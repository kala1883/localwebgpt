/**
 * 工具**输出** schema（LWB-017 步骤 3）。
 *
 * ## 为什么输入有 schema 还不够
 *
 * `tools.ts` 里的 `inputSchema` 只约束「模型能说什么」。而验收标准里的
 * 「工具结果符合 schema」讲的是另一侧 —— 结果。没有输出 schema 时，
 * 「结果符合契约」这句话**无法被证伪**：任何形状的返回都"符合"，
 * 因为没有任何东西声称它应该长什么样。
 *
 * 于是这里把 `docs` 里那些 TypeScript 接口逐字段写成 zod schema，
 * 适配器把它转成 JSON Schema 挂到 MCP 的 `outputSchema` 上，
 * 客户端（Inspector / ChatGPT）据此校验 `structuredContent`。
 *
 * ## 两个方向都会漂移，因此两个方向都要钉
 *
 * 手写的镜像 schema 会以两种方式与契约脱节：
 *
 *  - **少一个字段** —— 结果是它被 `strictObject` 拒绝，而拒绝发生在
 *    真机上、在一次已经完成的读取之后；
 *  - **多一个字段** —— 更糟：schema 比契约宽，于是"符合 schema"这件事
 *    被静默放宽，而放宽的方向恰好是**多出内容**那一侧。
 *
 * 两者都不是靠自觉能避免的（改接口的人未必知道还有一份镜像），
 * 因此每个 schema 后面都跟一条编译期核对：少字段、多字段、类型不符、
 * 枚举漏成员都会让 `tsc` 直接失败，报错里带上**出错的那个字段名**。
 * 核对的机器在 `wire-shape.ts`（那里写清了为什么「双向可赋值」不够、
 * 以及它自己覆盖不到的边界）。
 *
 * 品牌字符串（`ReadToken` / `Cursor`）由那台机器投影成 `string`：
 * JSON 上没有品牌这种东西，直接比对会让每一处品牌字段都假报不兼容，
 * 而假阳性比漏报更危险 —— 它会让人把这条检查注释掉。
 *
 * 本文件是纯契约：只有 schema 与类型，没有函数、没有状态。
 */

import { z } from 'zod';

import { BRIDGE_ERROR_CODES } from './errors.ts';
import type { BridgeErrorCode, BridgeErrorPayload } from './errors.ts';
import type { Consistency, ErrEnvelope } from './envelope.ts';
import { checkShape } from './wire-shape.ts';
import type { FileListData } from './list.ts';
import type { FileReadData } from './read.ts';
import type { TextSearchData } from './search.ts';
import type { BridgeStatusData, WorkspaceListData, WorkspaceSummary } from './status.ts';
import type { GitDiffData, GitStatusData, GitStatusExclusion, GitStatusEntry } from './git.ts';
import type { CapabilityFlags } from './capabilities.ts';
import type {
  ApprovalState,
  ChangeApplyData,
  ChangeDiffPage,
  ChangeFilePreview,
  ChangeFileState,
  ChangeGetData,
  ChangeListData,
  ChangeListEntry,
  ChangeOp,
  ChangePrepareData,
  ChangeRevertLocalAction,
  ChangeRevertPrepareData,
  ChangeRisk,
  ChangeSetState,
  ChangeSetView,
  OperationFileResult,
  OperationReceipt,
} from './change.ts';
import { CHANGE_STATE_LABELS } from './change.ts';
import type { ToolName } from './tools.ts';
import type { WorkspaceKind, WorkspaceMode } from './version.ts';

// ---------------------------------------------------------------------------
// 公共片段
// ---------------------------------------------------------------------------

/** 相对工作区根的路径，统一 `/` 分隔。绝对路径从不出现在任何结果里。 */
const relativePath = z.string().min(1);
/** 不透明游标。形状不可推断，因此这里只约束"是个非空字符串"。 */
const opaqueCursor = z.string().min(1);
/** SHA-256 十六进制小写。 */
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
/** 40 位十六进制提交 ID。 */
const commitId = z.string().regex(/^[0-9a-f]{40}$/);

