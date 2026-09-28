/**
 * ChangeDetailView 渲染测试（LWB-036 三条验收标准）。
 *
 * ## 这个文件与 `changes-view.spec.ts` 的分工
 *
 * 两个视图共用 `src/changes/` 的判定，因此**判定本身**不在这里重测
 * （`tests/unit/console-changes.test.ts` 已经做过）。这里测的是这一页
 * 独有的三件事，而三件事都只在真 DOM 里成立：
 *
 *  - **键盘**：`paging.ts` 的表是数据，而「按下 `j` 屏幕上的选中项真的
 *    变了」是另一回事。一个把 `actionFor` 接错分支的实现，在纯函数层
 *    100% 通过。
 *  - **分区**：详情页比清单页多一层风险与统计，而「模型写的那段话不能
 *    混进事实区」这一条在页面上是**容器归属**问题，不是字符串问题。
 *  - **闸门**：`content_gate` 是这一页独有的输入（清单页没有）。
 *
 * ## 三条验收标准的判决点分别在哪
 *
 * | 标准 | 判决点 | 为什么是它 |
 * | --- | --- | --- |
 * | (a) 批准内容与摘要一一对应 | D 组 | 有文件没展示过时，**按钮不在 DOM 里**，且说得出是哪个文件 |
 * | (b) 点击与工具调用并发只执行一次 | `tests/unit/control-changes.test.ts` | 那是服务端收敛（`UNIQUE(change_id)` + 一次性批准），界面测不到 |
 * | (c) 静态资源本地加载 | 无断言，靠结构 | 见下面「(c) 为什么没有断言」 |
 *
 * (c) 没有断言是刻意的，不是漏了：一个「页面上没有 `<img src=http://…>`」
 * 的测试只能证明**这一份夹具**里没有，而真正的保证是那两个组件的源码里
 * **根本没有渲染 `src` 的能力**（`DiffView.vue` 的文件头第 2 条）。
 * 一条只能证明夹具干净的断言，会给出一份没有的保证。
 *
 * ## B 组里最要紧的那一条
 *
 * B6 把 `REVIEW_KEYMAP` 里的**每一个键**都按一遍，断言 `approve` 一次都
 * 没发出去。它比「按 `a` 不发批准」强的地方在于：**它跟着那张表走**。
 * 将来有人往表里加一个键，这条断言会自动把它纳入 —— 而一个写死键名的
 * 断言不会。批准没有快捷键这件事（`paging.ts` 文件头）因此不是一条
 * 注释，是一条会失败的测试。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import type { ChangeFilePreview, ChangeRisk, ChangeSetView } from '@lwb/contracts';

import ChangeDetailView from '../views/ChangeDetailView.vue';
import {
  parseChangeDetail,
  REVIEW_KEYMAP,
  type ChangeDetail,
  type FileText,
  type RefreshDecision,
  type SessionPresence,
} from '../src/changes/index.ts';

const NOW = '2026-09-25T10:05:00.000Z';
const RLO = String.fromCodePoint(0x202e);

const SESSION: SessionPresence = { session_id: 'ses_0001' };

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

function changeOf(over: Partial<ChangeSetView> = {}): ChangeSetView {
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
 * 一份原始 JSON 响应 → `ChangeDetail`。
 *
 * 夹具走**真的解析函数**而不是直接造一个 `ChangeDetail` 对象：这样
 * 「服务端给了什么」与「屏幕上显示了什么」之间那一层也被走到了。直接把
 * 对象摆出来的写法会在解析层坏掉时继续通过 —— 而那一层正是「缺字段落到
 * `null` 还是落到默认值」的所在地。
 */
function detailOf(over: Record<string, unknown> = {}): ChangeDetail {
  const parsed = parseChangeDetail({
    change: changeOf(),
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
  });
  if (parsed === null) throw new Error('夹具本身解析失败 —— 先修夹具');
  return parsed;
}

