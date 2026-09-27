/**
 * ChangesView 渲染测试（LWB-023 三条验收标准）。
 *
 * ## 为什么这些断言必须在真 DOM 里跑，而不是在视图模型层跑完就算
 *
 * `tests/unit/console-changes.test.ts` 已经判过「摘要不参与事实计算」
 * 「可疑字符能被检出」「没有会话就不该给批准」三件事。那三条都是
 * **判定**层面的。而三条验收标准的原文说的都是**界面**：
 *
 * > 模型摘要写「无害」但实际大量删改时，**界面仍显示**全部事实和风险。
 * > Unicode 方向控制等可疑字符**有可视化提示**。
 * > 非登录本地操作者**不能访问或点击**批准接口。
 *
 * 一个判定正确、却因为模板里 `v-if` 写反而什么都没显示的实现，会让
 * 上面每一条都失败 —— 而在视图模型层它 100% 通过。因此这个文件的存在
 * 不是「多测一遍」，它测的是一件视图模型测不到的事：**东西真的在屏幕上**。
 *
 * ## 三组各有一条「不成立时最容易被忽略」的断言
 *
 *  - A 组：摘要写「无害」时，**文件清单的行数**仍是 12。这是验收标准 1
 *    的判决点 —— 只断言「页面上有事实区」会让一个只显示文件数的实现通过。
 *  - B 组：可疑字符的**原始字符不在 DOM 里**。只断言「有提示横幅」会让
 *    一个「提示了但照样渲染原字符」的实现通过，而那个实现等于没提示。
 *  - C 组：无会话时**按钮不在 DOM 里**，且**说得出理由**。这两条要一起测：
 *    只测「按钮不在」会让一个把入口整个藏起来、什么都不说的实现通过，
 *    而操作者那时只知道「按不了」，不知道该去做什么。
 *  - D 组（LWB-036）：有一个文件没取回差异时**按钮同样不在**，且
 *    **说得出是哪一个文件**。这是 LWB-036 验收标准 1 在界面上的判决点，
 *    而它与 C 组共用同一个问题的另一半：C 组问「你是谁」，
 *    D 组问「你看过了吗」。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { ChangeFilePreview, ChangeRisk, ChangeSetView } from '@lwb/contracts';

import ChangesView from '../views/ChangesView.vue';
import type { ContentGate, FileText } from '../src/changes/index.ts';

const NOW = '2026-09-25T10:05:00.000Z';
const RLO = String.fromCodePoint(0x202e);

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

/**
 * 一份「三处来源都齐」的正文表，即复核结论必然是 `complete` 的那种。
 *
 * ## 为什么 C 组需要它
 *
 * `coverage` 是批准的**必填**输入（见 `src/changes/approval.ts`），
 * 因此「有会话就能批准」这句话在 LWB-036 之后不再单独成立。C 组问的是
 * **会话**那一半，而它必须把复核那一半一并交代掉 —— 否则这些用例会因为
 * 一个与本组无关的理由（`UNSEEN_FILES`）而失败，或者更糟：为了让它通过
 * 而把断言放宽，那等于把 LWB-036 的判决点从测试里删掉。
 *
 * B 组的夹具自己给了 `texts`，因此不受这里影响 —— 那些 `texts` 是
 * 断言的对象本身（里面藏着要被检出的方向控制字符），不能由这里代劳。
 */
function fullyReviewed(change: ChangeSetView): Record<string, FileText> {
  const out: Record<string, FileText> = {};
  for (const entry of change.files) {
    out[entry.path] = {
      before: `// ${entry.path}\nold line\n`,
      after: `// ${entry.path}\nnew line\n`,
      unified: `--- a/${entry.path}\n+++ b/${entry.path}\n@@ -1,2 +1,2 @@\n // ${entry.path}\n-old line\n+new line\n`,
    };
  }
  return out;
}

