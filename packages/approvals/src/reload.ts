/**
 * 从**落库事实**重载一个修改集，并重算它的规范化摘要（LWB-021 步骤 1）。
 *
 * ## 为什么批准之前必须重载，而不是相信请求里的东西
 *
 * 控制台提交的是 `change_id` 与一串十六进制摘要。这两样都是**调用方说的**，
 * 而调用方说的东西在 ADR-003 的词汇里一律不受信 —— 哪怕它来自本地控制台。
 * 一个摘要值本身不自证任何事：它只能被**比对**。要比对，就必须有一个
 * 独立的、由本机状态库给出的真值。
 *
 * 于是本模块做三件事，缺一不可：
 *
 *  1. **按 id 重新加载**修改集与它的全部条目。不缓存、不信任会话里的副本：
 *     批准与准备之间隔着一次人工审核，而人工审核的时长是不定的。
 *  2. **从加载到的行重算摘要**（`canonicalChangeDigest`，与建立修改集时
 *     **同一个函数**）。这一步回答「这串十六进制是不是这堆事实的指纹」。
 *  3. **把重算值与 `changesets.digest` 比对**。这一步回答「这堆事实是不是
 *     当初存进去的那一堆」—— 即「这行记录有没有被动过」。
 *
 * 三次比对（重算值 vs 落库值 vs 提交值）里任何一处不等，都必须拒绝。
 * 「重算值 = 落库值 = 提交值」才是「人看到的就是要执行的那一份」。
 *
 * ## 重算为什么可行，以及它依赖什么
 *
 * 摘要覆盖的字段全部可从 `changesets` + `change_items` + `blobs.size` 读到
 * （见 `@lwb/changes` 的 `digest.ts` 文件头：它刻意**不**覆盖 `summary`、
 * `read_token`、`added_lines` 与 `idempotency_key`，正是为了让重算成立）。
 *
 * 两处外部依赖值得写下来，因为它们是**依赖**而不是本模块自证的性质：
 *
 *  - `changesets` 与 `change_items` 不可变由触发器保证
 *    （`changesets_content_immutable` / `change_items_immutable`）。
 *    它们若被移除，重算就会变成「读一次当前值」，而「批准绑定」这句话
 *    在那一刻失效 —— 本模块察觉不到这件事。
 *  - `blobs.size` 必须还在。被修改集引用的 blob 目前不可能被回收
 *    （`change_items.new_blob_id` 是 `ON DELETE RESTRICT`，且引用非零时
 *    `BlobsRepo.markDeleted` 会拒绝）。这一条是**另一个子系统的实现细节**，
 *    因此这里不假设它成立：读不到 blob 就是一次明确的拒绝，见下。
 */

import { BridgeError } from '@lwb/contracts';
import type { ChangeFilePreview, ChangeSetState } from '@lwb/contracts';
import { canonicalChangeDigest, filePreviewsOf } from '@lwb/changes';
import type { ChangeItemRecord, ChangeSetRecord, Repositories } from '@lwb/persistence';

/** 重载结果：修改集、它的条目、它的预览，以及由这些事实重算出的摘要。 */
export interface ReloadedChangeSet {
  readonly change: ChangeSetRecord;
  readonly items: readonly ChangeItemRecord[];
  /** 与 `changesets.digest` **比对过**的那一份重算结果。 */
  readonly digest: string;
  /**
   * 逐文件预览。由 `filePreviewsOf` 从落库行重建，因此控制台、`change_get`
   * 与执行前复核看到的是同一批字段 —— 摘要正是由这批字段算出的。
   */
  readonly files: readonly ChangeFilePreview[];
}

/** 重算失败的分类。它们都是「本机状态库与它自己的记录不一致」，不是调用方的错。 */
export type ReloadFailure =
  /** 修改集下一条条目都没有：半写入的记录，不可能由 `ChangesRepo.create` 产生。 */
  | 'CHANGE_ITEM_MISSING'
  /** 条目引用的 blob 读不到，摘要因此无法重算。 */
  | 'BLOB_UNREADABLE'
  /** 重算值与落库值不符：这一行被改过，或摘要的规范化方式变过。 */
  | 'DIGEST_NOT_REPRODUCIBLE';

function reloadFailure(reason: ReloadFailure, message: string): BridgeError {
  return new BridgeError('CHANGE_STATE_INVALID', message, { reason });
}

/**
 * 按 id 重载一个修改集，重算并核对摘要。
 *
 * 失败一律抛 `BridgeError`，且**不含**任何路径或内容：本模块只报事实
 * （哪一步不一致），不报它读到的东西。
 *
 * 为什么 `state` 不在这里检查：本函数回答的是「这堆事实是什么」，
 * 而「现在允许对它做什么」是 `gate.ts` 与 `decide.ts` 的问题。
 * 把状态判断混进来会让「取一份只读预览」也不得不先满足执行前提。
 */
export function reloadChangeSet(repos: Repositories, changeId: string): ReloadedChangeSet {
  const change = repos.changes.requireById(changeId);
  const items = repos.changes.items(changeId);

  if (items.length === 0) {
    // `ChangesRepo.create` 在同一个事务里写修改集与条目，且拒绝空条目集，
    // 因此走到这里意味着**有别的写入路径**或磁盘损坏。两种都不该被当成
    // 「一个没有文件的修改集」继续走下去。
    throw reloadFailure('CHANGE_ITEM_MISSING', '修改集没有任何条目，无法重算摘要；记录不完整。');
  }

  let files: readonly ChangeFilePreview[];
  try {
    files = filePreviewsOf(items, (blobId) => repos.blobs.requireById(blobId).size);
  } catch {
    throw reloadFailure('BLOB_UNREADABLE', '修改集引用的快照对象读不到，无法重算摘要。');
  }

  // 用**这一行记录的**契约版本与策略版本，而不是当前的 `CONTRACT_VERSION`：
  // 要核对的是「当时的规范能不能重现当时的摘要」，而拿今天的常量去算
  // 恰好会在契约升级后把一批合法记录判成不一致。
  const recomputed = canonicalChangeDigest({
    contract_version: change.contract_version,
    policy_version: change.policy_version,
    root_generation: change.root_generation,
    workspace_id: change.workspace_id,
    files,
  });

  if (recomputed !== change.digest) {
    throw reloadFailure(
      'DIGEST_NOT_REPRODUCIBLE',
      '修改集的落库摘要与由落库事实重算出的摘要不一致；该记录不完整或被改动过，已拒绝继续。',
    );
  }

  return { change, items, digest: recomputed, files };
}

/**
 * 修改集是否**还处在待人决定的状态**。
 *
 * 与 `TERMINAL_CHANGE_STATES` 不同：这里问的是「能不能对它作出批准或拒绝」，
 * 而答案是唯一一个状态 —— `PENDING_APPROVAL`。用「不在终态里」来表达它
 * 会把 `APPROVED`（已批准、等待执行）也算成可再决定的，而那意味着
 * 一次已经给出的批准可以被第二次决定覆盖。
 */
export function isAwaitingDecision(state: ChangeSetState): boolean {
  return state === 'PENDING_APPROVAL';
}
