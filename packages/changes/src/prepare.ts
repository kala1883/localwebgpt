/**
 * 建立不可变修改集并生成差异预览（LWB-020）。
 *
 * ## 这个模块做什么、绝不做什么
 *
 * 它做四件事，按这个顺序：
 *
 *  1. **重读**每个目标 —— 提案里的基线是模型说的，票据是上一次读取签的，
 *     两者都必须与**此刻磁盘上的字节**对上。
 *  2. **在内存里算出最终字节**（调用 LWB-019 的文本引擎），并据此得到
 *     结果哈希、尺寸、编码、换行、BOM 与增量行数。
 *  3. **把旧字节与新字节都落进内容寻址快照库**，把修改集与逐条事实写进状态库。
 *  4. 返回一份**完整**的预览：路径、操作、前后哈希与尺寸、编码、换行、
 *     增量行数、风险与摘要。
 *
 * 它**不**做的事，每一条都有一个具体的坏结果与之对应：
 *
 *  - **不写用户工作区的任何字节。** 这个模块只对工作区发出 `resolvePath` 与
 *    `readFileGuarded` 两种调用；`WinfsOps` 上任何一个写方法都不在这里出现。
 *    验收标准「prepare 不改变用户工作区任何文件」因此不是一句承诺，
 *    而是「本文件里没有那个调用」这件可以被静态检查的事实。
 *  - **不签发批准、不看 `approved` 之类的参数。** 建立修改集不需要任何授权，
 *    它只是把一份提案变成一份**可被批准**的对象。状态的初次流转
 *    （`PENDING_APPROVAL`）由 `ChangesRepo.create` 写死，没有入口可以指定别的。
 *  - **不允许修订。** 修改集一经建立，内容那一列由数据库触发器冻结
 *    （`changesets_content_immutable` / `change_items_immutable`）。改一个字节
 *    就是另一次 prepare、另一个 change_id、另一份摘要 —— 于是旧批准
 *    在摘要上对不上，自动失效。本模块没有任何「更新已有修改集」的路径。
 *
 * ## 为什么这里自己读文件，而不是调用 `@lwb/files` 的 `readFile`
 *
 * `readFile` 是**出站**读取：它按行分页（`MAX_READ_LINES`）、过秘密闸门
 * （命中就脱敏）、并且把正文经 `emitContent` 送出本机。这三件事对
 * 「给模型看」都是必需的，对「算出一份最终字节」则都是错的：
 *
 *  - 分页会让一个超过 400 行的文件读不完整 —— 而编辑的合法性判定
 *    需要整个文件的字节；
 *  - 脱敏后的正文与磁盘字节不同，拿它算出的新内容会把脱敏标记写进用户文件；
 *  - 出站闸门会**再发一次**整份文件，而模型早就拿到了它。
 *
 * 因此这里走的是与 `readFile` **同一套护栏纪律**，但只到「拿到字节」为止：
 * 探针（只取身份与尺寸）→ 受控句柄读取 → 句柄身份比对。共用的部分
 * （`refOf` / `resolveTarget` / `toBridgeError` / 判决路径规则）全部来自
 * `@lwb/files` 的 `guard-bridge.ts`，本文件不重新实现其中任何一条 ——
 * 两处各写一遍「同一个路径给出同一个答案」的规则，迟早在某一处漏掉一个分支。
 *
 * ## 读到了一个**已经不能编辑**的文件怎么办
 *
 * 票据里的 `editable` 是**签发那一刻**的裁定。两次读取之间文件可能变大、
 * 被加上硬链接、被换成不可写的编码。因此这里重读之后不沿用票据的裁定，
 * 而是拿**当场的事实**再判一次：尺寸、硬链接数、能否识别为文本。
 * 判不过就拒绝，并把「签发时是什么、现在是什么」都写进 details。
 */

import { randomUUID } from 'node:crypto';

import {
  BridgeError,
  CONTRACT_VERSION,
  LIMITS,
  sha256Hex,
  validateRelativePath,
  type ChangeFilePreview,
  type ChangeItem,
  type ChangeOp,
  type ChangePrepareData,
  type ChangePrepareInput,
  type ChangeRisk,
  type ChangeSetView,
  type FileEncoding,
  type NewlineStyle,
} from '@lwb/contracts';
import { BlobQuotaExceededError } from '@lwb/blob-store';
import type { BlobStore } from '@lwb/blob-store';
import {
  inspectBytes,
  refOf,
  requireCanonicalPath,
  resolveTarget,
  toBridgeError,
  type ReadScope,
  type ReadTicketAuthority,
  type ReadTicketPayload,
} from '@lwb/files';
import type { ChangeItemRecord, ChangeSetRecord, Repositories } from '@lwb/persistence';
import { isWinfsError, type WinfsFileIdentity, type WinfsOps } from '@lwb/winfs';

import { canonicalChangeDigest, changeRequestFingerprint, shortCodeOf, type RequestItem } from './digest.ts';
import {
  assertDistinctTargets,
  validateChangeItems,
  type ChangePlan,
  type ChangeTarget,
  type ValidatedChangeItem,
} from './edit-contract.ts';
import { withIdempotencyLock } from './single-flight.ts';
import { applyLineEdits, createTextFile, replaceWholeText, type AppliedTextChange } from './text-engine.ts';

/** 幂等与审计里记录的**工具名**。改写它会孤立此前所有记录，因此是常量。 */
export const CHANGE_PREPARE_TOOL = 'change_prepare';

