/**
 * 写盘的人（LWB-027）：把批准过的精确操作交给原生护栏。
 *
 * ## 它是什么，以及它**不是**什么（LWB-029 之后）
 *
 * 本模块是**原语层**：每个导出都是一次护栏调用（或一次快照库读取），
 * 加上把它**这一次的回答**翻译成本工程的词汇。「接下来做什么」——
 * 谁先谁后、失败了回滚什么、最后报什么 —— 一件都不在这里，
 * 而在 `apply.ts`（`createNativeApplier`）。
 *
 * 这条分界线是 LWB-029 划下的，理由不是分层好看：
 *
 *  - 回滚是一次**新的**写入。它必须走完整的校验与回执核对，而一个
 *    「在失败路径里顺手改回来」的实现会绕过全部这些 —— 包括那条
 *    「只撤销**我们自己**写下去的那一份」的比对；
 *  - 原语层因此可以是**无状态**的：它对每个条目做一次调用并如实回答，
 *    而「哪些条目已经写过」是编排层的事。把两者混在一个循环里，
 *    就会得到一个既能改磁盘又能改记账的函数 —— 那正是最难审的那一种。
 *
 * 本模块**在数据库事务之外**被调用（详见 `coordinator.ts` 的说明）：
 * 事务不能跨越「等待批准」与「把全部文件写完」，而这里正是后者的全部。
 *
 * ## 整次执行的形状（由 `apply.ts` 编排，这里只说明它为什么这样分）
 *
 * ```text
 *   阶段 A   逐条目核对（只读，一个字节都不写）
 *      ↓    有任何一条拒绝/冲突 ⇒ 在写之前退出，报 refused / conflict
 *   阶段 A2  持久化边界：把要用到的两份字节（目标 + 基线）都读回来核对
 *      ↓    取不到 ⇒ 拒绝，**目标文件零写入**
 *   阶段 B   记账：把「我这就开始写了」落进状态库（一个短事务）
 *      ↓
 *   阶段 C   逐条目写入（每条目一个原生句柄，写前在同一句柄内重新核对）
 * ```
 *
 * 顺序不能换。**阶段 B 必须在阶段 C 之前**：`APPLYING` 这一格的含义是
 * 「字节可能已经在盘上了」，而它只有在写入真的开始之前被记下来才有意义 ——
 * 反过来先写后记，就会出现「文件已经改了、账上还说没开始」的窗口，
 * 那个窗口里任何人都无法判断磁盘上的内容是谁写的。
 *
 * **阶段 A2 必须在阶段 B 之前**（LWB-029 步骤 1 原文：「所有旧/新 blob
 * 持久化完成后才能写入工作区」）。它在阶段 A 之后而不是之内，因为它回答的
 * 是另一个问题：A 问「该不该写」，A2 问「万一写坏了，我手上有没有那两份
 * 字节」。分开的可见后果是「快照取不到」在时间上仍然**早于**第一个字节 ——
 * 而这正是验收标准第二条要的。
 *
 * 阶段 A 也不只是「提前发现错误」：`no_change`（磁盘上已经是目标内容）
 * **只能**在这一阶段判出来。写入侧判不出它 —— 同一条目若磁盘已是目标内容，
 * 写入的基线核对会判成 `FILE_VERSION_CONFLICT`（磁盘 ≠ 基线），
 * 于是一次「本来就无需改动」会被报成一次冲突。这两件事对操作者完全不同。
 *
 * 阶段 A 的核对**不权威**，这只是刻意的分层：它按路径打开目标，读完就关。
 * 权威的核对在写入句柄内部（对象身份、硬链接、基线哈希，见
 * `Op-WriteFileGuarded`），因为只有那里能保证「核对与写入之间没有窗口」。
 * 阶段 A 的价值是便宜、早失败，以及回答「要不要写」这个问题。
 *
 * ## 一次失败说了什么：`touched` 与 `actual_state` 是两件事
 *
 * 护栏的回答里有两个**互相独立**的字段（细节见 `WinfsError`）：
 *
 * | 情况 | 磁盘上 | `apply.ts` 据此做什么 |
 * | --- | --- | --- |
 * | `touched` 缺席 | 一个字节都没动 | 报 `conflict` / `refused`，或记账后按「没留下东西」收尾 |
 * | `touched` 为真、`actual_state` 有值 | 动过，现场已知 | 可按现场**有界回滚**（乐观并发比对） |
 * | `touched` 为真、`actual_state` 缺席 | 动过，现场**未知** | 只能进 `RECOVERY_REQUIRED`，**绝不**回滚 |
 *
 * 「一个字节都没动」这句话在 LWB-028 时挂在 `actual_state` 上，那是个洞：
 * 现场观测是尽力而为的（`Get-BoundedActualState` 自己失败时返回 `$null`），
 * 于是「动过但没观测到」与「没动过」在响应里长得一模一样，而它们要求的
 * 动作正好相反。LWB-029 让护栏把进入破坏性区域这件事**独立**记下来
 * （`LwbFsException.Touched`），本模块如实转交。
 *
 * 本轮里**不再有**「阶段 C 的失败一律抛」这条规则：一次写成功、之后某条
 * 失败时，正确的处置取决于**已经写过的那几条能不能收回来**，而那是
 * `apply.ts` 读完逐条目日志才能回答的问题。
 *
 * `NATIVE_GUARD_UNAVAILABLE` 是唯一一个仍然特殊的码：它有可能只是客户端
 * 合成的「没连上护栏」，也就是**响应根本没从护栏回来** —— 那么
 * 「`touched` 缺席」什么也证明不了。阶段 A 里它仍然是安全的拒绝
 * （那时还没有任何字节可能被写过）；阶段 C 里它一律按「动过、现场未知」
 * 处理，即必须进恢复。
 *
 * ## 与邻居的边界（刻意不做的事）
 *
 *  - **不做**逐条目日志，也**不做**失败之后的回滚：两者都在 `apply.ts`
 *    （LWB-029）。本模块只回答「一次护栏调用返回了什么」，并把那个回答
 *    **原样**交出去，自己不决定「接下来做什么」。分开的理由不是分层好看：
 *    回滚是一次**新的**写入，它必须走完整的校验与回执核对，而一个
 *    「在失败路径里顺手改回来」的实现会绕过全部这些 —— 包括那条
 *    「只撤销**我们自己**写下去的那一份」的比对。
 *  - **不做**回退：回退是一次**新的**修改集，走同一条「提议 → 批准 → 应用」，
 *    绝不通过覆盖用户文件实现回滚。这与上一条是两件事：上一条说的是
 *    「正在进行的这次写入失败了，把它**这次**动过的字节收回去」，
 *    这里说的是「一次已经交付的改动，事后要撤销」—— 后者只能靠一个新提案。
 *  - **不做**跨条目的次序决定：次序由 `claim.ts` 的 `orderedForLocking`
 *    定好并放进计划，本模块按计划给的次序逐条目调用。
 *
 * ## 它不重新做授权判断
 *
 * 「这次执行该不该发生」由 `claimForExecution` 的闸门判定（连接、工作区、
 * 策略、到期、批准一次性消费）。本文件不重复那些判断，也**不**从工具参数里
 * 取任何身份 —— 它手上只有 `ExecutionPlan`，而计划里的每一个字段都是
 * 认领时从状态库读出来的。
 */

