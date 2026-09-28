/**
 * 逐条目执行日志（LWB-029）。
 *
 * ## 它回答的问题
 *
 * 「这一次执行到底对**每一个文件**做了什么？」—— 一次多文件写入的中间状态
 * 在磁盘上是看得见的（有的文件已经改了、有的还没动），而在**账上**它必须是
 * 看得见的，否则恢复流程与操作者只能靠猜。本模块是那个账。
 *
 * 与 `coordinator.ts` 的 `JOURNAL_STAGE` 分工明确、互不替代：
 *
 * | | 粒度 | 回答 | 谁写 |
 * | --- | --- | --- | --- |
 * | `JOURNAL_STAGE`（改动级） | 一个修改集一条 | 这次执行**以什么告终** | 协调器收尾时 |
 * | 本模块（条目级） | 一个文件若干条 | 每个文件**走到了哪一步** | 写盘的人，在每一步的边界上 |
 *
 * 两者共用同一张表（`journal_entries`）。表里 `item_id` 为 `NULL` 的行是
 * 改动级，非 `NULL` 的是条目级 —— 这不是约定，是**结构**：条目级的行
 * 带着外键指向 `change_items`，而外键那一列本来就是可空的。
 *
 * ## 为什么不需要迁移
 *
 * `journal_entries` 建表时（LWB-006）就带了 `item_id` / `observed_file_id` /
 * `observed_sha256` / `target_sha256` / `error_code` 五列，且带
 * `UNIQUE(operation_id, seq)` 与一条 `BEFORE DELETE` 的触发器 ——
 * 也就是说这张表一开始就是按「追加、有序、不可删」设计的。
 * 本任务因此**一个 schema 变更都没有**，这是设计当初押对了，
 * 不是这次省了事。
 *
 * ## 一条贯穿本模块的规则：日志里不出现绝对路径
 *
 * 日志会进状态库、会被操作者读、会被恢复流程读、可能被复制进证据。
 * 因此每一条 `detail` 在**写入之前**就过一遍 `redactRoot`：护栏的消息里
 * 常带工作区根的绝对路径（它是在那个坐标系里写话的），而这份日志不该
 * 成为本机目录结构的抄本。规则放在这里而不是调用点：调用点有十几个，
 * 而「什么可以进日志」只能有一个答案。
 *
 * 同样不放进去的还有**文件正文**。这一条靠的不是过滤，而是本模块的
 * 结构 —— 它只接受哈希、身份、字节数与原因，没有任何一个字段可以塞下一段
 * 正文（`detail` 由调用点写，而调用点的每一句都在测试里被断言过
 * 「不含正文」）。
 */

import type { ReadScope } from '@lwb/files';
import type { Repositories } from '@lwb/persistence';

/**
 * 条目级日志的**全部**阶段。
 *
 * 用 `as const` + 联合类型，而不是裸字符串：写日志的地方有十几处，
 * 一个拼错的阶段名在运行期看起来和「那一格没走到」一模一样 ——
 * 而恢复流程正是靠「哪一格走过」来判断磁盘状态的。
 */
export const ITEM_STAGE = {
  /** 我**这就开始**动这个文件了。写在护栏调用**之前**。 */
  intent: 'item_intent',
  /** 阶段 A 发现磁盘上已经是目标内容 —— 没有改动，也不是冲突。 */
  skipped: 'item_skipped',
  /** 失败，但可**证明**本次执行没有在这个文件上留下任何字节。 */
  untouched: 'item_untouched',
  /** 护栏报告字节已写出（回执里 `bytes_written`）。 */
  written: 'item_written',
  /** 删除回执已通过身份、内容哈希与缺失回读核验。 */
  deleted: 'item_deleted',
  /** 同一次回执报告已刷盘（`flushed=true`）。 */
  flushed: 'item_flushed',
  /** 同一次回执报告回读与目标逐字节相同（`readback_ok` 且哈希相等）。 */
  verified: 'item_verified',
  /** 护栏调用失败。磁盘上可能留有本次执行的字节。 */
  failed: 'item_failed',
  /** 有界恢复成功，且**独立回读**证实文件回到了基线。 */
  restored: 'item_restored',
  /** 有界恢复**没有尝试**（原因在 `error_code`）。留下的事实与失败相同。 */
  restore_skipped: 'item_restore_skipped',
  /** 有界恢复尝试了但失败（护栏拒绝、或恢复后的回读与基线不符）。 */
  restore_failed: 'item_restore_failed',
} as const;

export type ItemStage = (typeof ITEM_STAGE)[keyof typeof ITEM_STAGE];

/** 阶段名 → 是否属于本模块。用于把改动级的行筛出去。 */
const ITEM_STAGES: ReadonlySet<string> = new Set(Object.values(ITEM_STAGE));

