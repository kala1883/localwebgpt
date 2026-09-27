/**
 * Windows 文件系统护栏的**接口**（LWB-010 / LWB-003）。
 *
 * 为什么要有这层接口：
 * 方案的 14 条不变量里有好几条（I05 路径按真实对象判定、I06 重解析点拒绝、
 * I07 写入前重新校验基线、I08 不安全则拒绝、I10 无护栏不写入）只有在
 * 「谁都不许直接碰文件系统」时才可能成立。因此业务包一律不得 import fs，
 * 所有磁盘访问都必须经过本接口的实现，由静态检查
 * scripts/check-fsguard-imports.mjs 强制。
 *
 * 实现必须 **fail-closed**：
 *   护栏不可用、能力自检不通过、或任何一步无法证明路径安全时，
 *   必须返回错误，**绝不允许**退化到普通的托管文件 API 完成写入。
 *
 * 关于当前实现的重要事实（不要读成比实际更强的保证）：
 *   当前唯一的实现是 PowerShell + .NET P/Invoke 后端。它调用的是真实的
 *   Win32 API（CreateFileW / GetFileInformationByHandleW / FlushFileBuffers …），
 *   语义与编译型原生模块相同，但宿主是 PowerShell 进程。
 *   真实证据见 docs/evidence/lwb-003/ 与 docs/adr/002-writer-semantics.md。
 */

import type { WinfsErrorCode } from './error-codes.ts';

export type { WinfsErrorCode };

export interface WinfsFileIdentity {
  /** 卷序列号（十六进制字符串）。 */
  volume_id: string;
  /** 128 位文件索引（十六进制字符串）。改名不变、删除重建会变。 */
  file_id: string;
  /** 硬链接数。> 1 表示写入会影响工作区外的另一个名字。 */
  link_count: number;
}

/**
 * 一次失败之后，护栏在**仍然持有句柄**时看到的实际磁盘状态（LWB-027）。
 *
 * 它存在的唯一理由是：有些失败发生在「字节下落不明」的区间里，而那时
 * 调用方要做的决定（报告「什么都没改」还是「必须进恢复」）取决于磁盘上
 * 到底剩下什么。靠猜会把一次半成品写入报成一次干净的拒绝。
 *
 * `sha256` 为 `null` 的含义是**这次观测被上界截断**（文件比 `cap_bytes` 大），
 * 而不是「文件是空的」—— 空文件的哈希是 `e3b0c442…`，它照样会被算出来。
 * 看 `observed_bytes` 与 `cap_bytes` 可以确认这一点。
 */
export interface WinfsActualState {
  /** 观测到的文件大小（字节）。 */
  readonly size: number;
  /** 观测到的对象身份。 */
  readonly identity: WinfsFileIdentity;
  /** 完整读到时的 SHA-256；被上界截断时为 `null`。 */
  readonly sha256: string | null;
  /** 实际参与求哈希的字节数。 */
  readonly observed_bytes: number;
  /** 本次观测的字节上界。 */
  readonly cap_bytes: number;
  readonly observed_at_utc: string;
}

export interface WinfsError {
  ok: false;
  code: WinfsErrorCode;
  message: string;
  win32_error: number;
  /**
   * **只有越过「破坏性区域」之后的失败才带这一项。**
   *
   * 反过来说才是它有价值的那一面：**没有**这一项意味着这次调用从未进入
   * 截断之后的区域，也就是「一个字节都没动」—— 那是护栏在句柄里*知道*的
   * 事实，不是它没顾上看。进程被杀这类情形不产生任何响应，
   * 因此不会伪装成一份「干净」的失败。
   *
   * 它**不**携带信息说「动过」，那是 `touched` 的事：观测是尽力而为的，
   * 一次「动过但观测失败」的失败只有 `touched`（LWB-029）。
   */
  actual_state?: WinfsActualState;
  /**
   * 这次调用进入了**破坏性区域**（LWB-029）。缺席即「一个字节都没动」。
   *
   * 与 `actual_state` 的读法（`WinfsGuard.ps1` 的 `LwbFsException.Touched`
   * 是这一段的原文）：
   *
   * | `touched` | `actual_state` | 磁盘上 | 处置 |
   * | --- | --- | --- | --- |
   * | 缺席 | 缺席 | 一个字节都没动 | 报告冲突即可 |
   * | `true` | 有值 | 动过，现场已知 | 可按现场有界回滚 |
   * | `true` | 缺席 | 动过，现场**未知** | 必须进恢复，且**不能**回滚 |
   *
   * 第三行是这次加上这一项的全部理由：在它出现之前，第三行与第一行在
   * 响应里长得一模一样，而它们要求的动作正好相反。
   */
  touched?: true;
}