/**
 * 挂载视图。**未显式给出 `texts` 时按「全都看过了」补齐**。
 *
 * 这条默认值是有方向的：它让每一个没提到复核的用例都落在
 * 「复核通过」这一侧，于是它们各自测的那件事才是它们失败的唯一原因。
 * 而 D 组会显式给出**残缺**的 `texts` —— 「没看全」必须由用例说出来，
 * 不能靠默认值撞上。
 */
function mountView(props: Record<string, unknown>): ReturnType<typeof mount> {
  const change = (props['change'] ?? null) as ChangeSetView | null;
  const given = props['texts'];
  const texts = given !== undefined ? given : change === null ? undefined : fullyReviewed(change);
  return mount(ChangesView, { props: { now: NOW, ...props, ...(texts === undefined ? {} : { texts }) } });
}

// ---------------------------------------------------------------------------
// A 组 · 验收标准 1：摘要写「无害」，界面照样把事实摆全
// ---------------------------------------------------------------------------

describe('A 组 · 摘要写「无害」时界面仍显示全部事实（验收标准 1）', () => {
  /** 12 个文件、净删 456 行，摘要却说「无害」。 */
  function alarming(): ChangeSetView {
    const risks: readonly ChangeRisk[] = [
      { level: 'warning', code: 'MULTIPLE_FILES', message: '本次修改涉及 12 个文件；批准前请逐个核对。' },
      { level: 'warning', code: 'LARGE_DELETION', message: '净删除 456 行，超过单文件阈值。' },
      { level: 'notice', code: 'MANY_DELETIONS', message: '多个文件出现大段删除。' },
    ];
    return view({
      summary: '这是一次无害的小改动，仅涉及格式，可以放心批准。',
      files: Array.from({ length: 12 }, (_, i) =>
        file({ path: `src/mod${String(i).padStart(2, '0')}.ts`, added_lines: 2, removed_lines: 40, before_size: 9000, after_size: 3000 }),
      ),
      risks,
    });
  }

  it('A1 文件清单把 12 个文件一个不少地列出来', () => {
    const wrapper = mountView({ change: alarming(), session: { session_id: 'sess_1' } });
    const rows = wrapper.findAll('[data-testid="file-row"]');
    assert.equal(rows.length, 12, '摘要说「小改动」不改变文件数量');
    assert.equal(rows[0]?.attributes('data-path'), 'src/mod00.ts');
    assert.equal(rows[11]?.attributes('data-path'), 'src/mod11.ts');
  });

  it('A2 事实区的修改量按系统算出来的数字显示，不按摘要的措辞', () => {
    const wrapper = mountView({ change: alarming(), session: { session_id: 'sess_1' } });
    const facts = wrapper.find('[data-testid="facts-region"]').text();

    assert.match(facts, /12 个文件/, '文件数来自落库事实');
    assert.match(facts, /\+24 −480/, '行数增量来自落库事实（减号是 U+2212）');
    assert.match(facts, /净 -456/, '净变化量来自落库事实');
    assert.match(facts, /3 条风险/);
  });

  it('A3 有高风险时通栏警告出现在最前面', () => {
    const wrapper = mountView({ change: alarming(), session: { session_id: 'sess_1' } });
    const banner = wrapper.find('[data-testid="banner"]');
    assert.equal(banner.exists(), true);
    assert.equal(banner.attributes('role'), 'alert');
    assert.match(wrapper.find('[data-testid="banner-risk"]').text(), /2 条高风险/);

    // 位置断言：它在整个视图的最上面。一个要滚到底才看见的警告等于没有。
    const html = wrapper.html();
    assert.ok(html.indexOf('banner') < html.indexOf('facts-region'));
    assert.ok(html.indexOf('banner') < html.indexOf('prose-region'));
  });

  it('A4 风险逐条列出，warning 排在 notice 之前', () => {
    const wrapper = mountView({ change: alarming(), session: { session_id: 'sess_1' } });
    const levels = wrapper.findAll('[data-testid="risk-list"] li').map((li) => li.attributes('data-level'));
    assert.deepEqual(levels, ['warning', 'warning', 'notice']);
    assert.match(wrapper.find('[data-testid="risk-list"]').text(), /净删除 456 行/);
  });

  it('A5 摘要被原样显示，但在另一个分区里，且带固定标签', () => {
    const wrapper = mountView({ change: alarming(), session: { session_id: 'sess_1' } });

    assert.match(wrapper.find('[data-testid="summary"]').text(), /无害的小改动/);
    assert.match(wrapper.find('[data-testid="prose-region"]').text(), /模型撰写（不受信）/);
    assert.match(wrapper.find('[data-testid="prose-notice"]').text(), /不是\*\*系统判定依据/);

    // 分区事实：摘要在 prose 区，不在 facts 区。这是方案 §10.2 那句
    // 「分区展示」在结构上的样子 —— 一个把两者渲染进同一块的实现会在这里失败。
    const facts = wrapper.find('[data-testid="facts-region"]');
    assert.equal(facts.text().includes('无害'), false, '事实区里不得出现模型的措辞');
    assert.equal(facts.find('[data-testid="summary"]').exists(), false);
  });

  it('A6 没有风险时也照实说明「这不等于没有风险」，而不是留白', () => {
    const wrapper = mountView({ change: view(), session: { session_id: 'sess_1' } });
    assert.equal(wrapper.find('[data-testid="risk-list"]').exists(), false);
    assert.match(wrapper.find('[data-testid="no-risk"]').text(), /不等于没有风险/);
    assert.equal(wrapper.find('[data-testid="banner"]').exists(), false);
  });

  it('A7 没有修改集时不渲染事实区，只说明「当前没有」', () => {
    const wrapper = mountView({ change: null });
    assert.equal(wrapper.find('[data-testid="empty-state"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="facts-region"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="file-list"]').exists(), false);
  });
});

