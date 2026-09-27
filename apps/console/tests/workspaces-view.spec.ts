/**
 * WorkspacesView 渲染测试（LWB-035 执行步骤 1 与验收标准 1）。
 *
 * ## 为什么这些断言必须在真 DOM 里跑
 *
 * `tests/unit/console-setup.test.ts` 的 G 组已经判过暴露摘要怎么算、
 * 表单怎么校验、请求体是哪四个字段。那些都是**判定**。而验收标准的
 * 原文说的是**界面**：
 *
 * > 1. 提供**目录 / 单文件**授权、**只读模式**、**写入模式**与**风险说明**。
 * > 非技术用户能知道**当前哪台机器、哪些目录正在暴露**。
 *
 * 一个判定正确、却把风险说明放在页面底部、或把 `root` 藏起来的实现，
 * 会让上面每一条都失败 —— 而在视图模型层它 100% 通过。
 *
 * ## 三组各有一条「不成立时最容易被忽略」的断言
 *
 *  - **A 组**的 A3 断言**读取能力关闭时**通栏说的是「没有任何内容会被
 *    交给模型」，而不是「已登记 3 个」。只断言「显示了登记数」会让一个
 *    让非技术用户以为内容已经在外面了的实现通过。
 *  - **B 组**的 B2 断言缺勾时按钮**真的 disabled**，且理由**逐条在列**。
 *    只断言 «problems 数组非空» 会让一个把按钮永远禁用的实现通过。
 *  - **C 组**的 C2 断言移除要**两次点击**：第一次点完什么都没发出。
 *    只断言「点了之后发出了 remove」会让一个一次误点就摘掉根的实现通过。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { CapabilityFlags } from '@lwb/contracts';

import WorkspacesView from '../views/WorkspacesView.vue';
import type { WorkspaceRow } from '../src/setup/index.ts';

const NOW = '2026-09-26T12:00:00.000Z';

const FLAGS_OFF: CapabilityFlags = {
  read_enabled: false,
  git_enabled: false,
  proposal_enabled: false,
  direct_write_enabled: false,
  recovery_required: false,
};

const FLAGS_READ_ON: CapabilityFlags = { ...FLAGS_OFF, read_enabled: true };

const SESSION = { session_id: 'sess_1' };

function workspace(over: Partial<WorkspaceRow> & { readonly workspace_id: string }): WorkspaceRow {
  return {
    alias: '笔记',
    kind: 'directory',
    mode: 'read_only',
    root: 'D:\\MyProjects\\MyApps\\LocalWebGPT',
    generation: 1,
    policy_version: 1,
    enabled: true,
    removed: false,
    ...over,
  };
}

function mountView(props: Record<string, unknown>): ReturnType<typeof mount> {
  return mount(WorkspacesView, { props: { now: NOW, ...props } });
}

/** 填一个能提交的表单（只读模式，不需要那个勾）。 */
async function fillForm(
  wrapper: ReturnType<typeof mount>,
  alias: string,
  path: string,
): Promise<void> {
  await wrapper.find('[data-testid="alias-input"]').setValue(alias);
  await wrapper.find('[data-testid="path-input"]').setValue(path);
}

function disabled(wrapper: ReturnType<typeof mount>, testid: string): boolean {
  return wrapper.find(`[data-testid="${testid}"]`).attributes('disabled') !== undefined;
}

// ---------------------------------------------------------------------------
// A 组 · 「哪台机器、哪些目录正在暴露」（验收标准 1）
// ---------------------------------------------------------------------------

