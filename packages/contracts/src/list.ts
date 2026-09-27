/**
 * file_list 契约（方案 §6.1、LWB-014）。
 *
 * 遍历本身不是一致快照：`consistency` 必须为 per_file，且必须报告
 * scanned/skipped/truncated。被策略拒绝或被排除的对象不得在错误或列表中
 * 泄露详细信息（不返回其名称）。
 */

import type { Consistency } from './envelope.ts';
import type { Cursor } from './ids.ts';

export type DirectoryEntryType = 'file' | 'directory';

export interface FileListInput {
  readonly workspace_id: string;
  /** 相对目录路径；空字符串表示工作区根。 */
  readonly path?: string;
  readonly cursor?: string;
  /** 返回条目上限，受 MAX_DIRECTORY_ENTRIES 约束。 */
  readonly max_entries?: number;
  /** 递归深度；0 表示只列当前层。受 MAX_LIST_DEPTH 约束。 */
  readonly depth?: number;
}

export interface DirectoryEntry {
  /** 相对工作区根的完整路径，统一 `/` 分隔。 */
  readonly path: string;
  readonly name: string;
  readonly type: DirectoryEntryType;
  /** 仅文件有意义；目录为 null。 */
  readonly size: number | null;
  /** 是否被搜索排除规则跳过（性能排除，不是安全拒绝）。 */
  readonly excluded: boolean;
}

export interface FileListData {
  readonly path: string;
  readonly entries: readonly DirectoryEntry[];
  readonly next_cursor: Cursor | null;
  readonly truncated: boolean;
  readonly consistency: Consistency;
  /** 实际成功枚举的条目数。 */
  readonly scanned_entries: number;
  /** 因策略（硬拒绝）被跳过的条目数；不返回其名称。 */
  readonly denied_entries: number;
  /** 因性能排除规则跳过的条目数。 */
  readonly excluded_entries: number;
  /** 达到深度或页面上限而停止，且未用尽目录内容。 */
  readonly incomplete: boolean;
  readonly incomplete_reason: string | null;
}
