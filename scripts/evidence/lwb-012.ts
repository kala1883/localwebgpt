/**
 * LWB-012 可复现证据采集。
 *
 * 三条验收标准，以及各自的**采集方式**：
 *
 *  1. 「恶意网页请求不能修改工作区或批准修改」—— 起一个真的控制平面
 *     （真的 `OperationRegistry`、真的 `ControlSessionStore`、真的监听套接字，
 *     端口由系统分配），然后从**原始 TCP 套接字**逐个发出恶意报文：
 *     DNS rebinding 的 Host、跨站与 null 的 Origin、表单 content-type、
 *     绝对形式请求目标、`CONNECT`、以及一条**带着合法会话 cookie** 的跨站请求。
 *     最后发一条**诚实的**请求作对照 —— 否则「都被拒了」可能只是因为
 *     这个操作本来就不可用，而不是因为这些检查。
 *
 *     用原始套接字而不是 `fetch`：`Host`、`Origin`、绝对形式目标、`CONNECT`
 *     都不能用 `fetch` 构造（`Host`/`Cookie`/`Origin` 属于它的禁止头）。
 *     用一个攻击者不会用的接口去测「攻击者做不到什么」，测不出东西来。
 *
 *  2. 「MCP 连接凭证不能调用控制 API」—— 两条路都走一遍：
 *     把控制路由表**穷尽遍历**（每一条路要么在免鉴权清单里，要么要求一个
 *     `NEVER_GRANTED_TO_MODEL` 的能力）；再把适配器那侧的凭证素材
 *     当 cookie / 当请求头 / 当请求体字段，逐个试过去。
 *
 *  3. 「工具结果不含控制台登录令牌或带授权效果的 URL」—— 这一条的重点是
 *     把「本程序自己的凭证」与「用户的秘密」分开看：后者由 LWB-011 的规则覆盖，
 *     前者需要专门的规则。因此这里**真的签发**四类凭证（启动 / 会话 / CSRF / nonce），
 *     再把它们喂进出站闸门，逐类确认被拦；并确认脱敏后的读取拿不到可编辑票据 ——
 *     令牌不会经由票据再回到写入路径上。
 *
 * 另有一项「改造前的对照」：把**没有**来源校验的裸 `http` 服务与真控制平面并排，
 * 同样发那些恶意请求，量出差别。没有这个对照，「被拒绝了」证明不了是**这些检查**
 * 在起作用（可能只是操作名写错了、或路由根本没注册）。
 *
 * 用法：node --import tsx scripts/evidence/lwb-012.ts
 * 退出码：全部通过 0；任一项失败 1。
 */

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import process from 'node:process';

import { CONTROL_TOKEN_PREFIX, isControlTokenOfKind } from '@lwb/contracts';
import { NEVER_GRANTED_TO_MODEL, OperationRegistry, hasCapability, type Capability } from '@lwb/ipc';
import { emitContent, mintClearance, mintEditTicket, screenText, secretRuleIds } from '@lwb/egress';
import { decide, requireAllowed, type PolicyRequest } from '@lwb/policy';
import type { EgressBudget } from '@lwb/egress';

import {
  CONTROL_BIND_HOST,
  ControlRouteTable,
  ControlServer,
  ControlSessionStore,
  MUTATING_OPERATIONS,
  READ_ONLY_OPERATIONS,
  UNAUTHENTICATED_ROUTES,
  bodyDigest,
  consoleOrigin,
  controlOperationNames,
  createControlPlane,
  newControlToken,
  readSessionCookie,
} from '../../apps/daemon/src/control/index.ts';
import {
  ControlClient,
  bootstrapConsoleSession,
  digestOfBody,
  readBootstrapToken,
  stripFragment,
  type HistoryLike,
} from '../../apps/console/src/auth/index.ts';

// ---------------------------------------------------------------------------
// 输出助手（与 lwb-006 ~ lwb-011 一致）
// ---------------------------------------------------------------------------

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function note(name: string, detail: string): void {
  console.log(`NOTE ${name} — ${detail}`);
}

function skip(name: string, why: string): void {
  console.log(`NOT_RUN ${name} — ${why}`);
}

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

