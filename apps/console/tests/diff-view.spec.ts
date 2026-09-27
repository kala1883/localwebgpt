/**
 * DiffView 渲染测试（LWB-023 步骤 2 / 验收标准 2）。
 *
 * ## 这个文件测的是「屏幕上出现的东西」，而不是「函数返回了什么」
 *
 * 半条验收标准已经在 `tests/unit/console-changes.test.ts` 里判过了
 * （可疑字符能不能被检出）。这里判的是**另一半，而且是这一条标准的实质**：
 * 检出之后，渲染出来的是不是一个**可见的、与字节一一对应的**东西。
 *
 * 只报「本文件含可疑字符」是不够的 —— 不可见字符按原样渲染出来就是看不到的，
 * 于是「提示了」与「没提示」在屏幕上没有区别，操作者仍然不知道它藏在哪一行。
 * 因此本文件的中心断言是一条**否定**：渲染结果里**没有**那个原始字符；
 * 与之配对的一条**肯定**：多了一个写着码位的 `<mark>`。
 *
 * ## 两处容易写成同义反复的地方
 *
 *  - 「有 `<mark>`」单独成立时可能是误报。所以配了一条反向断言（A4）：
 *    一段合法的希伯来文/阿拉伯文**不得**触发任何提示。检出器的失败方向
 *    若不是「漏报」而是「草木皆兵」，操作者会学会忽略这个提示，
 *    那比没有提示更坏。
 *  - 「不执行仓库内容」若只断言源码里没有 `v-html`，那是在读源码而不是
 *    在测行为。B 组改成让正文**就是**一段 `<script>` 与 `<img onerror>`，
 *    再断言它们没有变成元素 —— 这条断言在有人日后加了 `v-html` 时会失败。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mount } from '@vue/test-utils';

import DiffView from '../components/DiffView.vue';

// 用 `String.fromCodePoint` 而不是写码位的字面量，有两个理由：
//  1. 在这个文件里逐字写下 U+202E 这类字符，本身就是它要防的事。
//     证据脚本的语料扫描（scripts/evidence/lwb-023.ts 第 2.6 节）
//     会把它报出来 —— 本条注释的第一版就是那样被报出来的。
//  2. `\uXXXX` 只吃 4 位十六进制：想写 U+E0041 而写成四位转义，
//     会塌成 U+E004 加一个 `1`，看起来毫无异常（见 `suspicious.ts`
//     里「必须按码位遍历」那段）。写成码位则两种坑都没有。
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const TAG_A = String.fromCodePoint(0xe0041);

/**
 * 挂载。
 *
 * 两侧正文默认 `null` 而不是缺省：`beforeText` / `afterText` 是必填 prop，
 * 而「没接线」与「还没有内容」在这个组件里是同一个状态（都走 `absent`
 * 分支）。默认成 `undefined` 会让 vue-tsc 与运行时都报缺 prop，
 * 于是每个只测统一差异的用例都要多写两行与本用例无关的东西。
 */
function mountDiff(props: Record<string, unknown>): ReturnType<typeof mount> {
  return mount(DiffView, {
    props: { path: 'src/app.ts', op: 'edit_text', beforeText: null, afterText: null, ...props },
  });
}

