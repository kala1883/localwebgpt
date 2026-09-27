/** 历史页的纯 TypeScript 视图模型（LWB-037）。 */

export interface HistoryOperation {
  readonly operation_id: string;
  readonly change_id: string;
  readonly workspace_id: string;
  readonly operation_state: string;
  readonly change_state: string;
  readonly recovered: boolean;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

export interface HistoryAuditEvent {
  readonly id: number;
  readonly subject: string;
  readonly action: string;
  readonly outcome: string;
  readonly error_code: string | null;
  readonly timestamp: string;
}

export interface HistoryData {
  readonly operations: readonly HistoryOperation[];
  readonly audit: readonly HistoryAuditEvent[];
  /** 由服务端数据库读取时生成，不由页面当前时间替代。 */
  readonly observed_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function boolOf(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function parseOperation(value: unknown): HistoryOperation | null {
  if (!isRecord(value)) return null;
  const operationId = stringOf(value['operation_id']);
  const changeId = stringOf(value['change_id']);
  const workspaceId = stringOf(value['workspace_id']);
  const operationState = stringOf(value['operation_state']);
  const changeState = stringOf(value['change_state']);
  const recovered = boolOf(value['recovered']);
  const createdAt = stringOf(value['created_at']);
  if (operationId === null || changeId === null || workspaceId === null || operationState === null || changeState === null || recovered === null || createdAt === null) return null;
  return Object.freeze({
    operation_id: operationId,
    change_id: changeId,
    workspace_id: workspaceId,
    operation_state: operationState,
    change_state: changeState,
    recovered,
    created_at: createdAt,
    started_at: stringOf(value['started_at']),
    finished_at: stringOf(value['finished_at']),
  });
}

function parseAudit(value: unknown): HistoryAuditEvent | null {
  if (!isRecord(value) || typeof value['id'] !== 'number' || !Number.isInteger(value['id'])) return null;
  const subject = stringOf(value['subject']);
  const action = stringOf(value['action']);
  const outcome = stringOf(value['outcome']);
  const timestamp = stringOf(value['timestamp']);
  if (subject === null || action === null || outcome === null || timestamp === null) return null;
  return Object.freeze({
    id: value['id'],
    subject,
    action,
    outcome,
    error_code: stringOf(value['error_code']),
    timestamp,
  });
}

/** 解析 `/api/history/list`，服务端形状不完整时不显示半份历史。 */
export function parseHistoryResponse(payload: unknown): HistoryData | null {
  if (!isRecord(payload) || !Array.isArray(payload['operations']) || !Array.isArray(payload['audit'])) return null;
  const observedAt = stringOf(payload['observed_at']);
  if (observedAt === null) return null;
  const operations = payload['operations'].map(parseOperation);
  const audit = payload['audit'].map(parseAudit);
  if (operations.some((entry) => entry === null) || audit.some((entry) => entry === null)) return null;
  return Object.freeze({
    operations: Object.freeze(operations as HistoryOperation[]),
    audit: Object.freeze(audit as HistoryAuditEvent[]),
    observed_at: observedAt,
  });
}

export function operationIsTerminal(operation: HistoryOperation): boolean {
  return ['APPLIED', 'ROLLED_BACK', 'FAILED', 'INVALIDATED', 'REJECTED', 'EXPIRED'].includes(
    operation.operation_state,
  );
}

export function historyStateLabel(state: string): string {
  const labels: Readonly<Record<string, string>> = {
    QUEUED: '已排队',
    VALIDATING: '校验中',
    APPLYING: '应用中',
    RECOVERY_REQUIRED: '待人工恢复',
    APPLIED: '已应用',
    ROLLED_BACK: '已回滚',
    FAILED: '失败',
    INVALIDATED: '已失效',
    REJECTED: '已拒绝',
    EXPIRED: '已过期',
  };
  return labels[state] ?? state;
}

export function outcomeLabel(outcome: string): string {
  const labels: Readonly<Record<string, string>> = {
    allow: '允许',
    deny: '拒绝',
    error: '错误',
  };
  return labels[outcome] ?? outcome;
}