function stubOperations(): { registry: OperationRegistry; calls: string[] } {
  const registry = new OperationRegistry();
  const calls: string[] = [];
  const names: readonly [string, Capability][] = [
    ['workspaces.register', 'workspaces.manage'],
    ['workspaces.list', 'workspaces.manage'],
    ['workspaces.describe', 'workspaces.manage'],
    ['workspaces.pause', 'workspaces.manage'],
    ['workspaces.resume', 'workspaces.manage'],
    ['workspaces.remove', 'workspaces.manage'],
    ['workspaces.reverify', 'workspaces.manage'],
    ['workspaces.relocate', 'workspaces.manage'],
  ];
  for (const [name, required] of names) {
    registry.register({
      name,
      required,
      handler: (_input, context) => {
        calls.push(name);
        return { handled: name, audience: context.audience };
      },
    });
  }
  return { registry, calls };
}

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

async function rawRequest(port: number, lines: readonly string[], body?: string): Promise<RawResponse> {
  // `Content-Length` 必须自己写。少了它，HTTP 解析器认为这个请求**没有正文**，
  // 后面的字节会被当成下一个请求的开头 —— 于是服务端读到一个空体，
  // 表现为「nonce 缺失」而不是「解析失败」。这个坑值得写在代码里：
  // 它让「带正文的原始请求」看起来发出去了、实际上正文从没到达。
  const payload = body ?? '';
  const text = `${[...lines, `Content-Length: ${Buffer.byteLength(payload, 'utf8')}`, 'Connection: close'].join('\r\n')}\r\n\r\n${payload}`;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: CONTROL_BIND_HOST, port });
    let buffer = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(parseRaw(buffer));
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
    });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    socket.setTimeout(8000, () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`原始请求超时（收到 ${buffer.length} 字节）`));
    });
  });
}

function parseRaw(text: string): RawResponse {
  const split = text.indexOf('\r\n\r\n');
  const head = split < 0 ? text : text.slice(0, split);
  const body = split < 0 ? '' : text.slice(split + 4);
  const [statusLine, ...headerLines] = head.split('\r\n');
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine ?? '')?.[1] ?? 0);
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status, headers, body };
}

interface Live {
  readonly server: ControlServer;
  readonly sessions: ControlSessionStore;
  readonly calls: string[];
  readonly port: number;
  readonly origin: string;
  readonly routes: ReturnType<ControlRouteTable['routes']>;
}

async function startControlPlane(): Promise<Live> {
  const { registry, calls } = stubOperations();
  const sessions = new ControlSessionStore({ port: 0 });
  const plane = createControlPlane({ operations: registry, sessions, port: 0 });
  const { port, origin } = await plane.server.listen();
  return { server: plane.server, sessions, calls, port, origin, routes: plane.routes.routes() };
}