describe('A 组 · 可疑字符在屏幕上必须看得见（验收标准 2）', () => {
  it('A1 方向覆盖字符被换成一个写着码位的可见块', () => {
    const before = 'const x = 1;\n';
    // RLO 之后整段文本的显示顺序会被翻转（Trojan Source，CVE-2021-42574）。
    const after = `const isAdmin = ${RLO}false;\n`;

    const wrapper = mountDiff({ beforeText: before, afterText: after, initialMode: 'after' });

    const marks = wrapper.findAll('[data-testid="suspicious-char"]');
    assert.equal(marks.length, 1, '恰好一个可疑字符，就应当恰好一个标记');
    assert.equal(marks[0]?.attributes('data-codepoint'), '202E');
    assert.equal(marks[0]?.text(), '⟦U+202E⟧', '块里写的是码位，不是那个字符本身');
  });

  it('A2 渲染结果里不再有那个原始字符 —— 这是本组存在的理由', () => {
    const after = `const isAdmin = ${RLO}false;\n`;
    const wrapper = mountDiff({ beforeText: 'x\n', afterText: after, initialMode: 'after' });

    // 若这两条失败，说明「提示」是假的：字符仍然在 DOM 里，
    // 浏览器仍然会按它翻转显示顺序，而屏幕上看起来「和提示之前一样」。
    assert.equal(wrapper.text().includes(RLO), false, '文本内容里不得残留原始字符');
    assert.equal(wrapper.html().includes(RLO), false, '整个 HTML（含属性）里也不得残留');
  });

  it('A3 通栏提示报出数量，且出现在正文之前', () => {
    const after = `a${ZWSP}b${RLO}c\n`;
    const wrapper = mountDiff({ beforeText: '', afterText: after, initialMode: 'after' });

    const alert = wrapper.find('[data-testid="suspicious-alert"]');
    assert.equal(alert.exists(), true);
    assert.match(alert.text(), /含有 2 个/);

    // 顺序断言：提示必须在正文容器**之前**。一个要滚到底才看见的警告，
    // 对一个「请核对后批准」的页面来说等于没有。
    const html = wrapper.html();
    assert.ok(
      html.indexOf('suspicious-alert') < html.indexOf('diff-body'),
      '提示应当排在正文之前',
    );
  });

  it('A4 合法的从右到左文字不触发任何提示（反向断言，防草木皆兵）', () => {
    // 这是**正常内容**，不是攻击：一段希伯来文、一段阿拉伯文，
    // 以及一个普通的 emoji。检出器若不认识它们，就会天天误报。
    const after = 'const greeting = "שלום עולם";\nconst salaam = "مرحبا بالعالم";\nconst ok = "✅";\n';
    const wrapper = mountDiff({ beforeText: '', afterText: after, initialMode: 'after' });

    assert.equal(wrapper.find('[data-testid="suspicious-alert"]').exists(), false);
    assert.equal(wrapper.findAll('[data-testid="suspicious-char"]').length, 0);
    assert.equal(wrapper.text().includes('שלום'), true, '正文本身必须原样显示出来');
  });

  it('A5 提示文案说明「显示顺序可能与字节顺序不一致」，而不只是报个数', () => {
    const wrapper = mountDiff({ beforeText: '', afterText: `x${RLO}\n`, initialMode: 'after' });
    const text = wrapper.find('[data-testid="suspicious-alert"]').text();
    assert.match(text, /显示的顺序/);
    assert.match(text, /字节顺序/);
  });

  it('A6 代理对组成的标签字符也照样换成占位（按码位而不是按码元）', () => {
    // U+E0041 在 UTF-16 里是两个码元。按码元遍历的实现会把它读成两个
    // 无意义的高位/低位代理，于是整类标签字符在**界面上**永远不提示 ——
    // 而它恰恰是最适合夹带数据的一类（`suspicious.ts` 的注释里写了这件事）。
    const after = `const a = 1;${TAG_A}\n`;
    const wrapper = mountDiff({ beforeText: '', afterText: after, initialMode: 'after' });

    const marks = wrapper.findAll('[data-testid="suspicious-char"]');
    assert.equal(marks.length, 1);
    assert.equal(marks[0]?.attributes('data-codepoint'), 'E0041');
    assert.equal(marks[0]?.text(), '⟦U+E0041⟧');
    assert.equal(wrapper.html().includes(TAG_A), false);
  });
});

describe('B 组 · 正文按文本渲染，不执行仓库内容', () => {
  it('B1 HTML 标签作为文字显示，不成为元素', () => {
    const after = '<script>alert(1)</script>\n<div onclick="x()">hi</div>\n';
    const wrapper = mountDiff({ beforeText: '', afterText: after, initialMode: 'after' });

    assert.equal(wrapper.find('script').exists(), false, '不得产生 script 元素');
    assert.equal(wrapper.find('div[onclick]').exists(), false, '不得产生带事件属性的元素');
    // 反过来：它们应当**原样**作为文字出现（转义之后）。
    assert.equal(wrapper.text().includes('<script>alert(1)</script>'), true);
  });

  it('B2 正文里的图片标记不产生任何请求（方案 §10.2 禁止外部图片）', () => {
    const after = '<img src="https://example.invalid/pixel.png" onerror="fetch(\'//x\')">\n';
    const wrapper = mountDiff({ beforeText: '', afterText: after, initialMode: 'after' });

    // 一张来自仓库内容的远程图片是一次**出站请求**，它会把
    // 「本机正在看这份差异」告诉那个地址 —— 而这是一个本地工具。
    assert.equal(wrapper.findAll('img').length, 0);
    assert.equal(wrapper.html().includes('example.invalid'), true, '但文字本身仍要显示出来');
  });

  it('B3 Markdown 不被解释（步骤 3：不执行仓库 Markdown）', () => {
    const after = '# 标题\n**粗体**\n[链接](https://example.invalid)\n';
    const wrapper = mountDiff({ beforeText: '', afterText: after, initialMode: 'after' });

    assert.equal(wrapper.findAll('h1').length, 0);
    assert.equal(wrapper.findAll('strong').length, 0);
    assert.equal(wrapper.findAll('a').length, 0, '不得产生可点的链接');
    assert.equal(wrapper.text().includes('# 标题'), true);
  });
});