/** 两侧正文都在、差异也齐：复核结论必然是 `complete` 的那种。 */
function reviewed(paths: readonly string[]): Record<string, FileText> {
  const out: Record<string, FileText> = {};
  for (const path of paths) {
    out[path] = {
      before: `BEFORE ${path}\n`,
      after: `AFTER ${path}\n`,
      unified: `UNIFIED ${path}\n`,
    };
  }
  return out;
}

function mountDetail(props: Record<string, unknown>): ReturnType<typeof mount> {
  return mount(ChangeDetailView, { props: { now: NOW, ...props } });
}

/**
 * 按下一个键，返回那个事件本身。
 *
 * 返回事件而不仅仅是「按过了」，是因为 B5 要问的是
 * `defaultPrevented` —— 一个认不出的键**不该被吃掉**（`paging.ts`
 * 的 `actionFor` 那一段写了理由）。`trigger()` 拿不到这个信息。
 */
async function press(wrapper: ReturnType<typeof mount>, key: string): Promise<KeyboardEvent> {
  const host = wrapper.find('[data-testid="change-detail"]').element as HTMLElement;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  host.dispatchEvent(event);
  await nextTick();
  return event;
}

function textOf(wrapper: ReturnType<typeof mount>, testid: string): string {
  return wrapper.find(`[data-testid="${testid}"]`).text();
}

// ---------------------------------------------------------------------------

describe('A 组 · 分区与事实（LWB-023 验收标准 1 在详情页上同样成立）', () => {
  it('A1 模型摘要落在「模型撰写」分区里，事实分区里没有它', () => {
    const wrapper = mountDetail({
      detail: detailOf(),
      session: SESSION,
      texts: reviewed(['src/app.ts']),
    });
    assert.equal(textOf(wrapper, 'summary').includes('无功能变化'), true);
    // 判决点：事实分区里不能出现摘要那句话。只断言「页面上有摘要」会让
    // 一个把摘要渲染进事实区的实现通过。
    assert.equal(textOf(wrapper, 'detail-region').includes('无功能变化'), false);
    assert.equal(wrapper.find('[data-testid="prose-region"]').exists(), true);
  });

  it('A2 摘要不影响事实：仍显示落库的增删行数与文件数', () => {
    const wrapper = mountDetail({
      detail: detailOf({
        change: changeOf({
          summary: '无害，仅调整格式。',
          files: [file({ path: 'a.ts', added_lines: 3, removed_lines: 1 })],
        }),
      }),
      session: SESSION,
      texts: reviewed(['a.ts']),
    });
    assert.match(textOf(wrapper, 'total-lines'), /\+3 −1/);
    assert.match(textOf(wrapper, 'total-files'), /1 个文件/);
  });

  it('A3 变更统计来自落库事实，不是从正文里数出来的', () => {
    // 正文只有一行，而落库事实说 999 —— 屏幕上的必须是 999。
    // 一个「数一遍」的实现会显示 +1，而那一行正是操作者据以决定的东西。
    const wrapper = mountDetail({
      detail: detailOf({
        change: changeOf({ files: [file({ path: 'a.ts', added_lines: 999, removed_lines: 7 })] }),
      }),
      session: SESSION,
      texts: reviewed(['a.ts']),
    });
    assert.match(textOf(wrapper, 'total-lines'), /\+999 −7/);
  });

  it('A4 风险汇总按等级计数，且逐条清单另有一处', () => {
    const risks: readonly ChangeRisk[] = [
      { level: 'warning', code: 'BULK_DELETE', message: '删除了大量行。' },
      { level: 'notice', code: 'NEW_FILE', message: '包含新建文件。' },
      { level: 'info', code: 'FORMAT', message: '仅格式变化。' },
    ];
    const wrapper = mountDetail({
      detail: detailOf({ change: changeOf({ risks }) }),
      session: SESSION,
      texts: reviewed(['src/app.ts']),
    });
    assert.equal(wrapper.find('[data-testid="risk-count-warning"]').attributes('data-count'), '1');
    assert.equal(wrapper.find('[data-testid="risk-count-notice"]').attributes('data-count'), '1');
    assert.equal(wrapper.find('[data-testid="risk-count-info"]').attributes('data-count'), '1');
    assert.equal(wrapper.findAll('[data-testid="risk-list"] li').length, 3);
  });

  it('A5 没有风险时不给暗示，只说明「系统没给出」', () => {
    const wrapper = mountDetail({
      detail: detailOf(),
      session: SESSION,
      texts: reviewed(['src/app.ts']),
    });
    const text = textOf(wrapper, 'no-risk');
    assert.equal(text.includes('不等于没有风险'), true);
    assert.equal(wrapper.find('[data-testid="risk-list"]').exists(), false);
  });

  it('A6 正文含方向控制字符时，通栏警告与逐文件标记同时出现', () => {
    const wrapper = mountDetail({
      detail: detailOf(),
      session: SESSION,
      texts: {
        'src/app.ts': { before: `${RLO}BEFORE\n`, after: 'AFTER\n', unified: 'U\n' },
      },
    });
    assert.equal(wrapper.find('[data-testid="banner-suspicious"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="file-suspicious"]').exists(), true);
  });

  it('A7 还没读到修改集时不显示任何动作', () => {
    const wrapper = mountDetail({ detail: null, session: SESSION });
    assert.equal(wrapper.find('[data-testid="detail-empty"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="reject-button"]').exists(), false);
  });
});

