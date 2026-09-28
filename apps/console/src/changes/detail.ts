/**
 * `changes.get` 的响应解析（LWB-036 步骤 1、2）。
 *
 * ## 为什么要一层显式的解析，而不是 `as ChangeDetail`
 *
 * 与 `src/setup/readings.ts` 同一条理由：这份 JSON 来自控制 API，
 * 而它**不是完全可信的输入**。页面可能连着一个**旧版本**的 daemon
 * （升级到一半、两份二进制并存），中间可能还隔着一层壳。一个
 * `as` 断言在这里做的事是：把「字段不存在」变成 `undefined` 流下去，
 * 然后在很远的地方炸成一个 `Cannot read properties of undefined`。
 *
 * 更要紧的是第二件事：**缺字段必须落到 `null`，不能落到一个默认值**。
 * 一份没有 `content_gate` 的响应，与一份 `content_gate.allows_read: true`
 * 的响应，在 `?? { allows_read: true }` 这种写法下会变成同一份东西 ——
 * 而那正是一个「看不到内容」被显示成「可以看」的方向。
 *
 * ## 与 `review.ts` 的 `ContentGate` 是同一格
 *
 * `changes.get` 的 `content_gate` 是**一次判定**，不是一份内容。
 * 它回答的是「服务端愿不愿意给内容」，而 `review.ts` 拿它当
 * `ReviewCoverage` 的输入之一。两处的字段逐字相同（`allows_read` /
 * `reason` / `message`），刻意不换名字：同一个事实有两个名字时，
 * 接线处就会接错一个。
 *
 * ## 这一层不算任何东西
 *
 * 它只把 JSON 变成类型正确的对象，不做判定、不读时钟、不看策略。
 * 「能不能批准」在 `approval.ts`，「看过没有」在 `review.ts`，
 * 「要不要刷新」在 `refresh.ts`。这个文件唯一被允许做的判断是
 * 「这个字段在不在、类型对不对」。
 */

import type {
  ChangeFilePreview,
  ChangeOp,
  ChangeRisk,
  ChangeSetState,
  ChangeSetView,
  FileEncoding,
  NewlineStyle,
} from '@lwb/contracts';
import type { ContentGate, DiffProgress } from './review.ts';

/**
 * 一个文件的**展示状态**：正文 + 已经取回了几页。
 *
 * 它是「界面手上关于这个文件的一切」，而不是落库事实 —— 落库事实在
 * `ChangeFilePreview` 里，两者刻意分开：一份差异可能还没取回来，
 * 而事实（大小、哈希、增删行数）在修改集建立时就已经有了。
 *
 * ## 为什么默认「完整」而复核覆盖默认「不知道」
 *
 * `unified_truncated` 省略即「这一份是完整的」。这与 `review.ts` 的
 * 默认值方向相反，而两者不矛盾，因为默认值的危险方向取决于**谁在断言**：
 * 覆盖那一格断言的是「操作者看过了」——一件组件**不知道**的事，于是
 * 默认必须是「不知道」；而这一格断言的是「这份文本是完整的」——一件
 * 调用方**知道**的事，组件拿到的就是它。真正要防的是「调用方不知道
 * 而组件替他断言」，那种情况在这里不存在。
 */
export interface FileText {
  readonly before: string | null;
  readonly after: string | null;
  /** 服务端渲染好的统一差异文本；尚未接线时为 `null` 或省略。 */
  readonly unified?: string | null;
  /** 这份统一差异**是不是被截断的一页**（服务端 `ChangeDiffPage.truncated`）。 */
  readonly unified_truncated?: boolean;
  /** 已经取回几页差异。省略时按「有差异就是 1 页」算。 */
  readonly pages?: number;
}

