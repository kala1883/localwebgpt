/**
 * 暂停与恢复的界面判定（LWB-035 步骤 3 的「一键暂停」）。
 *
 * ## 一次暂停要说的不是「已暂停」，是五件事
 *
 * 「一键暂停」这个词让人以为按下之后屏幕上只有一句话。而 LWB-034 的取证
 * 说明按下去之后有**五**件不同的事实同时成立，其中三件会被一句「已暂停」
 * 盖住（证据见 `docs/evidence/lwb-034/raw.log` §2.5 与 §4）：
 *
 * | # | 事实 | 被「已暂停」盖住之后会怎样 |
 * | --- | --- | --- |
 * | 1 | 有一个写入**还在停**（它仍握着写盘权） | 操作者以为「已经没事了」，而此刻盘上正在变 |
 * | 2 | 排队中的授权**被废止了**（它们不会再执行） | 以为「暂停只是慢一点」，其实那些提案已经作废 |
 * | 3 | 有操作停在**待恢复**（等人核验） | 以为重启就能回到原样 |
 * | 4 | 已经交出去的内容**收不回来**（`unrecallable_file_rows`） | 以为暂停等于「什么都没出去」 |
 * | 5 | 暂停**落在库里**（重启仍然停着） | 以为重启就恢复了 |
 *
 * 这五条都由 `pauseView` 逐条给出来，而不是让 `.vue` 去 `reading.value.stopping.length`
 * 之类的表达式里各取所需 —— 那样每一条都会在某次改版里悄悄消失。
 *
 * ## 暂停与恢复的方向**不对称**，这是本模块最要紧的一条
 *
 * | 动作 | 方向 | 因此允许的前提 |
 * | --- | --- | --- |
 * | 暂停 | **更保守** | 只要有会话就给。读数是旧的、缺的、矛盾的，都不构成不给它的理由 |
 * | 恢复 | **更宽松** | 只在**一份新鲜的、明确说「停着」的**读数之上才给 |
 *
 * 一条单独的读数都不能构成恢复的理由：`paused === false` 只是「那一刻没停」，
 * 而休息/断网/时钟校正都发生在这句话被写下之后。反过来，暂停**不**要求读数
 * 新鲜，恰恰因为「读数不新鲜」本身就是想按暂停的常见原因（睡眠唤醒、
 * 网络断了、界面卡住）。把暂停也压在一份新鲜读数之下，等于在最需要它的
 * 场景里把按钮收起来。
 */

import type { SessionPresence } from '../changes/approval.ts';
import type {
  Freshness,
  PauseOutcomeReading,
  PauseStatusReading,
  Reading,
} from './readings.ts';
import { DEFAULT_STALE_AFTER_MS, freshnessOf } from './readings.ts';

/** 不能暂停的原因。只有会话类两种 —— 见文件头：暂停不为读数设门槛。 */
export type PauseBlockedReason = 'NO_SESSION' | 'SESSION_EXPIRED';

/** 恢复不可用的原因。比暂停多三类，因为恢复要读数撑腰。 */
export type ResumeBlockedReason =
  | PauseBlockedReason
  | 'NO_READING'
  | 'STALE_READING'
  | 'NOT_PAUSED';

export interface PauseViewInput {
  readonly session: SessionPresence | null;
  /** 同 `changes/approval.ts`：与「没有会话」分开传，给的下一步不一样。 */
  readonly session_expired?: boolean;
  /** `service.pause_status` 的读数；没取到就是 `null`。 */
  readonly reading: Reading<PauseStatusReading> | null;
  /** 判定时刻，由调用方传入（这一层不读时钟）。 */
  readonly now: string;
  readonly stale_after_ms?: number;
}

export interface PauseView {
  readonly can_pause: boolean;
  readonly can_resume: boolean;
  readonly freshness: Freshness;
  /**
   * 读数里那一格 `paused`。**没读数时是 `null`，不是 `false`。**
   *
   * 单独给出来而不是让 `.vue` 去 `reading.value.paused` 里取：那个表达式
   * 在 `reading === null` 时会变成 `undefined`，而模板里
   * `v-if="paused"` 与 `v-if="!paused"` 的两支都会落到「没暂停」那一支 ——
   * 界面于是把「没有读数」显示成「服务正常」。这正是 `readings.ts`
   * 文件头要防的那件事，而它最容易在模板里被重新引入。
   */
  readonly paused: boolean | null;
  readonly pause_blocked_reason: PauseBlockedReason | null;
  readonly resume_blocked_reason: ResumeBlockedReason | null;
  /** 通栏那一句。永远非空。 */
  readonly headline: string;
  /** 必须逐条显示的读数事实。读数的五个事实各占一条。 */
  readonly facts: readonly string[];
  /** 是否应当提示重新运行本地启动命令（会话类原因）。 */
  readonly offer_relogin: boolean;
}

