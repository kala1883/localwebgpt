/**
 * LWB-035 单元测试：首次配置页与工作区页的视图模型。
 *
 * ## 三条验收标准，这里各测到哪一半
 *
 * | 验收标准 | 本文件 | `apps/console/tests/*-view.spec.ts` |
 * | --- | --- | --- |
 * | 1 非技术用户知道**哪台机器、哪些目录在暴露** | 暴露摘要的两句话与机器行的措辞 | 渲染出来的那一半（两句话都在屏幕上） |
 * | 2 无法越过 G0/G4 直接授权直写 | **判定的那一半**（四个门禁与控制台自己再与一遍） | 渲染出来的那一半（逐格列值，且「无读数」与「未通过」不同） |
 * | 3 停机/睡眠/断网不显示成正常在线 | **判定的那一半**（新鲜度、四条腿、断网否决） | 渲染出来的那一半（读数时刻那一行真的在） |
 *
 * 与 `console-changes.test.ts` 同一条理由：这一层不依赖 DOM（根 tsconfig
 * 里没有 DOM lib），因此能在 node 里跑的断言就不该只在浏览器里跑一遍。
 *
 * ## 本文件里三处刻意避开「同义反复」的地方
 *
 *  - **B 组**不满足于「今天 `callable` 为假」。一份永远算不出 `true` 的判据
 *    与一个写死的 `false` 无法区分，因此 B1 会喂一份**四格全绿**的读数，
 *    断言它算出 `true` —— 然后再逐条撤掉一格，看它变回 `false`。
 *  - **C 组**不满足于「四个门禁关着所以直写关着」。C5 把四格与开关全部
 *    置真，断言门禁**会**打开：判据落在事实上，而不是落在常量上。
 *  - **E 组**不满足于「诊断文本里没有路径」——那多半是因为夹具里没写路径。
 *    E1 刻意把绝对路径放进**别名**（别名是操作者自己起的名字，是路径最
 *    现实的藏身处），断言它被擦洗掉、且被记进了台账。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CapabilityFlags } from '@lwb/contracts';

import {
  applicableHelp,
  describeWorkspace,
  exposureSummary,
  freshnessOf,
  localStartHelp,
  machineLine,
  modeOffers,
  parsePauseOutcome,
  parsePauseStatus,
  parseStatusReading,
  parseWorkspaces,
  pauseOutcomeReport,
  pauseView,
  platformVerdict,
  redactedDiagnostic,
  registerRequest,
  scanForLeaks,
  scrub,
  toDiagnosticWorkspaces,
  validateRegister,
  writeGate,
  type ConnectionRow,
  type Gates,
  type PauseStatusReading,
  type Reading,
  type StatusReading,
  type TunnelReading,
  type WorkspaceRow,
} from '../../apps/console/src/setup/index.ts';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const NOW = '2026-09-26T12:00:00.000Z';
/** 10 秒前 —— 阈值（30 秒）之内。 */
const FRESH_AT = '2026-09-26T11:59:50.000Z';
/** 一小时前。 */
const STALE_AT = '2026-09-26T11:00:00.000Z';
/** 未来 30 秒 —— 休眠唤醒后对时的典型形状。 */
const FUTURE_AT = '2026-09-26T12:00:30.000Z';

const ALL_PASS: Gates = {
  g0_platform_verified: true,
  native_guard_verified: true,
  compatibility_section3_passed: true,
  g4_concurrency_fault_passed: true,
};

