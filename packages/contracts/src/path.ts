/**
 * 工作区内相对路径的**语法**校验（方案 §5.2 / LWB-010 步骤 1）。
 *
 * 本模块是纯函数、不含文件系统访问，负责在进入 FsGuard 之前挡住混淆性输入。
 *
 * 重要边界：通过本校验**不代表路径安全**。真正的安全判定必须由原生层逐级固定
 * 祖先目录句柄、验证每一级非 reparse point、并比对最终文件身份后才能得出。
 * 禁止用字符串前缀（startsWith）作为安全边界，也禁止把本模块当作唯一边界。
 *
 * 但本模块是**必要**的：绝对路径、盘符、UNC、设备命名空间、ADS、上跳、
 * 控制字符、保留名称等必须在解析前就被拒绝。
 */

export type PathRejectReason =
  | 'NOT_A_STRING'
  | 'INVISIBLE_CHAR'
  | 'EMPTY'
  | 'TOO_LONG'
  | 'TOO_DEEP'
  | 'SEGMENT_TOO_LONG'
  | 'ABSOLUTE'
  | 'UNC'
  | 'DEVICE_NAMESPACE'
  | 'DRIVE_LETTER'
  | 'ADS_COLON'
  | 'PARENT_REF'
  | 'DOT_SEGMENT'
  | 'EMPTY_SEGMENT'
  | 'TRAILING_SEPARATOR'
  | 'CONTROL_CHAR'
  | 'INVALID_CHAR'
  | 'TRAILING_DOT_OR_SPACE'
  | 'RESERVED_NAME';

export const MAX_RELATIVE_PATH_CHARS = 1024;
export const MAX_SEGMENT_CHARS = 255;
export const MAX_SEGMENT_DEPTH = 64;

/**
 * Windows 保留设备名。比较时取「第一个点之前」的部分并大写，
 * 因此 `CON.txt` 与 `con` 一样被拒绝。
 */
const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'CLOCK$',
  'CONIN$',
  'CONOUT$',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** Windows 文件名中非法的字符（`:` 单独处理为 ADS/盘符）。 */
