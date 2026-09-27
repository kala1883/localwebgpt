/**
 * LWB-029 条目级执行日志：词汇、折叠、脱敏。
 *
 * ## 这个文件为什么大多是纯函数用例
 *
 * `journal.ts` 的**全部**判断都不碰磁盘：它读的是已经落在状态库里的日志行，
 * 回答的是「按这本账，每个文件现在算什么」。这正是它值得单独测的原因 ——
 * 一次多文件写入失败之后，「哪几个文件还有我们的字节」这个判断要是错了，
 * 出错的方向只有两种，而两种都很贵：
 *
 *  - 把 `left_changed` 算成 `written` ⇒ 报告说全成功，盘上却少一个文件；
 *  - 把 `untouched` 算成 `left_changed` ⇒ 叫人来处理一件根本没发生的事。
 *
 * 这两条都不是靠真盘能测出来的（真盘只能证明「这一次」对不对），
 * 而是靠把**每一种日志组合**摆出来看它折成什么。因此本文件用合成事件
 * 穷举组合，只留一组用真 SQLite 验证「写进去的确实是脱敏后的那句话」。
 *
 * ## 与 `tests/unit/executor-native-adapter.test.ts` 的分工
 *
 * 那边测的是**产生**这些日志的那条路（假护栏 + 真 SQLite，端到端）；
 * 这边测的是**读**这本账的那几行代码。两边都断言 `aggregateOf` 的结论，
 * 但走的是不同的入口：那边从护栏的响应一路走到折叠，这边直接把事件摆出来。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import {
  aggregateOf,
  ALL_ITEM_STAGES,
  appendItemEvent,
  describeOutcomes,
  isItemStage,
  ITEM_STAGE,
  itemOutcomes,
  readItemEvents,
  redactRoot,
} from '@lwb/executor';
import type { ItemEvent, ItemOutcome } from '@lwb/executor';
import type { ReadScope } from '@lwb/files';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { OpenDatabaseResult } from '@lwb/persistence';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const T0 = '2026-09-26T00:00:00.000Z';
const ROOT = path.join('D:', 'lwb-journal-sandbox', 'workspace');

const SCOPE: ReadScope = {
  workspace_id: 'ws_journal',
  kind: 'directory',
  mode: 'read_propose_apply_with_local_approval',
  generation: 1,
  root_path: ROOT,
  root_volume_id: 'vol_journal',
  root_file_id: 'dir-root',
};

const workspacePath = (relative: string): string => path.join(ROOT, relative.split('/').join(path.sep));

let opened: OpenDatabaseResult | undefined;
let repos: Repositories;
let seq = 0;
const nextId = (prefix: string): string => `${prefix}_${(seq += 1)}`;

before(() => {
  opened = openDatabase({ path: ':memory:' });
  repos = new Repositories(opened.db, () => T0);
});

after(() => {
  if (opened !== undefined) closeDatabase(opened.db);
});

/** 合成一条条目级事件。`seq` 由本文件的计数器给，模拟仓储层的自增序号。 */
function event(item_id: string, stage: ItemEvent['stage'], extra: Partial<ItemEvent> = {}): ItemEvent {
  return {
    seq: (seq += 1),
    item_id,
    stage,
    observed_file_id: null,
    observed_sha256: null,
    target_sha256: null,
    error_code: null,
    detail: null,
    ...extra,
  };
}

const fold = (...events: ItemEvent[]): Map<string, ItemOutcome> => itemOutcomes(events);
const only = (outcomes: Map<string, ItemOutcome>, itemId: string): ItemOutcome => {
  const found = outcomes.get(itemId);
  assert.ok(found !== undefined, `折叠结果里没有 ${itemId}`);
  return found;
};

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

// ---------------------------------------------------------------------------
// 词汇
// ---------------------------------------------------------------------------

