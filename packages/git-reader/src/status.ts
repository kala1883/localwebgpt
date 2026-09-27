/**
 * `git_status`（LWB-016，契约 `packages/contracts/src/git.ts`）。
 *
 * ## 四步，每一步都在上一步成立之后
 *
 *  1. **起飞前检查**（`preflight.ts`）：工作区形态、路径、`.git` 内部路径、
 *     布局。四条都只需要护栏往返或纯路径运算，因此都排在碰库之前。
 *  2. **探针 + 预检**：拿到基准的规范拼写与身份，然后问闸门「这个基准有没有
 *     资格往外走内容」。载荷为空，因此不消耗出站预算。
 *  3. **一次 `statusMatrix`**，`refresh:false` + `ignored:false` 两个开关都
 *     写死在这里，而底层 fs 根本没有写通道（`meta-fs.ts`）。
 *  4. **结果后处理**：库给出的行**不能直接当结果** —— 见下。
 *
 * ## 为什么后处理是必须的，而不是「库应该已经处理好了」
 *
 * `statusMatrix` 的遍历是三棵树求并集（HEAD / WORKDIR / STAGE）。一个**被
 * 跟踪**的 `.env` 在 HEAD 与 STAGE 里都是 blob，于是库内部那句
 * `if ((workdirType === 'tree' || workdirType === 'special') && !isBlob) return`
 * 不成立（`isBlob` 看的是三棵树**之一**），它照样会排出一行 `[1, 0, 3]` ——
 * 读作「工作区里被删了」。那不是事实，是我们没读。
 *
 * `meta-fs.ts` 能给的是「不去读它」，给不了「它不出现在结果里」，因为判据
 * 不同：前者问库要什么，后者问策略让不让说。所以这一层必须按**同一份规则表**
 * 再过一遍。
 *
 * ## 两处判定，各自认领自己的账
 *
 * 「被摘掉的路径有几个」这个问题有两个来源，而它们**不能相加**：
 *
 *  - 库**问过**但策略不让读的（`meta.policyHiddenPaths()`）—— 这是完整的集合。
 *    一次未被跟踪的 `.env` 是在目录列举里被摘掉的，它**从来没有变成一行**，
 *    因此任何只看结果的计数都会漏掉它；
 *  - 库**排出**却命中了策略或秘密筛查的行 —— 这是上一条的兜底。
 *
 * 所以计数取自 fs 层的账本（它看见每一次询问），而这一层的逐行复核只做
 * 「这一行不能出现」这一件事：**不共用代码路径**（`classifyFile` 是纯函数，
 * 两次调用的答案必然一致，但「有没有调用」是两件事）。复核若发现账本里
 * 没有的行，说明两层看见的范围不同，此时并进同一个集合 —— 只计数，不回显名字。
 *
 * ## 出站：状态结果不按内容记账
 *
 * `git_status` 的载荷是**一组路径**，而路径在本项目里**从不由内容闸门记账**：
 * `file_list` 也不记（`packages/files/src/list.ts` 只有一次空载荷预检，
 * 名字逐条走 `screenText`）。两条路径必须一致，否则同一个文件在两个工具里
 * 一个有额度一个没额度。于是这里的做法与它同形：空载荷预检一次（判基准），
 * 然后逐条筛查路径。
 *
 * 判据比 `file_list` 粗一档：那边筛**名字**（basename），这里筛**完整相对
 * 路径**。多出来的部分是目录名 —— 同一个文件在 `file_list` 里被它的父目录
 * 挡掉，在这里由路径自己挡掉，归宿相同、判据不同。粗一档只会多摘不会漏摘，
 * 而多摘是计数的、可见的。
 *
 * `git_diff` 不同：那里的载荷是**文件内容**，因此两侧都经 `emitContent`
 * 出站（`diff.ts`）。区别不是宽容度，而是问的**是不是同一个问题**。
 */
import { BridgeError } from '@lwb/contracts';
import type { GitStatusData, GitStatusEntry, GitStatusExclusion, GitStatusInput } from '@lwb/contracts';
import type { EgressBudget } from '@lwb/egress';
import { emitContent, mintClearance, screenText } from '@lwb/egress';
import type { ReadScope } from '@lwb/files';
import { baseGatePathFor } from '@lwb/files';
import type { FileRule, PolicyDecision } from '@lwb/policy';
import { classifyFile } from '@lwb/policy';
import type { WinfsOps } from '@lwb/winfs';
import type { StatusRow } from 'isomorphic-git';
import { currentBranch, resolveRef, statusMatrix } from 'isomorphic-git';

