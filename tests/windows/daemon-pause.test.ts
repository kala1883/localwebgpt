/**
 * LWB-034 真 NTFS 验收：安全暂停与紧急停用。
 *
 * ## 为什么这一格必须在真盘上
 *
 * `tests/unit/pause.test.ts` 证的是**判据与落库**：状态写没写进去、
 * 排队授权有没有被作废、失败时长什么样。它一个字节都没碰过磁盘。
 *
 * 而 LWB-034 的三条验收标准问的都是**盘上发生了什么**：
 *
 *  1. 「紧急停用不会粗暴杀写进程而假装零影响」—— 只有真的写了字节，
 *     才谈得上「有影响」；只有那个写盘的手**自己**在安全边界停下来
 *     （而不是被谁杀掉），才谈得上「不粗暴」。
 *  2. 「暂停后重连不重放旧批准」—— 要看的是那个文件**还是原样**。
 *  3. 「操作处于恢复态时，界面和工具均如实报告」—— 报告里那个
 *     `RECOVERY_REQUIRED` 是不是真的对应一次写到一半的执行。
 *
 * 一个只跑内存桩的测试在这三条上都会说好话：桩里没有「写到一半」，
 * 因为桩的写入是原子的、一次性的。
 *
 * ## 闸门装在**盘那一层**，不装在应用器外面
 *
 * LWB-032 §6 把闸门装在真 applier 的外面（推迟整次写盘），因为那一格问的是
 * 「本次调用没等到结论」。本文件问的是另一件事：**写到一半时停用会怎样**。
 * 因此闸门装在更里面的一层 —— `WinfsOps.writeFileGuarded` 上，
 * 在**第一个文件真的落盘之后**、第二个文件开始之前按下紧急停用。
 *
 * 这个位置的选取就是这条用例的全部含义：
 *
 * ```text
 *   真 applier 的内部次序：vet → 快照 → recordIntent → 逐条目 writeOne
 *                                                          ↑
 *                                        a.txt 写完（盘上真的变了）
 *                                                          ↓
 *                                        ← 这里按下紧急停用
 *                                                          ↓
 *                                        b.txt 的 writeOne 开头看到中止 ⇒ 抛
 * ```
 *
 * 于是盘上必然留下**一个已经改过的文件**，而这次执行以
 * `RECOVERY_REQUIRED` 收场 —— 账实相符，不是零影响。
 *
 * ## 本文件**不**说的事
 *
 * 「把进程杀掉会怎样」「断电」仍然属于 LWB-033 的装置（真 SIGKILL）。
 * 本文件证的是**不杀进程**那一半：停用之后那个写盘的手仍然活着，
 * 只是不再往下写。这两件事必须分开说 —— 「我们没杀任何东西」与
 * 「我们扛得住被杀」是两条不同的保证。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { approveChange } from '@lwb/approvals';
import { answerToolCall } from '@lwb/audit';
import { isExecutionChangeState, operationReceiptFor } from '@lwb/changes';
import type {
  BridgeStatusData,
  ChangeApplyData,
  ChangePrepareData,
  Envelope,
  FileReadData,
} from '@lwb/contracts';
import type { PauseService } from '@lwb/executor';
import { OperationRegistry, type RequestContext } from '@lwb/ipc';
import { PowerShellWinfsBackend } from '@lwb/winfs';
import type { WinfsOps } from '@lwb/winfs';
import type { WorkspaceEnvironment } from '@lwb/workspaces';

import { registerPauseOperations } from '../../apps/daemon/src/control/pause.ts';
import {
  GATES_ON,
  callTool,
  dataOf,
  errorOf,
  makeToolHarness,
  type ToolHarness,
} from '../tools/harness.ts';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const idem = (tag: string): string => `lwb034-${tag}`;

describeWindows('LWB-034 真 NTFS：安全暂停与紧急停用', () => {
  let sandbox = '';
  let envRoot = '';
  let backend: PowerShellWinfsBackend;
  let environment: WorkspaceEnvironment;
  const harnesses: ToolHarness[] = [];

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-pause-'));
    envRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb-pause-env-'));
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
  }

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
      // `ops` 与 `probe` **一起**换成真实后端：只换一个会让登记时记下的身份
      // 与每次调用复核时的身份来自两个不同的来源（见 `ToolHarnessOptions.probe`）。
      ops: wrapped ?? backend,
      probe: backend,
      environment,
      gates: GATES_ON,
    });
    harnesses.push(harness);
    return harness;
  }

  /** 由 `hookWrites` 在用例开始前设置，`rig()` 建装置时读它。 */
  let wrapped: WinfsOps | null = null;

  /**
   * 给写入挂一个钩子：**每次 `writeFileGuarded` 真的成功之后**调用一次。
   *
   * ## 为什么是 `Proxy` 而不是展开对象或改后端
   *
   *  - 展开（`{...backend}`）会丢掉原型上的方法，于是护栏整个失效 ——
   *    而一个「因为装置坏了所以没写盘」的用例会在所有断言上说好话。
   *  - 改 `PowerShellWinfsBackend` 加一个测试挂钩，等于把测试的便利
   *    塞进被测的那一层，生产代码里会多出一个只有测试用的分支。
   *
   * `get` 里把**每一个方法**都绑回 `target`：`#private` 字段要求 `this` 就是
   * 那个对象本身，而 `this` 为 `Proxy` 时私有字段访问会抛。只绑那一个被挂钩
   * 的方法是不够的 —— 其余方法会以 `this = Proxy` 被调用，于是护栏的每一次
   * 读取都变成 `INTERNAL_ERROR`，而那个错会出现在**提案**那一步，
   * 离这里发生的事很远。
   */
  function hookWrites(onWritten: (relative: string) => Promise<void> | void): WinfsOps {
    return new Proxy(backend, {
      get(target, property): unknown {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== 'function') return value;
        const fn = (value as (req: unknown) => Promise<unknown>).bind(target);
        if (property !== 'writeFileGuarded') return fn;
        const write = fn;
        return async (req: unknown): Promise<unknown> => {
          const result = await write(req);
          // 只有**真的写成了**才通知：护栏拒绝、失败、冲突都要原样返回，
          // 否则装置会把一次没发生的写入报成「写完了」。
          if (typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === true) {
            await onWritten(String((req as { relative_path: unknown }).relative_path));
          }
          return result;
        };
      },
    });
  }

  const absOf = (harness: ToolHarness, relative: string): string =>
    path.join(harness.workspace.canonical_root, ...relative.split('/'));

  /** 大小 + 修改时刻 + 内容哈希。只比内容会放过「把同样的字节又写了一遍」。 */
  async function fingerprint(file: string): Promise<string> {
    const info = await stat(file);
    return `${String(info.size)}|${String(info.mtimeMs)}|${sha256(await readFile(file))}`;
  }

  /** 读一个文件拿票据（逐条目）。 */
  async function readFor(harness: ToolHarness, relative: string): Promise<FileReadData> {
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
    return read;
  }

  /**
   * 一次提案，**多条条目**。
   *
   * 两条条目是本文件的关键装置：只有一次写入之上还有「下一次」，
   * 中止才有落点。一条条目的计划里，停用要么来不及（写在停用之前）、
   * 要么整条都不写 —— 两种都验不到「写到一半」。
   *
   * 条目按**给定次序**排在计划里，而 `apply.ts` 按计划次序逐条写。
   */
  async function propose(
    harness: ToolHarness,
    entries: readonly { readonly relative: string; readonly at: string; readonly to: string }[],
    key: string,
  ): Promise<ChangePrepareData> {
    const items = [];
    for (const entry of entries) {
      const read = await readFor(harness, entry.relative);
      items.push({
        op: 'edit_text' as const,
        path: entry.relative,
        base_sha256: read.sha256,
        read_token: read.read_token,
        edits: [
          {
            start_line: 1,
            end_line_exclusive: 2,
            old_lines: [entry.at],
            new_lines: [entry.to],
          },
        ],
      });
    }

    const prepared = dataOf<ChangePrepareData>(
      await callTool(
        harness,
        'change_prepare',
        {
          workspace_id: harness.workspace.id,
          idempotency_key: key,
          summary: 'LWB-034 真盘停用验收',
          items,
        },
        harness.adapterContext(),
      ),
      'change_prepare',
    );
    assert.equal(prepared.state, 'PENDING_APPROVAL');
    assert.equal(prepared.workspace_modified, false, '提案不写用户文件');
    assert.equal(prepared.files.length, entries.length);
    return prepared;
  }

  /** 本地批准。`harness.now()` 那口钟的理由见 LWB-032 的说明（两只表要对得上）。 */
  function approve(harness: ToolHarness, prepared: ChangePrepareData, actor: string): void {
    approveChange({
      repos: harness.repos,
      change_id: prepared.change_id,
      digest: prepared.digest,
      actor,
      now: new Date(harness.now()).toISOString(),
    });
  }

  const applyTool = (
    harness: ToolHarness,
    changeId: string,
    key: string,
  ): Promise<Envelope<ChangeApplyData>> =>
    callTool<ChangeApplyData>(
      harness,
      'change_apply',
      { change_id: changeId, idempotency_key: key },
      harness.adapterContext(),
    );

  /** 控制台通道的身份。`audience: 'console'` 就是那条通道的**断言**。 */
  const consoleContext = (requestId = 'req_lwb034_console'): RequestContext => ({
    audience: 'console',
    connection_id: 'console:lwb-034',
    pid: process.pid,
    request_id: requestId,
  });

  /**
   * 控制面：只注册紧急停用那三个操作。
   *
   * **用的是生产那个 `registerPauseOperations`**，不是手写一个调用
   * `pause.engage()` 的桩 —— 后者会让「非控制台来源被拒」「带参数被拒」
   * 这些结构性质在真盘那一侧完全没有被验到。
   */
  function consoleOf(harness: ToolHarness): {
    call(name: string, input?: unknown): unknown;
  } {
    const registry = new OperationRegistry();
    registerPauseOperations(registry, { repos: harness.repos, pause: harness.pause });
    return {
      call(name, input = {}) {
        const definition = registry.lookup(name);
        assert.ok(definition !== undefined, `${name} 应当已注册`);
        return definition.handler(input, consoleContext());
      },
    };
  }

  const stageRows = (harness: ToolHarness, operationId: string): readonly string[] =>
    harness.repos.journal.list(operationId).map((row) => row.stage);

  // -------------------------------------------------------------------------
  // §1 验收 1：在途写入在安全边界停下，且报告如实
  // -------------------------------------------------------------------------

  it('§1 写到一半按下停用：盘上留下一个已改的文件，账上写 RECOVERY_REQUIRED，写盘的人还活着', async () => {
    /** 闸门按下之后才装得上：`rig()` 里还没有 harness。 */
    let press: (() => void) | null = null;
    let engaged: { stopping: readonly { operation_id: string; holder_pid: number }[]; paused: boolean } | null = null;
    const writtenFiles: string[] = [];

    wrapped = hookWrites((relative) => {
      writtenFiles.push(relative);
      if (press === null) return;
      const fire = press;
      press = null;
      fire();
    });

    let harness: ToolHarness;
    try {
      harness = await rig('midflight', { files: { 'a.txt': 'A-old\nA-rest\n', 'b.txt': 'B-old\nB-rest\n' } });
    } finally {
      wrapped = null;
    }

    const a = absOf(harness, 'a.txt');
    const b = absOf(harness, 'b.txt');
    const beforeA = await fingerprint(a);
    const beforeB = await fingerprint(b);

    const prepared = await propose(
      harness,
      [
        { relative: 'a.txt', at: 'A-old', to: 'A-new' },
        { relative: 'b.txt', at: 'B-old', to: 'B-new' },
      ],
      idem('s1'),
    );
    approve(harness, prepared, 'console:lwb-034-真盘测试');

    // --- 步骤 3 的另一半：已经交出去的内容收不回来 -------------------------
    // 先做一次**真的交出去过**的读取。它在审计里留下一条 `delivered = 1`
    // 的文件访问行，而那一行正是 `unrecallable_file_rows` 的口径
    // （`AuditRepo.countDeliveredFileAccess`）。
    //
    // 这一格非有不可：一个**恒为 0** 的「收不回来」计数器，与一个把
    // `delivered` 读错成常量的计数器，在只看 0 的那些断言下长得一模一样。
    const alreadyOut = dataOf<FileReadData>(
      await callTool(
        harness,
        'file_read',
        { workspace_id: harness.workspace.id, path: 'a.txt' },
        harness.adapterContext(),
      ),
      '停用前的一次读取',
    );
    assert.equal(alreadyOut.path, 'a.txt', '装置自检：这次读取必须真的成功');
    assert.ok(
      harness.repos.audit.countDeliveredFileAccess() >= 1,
      '装置自检：停用之前必须真的有过一条「内容已经出去」的记录',
    );

    // 闸门：第一个文件真的落盘之后，**真的**按下紧急停用。
    press = () => {
      engaged = harness.pause.engage().status;
    };

    // --- 这次调用**没有**交回结果（步骤 3）---------------------------------
    // 这是本用例最容易写错的一格：写盘真的发生了（下面就在验它），
    // 而模型**拿不到**那份回执 —— 因为暂停是在这次调用进行中落下的，
    // 而「已经算好、还没发出的结果」正是步骤 3 要拦下来的东西。
    //
    // 因此这里断言的不是回执，是**没有回执**，而且给出来的那句话说的是
    // 「未发送」，不是「未执行」。这两句话对操作者意味着完全不同的两件事。
    const applyRequest = 'req_lwb034_s1_apply';
    const withheld = errorOf(
      await callTool<ChangeApplyData>(
        harness,
        'change_apply',
        { change_id: prepared.change_id, idempotency_key: idem('s1-apply') },
        harness.adapterContext(applyRequest),
      ),
      '半途停用的应用',
    );
    assert.equal(withheld.error.code, 'PAUSED');
    assert.match(withheld.error.message, /未发送/, `被撤回的结果必须说清是「没发出去」：${withheld.error.message}`);
    assert.doesNotMatch(
      withheld.error.message,
      /未执行/,
      '它**执行了**，只是结果没出去；说成未执行会把「盘上已经变了」瞒下来',
    );

    // 那句话不是口头的：审计里那一行必须同时写着「没交出去」与「机制是撤回」。
    // 只写错误码是不够的 —— `PAUSED` 也是第 1 步「未执行」那一格的码，
    // 而这两行在账上必须是两件不同的事。
    const answer = answerToolCall(harness.repos, applyRequest);
    const call = answer.calls[0];
    assert.equal(call?.outcome, 'deny');
    assert.equal(call?.metadata?.['reason'], 'REVOKED_BEFORE_RETURN');
    assert.equal(call?.error_code, 'PAUSED');
    assert.deepEqual(answer.delivered, [], '已经算好的回执一个字段都没出去');
    assert.deepEqual(
      answer.attempted.map((range) => range.path).sort(),
      ['a.txt', 'b.txt'],
      '而它**尝试**过这两个文件 —— 记成「没碰」是另一种谎',
    );
    // 这里不断言 `bytes_out`：出站预算计的是**文件内容**，而一次 `change_apply`
    // 的回执不载内容，因此它的 0 与「撤回成没成功」无关。断言一个恒为 0 的
    // 数字只会让人以为它证明了什么。真正证明「内容没出去」的是上面那行
    // `delivered: []`。

    // --- 装置自检：闸门真的响过 -------------------------------------------
    assert.deepEqual(writtenFiles, ['a.txt'], '装置自检：必须只写了一个文件就停住，否则本用例什么都没验到');
    assert.ok(engaged !== null, '装置自检：紧急停用必须真的被按下过');

    // --- 步骤 3 的第二句话：「记录已返回给 ChatGPT 的内容无法撤回」---------
    // 读数在**控制面**上（`service.pause_status`），不在工具面上 ——
    // 工具面拿到的 `pause` 只有三个计数（见 `BridgeStatusData.pause`），
    // 「有多少内容已经出去过」这件事不给模型看。
    const consoleFace = consoleOf(harness);
    const unrecoverableBefore = (consoleFace.call('service.pause_status') as {
      unrecallable_file_rows: number;
    }).unrecallable_file_rows;
    assert.ok(
      unrecoverableBefore >= 1,
      `停用之前已经交出去的那次读取必须被记成「收不回来」；实际 ${unrecoverableBefore}`,
    );

    // --- 影响是**真的**：盘上那个文件确实变了 -------------------------------
    const afterA = await readFile(a);
    assert.notEqual(await fingerprint(a), beforeA, '写到一半被停：第一个文件必须已经变了');
    assert.equal(afterA.toString('utf8'), 'A-new\nA-rest\n', '而且写进去的就是被批准的字节');

    // --- 停用期间：新读取被挡住，但服务仍然答得出话 -------------------------
    // 这两条一起才是「没有粗暴杀进程而假装零影响」的正解：
    // **写入被挡住了**，而**进程还在**（它还答得出 `bridge_status`，
    // 那是第 1 步刻意留下的那条缝 —— 一个被暂停的服务如果连
    // 「为什么不能用了」都拒绝回答，操作者就只能去翻日志了）。
    const blockedRead = errorOf(
      await callTool(
        harness,
        'file_read',
        { workspace_id: harness.workspace.id, path: 'b.txt' },
        harness.adapterContext(),
      ),
      '停用后的读取',
    );
    assert.equal(blockedRead.error.code, 'PAUSED', '暂停期间的新读取必须被挡在门口');
    assert.match(blockedRead.error.message, /已阻断新读取与新应用/, blockedRead.error.message);
    assert.equal(
      (consoleFace.call('service.pause_status') as { unrecallable_file_rows: number }).unrecallable_file_rows,
      unrecoverableBefore,
      '被挡住的那次读取一个字节都没交出去，它不能算进「收不回来」',
    );
    const pausedStatus = dataOf<BridgeStatusData>(
      await callTool(harness, 'bridge_status', {}, harness.adapterContext()),
      '停用期间的状态',
    );
    assert.equal(pausedStatus.paused, true, '停着的时候状态查询必须照答，而且要如实说「停着」');
    assert.notEqual(pausedStatus.paused_at, null);

    // --- 恢复之后：重连看到的是**如实的账**，不是「一切正常」----------------
    // 步骤 3 撤回的是「已经算好的那一份结果」，撤回不了盘上已经发生的事。
    // 因此恢复之后重新问一次，答案必须是待恢复 —— 这条也顺带证明了
    // 中止没有把执行者一起带走：它还活着，还记得自己写到哪。
    const released = harness.pause.release();
    assert.equal(released.status.paused, false);

    const receipt = dataOf<ChangeApplyData>(
      await applyTool(harness, prepared.change_id, idem('s1-readback')),
      '恢复后的回执重读',
    );
    assert.equal(
      receipt.state,
      'RECOVERY_REQUIRED',
      `一次可能只写了一半的执行只能报待恢复；实际 ${receipt.state}：${receipt.message}`,
    );
    assert.notEqual(receipt.state, 'APPLIED', '半个修改集不得被报成已应用');
    assert.equal(receipt.tests_run, false);
    assert.equal(receipt.in_progress, false, '它已经停下来了，只是停在了需要人工核验的地方');
    assert.equal(receipt.files[0]?.after_sha256, sha256(afterA), '回执里的哈希必须与独立回读的一致');

    // --- 而**没有**粗暴杀进程 ---------------------------------------------
    // 两半：第二个文件一个字节没动（写盘的人自己在边界上停了），
    // 以及那之后整个护栏栈仍然可用（没有任何东西被终止）。
    assert.equal(await fingerprint(b), beforeB, '第二个文件必须一个字节都没动');
    const capability = await backend.capability();
    assert.equal(capability.available, true, '停用之后护栏栈仍然活着 —— 我们停的是写入，不是进程');
    const stillReads = dataOf<FileReadData>(
      await callTool(
        harness,
        'file_read',
        { workspace_id: harness.workspace.id, path: 'b.txt' },
        harness.adapterContext(),
      ),
      '恢复后的读取',
    );
    assert.equal(stillReads.path, 'b.txt', '而且读得到 —— 被挡住的是读取这件事，不是进程');
  });

  it('§1 停用那一刻的读数：它看得见那个正在写的文件，而不是「零影响」', async () => {
    let press: (() => void) | null = null;
    /**
     * 按下那一刻的读数。
     *
     * 装在一个**对象**里而不是一个裸的 `let`：赋值发生在闭包里，
     * 而 TypeScript 的控制流分析看不见闭包里的那次赋值 —— 于是
     * `if (live !== null)` 会把 `live` 收窄成 `never`，后面每个字段访问
     * 都编译不过。属性访问不进那套分析，因此这是这里唯一不用断言的写法。
     */
    const captured: {
      live: {
        stopping: readonly {
          operation_id: string;
          change_id: string;
          workspace_id: string;
          state: string;
          holder_pid: number;
          slot_blocked: boolean;
        }[];
        paused: boolean;
        paused_at: string | null;
      } | null;
    } = { live: null };

    /**
     * 按下那一刻在途的那条操作。
     *
     * 它必须在按下之前从**账上**读（那时这条操作确实在跑），而不能等结果
     * 回来 —— 结果回不来了：暂停撤回的正是它。这一格因此与 §1 是同一个
     * 事实的两个面：结果被撤回，但账上那行还在，读账的人照样看得见。
     */
    const inFlight: { operation_id: string | null } = { operation_id: null };

    wrapped = hookWrites(() => {
      if (press === null) return;
      const fire = press;
      press = null;
      fire();
    });

    let harness: ToolHarness;
    try {
      harness = await rig('live-reading', { files: { 'a.txt': 'a\nx\n', 'b.txt': 'b\nx\n' } });
    } finally {
      wrapped = null;
    }

    const prepared = await propose(
      harness,
      [
        { relative: 'a.txt', at: 'a', to: 'A' },
        { relative: 'b.txt', at: 'b', to: 'B' },
      ],
      idem('s1b'),
    );
    approve(harness, prepared, 'console:lwb-034-真盘测试');

    press = () => {
      inFlight.operation_id = harness.repos.operations.findByChangeId(prepared.change_id)?.id ?? null;
      captured.live = harness.pause.engage().status;
    };
    const withheld = errorOf(await applyTool(harness, prepared.change_id, idem('s1b-apply')), '半途停用');
    assert.equal(withheld.error.code, 'PAUSED', '与 §1 同一格：结果被撤回，而写盘已经发生');

    const live = captured.live;
    assert.ok(live !== null, '装置自检：紧急停用必须真的被按下过');
    // 「界面显示正在停止」的那一格：按下停用的**那一刻**，报告里必须有
    // 一条说得出「是哪一次写入、哪个进程」的记录。空报告会让操作者以为
    // 自己按下去的按钮没有生效。
    assert.equal(live.paused, true);
    assert.notEqual(live.paused_at, null, '真的按下的暂停必须带时刻 —— 界面要说得出「停多久了」');
    assert.equal(live.stopping.length, 1, '按下那一刻必须看得见那一次在途写入');
    const stopping = live.stopping[0];
    assert.ok(stopping !== undefined);
    assert.equal(stopping.change_id, prepared.change_id);
    assert.equal(stopping.workspace_id, harness.workspace.id);
    assert.notEqual(inFlight.operation_id, null, '装置自检：按下之前那条操作必须已经在账上');
    assert.equal(
      stopping.operation_id,
      inFlight.operation_id,
      '报告里那条「正在停的写入」必须就是账上这一条操作，而不是随便凑一条',
    );
    assert.equal(stopping.state, 'APPLYING');
    assert.equal(stopping.holder_pid, process.pid, '持有者就是本进程 —— 而它没有被杀掉');
    assert.equal(stopping.slot_blocked, false, '这是一次正常停用，不是抢锁');
  });

  // -------------------------------------------------------------------------
  // §2 验收 2：暂停 → 恢复之后，旧批准不会被重放
  // -------------------------------------------------------------------------

  it('§2 暂停把排队授权与本地批准一起作废；恢复之后旧批准仍然不能用，而新提案照常可用', async () => {
    let harness!: ToolHarness;
    wrapped = null;
    harness = await rig('no-replay', { files: { 'note.txt': '原样\n第二行\n' } });
    const file = absOf(harness, 'note.txt');

    const prepared = await propose(harness, [{ relative: 'note.txt', at: '原样', to: '改过' }], idem('s2'));
    approve(harness, prepared, 'console:lwb-034-真盘测试');
    assert.equal(harness.repos.changes.requireById(prepared.change_id).state, 'APPROVED');
    const untouched = await fingerprint(file);

    const console = consoleOf(harness);

    // --- 按下停用 ---------------------------------------------------------
    const outcome = console.call('service.pause') as {
      revoked: readonly { change_id: string; to: string; approval_id: string | null }[];
      status: { paused: boolean };
    };
    assert.equal(outcome.status.paused, true);
    const revoked = outcome.revoked.find((item) => item.change_id === prepared.change_id);
    assert.ok(revoked !== undefined, '那条已批准的修改集必须在停用清单里');
    assert.equal(revoked.to, 'INVALIDATED');
    assert.equal(
      harness.repos.changes.requireById(prepared.change_id).state,
      'INVALIDATED',
      '停用之后它必须已经不是「可应用」的状态',
    );

    // --- 恢复 -------------------------------------------------------------
    const resumed = console.call('service.resume') as { status: { paused: boolean }; revoked: readonly unknown[] };
    assert.equal(resumed.status.paused, false);
    assert.deepEqual(resumed.revoked, [], '恢复不恢复任何批准');
    assert.equal(
      harness.repos.changes.requireById(prepared.change_id).state,
      'INVALIDATED',
      '恢复之后那条修改集仍然是作废的 —— 一次带副作用的深呼吸不是恢复',
    );

    // --- 旧批准：一个字节都写不进去 ---------------------------------------
    const replay = await applyTool(harness, prepared.change_id, idem('s2-replay'));
    if (replay.ok) {
      assert.equal(replay.data.state, 'INVALIDATED', '重放只能如实回答「这条已经作废」');
      assert.equal(replay.data.in_progress, false);
    } else {
      // 错误码是**粗粒度**的：`APPROVAL_REVOKED` 与「过期」共用
      // `APPROVAL_EXPIRED` 这个码（`gateReasonToErrorCode` 的说明：
      // 与 `packages/policy` 的 `approvalFailures` 逐条对齐）。
      // 因此这里断言的是**原因**，它才是「为什么不能用」那句话。
      assert.equal(replay.error.code, 'APPROVAL_EXPIRED', `重放的实际回答：${replay.error.code}`);
      assert.equal(
        replay.error.details?.['reason'],
        'APPROVAL_REVOKED',
        '原因必须是「批准被撤销」，而不是「时间到了」—— 两者对操作者意味着完全不同的下一步',
      );
      assert.match(replay.error.message, /撤销/, '给人看的那句话也要说是撤销，不能只说过期');
    }
    assert.equal(await fingerprint(file), untouched, '被作废的批准不得改动文件');
    assert.equal(
      harness.repos.changes.requireById(prepared.change_id).state,
      'INVALIDATED',
      '一次被拒绝的重放不得推进任何状态',
    );

    // --- 反过来：新提案照常可用 -------------------------------------------
    // 少了这一半，上面那句「写不进去」可能只是「这个装置根本不写盘」。
    const fresh = await propose(harness, [{ relative: 'note.txt', at: '原样', to: '改过' }], idem('s2-fresh'));
    approve(harness, fresh, 'console:lwb-034-真盘测试');
    const applied = dataOf(await applyTool(harness, fresh.change_id, idem('s2-fresh-apply')), '新提案的应用');
    assert.equal(applied.state, 'APPLIED', `恢复之后新提案必须能落地：${applied.message}`);
    assert.equal((await readFile(file)).toString('utf8'), '改过\n第二行\n');
  });

  // -------------------------------------------------------------------------
  // §3 验收 3：恢复态在工具面与控制面上都如实报告
  // -------------------------------------------------------------------------

  it('§3 一次写到一半之后的恢复态：工具面与控制面说的是同一件事，且都不说「已保存」', async () => {
    let press: (() => void) | null = null;
    wrapped = hookWrites(() => {
      if (press === null) return;
      const fire = press;
      press = null;
      fire();
    });

    let harness: ToolHarness;
    try {
      harness = await rig('recovery-report', { files: { 'a.txt': 'a\nz\n', 'b.txt': 'b\nz\n' } });
    } finally {
      wrapped = null;
    }

    const prepared = await propose(
      harness,
      [
        { relative: 'a.txt', at: 'a', to: 'A' },
        { relative: 'b.txt', at: 'b', to: 'B' },
      ],
      idem('s3'),
    );
    approve(harness, prepared, 'console:lwb-034-真盘测试');

    /** 与 §1b 同一条理由：结果会被撤回，因此操作号只能在按下之前从账上读。 */
    const inFlight: { operation_id: string | null } = { operation_id: null };
    press = () => {
      inFlight.operation_id = harness.repos.operations.findByChangeId(prepared.change_id)?.id ?? null;
      harness.pause.engage();
    };
    const withheld = errorOf(await applyTool(harness, prepared.change_id, idem('s3-apply')), '半途停用');
    assert.equal(withheld.error.code, 'PAUSED', '结果被撤回 —— 这一条本身就是验收第 3 条的前半句');

    const operationId = inFlight.operation_id;
    assert.ok(operationId !== null, '装置自检：按下之前那条操作必须已经在账上');

    // --- 撤回的是**结果**，不是**事实** -------------------------------------
    // 这一点值得单独断言：如果有人把「撤回结果」实现成「回滚这次写入」，
    // 下面这行会先炸 —— 而回滚恰恰是这一格禁止的（盘上的字节是对用户的
    // 真实影响，撤回得了消息，撤回不了影响）。
    assert.equal(
      (await readFile(absOf(harness, 'a.txt'))).toString('utf8'),
      'A\nz\n',
      '被撤回的是回执，不是那次写入',
    );

    // --- 落库事实：修改集与操作都在恢复态，且操作**没有**被标成终结 -------
    assert.equal(harness.repos.changes.requireById(prepared.change_id).state, 'RECOVERY_REQUIRED');
    const operation = harness.repos.operations.findById(operationId);
    assert.ok(operation !== null);
    assert.equal(operation.state, 'RECOVERY_REQUIRED');
    // `finished` 为假是关键：恢复数据还在，「谁也别再动它」这件事有据可查。
    assert.equal(
      harness.repos.operations.listByStates(['RECOVERY_REQUIRED']).some((row) => row.id === operationId),
      true,
      '恢复态的操作必须能被恢复流程列出来',
    );

    // --- 工具面：`bridge_status` 报的是**计数**，不是细节 -------------------
    const status = dataOf<{
      paused: boolean;
      pause: { stopping_writes: number; unrevoked_change_sets: number; recovery_operations: number };
      limitations: readonly string[];
    }>(
      await callTool(harness, 'bridge_status', {}, harness.adapterContext()),
      'bridge_status',
    );
    assert.equal(status.paused, true);
    assert.equal(status.pause.recovery_operations, 1, '工具面必须数得出那一次待恢复的操作');
    assert.equal(status.pause.stopping_writes, 0, '它已经停下来了，不再是「正在写」');
    assert.equal(
      status.limitations.some((line) => line.includes('恢复')),
      true,
      '限制说明里必须有一句讲这次待恢复 —— 模型据此才知道该告诉使用者什么',
    );

    // --- 控制面：说得出是**哪一次** ----------------------------------------
    const console = consoleOf(harness);
    const detail = console.call('service.pause_status') as {
      recovery_operations: readonly { operation_id: string; change_id: string; workspace_id: string }[];
      unrevoked_change_sets: readonly unknown[];
      stopping: readonly unknown[];
    };
    assert.deepEqual(detail.recovery_operations, [
      { operation_id: operationId, change_id: prepared.change_id, workspace_id: harness.workspace.id },
    ]);
    assert.deepEqual(detail.unrevoked_change_sets, []);
    assert.deepEqual(detail.stopping, []);

    // --- 两边说的是同一件事 -------------------------------------------------
    assert.equal(status.pause.recovery_operations, detail.recovery_operations.length);

    // --- 而工具面**不**说「已保存」 ----------------------------------------
    //
    // 这一读必须发生在**解除暂停之后**：停用期间工具面撤回一切结果
    // （上面那条 `withheld` 就是它），因此「重连之后看到什么」这个问题
    // 只有在恢复之后才问得出答案 —— 而那个答案正是验收第 2 条要的那一句：
    // **恢复不重放，也不粉饰**。一次重启过的服务重新拿起这份账时，
    // 它看到的必须是同一个待恢复，而不是「上次那条批准还等着执行」。
    const released = harness.pause.release();
    assert.equal(released.status.paused, false);
    assert.deepEqual(released.revoked, [], '恢复本身不作废任何东西（作废是按下时做的）');

    const reread = dataOf(await applyTool(harness, prepared.change_id, idem('s3-reread')), '恢复态的复读');
    assert.equal(reread.state, 'RECOVERY_REQUIRED');
    assert.equal(reread.in_progress, false);
    assert.equal(reread.tests_run, false);
    assert.equal(reread.recovered, false, '还没恢复过，不得报 recovered');

    // --- 日志说得出它停在哪一格 --------------------------------------------
    const stages = stageRows(harness, operationId);
    assert.equal(stages.includes('write_recovery_required'), true, '收尾那一行必须写着按待恢复处理');
    assert.equal(stages.includes('item_written'), true, '而第一个文件确实写下去了');

    // 执行中的那三个状态一个都不剩：一次停不下来的执行会让界面永远显示
    // 「正在停止」，而那时谁也不知道该怎么办。
    assert.equal(isExecutionChangeState(reread.state), false);
    const receipt = operationReceiptFor(prepared.change_id, harness.repos);
    assert.ok(receipt !== null);
    assert.equal(receipt.state, 'RECOVERY_REQUIRED');
  });
});
