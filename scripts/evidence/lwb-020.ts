/**
 * LWB-020 可复现证据采集：不可变修改集与差异预览。
 *
 * 三条验收标准在这里各有独立的一段，全部跑在**真实夹具字节**与**真实护栏**
 * （`PowerShellWinfsBackend`：真实 NTFS 卷序列号与文件索引）上。
 * 工作区是夹具的一份**副本**：副本的 `file_id` 与原树不同，因此票据里的身份
 * 天然必须是「实际将要被读的那个对象」的身份 —— 这一点顺带把「身份取自路径
 * 字符串」这类实现挡在门外。
 *
 *  1. 「prepare 不改变用户工作区任何文件」—— 每次 prepare 前后对整棵工作区
 *     目录树做快照（相对路径 → 内容 SHA-256 + 大小 + mtime + 目录项增删）
 *     并逐项比对。同时记两件事：运行期护栏的写方法被调用了**几次**
 *     （记录型包装器，期望 0），以及源码里有没有出现写方法名（静态可查，
 *     不依赖作者记得）。最后再对**真实夹具树**做一次首尾快照 —— 本脚本
 *     从不在它上面作业。
 *  2. 「相同幂等请求得到同一修改集，变更内容得到不同摘要」—— 同一个键提交
 *     同一份内容两次，比对 `change_id` / `digest` / `idempotent_replay`；
 *     换内容必须得到不同的 `change_id` 与 `digest`；同键换内容必须冲突且
 *     不动既有修改集。**并额外证明摘要可以被重算**：先用一条**独立的**连接
 *     只读落库的行重算，整场跑完后关库、重开、再算一次。没有这一条，
 *     「批准绑定摘要」在跨进程重启时就是一句空话。
 *  3. 「预览显示的最终字节与待应用 blob 一致」—— 把预览里的 `after_sha256`
 *     与快照库里的实际字节对一遍，**再**与独立写出的字节拼装对一遍。
 *     三方一致才算数：只比两方的话，两方同时错就是「一致」。
 *
 * 用法：node --import tsx scripts/evidence/lwb-020.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件证明不了的事（见末尾「未执行项」）：**没有任何一次写入发生在用户
 * 工作区上，也没有经由执行器落盘**。G2 未通过（LWB-002 BLOCKED），P3 的门禁
 * 是「可以在契约冻结的前提下继续实现，但不得在真实仓库上联调」
 * （见 `docs/evidence/g2-read.md`）。
 */

import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { BlobStore } from '@lwb/blob-store';
import { BridgeError, CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import type { ChangeItem, ChangePrepareData } from '@lwb/contracts';
import { createReadTicketAuthority, inspectBytes, lineText, refOf } from '@lwb/files';
import type { ReadScope, ReadTicketAuthority, ReadTicketFacts } from '@lwb/files';
import { classifyFile } from '@lwb/policy';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { Repositories as Repos } from '@lwb/persistence';
import { PowerShellWinfsBackend, isWinfsError } from '@lwb/winfs';
import type { WinfsOps } from '@lwb/winfs';
import {
  canonicalChangeDigest,
  changeSetViewOf,
  deriveRisks,
  prepareChange,
  shortCodeOf,
} from '@lwb/changes';
import type { PrepareLimits } from '@lwb/changes';

import { TESTREPO_DIR, ensureFixtures, loadManifest } from '../../tests/fixtures/index.ts';
import type { FixtureFileEntry, FixtureManifest } from '../../tests/fixtures/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');

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

/** 一段验收抛错时，把「这一段没跑完」记为一条失败，而不是让整个脚本消失。 */
function reportSectionFailure(name: string, cause: unknown): void {
  const error = cause as { code?: string; message?: string; details?: unknown; stack?: string };
  check(`${name} 段跑完`, false, `${error.code ?? '(无错误码)'}：${error.message ?? String(cause)}`);
  if (error.details !== undefined) console.log(`      details=${JSON.stringify(error.details)}`);
  if (error.stack) console.log(`      ${error.stack.split('\n').slice(1, 4).join('\n      ')}`);
}

async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (cause) {
    reportSectionFailure(name, cause);
  }
}

/** 同 `guarded`，但把结果带回来（失败时返回 null，由调用方决定怎么记）。 */
async function guardedValue<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (cause) {
    reportSectionFailure(name, cause);
    return null;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 把抛出的错误压成一行：码 + 理由标签。 */
function errLine(cause: unknown): string {
  if (cause instanceof BridgeError) {
    return `${cause.code}/${String(cause.details?.['reason'] ?? '(无 reason)')}`;
  }
  return `(不是 BridgeError) ${String(cause)}`;
}

async function catchBridge(fn: () => Promise<unknown>): Promise<BridgeError> {
  try {
    await fn();
  } catch (cause) {
    if (cause instanceof BridgeError) return cause;
    throw cause;
  }
  throw new Error('装置错误：期望抛出 BridgeError，实际成功返回');
}

const WINDOWS_ONLY = process.platform === 'win32';

// ---------------------------------------------------------------------------
// 状态库旁路：独立的第二连接
// ---------------------------------------------------------------------------

/**
 * 用**另一条连接**读一行计数。
 *
 * 不借用 `Repositories` 的内部连接（它本就不该暴露）：独立的第二条连接
 * 看到的是磁盘上已提交的事实，与进程内缓存无关。
 */
function countRows(
  dbPath: string,
  table: 'approvals' | 'operations' | 'changesets' | 'change_items',
): number {
  const opened = openDatabase({ path: dbPath });
  try {
    const row = opened.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  } finally {
    closeDatabase(opened.db);
  }
}

/** 直接执行一条 SQL，返回是否**成功改动了行**（被触发器拒绝时为 false）。 */
function runSql(dbPath: string, sql: string, params: readonly unknown[]): boolean {
  const opened = openDatabase({ path: dbPath });
  try {
    opened.db.prepare(sql).run(...(params as never[]));
    return true;
  } catch {
    return false;
  } finally {
    closeDatabase(opened.db);
  }
}

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const CONNECTION = 'conn-evidence-020';
const WORKSPACE = 'ws-evidence-020';
const PRINCIPAL = 'principal-evidence-020';
const POLICY_VERSION = 11;
const NEW_FILE = '证据-新建.txt';
const KEY = 'lwb-evidence-020-key-0123456789abcdef0123456789';

const authority: ReadTicketAuthority = createReadTicketAuthority({ key: KEY });

interface DiskIdentity {
  volume_id: string;
  file_id: string;
  link_count: number;
}

async function diskIdentity(ops: WinfsOps, absPath: string): Promise<DiskIdentity> {
  const info = await ops.statVolume({ path: absPath });
  if (isWinfsError(info)) throw new Error(`statVolume 失败：${info.code} ${info.message}`);
  return { volume_id: info.volume_id, file_id: info.file_id, link_count: info.link_count };
}

function mint(
  bytes: Uint8Array,
  relPath: string,
  identity: DiskIdentity,
  generation: number,
  over: Partial<ReadTicketFacts> = {},
  mintedAt: number = NOW,
): string {
  const decoded = inspectBytes(bytes);
  if (decoded.kind !== 'text') throw new Error(`装置错误：${relPath} 不是文本字节（${decoded.reason}）`);
  const facts: ReadTicketFacts = {
    connection_id: CONNECTION,
    workspace_id: WORKSPACE,
    generation,
    canonical_path: relPath,
    volume_id: identity.volume_id,
    file_id: identity.file_id,
    raw_bytes_sha256: sha256(bytes),
    size: bytes.length,
    total_lines: decoded.lines.total_lines,
    range_start: 1,
    range_end_exclusive: decoded.lines.total_lines + 1,
    truncated: false,
    truncated_lines: [],
    editable: true,
    editable_blockers: [],
    redacted: false,
    ...over,
  };
  return authority.mintReadTicket(facts, { now: mintedAt, ttl_ms: LIMITS.READ_TOKEN_TTL_MS });
}

// --- 记录型护栏包装器 -------------------------------------------------------

interface OpsLog {
  readonly writes: string[];
  reads: number;
  probes: number;
}

/**
 * 把真实护栏包一层，**记录**写方法有没有被调用。
 *
 * 写方法照常转发而不是直接抛错：这样「prepare 不写」的证据不是「它撞墙了」，
 * 而是「它压根没往那走」；而万一真走了，那一笔写会真实发生，随后被目录树
 * 快照抓到 —— 两道证据互相独立。
 */
function recordingOps(inner: WinfsOps, log: OpsLog): WinfsOps {
  return {
    capability: () => inner.capability(),
    statVolume: (req) => inner.statVolume(req),
    validatePath: (req) => inner.validatePath(req),
    resolvePath: (req) => {
      log.probes += 1;
      return inner.resolvePath(req);
    },
    readFileGuarded: (req) => {
      log.reads += 1;
      return inner.readFileGuarded(req);
    },
    listDirectory: (req) => inner.listDirectory(req),
    writeFileGuarded: (req) => {
      log.writes.push(`writeFileGuarded ${req.relative_path}`);
      return inner.writeFileGuarded(req);
    },
    createFileGuarded: (req) => {
      log.writes.push(`createFileGuarded ${req.relative_path}`);
      return inner.createFileGuarded(req);
    },
  };
}

// --- 目录树快照 -------------------------------------------------------------

/** 相对路径 → `sha256 size mtime`（目录记 `dir mtime`）。顺序固定，便于比对。 */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const abs = path.join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const s = await stat(abs);
      if (entry.isDirectory()) {
        out.set(`${rel}/`, `dir mtime=${s.mtimeMs}`);
        await walk(abs, rel);
      } else {
        out.set(rel, `${sha256(await readFile(abs))} size=${s.size} mtime=${s.mtimeMs}`);
      }
    }
  };
  await walk(root, '');
  return out;
}

