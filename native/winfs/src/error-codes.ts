/**
 * 护栏错误码。与契约层的 BridgeError 代码是一一对应的子集：
 * 这里只保留「文件系统执行器」可能产生的那些，避免调用方拿到一个
 * 语义模糊的万金油错误。
 */

export type WinfsErrorCode =
  /** 路径在语法或逐级句柄固定阶段被判定不安全（穿越、重解析点、根相对等）。 */
  | 'PATH_UNSAFE'
  /** 目标是重解析点或存在多重硬链接，写入会影响工作区外对象。 */
  | 'LINK_UNSUPPORTED'
  /** 文件被其它进程占用（ERROR_SHARING_VIOLATION）。可有限重试。 */
  | 'FILE_BUSY'
  | 'NOT_FOUND'
  /** 基线哈希与磁盘实际不符，或 CREATE_NEW 撞上已存在文件。 */
  | 'FILE_VERSION_CONFLICT'
  | 'PERMISSION_DENIED'
  /** 护栏不可用或能力自检未通过。调用方必须停止写入，不得降级。 */
  | 'NATIVE_GUARD_UNAVAILABLE'
  /** 卷的形态/文件系统不在 V1 已验证范围内（网络盘、云占位、非 NTFS 等）。 */
  | 'VOLUME_UNSUPPORTED'
  /**
   * 按 `root_path` 打开的对象不是调用方声明的那一个（卷序列号或文件索引不符）。
   *
   * 与 `PATH_UNSAFE` 分开是刻意的：两者对调用方的含义完全不同。
   * `PATH_UNSAFE` 是「你给的路径写法有问题」，`ROOT_IDENTITY_MISMATCH` 是
   * 「路径写法没问题，但那个位置上的对象已经换人了」—— 后者应当触发
   * 重新授权（代次递增），而不是让模型改一个路径再来一次。
   */
  | 'ROOT_IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'IO_ERROR';

/** 这些错误码属于「环境暂时不可用」，可以有限次重试。 */
export const RETRYABLE_WINFS_CODES: readonly WinfsErrorCode[] = ['FILE_BUSY'];

/** 这些错误码属于「配置或环境问题」，重试不会变好。 */
export const NON_RETRYABLE_WINFS_CODES: readonly WinfsErrorCode[] = [
  'PATH_UNSAFE',
  'ROOT_IDENTITY_MISMATCH',
  'LINK_UNSUPPORTED',
  'NOT_FOUND',
  'FILE_VERSION_CONFLICT',
  'PERMISSION_DENIED',
  'NATIVE_GUARD_UNAVAILABLE',
  'INVALID_ARGUMENT',
  'VOLUME_UNSUPPORTED',
];
