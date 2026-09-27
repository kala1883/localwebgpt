/**
 * 状态刷新的两条时序规则（LWB-036 步骤 2、验收标准 2）。
 *
 * 本文件里的两件事看起来不搭，其实问的是同一个问题在**读**与**写**
 * 两个方向上的答案：
 *
 * | | 问题 | 规则 |
 * | --- | --- | --- |
 * | `refreshDecisionOf` | 多久去问一次服务端 | 有节奏地读，且**知道什么时候停** |
 * | `SingleFlight` | 同一次动作被触发两次怎么办 | 在途的请求只留一个 |
 *
 * 它们共同保证一件事：**这个页面与控制 API 之间的请求，每一次都有理由。**
 *
 * ## 只使用本地认证接口，不依赖向 ChatGPT 推送主动唤醒
 *
 * 步骤 2 的原文如此。它在代码里落成三条约束：
 *
 * 1. **只有一个通道**：`ControlClient.call('/api/changes/get')`。会话 cookie
 *    （`__Host-lwb_console`）+ CSRF 头 + `credentials: 'same-origin'`，
 *    由 `src/auth/client.ts` 负责，本模块只决定**什么时候**发起。
 * 2. **没有第二条通道**。没有 `WebSocket`、没有 `EventSource`、
 *    没有 `BroadcastChannel`、没有轮询之外的任何推送。为这个页面加一条
 *    推送通道，需要服务端再开一个接口，而那个接口的鉴权正是最容易
 *    被省掉的一处 —— 这个仓库点名的反模式里就有一条
 *    「它走的是隧道，不用再验一次」。多一条通道换来的是「少等 1.5 秒」，
 *    代价是多一处可能忘记鉴权的地方，不划算。
 * 3. **不等模型叫醒**。操作者可能已经关掉 ChatGPT 网页、模型这一轮早就
 *    结束了，而批准页面仍然要能用、要能看到执行结果。反过来也成立：
 *    模型**不能**写这个页面（它连控制平面的能力都没有，见
 *    `packages/ipc/src/audience.ts` 的 `NEVER_GRANTED_TO_MODEL`）。
 *
 * 「实时」在这里的诚实说法是**有节奏的轮询**：间隔由状态决定（正在写盘时
 * 快、其他时候慢），失败时退避，到了终态就停。
 *
 * ## 为什么「停」这件事要和「多久一次」写在同一个函数里
 *
 * 一个只会算间隔的实现在终态上会永远问下去：修改集已经 `APPLIED`，
 * 页面还在每 5 秒发一次请求。那个请求**永远不会**得到不同的答案，
 * 而它的代价不是带宽（本机回环）—— 是「这个页面在动」的错觉：
 * 操作者看着它不断刷新，会以为还有事情在进行。
 *
 * 同一条理由让「页面不在前台时暂停」也在这里：一个没人看的页面
 * 不该有网络活动，而**有人看的时候它必须立刻恢复**。
 */

import { isTerminalChangeState } from '@lwb/contracts';
import type { ChangeSetState } from '@lwb/contracts';

/**
 * 刷新使用的接口。**只有这一个**，写成常量以便被测试与证据脚本引用。
 *
 * 它是控制平面的**只读**操作（`READ_ONLY_OPERATIONS`），因此不需要
 * 一次性 nonce —— 每 1.5 秒签一次 nonce 的界面是不会有人用的。
 */
export const REFRESH_ENDPOINT = 'POST /api/changes/get' as const;

/** 写盘正在进行时的间隔。操作者此时正盯着屏幕等结果。 */
export const EXECUTING_INTERVAL_MS = 1500;

/** 其他非终态的间隔。这一档没有谁在等，问得慢一点就够。 */
export const WATCHING_INTERVAL_MS = 5000;

/** 失败退避的基数与上限。 */
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30000;

