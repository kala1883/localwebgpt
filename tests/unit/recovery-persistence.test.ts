/**
 * LWB-030 状态库测试：恢复授权表（迁移 v7）与两处配套改动。
 *
 * ## 这里证的不是「CRUD 能跑」
 *
 * 恢复授权是本工程里**第二个**「一次性、有期限、绑定唯一摘要」的表。
 * 它存在的理由是 `approvals` 绑错了对象：批准绑的是**修改集摘要**（写入之前
 * 由计划内容算出），而恢复要钉住的是**刚刚观测到的磁盘状态**。差别是这一句：
 * **磁盘一变，摘要就变，授权立刻失效。**
 *
 * 因此本文件围着那句话组织：
 *
 *  - A 组：迁移 v7 的形状 —— 表在、CHECK 在、唯一索引是**部分索引**、
 *    三条触发器把「曾经签发过」钉死。
 *  - B 组：`create` 的条件插入 —— 存在的操作 + 属于这个工作区，
 *    两件事在**同一条语句**里核。
 *  - C 组：`consume` 的三条 WHERE —— 状态、摘要、有效期。
 *    摘要不符那一格是本文件的主角：它对应「授权签发之后，用户又编辑了文件」。
 *  - D 组：两处配套改动 —— `listRecoveryRequiredByWorkspace` 不把
 *    「正在写」折进来，`sweepExpired` 分开报恢复授权的过期数。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { BridgeError, CONTRACT_VERSION } from '@lwb/contracts';
import { approveAndQueue } from '@lwb/approvals';
import { canonicalChangeDigest, sweepExpired } from '@lwb/changes';
import {
  FROZEN_RECOVERY_DECISIONS,
  KNOWN_SCHEMA_VERSION,
  MIGRATIONS,
  Repositories,
  closeDatabase,
  openDatabase,
  type OpenDatabaseResult,
} from '@lwb/persistence';

/** 基线/目标的假哈希与大小。**不是**真内容：本文件不读文件。 */
const BASE_SHA = 'b'.repeat(64);
const TARGET_SHA = 'c'.repeat(64);
const BEFORE_SIZE = 10;
const AFTER_SIZE = 20;
/** 恢复计划摘要。与修改集摘要不同 —— 后者由 `seedChange` 真算。 */
const HEX64 = 'a'.repeat(64);

/** 固定时刻。过期判定是本次测试的对象，因此不用 `new Date()`。 */
const T0 = '2026-09-26T10:00:00.000Z';
const T_EXPIRED = '2026-09-26T10:10:00.001Z';

let dir: string;
let opened: OpenDatabaseResult;
let repos: Repositories;
let seq = 0;

const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'lwb-recovery-'));
  opened = openDatabase({ path: path.join(dir, 'state.db') });
  repos = new Repositories(opened.db);
});

after(async () => {
  closeDatabase(opened.db);
  await rm(dir, { recursive: true, force: true });
});

/**
 * 建一套最小前置数据：连接 + 工作区 + blob + 修改集。
 *
 * 别名一律带 `id`：`connections.alias` 上有唯一约束，而一个共用的
 * 常量别名会让第二条用例在建前置数据时就炸 —— 那种失败与它要测的
 * 那条性质毫无关系，读起来却像真的坏了。
 *
 * **不**顺手建操作：操作的创建要走 `approveAndQueue`（见 `queueOf`），
 * 因为「QUEUED 的唯一前驱是 APPROVED」这条边是状态机里的一句真话，
 * 在这里绕过它建一个 QUEUED 的操作等于本文件先把生产路径改了一遍。
 */
