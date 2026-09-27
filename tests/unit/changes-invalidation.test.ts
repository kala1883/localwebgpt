/**
 * LWB-024 单元测试：代次、过期与审批撤销。
 *
 * ## 三条验收标准各自需要什么样的装置
 *
 *  - 「离线前批准、重连后过期**不会自动落盘**」是一条否定式的断言，它的
 *    主语是「不会」。因此 B 组不测「函数返回 false」，而是测**每一次拒绝
 *    都指得出是哪一条绑定不成立**，以及同时成立的几条一条不少。
 *  - 「权限缩小时**不能应用**老计划」的落点在两处：纯函数（B 组）与
 *    **真实的批准门禁**（C11/C12）。只在纯函数上证明，等于证明了
 *    「我写了一个正确的函数」，而不是「那条路径被堵住了」。
 *  - 「清理不会删除运行中、待恢复或仍在撤销窗口的快照」是本文件里唯一
 *    需要**真实字节**的一条。F 组因此不读任何返回值就下结论：它把字节写到
 *    磁盘上，跑**真的** `BlobStore.collectGarbage`，然后看文件还在不在。
 *    一个只断言 `plan.protected_blobs` 的测试会跟着实现一起错。
 *
 * ## 每个 describe 一个全新的库
 *
 * 过期清理与保留计划的作用域是**整张表**（`listByStates` 没有分页，是刻意
 * 的 —— 见 `PENDING_CHANGE_STATES` 的说明）。共用一个库会让「到期的那几条
 * 被清掉了」这种断言被前面几组留下的夹具污染，而修法若是把断言改成
 * 「包含我的那些」，就再也测不到「不该被清的一条都没被清」。
 * 因此每组自带 `before(resetDb)`；D 组更进一步用 `beforeEach` —— 它的断言是
 * 「**只有那一条**被清掉」，共用库时前一条用例的夹具会先到期并占据 `[0]`。
 *
 * ## 为什么用的是真库、真时钟、真字节
 *
 * `Repositories` 的时钟被换成一个**可变**的函数：保留窗口判定的对象就是
 * **时刻**，用 `new Date()` 意味着窗口边界永远测不到（随便取一个正中间的时刻，
 * 边界上 `<` 与 `<=` 的差别分不出来）。这与 LWB-020/021 用真库而不是桩
 * 是同一条理由 —— 桩会用自己的保证替换掉被测的保证。
 *
 * ## 一处刻意构造的、生产上不会自然出现的状态
 *
 * E 组在修改集**已经引用**快照之后调用 `releaseRef`，把引用计数打到 0。
 * 生产代码今天没有这条路径。这么做是因为回收策略要回答的问题不是
 * 「引用计数是多少」，而是「**谁**还可能需要这些字节」—— 两者在
 * `refcount = 0` 而修改集仍在撤销窗口内时**分开**，而那一分开就是
 * 验收标准 3 的全部内容。不构造它，这条标准就只能靠读代码相信。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { BlobStore, objectPath } from '@lwb/blob-store';
import {
  APPROVAL_STATES,
  CONTRACT_VERSION,
  LIMITS,
  TERMINAL_CHANGE_STATES,
  isTerminalChangeState,
} from '@lwb/contracts';
import type { ChangeSetState } from '@lwb/contracts';
import { APPLY_ENTRY_STATES, evaluateApplyGate } from '@lwb/approvals';
import { canonicalChangeDigest } from '@lwb/changes';
import {
  CHANGE_TRANSITIONS,
  EXECUTION_BINDING_REASONS,
  EXECUTION_CHANGE_STATES,
  EXPIRABLE_STATES,
  INVALIDATABLE_STATES,
  JOURNAL_STAGE_INVALIDATED,
  NON_TERMINAL_STATES,
  PENDING_CHANGE_STATES,
  SNAPSHOT_PROTECTION_REASONS,
  executionBindingErrorCode,
  executionBindingMessage,
  invalidateChangeSet,
  invalidateMany,
  invalidatePendingForConnection,
  invalidatePendingForWorkspace,
  planSnapshotRetention,
  reclaimedChangeMetadata,
  revalidateExecutionBindings,
  revokeLocalApproval,
  snapshotGuard,
  sweepExpired,
} from '@lwb/changes';
import type { ExecutionBindingReason, ExecutionBindingVerdict } from '@lwb/changes';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { ChangeItemInput, OpenDatabaseResult } from '@lwb/persistence';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

const CONNECTION = 'conn_inv';
const OTHER_CONNECTION = 'conn_inv_other';
const WORKSPACE = 'ws_inv';
const OTHER_WORKSPACE = 'ws_inv_other';
/** 专供「被移除」「被停用」两条用例使用，免得它们污染健康的那一份。 */
const WS_REMOVED = 'ws_inv_removed';
const WS_DISABLED = 'ws_inv_disabled';
/**
 * 专供「只读模式」用例。
 *
 * **建立时**就是只读，而不是建完再 `setMode` —— `setMode` 会连带递增代次
 * （那是刻意的），于是那条用例会同时命中两条理由，「单独成立」就断言不了。
 * 而要断言「这一条能被单独触发」，正是 B2 存在的理由。
 */
const WS_READ_ONLY = 'ws_inv_readonly';
const PRINCIPAL = 'principal_inv';
const POLICY_VERSION = 3;
const GENERATION = 5;
const MODE = 'read_propose_apply_with_local_approval';
const ACTOR = 'console:test-session';

const T0 = '2026-09-25T10:00:00.000Z';
const T0_MS = Date.parse(T0);
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION = LIMITS.SNAPSHOT_RETENTION_MS;

/** 可变时钟。窗口边界要精确到毫秒，而 `new Date()` 给不了。 */
let clockNow = T0;
const clock = (): string => clockNow;

let opened: OpenDatabaseResult;
let repos: Repositories;
let seq = 0;

const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;

/** 造一个 sha256 形状的十六进制串。**不是**真哈希：除 F 组外不读文件内容。 */
const fakeSha = (seed: string): string =>
  seed
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, 'a');

/**
 * 换一个**全新的内存库**，并把连接与工作区铺好。
 *
 * 每个 describe 各调一次。关掉上一个不是省内存，是让「这张表里现在有什么」
 * 这个问题在每组内有唯一答案。
 */
function resetDb(): void {
  if (opened !== undefined) closeDatabase(opened.db);
  clockNow = T0;
  opened = openDatabase({ path: ':memory:' });
  repos = new Repositories(opened.db, clock);

  for (const id of [CONNECTION, OTHER_CONNECTION]) {
    repos.connections.create({
      id,
      principal_kind: 'model_surface',
      principal_id: PRINCIPAL,
      alias: `测试连接 ${id}`,
      enabled: true,
    });
  }
  for (const id of [WORKSPACE, OTHER_WORKSPACE, WS_REMOVED, WS_DISABLED, WS_READ_ONLY]) {
    repos.workspaces.create({
      id,
      alias: `夹具 ${id}`,
      kind: 'directory',
      canonical_root: `C:\\lwb-024\\${id}`,
      volume_id: `vol-${id}`,
      root_file_id: `root-${id}`,
      policy_version: POLICY_VERSION,
      mode: id === WS_READ_ONLY ? 'read_only' : MODE,
    });
    // 建出来是第 1 代，而夹具声明的代次不是 1。把它推到第 5 代，而不是把
    // 夹具改成 1：两边都是 1 的时候，「代次比对」这条断言在做错事时也会通过。
    while (repos.workspaces.requireById(id).generation < GENERATION) {
      repos.workspaces.bumpGeneration(id, POLICY_VERSION);
    }
  }
}

/** 建一个处于某状态的修改集要走的那条边。每一步都必须是转移表允许的。 */
const PATH_TO: Readonly<Record<string, readonly ChangeSetState[]>> = {
  REJECTED: ['REJECTED'],
  EXPIRED: ['EXPIRED'],
  INVALIDATED: ['INVALIDATED'],
  APPROVED: ['APPROVED'],
  QUEUED: ['APPROVED', 'QUEUED'],
  VALIDATING: ['APPROVED', 'QUEUED', 'VALIDATING'],
  APPLYING: ['APPROVED', 'QUEUED', 'VALIDATING', 'APPLYING'],
  RECOVERY_REQUIRED: ['APPROVED', 'QUEUED', 'RECOVERY_REQUIRED'],
  CONFLICT: ['APPROVED', 'QUEUED', 'CONFLICT'],
  FAILED_NO_CHANGE: ['APPROVED', 'QUEUED', 'FAILED_NO_CHANGE'],
  APPLIED: ['APPROVED', 'QUEUED', 'VALIDATING', 'APPLYING', 'APPLIED'],
  ROLLED_BACK: ['APPROVED', 'QUEUED', 'VALIDATING', 'APPLYING', 'ROLLED_BACK'],
};

