/**
 * LWB-032 回执的**折叠规则**：从两个来源（逐文件回执行 / 执行日志）
 * 算出一次应用的逐文件结论。
 *
 * ## 为什么这一层值得单独测
 *
 * 真盘用例（`tests/windows/daemon-apply-tool.test.ts`）只能证明
 * 「这一次」对不对：它跑一次成功写入，看到 `VERIFIED` 与两个真哈希。
 * 而回执要回答的是**每一种终局**，其中大多数在真盘上根本造不出来
 * （要造一次「写了一半、回滚也失败了」，得让护栏在指定的那一刻坏掉）。
 * 折错的方向只有两种，而两种都很贵：
 *
 *  - 把「账目对不上」折成 `VERIFIED` ⇒ 回执宣称文件已保存，而盘上不是；
 *  - 把「不确定」折成 `FAILED` ⇒ 叫人去处理一件可能已经成功的事。
 *
 * 因此这一层用合成日志穷举组合，只留一组用真 SQLite 验「读回来的确实是
 * 那几行」，与 `tests/unit/executor-journal.test.ts` 的分工完全一致。
 *
 * ## 本文件里最要紧的一条
 *
 * **不认识的阶段名必须折成「不知道」**（`UNKNOWN` + `RECEIPT_INCOMPLETE`）。
 * 跨版本那一格不是假想：恢复流程（`@lwb/recovery`）往同一张表里写另一套
 * 词。把「我不认识」读成「什么都没发生」，会让一条待恢复的操作在回执里
 * 显示成写成功了 —— 方向必须是 fail-closed。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { canBeginWrite } from '@lwb/executor';
import { EXECUTION_JOURNAL_STAGES } from '../../packages/changes/src/execution-journal.ts';
import { operationReceiptFor } from '@lwb/changes';
import type { OperationFileResult } from '@lwb/contracts';
import { CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { OpenDatabaseResult } from '@lwb/persistence';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const T0 = '2026-09-26T00:00:00.000Z';
const ROOT = path.join('D:', 'lwb-receipt-sandbox', 'workspace');
const CONNECTION = 'conn_receipt';
const WORKSPACE = 'ws_receipt';
const POLICY_VERSION = 1;
const MODE = 'read_propose_apply_with_local_approval';
const BASE = 'a'.repeat(64);
const TARGET = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);

let opened: OpenDatabaseResult | undefined;
let repos: Repositories;
let seq = 0;
const nextId = (prefix: string): string => `${prefix}_${(seq += 1)}`;

before(() => {
  opened = openDatabase({ path: ':memory:' });
  repos = new Repositories(opened.db, () => T0);
  repos.connections.create({
    id: CONNECTION,
    principal_kind: 'model_surface',
    principal_id: 'principal_receipt',
    alias: '回执测试连接',
    enabled: true,
  });
  repos.workspaces.create({
    id: WORKSPACE,
    alias: '回执测试工作区',
    kind: 'directory',
    canonical_root: ROOT,
    volume_id: 'vol_receipt',
    root_file_id: 'dir-root',
    policy_version: POLICY_VERSION,
    mode: MODE,
  });
});

after(() => {
  if (opened !== undefined) closeDatabase(opened.db);
});

interface Seeded {
  readonly change_id: string;
  readonly operation_id: string;
  readonly item_id: string;
}

/** 造一条「已有一个条目的操作」。只建外键指得着的那几张表。 */
function seed(): Seeded {
  const change_id = nextId('chg');
  const item_id = nextId('itm');
  // `new_blob_id` 有外键。用 `ensure` **返回的** id（同内容第二次登记会去重）。
  const blob = repos.blobs.ensure({
    id: nextId('blob'),
    sha256: TARGET,
    size: 8,
    storage_ref: `objects/${TARGET.slice(0, 2)}/${TARGET}`,
  });
  repos.changes.create({
    id: change_id,
    owner_connection_id: CONNECTION,
    workspace_id: WORKSPACE,
    root_generation: 1,
    policy_version: POLICY_VERSION,
    contract_version: CONTRACT_VERSION,
    digest: OTHER,
    summary: '回执测试摘要',
    expires_at: new Date(Date.parse(T0) + LIMITS.CHANGE_TTL_MS).toISOString(),
    items: [
      {
        id: item_id,
        op: 'edit_text',
        path: 'src/one.ts',
        base_file_id: 'file-1',
        base_sha256: BASE,
        target_sha256: TARGET,
        new_blob_id: blob.blob.id,
        encoding: 'utf-8',
        bom: false,
        newline: 'lf',
        added_lines: 1,
        removed_lines: 1,
      },
    ],
  });
  const created = repos.operations.create({ id: nextId('op'), change_id });
  assert.equal(created.kind, 'created');
  return { change_id, operation_id: created.operation.id, item_id };
}

