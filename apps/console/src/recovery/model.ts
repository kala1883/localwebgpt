/**
 * 恢复页的纯 TypeScript 判定（LWB-037）。
 *
 * 这个模块不读 DOM、不读时钟、也不调用控制面。恢复页只能把服务端已经
 * 落库的事实摆出来，并把操作者的明确意图变成事件；它不能靠改本地页面
 * 状态把 `RECOVERY_REQUIRED` 伪装成已处理。
 */

export const RECOVERY_TERMINAL_STATES = [
  'APPLIED',
  'ROLLED_BACK',
  'FAILED',
  'INVALIDATED',
  'REJECTED',
  'EXPIRED',
] as const;

export type RecoveryTerminalState = (typeof RECOVERY_TERMINAL_STATES)[number];

export type RecoverySession = Readonly<{
  /** 控制台会话仍然存在。 */
  authenticated: boolean;
  /** 会话已过期；过期时不能发出任何本地动作。 */
  expired?: boolean;
}>;

export type RecoveryPlan =
  | Readonly<{
      kind: 'ok';
      action: 'ROLLBACK_TO_BASELINE';
      digest: string;
      targets: readonly string[];
    }>
  | Readonly<{
      kind: 'refused';
      reason: string;
      detail: string;
    }>
  | null;

export interface RecoveryItem {
  readonly item_id: string;
  readonly path: string;
  readonly op: string;
  /** 原版本快照哈希。新建文件没有原版本，因此为 null。 */
  readonly original_sha256: string | null;
  /** 提议版本快照哈希。 */
  readonly proposed_sha256: string | null;
  /** 最近一次受控观测到的当前版本哈希。 */
  readonly current_sha256: string | null;
  /** 当前现场判定或最终回执状态。 */
  readonly current_state: string;
  readonly reason: string | null;
  readonly error_code: string | null;
  readonly updated_at: string | null;
}

export interface RecoveryAuthorization {
  readonly id: string;
  readonly decision: string;
  readonly state: string;
  readonly actor: string;
  readonly digest: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly created_at: string;
}

export interface RecoveryJournalEntry {
  readonly seq: number;
  readonly item_id: string | null;
  readonly stage: string;
  readonly error_code: string | null;
  readonly detail: string | null;
}

