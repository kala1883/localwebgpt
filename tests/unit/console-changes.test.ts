/**
 * LWB-023 与 LWB-036 的单元测试（一）：待批准页面的视图模型。
 *
 * ## 验收标准，这里各测到哪一半
 *
 * | 验收标准 | 本文件 | `apps/console/tests/*.spec.ts` |
 * | --- | --- | --- |
 * | LWB-023·1 摘要写「无害」仍显示全部事实与风险 | **判定的那一半**（摘要不参与事实计算） | 渲染出来的那一半（两个分区都在屏幕上） |
 * | LWB-023·2 可疑字符有可视化提示 | **检出的那一半**（逐码位、含代理对） | 渲染出来的那一半（占位块真的出现在 DOM 里） |
 * | LWB-023·3 未登录不能批准 | **判定与理由的那一半** | 渲染出来的那一半（按钮不在 DOM 里） |
 * | LWB-036·1 不会批准未展示的隐含文件 | **判定的那一半**（E 组：没看全就不给批准） | 渲染出来的那一半（按钮不在 DOM 里，且说得出差哪几个） |
 * | LWB-036 步骤 2 状态实时更新只走本地认证接口 | **策略的那一半**（G 组：节奏、退避、终态即停、在途合并） | ——（驱动方是宿主，见 `refresh.ts` 的文件头） |
 *
 * LWB-036 的三条验收里，「不会批准未展示的隐含文件」是唯一能在这一层
 * 判到底的一条：它问的是「允许批准吗」，而答案是一个纯函数的返回值。
 * 另外两条（同时发生只执行一次、静态资源本地加载）的判决点在别处：
 * 前者在服务端的状态库（一个 change 只有一个 operation），后者在
 * 构建产物与 `DiffView` 的结构里，因此各自在各自的装置上取证。
 *
 * 这么分是因为这一层**不依赖 DOM**（`apps/console/src/changes/` 只用
 * ES2023，根 tsconfig 里没有 DOM lib）。同一个断言能在 node 里跑，
 * 就不该只在浏览器里跑一次 —— 一份只能在「我先点一遍」的条件下成立的
 * 验收，等于没有验收。
 *
 * ## 两个容易写成同义反复的地方，都刻意避开了
 *
 *  - 验收标准 1 的核心是「摘要**不参与**事实计算」。若只断言
 *    「摘要写无害时事实区仍然正确」，一个**读了摘要但恰好没影响结果**的
 *    实现也会通过。因此 A 组用**同一批文件、只有摘要不同**的两个视图，
 *    断言两次 `describeChange` 产出的 `facts` **逐字段相同** ——
 *    比较的是两个结果之间的关系，不是某一个结果长什么样。
 *  - 验收标准 2 的可疑字符大多是**不可见**的。若断言「文本里有 U+202E」，
 *    那是在断言夹具写对了；有意义的是「渲染出来的东西里**没有**它，
 *    而多了一个可见的占位」—— 见 D 组与 vitest 侧。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import type { ChangeFilePreview, ChangeRisk, ChangeSetView } from '@lwb/contracts';

import {
  appendDiffPage,
  approvalAffordance,
  approvalIdempotencyKey,
  BACKOFF_MAX_MS,
  breakdownOf,
  CHANGE_STATE_WHITELIST,
  parseChangeDetail,
  progressFromTexts,
  countByCategory,
  describeChange,
  EXECUTING_INTERVAL_MS,
  expiryOf,
  findSuspicious,
  formatBytes,
  formatLineDelta,
  hasSuspicious,
  positionLabel,
  recordFullTexts,
  recordPage,
  REFRESH_ENDPOINT,
  refreshDecisionOf,
  reviewCoverageOf,
  REVIEW_KEYMAP,
  actionFor,
  clampIndex,
  segmentText,
  SingleFlight,
  stepFile,
  visualizeSuspicious,
  WATCHING_INTERVAL_MS,
} from '../../apps/console/src/changes/index.ts';
import type { DiffProgress, ReviewCoverage } from '../../apps/console/src/changes/index.ts';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function file(over: Partial<ChangeFilePreview> & { readonly path: string }): ChangeFilePreview {
  return {
    op: 'edit_text',
    before_sha256: 'a'.repeat(64),
    after_sha256: 'b'.repeat(64),
    before_size: 100,
    after_size: 120,
    encoding: 'utf-8',
    newline: 'lf',
    bom: false,
    added_lines: 3,
    removed_lines: 1,
    ...over,
  };
}

function view(over: Partial<ChangeSetView> = {}): ChangeSetView {
  return {
    change_id: 'chg_0001',
    workspace_id: 'ws_0001',
    state: 'PENDING_APPROVAL',
    approval_required: true,
    digest: 'c'.repeat(64),
    short_code: 'CCCC-CCCC',
    summary: '仅调整注释格式，无功能变化。',
    files: [file({ path: 'src/app.ts' })],
    risks: [],
    created_at: '2026-09-25T10:00:00.000Z',
    expires_at: '2026-09-25T10:10:00.000Z',
    workspace_modified: false,
    next_action: '等待本地操作者批准。',
    ...over,
  };
}

const NOW = '2026-09-25T10:05:00.000Z';

// ---------------------------------------------------------------------------
// A 组：验收标准 1 —— 摘要不参与事实计算
// ---------------------------------------------------------------------------

describe('A 组 · 摘要与事实的分区（验收标准 1）', () => {
  it('A1 同一批文件、只有摘要不同时，事实区逐字段相同', () => {
    const benign = view({ summary: '仅调整注释格式，无功能变化，无害。' });
    const alarming = view({ summary: '删除三分之一代码，重命名全部导出，改动了鉴权逻辑。' });

    const a = describeChange(benign).facts;
    const b = describeChange(alarming).facts;

    // 逐字段比而不是比 JSON 字符串：字符串比会把「字段顺序」也算进去，
    // 而字段顺序不是这里要证明的东西。
    assert.deepEqual(a.totals, b.totals, '修改量不应随摘要变化');
    assert.deepEqual(a.risks, b.risks, '风险不应随摘要变化');
    assert.equal(a.risk_breakdown.has_warning, b.risk_breakdown.has_warning);
    assert.deepEqual(
      a.files.map((f) => [f.path, f.added_lines, f.removed_lines, f.before_sha256, f.after_sha256]),
      b.files.map((f) => [f.path, f.added_lines, f.removed_lines, f.before_sha256, f.after_sha256]),
      '逐文件事实不应随摘要变化',
    );
  });

  it('A2 摘要只说"无害"而事实是大量删改时，事实区照常报出全部数字', () => {
    const files = Array.from({ length: 12 }, (_, i) =>
      file({ path: `src/mod${i}.ts`, removed_lines: 40, added_lines: 2, before_size: 9000, after_size: 3000 }),
    );
    const risks: ChangeRisk[] = [
      { level: 'warning', code: 'MULTIPLE_FILES', message: '本次修改涉及 12 个文件；批准前请逐个核对。' },
      { level: 'warning', code: 'LARGE_DELETION', message: 'src/mod0.ts 删除 40 行、新增 2 行 —— 净减少 38 行。' },
    ];

    const described = describeChange(view({ summary: '无害的小改动。', files, risks }));

    assert.equal(described.facts.totals.file_count, 12);
    assert.equal(described.facts.totals.removed_lines, 480);
    assert.equal(described.facts.totals.added_lines, 24);
    assert.equal(described.facts.totals.net_lines, -456);
    assert.equal(described.facts.risk_breakdown.warnings, 2);
    assert.equal(described.facts.risk_breakdown.has_warning, true);
    assert.equal(described.facts.files.length, 12, '12 个文件一个都不能少');

    // 摘要在**另一个**对象里，原样保留。界面把它显示出来是应该的 ——
    // 要防的是它影响事实，不是它出现。
    assert.equal(described.model_prose.summary, '无害的小改动。');
  });

  it('A3 模型的话与事实是两个平级字段，且带固定标签', () => {
    const described = describeChange(view({ summary: '随便写点什么。' }));
    assert.deepEqual(Object.keys(described).sort(), ['facts', 'model_prose']);
    assert.equal(described.model_prose.label, '模型撰写（不受信）');
    assert.match(described.model_prose.untrusted_notice, /不是\*\*系统判定依据/);
  });

  it('A4 修改量逐项加总正确，且新建文件的修改前字节按契约记为 0', () => {
    const described = describeChange(
      view({
        files: [
          file({ path: 'a.ts', added_lines: 5, removed_lines: 2, before_size: 10, after_size: 20 }),
          file({ path: 'b.ts', op: 'create_text', before_sha256: null, added_lines: 7, removed_lines: 0, before_size: 0, after_size: 70 }),
          file({ path: 'c.ts', op: 'replace_text', added_lines: 1, removed_lines: 9, before_size: 100, after_size: 50 }),
        ],
      }),
    );
    assert.deepEqual(described.facts.totals, {
      file_count: 3,
      added_lines: 13,
      removed_lines: 11,
      net_lines: 2,
      created_files: 1,
      deleted_files: 0,
      replaced_files: 1,
      edited_files: 1,
      before_bytes: 110,
      after_bytes: 140,
    });
  });

  it('A5 风险分级计数与 has_warning 一致（界面据此决定通栏提示）', () => {
    const risks: ChangeRisk[] = [
      { level: 'warning', code: 'X', message: 'x' },
      { level: 'notice', code: 'Y', message: 'y' },
      { level: 'notice', code: 'Z', message: 'z' },
      { level: 'info', code: 'W', message: 'w' },
    ];
    const breakdown = breakdownOf(risks);
    assert.deepEqual(breakdown, { total: 4, warnings: 1, notices: 2, infos: 1, has_warning: true });
    assert.equal(breakdownOf([]).has_warning, false);
  });
});

// ---------------------------------------------------------------------------
// B 组：格式化
// ---------------------------------------------------------------------------

describe('B 组 · 格式化', () => {
  it('B1 行数增量用数学减号，不用 ASCII 连字符', () => {
    const text = formatLineDelta(3, 1);
    assert.equal(text, '+3 −1');
    // 这一条是本组的重点：`+3 -1` 里的连字符与 diff 正文里的删除标记
    // 是同一种字形，而这两个数字旁边通常就是差异正文。
    assert.equal(text.includes('-'), false, '不得出现 ASCII 连字符');
    assert.equal(formatLineDelta(5, 0), '+5 −0');
  });

  it('B2 字节数按量级换单位', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1024), '1.0 KiB');
    assert.equal(formatBytes(1536), '1.5 KiB');
    assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MiB');
  });

  it('B3 有效期倒计时把 now 当参数（不读时钟），并给出剩余时间', () => {
    const countdown = expiryOf('2026-09-25T10:10:00.000Z', NOW);
    assert.equal(countdown.expired, false);
    assert.equal(countdown.remaining_ms, 5 * 60 * 1000);
    assert.equal(countdown.text, '剩余 5 分 00 秒');
  });

  it('B4 到期与解析失败是两个不同的结果，不互相折合', () => {
    const expired = expiryOf('2026-09-25T10:04:59.000Z', NOW);
    assert.equal(expired.expired, true);
    assert.equal(expired.text, '已过期');

    const broken = expiryOf('不是时间', NOW);
    // **解析不出来不得折成「已过期」**：那会让人以为批准坏了。
    // 也不得折成「无限期」：那会让人以为可以一直等。
    assert.equal(broken.expired, false);
    assert.equal(broken.text, '有效期无法解析');

    const brokenNow = expiryOf('2026-09-25T10:10:00.000Z', '也不是时间');
    assert.equal(brokenNow.expired, false);
    assert.equal(brokenNow.text, '有效期无法解析');
  });

  it('B5 剩余时间正好为零时算已过期（边界不属于「还有效」）', () => {
    assert.equal(expiryOf(NOW, NOW).expired, true);
  });
});

// ---------------------------------------------------------------------------
// C 组：验收标准 2 —— 可疑字符的检出
// ---------------------------------------------------------------------------

describe('C 组 · 可疑字符检出（验收标准 2）', () => {
  it('C1 每一类的代表字符都能检出，且报出正确码位', () => {
    const cases: readonly [string, number, string][] = [
      ['\u202E', 0x202e, 'bidi_override'],
      ['\u202D', 0x202d, 'bidi_override'],
      ['\u202A', 0x202a, 'bidi_embedding'],
      ['\u202B', 0x202b, 'bidi_embedding'],
      ['\u202C', 0x202c, 'bidi_embedding'],
      ['\u2066', 0x2066, 'bidi_isolate'],
      ['\u2069', 0x2069, 'bidi_isolate'],
      ['\u200E', 0x200e, 'bidi_mark'],
      ['\u200F', 0x200f, 'bidi_mark'],
      ['\u061C', 0x061c, 'bidi_mark'],
      ['\u200B', 0x200b, 'zero_width'],
      ['\u200C', 0x200c, 'zero_width'],
      ['\u200D', 0x200d, 'zero_width'],
      ['\u2060', 0x2060, 'zero_width'],
      ['\uFEFF', 0xfeff, 'zero_width'],
      ['\u00AD', 0x00ad, 'invisible'],
      ['\u034F', 0x034f, 'invisible'],
      ['\u3164', 0x3164, 'invisible'],
      ['\u2800', 0x2800, 'invisible'],
      ['\u{E0041}', 0xe0041, 'tag_character'],
      ['\uFE0F', 0xfe0f, 'variation_selector'],
      ['\u{E0100}', 0xe0100, 'variation_selector'],
    ];
    for (const [text, codepoint, category] of cases) {
      const found = findSuspicious(text);
      assert.equal(found.length, 1, `${category} 应当检出恰好一个，实际 ${found.length}`);
      assert.equal(found[0]?.codepoint, codepoint, `码位应为 U+${codepoint.toString(16)}`);
      assert.equal(found[0]?.category, category);
      assert.notEqual(found[0]?.label, '', '必须带一个可读的名字');
      assert.notEqual(found[0]?.note, '', '必须说明它会造成什么');
    }
  });

  it('C2 标签字符在 BMP 之外，按码元遍历会漏掉它', () => {
    // U+E0041 的 UTF-16 是代理对（0xDB80 0xDC41），长度 2。
    // 这一条钉住的是「必须按码位遍历」：按 `charCodeAt` 走会把代理对
    // 读成两个无意义的高低位，于是整类标签字符**永远检不出来** ——
    // 而它恰恰是最适合夹带数据的一类。
    const tag = '\u{E0041}';
    assert.equal(tag.length, 2, '前提：它是代理对');
    const found = findSuspicious(tag);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.start, 0);
    assert.equal(found[0]?.length, 2, '长度按码元记，供切片使用');
  });

  it('C3 正常文本不误报，且下标可用来精确切片', () => {
    const normal = 'const 变量 = "中文 and English 123"; // 注释：emoji ✅ 🎉';
    assert.deepEqual(findSuspicious(normal), []);
    assert.equal(hasSuspicious(normal), false);

    const mixed = `abc${'\u202E'}def`;
    const found = findSuspicious(mixed);
    assert.equal(found[0]?.start, 3);
    assert.equal(mixed.slice(found[0]!.start, found[0]!.start + found[0]!.length), '\u202E');
  });

  it('C4 一段文本里的多个可疑字符各自报出位置', () => {
    const text = `a${'\u200B'}b${'\u202E'}c${'\u200B'}`;
    const found = findSuspicious(text);
    assert.deepEqual(
      found.map((f) => [f.start, f.codepoint]),
      [
        [1, 0x200b],
        [3, 0x202e],
        [5, 0x200b],
      ],
    );
    assert.deepEqual(countByCategory(found), { zero_width: 2, bidi_override: 1 });
  });

  it('C5 分段：相邻正常字符合并，可疑字符单独成段', () => {
    const segments = segmentText(`ab${'\u202E'}cd`);
    assert.deepEqual(
      segments.map((s) => s.kind),
      ['text', 'suspicious', 'text'],
    );
    assert.equal(segments[0]?.kind === 'text' ? segments[0].text : null, 'ab');
    assert.equal(segments[2]?.kind === 'text' ? segments[2].text : null, 'cd');

    // 合并的理由不是好看：一个大文件里逐字符成段会产生几十万个文本节点。
    const long = segmentText('x'.repeat(1000));
    assert.equal(long.length, 1);
  });

  it('C6 分段与检出用的是同一份判据（不会出现「提示了但没替换」）', () => {
    const text = `前${'\u202E'}后${'\u2066'}尾${'\u{E0041}'}`;
    const found = findSuspicious(text);
    const suspiciousSegments = segmentText(text).filter((s) => s.kind === 'suspicious');
    assert.equal(suspiciousSegments.length, found.length);
    assert.deepEqual(
      suspiciousSegments.map((s) => s.codepoint),
      found.map((f) => f.codepoint),
    );
  });

  it('C7 可视化表示里不含任何不可见字符，且与字节一一对应', () => {
    const text = `a${'\u202E'}b${'\u200B'}c`;
    const shown = visualizeSuspicious(text);
    assert.equal(shown, 'a⟦U+202E⟧b⟦U+200B⟧c');
    // 这是本组的要点：**输出里一个可疑字符都不剩**。
    // 否则「显示了」等于「没显示」—— 它本来就是不可见的。
    assert.equal(findSuspicious(shown).length, 0);
    assert.equal(hasSuspicious(shown), false);
  });

  it('C8 空文本与纯正常文本的两条路径都返回空', () => {
    assert.deepEqual(findSuspicious(''), []);
    assert.deepEqual(segmentText(''), []);
    assert.equal(visualizeSuspicious(''), '');
  });
});

// ---------------------------------------------------------------------------
// D 组：验收标准 3 —— 批准入口的判定
// ---------------------------------------------------------------------------

const SESSION = { session_id: 'sess_0001' };

/**
 * 复核覆盖的两个夹具（LWB-036）。
 *
 * `reviewed` 是**全部文件都完整看过**，`unreviewed` 是一个都没看过。
 * D 组绝大多数用例关心的是会话 / 状态 / 有效期，与复核无关，因此它们
 * 用 `reviewed` 把这一格填成「不构成拒绝」—— 那一格**必须**被填，
 * 因为它现在是必填输入（理由见 `approval.ts` 的 `coverage` 一节）。
 */
