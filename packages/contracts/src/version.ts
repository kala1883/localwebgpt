/**
 * 文件版本与工作区代次（方案 §5.3）。
 *
 * 关键要求：
 *  - `raw_bytes_sha256` 是**原始文件字节**的哈希，不是读取正文重新编码后的哈希。
 *  - 文件身份（volume + file id）与内容哈希共同约束；仅比 mtime/size 不足以判定未变。
 *  - 同内容换文件身份（例如删除后重建）也视为潜在冲突来源，需保守处理。
 */

export type FileEncoding = 'utf-8' | 'utf-8-bom' | 'unknown';

/**
 * 文件**观察到**的换行风格。`mixed` / `none` 是读数，不是选项：
 * `mixed` 表示文件里两种都有，`none` 表示整个文件没有换行符。
 */
export type NewlineStyle = 'lf' | 'crlf' | 'mixed' | 'none';

/**
 * 写入时**要求**的换行风格。是 `NewlineStyle` 的真子集，这不是笔误。
 *
 * 「读到的风格」与「要写的风格」是两个方向的事实，共用一个类型会让
 * 契约允许一个无法执行的请求：`{newline: "mixed"}` 作为写入指令没有意义
 * （`mixed` 是「两种都有」这一观察结果，没人能按它写出文件），
 * `none` 更不是一种可指定的风格（它描述的是「一行都没有换行符」）。
 *
 * 工具输入 schema（`packages/contracts/src/tools.ts` 的 `changeItem`）一直
 * 只接受 `lf` / `crlf`；这里的类型此前更宽，两侧因此不可互相赋值 ——
 * 那个编译期核对是发现它的原因，而**schema 那侧是对的**。
 */
export type WritableNewlineStyle = 'lf' | 'crlf';

/**
 * Windows 卷身份。卷序列号 + 卷挂载根，用于阻止跨卷别名与「同名路径换对象」。
 */
export interface VolumeIdentity {
  /** 例如 `\\?\Volume{...}` 或盘符规范化后的卷标识。 */
  readonly volume_id: string;
  readonly drive_letter: string | null;
  readonly filesystem: string;
}

/**
 * 文件物理身份。由原生层在**已打开的句柄**上读取，
 * 不能在打开之前靠路径推断。
 */
export interface FileIdentity {
  readonly volume_id: string;
  /** 128 位文件索引（NTFS file id），十进制或十六进制字符串，平台决定。 */
  readonly file_id: string;
  /** 硬链接计数；> 1 时 V1 保守拒绝写入。 */
  readonly link_count: number;
  /** 是否位于 reparse point 之下（V1 保守拒绝）。 */
  readonly is_reparse_related: boolean;
}

/**
 * 文件版本。读取票据、修改集基线与批准校验都以它为单位。
 */
export interface FileVersion {
  readonly workspace_generation: number;
  readonly canonical_relative_path: string;
  readonly volume_id: string;
  readonly file_id: string;
  /** 整个文件原始字节的 SHA-256（十六进制小写）。 */
  readonly raw_bytes_sha256: string;
  readonly size: number;
  readonly encoding: FileEncoding;
  readonly bom: boolean;
  readonly newline: NewlineStyle;
  /** 与安全相关的属性，例如只读位。 */
  readonly attributes: readonly string[];
}

/**
 * 工作区代次。以下任一情况必须递增：
 *  - 根路径重定位或重新授权
 *  - 访问模式/策略变化
 *  - 根对象身份变化（例如同名目录被替换为另一个目录）
 *
 * 代次变化后，所有旧的读取票据、游标、修改集和批准立即失效。
 */
export interface WorkspaceGeneration {
  readonly workspace_id: string;
  readonly generation: number;
  readonly policy_version: number;
  readonly root_volume_id: string;
  readonly root_file_id: string;
}

export type WorkspaceKind = 'directory' | 'file';

/**
 * 工作区访问模式。V1 只有这两种；不存在「模型可写」模式。
 * `read_propose_apply_with_local_approval` 是持久化/API 兼容名称；实际模型写入
 * 由当前 workspace 的 `propose` tool grant 授权，不再要求逐次本机批准。
 */
export type WorkspaceMode = 'read_only' | 'read_propose_apply_with_local_approval';

export function isVersionStale(
  base: Pick<FileVersion, 'volume_id' | 'file_id' | 'raw_bytes_sha256'>,
  current: Pick<FileVersion, 'volume_id' | 'file_id' | 'raw_bytes_sha256'>,
): boolean {
  return (
    base.volume_id !== current.volume_id ||
    base.file_id !== current.file_id ||
    base.raw_bytes_sha256 !== current.raw_bytes_sha256
  );
}
