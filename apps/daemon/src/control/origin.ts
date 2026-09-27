/**
 * 请求来源判定：Host、Origin、Sec-Fetch-Site、请求目标形态（LWB-012 步骤 1）。
 *
 * ## 这一层防的是什么（值得写清楚，否则会被当成冗余检查删掉）
 *
 * 控制 API 监听在 `127.0.0.1` 上。很多人会由此推出「只有本机能访问，
 * 所以它是安全的」。这一步推理错在两处：
 *
 * **一、浏览器里的任意页面都能向 127.0.0.1 发请求。**
 * 用户只要打开一个恶意网页，那个页面就能 `fetch('http://127.0.0.1:PORT/api/...')`。
 * 请求确实从本机发出 —— 但发出它的是攻击者的代码。
 *
 * **二、DNS rebinding 会让攻击者的页面与控制 API 变成「同源」。**
 * 攻击者把自己的域名 `evil.com` 解析到 `127.0.0.1`，然后让浏览器去访问
 * `http://evil.com:PORT/`。此时浏览器认为页面与请求**同源**，
 * 于是同源策略不再拦它，它甚至能读到响应体。Cookie 会怎么走？
 * 我们的 cookie 是发给 `127.0.0.1` 的，浏览器不会把它发给 `evil.com`
 * —— 所以「已登录」这一步挡住了。但只要有一个不需要 cookie 的动作
 * （或者将来某天有人为了「方便」把 cookie 放宽成 `Domain=`），
 * 这条路就通了。
 *
 * **而这两种攻击都有一个共同的、我们能在服务端看见的痕迹：
 * `Host` 请求头。** 真实操作者的浏览器访问的是 `http://127.0.0.1:PORT/`，
 * 于是 `Host: 127.0.0.1:PORT`；被 rebinding 的页面访问的是
 * `http://evil.com:PORT/`，于是 `Host: evil.com:PORT` ——
 * 尽管两条连接都落在同一个监听套接字上。
 *
 * 所以 `Host` 校验不是「顺手加的header检查」，**它是 DNS rebinding 的主要防线**。
 * 也正因为它承担这个责任，接受的主机名必须是**一个**、且是绑定的那个字面量：
 * 多接受一个拼写（`localhost`、`127.0.0.1.nip.io`、大小写变体、末尾点）
 * 就多一条解析路径，而解析路径的分歧正是绕过这类检查的常见方式。
 *
 * ## 「缺头就放行」这个陷阱
 *
 * `Origin` 和 `Sec-Fetch-Site` 都可能缺失（老浏览器、命令行工具、
 * 某些隐私设置）。把「缺失」当作「不跨站」是一个常见但错误的写法：
 * 攻击者可以构造一个**不带** `Origin` 的跨站请求吗？——
 * 在现代浏览器里不能（浏览器自己加），但本层的判断不该依赖于
 * 「攻击者用的是浏览器」这个假设。
 *
 * 这里的取向是：**变更类请求缺 `Origin` 一律拒绝**（fail-closed）。
 * 代价是 `curl` 之类的工具也要显式带上 `Origin` 才能改东西 ——
 * 而这个代价是**故意的**：控制平面的变更操作应当经过浏览器里的控制台，
 * 一个不带 `Origin` 的变更请求没有正当来源。
 * `Sec-Fetch-Site` 则相反：它缺失时**不**拒绝，因为它是浏览器专有头，
 * 拒绝会让所有非 Chromium 浏览器无法使用控制台，而它只是纵深防御的一层
 * （真正的边界是 Host + Origin + CSRF 三者）。
 *
 * ## 通用代理路由
 *
 * 步骤 1 要求「禁用通用代理路由」。一个 HTTP 服务变成开放代理的方式有两种：
 *
 *  - **绝对形式请求目标**：`GET http://evil.com/ HTTP/1.1`。这是代理请求的写法，
 *    服务器如果照着第二个 URL 去取内容，它就成了代理。
 *  - **`CONNECT` 方法**：隧道。
 *
 * 两者都在这里被显式拒绝，且拒绝理由写明「本服务不是代理」——
 * 未来的维护者看到这条规则时应当能立刻判断它能不能删。
 */

import { CONTROL_BIND_HOST } from './constants.ts';

export type RejectReason =
  | 'HOST_MISSING'
  | 'HOST_MALFORMED'
  | 'HOST_NOT_ALLOWED'
  | 'ORIGIN_MISSING'
  | 'ORIGIN_MALFORMED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'CROSS_SITE'
  | 'PROXY_REQUEST_TARGET'
  | 'METHOD_NOT_ALLOWED'
  | 'CONTENT_TYPE_REQUIRED';

