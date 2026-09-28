/**
 * `text_search` 的入口（LWB-015，契约 `packages/contracts/src/search.ts`）。
 *
 * ## 三条验收标准，各自对应这里的一段代码
 *
 *  1. > 搜索能找到已保存未提交的变更，不需要云端索引。
 *     —— 检索的对象是**磁盘上的字节**：遍历走护栏的目录扫描，内容走
 *     `readFileGuarded`（与 `file_read` 同一个受控句柄），没有任何索引、
 *     缓存或后台扫描。因此「刚保存、还没提交」与「提交过的」在它眼里
 *     没有任何区别 —— 它根本不知道 Git 存在。
 *
 *  2. > 秘密标记不会出现在命中片段中。
 *     —— 片段唯一的出口是 `emitContent`，而扫描层在出站前先做文件级预筛。
 *     两道都在 `scan.ts` 里，这里只负责把凭证递过去。
 *
 *  3. > 超时返回部分结果而非错误宣称没有匹配或已经检索全仓。
 *     —— 这一条主要落在**本文件**：时间/字节预算、取消、分页都返回
 *     已经找到的命中，同时用 `complete` / `incomplete_reason` / 各项计数
 *     把「我看到了什么、没看到什么」说清楚。
 *
 * ## 分页与「还有更多」的证据
 *
 * 与目录列举同一个手法（见 `list.ts` 的 `witness`）：**多找一个**。
 * 一页装满了之后，这里不会就地停下 —— 它会继续往后扫，直到找到**一条**
 * 落在页外的命中，或者把遍历走完。那条命中不返回，只作为「本页之后确实
 * 还有」的证据，用来决定要不要发游标。
 *
 * 为什么值得多扫：只返回前 N 条时，「恰好装满一页」与「刚好只剩这些」
 * 在结果上完全一样，而这个区别决定了调用方接下来做什么 ——
 * 发早了，下一面是空的；发晚了，剩下的命中**永远不会被返回**，
 * 而结果看起来是完整的。
 *
 * 代价是诚实的：页满之后为了找那条证据，可能要多读一些文件。这件事由
 * 时间预算与字节预算兜底（它们到点就停，并且那时发的是「从最后一条命中
 * 续读」的游标）。反过来，**不找证据就等于撒一个「已经搜完」的谎**。
 *
 * ## 页满之后不再产生的那些命中不花出站额度
 *
 * `scanFile` 在 `remaining_matches = 0` 时仍然会算出 `hits_in_file`（要拿它
 * 当证据），但一条片段都不出站、一个字节都不记账。也就是说找证据的代价是
 * 本地 I/O，不是用户每小时那 32 MiB 的额度。
 */

import { BridgeError, LIMITS, compileGlob, matchesGlob } from '@lwb/contracts';
import type { Cursor, SearchMatch, TextSearchData, TextSearchInput } from '@lwb/contracts';
import type { EgressBudget } from '@lwb/egress';
import { emitContent, mintClearance } from '@lwb/egress';
import type { ReadScope, ReadTicketAuthority } from '@lwb/files';
import { assertSearchCursorMatches, baseGatePathFor, requireCanonicalPath, resolveTarget } from '@lwb/files';
import type { PolicyDecision } from '@lwb/policy';
import type { WinfsOps } from '@lwb/winfs';

import { compileQuery, queryDigest } from './query.ts';
import type { SearchQuery } from './query.ts';
import { scanFile } from './scan.ts';
import type { WalkState, WalkVisitor } from './walk.ts';
import { newWalkState, resumeWalk, walkCandidates } from './walk.ts';

// ---------------------------------------------------------------------------
// 依赖与限额
// ---------------------------------------------------------------------------

/**
 * 向护栏问目录的次数上限（`walk.ts` 的默认值是 5000）。
 *
 * 这里**不再写一个数字**：默认值住在遍历层，因为那是「一次遍历能做多少
 * 工作」的实现边界。限额表里留一个可覆盖的入口，只是为了让测试能把它
 * 调成 1 或 2，从而在几毫秒内构造出「目录询问次数用尽」这条路径。
 */
