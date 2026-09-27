/**
 * Git 布局检查（LWB-016，方案 §9.1）。
 *
 * > V1 对外置 gitdir、alternates、未支持对象格式和特殊索引返回
 * > GIT_LAYOUT_UNSUPPORTED；普通文件读取仍可使用。
 *
 * ## 为什么要在读任何东西之前先判布局
 *
 * 「不支持」有两种表达方式：**在开始读之前说出来**，或者**读到一半失败**。
 * 后者的代价不是这次调用失败，而是失败的方式不可控 —— 库可能已经把一半的
 * 对象读完，可能返回一个"看起来像空仓库"的结果，也可能抛出一个我们没见过的
 * 错误。用户看到的会是"这个仓库没有改动"，而真相是"我们读不懂它的索引"。
 *
 * 所以这里做的是**先证伪**：把所有「读不懂」的形态在第一次打开文件之前
 * 挡掉，每一种都给一个确切的名字。
 *
 * ## 检查不到的那一条，必须写下来
 *
 * `repositoryformatversion` 与 `extensions.objectformat`（sha256 仓库）写在
 * `.git/config` 里，而 `.git/config` 是策略层的硬拒绝规则 `HD-GIT-CONFIG`
 * （远端 URL 里常见 `https://user:token@host`）。**因此本层看不到它们。**
 *
 * 这不是一个可以绕过去的细节，它决定了降级路径的形状：sha256 仓库不会被
 * `inspectLayout` 认出来，它会一直到解析索引时失败。实测那种失败的形态是
 * `Invalid checksum in GitIndex buffer …`（索引里的对象 id 是 32 字节，
 * 库按 20 字节读，校验和自然对不上），而**索引损坏的报错长得一模一样**。
 * 两者都归为 `GIT_LAYOUT_UNSUPPORTED`，理由不是它们等价，而是：
 * 我们确实无法区分，而编一个"这是 sha256 仓库"的说法就是编造。
 */
import { BridgeError } from '@lwb/contracts';
import type { ReadScope } from '@lwb/files';
import { refOf } from '@lwb/files';
import type { WinfsOps } from '@lwb/winfs';
import { isWinfsError } from '@lwb/winfs';

export interface GitLayoutSupport {
  readonly git_dir: '.git';
  /** 已知的降级说明；空数组表示没有已知降级。 */
  readonly warnings: readonly string[];
}

export type GitLayoutInspection =
  | { readonly ok: true; readonly support: GitLayoutSupport }
  | {
      readonly ok: false;
      readonly code: 'NOT_FOUND' | 'GIT_LAYOUT_UNSUPPORTED';
      readonly reason: string;
      readonly message: string;
    };

export interface LayoutLimits {
  readonly max_git_internal_file_bytes: number;
}

const GIT_DIR = '.git';

/**
 * 检查工作区根下的 Git 布局。
 *
 * **不读 `.git/config`**（策略硬拒绝），**不读任何对象**（那是解析阶段的事）。
 * 只做身份探针与目录列举，因此代价是常数条护栏往返。
 */
export async function inspectGitLayout(
  ops: WinfsOps,
  scope: ReadScope,
  limits: LayoutLimits,
): Promise<GitLayoutInspection> {
  const root = scope.root_path.replace(/\\/g, '/').replace(/\/+$/, '');

  // ---- 1. `.git` 必须是一个**目录** -------------------------------------
  const dotGit = await ops.resolvePath({ ...refOf(scope, GIT_DIR), expect: 'any' });
  if (isWinfsError(dotGit)) {
    if (dotGit.code === 'NOT_FOUND') {
      return {
        ok: false,
        code: 'NOT_FOUND',
        reason: 'NO_GIT_DIR',
        message: '该工作区不是 Git 仓库（找不到 .git）。普通文件读取不受影响。',
      };
    }
    throw new BridgeError('INTERNAL_ERROR', `${dotGit.message}（护栏码 ${dotGit.code}）`, {
      winfs_code: dotGit.code,
      path: GIT_DIR,
    });
  }
  if (!('attributes' in dotGit)) {
    return unsupported('GITDIR_NOT_A_TARGET', '护栏未能对 .git 给出目标形态的身份信息。');
  }
  if (!dotGit.attributes.is_directory) {
    // `.git` 是**文件**：里面写着 `gitdir: ../..`。这是 linked worktree 与
    // submodule 的形态 —— 真实仓库在别处，而那个位置不在本工作区之下。
    return unsupported(
      'GITDIR_FILE',
      '.git 是一个文件（gitdir 指针，常见于 linked worktree 或 submodule），仓库本体在本工作区之外。',
    );
  }
  if (dotGit.attributes.is_reparse) {
    return unsupported('GITDIR_REPARSE', '.git 是一个重解析点（符号链接 / junction），不跟随。');
  }

  // ---- 2. 不能是"共享 git 目录" ----------------------------------------
  if (await exists(ops, scope, `${GIT_DIR}/commondir`)) {
    return unsupported(
      'COMMONDIR',
      '.git/commondir 存在：对象库与 refs 在本工作区之外（worktree / submodule）。',
    );
  }

  // ---- 3. 不能有 alternates --------------------------------------------
  for (const name of ['objects/info/alternates', 'objects/info/http-alternates']) {
    if (await exists(ops, scope, `${GIT_DIR}/${name}`)) {
      return unsupported(
        'ALTERNATES',
        `.git/${name} 存在：对象库被替换到本工作区之外，本工具无法证明读到的是哪一份内容。`,
      );
    }
  }

  // ---- 4. 打包对象不能超过整文件读取上限 --------------------------------
  const packDir = await listOrNull(ops, scope, `${GIT_DIR}/objects/pack`);
  if (packDir !== null) {
    for (const entry of packDir) {
      if (entry.type !== 'file' || entry.size === null) continue;
      if (entry.size > limits.max_git_internal_file_bytes) {
        return unsupported(
          'PACK_TOO_LARGE',
          `有打包对象文件超过本次允许的内部文件上限（${entry.size} > ` +
            `${limits.max_git_internal_file_bytes} 字节）。读取受控句柄是整文件读取，` +
            '不提供部分读取：读了一半的 pack 解析出来的是错的对象。',
        );
      }
    }
  }

  // ---- 5. 已知降级（不是拒绝） ------------------------------------------
  const warnings: string[] = [
    '.git/config 按策略硬拒绝规则 HD-GIT-CONFIG 不读取；' +
      'core.autocrlf / core.filemode 取不到时按库的默认值处理，实测状态结果不变。',
    'repositoryformatversion 与 extensions.objectformat 写在 .git/config 里，' +
      '因此 sha256 仓库无法在本层识别；它会在解析阶段以 GIT_LAYOUT_UNSUPPORTED 返回。',
  ];

  void root;
  return { ok: true, support: { git_dir: GIT_DIR, warnings } };
}

