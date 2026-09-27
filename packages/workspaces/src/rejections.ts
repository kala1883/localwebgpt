/**
 * 候选根被拒绝的理由（LWB-009 步骤 2）。
 *
 * 这是一个**闭集**，与 `@lwb/contracts` 的 `PathRejectReason` 同一风格：
 * 拒绝理由必须能被评审、被测试逐条钉住，而不是散落成自由文本。
 * 新增一条理由就要同时新增一个测试 —— 这正是「拒绝而非降级」（I10）在
 * 代码结构上的体现。
 *
 * 每一条都对应一个**可被验证的失败模式**，不是防御性冗余：
 *   - 语法类：解析阶段就能判定，见 root-path.ts。
 *   - 形态类：需要原生层读到的卷/文件事实，见 screen.ts。
 *   - 关系类：需要与**已登记**工作区比较，见 screen.ts 的重叠判定。
 */

import { BridgeError } from '@lwb/contracts';

export type RootRejectionReason =
  // ---- 语法（root-path.ts） ----
  | 'NOT_ABSOLUTE'
  | 'DRIVE_RELATIVE'
  | 'DRIVE_ROOT'
  | 'UNC'
  | 'DEVICE_NAMESPACE'
  | 'ROOT_RELATIVE'
  | 'EMPTY_SEGMENT'
  | 'PARENT_REF'
  | 'DOT_SEGMENT'
  | 'ADS_COLON'
  | 'INVALID_CHAR'
  | 'TRAILING_DOT_OR_SPACE'
  | 'RESERVED_NAME'
  | 'CONTROL_CHAR'
  | 'PATH_TOO_LONG'
  | 'SEGMENT_TOO_LONG'
  | 'TOO_DEEP'
  | 'NOT_A_STRING'
  | 'EMPTY'
  // ---- 形态（需要原生层事实） ----
  /** 候选根自身是重解析点（Junction / 符号链接）。 */
  | 'ROOT_IS_REPARSE'
  /** 链上的某一级是重解析点：真实对象在别处，字符串前缀已无意义。 */
  | 'ANCESTOR_IS_REPARSE'
  /** 链上的某一级无法打开/查询 —— 无法证明它非重解析，只能拒绝。 */
  | 'ANCESTOR_UNVERIFIABLE'
  /** 云占位文件：任何读取都可能触发网络下载。 */
  | 'CLOUD_PLACEHOLDER'
  /** 网络盘。 */
  | 'DRIVE_TYPE_REMOTE'
  /** 可移动/光驱/内存盘/未知盘型，V1 未验证。 */
  | 'DRIVE_TYPE_UNSUPPORTED'
  /** 文件系统不是 NTFS，V1 未验证。 */
  | 'FILESYSTEM_UNVERIFIED'
  /** 取不到卷信息，无法判定形态。 */
  | 'VOLUME_INFO_UNAVAILABLE'
  /** 根文件有多个硬链接：写它会改变工作区外的另一个名字。 */
  | 'HARDLINK'
  /** 登记的形态与磁盘上的实际形态不符。 */
  | 'KIND_MISMATCH'
  /** 候选根不存在。 */
  | 'NOT_FOUND'
  /** 候选根打不开（权限）。 */
  | 'ACCESS_DENIED'
  /** 原生护栏不可用：没有事实就没有判定，一律拒绝。 */
  | 'GUARD_UNAVAILABLE'
  /** 探测返回了无法归类的失败。 */
  | 'PROBE_FAILED'
  // ---- 关系 ----
  /** 受保护存储根（凭证/状态库/快照/日志）本身或其祖先。 */
  | 'PROTECTED_STORE'
  /** 系统级或用户级广泛目录。 */
  | 'BROAD_DIRECTORY'
  /** 文件身份等于某个受保护对象的身份（绕过别名写法也拦得住）。 */
  | 'PROTECTED_IDENTITY'
  /** 文件身份已被另一条在册工作区占用（换了写法也拦得住）。 */
  | 'DUPLICATE_IDENTITY'
  /** 同一路径已被另一条在册工作区占用。 */
  | 'DUPLICATE_PATH'
  /** 别名已被另一条在册工作区占用。 */
  | 'DUPLICATE_ALIAS'
  /** 与在册工作区的根重叠，且至少有一侧可写。 */
  | 'WRITABLE_ROOT_OVERLAP'
  // ---- 来源 ----
  /** 调用来源不是本地控制台。 */
  | 'ORIGIN_NOT_LOCAL'
  /** 别名不合法。 */
  | 'INVALID_ALIAS';

export interface RootRejection {
  readonly reason: RootRejectionReason;
  /**
   * 面向**本地操作者**的说明，可能包含本机路径。
   *
   * 绝不能进入模型可见的载荷：`RootRejectedError.toPayload()` 只带
   * reason 码，不带 detail。见该类的注释。
   */
  readonly detail: string;
}

