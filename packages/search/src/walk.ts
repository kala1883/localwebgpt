/**
 * 候选文件的发现：有界、有序、可续、先过滤后进入（LWB-015 步骤 2）。
 *
 * ## 这一段为什么与 `list.ts` 的遍历**不共用**
 *
 * 两者都要回答「这个目录里有哪些条目」，但**节奏**完全不同：
 *
 *  - 列举的产物是**条目**，于是它的上限是页（200 条），策略排除的目录
 *    要**返回**并标 `excluded`（用户要看到它存在）；
 *  - 搜索的产物是**命中**，于是它的上限是「扫了多少字节、花了多少时间」，
 *    而策略排除的目录**根本不进**（「搜索排除」的本意就是性能排除）。
 *
 * 抽出共用遍历器意味着给一个函数加一堆模式开关，而**安全相关的那部分**
 * 反倒会被稀释在工程节奏里。因此这里把切分点放在「安全相关共用、
 * 工程节奏各自」：
 *
 *  - **共用**：`classifyFile`（策略规则只有一份）、`screenText`（秘密筛查
 *    只有一份）、`guard-bridge` 的作用域/判决路径/错误映射/游标锚点判定
 *    （边界只有一套说法）；
 *  - **各自**：页、深度、预算、计数口径。
 *
 * ## 三条必须写下来的判定
 *
 *  1. **绝不进入重解析点。** 条目照常计入计数，但不递归、也不读它指向的文件。
 *     跟随一个 Junction 会把工作区之外的对象带进结果里 —— 而护栏在打开阶段
 *     也会拒绝它，于是「跟随」的结果不是越界读取，是一条**每个链接都报错**的
 *     遍历。两者都不该发生。
 *  2. **命中硬拒绝规则的文件被整条丢弃**：不进结果、不进错误文本、不进任何
 *     诊断，只留下一个计数。理由与列举一致 —— 一个出现在错误文本里的路径
 *     就是一次泄漏。
 *  3. **名字也要过秘密筛查**，只筛 `certain` 档。`likely` 档会把 `TOKEN=x`
 *     这类合法文件名一起吞掉，而文件名里的 `=` 在 Windows 上合法。
 *
 * ## 这里只数**文件**
 *
 * 契约里的 `denied_files` / `skipped_files` 说的都是文件，因此本模块的计数
 * 器一律是文件级的。目录只在一个地方被数到：`depth_pruned` —— 因为
 * 「有几个目录没进去」正是「有多少内容没被检索」的唯一可观察代理，
 * 而它必须出现在 `incomplete_reason` 里。
 */

import { BridgeError } from '@lwb/contracts';
import { screenText } from '@lwb/egress';
import type { ReadScope } from '@lwb/files';
import { cursorAnchorSegments, isReadShaped, joinRelativePath, refOf, toBridgeError } from '@lwb/files';
import type { FileRule } from '@lwb/policy';
import { classifyFile } from '@lwb/policy';
import type { WinfsDirEntry, WinfsOps } from '@lwb/winfs';
import { isWinfsError } from '@lwb/winfs';

/**
 * 护栏侧 `$SCRIPT:LIST_HARD_CAP` 的镜像值（`native/winfs/WinfsGuard.ps1`）。
 *
 * 与 `list.ts` 里那个常量同值、同理由：护栏对超出自己硬上限的 `max_entries`
 * 是**夹取**，我们这边多要的部分拿不到而已。写在这里是为了让「我一次问多少条」
 * 有一个可读的上界，而不是一个凭空出现的魔法数。
 */
const GUARD_LIST_HARD_CAP = 1000;

/**
 * 一次搜索里最多向护栏问多少次目录。
 *
 * 与 `list.ts` 的 `max_directory_listings` 同一种边界，但这个数**更大**：
 * 列举的上限管的是「一次调用能做多少工作」而结果只有一页；搜索要遍历整棵
 * 子树才能回答「有没有」，所以它需要的目录询问次数与树的**目录数**成正比。
 *
 * 取 5000 的代价是「最坏情况 ≈ 5000 × 单次目录询问耗时」（实测常驻调用
 * P50 ≈ 1.3ms ⇒ 约 6.5s），比搜索自己的 3s 时间预算略大 —— 也就是说
 * 正常配置下**先撞到的是时间预算**，而这个数只是防止「时间预算还没到但
 * 目录询问已经停不下来」的兜底（时钟被系统休眠之类的事件拉长时）。
 *
 * 它**不在** `LIMITS` 冻结表里：那张表每一项都是产品可调的限额，而这一项是
 * 「一次调用能做多少工作」的实现边界，与护栏的 `LIST_HARD_CAP` 同类。
 * 放进 `SearchLimits` 只是为了让测试能把它调小。
 */
