/**
 * 行级文本差异（LWB-016；LWB-025 起住在本包）。
 *
 * ## 它为什么住在这里，而不是 `@lwb/git-reader`
 *
 * 这个文件是**纯算法**：进出的都是内存里的字符串，不知道 Git 是什么，
 * 也不知道磁盘是什么。它原来住在 `git-reader` 里只是因为 `git_diff` 是
 * 第一个消费者。LWB-025 的 `change_get` 需要同一件事（把两份快照字节
 * 变成一份差异），而让它去 import 一个会拖进 `isomorphic-git` 的包
 * 只为拿一个 LCS，是把依赖方向反过来绑。
 *
 * 两个消费者（`@lwb/git-reader`、`@lwb/changes`）都已经依赖本包，
 * 因此这里是唯一一处不需要新增任何依赖边的地方。
 *
 * ## 它比较的是**字节**，不是 Git 的语义
 *
 * 契约的 `note` 要求写明这一点，这里把它落到实现上：切行只按 `\n`，
 * `\r` 留在行内容里。也就是说 CRLF 与 LF 的差别**会**显示成整片改动，
 * 而 `git diff`（在 `core.autocrlf=true` 下）会认为它们相同。
 *
 * 反过来做——顺手归一化换行——更「好用」，但那意味着工具返回的差异
 * **不是**磁盘上两份字节的差异，而是一份我们加工过的说法。契约里
 * 「工作区字节差异、Git 的换行/属性语义可能不同」这句话，只有在不归一化
 * 时才成立。
 *
 * ## 有界
 *
 * LCS 是 O(旧行数 × 新行数) 的表格。两个两万行的文件就是四亿个格子，
 * 足够把这个进程按死。因此超出一格上限时**不猜、不算**，退化成
 * 「整段替换」的一个 hunk，并把 `truncated` 置真 —— 那个 hunk 仍然是一份
 * 正确的差异（旧的全删、新的全加），只是不是最小的。
 *
 * 一份「最小但不保证正确」的差异，比一份「不最小但确实正确」的差异危险得多。
 */
import type { GitDiffHunk } from '@lwb/contracts';

/**
 * LCS 表格的格子数上限。**不是产品限额**，因此不写进冻结契约。
 *
 * 它是内存边界：`旧行数 × 新行数` 个 `Int32` 格子，400 万格约合 16 MiB，
 * 而两个两万行的文件就是四亿格。超过就退化成「整段替换」的一个 hunk
 * （仍然正确，只是不是最小差异），见下面的 `diffLines`。
 *
 * ## 它为什么住在这里
 *
 * 它描述的是**这个算法**的内存代价，不是某个工具的配置，因此只能有一个
 * 取值、且必须紧挨着那个算法。LWB-025 之前它在 `@lwb/git-reader` 的限额表里
 * （当时 `diffLines` 也住在那里）；把算法搬到这里之后又留在那边，就会出现
 * 「`git_diff` 用 400 万格、`change_get` 用另一个数」这种只有读到两处
 * 才能发现的分叉。
 *
 * 操作者没有理由调它：调大它不会让任何一次查询变得更完整 ——
 * 它只决定差异的**最小性**，不决定结果的正确性。
 */
export const DIFF_MAX_DP_CELLS = 4_000_000;

export interface DiffLimits {
  /** 所有 hunk 的 `lines` 加起来的字节上限。 */
  readonly max_output_bytes: number;
  /** 每个 hunk 前后各带几行上下文。 */
  readonly context_lines: number;
  /** LCS 表格的格子数上限。 */
  readonly max_dp_cells: number;
}

export interface DiffResult {
  readonly hunks: readonly GitDiffHunk[];
  readonly truncated: boolean;
}

interface Op {
  readonly kind: ' ' | '-' | '+';
  readonly line: string;
}

