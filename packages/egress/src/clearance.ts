/**
 * 出站凭证：**内容离开本机的唯一通道**（LWB-011 步骤 3、验收标准 1）。
 *
 * ## 这个模块要解决的问题
 *
 * 「禁止文件不会通过搜索片段或 Git diff 旁路返回」这句话，如果靠约定来保证，
 * 它的实际含义是「所有出站的地方都记得调用过滤器」。而事实是：读取、搜索、
 * Git 差异、历史快照、错误详情、审计导出 —— 六个面，六处调用点，每一处都是
 * 一个未来会新增第七个面的地方。少调一次，策略就少一次生效，而**没有任何
 * 测试会失败**，因为少调的那次不报错，它只是安静地把内容发出去了。
 *
 * 所以这里不做「过滤器」，做**闸门**：
 *
 *  1. `emitContent()` 是唯一的出口。想送内容出去，就必须交出凭证与路径。
 *  2. 闸门**自己重新判定那条路径**，不采信调用方「这个文件我查过了」的说法。
 *     搜索走到一半漏掉了硬拒绝检查？闸门在这里再拒一次。
 *  3. 凭证由 `mintClearance()` 从**已登记的**判定结果铸出，且记在模块私有的
 *     WeakSet 里。手搓一个长得一样的对象进不来。
 *  4. 被判定为 `block` 的面（搜索片段、Git 差异、快照、错误、审计导出）
 *     拿不到「脱敏放行」这条出路 —— 处置方式存在凭证里，调用方改不了。
 *
 * ## 一句必须写下来的诚实
 *
 * 这些是**进程内**的自洽检查。它们保证「内容不会绕过判定离开」，**不**保证
 * 「判定所依据的输入是真的」—— 后者是 IPC 凭据与连接记录那一层的责任。
 * 进程内的检查写得再严，也替代不了鉴权；把它当成鉴权用，才是真正危险的事。
 */

import { createHash } from 'node:crypto';
import type { BridgeErrorCode } from '@lwb/contracts';
import { BridgeError } from '@lwb/contracts';
import type { EgressObligations, EgressSurface, PolicyDecision } from '@lwb/policy';
import { classifyFile, isIssuedDecision } from '@lwb/policy';
import type { EgressBudget } from './budget.ts';
import type { SecretFinding } from './secrets.ts';
import { redact, screenText } from './secrets.ts';

/** 只有 `mintClearance` 铸出的对象在这里。 */
const CLEARANCES = new WeakSet<object>();
/** 每个已出站载荷属于哪张凭证。用来防止「A 的凭证 + B 的载荷」拼起来。 */
const EMISSION_OWNER = new WeakMap<object, object>();
/** 每张凭证的污染记录。脱敏过内容的凭证，不再具备签发可编辑票据的资格。 */
const TAINT = new WeakMap<object, { readonly redactions: number; readonly block_count: number }>();
/** 每张票据由哪张凭证签发。用于在**使用票据的那一刻**复查污染状态。 */
const TICKET_OWNER = new WeakMap<object, object>();

/**
 * 预算耗尽时**仍然放行**的出站面，以及放行的大小上限。
 *
 * 为什么需要有这么一个例外：如果预算耗尽连「预算耗尽」这条错误都发不出去，
 * 调用方看到的是连接断开或超时，而真正的原因永远到不了 —— 那不是收紧，
 * 是让人无法诊断，于是一个可解释的限额变成了一个说不清的故障。
 *
 * 上限是必须的：没有上限的话，`error_detail` 就成了一条不受预算约束的
 * 无限通道，而「错误详情里能不能夹带正文」正是本模块要防的事。
 * 8 KiB 足够装下任何一条合规的错误载荷（方案 §6.6 要求它不含路径与正文）。
 */
const BUDGET_EXEMPT_SURFACES: readonly EgressSurface[] = ['error_detail'];
const BUDGET_EXEMPT_MAX_BYTES = 8 * 1024;

export interface Clearance {
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly generation: number;
  readonly action: string;
  readonly surface: EgressSurface;
  readonly obligations: EgressObligations;
  /**
   * 判定时使用的规则表。出站重判用的是**同一份对象**，
   * 因此不可能出现「判定时用新规则、出站时用旧规则」这种时间差。
   */
  readonly rules: PolicyDecision['rules'];
}