async function establishSession(live: Live): Promise<{ cookie: string; csrf: string }> {
  const ticket = live.server.mintBootstrap();
  const response = await fetch(`${live.origin}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: live.origin },
    body: JSON.stringify({ token: ticket.token }),
    redirect: 'error',
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`装置前提不成立：无法建立会话（${response.status} ${text}）`);
  const payload = JSON.parse(text) as { result: { csrf_token: string } };
  return { cookie: readSessionCookie(response.headers.get('set-cookie') ?? '') ?? '', csrf: payload.result.csrf_token };
}

/**
 * 一个**故意什么都不检查**的控制 API：与真控制平面并排的对照。
 *
 * 它的存在是为了回答一个问题：「上面那些恶意请求被拒了，是被**这些检查**
 * 拒的吗？」如果没有这个对照，答案可能是「因为路由没注册」或「因为操作名写错了」
 * —— 那些原因同样会让请求失败，而它们与安全性无关。
 */
async function startNaiveServer(calls: string[]): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      raw += chunk;
    });
    request.on('end', () => {
      // 不查 Host、不查 Origin、不查 content-type、不查 CSRF、不查 nonce。
      // 这正是「控制 API 只监听 127.0.0.1 所以安全」那种实现的样子。
      calls.push('/api/workspaces/register');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { handled: 'workspaces.register', got: raw.length } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, CONTROL_BIND_HOST, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const MUTATION_BODY = JSON.stringify({
  alias: 'evil',
  kind: 'directory',
  path: 'C:/',
  mode: 'read_only',
});

/** 恶意请求的形态。返回 (名称, 报文行, 请求体)。 */
function hostileRequests(
  port: number,
  live: Live,
  session: { cookie: string; csrf: string },
): readonly { name: string; lines: string[]; body: string }[] {
  const base = [
    `Host: 127.0.0.1:${port}`,
    `Cookie: __Host-lwb_console=${session.cookie}`,
    `x-lwb-csrf: ${session.csrf}`,
    `Content-Type: application/json`,
  ];
  return [
    {
      name: '跨站 fetch（Origin 是攻击者站点）',
      lines: [`POST /api/workspaces/register HTTP/1.1`, ...base, `Origin: http://evil.com`],
      body: MUTATION_BODY,
    },
    {
      name: 'DNS rebinding（Host 是攻击者域名，连接落在同一套接字上）',
      lines: [
        `POST /api/workspaces/register HTTP/1.1`,
        `Host: evil.com:${port}`,
        `Cookie: __Host-lwb_console=${session.cookie}`,
        `x-lwb-csrf: ${session.csrf}`,
        `Origin: http://evil.com:${port}`,
        `Content-Type: application/json`,
      ],
      body: MUTATION_BODY,
    },
    {
      name: 'sandbox iframe / data: 页面（Origin: null）',
      lines: [`POST /api/workspaces/register HTTP/1.1`, ...base, `Origin: null`],
      body: MUTATION_BODY,
    },
    {
      name: '缺 Origin（非浏览器客户端或旧式表单）',
      lines: [`POST /api/workspaces/register HTTP/1.1`, ...base],
      body: MUTATION_BODY,
    },
    {
      name: 'HTML 表单跨站提交（application/x-www-form-urlencoded 是简单请求）',
      lines: [
        `POST /api/workspaces/register HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Cookie: __Host-lwb_console=${session.cookie}`,
        `x-lwb-csrf: ${session.csrf}`,
        `Origin: http://evil.com`,
        `Content-Type: application/x-www-form-urlencoded`,
      ],
      body: 'alias=evil&kind=directory&path=C%3A%2F&mode=read_only',
    },
    {
      name: 'multipart/form-data（同样是简单请求类型）',
      lines: [
        `POST /api/workspaces/register HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Cookie: __Host-lwb_console=${session.cookie}`,
        `x-lwb-csrf: ${session.csrf}`,
        `Origin: http://evil.com`,
        `Content-Type: multipart/form-data; boundary=x`,
      ],
      body: MUTATION_BODY,
    },
    {
      name: '同站不同端口（另一个本地服务伪造的请求）',
      lines: [`POST /api/workspaces/register HTTP/1.1`, ...base, `Origin: http://127.0.0.1:1`, `Sec-Fetch-Site: same-site`],
      body: MUTATION_BODY,
    },
    {
      name: '浏览器已标记跨站（Sec-Fetch-Site: cross-site）',
      lines: [`POST /api/workspaces/register HTTP/1.1`, ...base, `Origin: ${live.origin}`, `Sec-Fetch-Site: cross-site`],
      body: MUTATION_BODY,
    },
    {
      name: '缺 CSRF 令牌（只有 cookie）',
      lines: [
        `POST /api/workspaces/register HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Cookie: __Host-lwb_console=${session.cookie}`,
        `Origin: ${live.origin}`,
        `Content-Type: application/json`,
      ],
      body: MUTATION_BODY,
    },
    {
      name: '缺一次性 nonce（绕开审核直接改）',
      lines: [`POST /api/workspaces/register HTTP/1.1`, ...base, `Origin: ${live.origin}`],
      body: MUTATION_BODY,
    },
    {
      name: '绝对形式请求目标（把控制 API 当代理用）',
      lines: [`POST http://evil.com/ HTTP/1.1`, ...base, `Origin: ${live.origin}`],
      body: MUTATION_BODY,
    },
    {
      name: '查询串里夹带凭证',
      lines: [`POST /api/workspaces/register?token=lwb_boot_x HTTP/1.1`, ...base, `Origin: ${live.origin}`],
      body: MUTATION_BODY,
    },
  ];
}

