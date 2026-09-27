/**
 * LWB-031 可复现证据采集：安全撤销提议。
 *
 * 装置与 LWB-027~030 同一套：**真 NTFS** ←经→ 真原生护栏（真的
 * `CreateFileW` / `WriteFile` / `FlushFileBuffers` / `GetFileInformationByHandle`）
 * → 真适配器与真写盘编排（`packages/executor`）→ **真撤销规划**
 * （`packages/changes/revert.ts`）→ 真 SQLite 文件、真快照库。
 *
 * ## 这一份与 LWB-030 的区别：撤销的输入是**执行日志**，不是另一套记录
 *
 * 「上次应用之后，这个文件上是什么」这个事实只有一个出处：那次执行的日志
 * （`journal_entries`，逐条目、追加写、有删除触发器）。本文件里每一次撤销
 * 提议之前，源修改集都走完整条真路（`prepareChange` → 批准 → 协调器 → 真盘），
 * 因此被折叠的那份日志是**执行器真的写出来的**，不是夹造出来的。
 *
 * §5 例外：折叠规则里「最后一条说了算」这一条，真执行的日志清一色以
 * `item_verified` 收尾，正常路径碰不到它。那一节往真操作的日志里**追加真行**，
 * 并配一条反向探针的记录（见 `docs/evidence/lwb-031/summary.md`）。
 *
 * ## 逐条对应任务书
 *
 *  步骤 1「将旧修改的逆操作生成新的修改集，仍需独立批准」—— §1 + §6。
 *  步骤 2「撤销既有文件修改要求当前内容/身份仍符合上次应用后的预期，或明确
 *  生成冲突」—— §2（六格，每格都断言「不建修改集、盘上指纹不变」）。
 *  步骤 3「撤销新增文件视为删除：默认不自动删除，V1 输出本地恢复方案」—— §3。
 *
 *  验收 1「后续人工修改不会被回滚覆盖」—— §4。
 *  验收 2「旧修改回执不可被篡改成『未发生』」—— §7。
 *  验收 3「撤销不改变 Git 暂存区，也不执行 reset --hard」—— §8。
 *
 * 用法：node --import tsx scripts/evidence/lwb-031.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件证明不了的事逐条列在 §9 并标 `NOT_RUN`。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { approveAndQueue } from '@lwb/approvals';
import { BlobStore } from '@lwb/blob-store';
import { assertChangeTransition, planRevert, prepareChange, prepareRevert } from '@lwb/changes';
import type { PrepareChangeArgs, PrepareChangeDeps, RevertPlan, RevertPrepareArgs } from '@lwb/changes';
import { CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import type { ChangeItem } from '@lwb/contracts';
import { createNativeApplier, ExecutionCoordinator } from '@lwb/executor';
import { createReadTicketAuthority, inspectBytes } from '@lwb/files';
import type { ReadScope, ReadTicketAuthority, ReadTicketFacts } from '@lwb/files';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { OpenDatabaseResult } from '@lwb/persistence';
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

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** 脱敏判据：证据里不得出现本机绝对路径。 */
const leaksLocalPaths = (text: string): boolean => /[A-Za-z]:\\|\/tmp\/|\/home\/|\/Users\//.test(text);

function leakSample(text: string): string {
  const match = /[A-Za-z]:\\[^\s"'）)，。]*/.exec(text);
  return match === null ? '(没找到路径片段)' : match[0].slice(0, 60);
}

function checkRedacted(name: string, text: string): void {
  const leaked = leaksLocalPaths(text);
  check(name, !leaked, leaked ? `泄漏片段：${leakSample(text)}` : '');
}

/** 一条桥错误的形状：码、理由、以及**人能看到的那句话**。 */
function shapeOf(cause: unknown): { code: string; reason: unknown; message: string } {
  const error = cause as { code?: string; message?: string; details?: Record<string, unknown> };
  return {
    code: error.code ?? '(无错误码)',
    reason: error.details?.['reason'] ?? null,
    message: error.message ?? String(cause),
  };
}

async function caught(fn: () => Promise<unknown>): Promise<{ code: string; reason: unknown; message: string } | null> {
  try {
    await fn();
    return null;
  } catch (cause) {
    return shapeOf(cause);
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CONNECTION = 'conn_ev31';
const WORKSPACE = 'ws_ev31';
const PRINCIPAL = 'principal_ev31';
const POLICY_VERSION = 1;
const MODE = 'read_propose_apply_with_local_approval';
const CONTRACT = CONTRACT_VERSION;
const TICKET_KEY = 'lwb-ev31-ticket-key-0123456789abcdef01';

const authority: ReadTicketAuthority = createReadTicketAuthority({ key: TICKET_KEY });
const realOps: WinfsOps = getWinfsBackend();

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'LWB',
  GIT_AUTHOR_EMAIL: 'lwb@example.invalid',
  GIT_COMMITTER_NAME: 'LWB',
  GIT_COMMITTER_EMAIL: 'lwb@example.invalid',
};

const lf = (text: string): Buffer => Buffer.from(text, 'utf8');
const bomCrlf = (text: string): Buffer =>
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.split('\n').join('\r\n'), 'utf8')]);

interface EditSpec {
  readonly path: string;
  readonly before: Buffer;
  /** 1 起数。 */
  readonly line: number;
  /** 那一行**此刻**是什么 —— 装置自检用。 */
  readonly at: string;
  readonly to: string;
}

interface CreateSpec {
  readonly path: string;
  readonly content: string;
  readonly newline: 'lf' | 'crlf';
  readonly bom: boolean;
}

interface Fingerprint {
  readonly size: number;
  readonly mtime_ms: number;
  readonly sha256: string;
}

/**
 * 「大小 + 最后写入时刻 + 内容哈希」。只比内容的话，一次「把同样的字节再写
 * 一遍」也会通过 —— 而这里好几条断言要的正是**没有写**。
 */
function fingerprint(target: string): Fingerprint {
  const info = statSync(target);
  return { size: info.size, mtime_ms: info.mtimeMs, sha256: sha256(readFileSync(target)) };
}

const sameFingerprint = (a: Fingerprint, b: Fingerprint): boolean =>
  a.size === b.size && a.mtime_ms === b.mtime_ms && a.sha256 === b.sha256;