export interface WinfsAttributes {
  readonly is_reparse: boolean;
  readonly is_directory: boolean;
  readonly names: readonly string[];
}

export interface WinfsReadResult {
  ok: true;
  relative_path: string;
  /**
   * 目标相对于工作区根的**磁盘规范拼写**（`/` 分隔）。
   *
   * 与 `relative_path` 可能不同，而且这个差异是真实的：
   *   - NTFS 大小写不敏感，`ALPHA.TXT` 与磁盘上的 `Alpha.txt` 是同一个对象；
   *   - 8.3 短名 `ALPHA~1.TXT` 同样能打开它。
   *
   * `relative_path` 回显的是调用方给的字符串，因此**不能**拿它去和目录比对 ——
   * 一份对不上文件系统的回执没有意义（I14）。这条路径取自句柄的
   * `GetFinalPathNameByHandleW`，是与磁盘一致的那个拼写。
   *
   * 为 `null` 表示护栏无法证明目标在根之下（取不到规范路径）。
   * 此时调用方不得退回使用 `relative_path` 充当规范路径。
   */
  canonical_relative_path: string | null;
  identity: WinfsFileIdentity;
  size: number;
  /** 磁盘原始字节的 SHA-256（小写十六进制）。基线比对以此为准。 */
  sha256: string;
  bytes_base64: string;
  attributes: WinfsAttributes;
}

export interface WinfsWriteResult {
  ok: true;
  relative_path: string;
  canonical_relative_path: string | null;
  identity_before: WinfsFileIdentity;
  identity_after: WinfsFileIdentity;
  /** 写入前在句柄内实际读到的哈希（已与 expected 比对通过）。 */
  before_sha256: string;
  /** 写入并刷盘后回读得到的哈希。 */
  after_sha256: string;
  /** 目标内容的哈希。after_sha256 必须等于它，回执才有意义。 */
  target_sha256: string;
  readback_ok: boolean;
  flushed: boolean;
  bytes_written: number;
}

export interface WinfsCreateResult {
  ok: true;
  relative_path: string;
  canonical_relative_path: string | null;
  identity_after: WinfsFileIdentity;
  /** 回读得到的哈希。调用方要与 `target_sha256` 比对之后才能报完成。 */
  after_sha256: string;
  /** 本应写下去的那一份的哈希（由护栏自己对收到的字节算出）。 */
  target_sha256: string;
  /** 回读与目标逐字节相同。**这是**「这个文件确定建成了」的判据。 */
  readback_ok: boolean;
  flushed: boolean;
  bytes_written: number;
}

/** 删除成功时的句柄内核验回执；没有 after hash，因为目标已不存在。 */
export interface WinfsDeleteResult {
  ok: true;
  relative_path: string;
  canonical_relative_path: string | null;
  identity_before: WinfsFileIdentity;
  before_sha256: string;
  bytes_deleted: number;
  /** 护栏关闭删除句柄后重新探测，确认原路径已不存在。 */
  readback_missing: boolean;
}

export interface WinfsDirEntry {
  name: string;
  relative_path: string;
  type: 'file' | 'directory';
  size: number | null;
  is_reparse: boolean;
}

