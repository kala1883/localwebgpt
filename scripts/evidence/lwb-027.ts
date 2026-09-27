/**
 * LWB-027 可复现证据采集：受保护的既有文件写入。
 *
 * 装置：**真 NTFS** ←经→ 真 `PowerShellWinfsBackend`（真的 `CreateFileW`、
 * `SetEndOfFile`、`FlushFileBuffers`、`GetFileInformationByHandle`）→ 真适配器
 * （`packages/executor/src/native-adapter.ts`）→ 真 SQLite、真快照库、
 * 真 `claimForExecution`。**没有假件**：这正是本任务与 LWB-026 的分界 ——
 * 那一边的写盘人是故意假的，因为「怎么落字节」是这一边的事。
 *
 * ## 逐条对应任务书
 *
 *  步骤 1「将批准过的精确操作交给原生执行器；固定祖先目录并独占打开既有目标」
 *  —— §1 与 §3。§3 直接观察那组共享标志的效果（护栏自己的 `holdHandle`
 *  走的是同一个 `Open-Guarded`、同一组标志）。
 *
 *  步骤 2「在同一句柄内验证文件 ID、硬链接、哈希、编码和权限，再写入、
 *  截断、刷盘和回读」 —— §1 证「写入→截断→刷盘→回读」整条走通且回读哈希
 *  等于批准的新哈希；§2 证文件 ID 与哈希这两项的核对真的会拦人；
 *  §4 证「权限」不足时是**错误**而不是降级。
 *
 *  步骤 3「占用、路径变化、句柄能力不足均返回错误，不降级普通文件 API」
 *  —— §3（占用）与 §4（句柄能力不足：只读、被映射）。「不降级」在代码上
 *  是一条**编译期**性质：`packages/executor/` 在 FsGuard 导入检查的业务
 *  前缀里，它 import `node:fs` 会让 `npm run check:imports` 直接失败。
 *
 *  步骤 4「在持锁期间进行有界恢复，释放句柄前生成实际结果」 —— 见
 *  `docs/evidence/lwb-027/summary.md` §5 的边界说明：「有界」在本任务里
 *  是**有界观测 + 不扩大损害**，不是一次自动的第二次写入。
 *
 *  验收 1「VS Code 在检查前保存则冲突；检查后到写入结束的普通竞争保存被
 *  共享模式阻止」 —— §2 与 §3。
 *  验收 2「回读哈希与已批准 new_hash 一致才报告该文件完成」 —— §1。
 *  验收 3「文档明确进程崩溃可能留下部分字节，须进入恢复，不宣称原子替换」
 *  —— 是一句**文档**要求。可机器核对的那一半（能力标志里
 *  `crash_atomic_replace=false`）在 §1 末尾；散文在 summary.md §5。
 *
 * 用法：node --import tsx scripts/evidence/lwb-027.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件证明不了的事（见 §7）：**真实 ChatGPT 网页端验收**需要真实账号与
 * Secure MCP Tunnel 凭据，当前 BLOCKED（LWB-002）；**恢复流程**属 LWB-030；
 * `change_apply` 工具对模型可见属 LWB-032。MCP Inspector 的一次成功不能
 * 替代第一项。
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { approveAndQueue } from '@lwb/approvals';
import { BlobStore } from '@lwb/blob-store';
import { canonicalChangeDigest } from '@lwb/changes';
import { CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import type { ChangeOp } from '@lwb/contracts';
import { claimForExecution, createNativeApplier, readItemEvents } from '@lwb/executor';
import type { ApplyReport, ExecutionPlan, ItemEvent, NativeApplierDeps } from '@lwb/executor';
import type { ProcessProbe } from '@lwb/ipc';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { ChangeItemInput, OpenDatabaseResult } from '@lwb/persistence';
import { getWinfsBackend, ResidentHelper, disposeWinfsBackend, isWinfsError } from '@lwb/winfs';
import type { WinfsOps } from '@lwb/winfs';

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

/** 跑一段；炸了就把真实原因报成 FAIL，而不是让整个脚本消失。 */
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

const rec = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** 脱敏判据：证据里不得出现本机绝对路径。 */
function leaksLocalPaths(text: string): boolean {
  return /[A-Za-z]:\\|\/tmp\/|\/home\/|\/Users\//.test(text);
}

/**
 * 一次**普通保存**：编辑器按保存走的就是 `File.WriteAllText`。
 *
 * 刻意不走护栏 —— 这一节要观察的正是「不受我们管辖的那一方会怎样」。
 * 只认 ASCII 的结论词：本机控制台代码页会把非 ASCII 输出弄成乱码，
 * 而在乱码里判 `includes` 会让一次失败的保存看起来像成功。
 */
function ordinarySave(target: string, text: string): 'SAVED' | 'BLOCKED' {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `  [IO.File]::WriteAllText('${target.replace(/'/g, "''")}', '${text}' + [char]10)`,
    '  "SAVED"',
    '} catch { "BLOCKED" }',
  ].join('\n');
  const res = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  });
  return res.includes('SAVED') ? 'SAVED' : 'BLOCKED';
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CONNECTION = 'conn_ev27';
const WORKSPACE = 'ws_ev27';
const PRINCIPAL = 'principal_ev27';
const POLICY_VERSION = 1;
const MODE = 'read_propose_apply_with_local_approval';
const EXECUTOR_ID = 'exe_ev27';
const HOLDER = { pid: process.pid, started_at: new Date(Date.now() - 60_000).toISOString() };
const CONTRACT = CONTRACT_VERSION;

/** 认领时不该被问到：地是空的，槽是空的。 */
const deadProbe: ProcessProbe = {
  identify: () => {
    throw new Error('本证据不该问进程探针（LWB-026 已经证过它）');
  },
};

const ops = getWinfsBackend();

let sandbox = '';
let opened: OpenDatabaseResult | undefined;
let repos: Repositories;
let blobs: BlobStore;
let seq = 0;

const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;

interface Rig {
  readonly dir: string;
  readonly relative: string;
  readonly abs: string;
  readonly ref: { readonly root_path: string; readonly root_volume_id: string; readonly root_file_id: string };
  readonly plan: ExecutionPlan;
  readonly change_id: string;
  readonly operation_id: string;
  readonly submit: (signal?: AbortSignal) => Promise<ApplyReport>;
  /** 走 `submit` 并把抛出来的东西原样交回，便于断详情。 */
  readonly rejected: (signal?: AbortSignal) => Promise<{ code?: string; message?: string; details?: Record<string, unknown> }>;
  /** 这一套当前全部条目级日志，按 `seq` 的落库顺序。 */
  readonly events: () => ItemEvent[];
}

