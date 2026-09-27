/**
 * 本包与护栏之间的**共用边界规则**（LWB-013 抽出，LWB-014 起被 read/list 共用）。
 *
 * ## 为什么这些东西必须只有一份
 *
 * 读取与列举是两条独立的代码路径，但它们对下面这几个问题必须给出**同一个**
 * 答案，否则同一个对象会在两条路径上得到两种结论：
 *
 *  1. 工作区根引用怎么从 `AuthorizedRoot` 变成 `WinfsRootRef`（`refOf`）——
 *     手写 `volume_id: root.volume_id` 的地方，迟早有人写成 `file_id`，
 *     而写错的那个字段是**身份**，不是拼写：一次错误的身份比对会把
 *     「换了个对象」判成「还是同一个」，而两条路径里只要有一条写错就够了。
 *  2. 判决用的是哪个路径（`gatePathFor`）—— 出站闸门按**名字**匹配硬拒绝规则，
 *     而名字必须是磁盘规范拼写（`.env` 的 8.3 短名 `ENV~1` 不命中任何规则）。
 *     读取用规范路径、列举用请求字符串，就会出现「读得到但列不出来」
 *     （或反过来）这种谁也说不清的状态。
 *  3. 护栏错误码怎么映射到契约错误码（`toBridgeError`）—— 映射表分两处，
 *     就会有两套「同一个护栏失败是什么错误」的答案。
 *
 * 这三件事都不是「策略」，而是**边界的一致性**：护栏那边只有一套规则，
 * 我们这边也应当只有一套说法。
 *
 * ## 关于 `expect`
 *
 * 护栏当前的 `resolvePath` **不执行** `expect`（它只打开目标并报告身份），
 * 也就是说「这是不是一个目录」的判断在**本层**。这不是缺陷，是一条需要
 * 写下来的事实：调用方不能把 `expect: 'directory'` 读成「护栏保证了它是目录」，
 * 而必须自己看 `attributes.is_directory`。护栏将来若真的执行 `expect`，
 * 本层已有的检查也不会因此变得多余 —— 它只是从第二个到达的证明。
 */

import { BridgeError } from '@lwb/contracts';
import type { BridgeErrorCode, WorkspaceKind, WorkspaceMode } from '@lwb/contracts';
import type {
  WinfsAttributes,
  WinfsError,
  WinfsErrorCode,
  WinfsFileIdentity,
  WinfsListResult,
  WinfsOps,
  WinfsPathRef,
  WinfsReadResult,
} from '@lwb/winfs';
import { isWinfsError } from '@lwb/winfs';

// ---------------------------------------------------------------------------
// 作用域
// ---------------------------------------------------------------------------

/**
 * 工作区根的**路径 + 物理身份**，加上调用方拿不到的那几个事实。
 *
 * 字段命名刻意与 `WinfsRootRef` 对齐（`root_volume_id`/`root_file_id`）：
 * 两者之间只应该有一次转换，而且那一次转换必须写在一个地方（`refOf`）。
 */
export interface ReadScope {
  readonly workspace_id: string;
  readonly kind: WorkspaceKind;
  readonly mode: WorkspaceMode;
  readonly generation: number;
  readonly root_path: string;
  readonly root_volume_id: string;
  readonly root_file_id: string;
}

/**
 * `WorkspaceRegistry.authorizeAccess()` 返回值中本包用得到的那部分。
 *
 * 声明成结构类型而不是 import `AuthorizedRoot`，是为了让「授权通道」这件事
 * 保持在 `@lwb/workspaces` 里：本包只消费它的**结果**，不引入对登记表的依赖。
 */
export interface AuthorizedRootLike {
  readonly workspace_id: string;
  readonly kind: WorkspaceKind;
  readonly mode: WorkspaceMode;
  readonly generation: number;
  readonly root_path: string;
  readonly volume_id: string;
  readonly file_id: string;
}