export interface WinfsListResult {
  ok: true;
  relative_path: string;
  /** 被列举目录的磁盘规范拼写。为 null 时 `entries[].relative_path` 退化为仅名字。 */
  canonical_relative_path: string | null;
  entries: WinfsDirEntry[];
  /**
   * 本次请求的窗口之后还有条目（同一个目录、ordinal 严格更大）。
   *
   * 判据是护栏**多选了一条**当证据：只返回前 `max_entries` 条时，
   * 「恰好装满一页」与「刚好只剩这些」无法区分，而这个区别决定了要不要发游标。
   *
   * 它描述的是**一个目录**还有没有更多，不是整次遍历还有没有更多 ——
   * 后者是调用方（`@lwb/files`）据此组装出来的结论。
   */
  has_more: boolean;
}

/** 列举请求。分页参数省略时护栏用自己的硬上限，从头开始。 */
export interface WinfsListRequest extends WinfsPathRef {
  /**
   * 只返回 ordinal 严格大于该名字的条目；省略表示从本目录第一项开始。
   *
   * 顺序是 **UTF-16 码元序**（.NET `CompareOrdinal`），与 TypeScript 里
   * 字符串的 `<` 是同一套。刻意不用区域设置相关的比较：游标按顺序定位，
   * 而区域设置相关的顺序会随机器而变。
   */
  readonly after_name?: string;
  /** 本目录最多返回多少条。护栏会夹取到自己的硬上限（`LIST_HARD_CAP`）。 */
  readonly max_entries?: number;
}

/**
 * 候选根所在的**卷与形态**事实（LWB-009 步骤 2）。
 *
 * 这是「事实」，不是「判断」：护栏只报告它实测到的东西，
 * 「什么样的卷不允许被登记」是策略，位于 packages/workspaces。
 * 分开的理由是护栏不该知道产品策略，而策略也不该自己猜 Win32 语义。
 */
export interface WinfsVolumeInfo {
  ok: true;
  /** 被查询的绝对路径（原样回显，便于调用方核对查的是哪一个）。 */
  path: string;
  /**
   * `GetDriveTypeW` 的结果。
   * 注意对 UNC 与非盘符根（如 `\\?\Volume{...}`）它会返回 `unknown`，
   * 因此**不能**把 `unknown` 当作「一定不是网络盘」——网络形态要另判。
   */
  drive_type: 'fixed' | 'remote' | 'removable' | 'cdrom' | 'ramdisk' | 'no_root_dir' | 'unknown';
  /** 卷的文件系统名（NTFS / ReFS / exFAT …）；`volume_info_available=false` 时为 null。 */
  file_system: string | null;
  file_system_flags: number;
  volume_label: string | null;
  max_component_length: number;
  /** 十六进制卷序列号。与 file_id 一起构成跨进程稳定的物理对象标识。 */
  volume_id: string;
  /** 十六进制 128 位文件索引。 */
  file_id: string;
  link_count: number;
  is_directory: boolean;
  /** 目标自身是重解析点（符号链接 / Junction / 云占位）。 */
  is_reparse: boolean;
  /** 打开该文件即触发云端下载。 */
  recall_on_open: boolean;
  /** 读取该文件数据时触发云端下载。 */
  recall_on_data_access: boolean;
  /** 上面两者任一成立。云占位文件在 V1 一律拒绝登记。 */
  is_cloud_placeholder: boolean;
  /**
   * 是否真的取到了卷信息。为 false 时 `file_system`/`volume_label` 不可用，
   * 而**身份字段仍然有效**（它们来自句柄信息，另一条 API）。
   */
  volume_info_available: boolean;
}

/**
 * 能力自检结果。`available=false` 时调用方必须停止提供写能力，
 * 而不是忽略它继续——这正是 I10「无护栏不写入」。
 */
