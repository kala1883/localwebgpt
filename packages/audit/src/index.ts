/**
 * `@lwb/audit` —— 工具调用审计（LWB-018）。
 *
 * 本包只做三件事，每一件都不与别的层重叠：
 *
 *  1. **提取**（`ranges.ts`）：从一次工具结果里读出「哪些文件、哪些范围」。
 *     它不判断能不能返回，只描述返回了什么。
 *  2. **筛查**（`screen.ts`）：保证写进审计的补充信息是**事实**而不是内容。
 *  3. **写入与反查**（`record.ts`）：把上面两件事变成审计库里一条可反查的记录。
 *
 * 它与 `@lwb/egress` 的分工值得写下来，因为两者都在「内容出站」附近：
 * `egress` 决定**要不要**让字节出去（路径重判、秘密筛查、预算），
 * 本包在**已经决定要出去之后**记录出去了什么。因此本包不重复做筛查，
 * 也不得被当成一道闸门 —— 它写在闸门下游，作用是留痕而不是拦截。
 *
 * 唯一的例外是 `screen.ts`：它拦的不是出站内容，而是**写进审计的东西**，
 * 因为审计库本身就是一份会被导出、被贴进工单的文件。
 */

export {
  FILE_ACCESS_EXTRACTORS,
  extractFileAccess,
  targetFileAccess,
} from './ranges.ts';
export type { FileAccessExtractor, FileAccessRow } from './ranges.ts';

export { AUDIT_METADATA_KEYS, screenMetadata } from './screen.ts';

export {
  answerToolCall,
  fileRowCount,
  recordToolCall,
} from './record.ts';
export type { AnsweredRange, ToolCallAnswer, ToolCallRecordInput } from './record.ts';