/**
 * 逐文件展示状态 → 复核进度。
 *
 * ## 为什么它必须是一个函数，而不是两个视图各写一遍
 *
 * `ChangesView`（LWB-023 的待批准页）与 `ChangeDetailView`（LWB-036 的
 * 复核页）都要问「看全了没有」，而两份拷贝的失效方式是单向的：将来有人
 * 给其中一处加一页来源而忘了另一处，两处的严格程度就分叉了，而分叉方向
 * 取决于谁先被改 —— 不是一种保证。这与 `review.ts` 把
 * 「页数」与「读到末尾」收在一处是同一条理由。
 *
 * ## 三个来源是怎么读出来的
 *
 *  - `pages`：调用方说了就用它；没说时「有一份差异」记作 1 页、
 *    「没有差异」记作 0 页。它只用来区分「一页都没取过」与
 *    「取过但没读完」。
 *  - `reached_end`：服务端**没有**说 `truncated`。注意「没说过」
 *    与「说了 false」在这里是同一个意思 —— 见 `FileText` 的默认值那一段。
 *  - `full_texts`：两侧正文都在。那是「原文 / 新文」对照这条展示路径。
 */
export function progressFromTexts(
  texts: Readonly<Record<string, FileText>>,
): readonly DiffProgress[] {
  return Object.entries(texts).map(([path, text]) => ({
    path,
    pages: text.pages ?? (text.unified === null || text.unified === undefined ? 0 : 1),
    reached_end: text.unified_truncated !== true,
    full_texts: text.before !== null && text.after !== null,
  }));
}

/**
 * 工作区那一格。
 *
 * **没有 `canonical_root`** —— 服务端刻意不给（复核界面不需要本机绝对路径，
 * 而响应会经过日志与诊断包）。这里也不加一个「可选的本机路径」字段：
 * 加一个，将来就会有人去填它。
 */
export interface DetailWorkspace {
  readonly workspace_id: string;
  readonly alias: string;
  readonly kind: string;
  readonly mode: string;
  readonly generation: number;
  readonly policy_version: number;
  readonly removed_at: string | null;
  readonly enabled: boolean;
}

/** 一次差异页。与 `@lwb/contracts` 的 `ChangeDiffPage` 同形，独立声明（见文件头）。 */
export interface DetailDiffPage {
  readonly path: string;
  readonly unified: string;
  readonly truncated: boolean;
  readonly next_cursor: string | null;
}

/** 批准摘要。只有状态与有效期 —— 批准人要去 `approvals.list` 问。 */
export interface DetailApproval {
  readonly state: string;
  readonly expires_at: string | null;
}

export interface ChangeDetail {
  readonly change: ChangeSetView;
  readonly workspace: DetailWorkspace | null;
  /** 提议这个修改集的连接 id。**不是**别名：别名要查 `connections` 表。 */
  readonly owner_connection_id: string;
  /** 服务端对「给不给内容」的判定。永远有值：拿不到时按**拒绝**处理。 */
  readonly content_gate: ContentGate;
  /** 本次响应里带的差异页；没要 `path` 时为 `null`。 */
  readonly diff: DetailDiffPage | null;
  readonly approval: DetailApproval | null;
  /** 服务端生成这份响应的时刻（ISO 8601）。 */
  readonly observed_at: string;
}

// ---------------------------------------------------------------------------
// 基础取值
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** 字符串数组；**任何一项不是字符串就整格作废**，而不是把好的挑出来。 */
function strArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item): item is string => typeof item === 'string') ? value : null;
}

// ---------------------------------------------------------------------------
// 修改集视图
// ---------------------------------------------------------------------------

/**
 * `ChangeFilePreview` 的逐字段解析。
 *
 * 缺一个字段就返回 `null`（整条作废）而不是补默认值：这一份视图是
 * **批准的对象**，一个补出来的 `added_lines: 0` 会让屏幕上那一行与
 * 摘要绑定的那份内容对不上 —— 而屏幕上那一行正是操作者据以决定的东西。
 */
