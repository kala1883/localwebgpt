/**
 * 出站闸门测试（LWB-011 步骤 3、4 与三条验收标准）。
 *
 * 本文件覆盖的重点**不是**「过滤器能过滤」，而是**闸门关不关得上**：
 *
 *  - 验收标准 1「禁止文件不会通过搜索片段或 Git diff 旁路返回」：
 *    这里刻意模拟**上层漏检** —— 拿一张对工作区根铸的凭证，直接把 `.env` 的
 *    内容送进去，闸门必须自己拒掉。如果哪天有人删掉闸门里的重判、只留下层过滤，
 *    这条用例会红；而只测「正常路径已过滤」的用例不会红。
 *  - 验收标准 2「模型输入无法修改策略或扩大资源根」：闸门只接受相对路径，
 *    绝对路径与反斜杠路径一律拒绝；手搓的判定结果换不到出站资格。
 *  - 验收标准 3「明确记录秘密检测并非百分之百」：`已知边界` 一节把
 *    **检不出来的情形**写成断言。它们不是待修的 bug，是记录在案的边界；
 *    有人以为"再加一条规则就全覆盖了"时，这几条会告诉他不是。
 *
 * 约定：涉及脱敏的断言优先用**精确相等**而不是"不含某串"——
 * 「输出里没有 X」在输出整个错位、或压根没输出时也可能为真。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { BridgeError } from '@lwb/contracts';
import { decide, type PolicyAction, type PolicyRequest } from '@lwb/policy';
import {
  EgressBudget,
  EgressBudgetStore,
  assertEditTicket,
  clearanceTaint,
  emitContent,
  mintClearance,
  mintEditTicket,
  redact,
  screenText,
  secretRuleIds,
  type Clearance,
} from '@lwb/egress';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

/** 模型侧连接能拿到的能力。注意**不含** `control` 与 `apply`（契约禁止）。 */
const MCP_CAPABILITIES = ['read', 'search', 'list', 'git_read', 'propose'] as const;

/**
 * 审计导出是**本地控制面**的动作（`capability: 'control'`），
 * 模型侧凭据带 `control` 会被连接层判为配置无效。因此这一条用控制面的连接视图 ——
 * 顺带也就测到了「换个面不等于换一套规则」。
 */
function connectionFor(action: PolicyAction): PolicyRequest['connection'] {
  const consoleOnly = action === 'audit_export';
  return {
    connection_id: 'conn-1',
    enabled: true,
    granted_capabilities: consoleOnly ? ['control', 'read'] : [...MCP_CAPABILITIES],
    audience: consoleOnly ? 'local_console' : 'mcp_adapter',
    granted_workspace_ids: ['ws-1'],
  };
}

function request(action: PolicyAction, path = ''): PolicyRequest {
  return {
    connection: connectionFor(action),
    workspace: {
      workspace_id: 'ws-1',
      kind: 'directory',
      mode: 'read_propose_apply_with_local_approval',
      capabilities: {
        read_enabled: true,
        git_enabled: true,
        proposal_enabled: true,
        direct_write_enabled: true,
        recovery_required: false,
      },
      current_generation: 7,
      current_policy_version: 3,
      root_volume_id: 'vol-1',
      root_file_id: 'file-1',
      paused: false,
    },
    presented: { generation: null, policy_version: null },
    action: { action, path, approval: null },
    now: NOW,
  };
}

/** 对工作区根铸一张凭证 —— 刻意**不对具体文件**，用来模拟上层漏检。 */
function clearanceFor(action: PolicyAction): Clearance {
  const decision = decide(request(action));
  assert.equal(
    decision.allow,
    true,
    `装置前提：${action} 应被允许，实际主因 ${decision.primary?.reason ?? '(none)'}`,
  );
  return mintClearance(decision, { connection_id: 'conn-1', generation: 7 });
}

function bigBudget(limit = 1024 * 1024): EgressBudget {
  return new EgressBudget({ limit_bytes_per_hour: limit, now: () => NOW });
}