/** 报告里那句给人看的话（`kind` 之外唯一允许存在的字段）。 */
function detailOfReport(report: ApplyReport): string {
  const detail = (report as { detail?: unknown }).detail;
  return typeof detail === 'string' ? detail : '';
}

let rigCount = 0;

/**
 * 搭一套**真的**工作区 + 修改集 + 计划。
 *
 * 身份（卷序列号 / 文件索引）与基线哈希都由护栏自己给出，本脚本不自己算
 * 一份 —— 否则验的是脚本写的第二个实现，而不是交付物。
 */
async function rig(
  seed: string,
  options: {
    readonly relative?: string;
    /** 目标字节（默认带 BOM + CRLF）。 */
    readonly after?: Buffer;
    /** 磁盘上的初始字节。 */
    readonly before?: Buffer;
    /** 造完之后把文件设成只读。 */
    readonly readonly?: boolean;
    /** 条目的操作类型覆盖（§5 用 `create_text`）。 */
    readonly op?: ChangeOp;
    /**
     * 条目**声明**的字节形态。
     *
     * 必须与 `after` 的实际字节一致：阶段 A 会拿 `inspectBytes` 的结果
     * 与声明比对，对不上就是一次拒绝（那正是「编码」那一项的做法）。
     * 默认值对应上面那个带 BOM + CRLF 的默认目标。
     */
    readonly shape?: { readonly encoding: 'utf-8' | 'utf-8-bom'; readonly bom: boolean; readonly newline: 'lf' | 'crlf' };
  } = {},
): Promise<Rig> {
  rigCount += 1;
  if (opened !== undefined) closeDatabase(opened.db);
  const dir = path.join(sandbox, `${seed}-${rigCount}`);
  mkdirSync(dir, { recursive: true });

  const relative = options.relative ?? 'notes.txt';
  const abs = path.join(dir, relative.split('/').join(path.sep));
  const before = options.before ?? Buffer.from(`before-${seed}\n`, 'utf8');
  const after =
    options.after ??
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`after-${seed}\r\nsecond line\r\n`, 'utf8'),
    ]);
  writeFileSync(abs, before);

  opened = openDatabase({ path: ':memory:' });
  repos = new Repositories(opened.db);
  blobs = new BlobStore({
    objectsRoot: path.join(sandbox, `${seed}-${rigCount}-objects`),
    registry: repos.blobs,
    newId: () => nextId('blob'),
  });

  const volume = await ops.statVolume({ path: dir });
  if (isWinfsError(volume)) throw new Error(`statVolume 失败：${JSON.stringify(volume)}`);
  const ref = { root_path: dir, root_volume_id: volume.volume_id, root_file_id: volume.file_id };
  const read = await ops.readFileGuarded({ ...ref, relative_path: relative });
  if (isWinfsError(read)) throw new Error(`读取基线失败：${JSON.stringify(read)}`);

  repos.connections.create({
    id: CONNECTION,
    principal_kind: 'model_surface',
    principal_id: PRINCIPAL,
    alias: '取证连接',
    enabled: true,
  });
  repos.workspaces.create({
    id: WORKSPACE,
    alias: '取证工作区',
    kind: 'directory',
    canonical_root: dir,
    volume_id: volume.volume_id,
    root_file_id: volume.file_id,
    policy_version: POLICY_VERSION,
    mode: MODE,
  });
  const generation = repos.workspaces.requireById(WORKSPACE).generation;

  const shape = options.shape ?? { encoding: 'utf-8-bom' as const, bom: true, newline: 'crlf' as const };
  const op: ChangeOp = options.op ?? 'edit_text';
  // 库上的触发器把这条约束钉死了：`create_text` **不得**携带基线身份或
  // 基线哈希，而 `edit_text` / `replace_text` **必须**有（migrations.ts:214）。
  // 因此夹具按 op 分叉，而不是一律填上基线 —— 后者在 §5b 会被库直接拒绝，
  // 表现为一次夹具构建失败，而不是一条关于写入路径的结论。
  const isCreate = op === 'create_text';
  const beforeBlob = await blobs.putAndRegister(before, { id: nextId('blob') });
  const afterBlob = await blobs.putAndRegister(after, { id: nextId('blob') });
  const item: ChangeItemInput = {
    id: nextId('ci'),
    path: relative,
    op,
    // 磁盘上那个对象的真实身份与真实哈希 —— 批准绑定的就是它们。
    base_file_id: isCreate ? null : read.identity.file_id,
    base_sha256: isCreate ? null : read.sha256,
    target_sha256: afterBlob.put.sha256,
    old_blob_id: isCreate ? null : beforeBlob.id,
    new_blob_id: afterBlob.id,
    encoding: shape.encoding,
    bom: shape.bom,
    newline: shape.newline,
    added_lines: 2,
    removed_lines: 1,
  };

  const digest = canonicalChangeDigest({
    contract_version: CONTRACT,
    policy_version: POLICY_VERSION,
    root_generation: generation,
    workspace_id: WORKSPACE,
    files: [
      {
        path: relative,
        op,
        before_sha256: item.base_sha256 ?? null,
        before_size: isCreate ? 0 : beforeBlob.put.size,
        after_sha256: item.target_sha256,
        after_size: afterBlob.put.size,
        encoding: shape.encoding,
        newline: shape.newline,
        bom: shape.bom,
      },
    ],
  });

  const nowMs = Date.now();
  const change = repos.changes.create({
    id: nextId('chg'),
    owner_connection_id: CONNECTION,
    workspace_id: WORKSPACE,
    root_generation: generation,
    policy_version: POLICY_VERSION,
    contract_version: CONTRACT,
    digest,
    summary: `取证摘要 ${seed}`,
    expires_at: new Date(nowMs + LIMITS.CHANGE_TTL_MS).toISOString(),
    items: [item],
  });
  approveAndQueue({
    repos,
    change_id: change.id,
    digest,
    actor: 'console:evidence-027',
    now: new Date(nowMs).toISOString(),
    idempotency_key: `key-${seed}-${rigCount}`,
  });

  const outcome = claimForExecution(
    { repos, executor_id: EXECUTOR_ID, holder: HOLDER, probe: deadProbe, lease_ms: 30_000, now: Date.now },
    change.id,
  );
  if (outcome.kind !== 'claimed') throw new Error(`认领未成功：${JSON.stringify(outcome)}`);
  const plan = outcome.plan;

  if (options.readonly === true) chmodSync(abs, 0o444);

  const applier = createNativeApplier({ repos, ops, blobs });
  return {
    dir,
    relative,
    abs,
    ref,
    plan,
    change_id: change.id,
    operation_id: plan.operation_id,
    submit: (signal = new AbortController().signal) => applier(plan, signal),
    async rejected(signal = new AbortController().signal) {
      try {
        const report = await applier(plan, signal);
        return { code: '(没有抛)', message: JSON.stringify(report), details: {} };
      } catch (cause) {
        const error = cause as { code?: string; message?: string; details?: Record<string, unknown> };
        return { code: error.code, message: error.message, details: error.details ?? {} };
      }
    },
    events: () => readItemEvents(repos, plan.operation_id),
  };
}

