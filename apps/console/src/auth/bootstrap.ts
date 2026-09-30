/**
 * 用本地启动命令建立控制台会话（LWB-012 步骤 2，控制台一侧）。
 *
 * ## 令牌为什么放在片段（`#`）里
 *
 * 启动 URL 形如 `http://127.0.0.1:PORT/#t=lwb_boot_…`。
 *
 * 浏览器**不会把片段发给服务器** —— 它不参与请求行，因此不会进任何访问日志；
 * 它不会被当作 `Referer` 的一部分送出去；它甚至不会被同页面的
 * 服务端渲染看到。用 `?t=…` 也能工作，但那样令牌会经过请求行、
 * 可能落进日志、并留在浏览器历史里，而「带授权效果的 URL」正是
 * LWB-012 验收标准 3 点名要防的东西。
 *
 * ## 三段式的顺序是有讲究的
 *
 * ```
 *  1. 从片段读出令牌
 *  2. **立刻**把片段从地址栏抹掉（replaceState）
 *  3. 才发起兑换请求
 * ```
 *
 * 第 2 步必须在第 3 步之前。常见的写法是先兑换、成功了再抹掉片段 ——
 * 那条路径下，如果兑换失败（daemon 重启过、令牌已过期），
 * 失败分支里没人抹片段，于是**一张失效但看起来有效的令牌留在地址栏里**，
 * 用户会去刷新、去重试、把它复制粘贴到别处。
 * 先抹后换则无论成功失败，地址栏里都不会再有它。
 *
 * 用 `replaceState` 而不是 `location.hash = ''`：后者会在历史里**留下一条记录**，
 * 用户按一次后退就会回到带着令牌的那个地址。
 *
 * ## 令牌不进任何存储
 *
 * 不写 `localStorage`、不写 `sessionStorage`、不写 IndexedDB。
 * 它只在这一次调用的局部变量里存在，兑换完就只剩下服务端那次兑换的结果。
 * 这既是为了不让令牌在磁盘上留下副本，也是为了让「刷新页面」这件事
 * 变成「重新跑一次本地启动命令」—— 那是正确的语义：
 * 会话是一次本地动作建立的，不该被无限期地留在浏览器里。
 */

import { CONTROL_TOKEN_PREFIX } from '@lwb/contracts/control';

/** 片段里承载令牌的参数名。短，因为它要被人看着从终端复制。 */
export const BOOTSTRAP_FRAGMENT_KEY = 't';

/**
 * 从片段字符串（含或不含开头的 `#`）里取出启动令牌。
 *
 * 只认**形状正确**的令牌：`lwb_boot_` 前缀 + base64url 随机段。
 * 这不是防御性的洁癖 —— 片段是页面上任何脚本都能写的东西，
 * 而一个「把片段里任何字符串都当令牌送去兑换」的实现，
 * 会让一次无关的 `#section-3` 跳转变成一次多余的兑换请求
 * （并且在日志里留下一串无效尝试）。
 */
export function readBootstrapToken(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length === 0) return null;

  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) !== BOOTSTRAP_FRAGMENT_KEY) continue;
    const value = decodeURIComponent(part.slice(eq + 1));
    if (!value.startsWith(CONTROL_TOKEN_PREFIX.bootstrap)) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(value.slice(CONTROL_TOKEN_PREFIX.bootstrap.length))) return null;
    return value;
  }
  return null;
}

/**
 * 抹掉地址栏里的片段，并把这条历史记录**替换**掉（不新增一条）。
 *
 * 参数用结构化类型而不是 `History`：仓库的 tsconfig 只有 `lib: ES2023`，
 * **没有 DOM lib**。这不是疏漏，是有意的 —— 它让 `apps/console/src/`
 * 这一层不可能依赖浏览器全局，于是它能在 node 里被直接测试，
 * 而「先在浏览器里点一遍」不会被误当成验证。
 */
export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string): void;
}

export function stripFragment(history: HistoryLike, pathname: string): void {
  history.replaceState(null, '', pathname);
}

/**
 * 控制台只应当在回环来源上运行。
 *
 * 这一条挡的是「有人把控制台页面另存为文件、或者从别的站点代理过来，
 * 然后在那个页面上输入启动令牌」—— 那种情况下令牌会发给一个
 * 不是 daemon 的服务端。判断放在**发起任何请求之前**。
 */
export function isLoopbackOrigin(origin: string): boolean {
  return (
    origin === 'http://127.0.0.1' ||
    origin.startsWith('http://127.0.0.1:') ||
    origin === 'http://[::1]' ||
    origin.startsWith('http://[::1]:')
  );
}

export interface RedeemDependencies {
  /** 便于测试注入。**必须**是 `redirect: 'error'` 语义（见 client.ts）。 */
  readonly fetchImpl: typeof fetch;
  readonly origin: string;
}