/** 断言一次出站被拒绝，并返回错误码与消息。 */
function expectRefused(fn: () => unknown, hint: string): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BridgeError, `${hint}：期望 BridgeError，实际 ${String(error)}`);
    return { code: error.code, message: error.message };
  }
  assert.fail(`${hint}：竟然出站成功了`);
}

// ---------------------------------------------------------------------------
// 1. 闸门本身
// ---------------------------------------------------------------------------

describe('出站闸门：凭证', () => {
  it('手搓的判定结果换不到凭证', () => {
    const fake = {
      allow: true,
      obligations: { secret_mode: 'block' },
      context: { workspace_id: 'ws-1', action: 'read', surface: 'file_read' },
      rules: [],
    };
    assert.throws(() => mintClearance(fake as never, { connection_id: 'conn-1', generation: 7 }), /不是/);
  });

  it('被拒绝的判定换不到凭证', () => {
    const denied = decide(request('read', '.env'));
    assert.equal(denied.allow, false);
    assert.throws(() => mintClearance(denied, { connection_id: 'conn-1', generation: 7 }), /不允许/);
  });

  it('没登记过的凭证不能出站', () => {
    const forged = {
      connection_id: 'conn-1',
      workspace_id: 'ws-1',
      generation: 7,
      action: 'read',
      surface: 'file_read',
      obligations: { secret_mode: 'block' },
      rules: [],
    };
    assert.throws(() => emitContent(forged as never, { path: 'a.txt', content: 'hi' }, bigBudget()), /mintClearance/);
  });

  it('绝对路径与反斜杠路径被拒（闸门只认工作区相对路径）', () => {
    const clearance = clearanceFor('read');
    for (const bad of ['C:/Users/me/.env', 'C:\\Users\\me\\notes.txt', '\\\\server\\share\\x.txt', '/etc/passwd']) {
      const { code } = expectRefused(
        () => emitContent(clearance, { path: bad, content: 'x' }, bigBudget()),
        `路径 ${bad} 应被拒绝`,
      );
      assert.equal(code, 'PATH_UNSAFE');
    }
  });

  it('合法相对路径正常出站，并按 UTF-8 字节如实计数', () => {
    const clearance = clearanceFor('read');
    const text = '中文abc';
    const emission = emitContent(clearance, { path: 'src/index.ts', content: text }, bigBudget());

    assert.equal(emission.content, text);
    assert.equal(emission.bytes, Buffer.byteLength(text, 'utf8'), '字节数按 UTF-8 算，不是按字符数');
    assert.equal(emission.redacted, false);
    assert.equal(emission.surface, 'file_read');
  });
});

// ---------------------------------------------------------------------------
// 2. 验收标准 1：禁止文件不经任何出站面旁路返回
// ---------------------------------------------------------------------------

const SURFACES: readonly { readonly action: PolicyAction; readonly surface: string }[] = [
  { action: 'read', surface: 'file_read' },
  { action: 'search', surface: 'search_snippet' },
  { action: 'git_diff', surface: 'git_diff' },
  { action: 'snapshot_read', surface: 'snapshot_read' },
  { action: 'error_detail', surface: 'error_detail' },
  { action: 'audit_export', surface: 'audit_export' },
];

const FORBIDDEN_PATHS = [
  '.env',
  'config/.env.production',
  '.env.example', // 方案 §4.3：不做自动豁免
  'keys/server.pem',
  'home/.ssh/id_rsa',
  '.git/config',
  '.aws/credentials',
  'lwb-state/approvals.db', // I13
  'app/.lwb/secret.key', // I13
];