function pauseBlocked(
  reason: PauseBlockedReason,
  headline: string,
  freshness: Freshness,
  paused: boolean | null,
  facts: readonly string[],
  offerRelogin: boolean,
): PauseView {
  return {
    can_pause: false,
    can_resume: false,
    freshness,
    paused,
    pause_blocked_reason: reason,
    resume_blocked_reason: reason,
    headline,
    facts,
    offer_relogin: offerRelogin,
  };
}

/**
 * 把一份暂停读数翻成「必须说出来的那几条」。
 *
 * **读数为 `null` 时返回的是一句「没有读数」，不是一个空数组**：空数组在
 * 界面上表现为「下面什么都没有」，而操作者读到的意思是「一切正常，没有
 * 需要说的事」。这两件事正好相反。
 */
function factsOf(reading: PauseStatusReading, fresh: Freshness, observedAt: string): readonly string[] {
  const facts: string[] = [];

  if (fresh !== 'fresh') {
    // 先声明这份读数是什么时候的。不写这一句的话，下面每一条都会被读成
    // 「此刻如此」—— 包括「暂停中」这一条。
    facts.push(`读数时刻：${observedAt}（${fresh === 'absent' ? '没有读数' : '读数已过期'}，下面每一条说的都是那一刻的样子）。`);
  }

  facts.push(
    reading.paused
      ? `服务处于暂停状态${reading.paused_at === null ? '（这一份读数里没有暂停时刻）' : `，上次暂停于 ${reading.paused_at}`}。` +
          '暂停会阻断新的读取、命令执行与应用，**不撤销已经交出去的内容**。'
      : '服务当前没有暂停，新调用会被正常处理。',
  );

  // 事实 1：还在停的写入。这一条的位置最靠前，因为它描述的是**正在发生**的事。
  const stopping = reading.stopping[0];
  if (stopping === undefined) {
    facts.push('没有正在进行的写入。');
  } else {
    facts.push(
      `**有 ${String(reading.stopping.length)} 个写入正在停**（第一件：操作 ${stopping.operation_id}，` +
        `状态 ${stopping.state}，持有者 pid ${stopping.holder_pid === null ? '未知' : String(stopping.holder_pid)}）：` +
        '它仍握着写盘权，盘上的内容可能此刻正在变。' +
        (stopping.slot_blocked ? '（写盘位已被占住，新的应用要等它。）' : ''),
    );
  }

  // 事实 2：排队中的授权。暂停的语义之一就是废止它们。
  facts.push(
    reading.unrevoked_change_sets.length === 0
      ? '没有排队中的授权。'
      : `有 ${String(reading.unrevoked_change_sets.length)} 份授权还排着队（尚未被废止）：` +
        reading.unrevoked_change_sets.map((row) => `${row.change_id}（${row.state}）`).join('、') +
        '。',
  );

  // 事实 3：待恢复。这一条不清理、不自动定案，因此必须显式说出来。
  facts.push(
    reading.recovery_operations.length === 0
      ? '没有等待人工核验的恢复现场。'
      : `**有 ${String(reading.recovery_operations.length)} 个操作处于待恢复状态**，需要本机操作者逐件核验：` +
        reading.recovery_operations.map((row) => row.operation_id).join('、') +
        '。在它们被处理之前，工具面不会对相关文件做出任何承诺。',
  );

  // 事实 4：已经出去的东西。数的是**行**，而一条被截断的响应不会到这里
  // （见 readings.ts 里那个字段的说明），因此这里可以说「截至上面那个时刻」。
  facts.push(
    reading.unrecallable_file_rows === 0
      ? '没有已经交出去的文件内容记录。'
      : `**已经交出去、收不回来的文件访问有 ${String(reading.unrecallable_file_rows)} 条**：` +
        '暂停与撤销都改变不了这一点 —— 能收回的是回执，不是已经发出去的内容。',
  );

  return facts;
}

/** 暂停与恢复此刻各能不能按，以及按不下去时的那句话。 */
export function pauseView(input: PauseViewInput): PauseView {
  const freshness = freshnessOf(input.reading, input.now, input.stale_after_ms ?? DEFAULT_STALE_AFTER_MS);
  const observedAt = input.reading?.observed_at ?? '';
  const facts = input.reading === null ? [] : factsOf(input.reading.value, freshness, observedAt);
  const paused = input.reading?.value.paused ?? null;

  if (input.session === null) {
    const expired = input.session_expired === true;
    return pauseBlocked(
      expired ? 'SESSION_EXPIRED' : 'NO_SESSION',
      expired
        ? '控制台会话已过期，暂停与恢复都按不动。重新运行本地启动命令，用打印出来的地址重新打开控制台。'
        : '还没有控制台会话，暂停与恢复都按不动。本地启动命令会打印一个带一次性令牌的地址，用它打开控制台。',
      freshness,
      paused,
      facts.length === 0 ? ['没有读数。'] : facts,
      true,
    );
  }

  // 恢复：要一份**新鲜且明确说停着**的读数。
  let resumeBlockedReason: ResumeBlockedReason | null = null;
  if (input.reading === null) resumeBlockedReason = 'NO_READING';
  else if (freshness !== 'fresh') resumeBlockedReason = 'STALE_READING';
  else if (!input.reading.value.paused) resumeBlockedReason = 'NOT_PAUSED';

  // 暂停：有会话就给。
  const headline = resumeBlockedReason === null
    ? '可以暂停，也可以恢复。'
    : input.reading === null
      ? '可以暂停。此时没有读数，因此**不提供恢复** —— 恢复要求一份新鲜的、明确说服务停着的读数。'
      : freshness !== 'fresh'
        ? `可以暂停。读数不新鲜（${observedAt}），因此**不提供恢复**：先重新验证，再决定要不要恢复。`
        : '可以暂停。读数说服务现在没有停，因此没有可恢复的东西。';

  return {
    can_pause: true,
    can_resume: resumeBlockedReason === null,
    freshness,
    paused,
    pause_blocked_reason: null,
    resume_blocked_reason: resumeBlockedReason,
    headline,
    facts: facts.length === 0 ? ['没有读数。'] : facts,
    offer_relogin: false,
  };
}

