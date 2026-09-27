/**
 * LWB-022 单元测试（二）：标识符、唯一操作的收敛，与「未知不是失败」。
 *
 * ## 三条验收标准分别落在哪
 *
 *  1. 「并发重复调用收敛到同一操作」——B 组。**本文件只能覆盖它的顺序部分**：
 *     `better-sqlite3` 是同步的，同一进程里造不出两个真正并行的写事务。
 *     这里证明的是「第二次调用在**任何写入之前**就失败」与「唯一索引那条
 *     残余路径拿到的是同一个操作」。真正的两连接并发在
 *     `scripts/evidence/lwb-022.ts` 里做（那里有文件库）。
 *     把顺序的当成并发的会是一次**假通过**，因此这里写在明处。
 *  2. 「不可从终态倒退到可再次执行状态」——`tests/unit/change-state-machine.test.ts`。
 *  3. 「所有未知结果都可以用 operation_id 查询，不要求重新发同一写任务」——C 组。
 *     这一条的实现方式是**签名**：`queryOperation` 只收 `operation_id`，
 *     因此「查询需要幂等键」这种退化在类型上就写不出来。C1 把这一点钉住。
 *
 * ## 为什么标识符要单独测
 *
 * `ids.ts` 的品牌是**类型层面**的保证，运行期什么都不做。因此它的测试必须
 * 同时有两条腿：运行期那条测「同一个字符串被解析出来之后确实还是那个字符串」，
 * 编译期那条用 `@ts-expect-error` 钉住「品牌之间不可互赋」。少了后者，
 * 整个文件里最核心的那句话就没有任何东西在验证 —— 品牌类型被改成
 * 普通 `string` 也别无用例变红。
 * `@ts-expect-error` 的方向是反的：注释在那儿而**代码不再报错**时，
 * `tsc` 才会失败。也就是说它挡的是「保证被悄悄删掉」。
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { BridgeError, CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import {
  FROZEN_ITEM_RESULT_STATES,
  Repositories,
  closeDatabase,
  openDatabase,
} from '@lwb/persistence';
import type { ChangeItemInput, OpenDatabaseResult } from '@lwb/persistence';

/**
 * 逐文件结果的状态类型。**从真实 API 推出来**，不另抄一份联合类型 ——
 * 抄一份的话，D10 核对的就是「我抄的那份」，而不是仓储层允许写入的那些。
 */
type ItemResultState = Parameters<Repositories['operations']['setItemResult']>[0]['state'];
import { canTransition, transitionChange } from '@lwb/changes';
import {
  IDENTIFIER_ROLES,
  OUTCOME_POLICY,
  asChangeId,
  asIdempotencyKey,
  asOperationId,
  asRequestId,
  classifyOperation,
  inFlightKeyCount,
  queryOperation,
  queueOperation,
  requireOperationId,
  withIdempotencyLock,
} from '@lwb/idempotency';
import type { ChangeId, OperationId, OperationOutcomeKind } from '@lwb/idempotency';

// ---------------------------------------------------------------------------
// 类型层的钉子（运行期不执行，由 `tsc --noEmit` 核对）
// ---------------------------------------------------------------------------

/**
 * 四个品牌互不可赋。
 *
 * 这几条是本文件里唯一能验证「标识符不会传错地方」的东西 ——
 * 运行期它们全都是字符串，`assert.equal` 分辨不出来。
 *
 * ## 品牌挡不住什么（写在这里，免得被当成挡住了）
 *
 * `as*` 四个解析函数的入参是 `unknown`（它们必须如此：未受信的输入进来时
 * 就是一个不知道类型的东西）。因此 `asChangeId(someOperationId)` **可以**
 * 编译通过 —— 品牌挡住的是**隐式**赋值，不是**显式**重新贴标签。
 * 这是有意的取舍：显式那一步会把函数名摆在那里（`asChangeId` 就是一句
 * 「我声称这是个 change id」），在评审里看得见，而隐式赋值看不出来。
 */