describe('验收标准 1：硬拒绝文件不经任何出站面旁路返回', () => {
  for (const { action } of SURFACES) {
    it(`${action} 面：九个硬拒绝路径全部被闸门自己拒掉`, () => {
      const clearance = clearanceFor(action);
      for (const path of FORBIDDEN_PATHS) {
        const { code, message } = expectRefused(
          () => emitContent(clearance, { path, content: 'SECRET-LEAK-CANARY' }, bigBudget()),
          `${action} 面送出 ${path}`,
        );
        assert.equal(code, 'POLICY_DENIED', `${action}/${path} 的错误码应为 POLICY_DENIED`);
        assert.ok(!message.includes('SECRET-LEAK-CANARY'), '拒绝消息里不能夹带内容');
      }
    });
  }

  it('拒的是闸门**自己重判**的结果，不是"上层已经过滤过"的说法', () => {
    // 同一张对根铸的凭证：干净路径放行、禁止路径被拒。
    // 「上层过滤」做不到这一点 —— 它只能决定不发；能这么拒的只有闸门本身。
    const clearance = clearanceFor('read');
    assert.equal(emitContent(clearance, { path: 'src/ok.ts', content: 'ok' }, bigBudget()).content, 'ok');
    const { code } = expectRefused(() => emitContent(clearance, { path: '.env', content: 'x' }, bigBudget()), '.env');
    assert.equal(code, 'POLICY_DENIED');
  });

  it('判定时用的规则与出站重判用的是**同一个对象**', () => {
    const decision = decide(request('read'));
    const clearance = mintClearance(decision, { connection_id: 'conn-1', generation: 7 });
    assert.equal(clearance.rules, decision.rules, '两份规则表必须同一个对象，否则中间那个时间差就是旁路');
  });

  it('审计导出面同样受限（它是控制面的能力，不是免检通道）', () => {
    const clearance = clearanceFor('audit_export');
    assert.equal(clearance.surface, 'audit_export');
    const { code } = expectRefused(() => emitContent(clearance, { path: '.env', content: 'x' }, bigBudget()), '审计导出');
    assert.equal(code, 'POLICY_DENIED');
  });
});

// ---------------------------------------------------------------------------
// 3. 秘密检测与脱敏
// ---------------------------------------------------------------------------

const PEM_KEY = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3Nn4Oo5Pp6Qq7Rr8Ss9Tt0',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

const AWS_SECRET_LINE = 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';
const AWS_SECRET_VALUE = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const GITHUB_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const JWT_TOKEN =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const SLACK_TOKEN = ['xoxb', 'synthetic', 'test', 'canary'].join('-');

/** 逐字符滑窗：原值的任何 6 字符片段都不该出现在输出里。 */
function assertNoFragment(haystack: string, needle: string, label: string): void {
  for (let i = 0; i + 6 <= needle.length; i += 1) {
    const window = needle.slice(i, i + 6);
    assert.ok(
      !haystack.includes(window),
      `${label}：脱敏结果里出现了原值的 ${JSON.stringify(window)}（第 ${i} 字符起）`,
    );
  }
}