export interface Reject {
  readonly ok: false;
  readonly reason: RejectReason;
  readonly detail: string;
}

export interface Authority {
  /** 原样保留的 host 部分，小写化后用于比较。 */
  readonly host: string;
  readonly port: number;
}

/**
 * 解析 `Host` / `Origin` 里的 authority 部分。
 *
 * **刻意只接受 IPv4 字面量 + 端口**，因此这条解析路径非常窄：
 *  - 不接受 IPv6 方括号（我们只绑 IPv4 回环，接受 `[::1]` 只会多一条
 *    「括号里的内容怎么比较」的规则）；
 *  - 不接受没有端口的形态（端口是我们自己分配的，缺了它就无法确认
 *    请求打的是**我们这个**监听，而不是本机别的服务）；
 *  - 不接受任何 `user@`（`Host: evil.com@127.0.0.1` 这种把戏）。
 *
 * 用户信息那一项不是假想：解析器之间的分歧（有的取 `@` 前、有的取 `@` 后）
 * 正是 Host 头攻击的经典手法，所以这里直接**拒绝**含 `@` 的输入，
 * 而不是试图规定「取哪一段」。
 */
export function parseAuthority(raw: string): Authority | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 255) return null;
  // 控制字符、空白、以及会让解析产生分歧的分隔符
  if (/[\s\u0000-\u001f\u007f/?#@,;\\"']/.test(value)) return null;
  if (value.includes('[') || value.includes(']')) return null;

  const colon = value.indexOf(':');
  if (colon < 0) return null;
  // 只允许一个冒号：多个冒号意味着这是某种 IPv6 写法，而我们已经排除方括号形态
  if (value.indexOf(':', colon + 1) >= 0) return null;

  const host = value.slice(0, colon).toLowerCase();
  const portText = value.slice(colon + 1);
  if (!/^[0-9]{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65535) return null;
  if (!isCanonicalIpv4(host)) return null;

  return { host, port };
}

/**
 * 规范形式（canonical）的 IPv4 点分四段。
 *
 * 两条要求，缺一不可：
 *
 *  - **必须是四段十进制点分**。看起来多余，实则是这个函数的全部意义所在：
 *    只要放 `localhost` 这类主机名过去，它的语义就从「确认这是那个字面量」
 *    滑成「确认这看起来像个主机名」，而后者要 DNS 解析才能定论 ——
 *    解析结果恰恰取决于**攻击者控制的域名**，正是本文件要防的东西。
 *  - **不允许前导零**。`010.1.1.1` 在部分解析器里按八进制读（=`8.1.1.1`），
 *    在另一些里按十进制读。这是 SSRF 绕过的经典手法；这里直接不接受这种形态，
 *    而不是去规定「按哪种进制解释」。
 *
 * 所以这个函数**只做字面量核对，不做主机名解析**：它的返回值可以拿去
 * 与常量做 `===` 比较。
 */
function isCanonicalIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

/** 本站的规范 origin，例如 `http://127.0.0.1:51234`。 */
export function consoleOrigin(port: number): string {
  return `http://${CONTROL_BIND_HOST}:${port}`;
}

/**
 * `Host` 校验。**每个请求都要过**，包括静态资源与 404。
 *
 * 顺序上放在最前面：它是 DNS rebinding 的主要防线，因此不该排在
 * 「先查路由、再查身份」之后 —— 那样一个未知路径的响应会先泄露
 * 「这个端口上确实有个服务」。
 */
export function checkHost(rawHost: string | undefined, expectedPort: number): Reject | null {
  if (rawHost === undefined || rawHost.length === 0) {
    return { ok: false, reason: 'HOST_MISSING', detail: '请求缺少 Host 头。' };
  }
  const authority = parseAuthority(rawHost);
  if (authority === null) {
    return { ok: false, reason: 'HOST_MALFORMED', detail: 'Host 头无法解析为 IPv4 字面量加端口。' };
  }
  if (authority.host !== CONTROL_BIND_HOST || authority.port !== expectedPort) {
    return {
      ok: false,
      reason: 'HOST_NOT_ALLOWED',
      // 注意 detail 里**回显**了收到的 Host：这一条只写给本地审计，
      // 不回给请求方（见 server.ts 的错误响应构造）。
      detail: `Host 为 ${authority.host}:${authority.port}，本站只接受 ${CONTROL_BIND_HOST}:${expectedPort}。`,
    };
  }
  return null;
}

/**
 * `Origin` 校验（只对变更类请求强制）。
 *
 * 精确字符串相等，不做「同源」的语义比较 —— 因为语义比较要处理
 * 默认端口省略（`http://127.0.0.1:80` 与 `http://127.0.0.1` 同源）、
 * 大小写、结尾斜杠等等，每一条都是分歧点。我们的 origin 是自己拼的固定字符串，
 * 逐字比较既够用又没有可分歧的地方。
 */
export function checkOrigin(rawOrigin: string | undefined, expectedOrigin: string): Reject | null {
  if (rawOrigin === undefined || rawOrigin.length === 0) {
    return {
      ok: false,
      reason: 'ORIGIN_MISSING',
      detail: '变更类请求必须带 Origin 头；缺省一律拒绝，不把「缺省」当作「同源」。',
    };
  }
  if (rawOrigin === 'null') {
    return {
      ok: false,
      reason: 'ORIGIN_MALFORMED',
      detail: 'Origin 为 null（沙箱 iframe、data: 或 file: 页面），不视为本站来源。',
    };
  }
  if (rawOrigin !== expectedOrigin) {
    return {
      ok: false,
      reason: 'ORIGIN_NOT_ALLOWED',
      detail: `Origin 为 ${rawOrigin}，本站只接受 ${expectedOrigin}。`,
    };
  }
  return null;
}

/**
 * `Sec-Fetch-Site` 校验。
 *
 * `none` 表示用户直接发起的导航（地址栏、书签），是正常的；
 * `same-origin` 是控制台自己发的。其余（`same-site`、`cross-site`）一律拒绝。
 *
 * `same-site` 也要拒：`127.0.0.1` 上另一个端口跑的服务与本站属于同一个
 * registrable domain，但它们是**不同的 origin**，互不信任。一个本地
 * 服务不该因为「也跑在 127.0.0.1 上」就获得改工作区的能力。
 *
 * 头缺失时返回 null（放行）：它是浏览器专有头，拿它当硬边界会让
 * 非 Chromium 浏览器整体不可用，而它只是纵深防御的一层。
 */
export function checkSecFetchSite(raw: string | undefined): Reject | null {
  if (raw === undefined || raw.length === 0) return null;
  if (raw === 'same-origin' || raw === 'none') return null;
  return {
    ok: false,
    reason: 'CROSS_SITE',
    detail: `Sec-Fetch-Site 为 ${raw}，本站只接受同源或用户直接发起的请求。`,
  };
}

/**
 * 请求目标形态。
 *
 * 绝对形式的请求目标（`GET http://evil.com/ HTTP/1.1`）是**代理请求**的写法。
 * 本服务不是代理，也永远不会是；收到这种请求说明对端把我们当代理用，
 * 直接拒绝并断开。`CONNECT` 是隧道方法，同样拒绝。
 */
export function checkRequestTarget(method: string, rawUrl: string): Reject | null {
  if (method === 'CONNECT' || method === 'TRACE') {
    return {
      ok: false,
      reason: 'METHOD_NOT_ALLOWED',
      detail: `方法 ${method} 不被接受：本服务不是代理，不提供隧道或回显。`,
    };
  }
  if (!rawUrl.startsWith('/')) {
    return {
      ok: false,
      reason: 'PROXY_REQUEST_TARGET',
      detail: '请求目标是绝对形式（形如 http://…）。本服务不是代理，不转发任何请求。',
    };
  }
  return null;
}

/**
 * 变更类请求必须声明 `application/json`。
 *
 * 这条不是洁癖，它是一道**结构性**的跨站防线：HTML 表单只能发出
 * `application/x-www-form-urlencoded`、`multipart/form-data`、`text/plain`
 * 三种 Content-Type，而只有这三种才属于「简单请求」，可以不发预检就跨站发出。
 * 强制 JSON 意味着**任何跨站伪造的变更请求都必然先触发预检**，
 * 而本服务从不回应 CORS 预检（见 server.ts）——于是它在发出前就被浏览器拦下。
 *
 * 换句话说：这一条把「跨站变更」从「请求到达后靠检查拒绝」
 * 变成了「请求根本发不出来」。
 */
export function contentTypeOf(raw: string | undefined): string {
  if (raw === undefined) return '';
  const semicolon = raw.indexOf(';');
  return (semicolon >= 0 ? raw.slice(0, semicolon) : raw).trim().toLowerCase();
}

export function checkJsonContentType(raw: string | undefined): Reject | null {
  const type = contentTypeOf(raw);
  if (type !== 'application/json') {
    return {
      ok: false,
      reason: 'CONTENT_TYPE_REQUIRED',
      detail:
        '变更类请求必须声明 Content-Type: application/json。' +
        '表单可用的三种类型都属于「简单请求」，能不经预检跨站发出；强制 JSON 让跨站伪造在浏览器侧就发不出去。',
    };
  }
  return null;
}