import { inspectBytes, isReadShaped, readScopeOf, refOf, type ReadScope } from '@lwb/files';
import { classifyFile } from '@lwb/policy';
import type { BlobStore } from '@lwb/blob-store';
import type { ChangeItemRecord, Repositories, WorkspaceRecord } from '@lwb/persistence';
import {
  isWinfsError,
  type WinfsCreateResult,
  type WinfsError,
  type WinfsOps,
  type WinfsWriteResult,
} from '@lwb/winfs';

import { redactRoot } from './journal.ts';

export interface NativeApplierDeps {
  /** 状态库。阶段 B 的记账与快照读取都走它。 */
  readonly repos: Repositories;
  /** 原生护栏。生产上是 `@lwb/winfs` 的常驻后端。 */
  readonly ops: WinfsOps;
  /** 快照库：目标字节（新内容）从它取，取出来还要逐字节核对。 */
  readonly blobs: BlobStore;
}

/**
 * 当前构建能执行的写入形态。
 *
 * 白名单而不是黑名单：一个「不是这个就当成覆盖写」的缺省分支会让一次创建
 * 请求静默地覆盖掉同名文件。
 */
const WRITABLE_OPS: ReadonlySet<ChangeItemRecord['op']> = new Set<ChangeItemRecord['op']>([
  'edit_text',
  'replace_text',
  'create_text',
]);

/**
 * 阶段 C 走哪一条原生操作。
 *
 * 两条路的**方向相反**，因此不能合并成一个「写」：
 *
 * | | 要的是 | 靠什么保证 |
 * | --- | --- | --- |
 * | `edit_text` / `replace_text` | 那个**对象**还是被批准的那一个 | 同一句柄内比对 `file_id` 与基线哈希 |
 * | `create_text` | 那个**名字**还没被占 | `CREATE_NEW`，判定与创建是同一次系统调用 |
 *
 * 合并的后果是可以预料的：一个「先看存在不存在、再决定用哪个调用」的实现，
 * 会在两条路之间那把 `if` 上留下 TOCTOU 窗口，而窗口的另一侧正是验收标准
 * 第一条问的那件事。
 */
export type WriteMode = 'edit_text' | 'create_text';

/**
 * 本模块交给 `apply.ts` 的**全部**能力。
 *
 * 五个动作，每一个都是「一次护栏调用」（加上把它的回答翻译成本工程的
 * 词汇）。编排 —— 谁先谁后、失败了回滚什么、最后报什么 —— 一件都不在这里。
 *
 * `readState` 是**独立回读**：它另起一次护栏调用去问「这个文件现在是什么」，
 * 不复用任何一次写入的返回值。判断「字节回到了基线没有」只能用这种方式：
 * 写入回执描述的是写入那一刻，而回滚要回答的是*现在*。
 */
export interface NativeWriter {
  /** 阶段 A：读一遍磁盘与计划，给出「写 / 跳过 / 拒绝 / 冲突」。 */
  readonly vet: (scope: ReadScope, item: ChangeItemRecord) => Promise<VettedItem>;
  /** 阶段 C：一次写入（按条目形态选改写或创建）。**不抛**，把护栏的回答交出去。 */
  readonly write: (scope: ReadScope, vetted: VettedItem) => Promise<WriteOutcome>;
  /**
   * 回滚一次写入：把**基线字节**写回去。
   *
   * 前置条件是「现在盘上还是我们写下去的那一份」—— 由调用方给出
   * `expected_sha256` / `expected_file_id`，护栏在它自己的句柄里核。
   * 核不过就拒绝，**绝不覆盖**（那意味着在我们写完之后有人改过它，
   * 而那是一个人的改动，不该被一次自动回滚抹掉）。
   */
  readonly restore: (scope: ReadScope, request: RestoreRequest) => Promise<WriteOutcome>;
  /** 独立回读：当前内容与对象身份。用来证实「回到了基线」或「确实没动过」。 */
  readonly readState: (scope: ReadScope, item: ChangeItemRecord) => Promise<ReadStateOutcome>;
  /** 基线字节（旧快照，已校验）。取不到时返回原因，**绝不**用别的字节顶替。 */
  readonly baselineBytes: (item: ChangeItemRecord) => Promise<BufferOutcome>;
  /** 目标字节（新快照，已校验）。阶段 A 用它，持久化边界也用它。 */
  readonly targetBytes: (item: ChangeItemRecord) => Promise<BufferOutcome>;
  /**
   * 持久化边界（阶段 A2）：把这一条**要用到的两份字节**都读回来核对。
   *
   * 「要用到的两份」是这一条的全部内容：
   *  - 目标字节 —— 待会儿要写进工作区的那一份；
   *  - 基线字节 —— 万一要回滚，**写回去**的那一份（创建没有基线）。
   *
   * 返回基线字节本身，而不是让调用方在失败路径上再去取一次：一次回滚
   * 发生在最没有余力的时刻，那时再去读一个 2 MiB 的对象，等于给「回滚
   * 失败」多加一条与磁盘无关的成因。字节在**第一次写之前**就已经拿在手上了。
   */
  readonly requireSnapshots: (item: ChangeItemRecord) => Promise<SnapshotOutcome>;
}

export function createNativeWriter(deps: NativeApplierDeps): NativeWriter {
  return {
    vet: (scope, item) => vetItem(deps, scope, item),
    write: (scope, vetted) => writeItem(deps, scope, vetted),
    restore: (scope, request) => restoreItem(deps, scope, request),
    readState: (scope, item) => readState(deps, scope, item),
    baselineBytes: (item) => bytesOf(deps, item.old_blob_id, item.base_sha256, '基线'),
    targetBytes: (item) => bytesOf(deps, item.new_blob_id, item.target_sha256, '目标'),
    requireSnapshots: (item) => requireSnapshots(deps, item),
  };
}

/**
 * 阶段 A2 的单条目结果。
 *
 * `baseline` 为 `null` 与 `ok: false` 是两件**相反**的事：前者是「这一条
 * 本来就没有基线」（创建），后者是「该有却取不到」。合成一个可空字段
 * 会让一次创建与一次快照缺失在代码里长得一模一样。
 */
export type SnapshotOutcome =
  | { readonly ok: true; readonly baseline: Buffer | null; readonly target: Buffer }
  | { readonly ok: false; readonly detail: string };