describe('A 组 · 暴露摘要在最上面，且两句话都说（验收标准 1）', () => {
  it('A1 机器那一行照实显示；没有读数时说明它为什么是未知的', () => {
    const known = mountView({ machineLine: 'MJ-LAPTOP-FVES0 · win32 10.0.26200 · x64' });
    assert.match(known.find('[data-testid="machine-line"]').text(), /MJ-LAPTOP-FVES0/);

    // 机器行由调用方算好传进来（`machineLine()`）。传不进来时**不能留白**：
    // 一行空着的机器信息会被读成「这台机器没有名字」，而不是「读不到」。
    const unknown = mountView({});
    assert.match(unknown.find('[data-testid="machine-line"]').text(), /未知/);
    assert.match(unknown.find('[data-testid="machine-line"]').text(), /没有给出机器读数/);
  });

  it('A2 一个都没登记时说的是「没有任何内容暴露」，并给空状态', () => {
    const wrapper = mountView({ machineLine: 'MJ-LAPTOP-FVES0' });

    assert.equal(wrapper.find('[data-testid="exposure-headline"]').attributes('data-exposed'), 'false');
    assert.equal(
      wrapper.find('[data-testid="exposure-headline"]').text(),
      '当前没有任何目录被登记，因此没有任何本机内容暴露给模型。',
    );
    assert.equal(wrapper.find('[data-testid="empty-state"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="workspace-list"]').exists(), false);
    // 空列表里那句「已登记的根（0）」仍然要有：一个不写数字的列表头
    // 会让人以为列表没加载完。
    assert.match(wrapper.text(), /已登记的根（0）/);
  });

  it('A3 登记了三个但读取关闭时，通栏说的是「没有任何内容会被交给模型」', () => {
    // 判决点：这正是「登记了几个」与「暴露了几个」答案相反的那一刻。
    const wrapper = mountView({
      machineLine: 'MJ-LAPTOP-FVES0',
      workspaces: [
        workspace({ workspace_id: 'ws_1' }),
        workspace({ workspace_id: 'ws_2', mode: 'read_propose_apply_with_local_approval' }),
        workspace({ workspace_id: 'ws_3', enabled: false }),
      ],
      flags: FLAGS_OFF,
    });

    const headline = wrapper.find('[data-testid="exposure-headline"]');
    assert.equal(headline.attributes('data-exposed'), 'false');
    assert.equal(
      headline.text(),
      '已登记 3 个根，但当前没有根同时满足连接、目录授权与全局能力门禁；内容工具不可用。',
    );
    assert.match(wrapper.find('[data-testid="capability-note"]').text(), /读取能力当前关闭/);
  });

  it('A4 读取打开时通栏改成「读取能力打开中」，且摘要是三行', () => {
    const wrapper = mountView({
      workspaces: [workspace({ workspace_id: 'ws_1' }), workspace({ workspace_id: 'ws_2', enabled: false })],
      workspaceAccess: [{ workspace_id: 'ws_1', enabled: true, capabilities: ['list', 'read'] }],
      connectionEnabled: true,
      flags: FLAGS_READ_ON,
    });

    const headline = wrapper.find('[data-testid="exposure-headline"]');
    assert.equal(headline.attributes('data-exposed'), 'true');
    assert.equal(headline.text(), '已登记 2 个根，其中 1 个根当前具备有效的 ChatGPT 内容工具访问条件；只有实际调用时才会有内容出站。');

    const lines = wrapper.findAll('[data-testid="exposure-line"]').map((line) => line.text());
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? '', /全局读取能力当前\*\*打开\*\*/);
    assert.match(lines[0] ?? '', /ChatGPT 连接已启用/);
    assert.match(lines[1] ?? '', /全局提议门禁当前关闭/);
    assert.match(lines[2] ?? '', /没有被移除的登记/);
  });

  it('A5 有被移除的登记时，第三行说出来，且它仍在列表里', () => {
    const wrapper = mountView({
      workspaces: [
        workspace({ workspace_id: 'ws_1' }),
        workspace({ workspace_id: 'ws_9', removed: true }),
      ],
      flags: FLAGS_READ_ON,
    });

    assert.match(wrapper.findAll('[data-testid="exposure-line"]')[2]?.text() ?? '', /另有 1 个已移除的登记/);
    // 「路径仍列出」这句是真的：被移除的那一行还在 DOM 里。
    assert.equal(wrapper.findAll('[data-testid="workspace-row"]').length, 2);
    assert.equal(
      wrapper.find('[data-workspace-id="ws_9"]').find('[data-testid="ws-state"]').text(),
      '已移除',
    );
  });

  it('A6 每一行的本机绝对路径、范围、模式都在屏幕上', () => {
    const wrapper = mountView({
      workspaces: [
        workspace({ workspace_id: 'ws_1', alias: '仓库', root: 'D:\\code\\repo' }),
        workspace({
          workspace_id: 'ws_2',
          alias: '一个文件.txt',
          kind: 'file',
          mode: 'read_propose_apply_with_local_approval',
          root: 'D:\\code\\a.txt',
          generation: 4,
          policy_version: 2,
        }),
      ],
    });

    const rows = wrapper.findAll('[data-testid="workspace-row"]');
    assert.deepEqual(rows.map((row) => row.attributes('data-workspace-id')), ['ws_1', 'ws_2']);

    // 绝对路径**不藏**：这一页是给本地操作者看的（藏起来他就无法确认
    // 登记的是哪一个目录），而它不会流向模型。
    assert.equal(rows[0]?.find('[data-testid="ws-root"]').text(), 'D:\\code\\repo');
    assert.equal(rows[1]?.find('[data-testid="ws-root"]').text(), 'D:\\code\\a.txt');
    assert.equal(rows[0]?.find('[data-testid="ws-mode"]').text(), '只读');
    assert.equal(rows[1]?.find('[data-testid="ws-mode"]').text(), '只读 + 提议（需本地批准）');
    assert.match(rows[0]?.find('[data-testid="ws-ids"]').text() ?? '', /目录 · 代次 1 · 策略版本 1/);
    assert.match(rows[1]?.find('[data-testid="ws-ids"]').text() ?? '', /单个文件 · 代次 4 · 策略版本 2/);
  });

  it('A7 上一次操作的结果留在页面上，且成功与失败分得开', () => {
    const bad = mountView({ feedback: { ok: false, message: '服务拒绝了这次登记。' } });
    assert.equal(bad.find('[data-testid="feedback"]').attributes('data-ok'), 'false');
    assert.match(bad.find('[data-testid="feedback"]').text(), /拒绝了这次登记/);

    const good = mountView({ feedback: { ok: true, message: '已登记。' } });
    assert.equal(good.find('[data-testid="feedback"]').attributes('data-ok'), 'true');

    assert.equal(mountView({}).find('[data-testid="feedback"]').exists(), false);
  });
});

