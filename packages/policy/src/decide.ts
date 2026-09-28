/**
 * 策略判定：能力交集（方案 §4.1、§4.3、LWB-011 步骤 1）。
 *
 * 「交集」不是比喻，是这句实现约束：
 *
 *   **每一层检查都必须跑，任何一层不通过就是不允许。**
 *
 * 因此本文件里**没有**短路 `return`。这个选择不是风格问题，是三条具体理由：
 *
 *  1. 短路会把「为什么拒绝」变成「哪一层先拒绝」—— 于是拒绝理由取决于代码里的
 *     语句顺序，而不是取决于安全事实。改一次顺序，同一个请求的拒绝码就变了。
 *  2. 审计需要知道**全部**失败项。只记第一条的话，一个既越权又过期的请求
 *     在审计里看起来和单纯越权一模一样。
 *  3. 短路会掩盖规则失效：如果第一层永远先失败，第二层的判定就永远不执行，
 *     它的 bug 也就永远不暴露。
 *
 * 全部失败都保留在 `failures` 里（本地审计用），呈现给模型的只有 `primary`
 * 一条，按 `POLICY_CHECKS` 的固定优先级挑出。
 *
 * **本文件是纯函数**：不读磁盘、不读时钟（`now` 由调用方传入）、不写状态。
 * 一切输入都是 daemon 从状态库与连接记录里装配出来的**快照**。
 */

import type {
  ApprovalState,
  BridgeErrorCode,
  CapabilityFlags,
  CapabilityName,
  WorkspaceKind,
  WorkspaceMode,
} from '@lwb/contracts';
import { BridgeError, isControlOnlyCapability } from '@lwb/contracts';
import type { FileRule, RuleVerdict } from './rules.ts';
import { ALL_DEFAULT_RULES, classifyFile } from './rules.ts';

// ---------------------------------------------------------------------------
// 检查项与顺序
// ---------------------------------------------------------------------------

/**
 * 四项检查，也是「主因」的优先级顺序（**不是**短路的顺序 —— 四项都会跑）。
 *
 * 为什么 `generation` 排在 `file_rules` 前面：代次变了意味着**我们据以判定
 * 的那份策略快照可能已经过期**。此时报「命中了哪条文件规则」是在拿旧地图指路。
 * 先报代次，模型重新读取之后自然会撞上文件规则那条硬拒绝 —— 信息不丢，
 * 只是顺序更诚实。
 */
export const POLICY_CHECKS = ['connection', 'workspace', 'generation', 'file_rules'] as const;

/** `approval` remains as a legacy type tag for old evidence readers; it is no longer a check. */
export type PolicyCheck = (typeof POLICY_CHECKS)[number] | 'approval';

/** 失败原因的稳定 slug。已发布的 slug 不可改名 —— 测试与审计按它比对。 */
export type PolicyFailureReason =
  // 连接
  | 'CONNECTION_DISABLED'
  | 'CAPABILITY_NOT_GRANTED'
  | 'CONTROL_CAPABILITY_ON_MODEL_SURFACE'
  // 工作区
  | 'WORKSPACE_NOT_GRANTED'
  | 'WORKSPACE_PAUSED'
  | 'WORKSPACE_RECOVERY_REQUIRED'
  | 'WORKSPACE_MODE_READ_ONLY'
  | 'WORKSPACE_KIND_MISMATCH'
  // 代次
  | 'GENERATION_CHANGED'
  | 'POLICY_VERSION_CHANGED'
  | 'TICKET_GENERATION_MISSING'
  // 文件规则
  | 'HARD_DENY_RULE'
  | 'APPROVAL_MISSING'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_REVOKED'
  | 'APPROVAL_CONSUMED'
  | 'APPROVAL_DIGEST_MISMATCH'