function reviewed(change: ChangeSetView | null): ReviewCoverage {
  return reviewCoverageOf({
    change,
    progress: (change?.files ?? []).map((file) => ({
      path: file.path,
      pages: 1,
      reached_end: true,
      full_texts: false,
    })),
    gate: null,
  });
}

function unreviewed(change: ChangeSetView | null): ReviewCoverage {
  return reviewCoverageOf({ change, progress: [], gate: null });
}

describe('D 组 · 批准入口（验收标准 3）', () => {
  it('D1 没有会话时不给批准，理由是「尚未建立」并提示重新登录', () => {
    const c = view();
    const gate = approvalAffordance({ session: null, change: c, coverage: reviewed(c), now: NOW });
    assert.equal(gate.can_approve, false);
    // 拒绝也不给，但理由与批准不同：这里不是「不允许」，是**发不出去**——
    // `ControlClient` 在没有会话时根本不会发出请求。所以这一格说的是
    // 「没有通道」，而不是「这个动作不该做」。
    assert.equal(gate.can_reject, false, '没有会话就没有通道，拒绝也发不出去');
    assert.equal(gate.blocked_reason, 'NO_SESSION');
    assert.equal(gate.offer_relogin, true);
  });

  it('D2 会话过期与尚未登录是两个不同的理由', () => {
    const c = view();
    const expired = approvalAffordance({
      session: null,
      session_expired: true,
      change: c,
      coverage: reviewed(c),
      now: NOW,
    });
    assert.equal(expired.blocked_reason, 'SESSION_EXPIRED');
    assert.equal(expired.offer_relogin, true);
    // 两者都给重新登录的入口，但说出来的话不同：一个说「还没登录」，
    // 一个说「刚过期」。对操作者的下一步，这两句指向不同的怀疑对象。
    const fresh = approvalAffordance({ session: null, change: c, coverage: reviewed(c), now: NOW });
    assert.notEqual(expired.message, fresh.message);
  });

  it('D3 有会话但修改集已到终态时不给动作', () => {
    for (const state of ['APPROVED', 'QUEUED', 'APPLIED', 'REJECTED', 'EXPIRED'] as const) {
      const c = view({ state });
      const gate = approvalAffordance({ session: SESSION, change: c, coverage: reviewed(c), now: NOW });
      assert.equal(gate.can_approve, false, `${state} 不应给批准`);
      assert.equal(gate.blocked_reason, 'WRONG_STATE');
      assert.equal(gate.offer_relogin, false, '状态问题不该提示重新登录');
    }
  });

  it('D4 待批准但已过期时不给动作', () => {
    const c = view({ expires_at: '2026-09-25T10:04:00.000Z' });
    const gate = approvalAffordance({ session: SESSION, change: c, coverage: reviewed(c), now: NOW });
    assert.equal(gate.can_approve, false);
    assert.equal(gate.blocked_reason, 'EXPIRED');
  });

  it('D5 有效期解析不了时按不能批准处理', () => {
    const c = view({ expires_at: '坏数据' });
    const gate = approvalAffordance({ session: SESSION, change: c, coverage: reviewed(c), now: NOW });
    assert.equal(gate.can_approve, false);
    assert.equal(gate.blocked_reason, 'EXPIRED');
  });

  it('D6 摘要为空时不给批准（没有可绑定的摘要）', () => {
    const c = view({ digest: '' });
    const gate = approvalAffordance({ session: SESSION, change: c, coverage: reviewed(c), now: NOW });
    assert.equal(gate.can_approve, false);
    assert.equal(gate.blocked_reason, 'DIGEST_MISSING');
  });

  it('D7 没有修改集时不给动作，且理由不是会话问题', () => {
    const gate = approvalAffordance({
      session: SESSION,
      change: null,
      coverage: unreviewed(null),
      now: NOW,
    });
    assert.equal(gate.can_approve, false);
    assert.equal(gate.blocked_reason, 'NO_CHANGE');
    assert.equal(gate.offer_relogin, false);
  });

  it('D8 判定的先后顺序：会话问题压过状态问题', () => {
    // 一个既没有会话、修改集又已经到期的页面应当说「请先登录」——
    // 说了「已过期」会让人以为登录之后还能救回来。
    const c = view({ state: 'APPLIED' });
    const gate = approvalAffordance({ session: null, change: c, coverage: reviewed(c), now: NOW });
    assert.equal(gate.blocked_reason, 'NO_SESSION');
  });

  it('D9 一切就绪时两个动作都给，并说明「不会立即写入」', () => {
    const c = view();
    const gate = approvalAffordance({ session: SESSION, change: c, coverage: reviewed(c), now: NOW });
    assert.equal(gate.can_approve, true);
    assert.equal(gate.can_reject, true);
    assert.equal(gate.blocked_reason, null);
    assert.match(gate.message, /不会立即写入/);
    assert.equal(gate.offer_relogin, false);
  });

  it('D10 幂等键绑定「这一个修改集的这一步」，重复点击收敛、换摘要则分开', () => {
    const a = approvalIdempotencyKey(view());
    const again = approvalIdempotencyKey(view());
    assert.equal(a, again, '同一份内容必须给出同一个键，否则重试会变成新请求');

    const otherDigest = approvalIdempotencyKey(view({ short_code: 'DDDD-DDDD' }));
    assert.notEqual(a, otherDigest, '内容变了就该是一个新的键');

    const otherChange = approvalIdempotencyKey(view({ change_id: 'chg_0002' }));
    assert.notEqual(a, otherChange, '不同的修改集必须分开');

    // 键要能被 `@lwb/idempotency` 的解析函数接受（长度 8..200、无控制字符）。
    assert.ok(a.length >= 8 && a.length <= 200, `键长度 ${a.length} 越界`);
    assert.equal(/[\u0000-\u001f\u007f]/.test(a), false);
  });

  it('D11 短编号缺失时仍然生成一个键，而不是抛错或给出空串', () => {
    // `short_code` 是派生值，理论上永远有；但一个会抛错的降级路径
    // 出现在「用户正要点批准」的那一刻是最坏的位置。
    const key = approvalIdempotencyKey(view({ short_code: '' }));
    assert.ok(key.length >= 8);
    assert.equal(key.includes('no-short-code'), true);
  });
});

