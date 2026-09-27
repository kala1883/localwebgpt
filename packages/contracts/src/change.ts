/**
 * 修改集契约（方案 §6.3–§6.5、§8、LWB-019～LWB-022）。
 *
 * 核心语义：
 *  - 修改集一经创建**内容不可变**；改任何字节/路径/基线都生成新 change_id，
 *    旧批准不能继承（方案 §6.4）。
 *  - `summary` 是模型撰写的不受信文案，只能作为展示，**不能**作为批准依据。
 *  - 批准绑定唯一摘要、主体、工作区代次、策略版本与有效期。
 *  - 一个修改集最多关联一个 operation，即使更换幂等键（UNIQUE(change_id)）。
 */

import type { FileEncoding, NewlineStyle, WritableNewlineStyle } from './version.ts';

export type ChangeOp = 'edit_text' | 'create_text' | 'replace_text';

export type ChangeSetState =
  | 'PENDING_APPROVAL'
  | 'REJECTED'
  | 'EXPIRED'
  | 'INVALIDATED'
  | 'APPROVED'
  | 'QUEUED'
  | 'VALIDATING'
  | 'CONFLICT'
  | 'FAILED_NO_CHANGE'
  | 'APPLYING'
  | 'APPLIED'
  | 'ROLLED_BACK'
  | 'RECOVERY_REQUIRED';

/** 逐文件的实际结果状态。未知结果必须显式暴露，不能并入成功。 */
export type ChangeFileState =
  | 'PENDING'
  | 'VERIFIED'
  | 'CONFLICT'
  | 'FAILED'
  /** 恢复时核验到目标状态（未再写入）。 */
  | 'RECOVERED_TARGET'
  /** 恢复时核验到原始状态。 */
  | 'RECOVERED_ORIGINAL'
  /** 第三种内容或身份不明，需本地人工处理。 */
  | 'UNKNOWN';

/**
 * 写入操作的状态（LWB-022）。
 *
 * 它是 `ChangeSetState` 的**真子集** —— 操作只存在于修改集已经进入
 * `APPROVED` 之后的那些状态里。单独立一个类型而不是复用全集，是为了让
 * 「这个字段不可能取到 `PENDING_APPROVAL`」成为类型上的事实，
 * 而不是一句注释。`OperationRecord.state` 目前仍标注为 `ChangeSetState`，
 * 因此两侧都能赋值（子集可以赋给超集）。
 */
export type OperationState =
  | 'QUEUED'
  | 'VALIDATING'
  | 'APPLYING'
  | 'APPLIED'
  | 'FAILED_NO_CHANGE'
  | 'ROLLED_BACK'
  | 'CONFLICT'
  | 'RECOVERY_REQUIRED';

/** 与 `FROZEN_OPERATION_STATES`（迁移 v1 的 DDL 输入）必须一致，由测试核对。 */
export const OPERATION_STATES: readonly OperationState[] = [
  'QUEUED',
  'VALIDATING',
  'APPLYING',
  'APPLIED',
  'FAILED_NO_CHANGE',
  'ROLLED_BACK',
  'CONFLICT',
  'RECOVERY_REQUIRED',
];

export type ApprovalState = 'ACTIVE' | 'CONSUMED' | 'REVOKED' | 'EXPIRED';

/** 与 `approvals.state` 的 CHECK 约束必须一致，由测试核对。 */
export const APPROVAL_STATES: readonly ApprovalState[] = [
  'ACTIVE',
  'CONSUMED',
  'REVOKED',
  'EXPIRED',
];

// ---------------------------------------------------------------------------
// 编辑操作
// ---------------------------------------------------------------------------

/**
 * 一个精确行区间补丁。
 *
 * 规则（方案 §6.3）：
 *  - 行号 1 起始，区间左闭右开；
 *  - `old_lines` 必须与基线**精确**匹配，不做 fuzzy match；
 *  - `new_lines` / `old_lines` 的每个元素**不得包含换行符**；
 *  - 同一文件内的编辑区间不得重叠；
 *  - 必须落在读取票据已返回的行范围内；插入要求邻接上下文已读。
 */
export interface LineEdit {
  readonly start_line: number;
  readonly end_line_exclusive: number;
  readonly old_lines: readonly string[];
  readonly new_lines: readonly string[];
}

export interface EditTextItem {
  readonly op: 'edit_text';
  readonly path: string;
  /** 提案所基于的**整个文件**原始字节哈希。 */
  readonly base_sha256: string;
  readonly read_token: string;
  readonly edits: readonly LineEdit[];
}

export interface CreateTextItem {
  readonly op: 'create_text';
  readonly path: string;
  /**
   * 创建不存在的文件。执行时使用 CREATE_NEW；
   * 目标已存在（含大小写别名碰撞）即失败，绝不覆盖。
   */
  readonly content: string;
  /** 要写入的换行风格。只有 `lf` / `crlf` —— 见 `WritableNewlineStyle`。 */
  readonly newline: WritableNewlineStyle;
  readonly bom: boolean;
}

