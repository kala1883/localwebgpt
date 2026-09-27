/**
 * 批准入口的可见性与可用性（LWB-023 验收标准 3）。
 *
 * ## 先把这件事说清楚：藏起按钮**不是**安全控制
 *
 * 验收标准 3 写的是「非登录本地操作者不能访问或点击批准接口」。这两件事
 * 由**不同的东西**保证，混在一起谈会让人以为把按钮藏好就够了：
 *
 * | 那一半 | 由谁保证 | 今天的状态 |
 * | --- | --- | --- |
 * | **访问**（能不能真的批准） | 服务端：能力表 + `requireLocalConsole` + 一次性 nonce 摘要绑定 | LWB-012 / LWB-021 已实现并取证 |
 * | **点击**（界面会不会给出这个动作） | 本模块 | 本任务 |
 *
 * 也就是说：即使本模块有 bug、把按钮显示给了一个没有会话的页面，
 * 那个人点下去也**只会拿到 401** —— `ControlClient.call` 在没有会话时
 * 根本不会发出请求（`client.ts` 的 `session === null` 分支），
 * 而服务端那两层也不认模型侧的凭据（`NEVER_GRANTED_TO_MODEL`）。
 *
 * **反过来说也必须成立**：不能因为「服务端会拦」就随便把按钮显示出来。
 * 一个显示了却按不动的按钮会让操作者以为是自己点错了，而真正的信息是
 * 「这个会话已经不能批准了，去重新跑本地启动命令」。因此这里的目标不是
 * 「更安全」，是**把拒绝的理由说出来**。
 *
 * ## 会话状态从哪来
 *
 * 只有 `ControlClient.session` 一处。它只存在于内存（`client.ts` 的文件头
 * 说明了为什么不进 localStorage），因此「未登录」不是一种需要清理的状态，
 * 而是**初始状态**：页面一刷新就回到这里。
 */

import type { ChangeSetView } from '@lwb/contracts';
import type { ReviewCoverage } from './review.ts';

/**
 * 不能批准的原因。每个值都对应一句给操作者看的话。
 *
 * 用具名的枚举而不是一个布尔值加一句自由文本：渲染方要按原因决定
 * 「该不该给出重新登录的入口」（`NO_SESSION` / `SESSION_EXPIRED` 要，
 * `WRONG_STATE` 不要），而从一个字符串里判读这件事是在猜。
 */
export type ApprovalBlockedReason =
  | 'NO_SESSION'
  | 'SESSION_EXPIRED'
  | 'NO_CHANGE'
  | 'NOT_REQUIRED'
  | 'WRONG_STATE'
  | 'EXPIRED'
  | 'DIGEST_MISSING'
  // LWB-036：三条**复核类**的拒绝。它们与上面六条的区别在于
  // 「谁能解决」：上面六条要操作者去处理会话/状态/时间，
  // 这三条要操作者**回到文件清单去继续看**（或者知道看不了）。
  //
  // 分三个值而不是一个 `NOT_REVIEWED`：三种情况在界面上要给的入口不同
  // （继续翻页 / 打开文件 / 什么都不给），而把「该按哪个按钮」这件事
  // 交给渲染方从一句话里读出来，是在让它猜。
  /** 有文件从未展示过。 */
  | 'UNSEEN_FILES'
  /** 有文件的差异没读到末尾（服务端分页截断）。 */
  | 'TRUNCATED_DIFF'
  /** 服务端拒绝交出内容：看不到，因此批不了。 */
  | 'CONTENT_UNAVAILABLE';

export interface ApprovalAffordance {
  /** 界面是否应当给出「批准并应用」这个动作。 */
  readonly can_approve: boolean;
  /** 界面是否应当给出「拒绝」这个动作。 */
  readonly can_reject: boolean;
  /** 不能批准的原因；`can_approve` 为真时是 `null`。 */
  readonly blocked_reason: ApprovalBlockedReason | null;
  /** 给操作者看的一句话。永远非空，`can_approve` 为真时说明当前状态。 */
  readonly message: string;
  /** 是否应当提示重新运行本地启动命令（会话类原因）。 */
  readonly offer_relogin: boolean;
}

