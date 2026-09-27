/**
 * 能力开关（方案 §14）。
 *
 * 规则：
 *  - 未提供的能力**不得**继续在工具描述中暗示可用。
 *  - `direct_write_enabled` 在原生守卫未通过验证前必须保持 false，
 *    此时读取与提议仍然可用（方案 §5.4 / LWB-003 验收）。
 *  - 升级不会自动重新开放已被禁用的能力（LWB-045 验收）。
 */

export interface CapabilityFlags {
  /** 是否允许读取类工具（file_list / file_read / text_search）。 */
  readonly read_enabled: boolean;
  /** 是否允许 Git 只读查询。 */
  readonly git_enabled: boolean;
  /** 是否允许生成修改集（change_prepare / change_revert_prepare）。 */
  readonly proposal_enabled: boolean;
  /** 是否允许实际写入。默认 false；原生守卫验证通过且门禁通过后才可开启。 */
  readonly direct_write_enabled: boolean;
  /** 是否处于需要人工恢复的状态；为 true 时该工作区禁止一切写入。 */
  readonly recovery_required: boolean;
}

/**
 * 最保守的默认值：只读，不写入。
 * 任何初始化路径都必须从它出发，而不是从「全开」出发。
 */
export const DEFAULT_CAPABILITIES: CapabilityFlags = {
  read_enabled: true,
  git_enabled: false,
  proposal_enabled: false,
  direct_write_enabled: false,
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
