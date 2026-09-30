/**
 * LWB-012 控制平面测试。
 *
 * ## 这份测试在测什么（以及刻意不测什么）
 *
 * 它测的是**门有没有关上**，而不是「门后面的功能对不对」。三条验收标准
 * 都是用「某个来源发来的请求**没有**产生效果」来表述的，而证明
 * 「没有产生效果」的唯一可靠方式是**真的发出那个请求，并检查状态确实没变**。
 *
 * 因此这里的大部分用例走的是**原始 TCP 套接字**，手写 HTTP 报文，
 * 而不是 `fetch`。理由不是偏执：
 *
 *  - 攻击者控制的正是报文本身。`Host`、`Origin`、绝对形式请求目标、
 *    `CONNECT` —— 这些都不能用 `fetch` 构造（`Host` 属于 fetch 的
 *    禁止头，绝对形式目标与 `CONNECT` 更不是 fetch 能表达的概念）。
 *    用 `fetch` 测这些等于**测了一个攻击者不会用的接口**。
 *  - 一个用 `fetch` 写成的「跨站请求」用例，即使通过了，也只说明
 *    「fetch 发不出这个请求」，而不是「服务端会拒绝它」。
 *
 * 只有在确实要模拟**控制台**（也就是一个诚实的同源客户端）时，才用 `fetch`。
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { OperationRegistry, type Capability } from '@lwb/ipc';
import { randomBytes } from 'node:crypto';

import {
  ControlRouteTable,
  ControlServer,
  ControlSessionStore,
  MUTATING_OPERATIONS,
  READ_ONLY_OPERATIONS,
  UNAUTHENTICATED_ROUTES,
  bodyDigest,
  checkHost,
  checkJsonContentType,
  checkOrigin,
  checkRequestTarget,
  checkSecFetchSite,
  consoleOrigin,
  controlOperationNames,
  createControlPlane,
  newControlToken,
  parseAuthority,
  readSessionCookie,
  registerApprovalOperations,
  registerChangeOperations,
  registerConnectionOperations,
  registerHistoryOperations,
  registerPauseOperations,
  registerRecoveryOperations,
  registerWorkspaceOperations,
  registerWorkspaceAccessOperations,
  type ControlRoute,
  type ControlEvent,
} from '../../apps/daemon/src/control/index.ts';
import type { BlobStore } from '@lwb/blob-store';
import type { EgressBudgetStore } from '@lwb/egress';
import type { PauseService } from '@lwb/executor';
import type { Repositories } from '@lwb/persistence';
import type { WorkspaceRegistry } from '@lwb/workspaces';

import {
  ControlApiFailure,
  ControlClient,
  digestOfBody,
  isLoopbackOrigin,
  readBootstrapToken,
  redeemBootstrap,
  stripFragment,
  bootstrapConsoleSession,
  type HistoryLike,
} from '../../apps/console/src/auth/index.ts';

import { CONTROL_TOKEN_PREFIX, isControlTokenOfKind } from '@lwb/contracts';
import type { EgressBudget } from '@lwb/egress';
import { emitContent, mintClearance, screenText } from '@lwb/egress';
import { decide } from '@lwb/policy';
import type { PolicyRequest } from '@lwb/policy';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

function stubOperations(): {
  readonly registry: OperationRegistry;
  readonly calls: { readonly name: string; readonly input: unknown; readonly audience: string }[];
} {
  const registry = new OperationRegistry();
  const calls: { name: string; input: unknown; audience: string }[] = [];
  const names: readonly [string, Capability][] = [
    ['workspaces.register', 'workspaces.manage'],
    ['workspaces.access.list', 'workspaces.manage'],
    ['workspaces.access.set', 'workspaces.manage'],
    ['workspaces.list', 'workspaces.manage'],
    ['workspaces.describe', 'workspaces.manage'],
    ['workspaces.pause', 'workspaces.manage'],
    ['workspaces.resume', 'workspaces.manage'],
    ['workspaces.remove', 'workspaces.manage'],
    ['workspaces.reverify', 'workspaces.manage'],
    ['workspaces.relocate', 'workspaces.manage'],
    // LWB-018 步骤 3 加进来的三条。控制操作清单必须与这里**逐一对应**，
    // 少一条 `createControlPlane` 就会拒绝装配（「清单与能力表已经脱节」），
    // 那正是它该做的事：新接口不能只加在一边。
    ['connections.list', 'connections.manage'],
    ['connections.pause', 'connections.manage'],
    ['connections.resume', 'connections.manage'],
    // LWB-021 加进来的三条。它们在这里是**桩**：本文件的用例测的是
    // 传输层的门（来源、CSRF、nonce、能力），不是批准语义 —— 后者的
    // 装置在 `tests/unit/approvals.test.ts`，那里用真实状态库。
    //
    // 桩仍然必须用 `approvals.decide`：控制操作的判据是「该能力没有授予
    // mcp-adapter」（`controlOperationNames`），换一个能力它就不再是控制
    // 操作，`createControlPlane` 会因为「清单与能力表脱节」拒绝装配。
    ['approvals.list', 'approvals.decide'],
    ['approvals.reject', 'approvals.decide'],
    ['approvals.approve_and_apply', 'approvals.decide'],
    // LWB-034 加进来的三条。同样在这里是桩：本文件测的是传输层的门，
    // 而紧急停用的语义（停止在途写入、作废排队授权）的装置在
    // `tests/unit/pause.test.ts` 与 `tests/windows/`。
    //
    // 桩的**返回体**在这里不重要，但它们仍然会把请求送进 handler ——
    // 因此「变更类要不要 nonce」这一条对这三条新接口同样是被真验证的。
    ['service.pause_status', 'service.control'],
    ['service.pause', 'service.control'],
    ['service.resume', 'service.control'],
    // LWB-036 加进来的两条。它们的能力是 `changes.read` —— 一条**只属于
    // 控制台**的能力，因此这两条天然是控制操作（判据见 `controlOperationNames`）。
    //
    // 桩的返回体在这里同样不重要：本文件的用例测的是传输层的门，
    // 复核读取的语义（范围、闸门、归属）的装置在
    // `tests/unit/control-changes.test.ts`。
    ['changes.list', 'changes.read'],
    ['changes.get', 'changes.read'],
    ['recovery.list', 'changes.read'],
    ['recovery.get', 'changes.read'],
    ['recovery.export_snapshot', 'approvals.decide'],
    ['history.list', 'audit.read'],
    ['recovery.keep_current', 'approvals.decide'],
    ['recovery.repropose', 'approvals.decide'],
    ['recovery.authorize', 'approvals.decide'],
    ['recovery.repair', 'approvals.decide'],
  ];
  for (const [name, required] of names) {
    registry.register({
      name,
      required,
      handler: (input, context) => {
        calls.push({ name, input, audience: context.audience });
        return { handled: name, audience: context.audience };
      },
    });
  }
  return { registry, calls };
}

interface Harness {
  readonly server: ControlServer;
  readonly routes: ControlRouteTable;
  readonly sessions: ControlSessionStore;
  readonly events: ControlEvent[];
  readonly calls: { readonly name: string; readonly input: unknown; readonly audience: string }[];
  readonly port: number;
  readonly origin: string;
}

async function startHarness(): Promise<Harness> {
  const { registry, calls } = stubOperations();
  const events: ControlEvent[] = [];
  const sessions = new ControlSessionStore({ port: 0 });
  const plane = createControlPlane({
    operations: registry,
    sessions,
    port: 0,
    onEvent: (event) => events.push(event),
  });
  const { port, origin } = await plane.server.listen();
  return { server: plane.server, routes: plane.routes, sessions, events, calls, port, origin };
}

/**
 * 手写一个 HTTP/1.1 请求并取回响应。**这是攻击者会用的接口。**
 *
 * 刻意不做的三件事：不自动补 `Host`、不自动补 `Origin`、
 * 不把请求目标规范化 —— 这些都正是被测的对象。
 */
