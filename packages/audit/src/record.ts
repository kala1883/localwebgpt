/**
 * 写入与反查一次工具调用的审计记录（LWB-018）。
 *
 * ## `subject` 取谁：这里是连接，不是工作区
 *
 * `packages/workspaces` 写审计时 `subject` 是被操作的那个工作区 ——
 * 那条事件的宾语是工作区。工具调用不同：**被记录的行为主体是调用方**，
 * 而调查者拿到 `audit.list()` 时问的是「哪条连接做了什么」，
 * 撤销的对象也是连接（`connections.enabled`）。工作区仍在
 * `workspace_id` 列里，没有丢。
 *
 * 两处取法不同不是不一致，而是「这条事件在讲谁」本来就不一样。
 *
 * ## `action` 是工具名原样
 *
 * 不做「读类 / 列类」的分类名：分类会随方案演进而变，而
 * 「这条记录来自 `file_read`」是永远成立的事实。`tool` 列与它同值，
 * 保留列是因为它让「按工具筛选」用得上索引。
 */

import type { AuditCallRecord, AuditFileAccessInput, Repositories } from '@lwb/persistence';

import type { FileAccessRow } from './ranges.ts';
import { screenMetadata } from './screen.ts';

export interface ToolCallRecordInput {
  /** 工具名，或非工具操作名（`tools.catalog`）。调用方保证它来自操作注册表。 */
  readonly tool: string;
  /** 本次 IPC 请求的关联 ID，与回给模型的信封里那个是同一个值。 */
  readonly request_id: string;
  readonly connection_id: string;
  readonly workspace_id?: string | null;
  readonly outcome: 'allow' | 'deny' | 'error';
  readonly error_code?: string | null;
  /** 实际出站的内容字节数。取值口径见 `apps/daemon/src/tools/guard.ts`。 */
  readonly bytes_out: number;
  /**
   * 文件访问行。
   *
   * `null` 表示**本次调用没有执行到能提取结果的程度**（被拒绝、被暂停、
   * 并发额度耗尽、入参违约）。它与空数组不是一回事：空数组断言
   * 「执行了，且没有文件被返回」，`null` 断言「没有结果可提取」。
   * 两者都会被忠实写下来，因为把前者写成后者会凭空多出一个事实。
   */
  readonly file_access: readonly FileAccessRow[] | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * 记录一次工具调用。返回审计事件 id。
 *
 * **抛出**是设计的一部分：调用方（`guard.ts`）把它当作「不能返回结果」
 * 的理由 —— 一条送不出去的记录等于一次没有记录的出站。
 */
export function recordToolCall(repos: Repositories, input: ToolCallRecordInput): number {
  // `file_rows` 也**穿过**同一道筛查：它虽然由本文件产生，但白名单之外的
  // 键一律拒绝这条规则如果给自己开后门，就会在下一个人照抄时变成惯例。
  const metadata = screenMetadata({
    // 「有几行没被写下来」本身是一个必须留痕的事实：`not_extracted`
    // 与 `0` 的区别，就是「没执行」与「执行了但没碰文件」的区别。
    file_rows: input.file_access === null ? 'not_extracted' : input.file_access.length,
    ...(input.metadata ?? {}),
  });
  return repos.audit.append({
    subject: input.connection_id,
    action: input.tool,
    outcome: input.outcome,
    connection_id: input.connection_id,
    workspace_id: input.workspace_id ?? null,
    error_code: input.error_code ?? null,
    request_id: input.request_id,
    tool: input.tool,
    bytes_out: input.bytes_out,
    file_access: input.file_access ?? [],
    metadata,
  });
}

// ---------------------------------------------------------------------------
// 反查
// ---------------------------------------------------------------------------

/** 一次调用里被返回的一个文件范围（闭区间）。 */
export interface AnsweredRange {
  readonly path: string;
  /** 仅当该次访问有行区间（`file_read` / `text_search`）；否则为 null。 */
  readonly start_line: number | null;
  readonly end_line: number | null;
}

/**
 * 「这次调用读了/返回了什么」的答案。
 *
 * 两条**分开**的清单，而不是一条带标志位的：
 * 它们回答的是不同的问题（「什么出去了」与「什么被拦住了」），
 * 合成一条会让最常见的那个问题（什么出去了）需要先做一次筛选，
 * 而筛选是做漏的第一步。
 */
export interface ToolCallAnswer {
  readonly request_id: string;
  /** 全部匹配事件，按写入顺序。正常情况长度为 1。 */
  readonly calls: readonly AuditCallRecord[];
  /** 内容/条目确实出站了的文件范围，已去重。 */
  readonly delivered: readonly AnsweredRange[];
  /** 本次调用的目标，但没有内容出站（被拒绝、被拦下、失败）。 */
  readonly attempted: readonly AnsweredRange[];
  /** 是否所有事件都是同一次工具调用（多于一条意味着同 ID 被写过多次）。 */
  readonly duplicate_events: boolean;
}

export function answerToolCall(repos: Repositories, requestId: string): ToolCallAnswer {
  const calls = repos.audit.findByRequestId(requestId);
  const delivered = new Map<string, AnsweredRange>();
  const attempted = new Map<string, AnsweredRange>();
  for (const call of calls) {
    for (const row of call.file_access) {
      const range: AnsweredRange = {
        path: row.path,
        start_line: row.start_line ?? null,
        end_line: row.end_line ?? null,
      };
      const key = `${row.path}\u0000${String(range.start_line)}\u0000${String(range.end_line)}`;
      (row.delivered ? delivered : attempted).set(key, range);
    }
  }
  return {
    request_id: requestId,
    calls,
    delivered: [...delivered.values()],
    attempted: [...attempted.values()],
    duplicate_events: calls.length > 1,
  };
}

/** 一次调用写进审计的文件行数（供证据脚本断言原子写入生效）。 */
export function fileRowCount(repos: Repositories, eventId: number): number {
  return repos.audit.fileAccessForEvent(eventId).length;
}

export type { AuditFileAccessInput };
