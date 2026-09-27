/**
 * 候选工作区根的**绝对路径语法**处理（LWB-009 步骤 1、2）。
 *
 * ## 为什么不用 `path.resolve`
 *
 * `path.resolve('..\\..\\Windows')` 会拿 **daemon 进程的当前目录** 当基准，
 * 把一个相对路径**静默变成**一个绝对路径。注册工作区时这正好是反向的：
 * 操作者给出相对路径一定是用错了，此时唯一正确的做法是拒绝，
 * 而不是替他猜一个根 —— 猜错的那一次就是把整个盘授权出去。
 *
 * 因此本模块自己解析，只接受**完全限定**的绝对路径。
 *
 * ## 本模块不是安全边界
 *
 * 这里全部是字符串判断。`D:\a` 与 `D:\b` 指向同一个目录（Junction、8.3 短名、
 * 大小写、硬链接）在这里看不出来。真正的判定在原生层：句柄上的
 * volume_id + file_id（I05）。本模块只负责挡住语法层面的混淆输入，
 * 并把路径切成可用于逐级探测的祖先链。
 */

import { MAX_SEGMENT_CHARS, MAX_SEGMENT_DEPTH } from '@lwb/contracts';

export type RootPathRejectReason =
  | 'NOT_A_STRING'
  | 'EMPTY'
  | 'PATH_TOO_LONG'
  | 'CONTROL_CHAR'
  | 'DEVICE_NAMESPACE'
  | 'UNC'
  | 'ROOT_RELATIVE'
  | 'NOT_ABSOLUTE'
  | 'DRIVE_RELATIVE'
  | 'DRIVE_ROOT'
  | 'EMPTY_SEGMENT'
  | 'PARENT_REF'
  | 'DOT_SEGMENT'
  | 'ADS_COLON'
  | 'INVALID_CHAR'
  | 'TRAILING_DOT_OR_SPACE'
  | 'SEGMENT_TOO_LONG'
  | 'TOO_DEEP'
  | 'RESERVED_NAME';

export interface RootPathRejected {
  readonly ok: false;
  readonly reason: RootPathRejectReason;
  readonly detail: string;
}

export interface RootPathAccepted {
  readonly ok: true;
  /** 规范化后的绝对路径：反斜杠分隔、无尾部分隔符（盘符根除外）。 */
  readonly normalized: string;
  /** 第一段是盘符（如 `D:`），其余是目录名。 */
  readonly segments: readonly string[];
  /** 盘符根（`D:\`）：显式本机登记时表示授权整块本地卷。 */
  readonly is_drive_root: boolean;
}

export type RootPathParse = RootPathAccepted | RootPathRejected;

/** 根路径长度上限。取 4096 而不是 32767：长路径前缀在 V1 是拒绝项。 */
export const MAX_ROOT_PATH_CHARS = 4096;

/** Windows 保留设备名；比较时取第一个点之前的部分并大写。 */
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