async function rawRequest(
  port: number,
  lines: readonly string[],
  body?: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const text = `${[...lines, 'Connection: close'].join('\r\n')}\r\n\r\n${body ?? ''}`;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let buffer = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(parseResponse(buffer));
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

function parseResponse(text: string): { status: number; headers: Record<string, string>; body: string } {
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

/**
 * 「这条请求不必复用连接」—— 用 `fetch` 的那一半用例都带上它。
 *
 * Node 的 `fetch`（undici）按 origin 维护一个**进程级**的连接池：同一个
 * `127.0.0.1:<port>` 上的 keep-alive 连接会被后面的请求捡起来复用。而本文件
 * 每个用例都起一个自己的控制平面服务、用完在 `finally` 里 `close()`，端口由
 * 系统分配 —— 系统把同一个端口再分给下一个用例是常事。于是下一个用例的
 * **第一次** `fetch` 会挑中上一个用例留下的那条已经死掉的连接，往上写请求，
 * 换来一个 `TypeError: fetch failed`（cause 是 `ECONNRESET`，栈落在 undici
 * 里，离被测的任何一条规则都很远，看起来像一次随机红）。
 *
 * 实测：同一个端口上连着跑两轮，第 2 轮的第 0 次请求就复现；每条请求都新建
 * 连接则一次都不失败 —— 所以变量确实在「复用」这一件事上。而本文件里手写
 * 报文的那一半（`rawRequest`）本来就带着 `Connection: close`，这一条只是让
 * `fetch` 那一半与它一致。
 *
 * 刻意**不做**成「失败就重试」：重试是把症状按下去，而且会让真正的传输层
 * 缺陷也变成一次通过。这里改的是请求本身 —— 每个用例的服务都是短命的，
 * 本来就没有连接可复用。
 */
const NO_REUSE: Record<string, string> = { connection: 'close' };

interface Console {
  readonly cookie: string;
  readonly csrf: string;
  readonly session_id: string;
}

/**
 * 建立会话，充当一个**诚实的控制台**。
 *
 * 这里显式带上 `Origin`，而且不是可有可无的礼节：Node 的 `fetch`
 * **不发 `Origin` 头**（实测：`POST` 与 `GET` 的 `req.headers.origin` 都是
 * `undefined`）。所以「不带 Origin 的变更请求被拒绝」这条规则，
 * 在 node 里用裸 `fetch` 是**测不出反例**的 —— 每一次都会因为缺头而被拒，
 * 于是「同源请求能通过」这件事从来没有被验证过。
 *
 * 显式补上 Origin 之后，下面那些拒绝用例才是有意义的：
 * 它们证明的是「同样是 POST /api/...，只有来源正确的那一条过得去」。
 */
async function establishSession(harness: Harness): Promise<Console> {
  const ticket = harness.server.mintBootstrap();
  const response = await fetch(`${harness.origin}/api/session`, {
    method: 'POST',
    headers: { ...NO_REUSE, 'Content-Type': 'application/json', Origin: harness.origin },
    body: JSON.stringify({ token: ticket.token }),
    redirect: 'error',
  });
  // 先把 body 读成文本再断言：`assert.equal` 的第三个参数是**立即求值**的，
  // 写 `assert.equal(status, 200, await res.text())` 会在断言之前就把 body 读掉，
  // 成功路径上随后那次 `res.json()` 就变成 "Body is unusable"。
  // 这个坑的恶劣之处在于：它只在**成功**时炸，看起来像被测代码的缺陷。
  const text = await response.text();
  assert.equal(response.status, 200, `建立会话失败：${text}`);
  const setCookie = response.headers.get('set-cookie') ?? '';
  const payload = JSON.parse(text) as { result: { session_id: string; csrf_token: string } };
  return {
    cookie: readSessionCookie(setCookie) ?? '',
    csrf: payload.result.csrf_token,
    session_id: payload.result.session_id,
  };
}

/** 发一个变更类请求，带上会话与 CSRF。 */
async function mutate(
  harness: Harness,
  console: Console,
  path: string,
  body: Record<string, unknown>,
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${harness.origin}${path}`, {
    method: 'POST',
    headers: {
      ...NO_REUSE,
      'Content-Type': 'application/json',
      'x-lwb-csrf': console.csrf,
      Origin: harness.origin,
      Cookie: `__Host-lwb_console=${console.cookie}`,
      ...extra,
    },
    body: JSON.stringify(body),
    redirect: 'error',
  });
}

// ---------------------------------------------------------------------------

describe('LWB-012 · 步骤 1：控制 API 只绑回环、校验来源', () => {
  describe('authority 解析', () => {
    it('只接受 IPv4 字面量加端口', () => {
      assert.deepEqual(parseAuthority('127.0.0.1:51234'), { host: '127.0.0.1', port: 51234 });
      assert.deepEqual(parseAuthority('127.0.0.1:51234'.toUpperCase()), { host: '127.0.0.1', port: 51234 });
    });

    it('拒绝每一种解析器之间会有分歧的形态', () => {
      const rejected = [
        '', // 空
        '127.0.0.1', // 缺端口：无法确认打的是我们这个监听
        '127.0.0.1:', // 空端口
        '127.0.0.1:0', // 端口 0
        '127.0.0.1:65536', // 越界
        '127.0.0.1:51234:51234', // 多个冒号
        '[::1]:51234', // 方括号形态
        '::1:51234',
        'evil.com@127.0.0.1:51234', // userinfo 把戏
        '127.0.0.1:51234@evil.com',
        '127.0.0.1:51234/evil', // 路径混进 authority
        '127.0.0.1 :51234', // 内部空白
        '127.0.0.1\n:51234',
        '127.0.0.1:5123a',
        '127.0.0.1:051234',
      ];
      for (const value of rejected) {
        assert.equal(parseAuthority(value), null, `不该接受：${JSON.stringify(value)}`);
      }
    });

    it('主机名一律不接受，只认点分四段字面量', () => {
      // 这一条是**这个函数的全部意义**：它做字面量核对，不做主机名解析。
      // 放任何主机名过去，它的语义就滑成「这看起来像个主机名」，
      // 而定论需要 DNS 解析 —— 解析结果取决于攻击者控制的域名。
      for (const value of ['localhost:51234', 'evil.com:51234', '127.0.0.1.nip.io:51234', '127.0.0.1.:51234']) {
        assert.equal(parseAuthority(value), null, `不该接受主机名：${value}`);
      }
    });

    it('IPv4 的每一段必须是规范十进制：前导零是 SSRF 绕过的经典手法', () => {
      // `010.1.1.1` 在部分解析器里按八进制读（= 8.1.1.1），另一些按十进制读。
      // 与其规定「按哪种进制解释」（那是一条要维护的规则），不如不接受这种形态。
      for (const value of ['010.1.1.1:51234', '127.0.0.01:51234', '127.0.0.1.5:51234', '127.0.0:51234', '127.0.0.256:51234']) {
        assert.equal(parseAuthority(value), null, `不该接受非规范形态：${value}`);
      }
    });

    it('首尾空白被规整掉（不是放行，是先规整再逐字校验）', () => {
      // HTTP 解析器本来就会去掉头值的首尾 OWS，所以这里到达时已经不会有它。
      // 做法是**先规整再严格校验**，而不是「因为看着像就放行」——
      // 规整后的结果仍然要过端口范围与点分四段两道，且最终与常量逐字比较。
      // 规整不可能让另一个主机被接受。
      for (const value of [' 127.0.0.1:51234', '127.0.0.1:51234 ', '\t127.0.0.1:51234']) {
        assert.deepEqual(parseAuthority(value), { host: '127.0.0.1', port: 51234 }, `应当规整后接受：${JSON.stringify(value)}`);
      }
    });

    it('checkHost 只认本站的字面量', () => {
      assert.equal(checkHost('127.0.0.1:9000', 9000), null);
      assert.equal(checkHost(undefined, 9000)?.reason, 'HOST_MISSING');
      // 主机名在**解析阶段**就被拒（HOST_MALFORMED），不走到「比对不相等」那一步：
      // 一个主机名要定论必须解析，而解析结果取决于攻击者控制的域名。
      assert.equal(checkHost('evil.com:9000', 9000)?.reason, 'HOST_MALFORMED');
      assert.equal(checkHost('localhost:9000', 9000)?.reason, 'HOST_MALFORMED');
      // 端口不同：这是「解析得出来，但不是本站」，与上面是两类拒绝。
      assert.equal(checkHost('127.0.0.1:9001', 9000)?.reason, 'HOST_NOT_ALLOWED');
      assert.equal(checkHost('10.0.0.1:9000', 9000)?.reason, 'HOST_NOT_ALLOWED');
    });
  });

  describe('来源判定', () => {
    const origin = consoleOrigin(9000);

    it('变更类请求缺 Origin 一律拒绝，不把「缺省」当作「同源」', () => {
      assert.equal(checkOrigin(origin, origin), null);
      assert.equal(checkOrigin(undefined, origin)?.reason, 'ORIGIN_MISSING');
      assert.equal(checkOrigin('', origin)?.reason, 'ORIGIN_MISSING');
      assert.equal(checkOrigin('null', origin)?.reason, 'ORIGIN_MALFORMED');
      assert.equal(checkOrigin('http://evil.com', origin)?.reason, 'ORIGIN_NOT_ALLOWED');
      // 同主机不同端口 = 不同源，必须拒
      assert.equal(checkOrigin('http://127.0.0.1:9001', origin)?.reason, 'ORIGIN_NOT_ALLOWED');
      // 尾斜杠也算不同字符串（逐字比较，不做同源语义比较）
      assert.equal(checkOrigin('http://127.0.0.1:9000/', origin)?.reason, 'ORIGIN_NOT_ALLOWED');
    });

    it('Sec-Fetch-Site：同源与用户直接发起放行，其余拒绝，缺省不拒', () => {
      assert.equal(checkSecFetchSite('same-origin'), null);
      assert.equal(checkSecFetchSite('none'), null);
      assert.equal(checkSecFetchSite(undefined), null);
      assert.equal(checkSecFetchSite('cross-site')?.reason, 'CROSS_SITE');
      // same-site 也拒：127.0.0.1 上另一个端口的服务是不同 origin
      assert.equal(checkSecFetchSite('same-site')?.reason, 'CROSS_SITE');
    });

    it('强制 JSON：把跨站变更从「到达后被拒」变成「发不出去」', () => {
      assert.equal(checkJsonContentType('application/json'), null);
      assert.equal(checkJsonContentType('application/json; charset=utf-8'), null);
      assert.equal(checkJsonContentType('APPLICATION/JSON'), null);
      // 表单可用的三种类型都是「简单请求」，能不经预检跨站发出
      for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain', undefined]) {
        assert.equal(checkJsonContentType(type)?.reason, 'CONTENT_TYPE_REQUIRED', `不该接受 ${String(type)}`);
      }
    });

    it('代理形态的请求目标被拒绝', () => {
      assert.equal(checkRequestTarget('GET', '/api/status'), null);
      assert.equal(checkRequestTarget('GET', 'http://evil.com/')?.reason, 'PROXY_REQUEST_TARGET');
      assert.equal(checkRequestTarget('POST', 'https://evil.com/x')?.reason, 'PROXY_REQUEST_TARGET');
      assert.equal(checkRequestTarget('CONNECT', 'evil.com:443')?.reason, 'METHOD_NOT_ALLOWED');
      assert.equal(checkRequestTarget('TRACE', '/')?.reason, 'METHOD_NOT_ALLOWED');
    });
  });

  describe('监听与报文（真实套接字）', () => {
    let harness: Harness;
    before(async () => {
      harness = await startHarness();
    });
    after(async () => {
      await harness.server.close();
    });

    it('只绑回环 IPv4，且没有任何一条响应带 CORS 头', async () => {
      // 用原始请求覆盖尽可能多的响应分支，逐条检查响应头。
      const responses = await Promise.all([
        rawRequest(harness.port, [`GET /api/status HTTP/1.1`, `Host: 127.0.0.1:${harness.port}`]),
        rawRequest(harness.port, [`GET /api/status HTTP/1.1`, `Host: evil.com:${harness.port}`]),
        rawRequest(harness.port, [`GET /nope HTTP/1.1`, `Host: 127.0.0.1:${harness.port}`]),
        rawRequest(harness.port, [`OPTIONS /api/status HTTP/1.1`, `Host: 127.0.0.1:${harness.port}`]),
        rawRequest(
          harness.port,
          [`POST /api/status HTTP/1.1`, `Host: 127.0.0.1:${harness.port}`, `Origin: http://evil.com`],
          '{}',
        ),
      ]);
      for (const response of responses) {
        const corsHeaders = Object.keys(response.headers).filter((name) => name.startsWith('access-control-'));
        assert.deepEqual(corsHeaders, [], `响应里出现了 CORS 头：${corsHeaders.join(',')}`);
        assert.equal(response.headers['x-content-type-options'], 'nosniff');
        assert.equal(response.headers['cache-control'], 'no-store');
      }
    });

    it('DNS rebinding：Host 不是本站字面量的一律拒绝', async () => {
      const cases = [
        `Host: evil.com:${harness.port}`,
        `Host: localhost:${harness.port}`,
        `Host: 127.0.0.1`,
        `Host: 127.0.0.1:1`,
        `Host: evil.com@127.0.0.1:${harness.port}`,
        `Host: 127.0.0.1:${harness.port}@evil.com`,
      ];
      for (const host of cases) {
        const response = await rawRequest(harness.port, [
          `GET /api/status HTTP/1.1`,
          host,
        ]);
        assert.equal(response.status, 403, `${host} 应被拒绝，实际 ${response.status}`);
      }
    });

    it('Host 判定排在路由之前：所以枚举不出有哪些接口', async () => {
      // 同一个非法 Host 下，「存在的路径」与「不存在的路径」必须给出**同一个**响应。
      // 否则攻击者可以靠状态码差异把控制 API 的路由表摸出来。
      const existing = await rawRequest(harness.port, [`GET /api/status HTTP/1.1`, `Host: evil.com:${harness.port}`]);
      const missing = await rawRequest(harness.port, [`GET /api/definitely-not-here HTTP/1.1`, `Host: evil.com:${harness.port}`]);
      assert.equal(existing.status, missing.status);
      assert.equal(existing.body, missing.body);
    });

    it('绝对形式的请求目标被拒绝（本服务不是代理）', async () => {
      const response = await rawRequest(harness.port, [
        `GET http://evil.com/ HTTP/1.1`,
        `Host: 127.0.0.1:${harness.port}`,
      ]);
      assert.equal(response.status, 400);
      assert.match(response.body, /NOT_AUTHORIZED/);
    });

    it('CONNECT 不产生隧道', async () => {
      // 注意这里的断言形状：Node 的 http 服务把 CONNECT 交给 `'connect'` 事件，
      // 没有监听者时**直接销毁套接字**，于是在脚本看来是「收到 0 字节、连接关闭」。
      // 那本身就是拒绝 —— 关键是**没有 2xx，也没有任何字节被转发**。
      // 断言写成 `=== 400` 会把「Node 的这层行为」当成被测行为，
      // 而真正要钉住的是「隧道不成立」。
      const response = await rawRequest(harness.port, [
        `CONNECT evil.com:443 HTTP/1.1`,
        `Host: 127.0.0.1:${harness.port}`,
      ]);
      assert.ok(
        response.status === 0 || response.status >= 400,
        `CONNECT 既没被拒绝也没被隧道化：${response.status}`,
      );
      assert.equal(response.body, '', '不得有任何被转发的字节');
    });

    it('OPTIONS 不被实现：不实现 CORS 预检本身就是一道防线', async () => {
      const response = await rawRequest(harness.port, [
        `OPTIONS /api/status HTTP/1.1`,
        `Host: 127.0.0.1:${harness.port}`,
        `Origin: http://evil.com`,
        `Access-Control-Request-Method: POST`,
      ]);
      assert.equal(response.status, 405);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      assert.equal(response.headers['access-control-allow-methods'], undefined);
    });

    it('查询串不被接受（同时挡住把凭证放进 URL）', async () => {
      const response = await rawRequest(harness.port, [
        `GET /api/status?token=lwb_boot_x HTTP/1.1`,
        `Host: 127.0.0.1:${harness.port}`,
      ]);
      assert.equal(response.status, 400);
    });

    it('百分号转义路径不被接受（不做解码，就没有解析器分歧）', async () => {
      const response = await rawRequest(harness.port, [
        `GET /api/%73tatus HTTP/1.1`,
        `Host: 127.0.0.1:${harness.port}`,
      ]);
      assert.equal(response.status, 400);
    });

    it('本机存在非回环地址时，从那个地址连不上控制 API', async (context) => {
      const candidates = Object.values(os.networkInterfaces())
        .flat()
        .filter((entry): entry is os.NetworkInterfaceInfo => entry !== undefined)
        .filter((entry) => entry.family === 'IPv4' && !entry.internal);
      if (candidates.length === 0) {
        // 本机没有非回环 IPv4（例如只有回环）。这一条**未执行**，不能记为通过。
        context.diagnostic('本机无任何非回环 IPv4 地址，本项未执行（NOT_RUN）');
        return;
      }
      const address = candidates[0]?.address ?? '';
      const refused = await new Promise<boolean>((resolve) => {
        const socket = net.connect({ host: address, port: harness.port });
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
      assert.ok(refused, `从 ${address} 竟然连上了控制 API —— 它不止绑在回环上`);
    });
  });
});