// ---------------------------------------------------------------------------
// B 组 · 验收标准 2：可疑字符在界面上看得见
// ---------------------------------------------------------------------------

describe('B 组 · 可疑字符的可视化提示（验收标准 2）', () => {
  function withRlo(): { readonly change: ChangeSetView; readonly texts: Record<string, { before: string; after: string }> } {
    return {
      change: view({ files: [file({ path: 'src/auth.ts' }), file({ path: 'src/util.ts' })] }),
      texts: {
        'src/auth.ts': { before: 'const isAdmin = false;\n', after: `const isAdmin = ${RLO}false;\n` },
        'src/util.ts': { before: 'export const x = 1;\n', after: 'export const x = 2;\n' },
      },
    };
  }

  it('B1 通栏提示报出总数', () => {
    const { change, texts } = withRlo();
    const wrapper = mountView({ change, texts, session: { session_id: 'sess_1' } });

    const banner = wrapper.find('[data-testid="banner-suspicious"]');
    assert.equal(banner.exists(), true);
    assert.match(banner.text(), /正文里有 1 个/);
    assert.match(banner.text(), /显示内容与写入内容不一致/);
  });

  it('B2 文件清单上就能看出是**哪个**文件有问题', () => {
    const { change, texts } = withRlo();
    const wrapper = mountView({ change, texts, session: { session_id: 'sess_1' } });

    // 只有 auth.ts 有。逐文件标记的意义在于：操作者不必逐个点开才知道
    // 该看哪里 —— 而一个含 RLO 的文件正是最容易被跳过的那一个。
    const marked = wrapper.findAll('[data-testid="file-suspicious"]');
    assert.equal(marked.length, 1);
    assert.match(marked[0]!.text(), /1 个可疑字符/);

    const authRow = wrapper.findAll('[data-testid="file-row"]').find((r) => r.attributes('data-path') === 'src/auth.ts');
    assert.equal(authRow?.find('[data-testid="file-suspicious"]').exists(), true);
    const utilRow = wrapper.findAll('[data-testid="file-row"]').find((r) => r.attributes('data-path') === 'src/util.ts');
    assert.equal(utilRow?.find('[data-testid="file-suspicious"]').exists(), false);
  });

  it('B3 差异正文里那个字符被换成可见占位，原始字符不在 DOM 里', async () => {
    const { change, texts } = withRlo();
    const wrapper = mountView({ change, texts, session: { session_id: 'sess_1' } });

    // 默认选中第一个文件（auth.ts）。它在「完整差异」模式下没有统一差异，
    // 因此这里切到「原文 / 新文」才看得到含 RLO 的那一侧。
    const afterButton = wrapper.findAll('[data-testid="mode-after"]')[0];
    assert.ok(afterButton !== undefined, 'DiffView 应当已经渲染出来');
    await afterButton.trigger('click');

    const marks = wrapper.findAll('[data-testid="suspicious-char"]');
    assert.equal(marks.length, 1);
    assert.equal(marks[0]?.attributes('data-codepoint'), '202E');
    // **本组的判决点**：原始字符不得留在 DOM 里。
    assert.equal(wrapper.html().includes(RLO), false);
  });

  it('B4 没有任何可疑字符时不给这条提示（否则提示会被学会忽略）', () => {
    const wrapper = mountView({
      change: view(),
      texts: { 'src/app.ts': { before: 'a\n', after: 'b\n' } },
      session: { session_id: 'sess_1' },
    });
    assert.equal(wrapper.find('[data-testid="banner-suspicious"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="file-suspicious"]').exists(), false);
  });

  it('B5 可疑字符独立触发通栏警告 —— 没有系统风险时也提示', () => {
    const { change, texts } = withRlo();
    // 这一条钉的是横幅的判据：`has_warning || totalSuspicious > 0`。
    // 若只按风险判，一个「系统看不出问题、但正文被 RLO 翻转」的修改集
    // 会安安静静地出现，而那正是最需要提示的一种。
    assert.equal(change.risks.length, 0);
    const wrapper = mountView({ change, texts, session: { session_id: 'sess_1' } });
    assert.equal(wrapper.find('[data-testid="banner"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="banner-risk"]').exists(), false);
  });
});

