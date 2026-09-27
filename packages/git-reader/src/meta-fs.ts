/**
 * 只读 Git 虚拟文件系统（LWB-016，方案 §9.1）。
 *
 * ## 这个模块存在的理由
 *
 * 方案要求「把 isomorphic-git 或通过同等验证的读取库注入只读虚拟 fs」。
 * 但「只读」两个字本身不够：`statusMatrix({refresh:false})` 是只读的，而
 * `statusMatrix({refresh:true})` **会重写 `.git/index`** —— 见 isomorphic-git
 * 源码里 `GitWalkerFs.oid()` 的 `if (self.refresh && …) index.insert(...)`，
 * 以及索引在 `GitIndexManager.acquire` 结束时落盘那一步。两者只差一个布尔
 * 参数，而那个参数的默认值是 `true`。
 *
 * 因此这里不做「记得传 refresh:false」这种约定，做**结构上的不可能**：
 * 交给库的 fs 根本没有写通道。少传了那个参数，调用失败；不会静默地
 * 改掉用户的索引。
 *
 * ## 三种路径，三种待遇
 *
 *  1. **`.git` 内部**：一份**允许清单**。不在清单里的一律拒绝并记账
 *     （`.git/hooks/**`、`.git/logs/**`、`.git/config` …）。
 *     `.git/config` 另有一道网：它是策略层的 `HD-GIT-CONFIG` 硬拒绝规则
 *     （远端 URL 里常见 `https://user:token@host`）。两道判据都拦它，
 *     而且**不共用一份名单** —— 策略管「什么内容不能出」，清单管
 *     「解析器需要什么」。合成一份的话，放宽其中任何一边都会同时放开另一边。
 *  2. **工作区普通文件**：走与 `file_read` 同一条受控读取，并先过
 *     `classifyFile`。硬拒绝的路径连 `lstat` 都不给真话（见下），
 *     于是它不会以 `deleted`、`untracked` 或任何形态出现在结果里。
 *  3. **工作区之外**：拒绝。库拿到的 `dir` 是我们给的，正常不会越界；
 *     越界只可能是我们自己的 bug，因此报 ENOENT 而不是策略错误 ——
 *     一个「策略拒绝」的说法会让这类 bug 看起来像用户的文件不该读。
 *
 * ## 读不到的路径为什么返回「既不是文件也不是目录」而不是 ENOENT
 *
 * 这是实测出来的，不是设计出来的：`statusMatrix` 走的是三棵树求并集
 * （HEAD / WORKDIR / STAGE，见 `_walk` 的 `unionOfIterators`），**索引里
 * 有的路径一定会被构造成一个 WORKDIR 条目**，然后对每个条目调 `lstat`。
 * 于是：
 *
 *  - 让 `lstat` 抛错 → 整个 `statusMatrix` 炸掉（实测：`EACCES` 直接冒泡）；
 *  - 让 `lstat` 报 ENOENT → 该文件被当成「工作区里没有」，于是**被跟踪的
 *    `.env` 会以 `deleted` 出现在结果里** —— 一条凭空捏造的变更记录；
 *  - 返回一个 `isFile()/isDirectory()/isSymbolicLink()` 全为假的 stat →
 *    isomorphic-git 判成 `special`，而 `special` 的条目**不会去读内容**
 *    （`statusMatrix` 里 `workdirOid` 只在 `workdirType === 'blob'` 时才求值）。
 *
 * 第三条是唯一既不炸、也不读的形态。它**不**保证该路径不出现在结果里 ——
 * 这一点曾经被写错过，实测更正如下：
 *
 *   `if ((workdirType === 'tree' || workdirType === 'special') && !isBlob) return`
 *   这句里的 `isBlob` 是 `[headType, workdirType, stageType]` **三者之一**为
 *   blob。一个**被跟踪**的 `.env`，它的 HEAD 与 STAGE 都是 blob，于是
 *   `isBlob` 为真，那一句不成立，条目照常进入结果，只是 `workdirOid` 为
 *   `undefined` → 排出来是 `[1, 0, 3]`，即「工作区里被删了」。
 *
 * 所以过滤**不能**靠这层兜住，必须由调用方按策略再筛一遍：`gitStatus` 会
 * 把 `notComparable()` 里的路径整条摘掉（不进 entries、不进 excluded），
 * 硬拒绝的只计入一个计数。换句话说：`specialStat` 负责**不读**，
 * 调用方负责**不报**，两件事在两个地方做，因为判据不同。
 *
 * ## 为什么 stat 里的时间戳恒为零，以及那不是偷懒
 *
 * 护栏的答复里没有任何时间戳（`WinfsReadResult` 只有身份、大小、摘要）。
 * 于是这里报出的 `mtime` / `ctime` 只能是零值。而 isomorphic-git 的
 * `compareStats` 拿它与索引里缓存的**真实**时间戳比较，**永远判为「已过期」**，
 * 于是它对每个被跟踪文件都去读真实内容算 blob 摘要，而不是采信索引里的
 * stat 缓存。
 *
 * 这不是我们设计出来的机制，是我们缺信息时唯一可能的取值 —— 但它恰好把
 * 一个缺失变成了一条保证：**状态结果永远来自工作区的真实字节，从不来自
 * 索引里缓存的 stat。** 这一点值得说清楚，因为反过来做（报一个能命中缓存的
 * 假时间戳）会让「同一秒内、同样大小的改动」被报成「没有改动」——
 * 实测可复现，见证据里的对照实验。
 *
 * 代价也是真实的：一次 `git_status` 要读一遍被跟踪文件的内容，因此有
 * `max_status_worktree_bytes` 预算，超限**明确失败**而不是退回缓存。
 *
 * ## 库碰过的每一条路径都记账
 *
 * `ledger` 记下每一次 `.git` 读取、每一次工作区读取/列举、每一次被拒的
 * 访问。它有两个用处：证据（「库到底碰了什么」是可核对的，不用读源码猜），
 * 以及**锁定**（`tests/git/*` 断言这份清单等于一个写死的集合；isomorphic-git
 * 升级后如果多读了一个文件，测试会失败，而不是让那条读取悄悄发生）。
 *
 * ## 缓存与一致性
 *
 * `.git` 内部读取按路径缓存。理由不是性能（虽然它也是），是**一致性**：
 * 实测一次 `statusMatrix` 会把 `.git/HEAD` 读 4 次、`.git/packed-refs`
 * 读 7 次，若不缓存，期间有人 `git commit` 就会让同一次调用里前后两次读到
 * 不同的 HEAD —— 那种结果既不是旧状态也不是新状态。
 * 工作区读取**不**缓存：工作区字节正是要比对的东西，缓存会把
 * 「工作区现在是什么」变成一个更早的答案。
 */