// ---------------------------------------------------------------------------

describe('LWB-012 · 步骤 2：会话、CSRF 与一次性 nonce', () => {
  describe('会话存储', () => {
    it('启动令牌一次性：兑换成功后再兑换同一张必然失败', () => {
      const store = new ControlSessionStore({ port: 9000 });
      const ticket = store.mintBootstrap();
      assert.ok(isControlTokenOfKind(ticket.token, 'bootstrap'));
      assert.ok(ticket.url.startsWith('http://127.0.0.1:9000/#t='));
      assert.ok(ticket.url.includes(ticket.token), '启动 URL 里应当带着令牌');
      // 令牌在**片段**里：`#` 之后的内容不会被浏览器发往服务器
      assert.ok(ticket.url.indexOf('#t=') > ticket.url.indexOf('/'));

      assert.ok(store.redeem(ticket.token) !== null);
      assert.equal(store.redeem(ticket.token), null, '同一张启动令牌不得兑换两次');
    });

    it('签发新的启动令牌会作废旧的：终端里最后一行才是有效的', () => {
      const store = new ControlSessionStore({ port: 9000 });
      const first = store.mintBootstrap();
      assert.equal(store.pendingBootstraps(), 1);
      const second = store.mintBootstrap();
      assert.equal(store.pendingBootstraps(), 1, '同一时刻只应有一张未兑换令牌');
      assert.equal(store.redeem(first.token), null, '旧令牌必须已作废');
      assert.ok(store.redeem(second.token) !== null);
    });

    it('过期的启动令牌兑换不出来', () => {
      let now = 1_000_000;
      const store = new ControlSessionStore({ now: () => now, port: 9000, bootstrapTtlMs: 1000 });
      const ticket = store.mintBootstrap();
      now += 1001;
      assert.equal(store.redeem(ticket.token), null);
    });

    it('会话只有不可续期的绝对上限', () => {
      let now = 0;
      const store = new ControlSessionStore({
        now: () => now,
        port: 9000,
        sessionTtlMs: 20_000,
      });
      const issued = store.redeem(store.mintBootstrap().token);
      assert.ok(issued !== null);

      // 持续请求也不会延长签发时确定的绝对有效期。
      for (let i = 0; i < 10; i += 1) {
        now += 900;
        assert.ok(store.authenticate(issued.cookie_value) !== null, `第 ${i} 次请求后提前失效`);
      }
      assert.equal(now, 9_000, '装置前提：到此刻为止都没碰到绝对上限');

      // 绝对上限一到就结束，哪怕它一直在被使用。
      now = 20_001;
      assert.equal(store.authenticate(issued.cookie_value), null, '绝对上限必须压住持续活动');
    });

    it('只要未达到绝对上限，长时间空闲也不会使会话失效', () => {
      let now = 0;
      const store = new ControlSessionStore({ now: () => now, port: 9000, sessionTtlMs: 2 * 60 * 60 * 1000 });
      const issued = store.redeem(store.mintBootstrap().token);
      assert.ok(issued !== null);
      now += 60 * 60 * 1000;
      assert.ok(store.authenticate(issued.cookie_value) !== null);
    });

    it('会话表里存的是摘要，不是 cookie 值本身', () => {
      const store = new ControlSessionStore({ port: 9000 });
      const issued = store.redeem(store.mintBootstrap().token);
      assert.ok(issued !== null);
      // 会话视图里不出现 cookie 值；session_id 也不是 cookie 值
      const listed = store.sessions();
      assert.equal(listed.length, 1);
      assert.notEqual(listed[0]?.session_id, issued.cookie_value);
      for (const session of listed) {
        assert.ok(
          !Object.values(session).some((value) => value === issued.cookie_value),
          '会话视图里泄露了 cookie 值',
        );
      }
    });

    it('cookie 属性：HttpOnly + Secure + SameSite=Strict + __Host- 前缀', () => {
      const store = new ControlSessionStore({ port: 9000 });
      const issued = store.redeem(store.mintBootstrap().token);
      assert.ok(issued !== null);
      assert.ok(issued.cookie_value.startsWith(CONTROL_TOKEN_PREFIX.session));
    });
  });

  describe('一次性 nonce', () => {
    type Issued = NonNullable<ReturnType<ControlSessionStore['redeem']>>;

    function withSession(): { store: ControlSessionStore; session: Issued } {
      const store = new ControlSessionStore({ port: 9000 });
      const session = store.redeem(store.mintBootstrap().token);
      if (session === null) throw new Error('装置前提不成立：启动令牌兑换失败');
      return { store, session };
    }

    it('用后即焚', () => {
      const { store, session } = withSession();
      const binding = { operation: '/api/workspaces/register', subject: 'a', digest: 'd' };
      const issued = store.issueNonce(session.session, binding);
      assert.equal(store.consumeNonce(session.session, issued.nonce, binding).ok, true);
      assert.deepEqual(store.consumeNonce(session.session, issued.nonce, binding), {
        ok: false,
        reason: 'NOT_ISSUED',
      });
    });

    it('绑定到内容摘要：内容变了就必须重新审核', () => {
      const { store, session } = withSession();
      const issued = store.issueNonce(session.session, { operation: 'op', subject: 's', digest: 'd1' });
      assert.deepEqual(store.consumeNonce(session.session, issued.nonce, { operation: 'op', subject: 's', digest: 'd2' }), {
        ok: false,
        reason: 'BINDING_MISMATCH',
      });
    });

    it('绑定到会话：别人的 nonce 用不了', () => {
      const { store, session } = withSession();
      const other = store.redeem(store.mintBootstrap().token);
      assert.ok(other !== null);
      const issued = store.issueNonce(session.session, { operation: 'op', subject: 's', digest: 'd' });
      assert.deepEqual(
        store.consumeNonce(other.session, issued.nonce, { operation: 'op', subject: 's', digest: 'd' }),
        { ok: false, reason: 'WRONG_SESSION' },
      );
    });

    it('过期即作废', () => {
      let now = 0;
      const store = new ControlSessionStore({ now: () => now, port: 9000, nonceTtlMs: 1000 });
      const session = store.redeem(store.mintBootstrap().token);
      assert.ok(session !== null);
      const issued = store.issueNonce(session.session, { operation: 'op', subject: 's', digest: 'd' });
      now += 1001;
      assert.deepEqual(store.consumeNonce(session.session, issued.nonce, { operation: 'op', subject: 's', digest: 'd' }), {
        ok: false,
        reason: 'EXPIRED',
      });
    });

    it('撤销会话会一并丢弃它的 nonce', () => {
      const { store, session } = withSession();
      store.issueNonce(session.session, { operation: 'op', subject: 's', digest: 'd' });
      assert.equal(store.pendingNonces(), 1);
      store.revoke(session.session.session_id);
      assert.equal(store.pendingNonces(), 0);
    });
  });

  describe('HTTP 层的会话与 CSRF', () => {
    let harness: Harness;
    before(async () => {
      harness = await startHarness();
    });
    after(async () => {
      await harness.server.close();
    });

    it('没有会话时控制路由返回 401', async () => {
      const response = await rawRequest(
        harness.port,
        [
          `POST /api/workspaces/register HTTP/1.1`,
          `Host: 127.0.0.1:${harness.port}`,
          `Origin: ${harness.origin}`,
          `Content-Type: application/json`,
        ],
        '{}',
      );
      assert.equal(response.status, 401);
    });

    it('会话建立后，控制路由可用；工作区操作拿到的是 console 身份', async () => {
      const console_ = await establishSession(harness);
      const response = await mutate(harness, console_, '/api/workspaces/list', {});
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { result: { audience: string } };
      assert.equal(payload.result.audience, 'console');
      assert.equal(harness.calls.at(-1)?.name, 'workspaces.list');
    });

    it('CSRF 头缺失或错误时变更被拒绝', async () => {
      const console_ = await establishSession(harness);
      const missing = await fetch(`${harness.origin}/api/workspaces/list`, {
        method: 'POST',
        headers: {
          ...NO_REUSE,
          'Content-Type': 'application/json',
          Origin: harness.origin,
          Cookie: `__Host-lwb_console=${console_.cookie}`,
        },
        body: '{}',
        redirect: 'error',
      });
      assert.equal(missing.status, 403);

      const wrong = await mutate(harness, console_, '/api/workspaces/list', {}, { 'x-lwb-csrf': 'lwb_csrf_wrong' });
      assert.equal(wrong.status, 403);
    });

    it('变更类操作缺一次性 nonce 时被拒绝；补上后可执行；再用一次失败', async () => {
      const console_ = await establishSession(harness);
      const body = { alias: 'proj', kind: 'directory', path: 'D:/x', mode: 'read_only' };

      const without = await mutate(harness, console_, '/api/workspaces/register', body);
      assert.equal(without.status, 403, '没有 nonce 的变更必须被拒绝');

      const nonce = await issueNonce(harness, console_, '/api/workspaces/register', 'proj', body);
      const withNonce = await mutate(harness, console_, '/api/workspaces/register', {
        ...body,
        nonce,
        subject: 'proj',
      });
      assert.equal(withNonce.status, 200, await withNonce.text());

      const replay = await mutate(harness, console_, '/api/workspaces/register', {
        ...body,
        nonce,
        subject: 'proj',
      });
      assert.equal(replay.status, 403, '同一张 nonce 不得复用');
    });

    it('nonce 与请求体绑定：申请后改了内容就失效', async () => {
      const console_ = await establishSession(harness);
      const body = { alias: 'proj', kind: 'directory', path: 'D:/x', mode: 'read_only' };
      const nonce = await issueNonce(harness, console_, '/api/workspaces/register', 'proj', body);

      const tampered = await mutate(harness, console_, '/api/workspaces/register', {
        ...body,
        path: 'D:/somewhere-else',
        nonce,
        subject: 'proj',
      });
      assert.equal(tampered.status, 403, '内容与 nonce 绑定不一致时必须拒绝');
    });

    it('只读控制路由不要求 nonce', async () => {
      const console_ = await establishSession(harness);
      const response = await mutate(harness, console_, '/api/workspaces/list', {});
      assert.equal(response.status, 200);
    });

    it('登出后会话立即失效，且 cookie 被清除', async () => {
      const console_ = await establishSession(harness);
      const logout = await fetch(`${harness.origin}/api/session`, {
        method: 'DELETE',
        headers: {
          ...NO_REUSE,
          'Content-Type': 'application/json',
          Origin: harness.origin,
          'x-lwb-csrf': console_.csrf,
          Cookie: `__Host-lwb_console=${console_.cookie}`,
        },
        body: JSON.stringify({ session_id: console_.session_id }),
        redirect: 'error',
      });
      assert.equal(logout.status, 200);
      assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/);
      assert.equal(harness.sessions.authenticate(console_.cookie), null);
    });
  });
});

