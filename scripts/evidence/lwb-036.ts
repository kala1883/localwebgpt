/**
 * LWB-036 可复现证据采集：待批准修改集的**复核读取**、逐文件浏览与批准入口。
 *
 * ## 与 LWB-035 的关系：同一套装置，换成复核这条路径
 *
 * 装置相同（真 `startDaemon`、真 HTTP、真环回端口、真 `Set-Cookie`、
 * 真 CSRF、控制台自己的兑换链路与 `ControlClient`），被证的事不同：
 * LWB-035 证的是「界面显示的结论来自真服务端」，这一份证的是
 * **「操作者据以批准的东西，与批准绑定的东西是同一份」**。
 *
 * ```text
 *   真 daemon（真控制面、真能力表、真策略判定）
 *     + 控制台自己的兑换链路与会话
 *     + 控制台自己的解析与判定（parseChangeDetail → progressFromTexts →
 *       reviewCoverageOf → approvalAffordance）
 *     → 判据：批准入口出不出来，由**服务端给的文件清单**与
 *       **服务端给的闸门结论**算出来
 * ```
 *
 * ## 本文件里唯一合成的东西，以及为什么只能是它
 *
 * 一条修改集**只能由模型面产生**（`change_prepare`），而真装配根今天把四个
 * 能力开关全部关着：G0 未通过、原生护栏未验证、§3 未通过、G4 未通过，
 * 于是 `capabilityFlagsFrom` 算出来的每一格都是 false。这不是可以绕开的
 * 装置限制 —— `apps/daemon/src/gates.ts` 里那句注释写得比本文件清楚：
 * 「一个可以被配置打开的门禁，就不是门禁了」。因此这条**输入**必须由本
 * 脚本自己造。
 *
 * 造的是输入，不是结论。每一格都走真实现：
 *  - 字节经真 `BlobStore.putAndRegister` 落进受保护根的 `objects` 目录
 *    （`fsync` + 目录同步 + 回读比对哈希）；
 *  - 行经真 `Repositories` 写进真 SQLite；
 *  - 摘要由真 `canonicalChangeDigest` 算出（批准绑定的就是它）；
 *  - 工作区是**通过真控制面登记**的（§3：nonce + CSRF + Origin 全链路）。
 *
 * 之后每一格结论都由真服务端算出来，本脚本不再参与。
 *
 * ## 逐条对应任务书
 *
 *  步骤 1「按文件分页、完整内容查看、风险汇总、变更统计、明确批准按钮和
 *  键盘可访问性」—— §6（真响应里的逐文件事实与风险/统计）、
 *  §8（批准入口）、§9.7（逐文件翻页与键盘映射）。
 *  步骤 2「状态实时更新只使用本地认证接口，不依赖向 ChatGPT 推送主动唤醒」
 *  —— §10。
 *  步骤 3「禁止 diff 折叠策略掩盖大范围删除；默认不提供部分批准」—— §9。
 *
 *  验收 (a)「批准内容与摘要一一对应，不会批准未展示的隐含文件」—— §8：
 *  清单来自服务端，覆盖判据按清单逐条算，少看一个文件入口就消失。
 *  验收 (b)「本地点击与 ChatGPT 工具调用同时发生仍只执行一次」—— §12.3
 *  跑的是那条用例（真 NTFS + 真护栏 + 真并发）；本文件不重造它。
 *  验收 (c)「所有静态资源本地加载，无第三方跟踪和外部内容执行」—— §11。
 *
 * ## 今天真服务端的结论是「拒绝」，而这一份要如实记下它
 *
 * 四个开关全关 ⇒ `snapshot_read` 的判定恒为拒绝 ⇒ 控制台**看不到任何
 * 文件正文**。于是 §7 量的是一次真拒绝的形状，§8.5 量的是「即便进度说
 * 全看过，也是 `unavailable` 而不是 `complete`」。把这件事写成「可以批准」
 * 才是这一份最该避免的错误。
 *
 * 用法：node --import tsx scripts/evidence/lwb-036.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件**证明不了**的事逐条列在末尾并标 `NOT_RUN`。
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { BlobStore } from '@lwb/blob-store';
import { DEFAULT_CHANGE_QUERY_LIMITS, canonicalChangeDigest, changeDiffPageOf, deriveRisks } from '@lwb/changes';
import type { ChangeQueryLimits } from '@lwb/changes';
import {
  CONTRACT_VERSION,
  CONTROL_COOKIE_NAME,
  CONTROL_TOKEN_PATTERN_SOURCE,
  LIMITS,
  newLocalId,
} from '@lwb/contracts';
import type { CapabilityFlags, ChangeDiffPage, ChangeSetView } from '@lwb/contracts';
import { EgressBudgetStore } from '@lwb/egress';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { ChangeItemInput, OpenDatabaseResult, WorkspaceRecord } from '@lwb/persistence';
import { decide } from '@lwb/policy';
import type { PolicyDecision } from '@lwb/policy';
import { resolveStoreLayout } from '@lwb/secure-store';

import {
  ControlClient,
  bootstrapConsoleSession,
  readBootstrapToken,
  type ConsoleSession,
  type HistoryLike,
} from '../../apps/console/src/auth/index.ts';
import {
  actionFor,
  approvalAffordance,
  approvalIdempotencyKey,
  clampIndex,
  parseChangeDetail,
  positionLabel,
  progressFromTexts,
  REFRESH_ENDPOINT,
  refreshDecisionOf,
  reviewCoverageOf,
  SingleFlight,
  stepFile,
} from '../../apps/console/src/changes/index.ts';
import type {
  ChangeDetail,
  ContentGate,
  DiffProgress,
  FileText,
} from '../../apps/console/src/changes/index.ts';
import { CONTROL_BIND_HOST, readSessionCookie } from '../../apps/daemon/src/control/index.ts';
import { startDaemon, StartupFailed, type DaemonRuntime } from '../../apps/daemon/src/runtime/assembly.ts';
import { ADAPTER_CONNECTION_ID } from '../../apps/daemon/src/runtime/constants.ts';
import { workspaceViewOf } from '../../apps/daemon/src/tools/access.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

// ---------------------------------------------------------------------------
// 输出助手（与 lwb-006 ~ lwb-035 一致，外加统一的路径遮罩）
// ---------------------------------------------------------------------------

let failures = 0;
let passes = 0;
let skips = 0;

/** 收集所有打印出去的行，供最后那条自查断言使用。 */
const printed: string[] = [];

/** 本机绝对路径 → `‹本机路径›`。**一切外发文本都要过它。** */
function mask(text: string): string {
  return text.replace(/[A-Za-z]:\\[^\s"'）)，。；]*/g, '‹本机路径›');
}

function emit(line: string): void {
  const safe = mask(line);
  printed.push(safe);
  console.log(safe);
}

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes += 1;
    emit(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    emit(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function note(name: string, detail: string): void {
  emit(`NOTE ${name} — ${detail}`);
}

function section(title: string): void {
  emit(`\n== ${title} ==`);
}

function skip(name: string, why: string): void {
  skips += 1;
  emit(`NOT_RUN ${name} — ${why}`);
}

function exec(cmd: string, args: readonly string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd, [...args], { cwd, encoding: 'utf8', shell: false });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// 取值助手（响应体是 `unknown`，逐格取，不 `as`）
// ---------------------------------------------------------------------------

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// 装置：真 daemon + 一个会自己记 cookie 的 fetch
// ---------------------------------------------------------------------------

/**
 * 一个最小的 cookie 罐。**这是装置，不是被测对象** —— Node 的 fetch 没有
 * cookie 罐，而兑换响应靠 `Set-Cookie` 下发会话 cookie。它替浏览器把那件
 * 浏览器会做的事做了，仅此而已（LWB-035 的同一个函数，那一份的注释里记着
 * 它写错过两次，两次都值得留着）。
 */
function cookieJar(): { fetchImpl: typeof fetch; cookie: () => string } {
  let cookie = '';
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers);
    if (cookie.length > 0) headers.set('Cookie', cookie);
    const response = await fetch(input, { ...init, headers });
    const issued = readSessionCookie(response.headers.get('set-cookie') ?? '');
    if (issued !== undefined && issued.length > 0) cookie = `${CONTROL_COOKIE_NAME}=${issued}`;
    return response;
  }) as typeof fetch;
  return { fetchImpl, cookie: () => cookie };
}

interface Raw {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly json: Record<string, unknown> | null;
}

/** 一次**裸**的 POST（不经 `ControlClient`）：用来量无会话 / 无 CSRF 时的形状。 */
async function postRaw(url: string, body: unknown, headers: Record<string, string>): Promise<Raw> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'error',
  });
  return await readRaw(response);
}

