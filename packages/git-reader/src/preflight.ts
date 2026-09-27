/**
 * 两个 Git 工具共用的起飞前检查（LWB-016）。
 *
 * ## 为什么这些检查必须只有一份
 *
 * `git_status` 与 `git_diff` 都要回答同样四个问题，而四个问题的答案决定了
 * 后面所有事情成不成立：
 *
 *  1. **这是不是一个仓库？**（单文件工作区一定不是）
 *  2. **请求的路径是哪一条？**（护栏的规范拼写，不是请求里的字符串）
 *  3. **这是不是 `.git` 内部路径？**（本工具不接受）
 *  4. **布局读不读得懂？**（外置 gitdir / alternates / 超限 pack）
 *
 * 两条路径各写一遍，迟早会在某一处漏掉一条 —— 而漏掉的那一条没有报错，
 * 只有「某个工具能用、另一个工具不能用」这种看起来像 bug 的现象。
 * 这与 `guard-bridge.ts` 把读取与列举的边界规则合到一处是同一个理由。
 *
 * ## 它们都必须排在**碰库之前**
 *
 * 判据是「付出代价之前能不能判」。这四条都只需要护栏往返或纯路径运算，
 * 因此统一排在 `statusMatrix` / `readBlob` 之前 —— 一个不成立的请求不该先
 * 花掉一次遍历，也不该让库先读到一半再失败。
 */
import { BridgeError } from '@lwb/contracts';
import type { ReadScope } from '@lwb/files';
import { requireCanonicalPath, resolveTarget } from '@lwb/files';
import type { WinfsOps } from '@lwb/winfs';

import type { GitLayoutSupport } from './layout.ts';
import { inspectGitLayout } from './layout.ts';
import type { MetaFs } from './meta-fs.ts';

/** 工作区里的一个已探明对象。`canonical` 是护栏给的规范相对路径（根为 `''`）。 */
export interface ProbedTarget {
  readonly canonical: string;
  readonly volume_id: string;
  readonly file_id: string;
  readonly size: number;
  readonly is_directory: boolean;
}

/**
 * 单文件工作区里没有仓库。
 *
 * 用 `NOT_FOUND` 而不是 `INVALID_ARGUMENT`：对调用方来说，这一刻要问的问题
 * 是「这里有没有 Git」，而答案与「这个目录下没有 `.git`」是同一个答案。
 * 如果用一个参数错误来回答，调用方会去改参数，而参数怎么改都不会变出一个仓库。
 */
export function requireDirectoryWorkspace(scope: ReadScope): void {
  if (scope.kind === 'directory') return;
  throw new BridgeError('NOT_FOUND', '这是单文件工作区，其下不存在 Git 仓库；普通文件读取不受影响。', {
    reason: 'FILE_WORKSPACE',
  });
}

/**
 * 拒绝 `.git` 内部路径作为查询路径。**逐段判，不只看开头那一段。**
 *
 * ## 这不是在堵 `file_read`
 *
 * `.git/**` 在策略层是**搜索排除**（`SE-VCS`），不是硬拒绝 —— 那是 LWB-013
 * 的决定，本任务不改它。这里拒绝的是**本工具**接受这种路径：
 *
 *  - `.git/info/exclude`、`.git/packed-refs` 这类文件是文本，而 `git_diff`
 *    会把「工作区侧」的内容原样拼进差异里。于是「模型指定一个路径、
 *    工具返回它的内容」这条路会绕过 Git 内部那条窄范围读取的清单
 *    （`meta-fs.ts` 的 `GIT_FILE_ALLOW`），把「内部解析器需要什么」
 *    变成「模型想要什么」。
 *  - `git_status({path:'.git'})` 今天返回空结果，靠的是 isomorphic-git 的
 *    `isIgnored()` 里写死了 `basename === '.git'` —— 一条我们无法保证
 *    下次升级还在的库内规则。判据要握在自己手里。
 *
 * ## 为什么逐段而不是只看开头
 *
 * `sub/.git/HEAD` 不是**本仓库**的内部路径，但 `.git` 目录在任何层级上
 * 都不是工作区内容 —— Git 自己在状态里也把嵌套的 `.git` 当作边界标记。
 * 「这两棵树比较的是工作区内容」这条前提，在 `.git` 面前不成立，
 * 而它在哪里不成立与它在第几段无关。
 *
 * 逐段扫描与 `packages/policy` 的 `classifyFile` 用的是同一个判法（它也是
 * 找路径里第一个 `.git` 段），因此两处对「这是不是 `.git` 内部」的答案一致。
 */