import { BridgeError } from '@lwb/contracts';
import type { GitStatusExclusion } from '@lwb/contracts';
import type { FileRule } from '@lwb/policy';
import { classifyFile } from '@lwb/policy';
import type { ReadScope } from '@lwb/files';
import { isReadShaped, refOf } from '@lwb/files';
import type { WinfsFileIdentity, WinfsOps, WinfsReadResult } from '@lwb/winfs';
import { isWinfsError } from '@lwb/winfs';

// ---------------------------------------------------------------------------
// 限额与窗口
// ---------------------------------------------------------------------------

export interface GitFsLimits {
  /**
   * 单个 `.git` 内部文件的大小上限。
   *
   * 触发它的现实是 packfile：一个用了几年的仓库可能有几百 MiB 的
   * `.git/objects/pack/*.pack`，而 `readFileGuarded` 是**整文件读取**。
   * 超过上限时**不**降级成「读一部分」—— 一个读了一半的 pack 解析出来的
   * 是错的对象，而错误的对象会变成一条看起来正常的差异。
   */
  readonly max_git_internal_file_bytes: number;
  /** 参与状态比对的工作区文件大小上限。与 `file_read` 用同一个数。 */
  readonly max_worktree_file_bytes: number;
  /**
   * 一次调用累计允许读取的工作区字节数。见文件头「时间戳恒为零」一节：
   * 状态查询要读被跟踪文件的内容，这个数字就是那件事的预算。
   */
  readonly max_worktree_read_bytes: number;
}

/** 一次向护栏要多少条目录项。护栏自己还会夹到它的硬上限。 */
const LIST_WINDOW = 500;
/** 一个目录最多取多少页。500 × 400 = 20 万条，超过就明确失败而不是无限翻。 */
const MAX_LIST_PAGES = 400;

// ---------------------------------------------------------------------------
// 允许清单
// ---------------------------------------------------------------------------

/**
 * `.git` 内部**可以读的文件**。清单来自实测（见 `docs/evidence/lwb-016/`）：
 * 这些正是 `statusMatrix(refresh:false)`、`resolveRef`、`readBlob` 真正会碰的
 * 东西，一条不多。
 *
 * 故意不包含：
 *  - `.git/config` —— 策略硬拒绝，且实测不需要（`core.autocrlf` /
 *    `core.filemode` 取不到时库用默认值，状态结果逐条不变）；
 *  - `.git/hooks/**` —— 方案明写不执行 hooks；
 *  - `.git/logs/**`（reflog）—— 本任务不需要，且它是历史内容；
 *  - `.git/COMMIT_EDITMSG` / `.git/ORIG_HEAD` 等一次性文件 —— 不需要。
 */
const GIT_FILE_ALLOW: readonly RegExp[] = [
  /^\.git\/HEAD$/,
  /^\.git\/index$/,
  /^\.git\/packed-refs$/,
  /^\.git\/shallow$/,
  /^\.git\/info\/exclude$/,
  /^\.git\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/,
  /^\.git\/objects\/pack\/pack-[0-9a-f]{40}\.idx$/,
  /^\.git\/objects\/pack\/pack-[0-9a-f]{40}\.pack$/,
  /^\.git\/objects\/info\/packs$/,
  /^\.git\/refs(\/[A-Za-z0-9._-]+)+$/,
];

