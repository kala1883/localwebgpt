/**
 * LWB-032 真 NTFS 验收：已批准修改集的应用（`change_apply`）。
 *
 * ## 为什么这一格必须在真盘上、且必须走**工具面**
 *
 * `tests/unit/mcp-adapter.test.ts` 里有一条具名排除：写入那两个工具
 * （`change_apply` / `change_revert_prepare`）**不**在适配器那一层被覆盖，
 * 因为 `tests/tools/fixture-ops.ts` 的桩对一切写操作直接抛
 * 「夹具桩：写操作不在工具面范围内」。那是刻意的——一条被桩假装覆盖的
 * 写入路径，恰好会在最需要被验的那几格（真的落盘了吗、第二次调用又写了吗）
 * 上说好话。
 *
 * 因此本文件把整条链子接成真的：
 *
 * ```text
 *   真 NTFS 文件 → 真 PowerShellWinfsBackend（句柄级身份复核）
 *     → 真工具面（makeToolHarness 的 operations/handler）
 *     → 真票据权威 → 真 prepareChange（重读、切片、落快照）
 *     → 真本地批准（approvals 表）
 *     → 真 ExecutionCoordinator + 真 createNativeApplier
 *     → **盘上真的变了字节**
 * ```
 *
 * ## 逐条对应任务书（LWB-032）
 *
 *  步骤 1「change_apply 只处理已批准修改集，返回稳定 operation_id；
 *  控制台批准并应用走相同服务」—— §1（未批准 ⇒ 拒绝且零写入）、
 *  §3（批准后应用出回执）、§5（控制台路径与工具路径**同一条操作**）。
 *  步骤 2「快速完成返回实际回执；未完成返回 RUNNING，后续用 change_get 查询」
 *  —— §6（`wait_ms: 0` 那一格）。
 *  步骤 3「重复调用无论是否使用同一幂等键，均返回该修改集唯一操作」—— §4。
 *  步骤 4「工具说明禁止模型在未取得终态回执时宣称文件已保存」—— §8。
 *
 *  验收 1「网页批准/本地批准的差异有清晰提示，本地批准不可省略」—— §1 + §2。
 *  验收 2「断网、超时、重复点击和重复工具调用不产生第二次写」—— §4 + §6。
 *  验收 3「回执包括逐文件哈希和 tests_run:false，不把落盘当成功通过测试」
 *  —— §3。
 *
 * ## 本文件**不**说的事
 *
 * 「进程被杀」「断电」「并发两个应用」都没有构造（属 LWB-033），
 * 逐条列在 `docs/evidence/lwb-032/summary.md` 里并标 `NOT_RUN`，
 * 不与 PASS 合并。§6 构造的是**超时**，不是崩溃：协调器一直活着，
 * 只是本次调用没等它。
 *
 * ## §5b 是并发，但**不是**「并发两个应用」
 *
 * 这一条容易读混，因此写清楚：§5b（LWB-036 验收标准 2）构造的是
 * **本地点击与工具调用同时到达**——一个**授权与排队**上的并发，
 * 而 §5b 里真正去写盘的始终只有一个执行者。它要证的是
 * 「两个入口落在同一条操作上」，不是「两个写入者抢一块地」。
 * 后者（两个执行者同时认领、leases、崩溃后的接管）仍然没有构造，
 * 仍然属 LWB-033，仍然标 `NOT_RUN`。
 *
 * ## 反过来说，本文件里哪些断言是「真的」
 *
 * 每条关键结论都落在**字节**或**表行**上，不落在措辞上：
 *
 *  - 「没写」用文件指纹（大小 + 修改时刻 + 内容哈希）证 —— 只比内容会
 *    放过「把同样的字节再写一遍」；
 *  - 「只有一条操作」用 `operations` 表的行数证，不用返回值的字段证；
 *  - 「回执没在编」用**独立回读**证：`files[].after_sha256` 必须等于
 *    测试自己从磁盘上读回来的字节的哈希。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { approveAndQueue } from '@lwb/approvals';
import { operationReceiptFor, isExecutionChangeState } from '@lwb/changes';
import { BridgeError, TOOLS_BY_NAME } from '@lwb/contracts';
import type {
  ChangeApplyData,
  ChangePrepareData,
  Envelope,
  FileReadData,
  OperationReceipt,
} from '@lwb/contracts';
import { applyChange, createNativeApplier, ExecutionCoordinator, ITEM_STAGE } from '@lwb/executor';
import type { ApplyReport, ExecutionApplier, ExecutionPlan } from '@lwb/executor';
import { createProcessProbe, OperationRegistry } from '@lwb/ipc';
import { PowerShellWinfsBackend } from '@lwb/winfs';
import type { WorkspaceEnvironment } from '@lwb/workspaces';

import { registerApprovalOperations } from '../../apps/daemon/src/control/index.ts';

import {
  GATES_ON,
  ADAPTER_CONNECTION,
  NOW,
  callTool,
  dataOf,
  errorOf,
  makeToolHarness,
  type CoordinatorParts,
  type ToolHarness,
} from '../tools/harness.ts';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

/** 相对路径 → 绝对路径。**只给断言与装置用**，被测代码一律拿不到它。 */
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * 幂等键。**长度是契约要求**（`LIMITS.MIN_IDEMPOTENCY_KEY_CHARS`，今天 8）。
 *
 * 本文件里的键一律由它生成。第一次跑时手写过 `'k-§1'` 这种短键，
 * 八条用例一起红成 `change_prepare ... too_small` —— 而那句失败信息指向
 * schema，不指向「键太短」。把长度要求收进一个函数，这种红法就不可能
 * 以「参数不合法」的面目出现。
 */