describe('B 组 · 键盘（LWB-036 步骤 1：键盘可访问性）', () => {
  const TWO_PATHS = ['a.ts', 'b.ts'] as const;

  function twoFiles(): ChangeDetail {
    return detailOf({
      change: changeOf({
        files: [file({ path: 'a.ts' }), file({ path: 'b.ts' })],
      }),
    });
  }

  it('B1 按 j 走到下一个文件，并发出一条 select-file', async () => {
    const wrapper = mountDetail({
      detail: twoFiles(),
      session: SESSION,
      texts: reviewed(TWO_PATHS),
    });
    await press(wrapper, 'j');
    const events = wrapper.emitted('select-file');
    assert.equal(events?.length, 1);
    assert.deepEqual(events?.[0]?.[0], { path: 'b.ts' });
  });

  it('B2 方向键与 j/k 去同一个地方（同一个动作，不是两条路）', async () => {
    const wrapper = mountDetail({
      detail: twoFiles(),
      session: SESSION,
      texts: reviewed(TWO_PATHS),
    });
    await press(wrapper, 'ArrowDown');
    assert.deepEqual(wrapper.emitted('select-file')?.[0]?.[0], { path: 'b.ts' });
    await press(wrapper, 'ArrowUp');
    assert.deepEqual(wrapper.emitted('select-file')?.[1]?.[0], { path: 'a.ts' });
  });

  it('B3 到边界是停住：最后一个文件上再按 j 不发事件（不绕回开头）', async () => {
    const wrapper = mountDetail({
      detail: twoFiles(),
      session: SESSION,
      texts: reviewed(TWO_PATHS),
    });
    await press(wrapper, 'End');
    assert.deepEqual(wrapper.emitted('select-file')?.[0]?.[0], { path: 'b.ts' });
    await press(wrapper, 'j');
    // 绕回实现会在这里发出 { path: 'a.ts' } —— 而「已经看完全部」正是
    // 批准的前提（`paging.ts` 的 `stepFile`）。
    assert.equal(wrapper.emitted('select-file')?.length, 1);
  });

  it('B4 按 2 真的把正文换成原文，不是改了一个没人读的变量', async () => {
    const wrapper = mountDetail({
      detail: twoFiles(),
      session: SESSION,
      texts: reviewed(TWO_PATHS),
    });
    assert.equal(textOf(wrapper, 'diff-body').includes('UNIFIED a.ts'), true);
    await press(wrapper, '2');
    const body = textOf(wrapper, 'diff-body');
    assert.equal(body.includes('BEFORE a.ts'), true);
    assert.equal(body.includes('UNIFIED a.ts'), false);
  });

  it('B5 认不出的键不被吃掉，认得的键被吃掉', async () => {
    const wrapper = mountDetail({
      detail: twoFiles(),
      session: SESSION,
      texts: reviewed(TWO_PATHS),
    });
    const unknown = await press(wrapper, 'q');
    assert.equal(unknown.defaultPrevented, false, '不认识的键必须放过去（Ctrl+R / F5 / Ctrl+F）');
    const known = await press(wrapper, 'j');
    assert.equal(known.defaultPrevented, true);
  });

  it('B6 表里的每一个键按一遍，批准一次都不发出去', async () => {
    const wrapper = mountDetail({
      detail: twoFiles(),
      session: SESSION,
      texts: reviewed(TWO_PATHS),
    });
    for (const binding of REVIEW_KEYMAP) {
      await press(wrapper, binding.key);
    }
    assert.equal(wrapper.emitted('approve'), undefined, '批准只能点击 —— 见 paging.ts 的文件头');
    assert.equal(wrapper.emitted('reject'), undefined);
  });

  it('B7 帮助表由 REVIEW_KEYMAP 渲染，按动作去重，且不含批准', () => {
    const wrapper = mountDetail({
      detail: twoFiles(),
      session: SESSION,
      texts: reviewed(TWO_PATHS),
    });
    const rows = wrapper.findAll('[data-testid="keymap"] li');
    const actions = rows.map((row) => row.attributes('data-action'));
    // j 与 ArrowDown 是同一个动作两行键，帮助里该是一行。
    assert.equal(new Set(actions).size, actions.length, '同一个动作不该在帮助里出现两次');
    assert.equal(rows.length, new Set(REVIEW_KEYMAP.map((b) => b.action)).size);
    assert.equal(rows.some((row) => (row.text()).includes('j / ArrowDown')), true);
    assert.equal(actions.includes('approve' as never), false);
    // 快捷键只浏览差异，不得暗示批准就是普通写入的必要步骤。
    assert.match(textOf(wrapper, 'keyboard'), /键盘快捷键只用于浏览差异，不触发写入/);
    assert.match(textOf(wrapper, 'keyboard'), /写入权限由当前 workspace 的工具 grant 决定/);
  });
});