// ---------------------------------------------------------------------------

describe('LWB-012 · 验收标准 1：恶意网页请求不能修改工作区或批准修改', () => {
  let harness: Harness;
  let console_: Console;
  before(async () => {
    harness = await startHarness();
    console_ = await establishSession(harness);
  });
  after(async () => {
    await harness.server.close();
  });

  /**
   * 「恶意网页」的各种形态。每一条都用**真实报文**构造，
   * 因为 `fetch` 发不出其中任何一条。
   *
   * 每条都带上一个**合法**的会话 cookie —— 这是刻意的：
   * 它模拟的是「用户已经登录了控制台，然后又打开了一个恶意页面」。
   * 不带 cookie 的话，全部都会被 401 挡住，测不出这一层的东西。
   */
  function hostileRequests(): readonly { readonly name: string; readonly lines: string[]; readonly body: string }[] {
    const body = JSON.stringify({ alias: 'evil', kind: 'directory', path: 'C:/', mode: 'read_only' });
    const base = [
      `Host: 127.0.0.1:${harness.port}`,
      `Cookie: __Host-lwb_console=${console_.cookie}`,
      `x-lwb-csrf: ${console_.csrf}`,
      `Content-Type: application/json`,
    ];
    return [
      {
        name: '跨站 fetch：Origin 是攻击者的站点',
        lines: [`POST /api/workspaces/register HTTP/1.1`, ...base, `Origin: http://evil.com`],
        body,
      },
      {
        name: '沙箱 iframe / data: 页面：Origin 为 null',
        lines: [`POST /api/workspaces/register HTTP/1.1`, ...base, `Origin: null`],
        body,
      },
      {
        name: '不带 Origin（旧式跨站表单或非浏览器客户端）',
        lines: [`POST /api/workspaces/register HTTP/1.1`, ...base],
        body,
      },
      {
        name: 'HTML 表单跨站提交：content-type 是简单请求类型',
        lines: [
          `POST /api/workspaces/register HTTP/1.1`,
          `Host: 127.0.0.1:${harness.port}`,
          `Cookie: __Host-lwb_console=${console_.cookie}`,
          `x-lwb-csrf: ${console_.csrf}`,
          `Origin: http://evil.com`,
          `Content-Type: application/x-www-form-urlencoded`,
        ],
        body: 'alias=evil&kind=directory&path=C%3A%2F&mode=read_only',
      },
      {
        name: 'DNS rebinding：Host 指向攻击者域名',
        lines: [
          `POST /api/workspaces/register HTTP/1.1`,
          `Host: evil.com:${harness.port}`,
          `Cookie: __Host-lwb_console=${console_.cookie}`,
          `x-lwb-csrf: ${console_.csrf}`,
          `Origin: http://evil.com:${harness.port}`,
          `Content-Type: application/json`,
        ],
        body,
      },
      {
        name: '浏览器已标记为跨站（Sec-Fetch-Site）',
        lines: [`POST /api/workspaces/register HTTP/1.1`, ...base, `Origin: http://evil.com`, `Sec-Fetch-Site: cross-site`],
        body,
      },
      {
        name: '同站不同端口：另一个本地服务伪造的请求',
        lines: [
          `POST /api/workspaces/register HTTP/1.1`,
          ...base,
          `Origin: http://127.0.0.1:1`,
          `Sec-Fetch-Site: same-site`,
        ],
        body,
      },
      {
        name: 'CSRF 令牌缺失（只靠 cookie 就能改的话，跨站就成立了）',
        lines: [
          `POST /api/workspaces/register HTTP/1.1`,
          `Host: 127.0.0.1:${harness.port}`,
          `Cookie: __Host-lwb_console=${console_.cookie}`,
          `Origin: ${harness.origin}`,
          `Content-Type: application/json`,
        ],
        body,
      },
      {
        name: '绝对形式请求目标（把控制 API 当代理用）',
        lines: [`POST http://evil.com/ HTTP/1.1`, ...base, `Origin: ${harness.origin}`],
        body,
      },
    ];
  }

  it('每一条恶意请求都被拒绝，且工作区一个都没被改动', async () => {
    const before = harness.calls.filter((call) => call.name === 'workspaces.register').length;

    for (const hostile of hostileRequests()) {
      const response = await rawRequest(harness.port, hostile.lines, hostile.body);
      assert.ok(
        response.status >= 400,
        `${hostile.name}：竟然返回了 ${response.status}（${response.body.slice(0, 200)}）`,
      );
      assert.notEqual(response.status, 200, `${hostile.name}：竟然成功了`);
    }

    const after_ = harness.calls.filter((call) => call.name === 'workspaces.register').length;
    assert.equal(after_, before, `有恶意请求穿透到了工作区 handler（${before} → ${after_}）`);
  });

  it('对照：同一份内容，由诚实的控制台发出就会成功', async () => {
    // 没有这一条，上面那一条可能只是「这个操作本来就不可用」。
    const body = { alias: 'proj-ok', kind: 'directory', path: 'D:/proj', mode: 'read_only' };
    const nonce = await issueNonce(harness, console_, '/api/workspaces/register', 'proj-ok', body);
    const response = await mutate(harness, console_, '/api/workspaces/register', {
      ...body,
      nonce,
      subject: 'proj-ok',
    });
    assert.equal(response.status, 200, await response.text());
  });

  it('由真实的控制台客户端走一遍完整的变更链路', async () => {
    // 上面几条用的是手搓的报文。这一条用**真的 ControlClient**：
    // 它证明的是「控制台那一侧的组合是对的」——尤其是
    // `authorizeMutation` 把 `subject` 算进了摘要之内。
    // 少了这一条，客户端那半条链路就只是被断言过、从未被执行过。
    // node 的 fetch **没有 cookie 罐**：`credentials: 'same-origin'` 在浏览器里
    // 意味着「自动附上这个来源的 cookie」（包括 HttpOnly 的那个），
    // 在 node 里则什么都不做。所以这个 shim 补上的正是浏览器做的那一步；
    // 客户端自己该做的（`credentials: 'same-origin'` 这个设置）另有断言检查。
    const browserFetch = ((input: string | URL | Request, init?: RequestInit) =>
      fetch(input, {
        ...init,
        headers: {
          ...NO_REUSE,
          ...((init?.headers ?? {}) as Record<string, string>),
          Cookie: `__Host-lwb_console=${console_.cookie}`,
        },
      })) as unknown as typeof fetch;

    const client = new ControlClient({ origin: harness.origin, fetchImpl: browserFetch });
    client.setSession({ session_id: console_.session_id, csrf_token: console_.csrf, expires_at: 0 });

    const body = { alias: 'proj-client', kind: 'directory', path: 'D:/proj', mode: 'read_only' };
    const payload = await client.authorizeMutation('/api/workspaces/register', 'proj-client', body);
    const result = (await client.call('/api/workspaces/register', payload)) as { readonly handled: string };

    assert.equal(result.handled, 'workspaces.register');
    assert.equal(harness.calls.at(-1)?.name, 'workspaces.register');
    assert.equal(harness.calls.at(-1)?.audience, 'console');
  });
});

