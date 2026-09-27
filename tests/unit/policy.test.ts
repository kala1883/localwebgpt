/**
 * 策略判定测试（LWB-011 步骤 1、2）。
 *
 * 两条验收标准在本文件里对应的部分：
 *  - 「模型输入无法修改策略或扩大资源根」—— 本文件用**形状**断言而不是
 *    「检查了它不可信」来覆盖：请求里没有绝对路径字段，批准视图里没有
 *    `approved` 字段，多塞进去的字段不会改变判定。
 *  - 「禁止文件不会通过搜索片段或 Git diff 旁路返回」—— 策略侧只能保证
 *    「判定说不行」；真正的旁路测试在 `tests/unit/egress.test.ts` 里，
 *    那里连"上层的搜索忘了调检查"这种情形也一并测了。
 *
 * 约定：断言信息带上实际值。拒绝类断言同时断言**理由码与错误码** ——
 * 「被拒绝了」和「因为正确的原因、以正确的错误码被拒绝」是三件事。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CapabilityFlags, CapabilityName, WorkspaceKind, WorkspaceMode } from '@lwb/contracts';
import {
  ALL_DEFAULT_RULES,
  HARD_DENY_RULES,
  SEARCH_EXCLUDE_RULES,
  applyExemptions,
  classifyFile,
  decide,
  isPolicyDeniedError,
  requireAllowed,
  validateExemption,
  type ConnectionAudience,
  type FileRule,
  type PolicyAction,
  type PolicyFailureReason,
  type PolicyRequest,
} from '@lwb/policy';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

const WS = 'ws-1';
const CONN = 'conn-1';
const GEN = 7;
const POLICY = 3;
const NOW = 1_700_000_000_000;

interface RequestOptions {
  readonly action?: PolicyAction;
  readonly path?: string;
  readonly audience?: ConnectionAudience;
  readonly granted_capabilities?: readonly CapabilityName[];
  readonly granted_workspace_ids?: readonly string[];
  readonly connection_enabled?: boolean;
  readonly kind?: WorkspaceKind;
  readonly mode?: WorkspaceMode;
  readonly capabilities?: Partial<CapabilityFlags>;
  readonly current_generation?: number;
  readonly current_policy_version?: number;
  readonly presented_generation?: number | null;
  readonly presented_policy_version?: number | null;
  readonly paused?: boolean;
  readonly now?: number;
  readonly rules?: readonly FileRule[];
}

/** 一份**默认全部通过**的请求；每个用例只改动它要测的那一处。 */
function request(options: RequestOptions = {}): PolicyRequest {
  const action = options.action ?? 'read';
  const writes = action === 'change_prepare' || action === 'file_create' || action === 'change_revert_prepare' || action === 'change_apply';

  return {
    connection: {
      connection_id: CONN,
      enabled: options.connection_enabled ?? true,
      // 注意这里**没有** `apply` 与 `control`：它们是控制面专属能力，
      // 模型面凭据持有任何一项都会被判定为凭据本身无效。
      granted_capabilities: options.granted_capabilities ?? [
        'read',
        'search',
        'list',
        'git_read',
        'propose',
      ],
      audience: options.audience ?? 'mcp_adapter',
      granted_workspace_ids: options.granted_workspace_ids ?? [WS],
    },
    workspace: {
      workspace_id: WS,
      kind: options.kind ?? 'directory',
      mode: options.mode ?? 'read_propose_apply_with_local_approval',
      capabilities: {
        read_enabled: true,
        git_enabled: true,
        proposal_enabled: true,
        direct_write_enabled: true,
        recovery_required: false,
        ...(options.capabilities ?? {}),
      },
      current_generation: options.current_generation ?? GEN,
      current_policy_version: options.current_policy_version ?? POLICY,
      root_volume_id: 'vol-1',
      root_file_id: 'file-1',
      paused: options.paused ?? false,
    },
    presented: {
      generation: options.presented_generation === undefined ? (writes ? GEN : null) : options.presented_generation,
      policy_version: options.presented_policy_version === undefined ? (writes ? POLICY : null) : options.presented_policy_version,
    },
    action: {
      action,
      path: options.path ?? 'src/index.ts',
    },
    now: options.now ?? NOW,
    ...(options.rules ? { rules: options.rules } : {}),
  };
}