export interface WinfsCapability {
  available: boolean;
  backend: 'powershell-pinvoke' | 'none';
  /** 为什么是当前这个 backend；失败时说明失败原因。 */
  resolved_backend_reason: string;
  supports_exclusive_handle: boolean;
  supports_flush: boolean;
  supports_create_new: boolean;
  supports_reparse_detection: boolean;
  supports_file_identity: boolean;
  supports_hardlink_count: boolean;
  /** 是否为崩溃原子替换（当前恒为 false，不得含糊其辞）。 */
  crash_atomic_replace: false;
  /** 是否提供跨文件事务（当前恒为 false）。 */
  cross_file_transaction: false;
  /** 于何环境验证。取自 `bridge_status` 的同一次自检。 */
  verified_on: string | null;
  notes: readonly string[];
}

/**
 * 工作区根引用：路径 **加上** 它的物理身份。
 *
 * 两者缺一不可，这不是冗余：
 *
 *  - 只有路径 → 同名路径被换成另一个目录之后，护栏会老老实实操作新对象；
 *  - 只有身份 → 没法打开它（身份不能用来打开对象）。
 *
 * 因此每个工作区内操作都必须同时给出两者，护栏会用句柄上的身份去核对路径
 * 打开出来的对象是不是声明的那一个（I03/I05）。调用方从
 * `WorkspaceRegistry.authorizeAccess` 得到这两个值。
 */
export interface WinfsRootRef {
  /** 工作区根的绝对路径。 */
  readonly root_path: string;
  /** 卷序列号，8 位十六进制（如 `c6e22015`）。 */
  readonly root_volume_id: string;
  /** 文件索引，16 位十六进制（如 `0044000000086a4e`）。 */
  readonly root_file_id: string;
}

/** 工作区内的相对路径引用。 */
export type WinfsPathRef = WinfsRootRef & { readonly relative_path: string };

/**
 * 护栏对相对路径的**语法**判定（LWB-010 步骤 1）。
 *
 * 之所以要能单独问，是因为语法规则在护栏里有一份独立实现（它是边界，
 * 不能假定调用方已经检查过），而两份实现的一致性必须能被逐例验证。
 */
export interface WinfsPathVerdict {
  readonly ok: true;
  readonly segments: readonly string[];
  readonly normalized: string;
}

/**
 * 护栏拒绝一个路径时的答复。
 *
 * `reason` 是护栏给出的**理由标签**，与 `packages/contracts` 的
 * `PathRejectReason` 是同一套取值。这里声明成 `string` 而不是那个联合类型，
 * 是为了不让 native 层反向依赖业务契约包 —— 而「两者取值一致」这件事
 * 由 `tests/windows/path-escape/relative-path-parity.test.ts` 逐例守住：
 * 语料的期望值来自 contracts 的联合类型，护栏给出别的字符串就会失败。
 */
export interface WinfsPathRejection {
  readonly ok: false;
  readonly code: 'PATH_UNSAFE';
  readonly reason: string;
  readonly message: string;
}

export type WinfsPathValidation = WinfsPathVerdict | WinfsPathRejection;

export interface WinfsOps {
  capability(): Promise<WinfsCapability>;

  /**
   * 查询**绝对路径**的卷与形态事实。仅供「登记 / 复核候选根」使用。
   *
   * 这是本接口里唯一一个接受绝对路径的操作，因为登记时工作区根还不存在，
   * 没有 root 可供相对。它**不得**用于工作区内的文件访问：那条路径必须走
   * root + relative_path，由逐级句柄证明安全性（I03）。
   * daemon 侧把它挂在 `workspaces.manage` 能力下，该能力不授予模型。
   *
   * 实现必须以 `FILE_FLAG_OPEN_REPARSE_POINT` 打开：跟随重解析点会**实体化**
   * 云占位文件（把整个文件下载到本地），而我们只是想识别它。
   */
  statVolume(req: { path: string }): Promise<WinfsVolumeInfo | WinfsError>;

  /**
   * 只做相对路径语法校验，不碰磁盘。用于快速失败，以及验证两侧规则一致。
   *
   * 返回的是专门的结果类型而不是通用 `WinfsError`：调用方与测试需要拿到
   * **理由标签**才能逐例比对，而理由标签不该被塞进一个所有操作共用的错误结构里。
   */
  validatePath(req: { relative_path: string }): Promise<WinfsPathValidation>;