// ---------------------------------------------------------------------------
// B 组 · 登记表单（执行步骤 1）
// ---------------------------------------------------------------------------

describe('B 组 · 目录 / 单文件、两种模式与各自的说明（执行步骤 1）', () => {
  it('B1 两种范围与两种模式都在；两个模式的说明各自跟在选项下面', () => {
    const wrapper = mountView({});
    assert.equal(wrapper.find('[data-testid="kind-directory"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="kind-file"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="mode-read_only"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="mode-read_propose_apply_with_local_approval"]').exists(), true);

    const risks = wrapper.findAll('[data-testid="mode-risk"]');
    assert.deepEqual(risks.map((p) => p.attributes('data-mode')), [
      'read_only',
      'read_propose_apply_with_local_approval',
    ]);
    // 这句话必须出现在**选只读的时候**：一个认为只读就是安全的用户
    // 不会去读页面底部的说明。
    assert.match(risks[0]?.text() ?? '', /只读不等于不出本机/);
    assert.match(risks[1]?.text() ?? '', /每次实际应用仍需你在本机核对差异并批准/);
  });

  it('B2 提议模式的风险说明里那句「直写」由门禁现算，不是写死的', () => {
    const off = mountView({ gates: null, flags: null });
    const offRisk = off.findAll('[data-testid="mode-risk"]')[1]?.text() ?? '';
    assert.match(offRisk, /当前关闭（门禁读数缺失，按未通过处理。）/);

    // 喂一份「门禁全过 + 开关打开」的读数，同一句变成「当前已打开」——
    // 写死文案的实现在这里会说谎。
    const on = mountView({
      gates: {
        g0_platform_verified: true,
        native_guard_verified: true,
        compatibility_section3_passed: true,
        g4_concurrency_fault_passed: true,
      },
      flags: { ...FLAGS_OFF, direct_write_enabled: true },
    });
    assert.match(on.findAll('[data-testid="mode-risk"]')[1]?.text() ?? '', /当前已打开。/);
  });

  it('B3 提议模式不勾风险说明就提交不了，且理由逐条在列', async () => {
    const wrapper = mountView({ session: SESSION });
    await wrapper.find('[data-testid="mode-read_propose_apply_with_local_approval"]').trigger('change');
    await fillForm(wrapper, '仓库', 'D:\\code\\repo');

    // 那个勾只在这一模式下出现，且此刻是没勾的。
    assert.equal(wrapper.find('[data-testid="risk-ack"]').exists(), true);
    assert.equal(disabled(wrapper, 'register-button'), true);
    assert.deepEqual(
      wrapper.findAll('[data-testid="form-problem"]').map((li) => li.text()),
      ['这一模式需要先确认风险说明。'],
    );

    await wrapper.find('[data-testid="risk-ack"]').setValue(true);
    assert.equal(disabled(wrapper, 'register-button'), false);
    assert.equal(wrapper.find('[data-testid="form-problems"]').exists(), false);
  });

  it('B4 换模式会把那个勾清掉', async () => {
    const wrapper = mountView({ session: SESSION });
    await wrapper.find('[data-testid="mode-read_propose_apply_with_local_approval"]').trigger('change');
    await wrapper.find('[data-testid="risk-ack"]').setValue(true);
    assert.equal(disabled(wrapper, 'register-button'), true, '路径还没填，此时本来就不可提交');

    await fillForm(wrapper, '仓库', 'D:\\code\\repo');
    assert.equal(disabled(wrapper, 'register-button'), false);

    // 切回只读再切回提议：勾必须没了 —— 带着旧勾提交等于没读过新说明。
    await wrapper.find('[data-testid="mode-read_only"]').trigger('change');
    await wrapper.find('[data-testid="mode-read_propose_apply_with_local_approval"]').trigger('change');
    assert.equal(wrapper.find('[data-testid="risk-ack"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="risk-ack"]').element.checked, false);
    assert.equal(disabled(wrapper, 'register-button'), true);
  });

  it('B5 空别名与空路径的原因都说得出，而且都不越过服务端', async () => {
    const wrapper = mountView({ session: SESSION });
    assert.deepEqual(
      wrapper.findAll('[data-testid="form-problem"]').map((li) => li.text()),
      ['别名不能为空。', '路径不能为空。浏览器不能替你选目录，请粘贴完整路径。'],
    );
    // 路径不能为空这一条**不许**替服务端判「路径存不存在」：界面只说自己知道的事。
    assert.match(wrapper.find('[data-testid="path-hint"]').text(), /浏览器不能替你选目录/);
  });

  it('B6 没有会话时按钮不可用，并说得出下一步', async () => {
    const wrapper = mountView({});
    await fillForm(wrapper, '仓库', 'D:\\code\\repo');

    assert.equal(disabled(wrapper, 'register-button'), true);
    assert.match(wrapper.find('[data-testid="no-session"]').text(), /还没有控制台会话/);
    assert.match(wrapper.find('[data-testid="no-session"]').text(), /一次性令牌/);

    // 表单自己过得了自检时，那一行「为什么不能提交」才轮到会话那一条 ——
    // 两条原因同时成立时先说表单（否则操作者会以为问题出在会话上）。
    const expired = mountView({ sessionExpired: true });
    await fillForm(expired, '仓库', 'D:\\code\\repo');
    assert.equal(disabled(expired, 'register-button'), true);
    assert.match(expired.find('[data-testid="no-session"]').text(), /会话已过期/);
  });

  it('B7 提交发出的**恰好四个字段**，且路径去空白后原样送出', async () => {
    const wrapper = mountView({ session: SESSION });
    await fillForm(wrapper, '  仓库  ', '  D:\\code\\repo  ');
    await wrapper.find('[data-testid="register-button"]').trigger('click');

    const emitted = wrapper.emitted('register');
    assert.equal(emitted?.length, 1);
    const payload = emitted?.[0]?.[0] as Record<string, unknown>;
    // 判决点：多一个字段都没有 —— 将来有人给表单加一个复选框时，
    // 它不会被顺手送到服务端去（服务端今天恰好会忽略它）。
    assert.deepEqual(Object.keys(payload).sort(), ['alias', 'kind', 'mode', 'path']);
    assert.deepEqual(payload, {
      alias: '仓库',
      kind: 'directory',
      mode: 'read_only',
      path: 'D:\\code\\repo',
    });
    // 反斜杠一个不少：路径不做规范化，服务端看到的必须就是粘贴的那一串
    // （只去掉首尾空白）。
    assert.equal((String(payload['path']).match(/\\/g) ?? []).length, 2);
  });

  it('B8 选「单个文件」之后请求体里就是 file', async () => {
    const wrapper = mountView({ session: SESSION });
    await wrapper.find('[data-testid="kind-file"]').trigger('change');
    assert.equal(wrapper.find('[data-testid="kind-file"]').element.checked, true);
    assert.equal(wrapper.find('[data-testid="kind-directory"]').element.checked, false);

    await fillForm(wrapper, '一个文件', 'D:\\code\\a.txt');
    await wrapper.find('[data-testid="register-button"]').trigger('click');
    assert.equal((wrapper.emitted('register')?.[0]?.[0] as Record<string, unknown>)['kind'], 'file');
  });

  it('B9 忙碌时提交不出去；「清空」把表单还原', async () => {
    const busy = mountView({ session: SESSION, busy: true });
    await fillForm(busy, '仓库', 'D:\\code\\repo');
    assert.equal(disabled(busy, 'register-button'), true);
    await busy.find('[data-testid="register-button"]').trigger('click');
    assert.equal(busy.emitted('register'), undefined);

    const wrapper = mountView({ session: SESSION });
    await fillForm(wrapper, '仓库', 'D:\\code\\repo');
    await wrapper.find('[data-testid="reset-button"]').trigger('click');
    assert.equal(wrapper.find('[data-testid="alias-input"]').element.value, '');
    assert.equal(wrapper.find('[data-testid="path-input"]').element.value, '');
    assert.deepEqual(
      wrapper.findAll('[data-testid="form-problem"]').map((li) => li.text()),
      ['别名不能为空。', '路径不能为空。浏览器不能替你选目录，请粘贴完整路径。'],
    );
  });

  it('B10 选中模式的说明在提交按钮上方还出现一次', () => {
    const wrapper = mountView({});
    assert.match(wrapper.find('[data-testid="selected-risk"]').text(), /将登记为「只读」/);
  });
});