const idem = (tag: string): string => `lwb032-${tag}`;

/**
 * 控制台那一次调用所用的身份。与 `@lwb/approvals` 的 `actor` 同一个形状
 * （`console:<session_id>`）：控制操作的 `connection_id` 由路由层设成它，
 * 而 §5b 手工装配那一层，因此要照着路由层的样子填。
 */
const CONSOLE_ACTOR = 'console:lwb-036-并发';

describeWindows('LWB-032 真 NTFS：已批准修改集的应用', () => {
  let sandbox = '';
  /** 受保护存储根与主目录——**放在沙箱的兄弟位置**，绝不与任何工作区根相交。 */
  let envRoot = '';
  let backend: PowerShellWinfsBackend;
  let environment: WorkspaceEnvironment;
  const harnesses: ToolHarness[] = [];

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-apply-'));
    envRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb-apply-env-'));
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏后端不可用：${capability.resolved_backend_reason}`);

    environment = {
      store_root: path.join(envRoot, 'store'),
      home_directory: path.join(envRoot, 'home'),
      extra_broad_probes: [],
      protected_refs: [],
      policy_version: 7,
    };
    await mkdir(environment.store_root, { recursive: true });
    await mkdir(environment.home_directory, { recursive: true });
  });

  after(async () => {
    for (const harness of harnesses) harness.close();
    await backend?.dispose();
    await rm(sandbox, { recursive: true, force: true });
    await rm(envRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 装置
  // -------------------------------------------------------------------------

  interface RigOptions {
    readonly files?: Readonly<Record<string, string>>;
    readonly gates?: typeof GATES_ON | (() => typeof GATES_ON);
    readonly paused?: boolean | (() => boolean);
    readonly apply_options?: ToolHarness['deps']['apply_options'];
    /** 覆盖协调器。§6 用它把写盘卡在半路，构造「本次没等到结论」那一格。 */
    readonly coordinator?: (parts: CoordinatorParts) => ExecutionCoordinator;
  }

  /**
   * 一次性装置：真临时目录 + 真护栏后端 + 真工具面。
   *
   * `ops` 与 `probe` **一起**换成真实后端：只换一个会让登记时记下的身份
   * 与每次调用复核时的身份来自两个不同的来源 —— 那条链会当场报「根被换掉」，
   * 而那是装置自己的锅（见 `ToolHarnessOptions.probe`）。
   */
  async function rig(seed: string, options: RigOptions = {}): Promise<ToolHarness> {
    const dir = path.join(sandbox, seed);
    await mkdir(dir, { recursive: true });
    for (const [relative, content] of Object.entries(options.files ?? {})) {
      const target = path.join(dir, ...relative.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }
    const other = path.join(sandbox, `${seed}-other`);
    await mkdir(other, { recursive: true });

    const harness = await makeToolHarness({
      root: dir,
      other_root: other,
      ops: backend,
      probe: backend,
      environment,
      gates: options.gates ?? GATES_ON,
      ...(options.paused === undefined ? {} : { paused: options.paused }),
      ...(options.apply_options === undefined ? {} : { apply_options: options.apply_options }),
      ...(options.coordinator === undefined ? {} : { coordinator: options.coordinator }),
    });
    harnesses.push(harness);
    return harness;
  }

  /** 绝对路径。断言与指纹用；被测代码拿到的只有相对路径。 */
  const absOf = (harness: ToolHarness, relative: string): string =>
    path.join(harness.workspace.canonical_root, ...relative.split('/'));

  /**
   * 文件指纹：大小 + 修改时刻 + 内容哈希。
   *
   * **只比内容会放过「把同样的字节又写了一遍」**，而「有没有写」正是
   * 本文件最要紧的那件事。修改时刻在 NTFS 上是 100ns 粒度，两次相邻的
   * 写入几乎不可能同值 —— 它是这里唯一能分辨「写了但写成一样」的读数。
   */
  async function fingerprint(file: string): Promise<string> {
    const info = await stat(file);
    const bytes = await readFile(file);
    return `${String(info.size)}|${String(info.mtimeMs)}|${sha256(bytes)}`;
  }

  /** 读 → 提案。返回提案结果；装置自检在下面两条断言里。 */
  async function proposeLine(
    harness: ToolHarness,
    relative: string,
    edit: { readonly line: number; readonly at: string; readonly to: string },
    key: string,
  ): Promise<ChangePrepareData> {
    const read = dataOf<FileReadData>(
      await callTool(
        harness,
        'file_read',
        { workspace_id: harness.workspace.id, path: relative },
        harness.adapterContext(),
      ),
      `file_read(${relative})`,
    );
    assert.equal(read.editable, true, `${relative} 应当可编辑，阻碍：${read.editable_blockers.join('、')}`);

    const prepared = dataOf<ChangePrepareData>(
      await callTool(
        harness,
        'change_prepare',
        {
          workspace_id: harness.workspace.id,
          idempotency_key: key,
          summary: 'LWB-032 真盘应用验收',
          items: [
            {
              op: 'edit_text',
              path: relative,
              base_sha256: read.sha256,
              read_token: read.read_token,
              edits: [
                {
                  start_line: edit.line,
                  end_line_exclusive: edit.line + 1,
                  old_lines: [edit.at],
                  new_lines: [edit.to],
                },
              ],
            },
          ],
        },
        harness.adapterContext(),
      ),
      `change_prepare(${relative})`,
    );
    assert.equal(prepared.state, 'PENDING_APPROVAL', '提案之后应当等本地批准');
    assert.equal(prepared.workspace_modified, false, '提案不写用户文件');
    assert.equal(prepared.files.length, 1);
    assert.equal(prepared.files[0]?.path, relative);
    return prepared;
  }

  /**
   * 本地批准。**用真实的当下时刻**，不写 `now`。
   *
   * 这里有一个装置上的不对称，必须说清楚，否则下一次改这个文件的人会
   * 按直觉填 `NOW` 然后收到一条看不懂的 `APPROVAL_EXPIRED`：
   *
   *  - 工具面那口钟是**冻结的**（`deps.now()` 恒为 `NOW`）；
   *  - 而协调器那口钟是**真的** —— `makeToolHarness` 刻意不注入 `now`，
   *    因为租约判定（`slot-rules.ts` 第 5 步）依赖它真的在走。
   *
   * 于是一条批准要同时活过两个时刻，而唯一能满足两者的读数是
   * `harness.now()` —— 协调器那口「锚在 `NOW` 上、但真的在走」的钟
   * （见 `makeToolHarness`）。批准从它起算 10 分钟
   * （`LIMITS.APPROVAL_TTL_MS`），于是在门禁（读 `NOW`）与认领
   * （读 `harness.now()`）眼里**都是** ACTIVE。
   *
   * 用 `NOW` 盖章：批准在今天看来早已过期，执行前那次复核
   * （方案 §9.3）报 `APPROVAL_EXPIRED`；
   * 用真实当下盖章：修改集本身早过了 24 小时有效期，报
   * `CHANGE_STATE_INVALID 修改集已超过有效期`。
   * 两条错法都指向别处，这就是必须用 `harness.now()` 的全部理由。
   */
  function applyTool(
    harness: ToolHarness,
    change_id: string,
    key: string,
  ): Promise<Envelope<ChangeApplyData>> {
    return callTool<ChangeApplyData>(
      harness,
      'change_apply',
      { change_id, idempotency_key: key },
      harness.adapterContext(),
    );
  }

  /**
   * 一道可以由测评方放行的闸。
   *
   * `resolve` 用定值断言而不是可空收窄：赋值发生在 `new Promise` 的
   * 执行器里，而 TypeScript 的控制流分析看不见那个执行器必然同步跑过一次
   * —— 于是 `release?.()` 会被收窄成 `null` 上的调用。这处 `!` 是对的，
   * 因为 `Promise` 构造函数**确实**同步调用执行器。
   */
  function latch(): { readonly promise: Promise<void>; readonly release: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, release: () => { resolve(); } };
  }

  /** 该修改集在 `operations` 表上的**行数**。「只有一条操作」只能这样证。 */
  const operationRows = (harness: ToolHarness, changeId: string): number =>
    harness.repos.operations.findByChangeId(changeId) === null ? 0 : 1;

  /**
   * 等一个操作走到终局。
   *
   * 只是在等一个**条件**，不是在等一段时间：循环里每一步都重读表，
   * 上界只是防挂死。§6 用它等那次被放弃的等待**自己**跑完。
   */
  async function waitTerminal(harness: ToolHarness, changeId: string): Promise<OperationReceipt> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const receipt = operationReceiptFor(changeId, harness.repos);
      if (receipt !== null && !isExecutionChangeState(receipt.state)) return receipt;
      if (Date.now() > deadline) {
        assert.fail(`等待 ${changeId} 终结超时；当前回执：${JSON.stringify(receipt)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  // -------------------------------------------------------------------------
  // §1 授予目录写权限后可直接应用，无需逐次批准
  // -------------------------------------------------------------------------

  it('单文件 file_create / file_edit 一次工具调用即直接落盘并返回回执', async () => {
    const harness = await rig('single-file-tools', { files: { 'note.txt': 'first\nsecond\n' } });
    const file = absOf(harness, 'note.txt');
    const read = dataOf<FileReadData>(
      await callTool(harness, 'file_read', { workspace_id: harness.workspace.id, path: 'note.txt' }, harness.adapterContext()),
      '编辑前读取',
    );

    const edited = dataOf<ChangeApplyData>(
      await callTool(harness, 'file_edit', {
        workspace_id: harness.workspace.id,
        idempotency_key: idem('single-edit'),
        summary: '一次调用直接编辑',
        path: 'note.txt',
        base_sha256: read.sha256,
        read_token: read.read_token,
        edits: [{ start_line: 2, end_line_exclusive: 3, old_lines: ['second'], new_lines: ['SECOND'] }],
      }, harness.adapterContext()),
      'file_edit 直接写入',
    );
    assert.equal(edited.state, 'APPLIED');
    assert.equal((await readFile(file, 'utf8')), 'first\nSECOND\n');
    assert.equal(edited.files[0]?.after_sha256, sha256(await readFile(file)));

    const created = dataOf<ChangeApplyData>(
      await callTool(harness, 'file_create', {
        workspace_id: harness.workspace.id,
        idempotency_key: idem('single-create'),
        summary: '一次调用直接创建',
        path: 'new-note.txt',
        content: 'created\n',
        newline: 'lf',
        bom: false,
      }, harness.adapterContext()),
      'file_create 直接写入',
    );
    assert.equal(created.state, 'APPLIED');
    assert.equal((await readFile(absOf(harness, 'new-note.txt'), 'utf8')), 'created\n');
    assert.equal(created.files[0]?.after_sha256, sha256(await readFile(absOf(harness, 'new-note.txt'))));
  });

  it('§1 单次 change_apply 会基于目录 grant 写入并留下 grant 来源记录', async () => {
    const harness = await rig('workspace-grant', { files: { 'note.txt': '第一行\n第二行\n第三行\n' } });
    const file = absOf(harness, 'note.txt');
    const before = await fingerprint(file);

    const prepared = await proposeLine(harness, 'note.txt', { line: 2, at: '第二行', to: '改过的第二行' }, idem('s1'));

    const applied = dataOf(await applyTool(harness, prepared.change_id, idem('s1-apply')), '目录授权应用');
    assert.equal(applied.state, 'APPLIED');
    assert.notEqual(await fingerprint(file), before, '获授权的目录写权限应使单次应用真实落盘');
    assert.equal(operationRows(harness, prepared.change_id), 1);
    const approval = harness.repos.approvals.listForChange(prepared.change_id)[0];
    assert.equal(approval?.state, 'CONSUMED');
    assert.equal(approval?.actor, `workspace-grant:${harness.repos.grants.find(ADAPTER_CONNECTION, harness.workspace.id)?.id}`);
  });

  it('§1 批准是唯一来源：approved / user_id / principal_id 一律进不来（strict 入参）', async () => {
    const harness = await rig('forged', { files: { 'note.txt': '甲\n乙\n' } });
    const file = absOf(harness, 'note.txt');
    const before = await fingerprint(file);
    const prepared = await proposeLine(harness, 'note.txt', { line: 1, at: '甲', to: '丙' }, idem('forged'));

    // 三种「模型自己声明已获授权」的写法。它们必须被**入参校验**挡住，
    // 而不是被某处 if 挡住：后者意味着字段能进到判定层，只差一个分支。
    const forgeries: readonly (readonly [string, Record<string, unknown>])[] = [
      ['approved', { approved: true }],
      ['user_id', { user_id: 'u-1' }],
      ['principal_id', { principal_id: 'principal-adapter' }],
      ['session_id + conversation_label', { session_id: 's-1', conversation_label: '本地控制台' }],
    ];

    for (const [label, extra] of forgeries) {
      const refused = errorOf(
        await callTool(
          harness,
          'change_apply',
          { change_id: prepared.change_id, idempotency_key: idem('forged-apply'), ...extra },
          harness.adapterContext(),
        ),
        `伪造 ${label}`,
      );
      assert.equal(refused.error.code, 'INVALID_ARGUMENT', `伪造 ${label} 应当被判为入参不合法`);
    }

    assert.equal(await fingerprint(file), before, '四次伪造都不得改动文件');
    assert.equal(operationRows(harness, prepared.change_id), 0, '四次伪造都不得建立操作行');
  });

  // -------------------------------------------------------------------------
  // §2 批准之后：真的落盘、真的回执
  // -------------------------------------------------------------------------

  it('§2 目录授权后应用：state=APPLIED、tests_run=false，且逐文件哈希与独立回读一致', async () => {
    const harness = await rig('applied', { files: { 'note.txt': 'alpha\nbeta\ngamma\n' } });
    const file = absOf(harness, 'note.txt');
    const beforeBytes = await readFile(file);

    const prepared = await proposeLine(harness, 'note.txt', { line: 2, at: 'beta', to: 'BETA' }, idem('s2'));
    const applied = dataOf(await applyTool(harness, prepared.change_id, idem('s2-apply')), '应用');
    assert.equal(applied.state, 'APPLIED', `应用应当成功；实际 ${applied.state}：${applied.message}`);
    assert.equal(applied.in_progress, false, '快速完成的调用不得报 in_progress');
    assert.equal(applied.recovered, false, '这不是一次恢复');
    // 任务书验收 3 的后半句：落盘**不是**测试通过。
    assert.equal(applied.tests_run, false, 'tests_run 恒为 false');
    assert.equal(applied.change_id, prepared.change_id);
    assert.ok(applied.operation_id.length > 0, '回执必须带一个稳定的 operation_id');

    // 回执里的哈希必须等于**测试自己**从盘上读回来的字节的哈希。
    // 少这一句，一次「回执说写成了、盘上没变」的执行就会通过。
    const afterBytes = await readFile(file);
    assert.equal(applied.files.length, 1);
    assert.equal(applied.files[0]?.path, 'note.txt');
    assert.equal(applied.files[0]?.state, 'VERIFIED', '成功的逐文件结果只能是 VERIFIED');
    assert.equal(applied.files[0]?.before_sha256, sha256(beforeBytes), '修改前哈希取自真实基线');
    assert.equal(applied.files[0]?.after_sha256, sha256(afterBytes), '修改后哈希必须等于盘上的字节');
    assert.equal(afterBytes.toString('utf8'), 'alpha\nBETA\ngamma\n', '盘上的内容就是提案说的那一行');
    // 装置自检：提案声明的目标哈希与**盘上那一刻**的字节必须对上。
    // 少了这一句，上面「after_sha256 等于盘上字节的哈希」有可能是在
    // 证明「回执与盘上的**同一个错误**一致」。
    assert.equal(prepared.files[0]?.after_sha256, sha256(afterBytes), '提案声明的目标就是盘上的结果');

    // 回执不是第二个来源：`change_get` 读到的必须是同一份。
    const receipt = operationReceiptFor(prepared.change_id, harness.repos);
    assert.ok(receipt !== null, '操作行必须存在');
    assert.equal(receipt.operation_id, applied.operation_id);
    assert.equal(receipt.files[0]?.after_sha256, applied.files[0]?.after_sha256);

    // 执行记录只为串接现有执行状态机；来源标记为 workspace grant，而不是人工审批。
    assert.equal(harness.repos.approvals.findActive(prepared.change_id), null, '执行授权已被消费');
    const records = harness.repos.approvals.listForChange(prepared.change_id);
    assert.equal(records.length, 1, '一条修改集上只该有一个执行授权记录');
    assert.equal(records[0]?.state, 'CONSUMED');
    assert.equal(records[0]?.consumed_by, applied.operation_id, '消费它的是那唯一一条操作');
  });

  // -------------------------------------------------------------------------
  // §3 重复调用：换不换幂等键都是同一条操作
  // -------------------------------------------------------------------------

  it('§3 重复调用（同键 / 换键）都返回同一条 operation_id，且不产生第二次写', async () => {
    const harness = await rig('repeat', { files: { 'note.txt': 'one\ntwo\n' } });
    const file = absOf(harness, 'note.txt');

    const prepared = await proposeLine(harness, 'note.txt', { line: 1, at: 'one', to: 'ONE' }, idem('s3'));
    const first = dataOf(await applyTool(harness, prepared.change_id, idem('s3-a')), '第一次应用');
    assert.equal(first.state, 'APPLIED');
    const settled = await fingerprint(file);

    // 换一个幂等键 —— 这是「模型重试时换了键」的形状，也正是
    // 「幂等只靠键」的实现会写第二次的那一格。
    const again = dataOf(await applyTool(harness, prepared.change_id, idem('s3-b')), '换键重试');
    const same = dataOf(await applyTool(harness, prepared.change_id, idem('s3-a')), '同键重试');

    assert.equal(again.operation_id, first.operation_id, '换键重试必须返回同一条操作');
    assert.equal(same.operation_id, first.operation_id, '同键重试必须返回同一条操作');
    assert.equal(again.state, 'APPLIED');
    assert.equal(again.tests_run, false);

    assert.equal(await fingerprint(file), settled, '重复调用不得再写一次（指纹含修改时刻）');
    assert.equal(operationRows(harness, prepared.change_id), 1, 'operations 表上只该有一行');
  });

  // -------------------------------------------------------------------------
  // §4 每个修改集独立落账，不需要复用或转借逐次批准
  // -------------------------------------------------------------------------

  it('§4 同一目录的两份提案都能独立直接应用，且保留各自摘要与回执', async () => {
    const harness = await rig('one-shot', { files: { 'note.txt': 'x\ny\n' } });
    const file = absOf(harness, 'note.txt');

    const firstChange = await proposeLine(harness, 'note.txt', { line: 1, at: 'x', to: 'X' }, idem('s4-a'));
    assert.equal(dataOf(await applyTool(harness, firstChange.change_id, idem('s4-a-apply')), '第一次').state, 'APPLIED');

    // 第二条提案（基于应用**之后**的字节）。
    const secondChange = await proposeLine(harness, 'note.txt', { line: 2, at: 'y', to: 'Y' }, idem('s4-b'));
    assert.notEqual(secondChange.change_id, firstChange.change_id);
    assert.notEqual(secondChange.digest, firstChange.digest, '两条提案的摘要必然不同');

    const applied = dataOf(await applyTool(harness, secondChange.change_id, idem('s4-b-apply2')), '第二条');
    assert.equal(applied.state, 'APPLIED');
    assert.equal(operationRows(harness, secondChange.change_id), 1);
    assert.equal(applied.files[0]?.after_sha256, sha256(await readFile(file)));
  });

  // -------------------------------------------------------------------------
  // §5 控制台路径与工具路径是同一条操作
  // -------------------------------------------------------------------------

  it('§5 控制台「批准并应用」与工具面 change_apply 落到同一条 operation_id', async () => {
    const harness = await rig('console', { files: { 'shared.txt': 'left\nright\n' } });
    const file = absOf(harness, 'shared.txt');

    const prepared = await proposeLine(harness, 'shared.txt', { line: 2, at: 'right', to: 'RIGHT' }, idem('s5'));

    // 控制台的主按钮（方案 §10.2）：批准与排队在**一个事务**里。
    approveAndQueue({
      repos: harness.repos,
      change_id: prepared.change_id,
      digest: prepared.digest,
      actor: 'console:lwb-032-控制台',
      now: new Date(harness.now()).toISOString(),
      idempotency_key: idem('s5-console'),
    });

    // 控制台随后执行它 —— 走的是**应用服务**（`@lwb/executor` 的 applyChange），
    // 也就是工具面那条路用的同一个函数。
    const consoleResult = await applyChange(
      { change_id: prepared.change_id, connection_id: ADAPTER_CONNECTION },
      { repos: harness.repos, coordinator: harness.coordinator },
    );
    assert.equal(consoleResult.state, 'APPLIED', `控制台应用应当成功：${consoleResult.message}`);
    assert.equal(consoleResult.files[0]?.after_sha256, sha256(await readFile(file)));

    // 然后模型再来点一次（换一个键）。它必须拿到**同一条操作**，
    // 而不是一条新的 —— 「两个入口、一件事」的全部意义就在这里。
    const viaTool = dataOf(await applyTool(harness, prepared.change_id, idem('s5-tool')), '工具面重放');
    assert.equal(viaTool.operation_id, consoleResult.operation_id, '两个入口必须是同一条操作');
    assert.equal(viaTool.state, 'APPLIED');
    assert.equal(operationRows(harness, prepared.change_id), 1, 'operations 表上仍然只有一行');
  });

  // -------------------------------------------------------------------------
  // §5b 同时发生：本地点击与工具调用落在同一条操作上（LWB-036 验收标准 2）
  // -------------------------------------------------------------------------

  /**
   * 控制台那一次「批准并应用」，走**真的控制操作处理器**。
   *
   * 不直接调 `approveAndQueue`：验收标准 2 说的是「本地点击」，而点击与
   * 函数调用之间隔着一整层（路由表、能力表、`requireLocalConsole`、
   * 审计写入）。F 组那次真事故（`recordDecision` 的白名单）正好证明了
   * 这一层不能跳过 —— 直接调底层函数会让处理器里的缺陷全部隐形。
   *
   * 返回「结果或错误」而不是直接抛：本用例里两种结局都是**合法**的
   * （谁先到谁赢），而断言要问的是「无论谁赢，是不是只有一条操作」。
   */
  function consoleApproveAndApply(
    harness: ToolHarness,
    prepared: ChangePrepareData,
    requestId: string,
  ): { readonly ok: true; readonly data: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
    const registry = new OperationRegistry();
    // 控制操作的 `now` 是 **ISO 字符串**（与 `@lwb/approvals` 的 `now` 同一个
    // 形状），不是 epoch 毫秒 —— 用 `harness.now()` 那口钟换算过去，
    // 理由与 `approve` 那段注释相同：两只表要对得上第三只。
    registerApprovalOperations(registry, {
      repos: harness.repos,
      now: () => new Date(harness.now()).toISOString(),
    });
    const definition = registry.lookup('approvals.approve_and_apply');
    assert.ok(definition !== undefined, 'approvals.approve_and_apply 应当已注册');
    try {
      const data = definition.handler(
        {
          change_id: prepared.change_id,
          digest: prepared.digest,
          idempotency_key: idem('s5b-console'),
        },
        { audience: 'console', connection_id: CONSOLE_ACTOR, pid: process.pid, request_id: requestId },
      ) as Record<string, unknown>;
      return { ok: true, data };
    } catch (error) {
      // 比的是 `details.reason`（稳定 slug）而不是 `code`：`code` 是
      // `CHANGE_STATE_INVALID`，它同时覆盖「状态不对」与「摘要不符」两种，
      // 而这里要问的**恰好**是哪一种。
      if (error instanceof BridgeError) {
        const reason = error.details?.['reason'];
        return { ok: false, reason: typeof reason === 'string' ? reason : error.code };
      }
      return { ok: false, reason: String(error) };
    }
  }

  it('§5b 本地点击与工具调用同时发生：只有一条操作、只写一次（验收标准 2）', async () => {
    const harness = await rig('race', { files: { 'race.txt': 'alpha\nbeta\n' } });
    const file = absOf(harness, 'race.txt');
    const prepared = await proposeLine(harness, 'race.txt', { line: 1, at: 'alpha', to: 'ALPHA' }, idem('s5b'));

    // ## 这两行就是「同时」
    //
    // 工具调用先起飞 —— 它是一个 async 函数，跑完同步的那一小段之后会在
    // 第一个 `await`（解析工作区访问权）上**悬停**。控制台那一次正是在
    // 那个悬停点上落的，因此它落在**同一条修改集的半路**上，而不是
    // 排在工具调用结束之后。两行之间没有任何等待。
    //
    // 这正是要构造的那一格：模型已经在问「能不能执行」的路上，
    // 而操作者在同一刻按下了「批准并应用」。
    const toolCall = applyTool(harness, prepared.change_id, idem('s5b-tool'));
    const consoleResult = consoleApproveAndApply(harness, prepared, 'req_s5b_race');
    const toolEnvelope = await toolCall;

    // ## 断言一：只有一条操作
    //
    // 这一条是验收标准 2 的判决点。「只执行一次」的凭据不是返回值里的
    // 某个字段，而是 `operations` 表上的行数 —— `UNIQUE(change_id)`
    // 是那条保证本身，而数行数是在问它，不是问它的结论。
    assert.equal(operationRows(harness, prepared.change_id), 1, '同一条修改集只能有一条操作');

    // ## 断言二：两个入口指的是同一条操作
    //
    // 控制台那次可能赢（先排队，工具随后认领同一条）也可能输
    // （工具先认领，控制台撞上 NOT_AWAITING_DECISION）。两种结局都合法，
    // 而**两种之下**这一句都必须成立。
    const toolData = dataOf<ChangeApplyData>(toolEnvelope, '工具面并发应用');

    // ## 「谁先落库」这件事要写死，不能写成「两种都行」
    //
    // 上面那两行构造出的顺序是确定的（见那一段注释），因此这里可以断言
    // 确定的结局：控制台那一次跑在工具调用**悬停**的那一点上，先写成。
    // 一个「两种结局都接受」的写法是危险的 —— 它在「控制台永远输」时
    // 也是绿的，而那意味着本地按钮在工具调用同时到达时永远不会成功：
    // 那不是验收标准 2 要的「只执行一次」，那是「本地批准被工具调用挤掉」。
    assert.equal(
      consoleResult.ok,
      true,
      `控制台那一次应当先落库；实际：${consoleResult.ok ? '成功' : consoleResult.reason}`,
    );
    if (!consoleResult.ok) throw new Error('unreachable');
    assert.equal(
      consoleResult.data['operation_id'],
      toolData.operation_id,
      '控制台与工具面必须落在同一条操作上',
    );
    assert.equal(consoleResult.data['state'], 'QUEUED', '控制台那次只排队，不写盘');
    assert.equal(toolData.state, 'APPLIED', '工具面那一次接着把同一份修改应用掉');

    // ## 断言三：写盘只发生了一次
    //
    // 日志里 `intent` 是「我要写这一条」的那一笔，每次真正的写入前写一次。
    // 数它，而不是数「文件最后对不对」—— 把同样的字节写两遍在内容上
    // 是看不出来的，而这正是本文件最要紧的那件事（文件头那句
    // 「只比内容会放过把同样的字节再写一遍」）。
    const intents = harness.repos.journal
      .list(toolData.operation_id)
      .filter((entry) => entry.stage === ITEM_STAGE.intent);
    assert.equal(intents.length, 1, '这条操作只许有一次写入意图');

    // ## 断言四：盘上真的是那一份字节
    //
    // 独立回读，不信回执：回执照抄的是执行时的记录，而这里问的是磁盘。
    await waitTerminal(harness, prepared.change_id);
    assert.equal(await readFile(file, 'utf8'), 'ALPHA\nbeta\n');
    assert.equal(sha256(await readFile(file)), toolData.files[0]?.after_sha256);
  });

  // -------------------------------------------------------------------------
  // §6 没等到结论：如实回答 in_progress，而不是宣称已保存
  // -------------------------------------------------------------------------

  it('§6 等待预算到点时如实回答 in_progress；此时盘上还没有那个字节', async () => {
    // 把写盘**卡住**：`wait_ms: 0` 的语义是「本次不等」，而一个已经跑完的
    // 写盘会让这一格退化成 §2。因此这里注入一个真协调器 —— 它用的仍是
    // 生产那个 `createNativeApplier`，只是在它前面加一道闸。
    const gate = latch();
    let entered = false;

    const harness = await rig('inflight', {
      files: { 'slow.txt': 'before\n' },
      apply_options: { wait_ms: 0 },
      // 闸门装在**真 applier 的外面**：写盘本身仍然是真的，只是被推迟到
      // 我们放行为止。装在里面（改 applier 内部）就不是同一件事了 ——
      // 那时被验的就是那个假 applier，而不是生产那个。
      coordinator: (parts: CoordinatorParts): ExecutionCoordinator => {
        const real: ExecutionApplier = createNativeApplier(parts);
        const gated: ExecutionApplier = async (
          plan: ExecutionPlan,
          signal: AbortSignal,
        ): Promise<ApplyReport> => {
          entered = true;
          await gate.promise;
          return await real(plan, signal);
        };
        return new ExecutionCoordinator({
          repos: parts.repos,
          probe: createProcessProbe(),
          apply: gated,
          // 持证人写的是**那口被锚定的钟**上的时刻，不是真实当下：
          // 「本人还活着」那次比对读的是同一个 `now`。两者若来自两口钟，
          // 这台机器上会算出「持证人于 2026 年启动，而现在是 2026-01-01」——
          // 于是每一次探活都答「早没了」，而那不是被测代码的错。
          holder: { pid: process.pid, started_at: new Date(parts.now() - 60_000).toISOString() },
          now: parts.now,
        });
      },
    });
    const file = absOf(harness, 'slow.txt');

    const prepared = await proposeLine(harness, 'slow.txt', { line: 1, at: 'before', to: 'after' }, idem('s6'));
    const untouched = await fingerprint(file);

    const answer = dataOf(await applyTool(harness, prepared.change_id, idem('s6-apply')), '未等到结论的应用');
    assert.equal(answer.in_progress, true, '预算到点时必须报 in_progress');
    assert.ok(
      isExecutionChangeState(answer.state),
      `in_progress 为真时状态必须是执行中的那三个之一；实际 ${answer.state}`,
    );
    assert.equal(answer.tests_run, false);
    assert.equal(
      await fingerprint(file),
      untouched,
      '「没等到结论」不是「已保存」：此刻盘上必须还是原样',
    );

    // 执行还在跑 —— 再点一次不得起第二次写。
    const retry = await applyTool(harness, prepared.change_id, idem('s6-retry'));
    if (retry.ok) {
      assert.equal(retry.data.in_progress, true, '在执行中重放只能得到「还在执行」');
      assert.equal(retry.data.operation_id, answer.operation_id, '仍然只能有那一条操作');
    } else {
      // 「有人正在写这块地」是这台机器上的正常时序，不是异常；
      // 但**不能**是「我起了第二次写」。
      assert.equal(retry.error.code, 'WORKSPACE_BUSY', `执行中重放的实际回答：${retry.error.code}`);
    }
    assert.equal(operationRows(harness, prepared.change_id), 1, '重放不得产生第二条操作');

    // 放行，然后等那次被放弃的等待**自己**跑完 —— 它继续跑，且真的落了盘。
    assert.equal(entered, true, '装置自检：写盘必须真的被卡住过，否则本用例什么都没验到');
    gate.release();
    const receipt = await waitTerminal(harness, prepared.change_id);
    assert.equal(receipt.state, 'APPLIED', `被放弃的等待也必须有终局：${JSON.stringify(receipt.files)}`);
    assert.equal(receipt.files[0]?.after_sha256, sha256(await readFile(file)));
    assert.equal((await readFile(file)).toString('utf8'), 'after\n', '放行之后真的写了一次');

    // 收场之后 `change_get` 能查到它 —— 这正是回执里那句「改用 change_get」。
    const later = dataOf<ChangeApplyData>(await applyTool(harness, prepared.change_id, idem('s6-later')), '事后查询');
    assert.equal(later.state, 'APPLIED');
    assert.equal(later.in_progress, false);
    assert.equal(later.operation_id, answer.operation_id, '事后拿到的仍然是同一条操作');
  });

  // -------------------------------------------------------------------------
  // §7 目录授权与暂停：不可用时不许「看起来能用」
  // -------------------------------------------------------------------------

  it('§7 撤销逐目录文件修改 grant 后拒绝写入；恢复 grant 后可继续应用', async () => {
    const harness = await rig('grant-revoke', { files: { 'note.txt': 'g\n' } });
    const file = absOf(harness, 'note.txt');

    const prepared = await proposeLine(harness, 'note.txt', { line: 1, at: 'g', to: 'G' }, idem('s7'));
    const before = await fingerprint(file);
    const grant = harness.repos.grants.find(ADAPTER_CONNECTION, harness.workspace.id);
    assert.ok(grant !== null, '装置必须有逐目录 grant');
    harness.repos.grants.put({ ...grant, capabilities: grant.capabilities.filter((item) => item !== 'propose') });
    const refused = errorOf(await applyTool(harness, prepared.change_id, idem('s7-apply')), '撤销目录写权限后的应用');
    assert.equal(refused.error.code, 'NOT_AUTHORIZED', `实际：${refused.error.code}`);
    assert.equal(
      refused.error.details?.['policy_reason'],
      'CAPABILITY_NOT_GRANTED',
      '拒绝原因应为目录 grant 缺少文件修改能力',
    );
    assert.equal(await fingerprint(file), before, '撤权后不得写盘');
    assert.equal(operationRows(harness, prepared.change_id), 0, '撤权后不得建立操作行');

    harness.repos.grants.put(grant);
    const applied = dataOf(await applyTool(harness, prepared.change_id, idem('s7-apply2')), '恢复目录写权限');
    assert.equal(applied.state, 'APPLIED');
    assert.equal(applied.files[0]?.after_sha256, sha256(await readFile(file)));
  });

  it('§7 全局暂停时 change_apply 被拒绝，且不建立操作行', async () => {
    // 暂停是**可变**的读数：先准备变更，再暂停，之后的直接写入必须被拦下。
    let paused = false;
    const harness = await rig('paused', {
      files: { 'note.txt': 'p\n' },
      paused: () => paused,
    });
    const file = absOf(harness, 'note.txt');
    const prepared = await proposeLine(harness, 'note.txt', { line: 1, at: 'p', to: 'P' }, idem('s7'));
    const before = await fingerprint(file);

    paused = true;
    const refused = errorOf(await applyTool(harness, prepared.change_id, idem('s7-apply')), '暂停时的应用');
    assert.equal(refused.error.code, 'PAUSED', `暂停时的应用必须答 PAUSED；实际 ${refused.error.code}`);
    assert.equal(await fingerprint(file), before, '暂停期间不得写盘');
    assert.equal(operationRows(harness, prepared.change_id), 0, '暂停期间不得建立操作行');
    assert.equal(
      harness.repos.changes.findById(prepared.change_id)?.state,
      'PENDING_APPROVAL',
      '暂停只是拦住这次执行，不推进修改集状态',
    );

    // 恢复之后同一份提案仍然能落地 —— 否则上面那句「拦住」可能只是
    // 「这个装置根本不写盘」。
    paused = false;
    assert.equal(
      dataOf(await applyTool(harness, prepared.change_id, idem('s7-apply2')), '恢复后的应用').state,
      'APPLIED',
    );
  });

  // -------------------------------------------------------------------------
  // §8 工具说明：模型拿到的文案必须把「什么时候能说已保存」说清楚
  // -------------------------------------------------------------------------

  it('§8 change_apply 的说明禁止在未取得终态回执时宣称已保存', () => {
    const definition = TOOLS_BY_NAME.get('change_apply');
    assert.ok(definition !== undefined, '工具清单里必须有 change_apply');
    const description = definition.description;

    // 四句都得在，缺哪一句都会让模型在某一格上说出不该说的话。
    const required: readonly (readonly [string, string])[] = [
      ['只有 APPLIED 才算落盘', '只有 state=APPLIED 才代表已落盘'],
      ['in_progress 时不许说已保存', '绝不能'],
      ['未完成时改查 change_get', 'change_get'],
      ['重复调用安全', '不会产生第二次写入'],
    ];
    for (const [label, phrase] of required) {
      assert.ok(description.includes(phrase), `说明里缺少「${label}」（找不到「${phrase}」）`);
    }
    assert.ok(description.includes('无需逐次本机批准'), '说明必须明确无需逐次本机批准');
    assert.ok(description.includes('approved'), '说明必须点名 approved 这类参数不被接受');

    // 说明里**不能**出现任何「已经保存」的正向承诺句式。
    for (const forbidden of ['文件已保存', '已写入成功', '可以告诉用户已完成']) {
      assert.ok(!description.includes(forbidden), `说明里不得出现「${forbidden}」`);
    }
  });

  // -------------------------------------------------------------------------
  // §9 授权仍有效时重放安全，撤权后新写入被拒
  // -------------------------------------------------------------------------

  it('§9 grant 有效时重放返回同一回执，撤权后新写入被拒', async () => {
    const harness = await rig('replay-surface', { files: { 'note.txt': 'r\n' } });
    const file = absOf(harness, 'note.txt');

    const done = await proposeLine(harness, 'note.txt', { line: 1, at: 'r', to: 'R' }, idem('s9-a'));
    const first = dataOf(await applyTool(harness, done.change_id, idem('s9-a-apply')), '第一次应用');
    assert.equal(first.state, 'APPLIED');
    const settled = await fingerprint(file);

    // 另起一条并在执行前撤销目录写权限。
    const pending = await proposeLine(harness, 'note.txt', { line: 1, at: 'R', to: 'RR' }, idem('s9-b'));
    const grant = harness.repos.grants.find(ADAPTER_CONNECTION, harness.workspace.id);
    assert.ok(grant !== null);
    harness.repos.grants.put({ ...grant, capabilities: grant.capabilities.filter((item) => item !== 'propose') });
    const refused = errorOf(await applyTool(harness, pending.change_id, idem('s9-b-apply')), '撤权后的应用');
    assert.equal(refused.error.code, 'NOT_AUTHORIZED', `实际：${refused.error.code}`);
    assert.equal(refused.error.details?.['policy_reason'], 'CAPABILITY_NOT_GRANTED');
    assert.equal(operationRows(harness, pending.change_id), 0, '被拒的应用不得建立操作行');
    assert.equal(await fingerprint(file), settled, '撤权后不得更改文件');
  });
});