/**
 * 「正在写盘」的三个状态。
 *
 * 与 `@lwb/contracts` 的 `isExecutionChangeState` 是同一批取值，
 * 但**不引用那个函数**：那个函数回答的是「这次工具调用返回时操作还在
 * 执行中吗」，是给模型看的一句话；这里回答的是「界面上要不要问得勤一点」。
 * 两个问题今天恰好同解，而耦合它们会让其中一处的语义调整意外改变
 * 另一处的行为 —— 并且是那种「改了也看不出来」的改变。
 */
const EXECUTING_STATES: ReadonlySet<ChangeSetState> = new Set<ChangeSetState>([
  'QUEUED',
  'VALIDATING',
  'APPLYING',
]);

export type RefreshReason =
  /** 终态：不会再变了，停止刷新。 */
  | 'TERMINAL'
  /** 会话没了（401）。继续问只会一直拿到 401。 */
  | 'SESSION_LOST'
  /** 页面不在前台：暂停，等 `visibilitychange` 叫醒。 */
  | 'HIDDEN'
  /** 上一次失败了，正在退避。 */
  | 'BACKOFF'
  /** 到点了，该问了。 */
  | 'DUE'
  /** 还没到点。 */
  | 'WAITING';

export interface RefreshInput {
  readonly state: ChangeSetState;
  /** `document.visibilityState === 'visible'`。由调用方读，本模块不碰 DOM。 */
  readonly visible: boolean;
  /** 会话是否已被判定为过期（`ControlApiFailure.session_expired`）。 */
  readonly session_expired?: boolean;
  /** 连续失败次数。成功一次即归零，由调用方维护。 */
  readonly consecutive_failures: number;
  /** 上一次**成功**发起的刷新时刻（epoch ms）。从未刷新过时是 `null`。 */
  readonly last_poll_at: number | null;
  /** 判定时刻（epoch ms）。本模块不读时钟。 */
  readonly now: number;
}

export interface RefreshDecision {
  /** 现在就该发一次请求吗。 */
  readonly poll: boolean;
  /**
   * 距离下一次尝试还有多少毫秒；`null` 表示**不要排下一次**
   * （终态、会话没了、或者页面在后台等一个事件叫醒）。
   *
   * `poll` 为真时它是**这次之后**的间隔，因此驱动方可以一句话写成
   * 「该问就问，然后按这个数字排下一次」—— 不必为「刚问过」和
   * 「还没到点」写两条不同的分支。
   */
  readonly next_delay_ms: number | null;
  /** 本次之后是否应当彻底停止刷新。 */
  readonly stop: boolean;
  readonly reason: RefreshReason;
  /** 给操作者看的一句话。永远非空 —— 包括「已经停了」这件事。 */
  readonly message: string;
}

function due(input: RefreshInput, interval: number): number {
  if (input.last_poll_at === null) return 0;
  const elapsed = input.now - input.last_poll_at;
  return elapsed >= interval ? 0 : interval - elapsed;
}

/**
 * 下一次刷新该怎么做。
 *
 * 判定顺序是**停 → 暂停 → 退避 → 间隔**，而这个顺序本身是设计的一部分：
 * 一个已经 `APPLIED` 的修改集，无论页面在前台还是后台、上一次失败没有，
 * 答案都是「停」。反过来先判可见性，会让一个后台的**终态**页面在切回
 * 前台时重新开始轮询 —— 而它已经没有任何东西可以等了。
 */