import { inspectLayoutOrThrow, isGitInternalPath, probeDirectory, requireDirectoryWorkspace, requireNotGitInternal, assertReadOnlyLedger, descends } from './preflight.ts';
import type { GitLayoutSupport } from './layout.ts';
import { hasGitCode, wrapGitFailure } from './layout.ts';
import type { GitLimits } from './limits.ts';
import { gitLimitsOf } from './limits.ts';
import type { MetaFs } from './meta-fs.ts';
import { byUtf8Bytes, createMetaFs } from './meta-fs.ts';

export type { StatusRow };

// ---------------------------------------------------------------------------
// 依赖与入参
// ---------------------------------------------------------------------------

export interface GitDeps {
  /** 受控句柄后端（生产上是 `@lwb/winfs`）。**本包不直接接触文件系统。** */
  readonly ops: WinfsOps;
  readonly budget: EgressBudget;
  /** 本地操作者收紧后的限额；省略即用 `DEFAULT_GIT_LIMITS`。 */
  readonly limits?: Partial<GitLimits>;
}

export interface GitStatusArgs {
  readonly scope: ReadScope;
  /** 本次调用所属的连接，来自凭据。 */
  readonly connection_id: string;
  /** daemon 对本次查询的判定结果。必须由 `@lwb/policy` 的 `decide()` 产出。 */
  readonly decision: PolicyDecision;
  readonly input: GitStatusInput;
}

// ---------------------------------------------------------------------------
// 行解码
// ---------------------------------------------------------------------------

/**
 * isomorphic-git 的一行：`[path, HEAD, WORKDIR, STAGE]`。
 *
 * **三个数字都不是布尔值，而是「该值在数组里第一次出现的下标」。**
 * 库的编码是 `[undefined, headOid, workdirOid, stageOid].map(v => entry.indexOf(v))`，
 * 去掉首位之后：
 *
 *  - `HEAD`    ∈ {0 不存在, 1 存在}
 *  - `WORKDIR` ∈ {0 不存在, 1 与 HEAD 相同, 2 与 HEAD 不同}
 *  - `STAGE`   ∈ {0 不存在, 1 与 HEAD 相同, 2 与 WORKDIR 相同, 3 与两者都不同}
 *
 * 把它读成布尔是这类代码最常见的错法：`[1,2,1]` 里的「2」既不表示
 * "true 两次"，也不表示「未跟踪」，它表示「工作区与 HEAD 不同」。
 */

/**
 * 24 种编码里**实际可能出现**的 15 种。
 *
 * 判定方式是穷举而不是直觉：把三棵树「存在 / 不存在、相等 / 不等」的
 * 全部组合写出来，逐个投影到这三个下标上。9 种组合在编码上不可达
 * （例如 `[1,1,2]`：`WORKDIR=1` 要求 `W === H`，而 `STAGE=2` 要求
 * `S === W` 且 `S ≠ H`，两者合起来是 `S === H` 与 `S ≠ H`，互斥）。
 */
const POSSIBLE_ROWS: ReadonlySet<string> = new Set([
  '0,0,0', // 三棵树都没有 —— 不会产生行，列在这里是为了让这张表**完整**
  '0,0,3', // AD 索引有、工作区没有
  '0,2,0', // ?? 未跟踪
  '0,2,2', // A  新文件已暂存，工作区与索引一致
  '0,2,3', // AM 新文件已暂存，工作区又改了
  '1,0,0', // D  索引里删了、工作区也没有
  '1,0,1', //  D 只删了工作区（索引与 HEAD 一致）
  '1,0,3', // MD 索引改了、工作区删了
  '1,1,0', // D + ?? 索引里删了（或从未加入），文件仍在磁盘上
  '1,1,1', //    干净
  '1,1,3', // MM 索引改了、工作区同 HEAD
  '1,2,0', // D + ?? 索引里删了，磁盘上有一份不同的
  '1,2,1', //  M 只改了工作区
  '1,2,2', // M  只改了索引（工作区与索引一致）
  '1,2,3', // MM 索引改了、工作区又改了
]);

export interface DerivedRow {
  readonly path: string;
  readonly head: GitStatusEntry['head'];
  readonly worktree: GitStatusEntry['worktree'];
}

/**
 * 一行状态 → `{head, worktree}`。
 *
 * 两条规则：
 *  - `head` 问的是「HEAD 与索引」：`headOid` 缺 = `absent`（索引也没有）
 *    或 `added`（索引有），`stageOid` 缺 = `deleted`，两者都有则比 `STAGE`
 *    下标是不是 1。
 *  - `worktree` 问的是「索引与工作区」：`stageOid` 缺（`STAGE=0`）说明
 *    索引不认识这个路径 —— 工作区有就是 `untracked`，没有就是 `absent`；
 *    索引认识时，`WORKDIR=0` 是 `deleted`，`WORKDIR === STAGE` 是
 *    `unmodified`，否则 `modified`。
 *
 * ## 不可能的组合**报错**，不猜
 *
 * 那 9 种组合出现的**唯一**原因是库的编码变了。那时按现在的规则算出来的
 * 会是一条**看起来正常的错状态**，而错状态比报错危险得多 —— 所以这里抛错。
 *
 * 错误里**不带路径**，只带那三个数字。理由是这个分支的前提正是「我们对库的
 * 理解已经不成立了」；既然前提都不成立，就不能再假设这一行里的路径是
 * 一条可以回显的路径（被硬拒绝的路径连名字都不该出现）。
 * 路径留在本地账本里，模型只看得到「有 N 条结果因此没有返回」。
 */