/**
 * `.git` 内部**可以列举**的目录。列举只返回名字，不返回内容。
 *
 * 刻意不含 `.git/objects/<ab>` 这种两字符分片目录：开放它等于允许把整个
 * 对象库的名字列出来，而「模型能枚举 .git 内部」正是本任务要排除的形态。
 * 库找松散对象时 `lstat` 的是具体路径，不需要列举分片目录。
 */
const GIT_DIR_ALLOW: readonly RegExp[] = [
  /^\.git$/,
  /^\.git\/info$/,
  /^\.git\/objects$/,
  /^\.git\/objects\/pack$/,
  /^\.git\/objects\/info$/,
  /^\.git\/refs(\/[A-Za-z0-9._-]+)*$/,
];

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

export interface GitFsLedger {
  /** 经护栏真正读过的 `.git` 路径（去重、排序）。 */
  readonly git_reads: readonly string[];
  /** 命中缓存、**没有**再次经过护栏的 `.git` 读取次数。 */
  readonly git_cache_hits: number;
  /** 经护栏读过的 `.git` 内部字节数（缓存未命中时才累加）。 */
  readonly git_read_bytes: number;
  /** 被问过身份的工作区路径。 */
  readonly worktree_stats: readonly string[];
  /** 被读过内容的工作区路径。 */
  readonly worktree_reads: readonly string[];
  /** 经护栏读过的工作区字节数。**这是状态查询的真实代价。** */
  readonly worktree_read_bytes: number;
  /** 被列举过的工作区目录。 */
  readonly worktree_listings: readonly string[];
  /**
   * 走过护栏的工作区读取**次数**（不是去重后的路径数）。
   *
   * 与 `worktree_read_bytes` 并排看：两者不等时，差额是库自己的读放大。
   * 实测到的最大一处是 `GitIgnoreManager.isIgnored()` —— 它为**每一个**
   * 未跟踪文件重读一遍 `.gitignore`，而这份内容本来只需要读一次。
   * 记下来是因为「读了几个文件」与「读了几次」回答的是不同的问题：
   * 前者是暴露面，后者是代价。
   */
  readonly worktree_read_calls: number;
  /** 库尝试过的写操作。**任何一笔都会让整次调用失败。** */
  readonly refused_writes: readonly string[];
  /** 被拒绝的访问（策略硬拒绝，或不在清单里的 `.git` 路径）。 */
  readonly refused_reads: readonly string[];
  /**
   * 因**策略硬拒绝**而从目录列举里被摘掉的名字。
   *
   * 单列一项，是因为它和「库没读到」不是一回事：这些名字确实在磁盘上，
   * 是我们主动没让库看见。证据要能区分这两者。
   */
  readonly policy_hidden_names: readonly string[];
}

// ---------------------------------------------------------------------------
// 形态
// ---------------------------------------------------------------------------

type FsFn = (...args: readonly unknown[]) => Promise<unknown>;

/**
 * isomorphic-git 需要的 `PromiseFsClient` 形状。
 *
 * 十一个方法名**逐个写出来**，而不是写成 `Record<string, FsFn>`：这样编译器
 * 会替我们盯着库的接口 —— 库升级后如果多要一个方法（或改名），这里直接
 * 编译失败，而不是等到某次调用才发现在运行时是 `undefined`，报出一句
 * `fsp.xxx is not a function`。
 *
 * 索引签名允许**多出**方法（`rm` / `cp` / `rename` / …）。那些是拒绝桩：
 * 库不使用它们，但它们必须存在，否则别的 fs 形态（callback 风格）会走进
 * `undefined`。
 */
export interface MetaFsClient {
  readonly promises: {
    readonly readFile: FsFn;
    readonly writeFile: FsFn;
    readonly unlink: FsFn;
    readonly readdir: FsFn;
    readonly mkdir: FsFn;
    readonly rmdir: FsFn;
    readonly stat: FsFn;
    readonly lstat: FsFn;
    readonly readlink: FsFn;
    readonly symlink: FsFn;
    readonly chmod: FsFn;
    readonly [method: string]: FsFn;
  };
}

/**
 * 一次工作区文件读取的结果。
 *
 * 带上身份与摘要不是「顺带多返回点东西」：`git_diff` 必须能证明
 * 「两次打开的是同一个对象」（I03），也必须给出这一侧的**原始字节**摘要。
 * 两者护栏都已经算过了；在这里把它们丢掉、再让调用方按路径去问一次，
 * 就正好是那个「看起来等价、实际多了一次打开窗口」的错法 —— 窗口里换掉的
 * 文件会被当成同一个文件比下去。
 *
 * `sha256` 取自护栏，因此与 `file_read` 的基线比对是**同一个来源**。
 */
export interface WorktreeRead {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly identity: WinfsFileIdentity;
  readonly size: number;
}