export function refreshDecisionOf(input: RefreshInput): RefreshDecision {
  if (isTerminalChangeState(input.state)) {
    return Object.freeze({
      poll: false,
      next_delay_ms: null,
      stop: true,
      reason: 'TERMINAL' as const,
      message: `${input.state} 之后不会再有变化，已停止刷新。`,
    });
  }

  if (input.session_expired === true) {
    // 与 `TERMINAL` 分开：这一条**可以**恢复（重新跑一次启动命令），
    // 而终态不能。两句话因此不同，而不是共用一句「已停止刷新」。
    return Object.freeze({
      poll: false,
      next_delay_ms: null,
      stop: true,
      reason: 'SESSION_LOST' as const,
      message: '控制台会话已过期，已停止刷新。请重新运行本地启动命令。',
    });
  }

  if (!input.visible) {
    return Object.freeze({
      poll: false,
      next_delay_ms: null,
      stop: false,
      reason: 'HIDDEN' as const,
      // 不排下一次定时器：`visibilitychange` 会叫醒。写清楚是哪一个事件，
      // 因为「等一个事件叫醒」的实现在没有那个事件监听时就是永久的静默。
      message: '页面不在前台，已暂停刷新；切回本页会立即刷新。',
    });
  }

  const failures = Math.max(0, Math.trunc(input.consecutive_failures));
  if (failures > 0) {
    // 指数退避，封顶 30 秒。**不放弃**：本机服务可能只是刚重启，
    // 而一个「重试几次就不管了」的界面会让操作者以为结果永远不会来了。
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
    const remaining = due(input, delay);
    return Object.freeze({
      poll: remaining === 0,
      next_delay_ms: remaining === 0 ? delay : remaining,
      stop: false,
      reason: remaining === 0 ? ('DUE' as const) : ('BACKOFF' as const),
      message: `刷新失败 ${failures} 次，${Math.round(delay / 1000)} 秒后重试。`,
    });
  }

  const executing = EXECUTING_STATES.has(input.state);
  const interval = executing ? EXECUTING_INTERVAL_MS : WATCHING_INTERVAL_MS;
  const remaining = due(input, interval);
  return Object.freeze({
    poll: remaining === 0,
    next_delay_ms: remaining === 0 ? interval : remaining,
    stop: false,
    reason: remaining === 0 ? ('DUE' as const) : ('WAITING' as const),
    message: executing ? '写入进行中，正在跟进结果。' : '等待状态变化。',
  });
}

/**
 * 同键在途请求只留一个。
 *
 * ## 它解决的是哪一半问题（另一半不在界面里）
 *
 * 验收标准 2 是「本地点击与 ChatGPT 工具调用同时发生仍只执行一次」。
 * 那件事的**权威**保证在服务端，且已经落地：
 *
 *  - 批准是一次性的（`approvals` 表里一条绑定摘要的记录，用掉即
 *    `CONSUMED`），执行前还要再跑一次门禁（`@lwb/approvals`）；
 *  - 一个修改集最多关联**一个** operation（迁移 v1 的 `UNIQUE(change_id)`），
 *    因此两个幂等键也只能换出同一个操作。
 *
 * 界面这一层能加的是**第一道**：同一次点击别发两次请求。它的价值不是
 * 「更安全」（服务端那两道才是），而是**不给服务端制造它必须去重的东西**
 * —— 一次性 nonce 是绑在请求体上的，两次点击会用掉两张 nonce、产生两次
 * 幂等键不同而 change_id 相同的调用，而服务端要把它们收敛成一次。
 * 收敛得对，但每次双击都在测试那条收敛路径。
 *
 * ## 键是谁
 *
 * 调用的那个幂等键（`approvalIdempotencyKey`）。用它而不是一个自增
 * 序号：序号会让「同一个修改集的第二次点击」看起来是新的一次，
 * 而那正是要收敛掉的东西。
 */
export class SingleFlight {
  readonly #inflight = new Map<string, Promise<unknown>>();

  /** 在途请求数。给测试与「有没有请求在飞」的界面状态用。 */
  get size(): number {
    return this.#inflight.size;
  }

  has(key: string): boolean {
    return this.#inflight.has(key);
  }

  /**
   * 跑一次任务；同键已有在途请求时返回**那一个**的 promise。
   *
   * 返回同一个 promise（而不是「等它结束后再开一次」）是要紧的：
   * 后者仍然是两次请求，只是被排成了队。
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.#inflight.get(key);
    if (existing !== undefined) return existing as Promise<T>;

    // `task()` 若同步抛出，异常会在 `set` 之前离开本函数，
    // 于是表里不会留下一个永远不结束的条目。
    const started = task().finally(() => {
      this.#inflight.delete(key);
    });
    this.#inflight.set(key, started);
    return started;
  }
}