describe('C 组 · 逐文件分页与位置（步骤 1）', () => {
  it('C1 没取过差异时说「尚未载入」，不说「已到末页」', () => {
    const wrapper = mountDetail({ detail: detailOf(), session: SESSION, texts: {} });
    assert.match(textOf(wrapper, 'position'), /差异尚未载入/);
    assert.equal(textOf(wrapper, 'position').includes('已到末页'), false);
  });

  it('C2 取全了说「已到末页」', () => {
    const wrapper = mountDetail({
      detail: detailOf(),
      session: SESSION,
      texts: { 'src/app.ts': { before: 'b\n', after: 'a\n', unified: 'U\n', pages: 1 } },
    });
    assert.match(textOf(wrapper, 'position'), /已取回 1 页差异（已到末页）/);
  });

  it('C3 被截断时说「还有更多」，并把「载入下一页」转给调用方', async () => {
    const wrapper = mountDetail({
      detail: detailOf(),
      session: SESSION,
      texts: {
        'src/app.ts': { before: null, after: null, unified: 'U\n', unified_truncated: true, pages: 1 },
      },
    });
    assert.match(textOf(wrapper, 'position'), /（还有更多）/);
    assert.equal(wrapper.find('[data-testid="diff-page"]').exists(), true);
    await wrapper.find('[data-testid="next-page"]').trigger('click');
    assert.deepEqual(wrapper.emitted('next-page')?.[0]?.[0], { path: 'src/app.ts' });
  });

  it('C4 上一个 / 下一个按钮与键盘走同一个方向', async () => {
    const detail = detailOf({
      change: changeOf({ files: [file({ path: 'a.ts' }), file({ path: 'b.ts' })] }),
    });
    const wrapper = mountDetail({ detail, session: SESSION, texts: reviewed(['a.ts', 'b.ts']) });
    await wrapper.find('[data-testid="next-file"]').trigger('click');
    assert.deepEqual(wrapper.emitted('select-file')?.[0]?.[0], { path: 'b.ts' });
    await wrapper.find('[data-testid="prev-file"]').trigger('click');
    assert.deepEqual(wrapper.emitted('select-file')?.[1]?.[0], { path: 'a.ts' });
  });
});

