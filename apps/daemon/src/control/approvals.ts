/**
 * 批准控制操作（LWB-021 步骤 1、3 的落地）。
 *
 * ## 三个操作，为什么是这三个
 *
 * | 操作 | 类别 | 它做什么 |
 * | --- | --- | --- |
 * | `approvals.list` | 只读 | 列出本机最近给出的批准，连带目标修改集当前的状态 |
 * | `approvals.reject` | 变更 | 拒绝一个待批准的修改集（终态） |
 * | `approvals.approve_and_apply` | 变更 | 记录批准并排队（方案 §10.2 的主按钮） |
 *
 * 三者对应方案 §10.2 的三个动作，而**不是一个带 `action` 参数的接口**：
 * 变更类与只读类在控制平面上是两种不同的路由（前者要一次性 nonce），
 * 用一个参数来切换会让「这一次调用要不要 nonce」变成一个运行时判断 ——
 * 而它现在是注册期就定死的事实（`control-plane.ts` 的分类清单）。
 *
 * ## 「仅批准」为什么不在这张表上
 *
 * LWB-021 步骤 3 要求「批准并应用入口」**与**「仅批准内部接口」。
 * 后者是 `@lwb/approvals` 的 `approveChange()`：一个只记批准、不排队的动作。
 * 它**不**挂到控制平面上，理由不是「用不上」，而是控制台上如果有一个
 * 「批准但不应用」的按钮，操作者点下去会得到一个 `APPROVED` 且**永远不会
 * 被执行**的修改集 —— 界面显示「已批准」，队列里什么都没有。
 * 那个状态没有任何一条路径会推进它，而人不会去查一个看起来成功的动作。
 *
 * 内部接口的调用方是执行协调器（LWB-026）与撤销流程（LWB-024）：
 * 它们需要在**没有**排队这个动作的前提下记录批准。
 *
 * ## 权限：两道，且都不是「本机所以放行」
 *
 * 第一道是能力表：`approvals.decide` 不在 `CAPABILITIES_BY_AUDIENCE['mcp-adapter']`
 * 里，且写在 `NEVER_GRANTED_TO_MODEL` 上。适配器算不出这条 audience 的
 * 握手证明，因此这不是一条 `if` 判断，是密码学上的不可用。
 *
 * 第二道是 `requireLocalConsole`：挡的是**接线错误** —— 有人把这些操作
 * 注册进了适配器那份注册表。它与 `connections.ts` 的同类函数是同一种东西，
 * 但没有共用：那里拒绝的是「不是控制台」（对一条没有磁盘对象的连接做判断），
 * 这里拒绝的是「不是本机的人」。两句话恰好由同一个判据表达，而它们
 * 属于两个不同的理由集合 —— 合并会让将来只改一处的人以为另一处也被改了。
 *
 * ## 审计的先后顺序（与 `workspaces.ts` / `connections.ts` 同）
 *
 * 先改状态、后写审计，两步各在自己的事务里。窗口的后果**可自证**：
 * `approvals.list` 会如实回报状态，操作者能看到它确实变了。
 * 「可自证」是这里不把它包成一个事务的理由 —— 见 `connections.ts` 文件头
 * 对这条取舍的完整说明。
 */

import { BridgeError } from '@lwb/contracts';
import type { OperationDefinition, OperationRegistry, RequestContext } from '@lwb/ipc';
import { screenMetadata } from '@lwb/audit';
import { approveAndQueue, effectiveApprovalState, rejectChange } from '@lwb/approvals';
import { shortCodeOf } from '@lwb/changes';
import type { ApprovalWithChange, Repositories } from '@lwb/persistence';

import { originOf } from './workspaces.ts';

/** 批准控制操作统一要求的能力。**不授予模型侧**（`NEVER_GRANTED_TO_MODEL` 里逐条钉住）。 */
export const APPROVALS_DECIDE_CAPABILITY = 'approvals.decide' as const;

// ---------------------------------------------------------------------------
// 入参解析
// ---------------------------------------------------------------------------

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BridgeError('INVALID_ARGUMENT', '批准操作需要一个对象参数。');
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BridgeError('INVALID_ARGUMENT', `字段 ${field} 必须是非空字符串。`);
  }
  return value;
}

/**
 * 摘要必须**原样**是一个 64 位十六进制串。
 *
 * 不做 trim、不做大小写归一：摘要是一个精确值，而「顺手容错」在这里的
 * 后果是把一个**不同的**输入当成同一个。形状检查只挡明显不是摘要的东西
 * （空串、从界面复制时带上的换行），真正的比对在 `@lwb/approvals` 里 ——
 * 那里比的是重算出来的值，不是这个形状。
 */
