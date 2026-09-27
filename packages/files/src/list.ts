/**
 * 分页目录列举（LWB-014，契约 `file_list`）。
 *
 * ## 这个模块要解决的三件事
 *
 * 方案 §6.1 给的验收标准是三句话，每一句都对应一个具体的坏结果：
 *
 *  1. **大量文件时输出有界。** 一个 20 万文件的 `node_modules` 不能让
 *     daemon 把它攒成一个数组再回给模型。因此：单页有上限（`max_entries`，
 *     夹取到 `MAX_DIRECTORY_ENTRIES`），单次调用向护栏问目录的次数也有上限，
 *     并且**攒满一页就立刻停止遍历** —— 不是「先走完再截断」。
 *  2. **目录变化可以返回游标失效或明确不完整状态。** 遍历不是快照
 *     （`consistency: per_file`），两次调用之间目录会变。这里的选择是：
 *     游标绑定**起点目录的身份**与**深度**，锚点用路径而不是序号；
 *     任何走不完的遍历都要在 `incomplete` / `incomplete_reason` 里说清楚，
 *     而不是给一个看起来完整的短列表。
 *  3. **隐藏/拒绝对象不在列表和错误中泄露详细信息。** 命中硬拒绝规则的条目
 *     被**整条丢弃**：不返回、不计数到别处、不出现在任何错误文本里。
 *     对应的只有 `denied_entries` 这个**数字**。
 *
 * ## 过滤为什么在这一层，而不是护栏
 *
 * 护栏负责「这个目录对象是不是我被授权的那个」（逐级句柄证明），
 * 它不知道 `.env` 是什么意思；策略包知道 `.env` 是什么意思，但它不碰磁盘。
 * 列举站在中间，手里同时有「路径事实」与「规则表」，因此**过滤只能在这里**。
 * 顺带的好处是：过滤规则的每一处生效都落在同一个函数（`classifyFile`）上，
 * 而不是散在遍历的各个分支里。
 *
 * ## 五个刻意的决定
 *
 *  1. **绝不跟随重解析点。** 护栏在逐级句柄里已经拒绝了重解析点，
 *     但那是「打开时拒绝」；列举这一层连**进入**都不做：条目照常返回
 *     （名字是磁盘上的事实），标记 `excluded: true`，但不递归。
 *     不去 stat 它也不读它 —— 跟随一个 Junction 会把工作区外的对象
 *     带进结果里。
 *  2. **搜索排除 ≠ 拒绝。** `node_modules` 这类目录会出现在列表里并标
 *     `excluded: true`，且不递归。这是策略包注释里的原话：
 *     「这是「不扫」，不是「不许读」」—— 模型显式列举它时应当拿得到内容。
 *  3. **名字也要过秘密筛查。** 一个名叫 `sk-live-…` 的文件不是「路径命中
 *     硬拒绝规则」，它是**名字本身就是秘密**。只筛 `certain` 档：`likely`
 *     档会把 `TOKEN=xxxx` 这种文件名也吞掉，而文件名里的 `=` 在 Windows 上
 *     是合法的、在真实仓库里也常见。
 *  4. **深度不是「尽力而为」。** 达到 `depth` 上限而放弃进入的目录会被数出来
 *     （`depthPruned`），并让结果变成 `incomplete`。一个「我看不到下面了」
 *     的诚实信号，比一个看起来完整、其实缺了一层的列表有用得多。
 *  5. **子树枚举失败不静默。** 某个子目录在遍历过程中被删掉、或被别的进程
 *     独占，都只跳过那一棵子树，但会**记在 `incomplete_reason` 里**
 *     （带路径与护栏码，不带护栏的自由文本）。静默跳过会让一份「缺了一块」
 *     的结果看起来是完整的。
 *
 * ## 一致性：`per_file`，不是快照
 *
 * 契约已经写死了这一点，这里要补充的是**它造成了什么可以观察的后果**：
 *
 *  - 翻页途中在锚点**之前**新增/删除的条目，不会被这次续读看到；
 *  - 同一个目录在两次列举之间变大，只要变大发生在锚点之后，续读仍会看到；
 *  - 因此「第 1 页 + 第 2 页」不等于「某一瞬间的目录内容的完整像」。
 *
 * 与之对照的是:分页**不会**产生重复条目 —— 这是路径锚点（而不是序号偏移）
 * 换来的，也是选它的唯一理由。
 */