describe('C 组 · 三种显示模式与它们的「没有内容」说明', () => {
  it('C1 没有统一差异时说明「尚未提供」，而不是退回显示新文全文', () => {
    const wrapper = mountDiff({ beforeText: '旧\n', afterText: '新\n' });

    // 退回显示新文全文看起来也是一段代码，操作者会以为自己在看差异。
    assert.equal(wrapper.find('[data-testid="diff-absent"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="diff-body"]').exists(), false);
    assert.match(wrapper.find('[data-testid="diff-absent"]').text(), /尚未提供统一差异/);
  });

  it('C2 给了统一差异就显示它', () => {
    const wrapper = mountDiff({ beforeText: '旧\n', afterText: '新\n', unified: '@@ -1 +1 @@\n-旧\n+新\n' });
    assert.equal(wrapper.find('[data-testid="diff-body"]').exists(), true);
    assert.match(wrapper.text(), /@@ -1 \+1 @@/);
  });

  it('C3 切到「原文 / 新文」显示对应正文', async () => {
    const wrapper = mountDiff({ beforeText: '旧内容\n', afterText: '新内容\n' });

    await wrapper.find('[data-testid="mode-after"]').trigger('click');
    assert.match(wrapper.text(), /新内容/);
    assert.equal(wrapper.text().includes('旧内容'), false);

    await wrapper.find('[data-testid="mode-before"]').trigger('click');
    assert.match(wrapper.text(), /旧内容/);
    assert.equal(wrapper.text().includes('新内容'), false);
  });

  it('C4 新建文件没有原文，说明是「新建」而不是「尚未载入」', () => {
    const wrapper = mountDiff({ op: 'create_text', beforeText: null, afterText: '新文件\n', initialMode: 'before' });

    // 两句话指向的下一步不同：一个是「这是设计如此」，一个是「等一下再试」。
    assert.match(wrapper.find('[data-testid="diff-absent"]').text(), /这是新建文件/);
  });

  it('C5 编辑文件缺原文时说的是「尚未载入」', () => {
    const wrapper = mountDiff({ op: 'edit_text', beforeText: null, afterText: 'x\n', initialMode: 'before' });
    assert.match(wrapper.find('[data-testid="diff-absent"]').text(), /原文尚未载入/);
  });

  it('C6 行号从 1 起、逐行对应，末尾换行不产生一个空行', () => {
    const wrapper = mountDiff({ beforeText: '', afterText: 'a\nb\nc\n', initialMode: 'after' });

    const linenos = wrapper.findAll('[data-testid="diff-lineno"]').map((el) => el.text());
    assert.deepEqual(linenos, ['1', '2', '3'], '三行内容就是三行，不是四行');
  });

  it('C7 空正文不产生任何行（而不是产生一行空的）', () => {
    const wrapper = mountDiff({ beforeText: '', afterText: '', initialMode: 'after' });
    assert.equal(wrapper.findAll('[data-testid="diff-line"]').length, 0);
  });

  it('C8 CR 留在行里 —— 屏幕上要显示的是磁盘上那份字节', () => {
    const wrapper = mountDiff({ beforeText: '', afterText: 'a\r\nb\r\n', initialMode: 'after' });
    const lines = wrapper.findAll('[data-testid="diff-line"]');
    assert.equal(lines.length, 2, 'CRLF 是两个行尾，不是三行');

    // 这里读 `element.textContent` 而不是 `line.text()`：后者会 `trim()`，
    // 而行尾的 CR 恰好是空白字符，于是**是 `trim()` 把 CR 吃掉的，不是渲染**。
    // 一条因为测试辅助函数的行为而失败的断言，会把修复引到错误的地方去
    // —— 所以它值得在这里写明。
    assert.equal(lines[0]?.element.textContent?.includes('\r'), true, 'CR 不得被悄悄吃掉');
    assert.equal(lines[1]?.element.textContent?.includes('\r'), true);
  });

  it('C9 分页不是静默截断：说得出「这不是全部内容」，并给出继续的入口', () => {
    const wrapper = mountDiff({
      unified: '@@ -1,2 +1,2 @@\n-a\n+b\n',
      unifiedTruncated: true,
      pageIndex: 1,
    });

    // 分页本身是这个页面的正常功能；危险的是**不说**。一个把第 1 页
    // 当成全部显示的实现在这里失败。
    assert.equal(wrapper.find('[data-testid="diff-complete"]').exists(), false);
    assert.match(wrapper.find('[data-testid="diff-page"]').text(), /不是全部内容/);
    assert.match(wrapper.find('[data-testid="diff-page"]').text(), /第 1 页/);
    assert.equal(wrapper.find('[data-testid="next-page"]').exists(), true);
  });

  it('C10 完整时给的是**肯定**说法，不只是没有警告', () => {
    // 只给否定提示的实现有一个盲区：「没有警告」与「警告没渲染出来」
    // 在屏幕上一样。因此完整这件事要有一句自己的话。
    const wrapper = mountDiff({ unified: '@@ -1 +1 @@\n-a\n+b\n' });
    assert.match(wrapper.find('[data-testid="diff-complete"]').text(), /完整差异/);
    assert.equal(wrapper.find('[data-testid="next-page"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="diff-page"]').exists(), false);
  });

  it('C11 切到「原文 / 新文」时截断标记消失 —— 整文件不是分页的', () => {
    // `unifiedTruncated` 说的是**差异页**被截断。原文与新文是整文件取回的，
    // 与那一页无关。把标记一起显示出来会让操作者以为全文也没看全。
    const wrapper = mountDiff({
      beforeText: '旧\n',
      afterText: '新\n',
      unified: '@@ -1 +1 @@\n-旧\n+新\n',
      unifiedTruncated: true,
      initialMode: 'unified',
    });
    assert.equal(wrapper.find('[data-testid="diff-page"]').exists(), true);

    return wrapper.find('[data-testid="mode-after"]').trigger('click').then(() => {
      assert.equal(wrapper.find('[data-testid="diff-page"]').exists(), false);
      assert.equal(wrapper.find('[data-testid="diff-complete"]').exists(), true);
    });
  });

  it('C12 点击「载入下一页」发出的是路径，取哪一页由调用方决定', async () => {
    const wrapper = mountDiff({
      path: 'src/deep/file.ts',
      unified: '@@ -1 +1 @@\n-a\n+b\n',
      unifiedTruncated: true,
      pageIndex: 2,
    });
    await wrapper.find('[data-testid="next-page"]').trigger('click');

    const emitted = wrapper.emitted('next-page');
    assert.equal(emitted?.length, 1);
    // 组件不持游标、不发请求：它只知道「哪一份文件有人要看下一页」。
    assert.deepEqual(emitted?.[0]?.[0], { path: 'src/deep/file.ts' });
  });

  it('C13 分页时正文仍然一行不少 —— 分页与折叠是两件事', () => {
    // 这一条把 C9 与 D1 接起来：分页会**换掉**正文，但不该**减少**它。
    // 一个把分页实现成「只显示前 N 行」的版本会在这里失败。
    const page = ['@@ -1,3 +1,3 @@', '-a', '-b', '-c', '+x', '+y', '+z'].join('\n');
    const wrapper = mountDiff({ unified: page, unifiedTruncated: true, pageIndex: 1 });
    assert.equal(wrapper.findAll('[data-testid="diff-line"]').length, page.split('\n').length);
  });
});

