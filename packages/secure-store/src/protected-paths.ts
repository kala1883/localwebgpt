/**
 * 受保护路径（方案 §5.2 硬拒绝、I13、LWB-007 步骤 4）。
 *
 * > 「密钥、审批状态库、恢复快照目录对模型永远不可挂载」——I13
 *
 * 本模块提供**两层**，且必须区分清楚：
 *
 *  - `isProtectedPathSyntax` 是**预过滤**：便宜、纯字符串、可作为 UX 提示。
 *    它**不是**安全边界 —— Junction、硬链接、8.3 短名、大小写别名都能绕过它。
 *  - `findProtectedIdentityMatch` 是**判定**：比对原生层在已打开句柄上读到的
 *     卷与文件身份。这才是 I05 要求的做法。
 *
 * 把这两层写在一个文件里并显式标注强弱，是为了防止后来者把第一层
 * 当成第二层用 —— 那正是方案反复警告的「表面路径与实际对象不一致」。
 */

import path from 'node:path';

/** 与内容无关、必须硬拒绝的文件名（小写比较）。 */
export const HARD_DENIED_BASENAMES: readonly string[] = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.envrc',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials',
  'credentials.json',
  'secrets.json',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  'bridge.sqlite',
  'bridge.sqlite-wal',
  'bridge.sqlite-shm',
];

/** 必须硬拒绝的目录名（小写比较，出现在任意层级）。 */
export const HARD_DENIED_DIRNAMES: readonly string[] = [
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  'cookies',
  'login data',
  'credential manager',
];

/**
 * `.env.example` 一类样例文件。
 *
 * 方案明确要求：**不得**自动豁免。样例文件在实践中经常被填入真实值，
 * 名字里的 "example" 不是内容保证。
 *
 * 这些名字**已经**被下面的前缀规则覆盖；保留这个常量是为了让「不得豁免」
 * 这个决定显式可读、可测，而不是因为它还需要单独处理。
 */
export const NOT_AUTO_EXEMPTED = ['.env.example', '.env.sample', '.env.template'] as const;

/**
 * 按前缀硬拒绝的基名。
 *
 * 为什么是前缀而不是枚举：`.env.bak`、`.env.old`、`.env.local.2`、`.env.prod`
 * 这类衍生物没有穷尽的一天，而枚举漏掉的那一个就是可读的机密。
 * 方案给出的三条样例只是示例，不是完整清单。
 */
const HARD_DENIED_BASENAME_PREFIXES: readonly string[] = ['.env'];

export interface ProtectedPathMatch {
  readonly kind: 'basename' | 'dirname' | 'store_root';
  readonly matched: string;
}

/**
 * 语法层预过滤。**不是安全边界。**
 *
 * @param relativePath 工作区内相对路径（已通过 `validateRelativePath`）。
 */
export function isProtectedPathSyntax(relativePath: string): ProtectedPathMatch | null {
  const segments = relativePath.split(/[\\/]/).filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  const last = segments[segments.length - 1]!.toLowerCase();
  if (HARD_DENIED_BASENAMES.includes(last)) {
    return { kind: 'basename', matched: segments[segments.length - 1]! };
  }
  for (const prefix of HARD_DENIED_BASENAME_PREFIXES) {
    if (last.startsWith(prefix)) {
      // 这里会连同 `.env.example` / `.env.sample` / `.env.template` 一起拒绝 ——
      // 正是 `NOT_AUTO_EXEMPTED` 要求的。代价是 `.environment` 这类名字被误杀，
      // 在「误杀一个罕见文件名」与「漏掉一个真实凭证」之间选前者。
      return { kind: 'basename', matched: segments[segments.length - 1]! };
    }
  }
  for (const segment of segments) {
    if (HARD_DENIED_DIRNAMES.includes(segment.toLowerCase())) {
      return { kind: 'dirname', matched: segment };
    }
  }
  return null;
}

/**
 * 「广泛目录」——不得被注册为工作区。
 *
 * 方案要求禁止把插件自身的安装/状态目录**及其父级广泛目录**注册为工作区。
 * 只拒绝自身目录是不够的：把 `C:\Users\me` 注册进来，等价于把受保护根
 * 连同整台机器的用户数据一起开放。
 */
export function broadDirectoryProbes(): string[] {
  const probes: string[] = [];
  const add = (value: string | undefined): void => {
    if (value && value.trim().length > 0) probes.push(path.resolve(value));
  };

  add(process.env['USERPROFILE']);
  add(process.env['LOCALAPPDATA']);
  add(process.env['APPDATA']);
  add(process.env['ProgramData']);
  add(process.env['SystemRoot']);
  add(process.env['ProgramFiles']);
  add(process.env['ProgramFiles(x86)']);
  add(process.env['TEMP']);

  // 当前目录所在盘的根：把整个盘注册为工作区不符合「用户明确授权一个目录」的语义。
  add(path.parse(path.resolve(process.cwd())).root);

  return [...new Set(probes)];
}

export interface BroadDirectoryOptions {
  readonly storeRoot: string;
  readonly candidateRoot: string;
  readonly homeDirectory: string;
  readonly extraProbes?: readonly string[];
}

export type BroadDirectoryVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: string };

/**
 * 判定一个候选工作区根是否是「广泛目录」。
 *
 * 比较的是**字符串**，因此同样是预过滤：真实判定由
 * `findProtectedIdentityMatch` 在原生层读到的身份上完成。
 * 但这里的两个条件（是受保护根的祖先、是系统级目录）即使被别名绕过，
 * 也还有身份判定兜底，属于纵深防御。
 */
export function assessBroadDirectory(options: BroadDirectoryOptions): BroadDirectoryVerdict {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };

  const candidate = normalize(options.candidateRoot);
  const storeRoot = normalize(options.storeRoot);

  // 候选根是受保护根的祖先（或就是它）：一旦授权，受保护根就在模型可读范围内。
  if (storeRoot === candidate || storeRoot.startsWith(`${candidate}${path.sep}`)) {
    return {
      accepted: false,
      reason: '该目录包含本地服务的受保护存储（凭证、状态库、快照、日志），不得作为工作区。',
    };
  }

  const probes = new Set<string>(
    [options.homeDirectory, ...broadDirectoryProbes(), ...(options.extraProbes ?? [])]
      .filter((p) => p.trim().length > 0)
      .map(normalize),
  );
  if (probes.has(candidate)) {
    return {
      accepted: false,
      reason: '该目录是系统级或用户级广泛目录，范围过大，不得作为工作区。',
    };
  }

  return { accepted: true };
}

/** 原生层读到的文件身份（与 `@lwb/contracts` 的 FileIdentity 同形）。 */
export interface ProtectedIdentityRef {
  readonly volume_id: string;
  readonly file_id: string;
  /** 人类可读的说明，仅用于错误信息。 */
  readonly label: string;
}

/**
 * **真正的判定**：候选根的文件身份是否等于某个受保护对象的身份。
 *
 * 这是 I05 要求的做法：身份来自已打开句柄上的 `GetFileInformationByHandle`，
 * 因此 Junction、短名、大小写、重命名都无法伪造它。
 */
export function findProtectedIdentityMatch(
  candidate: { readonly volume_id: string; readonly file_id: string },
  protectedRefs: readonly ProtectedIdentityRef[],
): ProtectedIdentityRef | null {
  for (const ref of protectedRefs) {
    if (ref.volume_id === candidate.volume_id && ref.file_id === candidate.file_id) {
      return ref;
    }
  }
  return null;
}