export interface PolicyFailure {
  readonly check: PolicyCheck;
  readonly reason: PolicyFailureReason;
  /** 呈现给模型与 IPC 调用方的错误码。 */
  readonly error_code: BridgeErrorCode;
  /** 可以呈现给模型的一句话。**不含**本机绝对路径、不含秘密正文。 */
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

export const POLICY_ACTIONS = [
  'list',
  'stat',
  'read',
  'search',
  'git_status',
  'git_diff',
  'git_log',
  'snapshot_read',
  'error_detail',
  'audit_export',
  'change_prepare',
  'file_create',
  'file_delete',
  'change_revert_prepare',
  'change_apply',
] as const;

export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/**
 * 出站面。凡是**内容会离开本机**的动作都必须落在其中一个面上，
 * 并且共用同一套出站检查（LWB-011 步骤 3）：
 *
 *   读取、搜索片段、Git 差异、历史快照、错误详情、审计导出 —— 前六项是方案点名的；
 *   目录列举与变更回执一并纳入，理由是「统一」比「够用」更难出漏洞：
 *   一份需要逐个论证「这个面不用检查」的清单，迟早会有人论证错。
 */
export const EGRESS_SURFACES = [
  'file_read',
  'search_snippet',
  'git_diff',
  'snapshot_read',
  'error_detail',
  'audit_export',
  'directory_listing',
  'change_receipt',
] as const;

export type EgressSurface = (typeof EGRESS_SURFACES)[number];

interface ActionSpec {
  /** 该动作需要连接凭据里被授予的能力。 */
  readonly capability: CapabilityName;
  readonly surface: EgressSurface;
  /** 属于提议链路：只读模式关闭的是**整条**链路，不只是写入那一步。 */
  readonly in_propose_chain: boolean;
  /** Legacy metadata only; no model action requires a separate local approval. */
  readonly requires_approval: boolean;
  /** 必须绑定一次具体的票据代次。提议与写入都要，纯读取不需要。 */
  readonly requires_ticket: boolean;
}

/**
 * 动作规格表。**穷尽**一个 `PolicyAction` 的所有取值 ——
 * 新增动作时必须在这里给出它的能力与出站面，否则类型检查不过。
 * 这是有意的：不允许出现「没写进表里所以不检查」的动作。
 *
 * ## `change_apply` 为什么要 `propose` 而不是 `apply`
 *
 * `CONTROL_ONLY_CAPABILITIES` 里包含 `apply`，而契约写明
 * 「MCP 适配器凭据不得包含其中任何一项」。因此**模型永远拿不到 `apply`**。
 * 如果 `change_apply` 要求 `apply`，模型调用它就只会得到 `NOT_AUTHORIZED`，
 * 而工具契约（`packages/contracts/src/tools.ts`）与 LWB-028 的验收标准要求的是：
 * 逐工作区的 `propose` 授权本身就是本地操作者授予的写权限。
 *
 * 因此 MCP 侧只检查同一工作区的 `propose` grant。一次性摘要/执行记录由 daemon
 * 内部生成，用于执行器去重与审计，不是第二个用户审批开关。
 */
export const ACTION_SPECS: Readonly<Record<PolicyAction, ActionSpec>> = {
  list: { capability: 'list', surface: 'directory_listing', in_propose_chain: false, requires_approval: false, requires_ticket: false },
  stat: { capability: 'read', surface: 'file_read', in_propose_chain: false, requires_approval: false, requires_ticket: false },
  read: { capability: 'read', surface: 'file_read', in_propose_chain: false, requires_approval: false, requires_ticket: false },
  search: { capability: 'search', surface: 'search_snippet', in_propose_chain: false, requires_approval: false, requires_ticket: false },
  git_status: { capability: 'git_read', surface: 'git_diff', in_propose_chain: false, requires_approval: false, requires_ticket: false },
  git_diff: { capability: 'git_read', surface: 'git_diff', in_propose_chain: false, requires_approval: false, requires_ticket: false },
  git_log: { capability: 'git_read', surface: 'git_diff', in_propose_chain: false, requires_approval: false, requires_ticket: false },
  snapshot_read: { capability: 'read', surface: 'snapshot_read', in_propose_chain: false, requires_approval: false, requires_ticket: false },
  error_detail: { capability: 'read', surface: 'error_detail', in_propose_chain: false, requires_approval: false, requires_ticket: false },
  // 审计导出只给本地控制面：它天然包含跨工作区、跨连接的记录。
  audit_export: { capability: 'control', surface: 'audit_export', in_propose_chain: false, requires_approval: false, requires_ticket: false },
  change_prepare: { capability: 'propose', surface: 'file_read', in_propose_chain: true, requires_approval: false, requires_ticket: true },
  // 创建不需要先读一个不存在的目标；daemon 仍会将当前工作区代次绑定进提案。
  file_create: { capability: 'propose', surface: 'file_read', in_propose_chain: true, requires_approval: false, requires_ticket: false },
  // 删除在本次调用内读取并快照基线，不要求额外的 file_read 票据。
  file_delete: { capability: 'propose', surface: 'file_read', in_propose_chain: true, requires_approval: false, requires_ticket: false },
  change_revert_prepare: { capability: 'propose', surface: 'snapshot_read', in_propose_chain: true, requires_approval: false, requires_ticket: true },
  change_apply: { capability: 'propose', surface: 'change_receipt', in_propose_chain: true, requires_approval: false, requires_ticket: true },
};

// ---------------------------------------------------------------------------
// 请求快照
// ---------------------------------------------------------------------------

/**
 * 连接面。`audience` 决定「控制面专属能力」是否被允许出现在凭据里。
 */
export type ConnectionAudience = 'mcp_adapter' | 'local_console' | 'daemon_internal';

export interface ConnectionView {
  readonly connection_id: string;
  /** 本地操作者是否启用了这条连接。停用即全线拒绝。 */
  readonly enabled: boolean;
  /**
   * 这条连接凭据被授予的能力，来自 daemon 的连接记录。
   *
   * **这里没有第二个写入点**：`PolicyRequest` 里没有任何字段能让调用方
   * 追加一项能力。模型参数里的 `approved` / `user_id` / `principal_id` 等等
   * 在本文件里连字段都不存在 —— 不是「检查了它们不可信」，是**无从传入**。
   */
  readonly granted_capabilities: readonly CapabilityName[];
  readonly audience: ConnectionAudience;
  /** 本连接被授权访问的工作区 id 列表。空数组表示尚未授权任何工作区。 */
  readonly granted_workspace_ids: readonly string[];
}

export interface WorkspaceView {
  readonly workspace_id: string;
  readonly kind: WorkspaceKind;
  readonly mode: WorkspaceMode;
  readonly capabilities: CapabilityFlags;
  /** 权威当前代次，由 daemon 从状态库读出，不是请求里带来的。 */
  readonly current_generation: number;
  readonly current_policy_version: number;
  readonly root_volume_id: string;
  readonly root_file_id: string;
  /** 操作者暂停该工作区。暂停阻断新读取与新应用。 */
  readonly paused: boolean;
}

/**
 * 调用方凭据/票据里携带的版本信息。
 *
 * 读取可以在没有票据的情况下发生（第一次读），此时为 null；
 * **写入不行** —— 写入必须绑定一次具体的代次与策略版本，缺失即拒绝。
 */
export interface PresentedTicket {
  readonly generation: number | null;
  readonly policy_version: number | null;
}

/** Legacy approval-ticket shape; ignored by the four-item policy decision. */
export interface ApprovalView {
  readonly state: ApprovalState;
  readonly change_digest: string;
  readonly presented_digest: string;
  readonly expires_at: number;
}

export interface ActionView {
  readonly action: PolicyAction;
  /**
   * 工作区**相对**路径；`''` 表示工作区根或「无具体文件」。
   *
   * 注意类型：这里是相对路径，`PolicyRequest` 里根本没有绝对根路径这种字段。
   * 「模型不能扩大资源根」在本层是**类型层面**成立的：没有可扩大的入口。
   * 绝对路径由护栏按工作区根解析，本层拿不到、也构造不出工作区外的对象。
   */
  readonly path: string;
  /** Legacy snapshot field. Workspace grants, not this view, authorize model writes. */
  readonly approval?: ApprovalView | null;
}

export interface PolicyRequest {
  readonly connection: ConnectionView;
  readonly workspace: WorkspaceView;
  readonly presented: PresentedTicket;
  readonly action: ActionView;
  /** 本地时钟（epoch ms）。由 daemon 传入，便于测试；不来自请求参数。 */
  readonly now: number;
  /**
   * 本次判定使用的规则表。省略时用默认规则（无操作者豁免）。
   *
   * 省略的后果是**更严**（豁免不生效，被豁免的文件仍被拒），不是更松 ——
   * 默认值的安全方向必须是这个方向。
   */
  readonly rules?: readonly FileRule[];
}

// ---------------------------------------------------------------------------
// 判定结果
// ---------------------------------------------------------------------------

/**
 * 出站义务。
 *
 * 策略是纯的、看不到内容；秘密筛查必须看到字节才能做。因此策略只**声明义务**，
 * 由 `@lwb/egress` 在真正出站的那一刻执行 —— 判断发生在拥有判断所需信息的层。
 *
 * ## 这里**只有一项**，而少了什么同样是设计
 *
 * 容易顺手写成开关、但**刻意没有**写进来的三件事：
 *
 *  - `screen_secrets`（要不要做秘密筛查）
 *  - `no_editable_ticket_when_redacted`（脱敏后要不要禁掉可编辑票据）
 *  - `metered`（要不要计入出站预算）
 *
 * 它们不是可选项，因此不放进义务集合 —— **可选项会被关掉**。一个
 * 「本次不筛查秘密」的合法取值，迟早会出现在某条为了性能或为了"别老是拦住我"
 * 的代码路径上，而它一旦出现，验收标准 1 就只是一句注释了。
 * 这三条被硬编码在 `@lwb/egress` 里，没有开关。
 *
 * 留下的这一项是真的会变，而且变的方向只能是**更严或等价**：
 * 阻断与脱敏都不泄露被命中的内容，区别只在「其余部分还能不能看」。
 */
export interface EgressObligations {
  /** 命中**高置信度**（certain）秘密时的处置：整块阻断，或就地脱敏后放行。 */
  readonly secret_mode: 'block' | 'redact';
}

export interface PolicyDecision {
  readonly allow: boolean;
  /** 呈现给调用方的唯一主因；`allow === true` 时为 null。 */
  readonly primary: PolicyFailure | null;
  /** 全部失败项，按 `POLICY_CHECKS` 顺序。本地审计用，**不**整体返回给模型。 */
  readonly failures: readonly PolicyFailure[];
  /** 四项检查各自的结论。顺序与 `POLICY_CHECKS` 一致。 */
  readonly checks: readonly { readonly check: PolicyCheck; readonly passed: boolean }[];
  readonly obligations: EgressObligations;
  /** 文件规则的判定结果。`search_exclude` 只是性能排除，不构成拒绝。 */
  readonly rule_verdict: RuleVerdict;
  /**
   * 本次判定所用的规则表。
   *
   * 由判定结果**携带**，再由出站凭证接手，这样「判定时用的规则」与
   * 「出站时重判用的规则」不可能不是同一份 —— 否则一次操作里会出现两个
   * 不同版本的策略，而中间那个差异就是旁路。
   */
  readonly rules: readonly FileRule[];
  /** 决策上下文，写审计用。 */
  readonly context: {
    readonly action: PolicyAction;
    readonly workspace_id: string;
    readonly relative_path: string;
    readonly generation: number | null;
    readonly policy_version: number | null;
    readonly surface: EgressSurface;
  };
}

// ---------------------------------------------------------------------------
// 各层检查
// ---------------------------------------------------------------------------

function connectionFailures(req: PolicyRequest): PolicyFailure[] {
  const out: PolicyFailure[] = [];
  const capability = ACTION_SPECS[req.action.action].capability;

  if (!req.connection.enabled) {
    out.push({
      check: 'connection',
      reason: 'CONNECTION_DISABLED',
      error_code: 'CONNECTION_DISABLED',
      detail: '该连接已被本地操作者停用；停用状态下不提供任何读取或写入。',
    });
  }

  if (!req.connection.granted_capabilities.includes(capability)) {
    out.push({
      check: 'connection',
      reason: 'CAPABILITY_NOT_GRANTED',
      error_code: 'NOT_AUTHORIZED',
      detail: `该连接凭据未被授予 ${capability} 能力。`,
    });
  }

  // 控制面专属能力一律不得出现在模型可达的凭据里。这里查的是**凭据本身**
  // 而不是本次动作需要什么：一份带 control 的模型侧凭据，本身就是配置错误，
  // 哪怕这次只读一个文件也不该被放行。
  if (req.connection.audience === 'mcp_adapter') {
    const leaked = req.connection.granted_capabilities.filter((c) => isControlOnlyCapability(c));
    if (leaked.length > 0) {
      out.push({
        check: 'connection',
        reason: 'CONTROL_CAPABILITY_ON_MODEL_SURFACE',
        error_code: 'NOT_AUTHORIZED',
        detail: `模型侧连接的凭据包含控制面专属能力（${leaked.join('、')}）；该凭据配置本身无效。`,
      });
    }
  }

  return out;
}

function workspaceFailures(req: PolicyRequest): PolicyFailure[] {
  const out: PolicyFailure[] = [];
  const spec = ACTION_SPECS[req.action.action];
  const ws = req.workspace;

  if (!req.connection.granted_workspace_ids.includes(ws.workspace_id)) {
    out.push({
      check: 'workspace',
      reason: 'WORKSPACE_NOT_GRANTED',
      error_code: 'WORKSPACE_NOT_GRANTED',
      detail: '当前连接未获准访问该工作区。',
    });
  }

  if (ws.paused) {
    out.push({
      check: 'workspace',
      reason: 'WORKSPACE_PAUSED',
      error_code: 'PAUSED',
      detail: '该工作区已被本地操作者暂停，已阻断新读取与新应用。',
    });
  }

  if (ws.capabilities.recovery_required) {
    out.push({
      check: 'workspace',
      reason: 'WORKSPACE_RECOVERY_REQUIRED',
      error_code: 'RECOVERY_REQUIRED',
      detail: '该工作区处于待人工恢复状态；禁止再次应用，须先由本地操作者查询与恢复。',
    });
  }

  if (spec.in_propose_chain && ws.mode !== 'read_propose_apply_with_local_approval') {
    out.push({
      check: 'workspace',
      reason: 'WORKSPACE_MODE_READ_ONLY',
      error_code: 'POLICY_DENIED',
      detail: '该工作区为只读模式；可以读取，但不能生成修改集或应用。',
    });
  }

  // 单文件工作区只有根这一个对象，因此相对路径必须是空串。
  // 非空相对路径意味着要走到根的**外面**去 —— 那不是这个工作区的范围。
  if (ws.kind === 'file' && req.action.path !== '') {
    out.push({
      check: 'workspace',
      reason: 'WORKSPACE_KIND_MISMATCH',
      error_code: 'POLICY_DENIED',
      detail: '该工作区以单个文件为根，只接受空相对路径（即根本身）。',
    });
  }

  return out;
}

function generationFailures(req: PolicyRequest): PolicyFailure[] {
  const out: PolicyFailure[] = [];
  const spec = ACTION_SPECS[req.action.action];
  const { generation, policy_version } = req.presented;

  if (generation === null && spec.requires_ticket) {
    out.push({
      check: 'generation',
      reason: 'TICKET_GENERATION_MISSING',
      error_code: 'WORKSPACE_GENERATION_CHANGED',
      detail: '写入类操作必须绑定一次具体的读取票据（含工作区代次）；本次请求没有携带。',
    });
  } else if (generation !== null && generation !== req.workspace.current_generation) {
    out.push({
      check: 'generation',
      reason: 'GENERATION_CHANGED',
      error_code: 'WORKSPACE_GENERATION_CHANGED',
      detail: '工作区代次已变化，旧的票据、游标、修改集与批准均已失效。',
    });
  }

  if (policy_version !== null && policy_version !== req.workspace.current_policy_version) {
    out.push({
      check: 'generation',
      reason: 'POLICY_VERSION_CHANGED',
      error_code: 'WORKSPACE_GENERATION_CHANGED',
      detail: '该工作区的策略版本已变化，需重新读取后再操作。',
    });
  }

  return out;
}

function fileRuleFailures(req: PolicyRequest, verdict: RuleVerdict): PolicyFailure[] {
  if (verdict.kind !== 'hard_deny') return [];
  return [
    {
      check: 'file_rules',
      reason: 'HARD_DENY_RULE',
      error_code: 'POLICY_DENIED',
      detail:
        `该路径命中硬拒绝规则 ${verdict.rule_id}，不能读取、搜索、导出，也不能经 Git 差异或快照旁路取得。` +
        `理由：${verdict.rationale}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/**
 * 判定一次操作。
 *
 * 纯函数：同样的输入永远给同样的输出，不碰磁盘、不读时钟、不留状态。
 */
export function decide(req: PolicyRequest): PolicyDecision {
  const spec = ACTION_SPECS[req.action.action];
  const rules = req.rules ?? ALL_DEFAULT_RULES;
  const rule_verdict = classifyFile(req.action.path, rules);

  // 四项检查全跑，不短路。顺序只影响「谁是主因」。
  const byCheck: Readonly<Record<PolicyCheck, PolicyFailure[]>> = {
    connection: connectionFailures(req),
    workspace: workspaceFailures(req),
    generation: generationFailures(req),
    file_rules: fileRuleFailures(req, rule_verdict),
    approval: [],
  };

  const failures: PolicyFailure[] = [];
  const checks: { check: PolicyCheck; passed: boolean }[] = [];
  let primary: PolicyFailure | null = null;
  for (const check of POLICY_CHECKS) {
    const list = byCheck[check];
    checks.push({ check, passed: list.length === 0 });
    failures.push(...list);
    // 主因取**第一个非空层的第一条**：顺序固定，与失败项数量无关。
    if (primary === null && list.length > 0) primary = list[0] ?? null;
  }

  // 秘密筛查对所有出站面一律执行，不按面区分「这个面不用查」——
  // 那正是旁路诞生的地方。
  //
  // 处置方式按面分两档，理由是这两档都不泄露内容，区别只在「其余部分还能不能看」：
  //  - 读取 / 列举：脱敏后放行。用户要的是这份文件，把私钥那一行盖掉之后
  //    剩下的部分仍然有用；整份拒掉只会逼人去关掉这个策略。
  //  - 搜索片段 / Git 差异 / 快照 / 错误 / 审计导出：整块阻断。这些面送出去的
  //    本来就是**片段**，一段被脱敏的片段也仍然暴露了它周围的形状与上下文，
  //    而调用方对这些面的期待本来就是"要么完整要么没有"。
  //
  // 注意摘要是**方向安全**的：脱敏结果拿不到可编辑票据（硬编码在出站层）。
  const obligations: EgressObligations = {
    secret_mode: spec.surface === 'file_read' || spec.surface === 'directory_listing' ? 'redact' : 'block',
  };

  const decision: PolicyDecision = {
    allow: primary === null,
    primary,
    failures,
    checks,
    obligations,
    rule_verdict,
    rules,
    context: {
      action: req.action.action,
      workspace_id: req.workspace.workspace_id,
      relative_path: req.action.path,
      generation: req.presented.generation,
      policy_version: req.presented.policy_version,
      surface: spec.surface,
    },
  };
  ISSUED_DECISIONS.add(decision);
  return decision;
}

/**
 * 本模块产出过的判定对象的登记表。
 *
 * 出站层只接受**在这里登记过**的判定（`@lwb/egress` 的 `mintClearance`）。
 * 它能挡住的是「手搓一个 `{allow: true, obligations: {...}}` 字面量」——
 * 在本进程内，那是最容易写出来的绕过方式：不需要攻破任何检查，只要绕开
 * `decide()` 直接构造一个看起来合法的结果。
 *
 * **它挡不住什么，必须说清楚：** 它挡不住调用方带着伪造的**输入**去正常调用
 * `decide()`（例如谎报「这条连接已被授予 apply 能力」）。那种信任边界不在本进程
 * 内部，而在 IPC 凭据与连接记录那一层 —— 判定只能是它拿到的快照的函数。
 * 把这一点写在这里，是为了不让读者把一个进程内的自洽检查误当成鉴权。
 */
const ISSUED_DECISIONS = new WeakSet<object>();

export function isIssuedDecision(value: unknown): value is PolicyDecision {
  return typeof value === 'object' && value !== null && ISSUED_DECISIONS.has(value);
}

/** 判定并把不允许的情形抛成 `BridgeError`；允许则返回判定本身。 */
export function requireAllowed(req: PolicyRequest): PolicyDecision {
  const decision = decide(req);
  if (decision.allow) return decision;
  throw new PolicyDeniedError(decision);
}

/**
 * 拒绝被抛成契约里的 `BridgeError`，这样上层不需要为策略单独写一套错误处理，
 * 模型侧拿到的也是与其它拒绝同一种形状（code / category / auto_retry / summary）。
 *
 * `details` 里只放**稳定标识**：规则 id、失败原因 slug、主因所在的检查层。
 * 不放 rationale 正文 —— 它已经进了 `message`，而 details 会被序列化进工具结果。
 */
export class PolicyDeniedError extends BridgeError {
  readonly decision: PolicyDecision;

  constructor(decision: PolicyDecision) {
    const primary = decision.primary;
    super(
      primary?.error_code ?? 'POLICY_DENIED',
      primary?.detail ?? '本地策略拒绝该操作。',
      {
        policy_check: primary?.check ?? 'unknown',
        policy_reason: primary?.reason ?? 'unknown',
        hard_deny_rule: decision.rule_verdict.kind === 'hard_deny' ? decision.rule_verdict.rule_id : null,
        failure_count: decision.failures.length,
      },
    );
    this.name = 'PolicyDeniedError';
    this.decision = decision;
  }
}

export function isPolicyDeniedError(value: unknown): value is PolicyDeniedError {
  return value instanceof PolicyDeniedError;
}