async function requireSnapshots(deps: NativeApplierDeps, item: ChangeItemRecord): Promise<SnapshotOutcome> {
  const target = await bytesOf(deps, item.new_blob_id, item.target_sha256, '目标');
  if (!target.ok) return { ok: false, detail: target.detail };

  if (item.op === 'create_text') return { ok: true, baseline: null, target: target.bytes };

  if (item.old_blob_id === null || item.base_sha256 === null) {
    return {
      ok: false,
      detail:
        `${item.canonical_path} 是一次改写，却没有基线快照（old_blob_id / base_sha256 为空）；` +
        '没有基线字节就无法在失败时把内容收回去。拒绝执行。',
    };
  }
  const baseline = await bytesOf(deps, item.old_blob_id, item.base_sha256, '基线');
  if (!baseline.ok) return { ok: false, detail: baseline.detail };
  return { ok: true, baseline: baseline.bytes, target: target.bytes };
}

/**
 * 按内容引用取字节并核对。
 *
 * 两道核对缺一不可，且它们检查的不是同一件事：
 *  1. 快照库自己的 `getVerified` —— 「这份字节是它自称的那一份」（落盘之后
 *     被人改过、截断过，都在这里被挡下）；
 *  2. 与**条目声明的哈希**比对 —— 「它确实是这个条目要的那一份」。
 * 只做第一件的话，一个内容正确但被挂到了另一个条目上的快照会一路通过。
 */
async function bytesOf(
  deps: NativeApplierDeps,
  blobId: string | null,
  expectedSha256: string | null,
  label: string,
): Promise<BufferOutcome> {
  if (blobId === null || expectedSha256 === null) {
    return { ok: false, detail: `${label}快照的引用为空（blob_id / sha256 有一个是 null）。` };
  }
  try {
    const record = deps.repos.blobs.requireById(blobId);
    const bytes = await deps.blobs.getVerified({
      sha256: record.sha256,
      size: record.size,
      storage_ref: record.storage_ref,
    });
    if (record.sha256 !== expectedSha256) {
      return {
        ok: false,
        detail:
          `条目声明的${label}哈希 ${expectedSha256} 与它引用的快照 ${record.sha256} 不符；` +
          '写入与回滚都必须逐字节是那一份。拒绝。',
      };
    }
    return { ok: true, bytes, sha256: record.sha256 };
  } catch (error) {
    // 快照缺失或校验不过（LWB-007 验收 2）：取不到被批准的那一份字节，
    // 就绝不用别的字节代替。
    return { ok: false, detail: `取不到本条目的${label}快照：${messageOf(error)}。` };
  }
}

/** 字节 + 它是哪一份；取不到时给出**原因**而不是抛。 */
export type BufferOutcome =
  | { readonly ok: true; readonly bytes: Buffer; readonly sha256: string }
  | { readonly ok: false; readonly detail: string };

/** 一次写入的结果，按护栏**说了什么**分类，不按异常分类。 */
export type WriteOutcome =
  | {
      readonly ok: true;
      readonly mode: WriteMode;
      readonly result: WinfsWriteResult | WinfsCreateResult;
      /** 交出去的字节数（用来核回执里的 `bytes_written`）。 */
      readonly payload_bytes: number;
    }
  | { readonly ok: false; readonly mode: WriteMode; readonly error: WinfsError };

export interface RestoreRequest {
  readonly item: ChangeItemRecord;
  /** 按**磁盘规范拼写**写回（与写入路径同一条规矩）。 */
  readonly relative_path: string;
  /** 回滚前必须成立的对象身份（我们自己写下去的那一个）。 */
  readonly expected_file_id: string;
  /** 回滚前必须成立的内容哈希（我们自己写下去的那一份）。 */
  readonly expected_sha256: string;
  /** 要写回去的字节：该条目的**基线**内容。 */
  readonly bytes: Buffer;
}

export type ReadStateOutcome =
  | {
      readonly ok: true;
      readonly file_id: string;
      readonly sha256: string;
      readonly size: number;
      readonly canonical_path: string | null;
    }
  | { readonly ok: false; readonly error: WinfsError };

/**
 * 一次写入。
 *
 * **不抛。** 失败是「护栏说了什么」的一种，而调用方（`apply.ts`）要根据
 * 那份回答决定回滚什么；把它抛在这里等于逼调用方从异常里把细节再挖出来。
 * 唯一的例外在下面那个 `throw` 里，而它是一条**不可能**的路径。
 */
async function writeItem(deps: NativeApplierDeps, scope: ReadScope, vetted: VettedItem): Promise<WriteOutcome> {
  const { item, mode, payload, canonical_path } = vetted;
  if (payload === null || canonical_path === null) {
    // `vet` 只会把 `write` 的条目配好这两个字段；到了这里说明调用方
    // 把一个别的判定结果递进来了。这是本工程内部的契约违反。
    throw new Error(`条目 ${item.id} 的判定结果不是可写入的形态，却走到了写入。`);
  }
  const ref = {
    // 按**磁盘规范拼写**写：改写那条路上它就是阶段 A 刚刚在同一个对象上
    // 证明过的名字；创建那条路上目标还不存在，因此用的就是条目里的路径
    // （护栏的 `Assert-HandleMatches` 要求请求拼写与句柄最终路径一致，
    // 8.3 短名在那一关就会被拒 —— 而一个新建的对象不可能有别名）。
    ...refOf(scope, canonical_path),
    content_base64: payload.toString('base64'),
  };

  // 两条路走两个原生操作，且**不合并**：合并的实现要在调用之前按
  // 「目标存不存在」挑一个，而那正是验收标准第一条要关掉的那个窗口。
  if (mode === 'create_text') {
    const created = await deps.ops.createFileGuarded(ref);
    if (isWinfsError(created)) return { ok: false, mode, error: created };
    return { ok: true, mode, result: created, payload_bytes: payload.length };
  }
  const rewritten = await deps.ops.writeFileGuarded({
    ...ref,
    expected_sha256: item.base_sha256!,
    expected_file_id: item.base_file_id!,
  });
  if (isWinfsError(rewritten)) return { ok: false, mode, error: rewritten };
  return { ok: true, mode, result: rewritten, payload_bytes: payload.length };
}

/**
 * 回滚：把基线字节写回去，前置条件写在同一句护栏调用里。
 *
 * 它和一次普通写入走**同一个**护栏操作（`writeFileGuarded`），这不是复用
 * 省事，而是唯一正确的做法：回滚要的保证与写入完全相同（对象身份、硬链接、
 * 非重解析点、句柄内比对、刷盘、回读），而任何一条走侧门的回滚都会缺掉几样。
 * 差别只在 `expected_*` 指的是「我们写下去的那一份」而不是「批准时的基线」。
 */