/**
 * 摘要之外的限额。
 *
 * 每一项都在两条路径上取值（契约工具 schema 与本层），因此与
 * `MAX_EDITABLE_FILE_BYTES` 同规矩：只在 `@lwb/contracts` 里写一次。
 */
export interface PrepareLimits {
  readonly max_editable_file_bytes: number;
  readonly max_change_files: number;
  readonly max_change_total_bytes: number;
  readonly change_ttl_ms: number;
}

export const DEFAULT_PREPARE_LIMITS: PrepareLimits = {
  max_editable_file_bytes: LIMITS.MAX_EDITABLE_FILE_BYTES,
  max_change_files: LIMITS.MAX_CHANGE_FILES,
  max_change_total_bytes: LIMITS.MAX_CHANGE_TOTAL_BYTES,
  change_ttl_ms: LIMITS.CHANGE_TTL_MS,
};

export interface PrepareChangeArgs {
  /** 来自 IPC 通道的**认证身份**，不是工具参数（ADR-003 §4）。 */
  readonly principal_id: string;
  /** 建立本次修改集的连接；它同时是修改集的归属连接。 */
  readonly connection_id: string;
  readonly workspace_id: string;
  /** 授权时的代次。落库为 `root_generation`。 */
  readonly generation: number;
  /** 本次授权所依据的策略版本。落库为 `policy_version`。 */
  readonly policy_version: number;
  readonly scope: ReadScope;
  readonly now: number;
  readonly input: ChangePrepareInput;
}

export interface PrepareChangeDeps {
  readonly ops: WinfsOps;
  readonly authority: ReadTicketAuthority;
  readonly blobs: BlobStore;
  readonly repos: Repositories;
  readonly limits?: Partial<PrepareLimits>;
  /** 仅用于测试：注入确定性 ID。生产上随机，且 ID 不参与任何判定。 */
  readonly newId?: () => string;
}

// ---------------------------------------------------------------------------
// 受控重读
// ---------------------------------------------------------------------------

interface BaselineRead {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly canonical_path: string;
  readonly identity: WinfsFileIdentity;
  readonly size: number;
}

function limitsOf(deps: PrepareChangeDeps): PrepareLimits {
  return { ...DEFAULT_PREPARE_LIMITS, ...(deps.limits ?? {}) };
}

/**
 * 重读一个已存在的目标文件。三步，缺一不可。
 *
 * 探针 → 读取 → 比对，与 `read.ts` 同序同理由（先问尺寸再读字节、
 * 读完比对**句柄身份**而不是路径字符串）。差别只在于这里**不**出站、
 * **不**分页 —— 理由见文件头。
 */
async function readBaseline(
  ops: WinfsOps,
  scope: ReadScope,
  path: string,
  maxBytes: number,
  operation: 'edit' | 'delete' = 'edit',
): Promise<BaselineRead> {
  const probe = await resolveTarget(ops, scope, path, 'file');
  if (probe.size > maxBytes) {
    throw new BridgeError(
      'SIZE_LIMIT_EXCEEDED',
      operation === 'delete'
        ? `该文件有 ${probe.size} 字节，超过完整快照读取上限 ${maxBytes} 字节；本次没有删除文件。`
        : `该文件有 ${probe.size} 字节，超过可编辑上限 ${maxBytes} 字节；本文件不能在原地修改。`,
      { reason: operation === 'delete' ? 'DELETE_SNAPSHOT_TOO_LARGE' : 'FILE_TOO_LARGE_FOR_EDIT', path, size: probe.size, limit: maxBytes },
    );
  }

  const result = await ops.readFileGuarded(refOf(scope, path));
  if (isWinfsError(result)) throw toBridgeError(result);

  if (
    result.identity.volume_id !== probe.identity.volume_id ||
    result.identity.file_id !== probe.identity.file_id ||
    result.size !== probe.size
  ) {
    throw new BridgeError(
      'FILE_VERSION_CONFLICT',
      '文件在本次重读的两次打开之间被替换或改动，已放弃建立修改集；请重新读取该文件。',
      {
        reason: 'IDENTITY_CHANGED_BETWEEN_OPENS',
        path,
        size_before: probe.size,
        size_after: result.size,
      },
    );
  }

  return {
    bytes: Buffer.from(result.bytes_base64, 'base64'),
    sha256: result.sha256,
    canonical_path: requireCanonicalPath(result.canonical_relative_path),
    identity: result.identity,
    size: result.size,
  };
}

// ---------------------------------------------------------------------------
// 票据与磁盘的比对
// ---------------------------------------------------------------------------

/**
 * 票据说的是**上一次读取时**的事实，这里比对的是**这一次重读**的事实。
 *
 * 三道判据由弱到强，顺序不能调换：
 *
 *  1. **身份**（卷序列号 + 文件索引）—— 最弱的假设，也最致命的一条。
 *     路径字符串在这里帮不上忙：同一个拼写可能已经指向另一个对象
 *     （被换成新文件、工作区根被重定向）。票据里的身份与当下不符，
 *     说明这份提案基于的对象已经不在了。
 *  2. **尺寸** —— 单独看它很弱（同尺寸改写看不出来），放在身份之后是为了
 *     把最常见的情形（文件被追加/截断）给出一个比「内容不符」更准确的诊断。
 *  3. **内容哈希** —— 最强的一条，也是唯一真正充分的一条。
 *
 * 三条都过之后，`read.sha256` 必然等于 `ticket.raw_bytes_sha256`，而后者
 * 已由 LWB-019 断言等于提案里的 `base_sha256`。因此这里**不再**单独比对
 * `base_sha256` —— 那是引擎的职责（`text-engine` 用基线字节判冲突），
 * 而这里比对的是「磁盘 vs 票据」这一段。
 */