// ---------------------------------------------------------------------------
// C 组 · 验收标准 3：非登录操作者不能点击批准
// ---------------------------------------------------------------------------

describe('C 组 · 非登录操作者不能点击批准接口（验收标准 3）', () => {
  it('C1 没有会话时批准按钮根本不在 DOM 里', () => {
    const wrapper = mountView({ change: view() });
    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="reject-button"]').exists(), false);
  });

  it('C2 没有会话时界面说得出原因，并给出重新登录的入口', () => {
    const wrapper = mountView({ change: view() });

    // 只把入口藏起来是不够的：操作者会以为界面坏了或自己看漏了。
    const blocked = wrapper.find('[data-testid="blocked-reason"]');
    assert.equal(blocked.exists(), true);
    assert.match(blocked.text(), /NO_SESSION/);
    assert.match(wrapper.find('[data-testid="gate-message"]').text(), /尚未建立控制台会话/);
    assert.equal(wrapper.find('[data-testid="relogin-hint"]').exists(), true);
  });

  it('C3 会话过期与尚未登录说的话不同', () => {
    const wrapper = mountView({ change: view(), sessionExpired: true });
    assert.match(wrapper.find('[data-testid="gate-message"]').text(), /已过期/);
    assert.match(wrapper.find('[data-testid="blocked-reason"]').text(), /SESSION_EXPIRED/);
  });

  it('C4 有会话时按钮出现，并说明「不会立即写入」', () => {
    const wrapper = mountView({ change: view(), session: { session_id: 'sess_1' } });

    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="reject-button"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="blocked-reason"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="relogin-hint"]').exists(), false);
    assert.match(wrapper.find('[data-testid="not-written-hint"]').text(), /不会立即写入文件/);
  });

  it('C5 点击批准发出的正是服务端要的那三个字段', async () => {
    const wrapper = mountView({ change: view(), session: { session_id: 'sess_1' } });
    await wrapper.find('[data-testid="approve-button"]').trigger('click');

    const emitted = wrapper.emitted('approve');
    assert.equal(emitted?.length, 1, '点一次只能发出一次');
    const payload = emitted![0]![0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ['change_id', 'digest', 'idempotency_key']);
    assert.equal(payload['change_id'], 'chg_0001');
    assert.equal(payload['digest'], 'c'.repeat(64));
    assert.match(String(payload['idempotency_key']), /^console-approve:chg_0001:CCCC-CCCC$/);
  });

  it('C6 点击拒绝发出的只有两个字段 —— 拒绝没有幂等键', async () => {
    const wrapper = mountView({ change: view(), session: { session_id: 'sess_1' } });
    await wrapper.find('[data-testid="reject-button"]').trigger('click');

    const emitted = wrapper.emitted('reject');
    assert.equal(emitted?.length, 1);
    const payload = emitted![0]![0] as Record<string, unknown>;
    // 这条是防「照着批准抄一份」的：`approvals.reject` 不读 `idempotency_key`，
    // 多带一个字段不会报错，只会让人以为拒绝对幂等做了处理。
    assert.deepEqual(Object.keys(payload).sort(), ['change_id', 'digest']);
  });

  it('C7 会话为 null 时点击不存在的按钮不会发出任何事件', async () => {
    const wrapper = mountView({ change: view() });
    // 按钮不存在，于是根本点不到。这里再断言一次「一个事件都没发出去」，
    // 是为了让「藏按钮」这件事的**结果**被明确写下来。
    assert.deepEqual(wrapper.emitted('approve'), undefined);
    assert.deepEqual(wrapper.emitted('reject'), undefined);
  });

  it('C8 修改集已到终态时按钮消失，且不提示重新登录', () => {
    const wrapper = mountView({ change: view({ state: 'APPLIED' }), session: { session_id: 'sess_1' } });
    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), false);
    assert.match(wrapper.find('[data-testid="blocked-reason"]').text(), /WRONG_STATE/);
    // 状态问题不是会话问题。提示重新登录会把人引到错误的方向。
    assert.equal(wrapper.find('[data-testid="relogin-hint"]').exists(), false);
    assert.match(wrapper.find('[data-testid="state"]').text(), /APPLIED/);
  });

  it('C9 已过期的修改集不给批准，并说清「过期内容不会被写入」', () => {
    const wrapper = mountView({
      change: view({ expires_at: '2026-09-25T10:04:00.000Z' }),
      session: { session_id: 'sess_1' },
    });
    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), false);
    assert.match(wrapper.find('[data-testid="gate-message"]').text(), /不会被写入/);
    assert.equal(wrapper.find('[data-testid="expiry"]').attributes('data-expired'), 'true');
  });

  it('C10 有请求在途时按钮带 disabled，且点击不发出事件', async () => {
    const wrapper = mountView({ change: view(), session: { session_id: 'sess_1' }, busy: true });
    const button = wrapper.find('[data-testid="approve-button"]');

    assert.notEqual(button.attributes('disabled'), undefined, '界面上应当看得出忙');

    // 断言 **`busy` 守卫写在函数里**，而不只是写在 `disabled` 属性上：
    // 不同浏览器/测试环境对「禁用元素是否派发 click」的处理并不一致，
    // 若只靠属性，双击的第二次在某个环境下仍会走到 emit。
    await button.trigger('click');
    assert.deepEqual(wrapper.emitted('approve'), undefined, '忙的时候点击不得发出事件');
  });

  it('C11 提议连接未知时显示「未知」而不是省略这一行', () => {
    const wrapper = mountView({ change: view(), session: { session_id: 'sess_1' } });
    // 一个空着的位置会让人以为界面漏了；「未知」是一个事实。
    assert.equal(wrapper.find('[data-testid="owner"]').text(), '未知');

    const named = mountView({ change: view(), session: { session_id: 'sess_1' }, ownerLabel: '我的笔记本' });
    assert.match(named.find('[data-testid="owner"]').text(), /我的笔记本/);
  });

  it('C12 短核对编号与完整摘要都给出来', () => {
    const wrapper = mountView({ change: view(), session: { session_id: 'sess_1' } });
    // 短编号是给人念的，完整摘要是「哪一份内容」的精确定义 —— 两者都要。
    assert.equal(wrapper.find('[data-testid="short-code"]').text(), 'CCCC-CCCC');
    assert.equal(wrapper.find('[data-testid="digest"]').text(), 'c'.repeat(64));
  });
});