/**
 * 会话的最小形状。
 *
 * 只取 `session_id`，**不**收整个 `ConsoleSession`：这个函数的判据里
 * 一个会话的其它字段都不该出现（CSRF 令牌与这个判断毫无关系，
 * 而让它流进一个「用来决定显示什么」的函数，是把它扩散到不需要它的地方）。
 */
export interface SessionPresence {
  readonly session_id: string;
}

export interface ApprovalGateInput {
  readonly session: SessionPresence | null;
  /**
   * 会话是否已被判定为过期。
   *
   * 与「没有会话」分开传：`ControlClient` 在收到 401 时会把会话清成 `null`
   * 并标记过期，此后 `session` 同样是 `null`，而两种情况要给的话不同 ——
   * 「还没登录」与「登录过了、刚过期」对操作者的下一步完全不同。
   */
  readonly session_expired?: boolean;
  readonly change: ChangeSetView | null;
  /**
   * 复核覆盖（LWB-036 验收标准 1）。**必填，没有默认值。**
   *
   * ## 为什么它必须被传，而不是「省略即视为看过」
   *
   * 一个可选参数等于给了调用方一个**不问这个问题**的选项，而省略时的
   * 语义只能有一个：要么「当看过了」（于是忘记传的那一处静默地放行了
   * 一份没人看过的修改集），要么「当没看过」（于是所有按旧签名调用的
   * 地方在升级后都显示「还有 N 个文件没看过」，而那个数字是假的）。
   * 两个方向都坏，而**必填**让这个选择不存在。
   *
   * 形状上，这是「批准绑定整份摘要」这件事在界面层的对应物：摘要覆盖
   * 全部文件，于是「能不能批准」这个问题就**必然**经过「全都看过没有」。
   * 判据本身在 `review.ts`，这里只读它的结论（`status` 与 `message`）。
   */
  readonly coverage: ReviewCoverage;
  /** 判定时刻，由调用方传入（同 `@lwb/approvals` 的 `now`）。 */
  readonly now: string;
}

/** 只有处在这个状态的修改集才谈得上批准。 */
const APPROVABLE_STATE = 'PENDING_APPROVAL';

/** 只有处在这个状态的修改集才谈得上拒绝（终态不可再拒）。 */
const REJECTABLE_STATE = 'PENDING_APPROVAL';

function expiryPassed(expiresAt: string, now: string): boolean {
  const end = Date.parse(expiresAt);
  const at = Date.parse(now);
  if (Number.isNaN(end) || Number.isNaN(at)) {
    // 解析不出来时按**不能批准**处理，而不是按「还没过期」。
    // 两个方向里，只有这一个的后果是「操作者多做一步去查」，
    // 另一个的后果是「界面说可以批准，服务端拒绝」——后者会让人怀疑系统坏了。
    return true;
  }
  return end - at <= 0;
}

/**
 * 判定当前界面应当给出哪些批准动作。
 *
 * 判定顺序是**会话 → 有没有修改集 → 状态 → 有效期 → 摘要形状**，
 * 而顺序本身是设计的一部分：排在前面的是「更根本的问题」。
 * 一个既没有会话、修改集又已经过期的页面，应当说「请先登录」——
 * 说了「已过期」会让人以为登录之后还能救回来。
 */