describe('LWB-029 词汇：阶段全集', () => {
  it('阶段名一律带 `item_` 前缀 —— 改动级的行不可能被误认成条目级', () => {
    // 判据是前缀而不是一张并列清单：`isItemStage` 用来把改动级的行
    // （`write_applied` 之类）筛出去，两套名字**看起来**就该分得开。
    for (const stage of ALL_ITEM_STAGES) {
      assert.match(stage, /^item_/, `${stage} 不符合条目级的命名规则`);
    }
    assert.equal(new Set(ALL_ITEM_STAGES).size, ALL_ITEM_STAGES.length, '阶段名不得重复');
  });

  it('`isItemStage` 认条目级、不认改动级、不认空串', () => {
    assert.equal(isItemStage(ITEM_STAGE.intent), true);
    assert.equal(isItemStage('write_applied'), false);
    assert.equal(isItemStage(''), false);
  });

  it('十个阶段一个不少 —— 少一个就意味着某一步的边界没地方记', () => {
    // 按字典序排：`item_restore_failed` 排在 `item_restored` **前面**
    // （`_` 的码位小于 `d`），这不是笔误。
    assert.deepEqual([...ALL_ITEM_STAGES].sort(), [
      'item_failed',
      'item_flushed',
      'item_intent',
      'item_restore_failed',
      'item_restore_skipped',
      'item_restored',
      'item_skipped',
      'item_untouched',
      'item_verified',
      'item_written',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 逐条目折叠
// ---------------------------------------------------------------------------

describe('LWB-029 折叠：取最后一条事件，而不是「出现过就算」', () => {
  it('先写过、后回滚成功 ⇒ `restored`，不是 `written`', () => {
    const outcomes = fold(
      event('i1', ITEM_STAGE.intent),
      event('i1', ITEM_STAGE.written),
      event('i1', ITEM_STAGE.flushed),
      event('i1', ITEM_STAGE.verified),
      event('i1', ITEM_STAGE.restored),
    );
    assert.equal(only(outcomes, 'i1').kind, 'restored');
    assert.equal(only(outcomes, 'i1').events, 5);
  });

  it('先写过、后回滚**失败** ⇒ `left_changed`（按「出现过」折会报成全成功）', () => {
    const outcomes = fold(
      event('i1', ITEM_STAGE.intent),
      event('i1', ITEM_STAGE.written),
      event('i1', ITEM_STAGE.flushed),
      event('i1', ITEM_STAGE.verified),
      event('i1', ITEM_STAGE.restore_failed, { error_code: 'FILE_BUSY', detail: '收回时被占着' }),
    );
    const outcome = only(outcomes, 'i1');
    assert.equal(outcome.kind, 'left_changed');
    assert.equal(outcome.last_error_code, 'FILE_BUSY');
    assert.equal(outcome.last_detail, '收回时被占着');
  });

  it('只有一条 `intent` ⇒ `unknown`（账上只有意图，磁盘上什么都可能）', () => {
    assert.equal(only(fold(event('i1', ITEM_STAGE.intent)), 'i1').kind, 'unknown');
  });

  it('`written` 之后没有 `verified` ⇒ `left_changed`，不声称刷过盘', () => {
    // 今天的三条是同一个事务里写的，因此这种组合不该出现。它一旦出现，
    // 说明账目被改过或来自别的版本 —— 此时唯一站得住的话是「可能有」。
    assert.equal(only(fold(event('i1', ITEM_STAGE.written)), 'i1').kind, 'left_changed');
    assert.equal(only(fold(event('i1', ITEM_STAGE.flushed)), 'i1').kind, 'left_changed');
  });

  it('认不出的阶段名 ⇒ `unknown`（跨版本时 fail-closed，不丢弃、不抛）', () => {
    const outcomes = fold(
      event('i1', ITEM_STAGE.intent),
      event('i1', 'item_from_the_future' as ItemEvent['stage']),
    );
    assert.equal(only(outcomes, 'i1').kind, 'unknown');
  });

  it('事件乱序到达也按序号排 —— 折叠依赖的是先后，不是读出来的次序', () => {
    const written = event('i1', ITEM_STAGE.written);
    const restored = event('i1', ITEM_STAGE.restored);
    assert.equal(only(fold(restored, written), 'i1').kind, 'restored');
    assert.equal(only(fold(written, restored), 'i1').kind, 'restored');
  });

  it('多个条目各折各的，互不影响', () => {
    const outcomes = fold(
      event('i1', ITEM_STAGE.intent),
      event('i2', ITEM_STAGE.intent),
      event('i1', ITEM_STAGE.written),
      event('i1', ITEM_STAGE.flushed),
      event('i1', ITEM_STAGE.verified),
      event('i2', ITEM_STAGE.untouched),
    );
    assert.equal(only(outcomes, 'i1').kind, 'written');
    assert.equal(only(outcomes, 'i2').kind, 'untouched');
  });

  it('一条事件都没有 ⇒ 空表（不是「全部 untouched」）', () => {
    assert.equal(fold().size, 0);
  });
});

// ---------------------------------------------------------------------------
// 总账
// ---------------------------------------------------------------------------

describe('LWB-029 总账：三种好结局，其余一律 unfinished', () => {
  const kinds = (...list: ItemOutcome['kind'][]): Map<string, ItemOutcome> => {
    const map = new Map<string, ItemOutcome>();
    list.forEach((kind, index) => {
      const item_id = `i${index + 1}`;
      map.set(item_id, { item_id, kind, last_detail: null, last_error_code: null, events: 2 });
    });
    return map;
  };

  it('全部 written（可带 skipped） ⇒ `applied`', () => {
    assert.equal(aggregateOf(kinds('written'), 1), 'applied');
    assert.equal(aggregateOf(kinds('written', 'written', 'skipped'), 3), 'applied');
  });

  it('全部 skipped ⇒ `no_change`', () => {
    assert.equal(aggregateOf(kinds('skipped', 'skipped'), 2), 'no_change');
  });

  it('全部 untouched ⇒ `rolled_back`（一次什么都没做的执行不该叫 applied）', () => {
    assert.equal(aggregateOf(kinds('untouched'), 1), 'rolled_back');
    assert.equal(aggregateOf(kinds('untouched', 'untouched'), 2), 'rolled_back');
  });

  it('回滚过、也 untouched、也 skipped 混在一起 ⇒ `rolled_back`', () => {
    assert.equal(aggregateOf(kinds('restored', 'untouched', 'skipped'), 3), 'rolled_back');
  });

  it('`{written:1, untouched:1}` ⇒ `unfinished` —— 这一格是本文件的重点', () => {
    // `untouched` 的含义是「这次执行没在这个文件上留下字节」，**不是**
    // 「这个文件已经是要写的内容」。把它算进 `applied`，报告说的就是
    // 「全部目标已达到」，而其中一个文件根本没被创建。
    assert.equal(aggregateOf(kinds('written', 'untouched'), 2), 'unfinished');
    assert.equal(aggregateOf(kinds('written', 'restored'), 2), 'unfinished');
    assert.equal(aggregateOf(kinds('written', 'left_changed'), 2), 'unfinished');
    assert.equal(aggregateOf(kinds('written', 'unknown'), 2), 'unfinished');
  });

  it('`{restored:1, left_changed:1}` ⇒ `unfinished`（回滚没收干净）', () => {
    assert.equal(aggregateOf(kinds('restored', 'left_changed'), 2), 'unfinished');
  });

  it('账上少了条目 ⇒ `unfinished`：没日志的条目不能被当成「没被改」', () => {
    assert.equal(aggregateOf(kinds('written'), 2), 'unfinished');
    assert.equal(aggregateOf(kinds('skipped'), 3), 'unfinished');
    assert.equal(aggregateOf(kinds(), 1), 'unfinished');
  });

  it('`left_changed` / `unknown` 在任何组合里都进不了好结局', () => {
    for (const bad of ['left_changed', 'unknown'] as const) {
      assert.equal(aggregateOf(kinds(bad), 1), 'unfinished', `单独一个 ${bad} 必须落 unfinished`);
      assert.equal(aggregateOf(kinds(bad, 'skipped'), 2), 'unfinished');
      assert.equal(aggregateOf(kinds(bad, 'untouched', 'restored'), 3), 'unfinished');
    }
  });

  it('零个条目、零条日志 ⇒ `no_change`（空集上「每个条目都 skipped」为真）', () => {
    // 这一格在生产里到不了：修改集至少一个条目（`ChangesRepo.create` 把
    // 零条目挡在模式层之前），而 `apply.ts` 在**没有任何要写的条目**时
    // 早在 `recordIntent` 之前就返回 `no_change` 了 —— 它跟这里给的是
    // 同一个答案。写成断言是为了把这个答案钉住：一次什么都没干的执行
    // 不该被报成 `unfinished`（那会去叫人来看一件没发生的事）。
    assert.equal(aggregateOf(kinds(), 0), 'no_change');
  });
});

// ---------------------------------------------------------------------------
// 总账的那句人话
// ---------------------------------------------------------------------------

describe('LWB-029 报告：逐条目小结', () => {
  const outcomes = (...list: ItemOutcome['kind'][]): Map<string, ItemOutcome> => {
    const map = new Map<string, ItemOutcome>();
    list.forEach((kind, index) => {
      const item_id = `i${index + 1}`;
      map.set(item_id, { item_id, kind, last_detail: `第 ${index + 1} 条的说明`, last_error_code: null, events: 2 });
    });
    return map;
  };
  const paths = new Map([
    ['i1', 'src/one.ts'],
    ['i2', 'src/two.ts'],
    ['i3', 'src/three.ts'],
  ]);

  it('好结局只数个数，不点名（没有人需要去看的条目）', () => {
    const text = describeOutcomes(outcomes('written', 'skipped'), paths);
    assert.equal(text, '已写入并核验 1；无需改动 1');
    assert.equal(text.includes('需要人看的条目'), false);
  });

  it('坏结局点名，并带上那条日志的原话', () => {
    const text = describeOutcomes(outcomes('written', 'left_changed'), paths);
    assert.match(text, /已写入并核验 1/);
    assert.match(text, /\*\*可能留有本次执行的字节\*\* 1/);
    assert.match(text, /需要人看的条目：「src\/two\.ts」：第 2 条的说明$/);
  });

  it('点多名的条数有上界，但计数不截断', () => {
    const many = outcomes('left_changed', 'left_changed', 'left_changed', 'left_changed');
    const wide = new Map([...paths, ['i4', 'src/four.ts']]);
    const text = describeOutcomes(many, wide, 2);
    assert.match(text, /可能留有本次执行的字节\*\* 4/, '计数必须说全');
    assert.equal(text.match(/需要人看的条目：/g)?.length, 1);
    assert.equal(text.includes('src/three.ts'), false, '超出的条目只进计数');
    assert.equal(text.includes('src/four.ts'), false);
  });

  it('找不到路径时退回条目 id —— 也不能因此漏掉一条', () => {
    const text = describeOutcomes(outcomes('unknown'), new Map());
    assert.match(text, /需要人看的条目：「i1」/);
  });

  it('坏条目没有说明时给出占位，而不是把 undefined 印出来', () => {
    const bare = new Map<string, ItemOutcome>([
      ['i1', { item_id: 'i1', kind: 'unknown', last_detail: null, last_error_code: null, events: 1 }],
    ]);
    assert.match(describeOutcomes(bare, paths), /（无说明）/);
  });
});

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

describe('LWB-029 脱敏：只擦工作区根', () => {
  it('把根路径换掉，别的路径不动', () => {
    const text = redactRoot(`${workspacePath('src/one.ts')} 与 C:\\Windows\\notepad.exe`, SCOPE);
    assert.equal(text, '<工作区根>\\src\\one.ts 与 C:\\Windows\\notepad.exe');
  });

  it('出现几次擦几次', () => {
    const text = redactRoot(`${ROOT} / ${ROOT}`, SCOPE);
    assert.equal(text, '<工作区根> / <工作区根>');
  });

  it('根为空串时原样返回（不去把所有位置都换成占位符）', () => {
    const empty: ReadScope = { ...SCOPE, root_path: '' };
    assert.equal(redactRoot('随便什么', empty), '随便什么');
  });

  it('不含根的文字原样返回', () => {
    assert.equal(redactRoot('护栏拒绝（FILE_BUSY）', SCOPE), '护栏拒绝（FILE_BUSY）');
  });
});

describe('LWB-029 脱敏：写库之前就发生（真 SQLite）', () => {
  it('`detail` 落库时已经不含工作区根的绝对路径', () => {
    const rig = seedOperation();
    const absolute = workspacePath('src/one.ts');

    const written = appendItemEvent(repos, {
      operation_id: rig.operation_id,
      item_id: rig.item_id,
      stage: ITEM_STAGE.failed,
      scope: SCOPE,
      detail: `${absolute} 被占着，无法写入。`,
    });

    const rows = repos.journal.list(rig.operation_id);
    const row = rows.find((r) => r.seq === written);
    assert.ok(row !== undefined);
    assert.equal(row.detail, '<工作区根>\\src\\one.ts 被占着，无法写入。');
    assert.equal(row.detail?.includes(ROOT), false, '库里不得出现根的绝对路径');
  });

  it('`detail` 缺席就是 `NULL`，不会被脱敏成空串', () => {
    const rig = seedOperation();
    const written = appendItemEvent(repos, {
      operation_id: rig.operation_id,
      item_id: rig.item_id,
      stage: ITEM_STAGE.intent,
      scope: SCOPE,
    });
    const row = repos.journal.list(rig.operation_id).find((r) => r.seq === written);
    assert.equal(row?.detail, null);
  });
});

describe('LWB-029 读回：只取条目级，按序号升序', () => {
  it('改动级的行被筛掉，条目级的行一条不少', () => {
    const rig = seedOperation();

    // 改动级的行（`item_id` 为 NULL）—— 协调器收尾时写的那种。
    repos.journal.append({ operation_id: rig.operation_id, stage: 'write_applied', detail: '改动级' });
    appendItemEvent(repos, {
      operation_id: rig.operation_id,
      item_id: rig.item_id,
      stage: ITEM_STAGE.intent,
      scope: SCOPE,
      detail: '条目级',
    });
    repos.journal.append({ operation_id: rig.operation_id, stage: 'write_verified' });
    appendItemEvent(repos, {
      operation_id: rig.operation_id,
      item_id: rig.item_id,
      stage: ITEM_STAGE.untouched,
      scope: SCOPE,
      error_code: 'FILE_BUSY',
    });

    const events = readItemEvents(repos, rig.operation_id);
    assert.deepEqual(
      events.map((e) => e.stage),
      [ITEM_STAGE.intent, ITEM_STAGE.untouched],
    );
    assert.deepEqual(
      events.map((e) => e.seq),
      [...events.map((e) => e.seq)].sort((a, b) => a - b),
    );
    // 混进一条改动级的行会让逐条目折叠多出一个没有归属的事件；这里
    // 连带证明折叠只看到两个条目级事件。
    const outcomes = itemOutcomes(events);
    assert.equal(outcomes.size, 1);
    assert.equal(only(outcomes, rig.item_id).kind, 'untouched');
  });

  it('别的操作的日志不会串进来', () => {
    const a = seedOperation();
    const b = seedOperation();
    appendItemEvent(repos, { operation_id: a.operation_id, item_id: a.item_id, stage: ITEM_STAGE.intent, scope: SCOPE });
    appendItemEvent(repos, { operation_id: b.operation_id, item_id: b.item_id, stage: ITEM_STAGE.intent, scope: SCOPE });

    assert.deepEqual(
      readItemEvents(repos, a.operation_id).map((e) => e.item_id),
      [a.item_id],
    );
  });

  it('身份与哈希原样带出来，不被脱敏吃掉', () => {
    const rig = seedOperation();
    appendItemEvent(repos, {
      operation_id: rig.operation_id,
      item_id: rig.item_id,
      stage: ITEM_STAGE.verified,
      scope: SCOPE,
      observed_file_id: 'file-1',
      observed_sha256: HASH_A,
      target_sha256: HASH_A,
    });
    const [first] = readItemEvents(repos, rig.operation_id);
    assert.equal(first?.observed_file_id, 'file-1');
    assert.equal(first?.observed_sha256, HASH_A);
    assert.equal(first?.target_sha256, HASH_A);
    assert.equal(HASH_A, HASH_A);
    assert.notEqual(HASH_A, HASH_B);
  });

  it('日志是追加写的：序号单调递增，重启读回来还是那个次序', () => {
    const rig = seedOperation();
    const first = appendItemEvent(repos, {
      operation_id: rig.operation_id,
      item_id: rig.item_id,
      stage: ITEM_STAGE.intent,
      scope: SCOPE,
    });
    const second = appendItemEvent(repos, {
      operation_id: rig.operation_id,
      item_id: rig.item_id,
      stage: ITEM_STAGE.written,
      scope: SCOPE,
    });
    assert.equal(second, first + 1);
    assert.deepEqual(readItemEvents(repos, rig.operation_id).map((e) => e.seq), [first, second]);
  });
});

// ---------------------------------------------------------------------------
// 一个最小的真库夹具：只建日志外键指着的那几张表
// ---------------------------------------------------------------------------

const CONNECTION = 'conn_journal';
const WORKSPACE = 'ws_journal';
const POLICY_VERSION = 1;
const MODE = 'read_propose_apply_with_local_approval';

/**
 * 造一个「有一个条目的操作」，只为了让 `journal_entries` 的两条外键
 * （`operations.id`、`change_items.id`）都指得着东西。
 *
 * 不走 `approveAndQueue` 那条生产路径：本文件测的是日志层，把批准与认领
 * 也拉进来只会让夹具更长，而它证明不了日志层的任何一件事。
 */
function seedOperation(): { operation_id: string; item_id: string } {
  const change_id = nextId('chg');
  const item_id = nextId('itm');
  const blob_id = nextId('blob');

  // 建一次连接与工作区是幂等的：夹具里只有这一对。
  if (repos.connections.findById(CONNECTION) === null) {
    repos.connections.create({
      id: CONNECTION,
      principal_kind: 'model_surface',
      principal_id: 'principal_journal',
      alias: '日志测试连接',
      enabled: true,
    });
  }
  if (repos.workspaces.findById(WORKSPACE) === null) {
    repos.workspaces.create({
      id: WORKSPACE,
      alias: '日志测试工作区',
      kind: 'directory',
      canonical_root: ROOT,
      volume_id: 'vol_journal',
      root_file_id: 'dir-root',
      policy_version: POLICY_VERSION,
      mode: MODE,
    });
  }

  // 条目上的 `new_blob_id` 有外键。登记一个元数据行即可 ——
  // `BlobsRepo.ensure` 只写元数据、不校验磁盘内容（见它的注释）。
  //
  // 用**它返回的** id，不是我提议的那个：同一个内容第二次登记时
  // `ensure` 按内容去重，返回的是已存在的那一行，而我提议的新 id
  // 根本没有被插进去 —— 照提议的 id 写条目会撞外键。
  const blob = repos.blobs.ensure({
    id: blob_id,
    sha256: HASH_A,
    size: 8,
    storage_ref: `objects/${HASH_A.slice(0, 2)}/${HASH_A}`,
  });

  repos.changes.create({
    id: change_id,
    owner_connection_id: CONNECTION,
    workspace_id: WORKSPACE,
    root_generation: 1,
    policy_version: POLICY_VERSION,
    contract_version: CONTRACT_VERSION,
    digest: HASH_B,
    summary: '日志测试摘要',
    expires_at: new Date(Date.parse(T0) + LIMITS.CHANGE_TTL_MS).toISOString(),
    items: [
      {
        id: item_id,
        op: 'edit_text',
        path: 'src/one.ts',
        base_file_id: 'file-1',
        base_sha256: HASH_A,
        target_sha256: HASH_B,
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
  return { operation_id: created.operation.id, item_id };
}
