/**
 * 一次执行的编排（LWB-029）。
 *
 * `native-adapter.ts` 回答「一次护栏调用返回了什么」，`journal.ts` 回答
 * 「每个文件走到了哪一步」，本模块回答**最后一个问题**：「于是这次执行
 * 算作什么」，并在算不出来的时候把话说明白。
 *
 * ```text
 *   阶段 A   逐条目核对（只读）        → refused / conflict / no_change 在这里就能定案
 *   阶段 A2  持久化边界（只读快照库）  → 取不到 ⇒ refused，目标文件零写入
 *   阶段 B   记账执行意图（短事务）    → 记不上 ⇒ 抛，且一个字节都没写
 *   阶段 C   逐条目：意图 → 写入 → 写入/刷盘/核验三条日志
 *              ↓ 失败
 *            分类（没动过 / 动过且现场已知 / 动过但收不回来）
 *              ↓ 收得回来的
 *            倒序收回**本次写过**的那些条目（每条一次，不重试）
 *   收尾     折叠逐条目终局 → applied / rolled_back / 其余一律抛（⇒ 待恢复）
 * ```
 *
 * ## 三条不可让渡的规则
 *
 * 1. **只回滚本次执行自己写下去的字节。** 每一次回滚都是一句带前置条件的
 *    护栏调用（`expected_sha256` + `expected_file_id` = **我们写完之后留在
 *    那里的那一份**）。前置条件不成立就拒绝 —— 那意味着在我们写完之后有人
 *    动过这个文件，而一次自动回滚**没有资格**抹掉一个人的改动。
 *
 *    注意前置条件取的是「我们留下的那一份」，**不是「现在盘上是什么」**：
 *    后者要靠一次新的读取才知道，而那样读到的可能正是别人刚写进去的内容 ——
 *    拿它当条件，回滚反而会理直气壮地覆盖掉那个人的改动。
 * 2. **批次失败时不自动删除本次新建对象。** 即使它看起来来自本次调用，
 *    自动删除也会把一次写失败扩大成另一项不可逆操作；失败时留下明确恢复记录，
 *    由操作者核对后可另行调用 `file_delete`。
 * 3. **不把部分完成当全成功。** 报告里那句 aggregate 由逐条目日志折叠而来，
 *    而不是「没有异常就算成功」。一个条目只要没走到「核验过」，总账里就
 *    一定有它的一条记录，而折叠函数只认三种好结局。
 *
 * ## 回滚是一次**新的**写入，这句话的代价写在这里
 *
 * 它同样可能失败，因此同样要记账（`restore_failed`），同样要**独立回读**
 * 验证（回到基线这件事不能靠写入方自己的回执来确认，哪怕回执来自护栏）。
 * 一次回滚失败**不**触发第二次尝试：本工程回滚的上界是「每条目一次」，
 * 而重试会让一次已经说不清的执行变得更说不清。剩下的交给恢复流程（LWB-030）。
 *
 * ## 中止信号在收尾阶段**不再**生效
 *
 * 阶段 A 到阶段 C 的每一步开头都检查中止。但**回滚一旦开始就不再检查**：
 * 中止的含义是「别再往工作区里写东西了」，而回滚是在把写下去的东西收回来。
 * 在一次回滚的中途放弃，留下的正好是最坏的那种状态 —— 一半文件回到了基线、
 * 一半没有，而账上什么都没记。因此收尾这一段跑到底，它是有限且短的。
 *
 * ## 它不重新做授权判断
 *
 * 与适配器同一条：手上只有 `ExecutionPlan`，而计划里的每个字段都是认领时
 * 从状态库读出来的。本模块**不**看工具参数，也不认 `approved` 之类的字样。
 */

import { BridgeError } from '@lwb/contracts';
import { transitionChange, transitionOperation } from '@lwb/changes';
import type { ReadScope } from '@lwb/files';
import type { ChangeItemRecord, Repositories } from '@lwb/persistence';
import type { WinfsWriteResult } from '@lwb/winfs';

import type { ExecutionPlan } from './claim.ts';
import type { ApplyReport, ExecutionApplier } from './coordinator.ts';
import {
  aggregateOf,
  appendItemEvent,
  describeOutcomes,
  ITEM_STAGE,
  itemOutcomes,
  readItemEvents,
  redactRoot,
  type ItemEventInput,
} from './journal.ts';
import {
  complaintOf,
  createNativeWriter,
  guardFailureFacts,
  guardVerdict,
  guardVerdictClause,
  observationIsComplete,
  restoreComplaint,
  scopeOf,
  type NativeApplierDeps,
  type NativeWriter,
  type VettedItem,
  type WriteOutcome,
} from './native-adapter.ts';

export function createNativeApplier(deps: NativeApplierDeps): ExecutionApplier {
  const writer = createNativeWriter(deps);
  return (plan, signal) => applyApprovedChange(deps, writer, plan, signal);
}

/**
 * 一个条目在本次执行里的全部痕迹。
 *
 * `written` 只在**清清楚楚写成功**时才有值（回执经得起核对）。它是回滚的
 * 前置条件，因此宁可缺席也不能是半个事实 —— 一个「写了但回执有毛病」的条目
 * 走的是失败那条路，它的前置条件从护栏的现场观测里取。
 */
interface ItemTrace {
  readonly vetted: VettedItem;
  /** 阶段 A2 拿在手上的基线字节；创建为 `null`（**没有**基线，不是取不到）。 */
  baseline: Buffer | null;
  /** 我们写下去之后、盘上那一份的身份与哈希。 */
  written: { readonly file_id: string; readonly sha256: string } | null;
}

/** 一次条目写入的失败，连同判定「接下来怎么办」需要的一切。 */
interface ItemFailure {
  readonly trace: ItemTrace;
  readonly item: ChangeItemRecord;
  /** 护栏原样交回来的那次调用结果。 */
  readonly outcome: WriteOutcome;
  /** 护栏回答可以接受、但回执经不起核对时的那句话；否则 `null`。 */
  readonly complaint: string | null;
}