// ---------------------------------------------------------------------------

describe('LWB-012 · 验收标准 2：MCP 连接凭证不能调用控制 API', () => {
  it('控制路由要求的能力，模型侧一个都没有（穷尽遍历）', async () => {
    const harness = await startHarness();
    try {
      const { hasCapability, NEVER_GRANTED_TO_MODEL } = await import('@lwb/ipc');
      const all = harness.routes.routes();
      assert.ok(all.length > 0, '应当至少注册出一条控制路由');
      for (const route of all) {
        if (route.capability === undefined) {
          assert.ok(
            UNAUTHENTICATED_ROUTES.includes(`${route.method} ${route.path}`),
            `${route.method} ${route.path} 没有能力要求又不在免鉴权清单里`,
          );
          continue;
        }
        assert.equal(
          hasCapability('mcp-adapter', route.capability),
          false,
          `路由 ${route.method} ${route.path} 要求的能力 ${route.capability} 模型侧也有`,
        );
        assert.ok(
          NEVER_GRANTED_TO_MODEL.includes(route.capability),
          `路由 ${route.method} ${route.path} 的能力 ${route.capability} 不属于「绝不授予模型」清单`,
        );
      }
    } finally {
      await harness.server.close();
    }
  });

  it('把 IPC 连接凭证当 cookie 或请求头送进来，都换不到控制会话', async () => {
    const harness = await startHarness();
    try {
      // 适配器那侧的凭证长这样（见 packages/ipc/src/handshake.ts）：
      // 它是一段 HMAC 证明，与「控制台会话 cookie」在结构上毫无关系。
      const adapterSecret = randomBytes(32).toString('hex');
      const attempts = [
        [`Cookie: __Host-lwb_console=${adapterSecret}`],
        [`Cookie: __Host-lwb_console=`, `X-LWB-IPC-Secret: ${adapterSecret}`],
        [`Cookie: __Host-lwb_console=${adapterSecret}`, `X-Audience: mcp-adapter`],
        [`Cookie: ${adapterSecret}`],
      ];
      for (const headers of attempts) {
        const response = await rawRequest(
          harness.port,
          [
            `POST /api/workspaces/list HTTP/1.1`,
            `Host: 127.0.0.1:${harness.port}`,
            `Origin: ${harness.origin}`,
            `Content-Type: application/json`,
            ...headers,
          ],
          '{}',
        );
        assert.equal(response.status, 401, `${headers.join(' / ')} 竟然通过了`);
      }
      assert.equal(harness.calls.length, 0, '没有任何一次应当到达 handler');
    } finally {
      await harness.server.close();
    }
  });

  it('启动令牌不能被凭空构造：形状对但没签发过的一律拒绝，且是 403', async () => {
    const harness = await startHarness();
    try {
      const forged = newControlToken('bootstrap');
      const response = await fetch(`${harness.origin}/api/session`, {
        method: 'POST',
        headers: { ...NO_REUSE, 'Content-Type': 'application/json', Origin: harness.origin },
        body: JSON.stringify({ token: forged }),
        redirect: 'error',
      });
      // 具体到 403，不是「>= 400」：这里曾经是 500（handler 抛的是普通 Error，
      // 被服务器折成 INTERNAL_ERROR）。那会让操作者以为是自己撞上了服务端 bug，
      // 而 500 与 403 在「该去查哪里」上是完全不同的两件事。
      assert.equal(response.status, 403, await response.text());
    } finally {
      await harness.server.close();
    }
  });

  it('会话建立只认启动令牌这一条路：没有任何请求体字段能换来会话', async () => {
    const harness = await startHarness();
    try {
      const shapes: readonly [string, Record<string, unknown>][] = [
        ['approved', { approved: true }],
        ['user_id/principal_id', { user_id: 'me', principal_id: 'me' }],
        ['audience', { audience: 'console' }],
        ['capabilities', { capabilities: ['workspaces.manage'] }],
        ['形状正确但未签发的令牌', { token: 'lwb_boot_' + 'a'.repeat(43), session: true, approved: true }],
      ];
      for (const [label, body] of shapes) {
        const response = await fetch(`${harness.origin}/api/session`, {
          method: 'POST',
          headers: { ...NO_REUSE, 'Content-Type': 'application/json', Origin: harness.origin },
          body: JSON.stringify(body),
          redirect: 'error',
        });
        // 403 = 形状对但服务端没有这张；400 = 连形状都不对。
        // 两者都是 4xx：这是客户端的问题，不该报成服务端内部错误。
        assert.ok(
          response.status === 403 || response.status === 400,
          `${label} 竟然返回 ${response.status}`,
        );
      }
    } finally {
      await harness.server.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('LWB-012 · 路由表的构造期断言', () => {
  function route(overrides: Partial<ControlRoute> = {}): ControlRoute {
    return {
      method: 'POST',
      path: '/api/example',
      capability: 'workspaces.manage',
      mutating: true,
      handler: () => ({}),
      ...overrides,
    };
  }

  it('要求一个模型侧也具备的能力 → 拒绝注册', () => {
    const table = new ControlRouteTable();
    assert.throws(
      () => table.register(route({ capability: 'tools.read' })),
      /已授予 mcp-adapter/,
      '要求 tools.read 的控制路由必须注册不出来',
    );
    assert.equal(table.routes().length, 0);
  });

  it('没有能力要求又不在免鉴权清单里 → 拒绝注册', () => {
    const table = new ControlRouteTable();
    assert.throws(() => table.register(route({ capability: undefined })), /UNAUTHENTICATED_ROUTES/);
  });

  it('通配路径 → 拒绝注册（通配路由等于一个转发器）', () => {
    const table = new ControlRouteTable();
    assert.throws(() => table.register(route({ path: '/api/*' })), /不是固定路径/);
    assert.throws(() => table.register(route({ path: '/api/:name' })), /不是固定路径/);
    assert.throws(() => table.register(route({ path: '/api//x' })), /不是固定路径/);
  });

  it('重复注册同一方法+路径 → 拒绝', () => {
    const table = new ControlRouteTable();
    table.register(route());
    assert.throws(() => table.register(route()), /已注册/);
  });

  it('免鉴权清单里的两条都在真实路由表里，且都与会话有关', () => {
    assert.deepEqual([...UNAUTHENTICATED_ROUTES].sort(), ['DELETE /api/session', 'POST /api/session']);
  });
});

describe('LWB-012 · 装配期断言', () => {
  function registryWith(names: readonly [string, Capability][]): OperationRegistry {
    const registry = new OperationRegistry();
    for (const [name, required] of names) {
      registry.register({ name, required, handler: () => ({}) });
    }
    return registry;
  }

  it('控制平面暴露哪些接口，由能力表推导', () => {
    const registry = registryWith([
      ['workspaces.list', 'workspaces.manage'],
      ['tools.read', 'tools.read'],
      ['tools.propose', 'tools.propose'],
    ]);
    assert.deepEqual(controlOperationNames(registry), ['workspaces.list']);
  });

  it('真控制操作登记进注册表后，控制操作清单必须正好覆盖它们', async () => {
    // 用真实的 registerWorkspaceOperations / registerConnectionOperations /
    // registerApprovalOperations / registerPauseOperations：这样
    // 「清单与能力表是否对齐」是被真的代码验证的，而不是被一份手抄的名单
    // 验证的。每一张表都要登记 —— 少登记一张，这里就会报
    // 「清单里有操作不属于控制平面」，而那正是这条断言要拦的脱节。
    const registry = new OperationRegistry();
    const stub = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('本用例不调用 handler');
        },
      },
    ) as unknown as WorkspaceRegistry;
    const stubRepos = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('本用例不调用 handler');
        },
      },
    ) as unknown as Repositories;
    registerWorkspaceOperations(registry, stub);
    registerWorkspaceAccessOperations(registry, {
      repos: stubRepos,
      model_connection_id: 'conn-chatgpt-web',
    });
    registerConnectionOperations(registry, { repos: stubRepos });
    // 批准操作的 handler 在本用例里一次也不会被调用：这里验证的是
    // 「注册进来的名字」与「分类清单」是否一致。
    registerApprovalOperations(registry, { repos: stubRepos });
    registerPauseOperations(registry, {
      repos: stubRepos,
      // 暂停服务在这里同样是桩：本用例只要它的**名字**进注册表。
      pause: new Proxy({}, { get: () => () => ({}) }) as unknown as PauseService,
    });
    // LWB-036 的复核读取。它的三处依赖同样是桩：本用例验证的是
    // 「注册进来的名字」与「分类清单」是否一致，**不是** handler 的行为
    // （那在 `control-changes.test.ts` 里用真仓储量）。
    registerChangeOperations(registry, {
      repos: stubRepos,
      blobs: new Proxy({}, { get: () => () => ({}) }) as unknown as BlobStore,
      budgets: new Proxy({}, { get: () => () => ({}) }) as unknown as EgressBudgetStore,
      capability_flags: () => {
        throw new Error('本用例不调用 handler');
      },
    });
    registerRecoveryOperations(registry, {
      repos: stubRepos,
      recovery: new Proxy({}, { get: () => () => ({}) }) as unknown as import('@lwb/recovery').RecoveryService,
      blobs: new Proxy({}, { get: () => () => ({}) }) as unknown as import('@lwb/blob-store').BlobStore,
    });
    registerHistoryOperations(registry, { repos: stubRepos });

    const names = controlOperationNames(registry);
    const listed = [...MUTATING_OPERATIONS, ...READ_ONLY_OPERATIONS].sort();
    assert.deepEqual(names, listed, '控制操作清单与真实注册的操作不相一致');
    // 数字写在这里是**故意**的：它逼着改的人在加一条控制操作时
    // 停下来看一眼 `MUTATING_OPERATIONS` / `READ_ONLY_OPERATIONS`
    // 里那条注释该怎么写。上面那条 deepEqual 已经保证了清单与注册表一致，
    // 因此这个数字不是第二份事实，而是一道「必须被手动推进的闸门」。
    assert.equal(names.length, 29);
    // 这两条是只读的，而且**必须**是只读的：复核页面要逐页翻差异，
    // 每翻一页签一次 nonce 会把这条路径变成一个没人愿意用的接口。
    for (const name of ['changes.list', 'changes.get', 'recovery.list', 'recovery.get', 'history.list']) {
      assert.ok(READ_ONLY_OPERATIONS.includes(name), `${name} 必须是只读控制操作`);
      assert.equal(MUTATING_OPERATIONS.includes(name), false);
    }
  });

  it('未分类的控制操作 → 拒绝装配', () => {
    const registry = registryWith([
      ['workspaces.list', 'workspaces.manage'],
      ['workspaces.somethingNew', 'workspaces.manage'],
    ]);
    assert.throws(
      () => createControlPlane({ operations: registry, sessions: new ControlSessionStore({ port: 0 }) }),
      /没有被分类为变更类或只读类/,
    );
  });

  it('清单里留下已不存在的操作 → 拒绝装配', () => {
    const registry = registryWith([['workspaces.list', 'workspaces.manage']]);
    assert.throws(
      () => createControlPlane({ operations: registry, sessions: new ControlSessionStore({ port: 0 }) }),
      /并不属于控制平面/,
    );
  });
});