export interface MintContext {
  readonly connection_id: string;
  /** 凭证绑定的工作区代次；代次变化后旧凭证不得再用。 */
  readonly generation: number;
}

/**
 * 从一次**允许**的判定结果铸出凭证。
 *
 * 拒绝两种情形，且都是抛错而不是返回 null：它们都是调用方的 bug，
 * 不是「用户遇到了一个拒绝」。静默返回 null 会让这些 bug 变成一个
 * 空响应，然后被当成「文件是空的」。
 */
export function mintClearance(decision: PolicyDecision, context: MintContext): Clearance {
  if (!isIssuedDecision(decision)) {
    throw new Error(
      '出站凭证只能由 @lwb/policy 的 decide() 产出的判定结果铸出；' +
        '这个对象不是。手搓的判定结果不能换来出站资格。',
    );
  }
  if (!decision.allow) {
    throw new Error(
      `不允许的操作不能获得出站凭证：${decision.primary?.reason ?? 'unknown'}（${decision.context.action}）`,
    );
  }

  const clearance: Clearance = Object.freeze({
    connection_id: context.connection_id,
    workspace_id: decision.context.workspace_id,
    generation: context.generation,
    action: decision.context.action,
    surface: decision.context.surface,
    obligations: decision.obligations,
    rules: decision.rules,
  });
  CLEARANCES.add(clearance);
  TAINT.set(clearance, { redactions: 0, block_count: 0 });
  return clearance;
}

export interface EgressChunk {
  /**
   * 工作区**相对**路径。闸门用它重新判定。
   *
   * 不接受绝对路径：这一层的规则全部是按相对路径逐段匹配的，
   * 给它一个绝对路径只会让 `C:\Users\me\.env` 里的 `Users`、`me` 参与匹配，
   * 而 `HD-ENV` 命中的 `.env` 恰好还在，于是"看起来能用"——
   * 一个看起来能用但匹配语义已经跑偏的接口，比一个明确不接受绝对路径的接口危险得多。
   */
  readonly path: string;
  readonly content: string;
}

export interface Emission {
  readonly path: string;
  readonly surface: EgressSurface;
  readonly content: string;
  readonly bytes: number;
  readonly redacted: boolean;
  /** 命中的规则 id 与位置。**不含任何被命中的内容。** */
  readonly findings: readonly SecretFinding[];
  /** 本次实际记账的字节数（= 出站后的字节数，不是脱敏前的）。 */
  readonly charged_bytes: number;
  readonly budget_remaining_bytes: number | null;
}

function assertRelativePath(path: string): void {
  if (path.includes('\\')) {
    throw new BridgeError('PATH_UNSAFE', '出站闸门只接受 `/` 分隔的工作区相对路径。', { reason: 'BACKSLASH' });
  }
  if (/^[A-Za-z]:/.test(path) || path.startsWith('/') || path.startsWith('//')) {
    throw new BridgeError('PATH_UNSAFE', '出站闸门只接受工作区相对路径，不接受绝对路径或 UNC 路径。', {
      reason: 'ABSOLUTE',
    });
  }
}

/**
 * 内容出站的**唯一**入口。
 *
 * 顺序是有讲究的，每一步都在前一步失败时不留下痕迹：
 *
 *  1. 凭证必须是本模块铸出的（否则是调用方的 bug）
 *  2. 路径形态必须是工作区相对路径
 *  3. **重新判定路径**（硬拒绝在这里再拦一次）
 *  4. 秘密筛查 → 阻断或脱敏
 *  5. 预算检查 → **通过之后才记账**，被拒的出站不消耗额度
 *  6. 返回
 *
 * 第 5 步必须在最后：如果先记账再筛查，一个反复被秘密阻断的请求会把用户的
 * 出站额度耗光，而它一个字节都没送出去。
 */