async function restoreItem(deps: NativeApplierDeps, scope: ReadScope, request: RestoreRequest): Promise<WriteOutcome> {
  const result = await deps.ops.writeFileGuarded({
    ...refOf(scope, request.relative_path),
    content_base64: request.bytes.toString('base64'),
    expected_sha256: request.expected_sha256,
    expected_file_id: request.expected_file_id,
  });
  if (isWinfsError(result)) return { ok: false, mode: 'edit_text', error: result };
  return { ok: true, mode: 'edit_text', result, payload_bytes: request.bytes.length };
}

/** 独立回读：`readFileGuarded` 一次，只要身份、哈希、大小。 */
async function readState(deps: NativeApplierDeps, scope: ReadScope, item: ChangeItemRecord): Promise<ReadStateOutcome> {
  const read = await deps.ops.readFileGuarded(refOf(scope, item.canonical_path));
  if (isWinfsError(read)) return { ok: false, error: read };
  return {
    ok: true,
    file_id: read.identity.file_id,
    sha256: read.sha256,
    size: read.size,
    canonical_path: read.canonical_relative_path,
  };
}

// ---------------------------------------------------------------------------
// 阶段 A：核对
// ---------------------------------------------------------------------------

export type VetVerdict =
  /** 需要在阶段 C 写入。 */
  | { readonly kind: 'write' }
  /** 磁盘上已经是目标内容 —— 不需要改动，也**不是**冲突。 */
  | { readonly kind: 'already_target' }
  /** 计划这一侧的问题：这个条目不该被这次执行处理。 */
  | { readonly kind: 'refuse'; readonly detail: string }
  /** 磁盘那一侧与计划不符。 */
  | { readonly kind: 'conflict'; readonly detail: string };

export interface VettedItem {
  readonly item: ChangeItemRecord;
  readonly verdict: VetVerdict;
  /** 要写进磁盘的字节；只有 `write` 时非 null。 */
  readonly payload: Buffer | null;
  /** 护栏给出的**磁盘规范拼写**；阶段 C 按它写入。 */
  readonly canonical_path: string | null;
  /** 阶段 C 走哪一条原生操作。只有 `write` 时有意义。 */
  readonly mode: WriteMode;
}

function heldOf(
  item: ChangeItemRecord,
  verdict: VetVerdict,
  payload: Buffer | null = null,
  canonical: string | null = null,
): VettedItem {
  // `create_text` 与它的改写同类项走不同的原生操作，判据只写在这一处：
  // 一个「按 `item.op` 现场再判一次」的写法，会在某个分支上漏掉一次转换，
  // 而那个分支的后果是**拿覆盖写去做创建**。
  return { item, verdict, payload, canonical_path: canonical, mode: modeOf(item.op) };
}

function modeOf(op: ChangeItemRecord['op']): WriteMode {
  if (op === 'create_text') return 'create_text';
  return 'edit_text';
}

const refuseOf = (item: ChangeItemRecord, detail: string): VettedItem => heldOf(item, { kind: 'refuse', detail });
const conflictOf = (item: ChangeItemRecord, detail: string): VettedItem => heldOf(item, { kind: 'conflict', detail });

