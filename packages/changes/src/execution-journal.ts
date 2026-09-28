/**
 * 执行日志的**词汇表与折叠**（LWB-029 的 `ITEM_STAGE` 在本包里的那一份）。
 *
 * ## 为什么这个文件存在
 *
 * 「一次执行在**每个文件**上留下了什么」由两个问题共用，而它们的答案必须是
 * 同一个：
 *
 *  - `revert.ts`（LWB-031）：撤销的前提是「我们写下去的到底是哪一份」；
 *  - `query.ts`（LWB-032）：回执要逐文件给出状态与前后哈希。
 *
 * 两处各抄一份阶段名、各写一次「取最后一条」的折叠，就会有两种规则 ——
 * 而它们的差别会恰好落在「先成功、后被收回」这种条目上：一条规则说
 * `written`、另一条说 `restored`，两边都说得通，读的人没有任何办法分辨。
 * 因此词汇与折叠放在这里，两处都从这里取。
 *
 * ## 权威定义在 `@lwb/executor`，这里只能抄字面量
 *
 * 依赖方向不允许反向 import（`@lwb/executor` 依赖本包，反向会成环），
 * 因此下面那张表是 `ITEM_STAGE` 的**镜像**。抄写这件事必须有一条测试兜着：
 * `tests/windows/changes-revert.test.ts` 的 A5 **逐键**对齐两份清单
 * （只比「两个集合相等」是不够的 —— 把 `verified` 与 `failed` 对调，
 * 集合仍然相等，而语义正好反过来）。少了那条测试，一次改名会让这里全部
 * 落进「认不出」，方向是安全的（停摆），但会停得莫名其妙。
 */

/**
 * 阶段名。键与 `ITEM_STAGE` 逐字对应，`REVERT_JOURNAL_STAGES` 就是它。
 *
 * 值里的每一个都是**执行器写下的字面量**；本包不认识别的。认不出的阶段名
 * 一律走各自折叠函数的 `default` 分支，方向是 fail-closed。
 */
export const EXECUTION_JOURNAL_STAGES = {
  /** 我**这就开始**动这个文件了。写在护栏调用**之前**。 */
  intent: 'item_intent',
  /** 阶段 A 发现磁盘上已经是目标内容 —— 没有改动，也不是冲突。 */
  skipped: 'item_skipped',
  /** 失败，但可**证明**本次执行没有在这个文件上留下任何字节。 */
  untouched: 'item_untouched',
  /** 护栏报告字节已写出（回执里 `bytes_written`）。 */
  written: 'item_written',
  /** 删除回执已核对原身份/哈希，并确认路径已消失。 */
  deleted: 'item_deleted',
  /** 同一次回执报告已刷盘（`flushed=true`）。 */
  flushed: 'item_flushed',
  /** 同一次回执报告回读与目标逐字节相同（`readback_ok` 且哈希相等）。 */
  verified: 'item_verified',
  /** 护栏调用失败。磁盘上可能留有本次执行的字节。 */
  failed: 'item_failed',
  /** 有界恢复成功，且**独立回读**证实文件回到了基线。 */
  restored: 'item_restored',
  /** 有界恢复**没有尝试**（原因在 `error_code`）。留下的事实与失败相同。 */
  restore_skipped: 'item_restore_skipped',
  /** 有界恢复尝试了但失败（护栏拒绝、或恢复后的回读与基线不符）。 */
  restore_failed: 'item_restore_failed',
} as const;

/**
 * 一本日志里的一行，**本包用得上的那几列**。
 *
 * 结构类型而不是 import `@lwb/persistence` 的行类型：`Repositories` 的行类型
 * 是仓储方法内联写出来的匿名形状，抓不住；而这里要的只是「折叠需要读什么」。
 * 多出来的列（`created_at` 等）在本包里没有任何用处，也就不进这个形状。
 */
export interface ExecutionJournalRow {
  readonly seq: number;
  /** 改动级的行（`item_id` 为 `NULL`）也在同一张表里，折叠时必须先筛掉。 */
  readonly item_id: string | null;
  readonly stage: string;
  readonly observed_file_id: string | null;
  readonly observed_sha256: string | null;
  readonly target_sha256: string | null;
  readonly error_code: string | null;
}

/**
 * 一个条目在日志里的**最后一条**行。没有它的行时返回 `null`。
 *
 * ## 为什么是「最后一条」而不是「出现过某个阶段」
 *
 * 一个条目可以先 `item_verified` 再 `item_restore_failed`，而这两条拼起来的
 * 事实是「磁盘上可能留着我们写的字节」。按「出现过」折叠会把它报成
 * 「写成功了」—— 那正是「把部分完成当全成功」。`@lwb/executor` 的
 * `itemOutcomes` 用的是同一条规则，同一个理由。
 *
 * ## 为什么必须按 `item_id` 先筛
 *
 * 一次真实的执行日志**不是**只有条目级行：它最后还有一条 `write_applied`，
 * 而那一行的 `item_id` 是 `NULL`（LWB-031 采集时撞出来的事实，偏离项 123）。
 * 「取整条日志的最后一行」因此会取到一条**不属于任何条目**的行 ——
 * 所有条目都会得到一个「认不出的阶段名」，而它们各自真正的那条 `verified`
 * 从来没被看过。筛掉它是这一步的全部意义。
 */
export function lastEventOf(
  events: readonly ExecutionJournalRow[],
  itemId: string,
): ExecutionJournalRow | null {
  let last: ExecutionJournalRow | null = null;
  for (const row of events) {
    if (row.item_id !== itemId) continue;
    if (last === null || row.seq > last.seq) last = row;
  }
  return last;
}