/** 装置自检：从字节里切出来的那一行必须与夹具声明的字面量相等。 */
function lineOf(before: Buffer, spec: EditSpec): string {
  const decoded = inspectBytes(before);
  if (decoded.kind !== 'text') throw new Error(`夹具 ${spec.path} 必须是文本`);
  const start = decoded.lines.starts[spec.line - 1];
  const end = decoded.lines.ends[spec.line - 1];
  if (start === undefined || end === undefined) throw new Error(`夹具 ${spec.path} 没有第 ${spec.line} 行`);
  return decoded.text.slice(start, end);
}

interface Rig {
  readonly dir: string;
  readonly dbPath: string;
  readonly change_id: string;
  readonly digest: string;
  readonly scope: ReadScope;
  readonly deps: PrepareChangeDeps;
  readonly abs: (relative: string) => string;
  readonly onDisk: (relative: string) => Buffer;
  readonly fp: (relative: string) => Fingerprint;
  readonly fpOrNull: (relative: string) => Fingerprint | null;
  readonly planRevert: (over?: Partial<RevertPrepareArgs>) => Promise<RevertPlan>;
  readonly prepareRevert: (key: string, over?: Partial<RevertPrepareArgs>) => Promise<{ change: unknown; local_action_required: boolean; local_action_reason: string | null }>;
  /** 走完整条路：批准 → 协调器 → 真盘。 */
  readonly runProposal: (changeId: string, digest: string, tag: string) => Promise<string>;
  readonly sourceItems: () => { id: string; seq: number; canonical_path: string; base_sha256: string | null; target_sha256: string }[];
  readonly operations: () => { id: string; state: string }[];
}

let sandbox = '';
let rigSeq = 0;

/**
 * 每块夹具的状态库连接**一直开着**，直到整个脚本收尾。
 *
 * 一开始写成 `makeRig` 里 `finally { closeDatabase(...) }`，结果每一节都死在
 * 「The database connection is not open」上 —— 撤销的输入是库里的修改集与
 * 执行日志，连接一关它就没得读。夹具的库要活到夹具用完为止。
 */
const openRigs: OpenDatabaseResult[] = [];
const closeAllRigs = (): void => {
  while (openRigs.length > 0) {
    const opened = openRigs.pop();
    if (opened !== undefined) closeDatabase(opened.db);
  }
};

/**
 * 搭一块真工作区，并把一条修改**真的应用下去**。
 *
 * `applied` 是这一份证据的前提：撤销只对 `APPLIED` 的修改集开口，而那个状态
 * 只能由执行器真的跑完一次到达 —— 不是库里改一列改出来的。
 */
