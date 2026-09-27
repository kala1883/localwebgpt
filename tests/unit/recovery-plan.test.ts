/**
 * LWB-030 单元测试：折叠、摘要与收场判据。
 *
 * ## 三块各自在证什么
 *
 *  - **折叠**（`reconciliationOf`）：逐条目判定加起来是什么，以及**哪一些加法
 *    结果可以自动定案**。这一块的验收标准是「枚举好情形，其余全落到人工」，
 *    因此本文件穷举一切可能的组合（4 种判定 × 1~3 条），逐个数出自动定案的
 *    格数 —— **只有两格**：全 `TARGET_REACHED` 与全 `ORIGINAL`。
 *  - **摘要**（`planDigestOf`）：它要能区分「观测变了」的一切。因此本文件
 *    逐字段改动，每一次都必须让摘要变 —— 而**只改判定之外的显示字段**
 *    不该让它变（比如条目数量不变时改条目 id 会变，那是应当的；
 *    但同一份观测重算两次必须逐字节相同）。
 *  - **收场判据**（`repairOf`）：三条拒绝理由各自被触发一次，外加一条
 *    「可以收场时，目标按倒序给出」。
 *
 * ## 摘要里为什么专门查「不含绝对路径」
 *
 * 摘要会被写进状态库。一个把工作区根拼进去的摘要是「摘要里出现本机路径」的
 * 最短路径，而「凭证与路径不进日志、不进证据」是本工程的硬约束。
 * 本文件用一个假的工作区根拼一次，再断言摘要里**查不到**它。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planDigestOf, reconciliationOf, repairOf } from '@lwb/recovery';
import type { ItemPlan, ItemVerdict, RecoveryPlan } from '@lwb/recovery';
import type { ChangeItemRecord } from '@lwb/persistence';

// ---------------------------------------------------------------------------
// 构造器
// ---------------------------------------------------------------------------

const BASE = 'a'.repeat(64);
const TARGET = 'b'.repeat(64);
const THIRD = 'c'.repeat(64);

function item(seq: number, overrides: Partial<ChangeItemRecord> = {}): ChangeItemRecord {
  return {
    id: `ci_${String(seq)}`,
    change_id: 'chg_1',
    seq,
    op: 'edit_text',
    canonical_path: `src/f${String(seq)}.ts`,
    canonical_path_key: `src/f${String(seq)}.ts`,
    base_file_id: `fid_${String(seq)}`,
    base_sha256: BASE,
    target_sha256: TARGET,
    old_blob_id: `blb_old_${String(seq)}`,
    new_blob_id: `blb_new_${String(seq)}`,
    encoding: 'utf-8',
    bom: false,
    newline: 'lf',
    added_lines: 1,
    removed_lines: 0,
    created_at: '2026-09-26T00:00:00.000Z',
    ...overrides,
  };
}

const VERDICTS = {
  ORIGINAL: {
    kind: 'ORIGINAL',
    observed_file_id: 'fid_1',
    observed_sha256: BASE,
    observed_path: 'src/f1.ts',
    detail: '核验到原状态。',
  },
  TARGET_REACHED: {
    kind: 'TARGET_REACHED',
    observed_file_id: 'fid_1',
    observed_sha256: TARGET,
    observed_path: 'src/f1.ts',
    detail: '核验到目标状态。',
  },
  THIRD_CONTENT: {
    kind: 'THIRD_CONTENT',
    observed_file_id: 'fid_1',
    observed_sha256: THIRD,
    observed_path: 'src/f1.ts',
    detail: '第三种内容。',
  },
  IDENTITY_UNKNOWN: {
    kind: 'IDENTITY_UNKNOWN',
    reason: 'REPLACED_OBJECT',
    detail: '对象被替换过。',
  },
} as const satisfies Record<string, ItemVerdict>;

type VerdictName = keyof typeof VERDICTS;

/**
 * 一条计划条目。
 *
 * 传进来的判定**原样**交给折叠与摘要 —— 这里不替调用方「补全」观测字段。
 * 补全会让 F 组那些「只改一个观测字段」的用例静默失效（改的那个值被
 * 覆盖回去了），而它们恰恰是本组存在的理由。
 */
function plan(seq: number, verdict: ItemVerdict, overrides: Partial<ChangeItemRecord> = {}): ItemPlan {
  return { item: item(seq, overrides), verdict };
}

function fullPlan(items: readonly ItemPlan[]): RecoveryPlan {
  return {
    operation_id: 'op_1',
    change_id: 'chg_1',
    workspace_id: 'ws_1',
    volume_id: 'vol_1',
    root_file_id: 'fid_root',
    items,
  };
}