async function vetItem(deps: NativeApplierDeps, scope: ReadScope, item: ChangeItemRecord): Promise<VettedItem> {
  const hold = (verdict: VetVerdict, payload: Buffer | null = null, canonical: string | null = null): VettedItem =>
    heldOf(item, verdict, payload, canonical);
  const refuse = (detail: string): VettedItem => hold({ kind: 'refuse', detail });
  const conflict = (detail: string): VettedItem => hold({ kind: 'conflict', detail });

  // --- 计划侧：先看这一条自己站不站得住，再去打扰磁盘 ------------------------
  if (!WRITABLE_OPS.has(item.op)) {
    return refuse(
      `本条目的操作是 ${item.op}；当前构建不执行这个形态的写入。` +
        '拒绝执行，且不会退化成一次覆盖写。',
    );
  }
  // 基线的**有无**由操作形态决定，因此这条判据是双向的：
  // 改写必须有基线（没有基线就不知道该改哪一个对象），
  // 创建必须**没有**基线（有基线意味着这次创建声称自己基于某个已存在的对象）。
  // 后者不是形式主义 —— 状态库的触发器同向拒绝这种行
  // （`create_text` 不得携带基线身份或基线哈希），因此带着基线的创建
  // 根本落不了库；能出现在这里的只有跨版本或直接改库造出来的行。
  if (item.op === 'create_text') {
    if (item.base_file_id !== null || item.base_sha256 !== null) {
      return refuse(
        '创建条目的基线字段不为 null（base_file_id / base_sha256）：' +
          '一次创建不基于任何已存在的对象。拒绝，不会把它当成一次改写。',
      );
    }
  } else if (item.base_file_id === null || item.base_sha256 === null) {
    return refuse(
      '条目的基线字段缺失（base_file_id / base_sha256 为 null）：' +
        '没有基线的改写无法核对到底要改的是哪一个对象、哪一份内容。拒绝。',
    );
  }
  if (item.encoding === 'unknown') {
    return refuse('条目的编码声明是 unknown，无法核对将要写入的字节形态。拒绝。');
  }

  const target = await targetBytesOf(deps, item);
  if (target.error !== null) return refuse(target.error);
  const payload = target.bytes;

  // 任务书 §LWB-027 步骤 2 的第五项「编码」在这里：护栏负责对象身份、硬链接、
  // 哈希与权限，**编码规则只有一份定义**（`@lwb/files` 的 `inspectBytes`），
  // 因此由调用方在把字节交给护栏之前判。判的是**将要写下去的字节**，
  // 因为那才是会被留在磁盘上的东西。
  const product = inspectBytes(payload);
  if (product.kind !== 'text') {
    return refuse(
      `本条目的目标字节不是可解码的 UTF-8 文本（${product.reason}）；` +
        '这是计划与它自己的快照之间对不上，不是磁盘的问题。拒绝。',
    );
  }
  if (product.encoding !== item.encoding || product.bom !== item.bom || product.newline !== item.newline) {
    return refuse(
      '目标字节的实际形态与条目声明不符：' +
        `声明 ${item.encoding} / bom=${String(item.bom)} / ${item.newline}，` +
        `实际 ${product.encoding} / bom=${String(product.bom)} / ${product.newline}。拒绝。`,
    );
  }

  // 创建与改写从这里分道：判据完全不同（见 `vetCreate` 与下面的探针段）。
  if (item.op === 'create_text') return await vetCreate(deps, scope, item, payload);

  // --- 磁盘侧之一：探针 ----------------------------------------------------
  // 只取身份与形态，**不读内容**。分成探针 + 读取两次调用，是因为它们回答
  // 两个不同的问题（「这是哪一个对象、什么形态」与「它的字节是什么」），
  // 而合并成一次读会让「磁盘上那个东西是目录」这件事只能从护栏的一条
  // 错误消息里推出来 —— 而那条消息里带着绝对路径。
  const probe = await deps.ops.resolvePath({ ...refOf(scope, item.canonical_path), expect: 'file' });
  if (isWinfsError(probe)) {
    const mapped = mapPreWriteError(probe);
    return hold({ kind: mapped.kind, detail: detailOf(probe, mapped.kind, scope) }, null, null);
  }
  if (!isReadShaped(probe)) {
    return conflict('护栏对该路径返回了非目标形态的结果；无法据此判断这是不是一个文件。拒绝写入。');
  }
  const canonical = probe.canonical_relative_path;
  // 护栏拿不到规范路径意味着它无法证明目标在根之下。**不**退回条目里记的
  // 字符串：那个字符串正是「我到底在碰哪一个对象」这个问题的错误答案。
  if (canonical === null) {
    return conflict('护栏无法证明目标位于工作区根之下（取不到句柄规范路径）。拒绝写入。');
  }
  if (probe.attributes.is_directory) {
    return conflict(`磁盘上的 ${canonical} 是目录，而条目要把它当作文件改写。拒绝写入。`);
  }
  // 重解析点不在这里判：`Assert-HandleMatches` 在打开句柄时就会拒绝它
  // （走 `PATH_UNSAFE` → 本文件的映射里同样是 `conflict`）。再写一遍是一条
  // 走不到的检查，而走不到的检查比没有检查更糟 —— 它让人以为那句话有人验过。

  // 硬拒绝规则按**句柄规范拼写**判，不按条目里记的字符串判。prepare 阶段
  // 用的是读取票据（票据只能由受控读取签发），因此「准备出来一个 `.env`
  // 修改」在正常路径上到不了这里 —— 这一句是**兜底**：它是写入路径上唯一
  // 一处拿磁盘实际名字去过策略的地方，因此不依赖读取侧曾经判对
  // （例如硬拒绝规则在读取之后被改过）。
  const rule = classifyFile(canonical);
  if (rule.kind === 'hard_deny') {
    return refuse(
      `磁盘上的 ${canonical} 命中硬拒绝规则 ${rule.rule_id}（${rule.rationale}）；` +
        '该规则没有模型侧或工具侧的例外。拒绝写入。',
    );
  }

  // 被批准的是**那一个对象**，不是那个位置。改名不改变文件 ID，删除重建会。
  if (probe.identity.file_id !== item.base_file_id) {
    return conflict(
      `目标对象已不是被批准的那一个：条目基线文件 ID ${item.base_file_id}，磁盘实际 ${probe.identity.file_id}` +
        '（改名不改变文件 ID，删除重建会）。',
    );
  }

  // --- 磁盘侧之二：内容哈希 ------------------------------------------------
  const read = await deps.ops.readFileGuarded(refOf(scope, canonical));
  if (isWinfsError(read)) {
    const mapped = mapPreWriteError(read);
    return hold({ kind: mapped.kind, detail: detailOf(read, mapped.kind, scope) }, null, null);
  }
  // 两次调用之间对象被换掉（删除重建）：探针看的和读取看的不是同一个对象，
  // 那么这两条读数拼起来的结论不成立。
  if (read.identity.file_id !== probe.identity.file_id) {
    return conflict(
      `目标对象在两次核对之间被换掉了：探针看到 ${probe.identity.file_id}，读取看到 ${read.identity.file_id}。`,
    );
  }

  if (read.sha256 === item.target_sha256) {
    // 磁盘上已经是要写的东西。**不是冲突**，也**不需要**写入 ——
    // 硬写一遍会把一次「本来就无需改动」变成一次真实的内容改写。
    return hold({ kind: 'already_target' }, payload, canonical);
  }
  if (read.sha256 !== item.base_sha256) {
    return conflict(
      `磁盘内容已不是被批准的基线：条目基线 ${item.base_sha256}，磁盘实际 ${read.sha256}` +
        '（既不是基线、也不是目标，说明有人在这中间改过它）。未写入任何字节。',
    );
  }
  return hold({ kind: 'write' }, payload, canonical);
}

/**
 * `create_text` 的阶段 A。
 *
 * 与改写那一支的区别集中在**方向**上：改写要证明「那个对象还是被批准的
 * 那一个」，创建要证明「那个名字还没被占」。因此判据不是同一组，也就不能
 * 复用同一段代码 —— 一个「先看存在不存在、再决定用哪个原生调用」的合并
 * 实现，会在那把 `if` 上留下 TOCTOU 窗口。
 *
 * ## 这一阶段的判定**不权威**，而且这里必须说清楚为什么
 *
 * 「目标不存在」这件事只回答「**刚才**不存在」。它到阶段 C 的 `CREATE_NEW`
 * 之间有一个窗口，而验收标准第一条问的正是这个窗口里发生的事。真正的判定
 * 在 `CREATE_NEW` 里，与创建是同一次系统调用（见 `@lwb/winfs` 的说明）。
 * 这里探一次的价值是：把「那名字早就被占着」这个**常见**情形在写之前干脆地
 * 定案成冲突，而不是拖到阶段 C 变成一次待恢复。
 *
 * ## 父目录
 *
 * 「只允许已有父目录中的 create_text，父目录同样固定并验证」——两件事分开：
 *
 *  - **这里**探一次父目录，是为了早失败（父目录不存在 ⇒ 这份计划永远执行
 *    不了，而它在写之前就能知道）；
 *  - **固定与验证**由护栏在阶段 C 做：`Open-GuardedChain` 逐级打开中间目录，
 *    每一级都 `Assert-HandleMatches`（规范拼写 + 非重解析点）。
 *
 * 本工程**不**隐式创建父目录：探到父目录不存在就拒绝，绝不退化成 `mkdir`。
 */