function requireDigest(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new BridgeError('INVALID_ARGUMENT', `字段 ${field} 必须是 64 位十六进制摘要。`);
  }
  return text;
}

/**
 * 只有本地控制台可以批准或拒绝。
 *
 * 见文件头：这是**第二道**，第一道是能力表。
 *
 * 返回的是**审批身份**（`actor`）。它是 `context.connection_id`，而不是从
 * 入参里读来的任何一个字段（ADR-003 §4）：控制平面路由在调用处理器之前
 * 把 `connection_id` 设成 `console:<session_id>`（见 `routes.ts`），
 * 因此这个值表达的是「哪个已鉴权的本机会话」，入参无从影响它。
 * 本模块的入参里也**没有**位置可以放下 `user_id` / `session_id` /
 * `conversation_label` —— 它们连被读一次的机会都没有。
 */
function requireLocalConsole(context: RequestContext): string {
  if (originOf(context) !== 'local_console') {
    throw new BridgeError('NOT_AUTHORIZED', '只有本地控制台可以批准或拒绝修改集。', {
      reason: 'ORIGIN_NOT_LOCAL',
    });
  }
  return context.connection_id;
}

// ---------------------------------------------------------------------------
// 回报字段
// ---------------------------------------------------------------------------

/**
 * 回给控制台的批准描述。
 *
 * **刻意不含 `actor` 之外的任何身份信息**，也**不含**修改集的内容：
 * 文件列表与差异属于修改集视图（LWB-023 的 `ChangesView`），
 * 让批准接口顺带把它们带出来，会让「批准页显示的内容」有第二个来源 ——
 * 而两个来源就有两种不一致。
 *
 * `short_code` 由完整摘要派生（`shortCodeOf`），只供人眼比对。
 * 它**不是**凭证，也不得用于任何判定 —— 放行读的永远是完整摘要。
 */
