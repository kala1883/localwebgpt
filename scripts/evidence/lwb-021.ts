/**
 * LWB-021 可复现证据采集：本地批准与拒绝。
 *
 * 三条验收标准在这里各有一段，而它们的共同形状是**否定式** ——
 * 「篡改后失效」「模型只得到 APPROVAL_REQUIRED」「重复点击不再产生执行」。
 * 证明否定命题的唯一可靠方式是**真的发起那个动作，再数落库的行数**，
 * 因此本脚本用的全是真东西：
 *
 *  - **真实修改集**：由 `prepareChange` 在夹具副本上产出（LWB-020 那条路径）。
 *    这一点很要紧：摘要若由脚本自己算好再插进去，「重算等于落库值」
 *    就退化成「同一个函数调用两次当然相等」。走 prepare 之后，摘要是
 *    **生产路径**算出来的，而批准侧的重算是**独立**走的另一遍。
 *  - **真实状态库**：落在临时目录里的 SQLite 文件，触发器与部分唯一索引
 *    全在库里；计数一律经由**另一条连接**读，不借进程内的对象。
 *  - **真实控制面**：`createControlPlane` + 回环监听 + 真实会话、CSRF、
 *    一次性 nonce，用 `fetch` 说 HTTP（诚实控制台会说的那种话）。
 *  - **真实护栏**：`PowerShellWinfsBackend` 取真实 NTFS 身份（prepare 需要）。
 *
 * 篡改那一段用的是**第三个**修改集（γ）：α 与 β 要留给后面的段落，
 * 而「改动过的记录」按定义是不可还原的 —— 那正是不可变性的意思。
 *
 * 用法：node --import tsx scripts/evidence/lwb-021.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件证明不了的事（见末尾「未执行项」）：**批准从未被消费，也没有任何
 * 一次写入落盘** —— 执行协调器（LWB-026）还不存在，本任务的交付物
 * 只到「排队」为止。真实 ChatGPT 网页端链路仍然 BLOCKED（LWB-002）。
 */

import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { BlobStore } from '@lwb/blob-store';
import {
  BridgeError,
  CONTROL_COOKIE_NAME,
  CONTROL_CSRF_HEADER,
  CONTROL_PLANE_ROUTES,
  LIMITS,
  TOOL_INPUT_SCHEMAS,
  isToolName,
} from '@lwb/contracts';
import type { ChangeItem, ChangePrepareData, ToolCatalogResult } from '@lwb/contracts';
import { createReadTicketAuthority, inspectBytes, lineText } from '@lwb/files';
import type { ReadScope, ReadTicketAuthority, ReadTicketFacts } from '@lwb/files';
import { hasCapability, NEVER_GRANTED_TO_MODEL, OperationRegistry } from '@lwb/ipc';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import { classifyFile, decide } from '@lwb/policy';
import type { ApprovalView as PolicyApprovalView, PolicyRequest } from '@lwb/policy';
import { PowerShellWinfsBackend, isWinfsError } from '@lwb/winfs';
import type { WinfsOps } from '@lwb/winfs';
import { canonicalChangeDigest, prepareChange, shortCodeOf } from '@lwb/changes';
import type { PrepareLimits } from '@lwb/changes';
import { APPLY_ENTRY_STATES, evaluateApplyGate, reloadChangeSet } from '@lwb/approvals';

import {
  ControlSessionStore,
  createControlPlane,
  registerApprovalOperations,
  registerConnectionOperations,
  registerWorkspaceOperations,
  registerWorkspaceAccessOperations,
  type ControlPlane,
} from '../../apps/daemon/src/control/index.ts';
import { resolveSurface } from '../../apps/mcp-adapter/src/surface.ts';
import type { WorkspaceRegistry } from '@lwb/workspaces';

import { TESTREPO_DIR, ensureFixtures, loadManifest } from '../../tests/fixtures/index.ts';
import type { FixtureFileEntry, FixtureManifest } from '../../tests/fixtures/index.ts';

// ---------------------------------------------------------------------------
// 脚手架（与 lwb-020.ts 同一套）
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

/** 把抛出的错误压成一行：码 + 理由标签。 */
function errLine(cause: unknown): string {
  if (cause instanceof BridgeError) {
    return `${cause.code}/${String(cause.details?.['reason'] ?? '(无 reason)')}`;
  }
  return `(不是 BridgeError) ${String(cause)}`;
}

async function catchBridge(fn: () => Promise<unknown> | unknown): Promise<BridgeError> {
  try {
    await fn();
  } catch (cause) {
    if (cause instanceof BridgeError) return cause;
    throw cause;
  }
  throw new Error('装置错误：期望抛出 BridgeError，实际成功返回');
}

const WINDOWS_ONLY = process.platform === 'win32';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// 真实控制面：用 fetch 说 HTTP（诚实控制台会用的接口）
// ---------------------------------------------------------------------------

interface ConsoleSession {
  readonly cookie: string;
  readonly csrf: string;
}

interface HttpOutcome {
  readonly status: number;
  /** 响应体里的 `result`：控制面把处理器返回值放在这一层（`{ok:true,result}`）。 */
  readonly result: Record<string, unknown>;
  /** 完整响应体。错误对象在这一层，因此错误码要从这里读。 */
  readonly envelope: Record<string, unknown>;
}