export const DEFAULT_MAX_DIRECTORY_LISTINGS = 5000;

/**
 * 遍历的计数器。**全部是文件级的**（`depth_pruned` 除外，见文件头）。
 *
 * 不变式：`files_seen = files_offered + denied_files + excluded_files`。
 * 这条等式是契约里 `scanned_files + skipped_files + denied_files` = 「看到的
 * 文件总数」的前提 —— 少了它，一次遍历就能凭空少掉几个文件而没人发现。
 */
export interface WalkCounters {
  /** 遍历中看到的**文件**条目数（含被丢弃、被跳过的）。 */
  files_seen: number;
  /** 已交给调用方扫描的文件数。 */
  files_offered: number;
  /** 命中硬拒绝规则、或名字本身是秘密的文件数。 */
  denied_files: number;
  /** 命中搜索排除规则、或是重解析点的文件数。**一个字节都没读。** */
  excluded_files: number;
  /** 因深度上限未进入的**目录**数。 */
  depth_pruned: number;
  /** 目录询问次数用尽，遍历被提前结束。 */
  listings_exhausted: boolean;
  /** 子树枚举失败：只记路径与护栏码，不记护栏的自由文本。 */
  readonly skipped_subtrees: { readonly path: string; readonly code: string }[];
}

export interface WalkOptions {
  readonly ops: WinfsOps;
  readonly scope: ReadScope;
  readonly rules: readonly FileRule[];
  readonly max_depth: number;
  /** 起点目录的规范相对路径（`''` 表示工作区根）。 */
  readonly base_path: string;
  /** 目录询问次数上限；省略即 `DEFAULT_MAX_DIRECTORY_LISTINGS`。 */
  readonly max_directory_listings?: number;
}

export interface WalkState extends WalkCounters {
  readonly ops: WinfsOps;
  readonly scope: ReadScope;
  readonly rules: readonly FileRule[];
  readonly base_path: string;
  readonly max_depth: number;
  readonly listing_budget: number;
  listings: number;
}

export function newWalkState(options: WalkOptions): WalkState {
  return {
    ops: options.ops,
    scope: options.scope,
    rules: options.rules,
    base_path: options.base_path,
    max_depth: options.max_depth,
    listing_budget: options.max_directory_listings ?? DEFAULT_MAX_DIRECTORY_LISTINGS,
    listings: 0,
    files_seen: 0,
    files_offered: 0,
    denied_files: 0,
    excluded_files: 0,
    depth_pruned: 0,
    listings_exhausted: false,
    skipped_subtrees: [],
  };
}

/**
 * 一次遍历的调用方（访问者）。
 *
 * `onFile` 的返回值表示「还要不要继续」：false 表示调用方已经收集够了
 * （页满、预算用尽、取消、已找到见证），遍历应当就地停止。**停止是调用方的
 * 决定**：遍历层不知道「够了」是什么意思，只知道怎么走。
 */
export interface WalkVisitor {
  /** 遇到一个可读的候选文件。返回值 false 请求停止遍历。 */
  onFile(path: string): Promise<boolean> | boolean;
}