export interface ItemEventInput {
  readonly operation_id: string;
  readonly item_id: string;
  readonly stage: ItemStage;
  /**
   * 这条日志所描述的那次执行的作用域。**用来脱敏 `detail`。**
   *
   * 它是输入的一部分，而不是 `appendItemEvent` 的第二个参数：调用点有
   * 十几处，而「日志里不出现绝对路径」这条规则不该依赖每一处都记得多传
   * 一个参数 —— 忘传的那一处编译不过，这正是把 scope 放进结构里的理由。
   */
  readonly scope: ReadScope;
  /** 该阶段观察到的对象身份（`GetFileInformationByHandle` 的文件 ID）。 */
  readonly observed_file_id?: string | null;
  /** 该阶段观察到的内容哈希。 */
  readonly observed_sha256?: string | null;
  /** 本条目被批准的目标哈希。 */
  readonly target_sha256?: string | null;
  /**
   * 机器可读的原因 / 错误码。
   *
   * **不限于错误**：`restore_skipped` 这类「没做某事」的阶段也要说明原因
   * （`CREATED_OBJECT_NOT_REMOVED` 等），而它是读到这条日志的人首先要知道
   * 的那件事。空的含义是「这一格没有原因可报」。
   */
  readonly error_code?: string | null;
  /** 人读的一句话。**写库之前会被 `redactRoot` 处理。** */
  readonly detail?: string | null;
}

export interface ItemEvent {
  readonly seq: number;
  readonly item_id: string;
  readonly stage: ItemStage;
  readonly observed_file_id: string | null;
  readonly observed_sha256: string | null;
  readonly target_sha256: string | null;
  readonly error_code: string | null;
  readonly detail: string | null;
}

/**
 * 把工作区根的绝对路径替换成一个占位符。
 *
 * 只替换根、不动别的：一个「把所有像路径的东西都擦掉」的过滤器会顺手擦掉
 * 真正的病因，而这份文字的唯一用途就是告诉人病因。
 */
export function redactRoot(text: string, scope: ReadScope): string {
  return scope.root_path.length === 0 ? text : text.split(scope.root_path).join('<工作区根>');
}

/**
 * 追加一条条目级日志。返回值是它在本次操作里的序号。
 *
 * **不自己开事务。** 调用点几乎总是有一件必须与它同时生效的事
 * （「记下意图」与「开始写」之间、「写了」与「刷了」之间），
 * 而本模块自己开事务会让那件事有一个「日志写了、事没做」的窗口。
 * 序号由仓储层按 `MAX(seq)+1` 取，并有 `UNIQUE(operation_id, seq)` 兜底。
 */
export function appendItemEvent(repos: Repositories, input: ItemEventInput): number {
  return repos.journal.append({
    operation_id: input.operation_id,
    item_id: input.item_id,
    stage: input.stage,
    observed_file_id: input.observed_file_id ?? null,
    observed_sha256: input.observed_sha256 ?? null,
    target_sha256: input.target_sha256 ?? null,
    error_code: input.error_code ?? null,
    // 脱敏在这里、不在调用点：调用点写的是「病因」，而病因里常带工作区根的
    // 绝对路径（护栏的消息就是在那个坐标系里写的）。擦掉根、只擦根 ——
    // 见 `redactRoot` 上方关于「为什么不做通用过滤」的说明。
    detail: input.detail == null ? null : redactRoot(input.detail, input.scope),
  });
}

/**
 * 读回一次执行的**条目级**日志，按序号升序。
 *
 * 改动级的行（`item_id` 为 `NULL`）被筛掉：调用方问的是「每个文件怎么了」，
 * 而混进一条改动级的行会让逐条目折叠多出一个没有归属的事件。
 *
 * 认不出的阶段名**保留**（而不是丢弃或抛）：它可能来自一个更新的版本。
 * 折叠时它会被当成「不是本版本认识的终局」，从而把那个条目算成
 * `unknown` ⇒ 一律按「磁盘上可能有我们的字节」处理。方向是 fail-closed。
 */
export function readItemEvents(repos: Repositories, operationId: string): ItemEvent[] {
  const events: ItemEvent[] = [];
  for (const row of repos.journal.list(operationId)) {
    if (row.item_id === null) continue;
    events.push({
      seq: row.seq,
      item_id: row.item_id,
      stage: row.stage as ItemStage,
      observed_file_id: row.observed_file_id,
      observed_sha256: row.observed_sha256,
      target_sha256: row.target_sha256,
      error_code: row.error_code,
      detail: row.detail,
    });
  }
  return events;
}