async function post(
  port: number,
  session: ConsoleSession | null,
  pathname: string,
  payload: Record<string, unknown>,
): Promise<HttpOutcome> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // 显式补上 `Origin`：Node 的 `fetch` **不发**这个头，而「不带 Origin 的
    // 变更请求一律拒绝」正是控制面的一道门（`origin.ts` 的 ORIGIN_MISSING）。
    // 真实控制台是浏览器，浏览器同源请求一定带它。漏掉它，采集到的
    // 就不是「控制台说的话」，而是一个任何浏览器都不会发出的报文。
    Origin: `http://127.0.0.1:${String(port)}`,
  };
  if (session !== null) {
    headers['Cookie'] = session.cookie;
    headers[CONTROL_CSRF_HEADER] = session.csrf;
  }
  const response = await fetch(`http://127.0.0.1:${String(port)}${pathname}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(text) as Record<string, unknown>;
  } catch {
    envelope = { _raw: text.slice(0, 200) };
  }
  const result = envelope['result'];
  return {
    status: response.status,
    result: typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {},
    envelope,
  };
}

function errorCodeOf(outcome: HttpOutcome): string {
  const error = outcome.envelope['error'];
  if (typeof error !== 'object' || error === null) return '';
  return String((error as Record<string, unknown>)['code'] ?? '');
}

/**
 * 与 `apps/daemon/src/control/server.ts` 的 `bodyDigest` 同算法。
 *
 * 这里刻意**重抄一份**而不是从 server.ts 导入：控制台（浏览器里那份实现）
 * 也是这样算的，导入会让「两端算法是否一致」永远为真。真实控制台实现在
 * `apps/console/src/auth/client.ts`，`tests/unit/control-plane.test.ts`
 * 已经对齐过一次；本脚本用一份独立实现再对照一次，作为第三处。
 */
function bodyDigest(body: Record<string, unknown>): string {
  const entries = Object.entries(body)
    .filter(([key]) => key !== 'nonce')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
}

/** 走完一次「申请 nonce → 带 nonce 调用」的诚实控制台流程。 */
async function mutatingCall(
  port: number,
  session: ConsoleSession,
  pathname: string,
  payload: Record<string, unknown>,
  options: { readonly reuseNonce?: string } = {},
): Promise<HttpOutcome> {
  let nonce = options.reuseNonce;
  if (nonce === undefined) {
    const issued = await post(port, session, '/api/nonces', {
      operation: pathname,
      subject: '',
      digest: bodyDigest(payload),
    });
    if (issued.status !== 200) {
      throw new Error(`装置错误：申请 nonce 失败 ${String(issued.status)} ${JSON.stringify(issued.envelope)}`);
    }
    nonce = String(issued.result['nonce']);
  }
  return post(port, session, pathname, { ...payload, nonce });
}

// ---------------------------------------------------------------------------
// 状态库旁路：独立的第二连接
// ---------------------------------------------------------------------------

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

function readApprovalRow(dbPath: string, approvalId: string): Record<string, unknown> | undefined {
  const opened = openDatabase({ path: dbPath });
  try {
    return opened.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as
      | Record<string, unknown>
      | undefined;
  } finally {
    closeDatabase(opened.db);
  }
}

/** 直接执行一条 SQL，返回是否**成功改动了行**（被触发器拒绝时为 false）。 */
function runSql(
  dbPath: string,
  sql: string,
  params: readonly unknown[],
): { readonly ok: boolean; readonly error: string } {
  const opened = openDatabase({ path: dbPath });
  try {
    opened.db.prepare(sql).run(...(params as never[]));
    return { ok: true, error: '' };
  } catch (cause) {
    return { ok: false, error: String((cause as { message?: string }).message ?? cause) };
  } finally {
    closeDatabase(opened.db);
  }
}

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

/**
 * 批准侧被冻结的时刻。
 *
 * 控制台的会话时钟走真实时间（否则 cookie 会当场过期），而**批准**的
 * 有效期必须可复现 —— 因此只冻结批准侧的 `now`。这顺带说明一件事：
 * 有效期判定读的是注入进来的时刻，不是「现在几点」这个无法复现的事实。
 */
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const NOW_ISO = new Date(NOW).toISOString();
const LATER_ISO = new Date(NOW + LIMITS.APPROVAL_TTL_MS + 60_000).toISOString();

const CONNECTION = 'conn-evidence-021';
const WORKSPACE = 'ws-evidence-021';
const PRINCIPAL = 'principal-evidence-021';
const POLICY_VERSION = 11;
const KEY = 'lwb-evidence-021-key-0123456789abcdef0123456789';
const APPROVE_PATH = '/api/approvals/approve_and_apply';
const REJECT_PATH = '/api/approvals/reject';

const authority: ReadTicketAuthority = createReadTicketAuthority({ key: KEY });

interface DiskIdentity {
  readonly volume_id: string;
  readonly file_id: string;
  readonly link_count: number;
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
    // 左闭右开：整文件读的右端是 `total_lines + 1`。
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

interface Corpus {
  readonly manifest: FixtureManifest;
  readonly editable: readonly FixtureFileEntry[];
  readonly bytes: Map<string, Buffer>;
  readonly identity: Map<string, DiskIdentity>;
}

function absOf(root: string, relPath: string): string {
  return path.join(root, ...relPath.split('/'));
}

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

/**
 * 一次 `change_apply` 的策略判定请求，**除批准外每一层都放行**。
 * 用来核对「策略层与门禁对同一个事实给出同一个答案」。
 */
function policyRequestFor(approval: PolicyApprovalView | null, now: number = NOW): PolicyRequest {
  return {
    now,
    connection: {
      connection_id: CONNECTION,
      enabled: true,
      granted_capabilities: ['propose'],
      audience: 'mcp_adapter',
      granted_workspace_ids: [WORKSPACE],
    },
    workspace: {
      workspace_id: WORKSPACE,
      kind: 'directory',
      mode: 'read_propose_apply_with_local_approval',
      capabilities: {
        read_enabled: true,
        git_enabled: false,
        proposal_enabled: true,
        direct_write_enabled: true,
        recovery_required: false,
      },
      current_generation: 1,
      current_policy_version: POLICY_VERSION,
      root_volume_id: 'vol-evidence',
      root_file_id: 'file-evidence',
      paused: false,
    },
    presented: { generation: 1, policy_version: POLICY_VERSION },
    action: { action: 'change_apply', path: 'newline/lf.txt', approval },
  };
}

// ===========================================================================
// 主流程
// ===========================================================================

async function main(): Promise<void> {
  if (!WINDOWS_ONLY) {
    skip('全部验收项', '当前平台不是 Windows；文件身份语义无法成立');
    console.log('\n0 PASSED');
    process.exitCode = 0;
    return;
  }

  ensureFixtures();
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-evidence-021-'));
  const workspaceRoot = path.join(sandbox, 'workspace');
  const dbPath = path.join(sandbox, 'state.sqlite');
  const backend = new PowerShellWinfsBackend();
  let plane: ControlPlane | null = null;

  try {
    const capability = await backend.capability();
    note(
      '护栏能力',
      `available=${String(capability.available)} backend=${capability.backend} ` +
        `supports_file_identity=${String(capability.supports_file_identity)}`,
    );
    if (!capability.available || !capability.supports_file_identity) {
      check('护栏可用且能取到文件身份', false, '没有身份就连修改集都建不出来');
      return;
    }

    await cp(TESTREPO_DIR, workspaceRoot, { recursive: true });
    const ops: WinfsOps = backend;

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

    const corpus = await loadCorpus(ops, workspaceRoot);
    const blobs = new BlobStore({ objectsRoot: path.join(sandbox, 'objects'), registry: repos.blobs });
    const limits: PrepareLimits = {
      max_editable_file_bytes: LIMITS.MAX_EDITABLE_FILE_BYTES,
      max_change_files: LIMITS.MAX_CHANGE_FILES,
      max_change_total_bytes: LIMITS.MAX_CHANGE_TOTAL_BYTES,
      change_ttl_ms: LIMITS.CHANGE_TTL_MS,
    };
    note(
      '语料',
      `夹具 ${String(corpus.manifest.files.length)} 个；可编辑且换行可写 ${String(corpus.editable.length)} 个`,
    );
    note(
      'LIMITS',
      `MAX_EDITABLE_FILE_BYTES=${String(limits.max_editable_file_bytes)} ` +
        `MAX_CHANGE_FILES=${String(limits.max_change_files)} ` +
        `APPROVAL_TTL_MS=${String(LIMITS.APPROVAL_TTL_MS)}（${String(LIMITS.APPROVAL_TTL_MS / 60_000)} 分钟）`,
    );

    // --- 控制面：真实会话、真实 CSRF、真实 nonce ---
    const registry = new OperationRegistry();
    const throwingStub = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('本脚本不通过 HTTP 调用工作区控制操作');
        },
      },
    ) as unknown as WorkspaceRegistry;
    registerWorkspaceOperations(registry, throwingStub);
    registerWorkspaceAccessOperations(registry, {
      repos,
      model_connection_id: 'conn-chatgpt-web',
    });
    registerConnectionOperations(registry, { repos });
    // 批准操作的时钟冻结在 NOW：有效期必须可复现（见 NOW 的说明）。
    registerApprovalOperations(registry, { repos, now: () => NOW_ISO });

    const sessions = new ControlSessionStore({ port: 0 });
    plane = createControlPlane({ operations: registry, sessions, port: 0 });
    const { port, origin } = await plane.server.listen();
    note(
      '控制面',
      `监听 ${origin}；控制路由 ${String(plane.routes.routes().length)} 条：${plane.routes
        .routes()
        .map((route) => route.path)
        .join('、')}`,
    );

    const ticket = plane.server.mintBootstrap();
    note('启动令牌', `地址 ${ticket.url.replace(/[?#].*$/, '#…')}（令牌在片段里，不进日志）`);
    const redeemed = await post(port, null, '/api/session', { token: ticket.token });
    if (redeemed.status !== 200) {
      check('装置：控制台会话可用', false, `${String(redeemed.status)} ${JSON.stringify(redeemed.envelope)}`);
      return;
    }
    const consoleSession: ConsoleSession = {
      // cookie 值同时出现在响应体的 `cookie_value`（供脚本/控制台自用）与
      // `Set-Cookie` 头（浏览器走的那条）里；本脚本两种都不打日志。
      cookie: `${CONTROL_COOKIE_NAME}=${String(redeemed.result['cookie_value'])}`,
      csrf: String(redeemed.result['csrf_token']),
    };
    check(
      '装置：真实 HTTP 兑换启动令牌，拿到会话与 CSRF 令牌',
      consoleSession.cookie.length > 20 && consoleSession.csrf.length > 20,
      `会话 ${String(redeemed.result['session_id'])}`,
    );

    // --- 造三个真实修改集 ---
    const rel = 'newline/lf.txt';
    const bytes = corpus.bytes.get(rel);
    const identity = corpus.identity.get(rel);
    if (bytes === undefined || identity === undefined) throw new Error(`装置错误：夹具里没有 ${rel}`);
    const decoded = inspectBytes(bytes);
    if (decoded.kind !== 'text') throw new Error('装置错误：newline/lf.txt 不是文本');
    const firstLine = lineText(decoded.text, decoded.lines, 1);

    const makeChange = async (label: string, newFirstLine: string): Promise<ChangePrepareData> =>
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
            idempotency_key: `lwb-evidence-021-${label}-0123456789abcdef`,
            summary: `证据：${label}`,
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
                    new_lines: [newFirstLine],
                  },
                ],
              } satisfies ChangeItem,
            ],
          },
        },
        { ops, authority, blobs, repos },
      );

    const alpha = await makeChange('alpha', '证据脚本写的第一行');
    const beta = await makeChange('beta', '证据脚本写的第二行');
    const gamma = await makeChange('gamma', '证据脚本写的第三行');
    note('修改集 α', `${alpha.change_id} digest=${alpha.digest} 短核 ${shortCodeOf(alpha.digest)}`);
    note('修改集 β', `${beta.change_id} digest=${beta.digest} 短核 ${shortCodeOf(beta.digest)}`);
    note('修改集 γ', `${gamma.change_id} digest=${gamma.digest} 短核 ${shortCodeOf(gamma.digest)}`);
    check(
      '装置：三个修改集内容各不相同，摘要因此各不相同',
      new Set([alpha.digest, beta.digest, gamma.digest]).size === 3,
      `${alpha.digest.slice(0, 12)}… / ${beta.digest.slice(0, 12)}… / ${gamma.digest.slice(0, 12)}…`,
    );

    // =======================================================================
    // 步骤 1：批准之前先由落库事实重载并重算摘要
    // =======================================================================

    await guarded('步骤 1', async () => {
      section('步骤 1：由落库事实重载并重算摘要');

      const loaded = reloadChangeSet(repos, alpha.change_id);
      const stored = repos.changes.requireById(alpha.change_id);
      check(
        '重算摘要 == 生产路径（prepareChange）算出的摘要',
        loaded.digest === alpha.digest,
        `${loaded.digest.slice(0, 16)}…`,
      );
      check('重算摘要 == 落库的 changesets.digest', loaded.digest === stored.digest);
      check(
        '重算所用的文件字段与摘要覆盖的是同一批（路径/操作/前后 sha 与大小/编码/换行/BOM）',
        loaded.files.length === 1 &&
          loaded.files[0]?.path === rel &&
          loaded.files[0]?.before_sha256 === sha256(bytes),
        JSON.stringify(loaded.files[0]),
      );
      check(
        '修改集初始状态为待批准，且建立时没有产生任何批准',
        loaded.change.state === 'PENDING_APPROVAL' && countRows(dbPath, 'approvals') === 0,
        `state=${loaded.change.state}，approvals ${String(countRows(dbPath, 'approvals'))} 行`,
      );
    });

    // =======================================================================
    // 验收标准 1：批准必须绑定摘要；篡改一个字符后旧审批失效
    // =======================================================================

    await guarded('验收 1', async () => {
      section('验收 1：批准绑定摘要；篡改一个字符后旧审批失效');

      // --- 1a 真实 HTTP：控制台按下「批准并应用」 ---
      const first = await mutatingCall(port, consoleSession, APPROVE_PATH, {
        change_id: alpha.change_id,
        digest: alpha.digest,
      });
      check(
        'a 控制台「批准并应用」按钮：真实 HTTP 200，修改集进入 QUEUED',
        first.status === 200 && first.result['state'] === 'QUEUED',
        `${String(first.status)} state=${String(first.result['state'])} operation=${String(first.result['operation_id'])}`,
      );
      check(
        'a 响应明确写着「尚未写入任何文件」',
        first.result['workspace_modified'] === false,
        String(first.result['next_action']),
      );

      const approvalId = String(first.result['approval_id']);
      const row = readApprovalRow(dbPath, approvalId);
      const storedAlpha = repos.changes.requireById(alpha.change_id);
      check(
        'a 步骤 2 的七项事实逐项落在 approvals 行上（经**另一条连接**读出）',
        row !== undefined &&
          row['actor_kind'] === 'local_operator' &&
          String(row['actor']).startsWith('console:') &&
          row['digest'] === alpha.digest &&
          row['state'] === 'ACTIVE' &&
          row['root_generation'] === storedAlpha.root_generation &&
          row['policy_version'] === storedAlpha.policy_version &&
          row['consumed_by'] === null &&
          String(row['expires_at']) === new Date(NOW + LIMITS.APPROVAL_TTL_MS).toISOString(),
        `actor=${String(row?.['actor'])} digest=${String(row?.['digest']).slice(0, 12)}… ` +
          `generation=${String(row?.['root_generation'])} policy=${String(row?.['policy_version'])} ` +
          `expires_at=${String(row?.['expires_at'])}`,
      );
      check(
        'a 批准行的身份不是任何入参：`actor` 是 `console:<session_id>`，由已鉴权的 IPC 通道身份给出',
        String(row?.['actor']) === `console:${String(redeemed.result['session_id'])}`,
        String(row?.['actor']),
      );

      // --- 1b 篡改一个字符：拿 α 的摘要去批 β ---
      const tamperedDigest = `${alpha.digest.slice(0, 63)}${alpha.digest.endsWith('0') ? '1' : '0'}`;
      const approvalsBefore = countRows(dbPath, 'approvals');
      const crossed = await mutatingCall(port, consoleSession, APPROVE_PATH, {
        change_id: beta.change_id,
        digest: tamperedDigest,
      });
      check(
        'b 把 α 的摘要改掉末位一个字符去批 β：真实 HTTP 被拒（CHANGE_STATE_INVALID）',
        crossed.status !== 200 && errorCodeOf(crossed) === 'CHANGE_STATE_INVALID',
        `${String(crossed.status)} ${errorCodeOf(crossed)}`,
      );
      check(
        'b β 上一条批准记录都没多（是「先比对后写」，不是「先记后拒」）',
        countRows(dbPath, 'approvals') === approvalsBefore,
        `approvals 仍为 ${String(approvalsBefore)} 行`,
      );
      check(
        'b β 的状态仍然是待批准',
        repos.changes.requireById(beta.change_id).state === 'PENDING_APPROVAL',
        repos.changes.requireById(beta.change_id).state,
      );
      check(
        'b α 的批准仍然精确绑定 α 自己（一次越界的尝试没有动到它）',
        readApprovalRow(dbPath, approvalId)?.['digest'] === alpha.digest,
        `短核 ${shortCodeOf(alpha.digest)}`,
      );

      // --- 1c 记录被改动：重算不再等于落库值 ---
      //
      // 拿 γ 来做：改动过的记录按定义不可还原，而 α 与 β 要留给后面的段落。
      //
      // `change_items_immutable` 挡 UPDATE，因此「改动」的写法是删旧插新。
      // 这不是脚本在破坏夹具，而是**演示**那条防线：有人在触发器之外动了行，
      // 批准侧必须发现，而不是算出一个别的摘要继续走。
      const itemsBefore = repos.changes.items(gamma.change_id);
      const originalTarget = String(itemsBefore[0]?.target_sha256 ?? '');
      const tamperedTarget = `${originalTarget.slice(0, 63)}${originalTarget.endsWith('0') ? '1' : '0'}`;
      // 先删旧行、再插新行（`UNIQUE(change_id, canonical_path_key)` 使得
      // 「先插后删」在同一个文件上必然撞索引）。新行的字段从读出来的那一行
      // 逐列照抄，**只改 `target_sha256` 一位**：这样这一改动在别处没有任何
      // 痕迹 —— 不引入新 blob、不动路径、不动基线，变掉的只有「将要写进去的
      // 是什么内容」。
      const original = itemsBefore[0];
      if (original === undefined) throw new Error('装置错误：γ 上没有条目行');
      const deleted = runSql(dbPath, 'DELETE FROM change_items WHERE id = ?', [original.id]);
      const inserted = runSql(
        dbPath,
        `INSERT INTO change_items
           (id, change_id, seq, op, canonical_path, canonical_path_key, base_file_id, base_sha256,
            target_sha256, old_blob_id, new_blob_id, encoding, bom, newline, created_at,
            added_lines, removed_lines)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'ci_evidence_021_tampered',
          original.change_id,
          original.seq,
          original.op,
          original.canonical_path,
          original.canonical_path_key,
          original.base_file_id,
          original.base_sha256,
          tamperedTarget,
          original.old_blob_id,
          original.new_blob_id,
          original.encoding,
          // 仓储层把 `bom` 读成布尔（模式里是 0/1），而 SQLite 绑参不收布尔。
          // 这一行本身就是个提醒：绕过仓储层直接说 SQL，就得自己管类型。
          original.bom ? 1 : 0,
          original.newline,
          original.created_at,
          original.added_lines,
          original.removed_lines,
        ],
      );
      check(
        'c 装置：γ 的条目行确实被换掉了（删旧插新，因为不可变触发器只挡 UPDATE）',
        deleted.ok && inserted.ok && repos.changes.items(gamma.change_id).length === 1,
        deleted.ok && inserted.ok
          ? `target_sha256 …${tamperedTarget.slice(-8)}（原 …${originalTarget.slice(-8)}）`
          : inserted.error || deleted.error,
      );

      const gateAfterTamper = evaluateApplyGate({
        repos,
        change_id: gamma.change_id,
        allowed_from: APPLY_ENTRY_STATES,
        now: NOW_ISO,
      });
      check(
        'c 篡改后门禁拒绝放行，理由是 CHANGE_INTEGRITY（记录自身不一致）',
        gateAfterTamper.kind === 'refused' && gateAfterTamper.reason === 'CHANGE_INTEGRITY',
        gateAfterTamper.kind === 'refused'
          ? `${gateAfterTamper.code}/${gateAfterTamper.reason}`
          : gateAfterTamper.kind,
      );
      const tamperError = await catchBridge(() => reloadChangeSet(repos, gamma.change_id));
      check(
        'c 重载层报出的理由是 DIGEST_NOT_REPRODUCIBLE（重算值 ≠ 落库值）',
        tamperError.code === 'CHANGE_STATE_INVALID' &&
          tamperError.details?.['reason'] === 'DIGEST_NOT_REPRODUCIBLE',
        errLine(tamperError),
      );
      check(
        'c 篡改后**没有**任何批准被写过，也没有任何状态被推进（拒绝是纯读的结论）',
        repos.changes.requireById(gamma.change_id).state === 'PENDING_APPROVAL' &&
          countRows(dbPath, 'approvals') === approvalsBefore,
        `state=${repos.changes.requireById(gamma.change_id).state}，approvals 仍为 ${String(approvalsBefore)} 行`,
      );
      check(
        'c 不可变触发器确实挡下 UPDATE：改一行条目的正确写法只有删插',
        !runSql(dbPath, 'UPDATE change_items SET target_sha256 = ? WHERE change_id = ? AND id = ?', [
          sha256(Buffer.from('whatever')),
          gamma.change_id,
          'ci_evidence_021_tampered',
        ]).ok,
        'UPDATE 被 change_items_immutable 拒绝',
      );
    });

    // =======================================================================
    // 验收标准 2：模型单独调用应用工具只得到 APPROVAL_REQUIRED
    // =======================================================================

    await guarded('验收 2', async () => {
      section('验收 2：模型单独调用应用工具只得到 APPROVAL_REQUIRED');

      const verdict = evaluateApplyGate({
        repos,
        change_id: beta.change_id,
        allowed_from: APPLY_ENTRY_STATES,
        now: NOW_ISO,
      });
      check(
        'a 门禁：没有任何批准时只得到 APPROVAL_REQUIRED / APPROVAL_MISSING',
        verdict.kind === 'refused' &&
          verdict.code === 'APPROVAL_REQUIRED' &&
          verdict.reason === 'APPROVAL_MISSING',
        verdict.kind === 'refused' ? `${verdict.code}/${verdict.reason}` : verdict.kind,
      );

      const decision = decide(policyRequestFor(null));
      const approvalFailure = decision.failures.find((failure) => failure.check === 'approval');
      check(
        'a 策略层对同一个事实给出同一个错误码与理由（两处判定必须一致）',
        approvalFailure?.error_code === 'APPROVAL_REQUIRED' &&
          approvalFailure.reason === 'APPROVAL_MISSING' &&
          decision.failures.length === 1,
        `${String(approvalFailure?.error_code)}/${String(approvalFailure?.reason)}；` +
          `其余层失败 ${String(decision.failures.length - 1)} 项`,
      );

      check(
        'b 能力表：mcp-adapter **不具备** approvals.decide，且它写在 NEVER_GRANTED_TO_MODEL 上',
        hasCapability('mcp-adapter', 'approvals.decide') === false &&
          NEVER_GRANTED_TO_MODEL.includes('approvals.decide'),
        '模型侧能拿到的只有 tools.read / tools.propose / tools.apply',
      );

      check(
        'c 入参 schema：change_apply 拒绝 approved / force / user_id / session_id / conversation_label',
        (() => {
          const base = { change_id: 'chg_1', idempotency_key: 'k'.repeat(8) };
          const extras: readonly Record<string, unknown>[] = [
            { approved: true },
            { force: true },
            { user_id: 'u1' },
            { session_id: 's1' },
            { conversation_label: '信任我' },
            { principal_id: 'p1' },
          ];
          return extras.every(
            (extra) => !TOOL_INPUT_SCHEMAS.change_apply.safeParse({ ...base, ...extra }).success,
          );
        })(),
        'strictObject：未知字段即拒绝；身份类字段连被读一次的机会都没有',
      );

      check(
        'd 工具面：批准类名字是控制面方法，不可能出现在 tools/list',
        ['approval.grant', 'approval.revoke', 'change.reject'].every(
          (name) => CONTROL_PLANE_ROUTES.includes(name as never) && isToolName(name) === false,
        ),
        `CONTROL_PLANE_ROUTES 共 ${String(CONTROL_PLANE_ROUTES.length)} 个名字`,
      );
      check(
        'd 适配器：即使 daemon 把控制面方法报成「可用」，适配器也拒绝装配工具面',
        (() => {
          const forged = {
            tools: [{ name: 'approval.grant', available: true, reason: null }],
          } as unknown as ToolCatalogResult;
          try {
            resolveSurface(forged);
            return false;
          } catch {
            return true;
          }
        })(),
        'SurfaceMismatchError：拒绝装配，而不是把控制面方法挂出去',
      );

      const anonymous = await post(port, null, APPROVE_PATH, {
        change_id: beta.change_id,
        digest: beta.digest,
        approved: true,
      });
      check(
        'e 真实 HTTP：没有控制台会话的调用在会话门就被挡下（401）；参数里的 approved:true 没有任何作用',
        anonymous.status === 401 && errorCodeOf(anonymous) === 'NOT_AUTHORIZED',
        `${String(anonymous.status)} ${errorCodeOf(anonymous)}`,
      );

      const noNonce = await post(port, consoleSession, APPROVE_PATH, {
        change_id: beta.change_id,
        digest: beta.digest,
      });
      check(
        'f 真实 HTTP：有会话但没有一次性 nonce → 403（nonce 是批准这条路上的必需要素）',
        noNonce.status === 403,
        `${String(noNonce.status)}`,
      );

      check(
        'g 整段跑完，β 上仍然一条批准记录都没有',
        repos.approvals.listForChange(beta.change_id).length === 0,
        `同时 α 上有 ${String(repos.approvals.listForChange(alpha.change_id).length)} 条 —— 差别只来自有没有人在控制台上点过`,
      );
    });

    // =======================================================================
    // 验收标准 3：重复点击批准不会制造第二次授权执行
    // =======================================================================

    await guarded('验收 3', async () => {
      section('验收 3：重复点击批准不会制造第二次授权执行');

      const approvalsBefore = countRows(dbPath, 'approvals');
      const operationsBefore = countRows(dbPath, 'operations');

      const nonceIssue = await post(port, consoleSession, '/api/nonces', {
        operation: APPROVE_PATH,
        subject: '',
        digest: bodyDigest({ change_id: beta.change_id, digest: beta.digest }),
      });
      const nonce = String(nonceIssue.result['nonce']);
      check(
        'a 控制台为本次动作申请到一次性 nonce',
        nonceIssue.status === 200 && nonce.length > 0,
        `operation=${APPROVE_PATH}，到期 ${String(nonceIssue.result['expires_at'])}`,
      );

      const click1 = await mutatingCall(port, consoleSession, APPROVE_PATH, {
        change_id: beta.change_id,
        digest: beta.digest,
      }, { reuseNonce: nonce });
      check(
        'a 第一次点击：批准 + QUEUED + 唯一操作',
        click1.status === 200 && click1.result['state'] === 'QUEUED',
        `${String(click1.status)} state=${String(click1.result['state'])} operation=${String(click1.result['operation_id'])}`,
      );

      // 第二次点击的第一种形态：**同一个 nonce 重放** —— 网络重试、双击、
      // 浏览器重发长这样。
      const replay = await mutatingCall(port, consoleSession, APPROVE_PATH, {
        change_id: beta.change_id,
        digest: beta.digest,
      }, { reuseNonce: nonce });
      check(
        'b 重放同一个 nonce：403（一次性）',
        replay.status === 403,
        `${String(replay.status)} ${errorCodeOf(replay)}`,
      );

      // 第二次点击的第二种形态：**重新申请一张 nonce 再点一次** —— 人真的又
      // 点了一次按钮长这样。它绕过了 nonce 的一次性，因此必须由状态挡住。
      const click2 = await mutatingCall(port, consoleSession, APPROVE_PATH, {
        change_id: beta.change_id,
        digest: beta.digest,
      });
      check(
        'c 重新取一张 nonce 再点一次：仍然被拒（挡它的是「已经在排队」，不是 nonce）',
        click2.status !== 200 && errorCodeOf(click2) === 'CHANGE_STATE_INVALID',
        `${String(click2.status)} ${errorCodeOf(click2)}`,
      );

      const approvalsAfter = countRows(dbPath, 'approvals');
      const operationsAfter = countRows(dbPath, 'operations');
      check(
        'd 两次点击之后：批准恰好 +1 行，操作恰好 +1 行（经另一条连接读出）',
        approvalsAfter === approvalsBefore + 1 && operationsAfter === operationsBefore + 1,
        `approvals ${String(approvalsBefore)}→${String(approvalsAfter)}；` +
          `operations ${String(operationsBefore)}→${String(operationsAfter)}`,
      );
      check(
        'd 修改集上仍然只有**一个**操作，状态为 QUEUED',
        (() => {
          const operation = repos.operations.findByChangeId(beta.change_id);
          return operation !== null && operation.state === 'QUEUED';
        })(),
        'UNIQUE(change_id) 是兜底；真正收敛的是「状态已不是待决定」这个前置判断',
      );
      check(
        'e 批准未被消费：仍是 ACTIVE，`consumed_by` 与 `consumed_at` 均为空',
        (() => {
          const active = repos.approvals.findActive(beta.change_id);
          return active !== null && active.consumed_by === null && active.consumed_at === null;
        })(),
        '执行协调器（LWB-026）还不存在，因此谁也无权消费 —— 消费只发生在认领执行的那一刻',
      );
    });

    // =======================================================================
    // 门禁：只判定，不消费；执行前用本次时刻重新判定
    // =======================================================================

    await guarded('门禁语义', async () => {
      section('门禁语义：只判定，不消费；执行前用本次时刻重新判定');

      const active = repos.approvals.findActive(beta.change_id);
      if (active === null) throw new Error('装置错误：β 上没有有效批准');
      const executionStates = ['QUEUED', 'VALIDATING', 'APPLYING'] as const;

      let readyCount = 0;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const verdict = evaluateApplyGate({
          repos,
          change_id: beta.change_id,
          allowed_from: executionStates,
          now: NOW_ISO,
        });
        if (verdict.kind === 'ready') readyCount += 1;
      }
      check(
        'a 连续三次执行前复核都放行（门禁是判定，不是占用）',
        readyCount === 3,
        `3 次判定中放行 ${String(readyCount)} 次`,
      );
      check(
        'a 三次复核之后批准仍然是 ACTIVE —— 门禁不消费',
        repos.approvals.requireById(active.id).state === 'ACTIVE',
        `state=${repos.approvals.requireById(active.id).state}`,
      );

      const expired = evaluateApplyGate({
        repos,
        change_id: beta.change_id,
        allowed_from: executionStates,
        now: LATER_ISO,
      });
      check(
        `b 把判定时刻推到有效期之后（${LATER_ISO}）不放行：APPROVAL_EXPIRED`,
        expired.kind === 'refused' && expired.code === 'APPROVAL_EXPIRED',
        expired.kind === 'refused' ? `${expired.code}/${expired.reason}` : expired.kind,
      );
      check(
        'b 库里的状态仍然是 ACTIVE —— 有效期是**读的时候**投影出来的，只读路径不写库',
        repos.approvals.requireById(active.id).state === 'ACTIVE',
        '与 approvals.list 用的是同一个投影函数，因此界面上显示的和门禁判定的一致',
      );

      const policyAtExpiry = decide(
        policyRequestFor(
          {
            state: 'ACTIVE',
            change_digest: active.digest,
            presented_digest: active.digest,
            expires_at: Date.parse(active.expires_at),
          },
          NOW + LIMITS.APPROVAL_TTL_MS + 60_000,
        ),
      );
      check(
        'b 策略层在同一个事实上也报 APPROVAL_EXPIRED（两处一致）',
        policyAtExpiry.failures.some(
          (failure) => failure.check === 'approval' && failure.error_code === 'APPROVAL_EXPIRED',
        ),
        `${String(policyAtExpiry.failures.length)} 项失败，主因 ${String(policyAtExpiry.primary?.reason)}`,
      );
      const policyBeforeExpiry = decide(
        policyRequestFor({
          state: 'ACTIVE',
          change_digest: active.digest,
          presented_digest: active.digest,
          expires_at: Date.parse(active.expires_at),
        }),
      );
      check(
        'b 未到期时策略层放行（因此上面那条不是「策略层总在拒绝」）',
        policyBeforeExpiry.allow && policyBeforeExpiry.failures.length === 0,
        `allow=${String(policyBeforeExpiry.allow)}`,
      );
    });

    // =======================================================================
    // 拒绝：终态，且不留下批准记录
    // =======================================================================

    await guarded('拒绝', async () => {
      section('拒绝：终态，且不留下批准记录');

      const approvalsBefore = countRows(dbPath, 'approvals');
      const rejected = await mutatingCall(port, consoleSession, REJECT_PATH, {
        change_id: gamma.change_id,
        digest: gamma.digest,
      });
      // γ 的条目在验收 1c 里被换过，因此它现在**算不出可信摘要** ——
      // 拒绝也必须先过同一套前置（重载 + 重算），不能因为「只是拒绝」
      // 就跳过。这一条正是「篡改之后旧审批与旧决定都失效」的延伸。
      check(
        'a 对被改动过的 γ 做拒绝：也被挡下（拒绝同样要求摘要可复算）',
        rejected.status !== 200 && errorCodeOf(rejected) === 'CHANGE_STATE_INVALID',
        `${String(rejected.status)} ${errorCodeOf(rejected)}`,
      );
      check(
        'a 拒绝不写入任何批准记录',
        countRows(dbPath, 'approvals') === approvalsBefore,
        `approvals 仍为 ${String(approvalsBefore)} 行`,
      );

      // 用一个**完好**的修改集补上「拒绝成功」这一条。
      const delta = await makeChange('delta', '证据脚本写的第四行');
      const rejectedDelta = await mutatingCall(port, consoleSession, REJECT_PATH, {
        change_id: delta.change_id,
        digest: delta.digest,
      });
      check(
        'b 完好的修改集上拒绝成功：状态进入 REJECTED（终态）',
        rejectedDelta.status === 200 && rejectedDelta.result['state'] === 'REJECTED',
        `${String(rejectedDelta.status)} state=${String(rejectedDelta.result['state'])}`,
      );
      check(
        'b 拒绝仍然不写入批准记录',
        countRows(dbPath, 'approvals') === approvalsBefore,
        `approvals 仍为 ${String(approvalsBefore)} 行`,
      );

      const afterwards = await mutatingCall(port, consoleSession, APPROVE_PATH, {
        change_id: delta.change_id,
        digest: delta.digest,
      });
      check(
        'c 拒绝之后再批准：被拒（终态不可逆）',
        afterwards.status !== 200 && errorCodeOf(afterwards) === 'CHANGE_STATE_INVALID',
        `${String(afterwards.status)} ${errorCodeOf(afterwards)}`,
      );
      check(
        'c 仍然没有批准记录产生',
        countRows(dbPath, 'approvals') === approvalsBefore,
        `approvals 仍为 ${String(approvalsBefore)} 行`,
      );
    });

    // =======================================================================
    // 收尾：关闭并重开状态库
    // =======================================================================

    closeDatabase(opened.db);
    await plane.server.close();
    plane = null;

    section('收尾：关闭并重开状态库（幂等事实不因重启消失）');
    const reopened = openDatabase({ path: dbPath });
    try {
      const repos2 = new Repositories(reopened.db);
      const loaded = reloadChangeSet(repos2, beta.change_id);
      check(
        '重开之后，仅凭落库的行重算出的摘要与 prepare 写入的逐字符相同',
        loaded.digest === beta.digest,
        `${loaded.digest.slice(0, 16)}…`,
      );
      const approval = repos2.approvals.findActive(beta.change_id);
      check(
        '重开之后，批准仍然绑定同一串摘要，且仍是 ACTIVE',
        approval !== null && approval.digest === loaded.digest && approval.state === 'ACTIVE',
        `${String(approval?.id)} state=${String(approval?.state)}`,
      );
      const operation = repos2.operations.findByChangeId(beta.change_id);
      check(
        '重开之后，操作仍然只有一条且仍在 QUEUED（等待一个还不存在的执行器）',
        operation !== null && operation.state === 'QUEUED',
        '本次采集里没有任何操作被推进，也没有任何批准被消费',
      );
      const stored = repos2.changes.requireById(beta.change_id);
      const recomputed = canonicalChangeDigest({
        contract_version: stored.contract_version,
        policy_version: stored.policy_version,
        root_generation: stored.root_generation,
        workspace_id: stored.workspace_id,
        files: loaded.files,
      });
      check(
        '重开之后独立调用 `canonicalChangeDigest` 与 `reloadChangeSet` 结论一致',
        recomputed === stored.digest,
        `${recomputed.slice(0, 16)}…`,
      );
    } finally {
      closeDatabase(reopened.db);
    }
  } finally {
    if (plane !== null) await plane.server.close().catch(() => undefined);
    await backend.dispose().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }

  section('未执行项（不得记为通过）');
  skip(
    '模型经真实 MCP 通道调用 `change_apply`',
    '五条 `change_*` 工具尚未实现（LWB-025/026）：工具面当前只为七个读工具注册了操作。本任务证明的是**它落地时会得到的那个答案**（门禁 → APPROVAL_REQUIRED），而不是「它现在就答这个」',
  );
  skip(
    '批准被消费（状态进入 CONSUMED）',
    '消费只发生在执行协调器认领操作的那一刻（LWB-026），而它尚未装配；本任务交付到「排队」为止，因此全部采集里批准都停在 ACTIVE。消费路径的门禁拒绝在 tests/unit/approvals.test.ts 有用例覆盖',
  );
  skip(
    '经由 daemon → 执行器 → 护栏的真实落盘',
    'LWB-026 未实现。本任务没有任何写入代码路径，`workspace_modified` 恒为 false',
  );
  skip(
    '在真实工作区（非夹具副本）上执行任何一次写入',
    'G2 未通过（LWB-002 BLOCKED）；P3 门禁：可在契约冻结前提下继续实现，但不得在真实仓库上联调（docs/evidence/g2-read.md）',
  );
  skip(
    '在真实 ChatGPT 网页端确认「模型不能自行批准」',
    'LWB-002 BLOCKED（真实账号与 Secure MCP Tunnel 凭证）。MCP Inspector 的成功不能替代它',
  );
  skip(
    '「用户确实看过这份内容」',
    'nonce 目前仍由控制台显式申请，因此它证明的是「一次性与内容绑定」，不证明「人看过」；后者要求 nonce 由渲染审核页的那次读取一并签发（见 apps/daemon/src/control/session.ts 文件头）',
  );

  console.log(
    `\n${failures === 0 ? 'ALL PASS' : `${String(failures)} FAILED`} — ${String(passes)} PASSED / ${String(failures)} FAILED / ${String(skips)} NOT_RUN`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