/** 一条条目的处置：遍历的第一层与续读共用它，因此不可能给出两种结论。 */
async function consider(
  state: WalkState,
  visitor: WalkVisitor,
  raw: WinfsDirEntry,
  entryDepth: number,
): Promise<boolean> {
  const verdict = classifyFile(raw.relative_path, state.rules);
  // 名字本身就是秘密的情形（例如有人把密钥粘成了文件名）。只筛 `certain` 档：
  // `likely` 档会把 `TOKEN=x` 这类合法文件名一起吞掉，而文件名里的 `=`
  // 在 Windows 上是合法的、在真实仓库里也常见。
  const secretName = screenText(raw.name).has_certain;

  if (raw.type === 'directory') {
    // 目录不进 `files_seen`（契约里的三个计数说的都是文件），它的归宿只有
    // 两个：进入，或者因为「排除」/「深度」而不进入。
    if (verdict.kind === 'hard_deny' || secretName) return false;
    const excluded = verdict.kind === 'search_exclude' || raw.is_reparse;
    // 排除的目录不进入 —— 这正是「搜索排除」与「硬拒绝」在行为上的共同点，
    // 也是它们的区别所在：排除的目录**可以**被显式列举、可以被 file_read 读，
    // 只是不参与自动遍历（策略包的原话：「这是「不扫」，不是「不许读」」）。
    if (excluded) return false;
    if (entryDepth < state.max_depth) {
      return await walkCandidates(state, visitor, null, raw.relative_path, entryDepth + 1);
    }
    // 到深度上限了：这一层的内容看不到，调用方必须知道（`depth_pruned`）。
    state.depth_pruned += 1;
    return false;
  }

  // 从这一行起都是**文件**。`files_seen` 先记 —— 它数的是「看到过的文件」，
  // 与后面判成什么无关。这条顺序保证了下述等式恒成立：
  //   files_seen = files_offered + denied_files + excluded_files
  // 而契约里 `scanned_files + skipped_files + denied_files` = 看到的文件总数
  // 正是以它为地基的。
  state.files_seen += 1;

  if (verdict.kind === 'hard_deny' || secretName) {
    state.denied_files += 1;
    return false;
  }
  if (verdict.kind === 'search_exclude' || raw.is_reparse) {
    // 重解析点的**文件**也不读：读它会跟随到链接目标，而那可能是工作区
    // 之外的另一个文件。
    state.excluded_files += 1;
    return false;
  }

  state.files_offered += 1;
  return !(await visitor.onFile(raw.relative_path));
}

/**
 * 遍历 `dirPath` 的整棵子树。
 *
 * `resumeAfter` 非空时，只处理本层 ordinal **严格大于**它的条目 ——
 * 续读的每一层都用它（每一层只取自己那一层的「之后」）。
 */
export async function walkCandidates(
  state: WalkState,
  visitor: WalkVisitor,
  resumeAfter: string | null,
  dirPath: string = state.base_path,
  entryDepth = 0,
): Promise<boolean> {
  let after = resumeAfter ?? '';

  for (;;) {
    if (state.listings >= state.listing_budget) {
      state.listings_exhausted = true;
      return false;
    }
    state.listings += 1;

    const result = await state.ops.listDirectory({
      ...refOf(state.scope, dirPath),
      max_entries: GUARD_LIST_HARD_CAP,
      ...(after === '' ? {} : { after_name: after }),
    });
    if (isWinfsError(result)) {
      // 子树的失败不吞掉，也不炸掉整次搜索：记下来，让它出现在
      // incomplete_reason 里。**只带路径与护栏码**，不带护栏的自由文本 ——
      // 后者可能包含我们没打算回给模型的东西。
      state.skipped_subtrees.push({ path: dirPath, code: result.code });
      return false;
    }

    if (result.entries.length === 0) return false;

    for (const raw of result.entries) {
      after = raw.name;
      if (await consider(state, visitor, raw, entryDepth)) return true;
    }

    if (!result.has_more) return false;
  }
}

/**
 * 续读：从 `resume_path` **这一层**继续。
 *
 * ## 与列举的续读差在哪
 *
 * 列举要处理「锚点现在是文件还是目录」三岔口；搜索的续读位置**几乎总是
 * 一个文件**（游标是在「某个文件里返回了若干命中」之后发出的），因此少一整支。
 * 但少了那一支之后，多出来一个列举没有的问题：
 *
 * > **锚点文件还在不在？** 它必须**在**，因为它的命中有几个还没返回，
 * > 而「继续」意味着从它内部的第 N 个命中接着往后。
 *
 * 于是这里先探一次锚点（一次 `resolvePath`，与列举的 `resolveAnchorForResume`
 * 同一手法），再分岔：
 *
 *  - **在** → 最后一层从目录开头列起，跳过它之前的一切，从它自己开始。
 *    护栏的 `after_name` 是「严格大于」，表达不了「大于等于」，因此这里
 *    不能用 `after_name` —— 用它就会把锚点自己排除掉，而锚点里那批还没
 *    返回的命中将**永远不会被返回**，结果看起来却是完整的。
 *  - **不在** → 用 `after_name = 锚点名字`。它已经不存在，因此没有命中丢失；
 *    而排在它之前的条目上一页都已经扫过了，排在它之后的正是该接着扫的。
 *
 * ## 竞态：探到了、列的时候又没了
 *
 * 搜索是长操作，探针与列举之间文件真的可能被删掉。若那一层列完都没见到
 * 锚点，`walkFromIncluding` 会**改口**用 `after_name = 锚点名字` 重列一次 ——
 * 这时排在锚点之后的条目一条都没被处理过（前面全被跳过了），不会重复；
 * 而不改口的话，那个目录里锚点之后的候选会被整段静默跳过，结果报 `complete`。
 * 一条安静的漏扫，正是这一层最不能出的错。
 */