export function requireNotGitInternal(path: string): void {
  if (!isGitInternalPath(path)) return;
  throw new BridgeError('INVALID_ARGUMENT', '本工具不接受 `.git` 内部路径；Git 元数据由内部解析器按窄范围清单读取。', {
    reason: 'GIT_INTERNAL_PATH',
  });
}

/**
 * 这个相对路径是不是 Git 内部路径。**纯函数，单独导出**，因为除了「拒绝
 * 入参」之外还有第二个调用点：状态结果的 `policy_hidden_count`。
 *
 * 那个计数说的是「你的工作区里有几条路径被策略摘掉了」，而 `Git` 内部路径
 * **从来不在**这个范围里：模型无论如何都看不到 `.git/**`（本工具直接拒绝
 * 这种入参，别的读取路径也没有把 `.git` 当工作区内容）。把 `.git/config`
 * 计进去，用户会看到一个他自己永远不可能看见的文件被算作「从他视野里摘掉
 * 了一条」—— 而那条其实是**我们的内部解析器**想去读、被 `HD-GIT-CONFIG`
 * 拦下来的。两件事混在一个数字里，这个数字就不再能解释。
 */
export function isGitInternalPath(path: string): boolean {
  return path.split('/').some((segment) => segment.length > 0 && segment.toLowerCase() === '.git');
}

/**
 * `path` 是不是在 `filepath` 这棵子树里。
 *
 * 两个用途，两种"范围"的问法：
 *
 *  - **剪枝**（`diff.ts`）：`_walk` 走到根节点时的 `filepath` 就是 `'.'`
 *    （它用一个填满 `'.'` 的数组起步），于是 `path.startsWith('./')` 恒假 ——
 *    整棵树在第一步被剪掉，遍历返回「什么都没有」，而那看起来与「索引里没有
 *    这个路径」一模一样。因此根节点单独放行。
 *  - **计数**（`status.ts`）：`policy_hidden_count` 说的是「你问的这个范围里
 *    有几条路径被摘掉」。而底层账本**必然会**包含范围外的路径：`_walk` 在
 *    调 `map` 之前已经对每个兄弟节点调过 `readdir`，于是列了 `secrets/` 的
 *    目录 —— 4 条硬拒绝路径就这么进了账本，哪怕这次问的只是 `src`。
 *    不筛掉它们，「被摘掉几条」这个数字就与用户问的东西无关了。
 *
 * 判据按**路径段边界**而不是裸前缀：`src2/a.ts` 不该因为它以 `src` 开头
 * 就被算进来。
 */
export function descends(filepath: string, path: string): boolean {
  return filepath === '.' || path.startsWith(`${filepath}/`);
}

/**
 * 目录的探针。
 *
 * 与 `search.ts` / `list.ts` 的同名手法逐字同构：「目录工作区 + 空相对路径」
 * 是护栏 `resolvePath` 故意拒绝的一种请求（它回答的是「这个路径是哪一个
 * 对象」，而「不用路径、直接说整个根」根本不是一次寻址），而「查整个工作区」
 * 却是最常见的一次调用。省掉的是一次**重复**的证明：`volume_id`/`file_id`
 * 仍取作用域里那份，而它每次都被护栏重新验过。
 */
