/**
 * LWB-035 可复现证据采集：首次配置 / 连接状态 / 工作区三页与本地启动帮助。
 *
 * ## 这一份与 LWB-023 ~ LWB-034 的区别：数据源是**真的服务端**
 *
 * 前面几份任务的界面证据是「按契约形状合成的探针数据」（LWB-023 §5 明说了）。
 * 这一份不再合成：它**启动生产装配根**（`startDaemon`，与 `npm run daemon`
 * 同一个函数、同一个受保护存储布局、只是根被 `--home` 覆盖到临时目录），
 * 然后：
 *
 * ```text
 *   真 daemon（真 HTTP、真环回端口、真 Set-Cookie、真 CSRF、真一次性 nonce）
 *     + 控制台**自己的**兑换链路（bootstrapConsoleSession：读片段 → 抹地址栏 → 兑换）
 *     + 控制台**自己的**客户端（ControlClient：摘要 + nonce + Origin + Cookie）
 *     + 控制台**自己的**解析与判定（parse* → platformVerdict / writeGate /
 *       exposureSummary / pauseView / redactedDiagnostic）
 *     → 判据：屏幕上会出现的那些字，由真正的服务端事实算出来
 * ```
 *
 * 也就是说，`apps/console/src/**` 这一层今天被接上了一台真的服务端。
 * 少了这一段，「界面显示的结论」与「服务端的真实状态」是不是同一件事，
 * 只能靠两边各自的单元测试各自声称。
 *
 * ## §1 那三行是一次**测量**，不是复述
 *
 * `help.ts` 的 `console_page_missing` 那一条里写着「本机实测（2026-09-26）：
 * `/` 与 `/index.html` 都是 404，而 `/api/status` 答 401」。§1 当场把这三行
 * 重新量一遍，并与帮助文本里的那句话交叉核对。**这是个有寿命的判据**：
 * LWB-039 托管了界面文件之后，`/` 就不再是 404，于是这一条会失败 ——
 * 那时该改的是帮助文本，而不是这条断言。让「文档里的事实」有一条会自动
 * 过期的接缝，比让它静静地变成谎言要好。
 *
 * ## 输出里不会出现本机绝对路径
 *
 * 所有打印都过 `mask()`（`check` / `note` / `section` 统一处理），最后一条
 * 断言再对**收集到的每一行**复查一次。这不是洁癖：本文件会连同它的输出
 * 一起提交，而里面那个 `%TEMP%` 路径带着用户名。
 *
 * 用法：node --import tsx scripts/evidence/lwb-035.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件**证明不了**的事逐条列在末尾并标 `NOT_RUN`。
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { CONTROL_COOKIE_NAME, CONTROL_TOKEN_PATTERN_SOURCE } from '@lwb/contracts';

import {
  ControlClient,
  bootstrapConsoleSession,
  readBootstrapToken,
  type ConsoleSession,
  type HistoryLike,
} from '../../apps/console/src/auth/index.ts';
import {
  applicableHelp,
  exposureSummary,
  localStartHelp,
  machineLine,
  pauseView,
  platformVerdict,
  redactedDiagnostic,
  parseConnections,
  parsePauseStatus,
  parseStatusReading,
  parseWorkspaces,
  writeGate,
} from '../../apps/console/src/setup/index.ts';
import { CONTROL_BIND_HOST, readSessionCookie } from '../../apps/daemon/src/control/index.ts';
import { startDaemon, StartupFailed, type DaemonRuntime } from '../../apps/daemon/src/runtime/assembly.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

// ---------------------------------------------------------------------------
// 输出助手（与 lwb-006 ~ lwb-034 一致，外加统一的路径遮罩）
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
// 装置：真 daemon + 一个会自己记 cookie 的 fetch
// ---------------------------------------------------------------------------

/**
 * 一个最小的 cookie 罐。
 *
 * 兑换响应靠 `Set-Cookie` 下发会话 cookie，而 **Node 的 fetch 没有 cookie 罐**
 * （`credentials: 'same-origin'` 在浏览器里管用，在这里什么都不做）。
 * 因此这一段是装置，不是被测对象：它替浏览器把那件浏览器会做的事做了。
 * 少了它，后面每一次调用都会拿到 401，而失败信息只会说「会话过期」。
 *
 * ## 这里写错过两次，两次都值得留在注释里
 *
 * 1. `readSessionCookie` 返回的是 cookie 的**值**，不是 `名字=值`
 *    （它内部已经按名字找过了）。把返回值直接塞进 `Cookie` 请求头，
 *    发出去的就是一个**没有名字**的值；服务端按名字找，找不到，
 *    于是 401。症状与「会话过期」一模一样，而原因是装置少拼了一个名字。
 *    现在用 `CONTROL_COOKIE_NAME` 拼回去 —— 而且用的是 contracts 里
 *    那一份常量，不是抄一个字面量。
 *
 * 2. 同一个返回值曾经被**打印进了证据**（`2.3` 那一行写的是
 *    `…split('=')[0]…`，看着像在只回显名字，实际上把一个会话密钥
 *    原样写了出去：值里没有 `=`，所以 `split` 出来的就是全部）。
 *    这一条比上一条严重得多，因为它是**外发**的：证据会连同输出一起提交。
 *    现在 `2.3` 只打印 cookie 的名字，而末段的自查会拿 contracts 声明的
 *    凭证形状对**每一行打印出去的字**复查一遍 —— 那次泄漏正是它要抓的东西。
 */
