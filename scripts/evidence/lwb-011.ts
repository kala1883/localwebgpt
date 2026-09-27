/**
 * LWB-011 可复现证据采集。
 *
 * 三条验收标准：
 *
 *  1. 禁止文件不会通过搜索片段或 Git diff 旁路返回 —— 逐面逐路径跑一遍闸门，
 *     而且刻意**模拟上层漏检**（拿一张对工作区根铸的凭证，直接送 `.env` 的内容），
 *     证明拦住它的不是"上层记得过滤"，是闸门自己重判。
 *  2. 模型输入无法修改策略或扩大资源根 —— 把真实代码里**根本不存在**的那些字段
 *     （`approved` / `user_id` / `root_path` / `force`…）塞进请求，逐字节比对判定结果；
 *     再对操作者豁免通道做负向测试：只能收窄、不能新增或删除、I13 那一条不可豁免。
 *  3. 明确记录秘密检测并非百分之百 —— **把检不出来的情形一条条打印出来**，
 *     连同规则清单一起。这一节的意义不在于通过，在于让"能力边界"成为可执行的记录。
 *
 * 另有两项实测，都是设计里**必须靠测量**才能定的：
 *  - 出站预算为什么是滑动窗口：现场搭一个"固定小时桶"的对照实现，量出它给出的
 *    双倍额度，以及本实现的实际误差；
 *  - `check-fsguard-imports.mjs` 对新包是否真的在检查范围内：**反向探针**
 *    （种一个故意违规的文件，确认检查器报错，再删除）。仅靠"检查通过"证明不了 ——
 *    两个清单都不在的包同样会让检查通过（PROGRESS.md 偏离项 9）。
 *
 * 用法：node --import tsx scripts/evidence/lwb-011.ts
 * 退出码：全部通过 0；任一项失败 1。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  ACTION_SPECS,
  ALL_DEFAULT_RULES,
  EGRESS_SURFACES,
  HARD_DENY_RULES,
  NON_EXEMPTABLE_RULE_IDS,
  POLICY_ACTIONS,
  SEARCH_EXCLUDE_RULES,
  applyExemptions,
  classifyFile,
  decide,
  isIssuedDecision,
  requireAllowed,
  validateExemption,
  type OperatorExemption,
  type PolicyAction,
  type PolicyRequest,
} from '@lwb/policy';
import {
  EgressBudget,
  EgressBudgetStore,
  assertEditTicket,
  clearanceTaint,
  emitContent,
  mintClearance,
  mintEditTicket,
  screenText,
  secretRuleIds,
  type Clearance,
} from '@lwb/egress';
import { BridgeError } from '@lwb/contracts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function note(name: string, detail: string): void {
  console.log(`NOTE ${name} — ${detail}`);
}

function skip(name: string, why: string): void {
  console.log(`NOT_RUN ${name} — ${why}`);
}

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

const MCP_CAPABILITIES = ['read', 'search', 'list', 'git_read', 'propose'] as const;

function connectionFor(action: PolicyAction): PolicyRequest['connection'] {
  const consoleOnly = action === 'audit_export';
  return {
    connection_id: 'conn-evidence',
    enabled: true,
    granted_capabilities: consoleOnly ? ['control', 'read'] : [...MCP_CAPABILITIES],
    audience: consoleOnly ? 'local_console' : 'mcp_adapter',
    granted_workspace_ids: ['ws-evidence'],
  };
}

function baseRequest(action: PolicyAction, relativePath = ''): PolicyRequest {
  return {
    connection: connectionFor(action),
    workspace: {
      workspace_id: 'ws-evidence',
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
      root_volume_id: 'vol-evidence',
      root_file_id: 'file-evidence',
      paused: false,
    },
    presented: { generation: null, policy_version: null },
    action: { action, path: relativePath, approval: null },
    now: NOW,
  };
}

/**
 * 一次"模型刚读完文件、还没得到本地批准"的 `change_apply` 请求。
 *
 * 这是 LWB-028 验收标准里的那个形态：模型单独调用应用工具。
 * 它必须能走到**批准层**（拿到 APPROVAL_REQUIRED），而不是在更早的层就被
 * `NOT_AUTHORIZED` 挡住 —— 否则"等待人工"这件事在工具面上根本表达不出来。
 */
function ticketOnlyRequest(): PolicyRequest {
  const base = baseRequest('change_apply', 'src/a.ts');
  return {
    ...base,
    presented: {
      generation: base.workspace.current_generation,
      policy_version: base.workspace.current_policy_version,
    },
    action: { action: 'change_apply', path: 'src/a.ts', approval: null },
  };
}