describe('秘密检测：两档处置', () => {
  it('读取面：高置信度命中 → 脱敏放行，且**整块**盖掉（含私钥正文）', () => {
    const clearance = clearanceFor('read');
    const emission = emitContent(clearance, { path: 'notes.txt', content: `说明\n${PEM_KEY}\n结束` }, bigBudget());

    assert.equal(emission.redacted, true);
    assert.equal(emission.content, '说明\n[REDACTED:private-key-block]\n结束');
    assert.deepEqual(
      emission.findings.map((f) => f.rule_id),
      ['private-key-block'],
    );
    // 只盖开头那行标记、把 base64 正文留在输出里，是这类实现最常见的错误。
    assertNoFragment(emission.content, PEM_KEY, '私钥');
  });

  it('搜索片段面：同一个私钥 → 整块阻断（片段不脱敏）', () => {
    const clearance = clearanceFor('search');
    const { code, message } = expectRefused(
      () => emitContent(clearance, { path: 'notes.txt', content: PEM_KEY }, bigBudget()),
      '搜索片段带出私钥',
    );
    assert.equal(code, 'SECRET_DETECTED');
    assertNoFragment(message, PEM_KEY, '错误消息');
  });

  it('Git 差异面：AWS 密钥 → 整块阻断', () => {
    const { code } = expectRefused(
      () =>
        emitContent(
          clearanceFor('git_diff'),
          { path: 'appsettings.json', content: `+${AWS_SECRET_LINE}` },
          bigBudget(),
        ),
      'git diff 带出 AWS 密钥',
    );
    assert.equal(code, 'SECRET_DETECTED');
  });

  it('快照 / 错误 / 审计面同样是阻断档', () => {
    for (const action of ['snapshot_read', 'error_detail', 'audit_export'] as const) {
      const { code } = expectRefused(
        () => emitContent(clearanceFor(action), { path: 'log.txt', content: GITHUB_TOKEN }, bigBudget()),
        `${action} 面带出 GitHub 令牌`,
      );
      assert.equal(code, 'SECRET_DETECTED', `${action} 面应为阻断档`);
    }
  });

  it('脱敏保留上下文：关键字与用户名/主机留下，只有值被替换', () => {
    const text = 'DB_PASSWORD=hunter2swordfish\nREDIS_URL=redis://default:sup3rs3cr3tpass@cache.internal:6379\n';
    const emission = emitContent(clearanceFor('read'), { path: 'docker-compose.yml', content: text }, bigBudget());

    assert.equal(
      emission.content,
      'DB_PASSWORD=[REDACTED:keyword-secret-value]\n' +
        'REDIS_URL=redis://default:[REDACTED:url-userinfo]@cache.internal:6379\n',
    );
  });

  it('脱敏不泄露任何前后缀（逐字符滑窗检查）', () => {
    const samples = [
      { id: 'PEM 私钥', text: PEM_KEY, secret: PEM_KEY },
      { id: 'AWS 秘密键', text: AWS_SECRET_LINE, secret: AWS_SECRET_VALUE },
      { id: 'GitHub 令牌', text: `token = ${GITHUB_TOKEN}`, secret: GITHUB_TOKEN },
      { id: 'JWT', text: `Authorization: Bearer ${JWT_TOKEN}`, secret: JWT_TOKEN },
      { id: 'Slack 令牌', text: SLACK_TOKEN, secret: SLACK_TOKEN },
    ];

    for (const sample of samples) {
      const emission = emitContent(clearanceFor('read'), { path: 'a.txt', content: sample.text }, bigBudget());
      assert.equal(emission.redacted, true, `${sample.id} 应当被脱敏`);
      assertNoFragment(emission.content, sample.secret, sample.id);
    }
  });

  it('脱敏幂等：对已脱敏文本再跑一次结果不变', () => {
    const once = redact('password = "hunter2swordfish"').text;
    assert.equal(once, 'password = "[REDACTED:keyword-secret-value]"');
    assert.equal(redact(once).text, once, '标记本身不得再被任何规则命中');
  });

  it('发现项只带规则与位置，绝不带内容', () => {
    const screen = screenText('password = "hunter2swordfish"');
    assert.ok(screen.findings.length > 0);
    assert.ok(!JSON.stringify(screen.findings).includes('hunter2'), '发现项里夹带了内容');
    assert.deepEqual(Object.keys(screen.findings[0] ?? {}).sort(), ['length', 'rule_id', 'start', 'tier']);
  });

  it('占位符与引用不脱敏（刻意的误报抑制，代价见"已知边界"）', () => {
    const text = 'DB_PASSWORD="${DB_PASSWORD}"\nAPI_KEY=<your-key-here>\nTOKEN=%TOKEN%\nSECRET=xxxxxxxxxxxx\n';
    const emission = emitContent(clearanceFor('read'), { path: 'docs/env-sample.md', content: text }, bigBudget());
    assert.equal(emission.redacted, false, `占位符不该被脱敏：${JSON.stringify(emission.content)}`);
    assert.equal(emission.content, text);
  });

  it('规则清单可从代码读出（证据与文档据此与实现同源）', () => {
    const rules = secretRuleIds();
    assert.ok(rules.some((r) => r.tier === 'certain'));
    assert.ok(rules.some((r) => r.tier === 'likely'));
    assert.equal(new Set(rules.map((r) => r.id)).size, rules.length, '规则 id 不允许重复');
  });
});

// ---------------------------------------------------------------------------
// 4. 脱敏结果不得获得可编辑读取票据
// ---------------------------------------------------------------------------

