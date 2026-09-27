/**
 * LWB-030 可复现证据采集：启动恢复与未知结果协调。
 *
 * 装置与 LWB-027/028/029 同一套：**真 NTFS** ←经→ 真原生护栏
 * （真的 `CreateFileW`、`WriteFile`、`FlushFileBuffers`、
 * `GetFileInformationByHandle`）→ 真适配器与真写盘编排
 * （`packages/executor`）→ 真恢复服务（`packages/recovery`）→
 * 真 SQLite **文件**、真快照库、真 `claimForExecution`。
 *
 * ## 与 LWB-029 的区别就在「重启」这两个字上
 *
 * LWB-029 里所有「进程在半路停住」都是**抛异常**，进程还活着。本文件换成
 * **真的把库关掉、再另开一套机器**：上一个「进程」留下的状态库、快照库、
 * 磁盘一个字节都没被整理过，而恢复扫描读的就是这三样。
 *
 * 崩溃点也是按验收标准挑的：`apply.ts` 落完盘就停在 `APPLYING`（终局由
 * 协调器落）。于是「写得完、应答丢」这个窗口就等于「跑完 applier，不跑
 * 协调器」—— 它不是一个模拟出来的窗口，它就是那个窗口本身。
 *
 * ## 逐条对应任务书
 *
 *  步骤 1「启动时先处理未终结操作，再开放工作区写能力」—— §1（真盘上留下一个
 *  未终结操作，重启后它被标记而**没有**被重放）+ §8（次序在装配根里是一处
 *  **行序**，由静态判据钉住）。
 *
 *  步骤 2「在受控句柄下比较当前身份/哈希与旧、新状态；分为未变、目标已达、
 *  第三种内容和身份不明」—— §2，四格各造一次，全部在真文件上。
 *
 *  步骤 3「只有可证明安全的状态协调才自动完成；第三种内容保留原样」——
 *  §3 与 §5。前者的判据是「这次定案一个字节都不写」，量法是**文件指纹**
 *  （大小 + 最后写入时刻 + 内容哈希）而不是内容 —— 见 §3 的 NOTE。
 *
 *  步骤 4「恢复写入需要本地恢复授权；禁用连接不妨碍操作者查看恢复记录」
 *  —— §7 甲/乙 与 §7 丙。
 *
 *  验收 (a)「写入完成但应答丢失后，重启查询收敛为实际已达状态，不重复修改」—— §4。
 *  验收 (b)「用户在崩溃后继续编辑时不被自动恢复覆盖」—— §5。
 *  验收 (c)「数据库/快照不完整时默认暂停，不能当成新安装清空历史」—— §6。
 *
 * 用法：node --import tsx scripts/evidence/lwb-030.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件证明不了的事逐条列在 §9 并标 `NOT_RUN`：**真实 ChatGPT 网页端验收**
 * 需要真实账号与 Secure MCP Tunnel 凭据，当前 BLOCKED（LWB-002）；
 * **「写到一半进程被杀」**在真盘上没有构造；**`recovery_required` 真的挡住
 * 了一次写入**要等协调器接线（LWB-032）—— 今天它是一个**真实查询**的布尔（§8 已验）。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { approveAndQueue } from '@lwb/approvals';
import { BlobStore, resolveStorageRef } from '@lwb/blob-store';
import { canonicalChangeDigest } from '@lwb/changes';
import type { ChangeDigestFile } from '@lwb/changes';
import { CONTRACT_VERSION, isBridgeError, LIMITS } from '@lwb/contracts';
import { claimForExecution, createNativeApplier } from '@lwb/executor';
import type { ApplyReport, ExecutionPlan } from '@lwb/executor';
import type { ProcessProbe } from '@lwb/ipc';
import {
  closeDatabase,
  FROZEN_RECOVERY_DECISIONS,
  KNOWN_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  Repositories,
} from '@lwb/persistence';
import type { ChangeItemInput, ChangeItemRecord } from '@lwb/persistence';
import { RecoveryService, RECOVERY_STAGE } from '@lwb/recovery';
import { disposeWinfsBackend, getWinfsBackend, isWinfsError } from '@lwb/winfs';
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

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** 脱敏判据：证据里不得出现本机绝对路径。 */
const leaksLocalPaths = (text: string): boolean => /[A-Za-z]:\\|\/tmp\/|\/home\/|\/Users\//.test(text);

/** 一段文本里出现本机绝对路径的最小片段（把「泄漏」变成一条可核的 FAIL 证据）。 */
function leakSample(text: string): string {
  const match = /[A-Za-z]:\\[^\s"'）)，。]*/.exec(text);
  return match === null ? '(没找到路径片段)' : match[0].slice(0, 60);
}

/** 脱敏检查的复用件：文本里没有绝对路径就 PASS。 */
function checkRedacted(name: string, text: string): void {
  const leaked = leaksLocalPaths(text);
  check(name, !leaked, leaked ? `泄漏片段：${leakSample(text)}` : '');
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CONNECTION = 'conn_ev30';
const WORKSPACE = 'ws_ev30';
const PRINCIPAL = 'principal_ev30';
const POLICY_VERSION = 1;
const MODE = 'read_propose_apply_with_local_approval';
const EXECUTOR_ID = 'exe_ev30';
const HOLDER = { pid: process.pid, started_at: new Date(Date.now() - 60_000).toISOString() };
const CONTRACT = CONTRACT_VERSION;

/** 认领时不该被问到：每个用例的地都是新开的一块。 */
const deadProbe: ProcessProbe = {
  identify: () => {
    throw new Error('本证据不该问进程探针（LWB-026 已经证过它）');
  },
};

const realOps: WinfsOps = getWinfsBackend();

let sandbox = '';

/**
 * 一个文件的正文：带 BOM 与 CRLF。
 *
 * 这两样是刻意的：写路径会拿 `inspectBytes` 判**将要写下去的字节**，并核对
 * 它与计划里申报的 `encoding/bom/newline` 是否一致（见 `native-adapter.ts`）。
 * 申报 `utf-8-bom` + `crlf` 而字节是别的写法，会在写之前就被拒 —— 因此这几个
 * 字节同时也在证「申报必须与字节一致」这条规则真的在跑。
 */
const bodyOf = (seed: string, which: string, when: string): Buffer =>
  Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`${when}-${seed}-${which}\r\n第二行\r\n`, 'utf8'),
  ]);

const metaOf = { encoding: 'utf-8-bom', bom: true, newline: 'crlf' } as const;

interface FileSpec {
  /** 工作区内的相对路径（`/` 分隔，与条目里的写法一致）。 */
  readonly relative: string;
  readonly before: Buffer;
  readonly after: Buffer;
}

/** 一个文件的「大小 + 最后写入时刻 + 内容哈希」。 */
interface Fingerprint {
  readonly size: number;
  readonly mtime_ms: number;
  readonly sha256: string;
}

/**
 * 后两项是这份指纹存在的理由：只比内容的话，一次「把同样的字节再写一遍」也会
 * 通过 —— 而验收 (a) 与步骤 3 要求的正是**没有写**。
 */
function fingerprint(target: string): Fingerprint {
  const info = statSync(target);
  return { size: info.size, mtime_ms: info.mtimeMs, sha256: sha256(readFileSync(target)) };
}

const sameFingerprint = (a: Fingerprint, b: Fingerprint): boolean =>
  a.size === b.size && a.mtime_ms === b.mtime_ms && a.sha256 === b.sha256;

interface Rig {
  readonly dir: string;
  readonly dbPath: string;
  readonly objectsRoot: string;
  readonly volume_id: string;
  readonly root_file_id: string;
  readonly change_id: string;
  readonly operation_id: string;
  readonly plan: ExecutionPlan;
  readonly specs: readonly FileSpec[];
  readonly items: readonly ChangeItemRecord[];
  readonly abs: (relative: string) => string;
}

let rigCount = 0;
let sandboxBlobSeq = 0;

/**
 * 搭一套**真的**工作区 + 修改集 + 计划。
 *
 * 与单元测试那套的区别只有一处，而它是本文件的主角：状态库是**磁盘上的一个
 * 文件**，不是 `:memory:` —— 因为「重启」在这里是「关掉它，再用同一个文件另开一个」。
 *
 * 身份（`base_file_id`）取自护栏在**真文件**上给出的文件索引，不是编的。
 * 这一点很要紧：判定表里「同一个对象」那一格全靠它。
 */
