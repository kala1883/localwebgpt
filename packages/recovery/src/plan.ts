/**
 * 恢复计划：**逐条目判定的和**，以及它唯一的摘要（LWB-030 步骤 3 与 4）。
 *
 * 本文件是纯的。它回答三个问题，而这三个问题的答案决定了恢复流程
 * 能不能自动完成：
 *
 *  1. 这一次执行的逐条目判定**加起来**是什么？（`reconciliationOf`）
 *  2. 这个加法结果里，**哪一些**是可证明安全的？（`reconciliationOf`）
 *  3. 如果操作者想手动收场，他**能**请求哪个动作，凭什么？（`repairOf`）
 *
 * ## 折叠方向：枚举**好**情形，其余一律落到人工
 *
 * 与 `@lwb/executor` 的 `aggregateOf` 同一条规矩，而且理由更强：
 * 那一处漏掉一格只是把一次执行报得含糊，这一处漏掉一格会**自动定案**
 * 一个说不清的现场。因此这里不枚举坏情形，只枚举两个可以证明安全的：
 *
 * | 全部条目的判定 | 结论 | 凭什么安全 |
 * | --- | --- | --- |
 * | 每一条都是 `TARGET_REACHED` | `APPLIED`（`recovered = true`） | 每一个文件都已在批准的目标上，定案**不需要写任何字节** |
 * | 每一条都是 `ORIGINAL` | `ROLLED_BACK` | 每一个文件都在基线上，定案同样不需要写任何字节 |
 * | 其余**全部**（含混合、含任何一条判不出） | `MANUAL` | 见下 |
 *
 * ## 「自动完成」的判据是「这次定案一字节都不写」
 *
 * 这是本模块最要紧的一条边界，也是步骤 3「只有可证明安全的协调才自动完成」
 * 在本实现里的具体含义。写不写字节不是程度问题，是**种类**问题：
 *
 *  - 不写的定案（`APPLIED` / `ROLLED_BACK`）只改状态库里的两行。
 *    它的失败模式是「状态写错了」，而那是一条可以被下一次读纠正的记录。
 *  - 要写的定案（把基线写回去）会改**用户的文件**。它的失败模式是
 *    「一个人的内容没了」，而那是不可逆的。
 *
 * 因此凡是需要写字节的收场，一律走操作者显式授权那条路
 * （`service.ts` 的 `repair`），**不在这里**，也就不可能在一个
 * 「启动时顺手跑一下」的路径上发生。
 *
 * ## 为什么混合态没有「接受现状」这个自动选项
 *
 * 因为把 `ORIGINAL` 的那些条目补写成目标，就是**重放一次旧批准** ——
 * §8.4 原文「不重放旧批准」。而 §9.3 的那句「本地批准有效期 10 分钟」
 * 说的也是同一件事：批准是一次性的、过期的、绑定当时的摘要的。
 * 一个重启之后的进程没有资格替那个决定续期。于是混合态只剩两个出路：
 * 人工收场，或者由操作者授权把已经写下去的那些收回来。
 */

import { createHash } from 'node:crypto';

import type { ChangeItemRecord } from '@lwb/persistence';

import type { ItemVerdict } from './verdict.ts';

/** 一条的判定，连同它判的是哪一条。 */
export interface ItemPlan {
  readonly item: ChangeItemRecord;
  readonly verdict: ItemVerdict;
}

/** 一个操作的完整恢复计划。 */
export interface RecoveryPlan {
  readonly operation_id: string;
  readonly change_id: string;
  readonly workspace_id: string;
  readonly volume_id: string;
  readonly root_file_id: string;
  /** 按 `seq` 升序。摘要按这个顺序算，因此顺序本身也是被绑定的。 */
  readonly items: readonly ItemPlan[];
}

/** 定不了案的原因。**每一个都要能对操作者说出口。** */
export type ManualReason =
  /** 至少一条是第三种内容。§8.4：保留当前文件，进入人工恢复，不自动覆盖。 */
  | 'THIRD_CONTENT'
  /** 至少一条判不出身份。§8.4：保留现场，要求本地核验。 */
  | 'IDENTITY_UNKNOWN'
  /** 一部分已达、一部分未变 —— 没有任何不写字节的收场方式。 */
  | 'MIXED'
  /** 这个操作没有条目。一张空计划不构成任何证据。 */
  | 'NO_ITEMS';