describe('可编辑票据', () => {
  it('干净的读取拿到票据，票据能通过校验，摘要绑定的就是出站内容', () => {
    const clearance = clearanceFor('read');
    const text = 'export const a = 1;\n';
    const emission = emitContent(clearance, { path: 'src/a.ts', content: text }, bigBudget());
    const ticket = mintEditTicket(clearance, emission, { now: NOW });

    assert.ok(ticket !== null, '干净内容应拿到票据');
    assert.equal(ticket.workspace_id, 'ws-1');
    assert.equal(ticket.path, 'src/a.ts');
    assert.equal(ticket.generation, 7);
    assert.equal(ticket.content_sha256, createHash('sha256').update(text, 'utf8').digest('hex'));
    assert.equal(assertEditTicket(ticket), ticket);
    assert.equal(clearanceTaint(clearance).redactions, 0);
  });

  it('脱敏过的读取**拿不到**票据', () => {
    const clearance = clearanceFor('read');
    const emission = emitContent(clearance, { path: 'src/a.ts', content: `x\n${GITHUB_TOKEN}\n` }, bigBudget());

    assert.equal(emission.redacted, true);
    assert.equal(mintEditTicket(clearance, emission, { now: NOW }), null, '脱敏结果不得获得可编辑票据');
    assert.equal(clearanceTaint(clearance).redactions, 1);
  });

  it('凭证一旦被污染，**先前**签发的那张干净票据也作废', () => {
    // 一次读取可能分多次出站（分页、多个片段）：先出去的干净片段拿到了票据，
    // 随后出去的片段命中秘密。只在签发那一刻查污染的话，那张早先的票据仍然有效，
    // 而它所属的文件此时已经确认含秘密。
    const clearance = clearanceFor('read');
    const clean = emitContent(clearance, { path: 'src/a.ts', content: '第一页，干净\n' }, bigBudget());
    const ticket = mintEditTicket(clearance, clean, { now: NOW });
    assert.ok(ticket !== null);
    assert.equal(assertEditTicket(ticket), ticket, '污染之前，票据有效');

    emitContent(clearance, { path: 'src/a.ts', content: `第二页\n${GITHUB_TOKEN}\n` }, bigBudget());

    assert.throws(
      () => assertEditTicket(ticket),
      (error: unknown) => error instanceof BridgeError && error.code === 'READ_TOKEN_STALE',
      '同一次读取的后续片段命中秘密后，先前的票据必须作废',
    );
  });

  it('手搓的票据通不过校验', () => {
    assert.throws(
      () =>
        assertEditTicket({ workspace_id: 'ws-1', path: 'a.ts', generation: 7, content_sha256: 'x', issued_at: NOW }),
      (error: unknown) => error instanceof BridgeError && error.code === 'READ_TOKEN_STALE',
    );
  });

  it('不能用另一张凭证的载荷换取本凭证的票据', () => {
    const a = clearanceFor('read');
    const b = clearanceFor('read');
    const emissionA = emitContent(a, { path: 'src/a.ts', content: 'a\n' }, bigBudget());
    assert.throws(() => mintEditTicket(b, emissionA, { now: NOW }), /另一张凭证/);
  });
});

// ---------------------------------------------------------------------------
// 5. 出站字节预算
// ---------------------------------------------------------------------------

