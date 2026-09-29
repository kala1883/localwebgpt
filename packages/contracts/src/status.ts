/**
 * bridge_status 与 workspace_list 的输出契约（方案 §6.1）。
 *
 * 二者都不得返回：本机绝对路径、凭证、控制台令牌、带授权效果的 URL。
 * workspace_list 只返回**当前连接获准的**工作区别名与能力，
 * 不返回本机全部可访问根。
 */

import type { CapabilityFlags } from './capabilities.ts';
import type { WorkspaceKind, WorkspaceMode } from './version.ts';
import type { ToolName } from './tools.ts';

export type ConnectionAlias = string;

export interface BridgeStatusData {
  /** 当前连接别名（本地配置）。不是模型可指定的字段。 */
  readonly connection_alias: ConnectionAlias;
  readonly server_version: string;
  /** Package/source fingerprint when supplied by the launcher; not a signature or permission. */
  readonly build_id?: string;
  readonly protocol_version: string;
  readonly contract_version: string;
  /** 连接级能力；与工作区级能力取交集后才是实际可用能力。 */
  readonly capabilities: CapabilityFlags;
  /**
   * 门禁状态。进程在运行 **不等于** 平台可调用；
   * `platform_verified=false` 时必须如实展示。
   */
  readonly gates: {
    readonly g0_platform_verified: boolean;
    readonly native_guard_verified: boolean;
  };
  /**
   * 当前是否暂停（方案 §9.2 的紧急停用）。
   *
   * 它读的是**状态库里的那一行**（`service_pause`，迁移 v8），
   * 因此重启不会让它变回 `false`。控制台看的是同一个来源。
   */
  readonly paused: boolean;
  /**
   * 暂停是从什么时候开始的。没有暂停时 `null`。
   *
   * 模型不需要它，但**必须**给出来：一个只说 `paused: true` 的回答，
   * 无法与「已经停了三天」区分开，而后者正是使用者此刻要知道的事。
   */
  readonly paused_at: string | null;
  /**
   * 紧急停用之后还剩下的三个计数（LWB-034 步骤 3 的「如实报告」）。
   *
   * 三个数各自回答一个具体的问题，而它们**都不是**「暂停成不成功」：
   *
   *  - `stopping_writes`：此刻还握着写盘权的写入有几件。非零表示
   *    「正在停止」—— 停用**没有**瞬间完成，而界面必须这么说。
   *  - `unrevoked_change_sets`：仍然待执行、因而还没被废止的修改集有几条。
   *    暂停中它非零，意味着废止那一步没做完（或者有人在暂停期间从控制台
   *    又排了一条）。现值现算，不是某个时刻的快照。
   *  - `recovery_operations`：等着人核验的恢复现场有几个。它与暂停无关，
   *    但把它与上面两个放在同一处，是因为操作者按下停用之后紧接着要问的
   *    就是「现在还有什么在等我」。
   */
  readonly pause: {
    readonly stopping_writes: number;
    readonly unrevoked_change_sets: number;
    readonly recovery_operations: number;
  };
  /** 人类可读的限制说明，供模型如实转述给用户。 */
  readonly limitations: readonly string[];
}

export interface WorkspaceSummary {
  readonly workspace_id: string;
  readonly display_name: string;
  readonly kind: WorkspaceKind;
  readonly mode: WorkspaceMode;
  readonly enabled: boolean;
  /** daemon 实现/诊断读数，不表示此工作区授予了哪些模型工具。 */
  readonly capabilities: CapabilityFlags;
  /** 当前连接在此工作区实际获授的 MCP 工具；不与其它工作区的 grant 合并。 */
  readonly granted_tools: readonly ToolName[];
  /** 工作区代次。变化即代表旧票据与批准全部失效。 */
  readonly generation: number;
  /** 单文件工作区时返回该文件的相对路径；目录工作区返回 null。 */
  readonly single_file_path: string | null;
}

export interface WorkspaceListData {
  readonly workspaces: readonly WorkspaceSummary[];
  /**
   * 是否还有未返回的工作区（本连接授权数超过分页上限时）。
   * 与「本机存在更多目录」无关：本工具永远不枚举授权之外的内容。
   */
  readonly truncated: boolean;
}
