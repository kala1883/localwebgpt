/**
 * `git_diff`（LWB-016，契约 `packages/contracts/src/git.ts`）。
 *
 * ## 两侧各用**合适的**机制取，而不是同一种
 *
 * | 比较 | 旧侧 | 新侧 |
 * |---|---|---|
 * | `head_vs_worktree`（默认） | `resolveRef('HEAD')` → `readBlob({oid, filepath})` | 受控句柄整文件读取 |
 * | `index_vs_worktree` | `walk({trees:[STAGE()]})` → `oid()` → `readBlob({oid})` | 同上 |
 * | `head_vs_index` | 同第一行 | 同第二行 |
 *
 * 两件事决定了这张表：
 *
 *  1. **索引侧没有按路径取内容的路。** `GitWalkerIndex.content()` 返回
 *     `undefined`，而库的公开导出里没有任何「给我索引里这个路径的 blob」
 *     接口。唯一可用的机制是走一遍 `STAGE()` 遍历，拿到 `entry.oid()`，
 *     再用那个 oid 读对象。
 *  2. **HEAD 侧有一条更窄的路。** `readBlob({oid: <HEAD 提交>, filepath})`
 *     只读这条路径沿途的各级 tree，不遍历整棵树；而 `TREE({ref:'HEAD'})`
 *     的遍历会 `readdir` 到沿途每一个兄弟目录。
 *
 * 由此得到一条可以直说的结论：**每一次对象读取的 oid，都来自我们刚走完的
 * 那棵树，或者 HEAD 的提交 id**。契约 `GitDiffInput` 里只有
 * `workspace_id` / `path` / `comparison` 三个字段 —— 没有、也不会有哪个字段
 * 能让模型指定一个 raw object ID。
 *
 * ### 只有索引侧需要遍历，而遍历的剪枝判据有个陷阱
 *
 * 见 `descends()`：根节点的 `filepath` 是 `'.'`，按「前缀」判会把整棵树在
 * 第一步剪掉，而结果是「什么都没有」—— 与「索引里没有这个路径」长得一样。
 *
 * ## 工作区侧必须存在，三种比较都一样
 *
 * 这是 V1 的一条**明确的限制**，不是遗漏：路径安全在本项目里按「实际打开的
 * 对象」判（I05），而「一个不存在的东西」没有身份可以证明。若只凭字符串去
 * HEAD 里找同名路径，就等于开出第二条只按字符串授权的通路 —— 正是 I05 要
 * 关掉的那条。于是**已删除的文件用 `git_status` 看**（它会说 `deleted`），
 * 不用 `git_diff` 看。探针顺带给出该文件的字节数，因此「这个文件大到不值得
 * 比」可以在读之前就判掉。
 *
 * ## 字节语义：原始字节，不套 Git 的换行/属性规则
 *
 * 两侧都是**磁盘/对象里的原始字节**：sha256 算在原始字节上，文本差异由原始
 * 字节解码而来。`core.autocrlf` 与 `.gitattributes` 的 filter 一律不套 ——
 * 它们要读 `.git/config`（策略硬拒绝规则 `HD-GIT-CONFIG`）与属性文件。
 * 于是「工作区里的 CRLF、HEAD 里的 LF」在这里是一处**真实的字节差异**，
 * 而 `git diff` 可能什么都不显示。这句话必须出现在结果的 `note` 里：
 * 它不是一个可以靠调用方自己猜出来的性质。
 *
 * ## 拒绝，而不是降级
 *
 *  - 任一侧是二进制 / 非 UTF-8 → `binary: true`，**没有 hunk**（有 hunk 才是
 *    奇怪的事：那意味着我们编了一段文本差异）。原因是**闭集里的原因码**，
 *    不是文件里的字节 —— 被拒绝的字节同样是字节。
 *  - 任一侧超过 `max_diff_bytes` → **抛错**。返回「没有 hunk + truncated」
 *    会让「读不动所以没比」看起来与「比过了，没变」一模一样。
 *  - 任一侧在 Git 里不是普通文件（目录 / 子模块）→ 抛错。
 *  - 文件在两次打开之间被换掉（身份不一致）→ `FILE_VERSION_CONFLICT`（I03）。
 *
 * ## 出站：先整批预筛，再逐个 hunk 过闸门
 *
 * 闸门（`@lwb/egress` 的 `emitContent`）是**每一个外发字节**的权威：
 * 它重新判路径、重新筛内容、按需脱敏、记账。但预筛不能省，因为：
 *
 *  1. 预筛要排在出站**之前**，否则一个在第 N 个 hunk 才发现的凭证会让前
 *     N-1 个已经吃掉出站预算 —— 而整次调用失败，模型一个字节都没拿到。
 *     额度不该为一次被拦下的调用付费（`scan.ts` 是同一条）。
 *  2. 预筛与闸门筛的**不是同一个字符串**：hunk 是要发出去的**片段**，它带
 *     `-`/`+`/` ` 前缀，而 `\b` 在片段起点成立（`scan.ts` 实测：`XAKIA…`
 *     整段不匹配，从 `AKIA` 起切的片段匹配）。片段的判定推不出整份文本的
 *     判定，反之亦然。
 *
 * **不筛的是"我们自己的产物"**：例如把所有 hunk 连起来之后恰好跨过 hunk
 * 边界形成的一个串。它不在文件里，是我们的输出格式造出来的；真正会发出去的
 * 是每个 hunk 自己，而它已经过闸门。写在这里是为了它是**被决定过**的。
 *
 * 同理，**没有单独对两侧原始文本做整份筛查**：没有被改到的行根本不进 hunk，
 * 因此一个位于未改动区域的凭证**既不外泄、也不阻断**（`file_read` 在同一个
 * 文件上也是这个结论）。多筛一遍不会多拦住一个字节，只会把「没差异」变成
 * 「失败」—— 那是在降级，不是在收紧。
 *
 * ## 因此这里没有 `policy_hidden_count` 这样的字段
 *
 * `git_status` 需要一个计数，因为那里确实存在「被摘掉且不说」的路径。这里
 * 不会有：被硬拒绝的路径在**探针之前**就失败，秘密命中的整次失败，两侧都
 * 没有文本差异的情形由 `binary` / `truncated` 如实说明。一句话：这个工具
 * **不静默丢弃任何东西**，所以没有需要计数的东西。
 */
