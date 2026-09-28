/**
 * LWB-030 单元测试：逐条目判定表。
 *
 * ## 这个文件为什么长得像一张表
 *
 * `verdict.ts` 的文件头画了两张判定表（改写一张、创建一张），本文件是那两张表
 * 的**逐格抄写**。它的价值不在于「跑过了」，而在于**格数是可数的**：任何一次
 * 修改判定逻辑都会让某几格红，而红的那几格直接指出改了哪条边。
 *
 * 因此这里不写「输入 A 得到 B」这种抽样，而是把维度**全部**枚举出来：
 * 改写那条路上是「观测形态（3）× 对象身份（3）× 内容（4）」，创建那条路上是
 * 「观测形态（3）× 内容（2）× 账上身份（3）」。抽样会漏掉恰好那一格
 * —— 而这一格的后果是**自动定案一个说不清的现场**。
 *
 * ## 三件事在本文件里被反复确认
 *
 *  1. `absent` 与 `unavailable` 落在**不同**的判定上。合成一格会让「文件不在了」
 *     与「护栏没看成」在代码里长得一样，而它们在 §8.4 里是两行。
 *  2. 内容对得上但对象换了，**不是** `TARGET_REACHED`。这是本任务唯一一处
 *     「看起来成功了但不是」的判定，也是「用路径前缀判安全」那种实现会
 *     漏掉的那一格。
 *  3. 截断的读（`sha256 === null`）**不是**空内容。它的后果很具体：
 *     当成 `present` 会落到 `THIRD_CONTENT`（「有一个我们不该覆盖的内容」），
 *     而那是同一个文件、只是没读完。
 *
 * ## 不碰磁盘、不碰数据库、不碰时钟
 *
 * `verdict.ts` 是纯的，本文件也保持纯的：观测是构造出来的，日志证据是
 * 构造出来的。真盘上的那一份在 `tests/windows/recovery-converge.test.ts`。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyItem, observationOf, NO_JOURNAL_EVIDENCE } from '@lwb/recovery';
import type { JournalEvidence, Observation } from '@lwb/recovery';
import type { ChangeItemRecord } from '@lwb/persistence';

// ---------------------------------------------------------------------------
// 构造器：两个哈希、一个对象
// ---------------------------------------------------------------------------

const BASE = 'a'.repeat(64);
const TARGET = 'b'.repeat(64);
const THIRD = 'c'.repeat(64);
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const BASE_ID = 'fid_base';
const OTHER_ID = 'fid_other';

function editItem(overrides: Partial<ChangeItemRecord> = {}): ChangeItemRecord {
  return {
    id: 'ci_1',
    change_id: 'chg_1',
    seq: 1,
    op: 'edit_text',
    canonical_path: 'src/app.ts',
    canonical_path_key: 'src/app.ts',
    base_file_id: BASE_ID,
    base_sha256: BASE,
    target_sha256: TARGET,
    old_blob_id: 'blb_old',
    new_blob_id: 'blb_new',
    encoding: 'utf-8',
    bom: false,
    newline: 'lf',
    added_lines: 1,
    removed_lines: 1,
    created_at: '2026-09-26T00:00:00.000Z',
    ...overrides,
  };
}

function createItem(overrides: Partial<ChangeItemRecord> = {}): ChangeItemRecord {
  return editItem({
    id: 'ci_c',
    op: 'create_text',
    canonical_path: 'docs/new.md',
    canonical_path_key: 'docs/new.md',
    base_file_id: null,
    base_sha256: null,
    old_blob_id: null,
    ...overrides,
  });
}

function deleteItem(overrides: Partial<ChangeItemRecord> = {}): ChangeItemRecord {
  return editItem({
    id: 'ci_d',
    op: 'delete_file',
    canonical_path: 'assets/payload.bin',
    canonical_path_key: 'assets/payload.bin',
    target_sha256: EMPTY_SHA256,
    ...overrides,
  });
}

const PRESENT_BASE: Observation = {
  kind: 'present',
  file_id: BASE_ID,
  sha256: BASE,
  size: 10,
  canonical_path: 'src/app.ts',
};
const PRESENT_TARGET: Observation = { ...PRESENT_BASE, sha256: TARGET };
const PRESENT_THIRD: Observation = { ...PRESENT_BASE, sha256: THIRD };
const PRESENT_OTHER_OBJECT: Observation = { ...PRESENT_BASE, file_id: OTHER_ID };
const ABSENT: Observation = { kind: 'absent' };
const GUARD_DOWN: Observation = {
  kind: 'unavailable',
  reason: 'GUARD_UNAVAILABLE',
  detail: '护栏不可用。',
};

function judge(item: ChangeItemRecord, observation: Observation, journal?: JournalEvidence) {
  return classifyItem({ item, observation, journal: journal ?? NO_JOURNAL_EVIDENCE });
}

// ---------------------------------------------------------------------------
// A. 改写：观测形态这一维
// ---------------------------------------------------------------------------

describe('LWB-030 A. 改写 —— 观测形态决定「判不判得出」', () => {
  it('A1 护栏不可用 ⇒ IDENTITY_UNKNOWN，原因照抄观测', () => {
    const verdict = judge(editItem(), GUARD_DOWN);
    assert.equal(verdict.kind, 'IDENTITY_UNKNOWN');
    assert.equal(verdict.kind === 'IDENTITY_UNKNOWN' && verdict.reason, 'GUARD_UNAVAILABLE');
  });

  it('A2 读失败 ⇒ IDENTITY_UNKNOWN(READ_FAILED)', () => {
    const verdict = judge(editItem(), {
      kind: 'unavailable',
      reason: 'READ_FAILED',
      detail: '权限不足。',
    });
    assert.equal(verdict.kind === 'IDENTITY_UNKNOWN' && verdict.reason, 'READ_FAILED');
  });

  it('A3 文件不在 ⇒ IDENTITY_UNKNOWN(OBJECT_MISSING)，**不是**「回到了原状」', () => {
    // 这是本组唯一一处容易写错的地方：改写条目的基线是「被批准的**那个对象**」，
    // 而它消失了不构成「未变」。§8.4 把它归入「身份变化」。
    const verdict = judge(editItem(), ABSENT);
    assert.equal(verdict.kind, 'IDENTITY_UNKNOWN');
    assert.equal(verdict.kind === 'IDENTITY_UNKNOWN' && verdict.reason, 'OBJECT_MISSING');
  });

  it('A4 截断的读（sha256 为空）⇒ IDENTITY_UNKNOWN(OBSERVATION_TRUNCATED)，**不是**空内容', () => {
    const observation = observationOf({
      ok: true,
      file_id: BASE_ID,
      sha256: null,
      size: 4_194_304,
      canonical_path: 'src/app.ts',
    });
    assert.equal(observation.kind, 'unavailable');
    const verdict = judge(editItem(), observation);
    assert.equal(verdict.kind === 'IDENTITY_UNKNOWN' && verdict.reason, 'OBSERVATION_TRUNCATED');
  });

  it('A5 空哈希不会被当成一个「既非基线也非目标」的内容', () => {
    // 上一条的反面：如果截断被当成 `present`，空哈希会落到 THIRD_CONTENT，
    // 而 THIRD_CONTENT 的含义是「有一个我们不该覆盖的内容」——
    // 同一个文件、只是没读完，绝不该被说成别人的东西。
    const truncated = observationOf({
      ok: true,
      file_id: BASE_ID,
      sha256: null,
      size: 1,
      canonical_path: 'src/app.ts',
    });
    assert.notEqual(judge(editItem(), truncated).kind, 'THIRD_CONTENT');
  });

  it('A6 改写条目缺基线身份/哈希 ⇒ IDENTITY_UNKNOWN，且明说是记录不完整', () => {
    // 这一格不是关于磁盘的，是关于账目的：一条没有基线的改写记录
    // 根本无法被判定，而「记录不完整」本身就是要报的事。
    for (const broken of [
      editItem({ base_file_id: null }),
      editItem({ base_sha256: null }),
    ]) {
      const verdict = judge(broken, PRESENT_BASE);
      assert.equal(verdict.kind, 'IDENTITY_UNKNOWN');
      assert.match(verdict.detail, /没有基线身份或基线哈希/);
    }
  });
});

// ---------------------------------------------------------------------------
// B. 改写：对象身份 × 内容 —— 12 格全枚举
// ---------------------------------------------------------------------------

describe('LWB-030 B. 改写 —— 对象身份 × 内容的 12 格', () => {
  // 身份维取三个值：等于基线、被替换、文件名已不可达（由 A 组覆盖 `absent`）。
  // 内容维取四个值：基线、目标、第三种、以及「两者都不是」的第三种。
  const identityCases: readonly {
    readonly name: string;
    readonly observation: Observation;
    readonly sameObject: boolean;
  }[] = [
    { name: '身份 = 基线', observation: PRESENT_BASE, sameObject: true },
    { name: '身份 ≠ 基线', observation: PRESENT_OTHER_OBJECT, sameObject: false },
  ];

  const contentCases: readonly {
    readonly name: string;
    readonly of: (observation: Observation) => Observation;
    readonly content: 'base' | 'target' | 'third';
  }[] = [
    { name: '内容 = 基线', of: (o) => ({ ...o, sha256: BASE }), content: 'base' },
    { name: '内容 = 目标', of: (o) => ({ ...o, sha256: TARGET }), content: 'target' },
    { name: '内容 = 第三种', of: (o) => ({ ...o, sha256: THIRD }), content: 'third' },
  ];

  const expected: Record<string, string> = {
    // 同对象：内容对上就是那一格，第三种内容进 THIRD_CONTENT。
    '身份 = 基线|内容 = 基线': 'ORIGINAL',
    '身份 = 基线|内容 = 目标': 'TARGET_REACHED',
    '身份 = 基线|内容 = 第三种': 'THIRD_CONTENT',
    // 异对象：内容对上基线或目标都判不出（对象被替换过），
    // 内容既不对基线也不对目标时才是「一个别人的内容」。
    '身份 ≠ 基线|内容 = 基线': 'IDENTITY_UNKNOWN',
    '身份 ≠ 基线|内容 = 目标': 'IDENTITY_UNKNOWN',
    '身份 ≠ 基线|内容 = 第三种': 'THIRD_CONTENT',
  };

  for (const identity of identityCases) {
    for (const content of contentCases) {
      const key = `${identity.name}|${content.name}`;
      it(`B ${key} ⇒ ${expected[key]}`, () => {
        const verdict = judge(editItem(), content.of(identity.observation));
        assert.equal(verdict.kind, expected[key], `${key} 的判定与判定表不符`);
      });
    }
  }

  it('B7 「内容等于目标但对象换了」带的是 REPLACED_OBJECT，且**不**声称达到目标', () => {
    const verdict = judge(editItem(), PRESENT_OTHER_OBJECT);
    assert.equal(verdict.kind === 'IDENTITY_UNKNOWN' && verdict.reason, 'REPLACED_OBJECT');
    // 「达到目标」这句话一个字都不该出现在身份不明的那一格上：
    // §8.4 原文「内容等于目标并不总能证明是谁写的」。
    assert.doesNotMatch(verdict.detail, /核验到目标状态/);
  });

  it('B8 三种判定各自带上观测到的身份、哈希与磁盘规范拼写', () => {
    // `observed_path` 是**磁盘现在的**拼写，不是条目里那个（准备修改集时的）
    // 拼写。写回要用它，因此它必须随判定一起被带上来 —— 见 verdict.ts 的注释。
    const observed: Observation = { ...PRESENT_TARGET, canonical_path: 'src/App.ts' };
    const verdict = judge(editItem(), observed);
    // `assert.equal` 把联合收窄到那一格，于是下面三行可以直接取字段。
    // 再写一层 `verdict.kind !== 'IDENTITY_UNKNOWN' &&` 是个恒真的比较，
    // 编译器会（正确地）报它「两侧没有交集」—— 那正好说明收窄生效了。
    assert.equal(verdict.kind, 'TARGET_REACHED');
    assert.equal(verdict.observed_path, 'src/App.ts');
    assert.equal(verdict.observed_file_id, BASE_ID);
    assert.equal(verdict.observed_sha256, TARGET);
  });

  it('B9 IDENTITY_UNKNOWN 那一格**没有**观测身份可带（它不是三种之一）', () => {
    const verdict = judge(editItem(), ABSENT);
    assert.equal(verdict.kind, 'IDENTITY_UNKNOWN');
    assert.equal('observed_file_id' in verdict, false);
  });

  it('B10 判定措辞只说「核验到目标状态」，不说「我们写成功了」', () => {
    const reached = judge(editItem(), PRESENT_TARGET);
    assert.match(reached.detail, /核验到目标状态/);
    assert.doesNotMatch(reached.detail, /写入成功|已应用|我们写的/);
    const original = judge(editItem(), PRESENT_BASE);
    assert.match(original.detail, /核验到原状态/);
  });
});

// ---------------------------------------------------------------------------
// C. 创建：名字空着、归属、被占用
// ---------------------------------------------------------------------------

describe('LWB-030 C. 创建 —— 名字空着是一格、归属不明是另一格', () => {
  const journalWith = (fileId: string | null): JournalEvidence => ({
    outcome: 'written',
    events: 2,
    observed_file_id: fileId,
    observed_sha256: TARGET,
  });

  it('C1 名字还空着 ⇒ ORIGINAL（要建的东西没建出来）', () => {
    const verdict = judge(createItem(), ABSENT);
    assert.equal(verdict.kind, 'ORIGINAL');
    // 创建这一格没有对象可指，因此三个观测字段都是 `null` —— 而它们
    // **应当**是 `null`，不是缺字段。
    assert.equal(verdict.kind === 'ORIGINAL' && verdict.observed_file_id, null);
    assert.equal(verdict.kind === 'ORIGINAL' && verdict.observed_sha256, null);
    assert.equal(verdict.kind === 'ORIGINAL' && verdict.observed_path, null);
  });

  it('C2 护栏不可用 ⇒ IDENTITY_UNKNOWN，**不是** ORIGINAL', () => {
    // 「没看」与「没有」在创建这条路上同样容易被混为一谈：
    // 护栏挂了的时候报「没建出来」会让一次真实的创建被定案成 ROLLED_BACK。
    const verdict = judge(createItem(), GUARD_DOWN);
    assert.equal(verdict.kind, 'IDENTITY_UNKNOWN');
  });

  it('C3 内容等于目标 + 账上身份等于观测身份 ⇒ TARGET_REACHED', () => {
    const observation: Observation = {
      kind: 'present',
      file_id: 'fid_new',
      sha256: TARGET,
      size: 20,
      canonical_path: 'docs/new.md',
    };
    const verdict = judge(createItem(), observation, journalWith('fid_new'));
    assert.equal(verdict.kind, 'TARGET_REACHED');
  });

  it('C4 内容等于目标但账上**没有**登录过身份 ⇒ IDENTITY_UNKNOWN(CREATED_IDENTITY_UNPROVEN)', () => {
    // §8.3 原文：「新文件创建后到身份入库之间崩溃属于可能的模糊状态，
    // 不能猜测所有同名内容都属于插件。」
    const observation: Observation = {
      kind: 'present',
      file_id: 'fid_new',
      sha256: TARGET,
      size: 20,
      canonical_path: 'docs/new.md',
    };
    for (const journal of [NO_JOURNAL_EVIDENCE, journalWith(null), journalWith('fid_其他')]) {
      const verdict = judge(createItem(), observation, journal);
      assert.equal(verdict.kind, 'IDENTITY_UNKNOWN', `journal=${JSON.stringify(journal)}`);
      assert.equal(
        verdict.kind === 'IDENTITY_UNKNOWN' && verdict.reason,
        'CREATED_IDENTITY_UNPROVEN',
      );
    }
  });

  it('C5 内容不是目标 ⇒ THIRD_CONTENT，且**不会**去覆盖它', () => {
    const observation: Observation = {
      kind: 'present',
      file_id: 'fid_someone_else',
      sha256: THIRD,
      size: 20,
      canonical_path: 'docs/new.md',
    };
    const verdict = judge(createItem(), observation, journalWith('fid_someone_else'));
    assert.equal(verdict.kind, 'THIRD_CONTENT');
    assert.match(verdict.detail, /不覆盖/);
  });

  it('C6 内容不是目标时，账上身份一致也**不**改变判定', () => {
    // 身份一致只证明「名字被我们那个对象占着」；内容不对时它仍然是
    // 一个不该被覆盖的东西 —— 内容这一维优先于身份那一维。
    const observation: Observation = {
      kind: 'present',
      file_id: 'fid_new',
      sha256: THIRD,
      size: 20,
      canonical_path: 'docs/new.md',
    };
    assert.equal(judge(createItem(), observation, journalWith('fid_new')).kind, 'THIRD_CONTENT');
  });

  it('C7 新建归属不明时不把独立删除工具当作自动恢复方案', () => {
    // file_delete 是一项单独、明确调用的能力；不能因为内容相同就把
    // 「这是本次创建的文件」当成事实并由启动恢复顺手删除。
    const observation: Observation = {
      kind: 'present',
      file_id: 'fid_x',
      sha256: THIRD,
      size: 1,
      canonical_path: 'docs/new.md',
    };
    for (const detail of [
      judge(createItem(), observation).detail,
      judge(createItem(), GUARD_DOWN).detail,
      judge(createItem(), ABSENT).detail,
    ]) {
      assert.doesNotMatch(detail, /删除|移除/);
    }
  });
});

// ---------------------------------------------------------------------------
// D. 删除：目录项不存在就是目标状态
// ---------------------------------------------------------------------------

describe('LWB-030 D. 删除 —— 崩溃恢复把路径缺失识别为目标状态', () => {
  it('D1 目标路径不存在 ⇒ TARGET_REACHED，且不编造对象身份/哈希', () => {
    const verdict = judge(deleteItem(), ABSENT);
    assert.equal(verdict.kind, 'TARGET_REACHED');
    if (verdict.kind !== 'TARGET_REACHED') return;
    assert.equal(verdict.observed_file_id, null);
    assert.equal(verdict.observed_sha256, null);
    assert.equal(verdict.observed_path, null);
  });

  it('D2 句柄观测明确返回 OBJECT_MISSING ⇒ TARGET_REACHED，而不是恢复失败', () => {
    const verdict = judge(deleteItem(), {
      kind: 'unavailable',
      reason: 'OBJECT_MISSING',
      detail: '护栏确认授权根下的目标路径不存在。',
    });
    assert.equal(verdict.kind, 'TARGET_REACHED');
  });

  it('D3 删除未发生且原身份/内容仍在 ⇒ ORIGINAL', () => {
    assert.equal(judge(deleteItem(), PRESENT_BASE).kind, 'ORIGINAL');
  });

  it('D4 删除后按快照重建且字节等于原基线 ⇒ ORIGINAL，无需再写', () => {
    const verdict = judge(deleteItem(), { ...PRESENT_BASE, file_id: OTHER_ID });
    assert.equal(verdict.kind, 'ORIGINAL');
    assert.match(verdict.detail, /文件身份已重建/);
  });

  it('D5 同一对象已有不同内容 ⇒ THIRD_CONTENT，不作自动删除/覆盖', () => {
    assert.equal(judge(deleteItem(), PRESENT_THIRD).kind, 'THIRD_CONTENT');
  });
});

// ---------------------------------------------------------------------------
// E. 纯函数性质
// ---------------------------------------------------------------------------

describe('LWB-030 E. 判定是纯的', () => {
  it('E1 同一个输入判两次，结果**逐字段**相同', () => {
    const item = editItem();
    const first = judge(item, PRESENT_TARGET);
    const second = judge(item, PRESENT_TARGET);
    assert.deepEqual(first, second);
  });

  it('E2 判定不改写传进来的观测与条目', () => {
    const item = editItem();
    const observation: Observation = { ...PRESENT_TARGET };
    const before = structuredClone(observation);
    judge(item, observation);
    assert.deepEqual(observation, before);
    assert.equal(item.canonical_path, 'src/app.ts');
  });

  it('E3 `observationOf` 把失败回执翻成 `unavailable`，原因原样保留', () => {
    const observation = observationOf({
      ok: false,
      reason: 'GUARD_UNAVAILABLE',
      detail: '护栏没起来。',
    });
    assert.equal(observation.kind === 'unavailable' && observation.reason, 'GUARD_UNAVAILABLE');
    assert.equal(observation.kind === 'unavailable' && observation.detail, '护栏没起来。');
  });

  it('E4 成功的回执被翻成 `present`，五个字段一个不少', () => {
    const observation = observationOf({
      ok: true,
      file_id: BASE_ID,
      sha256: BASE,
      size: 42,
      canonical_path: 'src/App.ts',
    });
    assert.deepEqual(observation, {
      kind: 'present',
      file_id: BASE_ID,
      sha256: BASE,
      size: 42,
      canonical_path: 'src/App.ts',
    });
  });
});