export async function resumeWalk(
  state: WalkState,
  visitor: WalkVisitor,
  resumePath: string,
): Promise<boolean> {
  const segments = segmentsOf(state.base_path, resumePath);
  const anchorExists = await anchorResolves(state, resumePath);

  const step = async (index: number): Promise<boolean> => {
    const dirPath = joinRelativePath(state.base_path, segments.slice(0, index));
    const segment = segments[index]!;

    if (index === segments.length - 1) {
      if (anchorExists) {
        const outcome = await walkFromIncluding(state, visitor, dirPath, segment, index);
        if (outcome.found) return outcome.stopped;
        // 竞态：探针与列举之间锚点没了。见文件头「竞态」。
        return await walkCandidates(state, visitor, segment, dirPath, index);
      }
      return await walkCandidates(state, visitor, segment, dirPath, index);
    }

    if (await step(index + 1)) return true;
    // 上一层：只取严格大于本层段名的条目（本层目录的内部已经单独处理过）。
    return await walkCandidates(state, visitor, segment, dirPath, index);
  };

  return await step(0);
}

/**
 * 列出 `dirPath` 的条目，跳过 `fromName` 之前的一切，从 `fromName` **自己**开始
 * 交给访问者。
 *
 * `found` 为 false 表示列完了整个目录也没见到 `fromName`（竞态，见文件头）。
 */
async function walkFromIncluding(
  state: WalkState,
  visitor: WalkVisitor,
  dirPath: string,
  fromName: string,
  entryDepth: number,
): Promise<{ found: boolean; stopped: boolean }> {
  let after = '';
  let seen = false;

  for (;;) {
    if (state.listings >= state.listing_budget) {
      state.listings_exhausted = true;
      return { found: seen, stopped: true };
    }
    state.listings += 1;

    const result = await state.ops.listDirectory({
      ...refOf(state.scope, dirPath),
      max_entries: GUARD_LIST_HARD_CAP,
      ...(after === '' ? {} : { after_name: after }),
    });
    if (isWinfsError(result)) {
      state.skipped_subtrees.push({ path: dirPath, code: result.code });
      return { found: seen, stopped: true };
    }
    if (result.entries.length === 0) return { found: seen, stopped: false };

    for (const raw of result.entries) {
      after = raw.name;
      if (!seen && raw.name !== fromName) continue;
      seen = true;
      if (await consider(state, visitor, raw, entryDepth)) return { found: true, stopped: true };
    }

    if (!result.has_more) return { found: seen, stopped: false };
  }
}

/** 锚点现在还在吗。`NOT_FOUND` 是正常答案，其它失败一律拒绝该游标。 */
async function anchorResolves(state: WalkState, anchorPath: string): Promise<boolean> {
  const target = await state.ops.resolvePath({ ...refOf(state.scope, anchorPath), expect: 'any' });
  if (isWinfsError(target)) {
    if (target.code === 'NOT_FOUND') return false;
    // 不把失败当成「锚点不在」：那会在一次本可诊断的失败上安静地少扫一截。
    throw toBridgeError(target);
  }
  if (!isReadShaped(target)) {
    throw new BridgeError('INTERNAL_ERROR', '护栏对续读位置返回了非目标形态的结果；已拒绝该游标。', {
      reason: 'CURSOR_RESUME_NOT_TARGET_SHAPED',
    });
  }
  return true;
}

/**
 * 路径段判定与拼接都在 `guard-bridge.ts` —— 与列举游标**共用同一份实现**。
 * 这里只把「不可用」翻译成搜索侧的说法。
 */
function segmentsOf(basePath: string, resumePath: string): readonly string[] {
  const result = cursorAnchorSegments(basePath, resumePath);
  if (!result.ok) {
    throw new BridgeError('READ_TOKEN_STALE', `该搜索游标的续读位置不可用（${result.why}）；请重新搜索。`, {
      reason: 'CURSOR_RESUME_UNUSABLE',
    });
  }
  return result.segments;
}

/** 供诊断与审计使用：本次遍历的目录询问次数。**不含任何路径。** */
export function listingsUsed(state: WalkState): number {
  return state.listings;
}