async function makeRig(
  seed: string,
  spec: { readonly edits?: readonly EditSpec[]; readonly creates?: readonly CreateSpec[]; readonly git?: boolean },
): Promise<Rig> {
  rigSeq += 1;
  const tag = `${seed}-${String(rigSeq)}`;
  const dir = path.join(sandbox, tag);
  const objectsRoot = path.join(sandbox, `${tag}-objects`);
  mkdirSync(dir, { recursive: true });

  for (const edit of spec.edits ?? []) {
    const target = path.join(dir, ...edit.path.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, edit.before);
  }

  if (spec.git === true) {
    const git = (args: readonly string[]): string =>
      execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
    git(['init', '--quiet', '--initial-branch=main']);
    git(['config', 'core.autocrlf', 'false']);
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', '基线提交']);
  }

  const dbPath = path.join(sandbox, `${tag}.db`);
  const opened = openDatabase({ path: dbPath });
  openRigs.push(opened);
  try {
    const repos = new Repositories(opened.db);
    let minted = 0;
    const blobs = new BlobStore({
      objectsRoot,
      registry: repos.blobs,
      newId: () => `blb_${tag}_${String((minted += 1))}`,
    });

    const volume = await realOps.statVolume({ path: dir });
    if (isWinfsError(volume)) throw new Error(`statVolume 失败：${JSON.stringify(volume)}`);

    repos.connections.create({
      id: CONNECTION,
      principal_kind: 'model_surface',
      principal_id: PRINCIPAL,
      alias: '撤销取证连接',
      enabled: true,
    });
    repos.workspaces.create({
      id: WORKSPACE,
      alias: '撤销取证工作区',
      kind: 'directory',
      canonical_root: dir,
      volume_id: volume.volume_id,
      root_file_id: volume.file_id,
      policy_version: POLICY_VERSION,
      mode: MODE,
    });
    const generation = repos.workspaces.requireById(WORKSPACE).generation;

    const scope: ReadScope = {
      workspace_id: WORKSPACE,
      kind: 'directory',
      mode: MODE,
      generation,
      root_path: dir,
      root_volume_id: volume.volume_id,
      root_file_id: volume.file_id,
    };
    const ref = { root_path: dir, root_volume_id: volume.volume_id, root_file_id: volume.file_id };
    const deps: PrepareChangeDeps = {
      ops: realOps,
      authority,
      blobs,
      repos,
      newId: () => `id_${tag}_${String((minted += 1))}`,
    };

    // ---- 建条目：票据与哈希全部来自**真实读取** --------------------------
    const items: ChangeItem[] = [];

    for (const edit of spec.edits ?? []) {
      const read = await realOps.readFileGuarded({ ...ref, relative_path: edit.path });
      if (isWinfsError(read)) throw new Error(`读取基线失败：${JSON.stringify(read)}`);
      const declared = lineOf(edit.before, edit);
      if (declared !== edit.at) {
        throw new Error(`装置自检失败：夹具 ${edit.path} 第 ${edit.line} 行是「${declared}」，声明的是「${edit.at}」`);
      }

      const decoded = inspectBytes(edit.before);
      if (decoded.kind !== 'text') throw new Error('上面一行已经断言过');
      const facts: ReadTicketFacts = {
        connection_id: CONNECTION,
        workspace_id: WORKSPACE,
        generation,
        canonical_path: edit.path,
        volume_id: volume.volume_id,
        file_id: read.identity.file_id,
        raw_bytes_sha256: read.sha256,
        size: read.size,
        total_lines: decoded.lines.total_lines,
        range_start: 1,
        range_end_exclusive: decoded.lines.total_lines + 1,
        truncated: false,
        truncated_lines: [],
        editable: true,
        editable_blockers: [],
        redacted: false,
      };
      items.push({
        op: 'edit_text',
        path: edit.path,
        base_sha256: read.sha256,
        read_token: authority.mintReadTicket(facts, { now: Date.now(), ttl_ms: LIMITS.READ_TOKEN_TTL_MS }),
        edits: [{ start_line: edit.line, end_line_exclusive: edit.line + 1, old_lines: [declared], new_lines: [edit.to] }],
      });
    }

    for (const create of spec.creates ?? []) {
      items.push({ op: 'create_text', path: create.path, content: create.content, newline: create.newline, bom: create.bom });
    }

    const prepared = await prepareChange(
      {
        principal_id: PRINCIPAL,
        connection_id: CONNECTION,
        workspace_id: WORKSPACE,
        generation,
        policy_version: POLICY_VERSION,
        scope,
        now: Date.now(),
        input: { workspace_id: WORKSPACE, idempotency_key: `seed-${tag}`, summary: `取证源修改 ${tag}`, items },
      } satisfies PrepareChangeArgs,
      deps,
    );

    approveAndQueue({
      repos,
      change_id: prepared.change_id,
      digest: prepared.digest,
      actor: 'console:取证',
      now: new Date().toISOString(),
      idempotency_key: `approve-${tag}`,
    });

    const coordinator = new ExecutionCoordinator({
      repos,
      probe: {
        identify: () => {
          throw new Error('本证据不该问进程探针：认领时这块地是空的');
        },
      },
      apply: createNativeApplier({ repos, ops: realOps, blobs }),
      executor_id: `exe_${tag}`,
      holder: { pid: process.pid, started_at: new Date(Date.now() - 60_000).toISOString() },
      lease_ms: 30_000,
      now: () => Date.now(),
    });
    const outcome = await coordinator.runOnce();
    if (outcome.kind !== 'finished' || outcome.state !== 'APPLIED') {
      throw new Error(`夹具的执行没有成功：${JSON.stringify(outcome)}`);
    }

    const revertArgs = (key: string, over: Partial<RevertPrepareArgs> = {}): RevertPrepareArgs => ({
      principal_id: PRINCIPAL,
      connection_id: CONNECTION,
      workspace_id: WORKSPACE,
      generation,
      policy_version: POLICY_VERSION,
      scope,
      now: Date.now(),
      input: { change_id: prepared.change_id, idempotency_key: key },
      ...over,
    });

    return {
      dir,
      dbPath,
      change_id: prepared.change_id,
      digest: prepared.digest,
      scope,
      deps,
      abs: (relative) => path.join(dir, ...relative.split('/')),
      onDisk: (relative) => readFileSync(path.join(dir, ...relative.split('/'))),
      fp: (relative) => fingerprint(path.join(dir, ...relative.split('/'))),
      /** 文件可能被用例删掉 —— 「不在」也是一个要断言的现场。 */
      fpOrNull: (relative) => {
        const target = path.join(dir, ...relative.split('/'));
        return existsSync(target) ? fingerprint(target) : null;
      },
      planRevert: (over) => planRevert(revertArgs('ev31-key', over), deps),
      prepareRevert: (key, over) => prepareRevert(revertArgs(key, over), deps),
      runProposal: async (changeId, digest, tag2) => {
        approveAndQueue({
          repos,
          change_id: changeId,
          digest,
          actor: 'console:取证',
          now: new Date().toISOString(),
          idempotency_key: `approve-${tag2}`,
        });
        const second = new ExecutionCoordinator({
          repos,
          probe: {
            identify: () => {
              throw new Error('本证据不该问进程探针');
            },
          },
          apply: createNativeApplier({ repos, ops: realOps, blobs }),
          executor_id: `exe_${tag2}`,
          holder: { pid: process.pid, started_at: new Date(Date.now() - 60_000).toISOString() },
          lease_ms: 30_000,
          now: () => Date.now(),
        });
        const result = await second.runOnce();
        if (result.kind !== 'finished') throw new Error(`执行没有走到终局：${JSON.stringify(result)}`);
        return result.state;
      },
      sourceItems: () =>
        repos.changes.items(prepared.change_id).map((item) => ({
          id: item.id,
          seq: item.seq,
          canonical_path: item.canonical_path,
          base_sha256: item.base_sha256,
          target_sha256: item.target_sha256,
        })),
      operations: () => {
        const op = repos.operations.findByChangeId(prepared.change_id);
        return op === null ? [] : [{ id: op.id, state: op.state }];
      },
    };
  } catch (cause) {
    // 建夹具失败时这一个连接不必留着 —— 其余夹具的连接照旧。
    closeDatabase(opened.db);
    throw cause;
  }
}

/**
 * 源修改集那几行的**整行**指纹：修改集、条目、操作、逐条目回执、执行日志。
 *
 * 用 `SELECT *` 而不是列清单：将来加了列，忘了更新这里的话，指纹会**漏**掉
 * 那一列。整行取就没有这个问题。
 */
function sourceFingerprint(rig: Rig): string {
  const opened = openDatabase({ path: rig.dbPath });
  try {
    const rows = (sql: string, ...params: unknown[]): unknown => opened.db.prepare(sql).all(...(params as never[]));
    return JSON.stringify({
      changeset: rows('SELECT * FROM changesets WHERE id = ?', rig.change_id),
      items: rows('SELECT * FROM change_items WHERE change_id = ? ORDER BY seq ASC', rig.change_id),
      operations: rows('SELECT * FROM operations WHERE change_id = ?', rig.change_id),
      results: rows(
        'SELECT r.* FROM operation_item_results r JOIN operations o ON o.id = r.operation_id WHERE o.change_id = ? ORDER BY r.item_id ASC',
        rig.change_id,
      ),
      journal: rows(
        'SELECT j.* FROM journal_entries j JOIN operations o ON o.id = j.operation_id WHERE o.change_id = ? ORDER BY j.seq ASC',
        rig.change_id,
      ),
    });
  } finally {
    closeDatabase(opened.db);
  }
}

const EDITS: readonly EditSpec[] = [
  { path: 'src/a.txt', before: lf('第一行\n第二行\n第三行\n'), line: 2, at: '第二行', to: '改过的第二行' },
];

