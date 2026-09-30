/**
 * 本地工作区授权页背后的判定。全局平台验收状态仅作提示；逐工作区 grant
 * 是唯一决定 ChatGPT 可用工具与读写范围的产品权限。
 *
 * ## 表单只提交四个字段
 *
 * `registerRequest()` 的返回类型**就是**控制面 `workspaces.register`
 * 认的四个入参。多一个字段都没有：一个「顺手把整个表单对象发过去」的
 * 实现，会在某天有人给表单加一个 `capabilities` 或 `direct_write`
 * 复选框时，把那个字段一并送到服务端去 —— 而服务端今天恰好会忽略它。
 * 于是那条路会在没有任何人注意的情况下被铺好。
 */

import type { CapabilityFlags } from '@lwb/contracts';
import type {
  Gates,
  WorkspaceAccessRow,
  WorkspaceKind,
  WorkspaceMode,
  WorkspaceRow,
} from './readings.ts';

/** 服务端是否支持目录级直接写入；具体工作区仍须单独授权。 */
export interface WriteGate {
  /** 服务端写入能力是否可用，不代表某个目录已经获授权。 */
  readonly direct_write: boolean;
  /** 关着的原因，逐条对应一个没通过的格。开着时为空数组。 */
  readonly reasons: readonly string[];
  /** 一句给操作者看的话。永远非空。 */
  readonly summary: string;
}

/**
 * 全局验收签署不再阻塞功能；只看 daemon 能力读数。逐目录授权由 grant 单独控制。
 */
export function writeGate(input: {
  /** Legacy diagnostics field; does not affect availability. */
  readonly gates?: Gates | null;
  readonly flags: CapabilityFlags | null;
}): WriteGate {
  const { flags } = input;

  if (flags === null) {
    return {
      direct_write: false,
      reasons: ['本机服务能力状态暂时不可用。'],
      summary: '目录写入：服务状态未知。',
    };
  }

  const reasons = flags.direct_write_enabled ? [] : ['本机服务的目录写入功能当前不可用。'];

  const directWrite = reasons.length === 0;
  return {
    direct_write: directWrite,
    reasons,
    summary: directWrite
      ? '目录写入功能可用；是否授权由每个工作区单独决定。'
      : `目录写入功能不可用（${String(reasons.length)} 项原因）。`,
  };
}

/**
 * 一个可选的工作区模式。
 *
 * `requires_ack` 是需要勾选风险说明的那种模式。**它不是安全控制**，
 * 与 `changes/approval.ts` 里那句「藏起按钮不是安全控制」同一条理由：
 * 服务端不认识这个勾，它只是让操作者在按下「登记」之前读一遍那段话。
 */
export interface ModeOffer {
  readonly mode: WorkspaceMode;
  readonly label: string;
  readonly risk: string;
  readonly requires_ack: boolean;
}

/**
 * 哪些模式需要先勾风险说明。
 *
 * 单独一张表而不是写在 `modeOffers` 的返回值里：`validateRegister`
 * 也要问同一件事，而让它去 `modeOffers(...)` 的返回值里翻一遍，
 * 会在某天有人给那张列表加过滤条件时静默失效（列表变了、校验没变）。
 */
const REQUIRES_ACK: Readonly<Record<WorkspaceMode, boolean>> = {
  read_only: false,
  read_propose_apply_with_local_approval: true,
};

/**
 * 两种模式的说明。
 *
 * 修改模式的风险说明明确告知：授权后会直接写入，不再逐次等待批准。
 */