export function readScopeOf(root: AuthorizedRootLike): ReadScope {
  return {
    workspace_id: root.workspace_id,
    kind: root.kind,
    mode: root.mode,
    generation: root.generation,
    root_path: root.root_path,
    root_volume_id: root.volume_id,
    root_file_id: root.file_id,
  };
}

/** 工作区根引用。**唯一**一处从 `ReadScope` 取出 `WinfsRootRef` 的地方。 */
export function refOf(scope: ReadScope, relativePath: string): WinfsPathRef {
  return {
    root_path: scope.root_path,
    // 顺序在此固定：`root_volume_id` 取 `scope.root_volume_id`，
    // 不是 `root_file_id` —— 两者都是十六进制字符串，写反了不会报错，
    // 只会在某次「换了对象」时比对通过。
    root_volume_id: scope.root_volume_id,
    root_file_id: scope.root_file_id,
    relative_path: relativePath,
  };
}

// ---------------------------------------------------------------------------
// 判决路径
// ---------------------------------------------------------------------------

/**
 * 规范路径的**存在性**检查。**永远返回非 null 的字符串**（可能是空串）。
 *
 * `null` 的处理是**拒绝**，不是回退：护栏拿不到规范路径意味着它无法证明目标
 * 在根之下（`WinfsReadResult.canonical_relative_path` 的注释写明了
 * 「调用方不得退回使用 relative_path 充当规范路径」）。
 *
 * `== null` 而不是 `=== null`：类型上这里只有 `string | null`，但护栏实现
 * 是外部边界，一个漏报该字段的实现会给出 `undefined`。两者的含义完全相同
 * ——「无法证明目标在根之下」—— 因此都拒绝。**`''` 不在此列**：空串是
 * 「目标就是工作区根」的合法拼写。
 */
export function requireCanonicalPath(canonical: string | null | undefined): string {
  if (canonical == null) {
    throw new BridgeError(
      'PATH_UNSAFE',
      '护栏无法证明目标位于工作区根之下（取不到句柄规范路径）；已拒绝，不会退回使用请求里的字符串。',
      { reason: 'NO_CANONICAL_PATH' },
    );
  }
  return canonical;
}

/**
 * **读取**的判决路径。**永远非空。**
 *
 * 空串在这里意味着「要读的就是工作区根」，而根在目录工作区里是一个目录：
 * 拒绝，而不是把它当成某个文件开始读。这条拒绝由读取的验收测试锁定
 * （`EMPTY_PATH_FOR_DIRECTORY_WORKSPACE`），不要为了让列举好写而放宽它。
 */
export function gatePathFor(scope: ReadScope, canonical: string | null | undefined): string {
  const path = requireCanonicalPath(canonical);
  if (path !== '') return path;

  if (scope.kind !== 'file') {
    throw new BridgeError('PATH_UNSAFE', '目录工作区的相对路径不应为空；已拒绝。', {
      reason: 'EMPTY_PATH_FOR_DIRECTORY_WORKSPACE',
    });
  }
  return rootNameOf(scope);
}

/**
 * **列举**的判决路径。与 `gatePathFor` 只差一处：基准就是根时不当错误。
 *
 * 列举根是目录列举最主要的用法，而空串不命中任何按名字匹配的硬拒绝规则 ——
 * 也就是说，直接拿空串去过闸门会**永远通过**，连「根目录自己叫 `.env`」
 * 这种情形也判不出来。所以基准是根时换成根对象自己的名字，闸门才看得到
 * 它在判什么。读取侧不能这么做（见上），列举侧不能不做 —— 两者的差别不是
 * 宽容度不同，而是**它们问的是不是同一个问题**：
 *
 *  - 读取问「我要读的这个**文件**叫什么名字」——根在目录工作区里不是文件；
 *  - 列举问「我要枚举的这个**基准**叫什么名字」——根永远有一个名字。
 */
export function baseGatePathFor(scope: ReadScope, canonical: string | null | undefined): string {
  const path = requireCanonicalPath(canonical);
  if (path !== '') return path;
  return rootNameOf(scope);
}