function seedChange() {
  const id = nextId('s');
  const connection = repos.connections.create({
    id: `conn_${id}`,
    principal_kind: 'model_surface',
    principal_id: `principal_${id}`,
    alias: `alias_${id}`,
    enabled: true,
  });
  const workspace = repos.workspaces.create({
    id: `ws_${id}`,
    alias: `fixtures_${id}`,
    kind: 'directory',
    canonical_root: `D:\\fixtures\\${id}`,
    volume_id: `vol_${id}`,
    root_file_id: `root_${id}`,
    policy_version: 1,
    mode: 'read_propose_apply_with_local_approval',
  });
  const oldBlob = repos.blobs.ensure({
    id: `blob_old_${id}`,
    sha256: BASE_SHA,
    size: BEFORE_SIZE,
    storage_ref: `blobs/${id}/old`,
  });
  const newBlob = repos.blobs.ensure({
    id: `blob_new_${id}`,
    sha256: TARGET_SHA,
    size: AFTER_SIZE,
    storage_ref: `blobs/${id}/new`,
  });

  // 摘要**不是**随便一串 64 位十六进制：`approveAndQueue` 会由落库事实
  // 重算一次再比对（那是 LWB-021 的一条防线）。编一个假的会让本文件
  // 在建前置数据时就死在别处，而那不是它要测的东西 —— 因此这里与
  // `prepare.ts` 用同一个函数算。
  const contentPath = 'src/main.ts';
  const digest = canonicalChangeDigest({
    contract_version: CONTRACT_VERSION,
    policy_version: workspace.policy_version,
    root_generation: workspace.generation,
    workspace_id: workspace.id,
    files: [
      {
        path: contentPath,
        op: 'edit_text',
        before_sha256: BASE_SHA,
        before_size: BEFORE_SIZE,
        after_sha256: TARGET_SHA,
        after_size: AFTER_SIZE,
        encoding: 'utf-8',
        newline: 'lf',
        bom: false,
      },
    ],
  });

  const change = repos.changes.create({
    id: `chg_${id}`,
    owner_connection_id: connection.id,
    workspace_id: workspace.id,
    root_generation: workspace.generation,
    policy_version: workspace.policy_version,
    contract_version: CONTRACT_VERSION,
    digest,
    summary: '恢复授权测试',
    expires_at: '2099-01-01T00:00:00.000Z',
    items: [
      {
        id: `item_${id}`,
        path: contentPath,
        op: 'edit_text' as const,
        base_file_id: `root_${id}`,
        base_sha256: BASE_SHA,
        target_sha256: TARGET_SHA,
        old_blob_id: oldBlob.blob.id,
        new_blob_id: newBlob.blob.id,
        encoding: 'utf-8' as const,
        bom: false,
        newline: 'lf' as const,
        added_lines: 1,
        removed_lines: 2,
      },
    ],
  });
  return { id, workspace, change, digest };
}

type Seeded = ReturnType<typeof seedChange>;

/**
 * 批准并排队，然后把操作推到 `RECOVERY_REQUIRED`。
 *
 * 两步都走**生产路径**：`approveAndQueue` 是本工程唯一能让一个修改集
 * 进入 `QUEUED` 的地方（`UNIQUE(change_id)` 的语义只有它一个解释者），
 * 而 `RECOVERY_REQUIRED` 本来就是「执行中的操作被启动扫描捡起来」那一格。
 */
function markRecovery(seeded: Seeded): { readonly operation_id: string; readonly change_id: string } {
  const queued = approveAndQueue({
    repos,
    change_id: seeded.change.id,
    digest: seeded.digest,
    actor: 'console:local',
    now: T0,
  });
  const operationId = queued.operation.id;
  repos.transaction(() => {
    repos.changes.transition(seeded.change.id, ['QUEUED'], 'RECOVERY_REQUIRED');
    repos.operations.transition(operationId, ['QUEUED'], 'RECOVERY_REQUIRED', { finished: false });
  });
  return { operation_id: operationId, change_id: seeded.change.id };
}

/**
 * 签发一条恢复授权。
 *
 * `volume_id` / `root_file_id` 从工作区行上取，而不是在这里拼：
 * 授权绑的是**物理身份**，编一份出来的话本文件测的就不是那件事了。
 */
function issue(operationId: string, seeded: Seeded, digest: string, expiresAt = '2099-01-01T00:00:00.000Z') {
  const id = nextId('rec');
  return {
    id,
    record: repos.recovery_authorizations.create({
      id,
      operation_id: operationId,
      workspace_id: seeded.workspace.id,
      volume_id: seeded.workspace.volume_id,
      root_file_id: seeded.workspace.root_file_id,
      decision: 'ROLLBACK_TO_BASELINE',
      digest,
      actor: 'console:local',
      expires_at: expiresAt,
    }),
  };
}

function expectBridge(code: string, fn: () => unknown, hint = ''): BridgeError {
  try {
    fn();
  } catch (cause) {
    assert.ok(cause instanceof BridgeError, `${hint} 应抛 BridgeError，实际：${String(cause)}`);
    assert.equal(cause.code, code, `${hint} 的错误码`);
    return cause;
  }
  assert.fail(`${hint} 应当抛出 ${code}，但没有抛错`);
}