export function approvalAffordance(input: ApprovalGateInput): ApprovalAffordance {
  const blocked = (
    reason: ApprovalBlockedReason,
    message: string,
    options: { readonly offer_relogin?: boolean; readonly can_reject?: boolean } = {},
  ): ApprovalAffordance =>
    Object.freeze({
      can_approve: false,
      can_reject: options.can_reject === true,
      blocked_reason: reason,
      message,
      offer_relogin: options.offer_relogin === true,
    });

  // 1. 会话。**这是第一道，因为其余判定都以「能发出请求」为前提。**
  if (input.session === null) {
    return input.session_expired === true
      ? blocked('SESSION_EXPIRED', '控制台会话已过期。请重新运行本地启动命令建立会话。', { offer_relogin: true })
      : blocked('NO_SESSION', '尚未建立控制台会话。请运行本地启动命令打开控制台。', { offer_relogin: true });
  }

  // 2. 有没有修改集。
  const change = input.change;
  if (change === null) {
    return blocked('NO_CHANGE', '没有待审批的修改集。');
  }
  if (!change.approval_required) {
    return blocked('NOT_REQUIRED', '该工作区的文件修改权限已在本地设置，无需逐次批准；获授时可由模型调用 change_apply。');
  }
  if (!change.approval_required) {
    return blocked('NOT_REQUIRED', '文件修改权限由本地工作区 grant 授予；ChatGPT 可调用 change_apply 执行，无需逐次批准。');
  }

  // 3. 状态。终态（已批准 / 已拒绝 / 已过期）一律不给动作 ——
  //    拒绝一个已拒绝的修改集只会得到 `CHANGE_STATE_INVALID`，
  //    而把那个错误显示给操作者，等于用报错解释一件界面上本该看清的事。
  if (change.state !== APPROVABLE_STATE) {
    return blocked('WRONG_STATE', `修改集当前状态为 ${change.state}，不再需要批准。`);
  }

  // 4. 有效期。这里的判据与服务端的 `effectiveApprovalState` 是**同一个**
  //    语义（到期即不可用），但时钟不是同一个：服务端按自己的时钟判。
  //    因此这里报「已过期」而服务端仍放行是可能的（差在秒级），
  //    反向则不该发生。界面上的这句话因此是提示，不是裁定。
  if (expiryPassed(change.expires_at, input.now)) {
    return blocked('EXPIRED', '修改集已过期。请让模型重新提议，过期内容不会被写入。');
  }

  // 5. 摘要形状。批准与之精确绑定，一个空的摘要没法绑定到任何东西。
  if (typeof change.digest !== 'string' || change.digest.length === 0) {
    return blocked('DIGEST_MISSING', '这个修改集没有可用的摘要，无法批准。');
  }

  // 6. 复核覆盖（LWB-036）。**排在最后一条，且这个位置是选出来的。**
  //
  //    前面五条说的都是「这份修改集现在能不能被批准」，它们各自有一个
  //    操作者要去做的事（重新登录 / 等一等 / 换一份）。而这一条说的是
  //    「你还没看完」—— 把它排在前面，一个既已过期、又没看完的修改集
  //    会显示「还有 3 个文件没看过」，操作者于是去翻那 3 个文件，
  //    翻完才发现它早就过期了。那句提示不是错，是**次序错了**：
  //    它让人做了一件白做的事。
  //
  //    闸门拒绝（`unavailable`）要单独认出来：那种情况下既不是「你没看」，
  //    也不是「去看了就能批」—— 是这份内容此刻根本交不出来。三者里
  //    只有它会让「去继续看」这个建议完全无效。
  if (input.coverage.status === 'unavailable') {
    return blocked('CONTENT_UNAVAILABLE', input.coverage.message, { can_reject: true });
  }
  if (input.coverage.status !== 'complete') {
    // `message` 用的是 `coverage` 自己那句（它同时列出「没打开过」与
    // 「没读到末尾」两类），而 slug 按下面这个次序二选一：
    // 有从未打开过的文件时先报它 —— 「存在你完全没看过的东西」比
    // 「有一份你只看了前半」更根本，而两者同时成立时，操作者下一步
    // 要做的事是同一件（回文件清单）。
    const reason: ApprovalBlockedReason =
      input.coverage.unseen.length > 0 ? 'UNSEEN_FILES' : 'TRUNCATED_DIFF';
    // **拒绝仍然给得出来**，而这一格是这六条里唯一给拒绝的。
    //
    // 理由不是「拒绝更安全」（那句话太笼统），而是这三条拒绝说的是
    // 「你还没看完」—— 而**拒绝不需要看完**。服务端那边同样如此：
    // `rejectChange` 只做重载、比对摘要、条件流转，它不读内容、
    // 不要求任何复核（`packages/approvals/src/decide.ts`）。
    //
    // 把它一并堵上的后果是具体的：操作者打开第一个文件就发现了问题，
    // 想拒绝，却必须先翻完剩下十一个 —— 于是**安全的那条路比危险的那条
    // 更难走**。而如果他中途放弃，就落进一个死胡同：既批不了也拒不了，
    // 只能等它过期。
    //
    // 反过来不成立：批准绑的是整份摘要，因此「没看全就批准」必须堵住；
    // 而「没看全就拒绝」堵住的是操作者对一个他不想要的东西说「不」。
    return blocked(reason, input.coverage.message, { can_reject: true });
  }

  const rejectable = change.state === REJECTABLE_STATE;
  return Object.freeze({
    can_approve: true,
    can_reject: rejectable,
    blocked_reason: null,
    // 把「凭什么可以批准」写在同一个句子里，而不是只说「可以批准」：
    // 这一格的前提是**全部文件都已完整看过**，而操作者看到的应当是这个
    // 前提本身，不是它的结论。他若不信，会回到文件清单去数一遍 —— 那
    // 正是这条消息要他做的事。
    message: `已完整看过全部 ${input.coverage.total_count} 个文件的差异，可以批准。批准只记录授权并排队，**不会立即写入文件**。`,
    offer_relogin: false,
  });
}