/** 一次**裸**的 GET（`ControlClient.call` 只发 POST，而 `/api/status` 是 GET 路由）。 */
async function getRaw(url: string, cookie = ''): Promise<Raw> {
  const response = await fetch(url, {
    method: 'GET',
    headers: cookie.length > 0 ? { Cookie: cookie } : {},
    redirect: 'error',
  });
  return await readRaw(response);
}

async function readRaw(response: Response): Promise<Raw> {
  const text = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = recordOf(JSON.parse(text));
  } catch {
    parsed = null;
  }
  const error = recordOf(parsed?.['error']);
  return {
    status: response.status,
    code: strOf(error?.['code']),
    message: strOf(error?.['message']),
    json: parsed,
  };
}

/** 拆出 `bootstrap_url` 里的三件事（片段、路径、来源）。 */
function parts(url: string): { origin: string; pathname: string; hash: string } {
  const parsed = new URL(url);
  return { origin: parsed.origin, pathname: parsed.pathname, hash: parsed.hash };
}

// ---------------------------------------------------------------------------
// 播种：真的字节、真的行、真的摘要
// ---------------------------------------------------------------------------

/**
 * 一个文件的三个版本（写盘的那一份、快照两侧的那两份）。
 *
 * `before === null` 就是 `create_text`：那里**没有**旧文件，
 * 而这不是一个空文件 —— 两者的区别在差异头的 `/dev/null` 上看得见。
 */
interface SeededFile {
  readonly path: string;
  readonly op: 'edit_text' | 'create_text';
  readonly before: string | null;
  readonly after: string;
  /**
   * 基线文件身份。**库里的触发器管着这一格**：`create_text` 必须为
   * `null`、编辑类必须有值（`change_items_edit_requires_base`）。
   *
   * 真值是护栏读到的那份身份（NTFS 文件索引，16 位十六进制），由
   * `change_prepare` 在建立修改集时记下，执行前会拿它和盘上现在的对象
   * 对一次（`packages/executor` 的 `state.file_id !== item.base_file_id`
   * 就是那条判断）。本文件不执行，因此这一格只是让行**长得像真的**：
   * 复核读取不读它，§6.2 比的是路径清单。
   */
  readonly base_file_id: string | null;
  readonly added_lines: number;
  readonly removed_lines: number;
}

/** 一个像样的 NTFS 文件索引（16 位十六进制）。 */
function fileIdOf(seed: number): string {
  return (0xa000 + seed).toString(16).padStart(16, '0');
}

/** 一条修改集的播种规格。 */
interface SeedSpec {
  readonly files: readonly SeededFile[];
  readonly summary: string;
}

interface Seeded {
  readonly change_id: string;
  readonly digest: string;
  readonly file_count: number;
}

/**
 * 把一条修改集放进真库。
 *
 * 顺序是「先落字节、再算摘要、最后写行」，与 `change_prepare` 的顺序一致：
 * 摘要覆盖的是**两侧字节的哈希与大小**，因此它只能在字节落盘并回读校验
 * 之后才算得出来。反过来写会让摘要描述一个还不存在的东西。
 */
async function seedChange(
  rig: Rig,
  workspace: WorkspaceRecord,
  spec: SeedSpec,
): Promise<Seeded> {
  const items: ChangeItemInput[] = [];
  const digestFiles: {
    path: string;
    op: 'edit_text' | 'create_text';
    before_sha256: string | null;
    before_size: number;
    after_sha256: string;
    after_size: number;
    encoding: 'utf-8';
    newline: 'lf';
    bom: boolean;
  }[] = [];

  for (const file of spec.files) {
    const after = await rig.blobs.putAndRegister(Buffer.from(file.after, 'utf8'), { id: newLocalId('blob') });
    const before =
      file.before === null
        ? null
        : await rig.blobs.putAndRegister(Buffer.from(file.before, 'utf8'), { id: newLocalId('blob') });

    // 回读校验：`putAndRegister` 自己会做一次，这里再做一次是因为
    // 摘要覆盖的正是**读回来的那些字节**的哈希 —— 而下面算摘要用的是
    // `after.put.sha256`，也就是说：这一步在证「摘要描述的那份字节
    // 真的躺在 objects 目录里」。
    //
    // 用 `verify` 而不是 `getVerified`：它读一遍并逐字节核对，返回的是
    // 它**读出来的**大小与哈希，正好是这里要比的两个量。
    const readBack = await rig.blobs.verify({
      sha256: after.put.sha256,
      size: after.put.size,
      storage_ref: after.put.storage_ref,
    });
    if (readBack.sha256 !== after.put.sha256 || readBack.size !== after.put.size) {
      throw new Error('装置自检失败：落盘之后再读回来的字节与写进去的不是同一份。');
    }

    items.push({
      id: newLocalId('ci'),
      path: file.path,
      op: file.op,
      base_file_id: file.base_file_id,
      base_sha256: before === null ? null : before.put.sha256,
      target_sha256: after.put.sha256,
      old_blob_id: before === null ? null : before.id,
      new_blob_id: after.id,
      encoding: 'utf-8',
      bom: false,
      newline: 'lf',
      added_lines: file.added_lines,
      removed_lines: file.removed_lines,
    });

    digestFiles.push({
      path: file.path,
      op: file.op,
      before_sha256: before === null ? null : before.put.sha256,
      before_size: before === null ? 0 : before.put.size,
      after_sha256: after.put.sha256,
      after_size: after.put.size,
      encoding: 'utf-8',
      newline: 'lf',
      bom: false,
    });
  }

  const digest = canonicalChangeDigest({
    contract_version: CONTRACT_VERSION,
    policy_version: workspace.policy_version,
    root_generation: workspace.generation,
    workspace_id: workspace.id,
    files: digestFiles,
  });

  const change = rig.repos.changes.create({
    id: newLocalId('chg'),
    owner_connection_id: ADAPTER_CONNECTION_ID,
    workspace_id: workspace.id,
    root_generation: workspace.generation,
    policy_version: workspace.policy_version,
    contract_version: CONTRACT_VERSION,
    digest,
    summary: spec.summary,
    expires_at: new Date(Date.now() + LIMITS.CHANGE_TTL_MS).toISOString(),
    items,
  });

  return { change_id: change.id, digest, file_count: items.length };
}

interface Rig {
  readonly opened: OpenDatabaseResult;
  readonly repos: Repositories;
  readonly blobs: BlobStore;
}

// ---------------------------------------------------------------------------
// §9 用的判定：`reviewDecision` 的逐参数复制，只有能力开关不同
// ---------------------------------------------------------------------------

/**
 * 一次**控制台侧**的复核判定，能力开关换成打开的那一份。
 *
 * 这是 `apps/daemon/src/control/changes.ts` 的 `reviewDecision` 的逐参数
 * 复制：同一个 `snapshot_read`、同一条只有 `read` 的能力表、同一份按本次
 * 复核收窄的连接视图、`presented` 同样是 `null`（读取类动作不声称绑定任何
 * 代次）。唯一不同的是能力开关 —— 因为它由装配根注入，而在真装配根上
 * **不可能**打开（见文件头）。除此之外每一层都是真的：真工作区行、
 * 真策略函数、真快照字节。
 */