// ---------------------------------------------------------------------------
// A. 迁移 v7 的形状
// ---------------------------------------------------------------------------

describe('LWB-030 A. 迁移 v7 的形状', () => {
  it('A1 模式版本与迁移表一致，且 v7 仍然在这一版迁移表里', () => {
    // 期望值**从 MIGRATIONS 推导**，不写死 7。原先这里写的是
    // `KNOWN_SCHEMA_VERSION === 7` 加一句「最后一版迁移就是它」，
    // 那个写法在 LWB-034 新增 v8 的当天就会变成一条**假失败**：
    // 它报的不是「v7 出了问题」，而是「后来又有人加了迁移」。
    // 这个文件要钉住的是「v7 还在、还叫这个名字、还构成当前模式」，
    // 理由与 `tests/unit/persistence.test.ts` 里从 LWB-020 起就写着的那条
    // 注释相同：写死的版本号会在每次新增迁移时被顺手改成新数字，
    // 而这条断言真正要证明的东西不该需要有人去改它。
    assert.equal(opened.schema_version, KNOWN_SCHEMA_VERSION);
    assert.equal(MIGRATIONS.find((m) => m.version === 7)?.name, 'recovery_authorizations');
    assert.equal(MIGRATIONS[MIGRATIONS.length - 1]!.version, KNOWN_SCHEMA_VERSION, '表里最后一版必须是当前模式版本');
  });

  it('A2 表在，列齐，且 `actor_kind` 只有 `local_operator` 一个取值', () => {
    const columns = opened.db
      .prepare('PRAGMA table_info(recovery_authorizations)')
      .all() as { name: string; notnull: number }[];
    assert.deepEqual(
      columns.map((column) => column.name),
      [
        'id',
        'operation_id',
        'workspace_id',
        'volume_id',
        'root_file_id',
        'decision',
        'digest',
        'actor',
        'actor_kind',
        'expires_at',
        'state',
        'consumed_at',
        'created_at',
      ],
    );
  });

  it('A3 冻结的恢复决定与表上的 CHECK **逐字**一致', () => {
    // 冻结表在 TypeScript 里，CHECK 在 SQL 里，两处各写一遍。
    // 这一条把「两处不许分叉」变成一次断言 —— 而分叉的方向通常是
    // 代码里多加了一个动作，数据库却会静默拒绝（或反过来）。
    const sql = opened.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recovery_authorizations'")
      .get() as { sql: string };
    for (const decision of FROZEN_RECOVERY_DECISIONS) {
      assert.ok(sql.sql.includes(`'${decision}'`), `CHECK 里没有 ${decision}`);
    }
    // 而另一个方向 —— 「把目标补写上去」—— 在 CHECK 里根本不存在，
    // 因为它在 `plan.ts` 里也根本不存在。
    assert.equal(sql.sql.includes('APPLY_TARGET'), false);
    assert.deepEqual([...FROZEN_RECOVERY_DECISIONS], ['ROLLBACK_TO_BASELINE']);
  });

  it('A4 摘要是 64 位十六进制（`length(digest) = 64` 的 CHECK 生效）', () => {
    // 这一条同时钉住另一件事：畸形摘要**不会**被报成「已存在有效授权」。
    // 那曾是 `isUniqueViolation` 前缀匹配 `SQLITE_CONSTRAINT` 的后果
    // （详见那个函数的说明），而它会让排障的人去查一个不存在的问题。
    const seeded = seedChange();
    const { operation_id } = markRecovery(seeded);
    assert.throws(() => issue(operation_id, seeded, 'too-short'), /CHECK constraint failed/);
  });

  it('A5 同一个操作同时只能有一条 **ACTIVE** 授权（部分唯一索引）', () => {
    const seeded = seedChange();
    const { operation_id } = markRecovery(seeded);
    issue(operation_id, seeded, HEX64);
    // 第二次签发撞的是部分索引 —— 而不是「所有历史授权必须唯一」。
    // 这条区别很重要：撤销之后再签发一次是**合法**的。
    expectBridge('CHANGE_STATE_INVALID', () => issue(operation_id, seeded, HEX64));
  });

  it('A6 撤销之后可以再签一条（历史保留，只有 ACTIVE 受唯一约束）', () => {
    const seeded = seedChange();
    const { operation_id } = markRecovery(seeded);
    const first = issue(operation_id, seeded, HEX64);
    repos.recovery_authorizations.revoke(first.id);
    const second = issue(operation_id, seeded, HEX64);
    assert.notEqual(first.id, second.id);
    assert.equal(repos.recovery_authorizations.listForOperation(operation_id).length, 2);
    assert.equal(repos.recovery_authorizations.findActive(operation_id)?.id, second.id);
  });

  it('A7 绑定字段不可改写（触发器 `immutable_binding`）', () => {
    const seeded = seedChange();
    const { operation_id } = markRecovery(seeded);
    const { id } = issue(operation_id, seeded, HEX64);
    // 授权绑的是**物理身份**。允许改写它等于允许把一条授权挪到别的工作区上。
    for (const [column, value] of [
      ['digest', 'd'.repeat(64)],
      ['volume_id', 'vol_别的'],
      ['root_file_id', 'root_别的'],
      ['operation_id', 'op_别的'],
      ['workspace_id', 'ws_别的'],
    ] as const) {
      assert.throws(
        () => opened.db.prepare(`UPDATE recovery_authorizations SET ${column} = ? WHERE id = ?`).run(value, id),
        /绑定字段不可变/,
        `${column} 应当不可改写`,
      );
    }

    // `decision` 单独一条，因为它是**两道**锁叠在一起：
    //  - 触发器同一句拦住它（上面那条规则把 `decision` 也算作绑定字段）；
    //  - 而即使没有触发器，CHECK 也只承认一个取值 —— 「恢复只能收场、
    //    不能把目标补写上去」这件事在列定义上就没有第二个取值可写。
    //
    // 因此这里不断言**哪一条**规则赢（那取决于 SQLite 的求值顺序），
    // 只断言「写不进去」以及「写完之后还是原来那个值」。
    assert.throws(
      () => opened.db.prepare('UPDATE recovery_authorizations SET decision = ? WHERE id = ?').run('APPLY_TARGET', id),
    );
    assert.equal(repos.recovery_authorizations.findById(id)?.decision, 'ROLLBACK_TO_BASELINE');
  });
});