export type Reconciliation =
  | { readonly kind: 'APPLIED'; readonly reason: 'ALL_TARGET' }
  | { readonly kind: 'ROLLED_BACK'; readonly reason: 'ALL_ORIGINAL' }
  | { readonly kind: 'MANUAL'; readonly reason: ManualReason };

/**
 * 逐条目判定折叠成一次定案。
 *
 * 顺序是**有意的**：先看「有没有判不出的」，再看「是不是清一色」。
 * 反过来写会让一个「三条已达 + 一条身份不明」被报成 `MIXED` ——
 * 那是一个**比真实原因更含糊**的答案，而操作者要读的恰恰是
 * 「哪一条判不出、为什么」（§8.4 的最后两行要的就是这个）。
 */
export function reconciliationOf(items: readonly ItemPlan[]): Reconciliation {
  if (items.length === 0) return { kind: 'MANUAL', reason: 'NO_ITEMS' };

  if (items.some((plan) => plan.verdict.kind === 'IDENTITY_UNKNOWN')) {
    return { kind: 'MANUAL', reason: 'IDENTITY_UNKNOWN' };
  }
  if (items.some((plan) => plan.verdict.kind === 'THIRD_CONTENT')) {
    return { kind: 'MANUAL', reason: 'THIRD_CONTENT' };
  }

  const allTarget = items.every((plan) => plan.verdict.kind === 'TARGET_REACHED');
  if (allTarget) return { kind: 'APPLIED', reason: 'ALL_TARGET' };

  const allOriginal = items.every((plan) => plan.verdict.kind === 'ORIGINAL');
  if (allOriginal) return { kind: 'ROLLED_BACK', reason: 'ALL_ORIGINAL' };

  return { kind: 'MANUAL', reason: 'MIXED' };
}

/**
 * 计划摘要。
 *
 * **覆盖观测到的身份与内容**，而不只是覆盖计划本身 —— 这正是它与
 * `approvals.digest` 的分工差别，也是「授权之后、执行之前磁盘被改过」
 * 这条防线本身：观测变了，摘要就变，授权就不再生效
 * （`RecoveryAuthorizationsRepo.consume` 把摘要放进 WHERE）。
 *
 * 摘要里**不含任何绝对路径**。`canonical_path` 是工作区内的相对路径，
 * 而 `volume_id` / `root_file_id` 是物理身份 —— 一个会把工作区根写进去的
 * 摘要是「摘要里出现本机路径」的最短路径，而那份摘要会被写进状态库。
 *
 * 序列化用**行分隔的定长字段**而不是 JSON：JSON 的键序、转义与
 * 数字格式都是一层可以被换掉的实现细节，而这个摘要必须逐字节稳定
 * —— 它将被存下来，并在几分钟之后被重新算一次做比对。
 * 字段之间用 `\u0000` 分隔，因为路径里不可能有它。
 */
export function planDigestOf(plan: RecoveryPlan): string {
  const lines: string[] = [
    'lwb-recovery-plan-v1',
    plan.operation_id,
    plan.change_id,
    plan.workspace_id,
    plan.volume_id,
    plan.root_file_id,
    String(plan.items.length),
  ];

  for (const { item, verdict } of plan.items) {
    lines.push(
      [
        item.id,
        String(item.seq),
        item.op,
        item.canonical_path,
        item.base_file_id ?? '',
        item.base_sha256 ?? '',
        item.target_sha256,
        verdict.kind,
        observedFileIdOf(verdict) ?? '',
        observedSha256Of(verdict) ?? '',
        // 磁盘规范拼写也进摘要。它变了意味着「同一个对象、同一份内容，
        // 但那个位置上的名字换了拼写」—— 一次写回会按新拼写发出请求，
        // 因此它是**这一次会怎么动磁盘**的一部分，不是显示细节。
        observedPathOf(verdict) ?? '',
        verdict.kind === 'IDENTITY_UNKNOWN' ? verdict.reason : '',
      ].join('\u0000'),
    );
  }

  return createHash('sha256').update(lines.join('\u0001'), 'utf8').digest('hex');
}

function observedFileIdOf(verdict: ItemVerdict): string | null {
  return verdict.kind === 'IDENTITY_UNKNOWN' ? null : verdict.observed_file_id;
}

function observedSha256Of(verdict: ItemVerdict): string | null {
  return verdict.kind === 'IDENTITY_UNKNOWN' ? null : verdict.observed_sha256;
}

function observedPathOf(verdict: ItemVerdict): string | null {
  return verdict.kind === 'IDENTITY_UNKNOWN' ? null : verdict.observed_path;
}