function verifyTicketAgainstDisk(ticket: ReadTicketPayload, read: BaselineRead, path: string): void {
  const stale = (
    reason: string,
    message: string,
    extra: Readonly<Record<string, string | number | boolean | null>> = {},
  ): never => {
    throw new BridgeError('READ_TOKEN_STALE', message, { reason, path, ...extra });
  };

  if (ticket.volume_id !== read.identity.volume_id || ticket.file_id !== read.identity.file_id) {
    stale('TICKET_IDENTITY_MISMATCH', '该路径上的对象已经不是读取时的那一个；请重新读取该文件后再提议。', {
      ticket_volume_id: ticket.volume_id,
      ticket_file_id: ticket.file_id,
      current_volume_id: read.identity.volume_id,
      current_file_id: read.identity.file_id,
    });
  }
  if (ticket.size !== read.size) {
    stale('TICKET_SIZE_MISMATCH', '文件大小与读取时不同；请重新读取该文件后再提议。', {
      ticket_size: ticket.size,
      current_size: read.size,
    });
  }
  if (ticket.raw_bytes_sha256 !== read.sha256) {
    stale('TICKET_CONTENT_MISMATCH', '文件内容与读取时不同；请重新读取该文件后再提议。', {
      ticket_sha256: ticket.raw_bytes_sha256,
      current_sha256: read.sha256,
    });
  }
}

/**
 * 重读之后重新判一次「能不能编辑」。
 *
 * 票据里的 `editable` 与 `editable_blockers` 是**签发那一刻**的裁定，
 * 而 LWB-019 的 `require_editable` 只保证「当时可以」。两次读取之间文件
 * 完全可能变成一个不该写的对象（变大了、被加了硬链接、被换成了二进制）。
 * 沿用旧裁定等于让一次过期的许可继续生效，因此这里拿当场的事实在判一遍。
 *
 * **判据与 `read.ts` 的 `editableBlockers` 同源**：这里只重复其中与
 * 「字节本身」有关的两条（尺寸、可识别为文本），硬链接那条由护栏在
 * `readFileGuarded` 之后给不出（它在 resolvePath 结果里），故用 `read.identity.link_count`。
 * 两条都有独立的测试；两处判据若将来分叉，应当合并回 `@lwb/files`。
 */
function requireStillEditable(read: BaselineRead, maxBytes: number, path: string): void {
  if (read.size > maxBytes) {
    throw new BridgeError(
      'SIZE_LIMIT_EXCEEDED',
      `该文件有 ${read.size} 字节，超过可编辑上限 ${maxBytes} 字节；本文件不能在原地修改。`,
      { reason: 'FILE_TOO_LARGE_FOR_EDIT', path, size: read.size, limit: maxBytes },
    );
  }
  if (read.identity.link_count > 1) {
    throw new BridgeError(
      'LINK_UNSUPPORTED',
      `该文件现在有 ${read.identity.link_count} 个硬链接；写入会同时改变工作区外的另一个名字，V1 保守拒绝。`,
      { reason: 'HARDLINK_COUNT_CHANGED', path, link_count: read.identity.link_count },
    );
  }
  const decoded = inspectBytes(read.bytes);
  if (decoded.kind !== 'text') {
    throw new BridgeError(
      'ENCODING_UNSUPPORTED',
      `重读发现该文件不再是可写的文本（${decoded.reason}）；本次修改被拒绝。`,
      { reason: 'NOT_EDITABLE_TEXT_AT_PREPARE', path, decode_reason: decoded.reason },
    );
  }
}

// ---------------------------------------------------------------------------
// create_text 的落点检查
// ---------------------------------------------------------------------------

/**
 * 创建操作不能只判「目标不存在」。
 *
 * V1 只支持**在已存在的父目录里新建文件**。护栏对「目标不存在」与
 * 「父目录也不存在」给出的是同一个 `NOT_FOUND`，因此只判目标是否存在，
 * 会把一份永远执行不了的修改集放进队列 —— 它看起来待批准，批准之后
 * 必然失败。这里把父目录单独探一次：父目录必须存在且是目录。
 *
 * 顺带一个容易漏掉的情形：目标位置上是一个**目录**。`CREATE_NEW` 会失败，
 * 但更好的做法是当场说清楚「那里已经有个东西了」，而不是等执行时。
 * 因此探测用 `expect: 'any'`：只要解析成功，就说明这个名字被占着。
 */
async function requireCreatable(ops: WinfsOps, scope: ReadScope, path: string): Promise<void> {
  const existing = await ops.resolvePath({ ...refOf(scope, path), expect: 'any' });
  if (!isWinfsError(existing)) {
    // 与写入路径同一个码：护栏把 CREATE_NEW 撞上已有文件判为
    // FILE_VERSION_CONFLICT，这里提前给出同一个答案，调用方不必区分
    // 「提议时被拒」与「执行时被拒」。
    throw new BridgeError('FILE_VERSION_CONFLICT', `目标位置已被占用，create_text 绝不覆盖：${path}`, {
      reason: 'TARGET_EXISTS',
      path,
    });
  }
  if (existing.code !== 'NOT_FOUND') throw toBridgeError(existing);

  const cut = path.lastIndexOf('/');
  const parent = cut === -1 ? '' : path.slice(0, cut);
  await requireParentDirectory(ops, scope, parent, path);
}