/** 工作区根的**磁盘名字**，从注册时记下的绝对路径取。取不到就拒绝。 */
function rootNameOf(scope: ReadScope): string {
  const name = basenameOfAbsolute(scope.root_path);
  if (name.length === 0) {
    throw new BridgeError('PATH_UNSAFE', '无法从工作区根路径取出文件名；已拒绝。', {
      reason: 'UNRESOLVABLE_ROOT_BASENAME',
    });
  }
  return name;
}

/**
 * 绝对路径的最后一段。**只用于单文件工作区的根**（`gatePathFor` 与列举的
 * 单文件分支），因为那是唯一一个「没有相对路径却需要一个名字」的地方。
 *
 * 它不做任何规范化：返回的就是调用方给的字符串里最后那一段。
 * 目录工作区里的名字一律来自护栏的目录扫描，不走这里 —— 那里的名字
 * 是与磁盘一致的拼写。
 */
export function basenameOfAbsolute(absolute: string): string {
  const cut = Math.max(absolute.lastIndexOf('\\'), absolute.lastIndexOf('/'));
  return cut === -1 ? absolute : absolute.slice(cut + 1);
}

// ---------------------------------------------------------------------------
// 护栏答复的形态与错误
// ---------------------------------------------------------------------------

export interface GuardTarget {
  /** 磁盘规范拼写（`/` 分隔）；单文件工作区的根为 `''`；取不到时为 `null`。 */
  readonly canonical_path: string | null;
  readonly identity: WinfsFileIdentity;
  readonly size: number;
  readonly attributes: WinfsAttributes;
}

/**
 * `resolvePath` 的返回类型是「读结果 | 列举结果」的联合，而当前后端只产出
 * 读形状的那一支。这里用一个显式的形状检查而不是 `as`：一个「假设它一定是
 * 读结果」的断言在护栏换实现之后不会报错，只会静默地读到一个不存在的字段
 * （`canonical_relative_path` 曾经就是这样漏掉的）。
 */
export function isReadShaped(result: WinfsReadResult | WinfsListResult): result is WinfsReadResult {
  return 'identity' in result;
}

/**
 * 护栏错误 → 契约错误码。
 *
 * 有两处刻意**不映射**，因为给一个听起来合理的码会把调用方引向错误的方向：
 *
 *  - `PERMISSION_DENIED`：契约里没有 ACL 拒绝的等价码。`PATH_UNSAFE` 的语义是
 *    「路径或身份不安全，不会降级」，而这里路径没问题，是权限不够；
 *    `POLICY_DENIED` 更不对 —— 那意味着本地策略拒绝，用户去改策略是白费功夫。
 *    落到 `INTERNAL_ERROR` 并在 details 里带上 `winfs_code`，比编一个码诚实。
 *  - `IO_ERROR` / `VOLUME_UNSUPPORTED`：同上，环境问题，不是判定问题。
 *
 * `ROOT_IDENTITY_MISMATCH` 是例外，它有精确的契约等价物：工作区根换了对象，
 * 那么该工作区的所有代次、票据与批准都已失效。
 */
export function toBridgeError(error: WinfsError): BridgeError {
  const mapped = WINFS_TO_BRIDGE[error.code] ?? 'INTERNAL_ERROR';
  return new BridgeError(mapped, `${error.message}（护栏码 ${error.code}）`, {
    winfs_code: error.code,
    win32_error: error.win32_error,
  });
}

const WINFS_TO_BRIDGE: Partial<Record<WinfsErrorCode, BridgeErrorCode>> = {
  PATH_UNSAFE: 'PATH_UNSAFE',
  LINK_UNSUPPORTED: 'LINK_UNSUPPORTED',
  NOT_FOUND: 'NOT_FOUND',
  FILE_BUSY: 'FILE_BUSY',
  NATIVE_GUARD_UNAVAILABLE: 'NATIVE_GUARD_UNAVAILABLE',
  FILE_VERSION_CONFLICT: 'FILE_VERSION_CONFLICT',
  ROOT_IDENTITY_MISMATCH: 'WORKSPACE_GENERATION_CHANGED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
};