import { createHash } from 'node:crypto';

import { BridgeError } from '@lwb/contracts';
import type { GitDiffComparison, GitDiffData, GitDiffHunk, GitDiffInput } from '@lwb/contracts';
import type { Clearance, EgressBudget } from '@lwb/egress';
import { emitContent, mintClearance, screenText } from '@lwb/egress';
import type { ByteRejectionReason, ReadScope } from '@lwb/files';
import { baseGatePathFor, inspectBytes } from '@lwb/files';
import type { PolicyDecision } from '@lwb/policy';
import { classifyFile } from '@lwb/policy';
import { readBlob, resolveRef, STAGE, walk } from 'isomorphic-git';

import type { GitLayoutSupport } from './layout.ts';
import { hasGitCode, wrapGitFailure } from './layout.ts';
import { gitLimitsOf } from './limits.ts';
import type { MetaFs } from './meta-fs.ts';
import { createMetaFs } from './meta-fs.ts';
import {
  assertReadOnlyLedger,
  descends,
  inspectLayoutOrThrow,
  probeFile,
  requireDirectoryWorkspace,
  requireNotGitInternal,
} from './preflight.ts';
import type { GitDeps } from './status.ts';
// 行级差异住在 `@lwb/files`（LWB-025 移过去）：它是纯算法，
// 而 `@lwb/changes` 也要用它 —— 让它为一个 LCS 依赖 `isomorphic-git`
// 是把依赖方向反过来绑。此处只是换个来源，语义逐字未变。
import { diffLines } from '@lwb/files';

// ---------------------------------------------------------------------------
// 比较表
// ---------------------------------------------------------------------------

export type SideName = 'head' | 'index' | 'worktree';

/** 侧的名字。用于错误与 `note` —— 模型看到的是「哪一侧」，不是内部代号。 */
const SIDE_LABEL: Readonly<Record<SideName, string>> = {
  head: 'HEAD',
  index: '索引',
  worktree: '工作区',
};

interface ComparisonPlan {
  readonly old: SideName;
  readonly next: SideName;
  /** 人能读的比较说明。只用于 `note`。 */
  readonly label: string;
}

/**
 * 三种比较，以及各自的默认值。
 *
 * 默认 `head_vs_worktree`：它是「我改了什么」的默认答案，也是 `git diff`
 * 不带参数时的行为。索引与索引之间的比较（`head_vs_index`）是「我暂存了
 * 什么」，属于另一个问题，要显式问。
 */