/**
 * 一个条目在日志里的**终局**。
 *
 * | 取值 | 含义 | 磁盘上是不是有本次执行写的字节 |
 * | --- | --- | --- |
 * | `written` | 写完并核验过 | 是（那正是批准的内容） |
 * | `restored` | 写过，已回到基线并核验 | 否 |
 * | `skipped` | 本来就是目标内容，没动 | 否 |
 * | `untouched` | 失败，但可证明没留下字节 | 否 |
 * | `left_changed` | 失败/恢复失败/放弃恢复 | **可能或确实有** |
 * | `unknown` | 日志不足以判断（例如只记下意图就没有下文） | 按「有」处理 |
 */
export type ItemOutcomeKind = 'written' | 'deleted' | 'restored' | 'skipped' | 'untouched' | 'left_changed' | 'unknown';

export interface ItemOutcome {
  readonly item_id: string;
  readonly kind: ItemOutcomeKind;
  /** 该条目最后一条日志的那句话（已脱敏）。 */
  readonly last_detail: string | null;
  readonly last_error_code: string | null;
  /** 该条目的日志条数。0 表示这次执行根本没碰它。 */
  readonly events: number;
}

/**
 * 逐条目折叠。
 *
 * **取每个条目的最后一条事件**，而不是「出现过某个阶段就算某件事」：
 * 一个条目可以先 `item_written` 再 `item_restore_failed`，而这两条
 * 拼起来的事实是「磁盘上可能留着我们写的字节」。按「出现过」折叠会把
 * 它报成 `written` —— 那正是「把部分完成当全成功」。
 *
 * 最后一条是 `item_written` 而没有后续的 `flushed` / `verified` 时算
 * `left_changed`：今天的三条是同一个事务里写的，因此这种组合不该出现；
 * 一旦出现，就说明账目被改过或来自别的版本，此时**不能**声称刷过盘。
 */
export function itemOutcomes(events: readonly ItemEvent[]): Map<string, ItemOutcome> {
  const byItem = new Map<string, ItemEvent[]>();
  for (const event of events) {
    const list = byItem.get(event.item_id);
    if (list === undefined) byItem.set(event.item_id, [event]);
    else list.push(event);
  }

  const outcomes = new Map<string, ItemOutcome>();
  for (const [item_id, list] of byItem) {
    const ordered = [...list].sort((a, b) => a.seq - b.seq);
    // 列表非空由上面的构造保证；`at` 的返回类型仍是可空的，因此显式收口。
    const last = ordered[ordered.length - 1];
    if (last === undefined) continue;
    outcomes.set(item_id, {
      item_id,
      kind: kindOfLastEvent(last.stage),
      last_detail: last.detail,
      last_error_code: last.error_code,
      events: ordered.length,
    });
  }
  return outcomes;
}

function kindOfLastEvent(stage: ItemStage): ItemOutcomeKind {
  switch (stage) {
    case ITEM_STAGE.verified:
      return 'written';
    case ITEM_STAGE.deleted:
      return 'deleted';
    case ITEM_STAGE.restored:
      return 'restored';
    case ITEM_STAGE.skipped:
      return 'skipped';
    case ITEM_STAGE.untouched:
      return 'untouched';
    case ITEM_STAGE.failed:
    case ITEM_STAGE.restore_failed:
    case ITEM_STAGE.restore_skipped:
      return 'left_changed';
    // `written` / `flushed` 单独出现（没有 verified 跟着）见函数注释。
    case ITEM_STAGE.written:
    case ITEM_STAGE.flushed:
      return 'left_changed';
    case ITEM_STAGE.intent:
      return 'unknown';
    default:
      // 认不出的阶段名（跨版本）：不假设任何事。
      return 'unknown';
  }
}

/**
 * 一次执行的**总账**。
 *
 * | 取值 | 判据 | 交给协调器的报告 |
 * | --- | --- | --- |
 * | `applied` | 每个条目都是 `written` / `deleted` / `skipped`，且至少一个有实际操作 | `applied` |
 * | `rolled_back` | 每个条目都 `restored` / `skipped` / `untouched`，且至少一个不是 `skipped` | `rolled_back` |
 * | `no_change` | 每个条目都是 `skipped` | `no_change` |
 * | `unfinished` | 其余**全部**情形 | 抛（⇒ `RECOVERY_REQUIRED`） |
 *
 * 「其余全部」是刻意的：这个函数不枚举坏情形，它枚举**好**情形，
 * 而任何一条不满足就落到 `unfinished`。多出来的取值、缺日志的条目、
 * 一个都没写却也一个都没回滚干净 —— 全部汇聚到同一格，
 * 因为它们在磁盘上的含义是同一件事：**这块地现在的样子，账上说清楚了一半**。
 *
 * ## 为什么 `untouched` 能进 `rolled_back` 却进不了 `applied`
 *
 * 这个不对称是**整个折叠函数的关键**，写反了会把一次部分完成报成全成功：
 *
 *  - `untouched` 的含义是「这次执行在这个文件上没留下字节」，**不是**
 *    「这个文件已经是要写的内容」。一次多文件执行里，前一个文件写成功、
 *    后一个文件失败且一个字节没写，若把它们算成 `applied`，那份报告说的
 *    就是「全部目标已达到」—— 而其中一个文件根本没被创建。
 *  - 反过来，回滚要回答的问题是「盘上还有没有本次执行留下的字节」。
 *    `untouched` 恰好是这个问题的一个**肯定回答**（没有），
 *    因此它和 `restored` / `skipped` 一样构成「退回到执行前的样子」。
 *
 * 判据因此不是「出现过某个阶段」，而是**每个条目各自的终局恰好落在
 * 同一件事实的那一侧**。
 */