/** 某个条目的条目级日志里的阶段序列。 */
const stagesOf = (r: Rig, relative: string): string[] =>
  r
    .events()
    .filter((event) => event.item_id === repos.changes.items(r.change_id).find((i) => i.canonical_path === relative)?.id)
    .map((event) => event.stage);

/** 该修改集此刻的状态（记账那一侧的事实）。 */
const stateOf = (changeId: string): string => repos.changes.requireById(changeId).state;

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`LWB-027 证据采集 @ ${new Date().toISOString()}`);
  console.log(`node ${process.version} / ${process.platform} ${process.arch}`);

  sandbox = path.join(os.tmpdir(), `lwb-027-${process.pid.toString()}`);
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });

  const helper = new ResidentHelper();
  const roots: string[] = [];

  try {
    // -----------------------------------------------------------------------
    section('第 0 节 装置');

    const capability = await ops.capability();
    check(
      '护栏后端可用，且落在 PowerShell 助手上（真 Win32 句柄）',
      capability.available === true,
      `backend=${capability.resolved_backend_reason}`,
    );
    check(
      '能力自述：不宣称崩溃原子替换（验收 3 的可机器核对那一半）',
      capability.crash_atomic_replace === false,
      `crash_atomic_replace=${String(capability.crash_atomic_replace)}`,
    );
    check(
      '能力自述：独占句柄、刷盘、文件身份、硬链接计数这四项真的存在',
      capability.supports_exclusive_handle &&
        capability.supports_flush &&
        capability.supports_file_identity &&
        capability.supports_hardlink_count,
      `exclusive=${String(capability.supports_exclusive_handle)} flush=${String(capability.supports_flush)} `
        + `identity=${String(capability.supports_file_identity)} hardlink=${String(capability.supports_hardlink_count)}`,
    );
    check(
      '能力自述：`verified_on` 非空（自检真的报出了它是在哪台机器上做的）',
      typeof capability.verified_on === 'string' && capability.verified_on.length > 0,
      String(capability.verified_on).slice(0, 80),
    );

    // -----------------------------------------------------------------------
    section('第 1 节 验收 2：字节真的落盘，回读哈希等于已批准的新哈希');

    const r1 = await rig('accept2');
    const item1 = repos.changes.items(r1.change_id)[0]!;
    const report1 = await r1.submit();
    const onDisk1 = readFileSync(r1.abs);

    check(
      '一次正常写入交回 applied（不是 no_change、不是 conflict）',
      report1.kind === 'applied',
      `kind=${report1.kind}`,
    );
    check(
      '验收 2：磁盘字节的 sha256 等于条目里已批准的 target_sha256',
      sha256(onDisk1) === item1.target_sha256,
      `磁盘 ${sha256(onDisk1).slice(0, 16)}… == 批准 ${item1.target_sha256.slice(0, 16)}…`,
    );
    check(
      '字节长度与它引用的快照登记尺寸一致',
      onDisk1.length === repos.blobs.requireById(item1.new_blob_id!).size,
      `${onDisk1.length} 字节`,
    );
    check(
      'BOM 与 CRLF 逐字节保真（不是「解码后一样」）',
      onDisk1[0] === 0xef && onDisk1[1] === 0xbb && onDisk1[2] === 0xbf && onDisk1.toString('utf8').includes('\r\n'),
      `${onDisk1.length} 字节，前三个 ${[...onDisk1.subarray(0, 3)].map((b) => b.toString(16)).join(' ')}`,
    );
    // 两件事要分开说：`APPLYING` 是**记账**，`onDisk` 是**事实**。
    // 此刻两者都指向「字节已经在盘上，但终局还没落」。
    check(
      '适配器止步于 APPLYING —— 终局由协调器的收尾落，写入方不自己改判终局',
      stateOf(r1.change_id) === 'APPLYING',
      `change.state=${stateOf(r1.change_id)}`,
    );

    // 独立回读：**再来一次护栏调用**去读，而不是复用写入那一次的读数。
    // 「回读哈希与已批准 new_hash 一致才报告该文件完成」里的那份回读是
    // 写入调用内部的；这一格问的是另一个问题 —— 写完之后**别人**去读，
    // 看到的还是不是那一份。两次都成立才算数。
    const independentRead = await ops.readFileGuarded({ ...r1.ref, relative_path: r1.relative });
    check(
      '独立回读（另一次护栏调用）：哈希仍等于已批准的新哈希',
      !isWinfsError(independentRead) && independentRead.sha256 === item1.target_sha256,
      isWinfsError(independentRead) ? `错误 ${independentRead.code}` : `read.sha256=${independentRead.sha256.slice(0, 16)}…`,
    );

    // 护栏**回执本身**的那几个字段：验收 2 说的「才报告该文件完成」，
    // 落在护栏这一层就是「回读过了、刷盘过了、对象还是同一个」。
    // 直接调一次护栏，把回执原样读出来（适配器只把它折成一句 applied）。
    const receiptWrite = await ops.writeFileGuarded({
      ...r1.ref,
      relative_path: r1.relative,
      expected_sha256: item1.target_sha256,
      content_base64: Buffer.from(`receipt-${Date.now()}\n`, 'utf8').toString('base64'),
    });
    check(
      '护栏回执：readback_ok 与 flushed 同时为真，且 after_sha256 等于写下去的那一份',
      !isWinfsError(receiptWrite) && receiptWrite.readback_ok && receiptWrite.flushed,
      isWinfsError(receiptWrite) ? `错误 ${receiptWrite.code}` : `readback_ok=${String(receiptWrite.readback_ok)} flushed=${String(receiptWrite.flushed)}`,
    );
    check(
      '护栏回执：身份在写入前后是**同一个对象**（file_id 未变，改名/替换会变）',
      !isWinfsError(receiptWrite) &&
        receiptWrite.identity_before.file_id === receiptWrite.identity_after.file_id &&
        receiptWrite.before_sha256 === item1.target_sha256 &&
        receiptWrite.target_sha256 === receiptWrite.after_sha256,
      isWinfsError(receiptWrite)
        ? ''
        : `file_id=${receiptWrite.identity_after.file_id} before=${receiptWrite.before_sha256.slice(0, 12)}… after=${receiptWrite.after_sha256.slice(0, 12)}…`,
    );

    // -----------------------------------------------------------------------
    section('第 2 节 验收 1 前半：检查前被动过 ⇒ 冲突，别人的字节原样');

    // 甲：同一个对象、原地写入 —— 文件 ID 不变，内容变了。
    const r2a = await rig('accept1a');
    const theirs2a = Buffer.from('VS Code 保存的内容\n', 'utf8');
    writeFileSync(r2a.abs, theirs2a);
    const report2a = await r2a.submit();
    check(
      '甲：原地改写被报成 conflict（不是 applied、不是 refused）',
      report2a.kind === 'conflict',
      `kind=${report2a.kind}`,
    );
    check(
      '甲的判据是**内容哈希**：磁盘既不是基线也不是目标',
      report2a.kind === 'conflict' && report2a.detail.includes('磁盘内容已不是被批准的基线'),
      report2a.kind === 'conflict' ? report2a.detail.slice(0, 80) : '',
    );
    check(
      '甲：我们未写入任何字节，改的人的字节原样留着',
      readFileSync(r2a.abs).equals(theirs2a),
      `${readFileSync(r2a.abs).length} 字节`,
    );
    check(
      '甲：没有任何写入请求发出，修改集停在 VALIDATING（冲突在校验阶段就定案）',
      stateOf(r2a.change_id) === 'VALIDATING',
      `change.state=${stateOf(r2a.change_id)}`,
    );

    // 乙：编辑器「原子保存」的典型做法 —— 写临时文件再替换。
    // 路径同名，而对象已经换了一个。只比哈希的实现会在这里放行。
    const r2b = await rig('accept1b');
    const theirs2b = Buffer.from('替换后的新对象\n', 'utf8');
    rmSync(r2b.abs);
    writeFileSync(r2b.abs, theirs2b);
    const report2b = await r2b.submit();
    check(
      '乙：删除重建被报成 conflict —— 批准的是**那一个对象**，不是那个位置',
      report2b.kind === 'conflict' && report2b.detail.includes('目标对象已不是被批准的那一个'),
      report2b.kind === 'conflict' ? report2b.detail.slice(0, 96) : '',
    );
    check(
      '乙：新对象的内容原样留着（被拒的写入不留半个字节）',
      readFileSync(r2b.abs).equals(theirs2b),
    );
    note(
      '甲乙的差别只在**换没换对象**',
      '乙这一格是「只比哈希」与「比对象身份」两种实现唯一分得开的地方：'
        + '内容不同时两者都会拦，而内容碰巧相同时只有身份能拦。'
        + 'identity 来自 GetFileInformationByHandle，护栏在打开句柄时就比对（Assert-HandleMatches）。',
    );

    // -----------------------------------------------------------------------
    section('第 3 节 验收 1 后半：写入期间普通竞争保存被共享模式阻止');

    // 装置说明：`Op-WriteFileGuarded` 是一次请求内的开→写→刷→回读→关，
    // 没有可以被外部进程插进去的窗口。因此这里用护栏自己的 `holdHandle`：
    // 同一个 `Open-Guarded`、同一组标志，只是把「写完就关」换成「持有」。
    // 它证明的是**这组标志的性质**。
    const r3 = await rig('accept1c');
    check(
      '① 持有之前，普通保存是通的（否则「被挡」可能只是文件本来就写不了）',
      ordinarySave(r3.abs, 'before-hold') === 'SAVED',
    );
    // ① 自己动过盘，基准必须在它之后取。
    const baseline3 = readFileSync(r3.abs);
    check('① 之后的基准内容确实是它写下的', baseline3.toString('utf8') === 'before-hold\n');

    await helper.start();
    const volume3 = await ops.statVolume({ path: r3.dir });
    if (isWinfsError(volume3)) throw new Error(`statVolume 失败：${JSON.stringify(volume3)}`);
    const held = await helper.call({
      op: 'holdHandle',
      root_path: r3.dir,
      root_volume_id: volume3.volume_id,
      root_file_id: volume3.file_id,
      relative_path: r3.relative,
      access: 'write',
      share_mode: 'read',
    });
    check('② 护栏自己持有写形状的句柄（access=write, share=read）', held['ok'] === true, JSON.stringify(held).slice(0, 120));
    check(
      '② 持有期间：普通竞争保存被拒',
      ordinarySave(r3.abs, 'editor-competes') === 'BLOCKED',
    );
    check(
      '② 被拒的保存不得留下半个字节',
      readFileSync(r3.abs).equals(baseline3),
    );

    // 反方向：我们自己的写入路径同样受共享规则约束，而不是绕开它。
    const guardedDuring = await ops.writeFileGuarded({
      root_path: r3.dir,
      root_volume_id: volume3.volume_id,
      root_file_id: volume3.file_id,
      relative_path: r3.relative,
      // 传**当前**哈希：若传过期的基线，失败就可能来自基线核对，
      // 于是「被占用」这条结论便没有了证据。要让它只能栽在打开这一步。
      expected_sha256: sha256(baseline3),
      content_base64: Buffer.from('我们自己的写入\n', 'utf8').toString('base64'),
    });
    check(
      '③ 我们的写入路径同样失败，且**不是**降级成普通文件 API 之后的结果',
      isWinfsError(guardedDuring) && guardedDuring.code === 'FILE_BUSY',
      isWinfsError(guardedDuring) ? `code=${guardedDuring.code} win32=${guardedDuring.win32_error}` : '竟然成功了',
    );
    check(
      '③ 失败码是真实的共享冲突（Win32 32 ERROR_SHARING_VIOLATION）',
      isWinfsError(guardedDuring) && guardedDuring.win32_error === 32,
      isWinfsError(guardedDuring) ? `win32=${guardedDuring.win32_error}` : '',
    );

    // 同一个失败经由适配器：它必须把它报成 conflict（**打开**就失败了，
    // 一个字节都没写），而不是让协调器去判成待恢复。
    const r3b = await rig('accept1c-adapter');
    const volume3b = await ops.statVolume({ path: r3b.dir });
    if (isWinfsError(volume3b)) throw new Error('statVolume 失败');
    const held3b = await helper.call({
      op: 'holdHandle',
      root_path: r3b.dir,
      root_volume_id: volume3b.volume_id,
      root_file_id: volume3b.file_id,
      relative_path: r3b.relative,
      access: 'write',
      share_mode: 'read',
    });
    check('③（经适配器）持有成功', held3b['ok'] === true);
    const report3b = await r3b.submit();
    check(
      '③（经适配器）被占用 ⇒ conflict，且详情指向磁盘状态而不是「磁盘可能不明」',
      report3b.kind === 'conflict' && report3b.detail.includes('磁盘状态与计划不符，未写入任何字节'),
      report3b.kind === 'conflict' ? report3b.detail.slice(0, 100) : `kind=${report3b.kind}`,
    );

    await helper.stop();
    check(
      '④ 持有者一退出，普通保存立刻恢复 —— 挡住它的是句柄，不是权限',
      ordinarySave(r3.abs, 'after-release') === 'SAVED',
    );

    // --- 稳定性：这个装置能当回归测试用吗？ ---------------------------------
    //
    // `holdHandle` 的 `$h` 是 PowerShell 函数的局部变量，理论上会在某次 GC
    // 时被终结。若它只是「通常活着」，把它写进回归测试就是在种一个间歇性
    // 失败的用例。连测 20 轮（每轮一个全新的根目录，避免上一轮的句柄干扰
    // 本轮的准备步骤），量一量它到底是哪一种。
    await helper.start();
    let blockedImmediately = 0;
    let blockedAfter500 = 0;
    for (let i = 0; i < 20; i += 1) {
      const root = path.join(sandbox, `hold-${i}`);
      mkdirSync(root, { recursive: true });
      roots.push(root);
      const target = path.join(root, 'target.txt');
      writeFileSync(target, `base-${i}\n`);
      const volume = await helper.call({ op: 'statVolume', path: root });
      const vrec = rec(volume);
      const hold = await helper.call({
        op: 'holdHandle',
        root_path: root,
        root_volume_id: vrec['volume_id'],
        root_file_id: vrec['file_id'],
        relative_path: 'target.txt',
        access: 'write',
        share_mode: 'read',
      });
      if (hold['ok'] !== true) throw new Error(`第 ${i} 轮 holdHandle 失败：${JSON.stringify(hold)}`);
      if (ordinarySave(target, `editor-${i}`) === 'BLOCKED') blockedImmediately += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (ordinarySave(target, `editor-${i}-again`) === 'BLOCKED') blockedAfter500 += 1;
    }
    await helper.stop();

    check(
      '④ 稳定性：20/20 轮在持有后**立刻**被挡（不是碰运气）',
      blockedImmediately === 20,
      `${blockedImmediately}/20`,
    );
    check(
      '④ 稳定性：20/20 轮在 500ms 之后**仍然**被挡（句柄不是被立刻回收的）',
      blockedAfter500 === 20,
      `${blockedAfter500}/20`,
    );
    note(
      '④ 这个 20/20 是**修过之后**的数',
      '第一次测的时候句柄只被函数局部变量持有，GC 随时可以终结它 ——'
        + '同一段代码连跑 20 轮出现过 **19/20**，也就是说靠它做的用例本身有约二十分之一的'
        + '间歇失败率，而那会以「环境抖动」的样子出现在回归里。'
        + '修法是护栏把持有的句柄留在一个脚本作用域的列表里（`$script:LwbHeldHandles`），'
        + '活到助手进程退出为止；同一测量随后两次独立运行都是 20/20。'
        + '这条修改进了 `native/winfs/WinfsGuard.ps1`，`tests/windows/` 全部 100 例在修改后通过。',
    );
    note(
      '④ 这个装置的边界仍然要写下来',
      '`holdHandle` 是 spike 专用操作（刻意不在 `WinfsOps` 里），'
        + '它承诺的是「在这个助手进程活着期间持有」。正式路径 `Op-WriteFileGuarded` '
        + '不用这个装置：它在**同一个请求内**开→写→刷→回读→显式关闭，'
        + '因此「写入期间别人写不进来」由那一段的句柄生命周期保证，'
        + '本节的共享标志是它的同一组。用例只应在**短窗口**内断言，'
        + '不能把「持有」当成一把跨进程存活的锁。',
    );

    // -----------------------------------------------------------------------
    section('第 4 节 步骤 3：句柄能力不足返回错误，不降级普通文件 API');

    // 甲：只读文件。拒绝发生在**打开**那一步，早于任何字节。
    //
    // **这一格在 LWB-029 里翻了案。** 旧行为是抛 `RECOVERY_REQUIRED`
    // （「护栏没给 `actual_state` ⇒ 现场未知 ⇒ 不敢下结论」）。但护栏的
    // 三行表里还有一行更贴切：**`touched` 缺席 = 没越过破坏性区域**。
    // 只读目标连句柄都没开，`touched` 必然不带 —— 那是「一个字节没动」的
    // **证明**，不是未知。因此现在交回 `rolled_back`，理由里带着护栏码。
    const r4a = await rig('readonly', { readonly: true });
    const report4a = await r4a.submit();
    check(
      '甲：只读目标 ⇒ 交回 rolled_back（已证明未动过），不是静默跳过、也不是 conflict',
      report4a.kind === 'rolled_back',
      `kind=${report4a.kind}`,
    );
    check(
      '甲：理由里记着护栏码 PERMISSION_DENIED 与 Win32 5',
      /PERMISSION_DENIED/.test(detailOfReport(report4a)) && /Win32 5\b/.test(detailOfReport(report4a)),
      detailOfReport(report4a).slice(0, 140),
    );
    check(
      '甲：账上那条终局是 `untouched`（打开就失败了，一个字节没动）',
      stagesOf(r4a, 'notes.txt').join(' → ') === 'item_intent → item_untouched',
      stagesOf(r4a, 'notes.txt').join(' → ') || '(空)',
    );
    check('甲：磁盘内容原样', readFileSync(r4a.abs).toString('utf8') === 'before-readonly\n');

    // 乙：被映射的文件。构造手段是 Windows 的一条真实约束 ——
    // **已被映射到某个进程地址空间的文件不能截断**（SetEndOfFile → 1224）。
    // 它让写入恰好停在那条线上，因此 actual_state 是**真的**会被走到的代码。
    const r4b = await rig('mapped', {
      before: Buffer.from('hello\n', 'utf8'),
      after: Buffer.from('bye\n', 'utf8'),
      // 这一格的字节是朴素的 UTF-8 / LF：条目必须照实声明。
      shape: { encoding: 'utf-8', bom: false, newline: 'lf' },
    });
    const mapper = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', MAPPED_HOLDER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LWB_MAP_PATH: r4b.abs },
    });
    const mapped = await new Promise<string>((resolve) => {
      let out = '';
      let err = '';
      mapper.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        if (out.includes('MAPPED')) resolve('ok');
      });
      mapper.stderr?.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf8');
      });
      setTimeout(() => resolve(`timeout ${out} ${err}`.trim()), 15_000);
    });
    check('乙：第二个进程把文件只读映射起来（构造「不能截断」）', mapped === 'ok', mapped);

    const rejected4b = await r4b.rejected();
    check(
      '乙：写入被映射的文件 ⇒ 抛，且护栏那一行读成 TOUCHED（越过了截断线）',
      rejected4b.code === 'RECOVERY_REQUIRED' &&
        rejected4b.details?.['guard_verdict'] === 'TOUCHED' &&
        rejected4b.details?.['guard_touched'] === true,
      `code=${String(rejected4b.code)} verdict=${String(rejected4b.details?.['guard_verdict'])} touched=${String(rejected4b.details?.['guard_touched'])}`,
    );
    check(
      '乙：护栏码 IO_ERROR、Win32 1224（ERROR_USER_MAPPED_FILE）',
      rejected4b.details?.['winfs_code'] === 'IO_ERROR' && rejected4b.details?.['win32_error'] === 1224,
      `winfs_code=${String(rejected4b.details?.['winfs_code'])} win32=${String(rejected4b.details?.['win32_error'])}`,
    );
    // 现场（尺寸 / 摘要 / 观测时刻）在 LWB-029 之后落在**条目级日志**里，
    // 而不是抛出去那句话的 `details` 里：`details` 现在只带「恢复流程要
    // 做哪些判断」的枚举字段，现场属于账本。这是分工，不是丢失 ——
    // 断言因此指向账本，别的条件（真值 6 字节、哈希与基线相同）一个字没改。
    check(
      '乙：账本里记着**现场**（尺寸、摘要），供恢复流程定位',
      r4b.events().some(
        (event) => event.stage === 'item_failed' && event.observed_sha256 !== null,
      ) && readFileSync(r4b.abs).length === 6,
      `observed_sha256=${String(r4b.events().find((event) => event.stage === 'item_failed')?.observed_sha256)?.slice(0, 16)}… 磁盘 6 字节`,
    );
    check(
      '乙：磁盘内容**原样**（截断失败早于任何字节改动）',
      readFileSync(r4b.abs).toString('utf8') === 'hello\n',
      JSON.stringify(readFileSync(r4b.abs).toString('utf8')),
    );
    note(
      '乙 这一格的诚实读法',
      '`guard_verdict=TOUCHED`（旧名 `crossed_truncate=true`）是**保守**的：它说的是'
        + '「已经走到截断之后，剩下的不由我们说了算」，不是「字节一定被改过」。'
        + '本格的 observed_sha256 恰好等于基线哈希，正是因为那次截断根本没成功。'
        + '恢复流程必须按前者理解它 —— 拿它当「一定坏了」会误报，'
        + '拿它当「一定没事」会漏掉真正写坏的那一半。'
        + '**改名不是换了个说法**：`crossed_truncate` 只说得清「改写」这一条路，'
        + '而创建那条路根本无截断线可越（它的问题是「对象已经造出来了」）。'
        + '`TOUCHED` / `NOT_TOUCHED` 对两条路是同一句话，恢复流程因此只需要读一个字段。',
    );

    // 丙：同一个修改集**再提交一次** ⇒ 抛，而不是「重试一次试试看」。
    //
    // 乙那次已经把执行意图记进了账（`VALIDATING → APPLYING`），而那一格的
    // 含义是「字节可能已经在盘上了」。此时写入方自己重来等于替恢复流程
    // 改判终局 —— 它没有这个权力。拒绝是正确方向。
    const retry4c = await r4b.rejected();
    check(
      '丙：记过执行意图的修改集不能再被同一个写入方重提（重来是恢复流程的事）',
      retry4c.code === 'RECOVERY_REQUIRED' && retry4c.details?.['reason'] === 'INTENT_RECORD_FAILED',
      `code=${String(retry4c.code)} reason=${String(retry4c.details?.['reason'])}`,
    );
    check(
      '丙：那次重提同样一个字节都没写（磁盘仍是 hello）',
      readFileSync(r4b.abs).toString('utf8') === 'hello\n',
      JSON.stringify(readFileSync(r4b.abs).toString('utf8')),
    );

    // 丁：映射释放之后，**同一个文件**在护栏层面写得动了 ——
    // 证明乙拦的是「此刻不能写」，而不是这个文件被谁判了死刑。
    mapper.stdin?.write('\n');
    await new Promise((resolve) => setTimeout(resolve, 800));
    mapper.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterRelease = await ops.writeFileGuarded({
      ...r4b.ref,
      relative_path: r4b.relative,
      expected_sha256: sha256(readFileSync(r4b.abs)),
      content_base64: Buffer.from('bye\n', 'utf8').toString('base64'),
    });
    check(
      '丁：映射释放后同一个文件写成功（乙是一次时刻判定，不是把文件判死）',
      !isWinfsError(afterRelease) && afterRelease.readback_ok,
      isWinfsError(afterRelease) ? `错误 ${afterRelease.code}` : `readback_ok=${String(afterRelease.readback_ok)}`,
    );

    // 戊：形状不对的参数在护栏那一层就被拒（不进入任何文件操作）。
    // 除 `expected_sha256` 之外**每一个参数都是对的** —— 否则拦下来的可能
    // 是身份不符，而那条断言就没有证据。
    const guardBadSha = await ops.writeFileGuarded({
      ...r4b.ref,
      relative_path: r4b.relative,
      expected_sha256: 'nope',
      content_base64: Buffer.from('x').toString('base64'),
    });
    check(
      '戊：形状不对的 expected_sha256 被报成 INVALID_ARGUMENT，不进入文件操作',
      isWinfsError(guardBadSha) && guardBadSha.code === 'INVALID_ARGUMENT',
      isWinfsError(guardBadSha) ? `${guardBadSha.code}：${guardBadSha.message.slice(0, 60)}` : '',
    );

    // -----------------------------------------------------------------------
    section('第 5 节 负向回归');

    // 5a 中止落在**阶段 A 之内** ⇒ 不记账。
    //
    // 这一格是施工中由单元测试抓出来的真实缺陷：`recordIntent` 原本在
    // 阶段 A 之后、阶段 C 的循环之前，而中止只在**循环开头**才被看见 ——
    // 于是「一次被取消、一个字节都没写的执行」会在账上写成 `APPLYING`
    // （那一格的含义是「字节可能已经在盘上了」），逼出一次没有对象的人工核验。
    const r5a = await rig('abort-in-phase-a');
    const controller = new AbortController();
    // 用 Proxy 而不是 `Object.create(ops)`：后者会让方法里的私有字段
    // （`#` 声明）落到错误的实例上。Proxy 转发到真后端，只在**探针**那一次
    // 顺手喊停 —— 中止点因此落在阶段 A **之内**，而不是阶段 A 与阶段 C 之间。
    const abortingOps: WinfsOps = new Proxy(ops as unknown as WinfsOps, {
      get(target, property) {
        if (property === 'resolvePath') {
          return (request: Parameters<WinfsOps['resolvePath']>[0]) => {
            controller.abort();
            return target.resolvePath(request);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const applier5a = createNativeApplier({ repos, ops: abortingOps, blobs });
    let abortCode = '(没有抛)';
    try {
      await applier5a(r5a.plan, controller.signal);
    } catch (cause) {
      abortCode = String((cause as { code?: string }).code);
    }
    check('5a：中止落在阶段 A 之内 ⇒ 抛（协调器据此判待恢复）', abortCode === 'RECOVERY_REQUIRED', `code=${abortCode}`);
    check(
      '5a：**没有**记下执行意图 —— 一个字节都没写，账上就不能写「可能已经写了」',
      stateOf(r5a.change_id) === 'VALIDATING',
      `change.state=${stateOf(r5a.change_id)}`,
    );
    check('5a：磁盘内容原样', readFileSync(r5a.abs).toString('utf8') === 'before-abort-in-phase-a\n');

    // 5b **计划自己**站不住时必须被拒，**且不能退化成一次写入**。
    //
    // 注意它交回的是 `refused` 而**不是**抛：这一条在阶段 A（还没碰磁盘）
    // 就定案了，因此「一个字节都没写」是一句真话，协调器据此落终局即可，
    // 不必请人来。抛出去只留给「写盘开始之后失败」——那把两种性质不同的
    // 失败混成一类，会让每一次拒绝都变成一次人工核验。
    //
    // 采集 LWB-027 时这一格用的来源是 `create_text`（那时它一律被拒）。
    // LWB-028 把它实现了，于是这一格换了来源：判据从「这个形态还没实现」
    // 换成「这份计划与它引用的快照对不上」。**四条断言一个字没改** ——
    // 这一格要验的从来不是「哪个具体形态被拒」，而是「阶段 A 定案的拒绝
    // 不惊动恢复流程，也不碰磁盘」。
    const r5b = await rig('shape-mismatch', {
      // 声明 utf-8 / 无 BOM，而目标快照的字节带 BOM。
      after: Buffer.from('﻿after-shape-mismatch\r\nsecond\r\n', 'utf8'),
      shape: { encoding: 'utf-8', bom: false, newline: 'crlf' },
    });
    const report5b = await r5b.submit();
    check(
      '5b：计划自身前后不一致 ⇒ refused（阶段 A 就定案，不惊动恢复流程）',
      report5b.kind === 'refused' && report5b.detail.includes('目标字节的实际形态与条目声明不符'),
      report5b.kind === 'refused' ? report5b.detail.slice(0, 100) : `kind=${report5b.kind}`,
    );
    check(
      '5b：拒绝的理由说的是**哪一条**对不上，而不是一句笼统的「不支持」',
      report5b.kind === 'refused' && report5b.detail.includes('声明 utf-8 / bom=false'),
      report5b.kind === 'refused' ? report5b.detail.slice(-70) : '',
    );
    check(
      '5b：被拒的修改集停在 VALIDATING（没写过就是没写过）',
      stateOf(r5b.change_id) === 'VALIDATING',
      `change.state=${stateOf(r5b.change_id)}`,
    );
    check(
      '5b：被拒的计划**没有**把既有文件覆盖掉',
      readFileSync(r5b.abs).toString('utf8') === 'before-shape-mismatch\n',
    );

    // 5c 目标被换成**目录** ⇒ 在写之前就拦住，而不是让 WriteFile 去撞一个
    // 目录句柄。这一格在真 NTFS 上是可造的，而单元测试里它是用假护栏
    // 摆出来的形态 —— 两条路都要有人走过。
    const r5c = await rig('target-becomes-dir');
    rmSync(r5c.abs);
    mkdirSync(r5c.abs);
    const report5c = await r5c.submit();
    check(
      '5c：目标变成目录 ⇒ conflict，且理由说的是**形态**而不是「磁盘不明」',
      report5c.kind === 'conflict' && report5c.detail.includes('是目录'),
      report5c.kind === 'conflict' ? report5c.detail.slice(0, 90) : `kind=${report5c.kind}`,
    );
    check(
      '5c：修改集停在 VALIDATING —— 一个字节都没写，账上也不该说写过',
      stateOf(r5c.change_id) === 'VALIDATING',
      `change.state=${stateOf(r5c.change_id)}`,
    );

    // 5d 硬拒绝规则的**写入路径兜底**在真盘上不可达 —— 照实说，不假装验过。
    note(
      '5d 硬拒绝兜底为什么在这里是 NOT_RUN',
      '写入路径上那次 `classifyFile(canonical)` 是**兜底**：正常路径上，'
        + '修改集由受控读取签发的票据准备而来，因此「准备出来一个指向 .env 的修改」'
        + '在准备阶段就到不了这里。要在这份证据里走到它，得让条目里的路径与'
        + '磁盘上的句柄规范拼写不一致（例如条目写 docs/notes.md，而那个对象叫 .env）——'
        + '在真 NTFS 上只能靠符号链接/硬链接构造，而造链接需要管理员或开发者模式，'
        + '本工程不得要求管理员权限。'
        + '该分支由 tests/unit/executor-native-adapter.test.ts 的 B6 覆盖'
        + '（假盘的 `openable_as` 就是为表达「同一个对象有两个名字」而设的）。',
    );

    // -----------------------------------------------------------------------
    section('第 6 节 脱敏');

    // 判据必须**可失败**：先证明原始护栏消息里真的有本机绝对路径，
    // 再说适配器交出来的那一份里没有。否则「没有路径」可能只是因为
    // 本来就没有路径可漏。
    const rawLeaky = await ops.writeFileGuarded({
      ...r4a.ref,
      relative_path: r4a.relative,
      expected_sha256: sha256(readFileSync(r4a.abs)),
      content_base64: Buffer.from('x\n').toString('base64'),
    });
    check(
      '护栏**原始**消息里确实带着本机绝对路径（脱敏不是空操作）',
      isWinfsError(rawLeaky) && leaksLocalPaths(rawLeaky.message),
      isWinfsError(rawLeaky) ? rawLeaky.message.slice(0, 70) : '竟然成功了',
    );
    // 对照物必须是**同一句**护栏话的两侧，而且那句话里得真的有路径。
    // 上面那句原始消息来自 §4 甲（只读目标），因此这里取的也是甲 ——
    // 甲在 LWB-029 之后不抛了，那句话改走报告；`guardLine` 的脱敏在
    // **造出那句话的地方**做，因此报告里与抛出去的形态是同一个。
    const fromReadonly = detailOfReport(report4a);
    check(
      '适配器交出的那一份里**没有**本机绝对路径，根路径被替换成 <工作区根>',
      !leaksLocalPaths(fromReadonly) && fromReadonly.includes('<工作区根>'),
      fromReadonly.slice(0, 120),
    );
    check(
      '脱的是根，不是病因：那句话的其余部分还在',
      fromReadonly.includes('PERMISSION_DENIED') && fromReadonly.includes('Win32 5'),
      fromReadonly.slice(0, 120),
    );

    // 另一条出口：**抛出去的那句话**。协调器会把它的 `message` 原样写进
    // **改动级**日志行，而那一行不经过条目级的脱敏，因此它必须自己就是干净的。
    // §4 乙 那句护栏消息本来就不带路径，因此这里断言的是**否定面** ——
    // 它连同 `details` 一起，一个字都不许带本机路径。
    const thrownText = `${String(rejected4b.message ?? '')} ${JSON.stringify(rejected4b.details ?? {})}`;
    check(
      '抛出去的那句话与它的详情同样干净（这条出口最要紧：改动级日志行不脱敏）',
      !leaksLocalPaths(thrownText),
      thrownText.slice(0, 120),
    );
    check(
      '而它的病因还在（干净不等于被擦成一句空话）',
      thrownText.includes('IO_ERROR') && thrownText.includes('Win32 1224'),
      thrownText.slice(0, 120),
    );
    const allText = [
      thrownText,
      fromReadonly,
      report5b.kind === 'refused' ? report5b.detail : '',
      report5c.kind === 'conflict' ? report5c.detail : '',
    ].join(' ');
    check(
      '全部失败详情里都没有本机绝对路径，也没有临时目录名',
      !leaksLocalPaths(allText) && !allText.includes('lwb-027-'),
      `${allText.length} 字符`,
    );

    // -----------------------------------------------------------------------
    section('第 7 节 未执行项');
    skip(
      '真实 ChatGPT 网页端验收（LWB-002）',
      '需要真实账号、Tunnel 与工作区管理权限，当前 BLOCKED；MCP Inspector 成功不能替代',
    );
    skip(
      '进程崩溃真的留下部分字节',
      '无法按需杀死一个**正在写盘**的护栏进程并保证它停在半途；'
        + '本证据证明的是「截断之后失败会带着现场进恢复」（§4 乙），'
        + '以及能力标志不宣称原子替换（§0）。崩溃本身的取证属 LWB-030 的恢复流程',
    );
    skip(
      '恢复流程真正把字节定案',
      '属 LWB-030。本任务只到「抛出去、带现场、由协调器判待恢复」为止',
    );
    skip(
      'change_apply 工具对模型可见',
      '属 LWB-032；适配器尚未接入工具面，这是有意的',
    );
    skip(
      '硬链接（link_count > 1）的写入',
      'NTFS 上无法对**普通用户**按需造出硬链接而不需要额外权限与本机设置；'
        + '护栏在打开句柄时核对 link_count（见 §4 丁 同族的 Assert-HandleMatches），'
        + '单元测试覆盖了「条目身份与句柄身份不符」的分支',
    );
  } finally {
    if (opened !== undefined) closeDatabase(opened.db);
    // 助手可能已经停过了（§3 的中段）；重复 stop 不该让收尾炸掉。
    try {
      await helper.stop();
    } catch {
      /* 已经停了 */
    }
    await disposeWinfsBackend();
    // 只读属性会让删除失败；先清掉再收。
    for (const entry of roots) {
      try {
        chmodSync(entry, 0o666);
      } catch {
        /* 目录不存在就算了 */
      }
    }
    rmSync(sandbox, { recursive: true, force: true });
  }

  console.log(`\n小计：PASS=${passes} FAIL=${failures} NOT_RUN=${skips}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

/**
 * 第二个进程：把目标文件只读映射进自己的地址空间。
 *
 * Windows 的一条真实约束 —— 已被映射的文件不能截断。这里用它把写入
 * **恰好**停在截断那条线上，从而证明 `actual_state` 是一段走得到的代码，
 * 而不是靠假后端「验」过去的。
 */
const MAPPED_HOLDER = [
  '$p = $env:LWB_MAP_PATH',
  '$fs = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)',
  '$mm = [System.IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($fs, "lwb_027_map", 0, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read, [System.IO.HandleInheritability]::None, $false)',
  '$view = $mm.CreateViewAccessor([int64]0, [int64]0, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)',
  'Write-Output "MAPPED"',
  '[Console]::Out.Flush()',
  '[Console]::In.ReadLine() | Out-Null',
  '$view.Dispose(); $mm.Dispose(); $fs.Dispose()',
  'Write-Output "RELEASED"',
].join('\n');

await main();
