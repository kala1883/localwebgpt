/**
 * 逐文件翻页与键盘操作（LWB-036 步骤 1）。
 *
 * ## 两件看起来无关的事为什么在同一个文件里
 *
 * 「翻到下一个文件」与「按下 `j`」是**同一个动作**的两种触发方式。
 * 把它们分开写，就会有一份「按钮能去的方向」和另一份「按键能去的方向」
 * —— 而两份方向表迟早会不一样，不一样的那一半是一个**能到却没人知道
 * 怎么到**（或者更坏：能到却没有任何视觉线索）的位置。
 *
 * 因此方向只有一处：下面的 `stepFile`。按钮与键盘都调它。
 *
 * ## 键盘映射是**数据**，不是 `switch`
 *
 * `REVIEW_KEYMAP` 是一张表，理由是它可以被**断言**：测试可以问
 * 「这个界面到底认哪些键」，而一个 `switch` 语句只能通过「按下每一个
 * 想得到的键」来测。可断言的那一份在改动时会被看见 —— 包括
 * 「有人加了一个键」这件事。
 *
 * ## 批准**没有**快捷键，这一条是刻意的
 *
 * 方案 §10.2 的主按钮是「批准并应用」，而它绑定的是一次真实写入。
 * 给它一个单键快捷方式（`Enter`、`a`、`y`）意味着一次误触就能排入
 * 一次写盘 —— 而 LWB-034 的 `service.pause` 那条注释写过同一件事：
 * 「一个可以被重放的暂停请求，等于一个可以被重放的紧急按钮」。
 * 批准属于同一类动作，因此它只接受一次**明确的点击**：
 * 一个需要把指针移过去、按下去的动作，与一个手放在键盘上就能触发的
 * 动作，在「这是不是一次有人真的按了」这个问题上不是同一件事。
 *
 * 这条也解释了下面 `KeyboardAction` 里为什么**没有** `approve` 这一项：
 * 不是忘了加，是类型上就不该存在。
 */

/**
 * 界面认得的一次键盘动作。
 *
 * 没有 `approve` / `reject` —— 见文件头最后一段。
 */
export type KeyboardAction =
  | 'next-file'
  | 'prev-file'
  | 'first-file'
  | 'last-file'
  | 'mode-unified'
  | 'mode-before'
  | 'mode-after'
  | 'next-page';

export interface KeyBinding {
  /** `KeyboardEvent.key` 的值，区分大小写（`j` 与 `J` 是两个条目）。 */
  readonly key: string;
  readonly action: KeyboardAction;
  /** 界面上写出来的说明。它同时是 `title` 与无障碍说明的来源。 */
  readonly label: string;
}

/**
 * 复核页的键盘映射。
 *
 * 方向键与 `j`/`k` 都在：前者是「任何界面都该有的」，后者是给
 * 习惯了 vim 的人少一次手部移动。同一个动作有两条键不是冗余 ——
 * 而两条都指向**同一个** `action`，因此它们不可能到达不同的地方。
 *
 * `1/2/3` 对应「完整差异 / 原文 / 新文」三种模式，与 `DiffView`
 * 的模式按钮同序。数字键而不是 `u/b/a` 之类的助记：模式是**顺序**
 * 概念，而顺序用数字表达不需要翻译。
 */
export const REVIEW_KEYMAP: readonly KeyBinding[] = Object.freeze([
  Object.freeze({ key: 'j', action: 'next-file' as const, label: '下一个文件' }),
  Object.freeze({ key: 'ArrowDown', action: 'next-file' as const, label: '下一个文件' }),
  Object.freeze({ key: 'k', action: 'prev-file' as const, label: '上一个文件' }),
  Object.freeze({ key: 'ArrowUp', action: 'prev-file' as const, label: '上一个文件' }),
  Object.freeze({ key: 'Home', action: 'first-file' as const, label: '第一个文件' }),
  Object.freeze({ key: 'End', action: 'last-file' as const, label: '最后一个文件' }),
  Object.freeze({ key: '1', action: 'mode-unified' as const, label: '完整差异' }),
  Object.freeze({ key: '2', action: 'mode-before' as const, label: '原文' }),
  Object.freeze({ key: '3', action: 'mode-after' as const, label: '新文' }),
  Object.freeze({ key: 'n', action: 'next-page' as const, label: '下一页差异' }),
]);

/**
 * 按键 → 动作。认不出时返回 `null`。
 *
 * `null` 而不是一个 `'noop'`：认不出的键要**放过去**（不
 * `preventDefault`），否则这个页面会把浏览器自己的快捷键全部吃掉
 * ——`Ctrl+R`、`F5`、`Ctrl+F`。一个「页面里按什么都没反应」的界面，
 * 与一个「坏掉的界面」在操作者那里是同一件事。
 */
export function actionFor(key: string): KeyboardAction | null {
  for (const binding of REVIEW_KEYMAP) {
    if (binding.key === key) return binding.action;
  }
  return null;
}

/**
 * 在文件清单里走一步。
 *
 * ## 到边界是**停住**，不是绕回去
 *
 * 循环（最后一项再按 `j` 回到第一项）在这里是有害的：清单的
 * 长度不是恒定的（翻页、刷新、别的连接又提议了一份），于是「绕回去」
 * 与「清单变短了」在屏幕上长得一样 —— 操作者会以为自己还在往下看，
 * 实际上已经回到了开头，而**「已经看完全部」这件事正是批准的前提**。
 * 停住则有一个明确的信号：不动了。
 *
 * `count` 为 0 时返回 `0`（一个不存在的下标），调用方据此显示空状态。
 */
export function stepFile(index: number, count: number, delta: -1 | 1): number {
  if (count <= 0) return 0;
  const next = index + delta;
  if (next < 0) return 0;
  if (next > count - 1) return count - 1;
  return next;
}

/** 夹到合法区间。清单变短（刷新之后）时用它把选中项拉回来。 */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  if (index < 0) return 0;
  if (index > count - 1) return count - 1;
  return index;
}

/**
 * 当前位置的说明，例如 `第 3 / 12 个文件 · 第 2 页（已到末页）`。
 *
 * ## 页数为什么是「已取回的页」而不是「第几页 / 共几页」
 *
 * 服务端的差异是游标分页（`ChangeDiffPage.next_cursor`），**总数不可知**
 * —— 它不回答「还剩几页」。界面上写一个 `2 / 5` 需要先猜一个 5，
 * 而一个猜出来的分母会让操作者按它来安排阅读：看到 `2 / 3` 就以为
 * 快看完了。因此这里只说两件**知道**的事：已经取回了多少页，
 * 以及最后那一页是不是末尾。
 *
 * `reached_end` 为 `null` 表示「还不知道」（这一份文件还没取过差异），
 * 与 `false`（取过，后面还有）是两件事，不能合并。
 */
export function positionLabel(
  index: number,
  count: number,
  pages: number,
  reachedEnd: boolean | null,
): string {
  const file = count <= 0 ? '没有文件' : `第 ${clampIndex(index, count) + 1} / ${count} 个文件`;
  if (pages <= 0) return `${file} · 差异尚未载入`;
  const tail = reachedEnd === null ? '' : reachedEnd ? '（已到末页）' : '（还有更多）';
  return `${file} · 已取回 ${pages} 页差异${tail}`;
}