describe('出站预算：滑动窗口', () => {
  it('正常记账，剩余额度递减', () => {
    const budget = new EgressBudget({ limit_bytes_per_hour: 1000, now: () => NOW });
    const clearance = clearanceFor('read');

    const first = emitContent(clearance, { path: 'a.txt', content: 'x'.repeat(100) }, budget);
    assert.equal(first.charged_bytes, 100);
    assert.equal(first.budget_remaining_bytes, 900);

    const second = emitContent(clearance, { path: 'a.txt', content: 'y'.repeat(50) }, budget);
    assert.equal(second.budget_remaining_bytes, 850);
    assert.equal(budget.usedBytes(), 150);
  });

  it('被拒绝的出站**不记账**（否则反复被拒就能耗光额度）', () => {
    const budget = new EgressBudget({ limit_bytes_per_hour: 100, now: () => NOW });
    const clearance = clearanceFor('read');

    for (let i = 0; i < 5; i += 1) {
      expectRefused(() => emitContent(clearance, { path: 'a.txt', content: 'z'.repeat(200) }, budget), '超额出站');
    }
    assert.equal(budget.usedBytes(), 0, '一个字节都没送出去，用量必须还是 0');
    assert.equal(budget.denials, 5, '拒绝次数应被计入诊断');
  });

  it('单次超过整小时上限 → SINGLE_REQUEST_EXCEEDS_LIMIT', () => {
    const budget = new EgressBudget({ limit_bytes_per_hour: 100, now: () => NOW });
    const { code } = expectRefused(
      () => emitContent(clearanceFor('read'), { path: 'a.txt', content: 'z'.repeat(101) }, budget),
      '单次超额',
    );
    assert.equal(code, 'EGRESS_BUDGET_EXCEEDED');
  });

  it('窗口是滚动的：第 59 分钟仍在窗口内，第 60 分钟滑出', () => {
    let t = Date.UTC(2026, 0, 1, 12, 59, 0);
    const budget = new EgressBudget({ limit_bytes_per_hour: 1000, now: () => t });
    assert.equal(budget.charge(1000).ok, true);
    assert.equal(budget.check(1).ok, false);

    t = Date.UTC(2026, 0, 1, 13, 58, 0); // +59 分钟
    assert.equal(budget.check(1).ok, false, '59 分钟前的用量仍在窗口内');

    t = Date.UTC(2026, 0, 1, 13, 59, 0); // +60 分钟
    assert.equal(budget.check(1).ok, true, '60 分钟后该用量滑出窗口');
    assert.equal(budget.usedBytes(), 0);
  });

  it('跨小时边界不会给出双倍额度（固定小时桶在这里会放行）', () => {
    let t = Date.UTC(2026, 0, 1, 12, 59, 0);
    const budget = new EgressBudget({ limit_bytes_per_hour: 1000, now: () => t });
    assert.equal(budget.charge(1000).ok, true);

    t = Date.UTC(2026, 0, 1, 13, 0, 0); // 下一小时的第 0 分钟
    assert.equal(
      budget.check(1000).ok,
      false,
      '「每小时 N 字节」若实现成固定小时桶，这里会再放行一整份额度 —— 实际允许两倍',
    );
  });

  it('窗口内还有用量的连接权重不会被回收；无用量且长期空闲的会被回收', () => {
    let t = NOW;
    const store = new EgressBudgetStore({ limit_bytes_per_hour: 100_000, now: () => t });

    // c1：长时间空闲，但持有预算引用的调用方在窗口内刚刚记过一笔。
    // 回收它会让额度变宽松 —— 所以它不该被回收。
    const c1 = store.forConnection('c1');
    // c2：建了就没用过，一直闲置。
    store.forConnection('c2');

    t = NOW + 85 * 60_000;
    c1.charge(1234);
    assert.equal(store.prune(), 1, '只应回收长期空闲且窗口内无用量的一条');
    assert.equal(store.size, 1);
    assert.equal(c1.usedBytes(), 1234, '被保留的那条，用量必须原样还在');
  });

  it('限额配错时拒绝构造，而不是悄悄退化成默认值', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => new EgressBudget({ limit_bytes_per_hour: bad, now: () => NOW }), /正整数/);
    }
  });
});