const consistencySchema = z.literal('per_file') satisfies z.ZodType<Consistency>;

const capabilityFlagsSchema = z.strictObject({
  read_enabled: z.boolean(),
  git_enabled: z.boolean(),
  proposal_enabled: z.boolean(),
  direct_write_enabled: z.boolean(),
  recovery_required: z.boolean(),
});
checkShape<CapabilityFlags, typeof capabilityFlagsSchema>(true);

const workspaceKindSchema = z.enum(['directory', 'file']) satisfies z.ZodType<WorkspaceKind>;
const workspaceModeSchema = z.enum(['read_only', 'read_propose_apply_with_local_approval']) satisfies z.ZodType<WorkspaceMode>;

/**
 * 成功信封。**`outputSchema` 描述的是成功那一种结果**。
 *
 * 失败结果不走 schema：它以 `isError: true` 返回，`structuredContent` 缺席。
 * 理由是 MCP 对 `outputSchema` 的约定是"声明了就必须符合"，
 * 而把成功与失败塞进同一个 `anyOf` 会让「检查结果」这件事变成
 * 「检查两个分支之一」，客户端很容易只校验成功分支而把失败分支放过。
 */
export function okEnvelopeOf<T extends z.ZodObject<z.ZodRawShape>>(data: T) {
  return z.strictObject({
    ok: z.literal(true),
    data,
    /** 本次调用的本地审计关联 ID。**不是**凭证，也不携带任何授权含义。 */
    request_id: z.string().min(1),
  });
}

/**
 * 失败载荷。`code` 被收窄成**已知错误码**，不是一个自由字符串。
 *
 * 收窄它的理由不是洁癖：这个对象是**模型看到失败时唯一的信息**，
 * 而它同时也是适配器唯一一条不做结构校验就能到达模型的数据。
 * 一个自由字符串的 `code` 意味着任何拼错、任何内部标签都可能成为
 * 「错误码」，而模型会照着它去决定下一步。
 */
const bridgeErrorPayloadSchema = z.strictObject({
  code: z.enum(BRIDGE_ERROR_CODES as [BridgeErrorCode, ...BridgeErrorCode[]]),
  message: z.string(),
  // 这两个枚举是 `errors.ts` 里两个联合类型的镜像。漏一个成员会在这里
  // 编译失败（`checkShape`），而不是在真机上把一个新的 category 值放行。
  category: z.enum(['protocol', 'business']),
  auto_retry: z.enum(['never', 'bounded', 'refetch', 'await_human', 'reduce_scope', 'stop_write']),
  /** 处理器给出的安全补充字段。它**不经过**这里的消毒 —— 见下面的说明。 */
  details: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});
checkShape<BridgeErrorPayload, typeof bridgeErrorPayloadSchema>(true);

export const BRIDGE_ERROR_PAYLOAD = bridgeErrorPayloadSchema;

/**
 * 失败信封。**成功与失败是两个 schema，不是一个 schema 的两个分支。**
 *
 * 适配器用它来**判别**：一个工具结果是「daemon 给出的失败」还是「没有形状的东西」。
 * 判别之前，失败结果只能当作「不符合输出契约」处理 —— 而那会把它折成
 * `INTERNAL_ERROR`，也就是把「策略拒绝」「未授权」全都说成「本地服务有 bug」。
 *
 * `details` 是本文件唯一**不做内容级约束**的字段：它由 daemon 的处理器填写，
 * 消毒责任在那一边（`apps/daemon/src/tools/errors.ts` 的 `toModelPayload`）。
 * 这里能保证的只是「它是个字符串/数字/布尔/null 的扁平表」——
 * 那是本层能证明的上限，把它说成「已消毒」会是假的。
 */
export const ERROR_ENVELOPE = z.strictObject({
  ok: z.literal(false),
  error: bridgeErrorPayloadSchema,
  request_id: z.string().min(1),
});
checkShape<ErrEnvelope, typeof ERROR_ENVELOPE>(true);