/**
 * 操作者**能**请求的写入动作，只有一个。理由见迁移 v7 与文件头。
 *
 * 注意它的名字里没有「apply」：这个模块里不存在「把目标写上去」这条路，
 * 而那是一个**结构上**的保证 —— 不是「我们记得不要去调它」，
 * 是那条路根本没有被写出来。
 */
export type RecoveryAction = 'ROLLBACK_TO_BASELINE';

/** 为什么不能收场。与 `RecoveryAction` 配套，用来拒绝一次授权请求。 */
export type RepairRefusal =
  /** 还有条目判不出或落在第三种内容上。先处理它们，再谈收场。 */
  | 'HAS_UNRESOLVED_ITEMS'
  /** 全部条目都还在基线上 —— 没有任何东西需要收回来。 */
  | 'NOTHING_TO_ROLL_BACK'
  /** 目标包含新建文件；恢复收场不自动删除该对象。 */
  | 'CREATED_OBJECT_NOT_REMOVED';

export type RepairPlan =
  | {
      readonly kind: 'ok';
      readonly action: RecoveryAction;
      /** 要写回基线的条目，**倒序**（与 `apply.ts` 的回滚同序）。 */
      readonly targets: readonly ItemPlan[];
    }
  | { readonly kind: 'refused'; readonly reason: RepairRefusal; readonly detail: string };

/**
 * 能不能把这次执行收回去。
 *
 * ## 判据
 *
 *  - 每一条都必须已经是 `TARGET_REACHED` 或 `ORIGINAL`；有任何一条
 *    `IDENTITY_UNKNOWN` / `THIRD_CONTENT` 就拒绝。理由不是保守，是**边界**：
 *    那些条目的现场不属于我们，一次「顺手把它们也办了」的收场会越过
 *    §8.4 划的那条线。
 *  - 至少要有**一条** `TARGET_REACHED` 的条目。全都还在基线上时无事可做，
 *    而「执行一次什么都不做的恢复授权」应当在授权之前就被拒掉。
 *  - `TARGET_REACHED` 的**新建**条目一律拒绝：这条计划不能推断新文件的归属。
 *  - `TARGET_REACHED` 的删除条目可以从已校验快照用 CREATE_NEW 恢复；
 *    这不会覆盖现有文件，且只在本地恢复授权后执行。
 *
 * ## 为什么 `targets` 是倒序的
 *
 * 与 `apply.ts` 的回滚同序：正向写入是 `seq` 升序，那么收回来的顺序反过来，
 * 留下的中间态与正向执行时的形状是对称的。这不是一条安全性质，
 * 而是一致性 —— 两处回滚的次序不同会让「读到日志的人」需要记住两套规矩。
 */
export function repairOf(items: readonly ItemPlan[]): RepairPlan {
  const unresolved = items.filter(
    (plan) => plan.verdict.kind === 'IDENTITY_UNKNOWN' || plan.verdict.kind === 'THIRD_CONTENT',
  );
  if (unresolved.length > 0) {
    const reasons = [...new Set(unresolved.map((plan) => plan.verdict.kind))].join('、');
    return {
      kind: 'refused',
      reason: 'HAS_UNRESOLVED_ITEMS',
      detail:
        `有 ${unresolved.length} 个条目的现场不属于本次执行（${reasons}），` +
        '不能连同它们一起收场；请先人工处理这些条目。',
    };
  }

  const written = items.filter((plan) => plan.verdict.kind === 'TARGET_REACHED');
  if (written.length === 0) {
    return {
      kind: 'refused',
      reason: 'NOTHING_TO_ROLL_BACK',
      detail: '全部条目都还在基线上，没有任何东西需要收回；这一次不需要授权。',
    };
  }

  const created = written.filter((plan) => plan.item.op === 'create_text');
  if (created.length > 0) {
    const paths = created.map((plan) => `「${plan.item.canonical_path}」`).join('、');
    return {
      kind: 'refused',
      reason: 'CREATED_OBJECT_NOT_REMOVED',
      detail:
        `${paths} 是本次执行**新建**出来的文件；本恢复流程不会自动删除创建出的对象，` +
        '以免把启动/崩溃后的猜测变成一次不可逆写入。请在本地核对并处理后，再重新做一次判定。',
    };
  }

  return { kind: 'ok', action: 'ROLLBACK_TO_BASELINE', targets: [...written].reverse() };
}