// ---------------------------------------------------------------------------
// C 组 · 逐行动作
// ---------------------------------------------------------------------------

describe('C 组 · 逐行动作', () => {
  it('C1 启用中的一行有五个动作，且名字与行为对得上', () => {
    const wrapper = mountView({ session: SESSION, workspaces: [workspace({ workspace_id: 'ws_1' })] });

    assert.equal(wrapper.find('[data-testid="pause-ws_1"]').text(), '暂停');
    assert.equal(wrapper.find('[data-testid="resume-ws_1"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="reverify-ws_1"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="relocate-ws_1"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="remove-ws_1"]').exists(), true);
  });

  it('C2 移除要两次点击：第一次点完什么都没发出', async () => {
    const wrapper = mountView({ session: SESSION, workspaces: [workspace({ workspace_id: 'ws_1' })] });

    await wrapper.find('[data-testid="remove-ws_1"]').trigger('click');
    assert.equal(wrapper.emitted('remove'), undefined, '第一次点击不得摘掉任何东西');
    assert.equal(wrapper.find('[data-testid="remove-confirm"]').exists(), true);
    assert.match(wrapper.find('[data-testid="remove-confirm"]').text(), /目录里的文件\*\*不受影响\*\*/);

    // 取消：什么也不发生，确认块收起来。
    await wrapper.find('[data-testid="remove-cancel"]').trigger('click');
    assert.equal(wrapper.find('[data-testid="remove-confirm"]').exists(), false);
    assert.equal(wrapper.emitted('remove'), undefined);

    await wrapper.find('[data-testid="remove-ws_1"]').trigger('click');
    await wrapper.find('[data-testid="remove-confirm-ws_1"]').trigger('click');
    assert.deepEqual(wrapper.emitted('remove')?.[0]?.[0], { workspace_id: 'ws_1' });
    assert.equal(wrapper.find('[data-testid="remove-confirm"]').exists(), false);
  });

  it('C3 已移除的行没有动作按钮，也没有暂停/恢复', () => {
    const wrapper = mountView({
      session: SESSION,
      workspaces: [workspace({ workspace_id: 'ws_9', removed: true })],
    });
    const row = wrapper.find('[data-workspace-id="ws_9"]');

    assert.equal(row.attributes('data-removed'), 'true');
    assert.equal(row.find('[data-testid="remove-ws_9"]').exists(), false);
    assert.equal(row.find('[data-testid="relocate-ws_9"]').exists(), false);
    assert.equal(row.find('[data-testid="reverify-ws_9"]').exists(), false);
    assert.equal(row.find('[data-testid="pause-ws_9"]').exists(), false);
    assert.equal(row.find('[data-testid="resume-ws_9"]').exists(), false);
  });

  it('C4 没有会话时按钮仍在但不可按 —— 藏起来会让人找不到入口', () => {
    const wrapper = mountView({ workspaces: [workspace({ workspace_id: 'ws_1' })] });

    assert.equal(wrapper.find('[data-testid="remove-ws_1"]').exists(), true);
    assert.equal(disabled(wrapper, 'remove-ws_1'), true);
    assert.equal(disabled(wrapper, 'pause-ws_1'), true);
    assert.equal(disabled(wrapper, 'reverify-ws_1'), true);
    assert.equal(disabled(wrapper, 'relocate-ws_1'), true);
  });

  it('C5 暂停与恢复按这一行的状态二选一，点下去带上 workspace_id', async () => {
    const wrapper = mountView({
      session: SESSION,
      workspaces: [
        workspace({ workspace_id: 'ws_1' }),
        workspace({ workspace_id: 'ws_2', enabled: false }),
      ],
    });

    assert.equal(wrapper.find('[data-testid="resume-ws_2"]').text(), '恢复');
    assert.equal(wrapper.find('[data-testid="ws-state"]').text(), '启用');

    await wrapper.find('[data-testid="pause-ws_1"]').trigger('click');
    await wrapper.find('[data-testid="resume-ws_2"]').trigger('click');
    assert.deepEqual(wrapper.emitted('pause')?.[0]?.[0], { workspace_id: 'ws_1' });
    assert.deepEqual(wrapper.emitted('resume')?.[0]?.[0], { workspace_id: 'ws_2' });
  });

  it('C6 重新指向：输入框预填当前路径，确认后发出新路径，且不发旧的', async () => {
    const wrapper = mountView({ session: SESSION, workspaces: [workspace({ workspace_id: 'ws_1', root: 'D:\\old' })] });

    await wrapper.find('[data-testid="relocate-ws_1"]').trigger('click');
    const form = wrapper.find('[data-testid="relocate-form"]');
    assert.equal(form.exists(), true);
    assert.equal(wrapper.find('[data-testid="relocate-input"]').element.value, 'D:\\old');
    assert.match(form.text(), /它\*\*不改动\*\*用户文件/);

    // 空路径不发：那会变成「指向空字符串」的一次登记。
    await wrapper.find('[data-testid="relocate-input"]').setValue('   ');
    await wrapper.find('[data-testid="relocate-confirm-ws_1"]').trigger('click');
    assert.equal(wrapper.emitted('relocate'), undefined);

    await wrapper.find('[data-testid="relocate-input"]').setValue('D:\\new');
    await wrapper.find('[data-testid="relocate-confirm-ws_1"]').trigger('click');
    assert.deepEqual(wrapper.emitted('relocate')?.[0]?.[0], { workspace_id: 'ws_1', path: 'D:\\new' });
  });

  it('C7 两个行内表单一次只开一个', async () => {
    const wrapper = mountView({
      session: SESSION,
      workspaces: [workspace({ workspace_id: 'ws_1' }), workspace({ workspace_id: 'ws_2' })],
    });

    await wrapper.find('[data-testid="remove-ws_1"]').trigger('click');
    assert.equal(wrapper.find('[data-testid="remove-confirm"]').exists(), true);

    await wrapper.find('[data-testid="relocate-ws_2"]').trigger('click');
    assert.equal(wrapper.findAll('[data-testid="relocate-form"]').length, 1);
    assert.equal(
      wrapper.findAll('[data-testid="remove-confirm"]').length,
      0,
      '开新的那一行时，上一行的二次确认必须收起来',
    );
  });

  it('C8 重新核对身份只发出 workspace_id', async () => {
    const wrapper = mountView({ session: SESSION, workspaces: [workspace({ workspace_id: 'ws_1' })] });
    await wrapper.find('[data-testid="reverify-ws_1"]').trigger('click');
    assert.deepEqual(wrapper.emitted('reverify')?.[0]?.[0], { workspace_id: 'ws_1' });
  });

  it('C9 每个目录显示自己的 ChatGPT 权限，保存时只发该目录所选能力', async () => {
    const wrapper = mountView({
      session: SESSION,
      workspaces: [workspace({ workspace_id: 'ws_1' }), workspace({ workspace_id: 'ws_2', alias: '另一仓库' })],
      workspaceAccess: [
        { workspace_id: 'ws_1', enabled: true, capabilities: ['read', 'list'] },
      ],
    });
    assert.match(wrapper.find('[data-workspace-id="ws_1"] [data-testid="access-summary"]').text(), /列出目录\/文件名、读取文件内容/);
    assert.match(wrapper.find('[data-workspace-id="ws_2"] [data-testid="access-summary"]').text(), /未授权访问此目录/);

    await wrapper.find('[data-testid="configure-access-ws_1"]').trigger('click');
    assert.equal((wrapper.find('[data-testid="access-ws_1-list"]').element as HTMLInputElement).checked, true);
    assert.equal((wrapper.find('[data-testid="access-ws_1-read"]').element as HTMLInputElement).checked, true);
    assert.equal((wrapper.find('[data-testid="access-ws_1-search"]').element as HTMLInputElement).checked, false);
    assert.equal(wrapper.find('[data-testid="access-ws_1-propose"]').attributes('disabled') !== undefined, true);
    assert.equal(wrapper.find('[data-testid="propose-mode-note"]').exists(), true);

    await wrapper.find('[data-testid="access-ws_1-git_read"]').setValue(true);
    await wrapper.find('[data-testid="save-access-ws_1"]').trigger('click');
    assert.deepEqual(wrapper.emitted('set-access')?.[0]?.[0], {
      workspace_id: 'ws_1',
      capabilities: ['list', 'read', 'git_read'],
    });
  });

  it('C10 空选并保存发出空能力集，表达撤销该目录 ChatGPT 访问', async () => {
    const wrapper = mountView({
      session: SESSION,
      workspaces: [workspace({ workspace_id: 'ws_1' })],
      workspaceAccess: [{ workspace_id: 'ws_1', enabled: true, capabilities: ['read'] }],
    });
    await wrapper.find('[data-testid="configure-access-ws_1"]').trigger('click');
    await wrapper.find('[data-testid="access-ws_1-read"]').setValue(false);
    await wrapper.find('[data-testid="save-access-ws_1"]').trigger('click');
    assert.deepEqual(wrapper.emitted('set-access')?.[0]?.[0], { workspace_id: 'ws_1', capabilities: [] });
  });
});