// ---------------------------------------------------------------------------
// D 组 · LWB-036：不折叠、键盘可访问、变更统计
// ---------------------------------------------------------------------------

describe('D 组 · 不折叠与可访问性（LWB-036 步骤 1、3）', () => {
  /** 一次大范围删除：400 行只剩 2 行。 */
  function bigDeletion(): string {
    const removed = Array.from({ length: 400 }, (_, i) => `-旧内容第 ${String(i + 1)} 行`);
    return ['@@ -1,402 +1,2 @@', '-保留一', '-保留二', ...removed, '+新内容一', '+新内容二'].join('\n');
  }

  it('D1 一段 402 行的差异，屏幕上一行不少 —— 这是本组的判决点', () => {
    const unified = bigDeletion();
    const wrapper = mountDiff({ unified });

    // **本条是「禁止折叠策略掩盖大范围删除」在界面上的样子。**
    // 一个把相邻未变行收起来、或者把大段删除收成「（省略 400 行）」的
    // 实现会在这里失败 —— 而那种实现正是这条要求要防的东西：
    // 操作者看到一个数字，按下批准，删掉的 400 行他一行都没看过。
    const expected = unified.split('\n').length;
    assert.equal(wrapper.findAll('[data-testid="diff-line"]').length, expected);
    assert.equal(expected, 405, '夹具本身：402 行内容 + 头 3 行');

    // 反向断言：屏幕上不得出现任何「省略」的说法。只数行数会让一个
    // 「行都渲染了，但额外加一句『中间略过 400 行』」的实现通过 ——
    // 而那句话本身就是折叠策略的产物（它描述的那段内容不在屏幕上）。
    const text = wrapper.text();
    assert.equal(text.includes('省略'), false);
    assert.equal(text.includes('略过'), false);
    assert.equal(text.includes('展开'), false);
  });

  it('D2 删除的每一行都真的在 DOM 里，不是只数对了行数', () => {
    const wrapper = mountDiff({ unified: bigDeletion() });
    const rendered = wrapper.findAll('[data-testid="diff-line"]').map((line) => line.element.textContent ?? '');
    // 抽查首、中、尾三行 —— 只查一行会让「渲染了前 N 行」的实现通过。
    assert.equal(rendered.some((line) => line.includes('旧内容第 1 行')), true);
    assert.equal(rendered.some((line) => line.includes('旧内容第 200 行')), true);
    assert.equal(rendered.some((line) => line.includes('旧内容第 400 行')), true);
  });

  it('D3 正文容器可获得焦点，键盘用户才滚得动它', () => {
    const wrapper = mountDiff({ unified: '@@ -1 +1 @@\n-a\n+b\n', path: 'src/a.ts' });
    const body = wrapper.find('[data-testid="diff-body"]');

    // 一个 `overflow-x: auto` 的盒子若不能获得焦点，长行超出宽度的部分
    // 对键盘用户就等于不存在 —— 而这段正文正是他们要核对的东西。
    assert.equal(body.attributes('tabindex'), '0');
    assert.equal(body.attributes('role'), 'region');
    assert.match(String(body.attributes('aria-label')), /src\/a\.ts/);
  });

  it('D4 变更统计来自落库事实，不由正文数出来', () => {
    const wrapper = mountDiff({
      unified: '@@ -1 +1 @@\n-a\n+b\n',
      stats: { added_lines: 3, removed_lines: 1, before_size: 100, after_size: 120 },
    });

    // 数字是调用方传进来的那一组，不是组件从正文里数出来的 ——
    // 正文里明明只有一行增删，屏幕上仍要显示落库的 `+3 −1`。
    // 这条断言在「组件自己数一遍」的实现上会失败，而那种实现会
    // 制造第二个判据：屏幕上那一行与批准绑定的摘要可能对不上。
    assert.match(wrapper.find('[data-testid="diff-stats-lines"]').text(), /\+3 −1/);
    assert.match(wrapper.find('[data-testid="diff-stats-bytes"]').text(), /100 B → 120 B/);
  });

  it('D5 拿不到落库事实时不显示统计行，而不是显示 0', () => {
    const wrapper = mountDiff({ unified: '@@ -1 +1 @@\n-a\n+b\n' });
    // 一个「+0 −0」既像事实又不像：它会被读成「这个文件没改动」，
    // 而真实情况是这一层不知道。不知道就不说。
    assert.equal(wrapper.find('[data-testid="diff-stats"]').exists(), false);
  });

  it('D6 没有正文可显示时不报「完整」，也不报「不完整」', () => {
    const wrapper = mountDiff({ beforeText: '旧\n', afterText: '新\n' });
    assert.equal(wrapper.find('[data-testid="diff-absent"]').exists(), true);
    // 这一格说的是「为什么没有」，在它旁边再加一句「而且它还不完整」
    // 是把两件事混成一句，而操作者要做的事只有第一件。
    assert.equal(wrapper.find('[data-testid="diff-complete"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="diff-page"]').exists(), false);
  });

});