/**
 * 父目录必须是**已存在**的目录，且不能是有别名的对象。
 *
 * 除一种情形，一律走探针：父目录正是**目录工作区的根**（`parent === ''`）。
 * 护栏的 `resolvePath` 对「目录根 + 空相对路径」是**故意**拒绝的 ——
 *
 * > 相对路径为空，而工作区根是一个目录…… 列举根目录请用 listDirectory。
 *
 * 它这么做是对的：`resolvePath` 回答的是「这个路径是哪一个对象」，而
 * 「不用路径、直接说整个根」根本不是一次寻址。可「在工作区根下新建一个
 * 文件」是一次完全正常的提案 —— 根确实是一个已存在的目录。于是这里与
 * `@lwb/files` 的目录列举走同一条路（见 `list.ts` 的 `resolveBase`）：
 * 根的**目录性质**来自作用域（登记工作区时写下的 `kind`），根的**身份**由
 * 护栏在每一次 `Open-GuardedChain` 里重新核实（句柄算出的卷序列号与文件
 * 索引必须与请求里的 `root_volume_id` / `root_file_id` 逐位相同，否则
 * `ROOT_IDENTITY_MISMATCH`）。
 *
 * 省掉的是一次**重复**的证明，不是一次缺失的证明。唯一真正少掉的是根目录的
 * 硬链接计数：NTFS 的目录不支持硬链接（`CreateHardLinkW` 对目录直接失败），
 * 目录的别名只能是重解析点，而重解析点由护栏逐级判定拒绝 —— 因此这一条在
 * 根上没有对应的真实风险；父目录是**子**目录时它仍然照常执行。
 */
async function requireParentDirectory(
  ops: WinfsOps,
  scope: ReadScope,
  parent: string,
  path: string,
): Promise<void> {
  if (parent === '' && scope.kind === 'directory') return;

  const parentTarget = await resolveTarget(ops, scope, parent, 'directory');
  if (parentTarget.identity.link_count > 1) {
    throw new BridgeError('LINK_UNSUPPORTED', `父目录有 ${parentTarget.identity.link_count} 个硬链接；V1 保守拒绝。`, {
      reason: 'PARENT_HARDLINKED',
      path,
      parent,
    });
  }
}

// ---------------------------------------------------------------------------
// 逐项建立
// ---------------------------------------------------------------------------

interface PreparedFile {
  readonly path: string;
  readonly op: ChangeOp;
  /** 重读时**当场**取得的文件身份；`create_text` 为 null（文件还不存在）。 */
  readonly base_volume_id: string | null;
  readonly base_file_id: string | null;
  readonly base_sha256: string | null;
  readonly target_sha256: string;
  readonly old_bytes: Buffer | null;
  readonly new_bytes: Buffer;
  readonly encoding: FileEncoding;
  readonly newline: NewlineStyle;
  readonly bom: boolean;
  readonly added_lines: number;
  readonly removed_lines: number;
}

function preparedFrom(
  applied: AppliedTextChange,
  path: string,
  identity: WinfsFileIdentity | null,
  oldBytes: Buffer | null,
): PreparedFile {
  return {
    path,
    op: applied.op,
    base_volume_id: identity?.volume_id ?? null,
    base_file_id: identity?.file_id ?? null,
    base_sha256: applied.before_sha256,
    target_sha256: applied.after_sha256,
    old_bytes: oldBytes,
    new_bytes: Buffer.from(applied.bytes),
    encoding: applied.encoding,
    newline: applied.newline,
    bom: applied.bom,
    added_lines: applied.added_lines,
    removed_lines: applied.removed_lines,
  };
}

async function prepareOne(
  item: ValidatedChangeItem,
  args: PrepareChangeArgs,
  deps: PrepareChangeDeps,
  limits: PrepareLimits,
): Promise<PreparedFile> {
  if (item.op === 'create_text') {
    await requireCreatable(deps.ops, args.scope, item.path);
    const applied = createTextFile({ item, max_editable_file_bytes: limits.max_editable_file_bytes });
    return preparedFrom(applied, item.path, null, null);
  }

  if (item.op === 'delete_file') {
    // Deletion is not text editing: allow binary/read-only content up to the
    // guarded snapshot read limit and retain the complete bytes for recovery.
    const read = await readBaseline(deps.ops, args.scope, item.path, LIMITS.MAX_READABLE_FILE_BYTES, 'delete');
    if (read.identity.link_count > 1) {
      throw new BridgeError(
        'LINK_UNSUPPORTED',
        `该文件有 ${read.identity.link_count} 个硬链接；删除会同时影响授权根外的名称，拒绝删除。`,
        { reason: 'DELETE_HARDLINKED_FILE', path: item.path, link_count: read.identity.link_count },
      );
    }

    // The empty snapshot is a diff tombstone. The delete op itself, not this
    // placeholder content, tells the executor that the expected final state is
    // an absent directory entry. The original bytes are retained for recovery.
    const empty = Buffer.alloc(0);
    const inspection = inspectBytes(read.bytes);
    return {
      path: read.canonical_path,
      op: 'delete_file',
      base_volume_id: read.identity.volume_id,
      base_file_id: read.identity.file_id,
      base_sha256: read.sha256,
      target_sha256: sha256Hex(empty),
      old_bytes: read.bytes,
      new_bytes: empty,
      encoding: inspection.kind === 'text' ? inspection.encoding : 'unknown',
      newline: inspection.kind === 'text' ? inspection.newline : 'none',
      bom: inspection.kind === 'text' ? inspection.bom : false,
      added_lines: 0,
      removed_lines: inspection.kind === 'text' ? inspection.lines.total_lines : 0,
    };
  }

  const read = await readBaseline(deps.ops, args.scope, item.path, limits.max_editable_file_bytes);
  verifyTicketAgainstDisk(item.ticket, read, item.path);
  requireStillEditable(read, limits.max_editable_file_bytes, item.path);

  const baseline = inspectBytes(read.bytes);
  if (baseline.kind !== 'text') {
    // 不可达：`requireStillEditable` 刚刚在同一份字节上判过。留着是为了不在
    // 这里写一个 `as` 断言 —— 一个将来被挪走调用顺序的改动，应当在这里
    // 得到一次明确的拒绝，而不是一次类型断言下的未定义行为。
    throw new BridgeError('ENCODING_UNSUPPORTED', `字节在两次识别之间改变了结果（${baseline.reason}）。`, {
      reason: 'DECODE_UNSTABLE',
      path: item.path,
    });
  }

  const applied =
    item.op === 'edit_text'
      ? applyLineEdits({
          item,
          original: read.bytes,
          baseline,
          max_editable_file_bytes: limits.max_editable_file_bytes,
        })
      : replaceWholeText({
          item,
          original: read.bytes,
          baseline,
          max_editable_file_bytes: limits.max_editable_file_bytes,
        });

  return preparedFrom(applied, read.canonical_path, read.identity, read.bytes);
}

