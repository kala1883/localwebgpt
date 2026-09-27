/**
 * LWB-021 单元测试：本地批准、拒绝与执行前门禁。
 *
 * ## 装置为什么是这个形状
 *
 * 本任务的三条验收标准都是**否定式**的：
 *
 *  - 「篡改一个字符后旧审批失效」—— 断言的是「没有产生授权」；
 *  - 「模型单独调用应用工具只得到 APPROVAL_REQUIRED」—— 同上；
 *  - 「重复点击批准不会制造第二次授权执行」—— 断言的是「第二次什么也没做」。
 *
 * 证明「什么都没发生」的唯一可靠方式是**真的做那件事，然后数行数**。
 * 因此这里用**真实状态库**（内存 SQLite）：`approvals` 的部分唯一索引、
 * `operations` 的 `UNIQUE(change_id)`、以及迁移 v5 新增的
 * `approvals_binding_matches_change` 触发器全在库里。把它们桩掉，等于
 * 把「拒绝复用的保证」换成桩自己的保证 —— 而被测的正是那些保证。
 *
 * 快照（`blobs`）是**真实的行**但**没有真实字节**：本任务里没有任何一步
 * 读文件内容，摘要只用到 `blobs.size`。造真实字节只会让装置更慢，
 * 并且掩盖「摘要的可行性依赖于 blob 行还在」这个事实 —— 下面的用例 D3
 * 恰好要**移除**那一行，以证明读不到 blob 时是拒绝而不是算出一个别的摘要。
 *
 * ## 负向用例优先
 *
 * 每个负向用例断言三件事：抛出的码与理由、**没有留下批准行**、
 * **状态没有被推进**。只断言「抛了个错」会放过「先记了批准再抛」——
 * 而那正是本任务要防的失效。
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { BridgeError, CONTRACT_VERSION, LIMITS, TOOL_INPUT_SCHEMAS, isToolName } from '@lwb/contracts';
import type { ApprovalRecord, ChangeItemInput } from '@lwb/persistence';
import type { RequestContext } from '@lwb/ipc';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { OpenDatabaseResult } from '@lwb/persistence';
import { canonicalChangeDigest, shortCodeOf } from '@lwb/changes';
import {
  APPLY_ENTRY_STATES,
  approveAndQueue,
  approveChange,
  effectiveApprovalState,
  evaluateApplyGate,
  rejectChange,
  reloadChangeSet,
} from '@lwb/approvals';
import { hasCapability, NEVER_GRANTED_TO_MODEL, OperationRegistry } from '@lwb/ipc';
import { decide } from '@lwb/policy';
import type { ApprovalView as PolicyApprovalView, PolicyRequest } from '@lwb/policy';
import { SurfaceMismatchError, resolveSurface } from '../../apps/mcp-adapter/src/surface.ts';
import type { ToolCatalogResult } from '@lwb/contracts';
import { isControlPlaneName } from '@lwb/contracts';

import {
  MUTATING_OPERATIONS,
  READ_ONLY_OPERATIONS,
  ControlRouteTable,
  registerApprovalOperations,
} from '../../apps/daemon/src/control/index.ts';
import { APPROVAL_OPERATION_NAMES } from '../../apps/daemon/src/control/approvals.ts';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const CONNECTION = 'conn_test';
const WORKSPACE = 'ws_test';
const PRINCIPAL = 'principal_test';
const VOLUME = 'vol-test';
const GENERATION = 7;
const POLICY_VERSION = 3;
const ACTOR = 'console:test-session';

/** 固定判定时刻。用固定时刻而不是 `new Date()`：过期判定是本次测试的对象。 */
const T0 = '2026-09-25T10:00:00.000Z';
const T0_MS = Date.parse(T0);
/** 刚过期一分钟。 */
const T_EXPIRED = new Date(T0_MS + LIMITS.APPROVAL_TTL_MS + 60_000).toISOString();

let opened: OpenDatabaseResult;
let repos: Repositories;
let seq = 0;

const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;

/** 造一个 sha256 形状的十六进制串。**不是**真哈希：本测试不读文件内容。 */
const fakeSha = (seed: string): string =>
  seed
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, 'a');

interface ChangeFixture {
  readonly change_id: string;
  readonly digest: string;
  readonly before_blob: string;
  readonly after_blob: string;
  readonly item_id: string;
}

/**
 * 建一个 `PENDING_APPROVAL` 修改集，摘要由 `canonicalChangeDigest` 算出。
 *
 * 走**真实仓储** `ChangesRepo.create`，因此不可变触发器、`UNIQUE(seq)`、
 * `UNIQUE(canonical_path_key)` 全部生效。摘要的算法与 `prepare.ts` 一致
 * （同一批字段、同一个函数），因此这里的修改集与生产路径建出来的同构。
 */