async function applyApprovedChange(
  deps: NativeApplierDeps,
  writer: NativeWriter,
  plan: ExecutionPlan,
  signal: AbortSignal,
): Promise<ApplyReport> {
  const scope = scopeOf(plan.workspace);
  const items = plan.items;

  if (items.length === 0) {
    return {
      kind: 'refused',
      detail: '计划里没有任何条目；修改集建立时已要求至少一条，因此这是一次不该发生的执行。',
    };
  }

  // --- 阶段 A：核对 ---------------------------------------------------------
  // 逐条目**顺序**核对，不并发：护栏是一个常驻进程加一行一个请求的协议，
  // 并发只会让请求交错，不带来任何吞吐，却会让「第几个条目出的错」这件事
  // 变得要靠日志去猜。
  const traces: ItemTrace[] = [];
  for (const item of items) {
    throwIfAborted(signal, plan);
    traces.push({ vetted: await writer.vet(scope, item), baseline: null, written: null });
  }

  const refusals = traces.filter((t) => t.vetted.verdict.kind === 'refuse');
  const conflicts = traces.filter((t) => t.vetted.verdict.kind === 'conflict');

  // 拒绝优先：一个「本构建不能执行」的条目意味着这份计划**永远**跑不成，
  // 而重新看一遍磁盘并不会改变这一点。让冲突先报出去会让人去重新提案，
  // 而新提案会带着同一个不可执行的形态回来。
  if (refusals.length > 0) return { kind: 'refused', detail: summarize(refusals, '拒绝执行') };
  if (conflicts.length > 0) return { kind: 'conflict', detail: summarize(conflicts, '冲突') };

  const toWrite = traces.filter((t) => t.vetted.verdict.kind === 'write');

  // 一条都不用写：这不是错误，是「磁盘上已经是目标内容」。
  // 这一格**不写任何逐条目日志**（协调器会写改动级的那一条）：逐条目日志
  // 描述的是「本次执行对每个文件做了什么」，而这次执行什么都没做，
  // 它也没有进过 `APPLYING` —— 下面那句 `recordIntent` 还没执行。
  if (toWrite.length === 0) {
    return {
      kind: 'no_change',
      detail: `全部 ${items.length} 个条目在磁盘上已经是目标内容，未改动任何字节：${pathsOf(traces)}`,
    };
  }

  // --- 阶段 A2：持久化边界 --------------------------------------------------
  // 目标字节与基线字节都必须**先落稳**，才允许往工作区写第一个字节。
  // 基线字节在这里就被读进内存，而不是等失败时再去取：一次回滚发生在最没有
  // 余力的时刻，那时再去读一个 2 MiB 的对象，等于给「回滚失败」多加一条
  // 与磁盘无关的成因。
  for (const trace of toWrite) {
    throwIfAborted(signal, plan);
    const item = trace.vetted.item;
    const snaps = await writer.requireSnapshots(item);
    if (!snaps.ok) return { kind: 'refused', detail: `${snaps.detail}未改动任何文件。` };
    // 要写下去的字节必须**就是**刚刚在边界上核对过的那一份。哈希相同即字节
    // 相同，因此这里不相等只可能意味着快照库两次给出了不同的内容。
    const payload = trace.vetted.payload;
    if (payload === null || !snaps.target.equals(payload)) {
      return {
        kind: 'refused',
        detail: `${item.canonical_path} 的目标字节在两次读取之间不一致（快照库给出了不同的内容）。未改动任何文件。`,
      };
    }
    trace.baseline = snaps.baseline;
  }

  // 中止可能落在阶段 A / A2 **之内**（最后一次核对还没回来时就有人喊停），
  // 而那句中止只有在阶段 C 的循环开头才会被看见 —— 那时账已经记过了。
  // 于是记录里写着 `APPLYING`（「字节可能已经在盘上了」），而实际一个字节
  // 都没写：一次被取消的执行会以「磁盘状态不明」的名义要求人工核验，
  // 而事实是「什么都没发生」。这里补一次检查，代价是一行。
  throwIfAborted(signal, plan);

  // --- 阶段 B：记账 --------------------------------------------------------
  // 「我这就开始写了」必须落在**第一个字节之前**：`APPLYING` 这一格的含义
  // 就是「字节可能已经在盘上了」。两个转移在同一个事务里，因此不存在
  // 「修改集记了、操作没记」的中间态。
  recordIntent(deps.repos, plan);

  // --- 阶段 C：写入 --------------------------------------------------------
  // 按**计划给的次序**遍历全部条目（不只是要写的那些）：`already_target`
  // 的条目也要在日志里留下一条，否则折叠时「这个条目一条日志都没有」与
  // 「进程在它之前就死了」无法区分。
  let failure: ItemFailure | null = null;
  for (const trace of traces) {
    if (failure !== null) break;
    if (trace.vetted.verdict.kind === 'already_target') {
      noteSkipped(deps.repos, scope, plan, trace);
      continue;
    }
    failure = await writeOne(deps, writer, scope, plan, trace, signal);
  }

  // --- 收尾：分类、有界回滚、折叠 -------------------------------------------
  let failureLine = '';
  if (failure !== null) {
    failureLine = await classifyFailure(deps, writer, scope, plan, failure);
    await unwind(deps, writer, scope, plan, traces, failure);
    noteNotAttempted(deps.repos, scope, plan, traces, failure.trace);
  }

  const outcomes = itemOutcomes(readItemEvents(deps.repos, plan.operation_id));
  const aggregate = aggregateOf(outcomes, items.length);
  const summary = describeOutcomes(outcomes, new Map(items.map((item) => [item.id, item.canonical_path])));

  switch (aggregate) {
    case 'applied':
      return { kind: 'applied', detail: `全部 ${items.length} 个条目已按计划写入并核验。逐条目：${summary}` };

    case 'rolled_back': {
      // 「收回」与「回到执行之前的样子」是两句话，而只有前一句在这个位置上
      // **总是**成立。`rolled_back` 允许 `untouched` 的条目（见 `journal.ts`
      // 的折叠表），而 `untouched` 最主要的两种成因 —— 基线哈希不符、
      // 对象已经换人 —— 本身就意味着**盘上已经不是执行之前的样子了**。
      // 两句话并排说出去，会在同一份报告里同时出现「独立回读看到的是…与
      // 基线不同」与「工作区回到执行之前的样子」：前一句是本模块在上面刚
      // 刚写下的。一份自相矛盾的报告比一句含糊的话糟得多 —— 它把「别人改过
      // 盘」这件事从报告里说没了，而那正是操作者此刻最需要知道的事。
      const untouchedCount = [...outcomes.values()].filter((o) => o.kind === 'untouched').length;
      return {
        kind: 'rolled_back',
        detail:
          `${failureLine} 本次执行写下去的字节已全部收回，` +
          (untouchedCount === 0
            ? '工作区回到执行之前的样子'
            : `工作区里没有本次执行留下的字节；${untouchedCount} 个条目是护栏在动笔之前就拒绝的，` +
              '它们在那时已经不是被批准的基线，盘上那部分内容不是本次执行写下的') +
          `（逐条目：${summary}）。修改集未被应用。`,
      };
    }

    case 'no_change':
      // 阶段 C 跑过之后**不可能**是这一格：走到这里说明至少有一个条目被判成
      // 「要写」，而它要么写成功（⇒ `written`）、要么失败（⇒ 一条非 `skipped`
      // 的终局记录）。两种都不会让全部条目都停在 `skipped`。
      //
      // 真正的 `no_change` 在上面那句 `recordIntent` **之前**就返回了 ——
      // 那时状态还是 `VALIDATING`，`VALIDATING → FAILED_NO_CHANGE` 是一条
      // 合法的边；而此刻状态已经是 `APPLYING`，那条边不存在。因此这一格
      // 只能按「账本与本次执行矛盾」处理，不能报 `no_change`。
      throw new BridgeError('RECOVERY_REQUIRED', `${failureLine} 逐条目账本显示全部条目都无需改动，而本次执行已经记下过执行意图。${summary}`, {
        reason: 'AGGREGATE_CONTRADICTS_LOOP',
        change_id: plan.change.id,
        operation_id: plan.operation_id,
      });

    case 'unfinished':
      throw new BridgeError('RECOVERY_REQUIRED', `${failureLine} ${summary}`, {
        reason: 'WRITE_FAILED_MIDWAY',
        change_id: plan.change.id,
        operation_id: plan.operation_id,
        path: failure?.item.canonical_path ?? null,
        ...guardDetails(failure),
      });

    default: {
      const never: never = aggregate;
      throw new Error(`未处理的折叠结果：${String(never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 阶段 C：一次写入
// ---------------------------------------------------------------------------

/**
 * 一个条目的完整变更序列：意图 → 写入/删除 → 经核对的结果日志。
 *
 * 返回 `null` 表示写成功；返回 `ItemFailure` 表示失败。**不抛** ——
 * 抛会把「接下来该回滚什么」这个决定从调用点拿走，而那是本模块存在的理由。
 */
async function writeOne(
  deps: NativeApplierDeps,
  writer: NativeWriter,
  scope: ReadScope,
  plan: ExecutionPlan,
  trace: ItemTrace,
  signal: AbortSignal,
): Promise<ItemFailure | null> {
  // 绝不在已中止之后开始一次写入：中止之后的写入无法被回执描述，
  // 而协调器会把那份回执丢掉、按待恢复处理 —— 那就更不该多写一个字节。
  throwIfAborted(signal, plan);

  const item = trace.vetted.item;
  // 意图写在护栏调用**之前**，且自己一个事务：它是「这个文件可能已经被动过」
  // 这句话第一次落到盘上的时刻，而它必须落在第一个字节之前。
  // 记不上就**不写**（`appendItemEvent` 会抛，这里不吞）。
  journal(deps.repos, scope, plan, trace, {
    stage: ITEM_STAGE.intent,
    target_sha256: item.target_sha256,
      detail: '准备写入这个条目。',
  });

  const outcome = await writer.write(scope, trace.vetted);
  if (!outcome.ok) return { trace, item, outcome, complaint: null };

  if (outcome.mode === 'delete_file') {
    const receipt = outcome.result;
    const complaint = complaintOf(item, outcome);
    if (complaint !== null) return { trace, item, outcome, complaint };
    deps.repos.transaction(() => {
      journal(deps.repos, scope, plan, trace, {
        stage: ITEM_STAGE.deleted,
        observed_file_id: null,
        observed_sha256: item.target_sha256,
        target_sha256: item.target_sha256,
        detail: '受保护护栏核对原对象身份与内容后删除；独立回读确认原路径不存在。',
      });
    });
    // Retain the original identity/hash as the restore precondition basis.
    trace.written = { file_id: receipt.identity_before.file_id, sha256: receipt.before_sha256 };
    return null;
  }
  if (outcome.mode === 'restore_deleted_file') {
    return { trace, item, outcome, complaint: '前向执行收到意外的 delete-restore 回执。' };
  }

  const complaint = complaintOf(item, outcome);
  if (complaint !== null) return { trace, item, outcome, complaint };

  // 三条日志一个事务：它们描述的是**同一件事**（这一次写入的结果），
  // 分开写会留下「说了写了、没说刷没刷」的中间态，而恢复流程正是靠
  // 「哪一格走过」来判断磁盘状态的。
  const receipt = outcome.result;
  deps.repos.transaction(() => {
    journal(deps.repos, scope, plan, trace, {
      stage: ITEM_STAGE.written,
      observed_file_id: receipt.identity_after.file_id,
      observed_sha256: receipt.after_sha256,
      target_sha256: item.target_sha256,
      detail: '护栏报告字节已写出。',
    });
    journal(deps.repos, scope, plan, trace, {
      stage: ITEM_STAGE.flushed,
      observed_file_id: receipt.identity_after.file_id,
      observed_sha256: receipt.after_sha256,
      target_sha256: item.target_sha256,
      detail: '护栏报告已刷盘。',
    });
    journal(deps.repos, scope, plan, trace, {
      stage: ITEM_STAGE.verified,
      observed_file_id: receipt.identity_after.file_id,
      observed_sha256: receipt.after_sha256,
      target_sha256: item.target_sha256,
      detail: '回读与已批准的新内容逐字节相同。',
    });
  });

  // 到这里才把「我们留下了什么」记进内存 —— 它是回滚的前置条件，
  // 因此只能来自一份**经得起核对**的回执。
  trace.written = { file_id: receipt.identity_after.file_id, sha256: receipt.after_sha256 };
  return null;
}

// ---------------------------------------------------------------------------
// 失败之后的分类
// ---------------------------------------------------------------------------

/**
 * 判定失败的那个条目在磁盘上留下了什么，并把这条结论记进日志。
 *
 * 三分支，判据全部来自护栏的回答（`guardFailureFacts` 的那张三行的表）：
 *
 * | 情形 | 结论 | 后续 |
 * | --- | --- | --- |
 * | 护栏没越过破坏性区域 | `untouched` | 不需要收回 |
 * | 越过了，且现场完整可读（改写） | 尝试 `restore` | 成功 ⇒ `restored`；失败 ⇒ `restore_failed` |
 * | 越过了，但现场未知 / 观测被截断 / 是新建的文件 | `restore_skipped` | 待恢复 |
 *
 * 返回值是一句给报告用的话 —— 它进 `detail`，也就是操作者读病因的地方。
 */
async function classifyFailure(
  deps: NativeApplierDeps,
  writer: NativeWriter,
  scope: ReadScope,
  plan: ExecutionPlan,
  failure: ItemFailure,
): Promise<string> {
  const { item, outcome, complaint } = failure;
  const path = item.canonical_path;
  const isCreate = failure.trace.vetted.mode === 'create_text';

  // --- 回执不满意：护栏说写成功了，但那次写入不是我们要的 -------------------
  if (complaint !== null && outcome.ok) {
    if (outcome.mode === 'delete_file') {
      journal(deps.repos, scope, plan, failure.trace, {
        stage: ITEM_STAGE.failed,
        observed_file_id: outcome.result.identity_before.file_id,
        observed_sha256: outcome.result.before_sha256,
        target_sha256: item.target_sha256,
        error_code: 'DELETE_RECEIPT_REJECTED',
        detail: complaint,
      });
      const restored = await attemptRestore(deps, writer, scope, plan, failure.trace, {
        file_id: outcome.result.identity_before.file_id,
        sha256: outcome.result.before_sha256,
      });
      return restored
        ? `条目「${path}」删除回执不完整；已从快照恢复基线内容并回读核对。`
        : `条目「${path}」删除回执不完整；恢复未能确认，必须查看本地恢复页。`;
    }
    // 两种回执都有的那两项先取出来：创建的回执没有 `identity_before`，
    // 因此下面用到它的地方必须在 `isCreate` 那一支返回**之后**。
    const after = outcome.result.identity_after;
    const afterSha256 = outcome.result.after_sha256;
    journal(deps.repos, scope, plan, failure.trace, {
      stage: ITEM_STAGE.failed,
      observed_file_id: after.file_id,
      observed_sha256: afterSha256,
      target_sha256: item.target_sha256,
      error_code: 'RECEIPT_REJECTED',
      detail: complaint,
    });

    if (isCreate) {
      // 对象已经建出来；本次自动回滚不扩大为一次额外删除。
      journal(deps.repos, scope, plan, failure.trace, {
        stage: ITEM_STAGE.restore_skipped,
        observed_file_id: after.file_id,
        observed_sha256: afterSha256,
        error_code: 'CREATED_OBJECT_NOT_REMOVED',
        detail: '这个对象是本次执行创建出来的；自动回滚不删除新建对象，以免把异常恢复扩展成另一次删除。',
      });
      return `条目「${path}」写入失败：${complaint}该文件是本次执行创建出来的；自动回滚未删除它，需要本地检查后再决定是否调用 file_delete。`;
    }

    // 到这里 `outcome.mode` 一定是 `edit_text`（上面那一支带走了创建），
    // 而那正是 `writeItem` 决定回执形状的依据。
    const receipt = outcome.result as WinfsWriteResult;
    if (receipt.identity_after.file_id !== receipt.identity_before.file_id) {
      // 写入期间对象被换掉了。此时「盘上这一份是我们写的」这句话不再成立，
      // 因此不能拿它的哈希当作回滚的前置条件 —— 那会把一次回滚指向一个
      // 我们没写过的对象。
      journal(deps.repos, scope, plan, failure.trace, {
        stage: ITEM_STAGE.restore_skipped,
        observed_file_id: receipt.identity_after.file_id,
        error_code: 'IDENTITY_CHANGED_DURING_WRITE',
        detail: '写入期间对象身份发生了变化，无法确认当前对象是不是本次执行写入的那一个。',
      });
      return `条目「${path}」写入失败：${complaint}写入期间对象身份发生了变化，无法自动收回，需要人工确认。`;
    }

    const atBaseline = await attemptRestore(deps, writer, scope, plan, failure.trace, {
      file_id: after.file_id,
      sha256: afterSha256,
    });
    return atBaseline
      ? `条目「${path}」写入失败：${complaint}已按其回执把基线内容写回去，独立回读证实已回到基线。`
      : `条目「${path}」写入失败：${complaint}尝试收回失败，盘上可能留有本次执行的字节。`;
  }

  // --- 护栏拒绝了这次调用 ---------------------------------------------------
  if (outcome.ok) throw new Error(`条目 ${item.id} 既没有回执抱怨、也不是一次拒绝，却走到了失败分类。`);
  const error = outcome.error;
  const facts = guardFailureFacts(error);
  // 护栏的消息是在**它自己的坐标系**里写的，里面带着目标的绝对路径
  // （`WinfsGuard.ps1` 的 `Open-Guarded` 把 `$Path` 拼进消息）。
  // 这句话往下走三条路：条目级日志、报告、以及 `throw` 出去的
  // `RECOVERY_REQUIRED` —— 最后那条由协调器原样写进**改动级**日志行，
  // 而那一行不经过 `appendItemEvent` 的脱敏。因此脱敏在这里做、
  // 也就是在**这句话被造出来的地方**：越靠上游，漏掉的出口越少。
  const guardLine = `护栏拒绝（${facts.winfs_code}${facts.win32_error === 0 ? '' : `，Win32 ${facts.win32_error}`}）：${redactRoot(error.message, scope)}`;

  if (facts.provesUntouched) {
    journal(deps.repos, scope, plan, failure.trace, {
      stage: ITEM_STAGE.untouched,
      observed_file_id: item.base_file_id,
      observed_sha256: item.base_sha256,
      target_sha256: item.target_sha256,
      error_code: facts.winfs_code,
      detail: `${guardLine}。${guardVerdictClause(facts)}，本次执行在这个文件上没有留下字节。`,
    });
    return `条目「${path}」写入失败：${guardLine}。${await corroborate(deps, writer, scope, item, isCreate, item.op === 'delete_file')}本次执行在这个文件上没有留下字节。`;
  }

  journal(deps.repos, scope, plan, failure.trace, {
    stage: ITEM_STAGE.failed,
    observed_file_id: facts.actual?.identity.file_id ?? null,
    observed_sha256: facts.actual?.sha256 ?? null,
    target_sha256: item.target_sha256,
    error_code: facts.winfs_code,
    /* 这一句说的是**手上有什么证据**，不是磁盘上发生了什么。
       走到这里时 `provesUntouched` 是假，而那有两种成因：护栏**说过**它进了
       破坏性区域（`touched`），或者它什么都没说过（客户端合成的不可用）。
       把后一种印成「已进入破坏性区域」，就是在操作者最需要知道「我不知道」
       的那一格上印了一句断言。 */
    detail: `${guardLine}。${guardVerdictClause(facts)}。`,
  });

  if (item.op === 'delete_file') {
    const restored = await attemptRestore(deps, writer, scope, plan, failure.trace, {
      file_id: item.base_file_id!,
      sha256: item.base_sha256!,
    });
    return restored
      ? `条目「${path}」删除调用结果不确定；已核验或从快照恢复到删除前内容。`
      : `条目「${path}」删除调用结果不确定；路径/快照状态需在本地恢复页处理。`;
  }

  // 从这里往下都是「动过」，区别只在收不收得回来。
  const blocked = restoreBlocker(failure, facts);
  if (blocked !== null) {
    journal(deps.repos, scope, plan, failure.trace, {
      stage: ITEM_STAGE.restore_skipped,
      observed_file_id: facts.actual?.identity.file_id ?? null,
      observed_sha256: facts.actual?.sha256 ?? null,
      error_code: blocked.code,
      detail: blocked.detail,
    });
    return `条目「${path}」写入失败：${guardLine}。${guardVerdictClause(facts)}，而${blocked.detail}需要人工确认。`;
  }

  // `restoreBlocker` 放行的只有一种情形：动过、现场完整可读、且是改写。
  const actual = facts.actual!;
  const atBaseline = await attemptRestore(deps, writer, scope, plan, failure.trace, {
    file_id: actual.identity.file_id,
    sha256: actual.sha256!,
  });
  return atBaseline
    ? `条目「${path}」写入失败：${guardLine}。已按其现场观测把基线内容写回去，独立回读证实已回到基线。`
    : `条目「${path}」写入失败：${guardLine}。尝试收回失败，盘上可能留有本次执行的字节，需要人工确认。`;
}

/**
 * 「动过，但**不能**自动收回」的全部理由。返回 `null` 表示可以试着收回。
 *
 * 每一条都对应护栏那张三行表里的一格，或者一条工程上的不可逆：
 *
 *  - `NATIVE_GUARD_UNAVAILABLE`：`touched` 缺席，但**不能**当作「没动过」——
 *    这个码有可能是客户端合成的「没连上护栏」，那时响应根本没从护栏回来，
 *    而「进程被杀」与「干净地拒绝了」在调用方看起来是一样的。
 *  - 现场未知（`touched` 有、`actual_state` 没有）：护栏自己都没能看一眼。
 *  - 观测被 1 MiB 上界截断：取不到完整哈希，而回滚的前置条件正是一个完整哈希。
 *  - 创建：收回它需要删除文件。
 *  - 没有基线字节：理论上被阶段 A2 挡住，走到这里说明账已经坏了。
 */
function restoreBlocker(
  failure: ItemFailure,
  facts: ReturnType<typeof guardFailureFacts>,
): { readonly code: string; readonly detail: string } | null {
  if (facts.winfs_code === 'NATIVE_GUARD_UNAVAILABLE') {
    return {
      code: 'GUARD_UNAVAILABLE_PROVES_NOTHING',
      detail: '护栏不可用，这个回答没有证明任何事（它可能是客户端合成的，根本没到过护栏）',
    };
  }
  if (!facts.observed || facts.actual === undefined) {
    return {
      code: 'GUARD_STATE_UNOBSERVED',
      detail: '护栏没能在这个句柄里取到实际状态，现场未知',
    };
  }
  if (!observationIsComplete(facts.actual)) {
    return {
      code: 'GUARD_STATE_TRUNCATED',
      detail: `现场观测被 ${facts.actual.cap_bytes} 字节的上界截断，取不到完整哈希（回滚的前置条件正是一个完整哈希）`,
    };
  }
  if (failure.trace.vetted.mode === 'create_text') {
    return {
      code: 'CREATED_OBJECT_NOT_REMOVED',
      detail: '这个对象是本次执行创建出来的；自动回滚不删除新建对象，以免扩大恢复写入范围。',
    };
  }
  if (failure.trace.baseline === null) {
    return {
      code: 'NO_BASELINE_BYTES',
      detail: '手上没有这个条目的基线字节（阶段 A2 本该拦住这种情形），无法把内容写回去',
    };
  }
  return null;
}

/**
 * 把基线内容写回去，并用**独立回读**证实它真的回去了。
 *
 * 返回「现在可以证明这个文件已回到基线」。失败的每一种成因都记进日志，
 * 且**每条目只试一次** —— 理由见模块头。
 */
async function attemptRestore(
  deps: NativeApplierDeps,
  writer: NativeWriter,
  scope: ReadScope,
  plan: ExecutionPlan,
  trace: ItemTrace,
  basis: { readonly file_id: string; readonly sha256: string },
): Promise<boolean> {
  const item = trace.vetted.item;
  const baseline = trace.baseline;
  const relative_path = trace.vetted.canonical_path;

  if (baseline === null || relative_path === null || item.base_sha256 === null || item.base_file_id === null) {
    journal(deps.repos, scope, plan, trace, {
      stage: ITEM_STAGE.restore_skipped,
      error_code: 'NO_BASELINE_BYTES',
      detail: '手上没有这个条目的基线字节或基线身份，无法把内容写回去。',
    });
    return false;
  }

  if (item.op === 'delete_file') {
    return await attemptRestoreDeletedFile(deps, writer, scope, plan, trace, baseline, relative_path);
  }

  const outcome = await writer.restore(scope, {
    item,
    relative_path,
    // 前置条件：盘上还是**我们写完之后**的那一份（不是「现在盘上是什么」）。
    expected_file_id: basis.file_id,
    expected_sha256: basis.sha256,
    bytes: baseline,
  });

  if (!outcome.ok) {
    journal(deps.repos, scope, plan, trace, {
      stage: ITEM_STAGE.restore_failed,
      observed_file_id: basis.file_id,
      observed_sha256: basis.sha256,
      error_code: outcome.error.code,
      // 同样在源头脱敏：这几条目前只进条目级日志（那里也会脱敏），
      // 但它们离「被拼进一句会抛出去的话」只有一次改动的距离。
      detail: `回滚被护栏拒绝（${outcome.error.code}，Win32 ${outcome.error.win32_error}）：${redactRoot(outcome.error.message, scope)}`,
    });
    return false;
  }

  if (outcome.mode !== 'edit_text') {
    journal(deps.repos, scope, plan, trace, {
      stage: ITEM_STAGE.restore_failed,
      error_code: 'UNEXPECTED_RESTORE_MODE',
      detail: `改写回滚收到意外的护栏回执类型（${outcome.mode}）；未将其报告为已恢复。`,
    });
    return false;
  }

  // 回执要证明的是「写下去的确实是基线那一份」，而它的前置条件（上面那两个
  // expected）证明的是「写的确实是那个对象」。两件事都要。
  const complaint = restoreComplaint(
    item,
    { sha256: item.base_sha256, file_id: basis.file_id, bytes: baseline.length },
    outcome,
  );
  if (complaint !== null) {
    journal(deps.repos, scope, plan, trace, {
      stage: ITEM_STAGE.restore_failed,
      observed_file_id: outcome.result.identity_after.file_id,
      observed_sha256: outcome.result.after_sha256,
      error_code: 'RESTORE_RECEIPT_REJECTED',
      detail: complaint,
    });
    return false;
  }

  // **独立回读**：另起一次护栏调用去问「这个文件现在是什么」。回执描述的是
  // 写入那一刻，而这里要回答的是*现在*；把两者分开，才可能发现
  // 「护栏说写回去了、而盘上不是」这种最糟的组合。
  const state = await writer.readState(scope, item);
  if (!state.ok) {
    journal(deps.repos, scope, plan, trace, {
      stage: ITEM_STAGE.restore_failed,
      observed_file_id: basis.file_id,
      observed_sha256: basis.sha256,
      error_code: 'RESTORE_READBACK_FAILED',
      detail: `回滚之后无法独立回读（${state.error.code}），因此不能声称它已回到基线：${redactRoot(state.error.message, scope)}`,
    });
    return false;
  }
  if (state.sha256 !== item.base_sha256 || state.file_id !== item.base_file_id) {
    journal(deps.repos, scope, plan, trace, {
      stage: ITEM_STAGE.restore_failed,
      observed_file_id: state.file_id,
      observed_sha256: state.sha256,
      error_code: 'RESTORE_READBACK_MISMATCH',
      detail:
        `回滚之后的独立回读是 ${state.sha256}／身份 ${state.file_id}，` +
        `而基线是 ${item.base_sha256}／身份 ${item.base_file_id}。`,
    });
    return false;
  }

  journal(deps.repos, scope, plan, trace, {
    stage: ITEM_STAGE.restored,
    observed_file_id: state.file_id,
    observed_sha256: state.sha256,
    target_sha256: item.base_sha256,
    detail: '基线内容已写回，独立回读证实哈希与对象身份都与执行之前一致。',
  });
  trace.written = null;
  return true;
}

/**
 * A delete rollback is not an overwrite: first prove the name is absent, then
 * restore the snapshotted bytes with CREATE_NEW so a later user file is never
 * replaced. A recreated file has a new NTFS file ID; byte hash plus the exact
 * create receipt is therefore the recovery proof.
 */
async function attemptRestoreDeletedFile(
  deps: NativeApplierDeps,
  writer: NativeWriter,
  scope: ReadScope,
  plan: ExecutionPlan,
  trace: ItemTrace,
  baseline: Buffer,
  relativePath: string,
): Promise<boolean> {
  const item = trace.vetted.item;
  const current = await writer.readState(scope, item);
  if (current.ok) {
    if (current.file_id === item.base_file_id && current.sha256 === item.base_sha256) {
      journal(deps.repos, scope, plan, trace, {
        stage: ITEM_STAGE.restored,
        observed_file_id: current.file_id,
        observed_sha256: current.sha256,
        target_sha256: item.base_sha256,
        detail: '独立回读确认原文件仍是删除前的对象与字节；未覆盖或重建。',
      });
      trace.written = null;
      return true;
    }
    journal(deps.repos, scope, plan, trace, {
      stage: ITEM_STAGE.restore_skipped,
      observed_file_id: current.file_id,
      observed_sha256: current.sha256,
      error_code: 'DELETE_RESTORE_TARGET_REPLACED',
      detail: '原路径现由另一个对象占用；为避免覆盖后来的文件，未自动恢复。',
    });
    return false;
  }
  if (current.error.code !== 'NOT_FOUND') {
    journal(deps.repos, scope, plan, trace, {
      stage: ITEM_STAGE.restore_skipped,
      error_code: current.error.code,
      detail: `恢复前无法确认删除目标是否仍为空（${current.error.code}）；未尝试创建。`,
    });
    return false;
  }

  const outcome = await writer.restore(scope, {
    item,
    relative_path: relativePath,
    expected_file_id: item.base_file_id!,
    expected_sha256: item.base_sha256!,
    bytes: baseline,
  });
  if (!outcome.ok) {
    journal(deps.repos, scope, plan, trace, {
      stage: ITEM_STAGE.restore_failed,
      error_code: outcome.error.code,
      detail: `通过 CREATE_NEW 恢复删除文件失败（${outcome.error.code}）：${redactRoot(outcome.error.message, scope)}`,
    });
    return false;
  }
  const complaint = restoreComplaint(
    item,
    { sha256: item.base_sha256!, file_id: item.base_file_id!, bytes: baseline.length },
    outcome,
  );
  if (complaint !== null || outcome.mode !== 'restore_deleted_file') {
    journal(deps.repos, scope, plan, trace, {
      stage: ITEM_STAGE.restore_failed,
      error_code: 'DELETE_RESTORE_RECEIPT_REJECTED',
      detail: complaint ?? '恢复路径没有返回 CREATE_NEW 的核验回执。',
    });
    return false;
  }

  const restoredId = outcome.result.identity_after.file_id;
  const after = await writer.readState(scope, item);
  if (!after.ok || after.file_id !== restoredId || after.sha256 !== item.base_sha256) {
    journal(deps.repos, scope, plan, trace, {
      stage: ITEM_STAGE.restore_failed,
      observed_file_id: after.ok ? after.file_id : null,
      observed_sha256: after.ok ? after.sha256 : null,
      error_code: after.ok ? 'DELETE_RESTORE_READBACK_MISMATCH' : after.error.code,
      detail: after.ok
        ? '删除回滚后的独立回读与 CREATE_NEW 回执/基线哈希不一致。'
        : `删除回滚后无法独立回读（${after.error.code}）。`,
    });
    return false;
  }

  journal(deps.repos, scope, plan, trace, {
    stage: ITEM_STAGE.restored,
    observed_file_id: after.file_id,
    observed_sha256: after.sha256,
    target_sha256: item.base_sha256,
    detail: '删除回滚以 CREATE_NEW 从快照重建文件；回读确认新对象字节与删除前基线一致。',
  });
  trace.written = null;
  return true;
}

/**
 * 倒序收回本次执行写成功的那些条目。
 *
 * **倒序**：计划里的次序是按加锁次序排的（`claim.ts`），倒着来就是先解
 * 最后一把锁 —— 与「怎么进去的就怎么出来」一致，也让一次中途停下的回滚
 * 留下的状态与「这次执行还没走到那么远」最接近。
 *
 * 失败的那个条目**不在这里**：它的处置由 `classifyFailure` 决定（它可能
 * 根本不需要或者不能够被收回）。这里只处理「已经写成功了、现在要撤销」。
 */
async function unwind(
  deps: NativeApplierDeps,
  writer: NativeWriter,
  scope: ReadScope,
  plan: ExecutionPlan,
  traces: readonly ItemTrace[],
  failure: ItemFailure,
): Promise<void> {
  for (const trace of [...traces].reverse()) {
    if (trace === failure.trace) continue;
    const written = trace.written;
    if (written === null) continue;

    const item = trace.vetted.item;
    if (trace.vetted.mode === 'create_text' || trace.baseline === null) {
      // 建出来的对象收不回来（不删用户文件），而没有基线就没有内容可写回。
      journal(deps.repos, scope, plan, trace, {
        stage: ITEM_STAGE.restore_skipped,
        observed_file_id: written.file_id,
        observed_sha256: written.sha256,
        error_code: trace.vetted.mode === 'create_text' ? 'CREATED_OBJECT_NOT_REMOVED' : 'NO_BASELINE_BYTES',
        detail:
          trace.vetted.mode === 'create_text'
            ? '这个对象是本次执行创建出来的；自动回滚未删除它，需要本地检查后再决定是否调用 file_delete。'
            : '手上没有这个条目的基线字节，无法把内容写回去。',
      });
      continue;
    }

    await attemptRestore(deps, writer, scope, plan, trace, written);
  }
}

/**
 * 为**失败之后**还没轮到、因而一条日志都没有的条目补记一条 `untouched`。
 *
 * 「没轮到」与「动过了但没记」在账上必须分得开，否则折叠会得出
 * `unfinished` —— 而那会要求人工核验一批**从来没被碰过**的文件。
 * 这条结论在本进程里是确定的：循环在第一个失败处就停了，
 * 后面的条目连一次护栏调用都没有发生过。
 */
function noteNotAttempted(
  repos: Repositories,
  scope: ReadScope,
  plan: ExecutionPlan,
  traces: readonly ItemTrace[],
  stoppedAt: ItemTrace,
): void {
  const from = traces.indexOf(stoppedAt);
  if (from < 0) return;
  for (const trace of traces.slice(from + 1)) {
    journal(repos, scope, plan, trace, {
      stage: ITEM_STAGE.untouched,
      observed_file_id: trace.vetted.item.base_file_id,
      observed_sha256: trace.vetted.item.base_sha256,
      target_sha256: trace.vetted.item.target_sha256,
      error_code: 'NOT_ATTEMPTED',
      detail: '本次执行在这个条目之前就停了，没有向护栏提交过它。',
    });
  }
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

/** 逐条目日志的一次追加，带上「这一条属于哪个操作/条目/作用域」。 */
function journal(
  repos: Repositories,
  scope: ReadScope,
  plan: ExecutionPlan,
  trace: ItemTrace,
  event: Omit<ItemEventInput, 'operation_id' | 'item_id' | 'scope'>,
): number {
  return appendItemEvent(repos, {
    operation_id: plan.operation_id,
    item_id: trace.vetted.item.id,
    scope,
    ...event,
  });
}

function noteSkipped(repos: Repositories, scope: ReadScope, plan: ExecutionPlan, trace: ItemTrace): void {
  journal(repos, scope, plan, trace, {
    stage: ITEM_STAGE.skipped,
    observed_sha256: trace.vetted.item.target_sha256,
    target_sha256: trace.vetted.item.target_sha256,
    detail: '阶段 A 核对时磁盘上已经是本条目的目标内容，本次执行未改动它。',
  });
}

/**
 * 一个佐证句：护栏说「没动过」之后，再**独立**问一次文件现在是什么。
 *
 * 护栏的 `touched` 缺席已经是「一个字节都没动」的**权威**回答（它是在句柄里
 * 知道的事实），因此这次回读**不改变结论**，只做两件事：把「现在盘上是什么」
 * 记进日志，以及在那句话与结论不符时留下痕迹 —— 那种不符不是本次执行造成的，
 * 但它正是操作者需要知道的事。
 */
async function corroborate(
  deps: NativeApplierDeps,
  writer: NativeWriter,
  scope: ReadScope,
  item: ChangeItemRecord,
  isCreate: boolean,
  isDelete: boolean,
): Promise<string> {
  const state = await writer.readState(scope, item);

  if (isCreate) {
    if (!state.ok && state.error.code === 'NOT_FOUND') return '独立回读确认该路径下没有对象。';
    if (state.ok) {
      return `独立回读发现该路径下已经有一个对象（身份 ${state.file_id}）；它不是本次执行创建的，请人工确认。`;
    }
    return `独立回读没有完成（${state.error.code}），只有护栏的报告作依据。`;
  }

  if (isDelete) {
    if (!state.ok && state.error.code === 'NOT_FOUND') {
      return '独立回读发现路径当前不存在；护栏报告本次调用未进入删除区域，因此不把缺失归因于本操作。';
    }
    if (!state.ok) return `独立回读没有完成（${state.error.code}），只有护栏的报告作依据。`;
    if (state.file_id === item.base_file_id && state.sha256 === item.base_sha256) {
      return '独立回读证实原文件仍是读取时的对象与字节。';
    }
    return `独立回读发现路径上是另一个对象/版本（${state.file_id}/${state.sha256}），不归因于本次删除。`;
  }

  if (!state.ok) return `独立回读没有完成（${state.error.code}），只有护栏的报告作依据。`;
  if (state.sha256 === item.base_sha256 && state.file_id === item.base_file_id) {
    return '独立回读证实它仍是执行之前的那一个对象、执行之前的那一份内容。';
  }
  return `独立回读看到的是哈希 ${state.sha256}／身份 ${state.file_id}，与基线不同；那不是本次执行写下的内容，请人工确认。`;
}

function summarize(blocked: readonly ItemTrace[], label: string): string {
  const HEAD = 3;
  const head = blocked.slice(0, HEAD).map((t) => {
    const verdict = t.vetted.verdict;
    const detail = verdict.kind === 'refuse' || verdict.kind === 'conflict' ? verdict.detail : '';
    return `「${t.vetted.item.canonical_path}」：${detail}`;
  });
  const rest = blocked.length > HEAD ? `（另有 ${blocked.length - HEAD} 个条目同样${label}，逐条目详情见执行日志。）` : '';
  return `${label} ${blocked.length} 个条目，未写入任何字节。${head.join(' ')}${rest}`;
}

function pathsOf(traces: readonly ItemTrace[]): string {
  return traces.map((t) => `「${t.vetted.item.canonical_path}」`).join('、');
}

function recordIntent(repos: Repositories, plan: ExecutionPlan): void {
  try {
    repos.transaction(() => {
      transitionChange(repos, { change_id: plan.change.id, from: ['VALIDATING'], to: 'APPLYING' });
      transitionOperation(repos, { operation_id: plan.operation_id, from: ['VALIDATING'], to: 'APPLYING' });
    });
  } catch (error) {
    // 记不上账就**不许写**：`APPLYING` 这一格是「字节可能已经在盘上」的
    // 唯一记录，没有它，一次真实写入会变成状态库里查不到来由的内容。
    // 因此这里抛，而不是「记不上就算了」—— 而抛出时确实一个字节都没动。
    throw new BridgeError('RECOVERY_REQUIRED', `无法把执行意图写入状态库，因此没有开始写入：${messageOf(error)}`, {
      reason: 'INTENT_RECORD_FAILED',
      change_id: plan.change.id,
      operation_id: plan.operation_id,
    });
  }
}

function throwIfAborted(signal: AbortSignal, plan: ExecutionPlan): void {
  if (!signal.aborted) return;
  const why = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? '未知原因');
  // 中止**必须抛**，不能返回报告：返回报告等于宣称自己知道磁盘的状态，
  // 而中止恰恰意味着有人已经认定这次写入不该继续（见 `ExecutionApplier`）。
  // 抛出去之后协调器会按待恢复处理 —— 而这次执行可能已经写了一半，
  // 那正是「不知道写到哪」的定义。
  throw new BridgeError('RECOVERY_REQUIRED', `执行 ${plan.operation_id} 被中止：${why}`, {
    reason: 'ABORTED',
    change_id: plan.change.id,
  });
}

/** 待恢复时写给操作者的机器可读字段（`BridgeError.details`）。 */
function guardDetails(failure: ItemFailure | null): Record<string, string | number | boolean | null> {
  if (failure === null) return {};
  const outcome = failure.outcome;
  if (outcome.ok) {
    return {
      write_mode: outcome.mode,
      guard_verdict: 'RECEIPT_REJECTED',
      guard_touched: true,
      guard_observed: true,
      winfs_code: null,
      win32_error: null,
    };
  }
  const facts = guardFailureFacts(outcome.error);
  return {
    write_mode: outcome.mode,
    // 三值，不是两值：`UNKNOWN` 是这一格上唯一的诚实答案
    // （护栏不可用而 `touched` 缺席时，`TOUCHED` 会把一个未知印成已知，
    // 而读这个字段的是程序 —— 它不会再去看那句话里的「可能」）。
    guard_verdict: guardVerdict(facts),
    guard_touched: facts.touched,
    guard_observed: facts.observed,
    winfs_code: facts.winfs_code,
    win32_error: facts.win32_error,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