import { BridgeError } from '@lwb/contracts';
import type { Cursor, DirectoryEntry, FileListData, FileListInput } from '@lwb/contracts';
import { LIMITS } from '@lwb/contracts';
import type { EgressBudget } from '@lwb/egress';
import { emitContent, mintClearance, screenText } from '@lwb/egress';
import type { PolicyDecision } from '@lwb/policy';
import { classifyFile } from '@lwb/policy';
import type { WinfsDirEntry, WinfsOps } from '@lwb/winfs';
import { isWinfsError } from '@lwb/winfs';

import {
  baseGatePathFor,
  basenameOfAbsolute,
  cursorAnchorSegments,
  isReadShaped,
  joinRelativePath,
  refOf,
  requireCanonicalPath,
  resolveTarget,
  toBridgeError,
} from './guard-bridge.ts';
import type { ReadScope } from './guard-bridge.ts';
import type { ReadTicketAuthority } from './read-token.ts';
import { assertListCursorMatches } from './read-token.ts';

// ---------------------------------------------------------------------------
// 依赖与限额
// ---------------------------------------------------------------------------

/**
 * 护栏侧 `$SCRIPT:LIST_HARD_CAP` 的镜像值（`native/winfs/WinfsGuard.ps1`）。
 *
 * 不一致不会导致越界：护栏对超出自己硬上限的 `max_entries` 是**夹取**，
 * 我们这边多要的部分拿不到而已。写在这里是为了让「我一次问多少条」
 * 有一个可读的上界，而不是一个凭空出现的魔法数。
 */
const GUARD_LIST_HARD_CAP = 1000;

/**
 * `depth` 省略时的默认深度：**只列当前层**。
 *
 * 默认值不扩大范围，这是本仓库一贯的方向（读取侧的 `max_lines` 默认取上限
 * 是因为「读一页」本来就意味着尽量读满；而列举的默认值决定了**要为用户
 * 付出多少次目录询问**）。要更深的视图就显式要，并且会得到一句
 * 「下面还有」的 `incomplete_reason`。
 */
const DEFAULT_LIST_DEPTH = 0;

/**
 * 单次调用最多向护栏问多少次目录。
 *
 * ## 为什么这个上限不能省
 *
 * 页面上限管的是**返回多少条**，它管不住**问了多少次**：一棵由 5 万个空目录
 * 组成的树，翻满一页（200 条）需要走遍全部 5 万个目录，而返回的条目可能
 * 一条都没有。没有这一条，`file_list` 就能被一次调用拖成一次全树扫描 ——
 * 而方案 §6.1 要的正是一个 O(页大小) 而不是 O(树大小) 的操作。
 *
 * ## 为什么按**次数**而不是按时间
 *
 * 时间预算会让同一个调用在不同机器上返回不同结果（甚至同一台机器上两次
 * 结果不同），而游标是按结果顺序定位的 —— 一次「这次跑得快所以多了三条」
 * 会让续读的锚点对不上。次数是确定的，代价是「最坏耗时 ≈ 次数 × 单次
 * 目录询问耗时」：实测常驻调用 P50 ≈ 1.3ms，因此 500 次的上界约 0.65s，
 * 与搜索的 3s 预算同一量级。
 *
 * 它**不在** `LIMITS` 冻结表里：那张表里每一项都是产品可调的限额，
 * 而这一项是「一次调用能做多少工作」的实现边界，与护栏的 `LIST_HARD_CAP`
 * 同类。放在 `ListLimits` 里只是为了让测试能把它调小。
 */
