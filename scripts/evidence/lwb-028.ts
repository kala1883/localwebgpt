/**
 * LWB-028 可复现证据采集：不覆盖的文本文件创建。
 *
 * 装置与 LWB-027 同一套：**真 NTFS** ←经→ 真 `PowerShellWinfsBackend`（真的
 * `CreateFileW` + `CREATE_NEW`、`WriteFile`、`FlushFileBuffers`、
 * `GetFileInformationByHandle`）→ 真适配器（`packages/executor/src/native-adapter.ts`）
 * → 真 SQLite、真快照库、真 `claimForExecution`。**没有假件**。
 *
 * ## 逐条对应任务书
 *
 *  步骤 1「仅允许在已存在的父目录中创建文件；创建前检查目标不存在」 ——
 *  §1 与 §3。§3 直接证明「父目录缺失 ⇒ 拒绝」以及「拒绝之后那一级目录
 *  在磁盘上依然不存在」（不隐式 `mkdir`）。
 *
 *  步骤 2「使用 `CREATE_NEW` 语义，失败时不重试覆盖」 —— §2。这条判据的
 *  可核对形式是**两次调用之间的那个窗口**：§2 丙 把抢先发生在那段窗口里，
 *  看结果是「拒绝 + 抢先者的字节原样」还是「覆盖」。护栏侧的直接观测在 §2 乙。
 *
 *  步骤 3「创建结果记录到快照/日志，并支持回读校验」 —— §1 的回执与独立
 *  回读。**持久化日志**属 LWB-029（本任务的记录是内存里的报告与账上的
 *  状态），因此这一条只做得到它可核对的另一半。
 *
 *  验收 1「检查不存在后被别人创建的文件不会被覆盖」 —— §2 甲（三种占位形态）
 *  与 §2 丙（真竞争窗口）。
 *  验收 2「新文件部分写入/进程退出能被识别为恢复事项」 —— §5 丙（创建之后
 *  失败 ⇒ 待恢复，护栏那一行读成 `TOUCHED`）与 §2 丙（创建**没**成功 ⇒
 *  不报待恢复，因为护栏没带 `touched` 本身就是「一个字节都没动」的证明）。
 *  **真盘上按需打断**做不到，见 §7 的 NOT_RUN。
 *  验收 3「不隐式创建父目录、修改 ACL 或设置执行权限」 —— §3（父目录）与
 *  §4（ACL / 属性 / 执行位）。
 *
 * 用法：node --import tsx scripts/evidence/lwb-028.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件证明不了的事（见 §7）：**真实 ChatGPT 网页端验收**需要真实账号与
 * Secure MCP Tunnel 凭据，当前 BLOCKED（LWB-002）；**恢复流程**属 LWB-030；
 * `change_apply` 工具对模型可见属 LWB-032；**执行日志的持久化**属 LWB-029。
 * MCP Inspector 的一次成功不能替代第一项。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { approveAndQueue } from '@lwb/approvals';
import { BlobStore } from '@lwb/blob-store';
import { canonicalChangeDigest } from '@lwb/changes';
import { CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import { claimForExecution, createNativeApplier, readItemEvents } from '@lwb/executor';
import type { ApplyReport, ExecutionPlan, NativeApplierDeps } from '@lwb/executor';
import type { ProcessProbe } from '@lwb/ipc';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { ChangeItemInput, OpenDatabaseResult } from '@lwb/persistence';
import { getWinfsBackend, ResidentHelper, disposeWinfsBackend, isWinfsError } from '@lwb/winfs';
import type { WinfsError, WinfsOps } from '@lwb/winfs';

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

/** 报告里那句给人看的话（`kind` 之外唯一允许存在的字段）。 */
function detailOfReport(report: Record<string, unknown>): string {
  const detail = report['detail'];
  return typeof detail === 'string' ? detail : '';
}

/** 某个条目的**条目级**日志里的阶段序列（按 `seq` 的落库顺序）。 */
function stagesOf(rig: Rig, relative: string): string[] {
  const item = repos.changes.items(rig.change_id).find((entry) => entry.canonical_path === relative);
  if (item === undefined) throw new Error(`夹具里没有 ${relative}`);
  return readItemEvents(repos, rig.operation_id)
    .filter((event) => event.item_id === item.id)
    .map((event) => event.stage);
}

const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** 只认 ASCII 的结论词：本机控制台代码页会把非 ASCII 输出弄成乱码。 */
function pwsh(script: string): string {
  return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  }).trim();
}

function attributesOf(target: string): string {
  return pwsh([
    '$ErrorActionPreference = "Stop"',
    `(Get-Item -LiteralPath ${psQuote(target)}).Attributes.ToString()`,
  ].join('\n'));
}

/**
 * 一份可比的 ACL 摘要：属主 + 每一条 ACE（主体 | 权限 | 允许/拒绝 | 是否继承）。
 *
 * 刻意**不**解析成结构化对象再比较字段 —— 这一节的判据就是「两边一模一样」，
 * 把两边都折成同一个字符串再比，比逐字段比更不容易漏掉一个我没想起来的维度。
 */
function aclSummary(target: string): string {
  return pwsh([
    '$ErrorActionPreference = "Stop"',
    `$acl = Get-Acl -LiteralPath ${psQuote(target)}`,
    '"OWNER=" + $acl.Owner',
    '$acl.Access | ForEach-Object { $_.IdentityReference.ToString() + "|" + $_.FileSystemRights.ToString() + "|" + $_.AccessControlType.ToString() + "|" + $_.IsInherited.ToString() }',
  ].join('\n'));
}

/** 非继承（显式设置）的 ACE 条数。它必须为 0：护栏不碰 ACL。 */
function explicitAceCount(summary: string): number {
  return summary.split('\n').filter((line) => line.endsWith('|False')).length;
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CONNECTION = 'conn_ev28';
const WORKSPACE = 'ws_ev28';
const PRINCIPAL = 'principal_ev28';
const POLICY_VERSION = 1;
const MODE = 'read_propose_apply_with_local_approval';
const EXECUTOR_ID = 'exe_ev28';
const HOLDER = { pid: process.pid, started_at: new Date(Date.now() - 60_000).toISOString() };
const CONTRACT = CONTRACT_VERSION;

/** 认领时不该被问到：地是空的，槽是空的。 */
const deadProbe: ProcessProbe = {
  identify: () => {
    throw new Error('本证据不该问进程探针（LWB-026 已经证过它）');
  },
};

const realOps = getWinfsBackend();

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
  readonly submit: (ops?: WinfsOps, signal?: AbortSignal) => Promise<ApplyReport>;
  /** 走 `submit` 并把抛出来的东西原样交回，便于断详情。 */
  readonly rejected: (ops?: WinfsOps, signal?: AbortSignal) => Promise<{ code?: string; message?: string; details?: Record<string, unknown> }>;
}