const DEFAULT_MAX_DIRECTORY_LISTINGS: number | undefined = undefined;

export interface SearchLimits {
  readonly max_search_matches: number;
  readonly max_search_scanned_bytes: number;
  readonly search_time_budget_ms: number;
  readonly max_snippet_bytes: number;
  readonly max_line_bytes: number;
  readonly max_readable_file_bytes: number;
  readonly max_list_depth: number;
  /** 省略即用遍历层的默认值；给值只为了测试能把它调小。 */
  readonly max_directory_listings: number | undefined;
  /** 搜索游标的有效期，与读取票据同为「一份签名过的观察」。 */
  readonly search_cursor_ttl_ms: number;
}

/** 默认取自冻结契约的 `LIMITS`。**调用方不能从请求参数改这些值。** */
export const DEFAULT_SEARCH_LIMITS: SearchLimits = {
  max_search_matches: LIMITS.MAX_SEARCH_MATCHES,
  max_search_scanned_bytes: LIMITS.MAX_SEARCH_SCANNED_BYTES,
  search_time_budget_ms: LIMITS.SEARCH_TIME_BUDGET_MS,
  max_snippet_bytes: LIMITS.MAX_SNIPPET_BYTES,
  max_line_bytes: LIMITS.MAX_LINE_BYTES,
  max_readable_file_bytes: LIMITS.MAX_READABLE_FILE_BYTES,
  max_list_depth: LIMITS.MAX_LIST_DEPTH,
  max_directory_listings: DEFAULT_MAX_DIRECTORY_LISTINGS,
  search_cursor_ttl_ms: LIMITS.READ_TOKEN_TTL_MS,
};

export interface SearchDeps {
  readonly ops: WinfsOps;
  readonly authority: ReadTicketAuthority;
  readonly budget: EgressBudget;
  /**
   * 单调读数（毫秒）。**本模块不读时钟** —— 时间预算必须能与测试的假时钟
   * 对齐，而 `Date.now()` 会因为系统时间被调整而倒退。它与 `args.now` 是
   * 两个不同的东西：`now` 是「现在几点」（票据用），`clock` 是「过了多久」
   * （预算用）。
   */
  readonly clock: () => number;
  /** 取消信号。返回 true 即停止遍历并返回已经找到的部分结果。 */
  readonly is_cancelled?: () => boolean;
  /** 本地操作者收紧后的限额；省略即用默认值。 */
  readonly limits?: Partial<SearchLimits>;
}

export interface SearchArgs {
  readonly scope: ReadScope;
  /** 本次调用所属的连接，来自凭据。游标绑定它，跨连接重放因此不可行。 */
  readonly connection_id: string;
  /** daemon 对本次搜索的判定结果。必须由 `@lwb/policy` 的 `decide()` 产出。 */
  readonly decision: PolicyDecision;
  readonly input: TextSearchInput;
  /** 本地时间（epoch ms）。本模块不读时钟。 */
  readonly now: number;
}

function limitsOf(deps: SearchDeps): SearchLimits {
  return { ...DEFAULT_SEARCH_LIMITS, ...(deps.limits ?? {}) };
}

// ---------------------------------------------------------------------------
// 本次搜索撞到的边界
// ---------------------------------------------------------------------------

/**
 * 结果为什么不是全貌。**这是给 LWB-017 用的稳定枚举** —— 适配器把标志位
 * 映射成契约错误码（`RESULT_TRUNCATED` / `SEARCH_BUDGET_EXCEEDED`）时
 * 应当只看这里，而不是自己去猜 `incomplete_reason` 里那句话是什么意思。
 *
 * 注意这里**没有** `DENIED` 与 `EXCLUDED`：被硬拒绝或被搜索排除的文件
 * 不是覆盖范围的缺口（前者按策略永远不可读、后者按设计不参与自动遍历），
 * 它们只出现在计数字段里。理由见下面 `denied` 那一行的注释。
 */