/**
 * 三个联合类型各配一张白名单。
 *
 * **用白名单而不是 `as ChangeOp`。** 一个 `as` 断言会把服务端送来的
 * 任意字符串变成「类型正确」的值，于是界面会把一个它不认识的 `op`
 * 渲染出来（`{{ file.op }}` 原样显示那串字符），而下游任何按 `op`
 * 分支的地方都会静默走 `else`。白名单让不认识的值**解析失败**，
 * 失败的方向是「这份修改集显示不出来」—— 响亮、可查、不会让人
 * 误以为自己在看一次普通编辑。
 */
const CHANGE_OPS: readonly ChangeOp[] = ['edit_text', 'create_text', 'replace_text', 'delete_file'];
const FILE_ENCODINGS: readonly FileEncoding[] = ['utf-8', 'utf-8-bom', 'unknown'];
const NEWLINE_STYLES: readonly NewlineStyle[] = ['lf', 'crlf', 'mixed', 'none'];

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function parseFile(value: unknown): ChangeFilePreview | null {
  if (!isRecord(value)) return null;
  const path = str(value['path']);
  const op = oneOf(CHANGE_OPS, value['op']);
  const afterSha = str(value['after_sha256']);
  const encoding = oneOf(FILE_ENCODINGS, value['encoding']);
  const newline = oneOf(NEWLINE_STYLES, value['newline']);
  const bom = bool(value['bom']);
  const added = num(value['added_lines']);
  const removed = num(value['removed_lines']);
  const beforeSize = num(value['before_size']);
  const afterSize = num(value['after_size']);
  if (
    path === null || op === null || afterSha === null || encoding === null ||
    newline === null || bom === null || added === null || removed === null ||
    beforeSize === null || afterSize === null
  ) {
    return null;
  }
  return Object.freeze({
    path,
    op,
    before_sha256: str(value['before_sha256']),
    after_sha256: afterSha,
    before_size: beforeSize,
    after_size: afterSize,
    encoding,
    newline,
    bom,
    added_lines: added,
    removed_lines: removed,
  });
}

/**
 * 风险的逐字段解析。**这一格刻意宽松**：风险条目是附加信息，
 * 一条形状不对的风险不该让整份修改集变得无法复核（那样操作者会
 * 连差异都看不到，而他要做的就是看差异）。
 *
 * 但「宽松」只到「丢掉这一条」为止：`level` 与 `message` 缺一个就丢这条，
 * 不编造一个 `info` 级别的条目 —— 编出来的风险与真实的风险在屏幕上
 * 长得一模一样。
 */
function parseRisk(value: unknown): ChangeRisk | null {
  if (!isRecord(value)) return null;
  const level = str(value['level']);
  const code = str(value['code']);
  const message = str(value['message']);
  if (level === null || code === null || message === null) return null;
  return Object.freeze({ level: level as ChangeRisk['level'], code, message });
}

/**
 * 修改集状态的白名单。**与 `@lwb/contracts` 的 `ChangeSetState` 逐字对应**。
 *
 * 它为什么是一张手抄的表而不是 `Object.values` 之类的推导：联合类型在
 * 运行时不存在，而这里要判的正是运行时拿到的那个字符串。手抄会脱节，
 * 因此 `tests/unit/console-changes.test.ts` 里有一条断言把这份表与
 * 契约的联合**两向**对上（多一个、少一个都失败）。
 */
const CHANGE_STATES: readonly ChangeSetState[] = [
  'PENDING_APPROVAL',
  'REJECTED',
  'EXPIRED',
  'INVALIDATED',
  'APPROVED',
  'QUEUED',
  'VALIDATING',
  'CONFLICT',
  'FAILED_NO_CHANGE',
  'APPLYING',
  'APPLIED',
  'ROLLED_BACK',
  'RECOVERY_REQUIRED',
];

/** 供上面那条两向比对使用（测试与证据脚本按它核对契约）。 */
export const CHANGE_STATE_WHITELIST: readonly string[] = CHANGE_STATES;