export function modeOffers(
  write: WriteGate,
  /** Legacy diagnostics argument; does not affect availability. */
  _proposalEnabled?: boolean | null,
): readonly ModeOffer[] {
  return [
    {
      mode: 'read_only',
      label: '只读',
      risk:
        '此模式不会授予修改提议。读取是否实际可用，还取决于该根单独获授的工具、' +
        'ChatGPT 连接启用。读取内容一旦返回就会经隧道发往 ChatGPT —— ' +
        '只读不等于不出本机。',
      requires_ack: REQUIRES_ACK.read_only,
    },
    {
      mode: 'read_propose_apply_with_local_approval',
      label: '读取 + 修改',
      risk:
        '勾选“文件修改”后，ChatGPT 可在此授权目录内直接创建/删除普通文件并应用修改集，不会逐次等待本机批准；编辑已有文件还需同时授予“读取文件内容”。' +
        '普通文件写入仍检查路径、冲突并保留恢复快照。命令执行不随文件修改授权开放，须单独勾选高风险授权。' +
        (write.direct_write ? '' : `（${write.reasons.join('')}）`),
      requires_ack: true,
    },
  ];
}

/** 登记表单的草稿。字段与界面上的输入框一一对应。 */
export interface RegisterDraft {
  readonly alias: string;
  readonly kind: WorkspaceKind;
  readonly mode: WorkspaceMode;
  readonly path: string;
  /** 「我已读过风险说明」的勾。只影响能否提交，不是安全控制。 */
  readonly risk_ack: boolean;
}

export interface RegisterValidation {
  readonly can_submit: boolean;
  /** 尚不能提交的原因；可以提交时为空数组。 */
  readonly problems: readonly string[];
}

/**
 * 提交前的自检。
 *
 * **只做界面自己知道的检查**：两个必填项与那个勾。别名是否重复、
 * 路径能不能被登记、根是不是凭证目录 —— 那些是 daemon 的判定
 * （`@lwb/workspaces` 的根筛查），在这里重写一遍只会让两处漂移：
 * 界面拦下的东西服务端可能允许（用户被挡住且不知道为什么），
 * 或者反过来（用户以为通过了，然后拿到一个错误）。
 *
 * 因此这里的失败只有一种处置：**把话说清楚，让操作者去补**
 * ——而不是替服务端下判断。
 */
export function validateRegister(draft: RegisterDraft): RegisterValidation {
  const problems: string[] = [];
  if (draft.alias.trim().length === 0) problems.push('别名不能为空。');
  if (draft.path.trim().length === 0) {
    problems.push('路径不能为空。请使用系统选择窗口或粘贴完整路径。');
  }
  const offer = modeOffers({
    direct_write: false,
    reasons: [],
    summary: '',
  }).find((item) => item.mode === draft.mode);
  if (offer?.requires_ack === true && !draft.risk_ack) {
    problems.push('这一模式需要先确认风险说明。');
  }
  return { can_submit: problems.length === 0, problems };
}

/**
 * 表单 → 请求体。**恰好四个字段**，见文件头。
 *
 * `workspace_id` 由服务端生成，因此这里没有它；`origin` 由服务端从
 * 通道身份推出来（`control/workspaces.ts` 的 `originOf`），
 * 因此**也不能**由表单提供 —— 一个能自报来源的表单等于没有来源判定。
 */
export function registerRequest(draft: RegisterDraft): {
  readonly alias: string;
  readonly kind: WorkspaceKind;
  readonly mode: WorkspaceMode;
  readonly path: string;
} {
  return {
    alias: draft.alias.trim(),
    kind: draft.kind,
    // 路径原样提交，**不做规范化**：改一个字符就可能指向另一个目录，
    // 而「服务端看到的路径就是你粘贴的路径」是这条链路唯一可核对的保证。
    path: draft.path.trim(),
    mode: draft.mode,
  };
}

/** 「现在有哪些目录正在暴露」的一句话回答（验收标准 1）。 */
export interface ExposureSummary {
  /** 通栏那一句。 */
  readonly headline: string;
  readonly registered: number;
  readonly removed: number;
  /** 有效逐目录 grant 中启用了提议能力的根数；不等同于当前可调用数。 */
  readonly proposal_granted: number;
  /** 连接启用且该根至少获授一种内容工具的根数。 */
  readonly accessible: number;
  readonly lines: readonly string[];
}