function describeApproval(entry: ApprovalWithChange, now: string): Record<string, unknown> {
  const { approval, change_state } = entry;
  return {
    approval_id: approval.id,
    change_id: approval.change_id,
    digest: approval.digest,
    short_code: shortCodeOf(approval.digest),
    // **有效**状态：`ACTIVE` 但已到期的，在这里读作 `EXPIRED`。
    // 与执行前门禁用的是同一个函数，因此界面上显示的与门禁判定的一致。
    state: effectiveApprovalState(approval, now),
    /** 库里的原始状态。与 `state` 不同即表示「已到期但尚未被归一化」。 */
    stored_state: approval.state,
    actor: approval.actor,
    root_generation: approval.root_generation,
    policy_version: approval.policy_version,
    expires_at: approval.expires_at,
    created_at: approval.created_at,
    consumed_by: approval.consumed_by,
    /** 目标修改集**当前**的状态：批准还在、目标却已失效，是排障时最要紧的组合。 */
    change_state,
  };
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

export interface ApprovalOperationsDeps {
  readonly repos: Repositories;
  /** 判定时刻。省略取当前时间；测试注入固定时刻。 */
  readonly now?: () => string;
}

/** 把一次决定写进审计。见文件头：「先改状态、后写审计」。 */
function recordDecision(
  repos: Repositories,
  input: {
    readonly action: string;
    readonly connection_id: string;
    readonly change_id: string;
    readonly digest: string;
    readonly state: string;
    /**
     * 触发本次决定的那个请求。它**必须**带上：审计行与请求是两份记录，
     * 没有它，一条「谁批准了什么」的记录无法与产生它的那次调用对上 ——
     * 而「这次批准是哪一次点击」正是排障时第一个要问的问题。
     * 它来自 `RequestContext`（已鉴权的通道），不是入参。
     */
    readonly request_id: string;
    readonly extra?: Readonly<Record<string, string | number | boolean | null>>;
  },
): void {
  repos.audit.append({
    subject: input.change_id,
    action: input.action,
    outcome: 'allow',
    connection_id: input.connection_id,
    change_id: input.change_id,
    request_id: input.request_id,
    metadata: screenMetadata({
      // 短核对编号而不是完整摘要：完整摘要虽然本身不是凭证，但它是
      // 「哪一份内容」的精确指纹，而审计要回答的是「谁在什么时候对
      // 哪一个修改集做了什么」。短编号足够把这条记录与界面上的那一份对上。
      short_code: shortCodeOf(input.digest),
      change_state: input.state,
      // **没有** `decision_by`：决定者是谁已经写在 `connection_id` 列上
      // （值是 `console:<session_id>`），再往 metadata 里放一份等于同一个
      // 事实有两个来源 —— 而两个来源就会有两种不一致。
      ...(input.extra ?? {}),
    }),
  });
}

export function registerApprovalOperations(
  registry: OperationRegistry,
  deps: ApprovalOperationsDeps,
): void {
  const now = (): string => deps.now?.() ?? new Date().toISOString();

  const definitions: OperationDefinition[] = [
    {
      name: 'approvals.list',
      required: APPROVALS_DECIDE_CAPABILITY,
      handler: (input, context) => {
        requireLocalConsole(context);
        const body = input === undefined || input === null ? {} : asRecord(input);
        const limit = body['limit'];
        if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit))) {
          throw new BridgeError('INVALID_ARGUMENT', '字段 limit 必须是整数。');
        }
        const at = now();
        return {
          approvals: deps.repos.approvals
            .listRecent(typeof limit === 'number' ? limit : 50)
            .map((entry) => describeApproval(entry, at)),
          // 读取时刻一并回报：`state` 是相对于它投影出来的，
          // 不给出它，界面上那个 `EXPIRED` 就没有参照系。
          observed_at: at,
        };
      },
    },

    {
      name: 'approvals.reject',
      required: APPROVALS_DECIDE_CAPABILITY,
      handler: (input, context) => {
        const actor = requireLocalConsole(context);
        const body = asRecord(input);
        const changeId = requireString(body['change_id'], 'change_id');
        const digest = requireDigest(body['digest'], 'digest');

        const change = rejectChange({
          repos: deps.repos,
          change_id: changeId,
          digest,
          actor,
          now: now(),
        });

        recordDecision(deps.repos, {
          action: 'change.reject',
          connection_id: actor,
          change_id: changeId,
          digest,
          state: change.state,
          request_id: context.request_id,
        });

        return { change_id: change.id, state: change.state, digest, short_code: shortCodeOf(digest) };
      },
    },

    {
      name: 'approvals.approve_and_apply',
      required: APPROVALS_DECIDE_CAPABILITY,
      handler: (input, context) => {
        const actor = requireLocalConsole(context);
        const body = asRecord(input);
        const changeId = requireString(body['change_id'], 'change_id');
        const digest = requireDigest(body['digest'], 'digest');
        const key = body['idempotency_key'];
        if (key !== undefined && (typeof key !== 'string' || key.length === 0)) {
          throw new BridgeError('INVALID_ARGUMENT', '字段 idempotency_key 若给出必须是非空字符串。');
        }

        const result = approveAndQueue({
          repos: deps.repos,
          change_id: changeId,
          digest,
          actor,
          now: now(),
          idempotency_key: typeof key === 'string' ? key : null,
        });

        recordDecision(deps.repos, {
          action: 'change.approve_and_apply',
          connection_id: actor,
          change_id: changeId,
          digest,
          state: result.change.state,
          request_id: context.request_id,
          extra: {
            approval_id: result.approval.id,
            operation_id: result.operation.id,
            operation_existed: result.operation_existed,
            // 复用既有的 `workspace_generation` 而不是新加一个 `root_generation`：
            // 批准记录的 `root_generation` 按定义就是授权那一刻的工作区代次
            // （`ApprovalsRepo.create` 把它从 `changesets` 复制过来），
            // 同一个事实不该有两个键名。
            workspace_generation: result.approval.root_generation,
            policy_version: result.approval.policy_version,
          },
        });

        return {
          change_id: result.change.id,
          state: result.change.state,
          operation_id: result.operation.id,
          operation_state: result.operation.state,
          approval_id: result.approval.id,
          approval_expires_at: result.approval.expires_at,
          digest,
          short_code: shortCodeOf(digest),
          // 「本次没有写入任何用户文件」是**结构性**的事实而不是承诺：
          // 写执行协调器还没有装配（LWB-026），而这个操作只做状态变更。
          workspace_modified: false as const,
          next_action:
            '修改集已批准并排队，**尚未写入任何文件**。写入由本机执行协调器在开始前重新校验批准有效期与所有代次后进行。',
        };
      },
    },
  ];

  for (const definition of definitions) registry.register(definition);
}

/** 供装配与测试核对：本模块注册的操作名。 */
export const APPROVAL_OPERATION_NAMES: readonly string[] = [
  'approvals.list',
  'approvals.reject',
  'approvals.approve_and_apply',
];