/** 今天生产环境那一组：四格全关。 */
const ALL_FAIL: Gates = {
  g0_platform_verified: false,
  native_guard_verified: false,
  compatibility_section3_passed: false,
  g4_concurrency_fault_passed: false,
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
    limitations: [],
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

function connection(over: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    connection_id: 'conn_model',
    alias: '本地适配器',
    principal_kind: 'model_surface',
    enabled: true,
    generation: 1,
    ...over,
  };
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

function workspace(over: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    workspace_id: 'ws_0001',
    alias: '我的项目',
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

function diagInput(over: Record<string, unknown> = {}) {
  return {
    now: NOW,
    status: reading(status()),
    connections: [] as readonly ConnectionRow[],
    workspaces: [workspace()] as readonly WorkspaceRow[],
    pause: null,
    platform: platformVerdict({ status: reading(status()), connections: null, now: NOW }),
    write_gate: writeGate({ gates: ALL_FAIL, flags: FLAGS_OFF }),
    last_error: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A 组 · 读数与新鲜度（验收标准 3 的判定半边）
// ---------------------------------------------------------------------------

describe('A 组 · 读数与新鲜度', () => {
  it('A1 四种输入里只有「阈值之内」算 fresh', () => {
    assert.equal(freshnessOf(null, NOW), 'absent', '还没有问过');
    assert.equal(freshnessOf(reading('x', STALE_AT), NOW), 'stale', '一小时前');
    assert.equal(freshnessOf(reading('x', FRESH_AT), NOW), 'fresh', '十秒前');
    // 未来：休眠唤醒后系统对时可能把时钟往回调，于是「刚取到的」落在未来。
    // 此刻**不能**说它新 —— 无法区分它与一次伪造。
    assert.equal(freshnessOf(reading('x', FUTURE_AT), NOW), 'stale');
    assert.equal(freshnessOf(reading('x', '不是时间'), NOW), 'stale', '解析不出就无法证明它新');
  });

  it('A2 缺失的字段解析成 null，不是 false', () => {
    // 这一条是本层最要紧的约定：把「没读到」读成「未通过」，会让界面
    // 把「去查服务」说成「去看证据」，而两件事的下一步完全不同。
    const parsed = parseStatusReading({});
    assert.equal(parsed.gates, null, '四格缺一即整份作废');
    assert.equal(parsed.capability_flags, null);
    assert.equal(parsed.machine, null);
    assert.equal(parsed.version, null);
    // 但**读到**一份全 false 的门禁时，它是一份完整的读数。
    const real = parseStatusReading({ gates: ALL_FAIL });
    assert.deepEqual(real.gates, ALL_FAIL, '全 false 是读到的结论，不是缺读数');
  });

  it('A3 门禁四格缺任何一格，整份门禁作废', () => {
    const partial = parseStatusReading({
      gates: { g0_platform_verified: true, native_guard_verified: true, compatibility_section3_passed: true },
    });
    assert.equal(partial.gates, null, '缺 G4 时不能说「G4 未通过」——那是没读到');
  });

  it('A4 不认识的工作区模式被丢掉，而不是兜底成只读', () => {
    const rows = parseWorkspaces([
      { workspace_id: 'ws_a', root: 'D:\\a', alias: 'a', kind: 'directory', mode: 'read_only' },
      { workspace_id: 'ws_b', root: 'D:\\b', alias: 'b', kind: 'directory', mode: '未来某个模式' },
      { workspace_id: 'ws_c', root: 'D:\\c', alias: 'c', kind: '未来某个类型', mode: 'read_only' },
    ]);
    // 兜底成只读看着安全，其实是错的：操作者会以为这个目录只读，
    // 而实际发生的是「界面没看懂那一行」。少一行会被看见。
    assert.deepEqual(rows.map((row) => row.workspace_id), ['ws_a']);
  });

  it('A5 暂停读数缺 paused 时整份作废，缺 unrecallable 时读成 0', () => {
    assert.equal(parsePauseStatus({}), null, '缺 paused 就没有可说的');
    const parsed = parsePauseStatus({ paused: true });
    assert.equal(parsed?.unrecallable_file_rows, 0);
    assert.equal(parsePauseStatus('不是对象'), null);
  });
});

// ---------------------------------------------------------------------------
// B 组 · 平台可调用性（执行步骤 2）
// ---------------------------------------------------------------------------

describe('B 组 · 平台可调用性', () => {
  const green: TunnelReading = { readyz: true, tunnel_id_configured: true };

  function verdict(over: Record<string, unknown> = {}) {
    return platformVerdict({
      status: reading(status({ gates: ALL_PASS, capability_flags: FLAGS_ON })),
      connections: reading<readonly ConnectionRow[]>([connection()]),
      tunnel: reading(green),
      now: NOW,
      ...over,
    });
  }

  it('B1 四格全绿时算得出 true —— 判据不是写死的 false', () => {
    // 这一条是整组的支点：一个恒为 false 的判据与一个写死的 false
    // 在界面上长得一样，只有把「全绿」喂进去才分得开。
    assert.equal(verdict().callable, true);
  });

  it('B2 撤掉任何一格就变回 false，且理由指名道姓', () => {
    const noTunnel = verdict({ tunnel: null });
    assert.equal(noTunnel.callable, false);
    assert.ok(noTunnel.reasons.some((line) => line.includes('隧道状态没有本机读数')));

    const noConn = verdict({ connections: reading<readonly ConnectionRow[]>([]) });
    assert.equal(noConn.callable, false);
    assert.ok(noConn.reasons.some((line) => line.includes('已启用')));

    const noG0 = verdict({ status: reading(status({ gates: ALL_FAIL, capability_flags: FLAGS_ON })) });
    assert.equal(noG0.callable, false);
    assert.ok(noG0.reasons.some((line) => line.includes('G0 完整验收未通过')));
    assert.ok(noG0.reasons.some((line) => line.includes('workspace_list') && line.includes('真实文件读取')));
  });

  it('B3 断网由网络本身否决，无论本机读数怎么说', () => {
    const offline = verdict({ browser_online: false });
    assert.equal(offline.callable, false, '四格全绿也救不回来');
    assert.equal(offline.reasons[0]?.includes('网络已断开'), true, '这一条排在最前');
  });

  it('B4 读数过期不算在线，而且那一格说的是「不知道」', () => {
    const stale = platformVerdict({
      status: reading(status(), STALE_AT),
      connections: reading<readonly ConnectionRow[]>([connection()], STALE_AT),
      tunnel: reading(green, STALE_AT),
      now: NOW,
    });
    assert.equal(stale.callable, false);
    assert.equal(stale.daemon_freshness, 'stale');

    const daemon = stale.legs.find((leg) => leg.id === 'daemon');
    assert.equal(daemon?.state, 'unknown', '既不是绿也不是红');
    assert.equal(daemon?.state_label, '读数已过期');
    // 过期读数的那一句必须**明确否认**「在线」——「不等于在线」这五个字
    // 就是这条否认。只断言「不含在线」会把这句正确的否认也判成失败。
    assert.match(daemon?.headline ?? '', /不等于在线/);
    assert.match(daemon?.detail ?? '', /请先「重新检测」/);
  });

  it('B5 四条腿各有各的状态，没有任何一格靠另一格撑腰', () => {
    const v = verdict();
    assert.deepEqual(v.legs.map((leg) => leg.id), ['daemon', 'mcp_adapter', 'tunnel_client', 'account']);
    assert.equal(v.legs.every((leg) => leg.detail.length > 0), true, '每一格都必须说清「不能证明什么」');
    // 只有 ok 那一档允许出现「在线 / 正常」
    for (const leg of v.legs) {
      if (leg.state !== 'ok') {
        assert.equal(leg.state_label.includes('在线'), false, `${leg.id} 的措辞不能暗示在线`);
        assert.equal(leg.state_label.includes('正常'), false, `${leg.id} 的措辞不能暗示正常`);
      }
    }
  });

  it('B6 今天生产环境的样子：隧道无读数、账号验收未通过', () => {
    const today = platformVerdict({
      status: reading(status()),
      connections: reading<readonly ConnectionRow[]>([connection()]),
      now: NOW,
    });
    assert.equal(today.callable, false);
    assert.equal(today.legs.find((leg) => leg.id === 'tunnel_client')?.state, 'unknown');
    assert.equal(today.legs.find((leg) => leg.id === 'account')?.state, 'off');
  });

  it('B7 机器读不到时说「未知」，不说「本机」', () => {
    assert.match(machineLine(null), /未知/);
    assert.equal(machineLine(null).includes('当前机器：本机'), false, '「本机」听起来像一个结论');
    assert.match(machineLine({ hostname: 'PC-1', os: 'win32', arch: 'x64' }), /PC-1/);
  });
});

// ---------------------------------------------------------------------------
// C 组 · 直写门禁（验收标准 2）
// ---------------------------------------------------------------------------

describe('C 组 · 文件修改能力状态（验收状态只作诊断）', () => {
  it('C1 外部验收格不再阻断目录写能力', () => {
    for (const key of Object.keys(ALL_PASS) as readonly (keyof Gates)[]) {
      const gates = { ...ALL_PASS, [key]: false };
      const gate = writeGate({ gates, flags: FLAGS_ON });
      assert.equal(gate.direct_write, true, `${key} 是验收状态，不应成为全局写入开关`);
      assert.deepEqual(gate.reasons, []);
    }
  });

  it('C2 服务能力不可用时如实显示不可用', () => {
    const gate = writeGate({ gates: ALL_PASS, flags: FLAGS_OFF });
    assert.equal(gate.direct_write, false);
    assert.ok(gate.reasons.some((line) => line.includes('目录写入功能当前不可用')));
  });

  it('C3 服务状态缺失显示未知；平台验收格缺失不影响权限状态', () => {
    const gate = writeGate({ gates: null, flags: FLAGS_ON });
    assert.equal(gate.direct_write, true);
    assert.deepEqual(gate.reasons, []);

    const other = writeGate({ gates: ALL_PASS, flags: null });
    assert.equal(other.direct_write, false);
    assert.equal(other.reasons[0], '本机服务能力状态暂时不可用。');
  });

  it('C4 未启用服务能力时只给一个直接原因', () => {
    const gate = writeGate({ gates: ALL_FAIL, flags: FLAGS_OFF });
    assert.equal(gate.direct_write, false);
    assert.equal(gate.reasons.length, 1);
    assert.match(gate.summary, /目录写入功能不可用/);
  });

  it('C5 服务端支持写入时，目录授权功能可用', () => {
    const gate = writeGate({ gates: ALL_PASS, flags: FLAGS_ON });
    assert.equal(gate.direct_write, true);
    assert.deepEqual(gate.reasons, []);
  });

  it('C6 风险说明明确逐目录授权后直接写入，无逐次批准', () => {
    const proposeRisk = (gl: ReturnType<typeof writeGate>, proposalEnabled: boolean): string =>
      modeOffers(gl, proposalEnabled).find((offer) => offer.mode === 'read_propose_apply_with_local_approval')?.risk ?? '';
    const closed = proposeRisk(writeGate({ gates: ALL_FAIL, flags: FLAGS_OFF }), false);
    const open = proposeRisk(writeGate({ gates: ALL_PASS, flags: FLAGS_ON }), true);

    assert.match(closed, /本机服务的目录写入功能当前不可用/);
    assert.match(open, /直接创建\/删除普通文件并应用修改集/);
    assert.match(open, /编辑已有文件还需同时授予“读取文件内容”/);
    assert.match(open, /不会逐次等待本机批准/);
    // 风险说明直接说清本地目录 grant 是权限来源。
    assert.notEqual(closed, open);
  });
});

// ---------------------------------------------------------------------------
// D 组 · 一键暂停（执行步骤 3）
// ---------------------------------------------------------------------------

describe('D 组 · 暂停与恢复', () => {
  const session = { session_id: 'sess_1' };

  it('D1 暂停与恢复**不对称**：没有读数时给暂停、不给恢复', () => {
    const view = pauseView({ session, reading: null, now: NOW });
    // 读数不新鲜恰恰是想按暂停的常见原因（睡眠唤醒、断网、界面卡住）。
    // 把暂停也压在一份新鲜读数之下，等于在最需要它的场景里把按钮收起来。
    assert.equal(view.can_pause, true);
    assert.equal(view.can_resume, false);
    assert.equal(view.resume_blocked_reason, 'NO_READING');
    assert.match(view.headline, /不提供恢复/);
    assert.deepEqual(view.facts, ['没有读数。'], '读数是 null 时给一句话，不是一个空数组');
  });

  it('D2 读数说没停时不给恢复，理由是 NOT_PAUSED', () => {
    const view = pauseView({ session, reading: reading(pauseReading({ paused: false })), now: NOW });
    assert.equal(view.can_resume, false);
    assert.equal(view.resume_blocked_reason, 'NOT_PAUSED');
  });

  it('D3 读数过期时不给恢复，并要人先重新验证', () => {
    const view = pauseView({
      session,
      reading: reading(pauseReading({ paused: true }), STALE_AT),
      now: NOW,
    });
    assert.equal(view.can_resume, false);
    assert.equal(view.resume_blocked_reason, 'STALE_READING');
    assert.match(view.headline, /先重新验证/);
    // 一份新鲜且说停着的读数才给恢复。
    const fresh = pauseView({ session, reading: reading(pauseReading({ paused: true })), now: NOW });
    assert.equal(fresh.can_resume, true);
    assert.equal(fresh.paused, true);
  });

  it('D4 没有会话时两个动作都不可用，且下一步是重新拿地址', () => {
    const view = pauseView({ session: null, reading: reading(pauseReading()), now: NOW });
    assert.equal(view.can_pause, false);
    assert.equal(view.pause_blocked_reason, 'NO_SESSION');
    assert.equal(view.offer_relogin, true);
    const expired = pauseView({ session: null, session_expired: true, reading: null, now: NOW });
    assert.equal(expired.pause_blocked_reason, 'SESSION_EXPIRED');
  });

  it('D5 暂停要说的**五件事**一件不少', () => {
    const view = pauseView({
      session,
      reading: reading(
        pauseReading({
          paused: true,
          paused_at: '2026-09-26T11:30:00.000Z',
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
          unrevoked_change_sets: [
            { change_id: 'chg_0002', workspace_id: 'ws_0001', state: 'APPROVED', expires_at: null },
          ],
          recovery_operations: [
            { operation_id: 'op_0009', change_id: 'chg_0009', workspace_id: 'ws_0001' },
          ],
          unrecallable_file_rows: 7,
        }),
      ),
      now: NOW,
    });

    const text = view.facts.join('\n');
    assert.match(text, /有 1 个写入正在停/, '事实 1：还在停的写入');
    assert.match(text, /op_0001/);
    assert.match(text, /pid 4242/);
    assert.match(text, /写盘位已被占住/);
    assert.match(text, /chg_0002/, '事实 2：排队中的授权');
    assert.match(text, /op_0009/, '事实 3：待恢复');
    assert.match(text, /收不回来.*7 条/, '事实 4：已经出去的内容');
    assert.match(text, /暂停只阻断新的读取与新应用/, '事实 5 的语义边界');
    assert.equal(view.facts.length, 5, '五条各占一行，一条都不合并');
  });

  it('D6 干净读数也照样把「没有」逐条说出来', () => {
    const view = pauseView({ session, reading: reading(pauseReading()), now: NOW });
    const text = view.facts.join('\n');
    assert.match(text, /没有正在进行的写入/);
    assert.match(text, /没有排队中的授权/);
    assert.match(text, /没有等待人工核验的恢复现场/);
    assert.match(text, /没有已经交出去的文件内容记录/);
  });

  it('D7 `paused` 在没读数时是 null，不是 false', () => {
    // 模板里 `v-if="!paused"` 会把 null 与 false 显示成同一句话，
    // 也就是把「没有读数」显示成「服务正常」——这正是本层要防的事。
    assert.equal(pauseView({ session, reading: null, now: NOW }).paused, null);
    assert.equal(pauseView({ session, reading: reading(pauseReading({ paused: false })), now: NOW }).paused, false);
  });

  it('D8 不新鲜的读数会先说清「下面说的是那一刻」', () => {
    const view = pauseView({ session, reading: reading(pauseReading(), STALE_AT), now: NOW });
    assert.match(view.facts[0] ?? '', /读数时刻/);
    assert.match(view.facts[0] ?? '', /读数已过期/);
  });

  it('D9 按键结果：废止失败与落库失败都是 critical，且排在最前', () => {
    const report = pauseOutcomeReport({
      already: false,
      revoked: [],
      skipped: [],
      revoke_failed: true,
      revoke_message: '库锁住了',
      persist_failed: false,
      persist_message: null,
      status: pauseReading(),
    });
    assert.equal(report.severity, 'critical');
    assert.match(report.lines[0] ?? '', /废止排队中的授权失败/);
    assert.match(report.lines[0] ?? '', /库锁住了/);

    const persisted = pauseOutcomeReport({
      already: false,
      revoked: [],
      skipped: [],
      revoke_failed: false,
      revoke_message: null,
      persist_failed: true,
      persist_message: null,
      status: null,
    });
    assert.equal(persisted.severity, 'critical');
    assert.match(persisted.headline, /没有完全做成/);
    assert.match(persisted.lines.join('\n'), /重启之后服务可能不记得自己停过/);
  });

  it('D10 「本来就在暂停中」是一次成功的按键，不是告警', () => {
    const report = pauseOutcomeReport({
      already: true,
      revoked: [],
      skipped: [],
      revoke_failed: false,
      revoke_message: null,
      persist_failed: false,
      persist_message: null,
      status: pauseReading({ paused: true }),
    });
    assert.equal(report.severity, 'ok');
    assert.match(report.headline, /本来就在暂停中/);
  });

  it('D11 「跳过」与「废止失败」分开报，且不会被读成「队列空了」', () => {
    const report = pauseOutcomeReport({
      already: false,
      revoked: [{ change_id: 'chg_1', approval_id: 'apr_1' }],
      skipped: [{ change_id: 'chg_2', reason: 'ALREADY_TERMINAL' }],
      revoke_failed: false,
      revoke_message: null,
      persist_failed: false,
      persist_message: null,
      status: pauseReading({ paused: true }),
    });
    assert.equal(report.severity, 'ok');
    const text = report.lines.join('\n');
    assert.match(text, /已废止 1 份/);
    assert.match(text, /本地批准一并作废/);
    assert.match(text, /另有 1 份没有废止（合计 2 份排队）/);
  });

  it('D12 服务没回状态时升级为 attention，并要人重新验证', () => {
    const report = pauseOutcomeReport({
      already: false,
      revoked: [],
      skipped: [],
      revoke_failed: false,
      revoke_message: null,
      persist_failed: false,
      persist_message: null,
      status: null,
    });
    assert.equal(report.severity, 'attention');
    assert.match(report.lines.join('\n'), /请重新验证/);
  });
});

// ---------------------------------------------------------------------------
// E 组 · 脱敏诊断（执行步骤 3）
// ---------------------------------------------------------------------------

describe('E 组 · 脱敏诊断', () => {
  it('E1 藏在别名里的绝对路径会被擦洗，并记进台账', () => {
    // 别名是操作者自己起的名字，因此是路径最现实的藏身处：它不会
    // 来自 `root` 字段，任何「记得别带 root」的做法都挡不住它。
    const result = redactedDiagnostic(
      diagInput({
        workspaces: [workspace({ alias: 'D:\\MyProjects\\MyApps\\LocalWebGPT 这个' })],
      }),
    );
    assert.equal(result.text.includes('D:\\MyProjects'), false, '路径不得出现在可复制的文本里');
    assert.match(result.text, /<已隐去>/);
    assert.ok(result.redactions.some((name) => name.startsWith('workspaces[0].alias')));
    assert.equal(result.safe, true, '擦洗过了，终检就该通过');
  });

  it('E2 终检不通过时 safe 为假，而且结果里只有模式名、没有命中的内容', () => {
    const text = '这一行里有 lwb_boot_ABCDEF 这样的东西';
    const findings = scanForLeaks(text);
    assert.deepEqual(findings, ['bootstrap_token']);

    const report = redactedDiagnostic(diagInput({ last_error: { code: 'X', message: 'lwb_boot_令牌漏进来了' } }));
    // 走到这里时它已经被第 2 层擦掉了，因此终检仍然通过 —— 两层各司其职。
    assert.equal(report.text.includes('lwb_boot_'), false);
    assert.equal(report.safe, true);
  });

  it('E3 终检错了会当场失败：给它一段没被擦洗的文本', () => {
    // 直接调 `scanForLeaks` 而不经过 `scrub`，模拟「将来有人加了一个
    // 新字段却忘了过第 2 层」——第 3 层就是为这一天存在的。
    const findings = scanForLeaks('root: C:\\Users\\mj\\secret');
    assert.ok(findings.includes('windows_absolute_path'));
    assert.ok(findings.includes('unix_home_path') === false, 'Windows 路径不该顺带命中 Unix 那条');
  });

  it('E4 带前缀的本地标识符不被当成密钥（否则检查会永远失败）', () => {
    const findings = scanForLeaks('operation_id: op_0123456789abcdef0123456789abcdef');
    assert.deepEqual(findings, [], '一个永远失败的检查等于没有检查');
    const naked = scanForLeaks(`digest: ${'a'.repeat(64)}`);
    assert.deepEqual(naked, ['hex_secret'], '裸的 64 位十六进制仍然要被抓到');
  });

  it('E5 诊断里不含凭据、不含控制台地址，且说明写在开头', () => {
    const report = redactedDiagnostic(diagInput({ last_error: { code: 'NO_SESSION', message: '会话无效。' } }));
    assert.match(report.text, /本机绝对路径一律不出现/);
    assert.match(report.text, /last_error.code: NO_SESSION/);
    assert.equal(/csrf|bearer|authorization/i.test(report.text), false);
    assert.deepEqual(report.findings, []);
  });

  it('E6 正常的一份诊断里没有任何路径 —— 这靠的是字段清单，不是「记得」', () => {
    const report = redactedDiagnostic(diagInput());
    assert.equal(report.safe, true);
    assert.deepEqual(report.redactions, [], '没有需要擦洗的地方');
    // 工作区那一行的本机路径被**显式**标记为「这一份不带」，
    // 而不是静默丢掉：读的人因此知道这里本来有一项。
    assert.match(report.text, /local_path: （本机路径：这份诊断不带）/);
  });

  it('E7 `toDiagnosticWorkspaces` 是唯一出口，它产出的行里根本没有 root', () => {
    const conversion = toDiagnosticWorkspaces([workspace()]);
    const row: Record<string, unknown> = { ...conversion.rows[0] };
    assert.equal('root' in row, false);
    assert.equal(conversion.rows[0]?.local_path_omitted, true);
    assert.deepEqual(conversion.redactions, [], '普通的别名不需要擦洗');

    // 它同时报告**自己**擦掉了什么：别名在这里已经被擦过一次，
    // 第 2 层再也看不见那次命中，台账若不收下这批名字就会谎报「没有」。
    const dirty = toDiagnosticWorkspaces([workspace({ alias: 'D:\\MyProjects\\x' })]);
    assert.deepEqual(dirty.redactions, ['workspaces[0].alias']);
    assert.equal(dirty.rows[0]?.alias.includes('MyProjects'), false);
  });

  it('E8 读数缺失时诊断说「无读数」，而不是把缺失渲染成 false', () => {
    const report = redactedDiagnostic(diagInput({ status: null }));
    assert.match(report.text, /status_reading_at: （没有读数）/);
    assert.match(report.text, /gate\.g0_platform_verified: 无读数/);
    assert.match(report.text, /flag\.read_enabled: 无读数/);
    assert.equal(/flag\.read_enabled: false/.test(report.text), false);
  });

  it('E9 `scrub` 命中之后不回显命中的内容', () => {
    const result = scrub('路径是 C:\\Users\\mj\\note.txt');
    assert.equal(result.text.includes('mj'), false);
    assert.equal(result.text.includes('C:\\'), false);
    assert.deepEqual(result.hits, ['windows_absolute_path']);
  });
});

// ---------------------------------------------------------------------------
// F 组 · 本地启动帮助（执行步骤 3）
// ---------------------------------------------------------------------------

describe('F 组 · 本地启动帮助', () => {
  it('F1 一切正常时**一条都不显示**', () => {
    // 常驻的帮助文本会被读过一次然后被忽略，而它下面那条真正重要的
    // 提示会跟着一起变成背景。
    assert.deepEqual(applicableHelp({ session: { session_id: 'sess_1' }, daemon_freshness: 'fresh' }), []);
  });

  it('F2 没有会话时给「启动服务 → 打开控制台 → 可能是 404」', () => {
    const entries = applicableHelp({ session: null, daemon_freshness: 'absent' });
    assert.deepEqual(entries.map((entry) => entry.id), ['start_daemon', 'open_console', 'console_page_missing']);
  });

  it('F3 会话过期与从未登录给的下一步不同', () => {
    const expired = applicableHelp({ session: null, session_expired: true, daemon_freshness: 'stale' });
    assert.deepEqual(expired.map((entry) => entry.id), ['session_expired', 'start_daemon']);
  });

  it('F4 有会话但读数不新鲜时给「睡眠唤醒之后」', () => {
    const entries = applicableHelp({ session: { session_id: 'sess_1' }, daemon_freshness: 'stale' });
    assert.deepEqual(entries.map((entry) => entry.id), ['wake_and_reverify']);
    assert.match(entries[0]?.warning ?? '', /旧读数/);
  });

  it('F5 三条**必须**在的话都在帮助里', () => {
    const text = localStartHelp()
      .flatMap((entry) => [...entry.steps, entry.warning ?? ''])
      .join('\n');
    assert.match(text, /一次性启动令牌/, '令牌是一次性的，且等同密码');
    assert.match(text, /不要\*\*贴到聊天/);
    assert.match(text, /浏览器不能替你选目录/, '方案 §10.1');
    assert.match(text, /`npm run daemon`/, '命令要写出来');
    assert.match(text, /404/, '页面还没有人托管这件事必须写下来');
  });

  it('F6 每一条都有标题、有步骤、且步骤不是空串', () => {
    for (const entry of localStartHelp()) {
      assert.ok(entry.title.length > 0, entry.id);
      assert.ok(entry.steps.length > 0, entry.id);
      assert.equal(entry.steps.every((step) => step.trim().length > 0), true, entry.id);
    }
  });

  it('F7 帮助是只读快照，改不动里面', () => {
    const first = localStartHelp();
    const second = localStartHelp();
    assert.notEqual(first, second, '每次都是新的一份');
    assert.deepEqual(first[0], second[0]);
    assert.equal(Object.isFrozen(first[0]), true);
  });
});

// ---------------------------------------------------------------------------
// G 组 · 工作区表单与暴露摘要（执行步骤 1、验收标准 1）
// ---------------------------------------------------------------------------

describe('G 组 · 工作区', () => {
  it('G1 请求体恰好四个字段，且路径不做规范化', () => {
    const request = registerRequest({
      alias: '  我的项目  ',
      kind: 'directory',
      mode: 'read_only',
      path: '  D:\\MyProjects\\a\\..\\b  ',
      risk_ack: true,
    });
    assert.deepEqual(Object.keys(request).sort(), ['alias', 'kind', 'mode', 'path']);
    assert.equal(request.alias, '我的项目', '别名去空白');
    // 路径**原样**提交：改一个字符就可能指向另一个目录，而
    // 「服务端看到的路径就是你粘贴的路径」是这条链路唯一可核对的保证。
    assert.equal(request.path, 'D:\\MyProjects\\a\\..\\b');
  });

  it('G2 需要确认风险的模式不勾就提交不了', () => {
    const base = { alias: 'a', kind: 'directory' as const, path: 'D:\\a' };
    const readOnly = validateRegister({ ...base, mode: 'read_only', risk_ack: false });
    assert.equal(readOnly.can_submit, true, '只读不需要那个勾');

    const propose = validateRegister({ ...base, mode: 'read_propose_apply_with_local_approval', risk_ack: false });
    assert.equal(propose.can_submit, false);
    assert.ok(propose.problems.some((line) => line.includes('风险说明')));
    assert.equal(validateRegister({ ...base, mode: 'read_propose_apply_with_local_approval', risk_ack: true }).can_submit, true);
  });

  it('G3 空别名与空路径各有一条能读懂的理由', () => {
    const result = validateRegister({ alias: '  ', kind: 'directory', mode: 'read_only', path: '', risk_ack: false });
    assert.equal(result.can_submit, false);
    assert.match(result.problems.join('\n'), /别名不能为空/);
    assert.match(result.problems.join('\n'), /浏览器不能替你选目录/);
  });

  it('G4 暴露摘要把「登记了几个」与「有几个在暴露」分开说', () => {
    const rows = [workspace(), workspace({ workspace_id: 'ws_0002', alias: 'b' })];
    const off = exposureSummary(rows, FLAGS_OFF);
    assert.equal(off.registered, 2);
    assert.match(off.headline, /已登记 2 个根/);
    assert.match(off.headline, /没有根同时满足连接与目录授权/);
    assert.match(off.lines[0] ?? '', /目录工具由逐 workspace grant 控制/);

    const on = exposureSummary(
      rows,
      FLAGS_ON,
      rows.map((row) => ({ workspace_id: row.workspace_id, enabled: true, capabilities: ['read', 'list'] as const })),
      true,
    );
    assert.equal(on.accessible, 2);
    assert.match(on.headline, /2 个根当前具备有效的 ChatGPT 内容工具访问条件/);
    assert.match(on.lines[0] ?? '', /目录工具由逐 workspace grant 控制/);
  });

  it('G4a 工作区 propose grant 决定提议/写工具是否可用', () => {
    const row = workspace({ mode: 'read_propose_apply_with_local_approval' });
    const flags = { ...FLAGS_OFF, read_enabled: true };
    const access = [{ workspace_id: row.workspace_id, enabled: true, capabilities: ['propose'] as const }];
    const summary = exposureSummary([row], flags, access, true);
    assert.equal(summary.proposal_granted, 1);
    assert.equal(summary.accessible, 1, '该根已获 propose grant，修改工具可用');
    assert.match(summary.lines[1] ?? '', /1 个启用根已获文件修改授权/);
  });

  it('G5 一个都没登记时不留白，明说「没有任何本机内容暴露」', () => {
    const summary = exposureSummary([], null);
    assert.equal(summary.registered, 0);
    assert.match(summary.headline, /没有任何目录被登记/);
    assert.match(summary.lines[0] ?? '', /ChatGPT 连接状态无可信读数/);
  });

  it('G6 已移除的登记仍然列出来，且计入「另有多少个」', () => {
    const summary = exposureSummary([workspace(), workspace({ workspace_id: 'ws_0002', removed: true })], FLAGS_OFF);
    assert.equal(summary.registered, 1);
    assert.equal(summary.removed, 1);
    assert.match(summary.lines[2] ?? '', /另有 1 个已移除/);
  });

  it('G7 一行工作区的两种标签各有四种组合', () => {
    assert.equal(describeWorkspace(workspace()).state_label, '启用');
    assert.equal(describeWorkspace(workspace({ enabled: false })).state_label, '已暂停');
    assert.equal(describeWorkspace(workspace({ removed: true })).state_label, '已移除');
    assert.equal(describeWorkspace(workspace({ mode: 'read_propose_apply_with_local_approval' })).mode_label, '读取 + 修改（逐目录授权）');
  });

  it('G8 只读的风险说明里必须包含「不等于不出本机」', () => {
    // 一个认为「只读就是安全的」用户不会去读页面底部的说明，
    // 因此这句话必须出现在**选只读的时候**。
    const offers = modeOffers(writeGate({ gates: ALL_FAIL, flags: FLAGS_OFF }));
    const readOnly = offers.find((offer) => offer.mode === 'read_only');
    assert.match(readOnly?.risk ?? '', /只读不等于不出本机/);
    assert.equal(readOnly?.requires_ack, false, '只读不需要勾，这一层不是安全控制');
    assert.deepEqual(offers.map((offer) => offer.mode), ['read_only', 'read_propose_apply_with_local_approval']);
  });
});