const COMPARISONS: Readonly<Record<GitDiffComparison, ComparisonPlan>> = {
  head_vs_worktree: { old: 'head', next: 'worktree', label: 'HEAD → 工作区' },
  index_vs_worktree: { old: 'index', next: 'worktree', label: '索引 → 工作区' },
  head_vs_index: { old: 'head', next: 'index', label: 'HEAD → 索引' },
};

export interface GitDiffArgs {
  readonly scope: ReadScope;
  /** 本次调用所属的连接，来自凭据。 */
  readonly connection_id: string;
  /** daemon 对本次查询的判定结果。必须由 `@lwb/policy` 的 `decide()` 产出。 */
  readonly decision: PolicyDecision;
  readonly input: GitDiffInput;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function gitDiff(args: GitDiffArgs, deps: GitDeps): Promise<GitDiffData> {
  const limits = gitLimitsOf(deps.limits);
  const { scope, connection_id, decision, input } = args;

  if (decision.context.workspace_id !== scope.workspace_id) {
    throw new BridgeError('INVALID_ARGUMENT', '判定结果与本次查询的工作区不一致；拒绝执行。', {
      reason: 'DECISION_SCOPE_MISMATCH',
    });
  }
  requireDirectoryWorkspace(scope);

  const requestPath = input.path;
  if (requestPath === '') {
    // 与 `probeDirectory` 里那条相反：目录列举的「空」是「整个工作区」，
    // 而一次文件比对必须指名一个文件。空路径在这里不是一次寻址。
    throw new BridgeError('INVALID_ARGUMENT', '本工具一次比较一个文件，需要一条相对路径；不接受空路径。', {
      reason: 'EMPTY_PATH',
    });
  }
  requireNotGitInternal(requestPath);

  // 硬拒绝：在**碰任何东西之前**判。闸门稍后还会再判一次（它是权威的），
  // 但等到那时，探针与读取的代价已经付出去了。
  const early = classifyFile(requestPath, decision.rules);
  if (early.kind === 'hard_deny') hardDenied(early.rule_id);

  const comparison: GitDiffComparison = input.comparison ?? 'head_vs_worktree';
  const plan = COMPARISONS[comparison];

  const base = await probeFile(deps.ops, scope, requestPath);

  // 规范拼写再判一次：请求里的拼写与磁盘上的拼写可能不同（大小写、8.3 短名），
  // 而闸门判的、Git 存的都是后者。这一句是**补漏**，不是重复劳动 ——
  // `classifyFile` 对大小写敏感的模式（`.env` 一类）在两种拼写下答案会不同。
  const canonicalVerdict = classifyFile(base.canonical, decision.rules);
  if (canonicalVerdict.kind === 'hard_deny') hardDenied(canonicalVerdict.rule_id);

  // 「大到不值得比」在读之前判掉：受控句柄只提供整文件读取，先读进来再判断
  // 是不是太大，等于没有上限。
  if (base.size > limits.max_diff_bytes) throw tooLarge(base.size, limits.max_diff_bytes);

  const clearance = mintClearance(decision, { connection_id, generation: scope.generation });
  const gatePath = baseGatePathFor(scope, base.canonical);
  // 预检：一个字节都还没读，先问闸门「这个基准有没有资格往外走内容」。
  // 载荷为空，因此这次调用不消耗任何出站预算。
  emitContent(clearance, { path: gatePath, content: '' }, deps.budget);

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

  const sides = await resolveSides(meta, scope.root_path, base, plan, layout, limits.max_diff_bytes);

  // 「库出现未预期写入就失败」。写在库调用**之后**：账本要先有东西可看。
  assertReadOnlyLedger(meta);

  const oldView = viewOf(sides.old);
  const nextView = viewOf(sides.next);
  const binarySides: { side: 'old' | 'new'; reason: ByteRejectionReason }[] = [];
  if (oldView.rejection !== null) binarySides.push({ side: 'old', reason: oldView.rejection });
  if (nextView.rejection !== null) binarySides.push({ side: 'new', reason: nextView.rejection });
  const binary = binarySides.length > 0;

  let hunks: readonly GitDiffHunk[] = [];
  let truncated = false;
  let redacted = false;

  if (!binary) {
    // 不存在的一侧按**空内容**参与比较：那边没有这个路径，所以差异全部计为
    // 新增（或全部计为删除）。这不是「猜」，`sha256: null` 与 `note` 都会
    // 把这件事说出来。
    const result = diffLines(oldView.text ?? '', nextView.text ?? '', {
      max_output_bytes: limits.max_diff_output_bytes,
      context_lines: limits.diff_context_lines,
      max_dp_cells: limits.max_dp_cells,
    });
    truncated = result.truncated;
    const emitted = emitHunks(clearance, gatePath, result.hunks, deps.budget);
    hunks = emitted.hunks;
    redacted = emitted.redacted;
  }

  return {
    path: base.canonical,
    comparison,
    base_commit: sides.base_commit,
    // V1 只支持「一侧是索引或工作区」的三种比较，新侧永远不是提交。
    compare_commit: null,
    hunks,
    old_sha256: oldView.sha256,
    new_sha256: nextView.sha256,
    binary,
    truncated,
    redacted,
    note: noteFor({
      plan,
      binarySides,
      oldAbsent: sides.old.bytes === null,
      newAbsent: sides.next.bytes === null,
      redacted,
      truncated,
    }),
  };
}

// ---------------------------------------------------------------------------
// 取两侧的字节
// ---------------------------------------------------------------------------

interface ResolvedSide {
  /** 该侧的原始字节；该侧不存在时为 `null`。 */
  readonly bytes: Uint8Array | null;
  /**
   * 工作区侧的原始字节摘要，**取自护栏**。
   *
   * 只有工作区侧有：它是唯一一份由受控句柄读出来的字节，而护栏顺手算过它
   * （与 `file_read` 的基线比对是同一个来源）。对象侧没有这一项，摘要由
   * 本模块现算。
   */
  readonly sha256: string | null;
}

interface ResolvedSides {
  readonly old: ResolvedSide;
  readonly next: ResolvedSide;
  /** 旧侧是 HEAD 时的固定提交 ID；其余比较里旧侧不是提交，为 `null`。 */
  readonly base_commit: string | null;
}

/**
 * 按比较表取两侧。
 *
 * 装载用 `needed`（这一侧这次用得到吗），取用按 `plan`（这一侧是旧侧还是新侧）。
 * 两者是同一张表算出来的，但**代码路径不同**，所以取用时再断言一次：
 * 如果哪天真不一致，宁可报错也不要返回一个「这一侧不存在」的假答案。
 */
async function resolveSides(
  meta: MetaFs,
  dir: string,
  base: { readonly canonical: string; readonly volume_id: string; readonly file_id: string; readonly size: number },
  plan: ComparisonPlan,
  layout: GitLayoutSupport,
  maxBytes: number,
): Promise<ResolvedSides> {
  const needed = new Set<SideName>([plan.old, plan.next]);
  const loaded = new Map<SideName, ResolvedSide>();

  let headCommit: string | null = null;
  if (needed.has('head')) {
    headCommit = await headCommitOf(meta, dir, layout);
    loaded.set('head', {
      // 空仓库：HEAD 里没有这一侧，因此这一侧就是「不存在」。
      bytes:
        headCommit === null
          ? null
          : await readTreeEntry(meta, dir, headCommit, base.canonical, layout, maxBytes),
      sha256: null,
    });
  }
  if (needed.has('index')) {
    loaded.set('index', {
      bytes: await readIndexEntry(meta, dir, base.canonical, layout, maxBytes),
      sha256: null,
    });
  }
  if (needed.has('worktree')) {
    // 探针 → 读取 → 身份比对（I03）。比的是**句柄上的身份**，不是路径字符串：
    // 要抓的正是「同一串字符现在指向了另一个对象」。
    const read = await meta.readWorktreeFile(base.canonical);
    if (
      read.identity.volume_id !== base.volume_id ||
      read.identity.file_id !== base.file_id ||
      read.size !== base.size
    ) {
      throw new BridgeError(
        'FILE_VERSION_CONFLICT',
        '文件在本次比对的两次打开之间被替换或改动，已放弃本次比对；请重新查询。',
        { reason: 'identity_changed_between_opens', size_before: base.size, size_after: read.size },
      );
    }
    loaded.set('worktree', { bytes: read.bytes, sha256: read.sha256 });
  }

  const sideOf = (name: SideName): ResolvedSide => {
    const side = loaded.get(name);
    if (side === undefined) {
      throw new BridgeError('INTERNAL_ERROR', '内部分支不一致：请求的一侧没有装载内容；已拒绝返回。', {
        reason: 'SIDE_NOT_LOADED',
        side: name,
      });
    }
    return side;
  };

  return {
    old: sideOf(plan.old),
    next: sideOf(plan.next),
    base_commit: plan.old === 'head' ? headCommit : null,
  };
}

/** HEAD 提交 ID；空仓库（ref 不存在）为 `null`，那是正常状态不是失败。 */
async function headCommitOf(meta: MetaFs, dir: string, layout: GitLayoutSupport): Promise<string | null> {
  try {
    return await resolveRef({ fs: meta.client, dir, ref: 'HEAD' });
  } catch (error) {
    if (hasGitCode(error, 'NotFoundError')) return null;
    wrapGitFailure(error, layout);
  }
}

/**
 * HEAD 侧的字节。
 *
 * 传的是**提交 id** 与**规范相对路径**：`resolveTree` 把提交剥成它的树，
 * `resolveFilepath` 只沿这条路径的各级 tree 走。
 *
 * `NotFoundError` 在这里的意思是「这条路径不在那棵树里」（新文件），因此
 * 是 `null`。这一条与索引侧**故意不同**（见 `readIndexEntry`）：那边的
 * 「在不在」由遍历回答，读取失败只能是另一种原因。
 */
async function readTreeEntry(
  meta: MetaFs,
  dir: string,
  commit: string,
  path: string,
  layout: GitLayoutSupport,
  maxBytes: number,
): Promise<Uint8Array | null> {
  try {
    const result = await readBlob({ fs: meta.client, dir, oid: commit, filepath: path });
    if (result.blob.byteLength > maxBytes) throw tooLarge(result.blob.byteLength, maxBytes);
    return result.blob;
  } catch (error) {
    if (hasGitCode(error, 'NotFoundError')) return null;
    if (hasGitCode(error, 'ObjectTypeError')) notAFile('head', path);
    wrapGitFailure(error, layout);
  }
}

/**
 * 索引侧的字节。
 *
 * 走一遍 `STAGE()` 遍历拿到 `entry.oid()`，再按那个 oid 读对象。**不用
 * `entry.content()`**：索引遍历器的 `content()` 返回 `undefined`（它是从
 * `.git/index` 的目录结构里造出来的，本来就没有内容），拿一个 `undefined`
 * 当内容会安静地变成「空文件」。
 *
 * `NotFoundError` 在这里**不解释成「不存在」**：这一侧在不在，遍历已经回答
 * 过了（`oid` 为 `null` 就是不在）。此后再出一个「找不到对象」，意思是
 * 索引指着一个读不出来的对象 —— 那是这个仓库读不了，不是这条路径不存在。
 */
async function readIndexEntry(
  meta: MetaFs,
  dir: string,
  path: string,
  layout: GitLayoutSupport,
  maxBytes: number,
): Promise<Uint8Array | null> {
  let oid: string | null = null;
  try {
    await walk({
      fs: meta.client,
      dir,
      trees: [STAGE()],
      map: async (filepath, entries) => {
        if (filepath === path) {
          const entry = entries[0];
          if (entry !== undefined && entry !== null) {
            const type = await entry.type();
            // 目录与子模块（gitlink）在这里都不是「文件」。拿它们当文件比，
            // 会编出一段不存在的字节差异。
            if (type !== 'blob') notAFile('index', path);
            oid = await entry.oid();
          }
          return null;
        }
        return descends(filepath, path) ? entries : null;
      },
      reduce: async () => null,
    });
  } catch (error) {
    // `notAFile` / `tooLarge` 抛的是 `BridgeError`，`wrapGitFailure` 原样放行。
    wrapGitFailure(error, layout);
  }

  if (oid === null) return null;

  try {
    const result = await readBlob({ fs: meta.client, dir, oid });
    if (result.blob.byteLength > maxBytes) throw tooLarge(result.blob.byteLength, maxBytes);
    return result.blob;
  } catch (error) {
    if (hasGitCode(error, 'ObjectTypeError')) notAFile('index', path);
    wrapGitFailure(error, layout);
  }
}

// ---------------------------------------------------------------------------
// 一侧的字节 → 可比文本
// ---------------------------------------------------------------------------

interface SideView {
  /** 该侧的原始字节摘要；该侧不存在时为 `null`。**空文件不是「不存在」**。 */
  readonly sha256: string | null;
  /** 可参与文本比较的内容；该侧不是文本时为 `null`。 */
  readonly text: string | null;
  /** 该侧不能作为文本比较的**原因码**；可比较时为 `null`。 */
  readonly rejection: ByteRejectionReason | null;
}

function viewOf(side: ResolvedSide): SideView {
  const { bytes } = side;
  if (bytes === null) return { sha256: null, text: null, rejection: null };

  // 工作区侧的摘要**取自护栏**（与 `file_read` 的基线比对是同一个来源）；
  // 对象侧没有这一项，现算。两者是同一个算法、同一个输入范围（原始字节）。
  const sha256 = side.sha256 ?? createHash('sha256').update(bytes).digest('hex');
  const inspection = inspectBytes(bytes);
  if (inspection.kind !== 'text') return { sha256, text: null, rejection: inspection.reason };
  return { sha256, text: comparableText(inspection), rejection: null };
}

/**
 * 参与比较的文本。
 *
 * `inspectBytes` 会剥掉 UTF-8 BOM（那是它的职责：报告正文），但**BOM 是文件
 * 字节的一部分**。比较的文本必须把它放回去，否则「只改了 BOM」会读成
 * 「没有改动」—— 一处真实的字节差异变成了没有差异。
 */
function comparableText(inspection: { readonly text: string; readonly bom: boolean }): string {
  return inspection.bom ? `﻿${inspection.text}` : inspection.text;
}

// ---------------------------------------------------------------------------
// 出站
// ---------------------------------------------------------------------------

/**
 * 逐个 hunk 过闸门。顺序见文件头：**先整批预筛，再逐个出站**。
 *
 * 脱敏会改写片段内容，因此返回的 hunk 用的是**闸门给出的**那份内容。
 */
function emitHunks(
  clearance: Clearance,
  gatePath: string,
  hunks: readonly GitDiffHunk[],
  budget: EgressBudget,
): { readonly hunks: GitDiffHunk[]; readonly redacted: boolean } {
  const texts = hunks.map((hunk) => hunk.lines.join('\n'));

  const blocked = texts.findIndex((text) => screenText(text).has_certain);
  if (blocked >= 0) {
    // 整次失败，一个 hunk 都不出站。**不带任何片段**，也不带那些 hunk 的
    // 文本 —— 只说是第几段、一共几段。
    throw new BridgeError(
      'SECRET_DETECTED',
      '本次差异中至少有一段被判定为高置信度凭证，已在出站前整块阻断；不会返回其中任何片段。',
      { reason: 'HUNK_SCREEN_BLOCKED', hunk_index: blocked + 1, hunk_count: hunks.length },
    );
  }

  const out: GitDiffHunk[] = [];
  let redacted = false;
  for (const [index, hunk] of hunks.entries()) {
    const text = texts[index];
    if (text === undefined) {
      throw new BridgeError('INTERNAL_ERROR', '内部不一致：hunk 与它的文本对不上；已拒绝返回。', {
        reason: 'HUNK_TEXT_MISSING',
        hunk_index: index + 1,
      });
    }
    // 唯一的出口。闸门会再判一次路径、再筛一次内容 —— 预筛漏掉的在这里被
    // 拦住，而那时抛错是对的：闸门发现了预筛没发现的东西。
    const emission = emitContent(clearance, { path: gatePath, content: text }, budget);
    const lines = emission.content.split('\n');
    if (lines.length !== hunk.lines.length) {
      // 脱敏只替换命中的片段，不改行数：本面上可能命中的规则里没有跨行的
      // （跨行的那条是 certain 档，已经在上面整块阻断了）。真出现不一致，
      // 说明这个前提不成立了，此时按行拼回去会造出一段**行号对不上**的差异。
      throw new BridgeError('INTERNAL_ERROR', '脱敏后的 hunk 行数与原文不一致；已拒绝返回。', {
        reason: 'REDACTION_LINE_COUNT_CHANGED',
        hunk_index: index + 1,
      });
    }
    if (emission.redacted) redacted = true;
    out.push({ ...hunk, lines });
  }
  return { hunks: out, redacted };
}

// ---------------------------------------------------------------------------
// 说明文字
// ---------------------------------------------------------------------------

/**
 * 两侧都不可比时的原因说明。**取自原因码，不取自字节。**
 *
 * `ByteRejection.detail` 里对 BOM 的那几档会带上开头几个字节的十六进制 ——
 * 那是文件正文（哪怕只有 4 个字节）。这里不转发它：一段被判定为「不能当文本
 * 读」的字节，没有理由借我们的说明文字走出去。
 */
const REJECTION_TEXT: Readonly<Record<ByteRejectionReason, string>> = {
  NUL_BYTE: '含 NUL 字节',
  UTF16_BOM: '是 UTF-16 文本（带 BOM）',
  UTF32_BOM: '是 UTF-32 文本（带 BOM）',
  INVALID_UTF8: '字节序列不是合法 UTF-8',
};

const RAW_BYTES_NOTE =
  '按原始字节比较：两侧都没有套用 Git 的换行转换与属性规则（core.autocrlf / .gitattributes），' +
  '也没有读 .git/config；工作区里的 CRLF 与对象库里的 LF 在这里是一处真实的字节差异，' +
  '而 git diff 可能什么都不显示。sha256 同样算在原始字节上。';

function noteFor(ctx: {
  readonly plan: ComparisonPlan;
  readonly binarySides: readonly { readonly side: 'old' | 'new'; readonly reason: ByteRejectionReason }[];
  readonly oldAbsent: boolean;
  readonly newAbsent: boolean;
  readonly redacted: boolean;
  readonly truncated: boolean;
}): string {
  const parts = [RAW_BYTES_NOTE, `本次比较：${ctx.plan.label}。`];

  for (const item of ctx.binarySides) {
    const name = item.side === 'old' ? ctx.plan.old : ctx.plan.next;
    const which = item.side === 'old' ? '旧侧' : '新侧';
    parts.push(`${which}（${SIDE_LABEL[name]}）${REJECTION_TEXT[item.reason]}，按二进制处理：不产出文本差异。`);
  }
  if (ctx.oldAbsent) parts.push(`旧侧（${SIDE_LABEL[ctx.plan.old]}）里没有这个路径，差异全部计为新增。`);
  if (ctx.newAbsent) parts.push(`新侧（${SIDE_LABEL[ctx.plan.next]}）里没有这个路径，差异全部计为删除。`);
  if (ctx.redacted) parts.push('部分 hunk 已由出站闸门脱敏，不是磁盘/对象库里的原文。');
  if (ctx.truncated) parts.push('输出超过上限：hunks 只包含已返回的部分，被丢弃的段落不在其中。');

  return parts.join('');
}

// ---------------------------------------------------------------------------
// 拒绝
// ---------------------------------------------------------------------------

/**
 * 硬拒绝。**在探针之前**就已经判过，因此这里不回显路径 —— 一个按策略永远
 * 不可读的路径，连名字都不该出现在结果里（`list.ts` 同一条）。
 */
function hardDenied(ruleId: string): never {
  throw new BridgeError(
    'POLICY_DENIED',
    `该路径命中硬拒绝规则 ${ruleId}，不会读取、不会比较，也不会经任何出站面返回内容。`,
    { hard_deny_rule: ruleId },
  );
}

/**
 * 该路径在一侧不是普通文件。
 *
 * `path` 可以回显：能走到这里，说明两个拼写都已经过了硬拒绝判定，而它是
 * 调用方自己给的那条路径。
 */
function notAFile(side: SideName, path: string): never {
  throw new BridgeError(
    'INVALID_ARGUMENT',
    `该路径在${SIDE_LABEL[side]}里不是普通文件（是目录、子模块或其它对象）；` +
      '把不是文件的东西当文件比，会编出一段不存在的差异，因此拒绝。',
    { reason: 'NOT_A_BLOB', side, path },
  );
}

/**
 * 太大就**报错**，不返回「没有差异」。
 *
 * 与 `read.ts` 用的是同一个错误码与同一个形状：同一个文件在两条路径上不该
 * 有不同的「太大」判据，也不该在一条路径上是错误、在另一条上是空结果。
 */
function tooLarge(size: number, limitBytes: number): never {
  throw new BridgeError(
    'SIZE_LIMIT_EXCEEDED',
    `一侧的内容大小 ${size} 字节超过本次比对上限 ${limitBytes} 字节；` +
      '受控句柄只提供整文件读取，本版本不做部分读取，也不会把「没比」报成「没有差异」。',
    { size, limit_bytes: limitBytes, limit: 'MAX_GIT_DIFF_BYTES' },
  );
}