/** 同上，但带上本地操作者给出的有效批准 —— 用于给 `change_receipt` 面铸凭证。 */
function approvedRequest(): PolicyRequest {
  const base = ticketOnlyRequest();
  const digest = 'a'.repeat(64);
  return {
    ...base,
    action: {
      action: 'change_apply',
      path: 'src/a.ts',
      approval: { state: 'ACTIVE', change_digest: digest, presented_digest: digest, expires_at: NOW + 60_000 },
    },
  };
}

function clearanceFor(action: PolicyAction): Clearance {
  const request = action === 'change_apply' ? approvedRequest() : baseRequest(action);
  const decision = decide(request);
  if (!decision.allow) {
    throw new Error(`装置前提不成立：${action} 被拒绝（${decision.primary?.reason ?? '?'}）`);
  }
  return mintClearance(decision, { connection_id: 'conn-evidence', generation: 7 });
}

function bigBudget(limit = 4 * 1024 * 1024): EgressBudget {
  return new EgressBudget({ limit_bytes_per_hour: limit, now: () => NOW });
}

function refusal(fn: () => unknown): { code: string; message: string } | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof BridgeError) return { code: error.code, message: error.message };
    return { code: 'NON_BRIDGE_ERROR', message: String(error) };
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('== 环境 ==');
  console.log(`平台: ${process.platform} ${process.arch}`);
  console.log(`系统: ${os.type()} ${os.release()}`);
  console.log(`Node: ${process.version}`);
  console.log(`tsx: ${(await import('tsx/package.json', { with: { type: 'json' } })).default.version}`);
  console.log(`PID: ${process.pid}`);
  console.log('');

  // =========================================================================
  // 验收标准 1：禁止文件不经任何出站面旁路返回
  // =========================================================================
  console.log('== 验收标准 1：禁止文件不经任何出站面旁路返回 ==');

  const FORBIDDEN = [
    '.env',
    '.env.example',
    '.env.production',
    'config/.env.local',
    'keys/server.pem',
    'deploy/signing.key',
    'home/.ssh/id_rsa',
    'home/.ssh/authorized_keys',
    '.git/config',
    '.aws/credentials',
    '.npmrc',
    'AppData/Local/Google/Chrome/User Data/Default/Login Data',
    'lwb-state/approvals.db',
    'app/.lwb/secret.key',
  ];
  const ALLOWED = [
    'src/index.ts',
    'docs/env-notes.md', // 与 `.env` 相邻但要放行：规则是逐段精确匹配，不做子串包含
    'config/appsettings.json',
    'README.md',
  ];

  note('规则表规模', `硬拒绝 ${HARD_DENY_RULES.length} 条（${HARD_DENY_RULES.length + SEARCH_EXCLUDE_RULES.length} 条总计）`);

  {
    const wronglyDenied = ALLOWED.filter((p) => classifyFile(p).kind === 'hard_deny');
    check(
      '不该被拒的路径没有被拒（规则是逐段精确匹配，不是子串包含）',
      wronglyDenied.length === 0,
      wronglyDenied.length === 0 ? `放行 ${ALLOWED.length} 条` : `误拒：${wronglyDenied.join(', ')}`,
    );
    const wronglyAllowed = FORBIDDEN.filter((p) => classifyFile(p).kind !== 'hard_deny');
    check(
      '每一条硬拒绝路径都被判定为 hard_deny（含 .env.example，方案 §4.3 不做自动豁免）',
      wronglyAllowed.length === 0,
      wronglyAllowed.length === 0 ? `${FORBIDDEN.length} 条全部命中` : `漏判：${wronglyAllowed.join(', ')}`,
    );
  }

  // --- 逐面逐路径：模拟上层漏检 ---
  const bypassed: string[] = [];
  const canary = 'SECRET-LEAK-CANARY-9f8e7d6c';
  let gateRefusals = 0;

  for (const surface of EGRESS_SURFACES) {
    const action = (POLICY_ACTIONS as readonly PolicyAction[]).find(
      (a) => ACTION_SPECS[a].surface === surface,
    );
    if (action === undefined) {
      bypassed.push(`${surface}: 没有任何动作指向这个出站面`);
      continue;
    }
    const clearance = clearanceFor(action);
    for (const forbidden of FORBIDDEN) {
      // 关键：凭证是对**工作区根**铸的，路径是直接送进去的 ——
      // 这正是"上层忘了过滤"的样子。
      const result = refusal(() => emitContent(clearance, { path: forbidden, content: canary }, bigBudget()));
      if (result === null) {
        bypassed.push(`${surface} × ${forbidden}: 竟然出站了`);
        continue;
      }
      gateRefusals += 1;
      if (result.code !== 'POLICY_DENIED') {
        bypassed.push(`${surface} × ${forbidden}: 拒绝码为 ${result.code}，期望 POLICY_DENIED`);
      }
      if (result.message.includes(canary)) {
        bypassed.push(`${surface} × ${forbidden}: 拒绝消息里夹带了内容`);
      }
    }
  }

  check(
    '每个出站面 × 每条硬拒绝路径都被闸门自己拒掉（上层漏检也拦得住）',
    bypassed.length === 0,
    bypassed.length === 0
      ? `${EGRESS_SURFACES.length} 面 × ${FORBIDDEN.length} 路径 = ${gateRefusals} 次全部拒绝`
      : bypassed.slice(0, 5).join(' | '),
  );

  {
    // 同一张凭证：干净路径放行、禁止路径被拒 —— 这两件事同时成立才说明
    // 拒绝来自"重判"，而不是"这张凭证本来就什么都送不出去"。
    const clearance = clearanceFor('read');
    const ok = emitContent(clearance, { path: 'src/ok.ts', content: 'export {}\n' }, bigBudget());
    const denied = refusal(() => emitContent(clearance, { path: '.env', content: canary }, bigBudget()));
    check(
      '同一张凭证上：干净路径正常出站，禁止路径被拒',
      ok.content === 'export {}\n' && denied?.code === 'POLICY_DENIED',
      `干净=${JSON.stringify(ok.content)} 禁止=${denied?.code ?? '竟然放行'}`,
    );
  }

  {
    // 规则表是**同一个对象**从判定传到出站，因此不存在"判定时用新规则、
    // 出站时用旧规则"的时间差。
    const decision = decide(baseRequest('read'));
    const clearance = mintClearance(decision, { connection_id: 'conn-evidence', generation: 7 });
    check(
      '判定时与出站重判时用的是同一份规则表对象（不存在两个版本的策略）',
      clearance.rules === decision.rules,
      `规则 ${clearance.rules.length} 条，同一对象`,
    );
  }

  {
    // 动作 → 出站面 的映射必须穷尽且有定义：任何一个动作都落在一个出站面上，
    // 任何一个出站面都至少被一个动作使用。这样"新增动作时忘了给出站面"编译不过，
    // 而"新增出站面时忘了定义处置"会在这里露出来。
    const usedSurfaces = new Set(POLICY_ACTIONS.map((a) => ACTION_SPECS[a].surface));
    const orphanSurfaces = EGRESS_SURFACES.filter((s) => !usedSurfaces.has(s));
    const actions = POLICY_ACTIONS.length;
    check(
      '动作与出站面的映射是穷尽的双向覆盖',
      orphanSurfaces.length === 0,
      `${actions} 个动作 → ${usedSurfaces.size} 个出站面；无人使用的出站面：${orphanSurfaces.join(', ') || '无'}`,
    );
  }

  {
    const modes = new Set(EGRESS_SURFACES.map((s) => decide(baseRequest(
      (POLICY_ACTIONS as readonly PolicyAction[]).find((a) => ACTION_SPECS[a].surface === s) ?? 'read',
    )).obligations.secret_mode));
    check(
      '每个出站面都有明确的秘密处置，且只有两种取值（没有"不处置"这个选项）',
      [...modes].every((m) => m === 'block' || m === 'redact') && modes.size <= 2,
      `出现过的处置：${[...modes].join(', ')}`,
    );
    note(
      '两档的划分',
      'file_read / directory_listing 为 redact；search_snippet / git_diff / snapshot_read / error_detail / audit_export / change_receipt 为 block',
    );
  }

  skip(
    '搜索（LWB-015）与 Git 差异（LWB-016）的真实调用点也走这道闸门',
    '这两个读路径尚未实现（P2），今天没有可旁路的目标。本项只证到**闸门层**：' +
      '闸门自己重判路径，因此调用点即使漏检也送不出去。调用点的接线在 LWB-015/LWB-016 验收时另行取证',
  );
  console.log('');

  // =========================================================================
  // 验收标准 2：模型输入无法修改策略或扩大资源根
  // =========================================================================
  console.log('== 验收标准 2：模型输入无法修改策略或扩大资源根 ==');

  {
    const clean = baseRequest('read', 'src/a.ts');
    const requestKeys = Object.keys(clean).sort();
    const actionKeys = Object.keys(clean.action).sort();
    const workspaceKeys = Object.keys(clean.workspace).sort();

    check(
      '请求对象的字段集是封闭的：没有绝对路径、没有资源根、没有"已批准"',
      !requestKeys.some((k) => /path|root|approv|user|principal|session/i.test(k)),
      `PolicyRequest = {${requestKeys.join(', ')}}`,
    );
    check(
      'ActionView 只有 action / path / approval 三项，且 path 是**相对**路径',
      JSON.stringify(actionKeys) === JSON.stringify(['action', 'approval', 'path']),
      `ActionView = {${actionKeys.join(', ')}}`,
    );
    check(
      'WorkspaceView 里的根身份是 volume_id/file_id（不透明标识），不是可写路径',
      workspaceKeys.includes('root_volume_id') &&
        workspaceKeys.includes('root_file_id') &&
        !workspaceKeys.includes('root_path'),
      `WorkspaceView = {${workspaceKeys.join(', ')}}`,
    );
    // 全仓检索：任何一处把绝对路径塞进判定输入的写法都不该存在。
    note(
      '绝对路径由谁解析',
      '护栏按工作区根解析（LWB-009/010，按实际打开对象的身份判定）；判定层拿不到也造不出工作区外的对象',
    );
  }

  {
    // 模型参数里那些"看起来像授权"的字段：塞进请求体，逐个比对判定结果。
    const clean = decide(ticketOnlyRequest());
    const cleanJson = JSON.stringify(clean);

    const injections: readonly [string, Record<string, unknown>][] = [
      ['approved', { approved: true }],
      ['user_id', { user_id: 'operator-1' }],
      ['principal_id', { principal_id: 'operator-1' }],
      ['session_id', { session_id: 'sess-1' }],
      ['conversation_label', { conversation_label: '已批准' }],
      ['force', { force: true }],
      ['skip_approval', { skip_approval: true }],
    ];

    const changed: string[] = [];
    for (const [label, extra] of injections) {
      // 故意在**类型之外**注入：跨进程边界上类型系统不起作用，
      // 因此这里要证明的是运行时的判定与这些字段无关。
      const poisoned = { ...ticketOnlyRequest(), ...extra } as PolicyRequest;
      if (JSON.stringify(decide(poisoned)) !== cleanJson) changed.push(label);
    }
    check(
      'approved / user_id / principal_id / session_id / conversation_label / force 等字段对判定毫无影响',
      changed.length === 0,
      changed.length === 0 ? `注入 ${injections.length} 个字段，判定逐字节相同` : `影响判定的字段：${changed.join(', ')}`,
    );
    check(
      '模型单独调用 change_apply（有票据、无批准）得到 APPROVAL_REQUIRED（不是 NOT_AUTHORIZED、更不是放行）',
      clean.allow === false && clean.primary?.error_code === 'APPROVAL_REQUIRED',
      `allow=${String(clean.allow)} code=${clean.primary?.error_code ?? '-'} 原因=${clean.primary?.reason ?? '-'}`,
    );
    check(
      '注入 approved:true 之后仍然 APPROVAL_REQUIRED（模型不能自己批准）',
      JSON.stringify(decide({ ...ticketOnlyRequest(), approved: true } as PolicyRequest)) === cleanJson &&
        clean.primary?.reason === 'APPROVAL_MISSING',
      `原因=${clean.primary?.reason ?? '-'}`,
    );
    check(
      '判定产出的对象被登记过；手搓的字面量换不到出站资格',
      isIssuedDecision(clean) &&
        !isIssuedDecision({ allow: true, obligations: { secret_mode: 'block' }, context: {}, rules: [] }),
      'isIssuedDecision: 真判定=true 手搓=false',
    );
  }

  {
    // 五层能力交集：全部失败时，五层都要留痕（不短路），主因按固定优先级取。
    const everythingWrong: PolicyRequest = {
      ...baseRequest('change_apply', '.env'),
      connection: { ...connectionFor('change_apply'), enabled: false, granted_capabilities: [], granted_workspace_ids: [] },
      workspace: {
        ...baseRequest('change_apply').workspace,
        capabilities: {
          read_enabled: false,
          git_enabled: false,
          proposal_enabled: false,
          direct_write_enabled: false,
          recovery_required: true,
        },
        paused: true,
        kind: 'file',
      },
      presented: { generation: 999, policy_version: 999 },
    };
    const worst = decide(everythingWrong);
    const checks = new Set(worst.failures.map((f) => f.check));
    check(
      '五层检查全部留痕（没有短路：失败原因不取决于代码里的语句顺序）',
      checks.size === 5,
      `${worst.failures.length} 条失败，覆盖 ${checks.size}/5 层：${[...checks].join(', ')}`,
    );
    check(
      '主因按固定优先级取第一条（connection 最先）',
      worst.primary?.check === 'connection',
      `主因层=${worst.primary?.check ?? '-'} 原因=${worst.primary?.reason ?? '-'}`,
    );
    check(
      'checks 数组长度恒为 5，逐层给出通过与否',
      worst.checks.length === 5 && worst.checks.every((c) => c.passed === false),
      worst.checks.map((c) => `${c.check}=${c.passed ? 'pass' : 'fail'}`).join(' '),
    );
  }

  {
    // 操作者豁免通道的负向测试：只能收窄。
    const mk = (over: Partial<OperatorExemption>): OperatorExemption => ({
      id: 'ex-1',
      rule_id: 'HD-ENV',
      name: '.env.example',
      rationale: '本仓库的示例文件确认不含真实密钥',
      created_at: '2026-09-25T00:00:00Z',
      ...over,
    });

    check(
      '正当的具名豁免被接受，且只收窄那一个名字',
      classifyFile('.env.example').kind === 'hard_deny' &&
        classifyFile('.env', applyExemptions([mk({})]).rules).kind === 'hard_deny' &&
        classifyFile('.env.example', applyExemptions([mk({})]).rules).kind === 'allow',
      '豁免 .env.example 之后，.env 仍然硬拒绝',
    );

    const rejectedCases: readonly [string, OperatorExemption][] = [
      ['指向不存在的规则（不能凭空造规则）', mk({ rule_id: 'HD-MADE-UP' })],
      ['通配符豁免（等于把整条规则关掉）', mk({ name: '*.env' })],
      ['I13 状态目录（永远不可豁免）', mk({ rule_id: 'HD-PLUGIN-STATE', name: '.lwb' })],
      ['无意义的豁免（本来就不命中）', mk({ name: 'notes.md' })],
      ['路径分隔符（豁免只能针对单个确切名字）', mk({ name: 'config/.env' })],
    ];
    const wronglyAccepted: string[] = [];
    for (const [label, ex] of rejectedCases) {
      if (validateExemption(ex, ALL_DEFAULT_RULES) === null) wronglyAccepted.push(label);
    }
    check(
      '五类越界豁免全部被拒（含 I13 的「永远不可豁免」）',
      wronglyAccepted.length === 0,
      wronglyAccepted.length === 0 ? `拒绝 ${rejectedCases.length} 类` : `竟然接受了：${wronglyAccepted.join(', ')}`,
    );
    check(
      'NON_EXEMPTABLE_RULE_IDS 里含 HD-PLUGIN-STATE（I13 的"永远"有可执行含义）',
      NON_EXEMPTABLE_RULE_IDS.includes('HD-PLUGIN-STATE'),
      `不可豁免规则：${NON_EXEMPTABLE_RULE_IDS.join(', ')}`,
    );

    const applied = applyExemptions([mk({})]);
    check(
      '豁免不改变规则条数（既不新增也不删除，只加 except）',
      applied.rules.length === ALL_DEFAULT_RULES.length && applied.rejected.length === 0,
      `${ALL_DEFAULT_RULES.length} 条 → ${applied.rules.length} 条，生效 ${applied.applied.length} 条`,
    );
    check(
      '返回的规则表是冻结的（上层改不动它）',
      Object.isFrozen(applied.rules),
      `frozen=${String(Object.isFrozen(applied.rules))}`,
    );
  }

  {
    // 只读模式关闭的是**整条**提议链路，不只是写入那一步。
    const readOnly: PolicyRequest = {
      ...baseRequest('change_prepare', 'src/a.ts'),
      workspace: { ...baseRequest('change_prepare').workspace, mode: 'read_only' },
    };
    const prepared = decide(readOnly);
    const applied = decide({
      ...baseRequest('change_apply', 'src/a.ts'),
      workspace: { ...baseRequest('change_apply').workspace, mode: 'read_only' },
      action: {
        action: 'change_apply',
        path: 'src/a.ts',
        approval: { state: 'ACTIVE', change_digest: 'd', presented_digest: 'd', expires_at: NOW + 60_000 },
      },
    });
    check(
      '只读模式下 change_prepare 与 change_apply 都被拒（整条链路，不只是写入那一步）',
      prepared.allow === false && applied.allow === false,
      `prepare=${prepared.primary?.reason ?? 'allow'} apply=${applied.primary?.reason ?? 'allow'}`,
    );
    check(
      '只读模式下读取仍可用（拒绝的是提议链路，不是整个工作区）',
      decide({ ...baseRequest('read', 'src/a.ts'), workspace: { ...baseRequest('read').workspace, mode: 'read_only' } })
        .allow === true,
      'read → allow',
    );
  }
  console.log('');

  // =========================================================================
  // 验收标准 3：秘密检测的能力边界（记录，而不是宣称）
  // =========================================================================
  console.log('== 验收标准 3：明确记录秘密检测并非百分之百识别任意秘密 ==');

  const rules = secretRuleIds();
  note('规则清单（与代码同源，直接读出）', `${rules.length} 条`);
  for (const r of rules) {
    console.log(`      [${r.tier}] ${r.id} — ${r.note}`);
  }
  console.log('');

  const BOUNDARY: readonly { readonly id: string; readonly text: string; readonly why: string }[] = [
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
      id: '自研令牌（无固定形状，名字里也没有关键字）',
      text: 'X-Internal-Auth: 7f3a9c1e5b2d8a460f9e1c3b7a5d2e8f',
      why: '内部系统的令牌没有可依赖的固定形状；名字里没有 password/token/secret 这一类关键字，关键字规则也够不着',
    },
  ];

  console.log('  检不出来的情形（这是记录，不是缺陷清单）：');
  const leaked: string[] = [];
  for (const sample of BOUNDARY) {
    const screen = screenText(sample.text);
    const detected = screen.findings.length > 0;
    if (detected) leaked.push(sample.id);
    console.log(
      `      ${detected ? '已检出' : '检不出'}  ${sample.id} — ${sample.why}`,
    );
  }
  check(
    '上列"检不出"的情形确实检不出来（若哪天检出来了，必须更新本节与规则清单，而不是删掉这一节）',
    leaked.length === 0,
    leaked.length === 0 ? `${BOUNDARY.length} 类边界如实记录` : `意外检出：${leaked.join(', ')}`,
  );
  note(
    '这不是"能力缺陷清单"',
    '同一份文本若躺在 .env / 私钥 / 凭证目录里，会被**硬拒绝规则**挡住 —— 那一层看路径不看内容，不受上列边界影响',
  );

  {
    // 另一侧的边界：把不是秘密的东西盖掉。方向是安全的，但代价要如实说。
    const falsePositive = 'const apiKey = getFromVault();\n';
    const emission = emitContent(clearanceFor('read'), { path: 'src/config.ts', content: falsePositive }, bigBudget());
    check(
      '已知的过度脱敏：关键字 + 长标识符会被当成值盖掉（安全方向，但会连累可编辑性）',
      emission.redacted === true && emission.content === 'const apiKey = [REDACTED:keyword-secret-value];\n',
      `输出=${JSON.stringify(emission.content)}`,
    );
    note(
      '代价',
      '该文件的本次读取因此拿不到可编辑票据（脱敏结果不得获得可编辑读取票据）—— 用户看到的是"这个文件不能改"',
    );
  }

  {
    // 部分命中：最容易被误认为"已经处理好了"的情形。
    const split = 'token = "ghp_abcdefghijklmnop"\n       "qrstuvwxyz0123456789"';
    const clearance = clearanceFor('read');
    const emission = emitContent(clearance, { path: 'src/a.ts', content: split }, bigBudget());
    check(
      '被切成多行的凭据：前半段被盖掉，后半段原样送出（**残余**，记录在案）',
      !emission.content.includes('ghp_abcdefghijklmnop') &&
        emission.content.includes('qrstuvwxyz0123456789'),
      '任意切分的凭据无法靠形状识别；唯一被挡住的是"把它当作可编辑内容"',
    );
    check(
      '该次读取拿不到可编辑票据',
      mintEditTicket(clearance, emission, { now: NOW }) === null,
      '脱敏结果不得获得可编辑读取票据',
    );
  }

  {
    // 脱敏本身是否留残：对原值做逐字符滑窗，任何一个 6 字符片段都不该出现在输出里。
    const samples = [
      { id: 'PEM 私钥（含正文）', secret: '-----BEGIN RSA PRIVATE KEY-----\nAa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3Nn4Oo5Pp6Qq7Rr8Ss9Tt0\n-----END RSA PRIVATE KEY-----' },
      { id: 'AWS 秘密访问密钥', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      { id: 'GitHub 令牌', secret: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
      { id: 'Slack 令牌', secret: ['xoxb', 'synthetic', 'test', 'canary'].join('-') },
    ];
    const residues: string[] = [];
    for (const s of samples) {
      const body = s.secret.includes('PRIVATE KEY')
        ? `说明\n${s.secret}\n结束`
        : s.id === 'AWS 秘密访问密钥'
          ? `aws_secret_access_key = "${s.secret}"`
          : `凭据：${s.secret}`;
      const emission = emitContent(clearanceFor('read'), { path: 'notes.txt', content: body }, bigBudget());
      if (!emission.redacted) {
        residues.push(`${s.id}: 未被脱敏`);
        continue;
      }
      for (let i = 0; i + 6 <= s.secret.length; i += 1) {
        const window = s.secret.slice(i, i + 6);
        if (emission.content.includes(window)) {
          residues.push(`${s.id}: 残留 ${JSON.stringify(window)}`);
          break;
        }
      }
    }
    check(
      '脱敏不留任何前后缀（对原值逐字符滑窗，6 字符片段一律不出现）',
      residues.length === 0,
      residues.length === 0 ? `${samples.length} 个样本无残留` : residues.join(' | '),
    );
  }

  {
    // 脱敏结果不得获得可编辑票据 —— 而且这条跟着凭证走，不只在签发那一刻查一次。
    const clearance = clearanceFor('read');
    const clean = emitContent(clearance, { path: 'src/a.ts', content: '第一页\n' }, bigBudget());
    const ticket = mintEditTicket(clearance, clean, { now: NOW });
    const beforeTaint = ticket !== null ? assertEditTicket(ticket) === ticket : false;
    emitContent(clearance, { path: 'src/a.ts', content: '第二页 ghp_abcdefghijklmnopqrstuvwxyz0123456789\n' }, bigBudget());
    const afterRefusal = refusal(() => assertEditTicket(ticket));
    check(
      '凭证被污染后，**先前**签发的干净票据也作废（票据有效性跟着凭证走）',
      beforeTaint && afterRefusal?.code === 'READ_TOKEN_STALE',
      `污染前有效=${String(beforeTaint)} 污染后=${afterRefusal?.code ?? '仍然有效'}`,
    );
    note('污染计数', JSON.stringify(clearanceTaint(clearance)));
  }

  {
    const denied = refusal(() => requireAllowed(baseRequest('read', '.env')));
    check(
      '硬拒绝路径抛 PolicyDeniedError，且 details 里带得出规则 id（不含正文、不含绝对路径）',
      denied !== null && denied.code === 'POLICY_DENIED' && denied.message.includes('HD-ENV'),
      denied?.message ?? '竟然放行了',
    );
  }
  console.log('');

  // =========================================================================
  // 实测：出站预算为什么是滑动窗口
  // =========================================================================
  console.log('== 实测：出站预算的窗口形状 ==');

  {
    const LIMIT = 1024 * 1024; // 1 MiB/小时，便于读数
    // 对照实现：最省事的"每小时一个桶，跨小时清零"。
    let bucketHour = 12;
    let bucketUsed = 0;
    const strawmanCharge = (at: Date, bytes: number): boolean => {
      if (at.getHours() !== bucketHour) {
        bucketHour = at.getHours();
        bucketUsed = 0;
      }
      if (bucketUsed + bytes > LIMIT) return false;
      bucketUsed += bytes;
      return true;
    };

    let t = Date.UTC(2026, 0, 1, 12, 59, 0);
    const ours = new EgressBudget({ limit_bytes_per_hour: LIMIT, now: () => t });
    const t0 = new Date(t);
    const firstOk = ours.charge(LIMIT).ok && strawmanCharge(t0, LIMIT);

    t = Date.UTC(2026, 0, 1, 13, 0, 0); // 一分钟后
    const oursNext = ours.check(LIMIT).ok;
    const strawNext = strawmanCharge(new Date(t), LIMIT);

    check(
      '对照：固定小时桶在跨小时时又给出一整份额度（实际允许两倍）',
      strawNext === true,
      '12:59 用满一整小时额度，13:00 立刻又有一整份额度',
    );
    check(
      '本实现：滑动窗口在同一时刻仍然拒绝（不给双倍）',
      firstOk && oursNext === false,
      `12:59 记满 → 13:00 check 仍为 ${oursNext ? 'allow（有洞）' : 'deny'}`,
    );

    // 窗口的真实精度：探到用量滑出的时刻。
    t = Date.UTC(2026, 0, 1, 12, 59, 0);
    const probe = new EgressBudget({ limit_bytes_per_hour: LIMIT, now: () => t });
    probe.charge(LIMIT);
    let releasedAtMin = -1;
    for (let m = 1; m <= 61; m += 1) {
      t = Date.UTC(2026, 0, 1, 12, 59, 0) + m * 60_000;
      if (probe.check(1).ok) {
        releasedAtMin = m;
        break;
      }
    }
    check(
      '窗口长度实测落在 [59, 60] 分钟（桶粒度一分钟，最坏提前一分钟忘掉最早用量）',
      releasedAtMin === 60,
      `用量在第 ${releasedAtMin} 分钟滑出；超出上界 ≈ limit/60 = ${Math.round(LIMIT / 60)} 字节`,
    );

    check(
      '被拒绝的出站不记账（反复被拒不会耗光额度）',
      (() => {
        const b = new EgressBudget({ limit_bytes_per_hour: 1000, now: () => NOW });
        const c = clearanceFor('read');
        for (let i = 0; i < 10; i += 1) {
          refusal(() => emitContent(c, { path: 'a.txt', content: 'z'.repeat(10_000) }, b));
        }
        return b.usedBytes() === 0 && b.denials === 10;
      })(),
      '10 次超额拒绝之后用量仍为 0',
    );

    const store = new EgressBudgetStore({ limit_bytes_per_hour: 1000, now: () => NOW });
    store.forConnection('conn-a');
    store.forConnection('conn-b');
    check(
      '预算是每连接的，不是每工作区的（多授权一个工作区不该顺带多拿额度）',
      store.forConnection('conn-a') === store.forConnection('conn-a') &&
        store.forConnection('conn-a') !== store.forConnection('conn-b'),
      `已登记连接 ${store.size} 条`,
    );
  }
  console.log('');

  // =========================================================================
  // 实测：新包是否真在 FsGuard 的检查范围内（反向探针）
  // =========================================================================
  console.log('== 实测：packages/policy 与 packages/egress 在 FsGuard 检查范围内 ==');
  note(
    '为什么要探针',
    '规则 1 的条件是 `isBusiness && !isAllowed`；两个清单都不在的包既不检查也不报错，' +
      '而检查器照常打印"未发现绕过"。因此"检查通过"证明不了覆盖（PROGRESS.md 偏离项 9）',
  );

  const checker = path.join(REPO_ROOT, 'scripts', 'check-fsguard-imports.mjs');
  const probes = [
    path.join(REPO_ROOT, 'packages', 'policy', 'src', '__probe_evidence.ts'),
    path.join(REPO_ROOT, 'packages', 'egress', 'src', '__probe_evidence.ts'),
  ];

  const runChecker = (): { status: number; out: string } => {
    const res = spawnSync(process.execPath, [checker], { cwd: REPO_ROOT, encoding: 'utf8' });
    return { status: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
  };

  const baseline = runChecker();
  note('基线', `检查器退出码 ${baseline.status}；${baseline.out.trim().split(/\r?\n/).pop() ?? ''}`);

  const probeResults: string[] = [];
  try {
    for (const probe of probes) {
      writeFileSync(probe, "import fs from 'node:fs';\nexport const x = fs;\n", 'utf8');
      const res = runChecker();
      const caught = res.status !== 0 && res.out.includes('FSGUARD_BYPASS');
      const pkg = path.relative(REPO_ROOT, probe);
      probeResults.push(`${pkg} → ${caught ? '被检出' : '**漏检**'}`);
      if (!caught) failures += 1;
      rmSync(probe, { force: true });
    }
  } finally {
    for (const probe of probes) rmSync(probe, { force: true });
  }

  const afterCleanup = runChecker();
  check(
    '反向探针：在这两个包里种下违规 import 都会被检查器报错（因此"未发现绕过"是有意义的）',
    probeResults.every((r) => r.endsWith('被检出')),
    probeResults.join(' | '),
  );
  check(
    '探针文件已删除，仓库恢复干净（检查器回到基线结果）',
    probes.every((p) => !existsSync(p)) && afterCleanup.status === baseline.status,
    `退出码 ${afterCleanup.status}；${afterCleanup.out.trim().split(/\r?\n/).pop() ?? ''}`,
  );
  console.log('');

  console.log(failures === 0 ? '全部通过。' : `失败 ${failures} 项。`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