function diffTrees(before: Map<string, string>, after: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [key, value] of before) {
    const now = after.get(key);
    if (now === undefined) problems.push(`消失：${key}`);
    else if (now !== value) problems.push(`变化：${key}（${value} → ${now}）`);
  }
  for (const key of after.keys()) if (!before.has(key)) problems.push(`出现：${key}`);
  return problems;
}

// --- 语料 -------------------------------------------------------------------

interface Corpus {
  manifest: FixtureManifest;
  /** 可编辑、换行风格可写、且未被策略硬拒绝的夹具。 */
  editable: readonly FixtureFileEntry[];
  bytes: Map<string, Buffer>;
  identity: Map<string, DiskIdentity>;
}

function absOf(root: string, relPath: string): string {
  return path.join(root, ...relPath.split('/'));
}

/**
 * 语料取自**工作区副本**（身份必须来自将要被读的那个对象，而不是原树），
 * 而「哪些可编辑」由**策略层**裁定，不看夹具清单里的 `editable` 字段。
 *
 * 清单字段是夹具生成器的意图标记：`config/.env.example` 在清单里写着
 * `editable: true`，而 `HD-ENV` 连读都硬拒绝它（`.env` / `.env.*` / `*.env`
 * 均不豁免）。拿清单字段当结论，就会把读不到的文件算进「可编辑语料」。
 */
async function loadCorpus(ops: WinfsOps, workspaceRoot: string): Promise<Corpus> {
  ensureFixtures();
  const manifest = await loadManifest();
  const bytes = new Map<string, Buffer>();
  const identity = new Map<string, DiskIdentity>();
  for (const entry of manifest.files) {
    const abs = absOf(workspaceRoot, entry.relPath);
    bytes.set(entry.relPath, await readFile(abs));
    identity.set(entry.relPath, await diskIdentity(ops, abs));
  }
  const editable = manifest.files.filter(
    (entry) =>
      entry.editable &&
      (entry.newline === 'lf' || entry.newline === 'crlf') &&
      classifyFile(entry.relPath).kind !== 'hard_deny',
  );
  return { manifest, editable, bytes, identity };
}

// ===========================================================================
// 验收 1：prepare 不改变用户工作区任何文件
// ===========================================================================

async function prepareDoesNotWrite(
  ops: WinfsOps,
  log: OpsLog,
  workspaceRoot: string,
  corpus: Corpus,
  repos: Repos,
  blobs: BlobStore,
  scope: ReadScope,
  dbPath: string,
): Promise<void> {
  section('验收 1：prepare 不改变用户工作区任何文件');

  const rel = 'newline/lf.txt';
  const bytes = corpus.bytes.get(rel) as Buffer;
  const identity = corpus.identity.get(rel) as DiskIdentity;
  const decoded = inspectBytes(bytes);
  if (decoded.kind !== 'text') throw new Error('装置错误：newline/lf.txt 不是文本');
  const firstLine = lineText(decoded.text, decoded.lines, 1);

  const replaceRel = '文档/设计说明.md';
  const replaceBytes = corpus.bytes.get(replaceRel) as Buffer;

  const stages: readonly {
    readonly label: string;
    readonly key: string;
    readonly items: readonly ChangeItem[];
  }[] = [
    {
      label: 'edit_text',
      key: 'evidence-020-edit',
      items: [
        {
          op: 'edit_text',
          path: rel,
          base_sha256: sha256(bytes),
          read_token: mint(bytes, rel, identity, scope.generation),
          edits: [
            {
              start_line: 1,
              end_line_exclusive: 2,
              old_lines: [firstLine],
              new_lines: ['证据脚本改过的第一行'],
            },
          ],
        },
      ],
    },
    {
      label: 'replace_text',
      key: 'evidence-020-replace',
      items: [
        {
          op: 'replace_text',
          path: replaceRel,
          base_sha256: sha256(replaceBytes),
          read_token: mint(
            replaceBytes,
            replaceRel,
            corpus.identity.get(replaceRel) as DiskIdentity,
            scope.generation,
          ),
          content: '整份替换\n只有两行\n',
        },
      ],
    },
    {
      label: 'create_text',
      key: 'evidence-020-create',
      items: [
        { op: 'create_text', path: NEW_FILE, content: '第一行\n第二行\n', newline: 'lf', bom: false },
      ],
    },
  ];

  const approvalsBefore = countRows(dbPath, 'approvals');
  const operationsBefore = countRows(dbPath, 'operations');

  for (const stage of stages) {
    const before = await snapshotTree(workspaceRoot);
    const result = await prepareChange(
      {
        principal_id: PRINCIPAL,
        connection_id: CONNECTION,
        workspace_id: WORKSPACE,
        generation: scope.generation,
        policy_version: POLICY_VERSION,
        scope,
        now: NOW,
        input: {
          workspace_id: WORKSPACE,
          idempotency_key: stage.key,
          summary: `证据：${stage.label}`,
          items: stage.items,
        },
      },
      { ops, authority, blobs, repos },
    );
    const after = await snapshotTree(workspaceRoot);
    const problems = diffTrees(before, after);

    note(
      `a ${stage.label}`,
      `${result.change_id} state=${result.state} workspace_modified=${String(result.workspace_modified)} ` +
        `files=${String(result.files.length)} digest=${result.digest.slice(0, 16)}…`,
    );
    check(
      `a ${stage.label}：整棵工作区目录树逐字节不变（含 mtime 与目录项增删）`,
      problems.length === 0,
      problems.length === 0 ? `快照 ${String(before.size)} 项，逐项相同` : problems.join('；'),
    );
    check(
      `a ${stage.label}：返回值声明 workspace_modified=false`,
      result.workspace_modified === false,
      String(result.workspace_modified),
    );
  }

  // 运行期零写调用。
  note(
    'a 护栏调用计数',
    `resolvePath ${String(log.probes)} 次、readFileGuarded ${String(log.reads)} 次、写方法 ${String(log.writes.length)} 次`,
  );
  check(
    'a 运行期：护栏的写方法（writeFileGuarded / createFileGuarded）一次都没有被调用',
    log.writes.length === 0,
    log.writes.length === 0
      ? `读方法被调用了 ${String(log.reads)} 次，故计数不是空转`
      : log.writes.join('；'),
  );
  check(
    'a 运行期：prepare 确实读了文件（否则上面那条可能是「什么都没跑」）',
    log.reads > 0 && log.probes > 0,
    `reads=${String(log.reads)} probes=${String(log.probes)}`,
  );

  // 静态：写方法名不出现在 prepare.ts 里。
  {
    const source = await readFile(
      path.join(REPO_ROOT, 'packages', 'changes', 'src', 'prepare.ts'),
      'utf8',
    );
    const writes = ['writeFileGuarded', 'createFileGuarded'].filter((name) => source.includes(name));
    const reads = ['readFileGuarded', 'resolvePath'].filter((name) => source.includes(name));
    note(
      'a 静态扫描',
      `prepare.ts 里出现 ${reads.join('、')}；${writes.length === 0 ? '未出现任何写方法名' : `**出现了 ${writes.join('、')}**`}`,
    );
    check(
      'a 静态：prepare.ts 源码里不出现任何写方法名（结构性保证，不靠作者记得）',
      writes.length === 0 && reads.length === 2,
      writes.length === 0 ? `只出现 ${reads.join('、')}` : `出现了 ${writes.join('、')}`,
    );
  }

  // prepare 不产生批准，也不产生执行记录。
  const approvalsAfter = countRows(dbPath, 'approvals');
  const operationsAfter = countRows(dbPath, 'operations');
  note(
    'a 状态库',
    `approvals ${String(approvalsBefore)} → ${String(approvalsAfter)}；operations ${String(operationsBefore)} → ${String(operationsAfter)}`,
  );
  check(
    'a prepare 全程不产生 approvals 行、不产生 operations 行',
    approvalsAfter === approvalsBefore && operationsAfter === operationsBefore,
    `approvals=${String(approvalsAfter)} operations=${String(operationsAfter)}`,
  );

  // 新建类提案在 prepare 阶段绝不落地。
  const createdExists = await stat(absOf(workspaceRoot, NEW_FILE)).then(
    () => true,
    () => false,
  );
  check(
    'a create_text 的目标文件在 prepare 之后仍然不存在（工作区里没有它）',
    !createdExists,
    createdExists ? '**竟然被建出来了**' : '不存在',
  );
}