// ---------------------------------------------------------------------------
// bridge_status
// ---------------------------------------------------------------------------

const bridgeStatusDataSchema = z.strictObject({
  connection_alias: z.string(),
  server_version: z.string(),
  protocol_version: z.string(),
  contract_version: z.string(),
  capabilities: capabilityFlagsSchema,
  gates: z.strictObject({
    g0_platform_verified: z.boolean(),
    native_guard_verified: z.boolean(),
  }),
  paused: z.boolean(),
  paused_at: z.string().nullable(),
  pause: z.strictObject({
    stopping_writes: z.number().int().nonnegative(),
    unrevoked_change_sets: z.number().int().nonnegative(),
    recovery_operations: z.number().int().nonnegative(),
  }),
  limitations: z.array(z.string()),
});
checkShape<BridgeStatusData, typeof bridgeStatusDataSchema>(true);

export const BRIDGE_STATUS_OUTPUT = okEnvelopeOf(bridgeStatusDataSchema);

// ---------------------------------------------------------------------------
// workspace_list
// ---------------------------------------------------------------------------

const workspaceSummarySchema = z.strictObject({
  workspace_id: z.string(),
  display_name: z.string(),
  kind: workspaceKindSchema,
  mode: workspaceModeSchema,
  enabled: z.boolean(),
  capabilities: capabilityFlagsSchema,
  generation: z.number().int().nonnegative(),
  single_file_path: z.string().nullable(),
});
checkShape<WorkspaceSummary, typeof workspaceSummarySchema>(true);

const workspaceListDataSchema = z.strictObject({
  workspaces: z.array(workspaceSummarySchema),
  truncated: z.boolean(),
});
checkShape<WorkspaceListData, typeof workspaceListDataSchema>(true);

export const WORKSPACE_LIST_OUTPUT = okEnvelopeOf(workspaceListDataSchema);

// ---------------------------------------------------------------------------
// file_list
// ---------------------------------------------------------------------------

const directoryEntrySchema = z.strictObject({
  path: relativePath,
  name: z.string(),
  type: z.enum(['file', 'directory']),
  /** 仅文件有意义；目录为 null。 */
  size: z.number().int().nonnegative().nullable(),
  /** 搜索排除规则（性能排除，不是安全拒绝）。 */
  excluded: z.boolean(),
});

const fileListDataSchema = z.strictObject({
  path: z.string(),
  entries: z.array(directoryEntrySchema),
  next_cursor: opaqueCursor.nullable(),
  truncated: z.boolean(),
  consistency: consistencySchema,
  scanned_entries: z.number().int().nonnegative(),
  denied_entries: z.number().int().nonnegative(),
  excluded_entries: z.number().int().nonnegative(),
  incomplete: z.boolean(),
  incomplete_reason: z.string().nullable(),
});
checkShape<FileListData, typeof fileListDataSchema>(true);

export const FILE_LIST_OUTPUT = okEnvelopeOf(fileListDataSchema);

// ---------------------------------------------------------------------------
// file_read
// ---------------------------------------------------------------------------

const fileReadDataSchema = z.strictObject({
  path: relativePath,
  /** 结果一律来自磁盘上**已保存**的字节。 */
  source: z.literal('disk'),
  /** **整个文件**原始字节的哈希，不是返回片段的哈希。 */
  sha256: sha256Hex,
  encoding: z.enum(['utf-8', 'utf-8-bom', 'unknown']),
  bom: z.boolean(),
  newline: z.enum(['lf', 'crlf', 'mixed', 'none']),
  start_line: z.number().int().min(1),
  end_line_exclusive: z.number().int().min(1),
  total_lines: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  truncated_lines: z.array(z.number().int().min(1)),
  consistency: consistencySchema,
  read_token: z.string().min(1),
  next_cursor: opaqueCursor.nullable(),
  content: z.string(),
  bytes_returned: z.number().int().nonnegative(),
  redacted: z.boolean(),
  editable: z.boolean(),
  editable_blockers: z.array(z.string()),
});
checkShape<FileReadData, typeof fileReadDataSchema>(true);