/**
 * 用**当场探到的身份**再判一次「同一份文件不得出现两次」。
 *
 * LWB-019 已经用票据里的身份判过一次，但票据是上一次读取签的；两个不同的
 * 路径拼写此刻是否仍指向同一个对象，只有当场探测才知道。这里用重读拿到的
 * `volume_id` / `file_id` 重建目标清单，交给**同一个** `assertDistinctTargets`
 * 再判一次 —— 它在 LWB-019 就是为这一步导出并留下说明的。
 *
 * 路径取**磁盘规范拼写**而不是提案里的写法：大小写不敏感那一条判据，
 * 只有在两边都取磁盘拼写时才真正成立（提案里的 `Readme.md` 与磁盘上的
 * `README.md` 是同一个文件，而按提案拼写比会看成两个）。
 */
function assertStillDistinct(prepared: readonly PreparedFile[]): void {
  const targets: ChangeTarget[] = prepared.map((file) =>
    Object.freeze({
      path: file.path,
      op: file.op,
      volume_id: file.base_volume_id,
      file_id: file.base_file_id,
    }),
  );
  assertDistinctTargets(targets);
}

// ---------------------------------------------------------------------------
// 风险
// ---------------------------------------------------------------------------

/** 大幅删减的判据：删得多，而且是**净删**。 */
const LARGE_DELETION_RATIO = 0.5;
const LARGE_DELETION_MIN_LINES = 20;

const SCRIPT_EXTENSIONS = new Set([
  'ps1',
  'psm1',
  'bat',
  'cmd',
  'sh',
  'bash',
  'zsh',
  'fish',
  'vbs',
  'js',
  'mjs',
  'cjs',
  'py',
  'rb',
  'pl',
  'jar',
  'exe',
  'dll',
  'com',
  'scr',
]);

/** 凭据类文件名的**形状**。刻意不是 `.env`。 */
const CREDENTIAL_FILENAME_RE = /^(\.env\..+|.*\.env|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.?(credentials|secrets?|passwords?|tokens?)(\..+)?|.*\.(pem|key|p12|pfx|jks|keystore|asc|gpg))$/i;

/**
 * 风险提示是**对落库事实的解释**，不是新的事实。
 *
 * 因此它不落库，而是每次从 `change_items` 的既有列推导。两个好处：
 *
 *  1. 看到的风险永远与它解释的事实一致 —— 存下来的文案会漂移；
 *  2. 追加一条判据不需要迁移。
 *
 * 代价是如实的：判据本身变了（比如把「净删 50%」调成 40%），同一份**尚未
 * 执行**的修改集在界面上显示的风险会变。这不影响已批准的内容：批准绑定的是
 * **摘要**，而摘要覆盖的是效果字段，不含风险。将来若需要「批准时看到的风险
 * 清单」作为证据，正确的做法是把当时的清单写进审计，而不是塞进摘要。
 *
 * ## 判据必须**够得着**
 *
 * 这里刻意没有 `路径就是 .env` 这一条：`.env` / `.env.*` / `*.env` 由策略层
 * 硬拒绝（`HD-ENV`），一个 `.env` 连读取票据都拿不到，因此永远到不了修改集。
 * 一条永远不触发的规则比没有这条规则更糟 —— 它会让读者以为这一类路径
 * 「只是被提示」，而实际上它们是被挡住的。
 * 剩下的凭据形状（`id_rsa`、`*.pem`、`credentials*` 等）**确实**可以是
 * 工作区里的普通文件，也**确实**可以被读取与修改，所以它们才需要被提示。
 *
 * ## 这一层刻意**不**读内容
 *
 * 所有判据都只用路径与落库的统计量。内容层面的特征（双向控制字符、
 * 不可见字符）由**渲染方**负责 —— LWB-023 的验收标准明确要求界面对
 * 「Unicode 方向控制等可疑字符」给出可视化提示，而那时内容已经在屏幕上，
 * 不需要再读一遍快照；出站路径上的秘密扫描则属于 `@lwb/egress`。
 * 在这里读一遍新快照，只会让 `change_get` 的代价随修改集大小增长。
 */