describe('D 组 · 复核覆盖挡住批准（验收标准 a）', () => {
  function twoFilesDetail(): ChangeDetail {
    return detailOf({
      change: changeOf({ files: [file({ path: 'src/app.ts' }), file({ path: 'tools/pre-commit' })] }),
    });
  }

  it('D1 有一个文件从没展示过时，批准按钮不在 DOM 里，但拒绝在', () => {
    const wrapper = mountDetail({
      detail: twoFilesDetail(),
      session: SESSION,
      texts: { 'src/app.ts': { before: 'b\n', after: 'a\n', unified: 'U\n' } },
    });
    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="reject-button"]').exists(), true);
  });

  it('D2 说得出是哪一个文件没展示（不是一句「还有文件没看」）', () => {
    const wrapper = mountDetail({
      detail: twoFilesDetail(),
      session: SESSION,
      texts: { 'src/app.ts': { before: 'b\n', after: 'a\n', unified: 'U\n' } },
    });
    const unseen = wrapper.find('[data-testid="file-unseen"]');
    assert.equal(unseen.exists(), true);
    assert.equal(unseen.attributes('data-reason'), 'NOT_DISPLAYED');
    assert.equal(textOf(wrapper, 'unseen-paths').includes('tools/pre-commit'), true);
    assert.equal(wrapper.find('[data-testid="blocked-reason"]').text().includes('UNSEEN_FILES'), true);
  });

  it('D3 全看完时批准按钮出现，且覆盖状态说得出「完整」', () => {
    const wrapper = mountDetail({
      detail: twoFilesDetail(),
      session: SESSION,
      texts: reviewed(['src/app.ts', 'tools/pre-commit']),
    });
    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="review-coverage"]').attributes('data-status'), 'complete');
    assert.equal(wrapper.findAll('[data-testid="file-covered"]').length, 2);
  });

  it('workspace 写 grant 已授权的修改集不显示逐次批准，并提示调用时复核 grant', () => {
    const wrapper = mountDetail({
      detail: detailOf({ change: changeOf({ approval_required: false }) }),
      session: SESSION,
      texts: reviewed(['src/app.ts']),
    });

    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="grant-write-hint"]').exists(), true);
    assert.match(wrapper.find('[data-testid="grant-write-hint"]').text(), /change_apply.*workspace.*grant/);
    assert.equal(wrapper.find('[data-testid="not-written-hint"]').exists(), false);
  });

  it('D4 服务端拒绝交内容时是 unavailable，而不是「还有文件没看过」', () => {
    const wrapper = mountDetail({
      detail: detailOf({
        change: changeOf({ files: [file({ path: 'src/app.ts' })] }),
        content_gate: {
          allows_read: false,
          reason: 'WORKSPACE_PAUSED',
          message: '工作区已暂停。',
        },
      }),
      session: SESSION,
      texts: reviewed(['src/app.ts']),
    });
    assert.equal(wrapper.find('[data-testid="review-coverage"]').attributes('data-status'), 'unavailable');
    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="reject-button"]').exists(), true);
    // 「取不到」不是「没看过」：列出「未取回差异」是一句假话，
    // 会让操作者去翻一个翻不出东西的地方。
    assert.equal(wrapper.find('[data-testid="unseen-paths"]').exists(), false);
    assert.equal(textOf(wrapper, 'gate-message').includes('WORKSPACE_PAUSED'), true);
  });

  it('D5 没有 content_gate 的响应按拒绝处理，不按允许', () => {
    const wrapper = mountDetail({
      detail: detailOf({ content_gate: undefined }),
      session: SESSION,
      texts: reviewed(['src/app.ts']),
    });
    assert.equal(wrapper.find('[data-testid="review-coverage"]').attributes('data-status'), 'unavailable');
    assert.equal(textOf(wrapper, 'gate-message').includes('GATE_UNREADABLE'), true);
    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), false);
  });

  it('D6 没有会话时连拒绝也不给（没有通道，拒绝也发不出去）', () => {
    const wrapper = mountDetail({
      detail: detailOf(),
      session: null,
      texts: reviewed(['src/app.ts']),
    });
    assert.equal(wrapper.find('[data-testid="approve-button"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="reject-button"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="relogin-hint"]').exists(), true);
  });
});