// ---------------------------------------------------------------------------
// E 组：LWB-036 验收标准 1 —— 复核覆盖
// ---------------------------------------------------------------------------

describe('E 组 · 复核覆盖（LWB-036 验收标准 1）', () => {
  const twoFiles: ChangeSetView = view({
    files: [file({ path: 'src/app.ts' }), file({ path: '.git/hooks/pre-commit', op: 'create_text' })],
  });

  it('E1 有一个文件从未取回差异时，覆盖不完整，且**报出是哪一个**', () => {
    // 这一条是本组的判决点：验收标准里那个「未展示的隐含文件」
    // 就长这样 —— 清单上有它，屏幕上没有它。
    const coverage = reviewCoverageOf({
      change: twoFiles,
      progress: [{ path: 'src/app.ts', pages: 1, reached_end: true, full_texts: false }],
      gate: null,
    });

    assert.equal(coverage.status, 'incomplete');
    assert.deepEqual(coverage.unseen, ['.git/hooks/pre-commit']);
    assert.equal(coverage.message.includes('.git/hooks/pre-commit'), true, '要说清是哪一个文件');
    assert.equal(coverage.covered_count, 1);
    assert.equal(coverage.total_count, 2);
  });

  it('E2 覆盖不完整时，即使其余一切都就绪也不给批准', () => {
    const coverage = reviewCoverageOf({
      change: twoFiles,
      progress: [{ path: 'src/app.ts', pages: 1, reached_end: true, full_texts: false }],
      gate: null,
    });
    const gate = approvalAffordance({ session: SESSION, change: twoFiles, coverage, now: NOW });

    assert.equal(gate.can_approve, false, '没看全就不能批准 —— 这是整条标准的意义');
    assert.equal(gate.blocked_reason, 'UNSEEN_FILES');
    // **拒绝仍然给得出来。** 这一格是刻意反过来的：拒绝不需要看完，
    // 服务端的 `rejectChange` 也只重载、比对摘要、条件流转，不读内容。
    // 把拒绝一起堵上会让「安全的那条路比危险的那条更难走」——
    // 操作者看到第一个文件就发现问题，却要翻完剩下十一个才能说不。
    assert.equal(gate.can_reject, true, '拒绝不要求先看全');
  });

  it('E2b 内容取不到时批准不给，但拒绝仍然给 —— 那正是最想说不的时候', () => {
    const coverage = reviewCoverageOf({
      change: twoFiles,
      progress: [],
      gate: { allows_read: false, reason: 'WORKSPACE_PAUSED', message: '工作区已暂停。' },
    });
    const gate = approvalAffordance({ session: SESSION, change: twoFiles, coverage, now: NOW });

    assert.equal(gate.blocked_reason, 'CONTENT_UNAVAILABLE');
    assert.equal(gate.can_approve, false);
    assert.equal(gate.can_reject, true);
  });

  it('E3 全部看完之后才给批准，并且说明凭什么', () => {
    const coverage = reviewed(twoFiles);
    assert.equal(coverage.status, 'complete');

    const gate = approvalAffordance({ session: SESSION, change: twoFiles, coverage, now: NOW });
    assert.equal(gate.can_approve, true);
    assert.equal(gate.message.includes('2 个文件'), true, '要说清是看完了几个文件');
  });

  it('E4 差异被截断（没读到末尾）不算看过，且理由与「没打开过」分开', () => {
    const coverage = reviewCoverageOf({
      change: twoFiles,
      progress: [
        { path: 'src/app.ts', pages: 2, reached_end: false, full_texts: false },
        { path: '.git/hooks/pre-commit', pages: 1, reached_end: true, full_texts: false },
      ],
      gate: null,
    });

    assert.equal(coverage.status, 'incomplete');
    assert.deepEqual(coverage.truncated, ['src/app.ts']);
    assert.deepEqual(coverage.unseen, [], '它被打开过，只是没看完 —— 两件事不能混在一起');

    const gate = approvalAffordance({ session: SESSION, change: twoFiles, coverage, now: NOW });
    assert.equal(gate.blocked_reason, 'TRUNCATED_DIFF');
  });

  it('E5 原文与新文双双取回也算看过（不看差异的展示方式）', () => {
    // 判据必须认得控制台的**两种**展示方式。只认差异页会让
    // 「用原文/新文对照看的」那一次批准永远被拒，而界面给出的
    // 理由是「这个文件没看过」—— 一句假话。
    const coverage = reviewCoverageOf({
      change: twoFiles,
      progress: [
        { path: 'src/app.ts', pages: 0, reached_end: false, full_texts: true },
        { path: '.git/hooks/pre-commit', pages: 1, reached_end: true, full_texts: false },
      ],
      gate: null,
    });
    assert.equal(coverage.status, 'complete');
  });

  it('E6 只有页数、没有「读到末尾」的记录不算看过', () => {
    // `pages: 0` 却 `reached_end: true` 是一条自相矛盾的记录。
    // 它不该被算成看过 —— 这是本函数里唯一一处「宁可判严」的地方，
    // 而方向是选出来的：判成没看过只会让操作者多打开一次文件。
    const coverage = reviewCoverageOf({
      change: twoFiles,
      progress: [
        { path: 'src/app.ts', pages: 0, reached_end: true, full_texts: false },
        { path: '.git/hooks/pre-commit', pages: 0, reached_end: true, full_texts: false },
      ],
      gate: null,
    });
    assert.equal(coverage.status, 'incomplete');
    assert.equal(coverage.files[0]?.reason, 'NOT_DISPLAYED');
  });

  it('E7 空修改集不算「全都看过」', () => {
    // 平凡成立不等于成立：没有东西可看与看全了是两回事，
    // 合并它们会让一个空修改集拿到批准入口。
    const coverage = reviewCoverageOf({ change: view({ files: [] }), progress: [], gate: null });
    assert.equal(coverage.status, 'incomplete');
    assert.equal(coverage.message.includes('没有任何文件'), true);
  });

  it('E8 内容闸门拒绝时是第三种状态：看不到，因此批不了', () => {
    // 这一格与「还没看」不同：回去翻文件清单解决不了任何问题。
    const coverage = reviewCoverageOf({
      change: twoFiles,
      progress: [{ path: 'src/app.ts', pages: 1, reached_end: true, full_texts: false }],
      gate: { allows_read: false, reason: 'WORKSPACE_PAUSED', message: '该工作区已暂停。' },
    });

    assert.equal(coverage.status, 'unavailable');
    assert.equal(coverage.gate_reason, 'WORKSPACE_PAUSED');
    assert.equal(coverage.covered_count, 0, '闸门关着的时候，旧进度描述的是上一次');

    const gate = approvalAffordance({ session: SESSION, change: twoFiles, coverage, now: NOW });
    assert.equal(gate.can_approve, false);
    assert.equal(gate.blocked_reason, 'CONTENT_UNAVAILABLE');
    assert.equal(gate.message.includes('WORKSPACE_PAUSED'), true);
  });

  it('E9 复核类拒绝排在最后：已过期时先说过期，不让人白翻文件', () => {
    // 一个既已过期、又没看完的修改集，应当先说「已过期」。
    // 反过来的话，操作者会去翻那 3 个文件，翻完才发现早就过期了。
    const c = view({ expires_at: '2026-09-25T10:04:00.000Z' });
    const gate = approvalAffordance({
      session: SESSION,
      change: c,
      coverage: unreviewed(c),
      now: NOW,
    });
    assert.equal(gate.blocked_reason, 'EXPIRED');
  });

  it('E10 `recordPage` 逐页累加，且末页标记只由服务端的话决定', () => {
    let progress: readonly DiffProgress[] = [];
    progress = recordPage(progress, { path: 'src/app.ts', truncated: true });
    progress = recordPage(progress, { path: 'src/app.ts', truncated: false });

    const item = progress.find((p) => p.path === 'src/app.ts');
    assert.equal(item?.pages, 2);
    assert.equal(item?.reached_end, true);

    // 只累加页数、不标末页时仍然是「没看完」——两条事实必须一起更新，
    // 而它们由同一个函数更新，因此不可能只更新其中一个。
    const half = recordPage([], { path: 'src/app.ts', truncated: true });
    const coverage = reviewCoverageOf({ change: view(), progress: half, gate: null });
    assert.equal(coverage.status, 'incomplete');
    assert.equal(coverage.files[0]?.reason, 'TRUNCATED');
  });

  it('E11 `recordFullTexts` 不改变页数，也不把「没读到末尾」说成读到了', () => {
    const before = recordPage([], { path: 'src/app.ts', truncated: true });
    const after = recordFullTexts(before, 'src/app.ts');
    const item = after.find((p) => p.path === 'src/app.ts');

    assert.equal(item?.pages, 1, '整文件对照与差异分页是两个来源，各记各的');
    assert.equal(item?.reached_end, false, '取了原文新文不代表差异翻到了末尾');
    assert.equal(item?.full_texts, true);
  });
});