export const FILE_READ_OUTPUT = okEnvelopeOf(fileReadDataSchema);

// ---------------------------------------------------------------------------
// text_search
// ---------------------------------------------------------------------------

const searchScopeSchema = z.strictObject({
  scanned_files: z.number().int().nonnegative(),
  skipped_files: z.number().int().nonnegative(),
  denied_files: z.number().int().nonnegative(),
  secret_files: z.number().int().nonnegative(),
  scanned_bytes: z.number().int().nonnegative(),
  complete: z.boolean(),
});

const searchMatchSchema = z.strictObject({
  path: relativePath,
  line_number: z.number().int().min(1),
  snippet: z.string(),
  line_truncated: z.boolean(),
  column: z.number().int().nonnegative(),
  snippet_offset: z.number().int().nonnegative(),
  redacted: z.boolean(),
});

const textSearchDataSchema = z.strictObject({
  query: z.string(),
  matches: z.array(searchMatchSchema),
  next_cursor: opaqueCursor.nullable(),
  truncated: z.boolean(),
  consistency: consistencySchema,
  scope: searchScopeSchema,
  deadline_exceeded: z.boolean(),
  byte_budget_exceeded: z.boolean(),
  cancelled: z.boolean(),
  incomplete_reason: z.string().nullable(),
});
checkShape<TextSearchData, typeof textSearchDataSchema>(true);

export const TEXT_SEARCH_OUTPUT = okEnvelopeOf(textSearchDataSchema);

// ---------------------------------------------------------------------------
// git_status
// ---------------------------------------------------------------------------

/**
 * 六个取值，**没有 `ignored`**，这是实测结论不是遗漏。
 * 理由写在 `git.ts` 的同名类型上，此处不重复。
 */
const gitFileStatusSchema = z.enum(['unmodified', 'added', 'modified', 'deleted', 'untracked', 'absent']);

const gitStatusEntrySchema = z.strictObject({
  path: relativePath,
  head: gitFileStatusSchema,
  worktree: gitFileStatusSchema,
});
checkShape<GitStatusEntry, typeof gitStatusEntrySchema>(true);

const gitStatusExclusionSchema = z.strictObject({
  path: relativePath,
  reason: z.enum(['FILE_TOO_LARGE', 'IDENTITY_UNAVAILABLE', 'LINK_UNSUPPORTED']),
  /** 一句话说明。不含文件内容。 */
  detail: z.string(),
});
checkShape<GitStatusExclusion, typeof gitStatusExclusionSchema>(true);

const gitStatusDataSchema = z.strictObject({
  branch: z.string().nullable(),
  head_commit: commitId.nullable(),
  entries: z.array(gitStatusEntrySchema),
  truncated: z.boolean(),
  excluded: z.array(gitStatusExclusionSchema),
  excluded_truncated: z.boolean(),
  policy_hidden_count: z.number().int().nonnegative(),
  /** 恒为 true：结果只覆盖已授权范围。 */
  limited_to_authorized_paths: z.literal(true),
  layout_warning: z.string().nullable(),
});
checkShape<GitStatusData, typeof gitStatusDataSchema>(true);

export const GIT_STATUS_OUTPUT = okEnvelopeOf(gitStatusDataSchema);

// ---------------------------------------------------------------------------
// git_diff
// ---------------------------------------------------------------------------

const gitDiffHunkSchema = z.strictObject({
  old_start: z.number().int().nonnegative(),
  old_lines: z.number().int().nonnegative(),
  new_start: z.number().int().nonnegative(),
  new_lines: z.number().int().nonnegative(),
  lines: z.array(z.string()),
});