async function vetCreate(
  deps: NativeApplierDeps,
  scope: ReadScope,
  item: ChangeItemRecord,
  payload: Buffer,
): Promise<VettedItem> {
  // --- 磁盘侧之一：那个名字现在空着吗 --------------------------------------
  // `expect: 'any'`：这里问的是「这个名字被占着吗」，而不是「它是不是文件」。
  // 目标位置上是一个**目录**也算被占着 —— `CREATE_NEW` 同样会失败，而
  // 「那里已经有个东西了」比「磁盘状态与计划不符」更接近操作者看到的事实。
  const existing = await deps.ops.resolvePath({ ...refOf(scope, item.canonical_path), expect: 'any' });
  if (!isWinfsError(existing)) {
    const canonical = isReadShaped(existing) ? existing.canonical_relative_path : null;
    // 两种主语都写成完整的句子：`${what}已被占用` 在带路径那一支会拼成
    // 「磁盘上的 src/new.ts已被占用」，读起来像路径的一部分。
    const what = canonical === null ? '目标位置已经被占用' : `磁盘上的 ${canonical} 已经被占用`;
    return conflictOf(
      item,
      `${what}，而条目要新建一个文件。创建**绝不覆盖**已存在的对象：` +
        '若那确实是要改的文件，正确做法是提案一次改写，而不是提案创建。未写入任何字节。',
    );
  }
  if (existing.code !== 'NOT_FOUND') {
    const mapped = mapPreWriteError(existing);
    return heldOf(item, { kind: mapped.kind, detail: detailOf(existing, mapped.kind, scope) });
  }

  // --- 磁盘侧之二：父目录在不在，且是不是目录 ------------------------------
  const cut = item.canonical_path.lastIndexOf('/');
  const parent = cut === -1 ? '' : item.canonical_path.slice(0, cut);
  if (parent === '' && scope.kind === 'directory') {
    // 父目录就是**工作区根自己**。护栏的 `resolvePath` 对「目录根 + 空相对路径」
    // 是刻意拒绝的（那根本不是一次寻址），因此这一格不探、也不该探 ——
    // 根是目录这件事由登记工作区时写下的 `kind` 说明，根的身份由护栏在
    // 每一次 `Open-GuardedChain` 里重新核实（卷序列号 + 文件索引逐位比对，
    // 不符即 `ROOT_IDENTITY_MISMATCH`）。省掉的是一次**重复**的证明。
    return heldOf(item, { kind: 'write' }, payload, item.canonical_path);
  }

  const parentProbe = await deps.ops.resolvePath({ ...refOf(scope, parent), expect: 'directory' });
  if (isWinfsError(parentProbe)) {
    const mapped = mapPreWriteError(parentProbe);
    const detail =
      parentProbe.code === 'NOT_FOUND'
        ? `父目录 ${parent} 不存在（护栏码 NOT_FOUND）。本工程**不隐式创建父目录**，` +
          '因此这份计划执行不了；请先由人在本地建好那一级目录，再重新提案。未写入任何字节。'
        : detailOf(parentProbe, mapped.kind, scope);
    return heldOf(item, { kind: mapped.kind, detail });
  }
  if (!isReadShaped(parentProbe) || !parentProbe.attributes.is_directory) {
    return conflictOf(
      item,
      `父路径 ${parent} 在磁盘上不是一个目录，而条目要在它下面新建文件。拒绝写入。`,
    );
  }

  return heldOf(item, { kind: 'write' }, payload, item.canonical_path);
}

/** 从快照库取目标字节，并核对它确实是条目声明的那些字节。 */
async function targetBytesOf(
  deps: NativeApplierDeps,
  item: ChangeItemRecord,
): Promise<{ readonly bytes: Buffer; readonly error: null } | { readonly bytes: null; readonly error: string }> {
  const got = await bytesOf(deps, item.new_blob_id, item.target_sha256, '目标');
  return got.ok ? { bytes: got.bytes, error: null } : { bytes: null, error: `${got.detail}拒绝，不会用别的字节顶替。` };
}

// ---------------------------------------------------------------------------
// 失败分类
// ---------------------------------------------------------------------------

/**
 * 写入**之前**的护栏错误 → 报告种类。
 *
 * 分界线是「原因在磁盘那一侧，还是计划/环境这一侧」：前者的处理是重新看一遍
 * 目标（多半要重新提案），后者看目标没用。两者落在同一格终局上，区别只在
 * 给操作者看的那句话 —— 而那正是他用来决定下一步的东西。
 *
 * 表是**穷举**的（`Record<WinfsError['code'], …>`），因此护栏每加一个错误码，
 * 这里都会变成一次编译错误，而不是一次静默的兜底。兜底只留给护栏返回了一个
 * 本构建不认识的码这种情形（跨版本），那时按「磁盘那一侧」处理。
 */
const PRE_WRITE_ERROR_KIND: Readonly<Record<WinfsError['code'], 'conflict' | 'refuse'>> = {
  // 磁盘 / 环境那一侧
  FILE_VERSION_CONFLICT: 'conflict',
  NOT_FOUND: 'conflict',
  FILE_BUSY: 'conflict',
  PERMISSION_DENIED: 'conflict',
  PATH_UNSAFE: 'conflict',
  LINK_UNSUPPORTED: 'conflict',
  ROOT_IDENTITY_MISMATCH: 'conflict',
  VOLUME_UNSUPPORTED: 'conflict',
  IO_ERROR: 'conflict',
  // 计划 / 构建这一侧
  INVALID_ARGUMENT: 'refuse',
  NATIVE_GUARD_UNAVAILABLE: 'refuse',
};

function mapPreWriteError(error: WinfsError): { readonly kind: 'conflict' | 'refuse' } {
  return { kind: PRE_WRITE_ERROR_KIND[error.code] ?? 'conflict' };
}

/**
 * 失败的说明文字。
 *
 * 护栏的消息里可能带**绝对路径**（它是在工作区根的坐标系里写这些话的）。
 * 这里把根替换掉：报告会进执行日志，而日志不该成为一份本机目录结构的抄本。
 * 只替换根，不动别的 —— 一个「把所有像路径的东西都擦掉」的过滤器会顺手
 * 擦掉真正的病因，而这份文字的唯一用途就是告诉人病因。
 *
 * 替换用的是 `journal.ts` 的 `redactRoot`，而不是本文件里的第二份实现：
 * 同一句话在两条通往日志的路上必须由同一段代码执行，否则其中一条迟早
 * 会漏掉一次替换。
 */