/** 切成行。只按 `\n` 切，行内容**保留** `\r`（见文件头）。空文本是零行。 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // `"a\n"` 切出来是 `['a','']`：末尾那个空串是「文件以换行结尾」的表现，
  // 不是一个空行。少了这一步，每个文件都会多出一行"被删掉"的空行。
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function diffLines(oldText: string, newText: string, limits: DiffLimits): DiffResult {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // 公共前缀 / 后缀先摘掉：真实改动往往只占文件的一小块，摘掉之后
  // LCS 的规模通常从「文件大小」降到「改动大小」。
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const aMid = a.slice(head, a.length - tail);
  const bMid = b.slice(head, b.length - tail);
  if (aMid.length === 0 && bMid.length === 0) return { hunks: [], truncated: false };

  const cells = aMid.length * bMid.length;
  const middle: Op[] =
    cells > limits.max_dp_cells
      ? [
          ...aMid.map((line): Op => ({ kind: '-', line })),
          ...bMid.map((line): Op => ({ kind: '+', line })),
        ]
      : lcsOps(aMid, bMid);

  // 前缀与后缀**作为上下文行留在 ops 里**，只是不参与 LCS：这样 hunk
  // 前后的上下文会自然地伸进未改动的部分，与 unified diff 的观感一致。
  const ops: Op[] = [
    ...a.slice(0, head).map((line): Op => ({ kind: ' ', line })),
    ...middle,
    ...a.slice(a.length - tail).map((line): Op => ({ kind: ' ', line })),
  ];

  return groupHunks(ops, limits);
}

/** 标准的 LCS 回溯。规模由调用方保证。 */
function lcsOps(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // `dp[i * width + j]` = a[i..] 与 b[j..] 的 LCS 长度。
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? (dp[(i + 1) * width + (j + 1)] ?? 0) + 1
          : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + (j + 1)] ?? 0);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] as string });
      i += 1;
      j += 1;
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + (j + 1)] ?? 0)) {
      ops.push({ kind: '-', line: a[i] as string });
      i += 1;
    } else {
      ops.push({ kind: '+', line: b[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: '-', line: a[i] as string });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: '+', line: b[j] as string });
    j += 1;
  }
  return ops;
}

/**
 * 把扁平的 op 序列切成 hunk：改动行前后各带 `context_lines` 行上下文，
 * 两个 hunk 的上下文若重叠或相接就合并成一个。
 *
 * 输出字节超限时**在行边界停下**：越界的那一条 hunk 只带上放得下的那些行，
 * 行号与行数按**实际带上的行**重新数（`old_lines` / `new_lines`），因此
 * 表头的行号仍然是**真的** —— 它说的是这一条 hunk 里到底有什么，而不是
 * 它本来能有什么。它之后的 hunk 一条都不再输出；一条都放不下时，这一条
 * 连同后面的一起丢。
 *
 * 被截掉这件事由 `truncated` 说出去，调用方凭它决定「看全了没有」——
 * LWB-036 的复核覆盖正是这么判的（`TRUNCATED_DIFF` 让批准入口消失）。
 *
 * 上面这段描述在 LWB-036 之前写的是「丢掉装不下的那一条 hunk」（偏离项 146）：
 * 那句话描述的是一个**更安全的**策略，而代码从来不是那么做的。行为本身
 * 是对的，错的是这段字 —— 有人照着它去读 `@@` 表头的行数时会算错。
 */
function groupHunks(ops: readonly Op[], limits: DiffLimits): DiffResult {
  const changed: number[] = [];
  for (let k = 0; k < ops.length; k += 1) {
    if (ops[k]?.kind !== ' ') changed.push(k);
  }
  if (changed.length === 0) return { hunks: [], truncated: false };

  const ctx = Math.max(0, limits.context_lines);
  const ranges: { start: number; end: number }[] = [];
  for (const k of changed) {
    const start = Math.max(0, k - ctx);
    const end = Math.min(ops.length, k + ctx + 1);
    const last = ranges.at(-1);
    if (last !== undefined && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  const hunks: GitDiffHunk[] = [];
  let used = 0;
  let truncated = false;
  // 行号游标：走过 ops 一路累加，因此不需要另算 `old_start`。
  let cursor = 0;
  let oldLine = 1;
  let newLine = 1;

  for (const range of ranges) {
    while (cursor < range.start) {
      const op = ops[cursor];
      if (op?.kind !== '+') oldLine += 1;
      if (op?.kind !== '-') newLine += 1;
      cursor += 1;
    }

    const oldStart = oldLine;
    const newStart = newLine;
    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;

    while (cursor < range.end) {
      const op = ops[cursor];
      if (op === undefined) break;
      const rendered = `${op.kind}${op.line}`;
      if (used + Buffer.byteLength(rendered, 'utf8') + 1 > limits.max_output_bytes) {
        truncated = true;
        break;
      }
      used += Buffer.byteLength(rendered, 'utf8') + 1;
      lines.push(rendered);
      if (op.kind !== '+') {
        oldCount += 1;
        oldLine += 1;
      }
      if (op.kind !== '-') {
        newCount += 1;
        newLine += 1;
      }
      cursor += 1;
    }

    if (lines.length === 0) {
      truncated = true;
      break;
    }
    hunks.push({ old_start: oldStart, old_lines: oldCount, new_start: newStart, new_lines: newCount, lines });
    if (truncated) break;
  }

  return { hunks, truncated };
}