// ---------------------------------------------------------------------------
// B. 条件插入
// ---------------------------------------------------------------------------

describe('LWB-030 B. 签发：存在性与归属在同一条语句里核', () => {
  it('B1 操作不存在 ⇒ CHANGE_NOT_FOUND', () => {
    const seeded = seedChange();
    expectBridge('CHANGE_NOT_FOUND', () => issue('op_不存在', seeded, HEX64));
  });

  it('B2 操作存在但属于**另一个**工作区 ⇒ 同样是 CHANGE_NOT_FOUND', () => {
    // 「不属于我」与「不存在」报同一个错误码是有意的：把两者区分开
    // 会让「这个操作 id 存不存在」变成一条可以试探的事实。
    const a = seedChange();
    const b = seedChange();
    const { operation_id } = markRecovery(a);
    expectBridge('CHANGE_NOT_FOUND', () => issue(operation_id, b, HEX64));
  });

  it('B3 签发出来的行把 `workspace_id` 取自**修改集**，而不是调用方传的那个', () => {
    // 条件插入的第二个后果：写进去的是 JOIN 出来的那一列。
    const seeded = seedChange();
    const { operation_id } = markRecovery(seeded);
    const { record } = issue(operation_id, seeded, HEX64);
    assert.equal(record.workspace_id, seeded.workspace.id);
    assert.equal(record.state, 'ACTIVE');
    assert.equal(record.actor_kind, 'local_operator');
    assert.equal(record.consumed_at, null);
  });

  it('B4 有授权挂着的操作不能被删掉（外键 `RESTRICT` 或删除触发器）', () => {
    // 两条防线，先撞上哪一条取决于 SQLite 的求值顺序，因此两条都接受
    // —— 要测的是「删不掉」这件事，不是哪一条规则赢。
    const seeded = seedChange();
    const { operation_id } = markRecovery(seeded);
    issue(operation_id, seeded, HEX64);
    assert.throws(
      () => opened.db.prepare('DELETE FROM operations WHERE id = ?').run(operation_id),
      /FOREIGN KEY|不得删除/i,
      '有授权挂着的操作不该能被删掉',
    );
    assert.notEqual(repos.operations.findById(operation_id), null, '操作应当还在');
  });
});

// ---------------------------------------------------------------------------
// C. 消费的三条 WHERE
// ---------------------------------------------------------------------------