function unsupported(reason: string, message: string): GitLayoutInspection {
  return { ok: false, code: 'GIT_LAYOUT_UNSUPPORTED', reason, message };
}

/** 存在性探针。`NOT_FOUND` 是"不存在"，其它护栏错误照实抛。 */
async function exists(ops: WinfsOps, scope: ReadScope, rel: string): Promise<boolean> {
  const result = await ops.resolvePath({ ...refOf(scope, rel), expect: 'any' });
  if (isWinfsError(result)) {
    if (result.code === 'NOT_FOUND') return false;
    throw new BridgeError('INTERNAL_ERROR', `${result.message}（护栏码 ${result.code}）`, {
      winfs_code: result.code,
      path: rel,
    });
  }
  return true;
}

async function listOrNull(
  ops: WinfsOps,
  scope: ReadScope,
  rel: string,
): Promise<readonly { name: string; type: 'file' | 'directory'; size: number | null }[] | null> {
  const result = await ops.listDirectory({ ...refOf(scope, rel) });
  if (isWinfsError(result)) {
    if (result.code === 'NOT_FOUND') return null;
    throw new BridgeError('INTERNAL_ERROR', `${result.message}（护栏码 ${result.code}）`, {
      winfs_code: result.code,
      path: rel,
    });
  }
  return result.entries;
}

/**
 * isomorphic-git 在解析阶段抛出的、**确定属于"这个仓库我们读不懂"** 的错误。
 *
 * 只在消息层面判别，因为库没有给这些情形稳定的错误类型：两者都是
 * `InternalError`，区别只在文本。判别词是实测得到的（见证据），
 * 不是在文档里找到的。
 */
const UNSUPPORTED_PARSE_SIGNATURES: readonly { readonly match: RegExp; readonly reason: string; readonly message: string }[] = [
  {
    match: /Unsupported dircache version:\s*(\d+)/,
    reason: 'INDEX_VERSION',
    message: '索引目录缓存版本不受支持（isomorphic-git 只解析版本 2）。',
  },
  {
    match: /Invalid checksum in GitIndex buffer/,
    reason: 'INDEX_UNREADABLE',
    message:
      '索引校验和不匹配：可能是不受支持的对象格式（如 sha256 仓库），也可能是索引损坏。' +
      '两者在 .git/config 不可读时无法区分。',
  },
];

/**
 * 库错误的**错误码**判别。
 *
 * 判据是 `code` 而不是消息文本：文本会随版本变，而每个错误类都在构造函数里
 * 把 `code` 设成自己的类名，那是库的公开契约（`NotFoundError` / `ObjectTypeError`）。
 *
 * 这个联合**是有意收窄的**：每多一个成员，就意味着我们开始对库的又一种失败
 * 做分支处理。加它之前要能说清楚「这一种失败与别的那种**在语义上不同**」——
 * 例如「这个路径在那一侧不存在」与「这个路径在那一侧不是一个普通文件」，
 * 两者对调用方意味着完全不同的事，因此必须分开。
 */
export type GitErrorCode = 'NotFoundError' | 'ObjectTypeError';

export function hasGitCode(error: unknown, code: GitErrorCode): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/**
 * 把库抛出的错误翻译成契约错误。
 *
 * 已经是 `BridgeError` 的（护栏/策略那一层抛的）**原样放行** —— 它有更精确的
 * 语义，包一层只会把「工作区根换了对象」说成「Git 布局不支持」。
 */
export function wrapGitFailure(error: unknown, layout: GitLayoutSupport | null): never {
  if (error instanceof BridgeError) throw error;

  const message = error instanceof Error ? error.message : String(error);
  for (const signature of UNSUPPORTED_PARSE_SIGNATURES) {
    if (signature.match.test(message)) {
      throw new BridgeError('GIT_LAYOUT_UNSUPPORTED', signature.message, {
        reason: signature.reason,
        layout_warning: layout?.warnings.length ?? 0,
      });
    }
  }
  throw new BridgeError('INTERNAL_ERROR', '读取 Git 状态时失败；未返回任何结果。', {
    reason: 'GIT_READ_FAILED',
    caller: (error as { caller?: string }).caller ?? 'unknown',
  });
}