function reviewDecisionWithOpenGate(
  workspace: WorkspaceRecord,
  flags: CapabilityFlags,
  now: number,
): PolicyDecision {
  return decide({
    connection: {
      connection_id: 'console:evidence',
      enabled: true,
      granted_capabilities: ['read'],
      audience: 'local_console',
      granted_workspace_ids: [workspace.id],
    },
    workspace: workspaceViewOf(workspace, { capability_flags: () => flags }),
    presented: { generation: null, policy_version: null },
    action: { action: 'snapshot_read', path: '', approval: null },
    now,
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('LWB-036 证据采集：修改集复核读取与批准入口（真控制面 + 真数据 + 真判定）');
  console.log(`仓库根 ${repoRoot}`);
  console.log(`Node ${process.version} / ${process.platform} ${process.arch}`);

  const home = await mkdtemp(path.join(os.tmpdir(), 'lwb-036-home-'));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb-036-ws-'));
  const lines: string[] = [];
  let runtime: DaemonRuntime | null = null;
  let rig: Rig | null = null;

  try {
    // =======================================================================
    section('§0 装好：启动生产装配根（根被 --home 覆盖到临时目录）');
    // =======================================================================

    try {
      runtime = await startDaemon({
        argv: [`--home=${home}`],
        env: {},
        log: (line) => lines.push(line),
      });
    } catch (error) {
      if (error instanceof StartupFailed && error.kind === 'already_running') {
        // 这一格**判为失败**而不是记一条说明：本文件的全部结论都建立在
        // 「本进程拥有一条真的在跑的装配根」之上，起不来就是没采集到证据，
        // 而没采集到证据的退出码不能是 0。
        check(
          '§0.0 本进程独占一条真的装配根',
          false,
          '本用户下已有 daemon 在运行（控制管道被占用），后续各节未执行；请先停掉它再采一次',
        );
      } else {
        throw error;
      }
    }

    if (runtime !== null) {
      const facts = runtime.facts;
      check(
        '§0.1 生产装配根起来了，且打印出一个带一次性令牌的回环地址',
        runtime.bootstrap_url.startsWith('http://127.0.0.1:'),
        '地址形状正确（不回显其中的令牌）',
      );
      check('§0.2 启动用的不是受保护目录（这是装置，不是被测对象）', facts.store_root_overridden);
      check(
        '§0.3 四个能力开关全关（真服务端的事实；G0 未通过）',
        !facts.capability_flags.read_enabled &&
          !facts.capability_flags.git_enabled &&
          !facts.capability_flags.proposal_enabled &&
          !facts.capability_flags.direct_write_enabled,
        `读取=${String(facts.capability_flags.read_enabled)} 提议=${String(facts.capability_flags.proposal_enabled)} 直写=${String(facts.capability_flags.direct_write_enabled)}`,
      );
      check(
        '§0.4 门禁四项也全为 false（开关是它们的与运算，不是另一处常量）',
        !facts.gates.g0_platform_verified &&
          !facts.gates.native_guard_verified &&
          !facts.gates.compatibility_section3_passed &&
          !facts.gates.g4_concurrency_fault_passed,
      );
      check('§0.5 启动日志没有一行被凭证筛查拦下', !lines.some((line) => line.includes('被拦截')), `${String(lines.length)} 行日志`);

      const where = parts(runtime.bootstrap_url);

      // =====================================================================
      section('§1 负向：没有会话就没有复核读取（这是本机接口，不是网页接口）');
      // =====================================================================

      // 三次裸调用。**带不带 `Origin` 是两件事**：服务端的次序是
      // 「Host → Sec-Fetch-Site → Origin → Content-Type → 会话 → CSRF → nonce」
      // （control-plane / server.ts 的注释写着这个次序），因此一个不带 Origin
      // 的请求在**会话**之前就被拒了，看不到会话那一层。
      const browserOrigin = { Origin: where.origin };
      const noSessionList = await postRaw(`${where.origin}/api/changes/list`, {}, browserOrigin);
      const noSessionGet = await postRaw(`${where.origin}/api/changes/get`, { change_id: 'chg_不存在' }, browserOrigin);
      const noOrigin = await postRaw(`${where.origin}/api/changes/list`, {}, {});

      check(
        '§1.1 没有会话说不了话：changes.list 在来源合法时答 401（这是本机接口，不是公开端）',
        noSessionList.status === 401,
        `HTTP ${String(noSessionList.status)} ${noSessionList.code}`,
      );
      check(
        '§1.2 changes.get 同样答 401 —— 它不因为「只读」就不要会话',
        noSessionGet.status === 401 && noSessionGet.code === 'NOT_AUTHORIZED',
        `HTTP ${String(noSessionGet.status)} ${noSessionGet.code}`,
      );
      check(
        '§1.3 连 `Origin` 都没有的请求，在**会话之前**就被来源检查拒了（403，不是 401）',
        noOrigin.status === 403,
        `HTTP ${String(noOrigin.status)} ${noOrigin.message}`,
      );
      note(
        '§1.4 「只读」在这里只意味着不要 nonce',
        'control-plane.ts 的 READ_ONLY_OPERATIONS 决定的是**要不要一次性 nonce**（不是要不要会话、也不是要不要来源检查）。凭据形状与路径都进不了这个判断',
      );

      // =====================================================================
      section('§2 兑换真会话，并核对真服务端自报的接口清单');
      // =====================================================================

      const order: string[] = [];
      const history: HistoryLike = {
        replaceState() {
          order.push('strip');
        },
      };
      const jar = cookieJar();
      const session: ConsoleSession | null = await bootstrapConsoleSession({
        location: where,
        history,
        fetchImpl: (async (...args: Parameters<typeof fetch>) => {
          order.push('fetch');
          return jar.fetchImpl(...args);
        }) as typeof fetch,
      });

      check('§2.1 控制台自己的兑换链路能从真地址换到真会话', session !== null && session.session_id.length > 0, 'session_id 由服务端签发（不回显）');
      check('§2.2 地址栏片段在兑换**之前**被抹掉', order.join(',') === 'strip,fetch', order.join(' → '));
      check(
        '§2.3 会话凭证进了 cookie 罐，且带着正确的名字',
        jar.cookie().startsWith(`${CONTROL_COOKIE_NAME}=`),
        `Cookie: ${CONTROL_COOKIE_NAME}=‹已隐去›`,
      );

      const client = new ControlClient({ origin: where.origin, fetchImpl: jar.fetchImpl });
      client.setSession(session);

      // 带上会话 cookie、来源也合法，**只差 CSRF 头**：这样量到的 403
      // 才是 CSRF 那一层的，而不是 §1.3 那个来源检查的。
      const noCsrf = await postRaw(
        `${where.origin}/api/changes/list`,
        {},
        { Cookie: jar.cookie(), Origin: where.origin },
      );
      check(
        '§2.4 有会话但**不带 CSRF 头**的非 GET 请求被拒（这一步与上一步是两件事）',
        noCsrf.status === 403 && noCsrf.message.includes('CSRF'),
        `HTTP ${String(noCsrf.status)} ${noCsrf.message}`,
      );

      // `/api/status` 是** GET** 路由，而 `ControlClient.call` 只发 POST
      // （非 GET 操作才要 CSRF 与 nonce），因此这一格走裸 GET + 会话 cookie。
      // 这与 `ControlClient` 的分工一致：状态是读的，读的不发 nonce。
      const statusRaw = await getRaw(`${where.origin}/api/status`, jar.cookie());
      const statusBody = recordOf(statusRaw.json?.['result']);
      const routes = arrayOf(statusBody?.['routes']).filter((route): route is string => typeof route === 'string');
      check(
        '§2.5 真服务端自报的接口清单里有两条复核读取路由',
        statusRaw.status === 200 &&
          routes.includes('POST /api/changes/list') &&
          routes.includes('POST /api/changes/get'),
        `${String(routes.length)} 条路由`,
      );
      const gateOpeners = routes.filter((route) => /gate|flag|capabilit|enable|permission/i.test(route));
      check(
        '§2.6 清单里没有任何「改门禁 / 改能力开关」的入口（§0.3 的关闭状态不是运行期可改的）',
        gateOpeners.length === 0,
        gateOpeners.join('、') || '一条都不匹配',
      );

      // =====================================================================
      section('§3 真登记一个工作区（nonce + CSRF + Origin 全链路）');
      // =====================================================================

      const alias = '证据工作区';
      const registerBody = { alias, kind: 'directory', path: workspaceRoot, mode: 'read_only' };
      const authorized = await client.authorizeMutation('/api/workspaces/register', alias, registerBody);
      const registered = recordOf(await client.call('/api/workspaces/register', authorized));
      const workspaceId = strOf(registered?.['workspace_id']);
      check('§3.1 登记成功（一次性 nonce 绑定 + CSRF 头 + Origin 全部通过）', workspaceId.length > 0, `workspace_id=${workspaceId}`);
      check('§3.2 服务端回报的根与登记时给出的逐字符相同', registered?.['root'] === workspaceRoot, '路径不做规范化');

      // 工作区文件：真 NTFS 上的真文件。它们**不是**快照的来源
      // （复核读的是 `objects` 里的字节），写在这里是为了 §9.6 能证明
      // 「复核一条修改集不碰用户工作区」。
      const files: readonly SeededFile[] = [
        {
          path: 'src/app.ts',
          op: 'edit_text',
          base_file_id: fileIdOf(1),
          before: '// app\nconst port = 8080;\n',
          after: '// app\nconst port = 9090;\n',
          added_lines: 1,
          removed_lines: 1,
        },
        {
          path: 'docs/readme.md',
          op: 'create_text',
          base_file_id: null,
          before: null,
          after: '# 说明\n\n这是新文件。\n',
          added_lines: 2,
          removed_lines: 0,
        },
        {
          path: 'src/util/format.ts',
          op: 'edit_text',
          base_file_id: fileIdOf(2),
          before: 'export const pad = (n: number) => String(n);\nexport const trim = (s: string) => s.trim();\n',
          after: 'export const pad = (n: number, w = 2) => String(n).padStart(w, "0");\nexport const trim = (s: string) => s.trimEnd();\n',
          added_lines: 2,
          removed_lines: 2,
        },
      ];

      for (const file of files) {
        const target = path.join(workspaceRoot, ...file.path.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.after, 'utf8');
      }

      // =====================================================================
      section('§4 装置：把一条内容真实的修改集放进真库（本文件唯一的合成物）');
      // =====================================================================

      const layout = resolveStoreLayout(home).layout;
      const opened = openDatabase({ path: layout.databaseFile });
      const repos = new Repositories(opened.db);
      const blobs = new BlobStore({ objectsRoot: layout.objects, registry: repos.blobs });
      rig = { opened, repos, blobs };

      note(
        '§4.1 为什么是第二个连接',
        'daemon 正开着同一个库（WAL）。本段用的是真布局（resolveStoreLayout）里的真库文件与真 objects 目录，因此写进去的行与字节，服务端读到的就是同一份',
      );

      const workspace = repos.workspaces.findById(workspaceId);
      if (workspace === null) throw new Error('装置自检失败：刚登记的工作区在库里读不到。');

      const seeded = await seedChange(rig, workspace, { files, summary: '证据：改端口 + 新增说明 + 收紧 trim' });

      // 大范围删除的那一份（§9）。**它只有一个文件**，且删掉的每一行
      // 都是真的删掉了 —— 那份差异是本任务「不得被折叠掩盖」的对象。
      const bigBefore = Array.from({ length: 400 }, (_, i) => `line ${String(i + 1)}`).join('\n') + '\n';
      const bigAfter = Array.from({ length: 400 }, (_, i) => `line ${String(i + 1)}`).filter((_, i) => i % 40 === 0).join('\n') + '\n';
      const bigSeeded = await seedChange(rig, workspace, {
        files: [
          {
            path: 'src/big.ts',
            op: 'edit_text',
            base_file_id: fileIdOf(3),
            before: bigBefore,
            after: bigAfter,
            added_lines: 0,
            removed_lines: bigBefore.split('\n').length - bigAfter.split('\n').length,
          },
        ],
        summary: '证据：一次删掉三百多行的改动',
      });

      check(
        '§4.2 两条修改集都落进了真库（从第二个连接读回来）',
        repos.changes.findById(seeded.change_id) !== null && repos.changes.findById(bigSeeded.change_id) !== null,
        `第一条 ${String(seeded.file_count)} 个文件`,
      );
      check(
        '§4.3 摘要由 canonicalChangeDigest 真算，且与落库的那一份相同',
        repos.changes.findById(seeded.change_id)?.digest === seeded.digest,
        `短编号 ${seeded.digest.slice(0, 8).toUpperCase()}`,
      );
      check(
        '§4.4 两条都属于那条模型侧连接（控制台不是提议方，这正是它需要另一条读取路径的原因）',
        repos.changes.findById(seeded.change_id)?.owner_connection_id === ADAPTER_CONNECTION_ID,
      );

      // =====================================================================
      section('§5 真 HTTP：列表');
      // =====================================================================

      const listRaw = recordOf(await client.call('/api/changes/list', {}));
      const rows = arrayOf(listRaw?.['changes']).map((row) => recordOf(row)).filter((row) => row !== null);
      check(
        '§5.1 changes.list 从真服务端拿回两行（列表是复核的入口）',
        rows.length === 2,
        `${String(rows.length)} 行`,
      );
      check(
        '§5.2 每一行都带 owner_connection_id —— 控制台要回答「这是谁提议的」',
        rows.length > 0 && rows.every((row) => typeof row?.['owner_connection_id'] === 'string'),
      );
      const firstRow = rows.find((row) => row?.['change_id'] === seeded.change_id);
      check(
        '§5.3 行里的 file_count 与库里逐条数出来的一致（不是列表自己编的）',
        numOf(firstRow?.['file_count']) === repos.changes.items(seeded.change_id).length,
        `file_count=${String(numOf(firstRow?.['file_count']))}`,
      );
      check(
        '§5.4 truncated 为假，observed_at 是这一次的读数时刻',
        listRaw?.['truncated'] === false &&
          typeof listRaw?.['observed_at'] === 'string' &&
          Math.abs(Date.now() - Date.parse(strOf(listRaw?.['observed_at']))) < 60_000,
        strOf(listRaw?.['observed_at']),
      );

      const emptyList = recordOf(
        await client.call('/api/changes/list', { workspace_id: 'ws_不存在的工作区' }),
      );
      check(
        '§5.5 非空对照：过滤到一个不存在的工作区是**空列表**，不是拒绝',
        arrayOf(emptyList?.['changes']).length === 0 && rows.length > 0,
        '0 行 / 2 行',
      );

      // =====================================================================
      section('§6 真 HTTP：详情（不带 path，回的是事实而不是正文）');
      // =====================================================================

      const detailRaw = await client.call('/api/changes/get', { change_id: seeded.change_id });
      const detail: ChangeDetail | null = parseChangeDetail(detailRaw);
      check('§6.1 控制台的解析器认得真服务端的 changes.get 响应', detail !== null, detail === null ? '解析失败（缺字段或类型不对）' : '');

      const change: ChangeSetView | null = detail?.change ?? null;
      const serverPaths = (change?.files ?? []).map((file) => file.path);
      const dbPaths = repos.changes.items(seeded.change_id).map((item) => item.canonical_path);
      check(
        '§6.2 逐文件清单来自服务端，且与库里逐条一致',
        serverPaths.length === 3 && serverPaths.join(',') === dbPaths.join(','),
        serverPaths.join('、'),
      );
      // 逐文件的增删行数与风险条目：**两者都从落库的统计量重算**，
      // 而重算函数就是服务端那一个（`changeSetViewOf` → `deriveRisks`）。
      // 于是这一条比的是「控制台解析出来的」与「按库里的行再算一遍的」，
      // 而不是「服务端说的」与「服务端说的」。
      const dbItems = repos.changes.items(seeded.change_id);
      const addedSum = (change?.files ?? []).reduce((total, file) => total + file.added_lines, 0);
      const removedSum = (change?.files ?? []).reduce((total, file) => total + file.removed_lines, 0);
      const dbAdded = dbItems.reduce((total, item) => total + item.added_lines, 0);
      const dbRemoved = dbItems.reduce((total, item) => total + item.removed_lines, 0);
      check(
        '§6.3 变更统计是事实：增删行数与库里逐条相加一致',
        change !== null && addedSum === dbAdded && removedSum === dbRemoved && addedSum + removedSum > 0,
        `增 ${String(addedSum)} / 删 ${String(removedSum)} 行`,
      );
      check(
        '§6.4 风险汇总来自服务端重算（与按库里那些行再算一遍逐字相同），不是界面自己编的',
        change !== null && JSON.stringify(change.risks) === JSON.stringify(deriveRisks(dbItems)),
        change === null ? '—' : change.risks.map((risk) => risk.code).join('、') || '（这一类改动没有风险条目）',
      );
      check(
        '§6.5 响应里**没有**本机绝对路径（工作区那一格刻意不给 canonical_root）',
        JSON.stringify(detailRaw).includes(workspaceRoot) === false &&
          JSON.stringify(detailRaw).includes('canonical_root') === false,
      );
      check(
        '§6.6 还没有批准记录（批准是操作者的动作，复核读取不会顺手造一个）',
        detail?.approval === null || detail?.approval === undefined,
        detail?.approval === null ? 'approval 为空' : '有值',
      );

      const gate: ContentGate | null = detail?.content_gate ?? null;
      check(
        '§6.7 闸门那一格如实说「不给内容」，理由是稳定 slug 而不是一句话',
        gate !== null && gate.allows_read === false && gate.reason === 'CAPABILITY_FLAG_DISABLED',
        `${String(gate?.reason)}`,
      );
      check(
        '§6.8 这一格在**要内容之前**就能问到（翻页之前就把「看不到」说出来）',
        typeof detail?.observed_at === 'string',
        `observed_at ${strOf(detail?.observed_at)}`,
      );

      // =====================================================================
      section('§7 带 path 的那一次：拒绝的形状（这一节是本次修掉的那处缺陷的判据）');
      // =====================================================================

      let refusal: { status: number; code: string; message: string } | null = null;
      try {
        await client.call('/api/changes/get', { change_id: seeded.change_id, path: 'src/app.ts' });
      } catch (error) {
        if (error instanceof Error && 'detail' in error) {
          const detailOf = (error as { detail: { status: number; code: string; message: string } }).detail;
          refusal = { status: detailOf.status, code: detailOf.code, message: detailOf.message };
        } else {
          refusal = { status: 0, code: 'THREW', message: error instanceof Error ? error.message : String(error) };
        }
      }
      check('§7.1 要正文被拒（闸门关着就不给内容）', refusal !== null && refusal.status !== 200, JSON.stringify(refusal));
      check(
        '§7.2 拒绝的形状是 POLICY_DENIED / 400，**不是** INTERNAL_ERROR / 500',
        refusal?.code === 'POLICY_DENIED' && refusal.status === 400,
        `HTTP ${String(refusal?.status)} ${String(refusal?.code)}`,
      );
      check(
        '§7.3 消息是策略的话，不是「本地服务内部错误。」',
        refusal !== null && refusal.message.length > 0 && !refusal.message.includes('内部错误'),
        refusal?.message ?? '—',
      );
      note(
        '§7.4 这三条在修复之前会是什么样',
        '缺了 changes.ts 里那句「要内容之前先看闸门」时：`changeDiffPageOf` 会先把两侧快照读进内存，然后在 `mintClearance` 抛出一个**裸 Error**（packages/egress 抛的不是 BridgeError），server.ts 把它折成 500 / INTERNAL_ERROR /「本地服务内部错误。」。于是「工作区被暂停」在界面上显示成「服务器出错了」。§7.2 与 §7.3 就是这条链上量得到的判据',
      );
      note(
        '§7.5 「一个字节都没读」这条在本文件里量不到',
        '它要的是一个空的 objects 目录（那时若仍答策略拒绝，就说明没去读快照）。那一条在 tests/unit/control-changes.test.ts 的 B1b 里断言',
      );

      // =====================================================================
      section('§8 验收标准 (a)：批准入口与「看过什么」一一对应');
      // =====================================================================

      const presence = { session_id: session?.session_id ?? '' };
      const now = new Date().toISOString();

      /**
       * 闸门那一格在这一节被换成「允许」。
       *
       * 真服务端今天恒给拒绝（§6.6 实测），而这一节要证的是**闸门允许之后**
       * 的那条判定链。换掉的是这一格，不是文件清单 —— 清单来自 §6 的真响应。
       */
      const gateOpen: ContentGate = { allows_read: true, reason: null, message: null };

      /** 进度是**操作者行为的替身**：只有人能说「我看过了」。文件清单是真的。 */
      const progressOf = (seen: readonly string[], truncated: readonly string[] = []): readonly DiffProgress[] =>
        (change?.files ?? []).map((file) => ({
          path: file.path,
          pages: seen.includes(file.path) ? 1 : 0,
          reached_end: seen.includes(file.path) && !truncated.includes(file.path),
          full_texts: false,
        }));

      const partial = reviewCoverageOf({
        change,
        progress: progressOf(['src/app.ts']),
        gate: gateOpen,
      });
      const partialAffordance = approvalAffordance({ session: presence, change, coverage: partial, now });

      check(
        '§8.1 只看了一个文件：覆盖是不完整的，且缺口**按路径点名**',
        partial.status === 'incomplete' &&
          partial.covered_count === 1 &&
          partial.total_count === 3 &&
          partial.unseen.join(',') === 'docs/readme.md,src/util/format.ts',
        partial.unseen.join('、'),
      );
      check(
        '§8.2 那个文件从未显示过 ⇒ 批准入口消失，理由是 UNSEEN_FILES',
        partialAffordance.can_approve === false && partialAffordance.blocked_reason === 'UNSEEN_FILES',
        partialAffordance.message,
      );
      check(
        '§8.3 但**拒绝**仍然给得出来（没看完也能说「不」）',
        partialAffordance.can_reject === true,
      );

      const full = reviewCoverageOf({ change, progress: progressOf(serverPaths), gate: gateOpen });
      const fullAffordance = approvalAffordance({ session: presence, change, coverage: full, now });
      check(
        '§8.4 三个文件都看过 ⇒ 覆盖完整，批准入口出现',
        full.status === 'complete' && fullAffordance.can_approve === true,
        fullAffordance.message,
      );
      check(
        '§8.5 那句话里的文件数就是服务端清单的长度（不是界面自己数出来的数）',
        fullAffordance.message.includes(String(serverPaths.length)) &&
          change?.files?.length === serverPaths.length,
        `${String(serverPaths.length)} 个文件`,
      );
      check(
        '§8.6 批准动作的幂等键绑的是**这一份摘要**（换一份内容就是一个不同的键）',
        change !== null && approvalIdempotencyKey(change).includes(change.short_code) &&
          approvalIdempotencyKey(change).startsWith('console-approve:'),
        change === null ? '—' : approvalIdempotencyKey(change),
      );

      // 多一个文件会怎样：清单里多出来的那一个**必然**落进 unseen，
      // 因为覆盖是按服务端给的清单逐条算的，而进度里没有它。
      //
      // 这一格模拟的是**摘要里多一个文件、而界面没有展示**那个形状 ——
      // 也就是这条验收标准要防的那件事。多出来的那一条由第一条复制而来，
      // 只换路径；它是不是一份「真实」的文件预览在这里不重要（这一层
      // 不读内容），重要的是**清单与进度之间的差**会被算出来。
      const firstFile = change?.files?.[0];
      const withExtra =
        change === null || firstFile === undefined
          ? null
          : reviewCoverageOf({
              change: { ...change, files: [...change.files, { ...firstFile, path: 'src/extra/从未展示.ts' }] },
              progress: progressOf(serverPaths),
              gate: gateOpen,
            });
      check(
        '§8.7 反例：清单里多出一个进度里没有的文件 ⇒ 立刻回到 UNSEEN_FILES（不会「默认认为看过」）',
        withExtra !== null && withExtra.status === 'incomplete' && withExtra.unseen.length === 1,
        withExtra === null ? '清单为空，这一条不成立' : `缺口 ${String(withExtra.unseen.length)} 个：${withExtra.unseen.join('、')}`,
      );

      const realGate = reviewCoverageOf({ change, progress: progressOf(serverPaths), gate });
      const realAffordance = approvalAffordance({ session: presence, change, coverage: realGate, now });
      check(
        '§8.8 **真闸门**（§6.6 实测的那一格）+ 完整进度 ⇒ unavailable，而不是 complete',
        realGate.status === 'unavailable' && realAffordance.can_approve === false,
        realAffordance.message,
      );
      check(
        '§8.9 理由不是「你没看」，而是「看不到」—— 两者要给的下一步不同',
        realAffordance.blocked_reason === 'CONTENT_UNAVAILABLE' &&
          realGate.files.every((file) => file.reason === 'GATE_DENIED'),
        '全部文件标为 GATE_DENIED',
      );

      // =====================================================================
      section('§9 步骤 3：大范围删除不得被折叠掩盖（本段就地打开闸门）');
      // =====================================================================

      note(
        '§9.1 这一段为什么就地打开闸门',
        '内容出站要 `read_enabled`，而真装配根上它恒为 false（§0.3）；没有内容就量不到「大范围删除长什么样」。打开的是**能力开关那一格**，其余每一层都是真的：真库、真 objects、真 diffLines、真出站闸门（`mintClearance` + `emitContent`）',
      );

      const openFlags: CapabilityFlags = {
        read_enabled: true,
        git_enabled: false,
        proposal_enabled: false,
        direct_write_enabled: false,
        recovery_required: false,
      };
      const budgets = new EgressBudgetStore({ limit_bytes_per_hour: LIMITS.EGRESS_BYTES_PER_HOUR, now: Date.now });
      const bigRecord = repos.changes.requireById(bigSeeded.change_id);
      const bigItems = repos.changes.items(bigSeeded.change_id);

      const bigDetailRaw = recordOf(await client.call('/api/changes/get', { change_id: bigSeeded.change_id }));
      const bigView = parseChangeDetail(bigDetailRaw)?.change ?? null;

      const fingerprintsBefore = new Map<string, string>();
      for (const file of files) {
        fingerprintsBefore.set(file.path, sha256(await readFile(path.join(workspaceRoot, ...file.path.split('/')), 'utf8')));
      }

      const render = async (limits: Partial<ChangeQueryLimits>): Promise<ChangeDiffPage> =>
        changeDiffPageOf({
          record: bigRecord,
          items: bigItems,
          path: 'src/big.ts',
          context: {
            connection_id: 'console:evidence',
            scope: { generation: workspace.generation },
            decision: reviewDecisionWithOpenGate(workspace, openFlags, Date.now()),
            budget: budgets.forConnection('console:evidence'),
          },
          limits: { ...DEFAULT_CHANGE_QUERY_LIMITS, ...limits },
          deps: { repos, blobs, limits },
        });

      const fullPage = await render({});
      const fullLines = fullPage.unified.split('\n');
      const deleted = fullLines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
      check(
        '§9.2 三百多行的删除，一行不少地出现在差异里（默认上限装得下）',
        fullPage.truncated === false && deleted >= 300,
        `删除行 ${String(deleted)} 行 / truncated=${String(fullPage.truncated)}`,
      );
      check(
        '§9.3 差异里没有任何自家格式的行（没有「… 折叠 N 行 …」这种标记）',
        fullLines.every((line) => line === '' || ' -+@'.includes(line[0] ?? '')),
        `首字符集合 ${[...new Set(fullLines.map((line) => line[0] ?? ''))].join('')}`,
      );
      check(
        '§9.4 差异头写的是 a/ 与 b/（不是把旧侧写成「空文件」）',
        fullLines[0] === '--- a/src/big.ts' && fullLines[1] === '+++ b/src/big.ts',
        `${String(fullLines[0])} / ${String(fullLines[1])}`,
      );

      // 把字节上限压到 2 KiB，逼出一次真截断。
      const tightPage = await render({ max_diff_output_bytes: 2048 });
      const tightLines = tightPage.unified.split('\n');
      check(
        '§9.5 撞上字节上限时 truncated 置真，且**不发出下一页的游标**',
        tightPage.truncated === true && tightPage.next_cursor === null,
        `truncated=${String(tightPage.truncated)} next_cursor=${String(tightPage.next_cursor)}`,
      );
      // 截断**发生在行边界**，而不是丢掉整条 hunk —— 这一点是本文件第一版
      // 写错的地方（当时断言「截断后的每一行都原样存在于完整版里」，它
      // 失败在 hunk **头**上：那条 hunk 的头在完整版里不存在，因为
      // 截断之后它的 `old_lines/new_lines` 被重数过了）。
      //
      // 真行为在 `packages/files/src/text-diff.ts` 的 `groupHunks` 里：
      // 逐行累加字节，装不下就**停止**，并且用**实际推入的行**重数
      // `old_lines` / `new_lines`。于是半条 hunk 的行号仍然是真的，
      // 而「装不下」由 `truncated` 说出来。（只有一行都放不下时才整条丢掉。）
      //
      // 于是这里判的是那条真正重要的事：**屏幕上出现的每一行，都是源文件
      // 里真实存在的一行**。没有半行、没有「…此处省略 N 行…」这种自家造的
      // 标记 —— 后者正是「折叠策略掩盖大范围删除」的形状：它让一次删掉
      // 三百行的改动看起来像一个说明。
      const sourceLines = new Set<string>([...bigBefore.split('\n'), ...bigAfter.split('\n')]);
      const tightBody = tightLines.filter(
        (line) => !line.startsWith('@@') && !line.startsWith('---') && !line.startsWith('+++'),
      );
      const sliced = tightBody.filter((line) => !sourceLines.has(line.slice(1)));
      check(
        '§9.6 截断发生在行边界：每条差异行去掉前缀后都是源文件里真实存在的一行（没有半行，也没有自家造的折叠标记）',
        tightBody.length > 0 && sliced.length === 0,
        sliced.length === 0
          ? `${String(tightBody.length)} 行逐条核对`
          : sliced.slice(0, 3).map((line) => JSON.stringify(line)).join(' '),
      );

      // 截断之后 hunk 头里的行数与它实际带的行是否仍然一致。这就是
      // `groupHunks` 注释里点名的那条风险（「行号与行数会对不上」）：
      // 一条自称带 215 行、实际只带 12 行的 hunk，会让按行号定位的
      // 读法落在错误的位置上。
      interface HunkStat {
        readonly declared_old: number;
        readonly declared_new: number;
        old_seen: number;
        new_seen: number;
      }
      const hunkStats: HunkStat[] = [];
      for (const line of tightLines) {
        const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(line);
        if (header !== null) {
          hunkStats.push({
            declared_old: Number(header[2]),
            declared_new: Number(header[4]),
            old_seen: 0,
            new_seen: 0,
          });
          continue;
        }
        const current = hunkStats.at(-1);
        if (current === undefined) continue;
        const kind = line[0] ?? '';
        if (kind !== '+') current.old_seen += 1;
        if (kind !== '-') current.new_seen += 1;
      }
      const mismatched = hunkStats.filter(
        (stat) => stat.declared_old !== stat.old_seen || stat.declared_new !== stat.new_seen,
      );
      check(
        '§9.6b 截断之后 hunk 头里的行数与它实际带的行一致（截断不会让行号对不上）',
        hunkStats.length > 0 && mismatched.length === 0,
        hunkStats.length === 0
          ? '一条 hunk 都没有'
          : `${String(hunkStats.length)} 条 hunk，${String(mismatched.length)} 条对不上`,
      );

      const tightText: FileText = {
        before: null,
        after: null,
        unified: tightPage.unified,
        unified_truncated: true,
        pages: 1,
      };
      const tightCoverage = reviewCoverageOf({
        change: bigView,
        progress: progressFromTexts({ 'src/big.ts': tightText }),
        gate: gateOpen,
      });
      const tightAffordance = approvalAffordance({ session: presence, change: bigView, coverage: tightCoverage, now });
      check(
        '§9.7 被截断的那一份算作「没看全」⇒ 批准入口消失，理由是 TRUNCATED_DIFF',
        tightCoverage.status === 'incomplete' &&
          tightAffordance.can_approve === false &&
          tightAffordance.blocked_reason === 'TRUNCATED_DIFF',
        tightCoverage.truncated.join('、'),
      );
      check(
        '§9.8 对照：同一份差异在默认上限下读到末尾 ⇒ 算看全了（不是因为「它很大」被拦）',
        reviewCoverageOf({
          change: bigView,
          progress: progressFromTexts({
            'src/big.ts': { before: null, after: null, unified: fullPage.unified, unified_truncated: false, pages: 1 },
          }),
          gate: gateOpen,
        }).status === 'complete',
      );
      note(
        '§9.9 「默认不提供部分批准」在这里的落点',
        '批准绑的是整份摘要（canonicalChangeDigest 覆盖全部文件），而批准入口要求覆盖 `complete` —— 于是「只批准一部分」在界面上没有对应的动作。要改一部分，只能让模型重新提议一条新的修改集',
      );

      const fingerprintsAfter = new Map<string, string>();
      for (const file of files) {
        fingerprintsAfter.set(file.path, sha256(await readFile(path.join(workspaceRoot, ...file.path.split('/')), 'utf8')));
      }
      check(
        '§9.10 复核读的是快照，不是用户工作区：跑完这一节之后工作区里的字节一个都没变',
        files.every((file) => fingerprintsBefore.get(file.path) === fingerprintsAfter.get(file.path)),
      );

      // 逐文件翻页与键盘（步骤 1 的后半句）
      check(
        '§9.11 键盘能翻文件，且两条键指向**同一个**动作（不可能到达不同的地方）',
        actionFor('j') === 'next-file' && actionFor('ArrowDown') === 'next-file' && actionFor('x') === null,
      );
      check(
        '§9.12 到边界是**停住**，不绕回开头（绕回会让「看完了」与「清单变短了」长得一样）',
        stepFile(2, 3, 1) === 2 && stepFile(0, 3, -1) === 0 && clampIndex(9, 3) === 2,
        `第 ${String(stepFile(2, 3, 1) + 1)} / 3 个文件`,
      );
      check(
        '§9.13 位置说明只说知道的两件事（已取回几页、到没到末尾），不编一个分母',
        positionLabel(0, 3, 1, true).includes('第 1 / 3 个文件') &&
          positionLabel(0, 3, 1, true).includes('已到末页') &&
          positionLabel(0, 3, 0, null).includes('尚未载入'),
        positionLabel(0, 3, 1, true),
      );

      // =====================================================================
      section('§10 步骤 2：状态实时更新只走本地认证接口');
      // =====================================================================

      check(
        '§10.1 刷新的目标是一个**同源路径**，不是一条绝对地址（没有主机可填）',
        REFRESH_ENDPOINT === 'POST /api/changes/get' && !/^https?:/.test(REFRESH_ENDPOINT),
        REFRESH_ENDPOINT,
      );

      const t0 = Date.now();
      const pending = refreshDecisionOf({
        state: 'PENDING_APPROVAL',
        visible: true,
        consecutive_failures: 0,
        last_poll_at: null,
        now: t0,
      });
      const hidden = refreshDecisionOf({
        state: 'PENDING_APPROVAL',
        visible: false,
        consecutive_failures: 0,
        last_poll_at: null,
        now: t0,
      });
      const lost = refreshDecisionOf({
        state: 'PENDING_APPROVAL',
        visible: true,
        session_expired: true,
        consecutive_failures: 1,
        last_poll_at: null,
        now: t0,
      });
      check(
        '§10.2 待批准且页面在前台：问一次，并按间隔排下一次',
        pending.poll === true && pending.reason === 'DUE' && pending.next_delay_ms !== null,
        `${String(pending.next_delay_ms)} ms`,
      );
      check(
        '§10.3 页面不在前台：不排下一次，等一个事件叫醒（不靠轮询维持）',
        hidden.poll === false && hidden.next_delay_ms === null && hidden.reason === 'HIDDEN',
      );
      check(
        '§10.4 会话没了：停止，且理由与「后台暂停」分开',
        lost.stop === true && lost.reason === 'SESSION_LOST',
        lost.message,
      );

      // 真状态变化：把大删除那一条推进终态，再问一次刷新怎么走。
      repos.changes.transition(bigSeeded.change_id, ['PENDING_APPROVAL'], 'REJECTED');
      const afterReject = parseChangeDetail(recordOf(await client.call('/api/changes/get', { change_id: bigSeeded.change_id })));
      const terminal = refreshDecisionOf({
        state: afterReject?.change.state ?? 'PENDING_APPROVAL',
        visible: true,
        consecutive_failures: 0,
        last_poll_at: null,
        now: t0,
      });
      check(
        '§10.5 服务端上的状态**真的变了**，控制台读到的是新状态',
        afterReject?.change.state === 'REJECTED',
        `state=${String(afterReject?.change.state)}`,
      );
      check(
        '§10.6 终态 ⇒ 停止刷新（不再问一个不会变的东西）',
        terminal.stop === true && terminal.next_delay_ms === null && terminal.reason === 'TERMINAL',
        terminal.message,
      );
      check(
        '§10.7 终态之后也没有批准入口了（状态排在覆盖之前判定）',
        approvalAffordance({ session: presence, change: afterReject?.change ?? null, coverage: full, now }).blocked_reason ===
          'WRONG_STATE',
      );

      // 同一次点击别发两次请求（验收标准 (b) 的界面侧那一半）
      const flight = new SingleFlight();
      let calls = 0;
      const task = async (): Promise<string> => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'ok';
      };
      const both = await Promise.all([flight.run('k', task), flight.run('k', task)]);
      check(
        '§10.8 同键在途请求只发一次（服务端那两道才是权威，这是第一道）',
        calls === 1 && both[0] === 'ok' && both[1] === 'ok',
        `实际发起 ${String(calls)} 次`,
      );

      // =====================================================================
      section('§11 验收标准 (c)：静态资源全部本地加载');
      // =====================================================================

      const consoleRoots = ['src', 'views', 'components'].map((dir) => path.join(repoRoot, 'apps', 'console', dir));
      const scanned: string[] = [];
      for (const root of consoleRoots) {
        for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const full = path.join(entry.parentPath, entry.name);
          if (!/\.(ts|vue|css|html)$/.test(entry.name)) continue;
          scanned.push(full);
        }
      }

      const externalRefs: string[] = [];
      const externalInCode: string[] = [];
      const modelSideRefs: string[] = [];
      const loadable = /(?:^|\s)(?:src|href)\s*=\s*["']https?:|\bfetch\(\s*["'`]https?:|url\(\s*["']?https?:|@import\s+(?:url\()?["']?https?:/i;
      // 回环判定要认三种写法：`http://127.0.0.1:PORT/…`、**没有端口的**
      // `http://127.0.0.1`（回环白名单自己就是这么写的）、
      // `http://127.0.0.1:<端口>`（给操作者看的模板）、以及 `http://[::1]`
      // （方括号是地址的一部分，因此不能把它从匹配里切掉）。
      // 判据落在**主机**上，主机之后的写法不参与判断 —— 但主机本身必须是
      // 完整的（`localhost.evil.com` 不算回环，靠末尾那个 `[^\w.]` 挡掉）。
      const loopback = /^https?:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?=$|[:/?#]|[^\w.])/;
      for (const file of scanned) {
        const text = await readFile(file, 'utf8');
        const codeLines = text
          .split('\n')
          .filter((line) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(line));
        for (const line of codeLines) {
          if (loadable.test(line)) externalRefs.push(`${path.basename(file)}: ${line.trim().slice(0, 60)}`);
          for (const match of line.matchAll(/https?:\/\/[^\s"'`]+/g)) {
            // 行尾的标点属于句子，不属于地址。
            const url = match[0].replace(/[),.;]+$/, '');
            if (!loopback.test(url)) externalInCode.push(`${path.basename(file)}: ${url}`);
            if (/(?:chatgpt|openai)\.com|oaiusercontent|tunnel/i.test(url)) {
              modelSideRefs.push(`${path.basename(file)}: ${url}`);
            }
          }
        }
      }

      check(
        '§11.1 界面代码里没有一处可加载的外部引用（src= / href= / fetch( / url( / @import）',
        externalRefs.length === 0,
        externalRefs.length === 0 ? `扫了 ${String(scanned.length)} 个文件` : externalRefs.slice(0, 3).join(' | '),
      );
      check(
        '§11.2 代码行里出现的绝对地址只有回环（注释行不计，那是引用外部资料的地方）',
        externalInCode.length === 0,
        externalInCode.length === 0 ? '未命中' : externalInCode.slice(0, 3).join(' | '),
      );

      // 跟踪指纹要带**主机名或调用形状**。第一版只写了裸词 `sentry`，
      // 于是 `SuspiciousEntry`（`…ousEntry`）在大小写不敏感下命中了 ——
      // 一个「第三方跟踪」的判据被自己代码里的一个类型名触发，
      // 是这类扫描最常见的假阳性形状。
      const trackerHits: string[] = [];
      for (const file of scanned) {
        const text = await readFile(file, 'utf8');
        if (
          /google-analytics\.com|googletagmanager\.com|gtag\s*\(|doubleclick\.net|hotjar\.com|mixpanel\.com|segment\.(?:io|com)|sentry\.(?:io|com)/i.test(
            text,
          )
        ) {
          trackerHits.push(path.basename(file));
        }
      }
      check(
        '§11.3 没有任何第三方跟踪脚本的引用',
        trackerHits.length === 0,
        trackerHits.length === 0 ? `${String(scanned.length)} 个文件里未命中` : trackerHits.join(' | '),
      );

      // 客户端**构造**时就拒绝非回环 origin：这不是「检查一下」，是构造失败。
      let loopbackRefused = false;
      try {
        new ControlClient({ origin: 'https://example.com', fetchImpl: jar.fetchImpl });
      } catch {
        loopbackRefused = true;
      }
      check(
        '§11.4 指向外部主机的客户端**构造**就失败（凭据与请求体没有一条路能出去）',
        loopbackRefused,
      );
      // 步骤 2 的另一半：状态变化靠**本地问**，不靠向模型侧推一条消息把它叫醒。
      // 判据是「界面代码里没有一个指向模型侧的地址」，而不是「这些词没出现过」
      // —— 它们当然出现过，出现在**给操作者看的文案**里（「内容仍会经由隧道
      // 发往 ChatGPT」「G0 未通过：真实 ChatGPT 网页会话…未经验证」），
      // 那些是说明，不是出口。
      check(
        '§11.5 界面代码里的绝对地址没有一个指向模型侧（没有「向 ChatGPT 推送唤醒」这条路）',
        modelSideRefs.length === 0,
        modelSideRefs.length === 0 ? `扫了 ${String(scanned.length)} 个文件的代码行` : modelSideRefs.slice(0, 3).join(' | '),
      );
      note(
        '§11.6 今天还没有宿主页面',
        '`apps/console` 下没有 index.html 与入口脚本（托管是 LWB-039 的交付物）：上面扫的是界面代码这一层。「页面在浏览器里真的不加载外部资源」要等有了宿主页面才谈得上',
      );

      // =====================================================================
      section('§12 真测试运行（实际命令 / 环境 / 退出码）');
      // =====================================================================

      const vitestEntry = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
      const vitestRun = exec(process.execPath, [vitestEntry, 'run'], path.join(repoRoot, 'apps', 'console'));
      const vitestOut = `${vitestRun.stdout}\n${vitestRun.stderr}`;
      for (const line of vitestOut.split('\n').filter((l) => /Test Files|Tests  /.test(l))) {
        emit(`  ${line.trim()}`);
      }
      const vitestCounts = /Tests\s+(\d+) passed/.exec(vitestOut);
      check(
        '§12.1 界面层（.vue + 视图模型）的 DOM 断言全部通过',
        vitestRun.code === 0 && vitestCounts !== null,
        vitestCounts === null ? `退出码 ${String(vitestRun.code)}` : `${vitestCounts[1]} 个用例`,
      );

      const unitRun = exec(
        process.execPath,
        [path.join(repoRoot, 'scripts', 'run-tests.mjs'), 'tests/unit', '--grep', 'control-changes'],
        repoRoot,
      );
      const unitOut = `${unitRun.stdout}\n${unitRun.stderr}`;
      for (const line of unitOut.split('\n').filter((l) => /^# (tests|pass|fail) /.test(l))) {
        emit(`  ${line}`);
      }
      check(
        '§12.2 复核读取的单元用例全部通过（真 SQLite + 真 BlobStore + 真 decide）',
        unitRun.code === 0,
        `退出码 ${String(unitRun.code)}`,
      );

      const windowsRun = exec(
        process.execPath,
        [path.join(repoRoot, 'scripts', 'run-tests.mjs'), 'tests/windows', '--grep', 'daemon-apply-tool'],
        repoRoot,
      );
      const windowsOut = `${windowsRun.stdout}\n${windowsRun.stderr}`;
      for (const line of windowsOut.split('\n').filter((l) => /^# (tests|pass|fail) /.test(l))) {
        emit(`  ${line}`);
      }
      check(
        '§12.3 验收标准 (b) 的那条用例通过（本地点击与工具调用同时发生只执行一次）',
        windowsRun.code === 0,
        `退出码 ${String(windowsRun.code)}`,
      );
    }

    // =======================================================================
    section('§13 自查：打印出去的东西里既没有本机路径，也没有凭证');
    // =======================================================================

    const leaky = printed.filter((line) => /[A-Za-z]:\\/.test(line));
    check('§13.1 本次运行打印的每一行都已被遮罩', leaky.length === 0, leaky.length === 0 ? `${String(printed.length)} 行` : leaky.slice(0, 3).join(' | '));

    // 凭证形状**不在这里另写一份**：用 `@lwb/contracts` 声明的那一个 ——
    // 与 `packages/egress` 筛查模型可见内容用的是同一条规则。自查规则与
    // 真正的出站规则分成两份，就会出现「自查说干净、出口漏了」这种组合。
    const credentialShape = new RegExp(CONTROL_TOKEN_PATTERN_SOURCE, 'g');
    const leakySecrets = printed.filter((line) => credentialShape.test(line));
    check(
      '§13.2 每一行打印出去的字都不含控制平面凭证的形状',
      leakySecrets.length === 0,
      leakySecrets.length === 0 ? `按 contracts 的规则扫了 ${String(printed.length)} 行` : `${String(leakySecrets.length)} 行命中`,
    );

    // =======================================================================
    section('未执行项（不得记为通过）');
    // =======================================================================

    skip('在浏览器里点开复核页看一遍', '本文件的证据是「真响应 → 控制台判定」这条链，不是视觉还原；`apps/console` 今天没有宿主页面（§11.6），托管是 LWB-039 的交付物');
    skip('读屏软件实测键盘可达性', '按键映射与翻页判据在 §9.11 ~ §9.13 里量到了（且按钮是原生 <button>）；「读屏软件实际怎么念」没有测过');
    skip('在真装配根上读到**文件正文**', '四个能力开关全关（§0.3），因此今天控制台拿不到任何正文 —— 这是 §7 / §8.8 量到的那个状态，不是本文件的缺口');
    skip('真实网页端（ChatGPT）的端到端验收', 'LWB-002 仍为 BLOCKED：需要操作者在 platform.openai.com 侧创建 tunnel_id、签发 runtime key、关联工作区并开启开发者模式。MCP Inspector 的成功不能替代它');
    skip('在真实工作区上联调读写', 'G2 未通过；P3 门禁：可在契约冻结前提下继续实现，但不得在真实仓库上联调（docs/evidence/g2-read.md）');
    skip('批准并应用（点上那个按钮之后的事）', 'LWB-021 / LWB-032 的交付物，那两份证据里各有一条完整的链（真 approvals 行 + 真护栏写入 + 真回执）；本文件量的是**按钮该不该出现**');
    skip('控制台与模型侧逐字节看到同一份差异', '需要一份工具面上下文（模型侧连接 + 已授予的能力），而真装配根今天不产生任何一份。断言在 tests/unit/control-changes.test.ts 的 B3（真 decide + 同一批字节）');
  } finally {
    if (rig !== null) {
      closeDatabase(rig.opened.db);
    }
    if (runtime !== null) {
      await runtime.shutdown().catch((error: unknown) => {
        emit(`NOTE 清理：关闭 daemon 时失败 — ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    await rm(home, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }

  emit(`\n${failures === 0 ? 'ALL PASS' : `${String(failures)} FAILED`} — ${String(passes)} PASSED / ${String(failures)} FAILED / ${String(skips)} NOT_RUN`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