/**
 * 把一个**游标里的锚点路径**拆成相对起点目录的路径段（LWB-014 起为列举与搜索共用）。
 *
 * ## 为什么这件事必须只有一份实现
 *
 * 两个调用方（列举游标、搜索游标）拿到的是同一种东西：一段由**签名载荷**
 * 提供的路径，用来决定「从哪里接着走」。签名保证它没被改过，但签名不保证
 * 它的**形态**是我们愿意拿去拼路径的那种形态 —— 而两处各写一遍 `..` 检查，
 * 迟早在某一处漏掉某个分支，那时两条路径对同一个游标给出两种结论：
 * 一条拒绝，另一条照走。而「照走」的那条会把遍历带到起点目录之外。
 *
 * 因此这里返回**判定结果**而不是抛错：判断只有一份，而「拒绝时说什么话」
 * 属于各自的调用点（`CURSOR_ANCHOR_UNUSABLE` / `CURSOR_RESUME_UNUSABLE`）。
 *
 * ## 拒绝的四类，每一类都对应一次具体的越界
 *
 *  - **锚点为空**：空锚点在列举侧意味着「起点目录自己」，而调用方检查这一条
 *    时手上并没有「起点是不是文件工作区」的信息；
 *  - **不在起点目录之下**：前缀比对本该由签名保证，这里再判一次是把
 *    「不可能」变成一次明确的拒绝，而不是让一段外来字符串参与拼路径；
 *  - **就是起点目录自己**：`rest === ''` 意味着锚点等于起点 —— 那样续读会
 *    从起点重来，而结果看起来像是「接着上次的」，实际是重复一遍；
 *  - **段为空 / `.` / `..`**：它们能让拼出来的路径落到起点目录之外。
 */
export type CursorAnchorSegments =
  | { readonly ok: true; readonly segments: readonly string[] }
  | { readonly ok: false; readonly why: string };

export function cursorAnchorSegments(basePath: string, anchorPath: string): CursorAnchorSegments {
  if (anchorPath === '') return { ok: false, why: '锚点是空路径' };

  let rest: string;
  if (basePath === '') {
    rest = anchorPath;
  } else if (anchorPath.startsWith(`${basePath}/`)) {
    rest = anchorPath.slice(basePath.length + 1);
  } else {
    return { ok: false, why: '锚点不在起点目录之下' };
  }

  if (rest === '') return { ok: false, why: '锚点就是起点目录本身' };

  const segments = rest.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return { ok: false, why: '锚点路径段不合法' };
    }
  }
  return { ok: true, segments };
}

/** 把路径段拼回一个相对路径。与 `cursorAnchorSegments` 配对使用。 */
export function joinRelativePath(basePath: string, segments: readonly string[]): string {
  const tail = segments.join('/');
  if (basePath === '') return tail;
  return tail === '' ? basePath : `${basePath}/${tail}`;
}

/**
 * 只取身份与尺寸的探针。**不读内容，也不判策略。**
 *
 * 两个调用方（读取、列举）都用它来回答「我要碰的这个对象是哪一个」，
 * 而把「多大算太大」和「它该不该是目录」留给各自的调用点 ——
 * 前一问对列举没有意义（列目录不会把内容读进内存），后一问对读取没有意义。
 */
export async function resolveTarget(
  ops: WinfsOps,
  scope: ReadScope,
  path: string,
  expect: 'file' | 'directory' | 'any',
): Promise<GuardTarget> {
  const result = await ops.resolvePath({ ...refOf(scope, path), expect });
  if (isWinfsError(result)) throw toBridgeError(result);
  if (!isReadShaped(result)) {
    throw new BridgeError(
      'INTERNAL_ERROR',
      '护栏对该路径返回了非目标形态的结果；已拒绝继续操作。',
      { reason: 'PROBE_NOT_TARGET_SHAPED', expect },
    );
  }
  return {
    canonical_path: result.canonical_relative_path,
    identity: result.identity,
    size: result.size,
    attributes: result.attributes,
  };
}