// ---------------------------------------------------------------------------
// F 组：LWB-036 步骤 1 —— 逐文件翻页与键盘
// ---------------------------------------------------------------------------

describe('F 组 · 翻页与键盘（LWB-036 步骤 1）', () => {
  it('F1 到边界停住，不绕回去', () => {
    assert.equal(stepFile(0, 3, -1), 0, '第一项再往前仍然是第一项');
    assert.equal(stepFile(2, 3, 1), 2, '最后一项再往后仍然是最后一项');
    assert.equal(stepFile(1, 3, 1), 2);
    assert.equal(stepFile(1, 3, -1), 0);

    // 绕回去与「清单变短了」在屏幕上长得一样，而「已经看完全部」
    // 正是批准的前提 —— 一个会绕回开头的界面让这件事无法判断。
    assert.equal(stepFile(0, 0, 1), 0, '空清单不该抛错');
  });

  it('F2 键盘映射里每一个动作都到得了，且没有重复的键', () => {
    const keys = REVIEW_KEYMAP.map((binding) => binding.key);
    assert.equal(new Set(keys).size, keys.length, '同一个键不能绑两个动作');

    // 每一个动作都必须有一个键 —— 一条只出现在表里的动作等于不存在。
    const actions = new Set(REVIEW_KEYMAP.map((binding) => binding.action));
    assert.deepEqual(
      [...actions].sort(),
      ['first-file', 'last-file', 'mode-after', 'mode-before', 'mode-unified', 'next-file', 'next-page', 'prev-file'],
    );
  });

  it('F3 批准与拒绝**没有**快捷键', () => {
    // 一次误触就能排入一次写盘，与「一个可以被重放的紧急按钮」
    // 是同一类问题。这条断言的作用是：将来有人想加，会先撞到这里。
    const actions: readonly string[] = REVIEW_KEYMAP.map((binding) => binding.action);
    assert.equal(actions.includes('approve'), false);
    assert.equal(actions.includes('reject'), false);
  });

  it('F4 认不出的键返回 null（要放行，不吃掉浏览器自己的快捷键）', () => {
    assert.equal(actionFor('j'), 'next-file');
    assert.equal(actionFor('ArrowDown'), 'next-file');
    assert.equal(actionFor('3'), 'mode-after');
    // `J` 与 `j` 是两个条目，因此大写返回 null —— 这正是「区分大小写」
    // 的意思：一个「按了 Shift 也照样生效」的映射，会在用户用
    // Ctrl+Shift+J 打开控制台时顺手翻一页。
    assert.equal(actionFor('J'), null);
    assert.equal(actionFor('F5'), null);
    assert.equal(actionFor('r'), null, '刷新没有键位：它是自动的');
  });

  it('F5 位置说明里不出现猜出来的总数', () => {
    assert.match(positionLabel(2, 12, 2, true), /第 3 \/ 12 个文件/);
    assert.match(positionLabel(2, 12, 2, true), /已到末页/);
    assert.match(positionLabel(0, 12, 1, false), /还有更多/);
    assert.match(positionLabel(0, 12, 0, null), /尚未载入/);
    // 游标分页不回答「还剩几页」，因此不能说 `2 / 5`。
    assert.equal(/共\s*\d+\s*页/.test(positionLabel(0, 12, 3, false)), false);

    // 「还不知道」（`null`）与「后面还有」（`false`）是两件事。
    assert.equal(positionLabel(0, 12, 0, null).includes('还有更多'), false);
  });

  it('F6 清单变短时夹回合法区间', () => {
    assert.equal(clampIndex(7, 3), 2);
    assert.equal(clampIndex(-1, 3), 0);
    assert.equal(clampIndex(1, 3), 1);
    assert.equal(clampIndex(0, 0), 0);
  });
});

