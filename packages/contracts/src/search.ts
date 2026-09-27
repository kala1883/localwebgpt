/**
 * text_search 契约（方案 §9.2、LWB-015）。
 *
 * V1 只做本地**字面量**检索：不接受任意正则、不接受外部命令。
 * 必须如实报告覆盖范围：不能把未扫描或权限跳过的文件算作「无命中」。
 *
 * ## 这一份里最要紧的一句话
 *
 * `scope.complete` **不是**「搜索成功了」的意思，而是「限定范围内的候选文件
 * 全部被检索过」的意思。两者在用户那里的差别是决定性的：
 *
 *  - `complete: true` + 没有命中 → 「这个工作区里没有这段文本」；
 *  - `complete: false` + 没有命中 → 「在我看到的那些文件里没有，**但还有我没看的**」。
 *
 * 方案 §9.2 与 `text_search` 的工具描述都写死了这条：搜索未覆盖全部候选文件时，
 * 绝不能把「没有命中」表述为「不存在」。
 */

import type { Consistency } from './envelope.ts';
import type { Cursor } from './ids.ts';

export interface TextSearchInput {
  readonly workspace_id: string;
  /** 字面量查询串（不是正则）。 */
  readonly query: string;
  /** 限定目录；省略表示工作区根。 */
  readonly path?: string;
  /** 受限 glob，例如 `**\/*.ts`。不支持任意正则。 */
  readonly path_glob?: string;
  readonly case_sensitive?: boolean;
  readonly cursor?: string;
  /** 匹配数上限，受 MAX_SEARCH_MATCHES 约束。 */
  readonly max_matches?: number;
}

export interface SearchMatch {
  readonly path: string;
  /** 1 起始行号。 */
  readonly line_number: number;
  /** 命中行片段，已按字节上限截断并转义为单行。 */
  readonly snippet: string;
  /** 该行是否被截断（超长行）。 */
  readonly line_truncated: boolean;
  /** 命中在行内的起始列（0 起始，按 UTF-16 码元计）。 */
  readonly column: number;
  /**
   * 片段起点在**行内**的列（0 起始，按 UTF-16 码元计）。
   *
   * 与 `column` 在同一个坐标系里（都相对**整行**，不是相对片段），因此
   * 「命中在片段里的第几个字符」= `column - snippet_offset`。
   *
   * 存在的理由是超长行：片段有字节上限（`MAX_SNIPPET_BYTES`），而一行可以
   * 长得多（`MAX_LINE_BYTES`）。若片段一律从行首开始，一个出现在第 7000 字节
   * 处的命中就**不在片段里**，而调用方看到的是一个不含命中词的片段 ——
   * 它会以为命中在别处。因此片段从命中附近开窗，而 `snippet_offset` 说明
   * 这个窗口是从行内哪里开始的。
   *
   * `snippet_offset > 0` 或片段长度小于整行，都表示**片段不是整行**。
   */
  readonly snippet_offset: number;
  /**
   * 该片段是否被出站层脱敏过（`[REDACTED:规则]` 形式的替换）。
   *
   * 脱敏发生在出站闸门里（`@lwb/egress`），不是搜索层的决定。搜索层在这里
   * **只是如实转述**：看到 `true` 时，片段里的文本不是磁盘原文，
   * 依赖片段做逐字判断（例如把片段回填进一次编辑提案）是不成立的。
   */
  readonly redacted: boolean;
}

export interface TextSearchData {
  readonly query: string;
  readonly matches: readonly SearchMatch[];
  readonly next_cursor: Cursor | null;
  readonly truncated: boolean;
  readonly consistency: Consistency;
  readonly scope: {
    /**
     * 实际扫描的文件数 —— **判据是「它的字节被读进来了」**，不是「它有命中」。
     *
     * 二进制与无法解码的文件也在其中：它们的字节确实读了（因此也计入
     * `scanned_bytes`），只是读完之后发现里面没有可检索的 UTF-8 文本。
     * 把它们算成「跳过」会让 `scanned_bytes` 与 `scanned_files` 互相矛盾 ——
     * 一份账里，读了字节的文件必须出现在两个数字中。
     */
    readonly scanned_files: number;
    /**
     * 看到但**一个字节都没读**的文件数，四种去向：
     *
     *  1. 命中搜索排除规则（`node_modules` 之类）；
     *  2. 是重解析点 —— **不跟随**，跟随会把工作区之外的对象带进结果；
     *  3. 不匹配 `path_glob`；
     *  4. 超出单次可读上限（尺寸预检在打开之前）。
     *
     * 细分写在 `incomplete_reason` 里，而不是各占一个字段。
     */
    readonly skipped_files: number;
    /** 因策略硬拒绝被跳过的文件数；不返回名称。 */
    readonly denied_files: number;
    /**
     * 已扫描但**内容被整文件丢弃**的文件数；不返回名称。
     *
     * 与 `denied_files` 的区别是决定性的：那几个文件**根本没被读**，
     * 而这几个被读了、结果被整份抽走 —— 判据是**文件里出现高置信度凭证**
     * （方案 §4.3「命中高置信度秘密时不向模型返回完整内容」）。
     *
     * 判据是整个文件而不是「被返回的那些片段」：跨行的凭证形状（PEM 私钥块）
     * 在被切成一行的片段里认不出来，逐片筛查会把私钥正文原样送出去。
     * 因此它是 `scanned_files` 的**子集**，不是第三个格子 ——
     * `scanned_files + skipped_files + denied_files` 才是本次遍历看到的文件总数。
     */
    readonly secret_files: number;
    /** 实际扫描的字节数。 */
    readonly scanned_bytes: number;
    /** 扫描是否覆盖了限定范围内的全部候选文件。 */
    readonly complete: boolean;
  };
  /** 是否因超过时间预算而提前结束。 */
  readonly deadline_exceeded: boolean;
  /** 是否因字节预算而提前结束。 */
  readonly byte_budget_exceeded: boolean;
  /** 是否因调用方取消而提前结束。与超时同构：返回已找到的部分结果，不伪装成完整。 */
  readonly cancelled: boolean;
  /**
   * 结果为何不是全貌。`complete === true` 时为 null。
   *
   * 这一项承载的是**原因**，上面四个布尔承载的是**类别**：模型据此决定
   * 是「换个查询」还是「缩小范围」还是「用游标继续」，而用户据此知道
   * 「没找到」这句话到底有多少分量。
   */
  readonly incomplete_reason: string | null;
}

export function emptySearchScope(): TextSearchData['scope'] {
  return {
    scanned_files: 0,
    skipped_files: 0,
    denied_files: 0,
    secret_files: 0,
    scanned_bytes: 0,
    complete: false,
  };
}