export interface MetaFs {
  readonly client: MetaFsClient;
  readonly ledger: GitFsLedger;
  readonly cacheSize: () => number;
  /**
   * 本层**没能比对**的路径，按原因分类。调用方要把这些路径从结果里摘掉
   * 并单列（见文件头：`specialStat` 负责不读，调用方负责不报）。
   *
   * **不含**策略硬拒绝的路径 —— 那些走 `policyHiddenPaths()`，
   * 两者的去向不同：一个要如实说「我没比」，一个连名字都不该出现。
   */
  readonly exclusions: () => readonly GitStatusExclusion[];
  /** 因策略硬拒绝而整条摘掉的路径。调用方只计数，不回显名字。 */
  readonly policyHiddenPaths: () => readonly string[];
  /**
   * 按工作区相对路径读一个**工作区文件**（`git_diff` 取「工作区侧」用）。
   *
   * 与 `client.promises.readFile` 的区别只有一条，但它必须由这一层保证：
   * **`.git` 内部路径走不通这里**。库走工作区分支是合理的（它的 `dir` 就是
   * 工作区根，它也不会去读 `.git`），而调用方绕这条捷径去读
   * `.git/packed-refs` 不是 —— 那类读取只能走 `GIT_FILE_ALLOW` 管着的那条路。
   *
   * 走的是与库**同一条**受控读取：策略判定、身份、尺寸上限、累计预算都在里面。
   */
  readonly readWorktreeFile: (rel: string) => Promise<WorktreeRead>;
}

export interface MetaFsOptions {
  readonly ops: WinfsOps;
  readonly scope: ReadScope;
  /** 判定时用的规则表（含操作者覆盖）。与出站闸门拿到的是同一份。 */
  readonly rules: readonly FileRule[];
  readonly limits: GitFsLimits;
}

/**
 * 护栏的这些码表示「这一个对象这次取不到」，而不是「这次查询本身不成立」。
 * 其余码（尤其是身份不一致）必须让整次调用失败，见 `statOf`。
 */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'FILE_BUSY',
  'PERMISSION_DENIED',
  'PATH_UNSAFE',
  'LINK_UNSUPPORTED',
  'VOLUME_UNSUPPORTED',
  'IO_ERROR',
]);