// ---------------------------------------------------------------------------
// G 组：LWB-036 步骤 2 与验收标准 2 —— 刷新节奏与在途合并
// ---------------------------------------------------------------------------

describe('G 组 · 刷新策略（LWB-036 步骤 2）', () => {
  const base = {
    visible: true,
    consecutive_failures: 0,
    last_poll_at: null,
    now: 1_000_000,
  } as const;

  it('G1 终态直接停，且不再排下一次', () => {
    for (const state of ['APPLIED', 'REJECTED', 'EXPIRED', 'INVALIDATED', 'CONFLICT', 'ROLLED_BACK'] as const) {
      const decision = refreshDecisionOf({ ...base, state });
      assert.equal(decision.stop, true, `${state} 之后不该继续刷新`);
      assert.equal(decision.poll, false);
      assert.equal(decision.next_delay_ms, null);
      assert.equal(decision.reason, 'TERMINAL');
      assert.equal(decision.message.includes(state), true, '要说清是哪个状态让它停的');
    }
  });

  it('G2 会话丢失同样是停，但与终态是两句不同的话', () => {
    const lost = refreshDecisionOf({ ...base, state: 'APPLIED', session_expired: true });
    assert.equal(lost.stop, true);
    assert.equal(lost.reason, 'TERMINAL', '终态压过会话问题：它已经没有什么可等的了');

    const onlyLost = refreshDecisionOf({ ...base, state: 'QUEUED', session_expired: true });
    assert.equal(onlyLost.stop, true);
    assert.equal(onlyLost.reason, 'SESSION_LOST');
    assert.match(onlyLost.message, /重新运行本地启动命令/);
  });

  it('G3 页面不在前台时暂停刷新，并说明靠什么恢复', () => {
    const hidden = refreshDecisionOf({ ...base, state: 'QUEUED', visible: false });
    assert.equal(hidden.poll, false);
    assert.equal(hidden.stop, false, '切回来还要继续，因此不是「停」');
    assert.equal(hidden.next_delay_ms, null, '不排定时器：等 visibilitychange');
    assert.equal(hidden.reason, 'HIDDEN');
    assert.match(hidden.message, /切回本页/);
  });

  it('G4 写盘进行中问得快，其余非终态问得慢', () => {
    const executing = refreshDecisionOf({ ...base, state: 'APPLYING' });
    const waiting = refreshDecisionOf({ ...base, state: 'PENDING_APPROVAL' });
    assert.equal(executing.poll, true);
    assert.equal(waiting.poll, true);
    assert.equal(executing.next_delay_ms, EXECUTING_INTERVAL_MS);
    assert.equal(waiting.next_delay_ms, WATCHING_INTERVAL_MS);
    assert.ok(
      (executing.next_delay_ms ?? 0) < (waiting.next_delay_ms ?? 0),
      '有人盯着结果时不该比没人看时问得慢',
    );
  });

  it('G5 还没到点时不问，并给出还要等多久', () => {
    const decision = refreshDecisionOf({
      ...base,
      state: 'PENDING_APPROVAL',
      last_poll_at: base.now - 1000,
    });
    assert.equal(decision.poll, false);
    assert.equal(decision.reason, 'WAITING');
    assert.equal(decision.next_delay_ms, WATCHING_INTERVAL_MS - 1000);
  });

  it('G6 失败时指数退避、封顶，且**不放弃**', () => {
    const delays = [1, 2, 3, 5, 9].map(
      (failures) => refreshDecisionOf({ ...base, state: 'QUEUED', consecutive_failures: failures }).next_delay_ms,
    );
    assert.deepEqual(delays, [1000, 2000, 4000, 16000, BACKOFF_MAX_MS]);
    assert.equal(
      refreshDecisionOf({ ...base, state: 'QUEUED', consecutive_failures: 50 }).stop,
      false,
      '连续失败也不停止：本机服务可能只是刚重启',
    );
  });

  it('G7 「实时」只走本地认证接口：策略里没有第二条通道', async () => {
    // 这条断言防的是「将来有人顺手加一条推送」。本地推送通道的鉴权
    // 正是最容易被省掉的一处，而这个仓库点名的反模式里就有一条
    // 「它走的是隧道，不用再验一次」。
    assert.equal(REFRESH_ENDPOINT, 'POST /api/changes/get');

    const source = await readFile(
      new URL('../../apps/console/src/changes/refresh.ts', import.meta.url),
      'utf8',
    );
    // 扫的是**构造与访问的写法**，不是名字本身。
    //
    // 这个区别是被这次运行逼出来的：第一版扫的是裸名字 `WebSocket`，
    // 而它命中的是 `refresh.ts` 文件头里那句「没有 `WebSocket`、没有
    // `EventSource`」—— **写明这条规则的那句话本身**把检查绊倒了。
    // 一份会在自己的说明文字上失败的检查，最后一定会被改成
    // 「把那句话删掉」，而那正好扔掉了最该留下的东西。
    for (const forbidden of [
      'new WebSocket',
      'new EventSource',
      'new BroadcastChannel',
      'new SharedWorker',
      'indexedDB',
      'localStorage',
      'sessionStorage',
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `刷新策略里不该用到 ${forbidden}：它只能通过本地认证接口读状态`,
      );
    }
  });

  it('G8 同一个键的在途请求只发一次（验收标准 2 的界面那一半）', async () => {
    const flight = new SingleFlight();
    let calls = 0;
    let release: (value: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });

    const task = (): Promise<string> => {
      calls += 1;
      return gate;
    };

    // 双击：两次点击拿到的是**同一个** promise，而不是排成两队的两次调用。
    const first = flight.run('console-approve:chg_0001:CCCC-CCCC', task);
    const second = flight.run('console-approve:chg_0001:CCCC-CCCC', task);
    assert.equal(first, second, '同键必须返回同一个 promise');
    assert.equal(calls, 1);

    release('done');
    assert.equal(await first, 'done');
    assert.equal(await second, 'done');

    // 结束后键被释放：此后的点击是**新的一次**动作，不该被合并掉。
    assert.equal(flight.size, 0);
    await flight.run('console-approve:chg_0001:CCCC-CCCC', task);
    assert.equal(calls, 2, '同一次点击结束后，下一次点击必须真的再发一次');
  });

  it('G9 不同的键互不合并（两次不同的动作是两次）', async () => {
    const flight = new SingleFlight();
    const seen: string[] = [];
    const task = (label: string) => async (): Promise<string> => {
      seen.push(label);
      return label;
    };

    await Promise.all([flight.run('a', task('a')), flight.run('b', task('b'))]);
    assert.deepEqual(seen.sort(), ['a', 'b']);
  });

  it('G10 任务同步抛错时不留下一张永远不结束的表项', () => {
    const flight = new SingleFlight();
    assert.throws(() => flight.run('boom', () => {
      throw new Error('同步抛出');
    }));
    assert.equal(flight.size, 0, '否则这个键此后永远被当成「在途」，再也发不出去');
  });
});

