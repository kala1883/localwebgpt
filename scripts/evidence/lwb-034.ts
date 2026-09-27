/**
 * LWB-034 可复现证据采集：**安全暂停与紧急停用**。
 *
 * 装置与 LWB-025 ~ LWB-033 同一套，而且这一份**不另起一套夹具**：
 * 它跑的就是工具面本身（`makeToolHarness` + 真 `PowerShellWinfsBackend`
 * + 真 `WinfsGuard.ps1` + 真 `createNativeApplier` + 真协调器），
 * 外加**生产那个** `registerPauseOperations` 建出来的控制面。
 *
 * ```text
 *   真 NTFS 工作区（%TEMP% 下）
 *     + 真护栏后端（CreateFileW / WriteFile / FlushFileBuffers，真共享模式）
 *     + 真工具面（change_prepare → 本地批准 → change_apply）
 *     + 真控制面（service.pause / service.resume / service.pause_status）
 *     → 判据：盘上的字节、状态库的行、逐条目日志、审计行、以及两面的读数
 * ```
 *
 * ## 逐条对应任务书
 *
 *  步骤 1「暂停立即阻断新读取/新应用并废止排队授权」
 *     —— §1.5（新读取被挡）、§1.6（新应用被挡在开始之前）、§3（废止）。
 *  步骤 2「进行中的写在安全边界停止或受控恢复；无法立即停止时界面显示正在停止」
 *     —— §1（写到一半按下）、§2（按下那一刻的读数里有 `stopping`）。
 *  步骤 3「停用后阻止未发出的工具结果；记录已返回给 ChatGPT 的内容无法撤回」
 *     —— §1.4（撤回：结果没出去、审计记 `REVOKED_BEFORE_RETURN`）
 *        与 §1.3（撤回不了什么：盘上的字节已经是用户的影响）。
 *
 *  验收 1「紧急停用不会粗暴杀写进程而假装零影响」—— §1.1 ~ §1.8。
 *  验收 2「暂停后重连不重放旧批准」—— §3.5 ~ §3.7 与 §5（真库文件上的重启）。
 *  验收 3「操作处于恢复态时，界面和工具均如实报告」—— §4。
 *
 * ## 本文件里哪些断言是「真的」
 *
 *  - 「没假装零影响」用**盘上的字节**证：第一个文件是**被批准的那些字节**，
 *    第二个文件与授权外的看门文件一个字节都没动。三条一起才叫账实相符 ——
 *    「什么都没写」与「写了但没报」是两种不同的谎，这一节把两种都堵上。
 *  - 「写盘的人还活着」用**它之后还在答话**证（`capability()` 仍然可用、
 *    解除暂停后读得到文件），而不是用「它没被杀」这句话 ——
 *    一个被杀掉又被重启的进程同样会说「我没被杀」。
 *  - 「暂停真的落地了」用**关库再开**证（§5）。同一个进程里的
 *    `isPaused()` 说明不了重启之后还在，而「忘记自己停过」正是这一格
 *    最坏的失效方向。
 *  - 「撤回的是结果、不是写入」用**两条一起**证：审计里 `delivered` 为空、
 *    而盘上第一个文件的字节确实变了（§1.3 + §1.4）。
 *
 * 用法：node --import tsx scripts/evidence/lwb-034.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件**证明不了**的事逐条列在 §7 并标 `NOT_RUN`。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { approveChange } from '@lwb/approvals';
import { answerToolCall } from '@lwb/audit';
import type { BridgeStatusData, ChangeApplyData, ChangePrepareData, Envelope, FileReadData } from '@lwb/contracts';
import { PauseService } from '@lwb/executor';
import { OperationRegistry, type RequestContext } from '@lwb/ipc';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import { PowerShellWinfsBackend } from '@lwb/winfs';
import type { WinfsOps } from '@lwb/winfs';
import type { WorkspaceEnvironment } from '@lwb/workspaces';

import { registerPauseOperations } from '../../apps/daemon/src/control/pause.ts';
import { GATES_ON, callTool, dataOf, errorOf, makeToolHarness } from '../../tests/tools/harness.ts';
import type { ToolHarness } from '../../tests/tools/harness.ts';

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

let failures = 0;
let passes = 0;
let skips = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes += 1;
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function note(name: string, detail: string): void {
  console.log(`NOTE ${name} — ${detail}`);
}

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

function skip(name: string, why: string): void {
  skips += 1;
  console.log(`NOT_RUN ${name} — ${why}`);
}

async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (cause) {
    const error = cause as { code?: string; message?: string; details?: unknown; stack?: string };
    check(`${name} 段跑完`, false, `${error.code ?? '(无错误码)'}：${error.message ?? String(cause)}`);
    if (error.details !== undefined) console.log(`      details=${JSON.stringify(error.details)}`);
    if (error.stack) console.log(`      ${error.stack.split('\n').slice(1, 4).join('\n      ')}`);
  }
}

/** 脱敏判据：证据里不得出现本机绝对路径。 */
const leaksLocalPaths = (text: string): boolean => /[A-Za-z]:\\|\/tmp\/|\/home\/|\/Users\//.test(text);