function makeChange(seed: string, opts: { readonly afterSize?: number } = {}): ChangeFixture {
  const beforeBytes = `before-${seed}`;
  const afterBytes = `after-${seed}`;
  const beforeSha = fakeSha(`1${seed}`);
  const afterSha = fakeSha(`2${seed}`);
  const afterSize = opts.afterSize ?? afterBytes.length;

  const before = repos.blobs.ensure({
    id: nextId('blob'),
    sha256: beforeSha,
    size: beforeBytes.length,
    storage_ref: `objects/${beforeSha}`,
  }).blob;
  const after = repos.blobs.ensure({
    id: nextId('blob'),
    sha256: afterSha,
    size: afterSize,
    storage_ref: `objects/${afterSha}`,
  }).blob;

  const path = `src/${seed}.ts`;
  const digest = canonicalChangeDigest({
    contract_version: CONTRACT_VERSION,
    policy_version: POLICY_VERSION,
    root_generation: GENERATION,
    workspace_id: WORKSPACE,
    files: [
      {
        path,
        op: 'edit_text',
        before_sha256: beforeSha,
        before_size: beforeBytes.length,
        after_sha256: afterSha,
        after_size: afterSize,
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
      path,
      op: 'edit_text',
      base_file_id: 'file-id-1',
      base_sha256: beforeSha,
      target_sha256: afterSha,
      old_blob_id: before.id,
      new_blob_id: after.id,
      encoding: 'utf-8',
      bom: false,
      newline: 'lf',
      added_lines: 1,
      removed_lines: 1,
    },
  ];

  const change = repos.changes.create({
    id: nextId('chg'),
    owner_connection_id: CONNECTION,
    workspace_id: WORKSPACE,
    root_generation: GENERATION,
    policy_version: POLICY_VERSION,
    contract_version: CONTRACT_VERSION,
    digest,
    summary: `测试摘要 ${seed}`,
    expires_at: new Date(T0_MS + LIMITS.CHANGE_TTL_MS).toISOString(),
    items,
  });

  return {
    change_id: change.id,
    digest,
    before_blob: before.id,
    after_blob: after.id,
    item_id: itemId,
  };
}

/** 当前 `approvals` 表的行数。负向用例的核心断言。 */
function approvalRows(changeId?: string): number {
  const row = (
    changeId === undefined
      ? repos.approvals.listRecent(200)
      : repos.approvals.listForChange(changeId)
  ) as readonly unknown[];
  return row.length;
}

function stateOf(changeId: string): string {
  return repos.changes.requireById(changeId).state;
}

function operationCount(changeId: string): number {
  return repos.operations.findByChangeId(changeId) === null ? 0 : 1;
}

/**
 * 由一条落库的批准记录推出**策略层**应当看到的视图。
 *
 * `state` 原样透传（不做「ACTIVE 但已到期」的投影）：到期这件事要由策略层
 * 与门禁**各自**从 `expires_at` 与 `now` 判出来，共用一次投影会让
 * 「两处是否一致」这个问题失去意义。
 */
function policyViewOf(approval: ApprovalRecord, presentedDigest: string): PolicyApprovalView {
  return {
    state: approval.state,
    change_digest: approval.digest,
    presented_digest: presentedDigest,
    expires_at: Date.parse(approval.expires_at),
  };
}

/**
 * 一次 `change_apply` 的策略判定请求，**除批准外每一层都放行**。
 *
 * 这样构造是为了让 C2 的比对只落在批准这一层：若别处也失败，
 * 比对的就不再是「同一件事在两处的答案」了。
 */
function policyRequestFor(approval: PolicyApprovalView | null, nowMs: number): PolicyRequest {
  return {
    now: nowMs,
    connection: {
      connection_id: CONNECTION,
      enabled: true,
      granted_capabilities: ['propose'],
      audience: 'mcp_adapter',
      granted_workspace_ids: [WORKSPACE],
    },
    workspace: {
      workspace_id: WORKSPACE,
      kind: 'directory',
      mode: 'read_propose_apply_with_local_approval',
      capabilities: {
        read_enabled: true,
        git_enabled: false,
        proposal_enabled: true,
        direct_write_enabled: true,
        recovery_required: false,
      },
      current_generation: GENERATION,
      current_policy_version: POLICY_VERSION,
      root_volume_id: VOLUME,
      root_file_id: 'root-file-id',
      paused: false,
    },
    presented: { generation: GENERATION, policy_version: POLICY_VERSION },
    action: { action: 'change_apply', path: 'src/c2.ts', approval },
  };
}

/**
 * 一次拒绝的具体理由。
 *
 * 断言理由**必须存在**：本任务的每一条拒绝都要能说清是哪一种 ——
 * 「抛了个错」不足以证明「拒绝的是这件事」。
 */
function reasonOf(error: BridgeError): unknown {
  const details = error.details;
  assert.ok(details !== undefined, `BridgeError(${error.code}) 应当带上 details.reason`);
  return details['reason'];
}

/** 捕获一次 `BridgeError`，并断言它确实是本工程错误而不是 TypeError。 */
function catchBridgeError(fn: () => unknown): BridgeError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof BridgeError, `应抛出 BridgeError，实际：${String(caught)}`);
  return caught;
}

before(() => {
  opened = openDatabase({ path: ':memory:' });
  repos = new Repositories(opened.db);
  repos.connections.create({
    id: CONNECTION,
    principal_kind: 'model_surface',
    principal_id: PRINCIPAL,
    alias: '测试连接',
    enabled: true,
  });
  repos.workspaces.create({
    id: WORKSPACE,
    alias: '批准夹具',
    kind: 'directory',
    canonical_root: 'C:\\approvals-fixture',
    volume_id: VOLUME,
    root_file_id: 'root-file-id',
    policy_version: POLICY_VERSION,
    mode: 'read_propose_apply_with_local_approval',
  });
  // 把工作区推到修改集夹具声明的那一代。
  //
  // `GENERATION = 7` 是刻意取的非 1 值：如果夹具用默认的 1，那么
  // 「代次比对」这条断言在**做错事**的时候也会通过 —— 比对写成
  // `workspace.generation !== change.root_generation` 或写成恒真的
  // `1 !== 7` 看不出区别的地方，恰恰是最容易写错的地方。
  // 代价是工作区必须真的处在第 7 代，否则 LWB-024 起门禁会（正确地）拒绝。
  while (repos.workspaces.requireById(WORKSPACE).generation < GENERATION) {
    repos.workspaces.bumpGeneration(WORKSPACE, POLICY_VERSION);
  }
});