// ---------------------------------------------------------------------------
// H 组：`changes.get` 的响应解析（LWB-036）
// ---------------------------------------------------------------------------

/**
 * 这一组的对象是 `detail.ts` 那一层，而它要回答的问题只有一个：
 * **服务端少给了一个字段时，屏幕上会不会多出一件根本没发生的事。**
 *
 * 因此这里的用例大半是「字段缺失 / 形状不对」的，而且每一条都断言
 * 落点的**方向**：落到 `null`（不知道）还是落到拒绝（不给）。两个方向
 * 都不是「更安全」的问题 —— 落到 `null` 会让界面说「还没读到」，
 * 落到 `true` 会让界面说「可以看」。
 */
describe('H 组 · changes.get 响应解析（LWB-036）', () => {
  /** 一份服务端形状的原始响应。每一条用例只改它关心的那一格。 */
  function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      change: view(),
      workspace: {
        workspace_id: 'ws_0001',
        alias: 'demo-repo',
        kind: 'directory',
        mode: 'read_propose_apply_with_local_approval',
        generation: 1,
        policy_version: 1,
        removed_at: null,
        enabled: true,
      },
      owner_connection_id: 'conn_0001',
      content_gate: { allows_read: true, reason: null, message: null },
      diff: null,
      approval: null,
      observed_at: NOW,
      ...over,
    };
  }

  it('H1 状态白名单与契约的联合两向对上（多一个、少一个都失败）', () => {
    // 这一条是 `detail.ts` 里 `CHANGE_STATES` 那段注释承诺的东西。
    // 手抄的表会与契约脱节，而脱节的方式是**静默**的：新加的状态在
    // 界面上变成「读到的内容无法解析」，而没有人会想到去查那张表。
    const contract: readonly string[] = [
      'PENDING_APPROVAL',
      'REJECTED',
      'EXPIRED',
      'INVALIDATED',
      'APPROVED',
      'QUEUED',
      'VALIDATING',
      'CONFLICT',
      'FAILED_NO_CHANGE',
      'APPLYING',
      'APPLIED',
      'ROLLED_BACK',
      'RECOVERY_REQUIRED',
    ];
    assert.deepEqual([...CHANGE_STATE_WHITELIST].sort(), [...contract].sort());
  });

  it('H2 白名单放行的每一个状态都解析得出来，不放行的解析不出来', () => {
    for (const state of CHANGE_STATE_WHITELIST) {
      const parsed = parseChangeDetail(payload({ change: view({ state: state as ChangeSetView['state'] }) }));
      assert.notEqual(parsed, null, `${state} 在白名单里却解析失败`);
      assert.equal(parsed?.change.state, state);
    }
    // 一个不认识的字符串必须让整份修改集解析失败，而不是把它原样渲染出来。
    const bogus = parseChangeDetail(payload({ change: { ...view(), state: 'DRAFTING' } }));
    assert.equal(bogus, null, '不认识的状态不能被当成一份可以批准的修改集');
  });

  it('H3 内容闸门缺字段时落到**拒绝**，不落到允许', () => {
    const missing = parseChangeDetail(payload({ content_gate: undefined }));
    assert.equal(missing?.content_gate.allows_read, false);
    assert.equal(missing?.content_gate.reason, 'GATE_UNREADABLE');

    const malformed = parseChangeDetail(payload({ content_gate: { allows_read: 'yes' } }));
    assert.equal(malformed?.content_gate.allows_read, false);

    // 反方向也要成立：一份**说了允许**的闸门要原样传过去，
    // 否则「缺字段落到拒绝」这条会因为「反正都是拒绝」而空洞地成立。
    const allowed = parseChangeDetail(payload());
    assert.equal(allowed?.content_gate.allows_read, true);
  });

  it('H4 文件清单里有一条形状不对时整份解析失败（分母不能是假的）', () => {
    const parsed = parseChangeDetail(
      payload({ change: { ...view(), files: [file({ path: 'a.ts' }), { path: 'b.ts' }] } }),
    );
    assert.equal(parsed, null, '文件清单是批准的对象，缺一项会让「已复核 N / M」的分母造假');
  });

  it('H5 工作区那一格没有 canonical_root，本机绝对路径进不了这份响应', () => {
    const parsed = parseChangeDetail(payload());
    assert.notEqual(parsed?.workspace, null);
    assert.equal(Object.hasOwn(parsed?.workspace as object, 'canonical_root'), false);
    // 给一个带根路径的响应也不会被搬进来 —— 解析层是白名单式的。
    const withRoot = parseChangeDetail(
      payload({ workspace: { ...payload()['workspace'] as object, canonical_root: 'D:\secret' } }),
    );
    assert.equal(JSON.stringify(withRoot).includes('D:\\secret'), false);
  });

  it('H6 workspace_modified 为 true 时拒绝显示，而不是渲染出来', () => {
    // 契约里这一格是**字面量 false**（「prepare 永远不修改用户工作区」），
    // 因此收到 true 不是一次普通的字段异常 —— 它说的是整条审批链的前提
    // 已经不成立。正确的动作是拒绝显示。
    const parsed = parseChangeDetail(payload({ change: { ...view(), workspace_modified: true } }));
    assert.equal(parsed, null);
  });

  it('H7 一条形状不对的风险被丢掉，而不是被编成一条 info', () => {
    const risks: readonly unknown[] = [
      { level: 'warning', code: 'BULK_DELETE', message: '删除了大量行。' },
      { level: 'notice', message: '缺 code。' },
      { level: 'info', code: 'FORMAT' },
      { level: 'info', code: 'FORMAT', message: '仅格式变化。' },
    ];
    const parsed = parseChangeDetail(payload({ change: { ...view(), risks } }));
    assert.equal(parsed?.change.risks.length, 2, '好的留下、坏的丢掉');
    assert.deepEqual(
      parsed?.change.risks.map((risk) => risk.code),
      ['BULK_DELETE', 'FORMAT'],
    );
  });

  it('H8 整体不是对象时返回 null，不是抛异常', () => {
    for (const input of [null, undefined, 'x', 42, []]) {
      assert.equal(parseChangeDetail(input), null);
    }
  });

  it('H9 逐文件进度由三个来源读出，且「没说 truncated」按读到末尾算', () => {
    const progress = progressFromTexts({
      'a.ts': { before: 'x\n', after: 'y\n', unified: 'U\n', pages: 2 },
      'b.ts': { before: null, after: null, unified: 'U\n', unified_truncated: true, pages: 1 },
      'c.ts': { before: null, after: null, unified: null },
    });
    const byPath = new Map(progress.map((entry) => [entry.path, entry]));
    assert.deepEqual(byPath.get('a.ts'), { path: 'a.ts', pages: 2, reached_end: true, full_texts: true });
    assert.deepEqual(byPath.get('b.ts'), { path: 'b.ts', pages: 1, reached_end: false, full_texts: false });
    // 「没有差异」是 0 页而不是 1 页 —— 否则「还没取过」会被算成「取过一页」。
    assert.deepEqual(byPath.get('c.ts'), { path: 'c.ts', pages: 0, reached_end: true, full_texts: false });
  });

  it('H10 拼接差异页：不凭空造空行，空页不覆盖已有内容', () => {
    const page = (unified: string): { path: string; unified: string; truncated: boolean; next_cursor: string | null } =>
      ({ path: 'a.ts', unified, truncated: true, next_cursor: 'c1' });

    assert.equal(appendDiffPage(null, page('one\n')), 'one\n');
    assert.equal(appendDiffPage('', page('one\n')), 'one\n');
    assert.equal(appendDiffPage('one', page('two\n')), 'one\ntwo\n');
    // 已经以换行结尾时不再加一个：那会造出一个会被读成「这里删掉了一行」的空行。
    assert.equal(appendDiffPage('one\n', page('two\n')), 'one\ntwo\n');
    // 空页：不追加任何东西（追加会多出一个空行）。
    assert.equal(appendDiffPage('one\n', page('')), 'one\n');
  });
});