/** 一次暂停/恢复按键的结果有多严重。界面按它决定要不要用通栏警告。 */
export type PauseOutcomeSeverity = 'ok' | 'attention' | 'critical';

export interface PauseOutcomeReport {
  readonly severity: PauseOutcomeSeverity;
  /** 通栏那一句。永远非空。 */
  readonly headline: string;
  /** 逐条结果。只要有一件没做成，它就在这里，不会被下一行盖住。 */
  readonly lines: readonly string[];
}

/**
 * 把一次按键的结果翻成要说的话。
 *
 * **失败的那几件永远排在前面**，而且不会被随后的成功盖住：`persist_failed`
 * （暂停没落库）与 `revoke_failed`（排队授权没废止）都意味着「界面接下来
 * 显示的那个状态**也许不成立**」，而它们各自都有真实的后果 —— 前者是重启之后
 * 服务不记得自己停过（LWB-034 证据 §5 证的是它**会**记得），后者是队列里的
 * 提案仍然可以被执行。
 *
 * 通栏语气的判据是**这两件失败**，不是「有没有改到东西」：
 * `already: true`（之前就停着）是一次成功什么也没发生的按键，它是 `ok`。
 */
export function pauseOutcomeReport(outcome: PauseOutcomeReading): PauseOutcomeReport {
  const lines: string[] = [];
  let severity: PauseOutcomeSeverity = 'ok';

  if (outcome.revoke_failed) {
    severity = 'critical';
    lines.push(
      `**废止排队中的授权失败**：${outcome.revoke_message ?? '（服务没有给原因）'}。` +
        '队列里的授权可能仍然可以被执行 —— 服务已经暂停，但不要把它当成「队列已经清空」。',
    );
  }

  if (outcome.persist_failed) {
    severity = 'critical';
    lines.push(
      `**暂停状态没有落库**：${outcome.persist_message ?? '（服务没有给原因）'}。` +
        '本进程现在停着，但重启之后服务可能不记得自己停过。',
    );
  }

  if (outcome.already) {
    lines.push('服务此前已经处于暂停状态（这次按键没有改变什么）。');
  } else if (!outcome.revoke_failed && !outcome.persist_failed) {
    lines.push('暂停已生效。');
  }

  lines.push(
    outcome.revoked.length === 0
      ? '没有需要废止的排队授权。'
      : `已废止 ${String(outcome.revoked.length)} 份排队中的授权：` +
        outcome.revoked.map((row) => row.change_id).join('、') +
        `${outcome.revoked.some((row) => row.approval_id !== null) ? '（本地批准一并作废）' : ''}。`,
  );

  if (outcome.skipped.length > 0) {
    // 「跳过」与「废止失败」不是一回事：跳过的那些本来就不该被动（例如
    // 已经是终态），因此它不升级通栏语气，但必须逐条说出来 —— 否则
    // 「废止了 3 份」这句话会被读成「队列空了」。
    lines.push(
      `另有 ${String(outcome.skipped.length)} 份没有废止（合计 ${String(outcome.revoked.length + outcome.skipped.length)} 份排队）：` +
        outcome.skipped.map((row) => `${row.change_id}（${row.reason}）`).join('、') +
        '。',
    );
  }

  if (outcome.status === null) {
    severity = severity === 'ok' ? 'attention' : severity;
    lines.push('服务没有回一份当前状态，因此这次按键之后的样子未知 —— 请重新验证。');
  }

  const headline =
    severity === 'critical'
      ? '紧急停用**没有完全做成**：下面第一句话说的那件事仍然成立，请先读它。'
      : outcome.status === null
        ? '按键已送达，但之后的状态没有读到。'
        : outcome.already
          ? '服务本来就在暂停中。'
          : '已暂停：新的读取、命令执行与新应用都被阻断；已经交出去的内容收不回来。';

  return { severity, headline, lines };
}