/** 追加一条条目级日志行。 */
function journal(
  seeded: Seeded,
  stage: string,
  observed: string | null = null,
  extra: { readonly target?: string | null; readonly error_code?: string | null } = {},
): void {
  repos.journal.append({
    operation_id: seeded.operation_id,
    item_id: seeded.item_id,
    stage,
    observed_sha256: observed,
    target_sha256: extra.target ?? null,
    error_code: extra.error_code ?? null,
  });
}

/** 把操作推到终局 —— 逐文件折叠在终局与执行中读的是不同的话。 */
function settle(seeded: Seeded, to: 'APPLIED' | 'FAILED_NO_CHANGE' | 'RECOVERY_REQUIRED'): void {
  repos.operations.transition(seeded.operation_id, ['QUEUED'], to, {
    finished: to !== 'RECOVERY_REQUIRED',
  });
}

/** 取出唯一那个条目的回执行。 */
function fileOf(seeded: Seeded): OperationFileResult {
  const receipt = operationReceiptFor(seeded.change_id, repos);
  assert.ok(receipt !== null, '有操作行就必须有回执');
  const [first] = receipt.files;
  assert.ok(first !== undefined, '回执里必须有那一个条目');
  return first;
}

const STAGE = EXECUTION_JOURNAL_STAGES;

// ---------------------------------------------------------------------------
// 折叠
// ---------------------------------------------------------------------------