const DEFAULT_MAX_DIRECTORY_LISTINGS = 500;

export interface ListLimits {
  readonly max_directory_entries: number;
  readonly max_list_depth: number;
  readonly max_directory_listings: number;
  /** 列举游标的有效期。与读取侧共用 `READ_TOKEN_TTL_MS`（同一种「一份签名过的观察」）。 */
  readonly list_cursor_ttl_ms: number;
}

/** 默认取自冻结契约的 `LIMITS`。**调用方不能从请求参数改这些值。** */
export const DEFAULT_LIST_LIMITS: ListLimits = {
  max_directory_entries: LIMITS.MAX_DIRECTORY_ENTRIES,
  max_list_depth: LIMITS.MAX_LIST_DEPTH,
  max_directory_listings: DEFAULT_MAX_DIRECTORY_LISTINGS,
  list_cursor_ttl_ms: LIMITS.READ_TOKEN_TTL_MS,
};

export interface ListDeps {
  readonly ops: WinfsOps;
  readonly authority: ReadTicketAuthority;
  readonly budget: EgressBudget;
  /** 本地操作者收紧后的限额；省略即用默认值。 */
  readonly limits?: Partial<ListLimits>;
}

export interface ListDirectoryArgs {
  readonly scope: ReadScope;
  /** 本次调用所属的连接，来自凭据。游标绑定它，跨连接重放因此不可行。 */
  readonly connection_id: string;
  /** daemon 对本次列举的判定结果。必须由 `@lwb/policy` 的 `decide()` 产出。 */
  readonly decision: PolicyDecision;
  readonly input: FileListInput;
  /** 本地时钟（epoch ms）。本模块不读时钟。 */
  readonly now: number;
}

function limitsOf(deps: ListDeps): ListLimits {
  return { ...DEFAULT_LIST_LIMITS, ...(deps.limits ?? {}) };
}

// ---------------------------------------------------------------------------
// 遍历状态
// ---------------------------------------------------------------------------

interface SkippedSubtree {
  readonly path: string;
  readonly code: string;
}

interface WalkState {
  readonly ops: WinfsOps;
  readonly scope: ReadScope;
  /** 判定时使用的规则表（含操作者覆盖），不是默认表。 */
  readonly rules: PolicyDecision['rules'];
  /** 起点目录的规范拼写（游标锚点是相对它计算的）。 */
  readonly baseCanonical: string;
  readonly depthLimit: number;
  readonly pageLimit: number;
  readonly listingBudget: number;

  listings: number;
  scanned: number;
  denied: number;
  excluded: number;
  /** 因深度上限而放弃进入的目录数。 */
  depthPruned: number;
  /** 子树枚举失败（不含被拒绝的对象 —— 那些连名字都不记）。 */
  readonly skipped: SkippedSubtree[];
  /** 目录询问次数用尽，遍历被提前结束。 */
  budgetExhausted: boolean;

  /** 已确认返回的条目，最多 `pageLimit` 条。 */
  readonly entries: DirectoryEntry[];
  /**
   * 第 `pageLimit + 1` 条**本可以返回**的条目的路径。
   *
   * 它的唯一作用是当证据：只返回前 `pageLimit` 条时，「恰好装满一页」与
   * 「刚好只剩这些」在结果上完全一样，而这个区别决定了要不要发游标 ——
   * 发早了，下一面是空的；发晚了，剩下的条目永远读不到。
   * 与护栏的 `has_more`（一个目录内）是同一种手法，只是这里的范围是整次遍历。
   */
  witness: string | null;
}

/** 一页满了：整次遍历立即停止。返回值 true 表示「到此为止」。 */
function pageFull(state: WalkState): boolean {
  return state.witness !== null;
}

// ---------------------------------------------------------------------------
// 单条目的处置
// ---------------------------------------------------------------------------