export interface RecoveryRecord {
  readonly operation_id: string;
  readonly change_id: string;
  readonly workspace_id: string;
  readonly operation_state: string;
  readonly change_state: string;
  readonly recovered: boolean;
  readonly items: readonly RecoveryItem[];
  readonly authorizations: readonly RecoveryAuthorization[];
  readonly journal: readonly RecoveryJournalEntry[];
  readonly plan: RecoveryPlan;
  /** 当前观测生成的摘要；恢复授权必须绑定它，而不是页面自己重算。 */
  readonly plan_digest: string | null;
  readonly observed_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nullableStringOf(value: unknown): string | null {
  return value === null || value === undefined ? null : stringOf(value);
}

function boolOf(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function parseItem(value: unknown): RecoveryItem | null {
  if (!isRecord(value)) return null;
  const itemId = stringOf(value['item_id']);
  const path = stringOf(value['path']) ?? stringOf(value['canonical_path']);
  const op = stringOf(value['op']);
  const currentState = stringOf(value['current_state']) ?? stringOf(value['state']);
  if (itemId === null || path === null || op === null || currentState === null) return null;
  return Object.freeze({
    item_id: itemId,
    path,
    op,
    original_sha256: nullableStringOf(value['original_sha256'] ?? value['before_sha256']),
    proposed_sha256: nullableStringOf(value['proposed_sha256'] ?? value['after_sha256']),
    current_sha256: nullableStringOf(value['current_sha256']),
    current_state: currentState,
    reason: nullableStringOf(value['reason']),
    error_code: nullableStringOf(value['error_code']),
    updated_at: nullableStringOf(value['updated_at']),
  });
}

function parsePlan(value: unknown): RecoveryPlan {
  if (!isRecord(value)) return null;
  const kind = stringOf(value['kind']);
  if (kind === 'ok') {
    const action = stringOf(value['action']);
    const digest = stringOf(value['digest']);
    const targets = Array.isArray(value['targets'])
      ? value['targets'].filter((entry): entry is string => typeof entry === 'string')
      : [];
    if (action !== 'ROLLBACK_TO_BASELINE' || digest === null) return null;
    return Object.freeze({ kind: 'ok', action, digest, targets: Object.freeze(targets) });
  }
  if (kind === 'refused') {
    const reason = stringOf(value['reason']);
    const detail = stringOf(value['detail']);
    if (reason === null || detail === null) return null;
    return Object.freeze({ kind: 'refused', reason, detail });
  }
  return null;
}

function parseAuthorization(value: unknown): RecoveryAuthorization | null {
  if (!isRecord(value)) return null;
  const id = stringOf(value['id']);
  const decision = stringOf(value['decision']);
  const state = stringOf(value['state']);
  const actor = stringOf(value['actor']);
  const digest = stringOf(value['digest']);
  const expiresAt = stringOf(value['expires_at']);
  const createdAt = stringOf(value['created_at']);
  if (id === null || decision === null || state === null || actor === null || digest === null || expiresAt === null || createdAt === null) return null;
  return Object.freeze({
    id,
    decision,
    state,
    actor,
    digest,
    expires_at: expiresAt,
    consumed_at: nullableStringOf(value['consumed_at']),
    created_at: createdAt,
  });
}

function parseJournal(value: unknown): RecoveryJournalEntry | null {
  if (!isRecord(value) || typeof value['seq'] !== 'number' || !Number.isInteger(value['seq'])) return null;
  const stage = stringOf(value['stage']);
  if (stage === null) return null;
  return Object.freeze({
    seq: value['seq'],
    item_id: nullableStringOf(value['item_id']),
    stage,
    error_code: nullableStringOf(value['error_code']),
    detail: nullableStringOf(value['detail']),
  });
}

/** 解析 `/api/recovery/get` 的响应；形状不完整时 fail-closed 返回 null。 */
export function parseRecoveryResponse(payload: unknown): RecoveryRecord | null {
  if (!isRecord(payload)) return null;
  const raw = isRecord(payload['record']) ? payload['record'] : payload;
  const operationId = stringOf(raw['operation_id']);
  const changeId = stringOf(raw['change_id']);
  const workspaceId = stringOf(raw['workspace_id']);
  const operationState = stringOf(raw['operation_state']);
  const changeState = stringOf(raw['change_state']);
  const recovered = boolOf(raw['recovered']);
  const observedAt = stringOf(payload['observed_at']) ?? stringOf(raw['observed_at']);
  const rawItems = Array.isArray(raw['items']) ? raw['items'] : null;
  const rawAuths = Array.isArray(raw['authorizations']) ? raw['authorizations'] : [];
  const rawJournal = Array.isArray(raw['journal']) ? raw['journal'] : [];
  if (
    operationId === null || changeId === null || workspaceId === null || operationState === null ||
    changeState === null || recovered === null || observedAt === null || rawItems === null
  ) return null;
  const items = rawItems.map(parseItem);
  const authorizations = rawAuths.map(parseAuthorization);
  const journal = rawJournal.map(parseJournal);
  if (items.some((item) => item === null) || authorizations.some((entry) => entry === null) || journal.some((entry) => entry === null)) return null;

  const inspection = isRecord(payload['inspection']) ? payload['inspection'] : null;
  const inspectedItems = inspection && Array.isArray(inspection['items']) ? inspection['items'].map(parseItem) : [];
  const persistedById = new Map((items as RecoveryItem[]).map((item) => [item.item_id, item]));
  const validInspectionItems = inspectedItems.filter((item): item is RecoveryItem => item !== null);
  const mergedItems = validInspectionItems.length > 0
    ? validInspectionItems.map((current) => {
        const persisted = persistedById.get(current.item_id);
        return Object.freeze({
          ...current,
          ...(persisted === undefined ? {} : {
            error_code: persisted.error_code,
            updated_at: persisted.updated_at,
          }),
        });
      })
    : (items as RecoveryItem[]);
  const plan = parsePlan(raw['plan']) ?? (inspection ? parsePlan(inspection['plan']) : null);
  return Object.freeze({
    operation_id: operationId,
    change_id: changeId,
    workspace_id: workspaceId,
    operation_state: operationState,
    change_state: changeState,
    recovered,
    items: Object.freeze(mergedItems),
    authorizations: Object.freeze(authorizations as RecoveryAuthorization[]),
    journal: Object.freeze(journal as RecoveryJournalEntry[]),
    plan,
    plan_digest: stringOf(raw['plan_digest']) ?? (inspection ? stringOf(inspection['plan_digest']) : null),
    observed_at: observedAt,
  });
}

export type RecoveryAction = 'keep-current' | 'export-original' | 'export-proposed' | 're-propose' | 'authorize' | 'repair';

export interface RecoveryControls {
  readonly can_keep_current: boolean;
  readonly can_export: boolean;
  readonly can_repropose: boolean;
  readonly can_authorize: boolean;
  readonly can_repair: boolean;
  readonly active_authorization_id: string | null;
  readonly reason: string;
}

function hasSession(session: RecoverySession | null | undefined): boolean {
  return session?.authenticated === true && session.expired !== true;
}

function isPending(record: RecoveryRecord | null): boolean {
  return record?.operation_state === 'RECOVERY_REQUIRED';
}

function activeAuthorizationOf(record: RecoveryRecord | null): RecoveryAuthorization | null {
  if (record === null) return null;
  return record.authorizations.find((entry) => entry.state === 'ACTIVE') ?? null;
}

/**
 * 计算恢复页的按钮状态。
 *
 * `confirmed` 是页面上的显式复选框，不是服务端授权；真正的授权仍必须
 * 由控制面重新读取现场、重算摘要并落库。这里的 `true` 只意味着操作者
 * 已经看到了本地警告并愿意发出请求。
 */
export function recoveryControlsOf(input: {
  readonly record: RecoveryRecord | null;
  readonly session?: RecoverySession | null;
  readonly confirmed?: boolean;
}): RecoveryControls {
  const session = hasSession(input.session);
  const pending = isPending(input.record);
  const active = activeAuthorizationOf(input.record);
  const plan = input.record?.plan ?? null;
  const canWrite = session && pending && input.confirmed === true && plan?.kind === 'ok';

  if (!session) {
    return Object.freeze({
      can_keep_current: false,
      can_export: false,
      can_repropose: false,
      can_authorize: false,
      can_repair: false,
      active_authorization_id: active?.id ?? null,
      reason: '控制台会话不可用，不能发出本地操作。',
    });
  }
  if (!pending) {
    return Object.freeze({
      can_keep_current: false,
      can_export: false,
      can_repropose: false,
      can_authorize: false,
      can_repair: false,
      active_authorization_id: active?.id ?? null,
      reason: '该操作已经是终态；页面不会用按钮状态伪造恢复完成。',
    });
  }
  if (plan?.kind === 'refused') {
    return Object.freeze({
      can_keep_current: true,
      can_export: true,
      can_repropose: true,
      can_authorize: false,
      can_repair: false,
      active_authorization_id: active?.id ?? null,
      reason: `当前现场不能自动恢复（${plan.reason}）。`,
    });
  }

  return Object.freeze({
    can_keep_current: true,
    can_export: true,
    can_repropose: true,
    can_authorize: canWrite && active === null,
    can_repair: canWrite && active !== null,
    active_authorization_id: active?.id ?? null,
    reason:
      input.confirmed === true
        ? '已确认本地警告；实际恢复仍需服务端重新观测并核对摘要。'
        : '恢复写入前必须由操作者明确确认；不会默认覆盖当前文件。',
  });
}

export function isTerminalRecoveryState(state: string): state is RecoveryTerminalState {
  return (RECOVERY_TERMINAL_STATES as readonly string[]).includes(state);
}

export function recoveryStateLabel(state: string): string {
  const labels: Readonly<Record<string, string>> = {
    RECOVERY_REQUIRED: '待人工恢复',
    APPLIED: '已应用',
    ROLLED_BACK: '已回滚',
    FAILED: '失败',
    INVALIDATED: '已失效',
    REJECTED: '已拒绝',
    EXPIRED: '已过期',
    ORIGINAL: '当前为原版本',
    TARGET_REACHED: '当前为提议版本',
    THIRD_CONTENT: '第三方后续修改',
    IDENTITY_UNKNOWN: '对象身份不明',
    UNKNOWN: '无法判定',
  };
  return labels[state] ?? state;
}

export function versionText(hash: string | null): string {
  return hash === null ? '无（新建文件没有原版本）' : hash;
}