async function makeRig(seed: string, specs: readonly FileSpec[]): Promise<Rig> {
  rigCount += 1;
  const tag = `${seed}-${String(rigCount)}`;
  const dir = path.join(sandbox, tag);
  const objectsRoot = path.join(sandbox, `${tag}-objects`);
  const dbPath = path.join(sandbox, `${tag}.db`);
  mkdirSync(dir, { recursive: true });

  for (const spec of specs) {
    const target = path.join(dir, spec.relative.split('/').join(path.sep));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, spec.before);
  }

  const opened = openDatabase({ path: dbPath });
  try {
    const repos = new Repositories(opened.db);
    const blobs = new BlobStore({
      objectsRoot,
      registry: repos.blobs,
      newId: () => `blb_${tag}_${String((sandboxBlobSeq += 1))}`,
    });

    const volume = await realOps.statVolume({ path: dir });
    if (isWinfsError(volume)) throw new Error(`statVolume 失败：${JSON.stringify(volume)}`);

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
    const ref = { root_path: dir, root_volume_id: volume.volume_id, root_file_id: volume.file_id };

    const items: ChangeItemInput[] = [];
    // 可变的累积器，因此是 `ChangeDigestFile[]` 而不是入参那个 `readonly`。
    const files: ChangeDigestFile[] = [];

    for (const spec of specs) {
      const observed = await realOps.readFileGuarded({ ...ref, relative_path: spec.relative });
      if (isWinfsError(observed)) throw new Error(`基线读取失败：${JSON.stringify(observed)}`);

      const oldBlob = await blobs.putAndRegister(spec.before);
      const newBlob = await blobs.putAndRegister(spec.after);
      if (oldBlob.put.sha256 !== sha256(spec.before)) {
        throw new Error('装置自检失败：基线快照的哈希与字节不符。');
      }
      if (observed.sha256 !== oldBlob.put.sha256) {
        throw new Error('装置自检失败：磁盘上的基线不是刚写下去的那一份。');
      }

      items.push({
        id: `ci_${tag}_${spec.relative}`,
        path: spec.relative,
        op: 'edit_text',
        base_file_id: observed.identity.file_id,
        base_sha256: oldBlob.put.sha256,
        target_sha256: newBlob.put.sha256,
        old_blob_id: oldBlob.id,
        new_blob_id: newBlob.id,
        ...metaOf,
        added_lines: 2,
        removed_lines: 2,
      });
      files.push({
        path: spec.relative,
        op: 'edit_text',
        before_sha256: oldBlob.put.sha256,
        before_size: oldBlob.put.size,
        after_sha256: newBlob.put.sha256,
        after_size: newBlob.put.size,
        ...metaOf,
      });
    }

    const digest = canonicalChangeDigest({
      contract_version: CONTRACT,
      policy_version: POLICY_VERSION,
      root_generation: generation,
      workspace_id: WORKSPACE,
      files,
    });

    const nowMs = Date.now();
    const change = repos.changes.create({
      id: `chg_${tag}`,
      owner_connection_id: CONNECTION,
      workspace_id: WORKSPACE,
      root_generation: generation,
      policy_version: POLICY_VERSION,
      contract_version: CONTRACT,
      digest,
      summary: `真盘恢复取证 ${tag}`,
      expires_at: new Date(nowMs + LIMITS.CHANGE_TTL_MS).toISOString(),
      items,
    });
    approveAndQueue({
      repos,
      change_id: change.id,
      digest,
      actor: 'console:取证',
      now: new Date(nowMs).toISOString(),
      idempotency_key: `key-${tag}`,
    });

    const outcome = claimForExecution(
      { repos, executor_id: EXECUTOR_ID, holder: HOLDER, probe: deadProbe, lease_ms: 30_000, now: Date.now },
      change.id,
    );
    if (outcome.kind !== 'claimed') throw new Error(`认领未成功：${JSON.stringify(outcome)}`);

    return {
      dir,
      dbPath,
      objectsRoot,
      volume_id: volume.volume_id,
      root_file_id: volume.file_id,
      change_id: change.id,
      operation_id: repos.operations.requireByChangeId(change.id).id,
      plan: outcome.plan,
      specs,
      items: repos.changes.items(change.id).sort((a, b) => a.seq - b.seq),
      abs: (relative: string) => path.join(dir, relative.split('/').join(path.sep)),
    };
  } finally {
    closeDatabase(opened.db);
  }
}

/** 打开这一份现场（库 + 快照库 + 一个恢复服务）。调用方负责关库。 */
function openService(rig: Rig, ops: WinfsOps = realOps) {
  const opened = openDatabase({ path: rig.dbPath });
  const repos = new Repositories(opened.db);
  const blobs = new BlobStore({ objectsRoot: rig.objectsRoot, registry: repos.blobs });
  let minted = 0;
  const recovery = new RecoveryService({
    repos,
    ops,
    blobs,
    now: Date.now,
    newId: () => `rec_ev30_${String((minted += 1)).padStart(4, '0')}`,
    log: (line) => console.log(`      · ${line}`),
  });
  return { opened, repos, blobs, recovery };
}

/**
 * 跑一次真实的写盘。**不**跑协调器 —— 那就是「写得完、应答丢」这个窗口。
 *
 * `await` 必须在 `try` 里：写成 `return createNativeApplier(...)(...)` 会让
 * `finally` 在写盘**开始之前**就关掉库连接（写盘是异步的），而那种失败长得
 * 很像「快照取不到」—— 一个诚实的假象，会把人送去查快照。
 */
async function applyWithoutFinalize(rig: Rig, ops: WinfsOps = realOps): Promise<ApplyReport> {
  const { opened, repos, blobs } = openService(rig, ops);
  try {
    return await createNativeApplier({ repos, ops, blobs })(rig.plan, new AbortController().signal);
  } finally {
    closeDatabase(opened.db);
  }
}

/**
 * 「重启」：关掉一切，再用**同一个库文件**另开一套机器，跑启动扫描。
 *
 * 上一个「进程」留下的三样东西一个字节都没被整理过 —— 状态库、快照库、磁盘。
 */
async function restartAndSweep(rig: Rig, ops: WinfsOps = realOps) {
  const context = openService(rig, ops);
  const report = await context.recovery.sweepStartup();
  return { ...context, report };
}

/** 手工阻断这块地（模拟一次安全暂停，或一个失联的执行器留下的现场）。 */
function blockSlot(rig: Rig, reason: string): void {
  const { opened, repos } = openService(rig);
  try {
    repos.write_slots.block({
      volume_id: rig.volume_id,
      root_file_id: rig.root_file_id,
      reason,
    });
  } finally {
    closeDatabase(opened.db);
  }
}

/** 把某个快照对象从对象库里删掉，返回它的绝对路径，便于断言「确实不在了」。 */
function deleteSnapshot(rig: Rig, blobId: string): string {
  const { opened, repos } = openService(rig);
  let absolute = '';
  try {
    absolute = resolveStorageRef(rig.objectsRoot, repos.blobs.requireById(blobId).storage_ref);
  } finally {
    closeDatabase(opened.db);
  }
  unlinkSync(absolute);
  return absolute;
}

/** 日志行里的阶段名，按顺序。 */
function stagesOf(repos: Repositories, operationId: string): string[] {
  return repos.journal.list(operationId).map((row) => row.stage);
}