/**
 * 处置一条护栏返回的条目。返回值 true 表示整次遍历该停了。
 *
 * 顺序是刻意的：**先判能不能返回，再判要不要进入**。两者共用同一个
 * `classifyFile` 结论，因此不可能出现「条目被过滤掉了，但它的子项被列了出来」
 * 这种绕过 —— 子项的路径以父目录的路径为前缀，父目录命中硬拒绝规则时，
 * 子项也必然命中（`classifyFile` 是逐路径段匹配的）。
 */
async function consider(state: WalkState, raw: WinfsDirEntry, entryDepth: number): Promise<boolean> {
  const childPath = raw.relative_path;

  const verdict = classifyFile(childPath, state.rules);
  if (verdict.kind === 'hard_deny') {
    // 整条丢弃：不进列表、不进错误文本、不进任何诊断。只留下一个计数。
    state.denied += 1;
    return false;
  }

  // 名字本身就是秘密的情形（例如有人把密钥粘成了文件名）。
  // 只筛 certain 档：likely 档会连 `TOKEN=...` 这类合法文件名一起吞掉。
  if (screenText(raw.name).has_certain) {
    state.denied += 1;
    return false;
  }

  const excluded = verdict.kind === 'search_exclude' || raw.is_reparse;

  if (state.entries.length >= state.pageLimit) {
    // 装不下了 —— 但它证明「本页之后还有」。
    state.witness = childPath;
    return true;
  }

  state.entries.push({
    path: childPath,
    name: raw.name,
    type: raw.type,
    // 契约要求目录为 null；重解析点的 size 为 null 是因为护栏**故意**不去
    // stat 它（stat 会跟随链接，从而把链接指向的对象的长度带进来）。
    size: raw.type === 'directory' ? null : raw.size,
    excluded,
  });
  if (excluded) state.excluded += 1;

  if (raw.type !== 'directory' || excluded) return false;

  if (entryDepth < state.depthLimit) {
    return await walkDirectory(state, childPath, entryDepth + 1, '');
  }
  // 到深度上限了：这一层的内容看不到，必须让调用方知道。
  state.depthPruned += 1;
  return false;
}

// ---------------------------------------------------------------------------
// 遍历
// ---------------------------------------------------------------------------

/**
 * 列举一个目录（必要时按窗口续取），并处理其中的条目。
 *
 * 返回 true 表示整次遍历该停了（页满或预算用尽）。
 *
 * `afterName` 非空时只取 ordinal 严格大于它的条目 —— 续读与目录内续窗都用它。
 */
async function walkDirectory(
  state: WalkState,
  dirPath: string,
  entryDepth: number,
  afterName: string,
): Promise<boolean> {
  let after = afterName;

  for (;;) {
    if (pageFull(state)) return true;
    if (state.listings >= state.listingBudget) {
      state.budgetExhausted = true;
      return true;
    }
    state.listings += 1;

    // 还差多少条才能确认「满页 + 一个见证」。多要的这一条不是浪费：
    // 没有它，恰好装满与刚好列完无法区分。
    const want = state.pageLimit - state.entries.length + 1;
    const request = {
      ...refOf(state.scope, dirPath),
      max_entries: Math.min(want, GUARD_LIST_HARD_CAP),
      ...(after === '' ? {} : { after_name: after }),
    };

    const result = await state.ops.listDirectory(request);
    if (isWinfsError(result)) {
      // 子树的失败不吞掉，也不炸掉整次列举：记下来，让它出现在
      // incomplete_reason 里。**只带路径与护栏码**，不带护栏的自由文本 ——
      // 后者可能包含我们没打算回给模型的东西。
      state.skipped.push({ path: dirPath, code: result.code });
      return false;
    }

    if (result.entries.length === 0) return false;

    for (const raw of result.entries) {
      state.scanned += 1;
      if (await consider(state, raw, entryDepth)) return true;
      after = raw.name;
    }

    // 页没满、还有更多 ⇒ 继续问同一个目录的下一窗。这在 `max_entries`
    // 大于护栏硬上限、或操作者把 `MAX_DIRECTORY_ENTRIES` 放大到 1000 以上
    // 时才会发生；不写这一支的话，那种配置下会静默少列条目。
    if (!result.has_more) return false;
  }
}