after(() => {
  closeDatabase(opened.db);
});

// ---------------------------------------------------------------------------
// A. 重载与重算
// ---------------------------------------------------------------------------

describe('LWB-021 A 重载与重算：批准之前先由落库事实重算摘要', () => {
  it('A1 重算值等于建立时写入的摘要', () => {
    const change = makeChange('a1');
    const loaded = reloadChangeSet(repos, change.change_id);

    assert.equal(loaded.digest, change.digest);
    assert.equal(loaded.change.digest, change.digest);
    assert.equal(loaded.items.length, 1);
    assert.equal(loaded.files.length, 1);
    assert.equal(loaded.files[0]?.path, 'src/a1.ts');
  });

  it('A2 修改集不存在 → CHANGE_NOT_FOUND', () => {
    const error = catchBridgeError(() => reloadChangeSet(repos, 'chg_does_not_exist'));
    assert.equal(error.code, 'CHANGE_NOT_FOUND');
  });

  it('A3 条目被删空 → CHANGE_ITEM_MISSING，且不给出任何摘要', () => {
    const change = makeChange('a3');
    // 条目可以删（不可变触发器只挡 UPDATE），模拟「记录不完整」。
    opened.db.prepare('DELETE FROM change_items WHERE change_id = ?').run(change.change_id);

    const error = catchBridgeError(() => reloadChangeSet(repos, change.change_id));
    assert.equal(error.code, 'CHANGE_STATE_INVALID');
    assert.equal(reasonOf(error), 'CHANGE_ITEM_MISSING');
  });

  it('A4 条目被换掉一个字节 → DIGEST_NOT_REPRODUCIBLE，而不是算出一个新摘要', () => {
    const change = makeChange('a4');
    // 删了重插：`change_items_immutable` 只挡 UPDATE，因此这是能改动条目的路径。
    opened.db.prepare('DELETE FROM change_items WHERE change_id = ?').run(change.change_id);
    opened.db
      .prepare(
        `INSERT INTO change_items
           (id, change_id, seq, op, canonical_path, canonical_path_key, base_file_id, base_sha256,
            target_sha256, old_blob_id, new_blob_id, encoding, bom, newline, created_at,
            added_lines, removed_lines)
         VALUES (?, ?, 0, 'edit_text', 'src/a4.ts', 'src/a4.ts', 'file-id-1', ?, ?, ?, ?,
                 'utf-8', 0, 'lf', ?, 1, 1)`,
      )
      .run(
        nextId('ci'),
        change.change_id,
        fakeSha('1a4'),
        // 只换掉**一个字符**：`f` → `e`。
        `${change.digest.slice(0, 63)}${change.digest.endsWith('f') ? 'e' : 'f'}`,
        change.before_blob,
        change.after_blob,
        T0,
      );

    const error = catchBridgeError(() => reloadChangeSet(repos, change.change_id));
    assert.equal(error.code, 'CHANGE_STATE_INVALID');
    assert.equal(reasonOf(error), 'DIGEST_NOT_REPRODUCIBLE');
  });

  it('A5 被引用的快照行读不到 → BLOB_UNREADABLE（不假设 blob 永不被回收）', () => {
    const change = makeChange('a5');
    // 外键挡住删除，因此临时关掉。关掉的是**这一次测试连接**的开关，
    // 而且是本用例刻意要造的「另一个子系统没有遵守约定」的局面。
    opened.db.pragma('foreign_keys = OFF');
    try {
      opened.db.prepare('DELETE FROM blobs WHERE id = ?').run(change.after_blob);
    } finally {
      opened.db.pragma('foreign_keys = ON');
    }

    const error = catchBridgeError(() => reloadChangeSet(repos, change.change_id));
    assert.equal(error.code, 'CHANGE_STATE_INVALID');
    assert.equal(reasonOf(error), 'BLOB_UNREADABLE');
  });
});

// ---------------------------------------------------------------------------
// B. 决定：批准与拒绝
// ---------------------------------------------------------------------------