// ===========================================================================
// 验收 2：相同幂等请求得到同一修改集，变更内容得到不同摘要
// ===========================================================================

interface DigestHandle {
  readonly change_id: string;
  readonly digest: string;
}

async function idempotencyAndDigest(
  ops: WinfsOps,
  corpus: Corpus,
  repos: Repos,
  blobs: BlobStore,
  scope: ReadScope,
  dbPath: string,
): Promise<DigestHandle> {
  section('验收 2：相同幂等请求得到同一修改集，变更内容得到不同摘要');

  const rel = 'newline/crlf.txt';
  const bytes = corpus.bytes.get(rel) as Buffer;
  const identity = corpus.identity.get(rel) as DiskIdentity;
  const decoded = inspectBytes(bytes);
  if (decoded.kind !== 'text') throw new Error('装置错误：newline/crlf.txt 不是文本');
  const firstLine = lineText(decoded.text, decoded.lines, 1);

  const item = (newText: string): ChangeItem => ({
    op: 'edit_text',
    path: rel,
    base_sha256: sha256(bytes),
    read_token: mint(bytes, rel, identity, scope.generation),
    edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: [firstLine], new_lines: [newText] }],
  });

  const run = (key: string, newText: string): Promise<ChangePrepareData> =>
    prepareChange(
      {
        principal_id: PRINCIPAL,
        connection_id: CONNECTION,
        workspace_id: WORKSPACE,
        generation: scope.generation,
        policy_version: POLICY_VERSION,
        scope,
        now: NOW,
        input: {
          workspace_id: WORKSPACE,
          idempotency_key: key,
          summary: '证据',
          items: [item(newText)],
        },
      },
      { ops, authority, blobs, repos },
    );

  // --- b1：同键同内容 ---
  const first = await run('evidence-020-idem', '甲');
  const second = await run('evidence-020-idem', '甲');
  note(
    'b1 第一次',
    `change_id=${first.change_id} digest=${first.digest} short=${first.short_code} replay=${String(first.idempotent_replay)}`,
  );
  note(
    'b1 第二次',
    `change_id=${second.change_id} digest=${second.digest} short=${second.short_code} replay=${String(second.idempotent_replay)}`,
  );
  check(
    'b1 同一个键 + 同一份内容 → 同一个 change_id、同一个 digest',
    second.change_id === first.change_id && second.digest === first.digest,
    second.change_id === first.change_id ? '一致' : `change_id ${first.change_id} ≠ ${second.change_id}`,
  );
  check(
    'b1 第二次被标记为幂等重放（没有新建修改集）',
    first.idempotent_replay === false && second.idempotent_replay === true,
    `first=${String(first.idempotent_replay)} second=${String(second.idempotent_replay)}`,
  );
  check(
    'b1 重放返回的逐文件预览与第一次逐字段相同',
    JSON.stringify(second.files) === JSON.stringify(first.files),
    `${String(first.files.length)} 个文件`,
  );

  // --- b2：换了内容 → 另一个修改集、另一个摘要 ---
  const other = await run('evidence-020-idem-b', '乙');
  note('b2 换内容', `change_id=${other.change_id} digest=${other.digest} short=${other.short_code}`);
  check(
    'b2 内容不同 → change_id 不同、digest 不同、短核对编号不同',
    other.change_id !== first.change_id &&
      other.digest !== first.digest &&
      other.short_code !== first.short_code,
    `${first.short_code} ≠ ${other.short_code}`,
  );

  // --- b3：同键换内容 → 冲突，且既有修改集不动 ---
  {
    const err = await catchBridge(() => run('evidence-020-idem', '丙'));
    const after = repos.changes.requireById(first.change_id);
    note('b3 同键换内容', `${errLine(err)}；既有修改集 digest 仍为 ${after.digest.slice(0, 16)}…`);
    check(
      'b3 同一个键换一份内容 → IDEMPOTENCY_CONFLICT，且既有修改集一字未改',
      err.code === 'IDEMPOTENCY_CONFLICT' && after.digest === first.digest,
      errLine(err),
    );
  }

  // --- b4：摘要可由「只读落库的行」重算（独立连接）---
  //
  // 这一条是「批准绑定摘要」在跨进程、跨重启时成立的前提：执行发生在批准之后，
  // 中间隔着一次状态库往返；若摘要只能靠内存里的对象重算，那次比对就无从谈起。
  {
    const independent = openDatabase({ path: dbPath });
    try {
      const repos2 = new Repositories(independent.db);
      const record = repos2.changes.requireById(first.change_id);
      const items = repos2.changes.items(record.id);
      // 尺寸也来自落库：只给 blob 的登记信息，不给内存里的任何对象。
      const view = changeSetViewOf(record, items, (blobId) => repos2.blobs.requireById(blobId).size);
      const digestInput = {
        contract_version: record.contract_version,
        policy_version: record.policy_version,
        root_generation: record.root_generation,
        workspace_id: record.workspace_id,
        files: view.files,
      };
      const recomputed = canonicalChangeDigest(digestInput);
      const tampered = canonicalChangeDigest({
        ...digestInput,
        files: view.files.map((file, index) => (index === 0 ? { ...file, after_sha256: 'f'.repeat(64) } : file)),
      });
      note(
        'b4 第二条连接重算',
        `落库 digest=${record.digest.slice(0, 16)}… 重算=${recomputed.slice(0, 16)}… 改动一个 hash 后=${tampered.slice(0, 16)}…`,
      );
      check(
        'b4 用独立连接、仅凭落库的行重算出的摘要与落库值逐字符相同',
        recomputed === record.digest,
        recomputed === record.digest ? '逐字符相同' : '**重算结果与落库值不一致**',
      );
      check(
        'b4 摘要真的覆盖内容：把预览里一个 after_sha256 改掉，摘要就变',
        tampered !== recomputed,
        '改了之后 digest 变了（说明摘要不是只绑定 ID 之类的元数据）',
      );
      check(
        'b4 重算覆盖的字段确实来自落库：契约版本 / 策略版本 / 代次 / 工作区',
        record.contract_version === CONTRACT_VERSION &&
          record.policy_version === POLICY_VERSION &&
          record.root_generation === scope.generation &&
          record.workspace_id === WORKSPACE,
        `${record.contract_version} / ${String(record.policy_version)} / ${String(record.root_generation)} / ${record.workspace_id}`,
      );
    } finally {
      closeDatabase(independent.db);
    }
  }

  // --- b5：全语料 —— 内容不同的文件不会撞摘要 ---
  {
    const seen = new Map<string, string>();
    let built = 0;
    for (const entry of corpus.editable) {
      const fileBytes = corpus.bytes.get(entry.relPath) as Buffer;
      const fileIdentity = corpus.identity.get(entry.relPath) as DiskIdentity;
      const fileDecoded = inspectBytes(fileBytes);
      if (fileDecoded.kind !== 'text' || fileDecoded.lines.total_lines < 1) continue;
      const result = await prepareChange(
        {
          principal_id: PRINCIPAL,
          connection_id: CONNECTION,
          workspace_id: WORKSPACE,
          generation: scope.generation,
          policy_version: POLICY_VERSION,
          scope,
          now: NOW,
          input: {
            workspace_id: WORKSPACE,
            idempotency_key: `evidence-020-corpus-${String(built)}`,
            summary: `语料：${entry.relPath}`,
            items: [
              {
                op: 'edit_text',
                path: entry.relPath,
                base_sha256: sha256(fileBytes),
                read_token: mint(fileBytes, entry.relPath, fileIdentity, scope.generation),
                edits: [
                  {
                    start_line: 1,
                    end_line_exclusive: 2,
                    old_lines: [lineText(fileDecoded.text, fileDecoded.lines, 1)],
                    new_lines: [`证据脚本：${entry.relPath}`],
                  },
                ],
              },
            ],
          },
        },
        { ops, authority, blobs, repos },
      );
      const clash = seen.get(result.digest);
      if (clash !== undefined) check(`b5 ${entry.relPath} 的摘要与 ${clash} 相撞`, false, result.digest);
      seen.set(result.digest, entry.relPath);
      built += 1;
    }
    check(
      'b5 全部可编辑语料各建一份修改集，摘要两两不同',
      seen.size === built && built >= 10,
      `建了 ${String(built)} 份、得到 ${String(seen.size)} 个互不相同的摘要（下界 10）`,
    );
    check(
      'b5 短核对编号也两两不同',
      new Set([...seen.keys()].map(shortCodeOf)).size === seen.size,
      `${String(seen.size)} 个`,
    );
  }

  return { change_id: first.change_id, digest: first.digest };
}