export function deriveRisks(items: readonly ChangeItemRecord[]): readonly ChangeRisk[] {
  const risks: ChangeRisk[] = [];

  if (items.length > 1) {
    risks.push({
      level: items.length >= 10 ? 'warning' : 'notice',
      code: 'MULTIPLE_FILES',
      message: `本次修改涉及 ${items.length} 个文件；批准前请逐个核对。`,
    });
  }

  for (const item of items) {
    const where = item.canonical_path;
    const filename = where.slice(where.lastIndexOf('/') + 1);

    if (item.op === 'create_text') {
      risks.push({
        level: 'notice',
        code: 'NEW_FILE_CREATED',
        message: `新建文件：${where}`,
      });
    }
    if (item.op === 'replace_text') {
      risks.push({
        level: 'warning',
        code: 'WHOLE_FILE_REPLACED',
        message: `整文件替换（不是逐行补丁）：${where}`,
      });
    }

    const removed = item.removed_lines;
    const added = item.added_lines;
    if (removed >= LARGE_DELETION_MIN_LINES && added < removed * (1 - LARGE_DELETION_RATIO)) {
      risks.push({
        level: 'warning',
        code: 'LARGE_DELETION',
        message: `${where} 删除 ${removed} 行、新增 ${added} 行 —— 净减少 ${removed - added} 行。`,
      });
    }

    const dot = filename.lastIndexOf('.');
    if (dot > 0 && SCRIPT_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase())) {
      risks.push({
        level: 'warning',
        code: 'EXECUTABLE_OR_SCRIPT',
        message: `可执行或脚本文件：${where}`,
      });
    }

    if (CREDENTIAL_FILENAME_RE.test(filename)) {
      risks.push({
        level: 'warning',
        code: 'CREDENTIAL_SHAPED_PATH',
        message: `文件名形如凭据或密钥：${where}`,
      });
    }
  }

  return Object.freeze(risks);
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/**
 * 从**落库的事实**重建一份预览。
 *
 * 这是「批准绑定摘要」能被兑现的关键：`change_get`、控制台、执行前的复核
 * 都走这个函数，因此三方看到的路径、哈希、尺寸、增量行数来自同一处 ——
 * 而摘要由同一批字段算出，于是「屏幕上看到的」与「批准绑定的」由构造
 * 保证是同一个东西。
 *
 * 这也解释了迁移 v4 为什么要给 `change_items` 加两列：增量行数是这两份字节
 * 之间的**关系**，不落库就只能现算，而现算得到的数字与建立时的数字
 * 不一定相同（引擎按操作语义计数，通用行差分不是）。
 */
export function filePreviewsOf(items: readonly ChangeItemRecord[], sizeOfBlob: (blobId: string) => number): readonly ChangeFilePreview[] {
  return items.map((item) =>
    Object.freeze({
      path: item.canonical_path,
      op: item.op,
      before_sha256: item.base_sha256,
      after_sha256: item.target_sha256,
      before_size: item.old_blob_id === null ? 0 : sizeOfBlob(item.old_blob_id),
      after_size: sizeOfBlob(item.new_blob_id),
      encoding: item.encoding,
      newline: item.newline,
      bom: item.bom,
      added_lines: item.added_lines,
      removed_lines: item.removed_lines,
    }),
  );
}

/**
 * 面向模型与用户的下一步提示。目录级文件修改 grant 已包含持续写入授权。
 */
export const NEXT_ACTION_PENDING_APPROVAL =
  '修改集已建立，**尚未写入任何文件**。若该工作区已授予文件修改权限，请调用 change_apply 执行；' +
  '若未授权，需由本地操作者在工作区设置中授予。只有执行回执为 APPLIED 才能说已保存。';