/** 某个操作的日志全文（按行拼起来，便于一次脱敏检查）。 */
function journalText(repos: Repositories, operationId: string): string {
  return repos.journal
    .list(operationId)
    .map((row) => row.detail ?? '')
    .join(' | ');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  sandbox = path.join(os.tmpdir(), `lwb-ev30-${String(process.pid)}-${String(Date.now())}`);
  mkdirSync(sandbox, { recursive: true });

  try {
    // -----------------------------------------------------------------------
    section('§0 装置自述：这台机器上真的是什么在跑');
    // -----------------------------------------------------------------------
    await guarded('§0', async () => {
      const capability = await realOps.capability();
      check('原生护栏可用', capability.available === true, `backend=${capability.backend}`);
      check('护栏自述支持独占句柄', capability.supports_exclusive_handle === true);
      check('护栏自述支持刷盘', capability.supports_flush === true);
      check('护栏自述支持文件身份', capability.supports_file_identity === true);
      check(
        '护栏自述**不**提供跨文件事务',
        capability.cross_file_transaction === false,
        '这句话是恢复流程必须逐条目写的理由',
      );
      check(
        '护栏自述**不**提供崩溃原子替换',
        capability.crash_atomic_replace === false,
        '因此「替换」在这台机器上不是一次原子动作',
      );
      console.log(`      环境自述：${capability.verified_on ?? '(未记录)'}`);

      const opened = openDatabase({ path: path.join(sandbox, 'probe.db') });
      try {
        // 这一格原本写的是 `KNOWN_SCHEMA_VERSION === 7`。它在 LWB-034 新增
        // 迁移 v8 的那一天就变成一条**假失败** —— 报的不是「v7 出了问题」，
        // 而是「后来又有人加了迁移」。本脚本要钉住的是「本任务取证的那一版
        // 迁移确实在库里、且它的名字没变」，因此判据改成从 `MIGRATIONS`
        // 推导（与 `tests/unit/persistence.test.ts` 从 LWB-020 起、
        // `tests/unit/recovery-persistence.test.ts` A1 起同一条规则）。
        check(
          '迁移 v7 在库，且本任务取证的那张表由它创建',
          MIGRATIONS.some((m) => m.version === 7 && m.name === 'recovery_authorizations'),
          `KNOWN_SCHEMA_VERSION=${String(KNOWN_SCHEMA_VERSION)}（当前值，不参与判定）`,
        );
        const row = opened.db
          .prepare(`SELECT sql FROM sqlite_master WHERE name = 'recovery_authorizations'`)
          .get() as { sql: string } | undefined;
        const sql = row?.sql ?? '';
        check('恢复授权表存在', sql.length > 0);
        check(
          '恢复动作的词表被冻结在迁移里，且只有一条',
          FROZEN_RECOVERY_DECISIONS.length === 1 &&
            FROZEN_RECOVERY_DECISIONS[0] === 'ROLLBACK_TO_BASELINE',
          `FROZEN_RECOVERY_DECISIONS=${JSON.stringify(FROZEN_RECOVERY_DECISIONS)}`,
        );
        check(
          '表里**没有**任何指向「写到目标」的动作',
          sql.includes('APPLY_TARGET') === false && sql.includes('ROLLBACK_TO_BASELINE'),
          '「把基线补写成目标」这条路在被授权执行的动作里不存在',
        );
        check('恢复授权表钉住一个 64 位摘要', sql.includes('length(digest) = 64'));
        check('恢复授权表的动作方只允许本地操作者', sql.includes(`'local_operator'`));

        // 索引与触发器不在上面那一行里（那是**表**的定义），要单独问。
        const constraints = opened.db
          .prepare(
            `SELECT type, name, sql FROM sqlite_master
             WHERE tbl_name = 'recovery_authorizations' AND type IN ('index','trigger')`,
          )
          .all() as { type: string; name: string; sql: string | null }[];
        const constraintSql = constraints.map((row) => row.sql ?? '').join('\n');
        check(
          '一个操作上不会有两条同时有效的授权',
          constraints.some(
            (row) => row.type === 'index' && row.name === 'recovery_authorizations_active_uq',
          ) &&
            /ON\s+recovery_authorizations\(operation_id\)\s*WHERE\s+state\s*=\s*'ACTIVE'/.test(constraintSql),
          '部分唯一索引：一次授权不会被两个执行者各用一次',
        );
        check(
          '授权不得从非 ACTIVE 状态退回去',
          constraints.some(
            (row) => row.type === 'trigger' && row.name === 'recovery_authorizations_no_reactivate',
          ),
        );
        check(
          '授权与它绑定的那次现场不可改写',
          constraints.some(
            (row) => row.type === 'trigger' && row.name === 'recovery_authorizations_immutable_binding',
          ),
          'operation_id / workspace_id / volume_id 与摘要都锁死在 UPDATE 上',
        );
      } finally {
        closeDatabase(opened.db);
      }
    });

    // -----------------------------------------------------------------------
    section('§1 步骤 1：启动扫描把未终结操作标为待恢复，**不重放**');
    // -----------------------------------------------------------------------
    await guarded('§1', async () => {
      const rig = await makeRig('sweep', [
        {
          relative: 'src/one.txt',
          before: bodyOf('sweep', 'one', 'before'),
          after: bodyOf('sweep', 'one', 'after'),
        },
        {
          relative: 'src/two.txt',
          before: bodyOf('sweep', 'two', 'before'),
          after: bodyOf('sweep', 'two', 'after'),
        },
      ]);

      const applied = await applyWithoutFinalize(rig);
      check('装置：真盘上两个文件都写成了', applied.kind === 'applied', `kind=${applied.kind}`);

      // 崩溃：上面那个「进程」已经关了库，磁盘上留着一个写完了的现场。
      const before = rig.specs.map((spec) => ({
        relative: spec.relative,
        at: fingerprint(rig.abs(spec.relative)),
      }));

      const { opened, repos, report } = await restartAndSweep(rig);
      try {
        check('扫描认出 1 个未终结操作', report.leftovers === 1, `leftovers=${String(report.leftovers)}`);
        check(
          '扫描**没有**重放它，而是重新观测后定案',
          report.reconciled.length === 1,
          `reconciled=${String(report.reconciled.length)}`,
        );
        check('没有留待人工', report.awaiting_manual.length === 0);
        check('没有判定不成的', report.undecidable.length === 0);

        const operation = repos.operations.requireById(rig.operation_id);
        check('操作收敛到 APPLIED', operation.state === 'APPLIED', `state=${operation.state}`);
        check('并且被标为「经恢复协调而来」', operation.recovered === true, 'recovered=true');
        check('修改集同步收敛', repos.changes.requireById(rig.change_id).state === 'APPLIED');
        check('它是一个收场的记录', operation.finished_at !== null);

        const after = rig.specs.map((spec) => ({
          relative: spec.relative,
          at: fingerprint(rig.abs(spec.relative)),
        }));
        const untouched = before.every((entry, index) => {
          const later = after[index];
          return (
            later !== undefined && entry.relative === later.relative && sameFingerprint(entry.at, later.at)
          );
        });
        check(
          '扫描前后每个文件的大小、最后写入时刻、内容哈希三者全等',
          untouched,
          '内容不变不足以说明没写过 —— 把同样的字节再写一遍也让内容不变',
        );

        const stages = stagesOf(repos, rig.operation_id);
        check(
          '日志里有「上一个进程退出」那一条',
          stages.includes(RECOVERY_STAGE.swept),
          `stages=${stages.join(',')}`,
        );
        check('日志里有「经重新观测协调」那一条', stages.includes(RECOVERY_STAGE.reconciled));
        check(
          '日志里**没有**任何一条说「写了字节」',
          stages.includes(RECOVERY_STAGE.repaired) === false,
          'recovery_repaired 这个阶段名本身就意味着动过字节',
        );

        const swept = repos.journal
          .list(rig.operation_id)
          .find((row) => row.stage === RECOVERY_STAGE.swept);
        check(
          '那条「标记」日志说清了「没有重放、没有改动字节」',
          (swept?.detail ?? '').includes('没有重放') && (swept?.detail ?? '').includes('没有改动'),
          `error_code=${swept?.error_code ?? '(空)'}`,
        );
        checkRedacted('脱敏：这一段的日志里没有本机绝对路径', journalText(repos, rig.operation_id));

        // 第二次「重启」应当无事可做。
        const again = await restartAndSweep(rig);
        try {
          check(
            '再重启一次：没有未终结操作',
            again.report.leftovers === 0,
            `leftovers=${String(again.report.leftovers)}`,
          );
          check(
            '再重启一次：什么都没被改',
            again.report.reconciled.length === 0 && again.report.awaiting_manual.length === 0,
          );
        } finally {
          closeDatabase(again.opened.db);
        }

        const firstBefore = before[0];
        check(
          '两次扫描之间磁盘也没被动',
          firstBefore !== undefined && sameFingerprint(firstBefore.at, fingerprint(rig.abs('src/one.txt'))),
        );
      } finally {
        closeDatabase(opened.db);
      }
    });

    // -----------------------------------------------------------------------
    section('§2 步骤 2：受控句柄下的重新观测 —— 判定四格各来一次');
    // -----------------------------------------------------------------------
    await guarded('§2', async () => {
      // `kind` 与 `reason` 是两件事：前者是「定了什么案」，后者是「凭什么」。
      // `reconciliationOf` 的顺序是**有意的**（先问判不出的，再问是不是清一色），
      // 因此最后两格的 `kind` 都是 `MANUAL`，而 `reason` 各自说的是真原因。
      const cases: readonly {
        readonly seed: string;
        /** 写完之后怎么把现场变成这一格要的样子。 */
        readonly arrange: 'none' | 'write-through' | 'user-edits' | 'replace-object';
        readonly verdict: string;
        readonly kind: string;
        readonly reason: string;
      }[] = [
        { seed: 'd-target', arrange: 'write-through', verdict: 'TARGET_REACHED', kind: 'APPLIED', reason: 'ALL_TARGET' },
        { seed: 'd-original', arrange: 'none', verdict: 'ORIGINAL', kind: 'ROLLED_BACK', reason: 'ALL_ORIGINAL' },
        { seed: 'd-third', arrange: 'user-edits', verdict: 'THIRD_CONTENT', kind: 'MANUAL', reason: 'THIRD_CONTENT' },
        { seed: 'd-replaced', arrange: 'replace-object', verdict: 'IDENTITY_UNKNOWN', kind: 'MANUAL', reason: 'IDENTITY_UNKNOWN' },
      ];

      for (const entry of cases) {
        const rig = await makeRig(entry.seed, [
          {
            relative: 'a.txt',
            before: bodyOf(entry.seed, 'a', 'before'),
            after: bodyOf(entry.seed, 'a', 'after'),
          },
        ]);

        if (entry.arrange !== 'none') await applyWithoutFinalize(rig);
        if (entry.arrange === 'user-edits') {
          writeFileSync(rig.abs('a.txt'), Buffer.from('用户自己写的\r\n', 'utf8'));
        }
        if (entry.arrange === 'replace-object') {
          // 删除重建：护栏的文件索引含 NTFS 的序列号，**删除重建会改变它**
          // （这条写在 `WinfsGuard.ps1` 的 `Get-FileIdHex` 注释里，LWB-027 起
          // 就在用）。因此这一格是在真盘上造出来的，不是我编一个身份填进去。
          const kept = Buffer.from(readFileSync(rig.abs('a.txt')));
          unlinkSync(rig.abs('a.txt'));
          writeFileSync(rig.abs('a.txt'), kept);

          // 装置自检：身份**确实**变了，否则下面那条断言证明的就不是这件事。
          const read = await realOps.readFileGuarded({
            root_path: rig.dir,
            root_volume_id: rig.volume_id,
            root_file_id: rig.root_file_id,
            relative_path: 'a.txt',
          });
          if (isWinfsError(read)) throw new Error(`装置自检失败：${JSON.stringify(read)}`);
          if (read.identity.file_id === (rig.items[0]?.base_file_id ?? '')) {
            throw new Error('装置不可用：删除重建之后文件索引没变，这一格在真盘上没造出来。');
          }
        }

        const before = fingerprint(rig.abs('a.txt'));
        const { opened, repos, recovery } = openService(rig, realOps);
        try {
          const journalBefore = repos.journal.list(rig.operation_id).length;
          const inspection = await recovery.inspect(rig.operation_id);
          const verdict = inspection?.items[0]?.verdict;

          check(
            `判定：${entry.seed} ⇒ ${entry.verdict}`,
            verdict?.kind === entry.verdict,
            `kind=${verdict?.kind ?? '(无)'}`,
          );
          check(
            `折叠：${entry.seed} ⇒ ${entry.kind} / ${entry.reason}`,
            inspection?.reconciliation.kind === entry.kind &&
              inspection.reconciliation.reason === entry.reason,
            `kind=${String(inspection?.reconciliation.kind)} reason=${String(inspection?.reconciliation.reason)}`,
          );

          if (entry.verdict === 'IDENTITY_UNKNOWN') {
            check(
              '而它说得出是「身份变化」而不是「内容不对」',
              verdict?.kind === 'IDENTITY_UNKNOWN' && verdict.reason === 'REPLACED_OBJECT',
              `reason=${verdict?.kind === 'IDENTITY_UNKNOWN' ? verdict.reason : '(无)'}`,
            );
            check(
              '内容与目标逐字节相同，判定**仍然**不是「目标已达」',
              before.sha256 === sha256(bodyOf(entry.seed, 'a', 'after')),
              '§8.4：内容等于目标并不总能证明是谁写的',
            );
          } else {
            const observedId = verdict?.kind === 'IDENTITY_UNKNOWN' ? null : verdict?.observed_file_id;
            check(
              `观测带回了**真对象的身份**（${entry.seed}）`,
              typeof observedId === 'string' && observedId.length > 0,
              `file_id=${String(observedId)}`,
            );
          }

          // 判定这一步是**只读**的：一条日志都不该被写下，一个字节都不该被碰。
          check(
            '判定**只读**：没有写下任何一条日志',
            repos.journal.list(rig.operation_id).length === journalBefore,
            `before=${String(journalBefore)} after=${String(repos.journal.list(rig.operation_id).length)}`,
          );
          check(
            `判定**只读**：磁盘未被碰（${entry.seed}）`,
            sameFingerprint(before, fingerprint(rig.abs('a.txt'))),
          );
        } finally {
          closeDatabase(opened.db);
        }
      }

      note(
        '四格的「凭什么」是可区分的',
        '后两格都定不了案（kind 都是 MANUAL），而 reason 一个说「有一个我们不该覆盖的内容」，'
          + '另一个说「对象不是被批准的那一个」。把两者合成一句「人工处理」会丢掉操作者唯一需要的线索。',
      );
    });

    // -----------------------------------------------------------------------
    section('§3 步骤 3：自动定案的两格，以及它们**不写字节**');
    // -----------------------------------------------------------------------
    await guarded('§3', async () => {
      // 第一格：全部已达目标。
      const reached = await makeRig('decide-target', [
        {
          relative: 'ok.txt',
          before: bodyOf('decide-target', 'ok', 'before'),
          after: bodyOf('decide-target', 'ok', 'after'),
        },
      ]);
      await applyWithoutFinalize(reached);
      const written = fingerprint(reached.abs('ok.txt'));

      const first = await restartAndSweep(reached);
      try {
        check('全部已达 ⇒ 自动定案', first.report.reconciled.length === 1);
        check(
          '定案为 APPLIED',
          first.report.reconciled[0]?.after === 'APPLIED',
          `after=${String(first.report.reconciled[0]?.after)}`,
        );
        check(
          '定案报告里带着一份计划摘要（64 位十六进制）',
          /^[0-9a-f]{64}$/.test(first.report.reconciled[0]?.plan_digest ?? ''),
          `plan_digest=${(first.report.reconciled[0]?.plan_digest ?? '').slice(0, 16)}…`,
        );

        const results = first.repos.operations.itemResults(reached.operation_id);
        check(
          '逐条目回执记成「核验到目标状态」',
          results[0]?.state === 'RECOVERED_TARGET',
          `state=${results[0]?.state ?? '(无)'}`,
        );
        check(
          '回执上的 before 记的是**被批准的那份基线**',
          results[0]?.before_sha256 === sha256(bodyOf('decide-target', 'ok', 'before')),
        );
        check(
          '回执上的 after 记的是**这一次观测到的内容**',
          results[0]?.after_sha256 === sha256(bodyOf('decide-target', 'ok', 'after')),
        );
        check('回执上没有错误码', results[0]?.error_code === null, `error_code=${String(results[0]?.error_code)}`);
        check(
          '被标为经恢复协调而来',
          first.repos.operations.requireById(reached.operation_id).recovered === true,
        );
      } finally {
        closeDatabase(first.opened.db);
      }
      check(
        '自动定案**没有**改写文件（大小/时刻/内容全等）',
        sameFingerprint(written, fingerprint(reached.abs('ok.txt'))),
      );

      // 第二格：全部还在基线上（一次都没写）。
      const original = await makeRig('decide-original', [
        {
          relative: 'ok.txt',
          before: bodyOf('decide-original', 'ok', 'before'),
          after: bodyOf('decide-original', 'ok', 'after'),
        },
      ]);
      const baseline = fingerprint(original.abs('ok.txt'));

      const second = await restartAndSweep(original);
      try {
        check(
          '全在基线上 ⇒ 自动定案为 ROLLED_BACK',
          second.report.reconciled[0]?.after === 'ROLLED_BACK',
          `after=${String(second.report.reconciled[0]?.after)}`,
        );
        check(
          '而它**没有**被标成「经恢复协调而来」',
          second.repos.operations.requireById(original.operation_id).recovered === false,
          '这条路上没有字节被写回去过，把它记成 recovered 会伪造一次写入',
        );
        check(
          '逐条目回执记成「核验到原状态」',
          second.repos.operations.itemResults(original.operation_id)[0]?.state === 'RECOVERED_ORIGINAL',
          `state=${String(second.repos.operations.itemResults(original.operation_id)[0]?.state)}`,
        );
        check(
          '该工作区不再需要恢复',
          second.recovery.requiresRecovery(second.repos.workspaces.requireById(WORKSPACE)) === false,
        );
      } finally {
        closeDatabase(second.opened.db);
      }
      check('这一格同样没碰文件', sameFingerprint(baseline, fingerprint(original.abs('ok.txt'))));

      note(
        '「不写字节」是怎么量的',
        '比的是**文件指纹**：大小 + 最后写入时刻 + 内容哈希。只比内容的话，一次「把同样的字节再写一遍」也会通过，'
          + '而 mtime 会变。三样全等才叫没写过。',
      );
    });

    // -----------------------------------------------------------------------
    section('§4 验收 (a)：写得完、应答丢 —— 重启收敛为「已应用」，不重复修改');
    // -----------------------------------------------------------------------
    await guarded('§4', async () => {
      const rig = await makeRig('lost-reply', [
        {
          relative: 'docs/a.txt',
          before: bodyOf('lost-reply', 'a', 'before'),
          after: bodyOf('lost-reply', 'a', 'after'),
        },
        {
          relative: 'deep/nest/b.txt',
          before: bodyOf('lost-reply', 'b', 'before'),
          after: bodyOf('lost-reply', 'b', 'after'),
        },
      ]);
      const applied = await applyWithoutFinalize(rig);
      check('装置：两个文件都写成了', applied.kind === 'applied', `kind=${applied.kind}`);
      for (const spec of rig.specs) {
        check(
          `装置：${spec.relative} 的盘上字节等于被批准的目标`,
          sha256(readFileSync(rig.abs(spec.relative))) === sha256(spec.after),
        );
      }
      const before = new Map(rig.specs.map((spec) => [spec.relative, fingerprint(rig.abs(spec.relative))]));

      // 崩溃点就在这里：写完了，应答没送到，账停在 APPLYING。
      const { opened, repos, recovery, report } = await restartAndSweep(rig);
      try {
        check('重启后收敛为 APPLIED', repos.operations.requireById(rig.operation_id).state === 'APPLIED');
        check(
          'recovered=true（这一次定案是恢复流程做的）',
          repos.operations.requireById(rig.operation_id).recovered === true,
        );
        check(
          'finished_at 有值（它不是一条悬着的记录）',
          repos.operations.requireById(rig.operation_id).finished_at !== null,
        );
        check('修改集同步收敛为 APPLIED', repos.changes.requireById(rig.change_id).state === 'APPLIED');
        check(
          '这个工作区**不再**需要恢复',
          recovery.requiresRecovery(repos.workspaces.requireById(WORKSPACE)) === false,
        );
        check(
          '自动定案的有 2 个条目',
          report.reconciled[0]?.items.length === 2,
          `items=${String(report.reconciled[0]?.items.length)}`,
        );
        check(
          '两个条目的判定都是「目标已达」',
          (report.reconciled[0]?.items ?? []).every((entry) => entry.verdict === 'TARGET_REACHED'),
        );
        check(
          '两条回执都是「核验到目标状态」',
          repos.operations.itemResults(rig.operation_id).every((row) => row.state === 'RECOVERED_TARGET'),
        );
      } finally {
        closeDatabase(opened.db);
      }

      let allEqual = true;
      for (const spec of rig.specs) {
        const was = before.get(spec.relative);
        if (was === undefined || !sameFingerprint(was, fingerprint(rig.abs(spec.relative)))) allEqual = false;
      }
      check('**不重复修改**：两个文件的大小、时刻、内容哈希三者全等', allEqual);
    });

    // -----------------------------------------------------------------------
    section('§5 验收 (b)：用户在崩溃后继续编辑 —— 恢复不覆盖');
    // -----------------------------------------------------------------------
    await guarded('§5', async () => {
      const rig = await makeRig('user-edits', [
        {
          relative: 'live.txt',
          before: bodyOf('user-edits', 'live', 'before'),
          after: bodyOf('user-edits', 'live', 'after'),
        },
      ]);
      await applyWithoutFinalize(rig);

      // 崩溃之后，用户继续编辑：内容既不是基线也不是目标。
      const theirs = Buffer.from('用户在崩溃之后自己写的东西\r\n', 'utf8');
      writeFileSync(rig.abs('live.txt'), theirs);
      const theirFingerprint = fingerprint(rig.abs('live.txt'));

      const { opened, repos, recovery, report } = await restartAndSweep(rig);
      try {
        check('第三种内容**不**被自动定案', report.reconciled.length === 0);
        check(
          '它落到「留待人工」',
          report.awaiting_manual.length === 1,
          `awaiting_manual=${String(report.awaiting_manual.length)}`,
        );
        check(
          '原因是「第三种内容」',
          report.awaiting_manual[0]?.reconciliation.reason === 'THIRD_CONTENT',
          `reason=${String(report.awaiting_manual[0]?.reconciliation.reason)}`,
        );
        check('操作停在待恢复', repos.operations.requireById(rig.operation_id).state === 'RECOVERY_REQUIRED');
        check('修改集同样停在待恢复', repos.changes.requireById(rig.change_id).state === 'RECOVERY_REQUIRED');
        check(
          '工作区被标着需要恢复',
          recovery.requiresRecovery(repos.workspaces.requireById(WORKSPACE)) === true,
        );

        const results = repos.operations.itemResults(rig.operation_id);
        check(
          '回执**不**声称任何一种「回来了」',
          results[0]?.state === 'UNKNOWN',
          `state=${results[0]?.state ?? '(无)'}`,
        );
        check(
          '而它说得出为什么',
          results[0]?.error_code === 'THIRD_CONTENT',
          `error_code=${String(results[0]?.error_code)}`,
        );
        check(
          '回执上的 before 仍是被批准的那份基线',
          results[0]?.before_sha256 === sha256(bodyOf('user-edits', 'live', 'before')),
        );

        // 恢复记录：**不**接受任何工具参数，全部来自状态库。
        const record = recovery.records(rig.operation_id);
        check('恢复记录读得到', record !== null);
        check(
          '记录里逐条目列得出这一条',
          record?.items[0]?.canonical_path === 'live.txt',
          `path=${String(record?.items[0]?.canonical_path)}`,
        );
        check('记录里的操作状态是待恢复', record?.operation_state === 'RECOVERY_REQUIRED');
        check(
          '记录里带着人工那一条日志',
          (record?.journal ?? []).some((row) => row.stage === RECOVERY_STAGE.manual),
        );
        check(
          '记录里**没有**「收场成功」那一条',
          (record?.journal ?? []).every((row) => row.stage !== RECOVERY_STAGE.repaired),
        );
        check('一条授权都没有（没人批过什么）', (record?.authorizations ?? []).length === 0);
        checkRedacted('脱敏：这一段日志文本里没有本机绝对路径', journalText(repos, rig.operation_id));
        checkRedacted(
          '脱敏：记录的条目路径里没有本机绝对路径',
          (record?.items ?? []).map((row) => row.canonical_path).join('|'),
        );

        // 判成人工时，**不许**有任何写入动作被放出来。
        const inspection = await recovery.inspect(rig.operation_id);
        check(
          '收场判据是**拒绝**的（有现场不属于我们）',
          inspection?.repair.kind === 'refused' && inspection.repair.reason === 'HAS_UNRESOLVED_ITEMS',
          `repair=${String(inspection?.repair.kind)}`,
        );
        let refused = false;
        let refusedCode = '';
        try {
          await recovery.authorize({ operation_id: rig.operation_id, actor: 'console:取证' });
        } catch (error) {
          refused = true;
          refusedCode = isBridgeError(error) ? error.code : '(不是 BridgeError)';
        }
        check('因此连恢复授权都签发不出来', refused, `code=${refusedCode}`);
        check(
          '授权表里一条都没有',
          repos.recovery_authorizations.listForOperation(rig.operation_id).length === 0,
        );
      } finally {
        closeDatabase(opened.db);
      }

      check(
        '用户那一次编辑的字节与时刻**一个都没变**',
        sameFingerprint(theirFingerprint, fingerprint(rig.abs('live.txt'))),
      );
    });

    // -----------------------------------------------------------------------
    section('§6 验收 (c)：数据库/快照不完整时默认暂停');
    // -----------------------------------------------------------------------
    await guarded('§6 甲：快照缺失 ⇒ 收场停下，且历史仍然读得到', async () => {
      const rig = await makeRig('snap-gone', [
        {
          relative: 'a.txt',
          before: bodyOf('snap-gone', 'a', 'before'),
          after: bodyOf('snap-gone', 'a', 'after'),
        },
        {
          relative: 'b.txt',
          before: bodyOf('snap-gone', 'b', 'before'),
          after: bodyOf('snap-gone', 'b', 'after'),
        },
      ]);
      await applyWithoutFinalize(rig);
      // 用户撤销第二条 ⇒ 混合态 ⇒ 收场判据成立，而目标正是第一条。
      writeFileSync(rig.abs('b.txt'), bodyOf('snap-gone', 'b', 'before'));
      const firstWritten = fingerprint(rig.abs('a.txt'));

      const baselineBlobId = rig.items[0]?.old_blob_id ?? '';
      check('装置：第一条有基线快照可删', baselineBlobId.length > 0);
      const objectPath = deleteSnapshot(rig, baselineBlobId);
      check('装置：快照对象确实不在了', existsSync(objectPath) === false);

      const { opened, repos, recovery } = await restartAndSweep(rig);
      try {
        check(
          '扫描照常跑完（判定不需要快照）',
          repos.operations.requireById(rig.operation_id).state === 'RECOVERY_REQUIRED',
        );
        const inspection = await recovery.inspect(rig.operation_id);
        check('装置：收场判据在快照缺失之前是成立的', inspection?.repair.kind === 'ok');

        const granted = await recovery.authorize({ operation_id: rig.operation_id, actor: 'console:取证' });
        const repaired = await recovery.repair({
          operation_id: rig.operation_id,
          authorization_id: granted.authorization_id,
        });
        check('**一条都没收回来**', repaired.repaired === 0, `repaired=${String(repaired.repaired)}`);
        check('并且说得出为什么', typeof repaired.failed === 'string' && repaired.failed.length > 0);
        check(
          '原因是「取不到快照」',
          /取不到基线快照|快照/.test(repaired.failed ?? ''),
          (repaired.failed ?? '').slice(0, 80),
        );
        checkRedacted('脱敏：那句原因里没有本机绝对路径', repaired.failed ?? '');

        const stages = stagesOf(repos, rig.operation_id);
        check(
          '日志里有「收场失败」那一条',
          stages.includes(RECOVERY_STAGE.repair_failed),
          `stages=${stages.join(',')}`,
        );
        check('日志里**没有**「收场成功」那一条', stages.includes(RECOVERY_STAGE.repaired) === false);
        check('状态没动：仍然是待恢复', repos.operations.requireById(rig.operation_id).state === 'RECOVERY_REQUIRED');

        // 历史还在 ——「不完整」与「新安装」的区别就在这里。
        const record = recovery.records(rig.operation_id);
        check('历史读得到：那条授权还在记录里', record?.authorizations.length === 1);
        check('而它已经被消费过（那是一次真实的动作）', record?.authorizations[0]?.state === 'CONSUMED');
        check('逐条目回执仍然读得到', (record?.items.length ?? 0) >= 1);
      } finally {
        closeDatabase(opened.db);
      }
      check('**一个字节都没写**：文件指纹全等', sameFingerprint(firstWritten, fingerprint(rig.abs('a.txt'))));
    });

    await guarded('§6 乙：护栏不可用 ⇒ 判定不成，原样留着', async () => {
      const rig = await makeRig('no-guard', [
        {
          relative: 'c.txt',
          before: bodyOf('no-guard', 'c', 'before'),
          after: bodyOf('no-guard', 'c', 'after'),
        },
      ]);
      await applyWithoutFinalize(rig);
      const written = fingerprint(rig.abs('c.txt'));

      // 把故障插在护栏边界上：`readFileGuarded` 直接抛（真实现里这是 pwsh
      // 起不来、或护栏进程中途消失时的形态）。这是本文件唯一一处非生产代码，
      // 而它插的位置正是「判定做不成」那一条要问的地方。转发必须逐个方法写
      // 出来：后端用私有字段，品牌检查会挡住 `Object.create` 那种转发。
      const failing: WinfsOps = {
        capability: () => realOps.capability(),
        statVolume: (req) => realOps.statVolume(req),
        validatePath: (req) => realOps.validatePath(req),
        resolvePath: (req) => realOps.resolvePath(req),
        readFileGuarded: () => {
          throw new Error('护栏进程无法启动（本证据构造的后端故障）。');
        },
        writeFileGuarded: (req) => realOps.writeFileGuarded(req),
        createFileGuarded: (req) => realOps.createFileGuarded(req),
        listDirectory: (req) => realOps.listDirectory(req),
      };

      const broken = await restartAndSweep(rig, failing);
      try {
        check(
          '护栏不可用时仍然把它标成待恢复',
          broken.report.leftovers === 1,
          `leftovers=${String(broken.report.leftovers)}`,
        );
        check(
          '判定不成 ⇒ 进 undecidable',
          broken.report.undecidable.length === 1,
          `undecidable=${String(broken.report.undecidable.length)}`,
        );
        check(
          '它**不**被算进「留待人工」',
          broken.report.awaiting_manual.length === 0,
          '判都没判成，谈不上人工判定',
        );
        check('它**不**被算进「自动定案」', broken.report.reconciled.length === 0);
        check(
          '状态原样留着',
          broken.repos.operations.requireById(rig.operation_id).state === 'RECOVERY_REQUIRED',
        );
        check('恢复记录仍然读得到', broken.recovery.records(rig.operation_id) !== null);
        check(
          '工作区仍然带着未处理的恢复记录（写能力关着）',
          broken.recovery.requiresRecovery(broken.repos.workspaces.requireById(WORKSPACE)) === true,
        );
        check(
          '扫描那一条日志仍然在',
          stagesOf(broken.repos, rig.operation_id).includes(RECOVERY_STAGE.swept),
        );
      } finally {
        closeDatabase(broken.opened.db);
      }
      check('判定不成时**一个字都没改**磁盘', sameFingerprint(written, fingerprint(rig.abs('c.txt'))));
    });

    await guarded('§6 丙：库文件坏掉 ⇒ 拒绝打开，且不凭空建新库', async () => {
      const badDb = path.join(sandbox, 'broken.db');
      const garbage = Buffer.alloc(8192, 0x41);
      writeFileSync(badDb, garbage);

      let refused = false;
      let code = '(没有抛)';
      try {
        const opened = openDatabase({ path: badDb });
        closeDatabase(opened.db);
      } catch (error) {
        refused = true;
        code = isBridgeError(error)
          ? error.code
          : `(非 BridgeError) ${String((error as Error).message).slice(0, 60)}`;
      }
      check('坏掉的库**拒绝打开**', refused, `code=${code}`);
      check('拒绝打开时**没有**改写那个文件', readFileSync(badDb).equals(garbage));
      check('文件长度也没变（没有被截断成空库）', readFileSync(badDb).length === garbage.length);
      check('现场没有多出一个新库文件', existsSync(`${badDb}-new`) === false);
    });

    // -----------------------------------------------------------------------
    section('§7 步骤 4：本地恢复授权 —— 签发、钉住现场、一次性');
    // -----------------------------------------------------------------------
    await guarded('§7 甲：混合态 ⇒ 授权 ⇒ 收场写回基线', async () => {
      const rig = await makeRig('repair', [
        {
          relative: 'a.txt',
          before: bodyOf('repair', 'a', 'before'),
          after: bodyOf('repair', 'a', 'after'),
        },
        {
          relative: 'b.txt',
          before: bodyOf('repair', 'b', 'before'),
          after: bodyOf('repair', 'b', 'after'),
        },
      ]);
      await applyWithoutFinalize(rig);
      // 用户撤销第二条 ⇒ 混合态（一条已达、一条未变）。
      writeFileSync(rig.abs('b.txt'), bodyOf('repair', 'b', 'before'));
      const writtenA = fingerprint(rig.abs('a.txt'));

      const { opened, repos, recovery } = await restartAndSweep(rig);
      try {
        const inspection = await recovery.inspect(rig.operation_id);
        check('混合态 ⇒ 不自动定案', inspection?.reconciliation.kind === 'MANUAL');
        check(
          '原因是 MIXED',
          inspection?.reconciliation.reason === 'MIXED',
          `reason=${String(inspection?.reconciliation.reason)}`,
        );
        check('而收场判据是**允许**的', inspection?.repair.kind === 'ok');
        check(
          '唯一的动作是「收回基线」，不是「写到目标」',
          inspection?.repair.kind === 'ok' && inspection.repair.action === 'ROLLBACK_TO_BASELINE',
          `action=${inspection?.repair.kind === 'ok' ? inspection.repair.action : '(拒绝)'}`,
        );
        check(
          '收场目标按 seq 倒序（最后写的先收回）',
          inspection?.repair.kind === 'ok' &&
            inspection.repair.targets[0]?.item.canonical_path === 'a.txt',
          `targets=${
            inspection?.repair.kind === 'ok'
              ? inspection.repair.targets.map((target) => target.item.canonical_path).join(',')
              : '(拒绝)'
          }`,
        );

        const granted = await recovery.authorize({ operation_id: rig.operation_id, actor: 'console:取证' });
        check('授权签发出来了', granted.authorization_id.length > 0, `id=${granted.authorization_id}`);
        check('它钉住的是**此刻的现场**：一个 64 位摘要', /^[0-9a-f]{64}$/.test(granted.digest));
        const ttl = Date.parse(granted.expires_at) - Date.now();
        check(
          '有效期是 §9.3 的那个数字（10 分钟，与本地批准同一个）',
          ttl > 0 && ttl <= LIMITS.APPROVAL_TTL_MS,
          `剩余 ${String(Math.round(ttl / 1000))}s / 上限 ${String(LIMITS.APPROVAL_TTL_MS / 60_000)}min`,
        );
        check(
          '授权表里是 ACTIVE',
          repos.recovery_authorizations.findById(granted.authorization_id)?.state === 'ACTIVE',
        );

        // 摘要绑的是**可观测量**，因此同一份现场重算两次得到同一组目标。
        const again = await recovery.inspect(rig.operation_id);
        const targetsOf = (result: typeof inspection): string =>
          result?.repair.kind === 'ok'
            ? result.repair.targets.map((target) => target.item.id).join(',')
            : '(拒绝)';
        check('同一份现场重算两次，收场目标逐条相同', targetsOf(again) === targetsOf(inspection));

        const repaired = await recovery.repair({
          operation_id: rig.operation_id,
          authorization_id: granted.authorization_id,
        });
        check('收回了一条', repaired.repaired === 1, `repaired=${String(repaired.repaired)}`);
        check('没有失败', repaired.failed === null, `failed=${String(repaired.failed)}`);
        check('定案是 ROLLED_BACK', repaired.reconciliation.kind === 'ROLLED_BACK');
        check(
          '授权一次性：用过了',
          repos.recovery_authorizations.findById(granted.authorization_id)?.state === 'CONSUMED',
        );
        check('操作定案为已回滚', repos.operations.requireById(rig.operation_id).state === 'ROLLED_BACK');
        check('修改集同步定案为已回滚', repos.changes.requireById(rig.change_id).state === 'ROLLED_BACK');
        check(
          '工作区不再需要恢复',
          recovery.requiresRecovery(repos.workspaces.requireById(WORKSPACE)) === false,
        );

        const afterA = fingerprint(rig.abs('a.txt'));
        check('第一个文件回到了基线字节', afterA.sha256 === sha256(bodyOf('repair', 'a', 'before')));
        check('而它确实被改过（与写完之后那一份不同）', afterA.sha256 !== writtenA.sha256);
        check(
          '第二个文件（用户撤销过的那一个）一个字节都没被动',
          fingerprint(rig.abs('b.txt')).sha256 === sha256(bodyOf('repair', 'b', 'before')),
        );

        const receipts = repos.operations.itemResults(rig.operation_id);
        check(
          '两条回执都是「核验到原状态」',
          receipts.length === 2 && receipts.every((row) => row.state === 'RECOVERED_ORIGINAL'),
          receipts.map((row) => row.state).join(','),
        );

        const stages = stagesOf(repos, rig.operation_id);
        check('日志里有「收场成功」那一条', stages.includes(RECOVERY_STAGE.repaired), `stages=${stages.join(',')}`);
        const repairedLine = repos.journal
          .list(rig.operation_id)
          .find((row) => row.stage === RECOVERY_STAGE.repaired);
        check('收场那一条说清了「按本地恢复授权」', (repairedLine?.detail ?? '').includes('本地恢复授权'));
        checkRedacted('脱敏：收场日志里没有本机绝对路径', journalText(repos, rig.operation_id));
      } finally {
        closeDatabase(opened.db);
      }
    });

    await guarded('§7 乙：授权签发之后磁盘又被改过 ⇒ 消费被拒绝，且不烧掉授权', async () => {
      const rig = await makeRig('stale-auth', [
        {
          relative: 'a.txt',
          before: bodyOf('stale-auth', 'a', 'before'),
          after: bodyOf('stale-auth', 'a', 'after'),
        },
        {
          relative: 'b.txt',
          before: bodyOf('stale-auth', 'b', 'before'),
          after: bodyOf('stale-auth', 'b', 'after'),
        },
      ]);
      await applyWithoutFinalize(rig);
      writeFileSync(rig.abs('b.txt'), bodyOf('stale-auth', 'b', 'before'));

      const { opened, repos, recovery } = await restartAndSweep(rig);
      try {
        const inspection = await recovery.inspect(rig.operation_id);
        check('装置：混合态，因此授权签得出来', inspection?.repair.kind === 'ok');

        const granted = await recovery.authorize({ operation_id: rig.operation_id, actor: 'console:取证' });
        // 授权之后，用户在第一个文件上又写了一次。
        writeFileSync(rig.abs('a.txt'), Buffer.from('用户刚刚写的\r\n', 'utf8'));
        const theirs = fingerprint(rig.abs('a.txt'));

        let rejected = false;
        let rejectionCode = '';
        try {
          await recovery.repair({ operation_id: rig.operation_id, authorization_id: granted.authorization_id });
        } catch (error) {
          rejected = true;
          rejectionCode = isBridgeError(error) ? error.code : '(不是 BridgeError)';
        }
        check('拒绝执行', rejected, `code=${rejectionCode}`);
        check(
          '**没有**消费掉那条授权（它还在，只是对这份现场不成立）',
          repos.recovery_authorizations.findById(granted.authorization_id)?.state === 'ACTIVE',
        );
        check('**没有**碰磁盘', sameFingerprint(theirs, fingerprint(rig.abs('a.txt'))));
        check('状态仍是待恢复', repos.operations.requireById(rig.operation_id).state === 'RECOVERY_REQUIRED');
      } finally {
        closeDatabase(opened.db);
      }
    });

    await guarded('§7 丙：禁用连接**不**妨碍查看恢复记录', async () => {
      const rig = await makeRig('disabled-conn', [
        {
          relative: 'a.txt',
          before: bodyOf('disabled-conn', 'a', 'before'),
          after: bodyOf('disabled-conn', 'a', 'after'),
        },
      ]);
      await applyWithoutFinalize(rig);
      writeFileSync(rig.abs('a.txt'), Buffer.from('用户自己写的\r\n', 'utf8'));

      const { opened, repos, recovery } = await restartAndSweep(rig);
      try {
        check(
          '装置：这时它有未处理的恢复记录',
          recovery.requiresRecovery(repos.workspaces.requireById(WORKSPACE)) === true,
        );

        // 停用连接 —— 恢复记录**不**看这个。
        repos.connections.setEnabled(CONNECTION, false);
        check('装置：连接已停用', repos.connections.requireById(CONNECTION).enabled === false);
        check(
          '装置：该工作区仍然被标成待恢复',
          recovery.requiresRecovery(repos.workspaces.requireById(WORKSPACE)) === true,
        );

        const record = recovery.records(rig.operation_id);
        check('停用之后恢复记录照样读得到', record !== null);
        check('逐条目清单还在', (record?.items.length ?? 0) === 1, `items=${String(record?.items.length ?? 0)}`);
        check('日志还在', (record?.journal.length ?? 0) >= 2, `journal=${String(record?.journal.length ?? 0)}`);
        check('操作状态还是待恢复', record?.operation_state === 'RECOVERY_REQUIRED');

        // 而写入面仍然是关着的：这不是「停用连接换来了什么」。
        const inspection = await recovery.inspect(rig.operation_id);
        check(
          '停用连接**没有**让收场变得可行（它本来就因为第三种内容被拒）',
          inspection?.repair.kind === 'refused',
          `repair=${String(inspection?.repair.kind)}`,
        );
      } finally {
        closeDatabase(opened.db);
      }
    });

    // -----------------------------------------------------------------------
    section('§8 边界：模型侧够不到恢复包（静态判据）');
    // -----------------------------------------------------------------------
    await guarded('§8', async () => {
      const trackedTs = (dir: string): string[] =>
        execFileSync('git', ['ls-files', '--', dir], { encoding: 'utf8' })
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.endsWith('.ts'));

      const modelFacing = [...trackedTs('apps/mcp-adapter/src'), ...trackedTs('apps/daemon/src/tools')];
      check('模型侧扫到了文件（装置自检）', modelFacing.length >= 8, `files=${String(modelFacing.length)}`);

      const importOffenders = modelFacing.filter((file) => {
        const text = readFileSync(file, 'utf8');
        return (
          /from\s+['"]@lwb\/recovery/.test(text) ||
          /import\s*\(\s*['"]@lwb\/recovery/.test(text) ||
          /require\(\s*['"]@lwb\/recovery/.test(text) ||
          /from\s+['"][^'"]*packages\/recovery/.test(text)
        );
      });
      check(
        '模型侧没有任何文件 import 恢复包（含相对路径与动态 import）',
        importOffenders.length === 0,
        `offenders=${importOffenders.join(',') || '(无)'}`,
      );

      const vocabularyOffenders = modelFacing.filter((file) => {
        const text = readFileSync(file, 'utf8');
        return text.includes('recovery_authorizations') || text.includes('recovery_repaired');
      });
      check(
        '模型侧不提恢复授权表与「收场成功」这个阶段名',
        vocabularyOffenders.length === 0,
        `files=${vocabularyOffenders.join(',') || '(无)'}`,
      );

      // 反向：装配根**确实**导入了它，且扫描排在工具面之前。
      const assembly = readFileSync('apps/daemon/src/runtime/assembly.ts', 'utf8');
      check('装配根导入了恢复服务', /from\s+['"]@lwb\/recovery['"]/.test(assembly));
      check('装配根**确实** await 了启动扫描', /await\s+recovery\.sweepStartup\(\)/.test(assembly));
      const sweepAt = assembly.indexOf('sweepStartup()');
      const surfaceAt = assembly.indexOf('createToolSurface(');
      check(
        '启动扫描排在工具面**之前**（步骤 1 的「先处理，再开放」是一处行序）',
        sweepAt > 0 && surfaceAt > 0 && sweepAt < surfaceAt,
        `sweep@${String(sweepAt)} < surface@${String(surfaceAt)}`,
      );
      check(
        '逐工作区的 recovery_required 接的是真查询，不是常量',
        /capabilityFlagsWith\([\s\S]*?recovery\.requiresRecovery\(/.test(assembly),
        '关掉能力开关是回退动作；把它硬编码成假会让「一个真值查询」变成一句谎',
      );
      check(
        '装配根里已经没有旧的那句「一律 false」',
        /capabilityFlagsWith\(BRIDGE_GATES,\s*\(\)\s*=>\s*false\)/.test(assembly) === false,
      );

      // 回退约束：整个恢复包里不许出现 git 回滚命令，也不许出现删除文件。
      const recoverySources = ['service.ts', 'plan.ts', 'verdict.ts']
        .map((file) => readFileSync(`packages/recovery/src/${file}`, 'utf8'))
        .join('\n');
      check(
        '回退约束：恢复包里不存在 `git reset/checkout/stash/clean`',
        /git\s+(reset|checkout|stash|clean)/.test(recoverySources) === false,
        '任务书原文：不得通过覆盖用户文件实现代码回滚',
      );
      check(
        '回退约束：恢复包里不存在删除文件的调用',
        /unlink|rmSync|rmdir|Remove-Item/.test(recoverySources) === false,
        '本工程不删文件 —— 一个多余的文件是可逆的，因此宁可要求人工处理它',
      );
    });

    // -----------------------------------------------------------------------
    section('§9 未执行项（这些不是 PASS）');
    // -----------------------------------------------------------------------
    skip(
      '真实 ChatGPT 网页端验收（读—写—回读）',
      'LWB-002 BLOCKED：需要真实账号在 Platform 侧建立 Secure MCP Tunnel 并完成控制台步骤；'
        + 'MCP Inspector 成功不能代替网页验收，因此这一条不计入 PASS',
    );
    skip(
      '「写到一半进程真的被杀」留下的现场',
      '护栏的写入是一次请求内的 校验→截断→写入→刷盘→回读，中间没有可以从外面插进去的窗口，本机也没有故障注入。'
        + '「写得完、应答丢」这一格由 §4 覆盖；「读到一半」那一格由判定表覆盖',
    );
    skip(
      '`recovery_required` 真的挡住了一次新的写入',
      '协调器尚未装配进守护进程（LWB-032）。今天它是一个**真实查询**的布尔（§8 已验），'
        + '但「它被写路径读到并拒绝」要等接线完成',
    );
    skip(
      '撤销一次**已终结**的提议',
      '属 LWB-031。本任务的收场是「把已经写下去的收回来」，不是用户可见的撤销',
    );
    skip(
      '跨卷 / 只读卷 / 卷被拔掉',
      '同 LWB-027/028/029：本机只有一个固定卷，造不出第二种',
    );
    skip(
      '两个进程真的同时抢同一块地',
      '属 LWB-033（竞争/崩溃/故障专项）；LWB-026 已经用真跨进程取证证过互斥与接管',
    );
    skip(
      '恢复授权过期之后被拒绝',
      '真盘上要等十分钟才走到，而它证明的与 `tests/unit/recovery-persistence.test.ts` 同一条规则；'
        + '单元那一份已经把「过期 ⇒ 拒绝」钉住',
    );
    skip(
      '新建条目已达目标之后的收场',
      '`repairOf` 对 `TARGET_REACHED` 的新建条目一律拒绝（`CREATED_OBJECT_NOT_REMOVED`）：'
        + '护栏没有删除操作，本工程不去造一个。真盘上造这一格要写 `create_text`，'
        + '而它的裁决与改写条目同一张表 —— 单元测试 C 组已穷尽',
    );
  } finally {
    await disposeWinfsBackend();
    rmSync(sandbox, { recursive: true, force: true });
  }

  console.log(`\n小计：PASS=${passes} FAIL=${failures} NOT_RUN=${skips}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