function checkRedacted(name: string, text: string): void {
  const leaked = leaksLocalPaths(text);
  const sample = /[A-Za-z]:\\[^\s"'）)，。]*/.exec(text)?.[0]?.slice(0, 60) ?? '(没找到路径片段)';
  check(name, !leaked, leaked ? `泄漏片段：${sample}` : '');
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** 哈希只留前 12 位：够核对，不足以还原内容。 */
const shortHash = (value: string | null | undefined): string =>
  typeof value === 'string' ? `${value.slice(0, 12)}…(${value.length})` : '?';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

let sandbox = '';
let envRoot = '';
let backend!: PowerShellWinfsBackend;
let environment!: WorkspaceEnvironment;
const harnesses: ToolHarness[] = [];
/**
 * 由 `hookWrites` 在装置建好**之前**设置，`rig()` 建装置时读它。
 *
 * 与 LWB-032 §6 的分工：那一格把闸门装在真 applier **外面**（推迟整次写盘），
 * 因为那里问的是「本次调用没等到结论」。这里问的是**写到一半时停用**，
 * 因此闸门必须装在更里面的一层 —— 盘那一层的 `writeFileGuarded` 上。
 */
let wrapped: WinfsOps | null = null;
let press: (() => void) | null = null;

/**
 * 给写入挂一个钩子：**每次 `writeFileGuarded` 真的成功之后**调用一次。
 *
 * `get` 里把**每一个**方法都绑回 `target`（不只是被挂钩的那一个）：
 * `#private` 字段要求 `this` 就是那个对象本身，而 `this` 为 `Proxy` 时
 * 私有字段访问会抛 —— 于是护栏的每一次读取都变成 `INTERNAL_ERROR`，
 * 而那个错会出现在**提案**那一步，离这里发生的事很远。
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
        if (typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === true) {
          await onWritten(String((req as { relative_path: unknown }).relative_path));
        }
        return result;
      };
    },
  });
}

/** 写盘真的落下去一个文件之后，按一次紧急停用。 */
function pressAfterFirstWrite(): void {
  wrapped = hookWrites(() => {
    if (press === null) return;
    const fire = press;
    press = null;
    fire();
  });
}

interface SeedFiles {
  readonly [relative: string]: string;
}

async function rig(seed: string, files: SeedFiles): Promise<ToolHarness> {
  const dir = path.join(sandbox, seed);
  await mkdir(dir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
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
    // 与每次调用复核时的身份来自两个不同的来源。
    ops: wrapped ?? backend,
    probe: backend,
    environment,
    gates: GATES_ON,
  });
  harnesses.push(harness);
  return harness;
}

const absOf = (harness: ToolHarness, relative: string): string =>
  path.join(harness.workspace.canonical_root, ...relative.split('/'));

const idem = (tag: string): string => `lwb034-${tag}`;

const consoleContext = (requestId: string): RequestContext => ({
  audience: 'console',
  connection_id: 'console:lwb-034-evidence',
  pid: process.pid,
  request_id: requestId,
});

/** 控制面：**生产那个** `registerPauseOperations`，不是手写的桩。 */
function consoleOf(harness: ToolHarness): { call(name: string, input?: unknown): unknown } {
  const registry = new OperationRegistry();
  registerPauseOperations(registry, { repos: harness.repos, pause: harness.pause });
  return {
    call(name, input = {}) {
      const definition = registry.lookup(name);
      if (definition === undefined) throw new Error(`${name} 应当已注册`);
      return definition.handler(input, consoleContext(`req_lwb034_${name}`));
    },
  };
}

interface EditEntry {
  readonly relative: string;
  readonly at: string;
  readonly to: string;
}

/** 走真工具面建一条修改集：读令牌 → 提案，两步都是生产的处理器。 */
async function propose(
  harness: ToolHarness,
  entries: readonly EditEntry[],
  key: string,
): Promise<ChangePrepareData> {
  const items = [];
  for (const entry of entries) {
    const read = dataOf<{ sha256: string; read_token: string }>(
      await callTool(
        harness,
        'file_read',
        { workspace_id: harness.workspace.id, path: entry.relative },
        harness.adapterContext(),
      ),
      `读取 ${entry.relative}`,
    );
    items.push({
      op: 'edit_text' as const,
      path: entry.relative,
      base_sha256: read.sha256,
      read_token: read.read_token,
      edits: [
        { start_line: 1, end_line_exclusive: 2, old_lines: [entry.at], new_lines: [entry.to] },
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
        summary: 'LWB-034 紧急停用取证',
        items,
      },
      harness.adapterContext(),
    ),
    'change_prepare',
  );
  if (prepared.state !== 'PENDING_APPROVAL' || prepared.workspace_modified) {
    throw new Error(`提案后状态不对：${prepared.state}（workspace_modified=${String(prepared.workspace_modified)}）`);
  }
  return prepared;
}

/** 本地批准。用 `harness.now()` 那口钟盖章 —— 两只表要对得上（LWB-032 的说明）。 */
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
  requestId = 'req_lwb034_apply',
): Promise<Envelope<ChangeApplyData>> =>
  callTool<ChangeApplyData>(
    harness,
    'change_apply',
    { change_id: changeId, idempotency_key: key },
    harness.adapterContext(requestId),
  );

const stagesOf = (harness: ToolHarness, operationId: string): readonly string[] =>
  harness.repos.journal.list(operationId).map((row) => row.stage);

// ---------------------------------------------------------------------------
// §1 ~ §5
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  section('§0 装置自述：先说清这一轮的证据是在什么上面采的');
  // -------------------------------------------------------------------------

  sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-034-'));
  envRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb-034-env-'));
  backend = new PowerShellWinfsBackend();
  const capability = await backend.capability();
  check(
    '§0.1 原生护栏后端可用（真 CreateFileW / WriteFile / 真共享模式）',
    capability.available,
    `backend=${capability.backend} exclusive_handle=${String(capability.supports_exclusive_handle)} flush=${String(capability.supports_flush)}`,
  );
  if (!capability.available) {
    note('§0.2 中止', `护栏后端不可用（${capability.resolved_backend_reason}），后面的每一节都无从谈起`);
    return;
  }

  environment = {
    store_root: path.join(envRoot, 'store'),
    home_directory: path.join(envRoot, 'home'),
    extra_broad_probes: [],
    protected_refs: [],
    policy_version: 7,
  };
  await mkdir(environment.store_root, { recursive: true });
  await mkdir(environment.home_directory, { recursive: true });

  // --- §1 写到一半按下停用 -------------------------------------------------

  section('§1 写到一半按下停用（验收 1 与步骤 3）');

  await guarded('§1', async () => {
    const written: string[] = [];
    const captured: {
      status: {
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
    } = { status: null };
    const inFlight: { operation_id: string | null } = { operation_id: null };

    const files = {
      'a.txt': 'A-old\nA-rest\n',
      'b.txt': 'B-old\nB-rest\n',
      // 授权外的看门文件：这条修改集**从未提起过**它。
      'canary.txt': '看门文件不得改变\n',
    };
    // 闸门必须在**建装置之前**挂上：`rig()` 在那一刻就把 `ops` 拿走了
    // （`ops: wrapped ?? backend`），事后再改这个变量不会换掉装置手里的那个对象。
    // 一个「闸门没挂上」的运行会因为「这次执行正常成功」而在所有断言上说是 ——
    // 那是本仓库最不能接受的一种绿，因此它有一条自检（§1.1）。
    wrapped = hookWrites((relative) => {
      written.push(relative);
      if (press === null) return;
      const fire = press;
      press = null;
      fire();
    });
    let harness: ToolHarness;
    try {
      harness = await rig('midflight', files);
    } finally {
      wrapped = null;
    }
    await writeFile(path.join(sandbox, 'outside.txt'), '工作区外不得改变\n', 'utf8');

    const beforeA = await readFile(absOf(harness, 'a.txt'));
    const beforeB = await readFile(absOf(harness, 'b.txt'));
    const beforeCanary = await readFile(absOf(harness, 'canary.txt'));
    const beforeOutside = await readFile(path.join(sandbox, 'outside.txt'));

    const prepared = await propose(
      harness,
      [
        { relative: 'a.txt', at: 'A-old', to: 'A-new' },
        { relative: 'b.txt', at: 'B-old', to: 'B-new' },
      ],
      idem('s1'),
    );
    approve(harness, prepared, 'console:lwb-034-evidence');
    check('§1.0 应用之前：批准是 ACTIVE 的', harness.repos.approvals.findActive(prepared.change_id)?.state === 'ACTIVE');

    // --- 步骤 3 的另一半：已经交出去的内容收不回来 -------------------------
    // 先做一次**真的交出去过**的读取，让审计里留下一条 `delivered = 1`
    // 的文件访问行 —— 那是「收不回来」这个读数的口径。少了它，下面那条
    // 断言验的是一个恒为 0 的计数器，而恒为 0 的计数器与一个把
    // `delivered` 读错成常量的计数器，在只看 0 的断言下长得一模一样。
    const alreadyOut = dataOf<FileReadData>(
      await callTool(
        harness,
        'file_read',
        { workspace_id: harness.workspace.id, path: 'a.txt' },
        harness.adapterContext('req_lwb034_s1_out'),
      ),
      '停用前的一次读取',
    );
    const deliveredBefore = harness.repos.audit.countDeliveredFileAccess();
    check(
      '§1.0.1 装置自检：停用之前真的有一次读取把内容交出去过',
      alreadyOut.path === 'a.txt' && deliveredBefore >= 1,
      `读到的=${alreadyOut.path} 已交出的文件访问行=${String(deliveredBefore)}`,
    );

    press = () => {
      inFlight.operation_id = harness.repos.operations.findByChangeId(prepared.change_id)?.id ?? null;
      captured.status = harness.pause.engage().status;
    };
    const withheld = errorOf(
      await applyTool(harness, prepared.change_id, idem('s1-apply'), 'req_lwb034_s1'),
      '半途停用的应用',
    );
    press = null;

    // --- 装置自检 ---------------------------------------------------------
    check(
      '§1.1 装置自检：只写了一个文件就停住了',
      written.length === 1 && written[0] === 'a.txt',
      `真的落盘的文件=${written.join(',') || '(空)'}`,
    );
    check('§1.2 装置自检：紧急停用真的被按下过', captured.status !== null);
    check(
      '§1.2.1 这次调用的结果被撤回：错误码 PAUSED、说的话是「未发送」而不是「未执行」',
      withheld.error.code === 'PAUSED' &&
        /未发送/.test(withheld.error.message) &&
        !/未执行/.test(withheld.error.message),
      `${withheld.error.code}：${withheld.error.message}`,
    );

    // --- 影响是**真的** ---------------------------------------------------
    const afterA = await readFile(absOf(harness, 'a.txt'));
    check(
      '§1.3 盘上第一个文件是**被批准的那些字节**（影响真的发生了）',
      afterA.toString('utf8') === 'A-new\nA-rest\n',
      `实际=${JSON.stringify(afterA.toString('utf8'))} 之前=${shortHash(sha256(beforeA))}`,
    );
    check(
      '§1.3.1 第二个文件一个字节都没动（写盘的人自己在安全边界停了）',
      sha256(await readFile(absOf(harness, 'b.txt'))) === sha256(beforeB),
    );
    check(
      '§1.3.2 授权外看门文件（工作区内）一个字节都没动',
      sha256(await readFile(absOf(harness, 'canary.txt'))) === sha256(beforeCanary),
    );
    check(
      '§1.3.3 授权外看门文件（工作区外）一个字节都没动',
      sha256(await readFile(path.join(sandbox, 'outside.txt'))) === sha256(beforeOutside),
    );

    // --- 撤回的是**结果**，不是**写入** ------------------------------------
    const answer = answerToolCall(harness.repos, 'req_lwb034_s1');
    const call = answer.calls[0];
    check(
      '§1.4 结果被撤回：审计里这一行是 deny / REVOKED_BEFORE_RETURN',
      call?.outcome === 'deny' && call?.metadata?.['reason'] === 'REVOKED_BEFORE_RETURN',
      `outcome=${String(call?.outcome)} reason=${String(call?.metadata?.['reason'])} code=${String(call?.error_code)}`,
    );
    check(
      '§1.4.1 一个字段都没出去（delivered 为空），而目标两个文件都记着',
      answer.delivered.length === 0 && answer.attempted.length === 2,
      `delivered=${String(answer.delivered.length)} attempted=${String(answer.attempted.length)}`,
    );
    check(
      '§1.4.2 撤回的是回执，不是那次写入（盘上的字节仍然是被批准的那一份）',
      sha256(await readFile(absOf(harness, 'a.txt'))) === sha256(afterA),
    );

    // --- 账实相符：待恢复 -------------------------------------------------
    check(
      '§1.5 修改集与操作都停在 RECOVERY_REQUIRED',
      harness.repos.changes.requireById(prepared.change_id).state === 'RECOVERY_REQUIRED',
      `change=${harness.repos.changes.requireById(prepared.change_id).state}`,
    );
    const operationId = inFlight.operation_id;
    if (operationId !== null) {
      const stages = stagesOf(harness, operationId);
      check(
        '§1.6 逐条目日志：写了第一个、第二个按待恢复处理',
        stages.includes('item_written') && stages.includes('write_recovery_required'),
        `阶段=${stages.join(' → ') || '(空)'}`,
      );
    } else {
      check('§1.6 逐条目日志', false, '没能从账上读到这次操作的操作号');
    }

    // --- 停用期间：新读取被挡、而服务仍然答得出话 --------------------------
    const blockedRead = errorOf(
      await callTool(
        harness,
        'file_read',
        { workspace_id: harness.workspace.id, path: 'b.txt' },
        harness.adapterContext('req_lwb034_s1_read'),
      ),
      '停用后的读取',
    );
    check(
      '§1.7 暂停立即阻断新读取',
      blockedRead.error.code === 'PAUSED' && /已阻断新读取与新应用/.test(blockedRead.error.message),
      `${blockedRead.error.code}：${blockedRead.error.message}`,
    );
    // 步骤 3 的后半句：「记录已返回给 ChatGPT 的内容无法撤回」。
    // 读数在**控制面**上，不在工具面上 —— 工具面的 `pause` 只有三个计数
    // （`BridgeStatusData.pause`），「有多少内容已经出去过」不给模型看。
    // 这一条同时是两个判据：它数得出停用之前那一次，而**没有**把刚才
    // 被挡住的那次读取算进去（那个一个字节都没交出去）。
    const unrecoverable = consoleOf(harness).call('service.pause_status') as {
      unrecallable_file_rows: number;
    };
    check(
      '§1.7.1 控制面数得出「已经交出去、收不回来」的内容，而被挡住的那次读取不计入',
      unrecoverable.unrecallable_file_rows === deliveredBefore && deliveredBefore >= 1,
      `unrecallable_file_rows=${String(unrecoverable.unrecallable_file_rows)} 停用前交出去的=${String(deliveredBefore)}`,
    );
    const pausedStatus = dataOf<BridgeStatusData>(
      await callTool(harness, 'bridge_status', {}, harness.adapterContext('req_lwb034_s1_status')),
      '停用期间的状态',
    );
    check(
      '§1.8 停用期间 `bridge_status` 照答，且如实说「停着」',
      pausedStatus.paused && pausedStatus.paused_at !== null,
      `paused=${String(pausedStatus.paused)} paused_at=${String(pausedStatus.paused_at)}`,
    );
    checkRedacted('§1.9 上面这些字符串里没有本机绝对路径', JSON.stringify(pausedStatus));

    // --- 恢复之后：重连看到的是**如实的账** -------------------------------
    const released = harness.pause.release();
    check('§1.10 解除暂停：状态回到未停用', !released.status.paused);

    const receipt = dataOf<ChangeApplyData>(
      await applyTool(harness, prepared.change_id, idem('s1-readback'), 'req_lwb034_s1_readback'),
      '恢复后的回执重读',
    );
    check(
      '§1.11 恢复之后重读回执：RECOVERY_REQUIRED，且不说「已保存」',
      receipt.state === 'RECOVERY_REQUIRED' && receipt.in_progress === false && receipt.recovered === false,
      `state=${receipt.state} in_progress=${String(receipt.in_progress)} recovered=${String(receipt.recovered)}`,
    );
    check(
      '§1.12 回执里的哈希与独立回读的一致',
      receipt.files[0]?.after_sha256 === sha256(afterA),
      `回执=${shortHash(receipt.files[0]?.after_sha256)} 回读=${shortHash(sha256(afterA))}`,
    );
    check(
      '§1.13 那之后护栏栈仍然活着（我们停的是写入，不是进程）',
      (await backend.capability()).available,
    );
    const alive = dataOf<{ path: string }>(
      await callTool(
        harness,
        'file_read',
        { workspace_id: harness.workspace.id, path: 'b.txt' },
        harness.adapterContext('req_lwb034_s1_alive'),
      ),
      '恢复后的读取',
    );
    check('§1.13.1 解除暂停之后读得到文件（写盘人没有被杀掉）', alive.path === 'b.txt');

    check(
      '§1.14 撤销/恢复都没有把批准变回可用',
      harness.repos.approvals.findActive(prepared.change_id) === null,
      `findActive=${String(harness.repos.approvals.findActive(prepared.change_id)?.state)}`,
    );
  });

  // --- §2 停用那一刻的读数 -------------------------------------------------

  section('§2 按下停用的那一刻：界面看得见「正在停止」');

  await guarded('§2', async () => {
    const captured: {
      status: {
        stopping: readonly { operation_id: string; state: string; holder_pid: number; slot_blocked: boolean }[];
      } | null;
    } = { status: null };
    const inFlight: { operation_id: string | null } = { operation_id: null };
    pressAfterFirstWrite();
    let harness: ToolHarness;
    try {
      harness = await rig('live-reading', { 'a.txt': 'a\nx\n', 'b.txt': 'b\nx\n' });
    } finally {
      wrapped = null;
    }

    const prepared = await propose(
      harness,
      [
        { relative: 'a.txt', at: 'a', to: 'A' },
        { relative: 'b.txt', at: 'b', to: 'B' },
      ],
      idem('s2'),
    );
    approve(harness, prepared, 'console:lwb-034-evidence');

    press = () => {
      inFlight.operation_id = harness.repos.operations.findByChangeId(prepared.change_id)?.id ?? null;
      captured.status = harness.pause.engage().status;
    };
    errorOf(await applyTool(harness, prepared.change_id, idem('s2-apply'), 'req_lwb034_s2'), '半途停用');
    press = null;

    const status = captured.status;
    if (status === null) {
      check('§2.1 按下那一刻的读数', false, '紧急停用没有被按下');
      return;
    }
    const stopping = status.stopping[0];
    check('§2.1 按下那一刻报告里有一条「正在停止」', status.stopping.length === 1, `条数=${String(status.stopping.length)}`);
    check(
      '§2.2 那条记录指的就是账上这一次操作（不是随便凑一条）',
      stopping?.operation_id === inFlight.operation_id && inFlight.operation_id !== null,
      `报告=${String(stopping?.operation_id)} 账上=${String(inFlight.operation_id)}`,
    );
    check('§2.3 它的状态是 APPLYING（真的在写，不是排队）', stopping?.state === 'APPLYING', `state=${String(stopping?.state)}`);
    check(
      '§2.4 持有者就是本进程，且这一格不是「抢锁」',
      stopping?.holder_pid === process.pid && stopping?.slot_blocked === false,
      `holder_pid=${String(stopping?.holder_pid)} slot_blocked=${String(stopping?.slot_blocked)}`,
    );
    note(
      '§2.5 这一格与「停用瞬间完成」的区别',
      '界面若只说「已暂停」，操作者会把「有一个写入还握着写盘权」当成「已经没事了」——' +
        '`stopping` 这个列表存在的唯一理由就是让那句话说不出口',
    );
  });

  // --- §3 暂停废止排队授权；恢复不重放 -------------------------------------

  section('§3 暂停废止排队授权与本地批准；恢复之后旧批准仍然不能用（验收 2）');

  await guarded('§3', async () => {
    const harness = await rig('no-replay', { 'note.txt': '原样\n第二行\n' });
    const file = absOf(harness, 'note.txt');
    const untouched = sha256(await readFile(file));

    const prepared = await propose(harness, [{ relative: 'note.txt', at: '原样', to: '改过' }], idem('s3'));
    approve(harness, prepared, 'console:lwb-034-evidence');
    check('§3.0 按下之前：修改集 APPROVED、批准 ACTIVE', harness.repos.changes.requireById(prepared.change_id).state === 'APPROVED');

    const console = consoleOf(harness);
    const outcome = console.call('service.pause') as {
      revoked: readonly { change_id: string; from: string; to: string; approval_id: string | null }[];
      skipped: readonly { change_id: string; reason: string }[];
      status: { paused: boolean; paused_at: string | null };
    };
    check('§3.1 按下停用：状态变成暂停，且带时刻', outcome.status.paused && outcome.status.paused_at !== null);

    const revoked = outcome.revoked.find((item) => item.change_id === prepared.change_id);
    check(
      '§3.2 那条已批准的修改集在废止清单里，且被记成 INVALIDATED',
      revoked !== undefined && revoked.to === 'INVALIDATED',
      `from=${String(revoked?.from)} to=${String(revoked?.to)} approval_id=${String(revoked?.approval_id)}`,
    );
    check(
      '§3.3 落库：修改集已经不是可应用的状态',
      harness.repos.changes.requireById(prepared.change_id).state === 'INVALIDATED',
    );
    const approval = harness.repos.approvals.listForChange(prepared.change_id)[0];
    check(
      '§3.4 那条本地批准被记成 REVOKED（不是「时间到了」）',
      approval?.state === 'REVOKED',
      `approval.state=${String(approval?.state)}`,
    );

    // --- 恢复 -------------------------------------------------------------
    const resumed = console.call('service.resume') as {
      status: { paused: boolean };
      revoked: readonly unknown[];
    };
    check('§3.5 恢复：状态回到未停用，且不恢复任何批准', !resumed.status.paused && resumed.revoked.length === 0);
    check(
      '§3.5.1 恢复之后那条修改集仍然是作废的（一次带副作用的深呼吸不是恢复）',
      harness.repos.changes.requireById(prepared.change_id).state === 'INVALIDATED',
    );

    // --- 旧批准：一个字节都写不进去 ---------------------------------------
    const replay = await applyTool(harness, prepared.change_id, idem('s3-replay'), 'req_lwb034_s3_replay') as {
      ok: boolean;
      data?: ChangeApplyData;
      error?: { code: string; message: string; details?: Record<string, unknown> };
    };
    if (replay.ok) {
      check(
        '§3.6 重放被拒（如实回答「这条已经作废」）',
        replay.data?.state === 'INVALIDATED' && replay.data.in_progress === false,
        `state=${String(replay.data?.state)}`,
      );
    } else {
      check(
        '§3.6 重放被拒（错误码粗粒度，原因是撤销）',
        replay.error?.code === 'APPROVAL_EXPIRED' && replay.error.details?.['reason'] === 'APPROVAL_REVOKED',
        `code=${String(replay.error?.code)} reason=${String(replay.error?.details?.['reason'])}`,
      );
      check(
        '§3.6.1 给人看的那句话说是「撤销」，不是「过期」',
        /撤销/.test(replay.error?.message ?? ''),
        replay.error?.message ?? '',
      );
    }
    check('§3.7 被作废的批准不得改动文件', sha256(await readFile(file)) === untouched);

    // --- 反过来：新提案照常可用 -------------------------------------------
    const fresh = await propose(harness, [{ relative: 'note.txt', at: '原样', to: '改过' }], idem('s3-fresh'));
    approve(harness, fresh, 'console:lwb-034-evidence');
    const applied = dataOf<ChangeApplyData>(
      await applyTool(harness, fresh.change_id, idem('s3-fresh-apply'), 'req_lwb034_s3_fresh'),
      '新提案的应用',
    );
    check(
      '§3.8 恢复之后新提案照常落地（否则上面那句「写不进去」只是「这装置不写盘」）',
      applied.state === 'APPLIED' && (await readFile(file)).toString('utf8') === '改过\n第二行\n',
      `state=${applied.state}：${applied.message}`,
    );
  });

  // --- §4 恢复态在两面都如实报告 -------------------------------------------

  section('§4 操作处于恢复态时，工具面与控制面说的是同一件事（验收 3）');

  await guarded('§4', async () => {
    pressAfterFirstWrite();
    let harness: ToolHarness;
    try {
      harness = await rig('recovery-report', { 'a.txt': 'a\nz\n', 'b.txt': 'b\nz\n' });
    } finally {
      wrapped = null;
    }
    const prepared = await propose(
      harness,
      [
        { relative: 'a.txt', at: 'a', to: 'A' },
        { relative: 'b.txt', at: 'b', to: 'B' },
      ],
      idem('s4'),
    );
    approve(harness, prepared, 'console:lwb-034-evidence');

    const inFlight: { operation_id: string | null } = { operation_id: null };
    press = () => {
      inFlight.operation_id = harness.repos.operations.findByChangeId(prepared.change_id)?.id ?? null;
      harness.pause.engage();
    };
    const withheld = errorOf(
      await applyTool(harness, prepared.change_id, idem('s4-apply'), 'req_lwb034_s4'),
      '半途停用',
    );
    press = null;
    check('§4.0 结果被撤回（步骤 3）', withheld.error.code === 'PAUSED', withheld.error.message);

    const status = dataOf<BridgeStatusData>(
      await callTool(harness, 'bridge_status', {}, harness.adapterContext('req_lwb034_s4_status')),
      'bridge_status',
    );
    check(
      '§4.1 工具面：数得出那一次待恢复，且不再把这条算作「正在写」',
      status.pause.recovery_operations === 1 && status.pause.stopping_writes === 0,
      `recovery=${String(status.pause.recovery_operations)} stopping=${String(status.pause.stopping_writes)} unrevoked=${String(status.pause.unrevoked_change_sets)}`,
    );
    check(
      '§4.2 工具面：限制说明里有一句讲这次待恢复',
      status.limitations.some((line) => line.includes('恢复')),
      status.limitations.find((line) => line.includes('恢复')) ?? `(限制说明=${JSON.stringify(status.limitations)})`,
    );

    const console = consoleOf(harness);
    const detail = console.call('service.pause_status') as {
      recovery_operations: readonly { operation_id: string; change_id: string; workspace_id: string }[];
      unrevoked_change_sets: readonly { state: string }[];
      stopping: readonly unknown[];
    };
    const operationId = inFlight.operation_id;
    check(
      '§4.3 控制面：说得出是**哪一次**（操作号、修改集、工作区都对得上）',
      operationId !== null &&
        detail.recovery_operations.length === 1 &&
        detail.recovery_operations[0]?.operation_id === operationId &&
        detail.recovery_operations[0]?.change_id === prepared.change_id &&
        detail.recovery_operations[0]?.workspace_id === harness.workspace.id,
      `recovery_operations=${JSON.stringify(detail.recovery_operations)}`,
    );
    check(
      '§4.4 两面说的是同一个数',
      status.pause.recovery_operations === detail.recovery_operations.length,
      `工具面=${String(status.pause.recovery_operations)} 控制面=${String(detail.recovery_operations.length)}`,
    );
    check(
      '§4.5 废止清单是空的：那条修改集已经作废，不再是「排队授权」',
      detail.unrevoked_change_sets.length === 0 && detail.stopping.length === 0,
      `unrevoked=${JSON.stringify(detail.unrevoked_change_sets)} stopping=${String(detail.stopping.length)}`,
    );

    // --- 恢复之后：重连看到的是同一个待恢复 --------------------------------
    harness.pause.release();
    const reread = dataOf<ChangeApplyData>(
      await applyTool(harness, prepared.change_id, idem('s4-reread'), 'req_lwb034_s4_reread'),
      '恢复态的复读',
    );
    check(
      '§4.6 恢复之后复读：同一个 RECOVERY_REQUIRED，不说「已保存」也不说「找不到」',
      reread.state === 'RECOVERY_REQUIRED' && reread.in_progress === false,
      `state=${reread.state} in_progress=${String(reread.in_progress)}`,
    );
    if (operationId !== null) {
      const stages = stagesOf(harness, operationId);
      check(
        '§4.7 逐条目日志里收尾那一行写着按待恢复处理',
        stages.includes('write_recovery_required'),
        `阶段=${stages.join(' → ') || '(空)'}`,
      );
    }
    checkRedacted('§4.8 上面这些字符串里没有本机绝对路径', JSON.stringify(status.limitations));
  });

  // --- §5 重启之后仍然停着 -------------------------------------------------

  section('§5 关库再开：暂停活过了重启，中止信号一出生就是中止的');

  await guarded('§5', async () => {
    const dbPath = path.join(sandbox, 'restart', 'state.db');
    await mkdir(path.dirname(dbPath), { recursive: true });

    const first = openDatabase({ path: dbPath });
    const reposFirst = new Repositories(first.db);
    const pauseFirst = new PauseService({ repos: reposFirst });
    check('§5.0 未暂停时：信号不是中止的', !pauseFirst.stopSignal().aborted && !pauseFirst.isPaused());
    const outcome = pauseFirst.engage();
    const stamp = reposFirst.service_pause.current();
    check(
      '§5.1 按下停用：落库了，且带时刻',
      outcome.status.paused && stamp.paused && stamp.paused_at !== null,
      `paused_at=${String(stamp.paused_at)}`,
    );
    closeDatabase(first.db);

    // 换一个连接、换一个进程内的对象树 —— 这就是「重启」在本机可复现的形态。
    const second = openDatabase({ path: dbPath });
    const reposSecond = new Repositories(second.db);
    const pauseSecond = new PauseService({ repos: reposSecond });
    const reopened = reposSecond.service_pause.current();
    check('§5.2 重开之后库里仍然写着「停着」', pauseSecond.isPaused() && reopened.paused);
    check('§5.3 中止信号**一出生就是中止的**（在途写入不会因为在停用期间重启而继续）', pauseSecond.stopSignal().aborted);
    check(
      '§5.4 重启不重写「上次暂停于」（那会让它变成一个关于重启时刻的假话）',
      reopened.paused_at === stamp.paused_at,
      `重启前=${String(stamp.paused_at)} 重启后=${String(reopened.paused_at)}`,
    );
    const released = pauseSecond.release();
    check('§5.5 解除暂停：换了一个**没有**中止的新信号', !released.status.paused && !pauseSecond.stopSignal().aborted);
    check('§5.6 解除之后库里也确实不再写着「停着」', !reposSecond.service_pause.isPaused());
    closeDatabase(second.db);
    note(
      '§5.7 这一节用的库是**文件库**',
      '同一个进程里的 `isPaused()` 说明不了重启之后还在，而「忘记自己停过」正是这一格最坏的失效方向',
    );
  });

  // --- §6 套件计数 ---------------------------------------------------------

  section('§6 套件：类型检查、导入检查、以及本任务的两组用例');

  const run = (label: string, args: readonly string[]): { ok: boolean; detail: string } => {
    const result = spawnSync(process.execPath, [...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 900_000,
    });
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    for (const line of out.split('\n')) {
      if (/^# (tests|suites|pass|fail|skipped) /.test(line)) console.log(`  ${line}`);
    }
    const countOf = (key: string): number =>
      Number(new RegExp(`^# ${key} (\\d+)`, 'm').exec(out)?.[1] ?? '-1');
    return {
      ok: result.status === 0,
      detail:
        countOf('tests') < 0
          ? `退出码 ${String(result.status)}`
          : `退出码 ${String(result.status)}，tests=${String(countOf('tests'))} pass=${String(countOf('pass'))} fail=${String(countOf('fail'))}`,
    };
  };

  await guarded('§6', async () => {
    const typecheck = spawnSync('npx', ['tsc', '--noEmit'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: true,
      timeout: 900_000,
    });
    check('§6.1 类型检查通过', typecheck.status === 0, `退出码 ${String(typecheck.status)}`);

    const imports = spawnSync(process.execPath, [path.join('scripts', 'check-fsguard-imports.mjs')], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 300_000,
    });
    check(
      '§6.2 FsGuard 导入检查通过（只有护栏适配层能碰 `child_process`）',
      imports.status === 0,
      `退出码 ${String(imports.status)}`,
    );

    // `--grep` 过滤的是**文件**（路径或内容含该串），因此这一条跑的是
    // 「内容提到 LWB-034 的那些文件」，不是一个用例名。它在这里正好等于
    // 本任务新增的那一个真盘验收文件（`--grep` 的语义写在 `run-tests.mjs:13`）。
    const acceptance = run('acceptance', [
      path.join('scripts', 'run-tests.mjs'),
      'tests/windows',
      '--grep',
      'LWB-034',
    ]);
    check('§6.3 LWB-034 真盘验收那一组全过', acceptance.ok, acceptance.detail);

    // 两组**全量**。少了这两条，上面那句「全过」只覆盖了新写的那一个文件 ——
    // 而一次紧急停用改的是工具面每一步都要读的那一格，它有没有碰坏别的
    // 用例，只有跑全套才回答得了。
    const unit = run('unit', [path.join('scripts', 'run-tests.mjs'), 'tests/unit']);
    check('§6.4 单元套件全量通过', unit.ok, unit.detail);
    const windowsAll = run('windows', [path.join('scripts', 'run-tests.mjs'), 'tests/windows']);
    check('§6.5 真盘套件全量通过', windowsAll.ok, windowsAll.detail);
  });

  // -------------------------------------------------------------------------
  section('§7 未执行项：逐条写下理由，不写成 PASS');
  // -------------------------------------------------------------------------

  note('§7 口径', '下面每一条都不是「没来得及」，而是本机**造不出这一格**、或者它**不由本任务回答**。');
  skip(
    '页面层（真实 ChatGPT 网页）触发一次紧急停用',
    'G0 未通过：LWB-002 BLOCKED（真实账号与隧道不可用）。本任务的注入全部发生在**本机**' +
      '（工具面 + 控制面 + 真护栏），与网络无关，因此网页层缺席不影响这些结论；' +
      '但「真实网页账号完成可复现的读—写—回读」仍然没有验收人、也没有设备',
  );
  skip(
    '控制台界面（Vue）上的那两个按钮',
    '控制台的紧急停用按钮属于 LWB-035 之后的界面任务。本任务交付的是它背后的两个操作' +
      '（`service.pause` / `service.resume`）与三个读数，界面尚未接上 —— ' +
      '而 `docs/LWB_COMPLETE_PLAN.md` 对 LWB-034 的验收说的是「界面和工具均如实报告」，' +
      '其中**界面**那一半在控制台接上这两个操作之后才算完整交付',
  );
  skip(
    '真实工作区上的紧急停用',
    'G4 未通过（判定与依据见 `docs/evidence/g4-write.md`），且四个能力开关照旧全关：' +
      '`direct_write_enabled` 为假。因此本任务的全部取证都在 `os.tmpdir()` 之下的临时工作区上进行，' +
      '真实工作区一个字节都没被碰过',
  );
  skip(
    '写到一半**杀掉**执行者（真 SIGKILL）',
    '不是本任务要问的问题，且已有归属：那是 LWB-033 的装置（`tests/fault-injection/daemon-death.test.ts`，' +
      '真子进程 + 真 SIGKILL + 真启动恢复）。本任务证的是**不杀**那一半 —— ' +
      '「我们没杀任何东西，写盘的人自己在边界上停了」与「我们扛得住被杀」是两条不同的保证，' +
      '混在一条里会让人以为其中一条不存在',
  );
  skip(
    '断电 / 拔电',
    '本机造不出：需要可控的电源或虚拟机。它的**等价面**（进程在写入过程中消失、盘上留下半份）' +
      '已由 LWB-033 §10.3 用真 SIGKILL 覆盖，而「重启之后暂停还在不在」由本文件 §5 用真库文件覆盖',
  );
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

await main();

for (const harness of harnesses) harness.close();
await backend?.dispose().catch(() => undefined);
await rm(sandbox, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
await rm(envRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);

console.log('\n== 计数 ==');
console.log(`PASS ${passes} / FAIL ${failures} / NOT_RUN ${skips}`);
process.exitCode = failures === 0 ? 0 : 1;