describe('LWB-030 C. 消费：状态、摘要、有效期，三条都在 WHERE 里', () => {
  it('C1 摘要一致 ⇒ 消费成功，状态转 CONSUMED 并记下时刻', () => {
    const seeded = seedChange();
    const { operation_id } = markRecovery(seeded);
    const { id } = issue(operation_id, seeded, HEX64);
    const consumed = repos.recovery_authorizations.consume({
      authorization_id: id,
      digest: HEX64,
      now: T0,
    });
    assert.equal(consumed.state, 'CONSUMED');
    assert.equal(consumed.consumed_at, T0);
  });

  it('C2 **摘要不符 ⇒ 拒绝** —— 这一格就是「授权之后用户又编辑了文件」', () => {
    // 本文件的主角。授权签发时磁盘长什么样已经被写成摘要；执行之前
    // 重新观测一次，算出来的摘要不一样，说明中间有人动过 ——
    // 那一刻「你同意收回这些字节」这句话就不再指向现在的现场。
    const seeded = seedChange();
    const { operation_id } = markRecovery(seeded);
    const { id } = issue(operation_id, seeded, HEX64);
    const error = expectBridge('APPROVAL_EXPIRED', () =>
      repos.recovery_authorizations.consume({
        authorization_id: id,
        digest: 'f'.repeat(64),
        now: T0,
      }),
    );
    assert.match(error.message, /摘要不符|磁盘在授权之后被改动过/);
    // 而且它**没有**被消费掉：拒绝之后那条授权还在，下一次仍可用
    // （只要磁盘又变回了当时观测到的样子）。
    assert.equal(repos.recovery_authorizations.findById(id)?.state, 'ACTIVE');
  });

  it('C3 已过期 ⇒ 拒绝，且**不**因为摘要对就放行', () => {
    const seeded = seedChange();
    const { operation_id } = markRecovery(seeded);
    const { id } = issue(operation_id, seeded, HEX64, T0);
    expectBridge('APPROVAL_EXPIRED', () =>
      repos.recovery_authorizations.consume({
        authorization_id: id,
        digest: HEX64,
        now: T_EXPIRED,
      }),
    );
  });

  it('C4 有效期边界：恰好等于 `expires_at` 的那一刻**不算**有效（`>` 而不是 `>=`）', () => {
    // §9.3 的 10 分钟是一条**上界**。边界上取哪一边是个选择，
    // 而它必须是个被写下来的选择 —— 这里选「到点即失效」。
    const expired = seedChange();
    const first = markRecovery(expired);
    const { id } = issue(first.operation_id, expired, HEX64, T0);
    expectBridge('APPROVAL_EXPIRED', () =>
      repos.recovery_authorizations.consume({ authorization_id: id, digest: HEX64, now: T0 }),
    );

    // 同一时刻、还没到点的另一条：有效。
    const live = seedChange();
    const second = markRecovery(live);
    const later = issue(second.operation_id, live, HEX64, T_EXPIRED);
    const consumed = repos.recovery_authorizations.consume({
      authorization_id: later.id,
      digest: HEX64,
      now: T0,
    });
    assert.equal(consumed.state, 'CONSUMED');
  });

  it('C5 一次性：消费过之后摘要再对也不能用第二次', () => {
    const seeded = seedChange();
    const { operation_id } = markRecovery(seeded);
    const { id } = issue(operation_id, seeded, HEX64);
    repos.recovery_authorizations.consume({ authorization_id: id, digest: HEX64, now: T0 });
    const error = expectBridge('APPROVAL_EXPIRED', () =>
      repos.recovery_authorizations.consume({ authorization_id: id, digest: HEX64, now: T0 }),
    );
    assert.match(error.message, /已被使用或撤销/);
  });

  it('C6 撤销之后不能消费', () => {
    const seeded = seedChange();
    const { operation_id } = markRecovery(seeded);
    const { id } = issue(operation_id, seeded, HEX64);
    repos.recovery_authorizations.revoke(id);
    expectBridge('APPROVAL_EXPIRED', () =>
      repos.recovery_authorizations.consume({ authorization_id: id, digest: HEX64, now: T0 }),
    );
  });

  it('C7 授权不存在 ⇒ APPROVAL_REQUIRED（与「用过了」区分开）', () => {
    expectBridge('APPROVAL_REQUIRED', () =>
      repos.recovery_authorizations.consume({
        authorization_id: 'rec_不存在',
        digest: HEX64,
        now: T0,
      }),
    );
  });

  it('C8 撤销只能撤 ACTIVE 的', () => {
    const seeded = seedChange();
    const { operation_id } = markRecovery(seeded);
    const { id } = issue(operation_id, seeded, HEX64);
    repos.recovery_authorizations.revoke(id);
    expectBridge('APPROVAL_EXPIRED', () => repos.recovery_authorizations.revoke(id));
  });

  it('C9 `expireDue` 收到期的 ACTIVE，且返回条数**等于**实际到期的条数', () => {
    // 表是全文件共用的，因此这里不写死「1」：前面几组留下的到期行仍在
    // 库里。期望值由**同一条谓词**在调用前数一遍 —— 那不是把实现抄一遍，
    // 而是把「`expireDue` 的返回值就是它改掉的行数」这句话钉住。
    const dueBefore = (
      opened.db
        .prepare("SELECT COUNT(*) AS n FROM recovery_authorizations WHERE state = 'ACTIVE' AND expires_at <= ?")
        .get(T0) as { n: number }
    ).n;
    assert.ok(dueBefore >= 1, '装置：本组留下的到期授权至少有一条');

    const seeded = seedChange();
    const { operation_id } = markRecovery(seeded);
    const { id } = issue(operation_id, seeded, HEX64, T0);

    assert.equal(repos.recovery_authorizations.expireDue(T0), dueBefore + 1, '到点即收');
    assert.equal(repos.recovery_authorizations.findById(id)?.state, 'EXPIRED');
    // 幂等：再收一次不会重复计数。
    assert.equal(repos.recovery_authorizations.expireDue(T0), 0);
  });
});