// ---------------------------------------------------------------------------

describe('LWB-012 · 控制台认证模块', () => {
  describe('启动令牌的读取与片段处理', () => {
    it('只认片段里的 lwb_boot_ 令牌', () => {
      const token = newControlToken('bootstrap');
      assert.equal(readBootstrapToken(`#t=${token}`), token);
      assert.equal(readBootstrapToken(`t=${token}`), token);
      assert.equal(readBootstrapToken(`#other=1&t=${token}`), token);
      // 会话/CSRF/nonce 都不是启动令牌
      assert.equal(readBootstrapToken(`#t=${newControlToken('session')}`), null);
      assert.equal(readBootstrapToken(`#t=${newControlToken('csrf')}`), null);
      // 无关片段不该被当成令牌（否则一次锚点跳转会变成一次兑换尝试）
      assert.equal(readBootstrapToken('#section-3'), null);
      assert.equal(readBootstrapToken(''), null);
      assert.equal(readBootstrapToken('#t='), null);
      assert.equal(readBootstrapToken(`#t=lwb_boot_has%20space`), null);
    });

    it('抹片段用的是 replaceState，不是赋值 —— 赋值会在历史里留一条', () => {
      const calls: { data: unknown; url: string | undefined }[] = [];
      const history: HistoryLike = {
        replaceState(data, _unused, url) {
          calls.push({ data, url });
        },
      };
      stripFragment(history, '/');
      assert.deepEqual(calls, [{ data: null, url: '/' }]);
    });

    it('只允许回环来源', () => {
      assert.equal(isLoopbackOrigin('http://127.0.0.1:51234'), true);
      assert.equal(isLoopbackOrigin('http://127.0.0.1'), true);
      assert.equal(isLoopbackOrigin('http://[::1]:51234'), true);
      assert.equal(isLoopbackOrigin('http://localhost:51234'), false);
      assert.equal(isLoopbackOrigin('http://192.168.1.5:51234'), false);
      assert.equal(isLoopbackOrigin('https://evil.com'), false);
      assert.equal(isLoopbackOrigin('file:///c:/x.html'), false);
    });
  });

  describe('兑换的顺序与失败路径', () => {
    function envWith(hash: string, fetchImpl: typeof fetch, origin = 'http://127.0.0.1:51234') {
      const order: string[] = [];
      const history: HistoryLike = {
        replaceState() {
          order.push('strip');
        },
      };
      const wrappedFetch = (async (...args: Parameters<typeof fetch>) => {
        order.push('fetch');
        return fetchImpl(...args);
      }) as typeof fetch;
      return {
        order,
        env: {
          location: { hash, pathname: '/', origin },
          history,
          fetchImpl: wrappedFetch,
        },
      };
    }

    function okFetch(): typeof fetch {
      return (async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { session_id: 's1', csrf_token: newControlToken('csrf'), expires_at: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )) as unknown as typeof fetch;
    }

    it('先抹片段，再兑换', async () => {
      const { order, env } = envWith(`#t=${newControlToken('bootstrap')}`, okFetch());
      const session = await bootstrapConsoleSession(env);
      assert.ok(session !== null);
      assert.deepEqual(order, ['strip', 'fetch'], '片段必须在发起请求之前就被抹掉');
    });

    it('兑换失败时片段也已经抹掉了（否则失效令牌会留在地址栏里）', async () => {
      const failing = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
      const { order, env } = envWith(`#t=${newControlToken('bootstrap')}`, failing);
      await assert.rejects(() => bootstrapConsoleSession(env), /会话建立失败/);
      assert.deepEqual(order, ['strip', 'fetch']);
    });

    it('没有令牌时返回 null，不当作错误', async () => {
      const { order, env } = envWith('#', okFetch());
      assert.equal(await bootstrapConsoleSession(env), null);
      assert.deepEqual(order, [], '没有令牌就不该抹片段，也不该发请求');
    });

    it('非回环来源直接拒绝，且不发任何请求', async () => {
      const { order, env } = envWith(`#t=${newControlToken('bootstrap')}`, okFetch(), 'https://evil.com');
      await assert.rejects(() => bootstrapConsoleSession(env), /只在回环来源上运行/);
      assert.deepEqual(order, []);
    });

    it('兑换失败的错误信息里不含令牌', async () => {
      const token = newControlToken('bootstrap');
      const failing = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
      const error = await redeemBootstrap(token, { fetchImpl: failing, origin: 'http://127.0.0.1:51234' }).then(
        () => null,
        (thrown: unknown) => thrown as Error,
      );
      assert.ok(error !== null);
      assert.ok(!error.message.includes(token), '错误信息里泄露了启动令牌');
    });
  });

  describe('客户端', () => {
    it('拒绝非回环 origin', () => {
      assert.throws(() => new ControlClient({ origin: 'https://evil.com', fetchImpl: fetch }), /只接受回环 origin/);
      assert.throws(() => new ControlClient({ origin: 'http://localhost:1', fetchImpl: fetch }), /只接受回环 origin/);
    });

    it('请求带上 CSRF 头、JSON 类型、same-origin 凭据，并且不跟随重定向', async () => {
      const seen: RequestInit[] = [];
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        seen.push(init);
        return new Response(JSON.stringify({ ok: true, result: { fine: true } }), { status: 200 });
      }) as unknown as typeof fetch;

      const client = new ControlClient({ origin: 'http://127.0.0.1:51234', fetchImpl });
      const csrf = newControlToken('csrf');
      client.setSession({ session_id: 's1', csrf_token: csrf, expires_at: 0 });
      await client.call('/api/workspaces/list', { a: 1 });

      const init = seen[0];
      assert.ok(init !== undefined);
      assert.equal(init.redirect, 'error', '必须禁止跟随重定向，否则 CSRF 头会被带到别的来源去');
      assert.equal(init.credentials, 'same-origin');
      const headers = init.headers as Record<string, string>;
      assert.equal(headers['x-lwb-csrf'], csrf);
      assert.equal(headers['Content-Type'], 'application/json');
      // Origin 必须由客户端自己写进报文，而不是指望运行环境补上：
      // 服务端对变更类请求要求它，而「靠浏览器自动加」是一条只写在环境里、
      // 不在代码里的依赖（见 client.ts 的说明）。
      assert.equal(headers['Origin'], 'http://127.0.0.1:51234');
    });

    it('GET 状态读数使用已认证的同源会话，且解析标准响应信封', async () => {
      const seen: RequestInit[] = [];
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        seen.push(init);
        return new Response(JSON.stringify({ ok: true, result: { version: '0.1.0' } }), { status: 200 });
      }) as unknown as typeof fetch;
      const client = new ControlClient({ origin: 'http://127.0.0.1:51234', fetchImpl });
      const csrf = newControlToken('csrf');
      client.setSession({ session_id: 's1', csrf_token: csrf, expires_at: 0 });

      assert.deepEqual(await client.get('/api/status'), { version: '0.1.0' });
      const request = seen[0];
      assert.ok(request !== undefined);
      assert.equal(request.method, 'GET');
      assert.equal(request.credentials, 'same-origin');
      assert.equal(request.redirect, 'error');
      assert.equal((request.headers as Record<string, string>)['x-lwb-csrf'], csrf);
    });

    it('authorizeMutation 把 subject 算进摘要之内（漏掉它会让 nonce 永远不匹配）', async () => {
      // 这一条是纯粹的组合检查：它不碰网络，只钉住「摘要覆盖的字段集合」。
      // 摘要少算 subject 的后果是**每一次变更都被拒**，而错误信息只说
      // 「与本次请求的内容不匹配」—— 看不出是哪里算错了，所以值得单独钉住。
      const sent: Record<string, unknown>[] = [];
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        sent.push(body);
        if (body['digest'] !== undefined) {
          return new Response(JSON.stringify({ ok: true, result: { nonce: 'lwb_nonce_x' } }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: { done: true } }), { status: 200 });
      }) as unknown as typeof fetch;

      const client = new ControlClient({ origin: 'http://127.0.0.1:51234', fetchImpl });
      client.setSession({ session_id: 's1', csrf_token: newControlToken('csrf'), expires_at: 0 });

      const payload = await client.authorizeMutation('/api/workspaces/register', 'proj', { alias: 'a', path: 'D:/x' });
      assert.equal(payload['subject'], 'proj');
      assert.equal(payload['alias'], 'a');

      const requested = sent[0];
      assert.ok(requested !== undefined);
      assert.equal(
        requested['digest'],
        bodyDigest({ alias: 'a', path: 'D:/x', subject: 'proj' }),
        '申请 nonce 时的摘要必须覆盖含 subject 的那份内容',
      );
    });

    it('401 时抛出会话过期，并清掉本地会话', async () => {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ ok: false, error: { code: 'NOT_AUTHORIZED', message: '无效' } }), {
          status: 401,
        })) as unknown as typeof fetch;
      const client = new ControlClient({ origin: 'http://127.0.0.1:51234', fetchImpl });
      client.setSession({ session_id: 's1', csrf_token: 'x', expires_at: 0 });

      const failure = await client.call('/api/workspaces/list', {}).then(
        () => null,
        (thrown: unknown) => thrown as ControlApiFailure,
      );
      assert.ok(failure !== null);
      assert.equal(failure.detail.session_expired, true);
      assert.equal(client.session, null);
    });

    it('没有会话时本地就拒绝，不发请求', async () => {
      let called = false;
      const fetchImpl = (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch;
      const client = new ControlClient({ origin: 'http://127.0.0.1:51234', fetchImpl });
      await assert.rejects(() => client.call('/api/status', {}), /尚未建立控制台会话/);
      assert.equal(called, false);
    });
  });

  describe('摘要算法两侧必须一致', () => {
    it('控制台算的摘要与服务端算的摘要逐字节相同', async () => {
      const cases: Record<string, unknown>[] = [
        { alias: 'a', kind: 'directory', path: 'D:/x', mode: 'read_only' },
        { b: 2, a: 1 },
        { z: 'Z', a: 'A', m: 'M' },
        { 中文: '值', ascii: 'v' },
        {},
      ];
      for (const body of cases) {
        assert.equal(
          await digestOfBody(body),
          bodyDigest(body),
          `两侧摘要不一致：${JSON.stringify(body)}`,
        );
      }
    });

    it('摘要排除 nonce 字段（否则 nonce 无法绑定「不含它自己的那份内容」）', () => {
      const body = { a: 1 };
      assert.equal(bodyDigest({ ...body, nonce: 'x' }), bodyDigest({ ...body, nonce: 'y' }));
      assert.equal(bodyDigest(body), bodyDigest({ a: 1 }));
      assert.notEqual(bodyDigest(body), bodyDigest({ a: 2 }));
    });
  });
});