function parseChangeSet(value: unknown): ChangeSetView | null {
  if (!isRecord(value)) return null;
  const changeId = str(value['change_id']);
  const workspaceId = str(value['workspace_id']);
  const state = oneOf(CHANGE_STATES, value['state']);
  const digest = str(value['digest']);
  const shortCode = str(value['short_code']);
  const summary = str(value['summary']);
  const createdAt = str(value['created_at']);
  const expiresAt = str(value['expires_at']);
  const files = Array.isArray(value['files']) ? value['files'].map(parseFile) : null;
  if (
    changeId === null || workspaceId === null || state === null || digest === null ||
    shortCode === null || summary === null || createdAt === null || expiresAt === null ||
    files === null || files.some((entry) => entry === null)
  ) {
    return null;
  }
  // `workspace_modified` 在契约里是**字面量 `false`**：「prepare 永远不修改
  // 用户工作区」。因此这里不是「解析一个布尔值」，而是**核对一条不变量**。
  //
  // 服务端若报 `true`，那不是一次普通的字段异常 —— 它说的是「工作区在
  // 建立修改集的过程中被写过」，而整条审批链的前提（批准之前没有字节落地）
  // 就此不成立。对这种响应，正确的动作不是把它渲染出来，是**拒绝显示**：
  // 让操作者看到「读到的内容无法解析」，而不是一份看起来很正常的修改集。
  const workspaceModified = value['workspace_modified'];
  if (workspaceModified === true) return null;

  const risks = Array.isArray(value['risks']) ? value['risks'].map(parseRisk) : [];
  return Object.freeze({
    change_id: changeId,
    workspace_id: workspaceId,
    state,
    approval_required: bool(value['approval_required']) ?? true,
    digest,
    short_code: shortCode,
    summary,
    files: Object.freeze(files as readonly ChangeFilePreview[]),
    risks: Object.freeze(risks.filter((risk): risk is ChangeRisk => risk !== null)),
    created_at: createdAt,
    expires_at: expiresAt,
    workspace_modified: false,
    next_action: str(value['next_action']) ?? '',
  });
}

function parseWorkspace(value: unknown): DetailWorkspace | null {
  if (!isRecord(value)) return null;
  const workspaceId = str(value['workspace_id']);
  const alias = str(value['alias']);
  const kind = str(value['kind']);
  const mode = str(value['mode']);
  const generation = num(value['generation']);
  const policyVersion = num(value['policy_version']);
  const enabled = bool(value['enabled']);
  if (
    workspaceId === null || alias === null || kind === null || mode === null ||
    generation === null || policyVersion === null || enabled === null
  ) {
    return null;
  }
  return Object.freeze({
    workspace_id: workspaceId,
    alias,
    kind,
    mode,
    generation,
    policy_version: policyVersion,
    removed_at: str(value['removed_at']),
    enabled,
  });
}

/**
 * 内容闸门。**解析不出来时按「拒绝」处理**，并且给出一个明确的理由。
 *
 * 这一格是唯一一处「缺字段落到 `true` 之外的地方」。方向是刻意的：
 *  - 落 `allows_read: true` 的后果是界面显示一份**可能不该给**的内容，
 *    而那正是闸门要防的事；
 *  - 落 `false` 的后果是操作者看到「服务端拒绝交出内容（GATE_UNREADABLE）」，
 *    而真实原因（响应形状不对）由那个 slug 说了出来，他会去查服务。
 *
 * 两边的代价不对称：一边是多看一次服务，一边是内容出了不该出的地方。
 */
function parseGate(value: unknown): ContentGate {
  if (!isRecord(value)) {
    return Object.freeze({
      allows_read: false,
      reason: 'GATE_UNREADABLE',
      message: '服务端没有给出内容取舍判定（响应里没有 content_gate）。',
    });
  }
  const allows = bool(value['allows_read']);
  if (allows === null) {
    return Object.freeze({
      allows_read: false,
      reason: 'GATE_UNREADABLE',
      message: '服务端给出的内容取舍判定形状不对（content_gate.allows_read 不是布尔值）。',
    });
  }
  return Object.freeze({ allows_read: allows, reason: str(value['reason']), message: str(value['message']) });
}