/**
 * 把修改集（连同它的操作）推到目标状态。
 *
 * 操作与修改集在真库里是两行，而在生产路径上它们**一起**走。这里让它们
 * 同步前进，是因为本文件要测的是它们在**分开**时的行为 —— 而「分开」
 * 只有在「一起」这件事已经成立的地方才说明得了问题。
 */
function drive(changeId: string, target: ChangeSetState): void {
  const steps = PATH_TO[target];
  assert.ok(steps !== undefined, `PATH_TO 缺少 ${target} 的路径`);
  let previous: ChangeSetState = 'PENDING_APPROVAL';
  let operationId: string | null = null;

  for (const step of steps) {
    if (step === 'QUEUED') {
      // 操作建出来就是 QUEUED，不需要流转。
      operationId = repos.operations.create({ id: nextId('op'), change_id: changeId }).operation.id;
    } else if (operationId !== null) {
      repos.operations.transition(operationId, [previous], step);
    }
    repos.changes.transition(changeId, [previous], step);
    previous = step;
  }
}

interface ChangeFixture {
  readonly change_id: string;
  readonly digest: string;
  readonly before_blob: string;
  readonly after_blob: string;
  readonly item_id: string;
}

interface ChangeOptions {
  readonly workspace_id?: string;
  readonly connection_id?: string;
  readonly generation?: number;
  readonly policy_version?: number;
  readonly contract_version?: string;
  readonly expires_at?: string;
}

/**
 * 建一个 `PENDING_APPROVAL` 修改集，走**真实仓储**。
 *
 * 摘要用 `canonicalChangeDigest` 真正算一遍，与 `prepare.ts` 同一批字段、
 * 同一个函数：C11/C12 要经过 `evaluateApplyGate`，而它先从落库事实重算摘要
 * 并与存下来的值比对。用一个「像摘要的串」在别处够用，在这里会先撞上
 * `DIGEST_NOT_REPRODUCIBLE` —— 那是装置的锅，不是被测代码的。
 *
 * 那些**只**用来触发某一条绑定理由的覆盖项（代次、策略版本、契约版本、
 * 有效期），走的是「夹具直接声明一个不同的事实」，而不是去改工作区记录：
 * `setEnabled` / `markRemoved` 会**连带**递增代次，于是「只是被停用」
 * 这个输入在真库里根本造不出来。理由见 B3。
 */
function makeChange(seed: string, options: ChangeOptions = {}): ChangeFixture {
  const workspaceId = options.workspace_id ?? WORKSPACE;
  const connectionId = options.connection_id ?? CONNECTION;
  const generation = options.generation ?? GENERATION;
  const policyVersion = options.policy_version ?? POLICY_VERSION;
  const contractVersion = options.contract_version ?? CONTRACT_VERSION;

  const beforeBytes = `before-${seed}`;
  const afterBytes = `after-${seed}`;
  const beforeSha = fakeSha(`1${seed}`);
  const afterSha = fakeSha(`2${seed}`);
  const relPath = `src/${seed}.ts`;

  const before = repos.blobs.ensure({
    id: nextId('blob'),
    sha256: beforeSha,
    size: beforeBytes.length,
    storage_ref: `objects/${beforeSha}`,
  }).blob;
  const after = repos.blobs.ensure({
    id: nextId('blob'),
    sha256: afterSha,
    size: afterBytes.length,
    storage_ref: `objects/${afterSha}`,
  }).blob;

  const digest = canonicalChangeDigest({
    contract_version: contractVersion,
    policy_version: policyVersion,
    root_generation: generation,
    workspace_id: workspaceId,
    files: [
      {
        path: relPath,
        op: 'edit_text',
        before_sha256: beforeSha,
        before_size: beforeBytes.length,
        after_sha256: afterSha,
        after_size: afterBytes.length,
        encoding: 'utf-8',
        newline: 'lf',
        bom: false,
      },
    ],
  });

  const itemId = nextId('ci');
  const items: ChangeItemInput[] = [
    {
      id: itemId,
      path: relPath,
      op: 'edit_text',
      base_file_id: `file-${seed}`,
      base_sha256: beforeSha,
      target_sha256: afterSha,
      old_blob_id: before.id,
      new_blob_id: after.id,
      encoding: 'utf-8',
      bom: false,
      newline: 'lf',
      added_lines: 2,
      removed_lines: 1,
    },
  ];

  const change = repos.changes.create({
    id: nextId('chg'),
    owner_connection_id: connectionId,
    workspace_id: workspaceId,
    root_generation: generation,
    policy_version: policyVersion,
    contract_version: contractVersion,
    digest,
    summary: `夹具 ${seed}`,
    expires_at: options.expires_at ?? new Date(T0_MS + LIMITS.CHANGE_TTL_MS).toISOString(),
    items,
  });

  return { change_id: change.id, digest, before_blob: before.id, after_blob: after.id, item_id: itemId };
}

/** 给修改集签一份仍然有效的本地批准。 */
function approve(changeId: string): string {
  return repos.approvals.create({
    id: nextId('apr'),
    change_id: changeId,
    digest: repos.changes.requireById(changeId).digest,
    actor: ACTOR,
    expires_at: new Date(T0_MS + LIMITS.APPROVAL_TTL_MS).toISOString(),
  }).id;
}

function stateOf(changeId: string): ChangeSetState {
  return repos.changes.requireById(changeId).state;
}

function operationStateOf(changeId: string): string | null {
  return repos.operations.findByChangeId(changeId)?.state ?? null;
}

/** 一次门禁拒绝的具体理由。断言它**存在**：本任务的每次拒绝都要说清是哪一种。 */
function refusalReason(verdict: ReturnType<typeof evaluateApplyGate>): string {
  assert.equal(verdict.kind, 'refused', '本次判定应当被拒绝');
  if (verdict.kind !== 'refused') throw new Error('unreachable');
  return verdict.reason;
}

after(() => {
  closeDatabase(opened.db);
});

// ---------------------------------------------------------------------------
// A 组：三个集合由转移表推出
// ---------------------------------------------------------------------------