/** 一个「不是普通文件、也不是目录、也不是链接」的 stat。见文件头。 */
function specialStat(): Record<string, unknown> {
  return {
    ...ZERO_STAT,
    isFile: () => false,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
}

const ZERO_STAT = {
  isFile: () => false,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
  isFIFO: () => false,
  isSocket: () => false,
  dev: 0,
  ino: 0,
  mode: 0,
  nlink: 0,
  uid: 0,
  gid: 0,
  rdev: 0,
  size: 0,
  blksize: 4096,
  blocks: 0,
  atimeMs: 0,
  mtimeMs: 0,
  ctimeMs: 0,
  birthtimeMs: 0,
  atime: new Date(0),
  mtime: new Date(0),
  ctime: new Date(0),
  birthtime: new Date(0),
} as const;

// ---------------------------------------------------------------------------

export function createMetaFs(options: MetaFsOptions): MetaFs {
  const { ops, scope, rules, limits } = options;

  const gitReads = new Set<string>();
  const worktreeStats = new Set<string>();
  const worktreeReads = new Set<string>();
  const worktreeListings = new Set<string>();
  const refusedWrites: string[] = [];
  const refusedReads: string[] = [];
  /**
   * 因策略硬拒绝而没让库看见的路径。
   *
   * 两个来源共用一个集合：目录列举时被摘掉的名字，以及 `lstat` 时被换成
   * special 的路径。它们去重后是「策略从视野里拿掉了多少条路径」，
   * 而**不是**两条不同的账 —— 同一个 `.env` 会同时从这两处漏出去。
   */
  const policyHidden = new Set<string>();
  const cache = new Map<string, Uint8Array>();
  let gitCacheHits = 0;
  let gitReadBytes = 0;

  /**
   * 本层没能比对的路径 → 原因。键就是工作区相对路径。
   *
   * 它同时承担两个职责：结果里要单列它们（`exclusions()`），
   * 以及**把库为它们编造出来的行摘掉**。后者的必要性见文件头：
   * 一个被跟踪但读不到的文件，`statusMatrix` 会给出 `[1,0,3]`，
   * 即「工作区里被删了」—— 那不是事实，是我们没看。
   */
  const notComparable = new Map<string, GitStatusExclusion>();
  let worktreeReadBytes = 0;
  let worktreeReadCalls = 0;

  const root = scope.root_path.replace(/\\/g, '/').replace(/\/+$/, '');

  /**
   * 绝对路径 → 工作区相对路径。`null` 表示不在工作区内。
   *
   * 库给的是**操作系统拼写**的绝对路径（`path.join(dir, filepath)`），
   * 也有一处是 `${dir}/${fullpath}` 形式的前斜杠拼接。两种都要认。
   * `''` 是合法的：它表示工作区根自己。
   *
   * ## `'.'` 段是**无操作**，不是非法
   *
   * 那一处拼接来自 `GitWalkerFs.stat`：`fs.lstat(`${dir}/${entry._fullpath}`)`。
   * 而遍历的**根**节点 `_fullpath` 就是 `'.'`（`_walk` 用一个填满 `'.'` 的
   * 数组起步），于是这里收到的是 `…\testrepo/.`。把它当非法，`statusMatrix`
   * 会在遍历的第一步就 ENOENT —— 而且报出来的是库自己的
   * `lstat '.'`，看起来像路径根本没传对（实测）。
   *
   * 归一化必须排在**策略判定之前**：`.git/./config` 先收敛成 `.git/config`，
   * 才轮得到 `HD-GIT-CONFIG` 拦它。顺序反过来就是给了一条绕过窄范围清单的路。
   *
   * `'..'` 与 `'.'` 不同：它**真的**能走出工作区，因此照旧拒绝。
   */
  function toRelative(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const p = raw.replace(/\\/g, '/');
    let rel: string;
    if (p === root) rel = '';
    else if (p.startsWith(`${root}/`)) rel = p.slice(root.length + 1);
    else return null;
    const kept: string[] = [];
    for (const segment of rel.split('/')) {
      if (segment === '.' || segment === '') continue;
      if (segment === '..') return null;
      kept.push(segment);
    }
    return kept.join('/');
  }

  const isGitPath = (rel: string): boolean => rel === '.git' || rel.startsWith('.git/');

  /** 策略判定。`.git` 内部路径同样过这一关（`HD-GIT-CONFIG` 在这里拦下 config）。 */
  const verdictOf = (rel: string) => classifyFile(rel, rules);

  // -------------------------------------------------------------------------
  // 错误
  // -------------------------------------------------------------------------

  function fsError(code: string, message: string): Error {
    const error = new Error(message);
    (error as Error & { code: string }).code = code;
    return error;
  }

  const enoent = (raw: unknown): Error => fsError('ENOENT', `ENOENT: no such file or directory, '${String(raw)}'`);

  /**
   * 护栏错误 → 库能读懂的码。
   *
   * `ROOT_IDENTITY_MISMATCH` 与 `FILE_VERSION_CONFLICT` **不**映射：
   * 它们是「这个工作区已经不是刚才那个工作区了」，属于必须让整次调用失败、
   * 由调用方转成契约错误的情形，而不是「某个文件读不到」。
   */
  function guardError(rel: string, error: { code: string; message: string; win32_error: number }): Error {
    switch (error.code) {
      case 'NOT_FOUND':
        return enoent(rel);
      case 'FILE_BUSY':
        return fsError('EBUSY', `EBUSY: resource busy or locked, '${rel}'`);
      case 'PERMISSION_DENIED':
      case 'PATH_UNSAFE':
      case 'LINK_UNSUPPORTED':
      case 'VOLUME_UNSUPPORTED':
        return fsError('EACCES', `EACCES: refused by guard (${error.code}), '${rel}'`);
      default:
        throw new BridgeError(
          error.code === 'ROOT_IDENTITY_MISMATCH' ? 'WORKSPACE_GENERATION_CHANGED' : 'INTERNAL_ERROR',
          `${error.message}（护栏码 ${error.code}）`,
          { winfs_code: error.code, win32_error: error.win32_error, path: rel },
        );
    }
  }

  // -------------------------------------------------------------------------
  // 护栏访问
  // -------------------------------------------------------------------------

  async function guardedRead(rel: string, maxBytes: number): Promise<WinfsReadResult> {
    const result = await ops.readFileGuarded(refOf(scope, rel));
    if (isWinfsError(result)) throw guardError(rel, result);
    if (result.attributes.is_directory) {
      throw fsError('EISDIR', `EISDIR: illegal operation on a directory, read '${rel}'`);
    }
    if (result.size > maxBytes) {
      throw new BridgeError(
        'SIZE_LIMIT_EXCEEDED',
        `文件超过本次操作允许的大小上限（${result.size} > ${maxBytes} 字节）；未读取。`,
        { size: result.size, limit_bytes: maxBytes },
      );
    }
    return result;
  }

  async function readGitInternal(rel: string): Promise<Uint8Array> {
    const cached = cache.get(rel);
    if (cached !== undefined) {
      gitCacheHits += 1;
      return cached;
    }
    const result = await guardedRead(rel, limits.max_git_internal_file_bytes);
    const bytes = decodeBytes(result);
    cache.set(rel, bytes);
    gitReads.add(rel);
    gitReadBytes += bytes.byteLength;
    return bytes;
  }

  /**
   * 读一个工作区文件。
   *
   * ## 预算在**读之前**判，而且判的是本次调用的累计值
   *
   * 与 `file_read` 不同的是，这里没有「读到一半也可以」这种结果：状态是一份
   * **比对**，一张比对了一半的表看起来与一张比对完的表没有区别。因此超预算时
   * 明确失败，并把「怎么继续」写进错误里（用 `path` 缩小范围）。
   *
   * ## 记账按**不同路径**算，不按调用次数算
   *
   * 同一个路径被读第二次**不再计费**。这不是为了宽容，是因为不这么做会得到
   * 一个错的结论：实测 `GitIgnoreManager.isIgnored()` 为**每一个**未跟踪文件
   * 重读一遍 `.gitignore`，于是一个「1000 个未跟踪文件 + 4 KiB `.gitignore`」
   * 的仓库会因为没有跟踪任何东西而吃掉 4 MiB 预算 —— 超过四分之一的上限花在
   * 同一份内容上。上限要表达的是「本次查询需要把多少**不同的工作区内容**
   * 拿进来比对」，那才是「比对不完整」的真实原因；读放大是代价，记在
   * `worktree_read_calls` 里，但它不该决定本次查询成不成立。
   *
   * 反过来，这里**不能**加缓存：同一个路径既可能是「被比对的跟踪文件」，
   * 也可能是「用来判忽略的辅助文件」，按路径缓存会让前者读到一份更早的答案。
   *
   * ## 为什么超预算的错误必须从这一层抛出，而不是让库去处理
   *
   * 一次超预算发生在库的遍历中间，库没有办法把「有一部分没比」表达成它的
   * 返回值。让它继续跑完，等于我们默认「这些文件当作没变」—— 那正是要防的事。
   */
  async function readWorktreeResult(rel: string): Promise<WinfsReadResult> {
    worktreeReadCalls += 1;
    const firstRead = !worktreeReads.has(rel);
    worktreeReads.add(rel);
    const result = await guardedRead(rel, limits.max_worktree_file_bytes);
    if (firstRead) {
      if (worktreeReadBytes + result.size > limits.max_worktree_read_bytes) {
        throw new BridgeError(
          'RESULT_TRUNCATED',
          `本次状态查询需要读取的工作区内容超过 ${limits.max_worktree_read_bytes} 字节上限；` +
            '为避免把「没比对的文件」报成「没有改动」，本次查询未完成。' +
            '请用 path 限定到子目录后重试。',
          {
            reason: 'STATUS_WORKTREE_BUDGET_EXCEEDED',
            limit_bytes: limits.max_worktree_read_bytes,
            used_bytes: worktreeReadBytes,
            next_file_bytes: result.size,
          },
        );
      }
      worktreeReadBytes += result.size;
    }
    return result;
  }

  async function readWorktree(rel: string): Promise<Uint8Array> {
    return decodeBytes(await readWorktreeResult(rel));
  }

  // -------------------------------------------------------------------------
  // stat
  // -------------------------------------------------------------------------

  /** 一个可以参与比对的普通文件 / 目录。 */
  function nodeStatOf(rel: string, isDirectory: boolean, size: number): Record<string, unknown> {
    return {
      ...ZERO_STAT,
      isFile: () => !isDirectory,
      isDirectory: () => isDirectory,
      mode: isDirectory ? 0o40000 : 0o100644,
      nlink: 1,
      size,
      _lwb_relative_path: rel,
    };
  }

  /**
   * 记为「没能比对」并返回一个库不会去读内容的 stat。
   *
   * 两个动作必须成对出现：只记不返回 special → 库照样去读；
   * 只返回 special 不记 → 调用方会把库编造的那一行当成事实。
   */
  function excluded(rel: string, exclusion: GitStatusExclusion): Record<string, unknown> {
    notComparable.set(rel, exclusion);
    return specialStat();
  }

  /**
   * 工作区路径的身份。
   *
   * ## 这里**不抛错**，除了一个例外
   *
   * `statusMatrix` 的遍历会把索引里的每个路径都拿来 `lstat` 一次，因此
   * 「某个文件取不到身份」是**常态**，不是异常：被别的进程独占、权限不足、
   * 恰好在这两步之间被删掉。让这些情形把整次查询炸掉，等于「仓库里有一个
   * 锁着的文件，就看不了状态」。
   *
   * 于是它们一律转成「我没比」：special stat + 单列。唯一的例外是
   * `ROOT_IDENTITY_MISMATCH` —— 那不是「某个文件读不到」，而是「这个工作区
   * 已经不是刚才那个工作区了」，此时任何结果都没有意义，必须整体失败。
   *
   * ## 重解析点为什么也算「没能比对」而不是「链接」
   *
   * 如实报成链接会让库去 `readlink`（`mode >> 12 === 0b1010` 那一支），
   * 而我们的 `readlink` 是拒绝的。方案要求不跟随链接，而**不跟随**就意味着
   * 我们无法回答「链接目标的内容是什么」—— 那正是比对需要的东西。
   * 与其让库在 `readlink` 上炸掉，不如在这里说清楚：这个对象不参与比对。
   */
  async function statOf(rel: string): Promise<Record<string, unknown>> {
    if (rel === '' && scope.kind === 'directory') {
      return nodeStatOf(rel, true, 0);
    }
    worktreeStats.add(rel);

    const result = await ops.resolvePath({ ...refOf(scope, rel), expect: 'any' });
    if (isWinfsError(result)) {
      // 见上：这些是**常态**，转成「我没比」；未知码是 bug，照实抛。
      if (result.code === 'ROOT_IDENTITY_MISMATCH' || result.code === 'FILE_VERSION_CONFLICT') {
        throw guardError(rel, result);
      }
      if (!UNAVAILABLE_CODES.has(result.code)) throw guardError(rel, result);
      return excluded(rel, {
        path: rel,
        reason: result.code === 'LINK_UNSUPPORTED' ? 'LINK_UNSUPPORTED' : 'IDENTITY_UNAVAILABLE',
        detail: `护栏未能给出该对象的可信身份（护栏码 ${result.code}）；它未参与本次比对。`,
      });
    }
    if (!isReadShaped(result)) {
      throw new BridgeError('INTERNAL_ERROR', '护栏对该路径返回了非目标形态的结果；已拒绝继续操作。', {
        reason: 'PROBE_NOT_TARGET_SHAPED',
        path: rel,
      });
    }
    if (result.attributes.is_reparse) {
      return excluded(rel, {
        path: rel,
        reason: 'LINK_UNSUPPORTED',
        detail: '该对象是重解析点（符号链接 / junction）；V1 不跟随链接，因此不对它做比对。',
      });
    }
    if (!result.attributes.is_directory && result.size > limits.max_worktree_file_bytes) {
      return excluded(rel, {
        path: rel,
        reason: 'FILE_TOO_LARGE',
        detail:
          `超过单文件比对上限 ${limits.max_worktree_file_bytes} 字节（${result.size} 字节）；` +
          '受控句柄只提供整文件读取，不提供部分读取，因此未参与本次比对。',
      });
    }
    return nodeStatOf(rel, result.attributes.is_directory, result.size);
  }

  // -------------------------------------------------------------------------
  // 列举
  // -------------------------------------------------------------------------

  /**
   * 目录列举。**必须返回一个完整、已按字节序排好的数组** ——
   * isomorphic-git 的三树并集（`unionOfIterators`）假定各来源已排序，
   * 否则合并出来的不是并集，而是「一部分文件凭空消失」。
   *
   * 护栏按 UTF-16 码元序返回。对 BMP 字符两者一致，对补充平面字符
   * （emoji 之类）不一致：UTF-16 把代理对排在 U+E000–U+FFFF 之前，
   * 而 Git 的索引按 `memcmp` 的字节序排。两者同时出现时顺序不同 ——
   * 因此这里按 UTF-8 字节重排一次，与 Git 对齐。
   */
  async function listNames(rel: string): Promise<string[]> {
    const names: string[] = [];
    let after: string | undefined;
    let page = await listPage(rel, undefined);

    for (let guard = 0; ; guard += 1) {
      for (const entry of page.entries) {
        const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (verdictOf(child).kind === 'hard_deny') {
          policyHidden.add(child);
          continue;
        }
        names.push(entry.name);
      }
      if (!page.has_more) break;
      const last = page.entries.at(-1);
      if (last === undefined || last.name === after) {
        throw new BridgeError('INTERNAL_ERROR', '目录列举游标没有推进；已中止。', {
          reason: 'LIST_CURSOR_STALLED',
          path: rel,
        });
      }
      if (guard >= MAX_LIST_PAGES) {
        throw new BridgeError('INTERNAL_ERROR', '目录列举页数超出上限；已中止。', {
          reason: 'LIST_PAGES_EXHAUSTED',
          path: rel,
        });
      }
      after = last.name;
      page = await listPage(rel, after);
    }
    return names.sort(byUtf8Bytes);
  }

  async function listPage(rel: string, after: string | undefined) {
    const page = await ops.listDirectory({
      ...refOf(scope, rel),
      max_entries: LIST_WINDOW,
      ...(after === undefined ? {} : { after_name: after }),
    });
    if (isWinfsError(page)) throw guardError(rel, page);
    return page;
  }

  // -------------------------------------------------------------------------

  function refuseWrite(op: string, raw: unknown): never {
    const rel = toRelative(raw);
    refusedWrites.push(`${op} ${rel ?? String(raw)}`);
    throw fsError('EPERM', `EPERM: read-only git filesystem, ${op} refused on '${String(rel ?? raw)}'`);
  }

  async function readFile(raw: unknown, opts?: unknown): Promise<Uint8Array | string> {
    const rel = toRelative(raw);
    if (rel === null) throw enoent(raw);
    if (isGitPath(rel)) {
      if (verdictOf(rel).kind === 'hard_deny' || !GIT_FILE_ALLOW.some((re) => re.test(rel))) {
        refusedReads.push(rel);
        throw enoent(rel);
      }
      const bytes = await readGitInternal(rel);
      return isUtf8Request(opts) ? new TextDecoder('utf-8').decode(bytes) : bytes;
    }
    if (verdictOf(rel).kind === 'hard_deny') {
      refusedReads.push(rel);
      throw enoent(rel);
    }
    const bytes = await readWorktree(rel);
    return isUtf8Request(opts) ? new TextDecoder('utf-8').decode(bytes) : bytes;
  }

  async function readdir(raw: unknown): Promise<string[]> {
    const rel = toRelative(raw);
    if (rel === null) throw enoent(raw);
    if (!isGitPath(rel)) {
      worktreeListings.add(rel);
      return listNames(rel);
    }
    if (verdictOf(rel).kind === 'hard_deny' || !GIT_DIR_ALLOW.some((re) => re.test(rel))) {
      refusedReads.push(rel);
      throw enoent(rel);
    }
    return listNames(rel);
  }

  async function stat(raw: unknown): Promise<Record<string, unknown>> {
    const rel = toRelative(raw);
    if (rel === null) throw enoent(raw);

    if (verdictOf(rel).kind === 'hard_deny') {
      refusedReads.push(rel);
      // 见文件头：硬拒绝的路径报告「不是普通文件」，让库**不去读它**。
      // 光这一句挡不住它出现在结果里（被跟踪的文件在 HEAD/STAGE 里也是 blob），
      // 因此还要把它记进策略隐藏集，由调用方整条摘掉。
      policyHidden.add(rel);
      return specialStat();
    }
    if (isGitPath(rel) && !GIT_FILE_ALLOW.some((re) => re.test(rel)) && !GIT_DIR_ALLOW.some((re) => re.test(rel))) {
      refusedReads.push(rel);
      throw enoent(rel);
    }
    return statOf(rel);
  }

  async function readlink(raw: unknown): Promise<never> {
    const rel = toRelative(raw) ?? String(raw);
    refusedReads.push(`readlink ${rel}`);
    throw fsError('EINVAL', `EINVAL: 不跟随链接，readlink 不可用，'${rel}'`);
  }

  const promises: MetaFsClient['promises'] = {
    readFile,
    readdir,
    stat,
    lstat: stat,
    readlink,
    writeFile: async (raw: unknown) => refuseWrite('writeFile', raw),
    unlink: async (raw: unknown) => refuseWrite('unlink', raw),
    mkdir: async (raw: unknown) => refuseWrite('mkdir', raw),
    rmdir: async (raw: unknown) => refuseWrite('rmdir', raw),
    rm: async (raw: unknown) => refuseWrite('rm', raw),
    cp: async (raw: unknown) => refuseWrite('cp', raw),
    symlink: async (raw: unknown) => refuseWrite('symlink', raw),
    chmod: async (raw: unknown) => refuseWrite('chmod', raw),
    rename: async (raw: unknown) => refuseWrite('rename', raw),
    appendFile: async (raw: unknown) => refuseWrite('appendFile', raw),
    truncate: async (raw: unknown) => refuseWrite('truncate', raw),
    utimes: async (raw: unknown) => refuseWrite('utimes', raw),
  };

  return {
    client: { promises },
    ledger: {
      get git_reads() {
        return [...gitReads].sort();
      },
      get git_cache_hits() {
        return gitCacheHits;
      },
      get git_read_bytes() {
        return gitReadBytes;
      },
      get worktree_stats() {
        return [...worktreeStats].sort();
      },
      get worktree_reads() {
        return [...worktreeReads].sort();
      },
      get worktree_read_bytes() {
        return worktreeReadBytes;
      },
      get worktree_read_calls() {
        return worktreeReadCalls;
      },
      get worktree_listings() {
        return [...worktreeListings].sort();
      },
      refused_writes: refusedWrites,
      refused_reads: refusedReads,
      get policy_hidden_names() {
        return [...policyHidden].sort();
      },
    },
    cacheSize: () => cache.size,
    exclusions: () => [...notComparable.values()].sort((a, b) => byUtf8Bytes(a.path, b.path)),
    policyHiddenPaths: () => [...policyHidden].sort(byUtf8Bytes),
    async readWorktreeFile(rel: string): Promise<WorktreeRead> {
      if (rel === '' || isGitPath(rel)) {
        throw new BridgeError(
          'INVALID_ARGUMENT',
          '拒绝按工作区路径读取 `.git` 内部或空路径；Git 内部内容只能走内部解析器的窄范围读取。',
          { reason: 'NOT_A_WORKTREE_PATH', path: rel },
        );
      }
      if (verdictOf(rel).kind === 'hard_deny') {
        refusedReads.push(rel);
        throw new BridgeError('POLICY_DENIED', '该路径命中硬拒绝规则，不会读取。', {
          path: rel,
        });
      }
      const result = await readWorktreeResult(rel);
      return {
        bytes: decodeBytes(result),
        sha256: result.sha256,
        identity: result.identity,
        size: result.size,
      };
    },
  };
}

/**
 * 受控句柄把字节以 base64 回传（JSON 边界上没有更好的选择）。
 *
 * 单独一处是因为**每一次**转换都必须一模一样：编码参数上的一处差异，
 * 得到的就是不同的字节，而它会以「两份内容之间的差异莫名其妙」的形式出现，
 * 非常难查。
 */
function decodeBytes(result: WinfsReadResult): Uint8Array {
  return Uint8Array.from(Buffer.from(result.bytes_base64, 'base64'));
}

/**
 * UTF-8 字节序比较。**必须与 Git 索引的 `memcmp` 语义一致**，见 `listNames`。
 *
 * 单独导出是为了能直接测：这条判据的错法不是崩溃，而是「某些文件
 * 从状态结果里消失」，而那看起来像「它们没被改过」。
 */
export function byUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** 库偶尔会以 `'utf8'` / `{ encoding: 'utf8' }` 要字符串。 */
function isUtf8Request(opts: unknown): boolean {
  if (opts === 'utf8' || opts === 'utf-8') return true;
  if (typeof opts === 'object' && opts !== null) {
    const encoding = (opts as { encoding?: unknown }).encoding;
    return encoding === 'utf8' || encoding === 'utf-8';
  }
  return false;
}