/** 判定并返回主因的理由码（断言「因为正确的原因被拒」）。 */
function reasonOf(req: PolicyRequest): PolicyFailureReason | 'ALLOWED' {
  const decision = decide(req);
  return decision.allow ? 'ALLOWED' : (decision.primary?.reason ?? 'ALLOWED');
}

// ---------------------------------------------------------------------------
// 1. 允许路径
// ---------------------------------------------------------------------------

describe('策略：允许路径', () => {
  it('普通读取在最保守的默认值下被允许', () => {
    const decision = decide(request({ action: 'read' }));
    assert.equal(decision.allow, true, `应允许，实际主因：${decision.primary?.reason ?? '无'}`);
    assert.equal(decision.primary, null);
    assert.deepEqual(decision.failures, []);
  });

  it('四项检查全部执行（不因某项通过而跳过其余）', () => {
    const decision = decide(request());
    assert.deepEqual(
      decision.checks.map((c) => c.check),
      ['connection', 'workspace', 'generation', 'file_rules'],
      '四项检查必须逐项记录结论，顺序固定',
    );
    assert.ok(
      decision.checks.every((c) => c.passed),
      `允许时四项都应记为通过，实际：${JSON.stringify(decision.checks)}`,
    );
  });

  it('命中搜索排除规则不构成拒绝（排除 ≠ 禁止）', () => {
    // node_modules 是性能排除。显式读它里面的文件应当允许 ——
    // 若这里被拒，说明有人把"不搜"读成了"不许读"。
    const decision = decide(request({ action: 'read', path: 'node_modules/pkg/index.js' }));
    assert.equal(decision.allow, true, `应允许，实际：${decision.primary?.reason ?? '无'}`);
    assert.equal(decision.rule_verdict.kind, 'search_exclude');
  });

  it('脱敏面（读取）与阻断面（搜索片段）由动作规格决定', () => {
    const read = decide(request({ action: 'read' }));
    const search = decide(request({ action: 'search' }));
    assert.equal(read.obligations.secret_mode, 'redact');
    assert.equal(search.obligations.secret_mode, 'block');
  });

  it('出站义务里**没有**可关闭秘密筛查的开关', () => {
    // 「可选项会被关掉」：这一项设计决定钉在测试里，避免以后有人
    // 顺手加一个 screen_secrets: boolean。
    const decision = decide(request());
    assert.deepEqual(
      Object.keys(decision.obligations),
      ['secret_mode'],
      '出站义务集合中只允许存在真正会变的那一项',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. 四项授权判定：每项单独失败
// ---------------------------------------------------------------------------

describe('策略：连接授权层', () => {
  it('连接被停用 → CONNECTION_DISABLED', () => {
    assert.equal(reasonOf(request({ connection_enabled: false })), 'CONNECTION_DISABLED');
  });

  it('凭据未被授予所需能力 → CAPABILITY_NOT_GRANTED / NOT_AUTHORIZED', () => {
    const decision = decide(request({ action: 'git_diff', granted_capabilities: ['read'] }));
    assert.equal(decision.primary?.reason, 'CAPABILITY_NOT_GRANTED');
    assert.equal(decision.primary?.error_code, 'NOT_AUTHORIZED');
  });

  it('模型面凭据里含控制面能力 → 即使本次只读也拒绝（凭据本身无效）', () => {
    for (const leaked of ['control', 'apply'] as const) {
      const decision = decide(request({ action: 'read', granted_capabilities: ['read', leaked] }));
      assert.equal(
        decision.primary?.reason,
        'CONTROL_CAPABILITY_ON_MODEL_SURFACE',
        `凭据里带 ${leaked} 时，连读取都不应放行 —— 它是一份不该存在的凭据`,
      );
      assert.equal(decision.primary?.error_code, 'NOT_AUTHORIZED');
    }
  });

  it('change_apply 由本机逐目录 propose grant 授权，不再要求逐次批准', () => {
    const modely = decide(
      request({ action: 'change_apply', granted_capabilities: ['propose'] }),
    );
    assert.equal(modely.allow, true, `逐目录写权限已授予时应放行：${modely.primary?.reason ?? ''}`);
    const noGrant = decide(request({ action: 'change_apply', granted_capabilities: [] }));
    assert.equal(noGrant.primary?.reason, 'CAPABILITY_NOT_GRANTED');
  });

  it('本地控制面持有 control 是允许的', () => {
    const decision = decide(
      request({ action: 'audit_export', audience: 'local_console', granted_capabilities: ['control'] }),
    );
    assert.equal(decision.allow, true, `应允许，实际：${decision.primary?.reason ?? '无'}`);
  });

  it('工作区能力开关关闭 → CAPABILITY_FLAG_DISABLED / POLICY_DENIED', () => {
    const decision = decide(request({ action: 'git_diff', capabilities: { git_enabled: false } }));
    assert.equal(decision.primary?.reason, 'CAPABILITY_FLAG_DISABLED');
    assert.equal(decision.primary?.error_code, 'POLICY_DENIED');
  });

  it('direct_write_enabled 默认关闭时不能应用修改', () => {
    const decision = decide(request({ action: 'change_apply', capabilities: { direct_write_enabled: false } }));
    assert.equal(decision.primary?.reason, 'CAPABILITY_FLAG_DISABLED');
    assert.equal(decision.allow, false);
  });
});

describe('策略：工作区层', () => {
  it('工作区未授予该连接 → WORKSPACE_NOT_GRANTED', () => {
    const decision = decide(request({ granted_workspace_ids: ['ws-other'] }));
    assert.equal(decision.primary?.reason, 'WORKSPACE_NOT_GRANTED');
    assert.equal(decision.primary?.error_code, 'WORKSPACE_NOT_GRANTED');
  });

  it('工作区被暂停 → PAUSED', () => {
    assert.equal(reasonOf(request({ paused: true })), 'WORKSPACE_PAUSED');
  });

  it('工作区待人工恢复 → RECOVERY_REQUIRED', () => {
    const decision = decide(request({ capabilities: { recovery_required: true } }));
    assert.equal(decision.primary?.reason, 'WORKSPACE_RECOVERY_REQUIRED');
    assert.equal(decision.primary?.error_code, 'RECOVERY_REQUIRED');
  });

  it('只读模式下写入动作被拒，读取动作仍允许', () => {
    assert.equal(reasonOf(request({ action: 'change_prepare', mode: 'read_only' })), 'WORKSPACE_MODE_READ_ONLY');
    assert.equal(reasonOf(request({ action: 'read', mode: 'read_only' })), 'ALLOWED');
  });

  it('单文件工作区只接受空相对路径', () => {
    assert.equal(reasonOf(request({ kind: 'file', path: 'other.txt' })), 'WORKSPACE_KIND_MISMATCH');
    assert.equal(reasonOf(request({ kind: 'file', path: '' })), 'ALLOWED');
  });
});

describe('策略：代次层', () => {
  it('创建新文件不要求读取目标文件的票据', () => {
    const decision = decide(request({ action: 'file_create', presented_generation: null }));
    assert.equal(
      decision.allow,
      true,
      `创建应绑定 daemon 当前代次而不伪造读取票据：${decision.primary?.reason ?? ''}`,
    );
  });

  it('代次不符 → WORKSPACE_GENERATION_CHANGED', () => {
    const decision = decide(request({ presented_generation: GEN - 1 }));
    assert.equal(decision.primary?.reason, 'GENERATION_CHANGED');
    assert.equal(decision.primary?.error_code, 'WORKSPACE_GENERATION_CHANGED');
  });

  it('策略版本不符 → POLICY_VERSION_CHANGED', () => {
    assert.equal(reasonOf(request({ presented_policy_version: POLICY - 1 })), 'POLICY_VERSION_CHANGED');
  });

  it('写入缺票据（代次为 null）被拒；读取可以没有票据', () => {
    assert.equal(reasonOf(request({ action: 'change_prepare', presented_generation: null })), 'TICKET_GENERATION_MISSING');
    assert.equal(reasonOf(request({ action: 'read', presented_generation: null })), 'ALLOWED');
  });
});

describe('策略：文件规则层', () => {
  const denied = [
    '.env',
    '.env.local',
    '.env.example',
    'config/.env',
    'src/keys/server.pem',
    'secrets/id_rsa',
    '.ssh/id_rsa',
    '.git/config',
    '.aws/credentials',
    '.lwb/secrets.db',
    'src/.ENV',
  ];

  for (const path of denied) {
    it(`硬拒绝：${path}`, () => {
      const decision = decide(request({ action: 'read', path }));
      assert.equal(decision.allow, false, `${path} 应被拒绝，实际放行`);
      assert.equal(decision.primary?.reason, 'HARD_DENY_RULE');
      assert.equal(decision.primary?.error_code, 'POLICY_DENIED');
      assert.equal(decision.rule_verdict.kind, 'hard_deny');
    });
  }

  const allowed = ['src/index.ts', 'docs/env-notes.md', 'config/app.json', 'README.md', '.gitignore'];

  for (const path of allowed) {
    it(`放行：${path}`, () => {
      const decision = decide(request({ action: 'read', path }));
      assert.equal(decision.allow, true, `${path} 应放行，实际被拒：${decision.primary?.reason ?? '无'}`);
    });
  }

  it('硬拒绝优先于搜索排除（被排除目录里的 .env 仍是硬拒绝）', () => {
    const verdict = classifyFile('node_modules/pkg/.env');
    assert.equal(verdict.kind, 'hard_deny', '先判排除会让这条路径在读取面上永远轮不到硬拒绝');
  });

  it('硬拒绝规则对 `..` 穿越段同样生效', () => {
    // 相对路径的合法性由 LWB-010 的语法层与护栏负责；这里要确认的是
    // 策略层不会因为路径"看起来在往上去"就跳过规则。逐段匹配天然覆盖它。
    assert.equal(classifyFile('../outside/.env').kind, 'hard_deny');
    assert.equal(classifyFile('a/../.env').kind, 'hard_deny');
  });

  it('硬拒绝与搜索排除分属两个独立集合，没有任何一条规则同时出现', () => {
    const hardIds = new Set(HARD_DENY_RULES.map((r) => r.id));
    const overlap = SEARCH_EXCLUDE_RULES.filter((r) => hardIds.has(r.id));
    assert.deepEqual(overlap, [], '两个规则集不允许共享 id');
    assert.ok(HARD_DENY_RULES.every((r) => r.kind === 'hard_deny'));
    assert.ok(SEARCH_EXCLUDE_RULES.every((r) => r.kind === 'search_exclude'));
  });

  it('放宽搜索排除在语法上碰不到硬拒绝：删光排除规则后硬拒绝一字不动', () => {
    const onlyHard: readonly FileRule[] = [...HARD_DENY_RULES];
    assert.equal(classifyFile('.env', onlyHard).kind, 'hard_deny');
    assert.equal(classifyFile('node_modules/pkg/.env', onlyHard).kind, 'hard_deny');
    // 反过来：搜索排除没了，被排除的文件就只是"能读"，而不是"变成硬拒绝" ——
    // 两个集合的收紧/放宽互不影响，这正是分开存储要买到的东西。
    assert.equal(classifyFile('node_modules/pkg/index.js', onlyHard).kind, 'allow');
  });

  it('每条硬拒绝规则都写了理由', () => {
    for (const rule of ALL_DEFAULT_RULES) {
      assert.ok(rule.rationale.trim().length >= 8, `规则 ${rule.id} 的理由太短，下一个人只会删掉它`);
    }
  });
});

describe('策略：写权限来自工作区 grant', () => {
  it('change_apply 只检查逐目录 grant；判定输入没有逐次人工批准字段', () => {
    const requestWithGrant = request({ action: 'change_apply' });
    const noGrant = decide(request({ action: 'change_apply', granted_capabilities: [] }));
    assert.equal(decide(requestWithGrant).allow, true);
    assert.equal(noGrant.allow, false);
    assert.equal(noGrant.primary?.reason, 'CAPABILITY_NOT_GRANTED');
    assert.deepEqual(Object.keys(requestWithGrant.action).sort(), ['action', 'path']);
  });

  it('读取类动作不要求批准', () => {
    assert.equal(reasonOf(request({ action: 'read' })), 'ALLOWED');
  });
});

// ---------------------------------------------------------------------------
// 3. 不短路
// ---------------------------------------------------------------------------

describe('策略：失败不短路', () => {
  /** 同时违反连接、工作区、代次与文件规则；逐次批准已不是一层策略。 */
  function everythingWrong(): PolicyRequest {
    return request({
      action: 'change_apply',
      path: '.env',
      connection_enabled: false,
      granted_capabilities: [],
      granted_workspace_ids: [],
      capabilities: { direct_write_enabled: false },
      presented_generation: GEN - 3,
      presented_policy_version: POLICY - 2,
      paused: true,
    });
  }

  it('四层同时失败时，四层都被记录', () => {
    const decision = decide(everythingWrong());
    const failed = decision.checks.filter((c) => !c.passed).map((c) => c.check);
    assert.deepEqual(
      failed,
      ['connection', 'workspace', 'generation', 'file_rules'],
      '任何一层被短路跳过，这里就会少一项',
    );
  });

  it('全部失败项都保留在 failures 里（审计需要知道全貌）', () => {
    const decision = decide(everythingWrong());
    const checks = new Set(decision.failures.map((f) => f.check));
    assert.deepEqual([...checks].sort(), ['connection', 'file_rules', 'generation', 'workspace']);
    assert.ok(decision.failures.length >= 4, `失败项太少：${decision.failures.length}`);
  });

  it('主因按固定优先级取，与失败项数量无关', () => {
    assert.equal(decide(everythingWrong()).primary?.reason, 'CONNECTION_DISABLED');

    // 去掉连接层的问题之后，主因顺位落到工作区层。
    const base = everythingWrong();
    const second = decide({
      ...base,
      connection: { ...base.connection, enabled: true, granted_capabilities: ['propose'] },
      workspace: { ...base.workspace, capabilities: { ...base.workspace.capabilities, direct_write_enabled: true } },
    });
    assert.equal(second.primary?.check, 'workspace', `实际主因：${second.primary?.reason}`);
  });

  it('靠前的层通过时明确记为通过，而不是"没记录"', () => {
    const decision = decide(request({ action: 'read', path: '.env' }));
    const byCheck = new Map(decision.checks.map((c) => [c.check, c.passed]));
    assert.equal(byCheck.get('connection'), true);
    assert.equal(byCheck.get('workspace'), true);
    assert.equal(byCheck.get('generation'), true);
    assert.equal(byCheck.get('file_rules'), false);
  });
});

// ---------------------------------------------------------------------------
// 4. 模型输入无法修改策略或扩大资源根
// ---------------------------------------------------------------------------

describe('策略：模型输入无法触及策略与资源根', () => {
  it('在请求里塞 approved:true / user_id 之类字段不会改变判定', () => {
    const base = request({ action: 'change_apply' });
    const tampered = {
      ...base,
      action: {
        ...base.action,
        approved: true,
        user_id: 'u-1',
        session_id: 's-1',
        conversation_label: 'chat',
        principal_id: 'p-1',
        force: true,
      },
    } as unknown as PolicyRequest;

    const baseline = decide(base);
    const decision = decide(tampered);
    assert.equal(decision.allow, baseline.allow, '请求字段不能扩大逐工作区 grant');
    assert.equal(decision.primary?.reason, baseline.primary?.reason);
  });

  it('请求里没有绝对路径字段，也没有任何可扩大的根', () => {
    const req = request();
    const keys = Object.keys(req);
    assert.deepEqual(keys.sort(), ['action', 'connection', 'now', 'presented', 'workspace']);
    const actionKeys = Object.keys(req.action).sort();
    assert.deepEqual(actionKeys, ['action', 'path'], '策略动作只包含动作名与工作区相对路径');
  });

  it('策略参数（rules）只能从请求传入，工具参数里没有这条通道', () => {
    // 这一条是**形状**断言：PolicyRequest 的字段集合是封闭的，
    // 因此工具参数里无论叫什么名字，都落不到 rules 上。
    const withRules = request({ rules: [...HARD_DENY_RULES] });
    assert.equal(decide(withRules).allow, true);
    const withoutRules = request();
    assert.equal(decide(withoutRules).rules.length, ALL_DEFAULT_RULES.length);
  });

  it('requireAllowed 对允许的请求返回判定，对拒绝的请求抛 BridgeError', () => {
    const ok = requireAllowed(request());
    assert.equal(ok.allow, true);

    try {
      requireAllowed(request({ path: '.env' }));
      assert.fail('应当抛出');
    } catch (error) {
      assert.ok(isPolicyDeniedError(error), `应抛 PolicyDeniedError，实际：${String(error)}`);
      assert.equal(error.code, 'POLICY_DENIED');
      assert.ok(error.message.includes('HD-ENV'), `拒绝信息应说明命中了哪条规则：${error.message}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. 操作者豁免：只能收窄，且碰不到 I13
// ---------------------------------------------------------------------------

describe('操作者豁免', () => {
  const exemption = {
    id: 'EX-1',
    rule_id: 'HD-ENV',
    name: '.env.example',
    rationale: '本仓库的 .env.example 只有占位符，经人工确认',
    created_at: '2026-09-25T00:00:00.000Z',
  };

  it('合法豁免让 .env.example 放行，而 .env 仍然被拒', () => {
    const { rules, applied, rejected } = applyExemptions([exemption]);
    assert.deepEqual(rejected, []);
    assert.equal(applied.length, 1);
    assert.equal(classifyFile('.env.example', rules).kind, 'allow');
    assert.equal(classifyFile('.env', rules).kind, 'hard_deny');
    assert.equal(classifyFile('src/.env.example', rules).kind, 'allow');
  });

  it('豁免生效后，判定层也跟着放行（同一份规则表贯穿）', () => {
    const { rules } = applyExemptions([exemption]);
    const decision = decide(request({ path: '.env.example', rules }));
    assert.equal(decision.allow, true, `应允许，实际：${decision.primary?.reason ?? '无'}`);
  });

  it('I13：插件自身状态目录的规则**不可豁免**', () => {
    const attempt = {
      id: 'EX-2',
      rule_id: 'HD-PLUGIN-STATE',
      name: 'lwb-state',
      rationale: '我只是想看一下快照目录里的文件名',
      created_at: '2026-09-25T00:00:00.000Z',
    };
    assert.ok(
      validateExemption(attempt, ALL_DEFAULT_RULES)?.includes('不可豁免'),
      'I13 说"永远"，本文件必须让"永远"有可执行的含义',
    );
    const { rules, applied, rejected } = applyExemptions([attempt]);
    assert.equal(applied.length, 0);
    assert.equal(rejected.length, 1);
    assert.equal(classifyFile('lwb-state/approvals.db', rules).kind, 'hard_deny');
  });

  it('通配符豁免被拒（那等于把整条规则关掉，只是换个写法）', () => {
    const wild = { ...exemption, id: 'EX-3', name: '*.env' };
    assert.ok(validateExemption(wild, ALL_DEFAULT_RULES) !== null);
    assert.equal(applyExemptions([wild]).applied.length, 0);
  });

  it('指向不存在规则的豁免被拒，且不静默丢弃', () => {
    const ghost = { ...exemption, id: 'EX-4', rule_id: 'HD-NO-SUCH-RULE' };
    const { applied, rejected } = applyExemptions([ghost]);
    assert.equal(applied.length, 0);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.reason.includes('HD-NO-SUCH-RULE'), `拒绝原因应说明问题：${rejected[0]?.reason ?? ''}`);
  });

  it('本来就没被命中的豁免被拒（无意义的豁免只会积累成噪音）', () => {
    const useless = { ...exemption, id: 'EX-5', name: 'README.md' };
    assert.ok(validateExemption(useless, ALL_DEFAULT_RULES)?.includes('本来就不被'));
  });

  it('豁免只能收窄：规则数量与 id 集合一字不变', () => {
    const before = ALL_DEFAULT_RULES.map((r) => r.id).sort();
    const { rules } = applyExemptions([exemption]);
    assert.deepEqual(rules.map((r) => r.id).sort(), before, '豁免不允许新增或删除规则');
    assert.equal(rules.length, ALL_DEFAULT_RULES.length);
    // 原规则对象没有被就地改写。
    assert.equal(HARD_DENY_RULES.find((r) => r.id === 'HD-ENV')?.except, undefined);
  });

  it('豁免表里带上的 touched_hard_deny 如实报告是否动了硬拒绝集合', () => {
    assert.equal(applyExemptions([exemption]).touched_hard_deny, true);
    const seOnly = { ...exemption, id: 'EX-6', rule_id: 'SE-DEPS', name: 'vendor', rationale: '本项目 vendor 目录很小' };
    assert.equal(applyExemptions([seOnly]).touched_hard_deny, false);
  });
});