/** 4 种判定取 `n` 条的全部组合（可重复）。 */
function combos(n: number): VerdictName[][] {
  const names: VerdictName[] = ['ORIGINAL', 'TARGET_REACHED', 'THIRD_CONTENT', 'IDENTITY_UNKNOWN'];
  if (n === 0) return [[]];
  const out: VerdictName[][] = [];
  for (const prefix of combos(n - 1)) {
    for (const name of names) out.push([...prefix, name]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// E. 折叠：枚举好情形，其余全落到人工
// ---------------------------------------------------------------------------

describe('LWB-030 E. 折叠 —— 自动定案的格数是可以数出来的', () => {
  it('E1 全 TARGET_REACHED ⇒ APPLIED', () => {
    const result = reconciliationOf([plan(1, VERDICTS.TARGET_REACHED), plan(2, VERDICTS.TARGET_REACHED)]);
    assert.deepEqual(result, { kind: 'APPLIED', reason: 'ALL_TARGET' });
  });

  it('E2 全 ORIGINAL ⇒ ROLLED_BACK', () => {
    const result = reconciliationOf([plan(1, VERDICTS.ORIGINAL), plan(2, VERDICTS.ORIGINAL)]);
    assert.deepEqual(result, { kind: 'ROLLED_BACK', reason: 'ALL_ORIGINAL' });
  });

  it('E3 空计划 ⇒ MANUAL(NO_ITEMS)：一张空计划不构成任何证据', () => {
    assert.deepEqual(reconciliationOf([]), { kind: 'MANUAL', reason: 'NO_ITEMS' });
  });

  it('E4 一条已达 + 一条未变 ⇒ MANUAL(MIXED)：没有任何不写字节的收场方式', () => {
    // 「接受现状」这个方向就是把 ORIGINAL 那些补写成目标，也就是
    // 重放一次旧批准 —— §8.4 明令禁止。因此混合态没有自动出路。
    const result = reconciliationOf([plan(1, VERDICTS.TARGET_REACHED), plan(2, VERDICTS.ORIGINAL)]);
    assert.deepEqual(result, { kind: 'MANUAL', reason: 'MIXED' });
  });

  it('E5 主因的报法：身份不明**先于**第三种内容（更具体的那个原因胜出）', () => {
    const result = reconciliationOf([plan(1, VERDICTS.THIRD_CONTENT), plan(2, VERDICTS.IDENTITY_UNKNOWN)]);
    assert.deepEqual(result, { kind: 'MANUAL', reason: 'IDENTITY_UNKNOWN' });
  });

  it('E6 身份不明**先于**「全清一色」的判法', () => {
    // 顺序反过来写会让「三条已达 + 一条判不出」被报成 MIXED ——
    // 那比真实原因含糊，而操作者要读的正是「哪一条判不出、为什么」。
    const result = reconciliationOf([
      plan(1, VERDICTS.TARGET_REACHED),
      plan(2, VERDICTS.TARGET_REACHED),
      plan(3, VERDICTS.IDENTITY_UNKNOWN),
    ]);
    assert.deepEqual(result, { kind: 'MANUAL', reason: 'IDENTITY_UNKNOWN' });
  });

  it('E7 穷举 1~3 条的**全部** 4^n 种组合：只有两格是自动定案', () => {
    let automatic = 0;
    let checked = 0;
    for (const n of [1, 2, 3]) {
      for (const combo of combos(n)) {
        const items = combo.map((name, index) => plan(index + 1, VERDICTS[name]));
        const result = reconciliationOf(items);
        checked += 1;
        if (result.kind === 'APPLIED') {
          automatic += 1;
          // 自动定案的**充要条件**：每一条都是 TARGET_REACHED。
          assert.ok(combo.every((name) => name === 'TARGET_REACHED'), `不该定案：${combo.join(',')}`);
        } else if (result.kind === 'ROLLED_BACK') {
          automatic += 1;
          assert.ok(combo.every((name) => name === 'ORIGINAL'), `不该定案：${combo.join(',')}`);
        } else {
          // 判成人工时，**必须**有一条理由说得出口。
          assert.ok(result.reason.length > 0);
          assert.notEqual(combo.every((name) => name === 'TARGET_REACHED'), true);
          assert.notEqual(combo.every((name) => name === 'ORIGINAL'), true);
        }
      }
    }
    assert.equal(checked, 4 + 16 + 64);
    // 每个 n 各两格：全目标、全原状。
    assert.equal(automatic, 2 * 3);
  });

  it('E8 判成人工时**不会**顺手给出任何写入动作', () => {
    // MANUAL 那一支上没有任何可以被误读成「那就写吧」的字段。
    const result = reconciliationOf([plan(1, VERDICTS.THIRD_CONTENT)]);
    assert.deepEqual(Object.keys(result).sort(), ['kind', 'reason']);
  });
});

// ---------------------------------------------------------------------------
// F. 摘要
// ---------------------------------------------------------------------------

describe('LWB-030 F. 摘要 —— 覆盖观测，且只覆盖该覆盖的', () => {
  const base = fullPlan([plan(1, VERDICTS.TARGET_REACHED), plan(2, VERDICTS.ORIGINAL)]);

  it('F1 同一份计划算两次，逐字节相同', () => {
    assert.equal(planDigestOf(base), planDigestOf(base));
    assert.equal(planDigestOf(base).length, 64);
  });

  it('F2 观测到的**内容哈希**变了 ⇒ 摘要变', () => {
    const changed = fullPlan([
      plan(1, { ...VERDICTS.TARGET_REACHED, observed_sha256: THIRD }),
      plan(2, VERDICTS.ORIGINAL),
    ]);
    assert.notEqual(planDigestOf(base), planDigestOf(changed));
  });

  it('F3 观测到的**对象身份**变了 ⇒ 摘要变', () => {
    const changed = fullPlan([
      plan(1, { ...VERDICTS.TARGET_REACHED, observed_file_id: 'fid_别的' }),
      plan(2, VERDICTS.ORIGINAL),
    ]);
    assert.notEqual(planDigestOf(base), planDigestOf(changed));
  });

  it('F4 观测到的**磁盘拼写**变了 ⇒ 摘要变（写回会按新拼写发请求）', () => {
    const changed = fullPlan([
      plan(1, { ...VERDICTS.TARGET_REACHED, observed_path: 'src/F1.ts' }),
      plan(2, VERDICTS.ORIGINAL),
    ]);
    assert.notEqual(planDigestOf(base), planDigestOf(changed));
  });

  it('F5 判定的**种类**变了 ⇒ 摘要变', () => {
    const changed = fullPlan([plan(1, VERDICTS.TARGET_REACHED), plan(2, VERDICTS.THIRD_CONTENT)]);
    assert.notEqual(planDigestOf(base), planDigestOf(changed));
  });

  it('F6 判不出的**原因**变了 ⇒ 摘要变', () => {
    const first = fullPlan([plan(1, { ...VERDICTS.IDENTITY_UNKNOWN, reason: 'REPLACED_OBJECT' })]);
    const second = fullPlan([plan(1, { ...VERDICTS.IDENTITY_UNKNOWN, reason: 'OBJECT_MISSING' })]);
    assert.notEqual(planDigestOf(first), planDigestOf(second));
  });

  it('F7 条目**顺序**变了 ⇒ 摘要变（顺序本身是被绑定的）', () => {
    const swapped = fullPlan([plan(2, VERDICTS.ORIGINAL), plan(1, VERDICTS.TARGET_REACHED)]);
    assert.notEqual(planDigestOf(base), planDigestOf(swapped));
  });

  it('F8 操作的物理身份变了（换了卷/根）⇒ 摘要变', () => {
    const otherVolume = { ...base, volume_id: 'vol_2' };
    assert.notEqual(planDigestOf(base), planDigestOf(otherVolume));
    const otherRoot = { ...base, root_file_id: 'fid_root_2' };
    assert.notEqual(planDigestOf(base), planDigestOf(otherRoot));
  });

  it('F9 摘要里**不含**任何绝对路径（含工作区根）', () => {
    // 摘要会被写进状态库。本工程里「本机路径进状态库」这件事没有正当理由。
    const absolute = 'D:\\MyProjects\\MyApps\\LocalWebGPT';
    const withPath = fullPlan([
      plan(1, { ...VERDICTS.TARGET_REACHED, observed_path: absolute }),
      plan(2, VERDICTS.ORIGINAL),
    ]);
    const digest = planDigestOf(withPath);
    assert.equal(digest.includes(absolute), false);
    assert.equal(digest.includes('D:'), false);
    assert.equal(digest.includes('\\'), false);
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  it('F10 判定详情（给人读的那句话）**不进**摘要', () => {
    // 换一句措辞不该让一份已经签发的授权失效 —— 摘要绑的是可观测量，
    // 不是文案。这是一条容易被「把整条判定 JSON 化」的实现破坏的性质。
    const reworded = fullPlan([
      plan(1, { ...VERDICTS.TARGET_REACHED, detail: '换一句完全不同的说法。' }),
      plan(2, VERDICTS.ORIGINAL),
    ]);
    assert.equal(planDigestOf(base), planDigestOf(reworded));
  });

  it('F11 计划长度变化 ⇒ 摘要变', () => {
    const longer = fullPlan([...base.items, plan(3, VERDICTS.ORIGINAL)]);
    assert.notEqual(planDigestOf(base), planDigestOf(longer));
  });
});

// ---------------------------------------------------------------------------
// G. 收场判据
// ---------------------------------------------------------------------------

describe('LWB-030 G. 收场 —— 三条拒绝理由各自都要能被触发', () => {
  it('G1 有第三种内容 ⇒ 拒绝，且说清楚有几个、是哪一类', () => {
    const result = repairOf([plan(1, VERDICTS.TARGET_REACHED), plan(2, VERDICTS.THIRD_CONTENT)]);
    assert.equal(result.kind, 'refused');
    assert.equal(result.kind === 'refused' && result.reason, 'HAS_UNRESOLVED_ITEMS');
    assert.equal(result.kind === 'refused' && /1 个条目/.test(result.detail), true);
  });

  it('G2 有身份不明 ⇒ 同样是 HAS_UNRESOLVED_ITEMS', () => {
    const result = repairOf([plan(1, VERDICTS.IDENTITY_UNKNOWN)]);
    assert.equal(result.kind === 'refused' && result.reason, 'HAS_UNRESOLVED_ITEMS');
  });

  it('G3 全在基线上 ⇒ NOTHING_TO_ROLL_BACK（这次不需要授权）', () => {
    const result = repairOf([plan(1, VERDICTS.ORIGINAL), plan(2, VERDICTS.ORIGINAL)]);
    assert.equal(result.kind === 'refused' && result.reason, 'NOTHING_TO_ROLL_BACK');
  });

  it('G4 空计划 ⇒ NOTHING_TO_ROLL_BACK（不是 HAS_UNRESOLVED_ITEMS）', () => {
    // 两条都成立时取哪一条：空计划里没有「未处理的条目」，
    // 只有「没有东西可收」。报前者会让人去找一个不存在的现场。
    const result = repairOf([]);
    assert.equal(result.kind === 'refused' && result.reason, 'NOTHING_TO_ROLL_BACK');
  });

  it('G5 要收回的东西里有**新建**的文件 ⇒ CREATED_OBJECT_NOT_REMOVED', () => {
    // 本工程不删文件：护栏没有删除操作，这里也不去造一个。
    // 一个多余的文件是可逆的，因此宁可要求人工处理它。
    const created = plan(1, VERDICTS.TARGET_REACHED, {
      op: 'create_text',
      canonical_path: 'docs/new.md',
      base_file_id: null,
      base_sha256: null,
      old_blob_id: null,
    });
    const result = repairOf([created, plan(2, VERDICTS.TARGET_REACHED)]);
    assert.equal(result.kind === 'refused' && result.reason, 'CREATED_OBJECT_NOT_REMOVED');
    assert.equal(result.kind === 'refused' && result.detail.includes('docs/new.md'), true);
  });

  it('G6 可以收场时，动作是 ROLLBACK_TO_BASELINE，目标按 **seq 倒序**', () => {
    const result = repairOf([
      plan(1, VERDICTS.TARGET_REACHED),
      plan(2, VERDICTS.ORIGINAL),
      plan(3, VERDICTS.TARGET_REACHED),
    ]);
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') return;
    assert.equal(result.action, 'ROLLBACK_TO_BASELINE');
    // 与 `apply.ts` 的回滚同序：正向是 seq 升序，收回来就反过来。
    assert.deepEqual(result.targets.map((entry) => entry.item.seq), [3, 1]);
  });

  it('G7 已经在基线上的条目**不**进收场目标（没有东西要写回去）', () => {
    const result = repairOf([plan(1, VERDICTS.TARGET_REACHED), plan(2, VERDICTS.ORIGINAL)]);
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') return;
    assert.deepEqual(result.targets.map((entry) => entry.item.seq), [1]);
  });

  it('G8 「可以收场」这个集合里**没有**任何指向「写到目标」的动作', () => {
    // 结构性的保证：这个模块里不存在「把目标写上去」这条路 ——
    // 不是「我们记得不要去调它」，是那条路根本没有被写出来。
    const result = repairOf([plan(1, VERDICTS.TARGET_REACHED)]);
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') return;
    assert.equal(result.action, 'ROLLBACK_TO_BASELINE');
    assert.equal(String(result.action).includes('APPLY'), false);
  });
});