describe('回执折叠：执行日志的每一个终局', () => {
  it('核验通过 ⇒ VERIFIED，两个哈希分别来自基线与观测', () => {
    const seeded = seed();
    journal(seeded, STAGE.verified, TARGET, { target: TARGET });
    settle(seeded, 'APPLIED');

    const file = fileOf(seeded);
    assert.equal(file.state, 'VERIFIED');
    assert.equal(file.before_sha256, BASE, '修改前的哈希取自修改集里记着的基线');
    assert.equal(file.after_sha256, TARGET);
    assert.equal(file.error_code, null);
  });

  it('日志说核验通过、但目标哈希与观测对不上 ⇒ 不猜，报账目不足', () => {
    // 三处哈希（日志的目标、修改集的目标、观测到的）互相印证。
    // 任何一处对不上都说明这本账被人改过或来自别的版本 ——
    // 而那正是「不能声称已保存」的时刻。
    const seeded = seed();
    journal(seeded, STAGE.verified, OTHER, { target: TARGET });
    settle(seeded, 'APPLIED');

    const file = fileOf(seeded);
    assert.equal(file.state, 'UNKNOWN');
    assert.equal(file.error_code, 'RECEIPT_INCOMPLETE');
  });

  it('核验行缺了观测哈希 ⇒ 同样报账目不足，而不是「核验过」', () => {
    const seeded = seed();
    journal(seeded, STAGE.verified, null, { target: TARGET });
    settle(seeded, 'APPLIED');

    assert.equal(fileOf(seeded).error_code, 'RECEIPT_INCOMPLETE');
  });

  it('跳过（内容已是目标）⇒ 与核验同样处理：盘上就是批准的那一份', () => {
    const seeded = seed();
    journal(seeded, STAGE.skipped, TARGET, { target: TARGET });
    settle(seeded, 'APPLIED');

    assert.equal(fileOf(seeded).state, 'VERIFIED');
  });

  it('未触碰 ⇒ FAILED 而**不是** UNKNOWN：我们知道它没被写过', () => {
    const seeded = seed();
    journal(seeded, STAGE.untouched, null, { error_code: 'BASE_CHANGED' });
    settle(seeded, 'FAILED_NO_CHANGE');

    const file = fileOf(seeded);
    assert.equal(file.state, 'FAILED', '「可证明没写过」与「不知道写没写」必须分得开');
    assert.equal(file.error_code, 'BASE_CHANGED');
  });

  it('未触碰且没给错误码 ⇒ 补一个明确的 NOT_TOUCHED，而不是留空', () => {
    const seeded = seed();
    journal(seeded, STAGE.untouched);
    settle(seeded, 'FAILED_NO_CHANGE');

    assert.equal(fileOf(seeded).error_code, 'NOT_TOUCHED');
  });

  it('写入失败 / 回滚失败 / 回滚被跳过 ⇒ UNKNOWN：盘上可能留着我们的字节', () => {
    for (const [stage, code] of [
      [STAGE.failed, 'WRITE_FAILED'],
      [STAGE.restore_failed, 'RESTORE_FAILED'],
      [STAGE.restore_skipped, null],
    ] as const) {
      const seeded = seed();
      journal(seeded, stage, null, { error_code: code });
      settle(seeded, 'RECOVERY_REQUIRED');

      const file = fileOf(seeded);
      assert.equal(file.state, 'UNKNOWN', `${stage} 必须折成 UNKNOWN`);
      assert.equal(file.error_code, code ?? 'WRITE_OUTCOME_UNKNOWN', `${stage} 的错误码`);
    }
  });

  it('回滚成功且带回读数 ⇒ RECOVERED_ORIGINAL', () => {
    const seeded = seed();
    journal(seeded, STAGE.restored, BASE);
    settle(seeded, 'FAILED_NO_CHANGE');

    const file = fileOf(seeded);
    assert.equal(file.state, 'RECOVERED_ORIGINAL');
    assert.equal(file.after_sha256, BASE, '恢复之后的观测就是原内容');
  });

  it('回滚声称成功但没有回读读数 ⇒ 账目不足', () => {
    const seeded = seed();
    journal(seeded, STAGE.restored, null);
    settle(seeded, 'FAILED_NO_CHANGE');

    assert.equal(fileOf(seeded).error_code, 'RECEIPT_INCOMPLETE');
  });

  it('只写到一半的阶段（意图 / 已写 / 已刷盘）⇒ 账目不足以声称刷过盘', () => {
    for (const stage of [STAGE.intent, STAGE.written, STAGE.flushed]) {
      const seeded = seed();
      journal(seeded, stage, TARGET, { target: TARGET });
      settle(seeded, 'RECOVERY_REQUIRED');

      const file = fileOf(seeded);
      assert.equal(file.state, 'UNKNOWN', `${stage} 不得被折成 VERIFIED`);
      assert.equal(file.error_code, 'RECEIPT_INCOMPLETE', `${stage} 的错误码`);
    }
  });

  it('**不认识的**阶段名 ⇒ UNKNOWN + RECEIPT_INCOMPLETE（跨版本必须 fail-closed）', () => {
    // 恢复流程写的是另一套词，而它在同一张表里。把「我不认识」读成
    // 「什么都没发生」，会让一条待恢复的操作在回执里显示成写成功了。
    const seeded = seed();
    journal(seeded, 'recovery_observed_target', TARGET, { target: TARGET });
    settle(seeded, 'RECOVERY_REQUIRED');

    const file = fileOf(seeded);
    assert.equal(file.state, 'UNKNOWN');
    assert.equal(file.error_code, 'RECEIPT_INCOMPLETE');
  });

  it('逐条目取**最后**一条，不是「出现过就算」', () => {
    // 一次先写成功、又被回滚掉的执行：日志里两条都在。
    // 「出现过 verified」与「现在盘上是什么」是两件事。
    const seeded = seed();
    journal(seeded, STAGE.verified, TARGET, { target: TARGET });
    journal(seeded, STAGE.restored, BASE);
    settle(seeded, 'FAILED_NO_CHANGE');

    assert.equal(fileOf(seeded).state, 'RECOVERED_ORIGINAL');
  });

  it('条目级日志行不会与收场行串味：item_id 为 NULL 的那条不属于任何条目', () => {
    // 真日志以一条 `item_id` 为 NULL 的收场行结尾（LWB-031 记下的偏离）。
    // 它若被按「最后一条」选中，每一个条目都会折成那条收场行说的话。
    const seeded = seed();
    journal(seeded, STAGE.verified, TARGET, { target: TARGET });
    repos.journal.append({
      operation_id: seeded.operation_id,
      item_id: null,
      stage: 'write_applied',
    });
    settle(seeded, 'APPLIED');

    const file = fileOf(seeded);
    assert.equal(file.state, 'VERIFIED', '收场行不得参与条目级折叠');
    assert.equal(file.after_sha256, TARGET);
  });

  it('日志里没有这个条目 ⇒ 终局报 UNKNOWN、执行中报 PENDING', () => {
    const terminal = seed();
    settle(terminal, 'APPLIED');
    assert.equal(fileOf(terminal).state, 'UNKNOWN', '终结之后缺一行是我们自己丢了事实');
    assert.equal(fileOf(terminal).before_sha256, null);

    const running = seed();
    assert.equal(fileOf(running).state, 'PENDING', '还没轮到它');
  });
});