// ===========================================================================
// 验收 3：预览显示的最终字节与待应用 blob 一致
// ===========================================================================

/**
 * 独立把「第 n 行换成 newLine」拼出来。
 *
 * 刻意不用 prepare 返回的任何中间量：这里只用磁盘上的原字节与解码索引。
 * 只比对「预览 ↔ blob」两方的话，两方同时错就是「一致」；第三方是必要的。
 */
function applyLineEditsIndependently(
  decoded: ReturnType<typeof inspectBytes>,
  lineN: number,
  newLine: string,
): Buffer | null {
  if (decoded.kind !== 'text') return null;
  const index = lineN - 1;
  const start = decoded.lines.starts[index];
  const end = decoded.lines.ends[index];
  const terminator = decoded.lines.terminators[index];
  if (start === undefined || end === undefined || terminator === undefined) return null;
  const before = decoded.text.slice(0, start);
  const after = decoded.text.slice(end + terminator.length);
  const bom = decoded.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
  return Buffer.concat([bom, Buffer.from(`${before}${newLine}${terminator}${after}`, 'utf8')]);
}

async function previewMatchesBlob(
  ops: WinfsOps,
  corpus: Corpus,
  repos: Repos,
  blobs: BlobStore,
  scope: ReadScope,
): Promise<void> {
  section('验收 3：预览显示的最终字节与待应用 blob 一致');

  let checkedFiles = 0;
  const mismatches: string[] = [];

  for (const entry of corpus.editable) {
    const originalBytes = corpus.bytes.get(entry.relPath) as Buffer;
    const identity = corpus.identity.get(entry.relPath) as DiskIdentity;
    const decoded = inspectBytes(originalBytes);
    if (decoded.kind !== 'text' || decoded.lines.total_lines < 1) continue;

    const newLine = '预览与快照必须一致的第一行';
    const result = await prepareChange(
      {
        principal_id: PRINCIPAL,
        connection_id: CONNECTION,
        workspace_id: WORKSPACE,
        generation: scope.generation,
        policy_version: POLICY_VERSION,
        scope,
        now: NOW,
        input: {
          workspace_id: WORKSPACE,
          idempotency_key: `evidence-020-blob-${String(checkedFiles)}`,
          summary: `预览核对：${entry.relPath}`,
          items: [
            {
              op: 'edit_text',
              path: entry.relPath,
              base_sha256: sha256(originalBytes),
              read_token: mint(originalBytes, entry.relPath, identity, scope.generation),
              edits: [
                {
                  start_line: 1,
                  end_line_exclusive: 2,
                  old_lines: [lineText(decoded.text, decoded.lines, 1)],
                  new_lines: [newLine],
                },
              ],
            },
          ],
        },
      },
      { ops, authority, blobs, repos },
    );

    const preview = result.files[0];
    const record = repos.changes.items(result.change_id)[0];
    if (preview === undefined || record === undefined) {
      throw new Error('装置错误：修改集里没有逐文件条目');
    }
    if (record.old_blob_id === null) throw new Error('装置错误：编辑类条目的旧 blob 不应为空');

    // 第一方：预览声明的哈希 / 尺寸。
    // 第二方：快照库里的**实际字节**。
    const newBytes = await blobs.getVerified(repos.blobs.requireById(record.new_blob_id));
    const oldBytes = await blobs.getVerified(repos.blobs.requireById(record.old_blob_id));
    // 第三方：独立拼装。
    const engine = applyLineEditsIndependently(decoded, 1, newLine);

    const previewMatchesBlobBytes =
      sha256(newBytes) === preview.after_sha256 && newBytes.length === preview.after_size;
    const blobMatchesEngine = engine !== null && sha256(engine) === sha256(newBytes);
    const oldBlobIsDisk = sha256(oldBytes) === sha256(originalBytes);
    const hashFieldsAgree =
      preview.before_sha256 === sha256(originalBytes) &&
      record.target_sha256 === preview.after_sha256;

    if (!(previewMatchesBlobBytes && blobMatchesEngine && oldBlobIsDisk && hashFieldsAgree)) {
      mismatches.push(
        `${entry.relPath}：预览↔blob ${String(previewMatchesBlobBytes)}、blob↔独立拼装 ${String(blobMatchesEngine)}、` +
          `旧 blob↔磁盘 ${String(oldBlobIsDisk)}、哈希字段 ${String(hashFieldsAgree)}`,
      );
    }
    checkedFiles += 1;
    note(
      `c ${entry.relPath}`,
      `${entry.newline}${entry.hasBom ? '+BOM' : ''} ${String(originalBytes.length)}B → ${String(newBytes.length)}B，` +
        `增量 +${String(preview.added_lines)}/−${String(preview.removed_lines)}，三方哈希一致`,
    );
  }

  check(
    'c1 全部可编辑语料：预览的 after_sha256/after_size == 快照库实际字节 == 独立拼装的产物',
    mismatches.length === 0 && checkedFiles >= 10,
    mismatches.length === 0 ? `检查了 ${String(checkedFiles)} 个文件（下界 10）` : mismatches.join('；'),
  );

  // --- c2：边界样本的换行 / BOM / 编码声明与 blob 实际字节吻合 ---
  {
    const cases: readonly {
      readonly rel: string;
      readonly line: number;
      readonly newline: string;
      readonly bom: boolean;
      readonly encoding: string;
      readonly noTrailingTerminator: boolean;
    }[] = [
      { rel: 'newline/crlf.txt', line: 1, newline: 'crlf', bom: false, encoding: 'utf-8', noTrailingTerminator: false },
      { rel: 'bom/with-bom.txt', line: 1, newline: 'lf', bom: true, encoding: 'utf-8-bom', noTrailingTerminator: false },
      // 末行没有行终止符：改的正是这一行，产物必须仍然没有终止符
      // （写入时擅自补一个换行是一种真实且常见的破坏）。
      {
        rel: 'newline/no-trailing-newline.txt',
        line: 2,
        newline: 'lf',
        bom: false,
        encoding: 'utf-8',
        noTrailingTerminator: true,
      },
    ];

    for (const testCase of cases) {
      const bytes = corpus.bytes.get(testCase.rel);
      if (bytes === undefined) {
        skip(`c2 ${testCase.rel}`, '该夹具不在本套语料里');
        continue;
      }
      const decoded = inspectBytes(bytes);
      if (decoded.kind !== 'text' || decoded.lines.total_lines < testCase.line) {
        skip(`c2 ${testCase.rel}`, '不是文本，或行数不足');
        continue;
      }
      const newLine = '边界样本改过的这一行';
      const result = await prepareChange(
        {
          principal_id: PRINCIPAL,
          connection_id: CONNECTION,
          workspace_id: WORKSPACE,
          generation: scope.generation,
          policy_version: POLICY_VERSION,
          scope,
          now: NOW,
          input: {
            workspace_id: WORKSPACE,
            idempotency_key: `evidence-020-edge-${testCase.rel.replace(/[^a-z0-9]/gi, '-')}`,
            summary: `边界：${testCase.rel}`,
            items: [
              {
                op: 'edit_text',
                path: testCase.rel,
                base_sha256: sha256(bytes),
                read_token: mint(
                  bytes,
                  testCase.rel,
                  corpus.identity.get(testCase.rel) as DiskIdentity,
                  scope.generation,
                ),
                edits: [
                  {
                    start_line: testCase.line,
                    end_line_exclusive: testCase.line + 1,
                    old_lines: [lineText(decoded.text, decoded.lines, testCase.line)],
                    new_lines: [newLine],
                  },
                ],
              },
            ],
          },
        },
        { ops, authority, blobs, repos },
      );
      const preview = result.files[0];
      const record = repos.changes.items(result.change_id)[0];
      if (preview === undefined || record === undefined) {
        throw new Error('装置错误：修改集里没有逐文件条目');
      }
      const after = await blobs.getVerified(repos.blobs.requireById(record.new_blob_id));
      const reDecoded = inspectBytes(after);
      const independent = applyLineEditsIndependently(decoded, testCase.line, newLine);
      const lastByte = after.length > 0 ? (after[after.length - 1] as number) : -1;
      const trailing = lastByte < 0 ? '' : String.fromCharCode(lastByte);
      const endsWithTerminator = trailing === '\n' || trailing === '\r';

      note(
        `c2 ${testCase.rel} 第 ${String(testCase.line)} 行`,
        `声明 ${preview.newline}/${String(preview.bom)}/${preview.encoding}；` +
          `实测 ${reDecoded.kind === 'text' ? `${reDecoded.newline}/${String(reDecoded.bom)}` : reDecoded.kind}；` +
          `末字节 ${JSON.stringify(trailing)}；与独立拼装一致 ${String(
            independent !== null && sha256(independent) === sha256(after),
          )}`,
      );
      check(
        `c2 ${testCase.rel}：预览声明的 newline/bom/encoding 与 blob 实际字节一致`,
        preview.newline === testCase.newline &&
          preview.bom === testCase.bom &&
          preview.encoding === testCase.encoding &&
          reDecoded.kind === 'text' &&
          reDecoded.newline === preview.newline &&
          reDecoded.bom === preview.bom &&
          (preview.newline === 'crlf' ? after.includes(0x0d) : !after.includes(0x0d)) &&
          independent !== null &&
          sha256(independent) === sha256(after),
        `${preview.newline}/${String(preview.bom)}/${preview.encoding}`,
      );
      check(
        `c2 ${testCase.rel}：末尾行终止符形态保持不变（${testCase.noTrailingTerminator ? '仍然没有' : '仍然有'}）`,
        endsWithTerminator !== testCase.noTrailingTerminator,
        `末字节 ${JSON.stringify(trailing)}`,
      );
    }
  }

  // --- c3：增量行数落库后从库里读回来是同一个数（迁移 v4 的存在理由）---
  {
    const listed = repos.changes.list({ limit: 1 })[0];
    if (listed === undefined) throw new Error('装置错误：状态库里没有任何修改集');
    const sample = repos.changes.items(listed.id)[0];
    if (sample === undefined) throw new Error('装置错误：修改集里没有条目');
    const rebuilt = changeSetViewOf(listed, [sample], (blobId) => repos.blobs.requireById(blobId).size);
    const rebuiltFile = rebuilt.files[0];
    if (rebuiltFile === undefined) throw new Error('装置错误：重建的预览里没有文件');
    note(
      'c3 落库的增量行数',
      `${sample.canonical_path} +${String(sample.added_lines)}/−${String(sample.removed_lines)}`,
    );
    check(
      'c3 预览里的增量行数可以直接从 change_items 的列读回（不需要重算）',
      rebuiltFile.added_lines === sample.added_lines && rebuiltFile.removed_lines === sample.removed_lines,
      `+${String(rebuiltFile.added_lines)}/−${String(rebuiltFile.removed_lines)}`,
    );
  }

  // --- c4：新建文件的预览：before 侧为空 ---
  {
    const result = await prepareChange(
      {
        principal_id: PRINCIPAL,
        connection_id: CONNECTION,
        workspace_id: WORKSPACE,
        generation: scope.generation,
        policy_version: POLICY_VERSION,
        scope,
        now: NOW,
        input: {
          workspace_id: WORKSPACE,
          idempotency_key: 'evidence-020-create-preview',
          summary: '新建文件预览',
          items: [
            { op: 'create_text', path: '证据-新建2.txt', content: '甲\n乙\n丙\n', newline: 'crlf', bom: true },
          ],
        },
      },
      { ops, authority, blobs, repos },
    );
    const preview = result.files[0];
    const record = repos.changes.items(result.change_id)[0];
    if (preview === undefined || record === undefined) {
      throw new Error('装置错误：修改集里没有逐文件条目');
    }
    const bytes = await blobs.getVerified(repos.blobs.requireById(record.new_blob_id));
    note(
      'c4 新建',
      `before=${String(preview.before_sha256)} after=${preview.after_sha256.slice(0, 16)}… 头部 ${JSON.stringify([...bytes.subarray(0, 3)])}`,
    );
    check(
      'c4 create_text：before 侧为空、after 侧逐字节等于提交内容（含 BOM 与 CRLF）',
      preview.before_sha256 === null &&
        preview.before_size === 0 &&
        record.old_blob_id === null &&
        sha256(bytes) === preview.after_sha256 &&
        bytes.toString('utf8') === '﻿甲\r\n乙\r\n丙\r\n',
      `${String(bytes.length)}B`,
    );
  }
}