export type SearchBound =
  | 'PAGE_FULL'
  | 'DEADLINE'
  | 'BYTE_BUDGET'
  | 'CANCELLED'
  | 'LISTINGS_EXHAUSTED'
  | 'DEPTH_LIMIT'
  | 'SUBTREE_FAILED'
  | 'FILE_TOO_LARGE'
  | 'FILE_UNREADABLE'
  | 'FILE_UNSTABLE'
  | 'SECRET_WITHHELD';

export function searchBounds(data: TextSearchData): readonly SearchBound[] {
  const bounds: SearchBound[] = [];
  if (data.truncated) bounds.push('PAGE_FULL');
  if (data.deadline_exceeded) bounds.push('DEADLINE');
  if (data.byte_budget_exceeded) bounds.push('BYTE_BUDGET');
  if (data.cancelled) bounds.push('CANCELLED');
  const reason = data.incomplete_reason ?? '';
  if (reason.includes('目录询问次数')) bounds.push('LISTINGS_EXHAUSTED');
  if (reason.includes('深度上限')) bounds.push('DEPTH_LIMIT');
  if (reason.includes('未能枚举')) bounds.push('SUBTREE_FAILED');
  if (reason.includes('超过单次可读上限')) bounds.push('FILE_TOO_LARGE');
  if (reason.includes('打不开')) bounds.push('FILE_UNREADABLE');
  if (reason.includes('扫描期间发生变化')) bounds.push('FILE_UNSTABLE');
  if (reason.includes('高置信度凭证')) bounds.push('SECRET_WITHHELD');
  return bounds;
}

// ---------------------------------------------------------------------------
// 一次搜索的累积状态
// ---------------------------------------------------------------------------