describe('E 组 · 事件与刷新（步骤 2：只走本地认证接口）', () => {
  it('E1 点批准发出的三个字段与服务端要的完全一致', async () => {
    const wrapper = mountDetail({
      detail: detailOf(),
      session: SESSION,
      texts: reviewed(['src/app.ts']),
    });
    await wrapper.find('[data-testid="approve-button"]').trigger('click');
    const payload = wrapper.emitted('approve')?.[0]?.[0] as Record<string, unknown>;
    assert.equal(payload['change_id'], 'chg_0001');
    assert.equal(payload['digest'], 'c'.repeat(64));
    assert.equal(typeof payload['idempotency_key'], 'string');
    assert.equal((payload['idempotency_key'] as string).includes('chg_0001'), true);
  });

  it('E2 有请求在途时再点也不发（busy）', async () => {
    const wrapper = mountDetail({
      detail: detailOf(),
      session: SESSION,
      texts: reviewed(['src/app.ts']),
      busy: true,
    });
    await wrapper.find('[data-testid="approve-button"]').trigger('click');
    assert.equal(wrapper.emitted('approve'), undefined);
  });

  it('E3 拒绝只带 change_id 与 digest（服务端不收幂等键）', async () => {
    const wrapper = mountDetail({
      detail: detailOf(),
      session: SESSION,
      texts: { 'src/app.ts': { before: null, after: null, unified: null } },
    });
    await wrapper.find('[data-testid="reject-button"]').trigger('click');
    assert.deepEqual(wrapper.emitted('reject')?.[0]?.[0], {
      change_id: 'chg_0001',
      digest: 'c'.repeat(64),
    });
  });

  it('E4 刷新状态显示出来，并且说得出还在不在轮询', () => {
    const refresh: RefreshDecision = {
      poll: false,
      next_delay_ms: null,
      stop: true,
      reason: 'TERMINAL',
      message: '修改集已进入终态，停止刷新。',
    };
    const wrapper = mountDetail({
      detail: detailOf(),
      session: SESSION,
      texts: reviewed(['src/app.ts']),
      refresh,
    });
    const node = wrapper.find('[data-testid="refresh-state"]');
    assert.equal(node.attributes('data-poll'), 'false');
    assert.equal(node.attributes('data-stop'), 'true');
    assert.equal(node.text().includes('停止刷新'), true);
  });

  it('E5 调用方不做自动刷新时什么都不说，不假装在轮询', () => {
    const wrapper = mountDetail({
      detail: detailOf(),
      session: SESSION,
      texts: reviewed(['src/app.ts']),
    });
    assert.equal(wrapper.find('[data-testid="refresh-state"]').exists(), false);
  });

  it('E6 生成新修改集时选中项与显示模式都回到初始值', async () => {
    const wrapper = mountDetail({
      detail: detailOf({
        change: changeOf({ files: [file({ path: 'a.ts' }), file({ path: 'b.ts' })] }),
      }),
      session: SESSION,
      texts: reviewed(['a.ts', 'b.ts']),
    });
    await press(wrapper, 'End');
    await press(wrapper, '2');
    assert.match(textOf(wrapper, 'position'), /第 2 \/ 2 个文件/);

    // 换一份修改集：停在「原文」模式上会让操作者以为屏幕上那段文字是差异。
    await wrapper.setProps({
      detail: detailOf({ change: changeOf({ change_id: 'chg_0002', files: [file({ path: 'c.ts' })] }) }),
      texts: reviewed(['c.ts']),
    });
    assert.match(textOf(wrapper, 'position'), /第 1 \/ 1 个文件/);
    assert.equal(textOf(wrapper, 'diff-body').includes('UNIFIED c.ts'), true);
  });
});
