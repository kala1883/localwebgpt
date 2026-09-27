/**
 * LWB-026 单元测试：写执行协调器。
 *
 * ## 三条验收标准各自需要什么样的装置
 *
 *  - 「同一工作区不会并发应用两个修改集」是一条**关于时间**的断言。证明它的
 *    唯一办法是**真的**按顺序跑两次，然后数一数第二个人碰到了什么。因此这里
 *    用真 SQLite、真仓储、真的 `BEGIN IMMEDIATE` —— 把事务换成桩，等于把
 *    「两个人不会同时读到没人在写」这句话换成桩自己的保证。
 *  - 「不同连接的任务也共享物理工作区执行约束」把上一条的主语从「工作区」
 *    换成了「物理身份」。因此 A 组里第二个修改集属于**另一个连接**，
 *    而它碰到的拒绝必须与第一个连接**逐字相同**。
 *  - 「旧执行器未退出时不会因心跳超时启动新写执行器」是**唯一**一条
 *    需要「进程探针」的。这里用一个会记账的假探针：它既回答「还在不在」，
 *    也回答**被问了几次** —— 而「租约有效时一次都不该问」正是
 *    `slot-rules.ts` 里那条惰性 thunk 的用途（C 组）。
 *
 * ## 写盘的人是假的，而且是**故意**假的
 *
 * `apply` 从不碰文件：本任务交付的是「谁先写、写完之后是什么状态」，
 * 而真实写入是 LWB-027。假写盘人还有第二个好处：B/D 两组要构造
 * 「持有者死了」「写入超时」这类事件，它们在真盘上极难复现，
 * 而在这里是几行代码。
 *
 * 假写盘人**应当**遵守真写盘人的约定：`signal` 被 abort 之后要抛，
 * 而不是交回一份报告。D3 专门让假写盘人**违反**这条约定，
 * 检查协调器不轻信一份迟到的「成功」报告。
 *
 * ## 每个 describe 一个全新的库
 *
 * 槽表的主键是 `(volume_id, root_file_id)`，因此**跨用例残留的一行**会让
 * 下一条用例从一个「已经有人占着」的世界开始。与 LWB-024 的测试同一条理由：
 * 让「这张表里现在有什么」在每组内有唯一答案。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { approveAndQueue, approveChange } from '@lwb/approvals';
import { canonicalChangeDigest } from '@lwb/changes';
import { CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import {
  ExecutionCoordinator,
  claimForExecution,
  decideSlot,
  isOrderedForLocking,
  orderedForLocking,
} from '@lwb/executor';
import type { ApplyReport, ExecutionCoordinatorOptions, ExecutionPlan } from '@lwb/executor';
import type { ProcessIdentity, ProcessProbe } from '@lwb/ipc';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type {
  ChangeItemInput,
  ChangeItemRecord,
  OpenDatabaseResult,
  WorkspaceWriteSlotRecord,
} from '@lwb/persistence';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

const CONNECTION = 'conn_exec';
const OTHER_CONNECTION = 'conn_exec_other';
const WORKSPACE = 'ws_exec';
const WORKSPACE_NESTED = 'ws_exec_nested';
const WORKSPACE_OTHER = 'ws_exec_other';
const PRINCIPAL = 'principal_exec';
const POLICY_VERSION = 3;
const GENERATION = 9;
const MODE = 'read_propose_apply_with_local_approval';
const ACTOR = 'console:test-session';
/**
 * 契约版本**取真值**，不写字面量。
 *
 * 写死它会是本文件里最隐蔽的一处失效：门禁的
 * `CONTRACT_VERSION_CHANGED` 会让每一次认领都被拒绝，而字面量过期的那天
 * 恰好也是契约变更的那天 —— 于是「契约一改，这份测试全红」和
 * 「契约一改，这份测试悄悄测不到东西」之间只差一个 import。
 */
const CONTRACT = CONTRACT_VERSION;

/**
 * 物理身份。**这是本文件里最重要的几个常量。**
 *
 * 槽按 `(volume_id, root_file_id)` 认地，不按 `workspace_id`：三个工作区
 * 记录、两块地 —— `WORKSPACE` 与 `WORKSPACE_NESTED` 同卷不同根，
 * `WORKSPACE_OTHER` 在另一块地上。
 */
const VOLUME = 'vol-exec';
const ROOT = 'root-exec-main';
const ROOT_NESTED = 'root-exec-nested';
const VOLUME_OTHER = 'vol-exec-other';
const ROOT_OTHER = 'root-exec-other';

const T0 = '2026-09-25T10:00:00.000Z';
const T0_MS = Date.parse(T0);
const LEASE_MS = 30_000;

/** 本执行器与「上一个执行器」的进程身份。`started_at` 不同即为不同进程。 */
const HOLDER: ProcessIdentity = { pid: 4242, started_at: '2026-09-25T09:00:00.000Z' };
const PREVIOUS_HOLDER: ProcessIdentity = { pid: 5150, started_at: '2026-09-25T08:00:00.000Z' };

let opened: OpenDatabaseResult;
let repos: Repositories;
let seq = 0;
let nowMs = T0_MS;

const now = (): number => nowMs;
const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;
const iso = (ms: number): string => new Date(ms).toISOString();
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 造一个 sha256 形状的十六进制串。**不是**真哈希：本测试不读文件内容。 */
const fakeSha = (seed: string): string => seed.repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a');

// ---------------------------------------------------------------------------
// 假探针
// ---------------------------------------------------------------------------

/** 会记账的假探针。`calls` 是 B3 与整个 C 组的对象。 */
interface CountingProbe {
  readonly probe: ProcessProbe;
  readonly calls: number[];
  /** 下一次及以后 `identify` 的行为。用例里随时改。 */
  behaviour: 'alive' | 'gone' | 'throw' | 'reused-pid';
  /** `alive` 时报告的身份。 */
  observed: ProcessIdentity | null;
}