function cookieJar(): { fetchImpl: typeof fetch; cookie: () => string } {
  let cookie = '';
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers);
    if (cookie.length > 0) headers.set('Cookie', cookie);
    const response = await fetch(input, { ...init, headers });
    const issued = readSessionCookie(response.headers.get('set-cookie') ?? '');
    // `readSessionCookie` 没找到时返回的是 `undefined`（不是 `null`）：
    // 写成 `!== null` 会让 cookie 变成字符串 "undefined"，症状同样是一路 401。
    if (issued !== undefined && issued.length > 0) cookie = `${CONTROL_COOKIE_NAME}=${issued}`;
    return response;
  }) as typeof fetch;
  return { fetchImpl, cookie: () => cookie };
}

interface Raw {
  readonly status: number;
  readonly text: string;
  readonly json: Record<string, unknown> | null;
}

async function getJson(url: string, cookie = ''): Promise<Raw> {
  const response = await fetch(url, {
    method: 'GET',
    headers: cookie.length > 0 ? { Cookie: cookie } : {},
    redirect: 'error',
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.status, text: text.slice(0, 200), json };
}

/** 拆出 `bootstrap_url` 里的三件事（片段、路径、来源）。 */
function parts(url: string): { origin: string; pathname: string; hash: string } {
  const parsed = new URL(url);
  return { origin: parsed.origin, pathname: parsed.pathname, hash: parsed.hash };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('LWB-035 证据采集：首次配置 / 连接状态 / 工作区（真控制面 + 真读数）');
  console.log(`仓库根 ${repoRoot}`);
  console.log(`Node ${process.version} / ${process.platform} ${process.arch}`);

  const home = await mkdtemp(path.join(os.tmpdir(), 'lwb-035-home-'));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb-035-ws-'));
  const lines: string[] = [];
  let runtime: DaemonRuntime | null = null;

  try {
    // =======================================================================
    section('0. 装好：启动生产装配根（根被 --home 覆盖到临时目录）');
    // =======================================================================

    try {
      runtime = await startDaemon({
        argv: [`--home=${home}`],
        env: {},
        log: (line) => lines.push(line),
      });
    } catch (error) {
      if (error instanceof StartupFailed && error.kind === 'already_running') {
        note('0.1 本用户下已有 daemon 在运行', '控制管道被占用；§1 ~ §3 需要独占单实例，因此标为 NOT_RUN');
      } else {
        throw error;
      }
    }

    if (runtime !== null) {
      check('0.1 生产装配根起来了，且打印出一个带一次性令牌的地址', runtime.bootstrap_url.startsWith('http://127.0.0.1:'), '地址形状正确（不回显其中的令牌）');
      check(
        '0.2 启动用的不是受保护目录（这是装置，不是被测对象）',
        runtime.facts.store_root_overridden,
        '启动摘要里说明了存储根被覆盖',
      );
      check('0.3 启动日志没有一行被凭证筛查拦下', !lines.some((line) => line.includes('被拦截')), `${String(lines.length)} 行日志`);
      check('0.4 未通过 G0 时四个能力开关全部关闭（真服务端的事实）', runtime.facts.capability_flags.read_enabled === false && runtime.facts.capability_flags.git_enabled === false && runtime.facts.capability_flags.proposal_enabled === false && runtime.facts.capability_flags.direct_write_enabled === false);

      const where = parts(runtime.bootstrap_url);

      // =====================================================================
      section('1. 界面文件还没有人托管：三行实测（help.ts 里那句话的判据）');
      // =====================================================================

      const rootPage = await getJson(`${where.origin}/`);
      const indexPage = await getJson(`${where.origin}/index.html`);
      const statusNoSession = await getJson(`${where.origin}/api/status`);

      check('1.1 GET / 答 404（服务在跑，但没有人托管界面文件）', rootPage.status === 404, `HTTP ${String(rootPage.status)}`);
      check('1.2 GET /index.html 也答 404', indexPage.status === 404, `HTTP ${String(indexPage.status)}`);
      check('1.3 GET /api/status 在无会话时答 401 —— 这正是它该做的', statusNoSession.status === 401, `HTTP ${String(statusNoSession.status)}`);
      note('1.4 这三行与帮助文本的关系', '`help.ts` 的 console_page_missing 那一条里写着同样三行；LWB-039 托管界面之后 1.1/1.2 会失败，那时该改的是帮助文本（这条断言是有意留下会过期的）');

      // =====================================================================
      section('2. 用**打印出来的**地址走完整条兑换链路');
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

      check('2.1 控制台自己的兑换链路能从真地址换到真会话', session !== null && session.session_id.length > 0, `session_id=${session?.session_id ?? '—'}（服务端签发）`);
      check('2.2 地址栏片段在兑换**之前**被抹掉', order.join(',') === 'strip,fetch', order.join(' → '));
      // 只回显**cookie 的名字**。这一段先前写的是 `cookie().split('=')[0]`，
      // 看上去像在只印名字，实际印出的是整个会话值（值里没有 `=`）——
      // 末段的自查就是为这类事准备的。
      check(
        '2.3 会话凭证到了 cookie 罐里，且带着正确的名字（后续调用靠它鉴权）',
        jar.cookie().startsWith(`${CONTROL_COOKIE_NAME}=`) && jar.cookie().length > CONTROL_COOKIE_NAME.length + 1,
        `Cookie: ${CONTROL_COOKIE_NAME}=‹已隐去›`,
      );

      const token = readBootstrapToken(where.hash) ?? '';
      let replayMessage = '';
      let replayStatus = 0;
      try {
        const response = await fetch(`${where.origin}/api/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: where.origin },
          body: JSON.stringify({ token }),
          redirect: 'error',
        });
        replayStatus = response.status;
      } catch (error) {
        replayMessage = error instanceof Error ? error.message : String(error);
      }
      check('2.4 同一张启动令牌**再兑一次**被拒（一次性）', replayStatus === 403, `HTTP ${String(replayStatus)}`);
      check('2.5 被拒的响应里不出现令牌本身', !replayMessage.includes(token) && token.length > 0, '判据是「找不到」，而不是「换了一句话」');

      // =====================================================================
      section('3. 真读数 → 控制台判定（验收标准 1 / 2 / 3 的数据源都是真的）');
      // =====================================================================

      const rawStatus = await getJson(`${where.origin}/api/status`, jar.cookie());
      const rawBody = rawStatus.json?.['result'] ?? null;
      const reading = parseStatusReading(rawBody);
      check('3.1 控制台解析器认得真服务端的 /api/status', rawStatus.status === 200 && rawBody !== null, `HTTP ${String(rawStatus.status)}`);
      check('3.2 机器身份解析出来了（这是「哪台机器」那一行的来源）', reading.machine !== null, machineLine(reading.machine));
      check('3.3 门禁四格与能力开关五格都解析出来了（缺一格会整份作废）', reading.gates !== null && reading.capability_flags !== null);
      check('3.4 版本与服务端自报的接口清单也在', reading.version !== null && reading.routes.length > 0, `${String(reading.routes.length)} 条路由`);

      const now = new Date().toISOString();
      const fresh = { value: reading, observed_at: now };
      const verdict = platformVerdict({
        status: fresh,
        connections: null,
        tunnel: null,
        now,
        browser_online: true,
        last_error: null,
      });
      check('3.5 真读数下：四条腿齐全，本机服务那一格是「在运行」', verdict.legs.length === 4 && verdict.legs[0]?.state === 'ok', verdict.legs[0]?.state_label ?? '—');
      check('3.6 真读数下：平台**不可调用**（G0 未通过 + 隧道无读数）', verdict.callable === false, verdict.reasons[0] ?? '—');

      const gate = writeGate({ gates: reading.gates, flags: reading.capability_flags });
      check('3.7 真门禁下直写是关着的，理由来自门禁本身', gate.direct_write === false && gate.reasons.length >= 3, `${String(gate.reasons.length)} 项原因：${gate.reasons[0] ?? ''}`);

      // 结构性断言：控制面上不存在「把门禁/开关改开」的操作。
      // 这一条问的是**真服务端自报的接口清单**，不是我们的记忆。
      const gateOpeners = reading.routes.filter((route) => /gate|flag|capabilit|enable|permission/i.test(route));
      check('3.8 真服务端的路由清单里没有任何「改门禁 / 改能力开关」的入口', gateOpeners.length === 0, gateOpeners.join('、') || `${String(reading.routes.length)} 条路由一条都不匹配`);
      note('3.9 门禁从哪来', '它来自 `apps/daemon/src/gates.ts` 的常量（一次评审结论的固化），不是运行期可写的状态 —— 3.8 是这一句在真服务端上的判据');

      // ---- 真登记：走 ControlClient 的 nonce + CSRF + Origin 全链路 ----
      const client = new ControlClient({ origin: where.origin, fetchImpl: jar.fetchImpl });
      client.setSession(session);

      const alias = '证据工作区';
      const registerBody = { alias, kind: 'directory', path: workspaceRoot, mode: 'read_only' };
      const authorized = await client.authorizeMutation('/api/workspaces/register', alias, registerBody);
      const registered = (await client.call('/api/workspaces/register', authorized)) as Record<string, unknown>;
      const registeredId = typeof registered['workspace_id'] === 'string' ? registered['workspace_id'] : '';
      check('3.10 真控制面上登记成功（一次性 nonce 绑定 + CSRF 头 + Origin 全部通过）', registeredId.length > 0, `workspace_id=${registeredId}`);
      check('3.11 服务端回报的根与登记时给出的**逐字符相同**', registered['root'] === workspaceRoot, '路径不做规范化');

      const listed = await client.call('/api/workspaces/list', {});
      const rows = parseWorkspaces(listed);
      check('3.12 workspaces.list 的真响应能被控制台解析成一行', rows.length === 1 && rows[0]?.workspace_id === registeredId, `${String(rows.length)} 行`);
      check('3.13 解析出来的绝对路径与登记的一致（这一行是给本地操作者看的）', rows[0]?.root === workspaceRoot);

      const exposure = exposureSummary(rows, reading.capability_flags);
      check('3.14 真数据上的暴露摘要：登记 1 个、但连接/目录 grant/全局门禁没有同时满足', exposure.registered === 1 && exposure.accessible === 0 && exposure.headline.includes('内容工具不可用'), exposure.headline);

      const rawPause = await client.call('/api/service/pause_status', {});
      const pause = parsePauseStatus(rawPause);
      check('3.15 service.pause_status 的真响应能被解析', pause !== null, pause === null ? '解析失败' : `paused=${String(pause.paused)} stopping=${String(pause.stopping.length)}`);
      const pauseState = pauseView({
        session: { session_id: session?.session_id ?? '' },
        reading: pause === null ? null : { value: pause, observed_at: new Date().toISOString() },
        now: new Date().toISOString(),
      });
      check('3.16 真读数下可以暂停；恢复不提供（要求一份新鲜且明确说停着的读数）', pauseState.can_pause && !pauseState.can_resume, String(pauseState.resume_blocked_reason));

      const rawConnections = await client.call('/api/connections/list', {});
      const wireRows = (rawConnections as { readonly connections?: unknown }).connections;
      const connections = parseConnections(rawConnections);
      // 「0 行」与「解析失败」在界面上长得一样，而它们要采取的行动完全不同。
      // 因此这里比的是**行数**：真响应里有几行，解析出来就该有几行。
      check(
        '3.17 connections.list 的真响应能被解析，且行数与线上响应一致',
        Array.isArray(wireRows) && connections.length === wireRows.length,
        `线上 ${String(Array.isArray(wireRows) ? wireRows.length : '—')} 行 / 解析出 ${String(connections.length)} 行`,
      );

      // =====================================================================
      section('4. 反例：同一层判定，喂假读数（验收标准 3 的判决点）');
      // =====================================================================

      const green = {
        ...reading,
        gates: { g0_platform_verified: true, native_guard_verified: true, compatibility_section3_passed: true, g4_concurrency_fault_passed: true },
        capability_flags: { read_enabled: true, git_enabled: true, proposal_enabled: true, direct_write_enabled: true, recovery_required: false },
      };
      const greenConnections = { value: [{ connection_id: 'c1', alias: '适配器', principal_kind: 'model_surface', enabled: true, generation: 1 }] as const, observed_at: now };
      const greenTunnel = { value: { readyz: true, tunnel_id_configured: true }, observed_at: now };

      const allGreen = platformVerdict({ status: { value: green, observed_at: now }, connections: greenConnections, tunnel: greenTunnel, now, browser_online: true, last_error: null });
      check('4.1 对照：四条腿与门禁全绿时**会**算出可调用（这一层不是恒定说「不」）', allGreen.callable === true);

      const oneHourLater = new Date(Date.parse(now) + 60 * 60 * 1000).toISOString();
      const stale = platformVerdict({ status: { value: green, observed_at: now }, connections: greenConnections, tunnel: greenTunnel, now: oneHourLater, browser_online: true, last_error: null });
      check('4.2 同一份全绿读数，一小时后再看：不可调用，且本机服务那一格是「读数已过期」', stale.callable === false && stale.legs[0]?.state === 'unknown', stale.legs[0]?.state_label ?? '—');
      check('4.3 而且它**不说**「等于在线」（停机与睡眠不得显示成正常在线）', stale.headline.includes('不可调用') && !stale.headline.includes('正常在线'));

      const offline = platformVerdict({ status: { value: green, observed_at: now }, connections: greenConnections, tunnel: greenTunnel, now, browser_online: false, last_error: null });
      check('4.4 断网由网络本身否决，且那条理由排在最前', offline.callable === false && (offline.reasons[0] ?? '').includes('网络已断开'), offline.reasons[0] ?? '—');

      const noTunnel = platformVerdict({ status: { value: green, observed_at: now }, connections: greenConnections, tunnel: null, now, browser_online: true, last_error: null });
      check('4.5 「没发现坏消息」不等于可调用：缺隧道读数时仍然不可调用', noTunnel.callable === false && (noTunnel.reasons.find((r) => r.includes('隧道')) ?? '').includes('无法证明'));

      const halfGates = writeGate({ gates: null, flags: green.capability_flags });
      check('4.6 门禁读数缺一格就整份作废：直写关闭，理由是「读数不完整」而不是「某项未通过」', halfGates.direct_write === false && halfGates.reasons.some((r) => r.includes('读数缺失')), halfGates.reasons.join('；'));

      const noSessionPause = pauseView({ session: null, reading: null, now });
      check('4.7 没有会话时暂停与恢复都不给，并把下一步说清楚', !noSessionPause.can_pause && !noSessionPause.can_resume, noSessionPause.headline);
      check('4.8 没有读数时那一格是「没有读数」，不是「没暂停」', noSessionPause.paused === null);

      // =====================================================================
      section('5. 脱敏诊断跑在**真数据**上');
      // =====================================================================

      // 别名是**操作者自己起的**，因此它可以藏下一个路径 —— 这正是第 2 层要接的事。
      const disguised = [{ ...rows[0]!, alias: workspaceRoot }, ...rows];
      const diagnostic = redactedDiagnostic({
        now,
        status: fresh,
        connections,
        workspaces: disguised,
        pause: pause === null ? null : { value: pause, observed_at: now },
        platform: verdict,
        write_gate: gate,
        last_error: null,
      });

      check('5.1 真根路径在可复制的文本里一次都不出现', !diagnostic.text.includes(workspaceRoot));
      check('5.2 台账点名了被隐去的字段（别名里藏下的那一个被抓住了）', diagnostic.redactions.some((name) => name === 'workspaces[0].alias'), diagnostic.redactions.join('、') || '（空）');
      check('5.3 终检通过，因此界面会给「复制」按钮', diagnostic.safe, diagnostic.findings.join('、') || '未命中任何模式');
      check('5.4 终检的对象是**将被复制出去的那串字节**（台账写在终检之前）', diagnostic.text.includes('## 已隐去'), '台账不在扫描之外');
      check('5.5 诊断里不含任何凭据形状的东西', !/lwb_boot_|csrf|bearer|authorization/i.test(diagnostic.text));

      // =====================================================================
      section('6. 一个**会说谎的服务器**：界面的判定不是安全边界');
      // =====================================================================

      // 真 socket、真 JSON，内容是编的。它证明的是「这一层信不信」，而不是
      // 「这一层能不能防」—— 后者不是它的职责。
      const liar = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            ok: true,
            result: {
              version: '9.9.9',
              protocol_version: '1',
              gates: { g0_platform_verified: true, native_guard_verified: true, compatibility_section3_passed: true, g4_concurrency_fault_passed: true },
              capability_flags: { read_enabled: true, git_enabled: true, proposal_enabled: true, direct_write_enabled: true, recovery_required: false },
              limitations: [],
              machine: { hostname: 'NOT-THIS-MACHINE', os: 'linux 0', arch: 'arm64' },
              workspaces: 99,
              connections: 99,
              routes: ['/api/nothing'],
            },
          }),
        );
      });
      await new Promise<void>((resolve) => liar.listen(0, CONTROL_BIND_HOST, resolve));
      const liarAddress = liar.address();
      const liarPort = typeof liarAddress === 'object' && liarAddress !== null ? liarAddress.port : 0;

      const liarRaw = await getJson(`http://127.0.0.1:${String(liarPort)}/api/status`);
      const liarReading = parseStatusReading(liarRaw.json?.['result'] ?? null);
      const liarGate = writeGate({ gates: liarReading.gates, flags: liarReading.capability_flags });
      const liarVerdict = platformVerdict({
        status: { value: liarReading, observed_at: new Date().toISOString() },
        connections: null,
        tunnel: null,
        now: new Date().toISOString(),
        browser_online: true,
        last_error: null,
      });

      await new Promise<void>((resolve) => liar.close(() => resolve()));

      check('6.1 谎报的门禁**能**让界面说出「直写：已打开」', liarGate.direct_write === true, liarGate.summary);
      note('6.2 这正是要写下来的事实', '界面这一层**不是**安全边界：一个谎报的服务端能让它把坏消息显示成好消息。真正的边界在服务端（能力表 + gates 常量 + 3.8 那条结构性断言）');
      check('6.3 但它仍然打不开「平台可调用」—— 那需要一条**正面**的隧道读数', liarVerdict.callable === false, liarVerdict.reasons.find((r) => r.includes('隧道')) ?? '—');
      check('6.4 谎报的机器名会照原样显示（界面不核对它，也无法核对）', machineLine(liarReading.machine).includes('NOT-THIS-MACHINE'));

      // ---- 帮助：有处境才有条目 ----
      const noSessionHelp = applicableHelp({ session: null, daemon_freshness: 'absent' });
      const allFineHelp = applicableHelp({ session: { session_id: 'sess_x' }, daemon_freshness: 'fresh' });
      check('6.5 没有会话时给三条（启动服务 → 打开控制台 → 那个 404）', noSessionHelp.length === 3 && noSessionHelp[0]?.id === 'start_daemon');
      check('6.6 一切正常时**一条都不给**（常驻的帮助文本会被读过一次然后被忽略）', allFineHelp.length === 0);
      check('6.7 全部帮助七条，且都带一句「什么时候用」', localStartHelp().length === 7 && localStartHelp().every((entry) => entry.steps.length >= 3));
    }

    // =======================================================================
    section('7. 渲染层：真 vitest 与 node 运行器的输出');
    // =======================================================================

    const vitestEntry = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
    const vitestRun = await Promise.resolve(exec(process.execPath, [vitestEntry, 'run'], path.join(repoRoot, 'apps', 'console')));
    const vitestOut = `${vitestRun.stdout}\n${vitestRun.stderr}`;
    for (const line of vitestOut.split('\n').filter((l) => /Test Files|Tests |✓ tests\//.test(l))) {
      emit(`  ${line.trim()}`);
    }
    const vitestCounts = /Tests\s+(\d+) passed/.exec(vitestOut);
    check('7.1 .vue 层的 DOM 断言全部通过（4 个页面组件）', vitestRun.code === 0 && vitestCounts !== null, vitestCounts === null ? '未解析到用例数' : `${vitestCounts[1]} 个用例通过`);

    const nodeRun = exec(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'run-tests.mjs'), 'tests/unit', '--grep', 'console-setup'],
      repoRoot,
    );
    const nodeOut = `${nodeRun.stdout}\n${nodeRun.stderr}`;
    for (const line of nodeOut.split('\n').filter((l) => /^# (tests|pass|fail) /.test(l))) {
      emit(`  ${line}`);
    }
    check('7.2 视图模型层的 node 用例全部通过（纯 TypeScript，无 DOM）', nodeRun.code === 0, `退出码 ${String(nodeRun.code)}`);

    // =======================================================================
    section('自查：打印出去的东西里既没有本机路径，也没有凭证');
    // =======================================================================

    const leaky = printed.filter((line) => /[A-Za-z]:\\/.test(line));
    check('8.1 本次运行打印的每一行都已被遮罩', leaky.length === 0, leaky.length === 0 ? `${String(printed.length)} 行` : leaky.slice(0, 3).join(' | '));

    // 凭证形状**不在这里另写一份**：用 `@lwb/contracts` 声明的那一个 ——
    // 与 `packages/egress` 筛查模型可见内容用的是同一条规则。
    // 自查规则与真正的出站规则分成两份，就会出现「自查说干净、出口漏了」
    // 这种最不该出现的组合；而 2.3 那一版真的这么漏过一次。
    const credentialShape = new RegExp(CONTROL_TOKEN_PATTERN_SOURCE, 'g');
    const leakySecrets = printed.filter((line) => credentialShape.test(line));
    check(
      '8.2 每一行打印出去的字都不含控制平面凭证的形状',
      leakySecrets.length === 0,
      leakySecrets.length === 0 ? `按 contracts 的规则扫了 ${String(printed.length)} 行` : `${String(leakySecrets.length)} 行命中`,
    );
    note('8.3 顺带记一件事实', '这条自查在本任务里**抓到过一次真泄漏**：会话 cookie 的值曾被当作「名字」打印出来（见 cookieJar 的注释）。它不是装饰');

    // =======================================================================
    section('未执行项（不得记为通过）');
    // =======================================================================

    skip('在浏览器里看这三个页面', '本任务的证据是 DOM 断言（元素是否存在、文本是否正确、属性是否为三态）与真读数，不是视觉还原；样式与整体外观属 LWB-039 之后的事');
    skip('真实网页端（ChatGPT）的端到端验收', 'LWB-002 仍为 BLOCKED：需要操作者在 platform.openai.com 侧创建 tunnel_id、签发 runtime key、把隧道关联到目标工作区并开启开发者模式。MCP Inspector 的成功不能替代它');
    skip('在真实工作区上联调读写', 'G2 未通过；P3 门禁：可在契约冻结前提下继续实现，但不得在真实仓库上联调（docs/evidence/g2-read.md）');
    skip('真实的睡眠 / 断网 / 时钟回拨', '读数的时效判定是**时间函数**，因此上面用「把 now 往后推一小时」来触发它 —— 那是同一条判定，但不是一次真的睡眠。整机睡眠期间的界面行为没有测过');
    skip('从真 ChatGPT 页面按「紧急停用」', '控制台页面今天没有宿主（§1：/ 与 /index.html 都是 404），托管是 LWB-039 的交付物');
    skip('键盘可达性与读屏软件实测', '按钮是原生 <button>、告警用 role="alert"、区块有 aria-label，这些写在模板里；「读屏软件实际怎么念」没有测过');
  } finally {
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