const INVALID_FILENAME_CHARS = /[<>"|?*]/;

/**
 * 「不可见但确实是文件名一部分」的字符区间。
 *
 * 与控制字符是**两类**问题，理由也不同，所以理由码分开：
 *   - 控制字符靠 C 字符串截断、按行协议断行来骗人；
 *   - 这些字符**可见性**为零或影响显示顺序，靠「看起来是同一个名字」来骗人。
 *
 * 具体危害：`a​b` 在日志、证据、批准界面上都显示成 `ab`；
 * `a‮b.txt` 经 RTL 覆盖后显示成 `atxt.b` —— 用户批准时看到的名字
 * 与实际打开的名字不是同一个。这类路径一旦被接受，
 * 「批准的是这一个」这句话就不再成立。
 *
 * 区间取自 Unicode 的 Cf（格式字符）类与两个行/段分隔符：
 *   00AD 软连字符；061C 阿拉伯字母标记；
 *   200B–200F 零宽与方向标记；2028–202E 行/段分隔符与双向嵌入覆盖；
 *   2060–206F 词连接符、不可见运算符、双向隔离；
 *   FEFF 零宽不换行空格（也是 BOM）；FFF9–FFFB 注解锚定。
 */
function isInvisibleChar(code: number): boolean {
  return (
    code === 0x00ad ||
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff ||
    (code >= 0xfff9 && code <= 0xfffb)
  );
}

export interface PathRejected {
  readonly ok: false;
  readonly reason: PathRejectReason;
  readonly detail: string;
}

export interface PathAccepted {
  readonly ok: true;
  /** 规范化后的相对路径，统一 `/` 分隔。 */
  readonly normalized: string;
  /** 规范化后的路径段。段数 >= 1，且每一段都是合法文件名。 */
  readonly segments: readonly string[];
  /** 原始大小写形式的规范路径（用于与目录项比对时的精确匹配）。 */
  readonly originalCase: string;
}

export type PathValidation = PathAccepted | PathRejected;

function reject(reason: PathRejectReason, detail: string): PathRejected {
  return { ok: false, reason, detail };
}

function isControlChar(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

/**
 * 校验并规范化一个工作区内相对路径。
 *
 * 接受 `/` 与 `\` 两种分隔符输入（模型可能给出 Windows 风格），
 * 但拒绝任何以分隔符开头、带盘符或设备前缀的形式。
 */
export function validateRelativePath(input: unknown): PathValidation {
  if (typeof input !== 'string') {
    return reject('NOT_A_STRING', 'path 必须是字符串');
  }
  // 不可见字符**排在空判断之前**。
  //
  // 理由是 U+FEFF：JS 的 trim() 把它当空白，.NET 的 char.IsWhiteSpace 不当空白，
  // 于是同一个输入在两侧分别得到 EMPTY 与「接受」—— 一处真实的实现漂移。
  // 把它判在前面，两侧给出的都是 INVISIBLE_CHAR，漂移随之消失；
  // 而且「里面有个看不见的字符」显然比「路径为空」更接近事实。
  for (let i = 0; i < input.length; i += 1) {
    if (isInvisibleChar(input.charCodeAt(i))) {
      return reject('INVISIBLE_CHAR', `path 第 ${i + 1} 个字符是不可见字符（U+${input
        .charCodeAt(i)
        .toString(16)
        .toUpperCase()
        .padStart(4, '0')}）`);
    }
  }

  if (input.length === 0 || input.trim().length === 0) {
    return reject('EMPTY', 'path 不能为空');
  }
  if (input.length > MAX_RELATIVE_PATH_CHARS) {
    return reject('TOO_LONG', `path 超过 ${MAX_RELATIVE_PATH_CHARS} 字符`);
  }

  // 控制字符在任何位置都不允许，且必须在其它解析之前检查，
  // 避免 NUL 截断一类混淆。
  for (let i = 0; i < input.length; i += 1) {
    if (isControlChar(input.charCodeAt(i))) {
      return reject('CONTROL_CHAR', `path 第 ${i + 1} 个字符是控制字符`);
    }
  }

  // 设备命名空间：\\?\、\\.\、\??\ —— 这些会绕过 Win32 路径规范化。
  if (/^\\\\[.?]\\/.test(input) || input.startsWith('\\??\\')) {
    return reject('DEVICE_NAMESPACE', '不接受设备命名空间路径');
  }
  if (input.startsWith('\\\\') || input.startsWith('//')) {
    return reject('UNC', '不接受 UNC 路径');
  }
  if (input.startsWith('\\') || input.startsWith('/')) {
    return reject('ABSOLUTE', '不接受绝对路径');
  }
  // 盘符形式，包括 C:foo 与 C:\foo。
  if (/^[A-Za-z]:/.test(input)) {
    return reject('DRIVE_LETTER', '不接受盘符形式路径');
  }

  const unified = input.replace(/\\/g, '/');

  // 统一分隔符之后任何冒号都是 ADS 或盘符残留。
  if (unified.includes(':')) {
    return reject('ADS_COLON', '路径中不允许出现冒号（ADS 或盘符）');
  }
  if (INVALID_FILENAME_CHARS.test(unified)) {
    return reject('INVALID_CHAR', '路径包含 Windows 非法字符 < > " | ? *');
  }

  if (unified.endsWith('/')) {
    return reject('TRAILING_SEPARATOR', '路径不能以分隔符结尾');
  }

  const segments = unified.split('/');
  if (segments.length > MAX_SEGMENT_DEPTH) {
    return reject('TOO_DEEP', `路径深度超过 ${MAX_SEGMENT_DEPTH} 级`);
  }

  for (const segment of segments) {
    if (segment.length === 0) {
      return reject('EMPTY_SEGMENT', '路径包含空段（连续分隔符）');
    }
    if (segment.length > MAX_SEGMENT_CHARS) {
      return reject('SEGMENT_TOO_LONG', `路径段超过 ${MAX_SEGMENT_CHARS} 字符`);
    }
    if (segment === '.') {
      return reject('DOT_SEGMENT', '路径不允许包含 "." 段');
    }
    if (segment === '..') {
      return reject('PARENT_REF', '路径不允许包含上级引用 ".."');
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return reject('TRAILING_DOT_OR_SPACE', '路径段不能以点或空格结尾');
    }
    const dotIndex = segment.indexOf('.');
    const base = (dotIndex === -1 ? segment : segment.slice(0, dotIndex)).toUpperCase();
    if (RESERVED_DEVICE_NAMES.has(base)) {
      return reject('RESERVED_NAME', '路径段是 Windows 保留设备名');
    }
  }

  const normalized = segments.join('/');
  return {
    ok: true,
    normalized,
    segments,
    originalCase: normalized,
  };
}

/** 便捷判定：路径是否通过语法校验。 */
export function isSafeRelativePath(input: unknown): input is string {
  return validateRelativePath(input).ok;
}

/**
 * 大小写不敏感比较（Windows 语义）。
 * 仅用于目录项匹配与显示；不构成任何安全判定。
 */
export function equalPathCaseInsensitive(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}

export function joinRelative(...parts: readonly string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0)
    .join('/');
}

export function dirnameRelative(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export function basenameRelative(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/** 判断 `ancestor` 是否为 `descendant` 的字面祖先（纯字符串，仅用于展示与组装）。 */
export function isRelativeAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === '') return true;
  return descendant === ancestor || descendant.startsWith(`${ancestor}/`);
}
