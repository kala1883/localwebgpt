/**
 * `git_status` / `git_diff` 的限额（LWB-016）。
 *
 * ## 为什么契约里已经有一份，这里还要有一份
 *
 * `@lwb/contracts` 的 `LIMITS` 是**产品限额**：它回答「操作者可以调什么」，
 * 是冻结基线的一部分。这一层回答的是「这两个工具各自需要哪些数」，
 * 而且必须**只有一处取值**——`git_status` 的限额表与它实际传给虚拟 fs 的
 * 那几个数是同一个对象算出来的，不存在「上层写 8 MiB、下层写 16 MiB」的分叉。
 *
 * ## 模型不能从这里改任何值
 *
 * 覆盖入口只给本地操作者（`deps.limits`），与 `SearchLimits` 同形：
 * 工具参数里**没有**任何字段通向这里。测试与证据脚本用同一个入口把上限
 * 调小，从而在几毫秒内走到边界路径上。
 */
import { LIMITS } from '@lwb/contracts';
import { DIFF_MAX_DP_CELLS } from '@lwb/files';

export interface GitLimits {
  /** `.git` 内部单个文件的上限（packfile 是触发它的现实）。 */
  readonly max_git_internal_file_bytes: number;
  /** 参与状态比对的**工作区**单文件上限；超过即「没能比对」，不是失败。 */
  readonly max_worktree_file_bytes: number;
  /** 一次状态查询累计允许读取的工作区字节数。 */
  readonly max_worktree_read_bytes: number;
  /** 一次状态查询最多返回的条目数。 */
  readonly max_status_entries: number;
  /** `git_diff` 单侧字节上限（两侧同时驻留内存，因此比单文件读取上限更严）。 */
  readonly max_diff_bytes: number;
  /** `git_diff` 输出的 hunk 行总字节上限。 */
  readonly max_diff_output_bytes: number;
  /** 每个 hunk 前后各带几行上下文。 */
  readonly diff_context_lines: number;
  /** LCS 表格的格子数上限。取值与 `change_get` 共用同一个常量。 */
  readonly max_dp_cells: number;
}

export const DEFAULT_GIT_LIMITS: GitLimits = {
  max_git_internal_file_bytes: LIMITS.MAX_GIT_INTERNAL_FILE_BYTES,
  // 与 `file_read` 用同一个数：同一个文件在两条路径上不该有不同的「太大」判据。
  max_worktree_file_bytes: LIMITS.MAX_READABLE_FILE_BYTES,
  max_worktree_read_bytes: LIMITS.MAX_GIT_STATUS_WORKTREE_BYTES,
  max_status_entries: LIMITS.MAX_GIT_STATUS_ENTRIES,
  max_diff_bytes: LIMITS.MAX_GIT_DIFF_BYTES,
  max_diff_output_bytes: LIMITS.MAX_GIT_DIFF_OUTPUT_BYTES,
  diff_context_lines: LIMITS.GIT_DIFF_CONTEXT_LINES,
  max_dp_cells: DIFF_MAX_DP_CELLS,
};

export function gitLimitsOf(overrides?: Partial<GitLimits>): GitLimits {
  return { ...DEFAULT_GIT_LIMITS, ...(overrides ?? {}) };
}
