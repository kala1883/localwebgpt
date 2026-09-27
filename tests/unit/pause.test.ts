/**
 * LWB-034 · 安全暂停与紧急停用（判据与落库那一半）。
 *
 * ## 这个文件测什么，不测什么
 *
 * 测的是**四件事**（`pause.ts` 文件头那张表）在这台机器上真的成立，
 * 以及它们各自的失败面**说得准不准**。每一节对应一步：
 *
 * | 步骤 | 事实 | 本文件里的用例 |
 * | --- | --- | --- |
 * | ① | 暂停**落库**，因此活过重启 | 「暂停状态落库」 |
 * | ② | 在途写入被中止（信号那一半） | 「暂停状态落库」末两条 |
 * | ③ | 已排队的授权被废止 | 「废止排队授权」 |
 * | ④ | 失败时长什么样 | 「如实报告」 |
 *
 * **不测**「真的写盘写到一半被停住」：那要真 NTFS 与真的护栏进程，
 * 因此在 `tests/windows/daemon-pause.test.ts`。本文件用内存状态库与
 * 真实的 `PauseService` / `invalidateMany`，证明的是**判据与落库**，
 * 不是磁盘上发生了什么。两者的分工写在 `docs/evidence/lwb-034/summary.md`。
 *
 * ## 为什么每一格都要问「失败时长什么样」
 *
 * 这一格的功能是「停下来」，而它的失效方向有两个，方向都坏：
 * 停不下来（假成功），或者停下来却报告说没有。因此每个成功用例
 * 旁边都有一个问「读不出来 / 写不进去时它说什么」的用例 ——
 * 后者的期望几乎总是「照实说」，而不是「继续」。
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS, newLocalId } from '@lwb/contracts';
import type { ChangeSetState } from '@lwb/contracts';
import { canonicalChangeDigest } from '@lwb/changes';
import { PAUSE_ABORT_REASON, PauseService } from '@lwb/executor';
import { OperationRegistry, type RequestContext } from '@lwb/ipc';
import {
  closeDatabase,
  openDatabase,
  Repositories,
  type ChangeItemInput,
  type SqliteDatabase,
} from '@lwb/persistence';

import { registerPauseOperations } from '../../apps/daemon/src/control/pause.ts';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

/**
 * 夹具里的时刻一律**相对于此刻**算出来，不写死一个日期。
 *
 * 这一点是上一版踩过的坑：写死 `2026-03-01` 之后，`PauseService.engage()`
 * 里那句 `invalidateMany(…, { now: new Date().toISOString() })` 用的是**真实**
 * 当下，于是那条批准在作废它的人眼里早就过期了 —— 它被记成 `EXPIRED`
 * 而不是 `REVOKED`，而这两者说的是两件完全不同的事（「时间到了」与
 * 「有人按了停用」）。
 *
 * 时钟不换成假的：本文件断言的是**关系**（谁比谁早、谁是第一次），
 * 而有效期边界那一类断言属于 `changes-expiry` 的用例，那里有可变时钟。
 * 让夹具按生产的同一种方式取时刻，比让夹具声称一个假的当下更诚实。
 */
const SOON = (ms: number): string => new Date(Date.now() + ms).toISOString();
const CONNECTION = 'conn_pause_fixture';
const PRINCIPAL = 'principal_pause_fixture';
const WORKSPACE = 'ws_pause_fixture';
/**
 * 工作区**建出来**就是第 1 代，因此这里声明 1。
 *
 * 不去「把夹具推到第 N 代」：`changes.create` 会拿这个数与工作区当前代次
 * 比对，而两边都取同一个来源时，代次比对这件事在本文件里不参与任何断言 ——
 * 让它多绕一圈只会多一个能出错的地方。代次本身是 LWB-024 的主题。
 */
const GENERATION = 1;
const POLICY_VERSION = 7;
const CONTRACT_VERSION = 'lwb-contract-v1';
const ACTOR = 'local_console';
const MODE = 'read_propose_apply_with_local_approval';

interface Rig {
  readonly db: SqliteDatabase;
  readonly repos: Repositories;
}

const opened: Rig[] = [];