interface SearchCounters {
  readonly matches: SearchMatch[];
  scanned_files: number;
  skipped_files: number;
  secret_files: number;
  scanned_bytes: number;
  too_large: number;
  unreadable: number;
  unstable: number;
  /** 不匹配 `path_glob` 的文件数。计入 `skipped_files`，但不算覆盖缺口。 */
  glob_filtered: number;
  /** 「本页之后还有」的证据。见文件头。 */
  witness: { readonly path: string; readonly skip: number } | null;
  /** 最后一条**已返回**的命中在哪个文件的第几个 —— 预算用尽时的续读锚点。 */
  last_path: string | null;
  last_skip: number;
  truncated_by: Exclude<SearchBound, 'PAGE_FULL' | 'SECRET_WITHHELD' | 'FILE_TOO_LARGE' | 'FILE_UNREADABLE' | 'FILE_UNSTABLE' | 'DEPTH_LIMIT' | 'SUBTREE_FAILED'> | null;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function textSearch(args: SearchArgs, deps: SearchDeps): Promise<TextSearchData> {
  const limits = limitsOf(deps);
  const { scope, connection_id, decision, input, now } = args;

  if (decision.context.workspace_id !== scope.workspace_id) {
    throw new BridgeError('INVALID_ARGUMENT', '判定结果与本次搜索的工作区不一致；拒绝执行。', {
      reason: 'DECISION_SCOPE_MISMATCH',
    });
  }

  // ---- 参数形态：全部不依赖磁盘，因此都排在第一次打开之前 ----------------

  const query = compileQuery(input.query, input.case_sensitive);
  const glob = compilePathGlob(input.path_glob);
  const digest = queryDigest(query, glob?.source ?? null);
  const pageLimit = clampMaxMatches(input.max_matches, limits);

  const requestPath = input.path ?? '';
  if (scope.kind === 'file' && requestPath !== '') {
    throw new BridgeError('INVALID_ARGUMENT', '这是单文件工作区，不存在子路径；请用空路径搜索该工作区。', {
      reason: 'SUBPATH_IN_FILE_WORKSPACE',
    });
  }

  // ---- 起点探针 → 预检 → 遍历 -------------------------------------------

  const base = await resolveBase(deps.ops, scope, requestPath);
  const clearance = mintClearance(decision, { connection_id, generation: scope.generation });
  // 预检：一个字节都还没读，先问闸门「这个起点有没有资格往外走内容」。
  // 载荷为空，因此这次调用不消耗任何出站预算（记账按实际出站字节数）。
  emitContent(clearance, { path: baseGatePathFor(scope, base.canonical), content: '' }, deps.budget);

  let resumePath: string | null = null;
  let resumeSkip = 0;
  const cursorInput = input.cursor;
  if (cursorInput !== undefined && cursorInput !== null && cursorInput !== '') {
    const cursor = deps.authority.verifySearchCursor(cursorInput, { now });
    assertSearchCursorMatches(cursor, {
      connection_id,
      workspace_id: scope.workspace_id,
      generation: scope.generation,
      base_path: base.canonical,
      base_volume_id: base.volume_id,
      base_file_id: base.file_id,
      query_digest: digest,
    });
    resumePath = cursor.resume_path;
    resumeSkip = cursor.skip_matches;
  }

  // `args.now` is wall-clock epoch time for signed tickets; the budget clock is
  // monotonic. Build the deadline from its own clock origin, never mix the two.
  const deadline = deps.clock() + limits.search_time_budget_ms;
  const counters: SearchCounters = {
    matches: [],
    scanned_files: 0,
    skipped_files: 0,
    secret_files: 0,
    scanned_bytes: 0,
    too_large: 0,
    unreadable: 0,
    unstable: 0,
    glob_filtered: 0,
    witness: null,
    last_path: null,
    last_skip: 0,
    truncated_by: null,
  };

  const shouldStop = (): boolean => {
    if (counters.truncated_by === 'DEADLINE' || counters.truncated_by === 'CANCELLED') return true;
    if (deps.is_cancelled?.() === true) {
      counters.truncated_by = 'CANCELLED';
      return true;
    }
    if (deps.clock() >= deadline) {
      counters.truncated_by = 'DEADLINE';
      return true;
    }
    return false;
  };

  const state = newWalkState({
    ops: deps.ops,
    scope,
    // 判定时用的规则表（含操作者覆盖），不是默认表。闸门拿到的是同一份。
    rules: clearance.rules,
    max_depth: limits.max_list_depth,
    base_path: base.canonical,
    max_directory_listings: limits.max_directory_listings,
    should_stop: shouldStop,
  });

  /** 扫描一个候选文件。返回值 false 表示遍历该停了。 */
  const offerFile = async (path: string): Promise<boolean> => {
    // walker 在每个目录询问、返回批次和条目之前都检查同一预算；这里再
    // 检查一次，避免 visitor 入口与目录枚举之间开始下一次文件读取。
    if (shouldStop()) return false;

    // glob 只筛**文件**，不剪**目录**：`*.ts` 不该让遍历跳过 `src/`。
    // 剪枝要靠「这个目录名匹配不上模式」来推断，而那在模式含 `**` 或
    // 目录名恰好匹配时都推错 —— 推错的后果是漏扫，不是多扫。
    if (glob !== null && !matchesGlob(glob.regex, relativeToBase(base.canonical, path))) {
      counters.skipped_files += 1;
      counters.glob_filtered += 1;
      return true;
    }

    const skip = resumePath !== null && path === resumePath ? resumeSkip : 0;
    const outcome = await scanFile(path, {
      ops: deps.ops,
      scope,
      query,
      clearance,
      budget: deps.budget,
      remaining_matches: Math.max(0, pageLimit - counters.matches.length),
      skip_matches: skip,
      max_readable_file_bytes: limits.max_readable_file_bytes,
      max_snippet_bytes: limits.max_snippet_bytes,
      max_line_bytes: limits.max_line_bytes,
    });

    switch (outcome.kind) {
      case 'too_large':
        counters.skipped_files += 1;
        counters.too_large += 1;
        break;
      case 'unreadable':
        counters.skipped_files += 1;
        counters.unreadable += 1;
        break;
      case 'no_text':
        counters.scanned_files += 1;
        counters.scanned_bytes += outcome.bytes;
        break;
      case 'unstable':
        counters.scanned_files += 1;
        counters.scanned_bytes += outcome.bytes;
        counters.unstable += 1;
        break;
      case 'secret':
        counters.scanned_files += 1;
        counters.scanned_bytes += outcome.bytes;
        counters.secret_files += 1;
        break;
      case 'found': {
        counters.scanned_files += 1;
        counters.scanned_bytes += outcome.bytes;
        for (const match of outcome.matches) counters.matches.push(match);
        const consumed = skip + outcome.matches.length;
        if (outcome.matches.length > 0) {
          counters.last_path = path;
          counters.last_skip = consumed;
        }
        if (outcome.hits_in_file > consumed) {
          // 本文件里还有没返回的命中 ⇒ 它就是那条证据。**停止遍历**：
          // 页满与「文件内还有」在这里是同一件事。
          counters.witness = { path, skip: consumed };
          return false;
        }
        break;
      }
    }

    if (counters.scanned_bytes >= limits.max_search_scanned_bytes) {
      counters.truncated_by = 'BYTE_BUDGET';
      return false;
    }
    // 单个受控读取不可被本层中途打断；若它本身耗尽时间预算，保留本文件
    // 已经核验的命中，但必须把结果标为不完整，不能返回 `complete=true`。
    if (shouldStop()) return false;
    // 页满了**也要继续**，直到找到那条证据或者遍历走完。见文件头。
    // 下一轮 `remaining_matches` 为 0，因此不会再多出站任何片段。
    return counters.witness === null;
  };

  const visitor: WalkVisitor = { onFile: offerFile };

  if (scope.kind === 'file') {
    // 单文件工作区：候选集就是根的那一个文件，没有遍历可言，也没有目录
    // 可以列举。它自己就是「起点」。
    await offerFile('');
  } else {
    // 护栏当前的 `resolvePath` 不执行 `expect`，因此「它是目录吗」这一判在**这里**。
    if (!base.is_directory) {
      throw new BridgeError('INVALID_ARGUMENT', '搜索的起点必须是目录；要搜一个文件请用 file_read 读它。', {
        reason: 'NOT_A_DIRECTORY',
        path: base.canonical,
      });
    }
    if (resumePath === null) {
      await walkCandidates(state, visitor, null);
    } else {
      await resumeWalk(state, visitor, resumePath);
    }
  }

  return assemble({ scope, connection_id, base, query, digest, pageLimit, limits, state, counters, deps, now });
}

// ---------------------------------------------------------------------------
// 组装结果
// ---------------------------------------------------------------------------

function assemble(ctx: {
  scope: ReadScope;
  connection_id: string;
  base: SearchBase;
  query: SearchQuery;
  digest: string;
  pageLimit: number;
  limits: SearchLimits;
  state: WalkState;
  counters: SearchCounters;
  deps: SearchDeps;
  now: number;
}): TextSearchData {
  const { scope, connection_id, base, query, digest, pageLimit, limits, state, counters, deps, now } = ctx;
  const { matches, witness } = counters;

  // 游标的锚点：优先用那条证据（它就是「本页之后」的准确位置）；
  // 没有证据但确实是提前停下的，就用最后一条已返回的命中 —— 没有理由
  // 让调用方从头再来一遍。
  const anchor =
    witness ??
    (counters.truncated_by !== null && counters.last_path !== null
      ? { path: counters.last_path, skip: counters.last_skip }
      : null);

  const nextCursor =
    anchor === null
      ? null
      : deps.authority.mintSearchCursor(
          {
            connection_id,
            workspace_id: scope.workspace_id,
            generation: scope.generation,
            base_path: base.canonical,
            base_volume_id: base.volume_id,
            base_file_id: base.file_id,
            query_digest: digest,
            resume_path: anchor.path,
            skip_matches: anchor.skip,
          },
          { now, ttl_ms: limits.search_cursor_ttl_ms },
        );

  const reasons = incompleteReasons(ctx, nextCursor !== null);

  return {
    query: query.text,
    matches,
    next_cursor: nextCursor as Cursor | null,
    truncated: nextCursor !== null,
    consistency: 'per_file',
    scope: {
      scanned_files: counters.scanned_files,
      // 「看到但一个字节都没读」的全部去向：搜索排除/重解析点 + 不匹配 glob
      // + 超出单次可读上限 + 打不开。细分在 incomplete_reason 里，这里只有总数。
      skipped_files: state.excluded_files + counters.skipped_files,
      denied_files: state.denied_files,
      secret_files: counters.secret_files,
      scanned_bytes: counters.scanned_bytes,
      complete: reasons.length === 0,
    },
    deadline_exceeded: counters.truncated_by === 'DEADLINE',
    byte_budget_exceeded: counters.truncated_by === 'BYTE_BUDGET',
    cancelled: counters.truncated_by === 'CANCELLED',
    incomplete_reason: reasons.length === 0 ? null : reasons.join('；'),
  };
}

/**
 * 结果为什么不是全貌。
 *
 * ## 什么**不**进这里，以及为什么
 *
 * `denied_files`（硬拒绝）与 `excluded_files`（搜索排除、重解析点）**不**让
 * 结果变成不完整。两者的理由不同，但方向一致：它们从一开始就不是**候选
 * 文件** —— 一个按策略永远不可读，一个按设计不参与自动遍历。把它们算成
 * 覆盖缺口，会让每一份真实仓库上的每一次搜索都报「不完整」，而一个永远
 * 响着的警报等于没有警报。它们是**范围事实**，如实出现在计数字段里。
 *
 * 与之相对，下面这些**是**缺口，因为那些文件本来会被检索：
 * 读不动、读不了、被改了、命中被抽走了、没进去的目录、没走完的遍历。
 */
function incompleteReasons(
  ctx: {
    scope: ReadScope;
    pageLimit: number;
    limits: SearchLimits;
    state: WalkState;
    counters: SearchCounters;
  },
  hasCursor: boolean,
): string[] {
  const { pageLimit, limits, state, counters } = ctx;
  const reasons: string[] = [];

  if (counters.witness !== null) {
    reasons.push(`已达到单次匹配上限 ${pageLimit} 条，本页之后仍有命中；请用 next_cursor 继续。`);
  }
  if (counters.truncated_by === 'DEADLINE') {
    reasons.push(
      `已达到时间预算 ${limits.search_time_budget_ms} ms，本次搜索提前结束，结果只覆盖已扫描的部分` +
        (hasCursor ? '；请用 next_cursor 继续。' : '；没有可续读的位置，请缩小 path 范围或收窄查询后重试。'),
    );
  }
  if (counters.truncated_by === 'BYTE_BUDGET') {
    reasons.push(
      `已达到单次扫描字节上限 ${limits.max_search_scanned_bytes} 字节，本次搜索提前结束，结果只覆盖已扫描的部分` +
        (hasCursor ? '；请用 next_cursor 继续。' : '；请缩小 path 范围后重试。'),
    );
  }
  if (counters.truncated_by === 'CANCELLED') {
    reasons.push('本次搜索已被取消，返回的是已经找到的部分结果。');
  }
  if (state.listings_exhausted) {
    reasons.push(
      `本次调用的目录询问次数已达上限，遍历提前结束` +
        (hasCursor ? '；请用 next_cursor 继续。' : '；请缩小 path 范围后重试。'),
    );
  }
  if (state.depth_pruned > 0) {
    reasons.push(`已达到深度上限 ${state.max_depth}，有 ${state.depth_pruned} 个目录未进入，其内容未被检索。`);
  }
  for (const skip of state.skipped_subtrees) {
    reasons.push(`目录 ${skip.path} 未能枚举（护栏码 ${skip.code}），该子树未被检索。`);
  }
  if (counters.too_large > 0) {
    reasons.push(
      `有 ${counters.too_large} 个文件超过单次可读上限 ${limits.max_readable_file_bytes} 字节，未被检索。`,
    );
  }
  if (counters.unreadable > 0) {
    reasons.push(`有 ${counters.unreadable} 个文件打不开（已被删除、被独占或权限不足），未被检索。`);
  }
  if (counters.unstable > 0) {
    reasons.push(`有 ${counters.unstable} 个文件在扫描期间发生变化，其结果已被丢弃。`);
  }
  if (counters.secret_files > 0) {
    // 这一条**必须**让结果变成不完整。文件确实被扫过了，但它的命中被整份
    // 抽走 —— 用户看到的是「没有命中」，而真相是「有，只是不返回」。
    // 「未找到 ≠ 不存在」这条要求在结果被抽走时同样成立。
    reasons.push(
      `有 ${counters.secret_files} 个文件里出现高置信度凭证，其内容已被整份丢弃，不会返回其中任何内容。`,
    );
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// 起点与参数
// ---------------------------------------------------------------------------

/** 起点的事实。`canonical` 是规范相对路径（工作区根为空串）。 */
interface SearchBase {
  readonly canonical: string;
  readonly volume_id: string;
  readonly file_id: string;
  readonly is_directory: boolean;
}

/**
 * 起点事实：探针一次，或者**在护栏不认的那种请求上**直接从作用域取。
 *
 * 与 `list.ts` 的同名函数逐字同构，理由也逐字相同 ——「目录工作区 + 空
 * 相对路径」是护栏 `resolvePath` 故意拒绝的一种请求（它回答的是「这个路径
 * 是哪一个对象」，而「不用路径、直接说整个根」根本不是一次寻址），而
 * 「搜整个工作区」却是最常见的一次调用。这里省掉的是一次**重复**的证明：
 * `volume_id`/`file_id` 仍取作用域里那份，而它每次都被护栏重新验过。
 */
async function resolveBase(ops: WinfsOps, scope: ReadScope, requestPath: string): Promise<SearchBase> {
  if (requestPath === '' && scope.kind === 'directory') {
    return {
      canonical: '',
      volume_id: scope.root_volume_id,
      file_id: scope.root_file_id,
      is_directory: true,
    };
  }

  const target = await resolveTarget(ops, scope, requestPath, 'directory');
  return {
    canonical: requireCanonicalPath(target.canonical_path),
    volume_id: target.identity.volume_id,
    file_id: target.identity.file_id,
    is_directory: target.attributes.is_directory,
  };
}

/**
 * 受限 glob 的编译。**只用于筛文件名，不用于任何授权判定** ——
 * 匹配成功只是让一个文件进入检索范围，匹配失败也只是让它不进。
 *
 * 返回的 `source` 是归一化后的模式（`\` 折成 `/`），它进查询指纹：
 * 同一个查询串配不同的 glob 是**两次不同的搜索**，续读时不能混。
 */
function compilePathGlob(pattern: string | undefined): { regex: RegExp; source: string } | null {
  if (pattern === undefined || pattern === null) return null;
  const result = compileGlob(pattern);
  if (!result.ok) {
    throw new BridgeError('INVALID_ARGUMENT', `path_glob 不合法：${result.reason}。`, {
      reason: 'INVALID_PATH_GLOB',
    });
  }
  return { regex: result.regex, source: result.source };
}

/**
 * 候选文件相对**起点目录**的路径。
 *
 * glob 按「相对起点」而不是「相对工作区根」匹配，理由是用起来的预期：
 * 调用方既然已经用 `path` 圈定了子树，`'*.ts'` 自然是指「这棵子树里的 ts」；
 * 若按根匹配，`'*.ts'` 会因为不跨 `/` 而一条都匹配不到子目录里的文件，
 * 而那是一次没有任何报错、只是「什么也没搜到」的失败。
 */
function relativeToBase(base: string, path: string): string {
  if (base === '') return path;
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

/** `max_matches` 只能**收紧**，不能扩大：契约的 `MAX_SEARCH_MATCHES` 是上限，不是默认值。 */
function clampMaxMatches(requested: number | undefined, limits: SearchLimits): number {
  if (requested === undefined) return limits.max_search_matches;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new BridgeError('INVALID_ARGUMENT', 'max_matches 必须是 >= 1 的整数。', {
      reason: 'INVALID_MAX_MATCHES',
    });
  }
  return Math.min(requested, limits.max_search_matches);
}

/** 供诊断与审计使用：本次搜索使用的限额。**不含任何路径。** */
export function searchLimitsOf(deps: SearchDeps): SearchLimits {
  return limitsOf(deps);
}