export interface ConsoleSession {
  readonly session_id: string;
  readonly csrf_token: string;
  readonly expires_at: number | null;
}

/** 用当前浏览器已有的 HttpOnly cookie 恢复页面内存中的控制台会话。 */
export async function resumeConsoleSession(deps: RedeemDependencies): Promise<ConsoleSession | null> {
  const response = await deps.fetchImpl(`${deps.origin}/api/session`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Origin: deps.origin },
    redirect: 'error',
  });
  if (response.status === 401) return null;
  if (!response.ok) {
    throw new Error(`控制台会话恢复失败（HTTP ${response.status}）。`);
  }

  const payload = (await response.json()) as {
    readonly ok?: boolean;
    readonly result?: { readonly session_id?: unknown; readonly csrf_token?: unknown; readonly expires_at?: unknown };
  };
  const result = payload.result;
  if (
    payload.ok !== true ||
    result === undefined ||
    typeof result.session_id !== 'string' ||
    typeof result.csrf_token !== 'string' ||
    (result.expires_at !== null && typeof result.expires_at !== 'number')
  ) {
    throw new Error('控制台会话恢复响应格式不正确。');
  }
  return { session_id: result.session_id, csrf_token: result.csrf_token, expires_at: result.expires_at };
}

/**
 * 用启动令牌兑换会话。
 *
 * 失败时抛错，且错误信息**不含令牌**：错误会被打印、被上报、
 * 被贴进聊天窗口，而其中任何一处都不该带上凭证。
 */
export async function redeemBootstrap(
  token: string,
  deps: RedeemDependencies,
  now: () => number = Date.now,
): Promise<ConsoleSession> {
  const response = await deps.fetchImpl(`${deps.origin}/api/session`, {
    method: 'POST',
    // 同源 cookie 必须带上：兑换响应会 `Set-Cookie`，而后续请求靠它鉴权。
    credentials: 'same-origin',
    // Origin 显式带上，理由见 client.ts：浏览器里它会被忽略并由浏览器写入自己的值，
    // 在非浏览器环境里它是必需的 —— 服务端对变更类请求要求它，缺了一律 403。
    headers: { 'Content-Type': 'application/json', Origin: deps.origin },
    body: JSON.stringify({ token }),
    // **不跟随重定向。** 见 client.ts 的说明：跟随会让 CSRF 令牌
    // 被重新发往另一个来源。
    redirect: 'error',
  });

  if (!response.ok) {
    throw new Error(`控制台会话建立失败（HTTP ${response.status}）。请重新生成浏览器接入链接，或重新运行本地启动脚本。`);
  }

  const payload = (await response.json()) as {
    readonly ok?: boolean;
    readonly result?: { readonly session_id?: unknown; readonly csrf_token?: unknown; readonly expires_at?: unknown };
  };
  const result = payload.result;
  if (
    payload.ok !== true ||
    result === undefined ||
    typeof result.session_id !== 'string' ||
    typeof result.csrf_token !== 'string' ||
    (result.expires_at !== null && typeof result.expires_at !== 'number')
  ) {
    throw new Error('控制台会话响应格式不正确。');
  }
  void now;
  return { session_id: result.session_id, csrf_token: result.csrf_token, expires_at: result.expires_at };
}

export interface BootstrapEnvironment {
  readonly location: { readonly hash: string; readonly pathname: string; readonly origin: string };
  readonly history: HistoryLike;
  readonly fetchImpl: typeof fetch;
}

/**
 * 页面加载时调用：读令牌 → 抹片段 → 恢复现有会话或兑换令牌。
 *
 * 返回 `null` 表示地址里没有令牌；调用方可用当前浏览器的会话 cookie 恢复登录。
 * 没有可恢复的 cookie 也不是异常 —— 这是尚未连接的浏览器的正常状态。
 */
export async function bootstrapConsoleSession(
  env: BootstrapEnvironment,
): Promise<ConsoleSession | null> {
  if (!isLoopbackOrigin(env.location.origin)) {
    throw new Error(
      `控制台只在回环来源上运行（当前为 ${env.location.origin}）。` +
        '请从 daemon 打印的 http://127.0.0.1:… 地址打开。',
    );
  }

  const token = readBootstrapToken(env.location.hash);
  if (token === null) return null;

  // 先抹掉再兑换。见文件头注释。
  stripFragment(env.history, env.location.pathname);

  // 在同一浏览器再次打开邀请链接时，复用仍有效的 cookie，避免覆盖已有会话。
  const currentSession = await resumeConsoleSession({ fetchImpl: env.fetchImpl, origin: env.location.origin });
  if (currentSession !== null) return currentSession;

  return redeemBootstrap(token, { fetchImpl: env.fetchImpl, origin: env.location.origin });
}