const sampleKey = asIdempotencyKey('idem-key-0001');
// @ts-expect-error 幂等键不得当作操作编号使用（这正是「拿键去查询」的写法）
const keyAsOperationId: OperationId = sampleKey;
// @ts-expect-error 普通字符串不能直接当操作编号，必须先过解析函数
const rawAsOperationId: OperationId = 'op_0001';
// @ts-expect-error 操作编号不得当作修改集编号使用
const operationIdAsChangeId: ChangeId = asOperationId('op_0001');

/**
 * 验收标准 3 的**签名级**钉子：`queryOperation` 只有两个入参。
 *
 * 多出一个必填参数（比如「把幂等键也带上」）会让这一行编译不过 ——
 * 而那种改动恰好会把「未知结果可以用 operation_id 查询」退化成
 * 「查询要求调用方记得别的东西」。
 */
const queryArity: Parameters<typeof queryOperation>['length'] = 2;

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CONNECTION = 'conn_idem';
const WORKSPACE = 'ws_idem';
const PRINCIPAL = 'principal_idem';
const VOLUME = 'vol-idem';
const GENERATION = 1;
const POLICY_VERSION = 1;
const T0_MS = Date.parse('2026-09-25T10:00:00.000Z');

let opened: OpenDatabaseResult;
let repos: Repositories;
let seq = 0;

const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;

const fakeSha = (seed: string): string =>
  seed
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, 'a');

