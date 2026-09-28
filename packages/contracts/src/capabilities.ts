/**
 * daemon 实现能力读数。它们不授予目录访问权；连接与 workspace/tool grants
 * 决定每个根的实际访问范围。平台验收状态另行显示，不作为第二套全局授权。
 */

export interface CapabilityFlags {
  /** daemon 是否实现读取类工具；不授予工作区访问权。 */
  readonly read_enabled: boolean;
  /** daemon 是否实现 Git 只读查询；不授予工作区访问权。 */
  readonly git_enabled: boolean;
  /** daemon 是否实现修改工具；实际使用仍检查逐工作区对应 grant。 */
  readonly proposal_enabled: boolean;
  /** daemon 是否实现修改应用工具；工作区授权和原生保护仍生效。 */
  readonly direct_write_enabled: boolean;
  /** 是否处于需要人工恢复的状态；为 true 时该工作区禁止一切写入。 */
  readonly recovery_required: boolean;
}

/** 默认的实现能力清单；不包含任何工作区授权。 */
export const DEFAULT_CAPABILITIES: CapabilityFlags = {
  read_enabled: true,
  git_enabled: true,
  proposal_enabled: true,
  direct_write_enabled: true,
  recovery_required: false,
};

/** 能力的细粒度标识，用于 grants 表与 IPC audience 校验。 */
export const CAPABILITY_NAMES = [
  'read',
  'search',
  'list',
  'git_read',
  'propose',
  'apply',
  'control', // 仅本地控制面；MCP 适配器永远不应持有
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/** 本地控制面专属能力；MCP 适配器凭据不得包含其中任何一项。 */
export const CONTROL_ONLY_CAPABILITIES: readonly CapabilityName[] = [
  'control',
  'apply',
];

export function isControlOnlyCapability(name: CapabilityName): boolean {
  return CONTROL_ONLY_CAPABILITIES.includes(name);
}