export function changeSetViewOf(
  change: ChangeSetRecord,
  items: readonly ChangeItemRecord[],
  sizeOfBlob: (blobId: string) => number,
): ChangeSetView {
  return Object.freeze({
    change_id: change.id,
    workspace_id: change.workspace_id,
    state: change.state,
    // PENDING_APPROVAL 是持久化状态机的待执行起点；它不代表还需逐次人工批准。
    approval_required: false,
    digest: change.digest,
    short_code: shortCodeOf(change.digest),
    summary: change.summary,
    files: filePreviewsOf(items, sizeOfBlob),
    risks: deriveRisks(items),
    created_at: change.created_at,
    expires_at: change.expires_at,
    // 类型上是字面量 false，因此这个字段不可能被写成 true —— 它不是
    // 「本模块打算不写文件」，而是「这条返回值没有别的可能」。
    workspace_modified: false,
    next_action: NEXT_ACTION_PENDING_APPROVAL,
  });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 提案 → 请求指纹的输入。令牌被刻意排除，理由见 `digest.ts`。 */
function fingerprintItems(items: readonly ChangeItem[]): readonly RequestItem[] {
  return items.map((item): RequestItem => {
    if (item.op === 'create_text') {
      return { op: 'create_text', path: item.path, content: item.content, newline: item.newline, bom: item.bom };
    }
    if (item.op === 'replace_text') {
      return { op: 'replace_text', path: item.path, base_sha256: item.base_sha256, content: item.content };
    }
    if (item.op === 'delete_file') {
      return { op: 'delete_file', path: item.path };
    }
    return {
      op: 'edit_text',
      path: item.path,
      base_sha256: item.base_sha256,
      edits: item.edits.map((edit) => ({
        start_line: edit.start_line,
        end_line_exclusive: edit.end_line_exclusive,
        old_lines: edit.old_lines,
        new_lines: edit.new_lines,
      })),
    };
  });
}

/**
 * 建立一个不可变修改集。
 *
 * 返回**永远**是 `PENDING_APPROVAL`、`workspace_modified: false`。
 * 本函数没有写工作区的代码路径，因此「prepare 不改文件」是结构性的。
 */
export async function prepareChange(
  args: PrepareChangeArgs,
  deps: PrepareChangeDeps,
): Promise<ChangePrepareData> {
  const limits = limitsOf(deps);
  const newId = deps.newId ?? randomUUID;
  const { input } = args;

  // 提案校验在**认领幂等键之前**。顺序反过来会有一个难看的结果：
  // 一次参数写错的调用把键占住（`result_ref` 为空），调用方改对参数后
  // 用同一个键重试，得到的是 IDEMPOTENCY_CONFLICT 而不是结果 ——
  // 一次语法错误被升级成一次需要换键的冲突。校验是纯函数，不碰磁盘，
  // 放在前面没有任何代价。
  const plan: ChangePlan = validateChangeItems(input.items, {
    connection_id: args.connection_id,
    workspace_id: args.workspace_id,
    generation: args.generation,
    now: args.now,
    authority: deps.authority,
    max_editable_file_bytes: limits.max_editable_file_bytes,
  });

  if (input.items.length > limits.max_change_files) {
    // `validateChangeItems` 已经按 `LIMITS.MAX_CHANGE_FILES` 判过；这里用
    // **可调**的那个值再判一次。上限被调小之后，昨天的数字不该继续管用。
    throw new BridgeError(
      'INVALID_ARGUMENT',
      `一个修改集最多包含 ${limits.max_change_files} 个文件，本次 ${input.items.length} 个。`,
      { reason: 'TOO_MANY_CHANGE_FILES', limit: limits.max_change_files, actual: input.items.length },
    );
  }

  const fingerprint = changeRequestFingerprint({
    tool: CHANGE_PREPARE_TOOL,
    workspace_id: args.workspace_id,
    connection_id: args.connection_id,
    summary: input.summary,
    items: fingerprintItems(input.items),
  });

  // 同键串行。实现在 `single-flight.ts` —— 与执行器（LWB-026）共用**同一张**
  // 锁表，因此「同一个键只跑一次」这条性质在整台 daemon 上只有一个实现。
  return withIdempotencyLock(
    { principal_id: args.principal_id, tool: CHANGE_PREPARE_TOOL, key: input.idempotency_key },
    async () => {
    const outcome = deps.repos.idempotency.begin({
      id: newId(),
      principal_id: args.principal_id,
      tool: CHANGE_PREPARE_TOOL,
      key: input.idempotency_key,
      request_hash: fingerprint,
    });

    if (outcome.kind === 'conflict') {
      throw new BridgeError(
        'IDEMPOTENCY_CONFLICT',
        '这个幂等键已经用于另一次内容不同的请求；请换一个键重新提交，本次没有建立任何修改集。',
        { reason: 'IDEMPOTENCY_KEY_REUSED', tool: CHANGE_PREPARE_TOOL },
      );
    }

    if (outcome.kind === 'replay' && outcome.record.result_ref !== null) {
      // 重放**不重算**：重算会把「同一请求得到同一修改集」变成「同一请求
      // 得到同一份内容」，而后者在两次调用之间磁盘发生变化时就会给出
      // 不同的字节 —— 那正是幂等要避免的事。这里读回落库的那一份。
      const existing = deps.repos.changes.requireById(outcome.record.result_ref);
      return Object.freeze({
        ...changeSetViewOf(existing, deps.repos.changes.items(existing.id), sizeLookup(deps)),
        idempotent_replay: true,
      });
    }

    // 走到这里有两种来源，含义不同但后续动作相同：
    //  - `new`：这个键是新的，本次是第一次尝试；
    //  - `replay` 且 `result_ref` 为空：上一次同键调用**没有建立任何修改集**
    //    （建立修改集与标记完成在同一个事务里，见下），因此可以安全重来。
    //    指纹已经比对过，所以「重来」用的确实是同一份请求内容。
    const prepared = await prepareAll(plan.items, args, deps, limits);

    const totalBytes = prepared.reduce((sum, file) => sum + file.new_bytes.length, 0);
    if (totalBytes > limits.max_change_total_bytes) {
      throw new BridgeError(
        'SIZE_LIMIT_EXCEEDED',
        `本次修改的最终文件共 ${totalBytes} 字节，超过单个修改集上限 ${limits.max_change_total_bytes} 字节。`,
        { reason: 'CHANGE_TOTAL_TOO_LARGE', total_bytes: totalBytes, limit: limits.max_change_total_bytes },
      );
    }

    assertStillDistinct(prepared);

    const digest = canonicalChangeDigest({
      contract_version: CONTRACT_VERSION,
      policy_version: args.policy_version,
      root_generation: args.generation,
      workspace_id: args.workspace_id,
      files: prepared.map((file) => ({
        path: file.path,
        op: file.op,
        before_sha256: file.base_sha256,
        before_size: file.old_bytes?.length ?? 0,
        after_sha256: file.target_sha256,
        after_size: file.new_bytes.length,
        encoding: file.encoding,
        newline: file.newline,
        bom: file.bom,
      })),
    });

    // 旧字节与新字节都进快照库。**先落盘、后登记**（`putAndRegister` 内部
    // 就是这个次序）：反过来的话，一次崩溃会留下「数据库里有记录、
    // 磁盘上没有字节」的悬空引用，而执行时的回读会以 STORAGE_UNAVAILABLE 失败。
    //
    // 两处 `expectedSha256` 都是白拿的一致性检查：新字节的哈希由引擎从
    // 实际字节算出，旧字节的哈希由护栏从实际字节算出。传进去，就多一道
    // 「算出来的哈希与落盘的内容对得上」的确认。
    const snapshotInputs: { readonly bytes: Buffer; readonly expectedSha256?: string }[] = [];
    for (const file of prepared) {
      if (file.old_bytes !== null) {
        snapshotInputs.push({ bytes: file.old_bytes, expectedSha256: file.base_sha256 ?? undefined });
      }
      snapshotInputs.push({ bytes: file.new_bytes, expectedSha256: file.target_sha256 });
    }

    let snapshotRefs: Awaited<ReturnType<BlobStore['putAndRegisterBatch']>>;
    try {
      // The store reserves quota for the complete batch before persisting the
      // first snapshot, so an over-limit proposal leaves no partial snapshot refs.
      snapshotRefs = await deps.blobs.putAndRegisterBatch(snapshotInputs);
    } catch (cause) {
      if (cause instanceof BlobQuotaExceededError) {
        throw new BridgeError(
          'STORAGE_UNAVAILABLE',
          '本机快照存储已达到配置上限；提案未建立，工作区文件未写入。',
          {
            reason: 'SNAPSHOT_QUOTA_EXCEEDED',
            used_bytes: cause.used_bytes,
            limit_bytes: cause.limit_bytes,
            incoming_bytes: cause.incoming_bytes,
          },
        );
      }
      throw cause;
    }

    const files: PreparedFileWithBlobs[] = [];
    let snapshotIndex = 0;
    for (const file of prepared) {
      let oldBlobId: string | null = null;
      if (file.old_bytes !== null) {
        const oldBlob = snapshotRefs[snapshotIndex++];
        if (oldBlob === undefined) throw new BridgeError('INTERNAL_ERROR', '快照批次缺少旧版本对象。');
        oldBlobId = oldBlob.id;
      }
      const newBlob = snapshotRefs[snapshotIndex++];
      if (newBlob === undefined) throw new BridgeError('INTERNAL_ERROR', '快照批次返回的对象数量不一致。');
      files.push({ ...file, old_blob_id: oldBlobId, new_blob_id: newBlob.id });
    }

    const changeId = `chg_${newId()}`;
    const expiresAt = new Date(args.now + limits.change_ttl_ms).toISOString();

    // 建立修改集与标记幂等完成**同一个事务**。分成两步会留下一个窗口：
    // 修改集已写入、幂等记录仍为空 —— 此时崩溃，重试会再建一个修改集
    // （同键两个修改集），不重试则该键永远查不到结果。
    const created = deps.repos.transaction(() => {
      const record = deps.repos.changes.create({
        id: changeId,
        owner_connection_id: args.connection_id,
        workspace_id: args.workspace_id,
        root_generation: args.generation,
        policy_version: args.policy_version,
        contract_version: CONTRACT_VERSION,
        digest,
        summary: input.summary,
        expires_at: expiresAt,
        items: files.map((file) => ({
          id: `ci_${newId()}`,
          path: file.path,
          op: file.op,
          base_file_id: file.base_file_id,
          base_sha256: file.base_sha256,
          target_sha256: file.target_sha256,
          old_blob_id: file.old_blob_id,
          new_blob_id: file.new_blob_id,
          encoding: file.encoding,
          bom: file.bom,
          newline: file.newline,
          added_lines: file.added_lines,
          removed_lines: file.removed_lines,
        })),
      });
      deps.repos.idempotency.complete(args.principal_id, CHANGE_PREPARE_TOOL, input.idempotency_key, record.id);
      return record;
    });

      return Object.freeze({
        ...changeSetViewOf(created, deps.repos.changes.items(created.id), sizeLookup(deps)),
        idempotent_replay: outcome.kind === 'replay',
      });
    },
  );
}

interface PreparedFileWithBlobs extends PreparedFile {
  readonly old_blob_id: string | null;
  readonly new_blob_id: string;
}

function sizeLookup(deps: PrepareChangeDeps): (blobId: string) => number {
  return (blobId: string) => deps.repos.blobs.requireById(blobId).size;
}

/**
 * 逐项建立最终字节。
 *
 * 顺序按 `seq`，且**不并行**：一次修改集里的目标可能相邻（同一个目录、
 * 甚至同一个文件的不同拼写），并发读只会让护栏助手的队列变长而没有收益 ——
 * 真正的并发控制属于 `@lwb/limits`，那里的额度是给「多条调用」用的。
 */
async function prepareAll(
  items: readonly ValidatedChangeItem[],
  args: PrepareChangeArgs,
  deps: PrepareChangeDeps,
  limits: PrepareLimits,
): Promise<readonly PreparedFile[]> {
  const prepared: PreparedFile[] = [];
  for (const item of items) {
    prepared.push(await prepareOne(item, args, deps, limits));
  }
  return Object.freeze(prepared);
}