/**
 * 一个全新的内存库，连接与工作区都铺好。
 *
 * 铺这两行不是仪式：`changes` 对 `workspaces` 有外键，而夹具要造的是**真的**
 * 修改集 —— 一个绕过外键的夹具会在别处（门禁、失效清单）以另一种方式失败。
 */
function freshRig(): Rig {
  const handle = openDatabase({ path: ':memory:' });
  const repos = new Repositories(handle.db);
  repos.connections.create({
    id: CONNECTION,
    principal_kind: 'model_surface',
    principal_id: PRINCIPAL,
    alias: '夹具连接',
    enabled: true,
  });
  repos.workspaces.create({
    id: WORKSPACE,
    alias: '夹具工作区',
    kind: 'directory',
    canonical_root: 'C:\\lwb-034\\ws',
    volume_id: `vol-${WORKSPACE}`,
    root_file_id: `root-${WORKSPACE}`,
    policy_version: POLICY_VERSION,
    mode: MODE,
  });

  const rig: Rig = { db: handle.db, repos };
  opened.push(rig);
  return rig;
}

function contextFor(audience: 'console' | 'mcp-adapter'): RequestContext {
  return {
    audience,
    connection_id: CONNECTION,
    pid: process.pid,
    request_id: `req_${newLocalId('p')}`,
  };
}

/** 一个形状合法、内容无意义的 64 位十六进制。本文件不比对这些字节。 */
function fakeSha(seed: string): string {
  let out = '';
  let counter = 0;
  while (out.length < 64) {
    out += Buffer.from(`${seed}${String(counter)}`, 'utf8').toString('hex');
    counter += 1;
  }
  return out.slice(0, 64);
}

/**
 * 建一条 `PENDING_APPROVAL` 修改集，走**真实仓储**。
 *
 * 摘要用 `canonicalChangeDigest` 真算一遍，与 `prepare.ts` 同一批字段、
 * 同一个函数：本文件有几条用例要点到批准，而批准绑的是摘要。
 * 用一个「像摘要的串」会在 `approvals.create` 的绑定校验上先撞墙 ——
 * 那是装置的锅，不是被测代码的。
 */
