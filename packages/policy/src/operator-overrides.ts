/**
 * 操作者豁免：让「本地操作者可以开洞」这件事有一处**具名、可审计、不可被模型触及**
 * 的落点。
 *
 * 为什么需要它：`.env.example` 这条规则一定会有人想开洞（方案 §4.3 明确要求
 * **默认**不豁免，但没说永远不豁免）。如果没有一处正当的开洞方式，人们就会去改
 * 规则本身 —— 而那会顺带把 `.env` 也放出来。给一个**只能收窄**的口子，
 * 是让那条规则活得久一点的办法。
 *
 * 三条不可商量的约束：
 *
 *  1. **豁免只能收窄既有规则，不能新增或删除规则。** 一份允许删除硬拒绝规则的
 *     API，迟早会被某个「就是想读一下 .env」的脚本用上。
 *  2. **豁免项必须是不含通配符的确切名字。** `*.env` 这种豁免等于把整条规则关掉，
 *     只是换了个写法。
 *  3. **I13 相关的规则永远不可豁免。** 方案说的是密钥、审批状态库与恢复快照目录
 *     「对模型**永远**不可挂载」—— 「永远」这个词必须在本文件里有一个可执行的
 *     含义，否则它只是一句形容。见 `NON_EXEMPTABLE_RULE_IDS`。
 *
 * 本模块是**纯函数**：不读配置文件、不看环境变量。调用方（daemon 启动路径）
 * 负责把操作者配置读进来，然后一次性算出规则表并冻结。
 */

import type { FileRule } from './rules.ts';
import { HARD_DENY_RULES, SEARCH_EXCLUDE_RULES, validateRuleAddition } from './rules.ts';

/**
 * 永远不可豁免的规则。
 *
 * `HD-PLUGIN-STATE` 是 I13 的落点：插件自身的密钥、审批状态库与恢复快照目录
 * 对模型不可读取。若这条规则可以被本地配置豁免，那么「永久不可挂载」就变成了
 * 「默认不可挂载，改一行配置即可」——性质完全不同。
 *
 * 更根本的一点：那三个目录的内容即使泄露，后果也不是「某个项目的秘密泄露」，
 * 而是**整套授权机制失效**（审批状态库决定了什么算获批）。因此它不在
 * 可权衡的范围内。
 */
export const NON_EXEMPTABLE_RULE_IDS: readonly string[] = ['HD-PLUGIN-STATE'];

/** 一条具名豁免。`created_at` 是本地操作者写下它的时刻（ISO 字符串，仅审计）。 */
export interface OperatorExemption {
  /** 具名标识，出现在审计与规则表的 `except` 里。 */
  readonly id: string;
  /** 收窄哪一条规则。必须是既有规则的 id。 */
  readonly rule_id: string;
  /** 确切名字（不含 `*`），例如 `.env.example`。 */
  readonly name: string;
  /** 为什么这个洞是安全的。必须写，理由同规则本身。 */
  readonly rationale: string;
  readonly created_at: string;
}

/** 豁免被拒绝的原因。返回 null 表示接受。 */
export function validateExemption(ex: OperatorExemption, rules: readonly FileRule[]): string | null {
  const rule = rules.find((r) => r.id === ex.rule_id);
  if (rule === undefined) {
    return `豁免 ${ex.id} 指向不存在的规则 ${ex.rule_id}；豁免不能凭空造出一条规则`;
  }
  if (NON_EXEMPTABLE_RULE_IDS.includes(ex.rule_id)) {
    return `规则 ${ex.rule_id} 不可豁免（I13：密钥、审批状态库与恢复快照目录对模型永远不可读取）`;
  }
  if (ex.name.includes('*') || ex.name.includes('/') || ex.name.includes('\\')) {
    return `豁免 ${ex.id} 的名字必须是单个确切名字（不含通配符与路径分隔符）：${JSON.stringify(ex.name)}`;
  }
  if (ex.name.trim().length === 0) {
    return `豁免 ${ex.id} 的名字不能为空`;
  }
  if (ex.rationale.trim().length < 8) {
    return `豁免 ${ex.id} 必须写清理由（至少 8 个字）`;
  }
  if (!rule.patterns.some((p) => matchesName(p, ex.name))) {
    return `豁免 ${ex.id} 的名字 ${ex.name} 本来就不被 ${ex.rule_id} 命中；这条豁免没有意义，请删掉它`;
  }
  return null;
}

