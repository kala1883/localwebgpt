/**
 * 授权表单背后的判定（LWB-035 步骤 1、验收标准 1 与 2）。
 *
 * ## 验收标准 2「无法越过 G0/G4 开关直接授权直写」在本模块里的样子
 *
 * 这一条**不是**由界面保证的：真正拦人的是 daemon 的工具面
 * （`capabilityFlagsFrom` 那个与运算，见 `apps/daemon/src/gates.ts`）。
 * 界面的职责是**不提供这条路，并且说清为什么不提供**。
 *
 * 但「不提供」如果只是「表单里没写这个选项」，那它靠的是**记得别写**。
 * 因此这里多了一层：控制台把四个门禁格与能力开关**自己也与一遍**
 * （`writeGate`），只有全部为真才认为直写是开着的。
 *
 * 这一层与 daemon 那一层的关系是**单向**的：
 *
 *  - 服务端说开、门禁说关 ⇒ 控制台说**关**（少开一次，安全）。
 *  - 服务端说关、门禁说开 ⇒ 控制台说**关**（同样少开一次）。
 *  - 两边都说开 ⇒ 控制台说开。
 *
 * 也就是说，任何一侧说了假话，结果都只会更保守。这正是我们要的方向：
 * 界面不能成为一条绕过门禁的路，而「两边都与一遍」让它在结构上不可能
 * 成为那条路 —— 除非**四格门禁全部被改成真**，而那是一次留下评审记录的
 * 代码变更（`BRIDGE_GATES` 的注释写明了这一点）。
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

/** 直写（不经批准直接改文件）此刻是否开着，以及为什么。 */
export interface WriteGate {
  /** 只有在四项门禁与能力开关**全部**为真时才是 `true`。 */
  readonly direct_write: boolean;
  /** 关着的原因，逐条对应一个没通过的格。开着时为空数组。 */
  readonly reasons: readonly string[];
  /** 一句给操作者看的话。永远非空。 */
  readonly summary: string;
}

/**
 * 把四个门禁格与能力开关与到一起。
 *
 * `gates` 或 `flags` 为 `null`（读数缺失）时结果是**关**，理由写「读数缺失，
 * 按未通过处理」。理由必须写出来：把「没读到」说成「没通过」是一种不准确，
 * 而把「没读到」说成「通过」是一种危险。
 */