const gitDiffDataSchema = z.strictObject({
  path: relativePath,
  comparison: z.enum(['head_vs_worktree', 'index_vs_worktree', 'head_vs_index']),
  base_commit: commitId.nullable(),
  /** V1 恒为 null（新侧永远是索引或工作区，不是提交）。 */
  compare_commit: commitId.nullable(),
  hunks: z.array(gitDiffHunkSchema),
  /** 该侧不存在时为 null —— 空文件的哈希不是 null。 */
  old_sha256: sha256Hex.nullable(),
  new_sha256: sha256Hex.nullable(),
  binary: z.boolean(),
  truncated: z.boolean(),
  redacted: z.boolean(),
  note: z.string(),
});
checkShape<GitDiffData, typeof gitDiffDataSchema>(true);

export const GIT_DIFF_OUTPUT = okEnvelopeOf(gitDiffDataSchema);

// ---------------------------------------------------------------------------
// change_prepare / change_get / change_list
// ---------------------------------------------------------------------------

/**
 * 修改集状态枚举。成员**从 `CHANGE_STATE_LABELS` 的键取**，不在这里另抄一份。
 *
 * `CHANGE_STATE_LABELS` 的类型是 `Readonly<Record<ChangeSetState, string>>`：
 * 它的键集合**就是**那个联合 —— 联合里加一个状态而忘了加标签是编译错误，
 * 反过来多一个标签也是。于是「schema 的成员集合」与「契约的状态集合」
 * 不可能分开，而这里写下 13 个状态名就等于手工维护第二次。
 *
 * （下面还有 `checkShape` 兜一层。两道检查不是冗余：这一道保证**来源**一致，
 * 那一道保证**投影**一致 —— 换掉来源的那天，只有后者还站着。）
 */
const CHANGE_STATE_NAMES = Object.keys(CHANGE_STATE_LABELS) as [ChangeSetState, ...ChangeSetState[]];

const changeSetStateSchema = z.enum(CHANGE_STATE_NAMES);
checkShape<ChangeSetState, typeof changeSetStateSchema>(true);

const changeOpSchema = z.enum(['edit_text', 'create_text', 'replace_text']) satisfies z.ZodType<ChangeOp>;
checkShape<ChangeOp, typeof changeOpSchema>(true);

/**
 * 逐文件的实际结果状态。**`UNKNOWN` 必须在这里**：它是「第三种内容或
 * 身份不明，需人工处理」，把它并进 `FAILED` 会让一次不确定的写入
 * 在回执里读起来像一次确定的失败。
 */
const changeFileStateSchema = z.enum([
  'PENDING',
  'VERIFIED',
  'CONFLICT',
  'FAILED',
  'RECOVERED_TARGET',
  'RECOVERED_ORIGINAL',
  'UNKNOWN',
]);
checkShape<ChangeFileState, typeof changeFileStateSchema>(true);

const approvalStateSchema = z.enum(['ACTIVE', 'CONSUMED', 'REVOKED', 'EXPIRED']) satisfies z.ZodType<ApprovalState>;
checkShape<ApprovalState, typeof approvalStateSchema>(true);

/** 修改前/后的整文件哈希。`create_text` 的「修改前」是 `null`，不是空串。 */
const nullableSha256 = sha256Hex.nullable();

const changeFilePreviewSchema = z.strictObject({
  path: relativePath,
  op: changeOpSchema,
  before_sha256: nullableSha256,
  after_sha256: sha256Hex,
  before_size: z.number().int().nonnegative(),
  after_size: z.number().int().nonnegative(),
  encoding: z.enum(['utf-8', 'utf-8-bom', 'unknown']),
  newline: z.enum(['lf', 'crlf', 'mixed', 'none']),
  bom: z.boolean(),
  added_lines: z.number().int().nonnegative(),
  removed_lines: z.number().int().nonnegative(),
});
checkShape<ChangeFilePreview, typeof changeFilePreviewSchema>(true);

const changeRiskSchema = z.strictObject({
  level: z.enum(['info', 'notice', 'warning']),
  code: z.string(),
  message: z.string(),
});
checkShape<ChangeRisk, typeof changeRiskSchema>(true);