/** 与 `rules.ts` 的段匹配同一套规则（此处只需判断「这条豁免是否真的有用」）。 */
function matchesName(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  if (!p.includes('*')) return p === n;
  const parts = p.split('*');
  if (parts.length !== 2) return false;
  const [head, tail] = parts as [string, string];
  return n.length >= head.length + tail.length && n.startsWith(head) && n.endsWith(tail);
}

export interface AppliedOverrides {
  readonly rules: readonly FileRule[];
  /** 实际生效的豁免（通过校验的那些）。 */
  readonly applied: readonly OperatorExemption[];
  /** 被拒绝的豁免与原因。**不静默丢弃**：拒绝的豁免要能被看见。 */
  readonly rejected: readonly { readonly exemption: OperatorExemption; readonly reason: string }[];
  /** 本次是否动过硬拒绝集合。 */
  readonly touched_hard_deny: boolean;
}

/**
 * 把豁免套用到规则表上，得到一份**新**的、冻结的规则表。
 *
 * 注意产出里硬拒绝规则仍然是原来那些**对象**的副本，只是 `patterns` 旁多了
 * `except`。既没有新增硬拒绝规则，也没有删除任何一条 —— 唯一的变化是
 * 若干确切名字从某些模式里被摘了出去。
 */
export function applyExemptions(
  exemptions: readonly OperatorExemption[],
  base: { readonly hard_deny?: readonly FileRule[]; readonly search_exclude?: readonly FileRule[] } = {},
): AppliedOverrides {
  const hard = base.hard_deny ?? HARD_DENY_RULES;
  const exclude = base.search_exclude ?? SEARCH_EXCLUDE_RULES;

  const all: readonly FileRule[] = [...hard, ...exclude];

  const applied: OperatorExemption[] = [];
  const rejected: { exemption: OperatorExemption; reason: string }[] = [];
  const exceptByRule = new Map<string, string[]>();

  for (const ex of exemptions) {
    const reason = validateExemption(ex, all);
    if (reason !== null) {
      rejected.push({ exemption: ex, reason });
      continue;
    }
    applied.push(ex);
    const list = exceptByRule.get(ex.rule_id) ?? [];
    // 同名重复豁免：幂等，不重复追加。
    if (!list.some((n) => n.toLowerCase() === ex.name.toLowerCase())) list.push(ex.name);
    exceptByRule.set(ex.rule_id, list);
  }

  const stamp = (rule: FileRule): FileRule => {
    const extra = exceptByRule.get(rule.id);
    if (extra === undefined) return rule;
    // 合并规则自带的 `except`（例如代码里写死的那条），而不是覆盖它 ——
    // 覆盖会让操作者配置的豁免顺手抹掉代码里的豁免意图。
    const merged = [...(rule.except ?? [])];
    for (const name of extra) {
      if (!merged.some((n) => n.toLowerCase() === name.toLowerCase())) merged.push(name);
    }
    return { ...rule, except: merged };
  };

  const touched = applied.some((ex) => hard.some((r) => r.id === ex.rule_id));

  return {
    rules: Object.freeze([...hard.map(stamp), ...exclude.map(stamp)]),
    applied,
    rejected,
    touched_hard_deny: touched,
  };
}

/** 操作者新增的自定义规则也必须过一遍同样的校验。 */
export function validateOperatorRules(rules: readonly FileRule[]): readonly string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const reason = validateRuleAddition(rule);
    if (reason !== null) {
      problems.push(`${rule.id}：${reason}`);
      continue;
    }
    if (seen.has(rule.id)) problems.push(`${rule.id}：id 重复`);
    seen.add(rule.id);
  }
  return problems;
}