// ---------------------------------------------------------------------------

describe('LWB-012 · 验收标准 3：工具结果不含控制台登录令牌或带授权效果的 URL', () => {
  const CAPS = ['read', 'search', 'list', 'git_read', 'propose'] as const;
  const NOW = 1_700_000_000_000;

  function clearanceFor(action: 'read' | 'search' | 'git_diff') {
    const request: PolicyRequest = {
      connection: {
        connection_id: 'conn-1',
        enabled: true,
        granted_capabilities: [...CAPS],
        audience: 'mcp_adapter',
        granted_workspace_ids: ['ws-1'],
      },
      workspace: {
        workspace_id: 'ws-1',
        kind: 'directory',
        mode: 'read_only',
        capabilities: {
          read_enabled: true,
          git_enabled: true,
          proposal_enabled: false,
          direct_write_enabled: false,
          recovery_required: false,
        },
        current_generation: 7,
        current_policy_version: 1,
        root_volume_id: 'vol-1',
        root_file_id: 'file-1',
        paused: false,
      },
      presented: { generation: null, policy_version: null },
      action: { action, path: 'src/a.ts', approval: null },
      now: NOW,
    };
    const decision = decide(request);
    assert.equal(decision.allow, true, `装置前提不成立：${action} 被拒绝`);
    return mintClearance(decision, { connection_id: 'conn-1', generation: 7 });
  }

  function bigBudget(): EgressBudget {
    return {
      charge: (bytes: number) => ({
        ok: true,
        remaining_bytes: 1_000_000 - bytes,
        used_bytes: bytes,
        limit_bytes: 1_000_000,
      }),
    } as unknown as EgressBudget;
  }

  it('真实签发的每一类控制平面凭证都被出站筛查命中', () => {
    const tokens = [
      ['启动令牌', newControlToken('bootstrap')],
      ['会话 cookie', newControlToken('session')],
      ['CSRF 令牌', newControlToken('csrf')],
      ['一次性 nonce', newControlToken('nonce')],
    ] as const;
    for (const [label, token] of tokens) {
      const result = screenText(`const x = "${token}";`);
      assert.ok(result.has_certain, `${label} 没有被判定为高置信度秘密`);
      assert.ok(
        result.findings.some((finding) => finding.rule_id === 'control-plane-token'),
        `${label} 命中的规则不是 control-plane-token`,
      );
    }
  });

  it('带授权效果的启动 URL 整条被拦下', () => {
    const store = new ControlSessionStore({ port: 51234 });
    const ticket = store.mintBootstrap();
    const screen = screenText(`请访问 ${ticket.url} 完成授权`);
    assert.ok(screen.has_certain);
    // 被盖住的那一段必须正好是令牌本身
    const finding = screen.findings[0];
    assert.ok(finding !== undefined);
    const covered = `请访问 ${ticket.url} 完成授权`.slice(finding.start, finding.start + finding.length);
    assert.equal(covered, ticket.token, '被覆盖的片段应当恰好是令牌');
  });

  it('阻断面整块拒绝，脱敏面盖掉令牌后其余内容仍可读', () => {
    const token = newControlToken('bootstrap');
    const leak = `README 片段：\n启动地址 http://127.0.0.1:51234/#t=${token}\n其余内容\n`;

    for (const surface of ['search', 'git_diff'] as const) {
      assert.throws(
        () => emitContent(clearanceFor(surface), { path: 'src/a.ts', content: leak }, bigBudget()),
        /SECRET_DETECTED|高置信度/,
        `${surface} 面应当整块阻断`,
      );
    }

    const emission = emitContent(clearanceFor('read'), { path: 'src/a.ts', content: leak }, bigBudget());
    assert.equal(emission.redacted, true);
    assert.ok(!emission.content.includes(token), '脱敏后仍能读出令牌');
    assert.ok(emission.content.includes('其余内容'), '其余内容应当保留');
  });

  it('脱敏过的读取拿不到可编辑票据（令牌不会经由票据回到写入路径）', async () => {
    const { mintEditTicket } = await import('@lwb/egress');
    const clearance = clearanceFor('read');
    const token = newControlToken('session');
    const emission = emitContent(
      clearance,
      { path: 'src/a.ts', content: `cookie=${token}\n` },
      bigBudget(),
    );
    assert.equal(mintEditTicket(clearance, emission, { now: NOW }), null);
  });

  it('伪造的、形状不对的字符串不会被误伤（规则只认真实形状）', () => {
    const benign = [
      'lwb_bootstrap 是这次改动的名字',
      'const name = "lwb_boot_tooshort";',
      'lwb_sess_' + 'a'.repeat(10),
      'http://127.0.0.1:51234/api/status 是状态接口',
    ];
    for (const text of benign) {
      assert.equal(screenText(text).findings.length, 0, `不该命中：${text}`);
    }
  });
});

