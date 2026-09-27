/**
 * git_status / git_diff 契约（方案 §9.1、LWB-016）。
 *
 * 硬约束：
 *  - 不执行 Git CLI，不提供 HTTP 客户端，不接受任意 raw object ID。
 *  - 底层只读虚拟 fs 的所有写方法直接拒绝；statusMatrix 使用 refresh:false，
 *    避免刷新 .git/index 的 stat 缓存。
 *  - 只能按已授权路径解析旧/新内容；被拒绝文件不得借 diff 或错误旁路返回。
 *  - 结果只覆盖授权范围，**不是**全仓安全审计。
 */

/**
 * 单个文件在某一侧的关系。
 *
 * **没有 `ignored`**，而且这是实测结论不是遗漏：被忽略的文件要出现在结果里，
 * 只能靠底层库的 `ignored: true`，而那个开关会同时让工作区遍历**进入 `.git/`**
 * 并返回 `.git/**` 的路径（实测见 `docs/evidence/lwb-016/`）。也就是说
 * 「能不能看见被忽略的文件」与「模型能不能枚举 `.git` 内部」是同一个开关 ——
 * 既然后者是本任务明确要排除的形态，前者只能不要。
 * 于是本工具报告的是「被跟踪的文件」与「未被忽略的未跟踪文件」，
 * 被忽略的文件在结果里完全不存在，不进入任何计数字段。
 */
export type GitFileStatus =
  | 'unmodified'
  | 'added'
  | 'modified'
  | 'deleted'
  | 'untracked'
  | 'absent';

/**
 * 一条**没能参与比对**的路径。
 *
 * 它与「没有改动」是两件不同的事，因此单列出来：漏掉这一项，
 * 「读不动所以没比」会在结果里长得和「比过了，没变」一模一样。
 *
 * 被**策略硬拒绝**的路径**不在这里**：它们连名字都不出现（只计入
 * `policy_hidden_count`）。理由见 `packages/files/src/list.ts`——
 * 「按策略永远不可读」与「这次没读到」是两回事，前者不该用名字的形式回显。
 */
export interface GitStatusExclusion {
  /** 工作区相对路径。 */
  readonly path: string;
  /** 稳定的机读原因。 */
  readonly reason: GitStatusExclusionReason;
  /** 一句话说明。不含文件内容。 */
  readonly detail: string;
}

export type GitStatusExclusionReason =
  /** 超过单文件比对上限；受控句柄只提供整文件读取，不做部分读。 */
  | 'FILE_TOO_LARGE'
  /** 取不到可信的文件身份（被独占、权限不足、护栏无法证明路径在根之下）。 */
  | 'IDENTITY_UNAVAILABLE'
  /** 是重解析点（符号链接 / junction）。V1 不跟随链接，因此无法比对它。 */
  | 'LINK_UNSUPPORTED';

export interface GitStatusInput {
  readonly workspace_id: string;
  /** 限定路径前缀；省略表示工作区根。 */
  readonly path?: string;
}

export interface GitStatusEntry {
  readonly path: string;
  /** HEAD 与索引的关系。 */
  readonly head: GitFileStatus;
  /** 工作区与索引的关系。 */
  readonly worktree: GitFileStatus;
}

export interface GitStatusData {
  /** 当前分支名；detached 时为 null。 */
  readonly branch: string | null;
  /** HEAD 提交 ID；空仓库为 null。 */
  readonly head_commit: string | null;
  readonly entries: readonly GitStatusEntry[];
  readonly truncated: boolean;
  /**
   * 本次**没能参与比对**的路径。见 `GitStatusExclusion`。
   *
   * 最多列 `MAX_GIT_STATUS_ENTRIES` 条；超出的部分只计入
   * `excluded_truncated`，不会假装没有。
   */
  readonly excluded: readonly GitStatusExclusion[];
  readonly excluded_truncated: boolean;
  /**
   * 被**摘掉**的路径数。**不列出名字。**
   *
   * 两种情形进这一个计数：命中硬拒绝规则，以及路径本身被秘密筛查命中
   * （有人把令牌粘成了文件名）。理由与 `FileListData.denied_entries` 一致：
   * 「按策略永远不可读」与「这次没读到」是两回事，前者不该用名字的形式回显。
   *
   * 计数取自底层只读 fs 的账本，因此它**包括**那些从来没有变成一行的路径
   * （未被跟踪的 `.env` 是在目录列举里被摘掉的）—— 换个算法会漏掉它们。
   */
  readonly policy_hidden_count: number;
  /** 结果只覆盖已授权范围。 */
  readonly limited_to_authorized_paths: true;
  /** Git 布局不完整支持时的说明；null 表示无已知降级。 */
  readonly layout_warning: string | null;
}

export type GitDiffComparison = 'head_vs_worktree' | 'index_vs_worktree' | 'head_vs_index';

export interface GitDiffInput {
  readonly workspace_id: string;
  /** 单个相对文件路径，必须是已授权路径。 */
  readonly path: string;
  readonly comparison?: GitDiffComparison;
}

export interface GitDiffHunk {
  readonly old_start: number;
  readonly old_lines: number;
  readonly new_start: number;
  readonly new_lines: number;
  readonly lines: readonly string[];
}

export interface GitDiffData {
  readonly path: string;
  readonly comparison: GitDiffComparison;
  /** 旧侧是 HEAD 时的固定提交 ID；其余比较里旧侧不是提交，为 null。 */
  readonly base_commit: string | null;
  /**
   * 新侧是提交时的固定提交 ID。
   *
   * **V1 恒为 null**，而且这不是遗留字段：本工具只支持三种「一侧是索引或
   * 工作区」的比较，因此新侧永远不是提交。留在这里是为了让「差异的两端
   * 各自是什么」在契约里是完整的 —— 将来若开放提交之间的比较，它是那个
   * 位置，而不是要新加一个字段。
   */
  readonly compare_commit: string | null;
  readonly hunks: readonly GitDiffHunk[];
  /** 旧侧的原始字节摘要；该侧不存在时为 null（空文件不是「不存在」）。 */
  readonly old_sha256: string | null;
  readonly new_sha256: string | null;
  readonly binary: boolean;
  readonly truncated: boolean;
  /**
   * hunk 文本是否被出站层脱敏过（`[REDACTED:规则]` 形式的替换）。
   *
   * 与 `SearchMatch.redacted` 同义、同一种诚实：脱敏发生在出站闸门里
   * （`@lwb/egress`），不是本工具的决定，这里**只是如实转述**。
   * 看到 `true` 时，`hunks[].lines` 不是磁盘原文，依赖它做逐字判断
   * （例如把某一行回填进一次编辑提案）是不成立的。
   */
  readonly redacted: boolean;
  /**
   * 注意：工作区字节差异与 Git 的换行/属性语义可能不同。
   * 本字段说明该差异是按原始字节计算的。
   */
  readonly note: string;
}