/** 建一个 `PENDING_APPROVAL` 修改集，走真实仓储（表与触发器都是真的）。 */
function makeChange(seed: string): string {
  const beforeSha = fakeSha(`1${seed}`);
  const afterSha = fakeSha(`2${seed}`);
  const before = repos.blobs.ensure({
    id: nextId('blob'),
    sha256: beforeSha,
    size: 10,
    storage_ref: `objects/${beforeSha}`,
  }).blob;
  const after = repos.blobs.ensure({
    id: nextId('blob'),
    sha256: afterSha,
    size: 11,
    storage_ref: `objects/${afterSha}`,
  }).blob;

  const items: ChangeItemInput[] = [
    {
      id: nextId('ci'),
      path: `src/${seed}.ts`,
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

  return repos.changes.create({
    id: nextId('chg'),
    owner_connection_id: CONNECTION,
    workspace_id: WORKSPACE,
    root_generation: GENERATION,
    policy_version: POLICY_VERSION,
    contract_version: CONTRACT_VERSION,
    digest: fakeSha(`d${seed}`),
    summary: `幂等夹具 ${seed}`,
    expires_at: new Date(T0_MS + LIMITS.CHANGE_TTL_MS).toISOString(),
    items,
  }).id;
}

/** 建一个已经批准、可以排队的修改集。 */
function makeApproved(seed: string): string {
  const changeId = makeChange(seed);
  transitionChange(repos, { change_id: changeId, from: ['PENDING_APPROVAL'], to: 'APPROVED' });
  return changeId;
}

const operationIdOf = (changeId: string): string | null =>
  repos.operations.findByChangeId(changeId)?.id ?? null;

const operationCount = (changeId: string): number => (operationIdOf(changeId) === null ? 0 : 1);

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

const reasonOf = (error: BridgeError): unknown => (error.details ?? {})['reason'];

before(() => {
  opened = openDatabase({ path: ':memory:' });
  repos = new Repositories(opened.db);
  repos.connections.create({
    id: CONNECTION,
    principal_kind: 'model_surface',
    principal_id: PRINCIPAL,
    alias: '幂等夹具',
    enabled: true,
  });
  repos.workspaces.create({
    id: WORKSPACE,
    alias: '幂等夹具',
    kind: 'directory',
    canonical_root: 'C:\\idempotency-fixture',
    volume_id: VOLUME,
    root_file_id: 'root-file-id',
    policy_version: POLICY_VERSION,
    mode: 'read_propose_apply_with_local_approval',
  });
});

after(() => {
  closeDatabase(opened.db);
});

// ---------------------------------------------------------------------------
// A. 标识符
// ---------------------------------------------------------------------------

describe('LWB-022 A 四种标识符：解析边界与「不可互赋」', () => {
  it('A1 品牌在运行期就是字符串，解析不改变值', () => {
    // 这一条同时说明为什么必须有 A2：运行期分辨不出这四个东西。
    assert.equal(sampleKey, 'idem-key-0001');
    assert.equal(typeof sampleKey, 'string');
    assert.equal(keyAsOperationId, 'idem-key-0001');
    assert.equal(rawAsOperationId.length, 7);
    assert.equal(operationIdAsChangeId, 'op_0001');
    assert.equal(queryArity, 2);
  });

  it('A2 幂等键的长度范围取自 LIMITS，与工具 schema 同源', () => {
    const shortest = 'a'.repeat(LIMITS.MIN_IDEMPOTENCY_KEY_CHARS);
    assert.equal(asIdempotencyKey(shortest), shortest);

    const tooShort = 'a'.repeat(LIMITS.MIN_IDEMPOTENCY_KEY_CHARS - 1);
    const error = catchBridgeError(() => asIdempotencyKey(tooShort));
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.equal(reasonOf(error), 'IDEMPOTENCY_KEY_TOO_SHORT');

    const tooLong = 'a'.repeat(LIMITS.MAX_IDEMPOTENCY_KEY_CHARS + 1);
    assert.equal(reasonOf(catchBridgeError(() => asIdempotencyKey(tooLong))), 'IDENTIFIER_TOO_LONG');
  });

  it('A3 空值、非字符串与控制字符一律拒绝，且理由分得清是哪一种', () => {
    // 「理由必须存在」在本工程是硬要求：只说「参数不对」不足以让排障的人
    // 知道该去查调用方还是查输入。
    assert.equal(
      reasonOf(catchBridgeError(() => asOperationId(''))),
      'IDENTIFIER_EMPTY',
    );
    for (const bad of [undefined, null, 42, {}, []]) {
      const error = catchBridgeError(() => asOperationId(bad));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(reasonOf(error), 'IDENTIFIER_NOT_A_STRING', `${String(bad)} 应当是「不是字符串」`);
    }
    // 换行与 NUL 的后果不是「难看」：`prepare` 的单飞锁键是三段 `\u0000` 拼接，
    // 而审计行按行读取 —— 一个含换行的 id 会让一个标识符变成两条记录。
    for (const bad of ['a\nb', 'a\u0000b', 'a\rb', 'a\u007fb']) {
      const error = catchBridgeError(() => asChangeId(bad));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(reasonOf(error), 'IDENTIFIER_CONTROL_CHARS');
    }
  });

  it('A4 四个解析函数都拒绝超过 200 字符的值', () => {
    const long = 'x'.repeat(201);
    for (const parse of [asChangeId, asOperationId, asRequestId]) {
      assert.equal(reasonOf(catchBridgeError(() => parse(long))), 'IDENTIFIER_TOO_LONG');
      assert.equal(parse(long.slice(0, 200)), long.slice(0, 200));
    }
  });

  it('A5 四个标识符在角色表里各有说法，没有一个是「不知道用它干嘛」', () => {
    assert.deepEqual(Object.keys(IDENTIFIER_ROLES).sort(), [
      'change_id',
      'idempotency_key',
      'operation_id',
      'request_id',
    ]);
    for (const description of Object.values(IDENTIFIER_ROLES)) {
      assert.ok(description.length > 0);
    }
  });

  it('A6 查询前的形状门：空串与空白串被拒，且理由是专用码', () => {
    for (const bad of ['', '   ', '\t', undefined, null, 7]) {
      const error = catchBridgeError(() => requireOperationId(bad));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(reasonOf(error), 'OPERATION_ID_REQUIRED');
    }
    assert.equal(requireOperationId('op_ok'), 'op_ok');
  });
});

// ---------------------------------------------------------------------------
// B. 唯一操作：收敛
// ---------------------------------------------------------------------------

describe('LWB-022 B 验收标准 1：同一个修改集只有一个操作', () => {
  it('B1 第一次排队：状态推进、操作创建、existed 为假', () => {
    const changeId = makeApproved('b1');
    const result = queueOperation(repos, {
      change_id: asChangeId(changeId),
      from: ['APPROVED'],
      idempotency_key: 'idem-b1-first',
      new_operation_id: () => nextId('op'),
    });

    assert.equal(result.existed, false);
    assert.equal(result.change.state, 'QUEUED');
    assert.equal(repos.changes.requireById(changeId).state, 'QUEUED');
    assert.equal(result.operation.change_id, changeId);
    assert.equal(result.operation.state, 'QUEUED');
    assert.equal(result.operation.idempotency_key, 'idem-b1-first');
    assert.equal(operationCount(changeId), 1);
  });

  it('B2 换一个幂等键再排一次：被拒绝，且没有第二个操作', () => {
    // 方案 §7 的原话：「相同 change_id 无论几个 apply 键，只关联一个 operation」。
    // 因此这里故意换键 —— 换键是**合法**的重试方式，换来第二个操作不是。
    const changeId = makeApproved('b2');
    const first = queueOperation(repos, {
      change_id: asChangeId(changeId),
      from: ['APPROVED'],
      idempotency_key: 'idem-b2-first',
      new_operation_id: () => nextId('op'),
    });

    const error = catchBridgeError(() =>
      queueOperation(repos, {
        change_id: asChangeId(changeId),
        from: ['APPROVED'],
        idempotency_key: 'idem-b2-second',
        new_operation_id: () => nextId('op'),
      }),
    );

    // 失败发生在**任何写入之前**：图检查过了（APPROVED → QUEUED 是合法边），
    // 挡下来的是仓储层的条件写 —— 行此刻已经是 QUEUED。
    assert.equal(error.code, 'CHANGE_STATE_INVALID');
    const details = error.details as Record<string, unknown>;
    assert.equal(details['current_state'], 'QUEUED');
    assert.equal(operationCount(changeId), 1);
    assert.equal(operationIdOf(changeId), first.operation.id);
    assert.equal(repos.changes.requireById(changeId).state, 'QUEUED');
  });

  it('B3 用同一个幂等键重试：拿到同一个操作', () => {
    const changeId = makeApproved('b3');
    const first = queueOperation(repos, {
      change_id: asChangeId(changeId),
      from: ['APPROVED'],
      idempotency_key: 'idem-b3',
      new_operation_id: () => nextId('op'),
    });
    const error = catchBridgeError(() =>
      queueOperation(repos, {
        change_id: asChangeId(changeId),
        from: ['APPROVED'],
        idempotency_key: 'idem-b3',
        new_operation_id: () => nextId('op'),
      }),
    );
    assert.equal(error.code, 'CHANGE_STATE_INVALID');
    assert.equal(operationIdOf(changeId), first.operation.id);
    assert.equal(repos.operations.listUnfinished().filter((o) => o.change_id === changeId).length, 1);
  });

  it('B4 残余路径：状态检查被绕过时，唯一索引仍然只留下一个操作', () => {
    // 造出那唯一的组合：操作已经存在，而修改集还在 APPROVED
    // （V1 没有任何一条正常路径会这样，正是为了覆盖「绕过」这一分支）。
    const changeId = makeApproved('b4');
    const preExisting = repos.operations.create({
      id: nextId('op'),
      change_id: changeId,
      idempotency_key: 'idem-b4-orphan',
    });
    assert.equal(preExisting.kind, 'created');

    const result = queueOperation(repos, {
      change_id: asChangeId(changeId),
      from: ['APPROVED'],
      idempotency_key: 'idem-b4-retry',
      new_operation_id: () => nextId('op'),
    });

    // 返回的是**既有的**那一个，而不是新建的 —— 并且这不是异常。
    assert.equal(result.existed, true);
    assert.equal(result.operation.id, preExisting.operation.id);
    assert.equal(result.change.state, 'QUEUED');
    assert.equal(operationCount(changeId), 1);
  });

  it('B5 不同来源状态的声明走不同的边，图检查先于条件写', () => {
    const changeId = makeApproved('b5');
    // 声明一个**图里没有**的来源：`PENDING_APPROVAL → QUEUED` 不是一条边。
    const error = catchBridgeError(() =>
      queueOperation(repos, {
        change_id: asChangeId(changeId),
        from: ['PENDING_APPROVAL'],
        new_operation_id: () => nextId('op'),
      }),
    );
    assert.equal(reasonOf(error), 'ILLEGAL_EDGE');
    assert.equal(canTransition('PENDING_APPROVAL', 'QUEUED'), false);
    // 图检查在条件写之前：没有任何写入发生，也没有操作被创建。
    assert.equal(operationCount(changeId), 0);
    assert.equal(repos.changes.requireById(changeId).state, 'APPROVED');
  });

  it('B6 幂等键只是记账，不参与「要不要新建操作」的判定', () => {
    // 两个修改集用**同一个**幂等键：它们仍然是两个不同的操作。
    // 若键参与了判定，这里会退化成「第二个修改集排不上队」。
    const a = makeApproved('b6a');
    const b = makeApproved('b6b');
    const resultA = queueOperation(repos, {
      change_id: asChangeId(a),
      from: ['APPROVED'],
      idempotency_key: 'idem-shared',
      new_operation_id: () => nextId('op'),
    });
    const resultB = queueOperation(repos, {
      change_id: asChangeId(b),
      from: ['APPROVED'],
      idempotency_key: 'idem-shared',
      new_operation_id: () => nextId('op'),
    });
    assert.notEqual(resultA.operation.id, resultB.operation.id);
    assert.equal(resultA.operation.idempotency_key, 'idem-shared');
    assert.equal(resultB.operation.idempotency_key, 'idem-shared');
  });

  it('B7 不传幂等键也可以排队（键是可选的记账字段）', () => {
    const changeId = makeApproved('b7');
    const result = queueOperation(repos, {
      change_id: asChangeId(changeId),
      from: ['APPROVED'],
      new_operation_id: () => nextId('op'),
    });
    assert.equal(result.operation.idempotency_key, null);
    assert.equal(operationCount(changeId), 1);
  });
});

// ---------------------------------------------------------------------------
// C. 验收标准 3：只靠 operation_id 查询
// ---------------------------------------------------------------------------

describe('LWB-022 C 验收标准 3：未知结果可用 operation_id 查询', () => {
  it('C1 查询签名里只有 operation_id 一个业务入参', () => {
    assert.equal(queryArity, 2, 'queryOperation 只应有 (repos, operation_id) 两个入参');
  });

  it('C2 排队中的操作：IN_PROGRESS，且明确要求用 operation_id 查询', () => {
    const changeId = makeApproved('c2');
    const queued = queueOperation(repos, {
      change_id: asChangeId(changeId),
      from: ['APPROVED'],
      new_operation_id: () => nextId('op'),
    });

    const queried = queryOperation(repos, asOperationId(queued.operation.id));
    assert.equal(queried.found, true);
    assert.equal(queried.outcome.kind, 'IN_PROGRESS');
    assert.equal(queried.outcome.saved, false);
    assert.equal(queried.outcome.file_effect, 'unknown');
    assert.equal(queried.outcome.must_query_by_operation_id, true);
    assert.equal(queried.change?.id, changeId);
    assert.deepEqual(
      queried.items.map((item) => item.item_id),
      [],
      '还没开始写，逐文件结果应当为空',
    );
  });

  it('C3 查一个不存在的 operation_id：不抛错，答案是 UNKNOWN', () => {
    // 抛错会让「你抄错了 id」与「它真的不存在」在调用方看来是同一件事，
    // 而前者是排障、后者是排障，两者都不该让调用方去**重发一次写任务**。
    const queried = queryOperation(repos, asOperationId('op_does_not_exist'));
    assert.equal(queried.found, false);
    assert.equal(queried.operation, null);
    assert.equal(queried.change, null);
    assert.equal(queried.outcome.kind, 'UNKNOWN');
    assert.equal(queried.outcome.must_query_by_operation_id, true);
    assert.equal(queried.outcome.operation_id, null);
  });

  it('C4 查询带回逐文件结果与追加日志', () => {
    const changeId = makeApproved('c4');
    const queued = queueOperation(repos, {
      change_id: asChangeId(changeId),
      from: ['APPROVED'],
      new_operation_id: () => nextId('op'),
    });
    const operationId = queued.operation.id;
    const itemId = repos.changes.items(changeId)[0]?.id ?? '';
    assert.ok(itemId.length > 0, '夹具应当有一个逐文件项');

    repos.operations.setItemResult({
      operation_id: operationId,
      item_id: itemId,
      state: 'VERIFIED',
      before_sha256: fakeSha('b'),
      after_sha256: fakeSha('a'),
    });
    repos.journal.append({ operation_id: operationId, stage: 'intent', item_id: itemId });
    repos.journal.append({ operation_id: operationId, stage: 'verified', item_id: itemId });

    const queried = queryOperation(repos, asOperationId(operationId));
    assert.equal(queried.items.length, 1);
    assert.equal(queried.items[0]?.state, 'VERIFIED');
    assert.deepEqual(
      queried.journal.map((entry) => entry.stage),
      ['intent', 'verified'],
    );
    assert.equal(queried.journal[0]?.seq, 0);
    assert.equal(queried.operation_id, operationId);
  });

  it('C5 查询是只读的：查两次不会改变任何状态', () => {
    const changeId = makeApproved('c5');
    const queued = queueOperation(repos, {
      change_id: asChangeId(changeId),
      from: ['APPROVED'],
      new_operation_id: () => nextId('op'),
    });
    const before = repos.operations.requireById(queued.operation.id).state;
    queryOperation(repos, asOperationId(queued.operation.id));
    queryOperation(repos, asOperationId(queued.operation.id));
    assert.equal(repos.operations.requireById(queued.operation.id).state, before);
    assert.equal(operationCount(changeId), 1);
  });
});

// ---------------------------------------------------------------------------
// D. 未知不是失败
// ---------------------------------------------------------------------------

/** 一段不带操作的判定输入。 */
const NO_OPERATION = { operation: null, items: [] } as const;

describe('LWB-022 D 判定七种答案：未知不得被读成成功或失败', () => {
  it('D1 每种答案都有策略，且策略表覆盖全集', () => {
    const kinds: readonly OperationOutcomeKind[] = [
      'IN_PROGRESS',
      'APPLIED',
      'FAILED_NO_CHANGE',
      'CONFLICT',
      'ROLLED_BACK',
      'NEEDS_RECOVERY',
      'UNKNOWN',
    ];
    assert.deepEqual(Object.keys(OUTCOME_POLICY).sort(), [...kinds].sort());

    // 只有 APPLIED 敢说「已保存」—— 方案 §8.1 要求它必须带核验回执。
    for (const kind of kinds) {
      assert.equal(
        OUTCOME_POLICY[kind].saved,
        kind === 'APPLIED',
        `${kind} 的 saved 只能是 ${kind === 'APPLIED'}`,
      );
    }
    // 说「不知道」的那三种必须把调用方推向查询，而不是重发。
    for (const kind of ['IN_PROGRESS', 'NEEDS_RECOVERY', 'UNKNOWN'] as const) {
      assert.equal(OUTCOME_POLICY[kind].must_query_by_operation_id, true);
      assert.equal(OUTCOME_POLICY[kind].file_effect, 'unknown');
    }
    for (const kind of ['FAILED_NO_CHANGE', 'CONFLICT', 'ROLLED_BACK'] as const) {
      assert.equal(OUTCOME_POLICY[kind].file_effect, 'unchanged');
      assert.equal(OUTCOME_POLICY[kind].must_query_by_operation_id, false);
    }
  });

  it('D2 没有操作记录 → UNKNOWN（不是失败）', () => {
    const outcome = classifyOperation(NO_OPERATION);
    assert.equal(outcome.kind, 'UNKNOWN');
    assert.equal(outcome.saved, false);
    assert.equal(outcome.operation_id, null);
  });

  it('D3 QUEUED / VALIDATING / APPLYING → IN_PROGRESS', () => {
    for (const state of ['QUEUED', 'VALIDATING', 'APPLYING'] as const) {
      const outcome = classifyOperation({
        operation: operationWithState(state),
        items: [],
      });
      assert.equal(outcome.kind, 'IN_PROGRESS', `${state} 应当是进行中`);
    }
  });

  it('D4 APPLIED 且每个文件都有回执 → 唯一可以说「已保存」的一种', () => {
    for (const receipt of ['VERIFIED', 'RECOVERED_TARGET'] as const) {
      const outcome = classifyOperation({
        operation: operationWithState('APPLIED'),
        items: [{ item_id: 'ci_1', state: receipt }],
      });
      assert.equal(outcome.kind, 'APPLIED', `${receipt} 也是回执`);
      assert.equal(outcome.saved, true);
      assert.equal(outcome.file_effect, 'changed');
      assert.equal(outcome.verified_items, 1);
    }
  });

  it('D5 APPLIED 但没有任何逐文件回执 → 降级为 UNKNOWN', () => {
    // 「操作说成功」不算证据。没有回执的成功是**没有证据的成功**。
    const outcome = classifyOperation({ operation: operationWithState('APPLIED'), items: [] });
    assert.equal(outcome.kind, 'UNKNOWN');
    assert.equal(outcome.saved, false);
  });

  it('D6 APPLIED 但有一个文件没回执 → NEEDS_RECOVERY', () => {
    const outcome = classifyOperation({
      operation: operationWithState('APPLIED'),
      items: [
        { item_id: 'ci_1', state: 'VERIFIED' },
        { item_id: 'ci_2', state: 'PENDING' },
      ],
    });
    assert.equal(outcome.kind, 'NEEDS_RECOVERY');
    assert.equal(outcome.saved, false);
    assert.equal(outcome.verified_items, 1);
  });

  it('D7 RECOVERED_ORIGINAL **不算**回执（它与「已应用」直接矛盾）', () => {
    const outcome = classifyOperation({
      operation: operationWithState('APPLIED'),
      items: [{ item_id: 'ci_1', state: 'RECOVERED_ORIGINAL' }],
    });
    assert.equal(outcome.kind, 'NEEDS_RECOVERY');
    assert.equal(outcome.verified_items, 0);
  });

  it('D8 逐文件的「不知道」压过操作自己的结论 —— 包括 APPLIED', () => {
    // 这一条是整份文件里最重要的一条：事实（这个文件现在是什么）
    // 比结论（操作说它成功了）更值得信。
    const outcome = classifyOperation({
      operation: operationWithState('APPLIED'),
      items: [
        { item_id: 'ci_1', state: 'VERIFIED' },
        { item_id: 'ci_2', state: 'UNKNOWN' },
      ],
    });
    assert.equal(outcome.kind, 'NEEDS_RECOVERY');
    assert.equal(outcome.saved, false);
    assert.equal(outcome.file_effect, 'unknown');
    assert.deepEqual(outcome.unknown_items, ['ci_2']);
    assert.equal(outcome.must_query_by_operation_id, true);
  });

  it('D9 RECOVERY_REQUIRED → NEEDS_RECOVERY；三种「已确认没改」原样透传', () => {
    assert.equal(
      classifyOperation({ operation: operationWithState('RECOVERY_REQUIRED'), items: [] }).kind,
      'NEEDS_RECOVERY',
    );
    for (const state of ['FAILED_NO_CHANGE', 'CONFLICT', 'ROLLED_BACK'] as const) {
      const outcome = classifyOperation({ operation: operationWithState(state), items: [] });
      assert.equal(outcome.kind, state);
      assert.equal(outcome.file_effect, 'unchanged');
    }
  });

  it('D10 判定用的是逐文件结果的真实枚举，不是自造的字面量', () => {
    // 夹具里出现的每个逐文件状态都必须来自冻结枚举 ——
    // 否则这些用例测的是「我编的那个字符串」，而不是迁移 v1 允许的那些。
    for (const state of ['VERIFIED', 'RECOVERED_TARGET', 'RECOVERED_ORIGINAL', 'UNKNOWN', 'PENDING']) {
      assert.ok(
        FROZEN_ITEM_RESULT_STATES.includes(state as ItemResultState),
        `${state} 必须来自 FROZEN_ITEM_RESULT_STATES`,
      );
    }
  });
});

/**
 * 造一条**只用于判定**的操作记录。
 *
 * 不落库：`classifyOperation` 是纯函数，它的入参只需要形状对。
 * 落库反而会让 D 组依赖夹具的额外字段，把「判定」与「建记录」两件事
 * 混在一起 —— 而 B/C 组已经用真实记录覆盖了后者。
 */
function operationWithState(state: string): Parameters<typeof classifyOperation>[0]['operation'] {
  return {
    id: 'op_pure',
    change_id: 'chg_pure',
    state,
    idempotency_key: null,
    worker_instance: null,
    recovered: false,
    started_at: null,
    finished_at: null,
    created_at: '2026-09-25T10:00:00.000Z',
  } as Parameters<typeof classifyOperation>[0]['operation'];
}

// ---------------------------------------------------------------------------
// E. 单飞锁
// ---------------------------------------------------------------------------

describe('LWB-022 E 单飞锁：同一个键不并发跑两次', () => {
  it('E1 同一个键的任务串行，不同键的可以并行', async () => {
    const order: string[] = [];
    const tick = async (): Promise<void> => {
      await new Promise((resolve) => setImmediate(resolve));
    };

    const scope = (key: string) => ({ principal_id: PRINCIPAL, tool: 'change_prepare', key });

    const a = withIdempotencyLock(scope('k-e1-same'), async () => {
      order.push('a-start');
      await tick();
      order.push('a-end');
      return 'a';
    });
    const b = withIdempotencyLock(scope('k-e1-same'), async () => {
      order.push('b-start');
      await tick();
      order.push('b-end');
      return 'b';
    });
    // 不同键：不应当被前面那个挡住。
    const c = withIdempotencyLock(scope('k-e1-other'), async () => {
      order.push('c');
      return 'c';
    });

    await Promise.all([a, b, c]);
    assert.deepEqual(order, ['a-start', 'c', 'a-end', 'b-start', 'b-end']);
  });

  it('E2 同一个键的第三次调用排在第二次之后，不会插队', async () => {
    const order: number[] = [];
    const scope = { principal_id: PRINCIPAL, tool: 'change_prepare', key: 'k-e2' };
    const task = (n: number) => async (): Promise<void> => {
      order.push(n);
      await new Promise((resolve) => setImmediate(resolve));
    };
    await Promise.all([
      withIdempotencyLock(scope, task(1)),
      withIdempotencyLock(scope, task(2)),
      withIdempotencyLock(scope, task(3)),
    ]);
    assert.deepEqual(order, [1, 2, 3]);
  });

  it('E3 前一个任务抛错不会卡住后面的（链上两个 handler 都要接）', async () => {
    const scope = { principal_id: PRINCIPAL, tool: 'change_prepare', key: 'k-e3' };
    const failed = withIdempotencyLock(scope, async () => {
      throw new BridgeError('INTERNAL_ERROR', '故意的失败');
    });
    await assert.rejects(failed);

    // 若链上只接了 resolve，这一次会永远挂住 —— 用一个真实的返回值证明它没有。
    const after = await withIdempotencyLock(scope, async () => 'ok');
    assert.equal(after, 'ok');
  });

  it('E4 锁不会泄漏：跑完之后在途键数回到原值', async () => {
    const before = inFlightKeyCount();
    const scope = { principal_id: PRINCIPAL, tool: 'change_prepare', key: 'k-e4' };
    await Promise.all([
      withIdempotencyLock(scope, async () => 1),
      withIdempotencyLock(scope, async () => 2),
    ]);
    assert.equal(inFlightKeyCount(), before);
  });

  it('E5 键的域包含 principal 与 tool：同键不同调用方互不影响', async () => {
    // 锁键是三段拼接（`principal \\u0000 tool \\u0000 key`）。少了前两段，
    // 两个不同调用方用同一个键会互相阻塞 —— 而它们的幂等记录本来就不共享。
    const order: string[] = [];
    const task = (label: string) => async (): Promise<void> => {
      order.push(`${label}-start`);
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`${label}-end`);
    };
    await Promise.all([
      withIdempotencyLock({ principal_id: 'p1', tool: 'change_prepare', key: 'same' }, task('p1')),
      withIdempotencyLock({ principal_id: 'p2', tool: 'change_prepare', key: 'same' }, task('p2')),
    ]);
    assert.deepEqual(order, ['p1-start', 'p2-start', 'p1-end', 'p2-end']);
  });

  it('E6 `@lwb/idempotency` 再导出的是**同一个**函数对象', async () => {
    // 「一个实现、一个导入面」：若哪天有人在本包里重写一份锁，
    // 这里会变红 —— 而两份锁各自宣称同一句保证，是这一条要防的事。
    const changes = await import('@lwb/changes');
    assert.equal(withIdempotencyLock, changes.withIdempotencyLock);
    assert.equal(inFlightKeyCount, changes.inFlightKeyCount);
  });
});