  /** 逐级固定路径并返回目标身份；不读取内容。 */
  resolvePath(req: WinfsPathRef & { expect: 'file' | 'directory' | 'any' }): Promise<
    WinfsReadResult | WinfsListResult | WinfsError
  >;

  /** 以不含 FILE_SHARE_WRITE 的句柄读取全部字节，并取得身份。 */
  readFileGuarded(req: WinfsPathRef): Promise<WinfsReadResult | WinfsError>;

  /**
   * 同一句柄内：校验身份与基线 → 截断 → 写入 → 刷盘 → 回读。
   *
   * `expected_file_id` 是**被批准的那个对象**的文件索引。省略（或给空串）
   * 表示调用方没有身份可比 —— 那是 LWB-027 之前的调用形态，护栏会照旧
   * 只比对内容哈希。给出它之后，一个「同名位置上换了一个内容恰好相同的
   * 对象」（删除重建：编辑器保存、`git checkout`、解压覆盖）会被拒绝，
   * 因为批准针对的是那一个对象，而不是那个位置。
   *
   * 它是**可选**的，而不是必填：把一段真实存在的旧形态变成编译错误，
   * 会让「守卫身份」这件事看起来像一次纯粹的接口收紧，而它实际是一次
   * 语义增强 —— 省略它的调用方得到的是更弱的保证，而这件事应当由调用
   * 点自己写在代码里。
   */
  writeFileGuarded(req: WinfsPathRef & {
    expected_sha256: string;
    /** 被批准对象的文件索引（16 位十六进制）。省略即不做身份比对。 */
    expected_file_id?: string | null;
    content_base64: string;
  }): Promise<WinfsWriteResult | WinfsError>;

  /**
   * CREATE_NEW：已存在则失败，绝不覆盖。
   *
   * 判定与创建是**同一次系统调用**，因此「检查之后还不存在」到「真的创建」
   * 之间没有窗口 —— 别人抢先建了同名文件时，这里失败（`FILE_VERSION_CONFLICT`），
   * 而那个文件一个字节都不会被我们碰过。
   *
   * 父目录**不会被创建**：缺一级就是 `NOT_FOUND`。ACL 由新对象从父目录继承，
   * 护栏不调用任何修改 ACL 的 API。
   *
   * 失败时的 `actual_state` 含义与 `writeFileGuarded` **不同**：那里是
   * 「已越过截断线」，这里是「对象已经被创建出来了」。因此
   * **没有** `actual_state` 意味着「一个对象都没被创建」。
   */
  createFileGuarded(req: WinfsPathRef & {
    content_base64: string;
  }): Promise<WinfsCreateResult | WinfsError>;

  /**
   * 按已读文件的身份与哈希删除；删除在同一句柄里核验，关闭后还要独立确认路径消失。
   * 失败结果的 `touched` 表示已提交 delete disposition，调用方须进入恢复核对。
   */
  deleteFileGuarded?(req: WinfsPathRef & {
    expected_sha256: string;
    expected_file_id: string;
  }): Promise<WinfsDeleteResult | WinfsError>;

  /**
   * 列举**一个目录**的直接子项，有界、有序（UTF-16 码元序）、可用 `after_name` 续读。
   *
   * 这里刻意**不**做递归、不做过滤、不读内容：递归与过滤是策略层的事
   * （`@lwb/files`），而句柄证明与内存边界是护栏的事。把策略搬进护栏会让
   * 「什么样的文件不该出现在列表里」这条规则出现在两个地方。
   */
  listDirectory(req: WinfsListRequest): Promise<WinfsListResult | WinfsError>;
}

export function isWinfsOk<T extends { ok: boolean }>(result: T | WinfsError): result is T {
  return result.ok === true;
}

export function isWinfsError(result: { ok: boolean }): result is WinfsError {
  return result.ok === false;
}