const INVALID_FILENAME_CHARS = /[<>"|?*]/;

function reject(reason: RootPathRejectReason, detail: string): RootPathRejected {
  return { ok: false, reason, detail };
}

function isControlChar(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

/**
 * 解析一个候选根。
 *
 * 只接受 `X:\...` 形式（`/` 也接受，统一归一为 `\`）。
 * 盘符根表示显式授权整块卷；UNC、设备命名空间、根相对路径与盘符相对路径拒绝。
 */
export function parseAbsoluteRoot(input: unknown): RootPathParse {
  if (typeof input !== 'string') return reject('NOT_A_STRING', '根路径必须是字符串');
  const raw = input.trim();
  if (raw.length === 0) return reject('EMPTY', '根路径不能为空');
  if (raw.length > MAX_ROOT_PATH_CHARS) {
    return reject('PATH_TOO_LONG', `根路径超过 ${MAX_ROOT_PATH_CHARS} 字符`);
  }

  // 控制字符必须在任何解析之前挡掉：NUL 截断一类混淆靠它防。
  for (let i = 0; i < raw.length; i += 1) {
    if (isControlChar(raw.charCodeAt(i))) {
      return reject('CONTROL_CHAR', `根路径第 ${i + 1} 个字符是控制字符`);
    }
  }

  // `\\?\` 会绕过 Win32 路径规范化，`\\.\` 直接是设备；两者都拒绝。
  // 注意：实测 `\\?\D:\x` 能被原生层打开并返回与 `D:\x` **相同**的身份，
  // 也就是说它并不制造一个新的物理对象。拒绝它的理由不是「它指向别处」，
  // 而是「同一个对象有两种写法」本身就会让基于路径字符串的比较失效。
  if (/^\\\\[.?]\\/.test(raw) || raw.startsWith('\\??\\')) {
    return reject('DEVICE_NAMESPACE', '不接受设备命名空间路径（\\\\?\\、\\\\.\\、\\??\\）');
  }
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    return reject('UNC', '不接受 UNC 路径（网络位置不在 V1 授权范围）');
  }
  if (raw.startsWith('\\') || raw.startsWith('/')) {
    return reject('ROOT_RELATIVE', '不接受根相对路径（以分隔符开头）');
  }

  const drive = /^([A-Za-z]):/.exec(raw);
  if (!drive) {
    return reject('NOT_ABSOLUTE', '工作区根必须是完全限定的绝对路径（形如 D:\\目录）');
  }
  const driveLetter = `${drive[1]!.toUpperCase()}:`;
  const rest = raw.slice(2);

  if (rest.length === 0) {
    return reject('DRIVE_RELATIVE', '不接受盘符相对路径（D: 表示该盘的当前目录）');
  }
  if (rest[0] !== '\\' && rest[0] !== '/') {
    return reject('DRIVE_RELATIVE', '不接受盘符相对路径（形如 D:目录）');
  }

  const body = rest.replace(/\\/g, '/');
  if (body === '/') {
    return {
      ok: true,
      normalized: `${driveLetter}\\`,
      segments: [driveLetter],
      is_drive_root: true,
    };
  }
  // 统一分隔符后剩下的冒号只可能是 ADS 或盘符残留。
  if (body.includes(':')) {
    return reject('ADS_COLON', '路径中不允许出现冒号（ADS 或盘符）');
  }
  if (body.endsWith('/')) {
    return reject('EMPTY_SEGMENT', '路径以分隔符结尾，存在空段');
  }

  const names = body.split('/').slice(1);
  if (names.length > MAX_SEGMENT_DEPTH) {
    return reject('TOO_DEEP', `路径深度超过 ${MAX_SEGMENT_DEPTH} 级`);
  }

  for (const name of names) {
    if (name.length === 0) return reject('EMPTY_SEGMENT', '路径包含空段（连续分隔符）');
    if (name.length > MAX_SEGMENT_CHARS) {
      return reject('SEGMENT_TOO_LONG', `路径段超过 ${MAX_SEGMENT_CHARS} 字符`);
    }
    if (name === '.') return reject('DOT_SEGMENT', '路径不允许包含 "." 段');
    if (name === '..') return reject('PARENT_REF', '路径不允许包含上级引用 ".."');
    if (name.endsWith('.') || name.endsWith(' ')) {
      // Win32 在打开时会**静默剥掉**尾部的点与空格，
      // 于是「登记的字符串」与「实际打开的对象」不是同一个东西。
      return reject('TRAILING_DOT_OR_SPACE', `路径段不能以点或空格结尾：${name}`);
    }
    if (INVALID_FILENAME_CHARS.test(name)) {
      return reject('INVALID_CHAR', `路径段包含 Windows 非法字符 < > " | ? *：${name}`);
    }
    const dotIndex = name.indexOf('.');
    const base = (dotIndex === -1 ? name : name.slice(0, dotIndex)).toUpperCase();
    if (RESERVED_DEVICE_NAMES.has(base)) {
      return reject('RESERVED_NAME', `路径段是 Windows 保留设备名：${name}`);
    }
  }

  return {
    ok: true,
    normalized: `${driveLetter}\\${names.join('\\')}`,
    segments: [driveLetter, ...names],
    is_drive_root: false,
  };
}

/**
 * 严格祖先路径，由外向内，**不含自身**。
 *
 * 例：`D:\a\b` → `['D:\\', 'D:\\a']`。
 * 逐级探测这些路径是「候选根的整条链上有没有重解析点」的唯一办法：
 * 只看最终一级会漏掉中间某级是 Junction 的情况（方案 §5.2）。
 */
export function ancestorPaths(normalized: string): string[] {
  const parsed = parseAbsoluteRoot(normalized);
  if (!parsed.ok) return [];
  if (parsed.is_drive_root) return [];
  const out: string[] = [];
  const drive = parsed.segments[0]!;
  // 盘符根永远在链上（`D:\` 也可能是挂载点/网络映射）。
  out.push(`${drive}\\`);
  let current = drive;
  for (const name of parsed.segments.slice(1, -1)) {
    current = `${current}\\${name}`;
    out.push(current);
  }
  return out;
}

/** 路径比较键。Windows 路径大小写不敏感，比较必须按小写进行。 */
export function rootKey(normalized: string): string {
  return normalized.replace(/\\+$/, '').toLowerCase();
}

/**
 * `ancestor` 是否等于或包含 `candidate`（字符串层面）。
 *
 * **只用于登记期的重叠预筛**。运行期的路径安全由原生层逐级句柄固定决定，
 * 不得用本函数替代（方案 §5.2）。
 */
export function isSameOrAncestor(ancestor: string, candidate: string): boolean {
  const a = rootKey(ancestor);
  const b = rootKey(candidate);
  return b === a || b.startsWith(`${a}\\`);
}

/** 严格祖先（不含相等）。 */
export function isStrictAncestor(ancestor: string, candidate: string): boolean {
  return rootKey(ancestor) !== rootKey(candidate) && isSameOrAncestor(ancestor, candidate);
}

/** 规格化：取最后一段作为显示名。仅用于日志与别名建议。 */
export function lastSegment(normalized: string): string {
  const parsed = parseAbsoluteRoot(normalized);
  if (!parsed.ok) return normalized;
  return parsed.segments[parsed.segments.length - 1] ?? normalized;
}