function makeProbe(): CountingProbe {
  const calls: number[] = [];
  const box: CountingProbe = {
    calls,
    behaviour: 'alive',
    observed: PREVIOUS_HOLDER,
    probe: {
      identify(pid: number): ProcessIdentity | null {
        calls.push(pid);
        switch (box.behaviour) {
          case 'throw':
            // 探针不可用**不是**「持有者已死」—— `classifyProcessHolder`
            // 把它归成 `unknown`，而 `unknown` 通向阻断。
            throw new Error('探针不可用（测试构造）');
          case 'gone':
            return null;
          case 'reused-pid':
            // 同一个 PID，不同的启动时刻 ⇒ 这是**另一个**进程。
            return { pid, started_at: '2026-09-25T07:00:00.000Z' };
          case 'alive':
            return box.observed;
          default: {
            const never: never = box.behaviour;
            throw new Error(`未处理的探针行为：${String(never)}`);
          }
        }
      },
    },
  };
  return box;
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function resetDb(): void {
  if (opened !== undefined) closeDatabase(opened.db);
  nowMs = T0_MS;
  opened = openDatabase({ path: ':memory:' });
  repos = new Repositories(opened.db, () => iso(nowMs));

  for (const id of [CONNECTION, OTHER_CONNECTION]) {
    repos.connections.create({
      id,
      principal_kind: 'model_surface',
      principal_id: PRINCIPAL,
      alias: `测试连接 ${id}`,
      enabled: true,
    });
  }
  for (const spec of [
    { id: WORKSPACE, volume: VOLUME, root: ROOT, path: 'C:\\lwb-026\\main' },
    { id: WORKSPACE_NESTED, volume: VOLUME, root: ROOT_NESTED, path: 'C:\\lwb-026\\main\\pkg' },
    { id: WORKSPACE_OTHER, volume: VOLUME_OTHER, root: ROOT_OTHER, path: 'C:\\lwb-026\\other' },
  ]) {
    repos.workspaces.create({
      id: spec.id,
      alias: `夹具 ${spec.id}`,
      kind: 'directory',
      canonical_root: spec.path,
      volume_id: spec.volume,
      root_file_id: spec.root,
      policy_version: POLICY_VERSION,
      mode: MODE,
    });
    // 建出来是第 1 代，而夹具声明的不是 1 —— 两边都是 1 的时候，
    // 「代次比对」这条断言在做错事时也会通过。
    while (repos.workspaces.requireById(spec.id).generation < GENERATION) {
      repos.workspaces.bumpGeneration(spec.id, POLICY_VERSION);
    }
  }
}

interface Built {
  readonly change_id: string;
  readonly digest: string;
}

interface Fixture extends Built {
  readonly operation_id: string;
  readonly approval_id: string;
}

/**
 * 造一个**已批准、已排队**的修改集：真仓储 + 真批准 + 真操作。
 *
 * 走 `approveAndQueue` —— 生产里控制台「批准并应用」走的就是它。
 * 自己拼一遍「建批准、转状态、建操作」也能得到同样的行，但那会让
 * 本文件测的起点变成「我拼出来的起点」而不是「生产路径给出的起点」。
 */
function queuedChange(
  seed: string,
  options: {
    readonly workspace_id?: string;
    readonly connection_id?: string;
    readonly paths?: readonly string[];
  } = {},
): Fixture {
  const built = buildChange(seed, options);
  const queued = approveAndQueue({
    repos,
    change_id: built.change_id,
    digest: built.digest,
    actor: ACTOR,
    now: T0,
    idempotency_key: `key-${seed}`,
  });
  return { ...built, operation_id: queued.operation.id, approval_id: queued.approval.id };
}

/** 只批准、**不**排队。F1 要的正是「有批准、没操作」那一格。 */
function approvedChange(seed: string): Built {
  const built = buildChange(seed);
  approveChange({ repos, change_id: built.change_id, digest: built.digest, actor: ACTOR, now: T0 });
  return built;
}

/**
 * 建一个 `PENDING_APPROVAL` 的修改集，返回它的 id 与**重算出来的**摘要。
 *
 * 摘要由 `canonicalChangeDigest` 从同一批事实算出来，而门禁里的
 * `reloadChangeSet` 会在执行前再算一遍 —— 两边对上才算数，
 * 这正是「批准绑定的是落库事实」这句话在测试装置里的体现。
 */
function buildChange(
  seed: string,
  options: {
    readonly workspace_id?: string;
    readonly connection_id?: string;
    readonly paths?: readonly string[];
  } = {},
): Built {
  const workspaceId = options.workspace_id ?? WORKSPACE;
  const connectionId = options.connection_id ?? CONNECTION;
  const paths = options.paths ?? [`src/${seed}.ts`];

  const files = paths.map((path, index) => {
    const beforeText = `before-${seed}-${index}`;
    const afterText = `after-${seed}-${index}`;
    const beforeSha = fakeSha(`1${seed}${index}`);
    const afterSha = fakeSha(`2${seed}${index}`);
    const before = repos.blobs.ensure({
      id: nextId('blob'),
      sha256: beforeSha,
      size: beforeText.length,
      storage_ref: `objects/${beforeSha}`,
    }).blob;
    const after = repos.blobs.ensure({
      id: nextId('blob'),
      sha256: afterSha,
      size: afterText.length,
      storage_ref: `objects/${afterSha}`,
    }).blob;
    const item: ChangeItemInput = {
      id: nextId('ci'),
      path,
      op: 'edit_text',
      base_file_id: `file-id-${seed}-${index}`,
      base_sha256: beforeSha,
      target_sha256: afterSha,
      old_blob_id: before.id,
      new_blob_id: after.id,
      encoding: 'utf-8',
      bom: false,
      newline: 'lf',
      added_lines: 1,
      removed_lines: 1,
    };
    return {
      item,
      digestFile: {
        path,
        op: 'edit_text' as const,
        before_sha256: beforeSha,
        before_size: beforeText.length,
        after_sha256: afterSha,
        after_size: afterText.length,
        encoding: 'utf-8' as const,
        newline: 'lf' as const,
        bom: false,
      },
    };
  });

  const digest = canonicalChangeDigest({
    contract_version: CONTRACT,
    policy_version: POLICY_VERSION,
    root_generation: GENERATION,
    workspace_id: workspaceId,
    files: files.map((entry) => entry.digestFile),
  });

  const change = repos.changes.create({
    id: nextId('chg'),
    owner_connection_id: connectionId,
    workspace_id: workspaceId,
    root_generation: GENERATION,
    policy_version: POLICY_VERSION,
    contract_version: CONTRACT,
    digest,
    summary: `测试摘要 ${seed}`,
    expires_at: iso(T0_MS + LIMITS.CHANGE_TTL_MS),
    items: files.map((entry) => entry.item),
  });

  return { change_id: change.id, digest };
}

function coordinatorWith(
  probe: ProcessProbe,
  apply: (plan: ExecutionPlan, signal: AbortSignal) => Promise<ApplyReport>,
  extra: Partial<ExecutionCoordinatorOptions> = {},
): ExecutionCoordinator {
  return new ExecutionCoordinator({
    repos,
    probe,
    apply,
    executor_id: 'exe_test',
    holder: HOLDER,
    lease_ms: LEASE_MS,
    now,
    ...extra,
  });
}

/** 认领的快捷方式，省掉每个用例都写一遍 deps。 */
function claim(probe: ProcessProbe, changeId: string, executorId = 'exe_test') {
  return claimForExecution(
    { repos, executor_id: executorId, holder: HOLDER, probe, lease_ms: LEASE_MS, now },
    changeId,
  );
}

const slotOf = (volume: string, root: string): WorkspaceWriteSlotRecord | null =>
  repos.write_slots.find(volume, root);
const stateOf = (changeId: string): string => repos.changes.requireById(changeId).state;
const opStateOf = (operationId: string): string => repos.operations.requireById(operationId).state;

/**
 * 写盘的人按 §8.2 步骤 5 记下「执行意图」：`VALIDATING → APPLYING`。
 *
 * 这一步**必须**由写盘的人做，理由不是纪律而是结构：它是唯一知道
 * 「全部既有文件身份与原始哈希都核对过了」的一方。本模块不能在调用它
 * 之前先把这一格写上 —— 那样一次在校验阶段就退出的执行会留下 `APPLYING`，
 * 而 `APPLYING → CONFLICT` 不是转移表里的边。
 *
 * 假写盘人在这里照着真约定做，D6 则专门不照做 —— 见那一条。
 */
function recordIntent(plan: ExecutionPlan): void {
  repos.changes.transition(plan.change.id, ['VALIDATING'], 'APPLYING');
  repos.operations.transition(plan.operation_id, ['VALIDATING'], 'APPLYING');
}

// ---------------------------------------------------------------------------
// A 组：互斥（验收标准 1 与 2）
// ---------------------------------------------------------------------------

describe('LWB-026 A 组：同一物理工作区不会并发应用两个修改集', () => {
  it('A1 第二个修改集被拒绝，且**什么都没变**', () => {
    resetDb();
    const probe = makeProbe();
    const first = queuedChange('a1-first');
    const second = queuedChange('a1-second');

    assert.equal(claim(probe.probe, first.change_id).kind, 'claimed');

    const refused = claim(probe.probe, second.change_id);
    assert.equal(refused.kind, 'refused');
    if (refused.kind !== 'refused') return;
    assert.equal(refused.reason, 'SLOT_REFUSED');
    assert.equal(refused.code, 'WORKSPACE_BUSY');
    assert.equal(refused.details['slot_reason'], 'LEASE_VALID');

    // 「拒绝」的全部含义：第二个修改集、它的操作、它的批准**一格都没动**。
    assert.equal(stateOf(second.change_id), 'QUEUED');
    assert.equal(opStateOf(second.operation_id), 'QUEUED');
    assert.equal(repos.approvals.findById(second.approval_id)?.state, 'ACTIVE', '批准没被烧掉');
    // 而第一个人是真的占住了。
    assert.equal(slotOf(VOLUME, ROOT)?.operation_id, first.operation_id);
    assert.equal(stateOf(first.change_id), 'VALIDATING');
  });

  it('A2 另一个**连接**的修改集碰到逐字相同的拒绝（验收标准 2）', () => {
    resetDb();
    const probe = makeProbe();
    const mine = queuedChange('a2-mine');
    const theirs = queuedChange('a2-theirs', { connection_id: OTHER_CONNECTION });

    assert.equal(claim(probe.probe, mine.change_id).kind, 'claimed');
    // 换个执行器标识也一样：约束挂在**物理身份**上，与是谁在申请无关。
    const refused = claim(probe.probe, theirs.change_id, 'exe_other');
    assert.equal(refused.kind, 'refused');
    if (refused.kind !== 'refused') return;
    assert.equal(refused.details['slot_reason'], 'LEASE_VALID');
    assert.equal(refused.details['volume_id'], VOLUME);
    assert.equal(refused.details['root_file_id'], ROOT);
    assert.equal(stateOf(theirs.change_id), 'QUEUED');
  });

  it('A3 不同物理身份各自持有一块地 —— 本用例**记录一个已知缺口**', () => {
    resetDb();
    const probe = makeProbe();
    const outer = queuedChange('a3-outer', { workspace_id: WORKSPACE });
    const inner = queuedChange('a3-inner', {
      workspace_id: WORKSPACE_NESTED,
      connection_id: OTHER_CONNECTION,
    });

    assert.equal(claim(probe.probe, outer.change_id).kind, 'claimed');
    const second = claim(probe.probe, inner.change_id);

    // ⚠️ 这一行断言的是**当前**行为，不是一个正确的性质。
    //
    // 目录工作区与它内部的另一个工作区（子目录，或 `kind:'file'` 的单文件）
    // 是两个不同的物理身份，因此占的是两块不同的地。两个操作可以同时覆盖
    // 同一个文件 —— 而它们各自的句柄级检查都只看到自己打开时的基线。
    //
    // LWB-027 的「每次写入前按对象身份重新核对」是这条缺口的收口处；
    // 它落地之后本断言必须改成「第二个人被拒绝」。
    // 与偏离项 99（8.3 短名与硬链接）属于同一类：**别名**。
    assert.equal(second.kind, 'claimed');
    assert.equal(repos.write_slots.list().length, 2, '两个物理身份 = 两块地，这正是缺口的成因');
    assert.notEqual(ROOT, ROOT_NESTED);
  });

  it('A4 两块**真正**无关的地可以同时被占（否则「全局单执行器」也能过 A1/A2）', () => {
    resetDb();
    const probe = makeProbe();
    const here = queuedChange('a4-here');
    const there = queuedChange('a4-there', { workspace_id: WORKSPACE_OTHER });

    assert.equal(claim(probe.probe, here.change_id).kind, 'claimed');
    const other = claim(probe.probe, there.change_id, 'exe_other');
    assert.equal(other.kind, 'claimed', '并行度不该被一个全局锁抹掉');
    assert.equal(repos.write_slots.list().length, 2);
  });
});

// ---------------------------------------------------------------------------
// B 组：租约、接管与否决
// ---------------------------------------------------------------------------

/** 造一个「上一个执行器占着地」的世界：直接写槽，绕过认领。 */
function seatPreviousExecutor(options: {
  readonly volume: string;
  readonly root: string;
  readonly workspace_id: string;
  readonly operation_id: string;
  readonly expires_at: string;
}): void {
  repos.write_slots.claim({
    volume_id: options.volume,
    root_file_id: options.root,
    workspace_id: options.workspace_id,
    operation_id: options.operation_id,
    executor_id: 'exe_previous',
    fencing_token: 3,
    holder_pid: PREVIOUS_HOLDER.pid,
    holder_started_at: PREVIOUS_HOLDER.started_at,
    expires_at: options.expires_at,
  });
}

/** 把上一个操作推到执行中的某一格（连同它的修改集）。 */
function driveToExecuting(
  changeId: string,
  operationId: string,
  at: 'QUEUED' | 'VALIDATING' | 'APPLYING',
): void {
  if (at === 'QUEUED') return;
  repos.changes.transition(changeId, ['QUEUED'], 'VALIDATING');
  repos.operations.transition(operationId, ['QUEUED'], 'VALIDATING');
  if (at === 'APPLYING') {
    repos.changes.transition(changeId, ['VALIDATING'], 'APPLYING');
    repos.operations.transition(operationId, ['VALIDATING'], 'APPLYING');
  }
}

describe('LWB-026 B 组：租约、接管，与「不知道就不动」', () => {
  /** 公共起点：上一个执行器占着地、租约**已过期**，同时有一个新申请者。 */
  function expiredWorld(seed: string): { previous: Fixture; next: Fixture } {
    const previous = queuedChange(seed);
    driveToExecuting(previous.change_id, previous.operation_id, 'APPLYING');
    seatPreviousExecutor({
      volume: VOLUME,
      root: ROOT,
      workspace_id: WORKSPACE,
      operation_id: previous.operation_id,
      expires_at: iso(T0_MS - 1),
    });
    return { previous, next: queuedChange(`${seed}-next`) };
  }

  it('B1 租约过期但持有者**还活着** ⇒ 拒绝，且**不阻断**（验收标准 3）', () => {
    resetDb();
    const probe = makeProbe();
    const { previous, next } = expiredWorld('b1');

    const refused = claim(probe.probe, next.change_id);
    assert.equal(refused.kind, 'refused');
    if (refused.kind !== 'refused') return;
    assert.equal(refused.details['slot_reason'], 'HELD_BY_LIVE_EXECUTOR');

    // 关键的一格：**没有**阻断。阻断一块活人正在写的地，会在它收尾之前
    // 给它加一个需要人工解释的状态。
    assert.equal(slotOf(VOLUME, ROOT)?.blocked_at, null);
    assert.equal(stateOf(previous.change_id), 'APPLYING', '进行中的写入记账不许被改坏');
    assert.equal(opStateOf(previous.operation_id), 'APPLYING');
  });

  it('B2 租约过期、持有者确定已退出 ⇒ 阻断 + 上一操作转待恢复', () => {
    resetDb();
    const probe = makeProbe();
    probe.behaviour = 'gone';
    const { previous, next } = expiredWorld('b2');

    const blocked = claim(probe.probe, next.change_id);
    assert.equal(blocked.kind, 'blocked');
    if (blocked.kind !== 'blocked') return;
    assert.equal(blocked.reason, 'PREVIOUS_WRITE_OUTCOME_UNKNOWN');
    assert.equal(blocked.recovered_previous, true);

    assert.notEqual(slotOf(VOLUME, ROOT)?.blocked_at, null);
    assert.equal(stateOf(previous.change_id), 'RECOVERY_REQUIRED');
    assert.equal(opStateOf(previous.operation_id), 'RECOVERY_REQUIRED');
    // 提出申请的那个人一格都没动。
    assert.equal(stateOf(next.change_id), 'QUEUED');
  });

  it('B3 探针**抛异常** ⇒ 阻断，但**不动**上一操作的状态', () => {
    resetDb();
    const probe = makeProbe();
    probe.behaviour = 'throw';
    const { previous, next } = expiredWorld('b3');

    const blocked = claim(probe.probe, next.change_id);
    assert.equal(blocked.kind, 'blocked');
    if (blocked.kind !== 'blocked') return;
    assert.equal(blocked.reason, 'HOLDER_STATUS_UNKNOWN');
    assert.equal(blocked.recovered_previous, false, '持有者可能还活着，不能改它的记账');
    assert.equal(probe.calls.length, 1, '「查不清」是问过之后才知道的');

    assert.notEqual(slotOf(VOLUME, ROOT)?.blocked_at, null);
    assert.equal(stateOf(previous.change_id), 'APPLYING');
  });

  it('B4 PID 被复用（启动时刻不同）⇒ 按「已退出」处理', () => {
    resetDb();
    const probe = makeProbe();
    probe.behaviour = 'reused-pid';
    const { next } = expiredWorld('b4');

    const blocked = claim(probe.probe, next.change_id);
    assert.equal(blocked.kind, 'blocked');
    if (blocked.kind !== 'blocked') return;
    assert.equal(blocked.reason, 'PREVIOUS_WRITE_OUTCOME_UNKNOWN');
    assert.equal(blocked.recovered_previous, true);
  });

  it('B5 已被阻断的地：只得到「已被阻断」，原因取第一次那一条', () => {
    resetDb();
    const probe = makeProbe();
    const { next } = expiredWorld('b5');
    repos.write_slots.block({
      volume_id: VOLUME,
      root_file_id: ROOT,
      reason: 'HOLDER_STATUS_UNKNOWN',
    });

    // 探针这次说「持有者死了」—— 阻断不因任何其他条件而改变。
    probe.behaviour = 'gone';
    const outcome = claim(probe.probe, next.change_id);
    assert.equal(outcome.kind, 'already_blocked');
    if (outcome.kind !== 'already_blocked') return;
    assert.equal(outcome.blocked_reason, 'HOLDER_STATUS_UNKNOWN');
    assert.equal(probe.calls.length, 0, '阻断是最先判的：连探针都不该问');
  });

  it('B6 **过期不等于可以接管**：同一事实的第三种读法', () => {
    resetDb();
    const probe = makeProbe();
    const previous = queuedChange('b6-prev');
    driveToExecuting(previous.change_id, previous.operation_id, 'VALIDATING');
    seatPreviousExecutor({
      volume: VOLUME,
      root: ROOT,
      workspace_id: WORKSPACE,
      operation_id: previous.operation_id,
      expires_at: iso(T0_MS - 1),
    });
    const next = queuedChange('b6-next');

    // 持有者三种状态里只有一种（gone）通向「处置别人的地」——
    // 而它通向的是**阻断**，不是接管。这里把 alive 那一格单独钉住：
    // 它的产物是「拒绝」，而且必须**没有任何一次写入**。
    probe.behaviour = 'alive';
    const refused = claim(probe.probe, next.change_id);
    assert.equal(refused.kind, 'refused');
    assert.equal(slotOf(VOLUME, ROOT)?.fencing_token, 3, '令牌没动');
    assert.equal(slotOf(VOLUME, ROOT)?.operation_id, previous.operation_id);
  });
});

// ---------------------------------------------------------------------------
// C 组：探针只在必要时被调用
// ---------------------------------------------------------------------------

describe('LWB-026 C 组：租约有效时一次探针都不发生', () => {
  it('C1 第一次认领（没有槽行）不探针', () => {
    resetDb();
    const probe = makeProbe();
    probe.behaviour = 'throw';
    const change = queuedChange('c1');

    // 探针会抛 —— 而这次认领根本不该问它。若它被问了，结果会是阻断。
    const claimed = claim(probe.probe, change.change_id);
    assert.equal(claimed.kind, 'claimed');
    assert.equal(probe.calls.length, 0);
  });

  it('C2 租约仍有效时不探针：一个会抛的探针也不该让工作区自己锁死', () => {
    resetDb();
    const probe = makeProbe();
    const first = queuedChange('c2-first');
    assert.equal(claim(probe.probe, first.change_id).kind, 'claimed');

    probe.behaviour = 'throw';
    const second = queuedChange('c2-second');
    const refused = claim(probe.probe, second.change_id);

    assert.equal(refused.kind, 'refused');
    if (refused.kind !== 'refused') return;
    assert.equal(refused.details['slot_reason'], 'LEASE_VALID');
    assert.equal(probe.calls.length, 0, '租约有效就已经拒绝了，问进程改变不了结论');
    assert.equal(
      slotOf(VOLUME, ROOT)?.blocked_at,
      null,
      '本机装不装探针，不该决定工作区会不会锁死',
    );
  });

  it('C3 租约**刚好**到期的那一刻才开始探（边界是 `<`）', () => {
    resetDb();
    const probe = makeProbe();
    const first = queuedChange('c3-first');
    assert.equal(claim(probe.probe, first.change_id).kind, 'claimed');
    assert.equal(slotOf(VOLUME, ROOT)?.expires_at, iso(T0_MS + LEASE_MS));

    // 走到「整点到期」的那一毫秒。
    nowMs = T0_MS + LEASE_MS;
    probe.behaviour = 'gone';
    const second = queuedChange('c3-second');
    const outcome = claim(probe.probe, second.change_id);
    assert.equal(outcome.kind, 'blocked', '整点即过期，于是要问进程');
    assert.equal(probe.calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// D 组：不重启（步骤 3）
// ---------------------------------------------------------------------------

describe('LWB-026 D 组：取消、断线、超时都不重启同一个写操作', () => {
  it('D1 写盘抛错 ⇒ RECOVERY_REQUIRED，**没有**回 QUEUED', async () => {
    resetDb();
    const probe = makeProbe();
    const change = queuedChange('d1');
    const coordinator = coordinatorWith(probe.probe, async () => {
      throw new Error('写盘失败（测试构造）');
    });

    const outcome = await coordinator.runOnce();
    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') return;
    assert.equal(outcome.state, 'RECOVERY_REQUIRED');
    assert.equal(stateOf(change.change_id), 'RECOVERY_REQUIRED');
    assert.equal(opStateOf(change.operation_id), 'RECOVERY_REQUIRED');
    assert.equal(
      repos.operations.findById(change.operation_id)?.finished_at,
      null,
      '待恢复不是终局',
    );

    // 再跑一次：它**不会**被重新捡起来（`listByStates(['QUEUED'])` 里没有它）。
    assert.equal((await coordinator.runOnce()).kind, 'idle');
  });

  it('D2 超时 ⇒ RECOVERY_REQUIRED（超时只证明「没等到回执」）', async () => {
    resetDb();
    const probe = makeProbe();
    const change = queuedChange('d2');
    const coordinator = coordinatorWith(
      probe.probe,
      (_plan, signal) =>
        new Promise<ApplyReport>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('被取消')));
        }),
      { apply_timeout_ms: 10 },
    );

    const outcome = await coordinator.runOnce();
    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') return;
    assert.equal(outcome.state, 'RECOVERY_REQUIRED');
    assert.match(outcome.detail, /上界/);
    assert.equal(stateOf(change.change_id), 'RECOVERY_REQUIRED');
  });

  it('D3 心跳失效（槽被阻断）⇒ 停手；迟到的报告不被采信', async () => {
    resetDb();
    const probe = makeProbe();
    const change = queuedChange('d3');
    let sawAbort = false;

    const coordinator = coordinatorWith(
      probe.probe,
      async (_plan, signal) => {
        // 地基被阻断：本执行器已失去资格。
        repos.write_slots.block({ volume_id: VOLUME, root_file_id: ROOT, reason: 'TEST_TAKEOVER' });
        await delay(40);
        sawAbort = signal.aborted;
        // **故意违反约定**：abort 之后仍然交回一份「成功」报告。
        // 协调器必须丢掉它 —— 否则一次可能只写了一半的操作会被标成 APPLIED。
        return { kind: 'applied' };
      },
      { heartbeat_ms: 5, lease_ms: 30 },
    );

    const outcome = await coordinator.runOnce();
    assert.equal(sawAbort, true, '心跳失败必须让 signal 进入 aborted');
    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') return;
    assert.equal(outcome.state, 'RECOVERY_REQUIRED');
    assert.match(outcome.detail, /待恢复/);
    assert.equal(stateOf(change.change_id), 'RECOVERY_REQUIRED');
  });

  it('D4 三种报告各自落到唯一的状态上', async () => {
    resetDb();
    const probe = makeProbe();
    // 第三列是「这个报告有没有先记下执行意图」。
    //
    // 只有 `applied` 会记：**记执行意图的含义是「我要动字节了」**，
    // 而 `no_change`（磁盘上已经是目标内容）与 `conflict`（复核发现基线已变）
    // 都是**在写之前**就能下的结论 —— 后者是必须，前者是转移表里
    // 根本没有 `APPLYING → FAILED_NO_CHANGE` 这条边。
    const cases: readonly (readonly [ApplyReport, string, boolean])[] = [
      [{ kind: 'applied' }, 'APPLIED', true],
      [{ kind: 'no_change', detail: '磁盘上已经是目标内容' }, 'FAILED_NO_CHANGE', false],
      [{ kind: 'conflict', detail: '写入前复核发现基线已变' }, 'CONFLICT', false],
    ];

    for (const [report, expected, recordsIntent] of cases) {
      const change = queuedChange(`d4-${expected}`);
      const coordinator = coordinatorWith(probe.probe, async (plan) => {
        if (recordsIntent) recordIntent(plan);
        return report;
      });
      const outcome = await coordinator.runOnce();
      assert.equal(outcome.kind, 'finished');
      if (outcome.kind !== 'finished') continue;
      assert.equal(outcome.state, expected);
      assert.equal(stateOf(change.change_id), expected);
      assert.notEqual(
        repos.operations.findById(change.operation_id)?.finished_at,
        null,
        '这三种都是终局',
      );
    }
    // 三次都跑在同一个工作区上，因此这顺带证明了「上一个终结之后下一个人能接手」，
    // 而且令牌一路只增不减。
    assert.equal(repos.operations.listByStates(['QUEUED']).length, 0, '三种终局都不留下可捡起的操作');
    assert.equal(slotOf(VOLUME, ROOT)?.fencing_token, 3, '三次执行 = 令牌 1 → 2 → 3');
  });

  it('D5 一个工作区被占住不挡住另一个（drain 会跳过它，而不是空转）', async () => {
    resetDb();
    const probe = makeProbe();
    // 三个人：`held` 已经占住了 WORKSPACE 这块地，`busy` 在**同一块地**上
    // 排队等它，`free` 在另一块地上。认领会把操作从 `QUEUED` 挪走，
    // 因此「占住地」与「还在队列里」必须由**两个不同的修改集**表达 ——
    // 这是本用例一开始写错的地方。
    const held = queuedChange('d5-held');
    const busy = queuedChange('d5-busy');
    const free = queuedChange('d5-free', { workspace_id: WORKSPACE_OTHER });
    assert.equal(claim(probe.probe, held.change_id, 'exe_other').kind, 'claimed');
    assert.equal(opStateOf(busy.operation_id), 'QUEUED');

    const coordinator = coordinatorWith(probe.probe, async (plan) => {
      recordIntent(plan);
      return { kind: 'applied' };
    });
    const outcomes = await coordinator.drain();

    const finished = outcomes.filter((outcome) => outcome.kind === 'finished');
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.kind === 'finished' ? finished[0].change_id : null, free.change_id);
    assert.ok(
      outcomes.some((outcome) => outcome.kind === 'refused'),
      '被占住的那个以拒绝的形式出现',
    );
    assert.equal(repos.operations.listByStates(['QUEUED']).length, 1, 'busy 还在队列里，下次再试');
  });

  it('D6 写盘的人**没**先记执行意图时，收尾仍落在 APPLIED 而不是抛异常', async () => {
    resetDb();
    const probe = makeProbe();
    const change = queuedChange('d6');
    // 故意**不**调 `recordIntent`。
    //
    // 转移表里没有 `VALIDATING → APPLIED` 这条边，所以一个「假设对方一定
    // 记了意图」的收尾会**在字节已经落盘之后**抛异常：文件是新的，
    // 记账却停在 `VALIDATING` —— 一次成功的写入被记成悬案。
    // 因此这里断言的是「不抛，并且落在 APPLIED」。
    const coordinator = coordinatorWith(probe.probe, async () => ({ kind: 'applied' }));

    const outcome = await coordinator.runOnce();
    assert.equal(outcome.kind, 'finished');
    if (outcome.kind !== 'finished') return;
    assert.equal(outcome.state, 'APPLIED');
    assert.equal(stateOf(change.change_id), 'APPLIED');
    assert.equal(opStateOf(change.operation_id), 'APPLIED');
    assert.notEqual(repos.operations.findById(change.operation_id)?.finished_at, null);
  });
});

// ---------------------------------------------------------------------------
// E 组：确定的加锁次序（步骤 1 后半句）
// ---------------------------------------------------------------------------

/** 只填排序用得上的两列的条目桩。其余字段给形状正确的常量。 */
function itemStub(path: string, seqIndex: number): ChangeItemRecord {
  return {
    id: `ci-stub-${seqIndex}`,
    change_id: 'chg_stub',
    seq: seqIndex,
    op: 'edit_text',
    canonical_path: path,
    // 与 `ChangesRepo.create` 写入的规则一致：规范化之后整体折叠大小写。
    canonical_path_key: path.toLowerCase(),
    base_file_id: null,
    base_sha256: null,
    target_sha256: 'a'.repeat(64),
    old_blob_id: null,
    new_blob_id: 'blob_stub',
    encoding: 'utf-8',
    bom: false,
    newline: 'lf',
    added_lines: 1,
    removed_lines: 1,
    created_at: T0,
  };
}

describe('LWB-026 E 组：加锁次序由路径决定，不由 `seq` 决定', () => {
  it('E1 契约里的条目按 `seq` 给，执行计划里按路径重排', () => {
    resetDb();
    const probe = makeProbe();
    // 故意倒着给：`seq` 0 是 z，1 是 a。
    const change = queuedChange('e1', { paths: ['src/z.ts', 'src/a.ts'] });

    assert.deepEqual(
      repos.changes.items(change.change_id).map((item) => item.canonical_path),
      ['src/z.ts', 'src/a.ts'],
      '落库的次序是 seq 的次序',
    );

    const claimed = claim(probe.probe, change.change_id);
    assert.equal(claimed.kind, 'claimed');
    if (claimed.kind !== 'claimed') return;
    assert.deepEqual(
      claimed.plan.items.map((item) => item.canonical_path),
      ['src/a.ts', 'src/z.ts'],
      '计划里的次序是**加锁**的次序',
    );
    assert.equal(isOrderedForLocking(claimed.plan.items), true);
  });

  it('E2 排序键是折叠过的 `canonical_path_key`，且不改动入参', () => {
    // 按**原路径**排会把 `src/Zebra.ts` 排到 `src/apple.ts` 前面
    // （码元序里 `Z` 在 `a` 之前）—— 而 Windows 上大小写不区分，
    // 于是「同一个文件」在两次排序里可能拿到两个名次。
    // 按折叠过的键排，两次都是 apple 在前。
    assert.deepEqual(
      orderedForLocking([itemStub('src/Zebra.ts', 0), itemStub('src/apple.ts', 1)]).map(
        (item) => item.canonical_path,
      ),
      ['src/apple.ts', 'src/Zebra.ts'],
    );

    // 比较用码元序（`<`），不用 `localeCompare`：后者随运行环境的区域设置
    // 变化，而次序要防的是死锁，死锁不该因为换台机器就变成别的性质。
    // `-` 是 0x2D、`_` 是 0x5F，因此这里 `-` 在前 —— 标点在不同区域设置下
    // 的权重并不一致，这正是不能用 `localeCompare` 的原因。
    assert.deepEqual(
      orderedForLocking([itemStub('src/a_b.ts', 0), itemStub('src/a-b.ts', 1)]).map(
        (item) => item.canonical_path,
      ),
      ['src/a-b.ts', 'src/a_b.ts'],
    );

    // 同一个键上再按 `seq` —— 这一层只为**确定性**，
    // 而不是为了让排序依赖另一张表上的唯一索引才稳定。
    assert.deepEqual(
      orderedForLocking([itemStub('src/a.ts', 1), itemStub('src/a.ts', 0)]).map((item) => item.seq),
      [0, 1],
    );

    const unsorted = [itemStub('src/z.ts', 0), itemStub('src/a.ts', 1)];
    assert.equal(isOrderedForLocking(orderedForLocking(unsorted)), true);
    assert.equal(isOrderedForLocking(unsorted), false);
    assert.equal(unsorted[0]?.canonical_path, 'src/z.ts', '入参没有被就地排序');
  });

  it('E3 判定表不读时钟、不调探针：同样的输入必给同样的输出', () => {
    // `decideSlot` 是纯函数，因此它可以直接构造着测 —— 这是把
    // 「什么时候不许动」摆开看的唯一方式（真库装置只能覆盖到能自然
    // 走到的那些分支）。
    let probes = 0;
    const counted = (): 'gone' => {
      probes += 1;
      return 'gone';
    };
    const slot: WorkspaceWriteSlotRecord = {
      volume_id: VOLUME,
      root_file_id: ROOT,
      workspace_id: WORKSPACE,
      operation_id: 'op_prev',
      executor_id: 'exe_prev',
      fencing_token: 4,
      holder_pid: 1,
      holder_started_at: null,
      acquired_at: T0,
      heartbeat_at: T0,
      expires_at: iso(T0_MS - 1),
      blocked_at: null,
      blocked_reason: null,
    };

    // 槽指向的操作不见了：模式层不该发生（外键 RESTRICT），
    // 因此不猜、阻断 —— 而这是**不问进程**就能下的结论。
    const missing = decideSlot({
      slot,
      previous_operation: null,
      now_ms: T0_MS,
      probe_holder: counted,
    });
    assert.equal(missing.kind, 'block');
    if (missing.kind !== 'block') return;
    assert.equal(missing.reason, 'PREVIOUS_WRITE_OUTCOME_UNKNOWN');
    assert.equal(probes, 0, '槽指向的操作不见了 ⇒ 不必问进程');

    const blocked = decideSlot({
      slot: { ...slot, blocked_at: T0, blocked_reason: 'HOLDER_STATUS_UNKNOWN' },
      previous_operation: null,
      now_ms: T0_MS,
      probe_holder: counted,
    });
    assert.equal(blocked.kind, 'already_blocked');
    assert.equal(probes, 0);
  });
});

// ---------------------------------------------------------------------------
// F 组：入队与解除阻断（两个「唯一入口」）
// ---------------------------------------------------------------------------

describe('LWB-026 F 组：入队与解除阻断各只有一个入口', () => {
  it('F1 补排队只管「已批准、未排队」的那些，且不产生决定', () => {
    resetDb();
    const probe = makeProbe();
    const coordinator = coordinatorWith(probe.probe, async () => ({ kind: 'applied' }));

    // 一个只批准、没排队的（模拟「批准并应用」那个事务没有提交完）。
    const approved = approvedChange('f1-approved');
    // 一个连批准都没有的。**它必须一动不动** —— 本方法搬运决定，不产生决定。
    const pending = buildChange('f1-pending');

    assert.equal(repos.operations.findByChangeId(approved.change_id), null);
    assert.equal(coordinator.enqueueApproved(), 1);

    assert.equal(stateOf(approved.change_id), 'QUEUED');
    assert.notEqual(repos.operations.findByChangeId(approved.change_id), null);
    assert.equal(stateOf(pending.change_id), 'PENDING_APPROVAL', '没有批准的修改集排不进队');
    assert.equal(repos.operations.findByChangeId(pending.change_id), null);

    assert.equal(coordinator.enqueueApproved(), 0, '第二次什么也不做');
    assert.equal(repos.operations.listByStates(['QUEUED']).length, 1);
  });

  it('F2 解除阻断的前提是「导致阻断的操作已经终结」', () => {
    resetDb();
    const probe = makeProbe();
    probe.behaviour = 'gone';
    const previous = queuedChange('f2-prev');
    driveToExecuting(previous.change_id, previous.operation_id, 'APPLYING');
    seatPreviousExecutor({
      volume: VOLUME,
      root: ROOT,
      workspace_id: WORKSPACE,
      operation_id: previous.operation_id,
      expires_at: iso(T0_MS - 1),
    });
    const next = queuedChange('f2-next');
    assert.equal(claim(probe.probe, next.change_id).kind, 'blocked');
    assert.equal(stateOf(previous.change_id), 'RECOVERY_REQUIRED');

    const coordinator = coordinatorWith(probe.probe, async () => ({ kind: 'applied' }));
    // 待恢复**不是**终结：字节的下落还没定案。
    assert.throws(
      () => coordinator.clearBlockade(VOLUME, ROOT),
      (error: unknown) => (error as { code?: string }).code === 'RECOVERY_REQUIRED',
      '未终结时不放行 —— 否则一块第三态的地会被交给下一个写手',
    );
    assert.notEqual(slotOf(VOLUME, ROOT)?.blocked_at, null, '拒绝之后阻断还在');

    // 恢复流程核验到目标状态之后，操作会到达 APPLIED。那时才放行。
    repos.changes.transition(previous.change_id, ['RECOVERY_REQUIRED'], 'APPLIED');
    repos.operations.transition(previous.operation_id, ['RECOVERY_REQUIRED'], 'APPLIED', {
      recovered: true,
      finished: true,
    });
    assert.equal(coordinator.clearBlockade(VOLUME, ROOT).cleared, true);
    assert.equal(slotOf(VOLUME, ROOT)?.blocked_at, null);
  });

  it('F3 解除阻断之后令牌**继续增长**，不从 1 重来', () => {
    resetDb();
    const probe = makeProbe();
    probe.behaviour = 'gone';
    const previous = queuedChange('f3-prev');
    driveToExecuting(previous.change_id, previous.operation_id, 'APPLYING');
    seatPreviousExecutor({
      volume: VOLUME,
      root: ROOT,
      workspace_id: WORKSPACE,
      operation_id: previous.operation_id,
      expires_at: iso(T0_MS - 1),
    });
    const next = queuedChange('f3-next');
    assert.equal(claim(probe.probe, next.change_id).kind, 'blocked');

    const coordinator = coordinatorWith(probe.probe, async () => ({ kind: 'applied' }));
    repos.changes.transition(previous.change_id, ['RECOVERY_REQUIRED'], 'ROLLED_BACK');
    repos.operations.transition(previous.operation_id, ['RECOVERY_REQUIRED'], 'ROLLED_BACK', {
      finished: true,
    });
    coordinator.clearBlockade(VOLUME, ROOT);

    const claimed = claim(probe.probe, next.change_id);
    assert.equal(claimed.kind, 'claimed');
    if (claimed.kind !== 'claimed') return;
    // 上一个执行器留下的是令牌 3。若解除阻断是「删掉那一行」，这里会拿到 1 ——
    // 于是「令牌只增不减」这条性质在第一次恢复之后就断了。
    assert.equal(claimed.plan.fencing_token, 4);
  });
});