export function emitContent(clearance: Clearance, chunk: EgressChunk, budget: EgressBudget): Emission {
  if (!CLEARANCES.has(clearance)) {
    throw new Error('出站凭证不是由 mintClearance() 铸出的；拒绝出站。');
  }
  assertRelativePath(chunk.path);

  // 3. 重新判定。**不采信调用方的说法。** 即使上层已经判过一次，
  //    这里也再判一次 —— 这两次调用是同一份纯函数、同一份规则表，
  //    因此不可能"打架"；它的价值在于堵住「上层忘了判」。
  const verdict = classifyFile(chunk.path, clearance.rules);
  if (verdict.kind === 'hard_deny') {
    const taint = TAINT.get(clearance);
    if (taint) TAINT.set(clearance, { ...taint, block_count: taint.block_count + 1 });
    throw new BridgeError(
      'POLICY_DENIED',
      `该路径命中硬拒绝规则 ${verdict.rule_id}，不会经任何出站面返回内容。`,
      { hard_deny_rule: verdict.rule_id, blocked_at: 'egress' },
    );
  }

  // 4. 秘密筛查。
  const screen = screenText(chunk.content);
  let outText = chunk.content;
  let redactedFlag = false;

  if (screen.has_certain && clearance.obligations.secret_mode === 'block') {
    const rules = screen.findings.filter((f) => f.tier === 'certain').map((f) => f.rule_id);
    const taint = TAINT.get(clearance);
    if (taint) TAINT.set(clearance, { ...taint, block_count: taint.block_count + 1 });
    throw new BridgeError(
      'SECRET_DETECTED',
      '该内容被判定为高置信度凭证，已在出站前整块阻断；不会返回其中任何片段。',
      { secret_rules: rules.join(','), surface: clearance.surface, blocked_at: 'egress' },
    );
  }

  if (screen.findings.length > 0) {
    const result = redact(chunk.content, screen);
    outText = result.text;
    redactedFlag = true;
    const taint = TAINT.get(clearance) ?? { redactions: 0, block_count: 0 };
    TAINT.set(clearance, { redactions: taint.redactions + 1, block_count: taint.block_count });
  }

  // 5. 预算。按**实际出站**的字节记账（脱敏后更短，就按更短的记 ——
  //    计的是真的送出去的字节，不是差点送出去的字节）。
  const bytes = Buffer.byteLength(outText, 'utf8');
  let charged = 0;
  let remaining: number | null = null;

  const verdictBudget = budget.charge(bytes);
  if (!verdictBudget.ok) {
    const exempt = BUDGET_EXEMPT_SURFACES.includes(clearance.surface) && bytes <= BUDGET_EXEMPT_MAX_BYTES;
    if (!exempt) {
      throw new BridgeError(
        'EGRESS_BUDGET_EXCEEDED',
        verdictBudget.reason === 'SINGLE_REQUEST_EXCEEDS_LIMIT'
          ? '单次出站内容超过该连接每小时的出站预算上限。'
          : '该连接的出站内容预算已用尽，需本地操作者调整。',
        {
          used_bytes: verdictBudget.used_bytes,
          limit_bytes: verdictBudget.limit_bytes,
          requested_bytes: verdictBudget.requested_bytes,
          reason: verdictBudget.reason,
        },
      );
    }
    // 放行但**不记账**：额度已经没了，记一笔负余额只会让后续诊断更难看懂。
  } else {
    charged = bytes;
    remaining = verdictBudget.remaining_bytes;
  }

  const emission: Emission = Object.freeze({
    path: chunk.path,
    surface: clearance.surface,
    content: outText,
    bytes,
    redacted: redactedFlag,
    findings: screen.findings,
    charged_bytes: charged,
    budget_remaining_bytes: remaining,
  });
  EMISSION_OWNER.set(emission, clearance);
  return emission;
}

// ---------------------------------------------------------------------------
// 可编辑票据
// ---------------------------------------------------------------------------

/**
 * 可编辑票据：`change_prepare` 必须出示它。
 *
 * 存在的意义只有一个 —— **把「脱敏过的读取不能变成写入」从一条约定
 * 变成一道门**。约定是「读到 redacted 时记得把 editable 设成 false」；
 * 门是「脱敏过的凭证铸不出票据，于是根本拿不到能进 change_prepare 的东西」。
 */
export interface EditTicket {
  readonly workspace_id: string;
  readonly path: string;
  readonly generation: number;
  /** 出站内容的 SHA-256。写入必须绑定的就是这一份内容（I06/I07）。 */
  readonly content_sha256: string;
  readonly issued_at: number;
}

export interface EditTicketContext {
  readonly now: number;
}

