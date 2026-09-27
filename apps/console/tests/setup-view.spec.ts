/**
 * SetupView 渲染测试（LWB-035 验收标准 2、3 的渲染半边）。
 *
 * ## 为什么这些断言必须在真 DOM 里跑
 *
 * `tests/unit/console-setup.test.ts` 已经判过「四格全绿时门禁会开」
 * 「断网否决一切」「没有读数时不提供恢复」。那些都是**判定**。而验收
 * 标准的原文说的是**界面**：
 *
 * > 无法越过 G0/G4 开关直接授权直写。
 * > 停机/睡眠/断网状态**不显示成**正常在线。
 *
 * 一个判定正确、却把「无读数」渲染成「未通过」的模板，会让第二条里
 * 最要紧的那一档（睡眠唤醒后读数过期）失败 —— 而在视图模型层它 100% 通过。
 *
 * ## 本文件的三个组各有一条「不成立时最容易被忽略」的断言
 *
 *  - **A 组**的 A1 断言页面上**不出现**「正常在线」这四个字。只断言
 *    「四条腿都在」会让一个把所有格子都涂成绿色的实现通过。
 *  - **B 组**的 B2 断言**无读数**渲染成「无读数」，而不是「未通过」。
 *    只断言「显示了四个格子」会让一个 `?? false` 的实现通过，而那个实现
 *    把「去查服务」说成了「去看证据」。
 *  - **C 组**的 C4 断言 `paused` 为 `null` 时那个属性是 `unknown`。
 *    只断言「暂停按钮在」会让一个把「没有读数」渲染成「服务正常」的
 *    实现通过 —— 因为两者的按钮**长得一模一样**。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { CapabilityFlags } from '@lwb/contracts';

import SetupView from '../views/SetupView.vue';
import type {
  ConnectionRow,
  Gates,
  PauseStatusReading,
  Reading,
  StatusReading,
} from '../src/setup/index.ts';
import { platformVerdict, writeGate } from '../src/setup/index.ts';

const NOW = '2026-09-26T12:00:00.000Z';
const FRESH_AT = '2026-09-26T11:59:50.000Z';
const STALE_AT = '2026-09-26T11:00:00.000Z';

const ALL_FAIL: Gates = {
  g0_platform_verified: false,
  native_guard_verified: false,
  compatibility_section3_passed: false,
  g4_concurrency_fault_passed: false,
};

const ALL_PASS: Gates = {
  g0_platform_verified: true,
  native_guard_verified: true,
  compatibility_section3_passed: true,
  g4_concurrency_fault_passed: true,
};

const FLAGS_OFF: CapabilityFlags = {
  read_enabled: false,
  git_enabled: false,
  proposal_enabled: false,
  direct_write_enabled: false,
  recovery_required: false,
};

const FLAGS_ON: CapabilityFlags = {
  read_enabled: true,
  git_enabled: true,
  proposal_enabled: true,
  direct_write_enabled: true,
  recovery_required: false,
};

function status(over: Partial<StatusReading> = {}): StatusReading {
  return {
    version: '0.1.0',
    protocol_version: '1',
    gates: ALL_FAIL,
    capability_flags: FLAGS_OFF,
    limitations: ['V1 仅支持本机 NTFS'],
    machine: { hostname: 'MJ-LAPTOP-FVES0', os: 'win32 10.0.26200', arch: 'x64' },
    workspaces: 0,
    connections: 0,
    routes: [],
    ...over,
  };
}

function reading<T>(value: T, observedAt: string = FRESH_AT): Reading<T> {
  return { value, observed_at: observedAt };
}

function pauseReading(over: Partial<PauseStatusReading> = {}): PauseStatusReading {
  return {
    paused: false,
    paused_at: null,
    stopping: [],
    unrevoked_change_sets: [],
    recovery_operations: [],
    unrecallable_file_rows: 0,
    ...over,
  };
}

function mountView(props: Record<string, unknown>): ReturnType<typeof mount> {
  return mount(SetupView, { props: { now: NOW, ...props } });
}

const SESSION = { session_id: 'sess_1' };

// ---------------------------------------------------------------------------
// A 组 · 停机/睡眠/断网不显示成正常在线（验收标准 3）
// ---------------------------------------------------------------------------

describe('A 组 · 平台状态不会冒充在线（验收标准 3）', () => {
  it('A1 停机时页面上不出现「正常在线」这类说法', () => {
    const wrapper = mountView({ session: SESSION });

    assert.equal(wrapper.find('[data-testid="banner"]').attributes('data-callable'), 'false');

    // 判决点：**结论区与四格**里不得出现「正常在线」这类说法。
    //
    // 这里刻意不扫整页：帮助里那一条的警告原文是「停机、睡眠、断网不得
    // 显示成正常在线」—— 它必须**出现**在页面上，而整页扫描会把它算成
    // 违规。断言的范围要与「谁在声称」对齐：声称的是通栏与那四格。
    const claimed = `${wrapper.find('[data-testid="banner"]').text()}\n${wrapper.find('[data-testid="leg-list"]').text()}`;
    assert.equal(claimed.includes('正常在线'), false);
    assert.equal(claimed.includes('服务正常'), false);
    assert.equal(claimed.includes('已就绪'), false);

    assert.match(wrapper.find('[data-testid="verdict-headline"]').text(), /不可调用/);
    // 「在运行」与「能调用」是两件事 —— 结论那一行必须说出来。
    assert.match(wrapper.find('[data-testid="verdict-headline"]').text(), /是两件事/);
    // 而那条禁止「显示成正常在线」的规则本身必须在屏幕上（它在帮助里）。
    assert.match(wrapper.text(), /不得显示成正常在线/);
  });

  it('A2 四条腿都在屏幕上，且每一格都说了「不能证明什么」', () => {
    const wrapper = mountView({ session: SESSION, status: reading(status()) });
    const legs = wrapper.findAll('[data-testid="leg"]');

    assert.deepEqual(legs.map((leg) => leg.attributes('data-leg')), [
      'daemon',
      'mcp_adapter',
      'tunnel_client',
      'account',
    ]);
    // 隧道那一格今天没有读数 —— 它必须是「没有读数」，不是绿也不是红。
    const tunnel = legs.find((leg) => leg.attributes('data-leg') === 'tunnel_client');
    assert.equal(tunnel?.attributes('data-state'), 'unknown');
    assert.match(tunnel?.find('[data-testid="leg-state"]').text() ?? '', /没有读数/);

    const account = legs.find((leg) => leg.attributes('data-leg') === 'account');
    assert.equal(account?.attributes('data-state'), 'off');
    assert.match(account?.find('[data-testid="leg-headline"]').text() ?? '', /尚未通过/);
    // 每一格的 detail 都必须存在：一句话结论会让人以为那就够了。
    assert.equal(wrapper.findAll('[data-testid="leg-detail"]').length, 4);
  });

  it('A3 读数过期时显示「读数已过期」，而不是继续显示旧值', () => {
    const wrapper = mountView({ session: SESSION, status: reading(status(), STALE_AT) });

    assert.equal(wrapper.find('[data-testid="reading-freshness"]').text(), '读数已过期');
    assert.match(wrapper.find('[data-testid="reading-at"]').text(), /2026-09-26T11:00:00\.000Z/);
    // 机器那一行照旧显示（机器不会变），但必须带上它出自什么时候。
    assert.match(wrapper.find('[data-testid="machine-line"]').text(), /MJ-LAPTOP-FVES0/);
    assert.match(wrapper.find('[data-testid="machine-line"]').text(), /读数已过期/);
  });

  it('A4 断网由网络本身否决：理由那一条排在最前', () => {
    const wrapper = mountView({
      session: SESSION,
      status: reading(status({ gates: ALL_PASS, capability_flags: FLAGS_ON })),
      browserOnline: false,
    });
    assert.equal(wrapper.find('[data-testid="banner"]').attributes('data-callable'), 'false');
    assert.match(wrapper.findAll('[data-testid="reason"]')[0]?.text() ?? '', /网络已断开/);
  });

  it('A5 四格全绿时通栏变成「可调用」—— 这一页不是恒定的红色', () => {
    const wrapper = mountView({
      session: SESSION,
      status: reading(status({ gates: ALL_PASS, capability_flags: FLAGS_ON })),
      connections: reading<readonly ConnectionRow[]>([
        { connection_id: 'c1', alias: '本地适配器', principal_kind: 'model_surface', enabled: true, generation: 1 },
      ]),
      tunnel: reading({ readyz: true, tunnel_id_configured: true }),
    });
    assert.equal(wrapper.find('[data-testid="banner"]').attributes('data-callable'), 'true');
  });

  it('A6 没有会话时「重新验证」不可用，并说得出为什么', () => {
    const wrapper = mountView({});
    const button = wrapper.find('[data-testid="reverify-button"]');
    assert.notEqual(button.attributes('disabled'), undefined);
    assert.match(wrapper.find('[data-testid="reverify-blocked"]').text(), /401/);
  });

  it('A7 点「重新验证」只发出一个事件，不带任何载荷', async () => {
    const wrapper = mountView({ session: SESSION, status: reading(status()) });
    await wrapper.find('[data-testid="reverify-button"]').trigger('click');
    assert.equal(wrapper.emitted('reverify')?.length, 1);
    assert.deepEqual(wrapper.emitted('reverify')?.[0], []);
  });
});

// ---------------------------------------------------------------------------
// B 组 · 直写门禁（验收标准 2）
// ---------------------------------------------------------------------------

describe('B 组 · 直写门禁在界面上逐格可读（验收标准 2）', () => {
  it('B1 四个门禁格逐格列值，今天全是「未通过」', () => {
    const wrapper = mountView({ session: SESSION, status: reading(status()) });
    const rows = wrapper.findAll('[data-testid="gate-row"]');

    assert.deepEqual(rows.map((row) => row.attributes('data-gate')), [
      'g0_platform_verified',
      'compatibility_section3_passed',
      'native_guard_verified',
      'g4_concurrency_fault_passed',
    ]);
    assert.deepEqual(rows.map((row) => row.text()), ['未通过', '未通过', '未通过', '未通过']);
  });

  it('B2 无读数渲染成「无读数」，不是「未通过」', () => {
    // 判决点：一个 `?? false` 的实现会在这里给出四个「未通过」，
    // 而那等于把「去查服务」说成了「去看证据」。
    const wrapper = mountView({ session: SESSION, status: null });
    const rows = wrapper.findAll('[data-testid="gate-row"]');
    assert.deepEqual(rows.map((row) => row.text()), ['无读数', '无读数', '无读数', '无读数']);
    assert.deepEqual(rows.map((row) => row.attributes('data-state')), [
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
  });

  it('B3 直写关着，理由逐条列出来（今天四条）', () => {
    const wrapper = mountView({ session: SESSION, status: reading(status()) });

    assert.equal(wrapper.find('[data-testid="write-gate-summary"]').attributes('data-direct-write'), 'false');
    assert.match(wrapper.find('[data-testid="write-gate-summary"]').text(), /直写：关闭/);
    const reasons = wrapper.findAll('[data-testid="write-gate-reason"]');
    assert.equal(reasons.length, 4);
    assert.match(reasons.map((row) => row.text()).join('\n'), /G0（真实网页接入验证）未通过/);
    assert.match(reasons.map((row) => row.text()).join('\n'), /G4（竞争与故障专项测试）未通过/);
  });

  it('B3a 明确区分阶段验收门禁与目录授权/运行时开关', () => {
    const wrapper = mountView({ session: SESSION, status: reading(status()) });
    const guide = wrapper.find('[data-testid="gate-guide"]');
    const text = guide.text();

    assert.equal(guide.exists(), true);
    assert.match(text, /G0.*真实 ChatGPT 网页/);
    assert.match(text, /G2.*真实网页读取/);
    assert.match(text, /G3.*本机批准前工作区字节不变/);
    assert.match(wrapper.find('[data-testid="gate-guide-runtime-note"]').text(), /不会登记目录、授予工作区权限/);
  });

  it('B4 四格与开关全绿时界面说「已打开」—— 这句不是写死的', () => {
    const wrapper = mountView({
      session: SESSION,
      status: reading(status({ gates: ALL_PASS, capability_flags: FLAGS_ON })),
    });
    assert.equal(wrapper.find('[data-testid="write-gate-summary"]').attributes('data-direct-write'), 'true');
    assert.equal(wrapper.find('[data-testid="write-gate-reasons"]').exists(), false);
  });

  it('B5 能力开关逐格列值，且「无读数」与「关闭」分得开', () => {
    const on = mountView({ session: SESSION, status: reading(status({ gates: ALL_PASS, capability_flags: FLAGS_ON })) });
    assert.deepEqual(on.findAll('[data-testid="flag-row"]').map((row) => row.text()), [
      '打开',
      '打开',
      '打开',
      '打开',
      '关闭',
    ]);
    assert.equal(on.findAll('[data-testid="flag-row"]')[3]?.attributes('data-flag'), 'direct_write_enabled');

    const none = mountView({ session: SESSION, status: null });
    assert.equal(none.findAll('[data-testid="flag-row"]').every((row) => row.text() === '无读数'), true);
  });

  it('B6 服务端声明的限制照实显示，没有时也不留白', () => {
    const withLimit = mountView({ session: SESSION, status: reading(status()) });
    assert.match(withLimit.find('[data-testid="limitations"]').text(), /V1 仅支持本机 NTFS/);

    const withoutLimit = mountView({
      session: SESSION,
      status: reading(status({ limitations: [] })),
    });
    assert.match(withoutLimit.find('[data-testid="limitations"]').text(), /没有给出/);
  });
});

// ---------------------------------------------------------------------------
// C 组 · 紧急停用
// ---------------------------------------------------------------------------

describe('C 组 · 紧急停用', () => {
  it('C1 没有会话时两个按钮都不在，且说得出下一步', () => {
    const wrapper = mountView({});
    assert.equal(wrapper.find('[data-testid="pause-button"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="resume-button"]').exists(), false);
    assert.equal(wrapper.find('[data-testid="pause-relogin"]').exists(), true);
    // 没有会话就没有读数 → 事实那一段必须写「没有读数」，不是留白。
    assert.deepEqual(wrapper.findAll('[data-testid="pause-fact"]').map((li) => li.text()), ['没有读数。']);
  });

  it('C2 有会话、没有读数时给暂停、不给恢复', () => {
    const wrapper = mountView({ session: SESSION });
    assert.equal(wrapper.find('[data-testid="pause-button"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="resume-button"]').exists(), false);
    assert.match(wrapper.find('[data-testid="resume-blocked"]').text(), /NO_READING/);
    assert.match(wrapper.find('[data-testid="pause-headline"]').text(), /不提供恢复/);
  });

  it('C3 读数说停着且新鲜时才出现「解除暂停」', () => {
    const wrapper = mountView({
      session: SESSION,
      pause: reading(pauseReading({ paused: true, paused_at: NOW })),
    });
    assert.equal(wrapper.find('[data-testid="resume-button"]').exists(), true);
    assert.match(wrapper.findAll('[data-testid="pause-fact"]')[0]?.text() ?? '', /处于暂停状态/);
  });

  it('C4 没读数时 `paused` 那一格是 unknown，不是 false', () => {
    // 判决点：`v-if="paused"` 与 `v-if="!paused"` 在 null 上都会落到
    // 「没暂停」那一支，也就是把「没有读数」显示成「服务正常」。
    const none = mountView({ session: SESSION });
    assert.equal(none.find('[data-testid="pause-headline"]').attributes('data-paused'), 'unknown');

    const notPaused = mountView({ session: SESSION, pause: reading(pauseReading({ paused: false })) });
    assert.equal(notPaused.find('[data-testid="pause-headline"]').attributes('data-paused'), 'false');
  });

  it('C5 五件事都逐条出现在屏幕上，一件都不合并', () => {
    const wrapper = mountView({
      session: SESSION,
      pause: reading(
        pauseReading({
          paused: true,
          stopping: [
            {
              operation_id: 'op_0001',
              change_id: 'chg_0001',
              workspace_id: 'ws_0001',
              state: 'APPLYING',
              holder_pid: 4242,
              slot_blocked: true,
            },
          ],
          unrevoked_change_sets: [{ change_id: 'chg_0002', workspace_id: 'ws_0001', state: 'APPROVED', expires_at: null }],
          recovery_operations: [{ operation_id: 'op_0009', change_id: 'chg_0009', workspace_id: 'ws_0001' }],
          unrecallable_file_rows: 7,
        }),
      ),
    });
    const facts = wrapper.findAll('[data-testid="pause-fact"]').map((li) => li.text()).join('\n');
    assert.match(facts, /有 1 个写入正在停/);
    assert.match(facts, /chg_0002/);
    assert.match(facts, /op_0009/);
    assert.match(facts, /收不回来/);
    assert.equal(wrapper.findAll('[data-testid="pause-fact"]').length, 5);
  });

  it('C6 点「紧急停用」发出 pause；忙碌时不发出', async () => {
    const wrapper = mountView({ session: SESSION, pause: reading(pauseReading()) });
    await wrapper.find('[data-testid="pause-button"]').trigger('click');
    assert.equal(wrapper.emitted('pause')?.length, 1);

    const busy = mountView({ session: SESSION, pause: reading(pauseReading()), busy: true });
    await busy.find('[data-testid="pause-button"]').trigger('click');
    assert.equal(busy.emitted('pause'), undefined, '忙的时候点击不得发出事件');
  });

  it('C7 上一次按键的结果用通栏告警显示，且失败那一句排在最前', () => {
    // 这份读数说「已经停着了」—— 看上去一切正常。而按键的结果说队列
    // 没有被废止。两句话必须同时在屏幕上：这正是把它们分成两个类型的
    // 原因（`readings.ts` 里 `PauseOutcomeReading` 的说明）。
    const wrapper = mountView({
      session: SESSION,
      pause: reading(pauseReading({ paused: true, paused_at: NOW })),
      pauseOutcome: {
        already: false,
        revoked: [{ change_id: 'chg_1', approval_id: 'apr_1' }],
        skipped: [],
        revoke_failed: true,
        revoke_message: '库锁住了',
        persist_failed: false,
        persist_message: null,
        status: pauseReading({ paused: true }),
      },
    });

    const outcome = wrapper.find('[data-testid="pause-outcome"]');
    assert.equal(outcome.attributes('data-severity'), 'critical');
    assert.equal(outcome.attributes('role'), 'alert');
    assert.match(outcome.findAll('[data-testid="outcome-line"]')[0]?.text() ?? '', /废止排队中的授权失败/);
    // 它必须与那份读数**分开**：刷新不会把这句话盖掉。
    assert.match(wrapper.findAll('[data-testid="pause-fact"]')[0]?.text() ?? '', /处于暂停状态/);
  });
});

// ---------------------------------------------------------------------------
// D 组 · 脱敏诊断
// ---------------------------------------------------------------------------

describe('D 组 · 脱敏诊断', () => {
  it('D1 文本里没有本机路径，且台账说出了哪一处被隐去', () => {
    const wrapper = mountView({
      session: SESSION,
      status: reading(status()),
      workspaces: [
        {
          workspace_id: 'ws_0001',
          alias: 'D:\\MyProjects\\MyApps\\LocalWebGPT',
          kind: 'directory',
          mode: 'read_only',
          root: 'D:\\MyProjects\\MyApps\\LocalWebGPT',
          generation: 1,
          policy_version: 1,
          enabled: true,
          removed: false,
        },
      ],
    });

    const text = wrapper.find('[data-testid="diagnostic-text"]').text();
    assert.equal(text.includes('D:\\MyProjects'), false, '可复制的文本里不得出现本机路径');
    assert.match(text, /<已隐去>/);
    assert.match(wrapper.find('[data-testid="diagnostic-redactions"]').text(), /workspaces\[0\]\.alias/);
    // 本机路径那一项被**显式**标记为「这份诊断不带」，而不是静默丢掉。
    assert.match(text, /local_path: （本机路径：这份诊断不带）/);
  });

  it('D2 干净的一份诊断：不提供任何隐去，且复制按钮在', () => {
    const wrapper = mountView({ session: SESSION, status: reading(status()) });
    assert.match(wrapper.find('[data-testid="diagnostic-redactions"]').text(), /已隐去的字段（0）/);
    const copy = wrapper.find('[data-testid="copy-diagnostic"]');
    assert.equal(copy.exists(), true);
    assert.equal(wrapper.find('[data-testid="diagnostic-unsafe"]').exists(), false);
  });

  it('D3 点复制发出的载荷只有 `text` 一个字段', async () => {
    const wrapper = mountView({ session: SESSION, status: reading(status()) });
    await wrapper.find('[data-testid="copy-diagnostic"]').trigger('click');

    const emitted = wrapper.emitted('copy-diagnostic');
    assert.equal(emitted?.length, 1);
    const payload = emitted?.[0]?.[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload), ['text']);
    assert.match(String(payload['text']), /Local Workspace Bridge 诊断/);
    // 这份文本里不该有任何凭据形状的东西。
    assert.equal(/csrf|bearer|authorization|lwb_boot_/i.test(String(payload['text'])), false);
  });

  it('D4 终检未通过时不提供复制 —— 这一支今天是**探针**', () => {
    // `diagnostic.safe` 为假时模板走另一支（只展示、不复制）。而今天
    // 第 2 层的擦洗覆盖了第 3 层的全部模式，因此**构造不出**一份
    // 未通过终检的输入：这一支是留给「将来有人加了一个新字段却忘了
    // 过第 2 层」的探针。这里断言的是它旁边那句话确实存在（模板写对了），
    // 而不是假装跑过它 —— 未执行项必须标明。
    const wrapper = mountView({ session: SESSION, status: reading(status()) });
    assert.equal(wrapper.find('[data-testid="copy-diagnostic"]').exists(), true);
    assert.equal(wrapper.find('[data-testid="diagnostic-unsafe"]').exists(), false);
    assert.match(wrapper.find('[data-testid="diagnostic-note"]').text(), /已隐去/);
  });
});

// ---------------------------------------------------------------------------
// E 组 · 本地启动帮助
// ---------------------------------------------------------------------------

describe('E 组 · 本地启动帮助', () => {
  it('E1 没有会话时给出：启动服务、打开控制台、以及那个 404 的说明', () => {
    const wrapper = mountView({});
    const entries = wrapper.findAll('[data-testid="help-entry"]');

    assert.deepEqual(entries.map((entry) => entry.attributes('data-help')), [
      'start_daemon',
      'open_console',
      'console_page_missing',
    ]);
    const all = wrapper.text();
    assert.match(all, /npm run daemon/);
    assert.match(all, /一次性启动令牌/);
    assert.match(all, /404/);
  });

  it('E2 一切正常时帮助区根本不渲染', () => {
    const wrapper = mountView({
      session: SESSION,
      status: reading(status({ gates: ALL_PASS, capability_flags: FLAGS_ON })),
      connections: reading<readonly ConnectionRow[]>([
        { connection_id: 'c1', alias: '本地适配器', principal_kind: 'model_surface', enabled: true, generation: 1 },
      ]),
      tunnel: reading({ readyz: true, tunnel_id_configured: true }),
    });
    assert.equal(wrapper.find('[data-testid="help-entry"]').exists(), false);
    // 但「全部帮助」永远在（默认收起），否则操作者找不到某一条。
    assert.equal(wrapper.find('[data-testid="all-help"]').exists(), true);
  });

  it('E3 「全部帮助」列出全部七条', () => {
    const wrapper = mountView({ session: SESSION });
    assert.equal(wrapper.findAll('[data-testid="all-help-entry"]').length, 7);
    assert.match(wrapper.find('[data-testid="all-help"] summary').text(), /全部帮助（7 条）/);
  });

  it('E4 帮助里那条「不要贴出去」的警告真的在屏幕上', () => {
    const wrapper = mountView({});
    const warnings = wrapper.findAll('[data-testid="help-warning"]').map((p) => p.text()).join('\n');
    assert.match(warnings, /等同于密码/);
    assert.match(warnings, /不要\*\*贴到聊天/);
  });

  it('E5 会话过期给的下一步与从未登录不同', () => {
    const wrapper = mountView({ sessionExpired: true });
    assert.deepEqual(
      wrapper.findAll('[data-testid="help-entry"]').map((entry) => entry.attributes('data-help')),
      ['session_expired', 'start_daemon'],
    );
  });
});