describe('出站预算：控制面载荷的例外', () => {
  function exhaustedBudget(): EgressBudget {
    const budget = new EgressBudget({ limit_bytes_per_hour: 10, now: () => NOW });
    budget.charge(10);
    return budget;
  }

  it('预算耗尽时错误详情仍能出站（否则"预算耗尽"这个原因永远到不了调用方）', () => {
    const emission = emitContent(
      clearanceFor('error_detail'),
      { path: '', content: '出站预算已用尽' },
      exhaustedBudget(),
    );
    assert.equal(emission.content, '出站预算已用尽');
    assert.equal(emission.charged_bytes, 0, '放行但不记账');
  });

  it('这个例外**不是**旁路：错误详情照样重判路径', () => {
    const { code } = expectRefused(
      () => emitContent(clearanceFor('error_detail'), { path: '.env', content: 'x' }, exhaustedBudget()),
      '错误面送 .env',
    );
    assert.equal(code, 'POLICY_DENIED');
  });

  it('这个例外**不是**旁路：错误详情照样做秘密筛查', () => {
    const { code } = expectRefused(
      () =>
        emitContent(clearanceFor('error_detail'), { path: '', content: `失败：${GITHUB_TOKEN}` }, exhaustedBudget()),
      '错误面夹带令牌',
    );
    assert.equal(code, 'SECRET_DETECTED');
  });

  it('例外有大小上限，不会变成不受预算约束的无限通道', () => {
    const { code } = expectRefused(
      () => emitContent(clearanceFor('error_detail'), { path: '', content: 'x'.repeat(9000) }, exhaustedBudget()),
      '错误详情超过 8 KiB',
    );
    assert.equal(code, 'EGRESS_BUDGET_EXCEEDED');
  });

  it('其它面没有这个例外', () => {
    expectRefused(() => emitContent(clearanceFor('read'), { path: 'a.txt', content: 'hi' }, exhaustedBudget()), '读取面');
    expectRefused(
      () => emitContent(clearanceFor('search'), { path: 'a.txt', content: 'hi' }, exhaustedBudget()),
      '搜索面',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. 验收标准 3：明确记录秘密检测的能力边界
// ---------------------------------------------------------------------------

describe('已知边界：秘密检测并非百分之百（验收标准 3）', () => {
  /**
   * 这一节里每一条都**断言检测失败**。
   *
   * 它们不是待修的缺陷，是被记录在案的边界 —— 方案要求「明确记录秘密检测
   * 并非百分之百识别任意秘密」。把边界写成**断言**而不是注释，是因为注释会腐坏，
   * 而断言会在有人以为"再加一条规则就全覆盖了"时提醒他并不是。
   *
   * 若哪天某条真的被检出来了，这里的用例会红。那时该做的是：把该条移出
   * 本清单、写进正式规则，并在证据里更新边界章节 —— 而不是删掉这条用例。
   */
  const undetectable = [
    {
      id: '无关键字的高熵随机串',
      text: 'const KEY = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c";',
      why: '形状与随机串无异；收录它等于让规则命中一切长十六进制串',
    },
    {
      id: '运行时拼接的凭据',
      text: 'const dsn = process.env.DB_PART_A + process.env.DB_PART_B;',
      why: '拼出来的值不在文本里，本模块看不到运行时状态',
    },
    {
      id: '被 base64 包了一层的凭据',
      text: 'payload = "QUtJQUlPU0ZPRE5ON0VYQU1QTEU="',
      why: '编码之后的形状与原规则完全不同',
    },
    {
      id: '占位符形态的真值（误报抑制的代价）',
      text: 'API_KEY="${AIzaSyA1234567890abcdefghijklmnopqrst}"',
      why: 'looksLikeReference 把它当成变量引用跳过了 —— 这是有意换来的低误报率',
    },
  ];

  for (const sample of undetectable) {
    it(`检不出来：${sample.id}`, () => {
      assert.equal(
        screenText(sample.text).findings.length,
        0,
        `${sample.id} 竟然被检出来了。这本身是好事，但必须同步更新规则清单与本边界章节，而不是删掉这条用例。` +
          `它原本检不出来的原因：${sample.why}`,
      );
      // 如实反映"这一层没拦住"，不假装拦住了。
      const emission = emitContent(clearanceFor('read'), { path: 'a.ts', content: sample.text }, bigBudget());
      assert.equal(emission.redacted, false);
      assert.equal(emission.content, sample.text);
    });
  }

  it('被切成多行的凭据：形状规则不命中，只有前半段被关键字规则盖掉', () => {
    // 这一条与上面几条不同 —— 它**不是**"完全检不出来"，而是"只盖住了一部分"。
    // 后半段会原样送出。写成用例而不是注释，是因为这正是最容易被当成已解决的情形：
    // 输出里出现了 `[REDACTED:...]`，看起来这件事已经处理好了。
    const text = 'token = "ghp_abcdefghijklmnop"\n       "qrstuvwxyz0123456789"';
    const screen = screenText(text);

    assert.ok(
      !screen.findings.some((f) => f.rule_id === 'github-token'),
      '形状规则要求 ghp_ 之后至少 36 位；被切断后两边都不满足',
    );
    assert.deepEqual(
      screen.findings.map((f) => f.rule_id),
      ['keyword-secret-value'],
      '关键字规则只认得「关键字 = 值」那一段，于是盖掉了前半段',
    );

    const clearance = clearanceFor('read');
    const emission = emitContent(clearance, { path: 'a.ts', content: text }, bigBudget());
    assert.ok(!emission.content.includes('ghp_abcdefghijklmnop'), '前半段已被盖掉');
    assert.ok(
      emission.content.includes('qrstuvwxyz0123456789'),
      '**残余**：后半段没有任何规则能识别（它连前缀都没有了），会原样送出。' +
        '这是记录在案的边界，不是待修的缺陷 —— 任意切分的凭据无法靠形状识别。',
    );
    // 唯一被挡住的是"把它当成可编辑内容"这条路。
    assert.equal(mintEditTicket(clearance, emission, { now: NOW }), null, '本次读取已判定含秘密，不得获得可编辑票据');
  });

  it('关键字 + 长标识符会被当成值脱敏（已知的过度脱敏，方向是安全的）', () => {
    // 与上面相反的一侧边界：把**不是**秘密的东西盖掉。
    // 关键字规则的要求只是「关键字 = 一个 ≥12 字符的连续记号」，
    // 因此 `const apiKey = getFromVault();` 也会被脱敏。
    // 方向是安全的（多盖不放行），代价是这一行看起来含秘密，
    // 于是整份文件失去可编辑票据 —— 这条代价如实记在这里。
    const text = 'const apiKey = getFromVault();\n';
    const emission = emitContent(clearanceFor('read'), { path: 'src/config.ts', content: text }, bigBudget());

    assert.equal(emission.redacted, true);
    assert.equal(emission.content, 'const apiKey = [REDACTED:keyword-secret-value];\n');
  });

  it('因此出站检查只是纵深防御的一层：第一道是硬拒绝规则', () => {
    // 同一个"检不出来"的随机串，躺在 .env 里就会被**硬拒绝**挡住 ——
    // 那一层看的是路径，不看内容，因此不受上表这些边界影响。
    const { code } = expectRefused(
      () =>
        emitContent(
          clearanceFor('read'),
          { path: '.env', content: 'KEY="9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c"' },
          bigBudget(),
        ),
      '.env 里的无形状密钥',
    );
    assert.equal(code, 'POLICY_DENIED');
  });
});

// ---------------------------------------------------------------------------
// 7. 六个面共用同一套检查
// ---------------------------------------------------------------------------

describe('统一性：所有出站面共用一套检查', () => {
  it('六个面都有义务集合与规则表，且规则表非空', () => {
    for (const { action } of SURFACES) {
      const clearance = clearanceFor(action);
      assert.ok(clearance.obligations !== undefined, `${action} 缺 obligations`);
      assert.ok(clearance.rules.length > 0, `${action} 缺规则表`);
    }
  });

  it('哪个面阻断、哪个面脱敏由**判定**决定，出站层自己不改口径', () => {
    const blocking = SURFACES.filter(({ action }) => decide(request(action)).obligations.secret_mode === 'block');
    assert.deepEqual(
      blocking.map((s) => s.surface).sort(),
      ['audit_export', 'error_detail', 'git_diff', 'search_snippet', 'snapshot_read'],
      '只有读取与目录列举是脱敏档；其余各面是阻断档',
    );
  });
});