export interface ReplaceTextItem {
  readonly op: 'replace_text';
  readonly path: string;
  readonly base_sha256: string;
  /**
   * 整文件替换。仅允许**已完整返回**的小文件；
   * 截断结果或脱敏结果不得用于整文件替换。
   */
  readonly read_token: string;
  readonly content: string;
}

export type ChangeItem = EditTextItem | CreateTextItem | ReplaceTextItem;

export interface ChangePrepareInput {
  readonly workspace_id: string;
  /** 客户端生成的幂等键；同键不同请求内容返回 IDEMPOTENCY_CONFLICT。 */
  readonly idempotency_key: string;
  /** 模型撰写的不受信摘要，仅用于展示。 */
  readonly summary: string;
  readonly items: readonly ChangeItem[];
}

// ---------------------------------------------------------------------------
// 修改集视图
// ---------------------------------------------------------------------------

export interface ChangeFilePreview {
  readonly path: string;
  readonly op: ChangeOp;
  /** 修改前整个文件原始字节哈希；create_text 为 null。 */
  readonly before_sha256: string | null;
  /** 修改后整个文件原始字节哈希。 */
  readonly after_sha256: string;
  readonly before_size: number;
  readonly after_size: number;
  readonly encoding: FileEncoding;
  readonly newline: NewlineStyle;
  readonly bom: boolean;
  readonly added_lines: number;
  readonly removed_lines: number;
}

export interface ChangeRisk {
  readonly level: 'info' | 'notice' | 'warning';
  readonly code: string;
  readonly message: string;
}

export interface ChangeSetView {
  readonly change_id: string;
  readonly workspace_id: string;
  readonly state: ChangeSetState;
  readonly approval_required: boolean;
  /** 规范化修改集摘要；批准与之精确绑定。 */
  readonly digest: string;
  /** 短核对编号，供人眼比对。不是安全凭证。 */
  readonly short_code: string;
  /** 模型撰写的不受信摘要。 */
  readonly summary: string;
  readonly files: readonly ChangeFilePreview[];
  readonly risks: readonly ChangeRisk[];
  readonly created_at: string;
  readonly expires_at: string;
  /** prepare 永远不修改用户工作区。 */
  readonly workspace_modified: false;
  /** 面向模型/用户的下一步提示。 */
  readonly next_action: string;
}

