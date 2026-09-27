/**
 * file_read 契约（方案 §6.2、LWB-013）。
 *
 * 读取只返回**磁盘上已保存的字节**。编辑器未保存缓冲区不在 V1 数据源内，
 * 结果里必须通过 `source` 字段如实说明。
 */

import type { Consistency } from './envelope.ts';
import type { Cursor, ReadToken } from './ids.ts';
import type { FileEncoding, NewlineStyle } from './version.ts';

export interface FileReadInput {
  readonly workspace_id: string;
  readonly path: string;
  /** 1 起始的起始行。省略时从第 1 行开始。 */
  readonly start_line?: number;
  /** 最多返回行数，受 MAX_READ_LINES 与字节上限共同约束。 */
  readonly max_lines?: number;
  /** 上一页返回的不透明游标；提供时忽略 start_line。 */
  readonly cursor?: string;
}

export interface FileReadData {
  readonly path: string;
  readonly source: 'disk';
  /** 整个文件原始字节的 SHA-256，不是返回片段的哈希。 */
  readonly sha256: string;
  readonly encoding: FileEncoding;
  readonly bom: boolean;
  readonly newline: NewlineStyle;
  readonly start_line: number;
  readonly end_line_exclusive: number;
  /** 文件总行数。为 null 表示未计算（例如超大文件）。 */
  readonly total_lines: number | null;
  /**
   * 返回的正文**不等于**整个文件的正文。
   *
   * 三种情形都会置为 true，且它们都是事实而不是警告：
   *  - 本次从第 `start_line` 行开始（前面还有行没返回）；
   *  - 本次到第 `end_line_exclusive` 行为止（后面还有行没返回）；
   *  - 某一行超过 `MAX_LINE_BYTES` 被按上限截断（见 `truncated_lines`）。
   *
   * 因此 `truncated === false` 是「`content` 就是整个文件的正文」的**唯一**凭据，
   * 任何调用方都不能从「看起来读完了」推断它。
   */
  readonly truncated: boolean;
  /**
   * 返回正文中被按 `MAX_LINE_BYTES` 截断的行号（1 起始，升序去重）。
   *
   * 空数组表示 `content` **逐字**来自磁盘（除 BOM 已按 `bom` 字段说明剥离）。
   * 非空表示 `content` 在这些行上不是磁盘上的原文，因此该结果**不得**用于编辑 ——
   * 这条由 `editable === false` 与读取票据里的同名标记同时保证，不只是文案。
   */
  readonly truncated_lines: readonly number[];
  readonly consistency: Consistency;
  /**
   * 服务端签发的读取票据。
   * 绑定：调用主体、工作区代次、规范路径、文件身份、全文件哈希、
   * 实际返回行范围、有效期。
   * 它证明「基于哪个版本读取了哪些行」，**不授予任何写入或批准权限**。
   */
  readonly read_token: ReadToken;
  readonly next_cursor: Cursor | null;
  readonly content: string;
  readonly bytes_returned: number;
  /** 是否因敏感内容策略被脱敏。脱敏结果不得获得可编辑票据。 */
  readonly redacted: boolean;
  /**
   * 该文件是否可被编辑（未被脱敏、编码可写、大小在限内、工作区允许提议）。
   * 为 false 时 read_token 只能用于展示，不能用于 change_prepare。
   */
  readonly editable: boolean;
  readonly editable_blockers: readonly string[];
}

export interface FileReadMetaInput {
  readonly workspace_id: string;
  readonly path: string;
}

/** 元数据预检结果：模型可以在只读取元数据的情况下判断是否值得读取正文。 */
export interface FileStatData {
  readonly path: string;
  readonly source: 'disk';
  readonly sha256: string;
  readonly size: number;
  readonly encoding: FileEncoding;
  readonly bom: boolean;
  readonly newline: NewlineStyle;
  readonly editable: boolean;
  readonly editable_blockers: readonly string[];
  readonly consistency: Consistency;
}