// ---------------------------------------------------------------------------
// D 组 · 复核覆盖：没取回差异的文件会挡住批准（LWB-036 验收标准 1）
// ---------------------------------------------------------------------------

describe('D 组 · 复核覆盖挡住批准（LWB-036 验收标准 1）', () => {
  /** 两个文件。其中一个**不会**被取回差异 —— 这就是那个「隐含文件」。 */
  const TWO = view({
    files: [file({ path: 'src/app.ts' }), file({ path: 'tools/pre-commit' })],
  });

  /** 只取回 `src/app.ts` 的差异，另一份从未打开。 */
  function halfReviewed(): Record<string, FileText> {
    return { 'src/app.ts': { before: 'a\n', after: 'b\n', unified: '--- a/src/app.ts\n+++ b/src/app.ts\n' } };
  }

  it('D1 有文件没取回差异时，批准按钮不在 DOM 里', () => {
    const wrapper = mountView({ change: TWO, texts: halfReviewed(), session: { session_id: 'sess_1' } });

    // **本组的判决点**。批准绑定的是整份修改集的摘要，因此「有一个文件
    // 从没出现在屏幕上」与「批准了没看过的东西」是同一件事。
    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), false);
    // 拒绝仍然给得出来：不批准不需要先看全，而把两条路一起堵死会
    // 让操作者既不能批准也不能拒绝，只能去改数据库。
    assert.equal(wrapper.find('[data-testid="reject-button"]').exists(), true);
  });

  it('D2 说得出是**哪一个**文件没看过', () => {
    const wrapper = mountView({ change: TWO, texts: halfReviewed(), session: { session_id: 'sess_1' } });

    assert.match(wrapper.find('[data-testid="blocked-reason"]').text(), /UNSEEN_FILES/);
    assert.match(wrapper.find('[data-testid="gate-message"]').text(), /tools\/pre-commit/);

    // 文件清单上也要看得出是哪一行 —— 只说「还差一个」的话，
    // 操作者得自己逐个点开去比对是哪一行。
    const rows = wrapper.findAll('[data-testid="file-row"]');
    const missing = rows.find((row) => row.attributes('data-path') === 'tools/pre-commit');
    const marker = missing?.find('[data-testid="file-unseen"]');
    assert.equal(marker?.exists(), true);
    assert.equal(marker?.attributes('data-reason'), 'NOT_DISPLAYED');

    const seen = rows.find((row) => row.attributes('data-path') === 'src/app.ts');
    assert.equal(seen?.find('[data-testid="file-unseen"]').exists(), false);
    assert.equal(seen?.find('[data-testid="file-covered"]').exists(), true);
  });

  it('D3 复核进度行给出分母，并列出未取回的路径', () => {
    const wrapper = mountView({ change: TWO, texts: halfReviewed(), session: { session_id: 'sess_1' } });

    const line = wrapper.find('[data-testid="review-coverage"]');
    assert.equal(line.attributes('data-status'), 'incomplete');
    assert.match(line.text(), /已复核 1 \/ 2 个文件/);
    assert.match(wrapper.find('[data-testid="unseen-paths"]').text(), /tools\/pre-commit/);
  });

  it('D4 「没读到末尾」与「从未取回」是两句不同的话', () => {
    // 有差异、但服务端说这一页不是末尾（分页截断）。看了一半不等于看过。
    const wrapper = mountView({
      change: TWO,
      texts: {
        'src/app.ts': { before: null, after: null, unified: '--- a\n+++ b\n', unified_truncated: true },
        'tools/pre-commit': { before: 'x\n', after: 'y\n', unified: null },
      },
      session: { session_id: 'sess_1' },
    });

    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), false);
    // 判据是两个：app.ts 截断 → TRUNCATED_DIFF；pre-commit 的原文/新文都在
    // → 算看过。因此这里恰恰**不能**出现 UNSEEN_FILES。
    assert.match(wrapper.find('[data-testid="blocked-reason"]').text(), /TRUNCATED_DIFF/);
    assert.match(wrapper.find('[data-testid="truncated-paths"]').text(), /src\/app\.ts/);
    // 措辞必须区分开：把「没读到末尾」说成「从未取回」会把人送去
    // 打开一个已经打开着的文件。
    assert.match(wrapper.find('[data-testid="gate-message"]').text(), /没读到末尾/);

    const rows = wrapper.findAll('[data-testid="file-row"]');
    assert.equal(
      rows.find((r) => r.attributes('data-path') === 'src/app.ts')?.find('[data-testid="file-unseen"]').attributes('data-reason'),
      'TRUNCATED',
    );
  });

  it('D5 服务端拒交内容时不显示「还差几个文件」，而是说清「现在看不了」', () => {
    const gate: ContentGate = {
      allows_read: false,
      reason: 'WORKSPACE_PAUSED',
      message: '工作区处于暂停状态，内容读取已停止。',
    };
    const wrapper = mountView({
      change: TWO,
      // 连 `texts` 都给成「全都看过」：闸门拒绝时必须把这份**过去的**
      // 进度一并作废，否则界面会显示「看全了，可以批准」——
      // 而此刻操作者连内容都打不开。
      texts: fullyReviewed(TWO),
      contentGate: gate,
      session: { session_id: 'sess_1' },
    });

    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), false);
    assert.match(wrapper.find('[data-testid="blocked-reason"]').text(), /CONTENT_UNAVAILABLE/);
    assert.match(wrapper.find('[data-testid="gate-message"]').text(), /WORKSPACE_PAUSED/);
    assert.match(wrapper.find('[data-testid="gate-message"]').text(), /看不到内容的修改集不能批准/);
    assert.equal(wrapper.find('[data-testid="review-coverage"]').attributes('data-status'), 'unavailable');
    // 一句「还有 2 个文件从未取回」在这里是**假话**：不是没取，是取不到。
    assert.equal(wrapper.find('[data-testid="unseen-paths"]').exists(), false);
  });

  it('D6 三处来源都齐时按钮出现，并说明看全了几个文件', () => {
    const wrapper = mountView({ change: TWO, session: { session_id: 'sess_1' } });

    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="blocked-reason"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="review-coverage"]').attributes('data-status'), 'complete');
    assert.match(wrapper.find('[data-testid="gate-message"]').text(), /已完整看过全部 2 个文件/);
    assert.equal(wrapper.findAll('[data-testid="file-covered"]').length, 2);
    assert.equal(wrapper.findAll('[data-testid="file-unseen"]').length, 0);
  });

  it('D7 没有文件时不算「看全了」，批准入口不出现', () => {
    // 平凡成立 ≠ 成立：「为每个文件都取了差异」在空清单上恒真。
    const wrapper = mountView({
      change: view({ files: [] }),
      session: { session_id: 'sess_1' },
    });
    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="review-coverage"]').attributes('data-status'), 'incomplete');
  });

  it('D8 复核不足排在过期与状态之后 —— 先处理已经无解的事', () => {
    // 顺序是有理由的：让操作者去翻完一个**已经过期**的修改集的文件，
    // 翻完也批准不了。而反过来（先说过期）他一次都不用翻。
    const expired = mountView({
      change: view({ expires_at: '2026-09-25T10:04:00.000Z' }),
      texts: {},
      session: { session_id: 'sess_1' },
    });
    assert.match(expired.find('[data-testid="blocked-reason"]').text(), /EXPIRED/);

    const applied = mountView({ change: view({ state: 'APPLIED' }), texts: {}, session: { session_id: 'sess_1' } });
    assert.match(applied.find('[data-testid="blocked-reason"]').text(), /WRONG_STATE/);
  });
});