describe('LWB-021 B 决定：批准是一次性授权，拒绝是终态', () => {
  it('B1 批准记录身份、连接、根代次、策略版本、摘要、有效期与一次性状态', () => {
    const change = makeChange('b1');
    const approval = approveChange({
      repos,
      change_id: change.change_id,
      digest: change.digest,
      actor: ACTOR,
      now: T0,
    });

    // 步骤 2 的七项逐项核对。
    assert.equal(approval.actor, ACTOR);
    assert.equal(approval.actor_kind, 'local_operator');
    assert.equal(approval.digest, change.digest);
    assert.equal(approval.expires_at, new Date(T0_MS + LIMITS.APPROVAL_TTL_MS).toISOString());
    assert.equal(approval.state, 'ACTIVE');
    assert.equal(approval.root_generation, GENERATION);
    assert.equal(approval.policy_version, POLICY_VERSION);
    assert.equal(approval.consumed_by, null);
    assert.equal(approval.consumed_at, null);

    assert.equal(stateOf(change.change_id), 'APPROVED');
  });

  it('B2 抄本由数据库核对：根代次抄错写不进来', () => {
    const change = makeChange('b2');
    // 绕过仓储直接写一行错的：迁移 v5 的触发器必须挡住它。
    assert.throws(() =>
      opened.db
        .prepare(
          `INSERT INTO approvals
             (id, change_id, digest, actor, actor_kind, expires_at, state,
              root_generation, policy_version, created_at)
           VALUES (?, ?, ?, ?, 'local_operator', ?, 'ACTIVE', ?, ?, ?)`,
        )
        .run(nextId('apr'), change.change_id, change.digest, ACTOR, T0, 999, POLICY_VERSION, T0),
    );
    assert.equal(approvalRows(change.change_id), 0);
  });

  it('B3 提交摘要差一个字符 → 拒绝，且没有留下批准行', () => {
    const change = makeChange('b3');
    const tampered = `${change.digest.slice(0, 63)}${change.digest.endsWith('a') ? 'b' : 'a'}`;
    assert.notEqual(tampered, change.digest);

    const error = catchBridgeError(() =>
      approveChange({
        repos,
        change_id: change.change_id,
        digest: tampered,
        actor: ACTOR,
        now: T0,
      }),
    );
    assert.equal(error.code, 'CHANGE_STATE_INVALID');
    assert.equal(reasonOf(error), 'DIGEST_MISMATCH');
    assert.equal(approvalRows(change.change_id), 0);
    assert.equal(stateOf(change.change_id), 'PENDING_APPROVAL');
  });

  it('B4 篡改一个字符后旧审批失效：A 的批准不能用在 B 上', () => {
    const a = makeChange('b4-a');
    const b = makeChange('b4-b');
    assert.notEqual(a.digest, b.digest);

    approveChange({ repos, change_id: a.change_id, digest: a.digest, actor: ACTOR, now: T0 });

    // 拿着 A 的摘要在 B 上做决定：既不是 B 的重算值，也不等于 B 的落库值。
    const error = catchBridgeError(() =>
      approveChange({ repos, change_id: b.change_id, digest: a.digest, actor: ACTOR, now: T0 }),
    );
    assert.equal(reasonOf(error), 'DIGEST_MISMATCH');
    assert.equal(approvalRows(b.change_id), 0);
    assert.equal(stateOf(b.change_id), 'PENDING_APPROVAL');
  });

  it('B5 第二次批准同一个修改集：状态已不是待决定，一行都没多', () => {
    const change = makeChange('b5');
    approveChange({ repos, change_id: change.change_id, digest: change.digest, actor: ACTOR, now: T0 });
    assert.equal(approvalRows(change.change_id), 1);

    const error = catchBridgeError(() =>
      approveChange({ repos, change_id: change.change_id, digest: change.digest, actor: ACTOR, now: T0 }),
    );
    assert.equal(error.code, 'CHANGE_STATE_INVALID');
    assert.equal(reasonOf(error), 'NOT_AWAITING_DECISION');
    assert.equal(approvalRows(change.change_id), 1);
  });

  it('B6 拒绝是终态，且不写入任何批准记录', () => {
    const change = makeChange('b6');
    const rejected = rejectChange({
      repos,
      change_id: change.change_id,
      digest: change.digest,
      actor: ACTOR,
      now: T0,
    });
    assert.equal(rejected.state, 'REJECTED');
    assert.equal(approvalRows(change.change_id), 0);

    // 拒绝之后不能再批准：终态不可逆。
    const error = catchBridgeError(() =>
      approveChange({ repos, change_id: change.change_id, digest: change.digest, actor: ACTOR, now: T0 }),
    );
    assert.equal(reasonOf(error), 'NOT_AWAITING_DECISION');
    assert.equal(approvalRows(change.change_id), 0);
  });

  it('B7 拒绝也要过同一套前置：摘要不符的拒绝同样被挡下', () => {
    const change = makeChange('b7');
    const error = catchBridgeError(() =>
      rejectChange({
        repos,
        change_id: change.change_id,
        digest: 'f'.repeat(64),
        actor: ACTOR,
        now: T0,
      }),
    );
    assert.equal(reasonOf(error), 'DIGEST_MISMATCH');
    assert.equal(stateOf(change.change_id), 'PENDING_APPROVAL');
  });
});

// ---------------------------------------------------------------------------
// C. 执行前门禁
// ---------------------------------------------------------------------------