/**
 * 为一次已出站的载荷铸可编辑票据。
 *
 * 返回 `null` 是一个**正常结果**，不是错误：它表示「这次读取的内容被脱敏过，
 * 因此不能用于编辑」。调用方据此把 `editable` 置为 false 并把原因写进
 * `editable_blockers`。
 *
 * 抛错的情形只有两种，都是调用方用错了 API：凭证不是本模块的、
 * 或载荷不是这张凭证发出的。
 */
export function mintEditTicket(
  clearance: Clearance,
  emission: Emission,
  context: EditTicketContext,
): EditTicket | null {
  if (!CLEARANCES.has(clearance)) {
    throw new Error('出站凭证不是由 mintClearance() 铸出的；拒绝签发可编辑票据。');
  }
  if (EMISSION_OWNER.get(emission) !== clearance) {
    throw new Error('该载荷不是这张出站凭证发出的；不能用另一张凭证的载荷换取可编辑票据。');
  }

  // 「脱敏结果不得获得可编辑票据」是硬编码的，不是策略开关。
  // 两道判据（本凭证脱敏过 / 本载荷被脱敏过）都查，因为一次读取可能
  // 分多次出站，而污染是记在凭证上的。
  const taint = TAINT.get(clearance);
  if (taint !== undefined && taint.redactions > 0) return null;
  if (emission.redacted) return null;
  if (emission.findings.length > 0) return null;

  const ticket: EditTicket = Object.freeze({
    workspace_id: clearance.workspace_id,
    path: emission.path,
    generation: clearance.generation,
    content_sha256: createHash('sha256').update(emission.content, 'utf8').digest('hex'),
    issued_at: context.now,
  });
  TICKET_OWNER.set(ticket, clearance);
  return ticket;
}

/**
 * `change_prepare` 入口处调用：票据必须真的是本模块签发的。
 *
 * **在"使用票据"这一刻复查污染状态**，而不是只在签发时查一次。
 * 差别在于：一次读取可能分多次出站（分页、多个片段），先出去的干净片段
 * 拿到了票据，随后出去的片段命中秘密被脱敏 —— 只查签发时的话，
 * 那张早先发出的票据仍然有效，而它所属的文件里已经确认有秘密。
 * 复查把这条时差关掉：票据的有效性跟着凭证走，凭证一被污染就作废。
 *
 * 拒绝码用 `READ_TOKEN_STALE` —— 契约里它的说明是「读取票据已失效
 * （过期、跨工作区或版本不符）」，与「这不是一张有效票据」同义，
 * 且 `autoRetry: refetch` 正好是模型该做的事：重新读一次。
 */
export function assertEditTicket(value: unknown): EditTicket {
  if (typeof value !== 'object' || value === null) {
    throw new BridgeError('READ_TOKEN_STALE', '可编辑票据无效；请重新读取该文件。', { reason: 'TICKET_NOT_ISSUED' });
  }
  const owner = TICKET_OWNER.get(value);
  if (owner === undefined) {
    throw new BridgeError('READ_TOKEN_STALE', '可编辑票据不是本服务签发的；请重新读取该文件。', {
      reason: 'TICKET_NOT_ISSUED',
    });
  }
  const taint = TAINT.get(owner);
  if (taint !== undefined && taint.redactions > 0) {
    throw new BridgeError('READ_TOKEN_STALE', '该次读取的内容已被脱敏，票据已作废；请重新读取。', {
      reason: 'TICKET_TAINTED',
    });
  }
  return value as EditTicket;
}

/** 诊断用：这张凭证被脱敏/阻断过几次。**不返回任何内容。** */
export function clearanceTaint(clearance: Clearance): { readonly redactions: number; readonly block_count: number } {
  return TAINT.get(clearance) ?? { redactions: 0, block_count: 0 };
}

/** 给上层拼 `editable_blockers` 用的稳定文案。 */
export function editableBlockerFor(ticket: EditTicket | null, emission: Emission): string | null {
  if (ticket !== null) return null;
  if (emission.redacted) return '内容因敏感信息策略被脱敏，脱敏结果不能用于编辑。';
  return '本次读取未获得可编辑票据。';
}

export function isEgressErrorCode(code: string): code is BridgeErrorCode {
  return code === 'POLICY_DENIED' || code === 'SECRET_DETECTED' || code === 'EGRESS_BUDGET_EXCEEDED';
}