export interface ChangePrepareData extends ChangeSetView {
  /** 相同幂等键重复提交时为 true（返回既有修改集，未新建）。 */
  readonly idempotent_replay: boolean;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export interface ChangeGetInput {
  readonly change_id?: string;
  readonly operation_id?: string;
  /** 分页读取逐文件差异。 */
  readonly path?: string;
  readonly cursor?: string;
}

export interface ChangeDiffPage {
  readonly path: string;
  readonly unified: string;
  readonly truncated: boolean;
  readonly next_cursor: string | null;
}

export interface OperationReceipt {
  readonly operation_id: string;
  readonly change_id: string;
  readonly state: ChangeSetState;
  readonly recovered: boolean;
  readonly files: readonly OperationFileResult[];
  /** V1 不运行项目测试；永远为 false，不得用落盘冒充测试通过。 */
  readonly tests_run: false;
  readonly message: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

export interface OperationFileResult {
  readonly path: string;
  readonly state: ChangeFileState;
  readonly before_sha256: string | null;
  readonly after_sha256: string | null;
  readonly error_code: string | null;
}

export interface ChangeGetData {
  readonly change: ChangeSetView;
  readonly operation: OperationReceipt | null;
  readonly approval: {
    readonly state: ApprovalState;
    readonly expires_at: string | null;
  } | null;
  readonly diff: ChangeDiffPage | null;
}

export interface ChangeListInput {
  readonly workspace_id?: string;
  readonly cursor?: string;
  readonly max_items?: number;
}

export interface ChangeListEntry {
  readonly change_id: string;
  readonly workspace_id: string;
  readonly state: ChangeSetState;
  readonly digest: string;
  readonly short_code: string;
  readonly summary: string;
  readonly created_at: string;
  readonly file_count: number;
}

export interface ChangeListData {
  readonly changes: readonly ChangeListEntry[];
  readonly next_cursor: string | null;
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// 应用
// ---------------------------------------------------------------------------

export interface ChangeApplyInput {
  readonly change_id: string;
  readonly idempotency_key: string;
}

export interface ChangeApplyData {
  readonly change_id: string;
  /** 唯一操作 ID。同一修改集无论用几个幂等键，都只关联这一个操作。 */
  readonly operation_id: string;
  readonly state: ChangeSetState;
  /**
   * 本次调用返回时，这个操作**还在执行中**（`QUEUED` / `VALIDATING` /
   * `APPLYING`）—— 也就是「这次没能等到结论」。
   *
   * ## 它为什么不是一个叫 `RUNNING` 的状态
   *
   * 状态机里没有 `RUNNING`：执行中有**三个**状态，而它们不是同一件事
   * （排队中 / 校验中 / 写入中）。凭空造一个第四种取值，会让「状态」这个词
   * 在工具结果与 `change_get` 里指两样东西 —— 而两个工具回答同一个问题时
   * 用不同的词，读的人只会以为是两个不同的事实。
   *
   * 因此这里保留真实状态，另给一个**派生**的布尔值回答「写完了没有」。
   * 派生意味着它不可能与 `state` 说反话：它由
   * `isExecutionChangeState(state)` 当场算出，不存、不传、不缓存。
   * 它是 `true` 时**绝不能**说文件已保存，而下一步是 `change_get`，
   * 不是再调一次本工具。
   */
  readonly in_progress: boolean;
  readonly recovered: boolean;
  readonly files: readonly OperationFileResult[];
  readonly tests_run: false;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// 撤销提议
// ---------------------------------------------------------------------------

export interface ChangeRevertPrepareInput {
  readonly change_id: string;
  readonly idempotency_key: string;
}

export interface ChangeRevertPrepareData {
  /**
   * 新的逆向修改集；仍需独立批准，不直接恢复。
   *
   * ## 类型是 `ChangePrepareData` 而不是 `ChangeSetView`
   *
   * 两者的差别只有一个字段：`idempotent_replay`。它是**必须**在这里的 ——
   * 撤销的幂等键由「源修改集 id + 调用方给的键」拼成，因此同一个源用同一个
   * 键再调一次会**返回既有那份撤销集**，而「这是新建的还是读回来的」
   * 是模型必须知道的一件事（前者意味着它刚改变了本机状态，后者没有）。
   *
   * 这个类型修正不是洁癖：`ChangeRevertPrepareData` 一直没有任何实现产生过，
   * 因此 `ChangeSetView` 这个更窄的写法从来没有被运行时核对过。而输出
   * schema 是 `strictObject` —— 它会**拒绝**一个多带字段的对象，于是那处
   * 类型与事实的偏差会在第一次真实调用（LWB-032 接线之后）变成一次
   * 「工具结果不符合输出契约」，而模型看到的是「本地服务有 bug」。
   */
  readonly change: ChangePrepareData | null;
  /** V1 不支持自动删除新增文件；需本地人工处理时给出说明。 */
  readonly local_action_required: boolean;
  /**
   * 一句话总述，**刻意不含路径**（逐条的路径在 `local_actions` 里）。
   *
   * 不含路径不是措辞偏好，是审计要求：一次工具调用里出站的**每一条工作区
   * 路径**都必须能被审计的文件访问表取出来。把路径埋在散文里，那张表就
   * 只能记「这次调用什么也没读」—— 而模型手上明明拿到了文件名。
   * （这条约束是 LWB-032 接线时发现的，见 `docs/PROGRESS.md` 的偏离记录。）
   */
  readonly local_action_reason: string | null;
  /** 需要**本机人工**做的逐条动作。V1 只有一种：删除本插件新建的文件。 */
  readonly local_actions: readonly ChangeRevertLocalAction[];
}

/**
 * 一件本版本做不了、必须由人在本机做的事。
 *
 * `instruction` 是**固定文案**（由引擎生成，不由模型措辞）：它描述的是一条
 * 不可协商的流程。它包含路径与哈希，因此 `path` 另外单列一份结构化字段
 * —— 散文里的路径取不出来，而审计要的是能被取出来的那一种。
 */
export interface ChangeRevertLocalAction {
  readonly action: 'DELETE_CREATED_FILE';
  readonly path: string;
  /** 创建时回读到的哈希。`null` 表示回执里没有观测值。 */
  readonly created_sha256: string | null;
  /** 此刻观测到的哈希。 */
  readonly observed_sha256: string | null;
  /** 此刻内容是否仍等于创建时回读的那一份。**这不是归属证明。** */
  readonly matches_creation: boolean;
  readonly instruction: string;
}

// ---------------------------------------------------------------------------
// 状态机辅助
// ---------------------------------------------------------------------------

/** 不可再回到可执行状态的终态。 */
export const TERMINAL_CHANGE_STATES: readonly ChangeSetState[] = [
  'REJECTED',
  'EXPIRED',
  'INVALIDATED',
  'APPLIED',
  'ROLLED_BACK',
  'FAILED_NO_CHANGE',
  'CONFLICT',
];

export function isTerminalChangeState(state: ChangeSetState): boolean {
  return TERMINAL_CHANGE_STATES.includes(state);
}

export const CHANGE_STATE_LABELS: Readonly<Record<ChangeSetState, string>> = {
  PENDING_APPROVAL: '待批准',
  REJECTED: '已拒绝',
  EXPIRED: '已过期',
  INVALIDATED: '已失效',
  APPROVED: '已批准（尚未写入）',
  QUEUED: '已排队（尚未写入）',
  VALIDATING: '校验中',
  CONFLICT: '冲突',
  FAILED_NO_CHANGE: '失败（未修改）',
  APPLYING: '写入中',
  APPLIED: '已应用',
  ROLLED_BACK: '已回滚',
  RECOVERY_REQUIRED: '需要恢复',
};

/**
 * APPROVED 不表示已写，QUEUED 不表示成功。
 * 只有 APPLIED（且具备核验回执）才可对外宣称「已保存」。
 */
export function isAppliedState(state: ChangeSetState): boolean {
  return state === 'APPLIED';
}