export const ROOT_REJECTION_SUMMARIES: Readonly<Record<RootRejectionReason, string>> = {
  NOT_ABSOLUTE: '工作区根必须是完全限定的绝对路径。',
  DRIVE_RELATIVE: '不接受盘符相对路径（D: 或 D:目录）。',
  DRIVE_ROOT: '不接受盘符根：它等价于授权整块磁盘。',
  UNC: '不接受 UNC 与网络位置。',
  DEVICE_NAMESPACE: '不接受设备命名空间路径。',
  ROOT_RELATIVE: '不接受根相对路径。',
  EMPTY_SEGMENT: '路径包含空段。',
  PARENT_REF: '路径不允许包含上级引用 ".."。',
  DOT_SEGMENT: '路径不允许包含 "." 段。',
  ADS_COLON: '路径中不允许出现冒号（ADS）。',
  INVALID_CHAR: '路径包含 Windows 非法字符。',
  TRAILING_DOT_OR_SPACE: '路径段不能以点或空格结尾。',
  RESERVED_NAME: '路径段是 Windows 保留设备名。',
  CONTROL_CHAR: '路径包含控制字符。',
  PATH_TOO_LONG: '路径超出长度上限。',
  SEGMENT_TOO_LONG: '路径段超出长度上限。',
  TOO_DEEP: '路径层级超出上限。',
  NOT_A_STRING: '根路径必须是字符串。',
  EMPTY: '根路径不能为空。',
  ROOT_IS_REPARSE: '候选根自身是符号链接或 Junction，V1 保守拒绝。',
  ANCESTOR_IS_REPARSE: '候选根的上级路径中有符号链接或 Junction，V1 保守拒绝。',
  ANCESTOR_UNVERIFIABLE: '无法验证候选根上级路径的形态，已拒绝。',
  CLOUD_PLACEHOLDER: '候选根是云占位文件，读取会触发网络下载，V1 不支持。',
  DRIVE_TYPE_REMOTE: '候选根在网络盘上，V1 不支持。',
  DRIVE_TYPE_UNSUPPORTED: '盘型不在 V1 已验证范围内。',
  FILESYSTEM_UNVERIFIED: '文件系统不在 V1 已验证范围内。',
  VOLUME_INFO_UNAVAILABLE: '无法读取卷信息，无法判定候选根形态。',
  HARDLINK: '候选根有多个硬链接，写入会影响工作区外的另一个名字。',
  KIND_MISMATCH: '登记的形态与磁盘上的实际形态不一致。',
  NOT_FOUND: '候选根不存在。',
  ACCESS_DENIED: '候选根无法打开（权限不足）。',
  GUARD_UNAVAILABLE: '原生护栏不可用，无法验证候选根。',
  PROBE_FAILED: '探测候选根时发生未归类失败。',
  PROTECTED_STORE: '该目录包含本地服务的受保护存储，不得作为工作区。',
  BROAD_DIRECTORY: '该目录是系统级或用户级广泛目录，范围过大。',
  PROTECTED_IDENTITY: '该路径指向受保护存储对象本身。',
  DUPLICATE_IDENTITY: '该物理对象已被另一条在册工作区占用。',
  DUPLICATE_PATH: '该路径已被另一条在册工作区占用。',
  DUPLICATE_ALIAS: '该别名已被在册工作区占用。',
  WRITABLE_ROOT_OVERLAP: '与在册工作区的根重叠，且至少有一侧可写。',
  ORIGIN_NOT_LOCAL: '工作区只能由本地控制台创建或修改。',
  INVALID_ALIAS: '别名不合法。',
};

/**
 * 登记被拒绝。
 *
 * ## 为什么 `toPayload()` 里没有 detail
 *
 * `BridgeError.details` 与 `message` 都可能一路走到模型可见的工具结果里
 * （方案 §6.6：「message 绝不能再装回本机绝对路径」）。拒绝理由的 detail
 * 恰恰**必须**包含本机路径才能让本地操作者看懂。
 *
 * 因此两者分开：`toPayload()` 只带 reason 码（可安全出站），
 * `rejections` 只在本地控制台上渲染。这条规则不靠注释维持 ——
 * 它是父类载荷与子类字段之间的结构性区别。
 */
export class RootRejectedError extends BridgeError {
  readonly rejections: readonly RootRejection[];

  constructor(rejections: readonly RootRejection[]) {
    const codes = [...new Set(rejections.map((r) => r.reason))];
    super('POLICY_DENIED', `候选工作区根被拒绝（${codes.join(', ')}）。`, {
      reasons: codes.join(','),
      reason_count: codes.length,
    });
    this.name = 'RootRejectedError';
    this.rejections = rejections;
  }

  /** 面向本地操作者的多行说明。**不得**直接回给模型。 */
  describe(): string[] {
    return this.rejections.map((r) => `${r.reason}：${r.detail}`);
  }
}

export function isRootRejectedError(value: unknown): value is RootRejectedError {
  return value instanceof RootRejectedError;
}