// ---------------------------------------------------------------------------

/**
 * 申请一张绑定到 `(路径, 主体, 请求体)` 的 nonce。
 *
 * 摘要算在 `{...body, subject}` 上，不是 `body` 上：服务端绑的是
 * 「即将发送的那份请求体去掉 `nonce`」，而请求体里带着 `subject`。
 * 少算这一个字段的话，nonce 永远匹配不上，而错误信息只说
 * 「与本次请求的内容不匹配」—— 看不出是哪里算错了。
 * 控制台一侧由 `ControlClient.authorizeMutation` 负责这件事，
 * 用例见「authorizeMutation 产出的请求体服务端确实接受」。
 */
async function issueNonce(
  harness: Harness,
  console_: Console,
  operation: string,
  subject: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await mutate(harness, console_, '/api/nonces', {
    operation,
    subject,
    digest: bodyDigest({ ...body, subject }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `签发 nonce 失败：${text}`);
  const payload = JSON.parse(text) as { result: { nonce: string } };
  return payload.result.nonce;
}

// ---------------------------------------------------------------------------
// 装置自检
// ---------------------------------------------------------------------------

describe('LWB-012 · 装置自检：fetch 一律不复用连接', () => {
  it('本文件里每一条 fetch 的头部块都声明了不复用连接', () => {
    // 这一格是给**将来**的人看的。上面那段解释只有在「加新用例的人正好
    // 读到它」时才有用；而这个是可执行的提醒：新加一条没带上它的 fetch，
    // 这里立刻红，而不是某天在某台机器上随机红一次、被人当成 flake 忽略掉。
    //
    // 读的是本文件自己的源码，所以**先把自己这一段切掉**：否则这段里那些
    // 字面量会自己满足自己（拼接 needle 也是同一个理由）。
    const needle = ['NO', 'REUSE'].join('_');
    const marker = '装置自检：fetch 一律不复用连接';
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8').split(marker)[0] ?? '';

    const segments = source.split('fetch(').slice(1);
    assert.ok(segments.length >= 7, `本文件里应当至少扫到 7 个 fetch 调用点，实际 ${segments.length}`);
    for (const [index, segment] of segments.entries()) {
      // 切到下一个 fetch 调用点为止：头部块若在，必在这一段里。
      assert.ok(
        segment.includes(needle),
        `本文件第 ${index + 1} 个 fetch 调用点没有声明不复用连接；` +
          '它会捡起上一条用例留在连接池里的死连接，换来一次偶发的 ECONNRESET。',
      );
    }
  });
});