describe('LWB-021 C 门禁：只判定，不消费', () => {
  it('C1 没有批准时只得到 APPROVAL_REQUIRED（验收标准 2）', () => {
    const change = makeChange('c1');
    const verdict = evaluateApplyGate({
      repos,
      change_id: change.change_id,
      allowed_from: APPLY_ENTRY_STATES,
      now: T0,
    });

    assert.equal(verdict.kind, 'refused');
    if (verdict.kind !== 'refused') throw new Error('unreachable');
    assert.equal(verdict.code, 'APPROVAL_REQUIRED');
    assert.equal(verdict.reason, 'APPROVAL_MISSING');
    // 拒绝不写任何东西。
    assert.equal(approvalRows(change.change_id), 0);
    assert.equal(stateOf(change.change_id), 'PENDING_APPROVAL');
  });

  it('C2 policy does not add per-change approval after a workspace grant', () => {
    // Exercise legacy approval record states: none of them is a policy permission.
    // The execution package still validates its internal one-time record when
    // claiming an operation; the user-facing authority is the workspace grant.
    const scenarios: readonly {
      readonly name: string;
      /** 判定时刻。省略即 `T0`。 */
      readonly now?: string;
      /** 造出一个历史/内部执行记录视图。 */
      readonly arrange: (changeId: string, digest: string) => PolicyApprovalView | null;
    }[] = [
      {
        name: '从来没有批准过',
        arrange: () => null,
      },
      {
        name: '批准仍然有效',
        arrange: (changeId, digest) => {
          const approval = approveChange({ repos, change_id: changeId, digest, actor: ACTOR, now: T0 });
          return policyViewOf(approval, digest);
        },
      },
      {
        name: '已过期：库里仍是 ACTIVE，只有到期时刻说了算',
        now: T_EXPIRED,
        arrange: (changeId, digest) => {
          const approval = approveChange({ repos, change_id: changeId, digest, actor: ACTOR, now: T0 });
          // 刻意把 `state` 原样传 `ACTIVE`：到期判定要由两个引擎**各自**
          // 从 `expires_at` 与 `now` 得出，而不是共用一次投影。
          return policyViewOf(approval, digest);
        },
      },
      {
        name: '已被消费',
        arrange: (changeId, digest) => {
          const approval = approveChange({ repos, change_id: changeId, digest, actor: ACTOR, now: T0 });
          const operation = repos.operations.create({ id: nextId('op'), change_id: changeId, idempotency_key: null });
          repos.approvals.consume({
            approval_id: approval.id,
            digest,
            operation_id: operation.operation.id,
            now: T0,
          });
          return policyViewOf(repos.approvals.requireById(approval.id), digest);
        },
      },
      {
        name: '已被操作者撤销',
        arrange: (changeId, digest) => {
          const approval = approveChange({ repos, change_id: changeId, digest, actor: ACTOR, now: T0 });
          repos.approvals.revoke(approval.id);
          return policyViewOf(repos.approvals.requireById(approval.id), digest);
        },
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const change = makeChange(`c2-${index}`);
      const now = scenario.now ?? T0;
      const policyView = scenario.arrange(change.change_id, change.digest);

      const decision = decide(policyRequestFor(policyView, Date.parse(now)));
      assert.equal(decision.allow, true, `${scenario.name}: a workspace grant is the policy authorization`);
      assert.deepEqual(decision.failures, []);
      assert.deepEqual(decision.checks.map((check) => check.check), ['connection', 'workspace', 'generation', 'file_rules']);
    }
  });

  it('C3 批准之后门禁放行，摘要取重算值', () => {
    const change = makeChange('c3');
    approveChange({ repos, change_id: change.change_id, digest: change.digest, actor: ACTOR, now: T0 });

    const verdict = evaluateApplyGate({
      repos,
      change_id: change.change_id,
      allowed_from: APPLY_ENTRY_STATES,
      now: T0,
    });
    assert.equal(verdict.kind, 'ready');
    if (verdict.kind !== 'ready') throw new Error('unreachable');
    assert.equal(verdict.digest, change.digest);
    assert.equal(verdict.approval.digest, change.digest);
  });

  it('C4 门禁连跑三次都不消费批准（它是一个判定，不是一个占用）', () => {
    const change = makeChange('c4');
    const approval = approveChange({
      repos,
      change_id: change.change_id,
      digest: change.digest,
      actor: ACTOR,
      now: T0,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const verdict = evaluateApplyGate({
        repos,
        change_id: change.change_id,
        allowed_from: APPLY_ENTRY_STATES,
        now: T0,
      });
      assert.equal(verdict.kind, 'ready', `第 ${attempt + 1} 次判定应当仍然放行`);
    }
    assert.equal(repos.approvals.requireById(approval.id).state, 'ACTIVE');
  });

  it('C5 到期后不放行：判定用的是本次 `now`，不是排队时的结论', () => {
    const change = makeChange('c5');
    approveChange({ repos, change_id: change.change_id, digest: change.digest, actor: ACTOR, now: T0 });

    const verdict = evaluateApplyGate({
      repos,
      change_id: change.change_id,
      allowed_from: APPLY_ENTRY_STATES,
      now: T_EXPIRED,
    });
    assert.equal(verdict.kind, 'refused');
    if (verdict.kind !== 'refused') throw new Error('unreachable');
    assert.equal(verdict.code, 'APPROVAL_EXPIRED');
    assert.equal(verdict.reason, 'APPROVAL_EXPIRED');
  });

  it('C6 已消费的批准不放行，且错误码是 CHANGE_STATE_INVALID 而不是「过期」', () => {
    const change = makeChange('c6');
    const approval = approveChange({
      repos,
      change_id: change.change_id,
      digest: change.digest,
      actor: ACTOR,
      now: T0,
    });
    // 消费必须指向一个**真实存在**的操作（外键），这也正是「批准只能被
    // 一次认领它的执行消耗掉」在结构上的体现：没有操作就没有消费。
    const operation = repos.operations.create({
      id: nextId('op'),
      change_id: change.change_id,
      idempotency_key: null,
    });
    repos.approvals.consume({
      approval_id: approval.id,
      digest: change.digest,
      operation_id: operation.operation.id,
      now: T0,
    });

    const verdict = evaluateApplyGate({
      repos,
      change_id: change.change_id,
      allowed_from: APPLY_ENTRY_STATES,
      now: T0,
    });
    if (verdict.kind !== 'refused') throw new Error('unreachable');
    // 「用过了」与「过期了」的下一步动作不同：前者再去拿一次批准也不会通过。
    assert.equal(verdict.code, 'CHANGE_STATE_INVALID');
    assert.equal(verdict.reason, 'APPROVAL_CONSUMED');
  });

  it('C7 已撤销的批准不放行', () => {
    const change = makeChange('c7');
    const approval = approveChange({
      repos,
      change_id: change.change_id,
      digest: change.digest,
      actor: ACTOR,
      now: T0,
    });
    repos.approvals.revoke(approval.id);

    const verdict = evaluateApplyGate({
      repos,
      change_id: change.change_id,
      allowed_from: APPLY_ENTRY_STATES,
      now: T0,
    });
    if (verdict.kind !== 'refused') throw new Error('unreachable');
    assert.equal(verdict.code, 'APPROVAL_EXPIRED');
    assert.equal(verdict.reason, 'APPROVAL_REVOKED');
  });

  it('C8 修改集状态不在允许来源集合里 → CHANGE_STATE_INVALID', () => {
    const change = makeChange('c8');
    approveChange({ repos, change_id: change.change_id, digest: change.digest, actor: ACTOR, now: T0 });

    // 排队前的入口只接受 APPROVED；执行期的集合里没有它。
    const verdict = evaluateApplyGate({
      repos,
      change_id: change.change_id,
      allowed_from: ['QUEUED', 'VALIDATING', 'APPLYING'],
      now: T0,
    });
    if (verdict.kind !== 'refused') throw new Error('unreachable');
    assert.equal(verdict.code, 'CHANGE_STATE_INVALID');
    assert.equal(verdict.reason, 'CHANGE_STATE_INVALID');
  });

  it('C9 记录自身不一致时不放行，且不把底层文本带出去', () => {
    const change = makeChange('c9');
    approveChange({ repos, change_id: change.change_id, digest: change.digest, actor: ACTOR, now: T0 });
    opened.db.prepare('DELETE FROM change_items WHERE change_id = ?').run(change.change_id);

    const verdict = evaluateApplyGate({
      repos,
      change_id: change.change_id,
      allowed_from: APPLY_ENTRY_STATES,
      now: T0,
    });
    if (verdict.kind !== 'refused') throw new Error('unreachable');
    assert.equal(verdict.code, 'APPROVAL_REQUIRED');
    assert.equal(verdict.reason, 'CHANGE_INTEGRITY');
    // 说明里不得出现任何本机路径或记录细节。
    assert.ok(!verdict.message.includes('change_items'));
    assert.ok(!verdict.message.includes('C:\\'));
  });

  it('C10 有效状态投影：ACTIVE 但已到期读作 EXPIRED，且不写库', () => {
    const change = makeChange('c10');
    const approval = approveChange({
      repos,
      change_id: change.change_id,
      digest: change.digest,
      actor: ACTOR,
      now: T0,
    });

    assert.equal(effectiveApprovalState(approval, T0), 'ACTIVE');
    assert.equal(effectiveApprovalState(approval, T_EXPIRED), 'EXPIRED');
    // 投影只是投影：库里的状态没有被改写。
    assert.equal(repos.approvals.requireById(approval.id).state, 'ACTIVE');
  });
});

// ---------------------------------------------------------------------------
// D. 批准并应用
// ---------------------------------------------------------------------------

describe('LWB-021 D 批准并应用：三件事同生同死', () => {
  it('D1 一次调用产生批准、QUEUED 与唯一操作', () => {
    const change = makeChange('d1');
    const result = approveAndQueue({
      repos,
      change_id: change.change_id,
      digest: change.digest,
      actor: ACTOR,
      now: T0,
      idempotency_key: 'key-d1',
    });

    assert.equal(result.approval.state, 'ACTIVE');
    assert.equal(result.change.state, 'QUEUED');
    assert.equal(result.operation.state, 'QUEUED');
    assert.equal(result.operation.change_id, change.change_id);
    assert.equal(result.operation_existed, false);
    assert.equal(operationCount(change.change_id), 1);
    assert.equal(approvalRows(change.change_id), 1);
  });

  it('D2 重复点击不制造第二次授权执行（验收标准 3）', () => {
    const change = makeChange('d2');
    const first = approveAndQueue({
      repos,
      change_id: change.change_id,
      digest: change.digest,
      actor: ACTOR,
      now: T0,
      idempotency_key: 'key-d2-first',
    });

    // 换一个幂等键再点一次：幂等键不是这条路径的保护，「已经在排队」才是。
    const error = catchBridgeError(() =>
      approveAndQueue({
        repos,
        change_id: change.change_id,
        digest: change.digest,
        actor: ACTOR,
        now: T0,
        idempotency_key: 'key-d2-second',
      }),
    );
    assert.equal(reasonOf(error), 'NOT_AWAITING_DECISION');
    assert.equal(approvalRows(change.change_id), 1);
    assert.equal(operationCount(change.change_id), 1);
    assert.equal(repos.operations.findByChangeId(change.change_id)?.id, first.operation.id);
  });

  it('D3 摘要不符时三件事一件都没发生', () => {
    const change = makeChange('d3');
    const error = catchBridgeError(() =>
      approveAndQueue({
        repos,
        change_id: change.change_id,
        digest: 'a'.repeat(64),
        actor: ACTOR,
        now: T0,
      }),
    );
    assert.equal(reasonOf(error), 'DIGEST_MISMATCH');
    assert.equal(approvalRows(change.change_id), 0);
    assert.equal(operationCount(change.change_id), 0);
    assert.equal(stateOf(change.change_id), 'PENDING_APPROVAL');
  });

  it('D4 批准的摘要等于重算值，短核对编号与之一致', () => {
    const change = makeChange('d4');
    const result = approveAndQueue({
      repos,
      change_id: change.change_id,
      digest: change.digest,
      actor: ACTOR,
      now: T0,
    });
    assert.equal(result.approval.digest, reloadChangeSet(repos, change.change_id).digest);
    assert.equal(shortCodeOf(result.approval.digest), shortCodeOf(change.digest));
  });
});

// ---------------------------------------------------------------------------
// E. 模型侧够不着
// ---------------------------------------------------------------------------

describe('LWB-021 E 批准不可由模型产生（步骤 4）', () => {
  it('E1 mcp-adapter 不具备 approvals.decide，且它列在 NEVER_GRANTED_TO_MODEL 上', () => {
    assert.equal(hasCapability('mcp-adapter', 'approvals.decide'), false);
    assert.ok(NEVER_GRANTED_TO_MODEL.includes('approvals.decide'));
  });

  it('E2 要求 approvals.decide 的控制路由**注册不出来**', () => {
    const table = new ControlRouteTable();
    assert.throws(
      () =>
        table.register({
          method: 'POST',
          path: '/api/approvals/decide',
          // 假如有人把这条能力授予了模型侧，这里就是一个模型可达的控制接口。
          capability: 'tools.read',
          mutating: true,
          handler: () => ({ ok: true }),
        }),
      /已授予 mcp-adapter/,
    );
  });

  it('E3 `change_apply` 的入参 schema 拒绝 approved / force / user_id 等未知字段', () => {
    const schema = TOOL_INPUT_SCHEMAS.change_apply;
    const base = { change_id: 'chg_1', idempotency_key: 'k'.repeat(8) };
    assert.equal(schema.safeParse(base).success, true);

    for (const extra of [
      { approved: true },
      { force: true },
      { user_id: 'u1' },
      { session_id: 's1' },
      { conversation_label: 'x' },
      { principal_id: 'p1' },
    ]) {
      const parsed = schema.safeParse({ ...base, ...extra });
      assert.equal(parsed.success, false, `入参 ${JSON.stringify(extra)} 必须被拒绝`);
    }
  });

  it('E4 批准类名字是控制面方法：不可能作为工具挂出去', () => {
    for (const name of ['approval.grant', 'approval.revoke', 'change.reject']) {
      assert.equal(isControlPlaneName(name), true, `${name} 应当被认作控制面方法`);
      // 因此它也不可能是工具名：`TOOL_NAMES` 与 `CONTROL_PLANE_ROUTES` 不相交，
      // 而工具面只挂 `TOOL_NAMES` 里的名字。
      assert.equal(isToolName(name), false, `${name} 不应当是工具名`);
    }

    // 适配器侧真实存在的那道断言：即使 daemon 的清单被改坏、把一个控制面
    // 方法报成「可用」，适配器也必须**拒绝装配工具面**而不是把它挂出去。
    const forged = {
      tools: [{ name: 'approval.grant', available: true, reason: null }],
    } as unknown as ToolCatalogResult;
    assert.throws(() => resolveSurface(forged), SurfaceMismatchError);
  });

  it('E5 三个控制操作都被显式分类（漏一个就装配失败）', () => {
    const classified = new Set([...MUTATING_OPERATIONS, ...READ_ONLY_OPERATIONS]);
    for (const name of APPROVAL_OPERATION_NAMES) {
      assert.ok(classified.has(name), `${name} 必须被分类为变更类或只读类`);
    }
    assert.ok(MUTATING_OPERATIONS.includes('approvals.reject'));
    assert.ok(MUTATING_OPERATIONS.includes('approvals.approve_and_apply'));
    assert.ok(READ_ONLY_OPERATIONS.includes('approvals.list'));
  });

  it('E6 控制台身份之外不产生批准；入参里的身份字段不被读取', () => {
    const change = makeChange('e6');
    const registry = new OperationRegistry();
    registerApprovalOperations(registry, { repos, now: () => T0 });

    const definition = registry.lookup('approvals.approve_and_apply');
    assert.ok(definition, 'approvals.approve_and_apply 应当已注册');

    // 伪装成模型侧的请求：身份是 mcp-adapter，参数里塞满身份字段。
    const error = catchBridgeError(() =>
      (definition.handler as (input: unknown, context: unknown) => unknown)(
        {
          change_id: change.change_id,
          digest: change.digest,
          approved: true,
          user_id: 'u1',
          session_id: 's1',
          conversation_label: '信任我',
          principal_id: 'p1',
        },
        { audience: 'mcp-adapter', connection_id: 'conn_model', pid: 1, request_id: 'req_1' },
      ),
    );
    assert.equal(error.code, 'NOT_AUTHORIZED');
    assert.equal(reasonOf(error), 'ORIGIN_NOT_LOCAL');

    // 关键断言：那些字段**一个也没被读** —— 没有批准，没有状态流转。
    assert.equal(approvalRows(change.change_id), 0);
    assert.equal(stateOf(change.change_id), 'PENDING_APPROVAL');
  });
});

describe('LWB-021 F 控制操作处理器：整条路径跑得通（含审计写入）', () => {
  /**
   * 这一组存在的原因是**一次真事故**：`recordDecision` 把 `short_code` /
   * `state` / `decision_by` / `approval_id` / `operation_id` /
   * `operation_existed` 交给 `screenMetadata`，而那份键名白名单里一个都没有。
   * 于是**每一次**批准都在「决定已经落库、审计写不进去」的地方抛出一个
   * 普通 `Error`，被服务器折成 500 `INTERNAL_ERROR`。
   *
   * 它逃过了 A–E 的全部用例，因为那些用例直接调 `approveAndQueue` /
   * `rejectChange`（`@lwb/approvals`），从不经过控制操作处理器 ——
   * 而白名单只在处理器这一层被过。E6 是唯一一个调处理器的用例，
   * 而它期望的正是被拒，因此在 `requireLocalConsole` 就返回了。
   *
   * 教训写在断言里：**每个处理器的成功路径都要真的走一遍**。
   * 状态已经是「已批准、已排队」而接口报 500，是这里最坏的结果 ——
   * 操作者会去重点，而队列里已经有一条了。
   */
  function consoleContext(requestId: string): RequestContext {
    return { audience: 'console', connection_id: ACTOR, pid: 4242, request_id: requestId };
  }

  function callHandler(
    registry: OperationRegistry,
    name: string,
    input: unknown,
    context: RequestContext,
  ): Record<string, unknown> {
    const definition = registry.lookup(name);
    assert.ok(definition, `${name} 应当已注册`);
    return definition.handler(input, context) as Record<string, unknown>;
  }

  function handlerRegistry(): OperationRegistry {
    const registry = new OperationRegistry();
    registerApprovalOperations(registry, { repos, now: () => T0 });
    return registry;
  }

  it('F1 `approvals.approve_and_apply` 成功返回，且审计行确实写进去了', () => {
    const change = makeChange('f1');
    const registry = handlerRegistry();
    const requestId = 'req_handler_f1';

    const result = callHandler(
      registry,
      'approvals.approve_and_apply',
      { change_id: change.change_id, digest: change.digest },
      consoleContext(requestId),
    );

    assert.equal(result['state'], 'QUEUED');
    assert.equal(result['workspace_modified'], false);
    assert.equal(typeof result['approval_id'], 'string');
    assert.equal(typeof result['operation_id'], 'string');
    assert.equal(stateOf(change.change_id), 'QUEUED');
    assert.equal(approvalRows(change.change_id), 1);

    // 审计：一次决定必须留下**一行**，且它的 metadata 是白名单放行的那些事实。
    const events = repos.audit.findByRequestId(requestId);
    assert.equal(events.length, 1, '批准决定应当留下恰好一条审计事件');
    const event = events[0];
    assert.ok(event);
    assert.equal(event.action, 'change.approve_and_apply');
    assert.equal(event.outcome, 'allow');
    assert.equal(event.connection_id, ACTOR);
    assert.equal(event.subject, change.change_id);

    const metadata = event.metadata as Record<string, unknown>;
    assert.equal(metadata['short_code'], shortCodeOf(change.digest));
    assert.equal(metadata['change_state'], 'QUEUED');
    assert.equal(metadata['approval_id'], result['approval_id']);
    assert.equal(metadata['operation_id'], result['operation_id']);
    assert.equal(metadata['operation_existed'], false);
    // 决定者只在 `connection_id` 列上，**不**在 metadata 里再放一份。
    assert.equal(metadata['decision_by'], undefined);
    // 完整摘要不进审计：审计回答「哪一次决定」，不回答「哪一份内容」。
    assert.equal(metadata['digest'], undefined);
    assert.ok(!JSON.stringify(metadata).includes(change.digest));
  });

  it('F2 `approvals.reject` 成功返回，审计同样写得进去', () => {
    const change = makeChange('f2');
    const registry = handlerRegistry();
    const requestId = 'req_handler_f2';

    const result = callHandler(
      registry,
      'approvals.reject',
      { change_id: change.change_id, digest: change.digest },
      consoleContext(requestId),
    );

    assert.equal(result['state'], 'REJECTED');
    assert.equal(stateOf(change.change_id), 'REJECTED');
    assert.equal(approvalRows(change.change_id), 0);

    const events = repos.audit.findByRequestId(requestId);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.action, 'change.reject');
    assert.equal((events[0]?.metadata as Record<string, unknown>)['change_state'], 'REJECTED');
  });

  it('F3 `approvals.list` 是只读的：调用它不写任何一行（含审计）', () => {
    makeChange('f3');
    const registry = handlerRegistry();
    const requestId = 'req_handler_f3';

    const listed = callHandler(registry, 'approvals.list', { limit: 10 }, consoleContext(requestId));

    assert.equal(listed['observed_at'], T0);
    assert.ok(Array.isArray(listed['approvals']));
    assert.deepEqual(repos.audit.findByRequestId(requestId), []);
  });

  it('F4 `approvals.list` 如实回报「批准还在、目标已排队」的组合', () => {
    const approved = makeChange('f4');
    const registry = handlerRegistry();
    callHandler(
      registry,
      'approvals.approve_and_apply',
      { change_id: approved.change_id, digest: approved.digest },
      consoleContext('req_handler_f4a'),
    );

    const listed = callHandler(registry, 'approvals.list', {}, consoleContext('req_handler_f4b')) as {
      readonly approvals: readonly Record<string, unknown>[];
    };
    const entry = listed.approvals.find((row) => row['change_id'] === approved.change_id);
    assert.ok(entry, '已批准的修改集应当出现在 list 里');
    assert.equal(entry['state'], 'ACTIVE');
    assert.equal(entry['stored_state'], 'ACTIVE');
    assert.equal(entry['change_state'], 'QUEUED');
    // 批准的身份是控制台会话，不是任何入参。
    assert.equal(entry['actor'], ACTOR);
  });
});