/**
 * 修改集视图。**它是 `change_prepare` 与 `change_get` 共用的形状**，
 * 因为两处回的是同一件东西的两个时刻 —— 分别写两份 schema 的话，
 * 「prepare 说有的字段 get 不说有」这件事就没人会发现。
 */
const changeSetViewSchema = z.strictObject({
  change_id: z.string().min(1),
  workspace_id: z.string().min(1),
  state: changeSetStateSchema,
  approval_required: z.boolean(),
  /** 规范化摘要。批准与它**精确绑定**；呈现给操作者的短码是它的派生。 */
  digest: sha256Hex,
  short_code: z.string().min(1),
  /** 模型撰写的不受信文案，只用于展示。 */
  summary: z.string(),
  files: z.array(changeFilePreviewSchema),
  risks: z.array(changeRiskSchema),
  created_at: z.string().min(1),
  expires_at: z.string().min(1),
  /**
   * 恒为 `false` 的字面量，不是 `z.boolean()`。
   *
   * 这一处刻意不跟着契约接口的类型走：`ChangeSetView.workspace_modified`
   * 的类型就是字面量 `false`，于是这条约束在**两个方向**上都不依赖运行期
   * 断言 —— prepare 不可能报出 `true`，schema 也不可能接受 `true`。
   */
  workspace_modified: z.literal(false),
  next_action: z.string(),
});
checkShape<ChangeSetView, typeof changeSetViewSchema>(true);

/**
 * 修改集视图 + 「这次是新建还是读回来的」。
 *
 * 具名而不是内联：`change_prepare` 与 `change_revert_prepare` 回的是
 * **同一个形状**（撤销就是一次提案），共用一份 schema 才能让
 * 「两个工具对同一件事说两种话」在结构上不成立。
 */
const changePrepareDataSchema = z.strictObject({
  ...changeSetViewSchema.shape,
  /** 相同幂等键重复提交时为 true（返回既有修改集，未新建）。 */
  idempotent_replay: z.boolean(),
});
checkShape<ChangePrepareData, typeof changePrepareDataSchema>(true);

export const CHANGE_PREPARE_OUTPUT = okEnvelopeOf(changePrepareDataSchema);

// ---- change_get -----------------------------------------------------------

const operationFileResultSchema = z.strictObject({
  path: relativePath,
  state: changeFileStateSchema,
  before_sha256: nullableSha256,
  after_sha256: nullableSha256,
  error_code: z.string().nullable(),
});
checkShape<OperationFileResult, typeof operationFileResultSchema>(true);

const operationReceiptSchema = z.strictObject({
  operation_id: z.string().min(1),
  change_id: z.string().min(1),
  state: changeSetStateSchema,
  recovered: z.boolean(),
  files: z.array(operationFileResultSchema),
  /**
   * V1 不运行项目测试，因此这里**也**是字面量 `false`。
   *
   * 与 `workspace_modified` 同一条理由，而且这一条更要紧：验收标准里
   * 「不得用落盘冒充测试通过」唯一的落点就是这个字段。写成 `z.boolean()`
   * 会让「回执说 tests_run 为 true」在 schema 上合法 —— 而模型看到
   * `tests_run: true` 之后会直接告诉用户「已经通过测试」。
   */
  tests_run: z.literal(false),
  message: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});
checkShape<OperationReceipt, typeof operationReceiptSchema>(true);

const changeDiffPageSchema = z.strictObject({
  path: relativePath,
  unified: z.string(),
  truncated: z.boolean(),
  next_cursor: z.string().nullable(),
});
checkShape<ChangeDiffPage, typeof changeDiffPageSchema>(true);

const changeGetDataSchema = z.strictObject({
  change: changeSetViewSchema,
  /** 尚无操作时为 `null`；**不是**一个「状态未知」的占位对象。 */
  operation: operationReceiptSchema.nullable(),
  approval: z
    .strictObject({
      state: approvalStateSchema,
      /** 无有效期为 null（`EXPIRED` / `REVOKED` 之后没有「什么时候到期」）。 */
      expires_at: z.string().nullable(),
    })
    .nullable(),
  diff: changeDiffPageSchema.nullable(),
});
checkShape<ChangeGetData, typeof changeGetDataSchema>(true);