export async function probeDirectory(
  ops: WinfsOps,
  scope: ReadScope,
  requestPath: string,
): Promise<ProbedTarget> {
  if (requestPath === '') {
    return {
      canonical: '',
      volume_id: scope.root_volume_id,
      file_id: scope.root_file_id,
      size: 0,
      is_directory: true,
    };
  }
  const target = await resolveTarget(ops, scope, requestPath, 'directory');
  if (!target.attributes.is_directory) {
    // 与 `probeFile` 同一条理由：`expect` 是提示不是判据。查一个文件的状态
    // 不是「缩小范围」，是换了一个问题 —— 那种情形请用 `git_diff`。
    throw new BridgeError('INVALID_ARGUMENT', '目标是文件，不是目录；查询单个文件的状态请改用 git_diff。', {
      reason: 'NOT_A_DIRECTORY',
      path: requireCanonicalPath(target.canonical_path),
    });
  }
  return {
    canonical: requireCanonicalPath(target.canonical_path),
    volume_id: target.identity.volume_id,
    file_id: target.identity.file_id,
    size: target.size,
    is_directory: target.attributes.is_directory,
  };
}

/**
 * 文件的探针。**只取身份与尺寸，不读内容，不判策略。**
 *
 * `expect: 'file'` 是给护栏的提示，**不是判据** —— 实测护栏当前的 `resolvePath`
 * 只把它当提示转述，并不替调用方拒绝。所以「它是不是目录」这一判在**这里**，
 * 和 `list.ts` 里同一处判断的理由相同：判据要落在拿着信息的那一层。
 * 少了这一句，`git_diff` 会去「比较一个目录的字节」。
 */
export async function probeFile(
  ops: WinfsOps,
  scope: ReadScope,
  requestPath: string,
): Promise<ProbedTarget> {
  const target = await resolveTarget(ops, scope, requestPath, 'file');
  if (target.attributes.is_directory) {
    throw new BridgeError('INVALID_ARGUMENT', '目标是目录，不是文件；本工具一次只比较一个文件。', {
      reason: 'NOT_A_FILE',
      path: requireCanonicalPath(target.canonical_path),
    });
  }
  return {
    canonical: requireCanonicalPath(target.canonical_path),
    volume_id: target.identity.volume_id,
    file_id: target.identity.file_id,
    size: target.size,
    is_directory: target.attributes.is_directory,
  };
}

/**
 * 布局检查，不通过就抛。
 *
 * `GIT_LAYOUT_UNSUPPORTED` 的语义是「这个仓库我们读不懂，但普通文件读取
 * 照样能用」—— 两种不通过都保留 `reason`，因为调用方要能区分
 * 「这里没有仓库」与「这里有仓库但读不了」。
 */
export async function inspectLayoutOrThrow(
  ops: WinfsOps,
  scope: ReadScope,
  limits: { readonly max_git_internal_file_bytes: number },
): Promise<GitLayoutSupport> {
  const inspection = await inspectGitLayout(ops, scope, limits);
  if (!inspection.ok) {
    throw new BridgeError(inspection.code, inspection.message, { reason: inspection.reason });
  }
  return inspection.support;
}

/**
 * 「库有没有试图写入」的断言。**任何一笔都让整次调用失败。**
 *
 * 方案 §9.1 写的是「库出现未预期写入就失败，不允许为『让状态查询成功』
 * 开放写权限」。这句话要落成代码，就得有两件事同时成立：
 *
 *  1. 写通道根本不存在（`meta-fs.ts` 的拒绝桩），于是写入不会发生；
 *  2. **发生了就报错**，而不是继续返回一个「看起来正常」的结果。
 *
 * 第 2 条不能省。第一版只有第 1 条：写被拒了，于是 `.git/index` 确实没变，
 * 但结果是在一个「库的假设已经被打破」的时刻算出来的，而我们没有任何证据
 * 说明那一刻算出来的东西还是对的。既然不能证明，就不返回。
 */
export function assertReadOnlyLedger(meta: MetaFs): void {
  const attempts = meta.ledger.refused_writes;
  if (attempts.length === 0) return;
  // 只报**次数**，不报那些路径。它们由库提供（正常是 `.git/index` 一类），
  // 但「库给的路径」不等于「可以回显给模型的路径」—— 上一条判断失灵的
  // 时刻，恰恰就是这条断言会被触发的时刻。路径留在本地账本里。
  throw new BridgeError(
    'INTERNAL_ERROR',
    '只读虚拟文件系统拒绝了库的写入尝试，本次调用的结果不再可信，因此整次失败。',
    { reason: 'READONLY_FS_WRITE_ATTEMPT', attempts: attempts.length },
  );
}