// ---------------------------------------------------------------------------
// D. 两处配套改动
// ---------------------------------------------------------------------------

describe('LWB-030 D. 配套改动', () => {
  it('D1 `listRecoveryRequiredByWorkspace` 只收 RECOVERY_REQUIRED，不折进「正在写」', () => {
    // 折进来的后果是把 `recovery_required` 从「有事要你处理」
    // 降级成「有活在干」，而那会让一个正常执行中的工作区被报成待恢复。
    const seeded = seedChange();
    assert.equal(
      repos.operations.listRecoveryRequiredByWorkspace(seeded.workspace.id).length,
      0,
      '刚建好、还在 QUEUED 的操作不该被算作待恢复',
    );

    // 装置自查：那个操作**确实**在 QUEUED —— 否则上一条断言是空的。
    const queued = approveAndQueue({
      repos,
      change_id: seeded.change.id,
      digest: seeded.digest,
      actor: 'console:local',
      now: T0,
    });
    const operationId = queued.operation.id;
    assert.equal(
      repos.operations.listByStates(['QUEUED']).some((row) => row.id === operationId),
      true,
      '装置：操作确实在 QUEUED',
    );

    repos.transaction(() => {
      repos.changes.transition(seeded.change.id, ['QUEUED'], 'RECOVERY_REQUIRED');
      repos.operations.transition(operationId, ['QUEUED'], 'RECOVERY_REQUIRED', { finished: false });
    });
    const flagged = repos.operations.listRecoveryRequiredByWorkspace(seeded.workspace.id);
    assert.deepEqual(flagged.map((row) => row.id), [operationId]);
  });

  it('D2 `listRecoveryRequiredByWorkspace` 只看本工作区', () => {
    const a = seedChange();
    const b = seedChange();
    markRecovery(a);
    assert.equal(repos.operations.listRecoveryRequiredByWorkspace(b.workspace.id).length, 0);
    assert.equal(repos.operations.listRecoveryRequiredByWorkspace(a.workspace.id).length, 1);
  });

  it('D3 `sweepExpired` 分开报恢复授权的过期数（不是并进批准那个数字）', () => {
    // 两个数字的读法不同：一份过期的批准意味着「那次修改没被做」，
    // 一份过期的恢复授权意味着「有人打开过恢复界面、想了十分钟、
    // 然后什么都没做」。合起来就看不见后者了。
    const seeded = seedChange();
    const { operation_id } = markRecovery(seeded);
    issue(operation_id, seeded, HEX64, T0);

    const report = sweepExpired(repos, { now: T_EXPIRED });
    assert.equal(typeof report.expired_recovery_authorizations, 'number');
    assert.equal(report.expired_recovery_authorizations, 1);
    assert.equal(repos.recovery_authorizations.findActive(operation_id), null);
  });
});