// ---------------------------------------------------------------------------
// 采集
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const live = await startControlPlane();
  const session = await establishSession(live);

  // =========================================================================
  section('验收标准 1：恶意网页请求不能修改工作区或批准修改');
  // =========================================================================

  note(
    '监听地址',
    `${CONTROL_BIND_HOST}:${live.port}（端口由系统分配；绑定后复核 address.address）`,
  );

  const hostile = hostileRequests(live.port, live, session);
  const outcomes: string[] = [];
  let escaped = 0;
  const callsBefore = live.calls.length;

  for (const attack of hostile) {
    const response = await rawRequest(live.port, attack.lines, attack.body);
    const rejected = response.status >= 400 && response.status !== 200;
    if (!rejected) escaped += 1;
    outcomes.push(`${attack.name} → ${response.status}`);
    check(`拒绝：${attack.name}`, rejected, `HTTP ${response.status}`);
  }

  const reachedHandler = live.calls.length - callsBefore;
  check(
    '没有任何一条恶意请求到达工作区 handler（拒绝发生在判定层，不在业务层）',
    reachedHandler === 0,
    `handler 调用次数 ${reachedHandler}`,
  );
  check(`恶意请求全部被拒：${hostile.length} 条`, escaped === 0, outcomes.join(' | '));

  // ---- 对照一：同样的报文，坦白说「如果不检查会怎样」 ----
  const naiveCalls: string[] = [];
  const naive = await startNaiveServer(naiveCalls);
  let naiveAccepted = 0;
  const naiveDetail: string[] = [];
  for (const attack of hostile) {
    const response = await rawRequest(naive.port, attack.lines, attack.body);
    if (response.status === 200) naiveAccepted += 1;
    naiveDetail.push(`${attack.name} → ${response.status}`);
  }
  await naive.close();
  check(
    '对照：同一个监听地址上、不查 Host/Origin/CSRF/nonce 的实现，这些请求全部会成功',
    naiveAccepted === hostile.length,
    `${naiveAccepted}/${hostile.length} 条被接受（说明上面那些拒绝来自检查本身，而不是来自"操作不可用"）`,
  );
  note('对照的接受明细', naiveDetail.join(' | '));

  // ---- 对照二：诚实的请求必须能通过 ----
  const honestBody = { alias: 'proj-ok', kind: 'directory', path: 'D:/proj', mode: 'read_only' };
  const nonceResponse = await fetch(`${live.origin}/api/nonces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: live.origin,
      'x-lwb-csrf': session.csrf,
      Cookie: `__Host-lwb_console=${session.cookie}`,
    },
    body: JSON.stringify({
      operation: '/api/workspaces/register',
      subject: 'proj-ok',
      digest: bodyDigest({ ...honestBody, subject: 'proj-ok' }),
    }),
    redirect: 'error',
  });
  const nonceText = await nonceResponse.text();
  const nonce = nonceResponse.status === 200 ? (JSON.parse(nonceText) as { result: { nonce: string } }).result.nonce : '';
  const honest = await rawRequest(
    live.port,
    [
      `POST /api/workspaces/register HTTP/1.1`,
      `Host: 127.0.0.1:${live.port}`,
      `Cookie: __Host-lwb_console=${session.cookie}`,
      `x-lwb-csrf: ${session.csrf}`,
      `Origin: ${live.origin}`,
      `Sec-Fetch-Site: same-origin`,
      `Content-Type: application/json`,
    ],
    JSON.stringify({ ...honestBody, subject: 'proj-ok', nonce }),
  );
  check(
    '对照：同一份内容、来源正确的请求会成功（因此上面的拒绝不是"谁来都拒"）',
    honest.status === 200,
    `HTTP ${honest.status}${honest.status === 200 ? '' : ` ${honest.body.slice(0, 160)}`}`,
  );

  // ---- 响应头：CORS 与缓存 ----
  const headerProbe = await rawRequest(live.port, [
    `OPTIONS /api/workspaces/register HTTP/1.1`,
    `Host: 127.0.0.1:${live.port}`,
    `Origin: http://evil.com`,
    `Access-Control-Request-Method: POST`,
    `Access-Control-Request-Headers: content-type,x-lwb-csrf`,
  ]);
  check('OPTIONS 不被实现（不实现 CORS 预检本身就是一道防线）', headerProbe.status === 405, `HTTP ${headerProbe.status}`);
  check(
    '响应里没有任何 Access-Control-Allow-* 头',
    Object.keys(headerProbe.headers).every((name) => !name.startsWith('access-control-')),
    Object.keys(headerProbe.headers).filter((n) => n.startsWith('access-control-')).join(',') || '无',
  );
  check(
    '每个响应都带 no-store 与 nosniff',
    headerProbe.headers['cache-control'] === 'no-store' && headerProbe.headers['x-content-type-options'] === 'nosniff',
    `cache-control=${headerProbe.headers['cache-control']} x-content-type-options=${headerProbe.headers['x-content-type-options']}`,
  );

  // ---- Host 判定排在路由之前 ----
  const knownPath = await rawRequest(live.port, [`GET /api/status HTTP/1.1`, `Host: evil.com:${live.port}`]);
  const unknownPath = await rawRequest(live.port, [`GET /definitely-not-here HTTP/1.1`, `Host: evil.com:${live.port}`]);
  check(
    'Host 判定排在路由之前：非法 Host 下，存在与不存在的路径响应完全相同（枚举不出接口表）',
    knownPath.status === unknownPath.status && knownPath.body === unknownPath.body,
    `两者均为 HTTP ${knownPath.status}、响应体逐字相同`,
  );

  // ---- CONNECT ----
  const tunnel = await rawRequest(live.port, [`CONNECT evil.com:443 HTTP/1.1`, `Host: 127.0.0.1:${live.port}`]);
  check(
    'CONNECT 不产生隧道',
    (tunnel.status === 0 || tunnel.status >= 400) && tunnel.body === '',
    `HTTP ${tunnel.status}、转发字节数 ${tunnel.body.length}（Node 对无监听者的 CONNECT 直接销毁套接字，同样是拒绝）`,
  );

  // ---- 绑定范围 ----
  const nonLoopback = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry): entry is os.NetworkInterfaceInfo => entry !== undefined)
    .filter((entry) => entry.family === 'IPv4' && !entry.internal);
  if (nonLoopback.length === 0) {
    skip('从非回环地址连不上控制 API', '本机没有任何非回环 IPv4 地址');
  } else {
    const address = nonLoopback[0]?.address ?? '';
    const refused = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: address, port: live.port });
      socket.setTimeout(3000, () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('connect', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => resolve(true));
    });
    check(`从非回环地址（${address}）连不上控制 API`, refused, refused ? '连接被拒' : '竟然连上了');
  }

  // =========================================================================
  section('验收标准 2：MCP 连接凭证不能调用控制 API');
  // =========================================================================

  const routeKeys = live.routes.map((route) => `${route.method} ${route.path}`);
  note('控制平面路由表（穷尽遍历）', routeKeys.join(' | '));

  let unprotected = 0;
  let modelReachable = 0;
  for (const route of live.routes) {
    if (route.capability === undefined) {
      if (!UNAUTHENTICATED_ROUTES.includes(`${route.method} ${route.path}`)) unprotected += 1;
      continue;
    }
    if (hasCapability('mcp-adapter', route.capability)) modelReachable += 1;
  }
  check(
    '每一条控制路由：要么在免鉴权清单里，要么要求一个模型侧拿不到的能力',
    unprotected === 0 && modelReachable === 0,
    `${live.routes.length} 条路由；免鉴权且不在清单里的 ${unprotected} 条；模型侧可获得能力的 ${modelReachable} 条`,
  );
  check(
    '免鉴权路由只有两条，且都与会话建立/登出有关',
    UNAUTHENTICATED_ROUTES.length === 2 && UNAUTHENTICATED_ROUTES.every((key) => key.includes('/api/session')),
    UNAUTHENTICATED_ROUTES.join(' | '),
  );

  // ---- 构造期断言：要求一个模型侧也有的能力，注册不出来 ----
  let threwOnModelCapability = false;
  let threwOnUnlistedOpen = false;
  let threwOnWildcard = false;
  try {
    new ControlRouteTable().register({
      method: 'GET',
      path: '/api/leak',
      capability: 'tools.read',
      mutating: false,
      handler: () => ({}),
    });
  } catch {
    threwOnModelCapability = true;
  }
  try {
    new ControlRouteTable().register({
      method: 'GET',
      path: '/api/open',
      capability: undefined,
      mutating: false,
      handler: () => ({}),
    });
  } catch {
    threwOnUnlistedOpen = true;
  }
  try {
    new ControlRouteTable().register({
      method: 'GET',
      path: '/api/*',
      capability: 'audit.read',
      mutating: false,
      handler: () => ({}),
    });
  } catch {
    threwOnWildcard = true;
  }
  check('要求 tools.read（模型侧也有）的控制路由注册不出来', threwOnModelCapability, 'register() 抛错');
  check('没有能力要求又不在免鉴权清单里的路由注册不出来', threwOnUnlistedOpen, 'register() 抛错');
  check('通配路径注册不出来（通配路由等于一个转发器）', threwOnWildcard, 'register() 抛错');

  // ---- 装配期断言 ----
  let threwOnUnclassified = false;
  try {
    const registry = new OperationRegistry();
    registry.register({ name: 'workspaces.list', required: 'workspaces.manage', handler: () => ({}) });
    registry.register({ name: 'workspaces.brandNew', required: 'workspaces.manage', handler: () => ({}) });
    createControlPlane({ operations: registry, sessions: new ControlSessionStore({ port: 0 }) });
  } catch {
    threwOnUnclassified = true;
  }
  check(
    '有控制操作没被分类为变更类/只读类时，控制平面拒绝装配',
    threwOnUnclassified,
    '分类决定是否需要一次性 nonce，而误判为只读在功能上看不出来',
  );

  check(
    '「绝不授予模型」的能力清单与路由实际用到的能力一致',
    live.routes
      .filter((route) => route.capability !== undefined)
      .every((route) => NEVER_GRANTED_TO_MODEL.includes(route.capability as Capability)),
    `路由用到：${[...new Set(live.routes.map((r) => r.capability).filter((c) => c !== undefined))].join(', ')}`,
  );

  // ---- 把适配器那一侧的素材当凭证送进来 ----
  const adapterMaterial = [
    ['cookie 里放一份 32 字节随机 hex（形如适配器凭据）', [`Cookie: __Host-lwb_console=${'a1b2c3d4'.repeat(8)}`]],
    ['请求头里放 X-LWB-IPC-Secret', [`Cookie: __Host-lwb_console=`, `X-LWB-IPC-Secret: ${'deadbeef'.repeat(8)}`]],
    ['同时声称自己是 mcp-adapter 身份', [`Cookie: __Host-lwb_console=${'f'.repeat(64)}`, `X-Audience: mcp-adapter`]],
    ['冒用会话令牌前缀但内容为随机串', [`Cookie: __Host-lwb_console=${CONTROL_TOKEN_PREFIX.session}${'z'.repeat(43)}`]],
  ] as const;
  const adapterOutcomes: string[] = [];
  let adapterAdmitted = 0;
  for (const [name, headers] of adapterMaterial) {
    const response = await rawRequest(
      live.port,
      [
        `POST /api/workspaces/list HTTP/1.1`,
        `Host: 127.0.0.1:${live.port}`,
        `Origin: ${live.origin}`,
        `Content-Type: application/json`,
        ...headers,
      ],
      '{}',
    );
    if (response.status !== 401) adapterAdmitted += 1;
    adapterOutcomes.push(`${name} → ${response.status}`);
  }
  check(
    '把适配器那一侧的凭证素材当 cookie/请求头送进来，一律 401（没有会话，也没有别的入口）',
    adapterAdmitted === 0,
    adapterOutcomes.join(' | '),
  );

  // ---- 伪造启动令牌 ----
  const forged = newControlToken('bootstrap');
  const forgedResponse = await fetch(`${live.origin}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: live.origin },
    body: JSON.stringify({ token: forged }),
    redirect: 'error',
  });
  // 具体到 4xx 而不是「>= 400」：这里曾经是 500（处理函数抛的是普通 Error，
  // 被服务器折成 INTERNAL_ERROR），而那会让操作者以为是自己遇到了服务端 bug。
  // 钉住状态码，才能让「又变回 500」这件事被发现。
  check(
    '形状正确但没有签发过的启动令牌换不到会话，且是 403 而不是 500（客户端问题不该报成服务端错误）',
    forgedResponse.status === 403,
    `HTTP ${forgedResponse.status}`,
  );

  const malformedResponse = await fetch(`${live.origin}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: live.origin },
    body: JSON.stringify({ token: 'not-a-token' }),
    redirect: 'error',
  });
  check(
    '格式就不对的令牌换不到会话，且是 400',
    malformedResponse.status === 400,
    `HTTP ${malformedResponse.status}`,
  );

  // ---- 请求体里的"授权字段"无效 ----
  const authorityFields = [
    { approved: true },
    { user_id: 'me', principal_id: 'me', session_id: 's1' },
    { audience: 'console', capabilities: ['workspaces.manage', 'approvals.decide'] },
  ];
  let authorityAdmitted = 0;
  const authorityOutcomes: string[] = [];
  for (const body of authorityFields) {
    const response = await fetch(`${live.origin}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: live.origin },
      body: JSON.stringify(body),
      redirect: 'error',
    });
    if (response.status === 200) authorityAdmitted += 1;
    authorityOutcomes.push(`${JSON.stringify(body)} → ${response.status}`);
  }
  check(
    '请求体里的 approved/user_id/principal_id/audience/capabilities 换不到任何授权',
    authorityAdmitted === 0,
    authorityOutcomes.join(' | '),
  );

  // ---- 控制操作清单与能力表一致 ----
  const { registry: freshRegistry } = stubOperations();
  const controlNames = controlOperationNames(freshRegistry);
  check(
    '控制操作清单由能力表推导，且与显式分类清单逐条一致',
    controlNames.length === MUTATING_OPERATIONS.length + READ_ONLY_OPERATIONS.length &&
      controlNames.every((name) => MUTATING_OPERATIONS.includes(name) || READ_ONLY_OPERATIONS.includes(name)),
    `${controlNames.length} 个控制操作：${controlNames.join(', ')}`,
  );

  // =========================================================================
  section('验收标准 3：工具结果不含控制台登录令牌或带授权效果的 URL');
  // =========================================================================

  note(
    '这一条与 LWB-011 的规则的关系',
    'LWB-011 的各条规则保护的是**用户的**秘密；控制平面凭证保护的是**本程序自己的授权凭据**，' +
      '泄露它等于把"批准"这件事本身交出去。因此它是一条独立的 certain 档规则（control-plane-token），' +
      '形状定义与签发端共用 packages/contracts/src/control.ts 同一份源头，不会漂移。',
  );

  const tokens = [
    ['启动令牌', newControlToken('bootstrap'), 'bootstrap'],
    ['会话 cookie 值', newControlToken('session'), 'session'],
    ['CSRF 令牌', newControlToken('csrf'), 'csrf'],
    ['一次性 nonce', newControlToken('nonce'), 'nonce'],
  ] as const;

  for (const [label, token, kind] of tokens) {
    const screen = screenText(`const leaked = "${token}";`);
    const hit = screen.findings.filter((finding) => finding.rule_id === 'control-plane-token');
    check(
      `出站筛查命中：${label}`,
      isControlTokenOfKind(token, kind) && hit.length > 0,
      `规则 ${[...new Set(screen.findings.map((f) => f.rule_id))].join(',')}，档位 ${hit[0]?.tier ?? '—'}`,
    );
  }

  const ruleIds = secretRuleIds();
  check(
    '规则清单里确实有 control-plane-token（规则集与代码同源读出）',
    ruleIds.some((rule) => rule.id === 'control-plane-token'),
    `${ruleIds.length} 条规则`,
  );

  // ---- 真正的出站闸门：阻断面 vs 脱敏面 ----
  const policyRequest: PolicyRequest = {
    connection: {
      connection_id: 'conn-evidence',
      enabled: true,
      granted_capabilities: ['read', 'search', 'git_read', 'list', 'propose'],
      audience: 'mcp_adapter',
      granted_workspace_ids: ['ws-evidence'],
    },
    workspace: {
      workspace_id: 'ws-evidence',
      kind: 'directory',
      mode: 'read_only',
      capabilities: {
        read_enabled: true,
        git_enabled: true,
        proposal_enabled: false,
        direct_write_enabled: false,
        recovery_required: false,
      },
      current_generation: 3,
      current_policy_version: 1,
      root_volume_id: 'vol',
      root_file_id: 'root',
      paused: false,
    },
    presented: { generation: null, policy_version: null },
    action: { action: 'read', path: 'src/a.ts', approval: null },
    now: 1_700_000_000_000,
  };

  const unlimited: EgressBudget = {
    charge: (bytes: number) => ({
      ok: true,
      remaining_bytes: 1_000_000 - bytes,
      used_bytes: bytes,
      limit_bytes: 1_000_000,
    }),
  } as unknown as EgressBudget;

  const bootTicket = new ControlSessionStore({ port: 51234 }).mintBootstrap();
  const leak = `README 片段：\n启动地址 ${bootTicket.url}\n其余内容\n`;
  note('被测试的文本', JSON.stringify(leak));

  const readClearance = mintClearance(requireAllowed({ ...policyRequest }), {
    connection_id: 'conn-evidence',
    generation: 3,
  });
  const emission = emitContent(readClearance, { path: 'src/a.ts', content: leak }, unlimited);
  check(
    '读取面：启动 URL 里的令牌被脱敏，其余内容仍可读',
    emission.redacted && !emission.content.includes(bootTicket.token) && emission.content.includes('其余内容'),
    JSON.stringify(emission.content),
  );
  check(
    '脱敏过的读取拿不到可编辑票据（令牌不会经由票据回到写入路径）',
    mintEditTicket(readClearance, emission, { now: 1_700_000_000_000 }) === null,
    'mintEditTicket() 返回 null',
  );

  for (const [label, action] of [
    ['搜索片段', 'search'],
    ['Git 差异', 'git_diff'],
  ] as const) {
    const clearance = mintClearance(
      requireAllowed({
        ...policyRequest,
        action: { action, path: 'src/a.ts', approval: null },
      }),
      { connection_id: 'conn-evidence', generation: 3 },
    );
    let blocked = false;
    let code = '';
    try {
      emitContent(clearance, { path: 'src/a.ts', content: leak }, unlimited);
    } catch (error) {
      blocked = true;
      code = (error as { code?: string }).code ?? 'unknown';
    }
    check(`${label}面：整块阻断（拿不到"脱敏放行"这条出路）`, blocked && code === 'SECRET_DETECTED', code);
  }

  // ---- 启动 URL 的组装与片段处理 ----
  check(
    '启动 URL 把令牌放在片段里（片段不会被浏览器发往服务器，不进请求行、不进日志、不进 Referer）',
    bootTicket.url.includes('/#t=') && bootTicket.url.includes(bootTicket.token),
    bootTicket.url.replace(bootTicket.token, `${bootTicket.token.slice(0, 12)}…（已截断展示）`),
  );
  check(
    '控制台只从片段里、且只按 lwb_boot_ 形状读令牌',
    readBootstrapToken(`#t=${bootTicket.token}`) === bootTicket.token &&
      readBootstrapToken('#section-3') === null &&
      readBootstrapToken(`#t=${newControlToken('session')}`) === null,
    '无关片段不会被当成令牌（否则一次锚点跳转会变成一次多余的兑换请求）',
  );

  const order: string[] = [];
  const history: HistoryLike = {
    replaceState() {
      order.push('strip');
    },
  };
  // 用**真的**由服务端签发的一张令牌：随便造一个形状正确的串会在兑换时被拒，
  // 于是这条用例证明的就成了「兑换会失败」，而不是「顺序是对的」。
  const realTicket = live.server.mintBootstrap();
  const orderSession = await bootstrapConsoleSession({
    location: { hash: `#t=${realTicket.token}`, pathname: '/', origin: live.origin },
    history,
    fetchImpl: (async (...args: Parameters<typeof fetch>) => {
      order.push('fetch');
      return fetch(...args);
    }) as typeof fetch,
  });
  check(
    '控制台用真令牌走完整条兑换链路：拿到会话（证明上面的顺序断言不是空跑）',
    orderSession !== null && orderSession.session_id.length > 0,
    `session_id=${orderSession?.session_id ?? '—'}`,
  );
  check(
    '控制台先抹片段、再兑换（顺序反了的话，失败分支会把失效令牌留在地址栏里）',
    order.join(',') === 'strip,fetch',
    order.join(' → '),
  );

  // ---- 两侧摘要算法一致 ----
  const digestSamples: Record<string, unknown>[] = [
    { alias: 'a', kind: 'directory', path: 'D:/x', mode: 'read_only' },
    { z: 1, a: 2, m: 3 },
    { 中文键: '值', ascii: 'v' },
    {},
  ];
  const digestMismatch: string[] = [];
  for (const sample of digestSamples) {
    if ((await digestOfBody(sample)) !== bodyDigest(sample)) digestMismatch.push(JSON.stringify(sample));
  }
  check(
    '控制台与服务端算出的请求体摘要逐字节相同（含中文键与任意键序）',
    digestMismatch.length === 0,
    `${digestSamples.length} 个样本，不一致 ${digestMismatch.length} 个`,
  );
  check(
    '摘要排除 nonce 字段（否则 nonce 无法绑定"不含它自己的那份内容"）',
    bodyDigest({ a: 1, nonce: 'x' }) === bodyDigest({ a: 1, nonce: 'y' }) && bodyDigest({ a: 1 }) === bodyDigest({ a: 1 }),
    '换一个 nonce，摘要不变',
  );

  // ---- 控制台客户端的基本约束 ----
  let clientRejectedOrigin = false;
  try {
    new ControlClient({ origin: 'https://evil.com', fetchImpl: fetch });
  } catch {
    clientRejectedOrigin = true;
  }
  check('控制台客户端拒绝非回环 origin', clientRejectedOrigin, '构造时抛错');

  // ---- 清理 ----
  await live.server.close();

  // =========================================================================
  section('未执行项（不得记为通过）');
  // =========================================================================

  skip('真实浏览器里的控制台端到端验收', '控制台界面属 LWB-035；本任务不带 DOM、不开浏览器');
  skip('真实 ChatGPT Web 端到端验收', '需要真实账号与 Secure MCP Tunnel 凭据；LWB-002 仍为 BLOCKED');
  skip('从局域网另一台机器发起攻击', '需要在第二台机器上执行，本机无法自证');
  skip('DNS rebinding 的真实浏览器复现（自建 DNS + 域名）', '需要控制一个域名与 DNS 服务；本任务只验证服务端侧的 Host 判定');

  console.log(`\n${failures === 0 ? '全部通过。' : `有 ${failures} 项未通过。`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