/**
 * 从锚点续读。
 *
 * ## 为什么不能「定位到锚点，然后接着走」
 *
 * 遍历是深度优先的**先序**：一个目录条目被返回之后，紧跟着的是它**内部**
 * 的内容，然后才是它的兄弟。因此「锚点之后」在不同情形下是不同位置：
 *
 *  - 锚点是文件 → 它的兄弟中排在它后面的那些；
 *  - 锚点是目录、且本次深度会进入它 → **它内部的第一条**，然后才是它的兄弟；
 *  - 锚点是目录、但深度上限不进入它 → 它的兄弟。
 *
 * 这里把这件事写成一条递归：每一层用 `after_name` = 锚点在该层的段，
 * 从**最深**的一层开始向上收尾。于是「锚点在 b/ 里的 b1.txt」会先列出
 * `b/` 中 `b1.txt` 之后的条目，再列出根目录里 `b` 之后的条目 —— 与首次
 * 遍历的顺序完全一致。
 *
 * ## 锚点不存在了怎么办
 *
 * `NOT_FOUND` 不是错误：它意味着锚点（以及若它是目录、它内部的一切）
 * 已经消失，于是「从它的兄弟继续」正是现在这棵树该有的顺序。
 * 其它失败**拒绝整个游标**：我们无法确定从哪里接着读，而"猜一个位置继续"
 * 会产出条目缺失或重复的结果 —— 那种结果看起来是完整的，这才是危险之处。
 */
async function resumeWalk(
  state: WalkState,
  anchorPath: string,
  anchorIsDirectory: boolean,
): Promise<void> {
  const segments = relativeSegmentsOf(state.baseCanonical, anchorPath);

  const step = async (index: number): Promise<boolean> => {
    const dirPath = joinRelativePath(state.baseCanonical, segments.slice(0, index));
    const segment = segments[index]!;

    if (index === segments.length - 1) {
      // 锚点就在这一层：先续它内部（若深度允许进入），再列它之后的兄弟。
      if (anchorIsDirectory && index < state.depthLimit) {
        if (await walkDirectory(state, anchorPath, index + 1, '')) return true;
      }
      return await walkDirectory(state, dirPath, index, segment);
    }

    if (await step(index + 1)) return true;
    return await walkDirectory(state, dirPath, index, segment);
  };

  await step(0);
}

/**
 * 取出锚点相对**起点目录**的路径段。
 *
 * 判定本身在 `guard-bridge.ts`（`cursorAnchorSegments`），与搜索游标**共用
 * 同一份实现** —— 两条路径各写一遍 `..` 检查，迟早在某一处漏掉一个分支，
 * 而那时同一个游标会在两条路径上得到两种结论。这里只负责把「不可用」
 * 翻译成列举侧的说法。
 */