/**
 * 暴露摘要。
 *
 * 「登记了几个目录」与「有几个目录正在被暴露」是**两个问题**，
 * 而它们的答案在能力关闭时正好相反：登记了 3 个、暴露 0 个。
 * 一个只报登记数的界面会让非技术用户以为内容已经在外面了；
 * 一个只报 0 的界面会让他以为自己的登记丢了。因此两句都给。
 */
export function exposureSummary(
  rows: readonly WorkspaceRow[],
  _flags: CapabilityFlags | null,
  workspaceAccess: readonly WorkspaceAccessRow[] = [],
  connectionEnabled: boolean | null = null,
): ExposureSummary {
  const live = rows.filter((row) => !row.removed);
  const removed = rows.length - live.length;
  const accessByWorkspace = new Map(workspaceAccess.map((grant) => [grant.workspace_id, grant]));
  const proposalGranted = live.filter((row) => {
    const grant = accessByWorkspace.get(row.workspace_id);
    return row.enabled && row.mode === 'read_propose_apply_with_local_approval' &&
      grant?.enabled === true && grant.capabilities.includes('propose');
  }).length;
  const accessible = live.filter((row) => {
    if (!row.enabled || connectionEnabled !== true) return false;
    const grant = accessByWorkspace.get(row.workspace_id);
    if (grant?.enabled !== true) return false;
    const hasFileReadTool = grant.capabilities.some((capability) =>
      capability === 'read' || capability === 'list' || capability === 'search',
    );
    const canReadFiles = hasFileReadTool;
    const canReadGit = grant.capabilities.includes('git_read');
    const canRunCommands = row.kind === 'directory' &&
      row.mode === 'read_propose_apply_with_local_approval' && grant.capabilities.includes('command_exec');
    const canPrepareChanges = row.mode === 'read_propose_apply_with_local_approval' &&
      grant.capabilities.includes('propose');
    return canReadFiles || canReadGit || canPrepareChanges || canRunCommands;
  }).length;

  const connectionLine = connectionEnabled === true
    ? 'ChatGPT 连接已启用。'
    : connectionEnabled === false
      ? 'ChatGPT 连接已停用。'
      : 'ChatGPT 连接状态无可信读数。';
  const capabilityLine = `目录工具由逐 workspace grant 控制；未授权的工具不会开放。${connectionLine}`;

  const headline =
    live.length === 0
      ? '当前没有任何目录被登记，因此没有任何本机内容暴露给模型。'
      : accessible > 0
        ? `已登记 ${String(live.length)} 个根，其中 ${String(accessible)} 个根当前具备有效的 ChatGPT 内容工具访问条件；只有实际调用时才会有内容出站。`
        : `已登记 ${String(live.length)} 个根，但当前没有根同时满足连接与目录授权；内容工具不可用。`;

  const proposalLine = `${String(proposalGranted)} 个启用根已获文件修改授权；ChatGPT 可在这些根直接创建、编辑或删除普通文件。`;

  return {
    headline,
    registered: live.length,
    removed,
    proposal_granted: proposalGranted,
    accessible,
    lines: [
      capabilityLine,
      proposalLine,
      removed > 0
        ? `另有 ${String(removed)} 个已移除的登记（路径仍在下面列出，但它们不再被使用）。`
        : '没有被移除的登记。',
    ],
  };
}

/** 一行工作区的显示文案。与 `exposureSummary` 同源，不另造一套说法。 */
export function describeWorkspace(row: WorkspaceRow): {
  readonly mode_label: string;
  readonly state_label: string;
} {
  return {
    mode_label:
      row.mode === 'read_only' ? '只读' : '读取 + 修改（逐目录授权）',
    state_label: row.removed ? '已移除' : row.enabled ? '启用' : '已暂停',
  };
}