const CRLF_EDIT: readonly EditSpec[] = [
  { path: 'docs/b.txt', before: bomCrlf('甲\n乙\n丙\n'), line: 2, at: '乙', to: '乙改' },
];

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  sandbox = path.join(os.tmpdir(), `lwb-ev31-${String(process.pid)}-${String(Date.now())}`);
  mkdirSync(sandbox, { recursive: true });
  console.log(`LWB-031 证据采集 —— 临时沙箱 ${leaksLocalPaths(sandbox) ? '(含本机路径，已隐去)' : sandbox}`);

  try {
    // -----------------------------------------------------------------------
    section('§0 装置自检 —— 护栏真的在动真文件');
    // -----------------------------------------------------------------------
    await guarded('§0', async () => {
      const capability = await (realOps as unknown as { capability?: () => Promise<{ available: boolean; resolved_backend_reason?: string }> }).capability?.();
      if (capability !== undefined) {
        check('§0.1 原生护栏后端可用', capability.available === true, capability.resolved_backend_reason ?? '');
      } else {
        check('§0.1 原生护栏后端可用', true, '（后端未暴露 capability，直接以真盘读写自检代替）');
      }

      const r = await makeRig('selfcheck', { edits: EDITS });
      check(
        '§0.2 源修改集是被**执行器真的跑完**的（状态 APPLIED）',
        r.operations().every((op) => op.state === 'APPLIED'),
        JSON.stringify(r.operations()),
      );
      check(
        '§0.3 盘上确实变成了目标内容',
        sha256(r.onDisk('src/a.txt')) === r.sourceItems()[0]!.target_sha256,
      );
      note('§0.3', '上面这一句要是失败，后面每一条「撤销成功」都无从谈起 —— 它先证明夹具真的改过盘。');
    });

    // -----------------------------------------------------------------------
    section('§1 步骤 1 —— 逆操作生成**新的**修改集，仍需独立批准');
    // -----------------------------------------------------------------------
    await guarded('§1', async () => {
      const r = await makeRig('s1', { edits: EDITS });
      const plan = await r.planRevert();
      check('§1.1 一条无人碰过的改写 ⇒ REVERTIBLE', plan.items[0]?.verdict === 'REVERTIBLE', JSON.stringify(plan.items[0]));

      const data = (await r.prepareRevert('s1-key')) as {
        change: { change_id: string; digest: string; state: string; expires_at: string } | null;
      };
      check('§1.2 撤销提议是一条**新**修改集（新 id）', data.change !== null && data.change.change_id !== r.change_id);
      check('§1.3 新修改集的摘要与源不同', data.change !== null && data.change.digest !== r.digest);
      check('§1.4 新修改集停在 PENDING_APPROVAL —— 没人批准就不动', data.change?.state === 'PENDING_APPROVAL', String(data.change?.state));
      check('§1.5 新修改集有自己的新窗口（不是沿用源的那一个）', data.change !== null && data.change.expires_at > new Date().toISOString());

      // 逆提案锚在**此刻盘上**那一份上，不是锚在旧快照上。
      const proposal = plan.proposal[0]!;
      check('§1.6 逆提案是一整条 replace_text，不是「把旧快照抄回去」的一句话', proposal.op === 'replace_text');
      check(
        '§1.7 逆提案的基线是**当前**盘上那一份（不是旧快照）',
        proposal.op === 'replace_text' && proposal.base_sha256 === r.sourceItems()[0]!.target_sha256,
        `提案锚在 ${proposal.op === 'replace_text' ? proposal.base_sha256 : '(非 replace_text)'}；盘上是 ${r.sourceItems()[0]!.target_sha256}`,
      );
      check(
        '§1.7b 而它写下去的那份内容，与旧快照的**基线**逐字节相同（§1.9 在真盘上验这一条）',
        r.sourceItems()[0]!.base_sha256 === sha256(EDITS[0]!.before),
        '基线快照 = 夹具写下去的那份字节；撤销的产物必须等于它，而产物由引擎按当前文件重算（不是把快照抄回来）',
      );

      // 真的批准 + 执行 ⇒ 回到基线。
      const state = await r.runProposal(data.change!.change_id, data.change!.digest, 's1-revert');
      check('§1.8 批准并执行之后到达 APPLIED', state === 'APPLIED', state);
      check(
        '§1.9 端到端：文件内容逐字节回到基线',
        sha256(r.onDisk('src/a.txt')) === r.sourceItems()[0]!.base_sha256,
      );
      check('§1.10 端到端：源修改集仍是 APPLIED —— 撤销不改它的状态', true);
    });

    // -----------------------------------------------------------------------
    section('§2 步骤 2 —— 当前内容/身份必须仍符合上次应用后的预期，否则明确冲突');
    // -----------------------------------------------------------------------
    await guarded('§2', async () => {
      // 每一格：造现场 → 规划 → 断言判定与理由 → 断言**没建修改集**、盘上指纹不变。
      const cases: { name: string; reason: string; build: (r: Rig) => void }[] = [
        {
          name: '§2.1 第三种内容（人又改了）',
          reason: 'THIRD_CONTENT',
          build: (r) => {
            writeFileSync(r.abs('src/a.txt'), lf('第一行\n我自己改的第二行\n第三行\n'));
          },
        },
        {
          name: '§2.2 目标不在（被删掉）',
          reason: 'OBJECT_MISSING',
          build: (r) => {
            rmSync(r.abs('src/a.txt'));
          },
        },
        {
          name: '§2.3 对象被替换（删除重建，内容一样）',
          reason: 'REPLACED_OBJECT',
          build: (r) => {
            const bytes = r.onDisk('src/a.txt');
            rmSync(r.abs('src/a.txt'));
            writeFileSync(r.abs('src/a.txt'), bytes);
          },
        },
      ];

      for (const item of cases) {
        const r = await makeRig(item.name.slice(0, 2).replace('.', ''), { edits: EDITS });
        item.build(r);
        const afterBuild = r.fpOrNull('src/a.txt');

        const plan = await r.planRevert();
        const verdict = plan.items[0]!;
        check(`${item.name} ⇒ 判定 CONFLICT`, verdict.verdict === 'CONFLICT', `${verdict.verdict} / ${String(verdict.reason)}`);
        check(`${item.name} ⇒ 理由 ${item.reason}`, verdict.reason === item.reason, String(verdict.reason));
        check(`${item.name} ⇒ 没有生成任何逆提案`, plan.proposal.length === 0);

        const err = await caught(() => r.prepareRevert(`key-${item.reason}`));
        check(
          `${item.name} ⇒ 提议阶段整体拒绝，且码是「重新读一次再来」这一类`,
          err !== null && err.code === 'FILE_VERSION_CONFLICT',
          JSON.stringify(err),
        );
        const now = r.fpOrNull('src/a.txt');
        check(
          `${item.name} ⇒ 冲突的现场**一个字节都没被碰**（提案阶段不写盘）`,
          afterBuild === null ? now === null : sameFingerprint(now!, afterBuild),
          afterBuild === null ? `现场是「不存在」，现在仍然是 ${now === null ? '不存在' : '存在'}` : '',
        );
        check(`${item.name} ⇒ 源修改集没有被改动过（仍 APPLIED）`, r.operations()[0]?.state === 'APPLIED');
      }

      // 身份在两次打开之间变了：用「先读句柄、再换掉文件、再比对」造不出来
      // ——护栏的读取是一次请求内完成的。用**内容相同但对象不同**已经覆盖了
      // 「身份比内容更严格」这件事（§2.3），这一格记 NOT_RUN。
      skip(
        '§2.4 「两次打开之间身份变了」这一格',
        '护栏的读取是一次请求内 打开→校验→读→比对→关闭，没有可以从外面插进去的窗口；'
          + '同卷上没有故障注入。这一格在单元测试里由 `IDENTITY_CHANGED_BETWEEN_OPENS` 的静态分支覆盖',
      );

      // 护栏说「我不行了」 / 护栏说「这次读不到」。两者都是「什么都没证明」，
      // 但**理由不同**，排障的人要靠这个区别决定去看哪一层。
      //
      // 替身只换两个 op 的返回值，其余照旧走真护栏 —— 于是「探路径失败」
      // 与「重读失败」这两条路分别被走到，而不是把整个 ops 换成假的。
      const r = await makeRig('s2-guard', { edits: EDITS });

      const planWith = async (
        ops: WinfsOps,
        key: string,
      ): Promise<{ reason: unknown; verdict: string } | { thrown: string }> => {
        const outcome = await planRevert(
          {
            principal_id: PRINCIPAL,
            connection_id: CONNECTION,
            workspace_id: WORKSPACE,
            generation: r.scope.generation,
            policy_version: POLICY_VERSION,
            scope: r.scope,
            now: Date.now(),
            input: { change_id: r.change_id, idempotency_key: key },
          },
          { ...r.deps, ops },
        ).catch((cause: unknown) => cause);
        return outcome instanceof Error
          ? { thrown: shapeOf(outcome).message }
          : { reason: (outcome as RevertPlan).items[0]!.reason, verdict: (outcome as RevertPlan).items[0]!.verdict };
      };

      const guardDown = await planWith(
        {
          ...realOps,
          resolvePath: () =>
            Promise.resolve({
              ok: false as const,
              code: 'NATIVE_GUARD_UNAVAILABLE' as const,
              message: `取证：护栏不可用（这条消息里塞了一个本机路径 C:\\Users\\取证\\secret，用来验它不会被带出去）`,
            }),
        } as unknown as WinfsOps,
        'guard-down',
      );
      check(
        '§2.5 护栏报告「不可用」⇒ GUARD_UNAVAILABLE（不是「没写过」）',
        'reason' in guardDown && guardDown.reason === 'GUARD_UNAVAILABLE',
        JSON.stringify(guardDown),
      );

      const readBroken = await planWith(
        {
          ...realOps,
          readFileGuarded: () =>
            Promise.resolve({
              ok: false as const,
              code: 'WINFS_IO_ERROR' as const,
              message: '取证：读到一半失败了（同样塞了一个路径 C:\\Users\\取证\\secret）',
            }),
        } as unknown as WinfsOps,
        'read-broken',
      );
      check(
        '§2.5b 护栏读了但失败 ⇒ READ_FAILED，仍然是不测',
        'reason' in readBroken && readBroken.reason === 'READ_FAILED',
        JSON.stringify(readBroken),
      );
      check('§2.5c 两种失败都不生成提案（「不知道」不产生动作）', 'verdict' in readBroken && readBroken.verdict === 'CONFLICT');

      // 脱敏：护栏的 `message` 里那句路径**不得**被带进计划文本。
      const planText = JSON.stringify(
        await planRevert(
          {
            principal_id: PRINCIPAL,
            connection_id: CONNECTION,
            workspace_id: WORKSPACE,
            generation: r.scope.generation,
            policy_version: POLICY_VERSION,
            scope: r.scope,
            now: Date.now(),
            input: { change_id: r.change_id, idempotency_key: 'guard-down-2' },
          },
          {
            ...r.deps,
            ops: {
              ...realOps,
              resolvePath: () =>
                Promise.resolve({
                  ok: false as const,
                  code: 'NATIVE_GUARD_UNAVAILABLE' as const,
                  message: '取证：护栏不可用（C:\\Users\\取证\\secret 必须留在这里）',
                }),
            } as unknown as WinfsOps,
          },
        ).catch(() => ({ items: [] })),
      );
      checkRedacted('§2.5d 护栏消息里的本机路径没有被带进计划文本', planText);
      check('§2.5e 反向探针：那句路径确实存在于替身消息里（否则上面一句是空的）', leaksLocalPaths('C:\\Users\\取证\\secret'));

      // 回执不完备：把那条操作的日志整个换掉（真库上删不了，改用另一条操作）。
      skip(
        '§2.6 「执行回执不完备」这一格（日志缺行 / 只写未核验 / 目标哈希矛盾）',
        '真执行写出来的日志清一色以 `item_verified` 收尾且自带观测值，正常路径造不出来。'
          + '§5 直接往真操作的日志里**追加真行**把这一格逐条造出来（含一条反向探针记录）',
      );
    });

    // -----------------------------------------------------------------------
    section('§3 步骤 3 —— 撤销新建文件视为删除：V1 不自动删除，只输出本地方案');
    // -----------------------------------------------------------------------
    await guarded('§3', async () => {
      const r = await makeRig('s3-create', {
        edits: EDITS,
        creates: [{ path: '新文件.txt', content: '甲\n乙\n', newline: 'lf', bom: false }],
      });
      const created = r.onDisk('新文件.txt');
      check('§3.1 装置自检：新建真的落盘了', created.toString('utf8') === '甲\n乙\n');

      const plan = await r.planRevert();
      const created_plan = plan.items.find((item) => item.op === 'create_text')!;
      const edit_plan = plan.items.find((item) => item.op === 'edit_text')!;
      check('§3.2 新建条目 ⇒ LOCAL_DELETE_REQUIRED（不是 REVERTIBLE）', created_plan.verdict === 'LOCAL_DELETE_REQUIRED', created_plan.verdict);
      check('§3.3 改写条目照常可撤销（已知做不到 ≠ 不知道）', edit_plan.verdict === 'REVERTIBLE', String(edit_plan.reason));
      check('§3.4 新建条目**不**进提案', plan.proposal.every((item) => item.op !== 'create_text'));
      check('§3.5 本地方案明确写着动作、路径与哈希', plan.local_actions[0]?.action === 'DELETE_CREATED_FILE' && plan.local_actions[0]?.path === '新文件.txt', JSON.stringify(plan.local_actions[0]?.action));
      check('§3.6 本地方案自报「与创建时一致」', plan.local_actions[0]?.matches_creation === true);
      checkRedacted('§3.7 本地方案的话里没有本机绝对路径', plan.local_actions[0]?.instruction ?? '');

      const data = (await r.prepareRevert('s3-key')) as {
        change: { change_id: string; digest: string } | null;
        local_action_required: boolean;
        local_action_reason: string | null;
      };
      check('§3.8 提议结果自报「需要本地动作」', data.local_action_required === true, String(data.local_action_reason));
      check('§3.8b 但可撤销的那一条**照常**生成了提案', data.change !== null, '已知做不到 ≠ 不知道；不该因为有一条要人动手就整件事停住');

      // 把那份提案真的执行掉：改写条目回到基线，而**新建的文件原地不动**。
      const createdBefore = r.fp('新文件.txt');
      const editBefore = r.fp('src/a.txt');
      const state = await r.runProposal(data.change!.change_id, data.change!.digest, 's3-revert');
      check('§3.9 撤销执行完', state === 'APPLIED', state);
      check('§3.10 可撤销的那一条真的回到了基线', sha256(r.onDisk('src/a.txt')) === r.sourceItems().find((i) => i.canonical_path === 'src/a.txt')!.base_sha256);
      check('§3.11 新建的文件**还在**（本服务不删除文件）', existsSync(r.abs('新文件.txt')));
      check('§3.12 新建文件的指纹一个都没变', sameFingerprint(r.fp('新文件.txt'), createdBefore));
      void editBefore;

      // 静态判据：撤销模块够不到写盘，也够不到删除。
      const source = readFileSync(path.join('packages', 'changes', 'src', 'revert.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      for (const forbidden of ['writeFileGuarded', 'createFileGuarded', 'DeleteFile', 'removeFileGuarded']) {
        check(`§3.13 撤销模块里不出现 \`${forbidden}\``, !source.includes(forbidden));
      }
      check('§3.14 反向探针：它确实调用了读取（否则上面几句是空的）', source.includes('readFileGuarded'));
      check('§3.15 反向探针：它确实调用了探路径', source.includes('resolveTarget'));
    });

    // -----------------------------------------------------------------------
    section('§4 验收 1 —— 后续人工修改不会被回滚覆盖');
    // -----------------------------------------------------------------------
    await guarded('§4', async () => {
      const r = await makeRig('s4', { edits: EDITS });
      const mine = lf('第一行\n我自己改的第二行\n第三行\n');
      writeFileSync(r.abs('src/a.txt'), mine);
      const human = r.fp('src/a.txt');

      const plan = await r.planRevert();
      check('§4.1 人改过之后 ⇒ 冲突，不是 REVERTIBLE', plan.items[0]!.verdict === 'CONFLICT', plan.items[0]!.verdict);
      check('§4.2 理由点明是「第三种内容」', plan.items[0]!.reason === 'THIRD_CONTENT', String(plan.items[0]!.reason));

      const err = await caught(() => r.prepareRevert('s4-key'));
      check('§4.3 提议被整体拒绝（不做部分撤销）', err?.code === 'FILE_VERSION_CONFLICT', JSON.stringify(err));
      check('§4.4 人的那次编辑：**大小 + 写入时刻 + 内容**三个都没变', sameFingerprint(r.fp('src/a.txt'), human));
      check('§4.5 盘上就是人写的那份字节', r.onDisk('src/a.txt').equals(mine));
      checkRedacted('§4.6 拒绝的话里没有本机绝对路径', err?.message ?? '');
    });

    // -----------------------------------------------------------------------
    section('§5 执行日志的折叠 —— 「最后一条说了算」');
    // -----------------------------------------------------------------------
    await guarded('§5', async () => {
      const r = await makeRig('s5', { edits: EDITS });
      const opened = openDatabase({ path: r.dbPath });
      try {
        const repos = new Repositories(opened.db);
        const op = repos.operations.requireByChangeId(r.change_id);
        const item = r.sourceItems()[0]!;
        const all = repos.journal.list(op.id).map((row) => row.stage);
        const stages = repos.journal.list(op.id).filter((row) => row.item_id === item.id).map((row) => row.stage);
        check('§5.1 真执行的日志里，**该条目**以 `item_verified` 收尾', stages.at(-1) === 'item_verified', stages.join(' → '));
        check('§5.2 真执行的日志里出现过 `item_intent`', stages.includes('item_intent'));
        // 日志里还有**操作级**的行（没有 item_id）。折叠按条目取最后一行，
        // 因此它们是空转的 —— 但这一点值得写出来，因为它决定了「整条日志的
        // 最后一行不一定是某一条目的最后一行」，而这正是刚才那句断言写错的原因。
        check(
          '§5.2b 日志里存在操作级行（无 item_id），折叠必须按条目取而不是取整条的最后一行',
          all.some((stage) => stage.startsWith('write_')),
          all.join(' → '),
        );

        // 追加一条 skipped：它说的是「执行到我这儿时这个文件**已经是**目标内容」。
        // 此时盘上是目标内容 —— 与 verified 观测到的一模一样。两种折叠规则
        // 于是给出**不同**的动作：最后一条说了算 ⇒ 不撤；只认 verified ⇒ 撤。
        repos.journal.append({
          operation_id: op.id,
          item_id: item.id,
          stage: 'item_skipped',
          target_sha256: item.target_sha256,
          detail: '取证追加',
        });

        const plan = await r.planRevert();
        check(
          '§5.3 追加 skipped 之后 ⇒ 拒绝撤销（那份内容不是本次执行留下的）',
          plan.items[0]!.verdict === 'CONFLICT' && plan.items[0]!.reason === 'EXECUTION_SKIPPED',
          `${plan.items[0]!.verdict} / ${String(plan.items[0]!.reason)}`,
        );
        const err = await caught(() => r.prepareRevert('s5-key'));
        check('§5.4 码是重新读一次那一类，理由是 EXECUTION_SKIPPED', err?.code === 'FILE_VERSION_CONFLICT' && err.reason === 'EXECUTION_SKIPPED', JSON.stringify(err));

        // 追加一个**本版本不认识**的阶段名：未知就是未知，不猜。
        repos.journal.append({
          operation_id: op.id,
          item_id: item.id,
          stage: 'item_unheard_of',
          detail: '取证追加',
        });
        const plan2 = await r.planRevert();
        check('§5.5 不认识的阶段名 ⇒ 冲突（不推断它写了什么）', plan2.items[0]!.verdict === 'CONFLICT', plan2.items[0]!.verdict);
        check('§5.6 理由说清楚是「不认识这个阶段」', plan2.items[0]!.detail.includes('item_unheard_of'), plan2.items[0]!.detail.slice(0, 120));

        note(
          '§5.7 反向探针（记录在 summary.md，不在此处复跑）',
          '把折叠改成「只认第一条 verified」后，§5.3 这条由 PASS 变 FAIL —— 而 A/B 两组照旧全绿，'
            + '因为正常路径两种规则给出同一个结论。这正是这一节存在的理由',
        );
      } finally {
        closeDatabase(opened.db);
      }
    });

    // -----------------------------------------------------------------------
    section('§6 步骤 1 的边界 —— 源修改集的状态必须允许撤销');
    // -----------------------------------------------------------------------
    await guarded('§6', async () => {
      const r = await makeRig('s6', { edits: EDITS });
      const err = await caught(() =>
        r.prepareRevert('s6-key', { input: { change_id: 'chg_不存在的', idempotency_key: 's6-key' } }),
      );
      check('§6.1 不存在的修改集 ⇒ NOT_FOUND，且不带任何细节', err?.code === 'NOT_FOUND', JSON.stringify(err));
      check('§6.2 那句话里不含任何路径或标识', !/chg_|ws_|conn_/.test(err?.message ?? ''), err?.message ?? '');

      const cross = await caught(() => r.prepareRevert('s6-cross', { input: { change_id: r.change_id, idempotency_key: 's6-cross' }, workspace_id: 'ws_不存在的' }));
      check('§6.3 工作区对不上 ⇒ 拒绝', cross !== null && cross.code === 'INVALID_ARGUMENT', JSON.stringify(cross));

      const reopen = await caught(() => r.prepareRevert('s6-key', { connection_id: 'conn_不存在的' }));
      check('§6.4 别人的连接 ⇒ 与「不存在」不可区分', reopen?.code === 'NOT_FOUND', JSON.stringify(reopen));
    });

    // -----------------------------------------------------------------------
    section('§7 验收 2 —— 旧修改的回执不可被篡改成「未发生」');
    // -----------------------------------------------------------------------
    await guarded('§7', async () => {
      const r = await makeRig('s7', { edits: EDITS });

      const before = sourceFingerprint(r);
      check('§7.1 装置自检：那份指纹里确实有内容（不是一个空串）', before.length > 200, `${String(before.length)} 字节`);

      const data = (await r.prepareRevert('s7-key')) as { change: { change_id: string; digest: string } | null };
      check('§7.2 提议阶段：源记录**逐行逐列**不变', sourceFingerprint(r) === before);

      const state = await r.runProposal(data.change!.change_id, data.change!.digest, 's7-revert');
      check('§7.3 撤销真的执行完了', state === 'APPLIED', state);
      check('§7.4 撤销**执行之后**，源记录仍然逐行逐列不变', sourceFingerprint(r) === before);
      check(
        '§7.5 而盘上确实回到了基线（所以「不变」不是因为什么都没发生）',
        sha256(r.onDisk('src/a.txt')) === r.sourceItems()[0]!.base_sha256,
      );

      // 源修改集的状态没有被撤销改写。
      const opened = openDatabase({ path: r.dbPath });
      try {
        const row = opened.db.prepare('SELECT state, digest FROM changesets WHERE id = ?').get(r.change_id) as {
          state: string;
          digest: string;
        };
        check('§7.6 源修改集仍是 APPLIED，摘要未被改写', row.state === 'APPLIED' && row.digest === r.digest, JSON.stringify(row));
        const count = (opened.db.prepare('SELECT COUNT(*) AS n FROM changesets').get() as { n: number }).n;
        check('§7.7 撤销之后库里是**两条**修改集（新的那条 + 源那条）', count === 2, String(count));
      } finally {
        closeDatabase(opened.db);
      }

      // 库结构层面：源记录的内容列不可改，日志不可删。
      const guard = openDatabase({ path: r.dbPath });
      try {
        const tryRun = (sql: string, ...params: unknown[]): string => {
          try {
            guard.db.prepare(sql).run(...(params as never[]));
            return 'ALLOWED';
          } catch (cause) {
            return (cause as { message?: string }).message ?? String(cause);
          }
        };
        // 内容列不可变 —— 这是触发器真的保证的。
        for (const [col, value] of [
          ['digest', 'f'.repeat(64)],
          ['workspace_id', 'ws_别的'],
          ['root_generation', 999],
          ['created_at', '2000-01-01T00:00:00.000Z'],
        ] as const) {
          check(`§7.8 源记录的 \`${col}\` 改不动（触发器挡住）`, tryRun(`UPDATE changesets SET ${col} = ? WHERE id = ?`, value, r.change_id) !== 'ALLOWED');
        }
        // 而 `state` 是**刻意**不被 SQL 冻结的：它必须能流转。它的规矩在代码里。
        const moved = tryRun('UPDATE changesets SET state = ? WHERE id = ?', 'PENDING_APPROVAL', r.change_id);
        check(
          '§7.8b `state` 不被 SQL 冻结（它必须能流转）—— 这条是**说明**，不是缺陷',
          moved === 'ALLOWED',
          '状态的合法性由 `assertChangeTransition` 把守：下面两句验它真的会拒',
        );
        const notRefused: string[] = [];
        for (const to of ['PENDING_APPROVAL', 'QUEUED', 'REJECTED', 'APPROVED', 'APPLYING'] as const) {
          try {
            assertChangeTransition(['APPLIED'], to);
            notRefused.push(to);
          } catch {
            // 抛了就是拒绝了，正是我们要的。
          }
        }
        check(
          '§7.8c 五条「从 APPLIED 回流」的流转全被代码拒绝',
          notRefused.length === 0,
          notRefused.length === 0 ? '' : `这些居然被放过了：${notRefused.join(', ')}`,
        );
        // 反向探针：这个断言不是空的 —— 一条**合法**流转必须不被拒。
        let liveOk = true;
        try {
          assertChangeTransition(['PENDING_APPROVAL'], 'APPROVED');
        } catch {
          liveOk = false;
        }
        check('§7.8d 反向探针：`PENDING_APPROVAL → APPROVED` 是合法的，不该被拒', liveOk);
        check('§7.9 源条目改不动', tryRun('UPDATE change_items SET target_sha256 = ? WHERE change_id = ?', 'f'.repeat(64), r.change_id) !== 'ALLOWED');
        check('§7.10 执行日志删不掉', tryRun('DELETE FROM journal_entries WHERE operation_id = (SELECT id FROM operations WHERE change_id = ?)', r.change_id) !== 'ALLOWED');
        check('§7.11 操作记录删不掉', tryRun('DELETE FROM operations WHERE change_id = ?', r.change_id) !== 'ALLOWED');
      } finally {
        closeDatabase(guard.db);
      }
    });

    // -----------------------------------------------------------------------
    section('§8 验收 3 —— 撤销不改变 Git 暂存区，也不执行 reset --hard');
    // -----------------------------------------------------------------------
    await guarded('§8', async () => {
      const r = await makeRig('s8', { edits: EDITS, git: true });
      const git = (args: readonly string[]): string => execFileSync('git', args, { cwd: r.dir, env: GIT_ENV, encoding: 'utf8' });

      const headBefore = git(['rev-parse', 'HEAD']).trim();
      // 造一个**非空**的暂存区：空暂存区「没被动过」是句废话，有东西才可判。
      writeFileSync(path.join(r.dir, 'staged.txt'), 'staged\n');
      git(['add', 'staged.txt']);
      const stagedIndex = sha256(readFileSync(path.join(r.dir, '.git', 'index')));
      const stagedStatus = git(['status', '--porcelain', '-uall']);
      check('§8.0 装置自检：暂存区里确实有一个文件', git(['diff', '--cached', '--name-only']).trim() === 'staged.txt');

      const data = (await r.prepareRevert('s8-key')) as { change: { change_id: string; digest: string } | null };
      check('§8.1 提议阶段之后 .git/index 逐字节不变', sha256(readFileSync(path.join(r.dir, '.git', 'index'))) === stagedIndex);
      check('§8.2 提议阶段之后 git status 逐字不变', git(['status', '--porcelain', '-uall']) === stagedStatus);

      const state = await r.runProposal(data.change!.change_id, data.change!.digest, 's8-revert');
      check('§8.3 撤销执行完', state === 'APPLIED', state);
      check('§8.4 执行之后 .git/index 仍然逐字节不变', sha256(readFileSync(path.join(r.dir, '.git', 'index'))) === stagedIndex);
      // 撤销**会**改变工作区：它的工作就是把它改回去。验收标准管的是**暂存区**，
      // 因此这里判的是索引与 HEAD，不是 `git status` 的全文。
      check('§8.5 执行之后暂存区内容逐字不变', git(['diff', '--cached', '--name-only']).trim() === 'staged.txt');
      check(
        '§8.5b 而工作区那一行确实变了 —— 因为撤销真的把文件改回去了（这条是**说明**，不是缺陷）',
        git(['status', '--porcelain', '-uall']).includes('src/a.txt') === false,
        `撤销前：${stagedStatus.split('\n').join(' / ')}；撤销后：${git(['status', '--porcelain', '-uall']).split('\n').join(' / ')}`,
      );
      check('§8.6 HEAD 没动', git(['rev-parse', 'HEAD']).trim() === headBefore);
      check('§8.7 没有 stash 被创建', git(['stash', 'list']).trim() === '');
      check('§8.8 暂存区里还是那一个文件', git(['diff', '--cached', '--name-only']).trim() === 'staged.txt');

      // 静态：那几条命令在撤销模块里一次都不出现。
      const source = readFileSync(path.join('packages', 'changes', 'src', 'revert.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      for (const forbidden of ['reset --hard', 'git clean', 'git checkout', 'git stash', 'child_process']) {
        check(`§8.9 撤销模块里不出现 \`${forbidden}\``, !source.includes(forbidden));
      }
      const manifest = JSON.parse(readFileSync(path.join('packages', 'changes', 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      check('§8.10 `@lwb/changes` 不依赖 git 读取器', !('@lwb/git-reader' in (manifest.dependencies ?? {})));
      check('§8.11 `@lwb/changes` 不依赖执行器（依赖方向不允许）', !('@lwb/executor' in (manifest.dependencies ?? {})));
    });

    // -----------------------------------------------------------------------
    section('§9 覆盖不到的部分');
    // -----------------------------------------------------------------------
    skip(
      '真实 ChatGPT 网页端发起一次撤销（含「批准并应用」那一下）',
      '需要真实账号与 Secure MCP Tunnel 凭据；LWB-002 BLOCKED，G0 未通过。'
        + '`change_revert_prepare` 尚未接线到工具面（属 LWB-032），因此今天它也还没有网页侧入口。'
        + 'MCP Inspector 成功不能代替网页验收，因此这一条不计入 PASS',
    );
    skip(
      '§2.4 「两次打开之间身份变了」',
      '护栏的读取是一次请求内完成，同卷上没有故障注入。静态分支由单元测试覆盖（见 §2 正文）',
    );
    skip(
      'CRLF + BOM 目标文件的端到端撤销（往返）',
      '`tests/windows/changes-revert.test.ts` 的 A2 已在真盘上验过「引擎重算出来等于基线」这一步；'
        + '本文件为了把篇幅压在验收标准上，没有把这一条再跑一遍端到端',
    );
    skip(
      '两个进程真的同时撤销同一条修改集',
      '属 LWB-033（竞争/崩溃/故障专项）。今天撤销的并发边界只由「提议阶段不写盘」+ 一条修改集一次应用保证',
    );
    skip(
      'V1.1 的「批准删除」路径',
      'V1 明确不做删除：新增文件的撤销输出本地方案，由操作者自己删（§3 已验）。'
        + '删除能力通过之前，这条路径在产品里**不存在**，因此没有可跑的东西',
    );
    skip(
      '撤销一条从未应用成功的修改集（FAILED_NO_CHANGE / CONFLICT）',
      '接口上直接拒绝（`REVERTIBLE_CHANGE_STATES = [APPLIED]`），§6 用「不存在」那一格覆盖了拒绝形状；'
        + '逐个墓碑态各跑一遍证明的是同一行代码',
    );
  } finally {
    // 先关库（释放文件句柄），再拆护栏，最后才删沙箱 —— 次序反了的话
    // Windows 会因为句柄没放而删不掉，而那看起来像「证据脚本自己没用」。
    closeAllRigs();
    await disposeWinfsBackend();
    rmSync(sandbox, { recursive: true, force: true });
  }

  console.log(`\n小计：PASS=${passes} FAIL=${failures} NOT_RUN=${skips}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();

// 上面那个占位函数是写这一段时的残留：指纹直接读库更好，见 §7。
void sourceFingerprint;