describe('LWB-024 A 组：可失效 / 可过期 / 未终结的集合由转移表推出', () => {
  before(resetDb);

  it('A1 三个集合都非空（空集合会让后面的断言全部空洞地成立）', () => {
    assert.ok(INVALIDATABLE_STATES.length > 0);
    assert.ok(EXPIRABLE_STATES.length > 0);
    assert.ok(PENDING_CHANGE_STATES.length > 0);
    assert.ok(NON_TERMINAL_STATES.length > 0);
  });

  it('A2 与转移表逐格重算的结果一致', () => {
    const all = Object.keys(CHANGE_TRANSITIONS) as ChangeSetState[];
    assert.deepEqual(
      [...INVALIDATABLE_STATES].sort(),
      all.filter((state) => CHANGE_TRANSITIONS[state].includes('INVALIDATED')).sort(),
    );
    assert.deepEqual(
      [...EXPIRABLE_STATES].sort(),
      all.filter((state) => CHANGE_TRANSITIONS[state].includes('EXPIRED')).sort(),
    );
    assert.deepEqual(
      [...NON_TERMINAL_STATES].sort(),
      all.filter((state) => CHANGE_TRANSITIONS[state].length > 0).sort(),
    );
  });

  it('A3 三个集合的成员是具名的、可核对的那几个', () => {
    assert.deepEqual([...INVALIDATABLE_STATES], ['PENDING_APPROVAL', 'APPROVED', 'QUEUED']);
    assert.deepEqual([...EXPIRABLE_STATES], ['PENDING_APPROVAL', 'APPROVED', 'QUEUED']);
    assert.deepEqual(
      [...NON_TERMINAL_STATES],
      ['PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'VALIDATING', 'APPLYING', 'RECOVERY_REQUIRED'],
    );
    assert.deepEqual([...PENDING_CHANGE_STATES], ['APPROVED', 'PENDING_APPROVAL', 'QUEUED']);
  });

  it('A4 可失效与未终结不是同一个集合，而分界点在「写入是否已经开始」', () => {
    // 三个执行状态**不**共享同一个答案，这正说明两个集合不能合并：
    //  - QUEUED：还在队列里，可以回头 → 可失效；
    //  - VALIDATING / APPLYING：已经开始动用户的文件了，回头只有
    //    APPLIED / ROLLED_BACK 两条路 → 不可失效。
    assert.ok(INVALIDATABLE_STATES.includes('QUEUED'), '排队中还没开始写，应当可失效');
    for (const state of ['VALIDATING', 'APPLYING'] as ChangeSetState[]) {
      assert.ok(!INVALIDATABLE_STATES.includes(state), `${state} 已经开写，不应可失效`);
    }
    // 但三个都**尚未终结**：清理不能凭它们「不可失效」就认为它们结束了。
    for (const state of EXECUTION_CHANGE_STATES) {
      assert.ok(NON_TERMINAL_STATES.includes(state), `${state} 应当算未终结`);
    }
    assert.ok(!INVALIDATABLE_STATES.includes('RECOVERY_REQUIRED'), '待恢复不是待执行');
    assert.ok(!INVALIDATABLE_STATES.includes('APPLIED'), '已应用不是待执行');
  });

  it('A5 终结的集合与契约里的清单一致，且与未终结互补', () => {
    const all = Object.keys(CHANGE_TRANSITIONS) as ChangeSetState[];
    const terminal = all.filter((state) => isTerminalChangeState(state));
    assert.deepEqual([...terminal].sort(), [...TERMINAL_CHANGE_STATES].sort());
    for (const state of all) {
      assert.notEqual(
        NON_TERMINAL_STATES.includes(state),
        terminal.includes(state),
        `${state} 恰好应当只落在「未终结」与「终结」中的一个`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// B 组：执行前重新验证
// ---------------------------------------------------------------------------

describe('LWB-024 B 组：执行前重新验证（不信任排队时校验）', () => {
  before(resetDb);

  /** 一个「一切正常」的输入，逐条被本组改动。 */
  function healthy(changeId: string) {
    const change = repos.changes.requireById(changeId);
    return {
      change,
      workspace: repos.workspaces.findById(change.workspace_id),
      connection: repos.connections.findById(change.owner_connection_id),
      now: T0,
      allowed_from: INVALIDATABLE_STATES,
    };
  }

  function verdictFor(changeId: string) {
    return revalidateExecutionBindings(healthy(changeId));
  }

  it('B1 一切正常时 ok，且 reasons 为空、code 与 message 为 null', () => {
    const verdict = verdictFor(makeChange('b1').change_id);
    assert.equal(verdict.ok, true);
    assert.deepEqual([...verdict.reasons], []);
    assert.equal(verdict.primary, null);
    assert.equal(verdict.code, null);
    assert.equal(verdict.message, null);
  });

  it('B2 十一条理由每一条都能单独被触发，触发时它是**唯一**成立的那条', () => {
    // 夹具的构造方式是「换掉那个事实本身」，不是去改工作区记录。
    // `setEnabled(false)` 与 `markRemoved` 都会**连带**递增代次（那是刻意的：
    // 停用期间签发的任何东西都该在重新启用时失效），因此这两条理由在真库里
    // 造不出「单独成立」的输入 —— 它们放在 B3，连同它们的连带一起断言。
    // 只读模式那条同理：`setMode` 也递增代次，所以它的夹具工作区
    // **建立时**就是只读的。
    // 每条用例返回**它自己算出来的那份判定**，而不是一个 changeId 让外层
    // 重新算一遍 —— 后者会把「workspace 传 null」这类只在这次调用里成立的
    // 输入丢掉，于是外层拿到的是一个健康的判定，而断言看不出区别。
    const isolated: readonly (readonly [string, () => ExecutionBindingVerdict])[] = [
      [
        'WORKSPACE_MISSING',
        () => {
          const changeId = makeChange('b2-missing').change_id;
          return revalidateExecutionBindings({ ...healthy(changeId), workspace: null });
        },
      ],
      [
        'OWNER_CONNECTION_MISSING',
        () => {
          const changeId = makeChange('b2-noconn').change_id;
          return revalidateExecutionBindings({ ...healthy(changeId), connection: null });
        },
      ],
      [
        'CONNECTION_DISABLED',
        () => {
          const changeId = makeChange('b2-conn-off').change_id;
          repos.connections.setEnabled(CONNECTION, false);
          try {
            return verdictFor(changeId);
          } finally {
            repos.connections.setEnabled(CONNECTION, true);
          }
        },
      ],
      [
        'WORKSPACE_MODE_READ_ONLY',
        () => verdictFor(makeChange('b2-readonly', { workspace_id: WS_READ_ONLY }).change_id),
      ],
      [
        'GENERATION_CHANGED',
        () => verdictFor(makeChange('b2-gen', { generation: GENERATION + 1 }).change_id),
      ],
      [
        'POLICY_VERSION_CHANGED',
        () => verdictFor(makeChange('b2-policy', { policy_version: POLICY_VERSION + 1 }).change_id),
      ],
      [
        'CONTRACT_VERSION_CHANGED',
        () => verdictFor(makeChange('b2-contract', { contract_version: 'lwb-contract-0' }).change_id),
      ],
      [
        'CHANGE_EXPIRED',
        () => verdictFor(makeChange('b2-expired', { expires_at: new Date(T0_MS - 1).toISOString() }).change_id),
      ],
      [
        'CHANGE_STATE_INVALID',
        () => {
          const changeId = makeChange('b2-state').change_id;
          drive(changeId, 'REJECTED');
          return verdictFor(changeId);
        },
      ],
    ];

    for (const [expected, run] of isolated) {
      const verdict = run();
      assert.deepEqual([...verdict.reasons], [expected], `${expected} 应当是**唯一**成立的那条`);
      assert.equal(verdict.primary, expected);
      assert.equal(verdict.ok, false);
      assert.equal(verdict.message, executionBindingMessage(expected as never));
      assert.equal(verdict.code, executionBindingErrorCode(expected as never));
    }

    // 上表九条，B3 覆盖剩下两条 —— 合起来必须是全部十一条，否则
    // 「每一条都能被触发」就成了「我挑了几条能触发的写了用例」。
    assert.equal(isolated.length + 2, EXECUTION_BINDING_REASONS.length);
  });

  it('B3 停用与移除的连带：它们会一起成立，而次序决定了报哪一句', () => {
    const disabledId = makeChange('b3-disabled', { workspace_id: WS_DISABLED }).change_id;
    repos.workspaces.setEnabled(WS_DISABLED, false);
    const disabled = verdictFor(disabledId);
    assert.deepEqual([...disabled.reasons], ['WORKSPACE_DISABLED', 'GENERATION_CHANGED']);
    // 报「已停用」比报「代次变了」更接近操作者刚做的那件事。
    assert.equal(disabled.primary, 'WORKSPACE_DISABLED');
    assert.equal(disabled.code, 'PAUSED');

    const removedId = makeChange('b3-removed', { workspace_id: WS_REMOVED }).change_id;
    repos.workspaces.markRemoved(WS_REMOVED);
    const removed = verdictFor(removedId);
    assert.deepEqual(
      [...removed.reasons],
      ['WORKSPACE_REMOVED', 'WORKSPACE_DISABLED', 'GENERATION_CHANGED'],
    );
    assert.equal(removed.primary, 'WORKSPACE_REMOVED');
    assert.equal(removed.code, 'WORKSPACE_NOT_GRANTED');
  });

  it('B4 同时成立的多条一次给全，排列是固定次序的子序列', () => {
    const changeId = makeChange('b4', {
      generation: GENERATION + 9,
      policy_version: POLICY_VERSION + 9,
      expires_at: new Date(T0_MS - 1000).toISOString(),
    }).change_id;
    repos.connections.setEnabled(CONNECTION, false);
    try {
      const verdict = verdictFor(changeId);
      assert.ok(verdict.reasons.length >= 4, `至少要触发四条，实际 ${verdict.reasons.length} 条`);
      assert.deepEqual(
        [...verdict.reasons],
        EXECUTION_BINDING_REASONS.filter((reason) => verdict.reasons.includes(reason)),
        'reasons 必须是固定次序的子序列',
      );
      assert.equal(verdict.primary, 'GENERATION_CHANGED');
      assert.equal(verdict.message, '工作区代次已变化，旧的票据、游标、修改集与批准均已失效。');
    } finally {
      repos.connections.setEnabled(CONNECTION, true);
    }
  });

  it('B5 排列与「发现顺序」无关：同一组事实的两次判定逐字段相同', () => {
    // 这两条理由在次序表里并**不相邻**（`GENERATION_CHANGED` 在第 4 位、
    // `CONTRACT_VERSION_CHANGED` 在第 6 位，中间隔着 `POLICY_VERSION_CHANGED`），
    // 所以「结果就是次序表的前 n 条」在这里必然落空 —— 该断的是
    // 「结果是次序表的**子序列**」，这个断言对任意组合都成立。
    const changeId = makeChange('b5', { generation: GENERATION + 1, contract_version: 'lwb-contract-0' }).change_id;
    const args = healthy(changeId);

    const first = revalidateExecutionBindings(args);
    const second = revalidateExecutionBindings(args);
    assert.deepEqual(first, second, '同一组事实的两次判定必须逐字段相同');
    assert.notEqual(first.reasons, second.reasons, '两次调用不能共享同一个 reasons 数组：调用方改到它就会改到下一次判定');

    assert.deepEqual([...first.reasons], ['GENERATION_CHANGED', 'CONTRACT_VERSION_CHANGED']);
    assert.deepEqual(
      [...first.reasons],
      EXECUTION_BINDING_REASONS.filter((reason) => first.reasons.includes(reason)),
      'reasons 必须是固定次序的子序列',
    );
  });

  it('B6 有效期边界是 `<=`：正好到期的时刻就已经过期', () => {
    const change = repos.changes.requireById(makeChange('b6').change_id);
    const verdict = revalidateExecutionBindings({ ...healthy(change.id), now: change.expires_at });
    assert.deepEqual([...verdict.reasons], ['CHANGE_EXPIRED'], '整点即到期，而不是整点之后');
  });

  it('B7 十一条理由的说明各不相同、点名了失效类别，且不含任何本机路径', () => {
    const messages = EXECUTION_BINDING_REASONS.map((reason) => executionBindingMessage(reason));
    assert.equal(new Set(messages).size, EXECUTION_BINDING_REASONS.length, '十一条说明必须两两不同');

    // 「哪一条」要能在说明里读出来 —— 但判据是**逐条点名**，不是一条排除式
    // 正则。排除式写法（「句子中间没有逗号句号」）只要说明里多一个分号
    // 就会误判，而它误判的方向是**放过**：一条什么也没说清的说明反而通过。
    // 下表是「这句话必须提到的事」，漏掉任何一件都是排障的人读不出来的信息。
    const mustMention: Readonly<Record<ExecutionBindingReason, readonly string[]>> = {
      // 两条「找不到」必须分得开：工作区没了，还是建立它的连接没了。
      WORKSPACE_MISSING: ['工作区', '不存在'],
      WORKSPACE_REMOVED: ['工作区', '移除'],
      WORKSPACE_DISABLED: ['工作区', '不可用'],
      WORKSPACE_MODE_READ_ONLY: ['工作区', '只读'],
      GENERATION_CHANGED: ['代次'],
      POLICY_VERSION_CHANGED: ['策略版本'],
      CONTRACT_VERSION_CHANGED: ['契约版本'],
      OWNER_CONNECTION_MISSING: ['连接', '不存在'],
      CONNECTION_DISABLED: ['连接', '禁用'],
      CHANGE_EXPIRED: ['有效期'],
      CHANGE_STATE_INVALID: ['状态'],
    };

    for (const reason of EXECUTION_BINDING_REASONS) {
      const message = executionBindingMessage(reason);
      assert.ok(message.length > 0);
      // 错误码映射必须是全函数，且给得出一个码。
      assert.match(executionBindingErrorCode(reason), /^[A-Z][A-Z_]+$/);
      for (const keyword of mustMention[reason]) {
        assert.ok(message.includes(keyword), `${reason} 的说明里没有出现「${keyword}」：${message}`);
      }
      for (const shape of ['\\', 'C:', '/home/', '/Users/', '/var/']) {
        assert.ok(!message.includes(shape), `${reason} 的说明里出现了路径形状 ${shape}：${message}`);
      }
    }

    // 上表的键必须与枚举一一对应：少一个键，对应的那条就没人检查了。
    assert.deepEqual(Object.keys(mustMention).sort(), [...EXECUTION_BINDING_REASONS].sort());

    // 与最上面那条 `default: never` 守卫呼应：枚举与说明表必须同步。
    assert.deepEqual(
      [...EXECUTION_BINDING_REASONS],
      ['WORKSPACE_MISSING', 'WORKSPACE_REMOVED', 'WORKSPACE_DISABLED', 'WORKSPACE_MODE_READ_ONLY', 'GENERATION_CHANGED', 'POLICY_VERSION_CHANGED', 'CONTRACT_VERSION_CHANGED', 'OWNER_CONNECTION_MISSING', 'CONNECTION_DISABLED', 'CHANGE_EXPIRED', 'CHANGE_STATE_INVALID'],
    );
  });
});

// ---------------------------------------------------------------------------
// C 组：失效写入，以及门禁真的会拦住老计划
// ---------------------------------------------------------------------------

describe('LWB-024 C 组：失效，以及门禁真的会拦住老计划', () => {
  before(resetDb);

  it('C1 没有任何批准的待批准修改集：只动它自己', () => {
    const fixture = makeChange('c1');
    const outcome = invalidateChangeSet(repos, { change_id: fixture.change_id, trigger: 'POLICY_CHANGED', now: T0 });
    assert.equal(outcome.from, 'PENDING_APPROVAL');
    assert.equal(outcome.to, 'INVALIDATED');
    assert.equal(outcome.approval_id, null);
    assert.equal(outcome.approval_to, null);
    assert.equal(outcome.operation_id, null);
    assert.equal(outcome.workspace_id, WORKSPACE);
    assert.equal(stateOf(fixture.change_id), 'INVALIDATED');
  });

  it('C2 已批准且批准仍有效：撤销它，并记下是 REVOKED', () => {
    const fixture = makeChange('c2');
    drive(fixture.change_id, 'APPROVED');
    const approvalId = approve(fixture.change_id);

    const outcome = invalidateChangeSet(repos, {
      change_id: fixture.change_id,
      trigger: 'WORKSPACE_RELOCATED',
      now: T0,
    });

    assert.equal(outcome.approval_id, approvalId);
    assert.equal(outcome.approval_to, 'REVOKED');
    assert.equal(repos.approvals.requireById(approvalId).state, 'REVOKED');
    assert.equal(stateOf(fixture.change_id), 'INVALIDATED');
  });

  it('C3 已批准但批准**自己到期了**：记 EXPIRED，不是 REVOKED', () => {
    // `CHANGE_TTL_MS`（24 小时）远长于 `APPROVAL_TTL_MS`（10 分钟），
    // 因此绝大多数过期修改集身上的批准其实早已到期。一律按 REVOKED 记，
    // 会让审计里几乎每一条都指向一次从未发生的撤销。
    const fixture = makeChange('c3');
    drive(fixture.change_id, 'APPROVED');
    const approvalId = approve(fixture.change_id);

    const later = new Date(T0_MS + LIMITS.APPROVAL_TTL_MS + 1).toISOString();
    const outcome = invalidateChangeSet(repos, { change_id: fixture.change_id, trigger: 'POLICY_CHANGED', now: later });

    assert.equal(outcome.approval_to, 'EXPIRED');
    assert.equal(repos.approvals.requireById(approvalId).state, 'EXPIRED');
    assert.ok(APPROVAL_STATES.includes('EXPIRED'), 'EXPIRED 必须是批准状态之一');
  });

  it('C4 已排队的修改集：操作被收束，且不留「在途操作」给下一次启动', () => {
    const fixture = makeChange('c4');
    drive(fixture.change_id, 'QUEUED');
    assert.equal(operationStateOf(fixture.change_id), 'QUEUED');

    const outcome = invalidateChangeSet(repos, {
      change_id: fixture.change_id,
      trigger: 'WORKSPACE_DISABLED',
      now: T0,
    });

    assert.equal(outcome.operation_to, 'FAILED_NO_CHANGE');
    assert.equal(operationStateOf(fixture.change_id), 'FAILED_NO_CHANGE');
    const operationId = outcome.operation_id;
    assert.ok(operationId !== null);
    assert.notEqual(repos.operations.requireById(operationId).finished_at, null);
    assert.ok(
      !repos.operations.listUnfinished().some((operation) => operation.change_id === fixture.change_id),
      '作废的操作不该再被报成「上一个进程遗留的在途操作」',
    );
    assert.deepEqual(
      repos.journal.list(operationId).map((entry) => entry.stage),
      [JOURNAL_STAGE_INVALIDATED],
    );
  });

  it('C5 终态与执行中的修改集都不能被失效，且**在任何写入之前**就拒绝', () => {
    const targets: readonly ChangeSetState[] = [
      ...TERMINAL_CHANGE_STATES,
      'VALIDATING',
      'APPLYING',
      'RECOVERY_REQUIRED',
    ];

    for (const state of targets) {
      const fixture = makeChange(`c5-${state}`);
      drive(fixture.change_id, state);
      // 身上挂一条 ACTIVE 批准：若拒绝发生在撤销之后，它就会变成 REVOKED，
      // 而「先撤销再发现不该动」正是本用例要排除的那个顺序。
      const approvalId = approve(fixture.change_id);
      const operationBefore = operationStateOf(fixture.change_id);

      assert.throws(
        () => invalidateChangeSet(repos, { change_id: fixture.change_id, trigger: 'POLICY_CHANGED', now: T0 }),
        /状态不允许失效/,
        `${state} 不该可失效`,
      );
      assert.equal(stateOf(fixture.change_id), state, `${state} 的状态不该被改动`);
      assert.equal(repos.approvals.requireById(approvalId).state, 'ACTIVE', `${state} 的批准不该被撤销`);
      assert.equal(operationStateOf(fixture.change_id), operationBefore, `${state} 的操作不该被收束`);

      // 这批状态里有一半**根本没有操作行** —— `REJECTED`/`EXPIRED`/`INVALIDATED`
      // 不是从 `QUEUED` 走过来的。所以「日志为空」要按有没有操作分别断言：
      // 直接 `requireByChangeId` 会在这些状态下抛「状态库记录缺失」，
      // 而那个抛看上去像被测代码崩了，实际是夹具问错了问题。
      const operation = repos.operations.findByChangeId(fixture.change_id);
      if (operationBefore === null) {
        assert.equal(operation, null, `${state} 本来就没有操作行，不该凭空多出一行`);
      } else {
        assert.deepEqual(repos.journal.list(operation!.id), [], `${state} 的操作不该留下日志`);
      }
    }
  });

  it('C6 按工作区批量：只动该工作区的，另一个工作区分毫未动', () => {
    const mine = [makeChange('c6-a'), makeChange('c6-b')];
    const theirs = makeChange('c6-x', { workspace_id: OTHER_WORKSPACE });

    const report = invalidatePendingForWorkspace(repos, {
      workspace_id: WORKSPACE,
      trigger: 'POLICY_CHANGED',
      now: T0,
    });

    assert.deepEqual(report.skipped, []);
    assert.equal(report.invalidated.length, 2);
    for (const fixture of mine) assert.equal(stateOf(fixture.change_id), 'INVALIDATED');
    assert.equal(stateOf(theirs.change_id), 'PENDING_APPROVAL');
  });

  it('C7 按连接批量：同上，按归属连接划分', () => {
    const mine = makeChange('c7-a', { connection_id: OTHER_CONNECTION });
    const theirs = makeChange('c7-b');

    const report = invalidatePendingForConnection(repos, {
      connection_id: OTHER_CONNECTION,
      trigger: 'CONNECTION_DISABLED',
      now: T0,
    });

    assert.equal(report.invalidated.length, 1);
    assert.deepEqual(report.skipped, []);
    assert.equal(stateOf(mine.change_id), 'INVALIDATED');
    assert.equal(stateOf(theirs.change_id), 'PENDING_APPROVAL');
  });

  it('C8 清单与执行之间状态前进了：记进 skipped，不抛，其余照常', () => {
    const a = makeChange('c8-a');
    const b = makeChange('c8-b');
    const c = makeChange('c8-c');
    // 先取清单（批量的第一步），再让 b 前进 —— 执行器在这中间把它领走了。
    //
    // 这里必须走到 `VALIDATING`（写已经开始），**不能**只走到 `APPROVED`：
    // `APPROVED` 仍在 `INVALIDATABLE_STATES` 里（它有 `INVALIDATED` 出边），
    // 用 `APPROVED` 当「前进了」的样本，测到的是「可失效的那条也能失效」，
    // 而本用例要测的恰恰是**不可失效的那条被跳过**。
    const listed = [a.change_id, b.change_id, c.change_id];
    drive(b.change_id, 'VALIDATING');

    const report = invalidateMany(repos, { change_ids: listed, trigger: 'POLICY_CHANGED', now: T0 });

    assert.deepEqual(report.invalidated.map((outcome) => outcome.change_id), [a.change_id, c.change_id]);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0]?.change_id, b.change_id);
    assert.equal(report.skipped[0]?.reason, 'STATE_CHANGED');
    assert.equal(report.skipped[0]?.current_state, 'VALIDATING');
    assert.equal(stateOf(b.change_id), 'VALIDATING', '跳过的那条必须原样留着');
    assert.ok(
      !INVALIDATABLE_STATES.includes('VALIDATING'),
      '本用例的前提：VALIDATING 不在可失效集合里',
    );
  });

  it('C9 清单里的修改集已经不存在了：记 NOT_FOUND，不抛', () => {
    const report = invalidateMany(repos, { change_ids: ['chg_不存在'], trigger: 'POLICY_CHANGED', now: T0 });
    assert.deepEqual(report.invalidated, []);
    assert.equal(report.skipped[0]?.reason, 'NOT_FOUND');
    assert.equal(report.skipped[0]?.current_state, null);
  });

  it('C10 撤销批准同时作废修改集：撤销之后不能靠再签一份批准复活', () => {
    const fixture = makeChange('c10');
    drive(fixture.change_id, 'APPROVED');
    const approvalId = approve(fixture.change_id);

    const outcome = revokeLocalApproval(repos, { change_id: fixture.change_id, now: T0 });
    assert.equal(outcome.trigger, 'APPROVAL_REVOKED');
    assert.equal(outcome.approval_to, 'REVOKED');
    assert.equal(stateOf(fixture.change_id), 'INVALIDATED');
    assert.equal(repos.approvals.requireById(approvalId).state, 'REVOKED');

    // 关键的一步：撤销之后**再签一份批准**。
    //
    // 它在数据库层是**允许**的 —— `approvals_active_uq` 是 `WHERE state =
    // 'ACTIVE'` 的**部分**唯一索引，只挡住第二条 ACTIVE；而 `create` 的
    // `INSERT … SELECT … FROM changesets WHERE id = ? AND digest = ?` 只核对
    // 摘要，被失效的修改集摘要没变，因此这一条会签成功。
    //
    // 于是「撤销」与「失效」的分工在此显形：挡住复活的是**修改集已经不在
    // `APPROVED`**，不是批准表。只撤销不失效，等于把一次明确的「停」变成
    // 「再点一下就能继续」—— 而门禁那道拒绝必须由 C11/C12 之外在这里也验一次。
    const resigned = approve(fixture.change_id);
    assert.equal(repos.approvals.requireById(resigned).state, 'ACTIVE', '数据库层确实允许再签一份');

    const gate = evaluateApplyGate({
      repos,
      change_id: fixture.change_id,
      allowed_from: APPLY_ENTRY_STATES,
      now: T0,
    });
    assert.equal(gate.kind, 'refused', '再签一份批准不能让它重新可执行');
    // 断言到 `reason` 而不只是 `code`：`APPROVAL_CONSUMED` 的码也是
    // `CHANGE_STATE_INVALID`，只看码分不出「批准用过了」与「修改集状态不对」。
    assert.equal(gate.kind === 'refused' ? gate.reason : null, 'CHANGE_STATE_INVALID');
    assert.equal(stateOf(fixture.change_id), 'INVALIDATED');
  });

  it('C11 门禁真的会拦住「权限缩小时的老计划」', () => {
    // 这一条**自带工作区**，不借用共享的那几个。理由不是洁癖：它要做的事是
    // 「把代次往前推」，而代次是**持久**的。借用 `WORKSPACE` 会让它之后任何
    // 一条用同一个工作区的用例面对一个已经变过的世界 —— C12 就曾因此报出
    // `GENERATION_CHANGED` 而不是它要断言的 `CHANGE_EXPIRED`，而那条失败
    // 看上去像 C12 的实现有问题。
    const workspaceId = 'ws_inv_c11';
    repos.workspaces.create({
      id: workspaceId,
      alias: `夹具 ${workspaceId}`,
      kind: 'directory',
      canonical_root: `C:\\lwb-024\\${workspaceId}`,
      volume_id: `vol-${workspaceId}`,
      root_file_id: `root-${workspaceId}`,
      policy_version: POLICY_VERSION,
      mode: MODE,
    });
    // 与 `resetDb` 同一个做法：把代次推到夹具声明的那个值（`makeChange` 的
    // 默认代次是常量，不是「工作区现在是多少」），否则前提那一步放行的不是
    // 「代次相符」，而是「代次恰好也错」，后面的拒绝就说明不了任何事。
    while (repos.workspaces.requireById(workspaceId).generation < GENERATION) {
      repos.workspaces.bumpGeneration(workspaceId, POLICY_VERSION);
    }

    const fixture = makeChange('c11', { workspace_id: workspaceId });
    drive(fixture.change_id, 'APPROVED');
    approve(fixture.change_id);

    const gate = () =>
      evaluateApplyGate({ repos, change_id: fixture.change_id, allowed_from: APPLY_ENTRY_STATES, now: T0 });

    // 前提：此刻放行。否则后面那条拒绝可能来自别的原因。
    assert.equal(gate().kind, 'ready');

    repos.workspaces.bumpGeneration(workspaceId, POLICY_VERSION);

    const refused = gate();
    assert.equal(refusalReason(refused), 'GENERATION_CHANGED');
    if (refused.kind !== 'refused') throw new Error('unreachable');
    assert.equal(refused.code, 'WORKSPACE_GENERATION_CHANGED');
    assert.equal(stateOf(fixture.change_id), 'APPROVED', '门禁只判定，不改状态');
  });

  it('C12 门禁也会拦住过期了的修改集，即使批准仍然有效', () => {
    const fixture = makeChange('c12', { expires_at: new Date(T0_MS + 60_000).toISOString() });
    drive(fixture.change_id, 'APPROVED');
    const approvalId = approve(fixture.change_id);

    const later = new Date(T0_MS + 61_000).toISOString();
    const refused = evaluateApplyGate({
      repos,
      change_id: fixture.change_id,
      allowed_from: APPLY_ENTRY_STATES,
      now: later,
    });
    assert.equal(refusalReason(refused), 'CHANGE_EXPIRED');

    // 批准本身没有到期：拒绝来自修改集那条 24 小时的有效期 ——
    // 而那条有效期在 LWB-024 之前**写在库里却没有任何地方读**。
    const approval = repos.approvals.requireById(approvalId);
    assert.equal(approval.state, 'ACTIVE');
    assert.ok(later < approval.expires_at);
  });
});

// ---------------------------------------------------------------------------
// D 组：过期清理
// ---------------------------------------------------------------------------

describe('LWB-024 D 组：过期清理', () => {
  // 这一组用 `beforeEach` 而不是 `before`，是本文件里唯一的一处。理由在断言
  // 的形状上：清理扫的是**整张表**，而这一组要断的是「到期的**那一条**被清掉、
  // 未到期的**那一条**没被动」—— 共用库时，前面用例留下的夹具会先到期，
  // 于是 `expired_changes[0]` 指向别人。修法若改成「找到我那条」，就再也测不到
  // 「只有它一条被清」，而验收标准 1 恰恰是「不该清的没被清」。
  beforeEach(resetDb);

  const PAST = new Date(T0_MS - 1).toISOString();
  const FUTURE = new Date(T0_MS + 60_000).toISOString();

  it('D1 到期的待批准修改集走 EXPIRED，未到期的不动', () => {
    const past = makeChange('d1-past', { expires_at: PAST });
    const future = makeChange('d1-future', { expires_at: FUTURE });

    const report = sweepExpired(repos, { now: T0 });

    assert.deepEqual(report.expired_changes.map((outcome) => outcome.to), ['EXPIRED']);
    assert.equal(report.expired_changes[0]?.change_id, past.change_id);
    assert.equal(stateOf(past.change_id), 'EXPIRED');
    assert.equal(stateOf(future.change_id), 'PENDING_APPROVAL');
    assert.deepEqual(report.skipped, []);
  });

  it('D2 挂在过期修改集上的批准被收掉；它走的是 EXPIRED 那一条', () => {
    const fixture = makeChange('d2', { expires_at: PAST });
    drive(fixture.change_id, 'APPROVED');
    const approvalId = approve(fixture.change_id);
    const later = new Date(T0_MS + LIMITS.APPROVAL_TTL_MS + 1000).toISOString();

    const report = sweepExpired(repos, { now: later });

    assert.equal(report.expired_changes[0]?.approval_to, 'EXPIRED');
    assert.equal(repos.approvals.requireById(approvalId).state, 'EXPIRED');
    assert.equal(stateOf(fixture.change_id), 'EXPIRED');
  });

  it('D3 第二步管的是「修改集不会过期、批准却会过期」的那些', () => {
    // VALIDATING 没有 EXPIRED 出边：它不会过期。但它的批准会 ——
    // 而让一条已经过期十分钟的批准一直显示为「有效」，正是
    // 「离线前批准、重连后过期」最容易被忽略的那一半。
    const fixture = makeChange('d3');
    drive(fixture.change_id, 'VALIDATING');
    const approvalId = approve(fixture.change_id);
    const later = new Date(T0_MS + LIMITS.APPROVAL_TTL_MS + 1000).toISOString();

    const report = sweepExpired(repos, { now: later });

    assert.equal(report.expired_approvals, 1);
    assert.deepEqual(report.expired_changes, [], '执行中的修改集不因过期被碰');
    assert.equal(repos.approvals.requireById(approvalId).state, 'EXPIRED');
    assert.equal(stateOf(fixture.change_id), 'VALIDATING');
  });

  it('D4 终态的修改集不参与过期扫描', () => {
    const fixture = makeChange('d4', { expires_at: PAST });
    drive(fixture.change_id, 'REJECTED');
    const report = sweepExpired(repos, { now: T0 });
    assert.ok(!report.expired_changes.some((outcome) => outcome.change_id === fixture.change_id));
    assert.equal(stateOf(fixture.change_id), 'REJECTED');
  });

  it('D5 两遍扫描是幂等的：第二遍什么都不做', () => {
    makeChange('d5', { expires_at: PAST });
    const first = sweepExpired(repos, { now: T0 });
    const second = sweepExpired(repos, { now: T0 });
    assert.equal(first.expired_changes.length, 1);
    assert.deepEqual(second.expired_changes, []);
    assert.equal(second.expired_approvals, 0);
  });
});

// ---------------------------------------------------------------------------
// E 组：保留计划（验收标准 3 的判定那一半）
// ---------------------------------------------------------------------------

interface RetentionFixtures {
  readonly queued: ChangeFixture;
  readonly validating: ChangeFixture;
  readonly applying: ChangeFixture;
  readonly recovery: ChangeFixture;
  readonly young_applied: ChangeFixture;
  readonly old_applied: ChangeFixture;
  /** 修改集停在 QUEUED，操作却已经进了 RECOVERY_REQUIRED。 */
  readonly diverged: ChangeFixture;
}

describe('LWB-024 E 组：保留计划不认得「引用计数」这个词', () => {
  let built: RetentionFixtures;
  /** 窗口内的那个是在这个时刻终结的。 */
  const T_YOUNG_END = new Date(T0_MS + 6 * DAY_MS).toISOString();
  const NOW = new Date(T0_MS + RETENTION + 1000).toISOString();

  before(() => {
    resetDb();
    clockNow = T0;
    const fixtures: RetentionFixtures = {
      queued: makeChange('e-queued'),
      validating: makeChange('e-validating'),
      applying: makeChange('e-applying'),
      recovery: makeChange('e-recovery'),
      young_applied: makeChange('e-young'),
      old_applied: makeChange('e-old'),
      diverged: makeChange('e-diverged'),
    };
    built = fixtures;

    // 老的那个在 T0 就终结了；年轻的那个在 T0+6 天终结。
    drive(fixtures.old_applied.change_id, 'APPLIED');
    clockNow = T_YOUNG_END;
    drive(fixtures.young_applied.change_id, 'APPLIED');
    clockNow = T0;
    drive(fixtures.queued.change_id, 'QUEUED');
    drive(fixtures.validating.change_id, 'VALIDATING');
    drive(fixtures.applying.change_id, 'APPLYING');
    drive(fixtures.recovery.change_id, 'RECOVERY_REQUIRED');

    // 分叉：两者**可以合法地分开**（见 `state-machine.ts`），
    // 只看修改集状态会把它漏掉 —— 而漏掉的后果是回滚取不到原始字节。
    drive(fixtures.diverged.change_id, 'QUEUED');
    const operation = repos.operations.requireByChangeId(fixtures.diverged.change_id);
    repos.operations.transition(operation.id, ['QUEUED'], 'RECOVERY_REQUIRED');

    // 把「谁还需要这些字节」与「引用计数」拆开：计数归零，需要仍在。
    // 生产代码今天没有这条路径；不构造它，验收标准 3 就只能靠读代码相信。
    for (const fixture of Object.values(fixtures)) {
      repos.blobs.releaseRef(fixture.before_blob);
      repos.blobs.releaseRef(fixture.after_blob);
    }
  });

  function reasonOf(changeId: string, now = NOW): string | undefined {
    return planSnapshotRetention(repos, { now }).protected_changes.find(
      (decision) => decision.change_id === changeId,
    )?.reason;
  }

  it('E0 前提：这些快照确实已经是 pending_gc 且引用为零', () => {
    const pending = new Set(repos.blobs.listPendingGc().map((blob) => blob.id));
    assert.ok(pending.has(built.young_applied.before_blob), '夹具没造出「计数为零」的前提');
    assert.ok(pending.has(built.old_applied.before_blob));
    assert.equal(repos.blobs.requireById(built.young_applied.before_blob).refcount, 0);
  });

  it('E1 运行中的三个、待恢复的一个、窗口内的一个都在保护清单里', () => {
    assert.equal(reasonOf(built.queued.change_id), 'IN_EXECUTION');
    assert.equal(reasonOf(built.validating.change_id), 'IN_EXECUTION');
    assert.equal(reasonOf(built.applying.change_id), 'IN_EXECUTION');
    assert.equal(reasonOf(built.recovery.change_id), 'AWAITING_RECOVERY');
    assert.equal(reasonOf(built.diverged.change_id), 'AWAITING_RECOVERY', '操作单独进了恢复中：只看修改集状态会漏掉它');
    assert.equal(reasonOf(built.young_applied.change_id), 'WITHIN_RETENTION_WINDOW');
  });

  it('E2 计数是照着手数出来的值，而不是同一份清单的第二次求和', () => {
    const plan = planSnapshotRetention(repos, { now: NOW });
    assert.deepEqual(
      { ...plan.counts_by_reason },
      { IN_EXECUTION: 3, AWAITING_RECOVERY: 2, WITHIN_RETENTION_WINDOW: 1, NOT_TERMINAL: 0 },
    );
    assert.equal(
      plan.protected_changes.length,
      SNAPSHOT_PROTECTION_REASONS.reduce((sum, reason) => sum + plan.counts_by_reason[reason], 0),
    );
    assert.deepEqual(
      plan.protected_changes.map((decision) => decision.change_id),
      [...plan.protected_changes.map((decision) => decision.change_id)].sort(),
      'protected_changes 应当已排序（未排序时两次运行的差异会看起来像不一致）',
    );
  });

  it('E3 撤销窗口已满的不在清单里；窗口内的右端是「终结时刻 + 保留期」', () => {
    const plan = planSnapshotRetention(repos, { now: NOW });
    assert.equal(
      plan.protected_changes.find((decision) => decision.change_id === built.old_applied.change_id),
      undefined,
    );
    const young = plan.protected_changes.find((decision) => decision.change_id === built.young_applied.change_id);
    assert.equal(young?.ended_at, T_YOUNG_END);
    assert.equal(young?.retain_until, new Date(Date.parse(T_YOUNG_END) + RETENTION).toISOString());
  });

  it('E4 判据按 blob 给出：同一个结论，两种读法', () => {
    const guard = snapshotGuard(repos, { now: NOW });
    assert.notEqual(guard.protect({ id: built.young_applied.before_blob }), null);
    assert.notEqual(guard.protect({ id: built.applying.after_blob }), null);
    assert.notEqual(guard.protect({ id: built.diverged.before_blob }), null);
    assert.equal(guard.protect({ id: built.old_applied.before_blob }), null);
    assert.equal(guard.protect({ id: built.old_applied.after_blob }), null);
    assert.equal(guard.protect({ id: 'blob_从未存在过' }), null);
  });

  it('E5 窗口边界：差一毫秒受保护，正好到期就不受保护', () => {
    const edgeMs = Date.parse(T_YOUNG_END) + RETENTION;
    const justInside = snapshotGuard(repos, { now: new Date(edgeMs - 1).toISOString() });
    const exactly = snapshotGuard(repos, { now: new Date(edgeMs).toISOString() });
    assert.notEqual(justInside.protect({ id: built.young_applied.before_blob }), null);
    assert.equal(exactly.protect({ id: built.young_applied.before_blob }), null);
  });

  it('E6 尚未终结但不在执行中的（待批准）算 NOT_TERMINAL，不是「可回收」', () => {
    const pending = makeChange('e6-pending');
    assert.equal(reasonOf(pending.change_id), 'NOT_TERMINAL');
    assert.notEqual(snapshotGuard(repos, { now: NOW }).protect({ id: pending.before_blob }), null);
  });

  it('E7 反向探针：窗口调成负数时，未终结的那些**不受影响**', () => {
    // 若未终结的那些也跟着窗口走，「窗口」就成了一个能绕过保护的旋钮 ——
    // 而它本该只决定「已终结的留多久」。
    const guard = snapshotGuard(repos, { now: NOW, retention_ms: -1 });
    assert.equal(guard.protect({ id: built.young_applied.before_blob }), null);
    assert.notEqual(guard.protect({ id: built.applying.before_blob }), null);
    assert.notEqual(guard.protect({ id: built.recovery.before_blob }), null);
    assert.notEqual(guard.protect({ id: built.queued.before_blob }), null);
  });

  it('E8 审计保留的是身份与规模，不是路径，也不是内容', () => {
    const metadata = reclaimedChangeMetadata(repos, built.old_applied.change_id);
    assert.ok(metadata !== null);
    const serialized = JSON.stringify(metadata);
    assert.ok(!serialized.includes('src/'), `元数据里出现了工作区相对路径：${serialized}`);
    assert.ok(!serialized.includes('before-'), '元数据里出现了内容');
    assert.equal(metadata.change_id, built.old_applied.change_id);
    assert.equal(metadata.item_count, 1);
    assert.equal(metadata.added_lines, 2);
    assert.equal(metadata.removed_lines, 1);
    assert.equal(metadata.before_bytes, 'before-e-old'.length);
    assert.equal(metadata.after_bytes, 'after-e-old'.length);
    assert.equal(metadata.digest, built.old_applied.digest);
    // 不抛：排障路径上「它已经不在了」是一个正常的答案。
    assert.equal(reclaimedChangeMetadata(repos, 'chg_不存在'), null);
  });
});

// ---------------------------------------------------------------------------
// F 组：与真实的 BlobStore.collectGarbage 对上（验收标准 3）
// ---------------------------------------------------------------------------

interface RealFixture {
  readonly change_id: string;
  /** 这个修改集引用的两个快照，`before` 在前。 */
  readonly blobs: readonly { readonly id: string; readonly sha256: string }[];
}

describe('LWB-024 F 组：清理不会删除运行中、待恢复或仍在撤销窗口的快照', () => {
  let objectsRoot: string;
  let store: BlobStore;
  const T_YOUNG_END_MS = T0_MS + 6 * DAY_MS;
  const NOW = new Date(T0_MS + RETENTION + 1000).toISOString();

  before(async () => {
    resetDb();
    objectsRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb-024-gc-'));
    // 仓储就是 `repos.blobs` 本身：`BlobRegistry` 是它的结构子集，
    // 因此「登记」「引用计数」「待回收」三件事走的是**同一批行**。
    store = new BlobStore({ objectsRoot, registry: repos.blobs, newId: () => nextId('blob') });
  });

  after(async () => {
    await rm(objectsRoot, { recursive: true, force: true });
  });

  /** 快照的字节在磁盘上的位置。问库要 sha256，而不是记住夹具给的那个。 */
  function pathOf(blobId: string): string {
    return objectPath(objectsRoot, repos.blobs.requireById(blobId).sha256);
  }

  /**
   * 让一个修改集引用**真实落盘**的字节，并把它的引用打到零。
   *
   * `putAndRegister` 先落盘、再登记、再回读校验，因此这些夹具的字节是真的
   * 在磁盘上 —— 而「清理有没有删掉它」只有在真的能删掉的地方才检验得到。
   */
  async function changeWithRealBytes(
    seed: string,
    target: ChangeSetState,
    driveAtMs: number | null,
  ): Promise<RealFixture> {
    clockNow = T0;
    const beforeBytes = Buffer.from(`before-${seed}-${'x'.repeat(24)}`, 'utf8');
    const afterBytes = Buffer.from(`after-${seed}-${'y'.repeat(24)}`, 'utf8');
    const before = await store.putAndRegister(beforeBytes, { id: nextId('blob') });
    const after = await store.putAndRegister(afterBytes, { id: nextId('blob') });

    const relPath = `src/${seed}.ts`;
    const change = repos.changes.create({
      id: nextId('chg'),
      owner_connection_id: CONNECTION,
      workspace_id: WORKSPACE,
      root_generation: GENERATION,
      policy_version: POLICY_VERSION,
      contract_version: CONTRACT_VERSION,
      digest: canonicalChangeDigest({
        contract_version: CONTRACT_VERSION,
        policy_version: POLICY_VERSION,
        root_generation: GENERATION,
        workspace_id: WORKSPACE,
        files: [
          {
            path: relPath,
            op: 'edit_text',
            before_sha256: before.put.sha256,
            before_size: before.put.size,
            after_sha256: after.put.sha256,
            after_size: after.put.size,
            encoding: 'utf-8',
            newline: 'lf',
            bom: false,
          },
        ],
      }),
      summary: `真实字节夹具 ${seed}`,
      expires_at: new Date(T0_MS + LIMITS.CHANGE_TTL_MS).toISOString(),
      items: [
        {
          id: nextId('ci'),
          path: relPath,
          op: 'edit_text',
          base_file_id: `file-${seed}`,
          base_sha256: before.put.sha256,
          target_sha256: after.put.sha256,
          old_blob_id: before.id,
          new_blob_id: after.id,
          encoding: 'utf-8',
          bom: false,
          newline: 'lf',
          added_lines: 1,
          removed_lines: 1,
        },
      ],
    });

    // 时刻必须在**流转之前**设好：`updated_at` 是每次流转写下的，
    // 而保留窗口的起点就是它。
    if (driveAtMs !== null) clockNow = new Date(driveAtMs).toISOString();
    drive(change.id, target);
    clockNow = T0;

    repos.blobs.releaseRef(before.id);
    repos.blobs.releaseRef(after.id);

    return {
      change_id: change.id,
      blobs: [
        { id: before.id, sha256: before.put.sha256 },
        { id: after.id, sha256: after.put.sha256 },
      ],
    };
  }

  it('F1 一轮回收：运行中的与窗口内的留下，窗口已满的被真的删掉', async () => {
    const young = await changeWithRealBytes('f-young', 'APPLIED', T_YOUNG_END_MS);
    const old = await changeWithRealBytes('f-old', 'APPLIED', T0_MS);
    const running = await changeWithRealBytes('f-running', 'APPLYING', null);

    for (const fixture of [young, old, running]) {
      for (const blob of fixture.blobs) {
        assert.ok(existsSync(pathOf(blob.id)), `前提：${blob.id} 的字节真的落盘了`);
      }
    }

    const guard = snapshotGuard(repos, { now: NOW });
    const report = await store.collectGarbage({
      isSafeToCollect: () => true,
      protect: (blob) => guard.protect(blob),
    });

    assert.equal(report.refused, false);
    // 「只删了该删的那些」比「该删的删了」强：前者还排除了多删。
    assert.deepEqual(
      report.collected.map((entry) => entry.id).sort(),
      old.blobs.map((blob) => blob.id).sort(),
    );

    for (const blob of old.blobs) {
      assert.ok(!existsSync(pathOf(blob.id)), `${blob.id} 的字节应当已经从磁盘上消失`);
      assert.equal(repos.blobs.requireById(blob.id).retention_state, 'deleted');
    }
    for (const fixture of [young, running]) {
      for (const blob of fixture.blobs) {
        assert.ok(existsSync(pathOf(blob.id)), `${blob.id} 被删掉了`);
        assert.equal(repos.blobs.requireById(blob.id).retention_state, 'pending_gc');
      }
    }

    assert.ok(
      report.skipped.some((entry) => entry.id === young.blobs[0]?.id && entry.reason.includes('撤销窗口')),
      `窗口内的跳过原因应当指名道姓：${JSON.stringify(report.skipped)}`,
    );
    assert.ok(
      report.skipped.some((entry) => entry.id === running.blobs[0]?.id && entry.reason.includes('正在执行中')),
      `运行中的那条理由应当是「正在执行中」：${JSON.stringify(report.skipped)}`,
    );
  });

  it('F2 反证：把逐对象判据撤掉，同一轮回收会连窗口内的字节一起删', async () => {
    const young = await changeWithRealBytes('f2-young', 'APPLIED', T_YOUNG_END_MS);
    const first = young.blobs[0];
    assert.ok(first !== undefined);
    assert.ok(existsSync(pathOf(first.id)));

    // 全局谓词为真 —— 这正是 LWB-024 之前唯一能表达的东西。
    const report = await store.collectGarbage({ isSafeToCollect: () => true });

    assert.ok(
      report.collected.some((entry) => entry.id === first.id),
      '没有 protect 时它应当被删 —— 若没被删，说明这条反证没在证任何东西',
    );
    assert.ok(!existsSync(pathOf(first.id)), '反证的前提是字节真的被删了');
  });

  it('F3 全局谓词为假时确实什么都不删 —— 但那让标准 3 空洞地成立', async () => {
    const young = await changeWithRealBytes('f3-young', 'APPLIED', T_YOUNG_END_MS);
    const old = await changeWithRealBytes('f3-old', 'APPLIED', T0_MS);
    const guard = snapshotGuard(repos, { now: NOW });

    const report = await store.collectGarbage({
      isSafeToCollect: () => false,
      unsafeReason: '存在在途操作或未决恢复，拒绝回收。',
      protect: (blob) => guard.protect(blob),
    });

    assert.equal(report.refused, true);
    assert.equal(report.refusal_reason, '存在在途操作或未决恢复，拒绝回收。');
    assert.deepEqual(report.collected, []);
    assert.deepEqual(report.skipped, [], '整个回收被拒时不该逐条报告跳过');
    // 「没删错」与「什么都没删」在这里是同一件事 —— 这正是它不能替代
    // F1 的原因：把谓词写成恒假，本用例照样通过。
    for (const fixture of [old, young]) {
      for (const blob of fixture.blobs) assert.ok(existsSync(pathOf(blob.id)));
    }
  });
});
