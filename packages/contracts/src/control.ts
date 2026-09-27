/**
 * 控制平面凭证的**形状**（LWB-012）。
 *
 * ## 为什么凭证要有一个可识别的形状
 *
 * 控制平面凭证是这套系统里权限最高的一类东西：持有一张控制台会话，
 * 就能注册工作区、批准修改、改变策略 —— 也就是**代替操作者做决定**。
 * 而它同时也是最容易「不小心出现在别处」的一类东西：启动命令要打印它，
 * 控制台要把 URL 放进地址栏，出错时人可能顺手把它贴进某个文件里。
 *
 * 一句「工具结果不含控制台登录令牌」如果靠「记得别放进去」来保证，
 * 那它保证的是写这句话那天的情况。这里换一种做法：**给凭证一个
 * 一眼可辨、且不可能在正常文本里偶然出现的形状**，然后把这个形状注册成
 * `@lwb/egress` 的 `certain` 级秘密规则。于是「令牌进入模型可见内容」
 * 这件事在最后一道出口上被**结构性地**挡住 —— 无论它是从哪条路径漏出来的：
 * 读取、搜索、Git 差异、错误详情、审计导出，还是将来某个还没写的第七个面。
 *
 * 前缀里的 `lwb_` 与随机段用了 base64url 字母表，因此这个形状
 * 「恰好出现在一段普通源码里」的概率可以忽略；而一旦出现，它就是真的。
 *
 * ## 为什么放在 contracts 而不是 daemon
 *
 * 因为需要它的有**两处**，且分属不同的包：生成它的是
 * `apps/daemon/src/control/`，筛查它的是 `packages/egress/`。
 * 两边各自写一份前缀常量，就会有一天只改了一边 —— 而那一天不会有任何
 * 测试失败：生成端照常发令牌，筛查端照常不认得它。所以形状必须只有一份，
 * 且放在一个两个包都允许依赖的地方。`contracts` 是纯契约层，符合这个条件。
 *
 * 本文件只有常量与类型，没有任何运行时行为（`contracts` 的纯度约束）。
 */

/**
 * 各类控制平面凭证的前缀。
 *
 * 分四类而不是统一一个前缀，是为了让审计与排障能一眼看出**泄露的是哪一类**：
 * 启动令牌泄露意味着「有人还没兑换它，可以立刻作废」；
 * 会话 cookie 泄露意味着「有个会话正在被人用，要立刻撤销」；
 * 两者的处置完全不同，而它们如果长得一样，日志里就分不出来了。
 */
export const CONTROL_TOKEN_PREFIX = {
  /** 本地启动命令打印的一次性令牌，用于兑换会话。用后即焚。 */
  bootstrap: 'lwb_boot_',
  /** 控制台会话 cookie 的值。 */
  session: 'lwb_sess_',
  /** CSRF 双提交令牌（放在请求头里，不在 cookie 里）。 */
  csrf: 'lwb_csrf_',
  /** 一次性操作 nonce。 */
  nonce: 'lwb_nonce_',
} as const;

export type ControlTokenKind = keyof typeof CONTROL_TOKEN_PREFIX;

/** 全部前缀，供筛查规则与测试共用。 */
export const CONTROL_TOKEN_PREFIXES: readonly string[] = Object.values(CONTROL_TOKEN_PREFIX);

/**
 * 随机段的长度：32 字节的 base64url。
 *
 * 32 字节 = 256 位，对在线猜测是荒谬的安全余量；选它而不是 16 字节，
 * 是因为这张凭证能授权的动作（批准写入用户的工作区）是不可撤销的 ——
 * 余量大一点的成本只是 URL 长几个字符。
 *
 * base64url 编码 32 字节得到 44 个字符，末尾一个 `=` 补位被去掉，故为 43。
 * 这个数字写在注释里而不是靠心算，是因为它是筛查正则的一部分：
 * 算错一位的后果是真实令牌匹配不上（漏检），而那正好是最糟的方向。
 */
export const CONTROL_TOKEN_BODY_LENGTH = 43;

/**
 * 控制平面凭证的正则**源码**。
 *
 * 用源码字符串而不是直接给 RegExp：`packages/egress` 需要的是带
 * `g` 与 `d` 标志的副本，而共享同一个 RegExp 对象会让 `lastIndex`
 * 在多个调用点之间互相干扰（一个经典的、只在并发时才暴露的 bug）。
 * 这里给形状，让使用方各自构造自己的实例。
 *
 * 尾部用 `{43,}` 而不是 `{43}`：万一将来随机段变长，筛查应当继续命中
 * （宁可多盖），而不是突然失配（漏检）。
 */
export const CONTROL_TOKEN_PATTERN_SOURCE = `\\b(?:${CONTROL_TOKEN_PREFIXES.join('|')})[A-Za-z0-9_-]{${CONTROL_TOKEN_BODY_LENGTH},}\\b`;

/**
 * 承载会话的 cookie 名。**带 `__Host-` 前缀**。
 *
 * 这个前缀不是命名风格，是浏览器强制的一组约束：带它的 cookie
 * 必须带 `Secure`、必须来自安全上下文、必须 `Path=/`、且**不得设置 `Domain`**。
 * 最后一条正是我们要的 —— 它让这张 cookie 只可能属于设置它的那个主机，
 * 无法被放宽到某个父域。理由见 `apps/daemon/src/control/session.ts` 的
 * `cookieAttributes`。
 *
 * 放在 contracts 而不是 daemon，是因为**控制台一侧也要读它**
 * （清除 cookie、判断是否已登录），而两处各写一份字符串常量，
 * 就会有一天只改了一边 —— 而那一天不会有任何测试失败：
 * 服务端照常设置，控制台照常找不到。
 */
export const CONTROL_COOKIE_NAME = '__Host-lwb_console';

/**
 * CSRF 双提交令牌走的请求头名。
 *
 * 服务端与控制台两侧都要用，理由同上。用自定义头（而不是
 * `X-Requested-With` 之类通用头）还有一个额外好处：自定义头
 * **必然触发 CORS 预检**，而本服务从不回应预检。
 */
export const CONTROL_CSRF_HEADER = 'x-lwb-csrf';

/** 形状判定，供生成端自检与测试使用。 */
export function isControlToken(value: string): boolean {
  return new RegExp(`^(?:${CONTROL_TOKEN_PREFIXES.join('|')})[A-Za-z0-9_-]{${CONTROL_TOKEN_BODY_LENGTH},}$`).test(
    value,
  );
}

export function isControlTokenOfKind(value: string, kind: ControlTokenKind): boolean {
  return value.startsWith(CONTROL_TOKEN_PREFIX[kind]) && isControlToken(value);
}