// ===========================================================================
// 风险提示与拒绝面
// ===========================================================================

async function risksAndRejections(
  ops: WinfsOps,
  corpus: Corpus,
  repos: Repos,
  blobs: BlobStore,
  scope: ReadScope,
  dbPath: string,
): Promise<void> {
  section('风险提示（由落库事实推导）');

  {
    const lfRel = 'newline/lf.txt';
    const lfBytes = corpus.bytes.get(lfRel) as Buffer;
    const result = await prepareChange(
      {
        principal_id: PRINCIPAL,
        connection_id: CONNECTION,
        workspace_id: WORKSPACE,
        generation: scope.generation,
        policy_version: POLICY_VERSION,
        scope,
        now: NOW,
        input: {
          workspace_id: WORKSPACE,
          idempotency_key: 'evidence-020-risks',
          summary: '风险提示',
          items: [
            {
              op: 'replace_text',
              path: lfRel,
              base_sha256: sha256(lfBytes),
              read_token: mint(lfBytes, lfRel, corpus.identity.get(lfRel) as DiskIdentity, scope.generation),
              content: '整份替换\n',
            },
            {
              op: 'create_text',
              path: '证据-新建3.ps1',
              content: 'Write-Host 甲\n',
              newline: 'lf',
              bom: false,
            },
          ],
        },
      },
      { ops, authority, blobs, repos },
    );
    for (const risk of result.risks) {
      console.log(`      [${risk.level}] ${risk.code} — ${risk.message}`);
    }
    const codes = result.risks.map((r) => r.code);
    check(
      'd1 整文件替换 + 新建脚本 + 多文件：四条风险提示都出现',
      codes.includes('WHOLE_FILE_REPLACED') &&
        codes.includes('NEW_FILE_CREATED') &&
        codes.includes('EXECUTABLE_OR_SCRIPT') &&
        codes.includes('MULTIPLE_FILES'),
      codes.join('、'),
    );
    const items = repos.changes.items(result.change_id);
    check(
      'd1 风险由落库事实推导、不落库：再推导一次结果相同',
      JSON.stringify(deriveRisks(items)) === JSON.stringify(result.risks),
      `${String(deriveRisks(items).length)} 条`,
    );
  }

  {
    const denied = corpus.manifest.files
      .filter((f) => classifyFile(f.relPath).kind === 'hard_deny')
      .map((f) => f.relPath);
    note('d2 硬拒绝语料', `${denied.join('、')}（含 config/.env.example：\`.env.example\` 不被自动豁免）`);
    check(
      'd2 被硬拒绝的路径一个都没有进入可编辑语料：修改集这一层拿不到它们的票据',
      denied.length > 0 && !denied.some((p) => corpus.editable.some((e) => e.relPath === p)),
      `硬拒绝 ${String(denied.length)} 个、可编辑 ${String(corpus.editable.length)} 个，两者不相交`,
    );
  }

  section('拒绝面：建立修改集时的当场复核');

  const rel = 'newline/lf.txt';
  const bytes = corpus.bytes.get(rel) as Buffer;
  const identity = corpus.identity.get(rel) as DiskIdentity;
  const decoded = inspectBytes(bytes);
  if (decoded.kind !== 'text') throw new Error('装置错误：newline/lf.txt 不是文本');
  const line1 = lineText(decoded.text, decoded.lines, 1);

  const attempt = (items: readonly ChangeItem[], key: string): Promise<ChangePrepareData> =>
    prepareChange(
      {
        principal_id: PRINCIPAL,
        connection_id: CONNECTION,
        workspace_id: WORKSPACE,
        generation: scope.generation,
        policy_version: POLICY_VERSION,
        scope,
        now: NOW,
        input: { workspace_id: WORKSPACE, idempotency_key: key, summary: '拒绝面', items },
      },
      { ops, authority, blobs, repos },
    );

  const goodItem = (over: Partial<ReadTicketFacts> = {}, newText = '甲'): ChangeItem => ({
    op: 'edit_text',
    path: rel,
    base_sha256: sha256(bytes),
    read_token: mint(bytes, rel, identity, scope.generation, over),
    edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: [line1], new_lines: [newText] }],
  });

  const cases: readonly {
    readonly label: string;
    readonly item: ChangeItem;
    readonly code: string;
    readonly reason: string;
  }[] = [
    { label: 'e1 票据过期', item: goodItem(), code: 'READ_TOKEN_STALE', reason: 'TICKET_EXPIRED' },
    {
      label: 'e2 票据属于别的连接',
      item: goodItem({ connection_id: 'conn-other' }),
      code: 'READ_TOKEN_STALE',
      reason: 'TICKET_CROSS_CONNECTION',
    },
    {
      label: 'e3 票据属于别的代次（撤权后不继承）',
      item: goodItem({ generation: scope.generation + 1 }),
      code: 'READ_TOKEN_STALE',
      reason: 'TICKET_GENERATION_MISMATCH',
    },
    {
      label: 'e4 票据属于别的工作区',
      item: goodItem({ workspace_id: 'ws-other' }),
      code: 'READ_TOKEN_STALE',
      reason: 'TICKET_CROSS_WORKSPACE',
    },
    {
      label: 'e5 票据指向别的路径',
      item: goodItem({ canonical_path: 'newline/other.txt' }),
      code: 'READ_TOKEN_STALE',
      reason: 'TICKET_PATH_MISMATCH',
    },
    {
      label: 'e6 票据声称不可编辑（出站层已判定）',
      item: goodItem({ editable: false, editable_blockers: ['夹具：不可编辑'] }),
      code: 'READ_TOKEN_STALE',
      reason: 'TICKET_NOT_EDITABLE',
    },
    {
      label: 'e7 提案声明的基线与票据记录不一致',
      item: {
        op: 'edit_text',
        path: rel,
        base_sha256: 'f'.repeat(64),
        read_token: mint(bytes, rel, identity, scope.generation),
        edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: [line1], new_lines: ['甲'] }],
      },
      code: 'READ_TOKEN_STALE',
      reason: 'TICKET_BASE_MISMATCH',
    },
  ];

  for (const testCase of cases) {
    // e1 用一张真的过期的票；其余用其余字段全对、只改一项的真票。
    const item = testCase.label.startsWith('e1 ')
      ? {
          ...testCase.item,
          read_token: mint(
            bytes,
            rel,
            identity,
            scope.generation,
            {},
            NOW - LIMITS.READ_TOKEN_TTL_MS - 1000,
          ),
        }
      : testCase.item;
    const before = countRows(dbPath, 'changesets');
    const err = await catchBridge(() => attempt([item], `evidence-020-reject-${testCase.label.slice(0, 2)}`));
    const after = countRows(dbPath, 'changesets');
    check(
      `${testCase.label} → ${testCase.code}/${testCase.reason}，且不留下修改集`,
      err.code === testCase.code && err.details?.['reason'] === testCase.reason && after === before,
      `${errLine(err)}；修改集 ${String(before)} → ${String(after)}`,
    );
  }

  // 磁盘在读取之后被换掉：尺寸 / 内容 / 身份三个方向各一条。
  {
    const swappedRel = '证据-被换掉.txt';
    const swappedAbs = absOf(scope.root_path, swappedRel);
    await writeFile(swappedAbs, 'A\nB\nC\n', 'utf8');
    const originalBytes = await readFile(swappedAbs);
    const originalId = await diskIdentity(ops, swappedAbs);
    const token = mint(originalBytes, swappedRel, originalId, scope.generation);
    const swapItem = (): ChangeItem => ({
      op: 'edit_text',
      path: swappedRel,
      base_sha256: sha256(originalBytes),
      read_token: token,
      edits: [{ start_line: 2, end_line_exclusive: 3, old_lines: ['B'], new_lines: ['B 改'] }],
    });

    // 尺寸变了。
    await writeFile(swappedAbs, 'A\nB\nC\nD\n', 'utf8');
    const grown = await catchBridge(() => attempt([swapItem()], 'evidence-020-swapped-size'));
    check(
      'e8 读取之后文件被追加：READ_TOKEN_STALE/TICKET_SIZE_MISMATCH（不是「按现在的字节硬改」）',
      grown.code === 'READ_TOKEN_STALE' && grown.details?.['reason'] === 'TICKET_SIZE_MISMATCH',
      errLine(grown),
    );

    // 尺寸没变、内容变了。
    await writeFile(swappedAbs, 'X\nY\nZ\n', 'utf8');
    const swapped = await catchBridge(() => attempt([swapItem()], 'evidence-020-swapped-content'));
    check(
      'e9 读取之后同尺寸原地改写：READ_TOKEN_STALE/TICKET_CONTENT_MISMATCH（尺寸判据抓不到的，内容判据抓得到）',
      swapped.code === 'READ_TOKEN_STALE' && swapped.details?.['reason'] === 'TICKET_CONTENT_MISMATCH',
      errLine(swapped),
    );

    // 身份变了（删掉重建）：内容与尺寸都还原，只有 file_id 变了。
    await rm(swappedAbs, { force: true });
    await writeFile(swappedAbs, 'A\nB\nC\n', 'utf8');
    const recreatedId = await diskIdentity(ops, swappedAbs);
    const replaced = await catchBridge(() => attempt([swapItem()], 'evidence-020-swapped-identity'));
    check(
      'e10 读取之后文件被删掉重建：READ_TOKEN_STALE/TICKET_IDENTITY_MISMATCH（尺寸与内容都还原了，只有身份能抓住）',
      recreatedId.file_id !== originalId.file_id &&
        replaced.code === 'READ_TOKEN_STALE' &&
        replaced.details?.['reason'] === 'TICKET_IDENTITY_MISMATCH',
      `file_id ${originalId.file_id} → ${recreatedId.file_id}；${errLine(replaced)}`,
    );
    await rm(swappedAbs, { force: true });
  }

  // create_text 的三个落点判据。
  {
    const fileHit = await catchBridge(() =>
      attempt([{ op: 'create_text', path: rel, content: 'x\n', newline: 'lf', bom: false }], 'evidence-020-create-file'),
    );
    check(
      'e11 create_text 撞上已存在的文件：FILE_VERSION_CONFLICT/TARGET_EXISTS（绝不覆盖）',
      fileHit.code === 'FILE_VERSION_CONFLICT' && fileHit.details?.['reason'] === 'TARGET_EXISTS',
      errLine(fileHit),
    );
    const dirHit = await catchBridge(() =>
      attempt([{ op: 'create_text', path: 'newline', content: 'x\n', newline: 'lf', bom: false }], 'evidence-020-create-dir'),
    );
    check(
      'e12 create_text 撞上已存在的目录：FILE_VERSION_CONFLICT/TARGET_EXISTS',
      dirHit.code === 'FILE_VERSION_CONFLICT' && dirHit.details?.['reason'] === 'TARGET_EXISTS',
      errLine(dirHit),
    );
    const noParent = await catchBridge(() =>
      attempt(
        [{ op: 'create_text', path: '不存在的目录/x.txt', content: 'x\n', newline: 'lf', bom: false }],
        'evidence-020-create-noparent',
      ),
    );
    check(
      'e13 create_text 的父目录不存在：NOT_FOUND（V1 只支持在已存在的父目录里新建）',
      noParent.code === 'NOT_FOUND',
      errLine(noParent),
    );
  }

  // 同一份提案里对同一个文件两次操作。
  {
    const twice = await catchBridge(() => attempt([goodItem({}, '甲'), goodItem({}, '乙')], 'evidence-020-dup'));
    check(
      'e14 同一个文件在一次修改集里出现两次：INVALID_ARGUMENT/DUPLICATE_TARGET_PATH',
      twice.code === 'INVALID_ARGUMENT' && twice.details?.['reason'] === 'DUPLICATE_TARGET_PATH',
      errLine(twice),
    );
  }

  // 路径形状：`..` 不得越出工作区。
  {
    const traversal = await catchBridge(() =>
      attempt(
        [
          {
            op: 'create_text',
            path: '../越出工作区.txt',
            content: 'x\n',
            newline: 'lf',
            bom: false,
          },
        ],
        'evidence-020-traversal',
      ),
    );
    check(
      'e15 相对路径里的 `..`：INVALID_ARGUMENT/CHANGE_PATH_INVALID，且 path_reason=PARENT_REF',
      traversal.code === 'INVALID_ARGUMENT' &&
        traversal.details?.['reason'] === 'CHANGE_PATH_INVALID' &&
        traversal.details?.['path_reason'] === 'PARENT_REF',
      `${errLine(traversal)} path_reason=${String(traversal.details?.['path_reason'])}`,
    );
  }

  // 上限：改小上限，边界跟着动。
  {
    const tight = await catchBridge(() =>
      prepareChange(
        {
          principal_id: PRINCIPAL,
          connection_id: CONNECTION,
          workspace_id: WORKSPACE,
          generation: scope.generation,
          policy_version: POLICY_VERSION,
          scope,
          now: NOW,
          input: {
            workspace_id: WORKSPACE,
            idempotency_key: 'evidence-020-limit',
            summary: '上限',
            items: [goodItem()],
          },
        },
        { ops, authority, blobs, repos, limits: { max_change_total_bytes: 1 } },
      ),
    );
    check(
      'e16 修改集总字节上限：SIZE_LIMIT_EXCEEDED/CHANGE_TOTAL_TOO_LARGE（上限可调，边界跟着动）',
      tight.code === 'SIZE_LIMIT_EXCEEDED' && tight.details?.['reason'] === 'CHANGE_TOTAL_TOO_LARGE',
      errLine(tight),
    );
  }

  // 幂等键不因校验失败而被占用：改对参数后同一个键仍然可用。
  {
    const key = 'evidence-020-key-not-burned';
    const bad = await catchBridge(() =>
      attempt(
        [
          {
            op: 'edit_text',
            path: rel,
            base_sha256: sha256(bytes),
            read_token: mint(bytes, rel, identity, scope.generation),
            edits: [
              {
                start_line: decoded.lines.total_lines + 5,
                end_line_exclusive: decoded.lines.total_lines + 6,
                old_lines: ['不存在'],
                new_lines: ['x'],
              },
            ],
          },
        ],
        key,
      ),
    );
    const okResult = await attempt([goodItem({}, '甲')], key);
    note('e17 越界编辑', errLine(bad));
    check(
      'e17 参数校验失败不占用幂等键：改对之后同一个键仍然建出了修改集',
      bad.code === 'READ_TOKEN_STALE' &&
        bad.details?.['reason'] === 'EDIT_RANGE_NOT_READ' &&
        okResult.state === 'PENDING_APPROVAL',
      `first=${errLine(bad)} second=${okResult.change_id}`,
    );
  }

  // 旁路：模型没有任何办法在建立修改集这一步制造批准。
  {
    const withHints = {
      workspace_id: WORKSPACE,
      idempotency_key: 'evidence-020-approved-hint',
      summary: '试图自我批准',
      approved: true,
      user_id: PRINCIPAL,
      conversation_label: '某个会话',
      items: [goodItem({}, '无视 approved')],
    } as unknown as {
      readonly workspace_id: string;
      readonly idempotency_key: string;
      readonly summary: string;
      readonly items: readonly ChangeItem[];
    };
    const result = await prepareChange(
      {
        principal_id: PRINCIPAL,
        connection_id: CONNECTION,
        workspace_id: WORKSPACE,
        generation: scope.generation,
        policy_version: POLICY_VERSION,
        scope,
        now: NOW,
        input: withHints,
      },
      { ops, authority, blobs, repos },
    );
    const active = repos.approvals.findActive(result.change_id);
    note(
      'e18 approved:true 之类的额外字段',
      `state=${result.state} approval_required=${String(result.approval_required)} 活动批准=${active === null ? '无' : active.id}`,
    );
    check(
      'e18 输入里的 approved/user_id/conversation_label 不产生任何批准：初态恒为 PENDING_APPROVAL',
      result.state === 'PENDING_APPROVAL' && result.approval_required === true && active === null,
      `${result.state}，活动批准记录 ${active === null ? '0' : '1'} 条`,
    );
  }

  // 不可变：落库之后再用**另一条连接**改内容，仍被触发器拒绝。
  {
    const listed = repos.changes.list({ limit: 1 })[0];
    if (listed === undefined) throw new Error('装置错误：状态库里没有任何修改集');
    const itemMutated = runSql(dbPath, 'UPDATE change_items SET target_sha256 = ? WHERE change_id = ?', [
      'f'.repeat(64),
      listed.id,
    ]);
    const setMutated = runSql(dbPath, 'UPDATE changesets SET digest = ? WHERE id = ?', [
      'f'.repeat(64),
      listed.id,
    ]);
    const stateStill = repos.changes.requireById(listed.id);
    check(
      'e19 修改集一经建立内容不可变：另一条连接改 change_items / changesets 都被触发器拒绝',
      !itemMutated && !setMutated,
      `change_items ${itemMutated ? '**改动了**' : '拒绝'}；changesets ${setMutated ? '**改动了**' : '拒绝'}`,
    );
    check(
      'e19 被拒绝之后落库摘要仍然不变',
      stateStill.digest === listed.digest,
      `${stateStill.digest.slice(0, 16)}…`,
    );
  }
}