function relativeSegmentsOf(basePath: string, anchorPath: string): readonly string[] {
  const result = cursorAnchorSegments(basePath, anchorPath);
  if (!result.ok) {
    throw new BridgeError('READ_TOKEN_STALE', `该目录列举游标的锚点不可用（${result.why}）；请重新列举。`, {
      reason: 'CURSOR_ANCHOR_UNUSABLE',
    });
  }
  return result.segments;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function listDirectory(args: ListDirectoryArgs, deps: ListDeps): Promise<FileListData> {
  const limits = limitsOf(deps);
  const { scope, connection_id, decision, input, now } = args;

  if (decision.context.workspace_id !== scope.workspace_id) {
    throw new BridgeError('INVALID_ARGUMENT', '判定结果与本次列举的工作区不一致；拒绝执行。', {
      reason: 'DECISION_SCOPE_MISMATCH',
    });
  }

  // 参数形态先判：合不合法不依赖磁盘，因此没有理由让它排在一次目录打开之后。
  const pageLimit = clampMaxEntries(input.max_entries, limits);
  const requestedDepth = input.depth === undefined ? null : clampDepth(input.depth, limits);

  const requestPath = input.path ?? '';
  if (scope.kind === 'file' && requestPath !== '') {
    throw new BridgeError('INVALID_ARGUMENT', '这是单文件工作区，不存在子路径；请用空路径列举该工作区。', {
      reason: 'SUBPATH_IN_FILE_WORKSPACE',
    });
  }

  // 探针 → 预检 → 列举。与读取同样的顺序与理由：判决必须发生在**付出代价之前**，
  // 而代价（在这里是枚举整个目录）之前唯一能拿到规范路径的时机就是这一次探针。
  const base = await resolveBase(deps.ops, scope, requestPath);
  const clearance = mintClearance(decision, { connection_id, generation: scope.generation });

  // 回执/子路径拼接用规范相对路径（根是空串），闸门要一个**名字**。两者只在
  // 「基准就是工作区根」时不同，因此是两个值而不是一个 —— 混用的后果是：
  // 单文件工作区的回执变成文件名（与 file_read 的约定不一致），或者根目录
  // 的名字根本不经过闸门。
  const baseCanonical = base.canonical;
  const baseGatePath = baseGatePathFor(scope, baseCanonical);
  emitContent(clearance, { path: baseGatePath, content: '' }, deps.budget);

  if (scope.kind === 'file') {
    return singleFileListing(scope, baseCanonical, base.size);
  }

  // 护栏当前的 `resolvePath` 不执行 `expect`，因此「它是目录吗」这一判在**这里**。
  if (!base.is_directory) {
    throw new BridgeError('INVALID_ARGUMENT', '目标是文件，不是目录；请改用 file_read 读取它。', {
      reason: 'NOT_A_DIRECTORY',
      path: baseCanonical,
    });
  }

  const cursorInput = input.cursor;
  const hasCursor = cursorInput !== undefined && cursorInput !== null && cursorInput !== '';

  let depthLimit = requestedDepth ?? DEFAULT_LIST_DEPTH;
  let anchorPath: string | null = null;
  let anchorIsDirectory = false;

  if (hasCursor) {
    const cursor = deps.authority.verifyListCursor(cursorInput, { now });
    // `depth` 不随游标静默漂移：省略时用游标里的那个，显式给出且不一致时拒绝。
    // 取较小值「继续」看起来更保守，实际是让调用方拿到一份自己没要求过、
    // 也没有被告知的遍历结果。
    assertListCursorMatches(cursor, {
      connection_id,
      workspace_id: scope.workspace_id,
      generation: scope.generation,
      base_path: baseCanonical,
      base_volume_id: base.volume_id,
      base_file_id: base.file_id,
      depth: requestedDepth ?? cursor.depth,
    });
    depthLimit = cursor.depth;
    anchorPath = cursor.anchor_path;
    anchorIsDirectory = await resolveAnchorForResume(deps.ops, scope, anchorPath);
  }

  const state: WalkState = {
    ops: deps.ops,
    scope,
    rules: clearance.rules,
    baseCanonical,
    depthLimit,
    pageLimit,
    listingBudget: limits.max_directory_listings,
    listings: 0,
    scanned: 0,
    denied: 0,
    excluded: 0,
    depthPruned: 0,
    skipped: [],
    budgetExhausted: false,
    entries: [],
    witness: null,
  };

  if (anchorPath === null) {
    await walkDirectory(state, baseCanonical, 0, '');
  } else {
    await resumeWalk(state, anchorPath, anchorIsDirectory);
  }

  const reasons: string[] = [];
  if (state.witness !== null) {
    reasons.push(`已达到单页上限 ${pageLimit} 条，本页之后仍有条目；请用 next_cursor 继续。`);
  }
  if (state.budgetExhausted) {
    reasons.push(
      `本次调用的目录询问次数已达到上限 ${limits.max_directory_listings}，遍历提前结束` +
        (state.entries.length > 0 ? '；请用 next_cursor 继续。' : '；没有可续读的锚点，请缩小 path 范围后重试。'),
    );
  }
  if (state.depthPruned > 0) {
    reasons.push(
      `已达到深度上限 depth=${depthLimit}，有 ${state.depthPruned} 个目录未进入，其内容未包含在本次结果中。`,
    );
  }
  for (const skip of state.skipped) {
    reasons.push(`子目录 ${skip.path} 未能枚举（护栏码 ${skip.code}），该子树未包含在本次结果中。`);
  }

  // 有锚点才发游标。见证条目是最直接的一种；预算用尽时，最后一条已返回的
  // 条目同样是有效的锚点（续读从它之后继续），没有理由让调用方从头再来一遍。
  const lastEntry = state.entries.at(-1);
  const continuable = state.witness !== null || (state.budgetExhausted && lastEntry !== undefined);
  const nextCursor =
    continuable && lastEntry !== undefined
      ? deps.authority.mintListCursor(
          {
            connection_id,
            workspace_id: scope.workspace_id,
            generation: scope.generation,
            base_path: baseCanonical,
            base_volume_id: base.volume_id,
            base_file_id: base.file_id,
            anchor_path: lastEntry.path,
            depth: depthLimit,
          },
          { now, ttl_ms: limits.list_cursor_ttl_ms },
        )
      : null;

  return {
    // 回执用**磁盘规范拼写**，不回显请求字符串（I14）。单文件工作区因此是空串。
    path: baseCanonical,
    entries: state.entries,
    next_cursor: nextCursor as Cursor | null,
    truncated: nextCursor !== null,
    consistency: 'per_file',
    scanned_entries: state.scanned,
    denied_entries: state.denied,
    excluded_entries: state.excluded,
    incomplete: reasons.length > 0,
    incomplete_reason: reasons.length > 0 ? reasons.join('；') : null,
  };
}

/** 起点的事实。`canonical` 是规范相对路径（工作区根为空串）。 */
interface ListBase {
  readonly canonical: string;
  readonly volume_id: string;
  readonly file_id: string;
  readonly is_directory: boolean;
  readonly size: number;
}

/**
 * 起点事实：探针一次，或者**在护栏不认的那种请求上**直接从作用域取。
 *
 * 除下面这一种情形，一律走探针（`resolveTarget`）。情形是
 * **「列举目录工作区的根」**：护栏的 `resolvePath` 对「目录根 + 空相对路径」
 * 是**故意**拒绝的 ——
 *
 * > 相对路径为空，而工作区根是一个目录…… 列举根目录请用 listDirectory。
 *
 * 它这么做是对的：`resolvePath` 回答的是「这个路径是哪一个对象」，而「不用
 * 路径、直接说整个根」根本不是一次寻址。列举根却是最常见的一次调用，于是
 * 这里按护栏的指路走 —— 不再多问一次「根是不是目录」，因为这个判断的信息
 * **就在作用域里**（`kind: 'directory'` 是登记工作区时写下的），而「根还是
 * 不是那个对象」由护栏在**每一次** `Open-GuardedChain` 里重新核实
 * （它拿句柄算出的卷序列号与文件索引必须与请求里的 `root_volume_id`/
 * `root_file_id` 逐位相同，否则 `ROOT_IDENTITY_MISMATCH`）。
 *
 * 也就是说，这里省掉的是一次**重复**的证明，不是一次缺失的证明：
 *  `volume_id`/`file_id` 仍取作用域里那份，而它每次都被护栏重新验过 ——
 * 因此把它写进游标是有效的绑定，而不是把字符串抄了一遍。
 */
async function resolveBase(ops: WinfsOps, scope: ReadScope, requestPath: string): Promise<ListBase> {
  if (requestPath === '' && scope.kind === 'directory') {
    return {
      canonical: '',
      volume_id: scope.root_volume_id,
      file_id: scope.root_file_id,
      is_directory: true,
      // 目录的尺寸对本模块没有意义（列举不读内容，条目的 size 来自目录扫描）。
      size: 0,
    };
  }

  const target = await resolveTarget(ops, scope, requestPath, 'directory');
  return {
    canonical: requireCanonicalPath(target.canonical_path),
    volume_id: target.identity.volume_id,
    file_id: target.identity.file_id,
    is_directory: target.attributes.is_directory,
    size: target.size,
  };
}

/**
 * 锚点探针：续读要从「它内部」还是「它之后」开始，取决于它现在是什么。
 *
 * 只有 `NOT_FOUND` 被当作一个正常答案（它消失了 ⇒ 从它的兄弟继续）；
 * 其它失败一律拒绝游标。**不把失败当成「不是目录」**：那样会在一次
 * 本来可以诊断的失败上，安静地跳过一整棵子树。
 */
async function resolveAnchorForResume(
  ops: WinfsOps,
  scope: ReadScope,
  anchorPath: string,
): Promise<boolean> {
  const target = await ops.resolvePath({ ...refOf(scope, anchorPath), expect: 'any' });
  if (isWinfsError(target)) {
    if (target.code === 'NOT_FOUND') return false;
    throw toBridgeError(target);
  }
  if (!isReadShaped(target)) {
    throw new BridgeError('INTERNAL_ERROR', '护栏对锚点返回了非目标形态的结果；已拒绝该游标。', {
      reason: 'CURSOR_ANCHOR_NOT_TARGET_SHAPED',
    });
  }
  return target.attributes.is_directory;
}

/**
 * 单文件工作区：整个工作区就是根的那一个文件。
 *
 * 它返回**一条**条目，路径是空串 —— 与 `file_read` 在这个工作区里回的空串
 * 是同一个值，因此模型拿着这份结果发起的下一次调用不需要任何转换。
 *
 * 名字取自注册时记下的绝对路径的最后一段，因此**可能与磁盘拼写大小写不同**
 * （Windows 不区分大小写，两者是同一个对象）。真正权威的字段是 `path`（空串）。
 * 这一点写在这里而不是靠读者去发现：`DirectoryEntry.name` 在目录工作区里
 * 一律来自磁盘扫描，只有这一处例外。
 */
function singleFileListing(
  scope: ReadScope,
  canonicalBasePath: string,
  size: number,
): FileListData {
  const name = basenameOfAbsolute(scope.root_path);
  return {
    path: canonicalBasePath,
    entries:
      name === ''
        ? []
        : [{ path: '', name, type: 'file', size, excluded: false }],
    next_cursor: null,
    truncated: false,
    consistency: 'per_file',
    scanned_entries: name === '' ? 0 : 1,
    denied_entries: 0,
    excluded_entries: 0,
    // 一个文件工作区的内容就是这一个文件，因此这次列举**是**完整的 ——
    // `incomplete` 为 true 会让调用方以为还有没看到的东西。
    incomplete: false,
    incomplete_reason: null,
  };
}

/** `max_entries` 只能**收紧**，不能扩大：契约的 `MAX_DIRECTORY_ENTRIES` 是上限，不是默认值。 */
function clampMaxEntries(requested: number | undefined, limits: ListLimits): number {
  if (requested === undefined) return limits.max_directory_entries;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new BridgeError('INVALID_ARGUMENT', 'max_entries 必须是 >= 1 的整数。', {
      reason: 'INVALID_MAX_ENTRIES',
    });
  }
  return Math.min(requested, limits.max_directory_entries);
}

/** `depth` 同理：`0` 合法（只列当前层），负数与非整数不合法。 */
function clampDepth(requested: number, limits: ListLimits): number {
  if (!Number.isInteger(requested) || requested < 0) {
    throw new BridgeError('INVALID_ARGUMENT', 'depth 必须是 >= 0 的整数。', { reason: 'INVALID_DEPTH' });
  }
  return Math.min(requested, limits.max_list_depth);
}

/** 供诊断与审计使用：本次列举使用的限额。**不含任何路径。** */
export function listLimitsOf(deps: ListDeps): ListLimits {
  return limitsOf(deps);
}