export type Aggregate = 'applied' | 'rolled_back' | 'no_change' | 'unfinished';

export function aggregateOf(outcomes: ReadonlyMap<string, ItemOutcome>, expectedItems: number): Aggregate {
  // 有条目连一条日志都没有 —— 它要么没被处理，要么处理它的时候进程死了。
  // 两种都不足以声称「它没被改」。
  if (outcomes.size !== expectedItems) return 'unfinished';

  const kinds = [...outcomes.values()].map((outcome) => outcome.kind);
  const every = (allowed: readonly ItemOutcomeKind[]): boolean =>
    kinds.every((kind) => allowed.includes(kind));
  const any = (kind: ItemOutcomeKind): boolean => kinds.includes(kind);

  // `left_changed` / `unknown` 在下面每一条里都不被允许 —— 它们正是
  // 「盘上可能有本次执行的字节」，与三种好结局互斥。列在每条里而不是
  // 提前 return，是为了让「哪一种终局允许哪几种条目终局」一眼可见。
  if (every(['skipped'])) return 'no_change';
  if (every(['written', 'deleted', 'skipped']) && (any('written') || any('deleted'))) return 'applied';
  // `any('restored') || any('untouched')` 这一项排掉「全部 skipped」——
  // 那一格是 `no_change`，上面已经接走了；而一次**什么都没写、也什么都
  // 没回滚**的执行不该报成 rolled_back。
  //
  // 「全部 untouched」（每个条目都失败、且每一个都能证明没留下字节）
  // 因此也落在这一条上：它同样满足「盘上没有本次执行的字节」。
  // LWB-028 里这一格只能抛（那条路没有 ROLLED_BACK 可报），现在它有了名字。
  if (every(['restored', 'skipped', 'untouched']) && (any('restored') || any('untouched'))) {
    return 'rolled_back';
  }
  return 'unfinished';
}

/**
 * 总账的最后一句人话（进报告的 `detail`）。
 *
 * 逐条目列出来，因为「一次多文件写入失败之后，哪几个文件是什么状态」
 * 正是操作者要的第一件事。条目多时列前若干条并给出总数：报告是给人看的，
 * 完整清单在日志里（`readItemEvents`）。
 */
export function describeOutcomes(
  outcomes: ReadonlyMap<string, ItemOutcome>,
  paths: ReadonlyMap<string, string>,
  limit = 5,
): string {
  const label: Readonly<Record<ItemOutcomeKind, string>> = {
    written: '已写入并核验',
    deleted: '已删除并核验',
    restored: '已回到基线',
    skipped: '无需改动',
    untouched: '未改动',
    left_changed: '**可能留有本次执行的字节**',
    unknown: '**状态不明（账上只有意图）**',
  };
  const counts = new Map<ItemOutcomeKind, number>();
  for (const outcome of outcomes.values()) {
    counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);
  }
  const tail = [...counts.entries()]
    .map(([kind, count]) => `${label[kind]} ${count}`)
    .join('；');

  const notable = [...outcomes.values()]
    .filter((outcome) => outcome.kind === 'left_changed' || outcome.kind === 'unknown')
    .slice(0, limit)
    .map((outcome) => `「${paths.get(outcome.item_id) ?? outcome.item_id}」：${outcome.last_detail ?? '（无说明）'}`);

  return notable.length === 0 ? tail : `${tail}。需要人看的条目：${notable.join(' ')}`;
}

/** 供测试与证据脚本核对：本模块声明的阶段全集。 */
export const ALL_ITEM_STAGES: readonly ItemStage[] = Object.values(ITEM_STAGE);

/** 供测试与证据脚本核对：某个阶段名是不是条目级。 */
export function isItemStage(stage: string): stage is ItemStage {
  return ITEM_STAGES.has(stage);
}