function detailOf(error: WinfsError, kind: 'conflict' | 'refuse', scope: ReadScope): string {
  const tail = kind === 'conflict' ? '磁盘状态与计划不符，未写入任何字节。' : '未写入任何字节。';
  const win32 = error.win32_error === 0 ? '' : ` / Win32 ${error.win32_error}`;
  return `${redactRoot(error.message, scope)}（护栏码 ${error.code}${win32}）。${tail}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 阶段 C 的回答 → 工程词汇
// ---------------------------------------------------------------------------

/**
 * 一次失败写下的**事实**，交给 `apply.ts` 做决定。
 *
 * ## 「动过没有」与「现场知道不知道」是两件事
 *
 * LWB-028 时这里把两者合成了一句「`actual_state` 在不在」。那句话有一个洞：
 * 护栏的现场观测是**尽力而为**的（`Get-BoundedActualState` 自己失败时返回
 * `$null`），因此「越过那条线之后失败、且观测也失败」的调用会带着一个
 * 看起来干净的响应回去。LWB-029 在护栏里把两件事分成两个字段
 * （`WinfsError.touched` / `WinfsError.actual_state`），这里如实转交：
 *
 * | `touched` | `actual_state` | 这句话的意思 |
 * | --- | --- | --- |
 * | 缺席 | 缺席 | 一个字节都没动 —— **可以依赖**的否定 |
 * | `true` | 有值 | 动过，现场已知（大小、身份、完整哈希或截断标记） |
 * | `true` | 缺席 | 动过，现场**未知** —— 只能进恢复，绝不能回滚 |
 */
export interface GuardFailureFacts {
  readonly touched: boolean;
  readonly observed: boolean;
  /**
   * 这次失败是否**足以证明**「本次执行在这个文件上没留下任何字节」。
   *
   * 判据是上面那张表的头两行取反，加上一条例外：
   * `NATIVE_GUARD_UNAVAILABLE` 一律**不**证明任何事。它有可能只是客户端
   * 合成的「没连上护栏」—— 响应根本没从护栏回来，那么「`touched` 缺席」
   * 与「进程被杀」是同一种情形（`WinfsError` 的注释里写着：被杀不产生响应，
   * 因此不会伪装成一份干净的失败；而客户端合成的不可用**会**）。
   * 这条例外是 fail-closed 方向上的：它只可能让一次「其实没写成」被多报成
   * 一次待恢复，反过来则是把一个未知当成已知。
   */
  readonly provesUntouched: boolean;
  readonly winfs_code: WinfsError['code'];
  readonly win32_error: number;
  /** 现场观测（可能缺席，也可能被 1 MiB 上界截断）。 */
  readonly actual: WinfsError['actual_state'];
}

export function guardFailureFacts(error: WinfsError): GuardFailureFacts {
  // 严格按 `=== true` 读：`touched` 是个「在场即真」的标记，任何别的取值
  // 都当作「没说」，而「没说」的含义是最强的那一个否定命题。
  const touched = error.touched === true;
  return {
    touched,
    observed: error.actual_state !== undefined,
    provesUntouched: !touched && error.code !== 'NATIVE_GUARD_UNAVAILABLE',
    winfs_code: error.code,
    win32_error: error.win32_error,
    actual: error.actual_state,
  };
}

/**
 * 一条护栏失败**对「字节的下落」说了什么**。三句话，不是两句。
 *
 * LWB-033 之前，报告与日志里只有两句：「已进入破坏性区域」与「未进入破坏性
 * 区域」—— 由 `provesUntouched` 的真假二选一。而那是一个**把「没被证明」
 * 读成「被否定」**的错：`provesUntouched === false` 的意思只是「这条失败
 * 不能证明没动过」，它同时覆盖了「证明动过」与「什么都没说」两种情形。
 * 护栏进程死掉时调用方拿到的是**客户端合成**的一条失败
 * （`ResidentHelper.#onGone`），它一个字节的下落都没说 —— 而它当时被印成了
 * 「已进入破坏性区域」，也就是把一个未知印成了已知。
 *
 * 判据因此按**证据**分三层，而不是按一句话的真假分两层：
 *
 * | 情形 | 判定 | 依据 |
 * | --- | --- | --- |
 * | `touched === true` | `TOUCHED` | 护栏**说过**它进了破坏性区域 |
 * | `touched` 缺席且码不是 `NATIVE_GUARD_UNAVAILABLE` | `NOT_TOUCHED` | 护栏的契约是「只在没进破坏性区域时才省略 `touched`」 |
 * | `touched` 缺席且码是 `NATIVE_GUARD_UNAVAILABLE` | `UNKNOWN` | 这条失败可能是客户端合成的，根本没到过护栏 |
 *
 * 第三行是**保守**方向上的：把一次其实没写成报成未知，代价是多看一次；
 * 反过来则是把一个未知当成已知，那正是本任务要拦下的那个错误答案。
 */
export type GuardVerdict = 'TOUCHED' | 'NOT_TOUCHED' | 'UNKNOWN';

/** `provesUntouched` 的三值版本 —— 由它派生，因此两者不可能各自漂移。 */
export function guardVerdict(facts: GuardFailureFacts): GuardVerdict {
  if (facts.provesUntouched) return 'NOT_TOUCHED';
  return facts.touched ? 'TOUCHED' : 'UNKNOWN';
}

/**
 * 上面那个判定的一句话说法（无句末标点，供报告与日志拼接）。
 *
 * 三句话都必须能被**单独读**：操作者看的是这一句，而不是本文件的注释。
 * 尤其是第三句 —— 它不描述磁盘，它描述**我们手上有什么证据**。
 */
export function guardVerdictClause(facts: GuardFailureFacts): string {
  switch (guardVerdict(facts)) {
    case 'TOUCHED':
      return '护栏报告已进入破坏性区域';
    case 'NOT_TOUCHED':
      return '护栏报告未进入破坏性区域';
    case 'UNKNOWN':
      return '这个回答可能根本没到过护栏，因此它进没进破坏性区域没有被报告过';
  }
}

/**
 * 现场观测是否**足以**当作回滚的比对凭据。
 *
 * 两个条件，缺一不可：
 *  - `sha256` 非空 —— 被 1 MiB 上界截断的观测给不出完整哈希，而回滚要靠
 *    它做乐观并发（`expected_sha256`）。拿一个「前 1 MiB 的哈希」去比对，
 *    比对的是另一样东西；
 *  - `observed_bytes === size` —— 读全了。截断时这两个数不等，而它们是
 *    护栏自己能报出来的事实，不必再猜。
 */
export function observationIsComplete(actual: NonNullable<WinfsError['actual_state']>): boolean {
  return actual.sha256 !== null && actual.observed_bytes === actual.size;
}

/**
 * 回执核对：返回 `null` 表示「这个文件确定地写成了」。
 *
 * 按**写入形态**分派到两份判据上，而不是在一个函数里对 `null` 做判断 ——
 * 创建没有 `identity_before` 可比，混合写法会让同一个函数在两种模式下
 * 检查的东西**不一样**，而读代码的人看到的是一份统一的判据。
 *
 * 判据比验收标准要求的更紧一点（那里只要求回读哈希等于已批准的新哈希），
 * 代价是**可能把一次实际成功的写入判成待恢复**：`flushed=false` 时内容
 * 通常已经在页缓存里、只是没能刷到盘。仍然按失败处理，因为「字节可能还在
 * 内存里」正是崩溃后会产生部分字节的那种状态，而本次执行的回执会被写进
 * 执行日志 —— 一份说「已完成」的日志配一次可能没落盘的写入，比一次多余的
 * 人工核验糟得多。
 *
 * LWB-029 之后它的调用者不再直接抛：有抱怨意味着盘上的字节不是我们批准的
 * 那一份，而**盘上确实有字节** —— 于是那条路要走的是「记账 + 有界回滚」，
 * 由 `apply.ts` 决定。返回一句话而不是抛，正是为了让那个决定有得可做。
 */
export function complaintOf(item: ChangeItemRecord, outcome: WriteOutcome): string | null {
  if (!outcome.ok) return null;
  return outcome.mode === 'create_text'
    ? createComplaint(item, outcome.result as WinfsCreateResult, outcome.payload_bytes)
    : receiptComplaint(item, outcome.result as WinfsWriteResult);
}

/**
 * 创建的回执核对。**与改写共用后半段，但没有前半段。**
 *
 * 少掉的那一段是 `identity_before` / `base_file_id` 的比较 —— 创建一个
 * 还不存在的对象，没有「之前是谁」可谈。这一条必须由**调用点**按模式分开，
 * 而不是在核对函数里对 `null` 做判断：`base_file_id` 为 null 时那两句比较
 * 会静默地不成立，于是同一个函数在两种模式下检查的东西**不一样**，
 * 而读代码的人看到的是一份统一的判据。
 *
 * 多出来的那一段是 `target_sha256`：改写那条路上护栏回的 `target_sha256`
 * 已经用了很久，而创建是 LWB-028 才补上的字段。两次核对的是同一件事
 * （护栏收到的字节 == 条目批准的那一份），但它在这里格外要紧：创建**没有
 * 基线可对**，因此「护栏收到的到底是不是我们批准的那份字节」是这条路上
 * 唯一一处把「批准的内容」与「写下去的内容」连起来的检查。
 */
function createComplaint(item: ChangeItemRecord, result: WinfsCreateResult, approvedSize: number): string | null {
  if (result.target_sha256 !== item.target_sha256) {
    return `护栏收到的字节与本条目的目标不符：条目 ${item.target_sha256}，写入 ${result.target_sha256}。`;
  }
  if (!result.readback_ok) {
    return `新建 ${item.canonical_path} 之后的回读与目标不符（readback_ok=false）。`;
  }
  if (result.after_sha256 !== item.target_sha256) {
    return (
      `新建 ${item.canonical_path} 后的回读哈希 ${result.after_sha256} 与已批准的新哈希 ${item.target_sha256} 不符；` +
      '该文件不得报告为完成。'
    );
  }
  if (!result.flushed) {
    return `新建 ${item.canonical_path} 后刷盘未完成（flushed=false）；内容可能仍在页缓存中，该文件不得报告为完成。`;
  }
  if (result.bytes_written !== approvedSize) {
    // 哈希已经对上了，长度却对不上 —— 那只能说明其中一条读数描述的不是
    // 同一个东西。宁可多一次人工核验，也不把一个说不清的对象报成「已建好」。
    return `新建 ${item.canonical_path} 报告的写入字节数 ${result.bytes_written} 与已批准的长度 ${approvedSize} 不符。`;
  }
  return null;
}

function receiptComplaint(item: ChangeItemRecord, result: WinfsWriteResult): string | null {
  return writeReceiptComplaint(
    item.canonical_path,
    { sha256: item.target_sha256, label: '本条目的目标', file_id: item.base_file_id },
    result,
  );
}

/**
 * 回滚回执的核对。
 *
 * 与一次普通写入走**同一份**判据，只是把「期望」从「本条目的目标」换成
 * 「我们刚刚写下去的那一份」：回滚要证明的事实是「文件回到了基线」，
 * 而判据的形状（护栏收到的 == 期望的、回读 == 收到的、刷过盘、
 * 身份没有换过）一件都不变。因此下面那个函数是共用的 ——
 * 两份长得一样但各改各的判据，迟早会在某一次只改了一处的修改里分叉，
 * 而分叉的那一侧是「回滚报成功、其实没回到基线」。
 *
 * 多出来的一项是 `bytes_written`：创建那条路上一直有它（LWB-028），
 * 而回滚这条路上它格外要紧 —— 回滚写下去的是**基线长度**，
 * 一个长度不符的回执说明盘上的对象不是我们以为的那一个。
 */
export function restoreComplaint(
  item: ChangeItemRecord,
  expected: { readonly sha256: string; readonly file_id: string; readonly bytes: number },
  outcome: WriteOutcome,
): string | null {
  if (!outcome.ok) return null;
  const receipt = outcome.result as WinfsWriteResult;
  const complaint = writeReceiptComplaint(
    item.canonical_path,
    { sha256: expected.sha256, label: '要写回去的基线', file_id: expected.file_id },
    receipt,
  );
  if (complaint !== null) return complaint;
  if (receipt.bytes_written !== expected.bytes) {
    return (
      `回滚 ${item.canonical_path} 报告的写入字节数 ${receipt.bytes_written} 与基线长度 ${expected.bytes} 不符；` +
      '该文件不得报告为已回到基线。'
    );
  }
  return null;
}

/**
 * 上面两份的**共用判据**。
 *
 * `expected.label` 只进消息：判据本身对两种调用完全相同，而消息要让人一眼
 * 看出「对不上的那一份是什么」——「已批准的新哈希」与「要写回去的基线」
 * 在同一份日志里必须读得出来。
 * `expected.file_id` 为 `null` 表示「没有可对的身份」。
 */
function writeReceiptComplaint(
  path: string,
  expected: { readonly sha256: string; readonly label: string; readonly file_id: string | null },
  result: WinfsWriteResult,
): string | null {
  if (result.target_sha256 !== expected.sha256) {
    return `护栏收到的字节与${expected.label}不符：期望 ${expected.sha256}，护栏算出 ${result.target_sha256}。`;
  }
  if (!result.readback_ok) {
    return `写入 ${path} 之后的回读与目标不符（readback_ok=false）。`;
  }
  if (result.after_sha256 !== expected.sha256) {
    return `写入 ${path} 后的回读哈希 ${result.after_sha256} 与${expected.label} ${expected.sha256} 不符；该文件不得报告为完成。`;
  }
  if (!result.flushed) {
    return `写入 ${path} 后刷盘未完成（flushed=false）；内容可能仍在页缓存中，该文件不得报告为完成。`;
  }
  if (result.identity_after.file_id !== result.identity_before.file_id) {
    return `写入 ${path} 期间对象身份发生了变化（${result.identity_before.file_id} → ${result.identity_after.file_id}）。`;
  }
  if (expected.file_id !== null && result.identity_after.file_id !== expected.file_id) {
    return `写入后的对象身份 ${result.identity_after.file_id} 与期望的 ${expected.file_id} 不符。`;
  }
  return null;
}

/** `WorkspaceRecord`（状态库的**行**）→ `ReadScope`（护栏的**作用域**）。 */
export function scopeOf(workspace: WorkspaceRecord): ReadScope {
  return readScopeOf({
    workspace_id: workspace.id,
    kind: workspace.kind,
    mode: workspace.mode,
    generation: workspace.generation,
    // 字段名不同不是笔误：行里叫 `canonical_root`，作用域里叫 `root_path`。
    // 转换只写在这一处，是因为「哪一列变成哪一个字段」应当只有一个答案。
    root_path: workspace.canonical_root,
    volume_id: workspace.volume_id,
    file_id: workspace.root_file_id,
  });
}