let rigCount = 0;

/**
 * 搭一套**真的**工作区 + 修改集 + 计划，条目是 `create_text`。
 *
 * 与 LWB-027 的 `rig` 的区别是根本性的：这里**没有基线**。创建不基于任何
 * 已存在的对象，因此 `base_file_id` / `base_sha256` / `old_blob_id` 一律为
 * `null`，摘要里的 `before_sha256` 也是 `null`（库上的触发器同向钉死了这条：
 * `create_text` 不得携带基线身份或基线哈希）。
 *
 * 磁盘布局刻意**不**在函数里安排：目标占不占着、父目录在不在，都由调用点
 * 在 `submit()` 之前自己摆出来 —— 每一节的磁盘形态因此写在那一节里，
 * 而不是藏在一个带六个开关的夹具函数里。
 */
async function createRig(
  seed: string,
  options: {
    /** 条目路径（默认根下的 `created.txt`）。父目录链要由调用点自己建。 */
    readonly relative?: string;
    /** 目标字节（默认带 BOM + CRLF）。 */
    readonly after?: Buffer;
    /**
     * 条目**声明**的字节形态。必须与 `after` 的实际字节一致，否则阶段 A
     * 会拿 `inspectBytes` 的结果与声明比对并拒绝（§5 乙 用的就是这一格）。
     */
    readonly shape?: { readonly encoding: 'utf-8' | 'utf-8-bom'; readonly bom: boolean; readonly newline: 'lf' | 'crlf' };
  } = {},
): Promise<Rig> {
  rigCount += 1;
  if (opened !== undefined) closeDatabase(opened.db);
  const dir = path.join(sandbox, `${seed}-${rigCount}`);
  mkdirSync(dir, { recursive: true });

  const relative = options.relative ?? 'created.txt';
  const abs = path.join(dir, relative.split('/').join(path.sep));
  const after =
    options.after ??
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`created-${seed}\r\nsecond line\r\n`, 'utf8'),
    ]);
  const shape = options.shape ?? { encoding: 'utf-8-bom' as const, bom: true, newline: 'crlf' as const };

  opened = openDatabase({ path: ':memory:' });
  repos = new Repositories(opened.db);
  blobs = new BlobStore({
    objectsRoot: path.join(sandbox, `${seed}-${rigCount}-objects`),
    registry: repos.blobs,
    newId: () => nextId('blob'),
  });

  const volume = await realOps.statVolume({ path: dir });
  if (isWinfsError(volume)) throw new Error(`statVolume 失败：${JSON.stringify(volume)}`);
  const ref = { root_path: dir, root_volume_id: volume.volume_id, root_file_id: volume.file_id };

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

  const afterBlob = await blobs.putAndRegister(after, { id: nextId('blob') });
  const item: ChangeItemInput = {
    id: nextId('ci'),
    path: relative,
    op: 'create_text',
    base_file_id: null,
    base_sha256: null,
    target_sha256: afterBlob.put.sha256,
    old_blob_id: null,
    new_blob_id: afterBlob.id,
    encoding: shape.encoding,
    bom: shape.bom,
    newline: shape.newline,
    added_lines: 2,
    removed_lines: 0,
  };

  const digest = canonicalChangeDigest({
    contract_version: CONTRACT,
    policy_version: POLICY_VERSION,
    root_generation: generation,
    workspace_id: WORKSPACE,
    files: [
      {
        path: relative,
        op: 'create_text',
        before_sha256: null,
        before_size: 0,
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
    actor: 'console:evidence-028',
    now: new Date(nowMs).toISOString(),
    idempotency_key: `key-${seed}-${rigCount}`,
  });

  const outcome = claimForExecution(
    { repos, executor_id: EXECUTOR_ID, holder: HOLDER, probe: deadProbe, lease_ms: 30_000, now: Date.now },
    change.id,
  );
  if (outcome.kind !== 'claimed') throw new Error(`认领未成功：${JSON.stringify(outcome)}`);
  const plan = outcome.plan;

  const applierWith = (ops: WinfsOps, signal: AbortSignal) =>
    createNativeApplier({ repos, ops, blobs } as NativeApplierDeps)(plan, signal);

  return {
    dir,
    relative,
    abs,
    ref,
    plan,
    change_id: change.id,
    operation_id: plan.operation_id,
    submit: (ops = realOps, signal = new AbortController().signal) => applierWith(ops, signal),
    async rejected(ops = realOps, signal = new AbortController().signal) {
      try {
        const report = await applierWith(ops, signal);
        return { code: '(没有抛)', message: JSON.stringify(report), details: {} };
      } catch (cause) {
        const error = cause as { code?: string; message?: string; details?: Record<string, unknown> };
        return { code: error.code, message: error.message, details: error.details ?? {} };
      }
    },
  };
}

/** 该修改集此刻的状态（记账那一侧的事实）。 */
const stateOf = (changeId: string): string => repos.changes.requireById(changeId).state;

/** 目标此刻是否在磁盘上存在。 */
const exists = (target: string): boolean => {
  try {
    readFileSync(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * 数一数某个操作被调了几次。
 *
 * 与 `Object.create(backend)` 不同，Proxy 转发到真后端实例，因此方法里的
 * 私有字段（`#helper`）仍然落在正确的对象上。这一条在 LWB-027 的中止实验里
 * 已经踩过一次，这里沿用同一个装置。
 */
function countingOps(): { ops: WinfsOps; counts: { create: number; write: number; resolve: number } } {
  const counts = { create: 0, write: 0, resolve: 0 };
  const proxy: WinfsOps = new Proxy(realOps as unknown as WinfsOps, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      if (property === 'createFileGuarded') {
        return (req: unknown) => {
          counts.create += 1;
          return bound(req);
        };
      }
      if (property === 'writeFileGuarded') {
        return (req: unknown) => {
          counts.write += 1;
          return bound(req);
        };
      }
      if (property === 'resolvePath') {
        return (req: unknown) => {
          counts.resolve += 1;
          return bound(req);
        };
      }
      return bound;
    },
  });
  return { ops: proxy, counts };
}

/**
 * 把护栏的每一条**创建拒绝**补上 `touched: true`，其余转发不变。
 *
 * 用途只有一个：让**真**护栏那条消息走到「会抛出去」的那条出口上（见 §6 乙）。
 * 消息本身一个字不动，补的是判决 —— 「这个对象已经建出来了，才发现出的问题」
 * 是另一种失败，而它恰好是脱敏最难的那条路。
 */
function relabelTouched(inner: WinfsOps): WinfsOps {
  return new Proxy(inner as unknown as WinfsOps, {
    get(target, property) {
      if (property === 'createFileGuarded') {
        return async (req: Parameters<WinfsOps['createFileGuarded']>[0]) => {
          const receipt = await target.createFileGuarded(req);
          if (!isWinfsError(receipt)) return receipt;
          return { ...receipt, touched: true as const };
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * 在「检查之后、创建之前」那个窗口里动手的装置。
 *
 * 窗口的入口是 `createFileGuarded` 这一层：适配器探完磁盘、记过执行意图、
 * 走进阶段 C 之后**才**调它，因此在这个钩子里写下去的字节，位置正好落在
 * 验收标准第一条问的那一段里。真护栏仍然是被调用的那一个，抢跑者只是一次
 * 普通的文件写入。
 */
function racingOps(
  race: (request: Parameters<WinfsOps['createFileGuarded']>[0]) => void,
): { ops: WinfsOps; arm: () => void } {
  let armed = false;
  const proxy: WinfsOps = new Proxy(realOps as unknown as WinfsOps, {
    get(target, property) {
      if (property === 'createFileGuarded') {
        return async (req: Parameters<WinfsOps['createFileGuarded']>[0]) => {
          if (armed) {
            armed = false;
            race(req);
          }
          return target.createFileGuarded(req);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ops: proxy, arm: () => { armed = true; } };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`LWB-028 证据采集 @ ${new Date().toISOString()}`);
  console.log(`node ${process.version} / ${process.platform} ${process.arch}`);

  sandbox = path.join(os.tmpdir(), `lwb-028-${process.pid.toString()}`);
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });

  try {
    // -----------------------------------------------------------------------
    section('第 0 节 装置');

    const capability = await realOps.capability();
    check(
      '护栏后端可用，且落在 PowerShell 助手上（真 Win32 句柄）',
      capability.available === true,
      `backend=${capability.resolved_backend_reason}`,
    );
    check(
      '能力自述：支持 CREATE_NEW（本任务整条路都压在它上面）',
      capability.supports_create_new === true,
      `supports_create_new=${String(capability.supports_create_new)}`,
    );
    check(
      '能力自述：不宣称崩溃原子替换、也不宣称跨文件事务（两条都不含糊）',
      capability.crash_atomic_replace === false && capability.cross_file_transaction === false,
      `crash_atomic_replace=${String(capability.crash_atomic_replace)} cross_file_transaction=${String(capability.cross_file_transaction)}`,
    );
    check(
      '能力自述：`verified_on` 非空（自检真的报出了它是在哪台机器上做的）',
      typeof capability.verified_on === 'string' && capability.verified_on.length > 0,
      String(capability.verified_on).slice(0, 80),
    );

    // -----------------------------------------------------------------------
    await guarded('§1 新建', async () => {
      section('第 1 节 正向：新文件真的建出来，字节等于已批准的那一份');

      const r1 = await createRig('create-ok');
      const item1 = repos.changes.items(r1.change_id)[0]!;
      const before1 = await realOps.resolvePath({ ...r1.ref, relative_path: r1.relative, expect: 'any' });
      check(
        '① 提交之前，那个名字在磁盘上不存在 —— 由护栏自己说的（不是脚本猜的）',
        isWinfsError(before1) && before1.code === 'NOT_FOUND',
        `目录内容 ${JSON.stringify(readdirSync(r1.dir))}`,
      );

      const report1 = await r1.submit();
      const onDisk1 = readFileSync(r1.abs);

      check('② 创建交回 applied（不是 no_change、不是 conflict、不是 refused）', report1.kind === 'applied', `kind=${report1.kind}`);
      check(
        '验收 2 前半：磁盘字节的 sha256 等于条目里已批准的 target_sha256',
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
      check(
        '父目录里只多了那一个条目，没有别的产物（临时文件、备份、锁）',
        JSON.stringify(readdirSync(r1.dir)) === JSON.stringify([r1.relative]),
        JSON.stringify(readdirSync(r1.dir)),
      );
      // 两件事分开说：`APPLYING` 是**记账**，`onDisk` 是**事实**。
      check(
        '适配器止步于 APPLYING —— 终局由协调器的收尾落，写入方不自己改判终局',
        stateOf(r1.change_id) === 'APPLYING',
        `change.state=${stateOf(r1.change_id)}`,
      );

      // 独立回读：**再来一次护栏调用**去读，而不是复用创建那一次的回执。
      const independentRead = await realOps.readFileGuarded({ ...r1.ref, relative_path: r1.relative });
      check(
        '独立回读（另一次护栏调用）：哈希仍等于已批准的那一份',
        !isWinfsError(independentRead) && independentRead.sha256 === item1.target_sha256,
        isWinfsError(independentRead) ? `错误 ${independentRead.code}` : `read.sha256=${independentRead.sha256.slice(0, 16)}…`,
      );

      // 护栏**回执本身**的那几个字段：验收 2 说的「才报告该文件完成」，
      // 落在护栏这一层就是「回读过了、刷盘过了、写入字节数对得上」。
      // 直接调一次护栏（另一个名字，免得撞上刚建好的那个），把回执读出来。
      const r1b = await createRig('create-receipt');
      const payload1b = Buffer.from(`receipt-${Date.now()}\n`, 'utf8');

      // 先用**助手直连**拿一份护栏的原始响应：这一份里有 `absolute_path`。
      // 它证明「路径是护栏知道的」，脱敏因此不是把一份本来就没有路径的
      // 字符串再擦一遍。
      const helper1 = new ResidentHelper();
      await helper1.start();
      const volume1b = await realOps.statVolume({ path: r1b.dir });
      if (isWinfsError(volume1b)) throw new Error(`statVolume 失败：${JSON.stringify(volume1b)}`);
      const rawReceipt = rec(
        await helper1.call({
          op: 'createFileGuarded',
          root_path: r1b.dir,
          root_volume_id: volume1b.volume_id,
          root_file_id: volume1b.file_id,
          relative_path: 'raw-receipt.txt',
          content_base64: payload1b.toString('base64'),
        }),
      );
      check(
        '护栏**原始**响应里有 absolute_path，且它是本机绝对路径',
        rawReceipt['ok'] === true && path.isAbsolute(String(rawReceipt['absolute_path'])),
        String(rawReceipt['absolute_path']).slice(0, 40),
      );
      await helper1.stop();

      const receipt = await realOps.createFileGuarded({
        ...r1b.ref,
        relative_path: r1b.relative,
        content_base64: payload1b.toString('base64'),
      });
      check(
        '护栏回执：readback_ok 与 flushed 同时为真，写入字节数等于交出去的字节数',
        !isWinfsError(receipt) && receipt.readback_ok && receipt.flushed && receipt.bytes_written === payload1b.length,
        isWinfsError(receipt)
          ? `错误 ${receipt.code}`
          : `readback_ok=${String(receipt.readback_ok)} flushed=${String(receipt.flushed)} written=${receipt.bytes_written}`,
      );
      check(
        '护栏回执：target_sha256 == after_sha256（护栏收到的 == 回读到的）',
        !isWinfsError(receipt) && receipt.target_sha256 === receipt.after_sha256 && receipt.target_sha256 === sha256(payload1b),
        isWinfsError(receipt) ? '' : `target=${receipt.target_sha256.slice(0, 12)}… after=${receipt.after_sha256.slice(0, 12)}…`,
      );
      check(
        '护栏回执：新对象的 link_count 是 1（没有顺手造出一个硬链接）',
        !isWinfsError(receipt) && receipt.identity_after.link_count === 1,
        isWinfsError(receipt) ? '' : `link_count=${receipt.identity_after.link_count} file_id=${receipt.identity_after.file_id}`,
      );
      // 护栏的 `absolute_path` **没有**走到调用方：后端的回执是按白名单
      // 逐字段拼起来的（`powershell-backend.ts` 的 `createFileGuarded`），
      // 因此这个字段在边界上就被丢掉了。这是脱敏的第一道；第二道是进报告
      // 时的 `sanitize`（§6 正面量）。两道都记下来，因为它们防的是不同的事：
      // 第一道防「绝对路径进入类型系统」，第二道防「护栏的话原样进日志」。
      check(
        '后端的回执里没有 absolute_path（后端按白名单拼装，不整包透传）',
        !isWinfsError(receipt) && !('absolute_path' in (receipt as unknown as Record<string, unknown>)),
        !isWinfsError(receipt) ? `回执字段=${JSON.stringify(Object.keys(receipt))}` : '',
      );
      // 报告在 LWB-029 之后多了一个 `detail`（逐条目小结，§5 要它不能被
      // 压成一句「全部成功」）。因此这一格问的**不是**「只有一个字段」，
      // 而是「没有任何**绝对路径**字段」：`path` 这类字段一旦出现，
      // 就意味着绝对路径换了个键名接着往下走。
      check(
        '适配器交回的报告里没有任何路径字段（`kind` 与给人看的 `detail` 之外没有别的）',
        Object.keys(report1).sort().join(',') === 'detail,kind' &&
          !Object.keys(report1).some((key) => /path|root|file/i.test(key)),
        JSON.stringify(Object.keys(report1)),
      );
      check(
        '报告里那句给人看的话也不带本机绝对路径（报告是它最远的出口）',
        !leaksLocalPaths(detailOfReport(report1 as unknown as Record<string, unknown>)),
        detailOfReport(report1 as unknown as Record<string, unknown>).slice(0, 120),
      );
    });

    // -----------------------------------------------------------------------
    await guarded('§2 绝不覆盖', async () => {
      section('第 2 节 验收 1：创建绝不覆盖 —— 三种占位形态 + 一次真竞争');

      // --- 甲之一：精确同名（阶段 A 就定案） ---------------------------------
      const r2a = await createRig('occupied-exact');
      const theirs2a = Buffer.from('别人先建的\n', 'utf8');
      writeFileSync(r2a.abs, theirs2a);
      const counting2a = countingOps();
      const report2a = await r2a.submit(counting2a.ops);

      check('甲之一：名字被占着 ⇒ conflict（不是 applied、不是 refused）', report2a.kind === 'conflict', `kind=${report2a.kind}`);
      check(
        '甲之一：理由说的是「已经被占用」且点名**绝不覆盖**',
        report2a.kind === 'conflict' && report2a.detail.includes('已经被占用') && report2a.detail.includes('绝不覆盖'),
        report2a.kind === 'conflict' ? report2a.detail.slice(0, 90) : '',
      );
      check(
        '甲之一：**创建调用一次都没发出**（这才是「绝不覆盖」的可核对形式）',
        counting2a.counts.create === 0 && counting2a.counts.write === 0,
        `create=${counting2a.counts.create} write=${counting2a.counts.write} resolve=${counting2a.counts.resolve}`,
      );
      check('甲之一：别人的字节原样', readFileSync(r2a.abs).equals(theirs2a));
      check('甲之一：修改集停在 VALIDATING（一个字节都没写）', stateOf(r2a.change_id) === 'VALIDATING', `change.state=${stateOf(r2a.change_id)}`);

      // --- 甲之二：大小写别名（NTFS 大小写不敏感） ---------------------------
      const r2b = await createRig('occupied-alias', { relative: 'Case.txt' });
      const theirs2b = Buffer.from('小写那份\n', 'utf8');
      writeFileSync(path.join(r2b.dir, 'case.txt'), theirs2b);
      const report2b = await r2b.submit();
      check(
        '甲之二：条目写 Case.txt 而盘上是 case.txt ⇒ 同样 conflict（大小写不是不同的名字）',
        report2b.kind === 'conflict' && report2b.detail.includes('已经被占用'),
        report2b.kind === 'conflict' ? report2b.detail.slice(0, 90) : `kind=${report2b.kind}`,
      );
      check(
        '甲之二：说明里给的是**磁盘上的拼写**，而不是条目里写的那个',
        report2b.kind === 'conflict' && report2b.detail.includes('case.txt'),
        report2b.kind === 'conflict' ? report2b.detail.slice(0, 60) : '',
      );
      check(
        '甲之二：目录里仍然只有那一个对象（没有多出一个「新」的）',
        JSON.stringify(readdirSync(r2b.dir)) === JSON.stringify(['case.txt']),
        JSON.stringify(readdirSync(r2b.dir)),
      );

      // --- 甲之三：那个名字被一个**目录**占着 -------------------------------
      const r2c = await createRig('occupied-by-dir');
      mkdirSync(r2c.abs);
      const report2c = await r2c.submit();
      check(
        '甲之三：目标位置是一个目录 ⇒ conflict，且被当作「那里已经有东西了」',
        report2c.kind === 'conflict' && report2c.detail.includes('已经被占用'),
        report2c.kind === 'conflict' ? report2c.detail.slice(0, 90) : `kind=${report2c.kind}`,
      );
      check('甲之三：那个目录还在，没被换成文件', readdirSync(r2c.abs).length === 0);

      // --- 乙：护栏那一层的直接观测 -----------------------------------------
      //
      // 甲那一组证明的是**适配器**不会去覆盖。护栏自己呢？这里绕过适配器
      // 直接调 `createFileGuarded`，看真的 `CREATE_NEW` 给出什么。
      const guardCollide = await realOps.createFileGuarded({
        ...r2a.ref,
        relative_path: r2a.relative,
        content_base64: Buffer.from('想覆盖\n', 'utf8').toString('base64'),
      });
      check(
        '乙：真 CREATE_NEW 撞上已有文件 ⇒ FILE_VERSION_CONFLICT，且**没有** touched',
        isWinfsError(guardCollide) && guardCollide.code === 'FILE_VERSION_CONFLICT' && guardCollide.touched === undefined,
        isWinfsError(guardCollide)
          ? `code=${guardCollide.code} touched=${String(guardCollide.touched)}`
          : '竟然成功了',
      );
      check(
        '乙：护栏码是真实的 Win32 80（ERROR_FILE_EXISTS；同一张映射表里的 183 归到同一个码）',
        isWinfsError(guardCollide) && guardCollide.win32_error === 80,
        isWinfsError(guardCollide) ? `win32=${guardCollide.win32_error}` : '',
      );
      check('乙：别人的字节仍然原样', readFileSync(r2a.abs).equals(theirs2a));

      // --- 丙：检查之后、创建之前被别人抢先 --------------------------------
      //
      // 这是验收标准第一条真正问的那一段。抢跑发生在适配器探完之后、
      // 真护栏被调用之前 —— 也就是「先检查再创建」的实现里唯一的那个窗口。
      const r2d = await createRig('raced');
      const racer = Buffer.from('抢跑者写下的内容\n', 'utf8');
      const racing = racingOps(() => {
        writeFileSync(r2d.abs, racer);
      });
      racing.arm();
      const raced = await r2d.submit(racing.ops);

      // **这一格在 LWB-029 里翻了案，翻得有道理。** 旧行为是抛
      // `RECOVERY_REQUIRED`（「护栏没带 `actual_state`，因此现场未知」），
      // 代价是本文件旧 NOTE 承认的那一次**多余的人工核验**。新行为是
      // 交回 `rolled_back`，依据是护栏的三行表里那一行现在读对了：
      // **`touched` 缺席本身就是「一个字节都没动」的权威回答**，
      // 而 `actual_state` 缺席只说「这个句柄里没取到现场」，两件事不同。
      // 一次 `CREATE_NEW` 撞名失败**必经**句柄被赋值之前，因此它必然不带
      // `touched` —— 那正是「连一个对象都没创建出来」的证明，不是未知。
      check(
        '丙：抢跑 ⇒ 交回 rolled_back（已证明未动过，不再报成待恢复）',
        raced.kind === 'rolled_back',
        `kind=${raced.kind}`,
      );
      check(
        '丙：理由带着护栏码与 Win32 码，并明说本次执行没留下字节',
        /FILE_VERSION_CONFLICT/.test(detailOfReport(raced as unknown as Record<string, unknown>)) &&
          /Win32 80/.test(detailOfReport(raced as unknown as Record<string, unknown>)) &&
          /没有留下字节/.test(detailOfReport(raced as unknown as Record<string, unknown>)),
        detailOfReport(raced as unknown as Record<string, unknown>).slice(0, 160),
      );
      check(
        '丙：账上那条终局是 `untouched`（**未动过**），不是「动过、收回来了」',
        stagesOf(r2d, 'created.txt').at(-1) === 'item_untouched',
        stagesOf(r2d, 'created.txt').join(' → '),
      );
      check(
        '丙：**抢跑者的字节一个都没被碰**（覆盖这条路真的不存在）',
        readFileSync(r2d.abs).equals(racer),
        `${readFileSync(r2d.abs).length} 字节「${readFileSync(r2d.abs).toString('utf8').trim()}」`,
      );
      check(
        '丙：修改集停在 APPLYING，**没有**被改判成 CONFLICT —— 那张转移表没动过',
        stateOf(r2d.change_id) === 'APPLYING',
        `change.state=${stateOf(r2d.change_id)}`,
      );
      note(
        '丙 这一格从「多余的核验」变成了「干净的回滚」，代价是怎么消失的',
        '旧行为把 `actual_state` 的缺席读成「现场未知 ⇒ 不敢下结论」，而一次'
          + '`CREATE_NEW` 撞名失败**永远**不带它 —— 于是这一格**总是**付一次人工核验的代价，'
          + '哪怕磁盘上明明白白什么都没发生。修法不是给这一格开特例，而是把判据换成'
          + '护栏`touched` 那一行：**「没带 `touched`」= 「没越过破坏性区域」**。'
          + '这条判据对全部三条路径同向成立，因此这一格的代价连同它的特例一起消失了。'
          + '「状态机那张图不动」这条**约束**没有被放弃，只是不再需要用一次人工核验去换。',
      );
    });

    // -----------------------------------------------------------------------
    await guarded('§3 父目录', async () => {
      section('第 3 节 验收 3 前半：不隐式创建父目录');

      // --- 甲：父目录链缺一级 -----------------------------------------------
      const r3a = await createRig('parent-absent', { relative: 'src/deep/new.txt' });
      mkdirSync(path.join(r3a.dir, 'src'), { recursive: true });
      // `src/deep` 刻意**不**建。
      const counting3a = countingOps();
      const report3a = await r3a.submit(counting3a.ops);

      check(
        '甲：父目录不存在 ⇒ conflict（不是 refused —— 这是磁盘那一侧的事实）',
        report3a.kind === 'conflict',
        `kind=${report3a.kind}`,
      );
      check(
        '甲：理由点的是**哪一级**目录，并明说不隐式创建',
        report3a.kind === 'conflict' &&
          report3a.detail.includes('src/deep') &&
          report3a.detail.includes('不隐式创建父目录') &&
          report3a.detail.includes('未写入任何字节'),
        report3a.kind === 'conflict' ? report3a.detail.slice(0, 110) : '',
      );
      check(
        '甲：那一级目录在磁盘上**依然不存在**（拒绝没有退化成一次 mkdir）',
        !exists(path.join(r3a.dir, 'src', 'deep')),
        JSON.stringify(readdirSync(path.join(r3a.dir, 'src'))),
      );
      check(
        '甲：一个 create 都没发出，修改集停在 VALIDATING',
        counting3a.counts.create === 0 && stateOf(r3a.change_id) === 'VALIDATING',
        `create=${counting3a.counts.create} change.state=${stateOf(r3a.change_id)}`,
      );

      // --- 乙：父路径上是一个文件 -------------------------------------------
      const r3b = await createRig('parent-is-file', { relative: 'src/new.txt' });
      const blocker = Buffer.from('我是个文件\n', 'utf8');
      writeFileSync(path.join(r3b.dir, 'src'), blocker);
      const report3b = await r3b.submit();
      check(
        '乙：父路径上是一个文件 ⇒ conflict，理由说的是「不是一个目录」',
        report3b.kind === 'conflict' && report3b.detail.includes('在磁盘上不是一个目录'),
        report3b.kind === 'conflict' ? report3b.detail.slice(0, 100) : `kind=${report3b.kind}`,
      );
      check(
        '乙：那个文件没被删掉、也没被改名（拒绝不是「先腾地方」）',
        readFileSync(path.join(r3b.dir, 'src')).equals(blocker),
      );
    });

    // -----------------------------------------------------------------------
    await guarded('§4 ACL 与属性', async () => {
      section('第 4 节 验收 3 后半：不动 ACL、不设执行权限');

      const r4 = await createRig('acl');
      const report4 = await r4.submit();
      check('① 前置：文件确实建出来了', report4.kind === 'applied', `kind=${report4.kind}`);

      // 对照组：同一目录下、用**普通方式**建的一个文件（`[IO.File]::WriteAllText`
      // 走的是同一条 CreateFile 路径，但它不经我们的护栏）。
      const controlAbs = path.join(r4.dir, 'control.txt');
      writeFileSync(controlAbs, 'control\n');

      const createdAcl = aclSummary(r4.abs);
      const controlAcl = aclSummary(controlAbs);
      check(
        '① 新建文件的 ACL 与同目录下普通方式建的文件**逐项相同**',
        createdAcl === controlAcl,
        `创建 ${createdAcl.split('\n').length} 行 / 对照 ${controlAcl.split('\n').length} 行`,
      );
      check(
        '① 新建文件没有任何**非继承**的 ACE（护栏没调用过任何 SetSecurityInfo）',
        explicitAceCount(createdAcl) === 0,
        `非继承 ACE=${explicitAceCount(createdAcl)}`,
      );
      check(
        '① 新建文件的属性与对照文件相同（没有额外的只读/隐藏/系统位）',
        attributesOf(r4.abs) === attributesOf(controlAbs),
        `创建 ${attributesOf(r4.abs)} / 对照 ${attributesOf(controlAbs)}`,
      );

      // 父目录：护栏在创建前后都没有改过它的 ACL。
      const controlDir = path.join(sandbox, `acl-control-dir-${rigCount}`);
      mkdirSync(controlDir, { recursive: true });
      const parentAcl = aclSummary(r4.dir);
      check(
        '② 工作区根的 ACL 与一个刚刚 mkdir 出来的目录相同（护栏没动过它）',
        parentAcl === aclSummary(controlDir) && explicitAceCount(parentAcl) === 0,
        `非继承 ACE=${explicitAceCount(parentAcl)}`,
      );
      note(
        '② 「不设置执行权限」在 NTFS 上没有对应位',
        'POSIX 的执行位在 NTFS 上不存在（`attributes` 里只有只读/隐藏/系统/存档，'
          + '权限全在 ACL 里）。因此这一条可核对的形式不是「检查某个位」，'
          + '而是上面那三条：新对象的安全描述符**逐项等于**同目录下普通方式建的那个，'
          + '且不携带任何非继承 ACE —— 若护栏设置过执行权限，它只能体现在 ACL 里，'
          + '而那会让这两份摘要不再相同。',
      );
    });

    // -----------------------------------------------------------------------
    await guarded('§5 负向回归', async () => {
      section('第 5 节 负向回归');

      // 5a 中止落在**阶段 A 之内** ⇒ 不记账、不碰盘。
      const r5a = await createRig('abort-in-phase-a');
      const controller = new AbortController();
      const abortingOps: WinfsOps = new Proxy(realOps as unknown as WinfsOps, {
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
      let abortCode = '(没有抛)';
      try {
        await r5a.submit(abortingOps, controller.signal);
      } catch (cause) {
        abortCode = String((cause as { code?: string }).code);
      }
      check('5a：中止落在阶段 A 之内 ⇒ 抛（协调器据此判待恢复）', abortCode === 'RECOVERY_REQUIRED', `code=${abortCode}`);
      check(
        '5a：**没有**记下执行意图，也**没有**把文件建出来',
        stateOf(r5a.change_id) === 'VALIDATING' && !exists(r5a.abs),
        `change.state=${stateOf(r5a.change_id)} 磁盘上存在=${String(exists(r5a.abs))}`,
      );

      // 5b 计划**自己**站不住 ⇒ refused，且不碰盘。
      //
      // 与 LWB-027 §5b 同一格的创建版本：声明 utf-8 / 无 BOM，而目标快照
      // 的字节带 BOM。这一条在阶段 A（还没探盘）就定案，因此「一个字节都
      // 没写」是一句真话，协调器据此落终局即可，不必请人来。
      const r5b = await createRig('shape-mismatch', {
        // 声明的形态是「utf-8 / 无 BOM」，而目标快照的字节**带** BOM。
        // 前导的 U+FEFF 是这一格的**唯一**变量：其余每一项都声明正确，
        // 否则拦下来的可能不是「形态不符」那条判据。
        after: Buffer.from('﻿after-shape-mismatch\r\nsecond\r\n', 'utf8'),
        shape: { encoding: 'utf-8', bom: false, newline: 'crlf' },
      });
      const counting5b = countingOps();
      const report5b = await r5b.submit(counting5b.ops);
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
        '5b：被拒的计划**没有**在磁盘上留下任何东西',
        stateOf(r5b.change_id) === 'VALIDATING' && !exists(r5b.abs) && counting5b.counts.create === 0,
        `change.state=${stateOf(r5b.change_id)} create=${counting5b.counts.create}`,
      );

      // 5c **创建之后**失败 ⇒ 带现场、`object_created=true`。
      //
      // 诚实读法放在前面：**错误是注入的**。真盘上无法在「创建成功」与
      // 「刷盘完成」之间按需打断这一步（见 §7 的 NOT_RUN），因此这里用一层
      // Proxy 在真护栏**成功之后**补报一次失败。而**现场字段是真的** ——
      // 注入用的 `actual_state` 由另一次独立读取量出来（真尺寸、真哈希、
      // 真时刻），对象也确实真的建出来了。因此这一格证明的是「适配器如实
      // 转交现场、并按 `object_created=true` 分类」，而不是「护栏真的会在
      // 这里失败」。前者才是本任务能背的那一半。
      const r5c = await createRig('post-create-failure');
      let observed: { size: number; sha: string; at: string } | undefined;
      const injectingOps: WinfsOps = new Proxy(realOps as unknown as WinfsOps, {
        get(target, property) {
          if (property === 'createFileGuarded') {
            return async (request: Parameters<WinfsOps['createFileGuarded']>[0]) => {
              const receipt = await target.createFileGuarded(request);
              if (isWinfsError(receipt)) return receipt;
              // 对象真的建出来了。现在去量一份**真**的现场。
              const read = await target.readFileGuarded({
                root_path: request.root_path,
                root_volume_id: request.root_volume_id,
                root_file_id: request.root_file_id,
                relative_path: request.relative_path,
              });
              if (isWinfsError(read)) throw new Error(`注入装置读不回刚建好的文件：${read.code}`);
              observed = { size: read.size, sha: read.sha256, at: new Date().toISOString() };
              const synthetic: WinfsError = {
                ok: false,
                code: 'IO_ERROR',
                message: '写入之后刷盘未完成（注入：真盘上无法在创建与刷盘之间按需打断）',
                win32_error: 0,
                // `touched: true` 是**注入里最要紧的那个字段**：护栏只有在
                // 对象真的被创建出来之后才会挂上它（`Op-CreateFileGuarded`），
                // 因此这一格模拟的是「越过了破坏性区域」。少了它，这条注入
                // 说的就是「一个字节都没动」—— 而磁盘上那个 45 字节的对象
                // 明明白白地反驳着那句话。见本证据的 `summary.md` §5.3。
                touched: true,
                actual_state: {
                  size: read.size,
                  identity: read.identity,
                  sha256: read.sha256,
                  observed_bytes: read.size,
                  // 上界取观测到的尺寸本身，含义就是「整份都读到了」——
                  // 与护栏那条「只有读全了才给哈希」的规矩自洽。
                  cap_bytes: read.size,
                  observed_at_utc: observed.at,
                },
              };
              return synthetic;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
      const rejected5c = await r5c.rejected(injectingOps);
      check(
        '5c：创建之后失败 ⇒ RECOVERY_REQUIRED，且护栏那一行读成 TOUCHED（与 §2 丙 恰好相反的那一格）',
        rejected5c.code === 'RECOVERY_REQUIRED' &&
          rejected5c.details?.['guard_touched'] === true &&
          rejected5c.details?.['guard_verdict'] === 'TOUCHED',
        `code=${String(rejected5c.code)} verdict=${String(rejected5c.details?.['guard_verdict'])} touched=${String(rejected5c.details?.['guard_touched'])}`,
      );
      check(
        '5c：详情里的现场是真的 —— 观测到的哈希与尺寸等于独立读取量到的那一份',
        (() => {
          const events = readItemEvents(repos, r5c.operation_id).filter((event) => event.stage === 'item_failed');
          return events.length > 0 && events[0]!.observed_sha256 === observed?.sha;
        })(),
        `observed_sha256=${String(readItemEvents(repos, r5c.operation_id).find((event) => event.stage === 'item_failed')?.observed_sha256)}（真值 ${String(observed?.sha)}）`,
      );
      check(
        '5c：文案分得清这两种失败（「这个对象是本次执行创建出来的」而不是「没有留下字节」）',
        String(rejected5c.message ?? '').includes('本次执行创建出来的') &&
          !String(rejected5c.message ?? '').includes('没有留下字节'),
        String(rejected5c.message ?? '').slice(0, 160),
      );
      check(
        '5c：账上把创造出来的那个对象单独记成 restore_skipped（不删用户文件，因此不许说「收回」）',
        stagesOf(r5c, 'created.txt').join(' → ') === 'item_intent → item_failed → item_restore_skipped',
        stagesOf(r5c, 'created.txt').join(' → ') || '(空)',
      );
      check('5c：那次创建是真的 —— 字节确实在盘上（现场不是编出来的）', exists(r5c.abs), `${readFileSync(r5c.abs).length} 字节`);
    });

    // -----------------------------------------------------------------------
    await guarded('§6 脱敏', async () => {
      section('第 6 节 脱敏');

      // 判据必须**可失败**：先证明原始护栏消息里真的有本机绝对路径，
      // 再说适配器交出来的那一份里没有。两次说的是**同一句护栏话** ——
      // 一次是护栏原样交回的，一次是穿过适配器之后的。
      // 甲：拿一份**原始**护栏消息。目标先被占着，这样 `CREATE_NEW` 会失败，
      // 而失败消息是 `文件已存在，CREATE_NEW 拒绝覆盖：<绝对路径>`。
      const r6a = await createRig('redaction-raw');
      writeFileSync(r6a.abs, Buffer.from('先来的那份\n', 'utf8'));

      const rawLeaky = await realOps.createFileGuarded({
        ...r6a.ref,
        relative_path: r6a.relative,
        content_base64: Buffer.from('x\n').toString('base64'),
      });
      check(
        '护栏**原始**消息里确实带着本机绝对路径（脱敏不是空操作）',
        isWinfsError(rawLeaky) && leaksLocalPaths(rawLeaky.message),
        isWinfsError(rawLeaky) ? rawLeaky.message.slice(0, 80) : '竟然成功了',
      );

      // 乙：同一句护栏话经由适配器。这里必须让失败发生在**阶段 C**：阶段 A
      // 的冲突说明是适配器自己用相对拼写写的，根本不经过脱敏函数，拿它来
      // 证明「脱敏有效」是拿一个没有路径的字符串去比一个没有路径的字符串。
      // 因此再走一次 §2 丙 的那个装置：目标在阶段 A 看着是空的，抢跑发生在
      // 检查之后、创建之前 —— 失败于是从护栏那一层带着绝对路径冒上来，
      // 走 `writeFailure` 的 `sanitize`。（那一格也因此必须是一个**新**的
      // 工作区：甲那个里目标已经被占着，适配器会在阶段 A 就定案。）
      const r6b = await createRig('redaction-adapter');
      const racing6 = racingOps(() => {
        writeFileSync(r6b.abs, `抢跑 ${Date.now()}\n`, 'utf8');
      });
      racing6.arm();

      // **这一层补的不是消息，是判决。** 抢跑这条失败现在被判成「证明未动过」，
      // 于是它交回报告、什么都不抛 —— 而报告那条出口本来就有 `sanitize`，
      // 拿它证明「脱敏有效」太轻松了。这一节要问的是**最难的那条出口**：
      // 抛出去的那句话（协调器会把它的 `message` 原样写进**改动级**日志行，
      // 那一行不经过条目级的脱敏）。因此给真护栏这条拒绝补上 `touched: true`，
      // 让它走「动过、但创建出来的对象收不回来」那一支 —— 消息一个字没改，
      // 它仍然是 `WinfsGuard.ps1` 造出来的那一句，带着真的本机绝对路径。
      const relabeling = relabelTouched(racing6.ops);
      const throughAdapter = await r6b.rejected(relabeling);
      const adapterText = `${String(throughAdapter.message ?? '')} ${JSON.stringify(throughAdapter.details ?? {})}`;

      check(
        '丙：补上 `touched` 之后确实走了「抛」这条出口（否则本节量的是一个更松的出口）',
        throughAdapter.code === 'RECOVERY_REQUIRED',
        `code=${String(throughAdapter.code)}`,
      );
      check(
        '适配器交出的那一份里**没有**本机绝对路径，根路径被替换成 <工作区根>',
        !leaksLocalPaths(adapterText) && adapterText.includes('<工作区根>'),
        adapterText.slice(0, 140),
      );
      check(
        '同一句护栏话在两侧都还在（脱敏换掉的是路径，不是病因）',
        adapterText.includes('文件已存在') &&
          adapterText.includes('CREATE_NEW 拒绝覆盖') &&
          adapterText.includes('FILE_VERSION_CONFLICT'),
        adapterText.slice(0, 140),
      );
      check(
        '详情里的路径字段是**相对**路径（不是把绝对路径换个键名接着放）',
        throughAdapter.details?.['path'] === r6b.relative && !leaksLocalPaths(String(throughAdapter.details?.['path'] ?? '')),
        `path=${String(throughAdapter.details?.['path'])}`,
      );
      check(
        '本次采集里所有失败详情都没有本机绝对路径，也没有临时目录名',
        !leaksLocalPaths(adapterText) && !adapterText.includes('lwb-028-'),
        `${adapterText.length} 字符`,
      );
    });

    // -----------------------------------------------------------------------
    section('第 7 节 未执行项');
    skip(
      '真实 ChatGPT 网页端验收（LWB-002）',
      '需要真实账号、Tunnel 与工作区管理权限，当前 BLOCKED；MCP Inspector 成功不能替代',
    );
    skip(
      '真盘上「创建与刷盘之间进程退出」留下一个半份对象',
      '没有故障注入：`Op-CreateFileGuarded` 是一次请求内的创建→写→刷→回读，'
        + '外部插不进那一段；而用「写满卷」之类的办法只能造出写入失败，不能让它**恰好**'
        + '停在刷盘之前。§5 丙 证明的是适配器那一半（按 `object_created=true` 分类、'
        + '如实转交现场），现场字段本身是真的；护栏那一半（`actual_state` 只在创建**成功**'
        + '之后才挂上去）由 §2 乙 从反面量过：CREATE_NEW 失败时它确实不在。'
        + '崩溃取证本身属 LWB-030',
    );
    skip(
      '恢复流程真正给那个半份对象定案（含清理）',
      '属 LWB-030。本任务只到「抛出去、带现场、由协调器判待恢复」为止；'
        + '护栏刻意不删那个对象（见 `Op-CreateFileGuarded` 的三条理由）',
    );
    skip(
      '执行日志把逐条目的创建结果持久化',
      '属 LWB-029；本任务的报告是内存里的，账上只有修改集的 `APPLYING`',
    );
    skip(
      'change_apply 工具对模型可见',
      '属 LWB-032；适配器尚未接入工具面，这是有意的',
    );
    skip(
      '方向性基线拒绝（带基线的创建 / 无基线的改写）',
      '库上有两条 BEFORE INSERT 触发器（`change_items_create_has_no_base` / '
        + '`change_items_edit_requires_base`），因此这两种行**根本落不了库**，'
        + '从产品路径上不可达。适配器那两句是跨版本与直接改库的防御，'
        + '由 tests/unit/executor-native-adapter.test.ts 覆盖',
    );
    skip(
      '父目录在本瞬间被换成指向别处的 Junction',
      '要造重解析点需要管理员或开发者模式，本工程不得要求管理员权限。'
        + '护栏在打开句柄后逐级 `Assert-HandleMatches`（规范拼写 + 非重解析点），'
        + '单元测试覆盖了「句柄身份与声明不符」的分支',
    );
  } finally {
    if (opened !== undefined) closeDatabase(opened.db);
    await disposeWinfsBackend();
    rmSync(sandbox, { recursive: true, force: true });
  }

  console.log(`\n小计：PASS=${passes} FAIL=${failures} NOT_RUN=${skips}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