function makeChange(rig: Rig, seed: string): string {
  const { repos } = rig;
  const beforeBytes = `before-${seed}\n`;
  const afterBytes = `after-${seed}\n`;
  const beforeSha = fakeSha(`1${seed}`);
  const afterSha = fakeSha(`2${seed}`);
  const relPath = `src/${seed}.ts`;

  const before = repos.blobs.ensure({
    id: newLocalId('blob'),
    sha256: beforeSha,
    size: Buffer.byteLength(beforeBytes),
    storage_ref: `objects/${beforeSha}`,
  }).blob;
  const after = repos.blobs.ensure({
    id: newLocalId('blob'),
    sha256: afterSha,
    size: Buffer.byteLength(afterBytes),
    storage_ref: `objects/${afterSha}`,
  }).blob;

  const digest = canonicalChangeDigest({
    contract_version: CONTRACT_VERSION,
    policy_version: POLICY_VERSION,
    root_generation: GENERATION,
    workspace_id: WORKSPACE,
    files: [
      {
        path: relPath,
        op: 'edit_text',
        before_sha256: beforeSha,
        before_size: Buffer.byteLength(beforeBytes),
        after_sha256: afterSha,
        after_size: Buffer.byteLength(afterBytes),
        encoding: 'utf-8',
        newline: 'lf',
        bom: false,
      },
    ],
  });

  const items: ChangeItemInput[] = [
    {
      id: newLocalId('ci'),
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

  return repos.changes.create({
    id: newLocalId('chg'),
    owner_connection_id: CONNECTION,
    workspace_id: WORKSPACE,
    root_generation: GENERATION,
    policy_version: POLICY_VERSION,
    contract_version: CONTRACT_VERSION,
    digest,
    summary: `夹具 ${seed}`,
    expires_at: SOON(LIMITS.CHANGE_TTL_MS),
    items,
  }).id;
}

/**
 * 把修改集（连同它的操作）推到目标状态。
 *
 * 操作与修改集在真库里是两行，而在生产路径上它们**一起**走。这里让它们
 * 同步前进，是因为本节要测的是它们在**分开**时的行为 —— 而「分开」
 * 只有在「一起」这件事已经成立的地方才说明得了问题。
 */
function drive(rig: Rig, changeId: string, target: 'APPROVED' | 'QUEUED'): string | null {
  const { repos } = rig;
  repos.changes.transition(changeId, ['PENDING_APPROVAL'], 'APPROVED');
  if (target === 'APPROVED') return null;
  const operationId = repos.operations.create({ id: newLocalId('op'), change_id: changeId }).operation.id;
  repos.changes.transition(changeId, ['APPROVED'], 'QUEUED');
  return operationId;
}

/** 给修改集签一份仍然有效的本地批准。 */
function approve(rig: Rig, changeId: string): string {
  return rig.repos.approvals.create({
    id: newLocalId('apr'),
    change_id: changeId,
    digest: rig.repos.changes.requireById(changeId).digest,
    actor: ACTOR,
    expires_at: SOON(LIMITS.APPROVAL_TTL_MS),
  }).id;
}

/**
 * 占住这个工作区的写执行槽 —— 一条「正在写」的**在场证据**。
 *
 * `PauseService.status().stopping` 是从槽位表读的（见它的实现），因此
 * 「在途写入」这件事要真的被看见，就真的得占一块地。这不是仪式：
 * 一个只把修改集推到 `APPLYING` 的用例会得到一份**空**的 `stopping`，
 * 而那恰好是「界面显示已暂停、磁盘上还在写」这一格的成因。
 */
/**
 * 只让「暂停那一行」写不进去，其余写路径照常。
 *
 * 这是真实世界里的另一半失败：状态库好好的，而这一行写不进去
 * （磁盘满、锁超时、只读挂载）。
 *
 * 用原型接出来的对象而不是 `{...real}`：展开一个类实例会**丢掉原型方法**
 * （`isPaused` / `current` / `release` 都在原型上），于是这个夹具会把
 * 「读」也一起弄坏，而本用例要的恰恰是「读得到、写不进」。
 * `Object.assign` 从实例上取的是**自有**属性（`db` 与 `clock`），
 * 未覆写的方法继续走原型。
 */
function breakPersistOnly(rig: Rig, message: string): void {
  const real = rig.repos.service_pause;
  const stub = Object.assign(Object.create(Object.getPrototypeOf(real) as object), real, {
    engage: () => {
      throw new Error(message);
    },
  });
  Object.defineProperty(rig.repos, 'service_pause', { value: stub, configurable: true });
}

function holdSlot(rig: Rig, operationId: string): void {
  rig.repos.write_slots.claim({
    volume_id: `vol-${WORKSPACE}`,
    root_file_id: `root-${WORKSPACE}`,
    workspace_id: WORKSPACE,
    operation_id: operationId,
    executor_id: 'exec_fixture',
    fencing_token: 1,
    holder_pid: process.pid,
    holder_started_at: SOON(0),
    expires_at: SOON(30_000),
  });
}

function stateOf(rig: Rig, changeId: string): ChangeSetState {
  return rig.repos.changes.requireById(changeId).state;
}

after(() => {
  for (const rig of opened) closeDatabase(rig.db);
});

// ---------------------------------------------------------------------------
// ① 暂停状态落库
// ---------------------------------------------------------------------------

describe('LWB-034 · 暂停状态落库', () => {
  it('这台机器从来没有暂停过时：四个读数都如实说「没有」', () => {
    const { repos } = freshRig();
    const status = new PauseService({ repos }).status();

    assert.equal(status.paused, false);
    assert.equal(status.paused_at, null);
    // `updated_at` 为 null 与「暂停过又恢复了」不同（那时它留着上一次的时刻）。
    // 界面要能说出这个差别 —— 那是「从来没被停过」与「停过，后来解除了」。
    assert.equal(status.updated_at, null);
    assert.deepEqual(status.stopping, []);
    assert.deepEqual(status.unrevoked_change_sets, []);
    assert.deepEqual(status.recovery_operations, []);
    assert.equal(status.unrecallable_file_rows, 0);
  });

  it('暂停**落库**：换一个实例仍然读得到（重启不忘记）', () => {
    const { repos } = freshRig();
    const first = new PauseService({ repos }).engage();

    // 换一个实例 = 模拟一次重启：内存里的东西全没了，只剩状态库。
    const afterRestart = new PauseService({ repos });
    assert.equal(
      afterRestart.isPaused(),
      true,
      '只活在内存里的紧急停用会被一次重启静默清掉，而界面会显示「运行中」',
    );
    assert.equal(afterRestart.status().paused_at, first.status.paused_at);
  });

  it('重启后第一次读到的中止信号**一出生就是中止的**', () => {
    const { repos } = freshRig();
    new PauseService({ repos }).engage();

    const afterRestart = new PauseService({ repos });
    assert.equal(
      afterRestart.stopSignal().aborted,
      true,
      '库里写着暂停，而新信号不是中止的 —— 这中间有一格新执行能溜进去',
    );
    assert.equal((afterRestart.stopSignal().reason as Error).message, PAUSE_ABORT_REASON);
  });

  it('重复按下不改变 `paused_at`：它记的是**第一次**按下的时刻', () => {
    const { repos } = freshRig();
    const pause = new PauseService({ repos });
    const first = pause.engage();
    const second = pause.engage();

    assert.equal(first.already, false);
    assert.equal(second.already, true, '第二次按下必须报出「本来就停着」');
    assert.equal(second.status.paused_at, first.status.paused_at);
  });

  it('重复按下用的是**同一只**信号：已经在跑的那一次执行不会漏网', () => {
    const { repos } = freshRig();
    const pause = new PauseService({ repos });
    const before = pause.stopSignal();
    pause.engage();
    pause.engage();

    // 换掉信号 = 那一次执行挂的监听器落在一只没人听的旧信号上，
    // 于是写盘人会一直写下去，而界面说「已暂停」。
    assert.equal(pause.stopSignal(), before);
    assert.equal(pause.stopSignal().aborted, true);
  });

  it('恢复之后 `paused` 归零，而 `updated_at` 留下痕迹', () => {
    const { repos } = freshRig();
    const pause = new PauseService({ repos });
    pause.engage();
    const released = pause.release();

    assert.equal(released.already, false);
    assert.equal(released.status.paused, false);
    assert.equal(released.status.paused_at, null);
    // 两次写都更新 updated_at，因此它**不是** NULL —— 那一行确实存在过。
    assert.notEqual(released.status.updated_at, null);
  });

  it('恢复之后第二次停用能再次中止（信号被换成了新的一只）', () => {
    const { repos } = freshRig();
    const pause = new PauseService({ repos });
    pause.engage();
    const first = pause.stopSignal();
    pause.release();
    const second = pause.stopSignal();

    assert.notEqual(first, second, '沿用旧信号的话，第二次停用会挂在一只早已中止的信号上');
    assert.equal(second.aborted, false);
    pause.engage();
    assert.equal(second.aborted, true);
  });
});

// ---------------------------------------------------------------------------
// ③ 废止排队授权
// ---------------------------------------------------------------------------

describe('LWB-034 · 废止排队授权', () => {
  it('待批准、已批准、已排队三种状态**全部**作废，批准一并撤销', () => {
    const rig = freshRig();
    const pending = makeChange(rig, 'pending');
    const approved = makeChange(rig, 'approved');
    const queued = makeChange(rig, 'queued');
    drive(rig, approved, 'APPROVED');
    drive(rig, queued, 'QUEUED');
    const approvalId = approve(rig, approved);

    const outcome = new PauseService({ repos: rig.repos }).engage();

    assert.deepEqual(
      outcome.revoked.map((item) => item.change_id).sort(),
      [pending, approved, queued].sort(),
    );
    for (const id of [pending, approved, queued]) {
      assert.equal(stateOf(rig, id), 'INVALIDATED');
    }
    // 批准必须**一并**撤销：只改修改集状态会让那条批准留在表里写着 ACTIVE，
    // 而它绑的摘要仍然指向同一份内容 —— 下一个读它的人会以为还能用。
    assert.equal(rig.repos.approvals.requireById(approvalId).state, 'REVOKED');
    assert.deepEqual(outcome.status.unrevoked_change_sets, []);
    assert.equal(outcome.revoke_error, null);
  });

  it('作废的触发因是 `SERVICE_PAUSED`，不是「过期」', () => {
    const rig = freshRig();
    const change = makeChange(rig, 'trigger');
    const outcome = new PauseService({ repos: rig.repos }).engage();

    const item = outcome.revoked.find((entry) => entry.change_id === change);
    assert.ok(item !== undefined, '这条修改集应当被作废');
    // 写成「过期」会让操作者在失效清单里读到一句关于**时间**的话，
    // 而这次作废与时间无关 —— 是有人按了按钮。
    assert.equal(item.trigger, 'SERVICE_PAUSED');
    assert.equal(item.to, 'INVALIDATED');
  });

  it('已经在 `APPLYING` 的不在废止范围内，而它在**另一个**列表里被看见', () => {
    const rig = freshRig();
    const running = makeChange(rig, 'applying');
    const operationId = drive(rig, running, 'QUEUED');
    assert.ok(operationId !== null);
    rig.repos.changes.transition(running, ['QUEUED'], 'VALIDATING');
    rig.repos.changes.transition(running, ['VALIDATING'], 'APPLYING');
    rig.repos.operations.transition(operationId, ['QUEUED'], 'APPLYING');
    holdSlot(rig, operationId);

    const pause = new PauseService({ repos: rig.repos });
    const outcome = pause.engage();
    const status = outcome.status;

    // 这一格归「中止在途写入」管，不归「废止排队授权」管：
    // 强行改成 INVALIDATED 会让一条**可能已经动过盘**的写入失去它的现场。
    assert.deepEqual(outcome.revoked, []);
    assert.equal(stateOf(rig, running), 'APPLYING');

    // 而它**不能因此从界面上消失**。两个列表的分工是：
    //  - `unrevoked_change_sets` 回答「还有哪些排队授权没被废掉」——
    //    一条已经在写的东西不是「排队授权」，因此它不在这里，这是对的；
    //  - `stopping` 回答「现在到底还有谁在写」—— 它在这里。
    // 一条 `APPLYING` 的修改集若两个列表都进不去，操作者按下停用之后
    // 就会看到一份全空的报告，而磁盘上有人在写。
    assert.deepEqual(status.unrevoked_change_sets, []);
    assert.equal(status.stopping.length, 1);
    assert.equal(status.stopping[0]?.operation_id, operationId);
    assert.equal(status.stopping[0]?.change_id, running);
    assert.equal(status.stopping[0]?.workspace_id, WORKSPACE);
    assert.equal(status.stopping[0]?.state, 'APPLYING');
    assert.equal(status.stopping[0]?.holder_pid, process.pid);
    assert.equal(status.stopping[0]?.slot_blocked, false);
  });

  it('已经排上队、连写槽都占好了的，被停用时**不再报成「正在写」**', () => {
    const rig = freshRig();
    const queued = makeChange(rig, 'slotted');
    const operationId = drive(rig, queued, 'QUEUED');
    assert.ok(operationId !== null);
    holdSlot(rig, operationId);

    // 停用之前它确实在 `stopping` 里：它排着队、占着地，随时可能开始写。
    const before = new PauseService({ repos: rig.repos });
    assert.deepEqual(
      before.status().stopping.map((item) => item.operation_id),
      [operationId],
      '一条占了写槽的排队写入必须在停用之前就看得见',
    );

    const status = before.engage().status;

    // 停用之后它必须从**三个**列表里一致地消失，而且每一步都有据可查：
    // 修改集作废、批准撤销、操作按 `FAILED_NO_CHANGE` 收场，并附一条
    // 写着「本次操作没有任何写入动作」的日志。
    //
    // 只清掉其中一部分就会出现这一格最坏的读数：界面说「已暂停、无在途写入」，
    // 而某个列表里还挂着它。
    assert.deepEqual(status.stopping, []);
    assert.deepEqual(status.unrevoked_change_sets, []);
    assert.deepEqual(status.recovery_operations, []);
    assert.equal(stateOf(rig, queued), 'INVALIDATED');
    assert.equal(rig.repos.operations.findById(operationId)?.state, 'FAILED_NO_CHANGE');
    const stages = rig.repos.journal.list(operationId).map((row) => row.stage);
    assert.deepEqual(stages, ['invalidated']);
  });

  it('恢复**不**恢复任何批准：重新写要重新准备一次修改集', () => {
    const rig = freshRig();
    const change = makeChange(rig, 'resume');
    drive(rig, change, 'APPROVED');
    const approvalId = approve(rig, change);

    const pause = new PauseService({ repos: rig.repos });
    pause.engage();
    const released = pause.release();

    assert.deepEqual(released.revoked, [], '恢复不产生作废，因此这一项恒为空');
    assert.equal(
      stateOf(rig, change),
      'INVALIDATED',
      '恢复把作废的修改集变回来 = 一次带副作用的深呼吸',
    );
    assert.equal(rig.repos.approvals.requireById(approvalId).state, 'REVOKED');
  });

  it('状态里数得出恢复态的操作，也数得出已交付给模型的文件行', () => {
    const rig = freshRig();
    const stuck = makeChange(rig, 'stuck');
    const operationId = drive(rig, stuck, 'QUEUED');
    assert.ok(operationId !== null);
    rig.repos.changes.transition(stuck, ['QUEUED'], 'VALIDATING');
    rig.repos.changes.transition(stuck, ['VALIDATING'], 'APPLYING');
    rig.repos.operations.transition(operationId, ['QUEUED'], 'APPLYING');
    // 一次「写到一半、现场未知」的收场。协调器把它收进 RECOVERY_REQUIRED，
    // 而暂停状态的报告必须把它算进 `recovery_operations`。
    rig.repos.changes.transition(stuck, ['APPLYING'], 'RECOVERY_REQUIRED');
    rig.repos.operations.transition(operationId, ['APPLYING'], 'RECOVERY_REQUIRED');

    const pause = new PauseService({ repos: rig.repos });
    const status = pause.engage().status;

    assert.deepEqual(status.unrevoked_change_sets, []);
    assert.deepEqual(status.recovery_operations, [
      { operation_id: operationId, change_id: stuck, workspace_id: WORKSPACE },
    ]);
    // 一个字节都还没出去过，因此这个读数是 0 —— 它与「已经交付、
    // 因此无法撤回」不是同一件事，而这个差别正是这个字段存在的理由。
    assert.equal(status.unrecallable_file_rows, 0);
  });
});

// ---------------------------------------------------------------------------
// ④ 如实报告
// ---------------------------------------------------------------------------

describe('LWB-034 · 如实报告', () => {
  it('落库失败时不假装成功：报 `persist_error`，而中止与废止**仍然发生**', () => {
    const rig = freshRig();
    const change = makeChange(rig, 'readonly');
    const notices: string[] = [];

    // 把库变成只读：**读**照常，**写**全失败。这正好是「落库失败」那一格。
    rig.db.exec('PRAGMA query_only = 1;');

    const pause = new PauseService({
      repos: rig.repos,
      on_notice: (notice) => notices.push(notice.kind),
    });
    const outcome = pause.engage();

    assert.notEqual(outcome.persist_error, null, '落库失败必须如实报出来');
    assert.notEqual(outcome.revoke_error, null, '废止那一步也写不进去，同样必须报出来');
    assert.deepEqual([...notices].sort(), ['PERSIST_FAILED', 'REVOKE_FAILED']);
    // 三件事**分开读**：
    //  - 暂停没有成为事实（库里仍是 false，重启后不会记得）；
    //  - 但在途写入真的被中止了（信号已中止，这一条不依赖数据库）；
    //  - 而没写进去的作废不该被报成作废（那条修改集还在原地）。
    assert.equal(outcome.status.paused, false);
    assert.equal(pause.stopSignal().aborted, true);
    assert.equal(stateOf(rig, change), 'PENDING_APPROVAL');
    assert.deepEqual(outcome.revoked, []);
  });

  it('只有一个失败时，两个字段各自说各自的话', () => {
    const rig = freshRig();
    const change = makeChange(rig, 'half');

    breakPersistOnly(rig, '夹具：只让落库这一步失败');
    const outcome = new PauseService({ repos: rig.repos }).engage();

    assert.match(outcome.persist_error ?? '', /只让落库这一步失败/);
    // 废止那一步没受影响，因此它是成功的 —— 两个字段必须能分开读，
    // 否则「哪一步没做成」这个问题就没有答案。
    assert.equal(outcome.revoke_error, null);
    assert.equal(outcome.revoked.length, 1);
    assert.equal(stateOf(rig, change), 'INVALIDATED');
  });

  it('状态库整个不可读时：`isPaused()` 与 `status()` 都抛，而不是答成「没暂停」', () => {
    const rig = freshRig();
    const pause = new PauseService({ repos: rig.repos });
    closeDatabase(rig.db);

    // 答成「没暂停」是这一格最坏的失效方向：它会让读取继续。
    assert.throws(() => pause.isPaused());
    assert.throws(() => pause.status());
  });
});

// ---------------------------------------------------------------------------
// 控制操作
// ---------------------------------------------------------------------------

describe('LWB-034 · 控制操作 service.pause / service.resume / service.pause_status', () => {
  interface ServiceAuditRow {
    readonly outcome: string;
    readonly subject: string;
    readonly error_code: string | null;
    readonly metadata: Record<string, unknown>;
  }

  interface ControlRig {
    readonly rig: Rig;
    readonly pause: PauseService;
    call(name: string, input: unknown, audience?: 'console' | 'mcp-adapter'): unknown;
    /** 审计行**连同元数据**。仓储的 `list()` 不带元数据，因此这里直查。 */
    serviceAuditRows(): readonly ServiceAuditRow[];
  }

  function makeControlRig(): ControlRig {
    const rig = freshRig();
    // 夹具里放一条**真的**待执行修改集：有几条用例要点到「作废了几条」。
    drive(rig, makeChange(rig, 'audit'), 'QUEUED');

    const pause = new PauseService({ repos: rig.repos });
    const registry = new OperationRegistry();
    registerPauseOperations(registry, { repos: rig.repos, pause });

    return {
      rig,
      pause,
      call(name, input, audience = 'console') {
        const definition = registry.lookup(name);
        assert.ok(definition !== undefined, `${name} 应当已注册`);
        return definition.handler(input, contextFor(audience));
      },
      serviceAuditRows() {
        const rows = rig.db
          .prepare(
            `SELECT outcome, subject, error_code, metadata FROM audit_events
             WHERE action LIKE 'service.%' ORDER BY id ASC`,
          )
          .all() as {
          outcome: string;
          subject: string;
          error_code: string | null;
          metadata: string | null;
        }[];
        return rows.map((row) => ({
          outcome: row.outcome,
          subject: row.subject,
          error_code: row.error_code,
          metadata: (row.metadata === null ? {} : JSON.parse(row.metadata)) as Record<string, unknown>,
        }));
      },
    };
  }

  it('三个操作都要求 `service.control`，而这一条**不授予模型侧**', () => {
    const control = makeControlRig();
    for (const name of ['service.pause', 'service.resume', 'service.pause_status']) {
      assert.throws(
        () => control.call(name, {}, 'mcp-adapter'),
        /只有本地控制台/,
        `${name} 不该接受模型侧来源的调用`,
      );
    }
    // 模型自己把服务停掉是一次拒绝服务，而它在工具面上的表现是
    // 「所有工具突然都返回 PAUSED」—— 使用者会去查一个不存在的问题。
    assert.equal(control.pause.isPaused(), false, '被拒绝的调用不得留下任何状态变化');
    assert.deepEqual(control.serviceAuditRows(), []);
  });

  it('带参数的请求被**拒绝**，而不是被静默忽略', () => {
    const control = makeControlRig();
    // 一个没人读的字段看起来在做点什么 —— 有人读到 `{"reason": "…"}`
    // 会合理地以为那个理由被记下来了。
    assert.throws(() => control.call('service.pause', { reason: '磁盘要满了' }), /不接受参数/);
    assert.throws(() => control.call('service.pause_status', { verbose: true }), /不接受参数/);
    assert.throws(() => control.call('service.resume', { force: true }), /不接受参数/);
    // 空体的两种写法都算空。
    assert.doesNotThrow(() => control.call('service.pause_status', null));
    assert.doesNotThrow(() => control.call('service.pause_status', {}));
    assert.equal(control.pause.isPaused(), false);
  });

  it('`service.pause` 真的停住了服务，并把四个计数写进审计', () => {
    const control = makeControlRig();
    const result = control.call('service.pause', {}) as {
      already: boolean;
      revoked: readonly unknown[];
      persist_failed: boolean;
      revoke_failed: boolean;
      status: { paused: boolean; paused_at: string | null };
    };

    assert.equal(result.status.paused, true);
    assert.equal(result.status.paused_at !== null, true);
    assert.equal(result.already, false);
    assert.equal(result.revoked.length, 1);
    assert.equal(result.persist_failed, false);
    assert.equal(result.revoke_failed, false);

    const rows = control.serviceAuditRows();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row !== undefined);
    assert.equal(row.outcome, 'allow');
    assert.equal(row.subject, 'local_service');
    assert.equal(row.error_code, null);
    // 四个计数 + 一个闭集原因。**没有**错误原文：它可能是本机绝对路径，
    // 而那道筛查对绝对路径是抛错 —— 那会让这条记录在最需要它的时刻写不出来。
    assert.deepEqual(Object.keys(row.metadata).sort(), [
      'reason',
      'revoked_changes',
      'skipped_changes',
      'stopping_writes',
      'unrevoked_changes',
    ]);
    assert.equal(row.metadata['revoked_changes'], 1);
    assert.equal(row.metadata['reason'], null);
  });

  it('`service.resume` 解除暂停，且不产生作废', () => {
    const control = makeControlRig();
    control.call('service.pause', {});
    const result = control.call('service.resume', {}) as {
      already: boolean;
      revoked: readonly unknown[];
      persist_failed: boolean;
      status: { paused: boolean };
    };

    assert.equal(result.already, false);
    assert.equal(result.status.paused, false);
    assert.deepEqual(result.revoked, [], '恢复不恢复任何批准，因此这一项恒为空');
    assert.equal(control.pause.isPaused(), false);

    const rows = control.serviceAuditRows();
    assert.deepEqual(
      rows.map((row) => row.outcome),
      ['allow', 'allow'],
    );
    assert.equal(rows[1]?.metadata['reason'], null);
  });

  it('`service.pause_status` 只读：它不改状态，也不写审计', () => {
    const control = makeControlRig();
    const status = control.call('service.pause_status', {}) as {
      paused: boolean;
      paused_at: string | null;
      updated_at: string | null;
      stopping: readonly unknown[];
      unrevoked_change_sets: readonly { state: string }[];
      recovery_operations: readonly unknown[];
      unrecallable_file_rows: number;
    };

    assert.equal(status.paused, false);
    assert.equal(status.paused_at, null);
    assert.equal(status.updated_at, null);
    assert.deepEqual(status.stopping, []);
    assert.deepEqual(status.recovery_operations, []);
    assert.equal(status.unrecallable_file_rows, 0);
    // 夹具里那条排队授权**应当**出现在这里：这个列表回答的正是
    // 「还有哪些排队授权没被废掉」，而此刻还没有人按过停用。
    assert.deepEqual(
      status.unrevoked_change_sets.map((item) => item.state),
      ['QUEUED'],
    );
    assert.equal(control.pause.isPaused(), false);
    // 一个只读接口不该产生状态变更：它每次刷新都会被界面调用。
    assert.deepEqual(control.serviceAuditRows(), []);
  });

  it('落库失败时：**先写审计**，再抛一个带着现场的错', () => {
    const control = makeControlRig();
    breakPersistOnly(control.rig, '夹具：落库失败');

    assert.throws(
      () => control.call('service.pause', {}),
      (error: unknown) => {
        const details = (error as { details?: Record<string, unknown> }).details ?? {};
        // 详情里带的是「实际发生了什么」，而不是一句笼统的失败 ——
        // 操作者接下来要决定的是「再按一次，还是直接断电」，
        // 而这两个答案取决于在途写入到底停了没有。
        assert.equal(details['reason'], 'PERSIST_FAILED');
        assert.equal(details['stopped_in_flight'], 0);
        assert.equal(details['revoke_failed'], false);
        // 而中止**确实发生了**：它不依赖数据库，因此它不能被算进失败里。
        assert.equal(control.pause.stopSignal().aborted, true);
        return true;
      },
    );

    // 审计**在抛之前**就写好了：落库失败的时候，「有人按过这个按钮」
    // 反而更重要，而一条先抛出去的错误会让这次审计来不及写。
    const rows = control.serviceAuditRows();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row !== undefined);
    assert.equal(row.outcome, 'error', '暂停没有成为事实，因此它是一次 error，不是 allow');
    assert.equal(row.error_code, 'PAUSED');
    assert.equal(row.metadata['reason'], 'PERSIST_FAILED');
    assert.equal(row.metadata['revoked_changes'], 1, '废止那一步成功了，计数要如实写');
  });
});