export function writeGate(input: {
  readonly gates: Gates | null;
  readonly flags: CapabilityFlags | null;
}): WriteGate {
  const { gates, flags } = input;

  if (gates === null || flags === null) {
    return {
      direct_write: false,
      reasons: [
        gates === null ? '门禁读数缺失，按未通过处理。' : '能力开关读数缺失，按未打开处理。',
      ],
      summary: '直写：关闭（读数不完整）。',
    };
  }

  const reasons: string[] = [];
  if (!gates.g0_platform_verified) reasons.push('G0（真实网页接入验证）未通过。');
  if (!gates.compatibility_section3_passed) reasons.push('平台兼容性（§3）未全部验证通过。');
  if (!gates.native_guard_verified) reasons.push('原生句柄护栏未通过验证。');
  if (!gates.g4_concurrency_fault_passed) reasons.push('G4（竞争与故障专项测试）未通过。');
  if (reasons.length === 0 && !flags.direct_write_enabled) {
    reasons.push('门禁已全部通过，但服务端的能力开关没有把直写打开。');
  }

  const directWrite = reasons.length === 0;
  return {
    direct_write: directWrite,
    reasons,
    summary: directWrite
      ? '直写：已打开（四项门禁与服务端开关一致）。'
      : `直写：关闭（${String(reasons.length)} 项原因）。`,
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
 * `read_propose_apply_with_local_approval` 的文案里有三句**必须**在的话，
 * 因为它们各自封住一个真实的误解：
 *
 *  1. 「模型只能提出修改集」——它不是「让模型改文件」。
 *  2. 「每一次写入都要你在本机批准」——写盘由本地批准触发。
 *  3. 「直写由门禁控制，当前关闭」——这一条由 `writeGate` 现算，
 *     不在文案里写死（写死的话，门禁通过那天它会开始说谎）。
 */
export function modeOffers(
  write: WriteGate,
  proposalEnabled: boolean | null = null,
): readonly ModeOffer[] {
  return [
    {
      mode: 'read_only',
      label: '只读',
      risk:
        '此模式不会授予修改提议。读取是否实际可用，还取决于该根单独获授的工具、' +
        'ChatGPT 连接启用及全局读取门禁。读取内容一旦返回就会经隧道发往 ChatGPT —— ' +
        '只读不等于不出本机。',
      requires_ack: REQUIRES_ACK.read_only,
    },
    {
      mode: 'read_propose_apply_with_local_approval',
      label: '只读 + 提议（需本地批准）',
      risk:
        '此模式允许你为这个根配置修改提议，但实际可用还需要单独授予 propose 工具，' +
        `并且全局提议能力${proposalEnabled === true ? '当前已打开' : proposalEnabled === false ? '当前关闭' : '没有读数，按关闭处理'}。` +
        '模型自己不能写文件；每次实际应用仍需你在本机核对差异并批准。' +
        '**这仍然不是「直写」**：不经批准直接改文件的能力叫直写，' +
        `由门禁控制，${write.direct_write ? '当前已打开' : '当前关闭'}` +
        `${write.direct_write ? '。' : `（${write.reasons.join('')}）。`}`,
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
    problems.push('路径不能为空。浏览器不能替你选目录，请粘贴完整路径。');
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
  /** 连接、工作区、grant 与相关全局能力门禁均满足的根数。 */
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
  flags: CapabilityFlags | null,
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
    if (!row.enabled || connectionEnabled !== true || flags === null) return false;
    const grant = accessByWorkspace.get(row.workspace_id);
    if (grant?.enabled !== true) return false;
    const hasFileReadTool = grant.capabilities.some((capability) =>
      capability === 'read' || capability === 'list' || capability === 'search',
    );
    const canReadFiles = flags.read_enabled && hasFileReadTool;
    const canReadGit = flags.git_enabled && grant.capabilities.includes('git_read');
    const canPrepareChanges = flags.proposal_enabled && row.mode === 'read_propose_apply_with_local_approval' &&
      grant.capabilities.includes('propose');
    return canReadFiles || canReadGit || canPrepareChanges;
  }).length;

  const readEnabled = flags?.read_enabled === true;
  const connectionLine = connectionEnabled === true
    ? 'ChatGPT 连接已启用。'
    : connectionEnabled === false
      ? 'ChatGPT 连接已停用。'
      : 'ChatGPT 连接状态无可信读数。';
  const capabilityLine = readEnabled
    ? `全局读取能力当前**打开**；具体目录仍须启用并获授读取工具。${connectionLine}`
    : `全局读取能力当前**关闭**：文件列表/读取/搜索暂不可调用。${connectionLine}`;

  const headline =
    live.length === 0
      ? '当前没有任何目录被登记，因此没有任何本机内容暴露给模型。'
      : accessible > 0
        ? `已登记 ${String(live.length)} 个根，其中 ${String(accessible)} 个根当前具备有效的 ChatGPT 内容工具访问条件；只有实际调用时才会有内容出站。`
        : `已登记 ${String(live.length)} 个根，但当前没有根同时满足连接、目录授权与全局能力门禁；内容工具不可用。`;

  const proposalLine = flags === null
    ? `全局提议开关无可信读数，按关闭处理；${String(proposalGranted)} 个根保存了提议授权。`
    : flags.proposal_enabled
      ? `${String(proposalGranted)} 个启用根已保存提议授权；每次实际应用仍需你在本机批准。`
      : `全局提议门禁当前关闭；${String(proposalGranted)} 个根虽保存了提议授权，模型目前仍不能提出修改。`;

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
      row.mode === 'read_only' ? '只读' : '只读 + 提议（需本地批准）',
    state_label: row.removed ? '已移除' : row.enabled ? '启用' : '已暂停',
  };
}