/**
 * 批准动作的幂等键。
 *
 * ## 为什么它不能是「每次点击现生成一个随机值」
 *
 * `approvals.approve_and_apply` 的 `idempotency_key` 是**调用方**生成的，
 * 用来把「同一次点击重试」与「又一次新的点击」区分开（`@lwb/idempotency`
 * 的文件头把这件事说透了）。随机生成一个，等于每次点击都宣告
 * 「这是一次全新的请求」—— 于是断线重试、双击、浏览器重发都会各自
 * 变成一次新请求，而它们本该收敛到同一个操作上。
 *
 * ## 也不能是「修改集摘要」
 *
 * 摘要相同不代表「这一次点击」相同：同一个修改集可以合法地先被拒绝、
 * 再被重新提议（那是新的 change_id 但内容可能一致），而两件事都该各自
 * 是一次操作。用一个跨轮次恒定的值，会让第二次被当成第一次的重放。
 *
 * ## 因此它绑的是「这一个修改集的这一步」
 *
 * 键 = `change_id` + 摘要里的短核对编号。同一个修改集、同一份内容上的
 * 重复点击收敛到同一个键（服务端的 `UNIQUE(change_id)` 再把它们收成一个
 * 操作）；换一份内容（摘要变了）就是一个不同的键，那本该是一次新的批准。
 *
 * **注意它仍然只是记账**：`@lwb/idempotency` 的文件头写明幂等键
 * 「不参与任何授权判定」。这里的键不会让任何人获得批准，它只影响
 * 「这次点击算不算重复」。
 */
export function approvalIdempotencyKey(change: ChangeSetView): string {
  const short = typeof change.short_code === 'string' && change.short_code.length > 0
    ? change.short_code
    : 'no-short-code';
  // 前缀让键在状态库里可辨认来源（`@lwb/idempotency` 的 MIN 长度要求也因此天然满足）。
  return `console-approve:${change.change_id}:${short}`;
}

/**
 * 拒绝**没有**幂等键，这是刻意的，不是漏了。
 *
 * `approvals.reject` 的处理器（`apps/daemon/src/control/approvals.ts`）只读
 * `change_id` 与 `digest` 两个字段 —— 它不接受 `idempotency_key`。
 * 理由在拒绝这件事本身：拒绝把修改集推进一个**终态**，第二次拒绝会在
 * `transitionChange` 上撞到 `TERMINAL_STATE` 而被拒，于是「重复点击」
 * 与「重复调用」收敛到的是同一个结果，不需要额外的记账。
 *
 * 批准则相反：它要创建一条批准记录与一个操作，两样都是**新的行**，
 * 因此必须有键来告诉服务端「这是同一次点击」。
 */