describe('回执折叠：逐文件回执行的优先级', () => {
  it('恢复流程写下的那一行**压过**日志', () => {
    // 回执行出现意味着恢复流程在那条操作上跑过：那是崩溃之后**重新观测**、
    // 并且可能已经动过盘之后写下的判定。日志记的是当初写的时候，回执行
    // 记的是后来看到的 —— 后者更晚，且它是唯一知道「盘上现在是什么」的。
    const seeded = seed();
    journal(seeded, STAGE.verified, TARGET, { target: TARGET });
    repos.operations.setItemResult({
      operation_id: seeded.operation_id,
      item_id: seeded.item_id,
      state: 'RECOVERED_ORIGINAL',
      before_sha256: OTHER,
      after_sha256: BASE,
      error_code: null,
    });
    settle(seeded, 'RECOVERY_REQUIRED');

    const file = fileOf(seeded);
    assert.equal(file.state, 'RECOVERED_ORIGINAL', '回执行必须压过日志');
    assert.equal(file.before_sha256, OTHER, '两个哈希也一并取回执行里的');
    assert.equal(file.after_sha256, BASE);
  });

  it('回执行里写不进本版本不认识的状态：库上的 CHECK 先拦住', () => {
    // 折叠代码里那道 `FILE_STATES.has(raw)` 是**第二道**防线。第一道在
    // schema 上：`operation_item_results.state` 有 CHECK 约束，取值为
    // 那七个字面量。这一格钉的是第一道真的在 —— 少了它，第二道就得独自
    // 承担「一个写坏的值无声地变成一个合法状态」这件事，而它多半会被读成成功。
    //
    // 用 `assert.throws` 而不是断言折叠结果：这一格的产物是**一次写入失败**。
    const seeded = seed();
    assert.throws(
      () => {
        repos.operations.setItemResult({
          operation_id: seeded.operation_id,
          item_id: seeded.item_id,
          state: 'TOTALLY_MADE_UP' as 'VERIFIED',
          after_sha256: TARGET,
        });
      },
      /CHECK constraint failed/,
      '库必须拒绝一个不在词表里的逐文件状态',
    );

    // 而且它没留下半行：约束失败之后这个条目仍然没有回执行，
    // 于是回执照日志折叠（这里没有日志 ⇒ 终局报未知）。
    //
    // 用 `FAILED_NO_CHANGE` 而不是 `RECOVERY_REQUIRED` 收场：后者**不是**
    // 终态（它等人处理，之后还会被推进），因此「没有回执行」在它上面读作
    // `PENDING` —— 那是另一件事，由下面那一格单独钉。
    settle(seeded, 'FAILED_NO_CHANGE');
    assert.equal(fileOf(seeded).state, 'UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// 「这次调用有没有可能开始一次写入」
// ---------------------------------------------------------------------------

describe('canBeginWrite：唯一一个「会不会写」的判据', () => {
  it('还没有操作行 ⇒ 可能写', () => {
    // 这一格就是「第一次点应用」：`operations` 表上还没有那一行。
    // 直接问一个不存在的修改集即可 —— 判据读的只有操作行，不看修改集。
    assert.equal(canBeginWrite(repos, 'chg_never_seen'), true);
  });

  it('已排队、尚未被认领 ⇒ 可能写', () => {
    const seeded = seed();
    assert.equal(canBeginWrite(repos, seeded.change_id), true);
  });

  it('认领之后**每一个**状态 ⇒ 不可能写', () => {
    // 这张表是这一格的要点：`claimForExecution` 拒绝除 QUEUED 之外的
    // 每一个状态，而 `UNIQUE(change_id)` 保证一条修改集只有一行操作。
    // 两件事合起来 ⇒ 「不可认领」与「不可能产生第二次写」是同一件事。
    for (const state of ['VALIDATING', 'APPLYING', 'APPLIED', 'ROLLED_BACK', 'CONFLICT', 'FAILED_NO_CHANGE', 'RECOVERY_REQUIRED'] as const) {
      const seeded = seed();
      repos.operations.transition(seeded.operation_id, ['QUEUED'], state);
      assert.equal(canBeginWrite(repos, seeded.change_id), false, `${state} 之后不得再判成「可能写」`);
    }
  });

  it('不可认领的状态**恰恰**是应用服务会走重放的那一批，两处判据同一个函数', () => {
    // 工具面与 `applyChange` 各判一次，而它们必须给出同一个答案 ——
    // 判据因此是导出的、而不是各自实现一遍。这一格钉的是「两边读的是
    // 同一个函数」这件事：一旦有人复制一份，复制品不会跟着这里变。
    const seeded = seed();
    repos.operations.transition(seeded.operation_id, ['QUEUED'], 'APPLIED');
    assert.equal(canBeginWrite(repos, seeded.change_id), false);
    assert.equal(
      operationReceiptFor(seeded.change_id, repos)?.state,
      'APPLIED',
      '走重放那一批的前提正是「回执读得出来」',
    );
  });
});