function parseDiff(value: unknown): DetailDiffPage | null {
  if (!isRecord(value)) return null;
  const path = str(value['path']);
  const unified = str(value['unified']);
  const truncated = bool(value['truncated']);
  if (path === null || unified === null || truncated === null) return null;
  return Object.freeze({ path, unified, truncated, next_cursor: str(value['next_cursor']) });
}

function parseApproval(value: unknown): DetailApproval | null {
  if (!isRecord(value)) return null;
  const state = str(value['state']);
  if (state === null) return null;
  return Object.freeze({ state, expires_at: str(value['expires_at']) });
}

/**
 * 整份响应 → `ChangeDetail`。
 *
 * 修改集那一格解析失败时返回 `null`（页面显示「读到的内容无法解析」），
 * 而不是显示一份缺了文件清单的修改集：**文件清单是批准的对象**，
 * 一份不完整的清单会让「已复核 N / M」这个分母是假的。
 *
 * 其余各格失败时各自退化成 `null` / 拒绝，不影响整份读取 ——
 * 理由与 `parseRisk` 那条相同：能显示的部分要显示出来。
 */
export function parseChangeDetail(payload: unknown): ChangeDetail | null {
  if (!isRecord(payload)) return null;
  const change = parseChangeSet(payload['change']);
  if (change === null) return null;
  const owner = str(payload['owner_connection_id']);
  return Object.freeze({
    change,
    workspace: parseWorkspace(payload['workspace']),
    // 归属未知时给空串而不是 `null`：这一格**不是**可选的（每一条修改集
    // 都有提议方），而空串在界面上会显示成「未知」—— 那正是缺字段时
    // 应当显示的东西。
    owner_connection_id: owner ?? '',
    content_gate: parseGate(payload['content_gate']),
    diff: parseDiff(payload['diff']),
    approval: parseApproval(payload['approval']),
    observed_at: str(payload['observed_at']) ?? '',
  });
}

// ---------------------------------------------------------------------------
// 分页累积
// ---------------------------------------------------------------------------

/**
 * 把一次差异页**接到**已经取回的内容后面。
 *
 * ## 为什么是「接在后面」而不是「替换」
 *
 * 服务端的 `changeDiffPageOf` 按 `cursor` 返回**一页**，而 `DiffView`
 * 要显示的是「这个文件的差异」。替换会让屏幕上的内容一页一页地被顶掉，
 * 于是操作者读完第二页之后再也看不到第一页 —— 而复核要求的是
 * 「全都看过」，不是「看过最后那一页」。
 *
 * ## 空页是允许的：它表示「这一页就是空的」
 *
 * `unified` 为空串时**不**接一段空行：拼接 `'a\n' + ''` 会多出一个空行，
 * 而屏幕上那个空行会被读成「这里删掉了一行」。
 *
 * ## 去重只做一件确定的事
 *
 * 同一页取回来两次（重试、双击「载入下一页」）时，`cursor` 相同 —— 但
 * 本函数**不收 cursor**，因为它的输入里没有「这是第几页」这个事实：
 * 调用方拿到的只是一段文本。真正防重复取页的地方是 `refresh.ts` 的
 * `SingleFlight`（同键在途请求合并）与调用方自己的页游标。这里只保证
 * 拼接这件事本身是确定的：给定同样的两段文本，得到同样的结果。
 */
export function appendDiffPage(previous: string | null, page: DetailDiffPage): string {
  if (previous === null || previous === '') return page.unified;
  if (page.unified === '') return previous;
  // 服务端的分页按行切，页与页之间不重叠，因此中间只需要一个换行。
  // `previous` 末尾**已经**有换行时不再加一个 —— 那会凭空造出一个空行。
  return previous.endsWith('\n') ? previous + page.unified : `${previous}\n${page.unified}`;
}