export const CHANGE_GET_OUTPUT = okEnvelopeOf(changeGetDataSchema);

// ---- change_list ----------------------------------------------------------

/**
 * 清单条目。**刻意不含路径**。
 *
 * 列出「本连接创建过哪些修改集」与列出「它们动了哪些文件」是两件事：
 * 后者是文件级事实，前者只是本连接的账。这个形状让 `change_list` 的
 * 出站内容是**摘要与计数**，不含任何工作区内的路径 —— 而路径一旦出现在
 * 这里，`change_get` 那道逐路径的判定就多了一条绕过的路。
 */
const changeListEntrySchema = z.strictObject({
  change_id: z.string().min(1),
  workspace_id: z.string().min(1),
  state: changeSetStateSchema,
  digest: sha256Hex,
  short_code: z.string().min(1),
  summary: z.string(),
  created_at: z.string().min(1),
  file_count: z.number().int().nonnegative(),
});
checkShape<ChangeListEntry, typeof changeListEntrySchema>(true);

const changeListDataSchema = z.strictObject({
  changes: z.array(changeListEntrySchema),
  next_cursor: opaqueCursor.nullable(),
  truncated: z.boolean(),
});
checkShape<ChangeListData, typeof changeListDataSchema>(true);

export const CHANGE_LIST_OUTPUT = okEnvelopeOf(changeListDataSchema);

// ---- change_apply ---------------------------------------------------------

/**
 * 应用的回执。
 *
 * `files` 与 `operationReceiptSchema` 用的是**同一份** `operationFileResultSchema`
 * —— 而且不只是 schema 相同：两个工具的运行时数据由 `@lwb/changes` 的
 * `operationReceiptFor` 一处产生。两处各写一份 schema 已经够糟了；
 * 两处各**算**一份回执则会让同一个操作在两个工具里给出不同的逐文件哈希。
 *
 * 与 `OperationReceipt` 的差别只有两处，都是刻意的：
 *
 *  - 没有 `started_at` / `finished_at`：应用是「刚刚发生的那件事」，
 *    调用方要的是结果，不是时刻表（要时刻表请用 `change_get`）；
 *  - 多一个 `in_progress`：见 `ChangeApplyData` 的说明。
 */
const changeApplyDataSchema = z.strictObject({
  change_id: z.string().min(1),
  operation_id: z.string().min(1),
  state: changeSetStateSchema,
  in_progress: z.boolean(),
  recovered: z.boolean(),
  files: z.array(operationFileResultSchema),
  /** 与 `OperationReceipt.tests_run` 同一条理由：落盘**不是**测试通过。 */
  tests_run: z.literal(false),
  message: z.string(),
});
checkShape<ChangeApplyData, typeof changeApplyDataSchema>(true);

export const CHANGE_APPLY_OUTPUT = okEnvelopeOf(changeApplyDataSchema);

// ---- change_revert_prepare ------------------------------------------------

/**
 * 撤销提议的结果。
 *
 * `change` 为 `null` 是**一个合法的成功结果**，不是一个错误：当源修改集
 * 里的条目全是新建文件时，本版本没有能力执行「删除」，于是没有任何可自动
 * 撤销的条目 —— 但那件事本身需要告诉操作者，因此它带着
 * `local_action_required: true` 成功返回，而不是抛一个错。
 *
 * 把它做成错误会让模型去重试（错误暗示「换个方式再来一次」），
 * 而这里正确的下一步是「告诉用户需要本机人工删除某个文件」。
 */
const changeRevertLocalActionSchema = z.strictObject({
  action: z.literal('DELETE_CREATED_FILE'),
  path: relativePath,
  created_sha256: nullableSha256,
  observed_sha256: nullableSha256,
  matches_creation: z.boolean(),
  instruction: z.string(),
});
checkShape<ChangeRevertLocalAction, typeof changeRevertLocalActionSchema>(true);