// ===========================================================================
// 主流程
// ===========================================================================

async function main(): Promise<void> {
  if (!WINDOWS_ONLY) {
    skip('全部验收项', '当前平台不是 Windows；文件身份与硬链接语义都无法在此成立');
    console.log('\n0 PASSED');
    process.exitCode = 0;
    return;
  }

  ensureFixtures();
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-evidence-020-'));
  const workspaceRoot = path.join(sandbox, 'workspace');
  const dbPath = path.join(sandbox, 'state.sqlite');
  const backend = new PowerShellWinfsBackend();
  let handle: DigestHandle | null = null;

  try {
    const capability = await backend.capability();
    note(
      '护栏能力',
      `available=${String(capability.available)} backend=${capability.backend} ` +
        `supports_file_identity=${String(capability.supports_file_identity)} ` +
        `crash_atomic_replace=${String(capability.crash_atomic_replace)} ` +
        `cross_file_transaction=${String(capability.cross_file_transaction)}`,
    );
    if (!capability.available || !capability.supports_file_identity) {
      check('护栏可用且能取到文件身份', false, '没有身份就无法证明「读到的还是不是同一个文件」');
      return;
    }

    // 真实夹具的目录树快照：整场跑完之后必须一字未改（本脚本只在副本上作业）。
    const fixtureBefore = await snapshotTree(TESTREPO_DIR);
    note('夹具原树', `${TESTREPO_DIR}（只读；快照 ${String(fixtureBefore.size)} 项）`);

    await cp(TESTREPO_DIR, workspaceRoot, { recursive: true });
    const log: OpsLog = { writes: [], reads: 0, probes: 0 };
    const ops = recordingOps(backend, log);
    note(
      '工作区',
      `${workspaceRoot}（夹具的副本；副本的 file_id 与原树不同，因此票据身份必须取自实际被读的对象）`,
    );

    const opened = openDatabase({ path: dbPath });
    note(
      '状态库',
      `schema_version=${String(opened.schema_version)} 迁移 ${opened.applied_migrations.join(',')}；路径 ${dbPath}`,
    );
    const repos = new Repositories(opened.db);
    repos.connections.create({
      id: CONNECTION,
      principal_kind: 'model_surface',
      principal_id: PRINCIPAL,
      alias: '证据脚本连接',
      enabled: true,
    });
    const rootIdentity = await diskIdentity(ops, workspaceRoot);
    const workspaceRecord = repos.workspaces.create({
      id: WORKSPACE,
      alias: '证据工作区（夹具副本）',
      kind: 'directory',
      canonical_root: workspaceRoot,
      volume_id: rootIdentity.volume_id,
      root_file_id: rootIdentity.file_id,
      policy_version: POLICY_VERSION,
      mode: 'read_propose_apply_with_local_approval',
    });
    const scope: ReadScope = {
      workspace_id: WORKSPACE,
      kind: 'directory',
      mode: 'read_propose_apply_with_local_approval',
      generation: workspaceRecord.generation,
      root_path: workspaceRoot,
      root_volume_id: rootIdentity.volume_id,
      root_file_id: rootIdentity.file_id,
    };
    note(
      '工作区根身份',
      `${rootIdentity.volume_id}:${rootIdentity.file_id} generation=${String(workspaceRecord.generation)} ` +
        '（取自护栏 statVolume；不是路径字符串比较）',
    );

    const corpus = await loadCorpus(ops, workspaceRoot);
    note(
      '语料',
      `夹具 ${String(corpus.manifest.files.length)} 个；可编辑且换行可写 ${String(corpus.editable.length)} 个：` +
        corpus.editable.map((e) => e.relPath).join('、'),
    );

    // 装置前提：同一条路径，statVolume（绝对路径）与 readFileGuarded（根 + 相对路径）
    // 必须报出同一个文件身份。这条不成立，后面所有票据都是对着一个查不到的对象铸的。
    {
      const probeRel = corpus.editable[0]?.relPath;
      if (probeRel === undefined) throw new Error('装置错误：可编辑语料为空');
      const viaStat = await diskIdentity(ops, absOf(workspaceRoot, probeRel));
      const viaRead = await ops.readFileGuarded({
        ...refOf(scope, probeRel),
      });
      const readIdentity = isWinfsError(viaRead) ? null : viaRead.identity;
      check(
        '装置前提：同一条路径经 statVolume（绝对路径）与 readFileGuarded（根 + 相对路径）报出的身份一致',
        readIdentity !== null &&
          readIdentity.volume_id === viaStat.volume_id &&
          readIdentity.file_id === viaStat.file_id,
        isWinfsError(viaRead)
          ? `读取失败：${viaRead.code} ${viaRead.message}`
          : readIdentity === null
            ? '读取失败'
            : `${viaStat.volume_id}:${viaStat.file_id}`,
      );
    }

    const blobs = new BlobStore({
      objectsRoot: path.join(sandbox, 'objects'),
      registry: repos.blobs,
    });
    const limits: PrepareLimits = {
      max_editable_file_bytes: LIMITS.MAX_EDITABLE_FILE_BYTES,
      max_change_files: LIMITS.MAX_CHANGE_FILES,
      max_change_total_bytes: LIMITS.MAX_CHANGE_TOTAL_BYTES,
      change_ttl_ms: LIMITS.CHANGE_TTL_MS,
    };
    note(
      'LIMITS（与 DEFAULT_PREPARE_LIMITS 同源）',
      `MAX_EDITABLE_FILE_BYTES=${String(limits.max_editable_file_bytes)} ` +
        `MAX_CHANGE_FILES=${String(limits.max_change_files)} ` +
        `MAX_CHANGE_TOTAL_BYTES=${String(limits.max_change_total_bytes)} ` +
        `CHANGE_TTL_MS=${String(limits.change_ttl_ms)}`,
    );

    await guarded('验收 1', () =>
      prepareDoesNotWrite(ops, log, workspaceRoot, corpus, repos, blobs, scope, dbPath),
    );
    handle = await guardedValue('验收 2', () =>
      idempotencyAndDigest(ops, corpus, repos, blobs, scope, dbPath),
    );
    await guarded('验收 3', () => previewMatchesBlob(ops, corpus, repos, blobs, scope));
    await guarded('风险与拒绝面', () => risksAndRejections(ops, corpus, repos, blobs, scope, dbPath));

    // --- 收尾 1：真正的关库 → 重开 → 重算摘要 ---
    //
    // 上面 b4 用的是「第二条连接」；这里是「关掉再打开」：进程退出再进来
    // 能拿到的只有磁盘上的字节，因此这一条才是跨重启的那一条。
    closeDatabase(opened.db);
    if (handle === null) {
      check('收尾：关闭并重开状态库后摘要仍可从落库的行重算', false, '验收 2 段没有产出可比对的修改集');
    } else {
      const captured: DigestHandle = handle;
      const reopened = openDatabase({ path: dbPath });
      try {
        const repos2 = new Repositories(reopened.db);
        const record = repos2.changes.requireById(captured.change_id);
        const view = changeSetViewOf(record, repos2.changes.items(record.id), (blobId) =>
          repos2.blobs.requireById(blobId).size,
        );
        const recomputed = canonicalChangeDigest({
          contract_version: record.contract_version,
          policy_version: record.policy_version,
          root_generation: record.root_generation,
          workspace_id: record.workspace_id,
          files: view.files,
        });
        check(
          '收尾：关闭并重开状态库后，仅凭落库的行重算出的摘要与建立时逐字符相同',
          recomputed === captured.digest && record.digest === captured.digest,
          `${captured.digest.slice(0, 16)}… == ${recomputed.slice(0, 16)}…`,
        );
      } finally {
        closeDatabase(reopened.db);
      }
    }

    // --- 收尾 2：真实夹具目录树全程只被读过 ---
    const fixtureAfter = await snapshotTree(TESTREPO_DIR);
    const fixtureProblems = diffTrees(fixtureBefore, fixtureAfter);
    check(
      '收尾：真实夹具目录树（非副本）全程未被改动',
      fixtureProblems.length === 0,
      fixtureProblems.length === 0
        ? `快照 ${String(fixtureBefore.size)} 项，逐项相同`
        : fixtureProblems.join('；'),
    );

    // --- 收尾 3：整场跑完，护栏的写方法仍然一次都没被调用 ---
    check(
      '收尾：整场跑完，护栏写方法累计调用次数仍为 0',
      log.writes.length === 0,
      log.writes.length === 0
        ? `读方法累计 ${String(log.reads)} 次、路径探针 ${String(log.probes)} 次`
        : log.writes.join('；'),
    );
  } finally {
    await backend.dispose().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }

  section('未执行项（不得记为通过）');
  skip(
    '在真实工作区（非夹具副本）上执行任何一次写入',
    'G2 未通过（LWB-002 BLOCKED）；P3 门禁：可在契约冻结前提下继续实现，但不得在真实仓库上联调（docs/evidence/g2-read.md）',
  );
  skip(
    '经由 daemon → 执行器 → 护栏的真实落盘',
    'LWB-021/022 未实现：本任务的交付物不包含任何写入代码路径',
  );
  skip('审批后才应用、一次性、带过期', 'LWB-021 未实现；本任务只证明「建立修改集不产生批准」');
  skip(
    '五条 change_* 工具端到端可用',
    '未实现：它们当前按 LWB-018 步骤 4 返回 NOT_IMPLEMENTED，本任务没有改动工具面',
  );
  skip(
    '名称不同但指向同一物理文件的两个条目被 prepare 的身份层拒绝',
    '除非真建硬链接，否则造不出「两个不同路径、同一 file_id」；该判据的单元级证据在 tests/unit/changes-prepare.test.ts，真实硬链接证据在 docs/evidence/lwb-019',
  );
  skip(
    '硬链接文件（link_count > 1）在 prepare 阶段被拒',
    '夹具语料里没有硬链接，且副本无法自然产生；该拒绝的单元级证据在 tests/unit/changes-prepare.test.ts',
  );
  skip(
    '超过 MAX_EDITABLE_FILE_BYTES 的文件在 prepare 阶段被拒的 Windows 级证据',
    '夹具里 large/big.txt 已在清单层标为不可编辑，走不到 prepare；该拒绝的单元级证据在 tests/unit/changes-prepare.test.ts',
  );
  skip(
    '崩溃原子替换 / 跨文件事务',
    'I11 与护栏自检均报告 crash_atomic_replace=false、cross_file_transaction=false；本任务不负责落盘',
  );
  skip(
    '在真实 ChatGPT 网页端提出一次编辑',
    'LWB-002 BLOCKED（真实账号与 Secure MCP Tunnel 凭证）；MCP Inspector 的成功不能替代它',
  );

  console.log(
    `\n${failures === 0 ? 'ALL PASS' : `${String(failures)} FAILED`} — ${String(passes)} PASSED / ${String(failures)} FAILED / ${String(skips)} NOT_RUN`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