export function deriveRow(row: StatusRow): DerivedRow {
  const [path, h, w, s] = row;
  if (!POSSIBLE_ROWS.has(`${h},${w},${s}`)) {
    throw new BridgeError(
      'INTERNAL_ERROR',
      `底层库返回了不可能的 statusMatrix 组合 [${h},${w},${s}]；本次结果不可信，已拒绝返回。`,
      { reason: 'UNEXPECTED_STATUS_ROW', combo: `${h},${w},${s}` },
    );
  }
  return { path, head: deriveHead(h, s), worktree: deriveWorktree(w, s) };
}

/** 工作区与索引的关系。`STAGE` 是「索引指向哪一份内容」。 */
function deriveWorktree(w: number, s: number): GitStatusEntry['worktree'] {
  if (s === 0) return w === 0 ? 'absent' : 'untracked';
  if (w === 0) return 'deleted';
  if (w === s) return 'unmodified';
  return 'modified';
}

/** HEAD 与索引的关系。`HEAD=0` 表示 HEAD 里没有这个路径。 */
function deriveHead(h: number, s: number): GitStatusEntry['head'] {
  if (h === 0) return s === 0 ? 'absent' : 'added';
  if (s === 0) return 'deleted';
  if (s === 1) return 'unmodified';
  return 'modified';
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function gitStatus(args: GitStatusArgs, deps: GitDeps): Promise<GitStatusData> {
  const limits = gitLimitsOf(deps.limits);
  const { scope, connection_id, decision, input } = args;

  if (decision.context.workspace_id !== scope.workspace_id) {
    throw new BridgeError('INVALID_ARGUMENT', '判定结果与本次查询的工作区不一致；拒绝执行。', {
      reason: 'DECISION_SCOPE_MISMATCH',
    });
  }
  requireDirectoryWorkspace(scope);
  const requestPath = input.path ?? '';
  requireNotGitInternal(requestPath);

  // ---- 探针 → 预检 → 布局 ------------------------------------------------

  const base = await probeDirectory(deps.ops, scope, requestPath);
  const clearance = mintClearance(decision, { connection_id, generation: scope.generation });
  const baseGatePath = baseGatePathFor(scope, base.canonical);
  // 预检：一个字节都还没读，先问闸门「这个基准有没有资格往外走内容」。
  // 载荷为空，因此这次调用不消耗任何出站预算（记账按实际出站字节数）。
  emitContent(clearance, { path: baseGatePath, content: '' }, deps.budget);

  const layout = await inspectLayoutOrThrow(deps.ops, scope, limits);

  const meta = createMetaFs({
    ops: deps.ops,
    scope,
    rules: clearance.rules,
    limits: {
      max_git_internal_file_bytes: limits.max_git_internal_file_bytes,
      max_worktree_file_bytes: limits.max_worktree_file_bytes,
      max_worktree_read_bytes: limits.max_worktree_read_bytes,
    },
  });

  // `filepaths` 用的是**规范相对路径**（根为空串 → `'.'`）。库的
  // `worthWalking()` 按路径段边界匹配，因此 `'src'` 不会把 `src2/` 拉进来。
  const filepaths = base.canonical === '' ? ['.'] : [base.canonical];

  const probe = await queryRepo(meta, scope.root_path, filepaths, layout);

  // 「库出现未预期写入就失败」。写在库调用**之后**：账本要先有东西可看。
  assertReadOnlyLedger(meta);

  return assemble({
    rules: clearance.rules,
    layout,
    meta,
    probe,
    maxEntries: limits.max_status_entries,
    requestPath: base.canonical,
  });
}

// ---------------------------------------------------------------------------
// 库调用
// ---------------------------------------------------------------------------

interface RepoProbe {
  readonly rows: readonly StatusRow[];
  readonly branch: string | null;
  readonly head_commit: string | null;
}

/**
 * 一次 `statusMatrix` + 两次 ref 解析。
 *
 * 整个包在**一个** try 里：三次调用共用同一份只读 fs 与同一份缓存，
 * 任何一次失败都意味着「这次探测没有完成」，没有理由把它们的失败区别对待。
 */
async function queryRepo(
  meta: MetaFs,
  dir: string,
  filepaths: readonly string[],
  layout: GitLayoutSupport,
): Promise<RepoProbe> {
  try {
    const rows = await statusMatrix({
      fs: meta.client,
      dir,
      ref: 'HEAD',
      filepaths: [...filepaths],
      // 只读的**两个**开关，缺一不可：
      //  - `refresh:false` 关掉索引 stat 缓存回写（那会重写 .git/index，
      //    而它的默认值是 true）；
      //  - `ignored:false` 关掉 ignore 走查，因为 `ignored:true` 会让工作区
      //    遍历**进入 `.git/`** 并返回 `.git/**`（实测）。代价是被忽略的文件
      //    不出现在结果里，契约的 `GitFileStatus` 因此没有 `ignored`。
      refresh: false,
      ignored: false,
    });

    // `currentBranch` 在 detached HEAD 上返回 undefined，在未出生的分支上
    // 返回分支名 —— 与 `git status` 的说法一致，因此不需要额外处理。
    const branch = (await currentBranch({ fs: meta.client, dir, fullname: false })) ?? null;

    // HEAD 解析不出来**是正常状态**（空仓库），不是失败。判据用库自己的
    // 错误码而不是消息文本：文本会随版本变，错误码是库的公开契约。
    let head_commit: string | null;
    try {
      head_commit = await resolveRef({ fs: meta.client, dir, ref: 'HEAD' });
    } catch (error) {
      if (hasGitCode(error, 'NotFoundError')) head_commit = null;
      else throw error;
    }

    return { rows, branch, head_commit };
  } catch (error) {
    wrapGitFailure(error, layout);
  }
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

function assemble(ctx: {
  rules: readonly FileRule[];
  layout: GitLayoutSupport;
  meta: MetaFs;
  probe: RepoProbe;
  maxEntries: number;
  /** 本次请求的规范相对路径（`''` = 整个工作区）。 */
  requestPath: string;
}): GitStatusData {
  const { rules, meta, probe, maxEntries, requestPath } = ctx;

  /**
   * 账本里只有**这次问到的范围**内的路径才算数。两条筛法各有理由：
   *
   *  - `descends` —— `_walk` 在 `map` 之前就对每个兄弟节点调过 `readdir`，
   *    因此「读一眼 `secrets/` 的目录」这件事会发生，哪怕问的只是 `src`。
   *    那些路径不在用户的视野里，不该计入「你的范围里被摘掉几条」。
   *  - `!isGitInternalPath` —— `.git/config` 是**我们内部解析**想读的东西，
   *    从来不是用户可见的路径（见 `preflight.ts` 的长注释）。
   */
  const inScope = (path: string): boolean => !isGitInternalPath(path) && descends(requestPath === '' ? '.' : requestPath, path);

  // 账本取自 fs 层：它看见每一次询问，因此**包括**那些从来没变成一行的路径
  // （未被跟踪的 `.env` 是在目录列举里被摘掉的）。只计数，不回显名字。
  const policyHidden = new Set(meta.policyHiddenPaths().filter(inScope));
  let policyHiddenCount = policyHidden.size;

  const exclusions = meta.exclusions().filter((e) => inScope(e.path));
  const notComparable = new Set(exclusions.map((e) => e.path));
  const entries: GitStatusEntry[] = [];

  for (const row of probe.rows) {
    const derived = deriveRow(row);
    if (derived.path === '' || derived.path === '.') continue;

    // 兜底复核。fs 层保证「不读」，这里保证「不报」—— 见文件头。
    if (classifyFile(derived.path, rules).kind === 'hard_deny') {
      if (!policyHidden.has(derived.path)) {
        policyHidden.add(derived.path);
        policyHiddenCount += 1;
      }
      continue;
    }
    // 名字本身就是秘密的情形（有人把令牌粘成了文件名）。与 `file_list` 同一条：
    // 只筛 certain 档，且只留下一个计数。
    if (screenText(derived.path).has_certain) {
      policyHiddenCount += 1;
      continue;
    }
    // 没能比对的路径不进 entries —— 它由 `excluded` 单独如实说明。
    if (notComparable.has(derived.path)) continue;

    entries.push({ path: derived.path, head: derived.head, worktree: derived.worktree });
  }

  entries.sort((a, b) => byUtf8Bytes(a.path, b.path));
  const truncated = entries.length > maxEntries;

  const visibleExcluded = exclusions.slice(0, maxEntries);
  const excludedTruncated = exclusions.length > maxEntries;

  return {
    branch: probe.branch,
    head_commit: probe.head_commit,
    entries: truncated ? entries.slice(0, maxEntries) : entries,
    truncated,
    excluded: visibleExcluded,
    excluded_truncated: excludedTruncated,
    policy_hidden_count: policyHiddenCount,
    limited_to_authorized_paths: true,
    layout_warning: ctx.layout.warnings.length === 0 ? null : ctx.layout.warnings.join('；'),
  };
}