const changeRevertPrepareDataSchema = z.strictObject({
  change: changePrepareDataSchema.nullable(),
  local_action_required: z.boolean(),
  local_action_reason: z.string().nullable(),
  /**
   * 逐条本机动作。**必须是有结构的那一份**，理由见
   * `ChangeRevertPrepareData.local_action_reason` 的说明：审计的文件访问表
   * 从结构化字段里取路径，从散文里取不出来。
   */
  local_actions: z.array(changeRevertLocalActionSchema),
});
checkShape<ChangeRevertPrepareData, typeof changeRevertPrepareDataSchema>(true);

export const CHANGE_REVERT_PREPARE_OUTPUT = okEnvelopeOf(changeRevertPrepareDataSchema);

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/**
 * **已实现**的工具名。`TOOL_NAMES`（`tools.ts`）是全部 12 个工具的
 * **名字**来源，这一张是**已有实现与输出契约**的那一部分。
 *
 * 单列一张而不是用 `Partial<Record<ToolName, …>>`，是为了让「实现了一个工具
 * 但忘了给它输出 schema」与「给一个没实现的工具写了输出 schema」都成为
 * **编译错误**：下面那张表的类型是 `Record<已实现的名字, …>`，
 * 两个方向都少一个多一个都不行。
 *
 * 提议链路的三个工具（`change_prepare` / `change_get` / `change_list`）
 * 在 LWB-025 进来，写入那两个（`change_apply` / `change_revert_prepare`）
 * 在 LWB-032 进来 —— 到此 `TOOL_NAMES` 的 12 个工具**全部**有了实现与输出
 * 契约。
 *
 * ## 「全都在表里」不等于「模型能用」
 *
 * 名字在这里只说明「本机有代码能回答它」。真正的可用性由工具清单
 * （`apps/daemon/src/tools/catalog.ts`）按能力开关逐条裁定，而生产装配下
 * 四个开关全关 ⇒ 清单里仍然只有那三条只读状态库的工具。
 * `change_apply` 因此**挂不出来**，即使它已经有了实现 ——
 * 这正是 §5.1「不可用的能力不得在工具描述里被暗示为可用」的落点。
 */
export const IMPLEMENTED_TOOL_NAMES = [
  'bridge_status',
  'workspace_list',
  'file_list',
  'text_search',
  'file_read',
  'git_status',
  'git_diff',
  'change_prepare',
  'change_get',
  'change_list',
  'change_apply',
  'change_revert_prepare',
] as const;

export type ImplementedToolName = (typeof IMPLEMENTED_TOOL_NAMES)[number];

export function isImplementedToolName(value: ToolName): value is ImplementedToolName {
  return (IMPLEMENTED_TOOL_NAMES as readonly string[]).includes(value);
}

/** 工具 → 输出 schema。见 `IMPLEMENTED_TOOL_NAMES`。 */
export const TOOL_OUTPUT_SCHEMAS: Readonly<Record<ImplementedToolName, z.ZodObject<z.ZodRawShape>>> = {
  bridge_status: BRIDGE_STATUS_OUTPUT,
  workspace_list: WORKSPACE_LIST_OUTPUT,
  file_list: FILE_LIST_OUTPUT,
  text_search: TEXT_SEARCH_OUTPUT,
  file_read: FILE_READ_OUTPUT,
  git_status: GIT_STATUS_OUTPUT,
  git_diff: GIT_DIFF_OUTPUT,
  change_prepare: CHANGE_PREPARE_OUTPUT,
  change_get: CHANGE_GET_OUTPUT,
  change_list: CHANGE_LIST_OUTPUT,
  change_apply: CHANGE_APPLY_OUTPUT,
  change_revert_prepare: CHANGE_REVERT_PREPARE_OUTPUT,
};

export function outputSchemaOf(name: ToolName): z.ZodObject<z.ZodRawShape> | undefined {
  return isImplementedToolName(name) ? TOOL_OUTPUT_SCHEMAS[name] : undefined;
}
