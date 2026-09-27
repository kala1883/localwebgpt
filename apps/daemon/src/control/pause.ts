/**
 * 紧急停用的控制操作（LWB-034 步骤 1 与步骤 3 的落地）。
 *
 * ## 为什么这一个按钮需要一条控制操作
 *
 * `packages/executor/src/pause.ts` 提供了机制（落库、中止、废止、报状态），
 * 但机制不等于有人拉得动它。与 LWB-018 给连接撤权补上 `connections.pause`
 * 是同一个理由：一条只能由测试触发的紧急停用，其验收证据是
 * 「机制成立，但按不下去」—— 那不足以证明停用可用。
 *
 * ## 三个只读/变更的判定，各自单独写过理由
 *
 * | 操作 | 分类 | 理由（一句话） |
 * | --- | --- | --- |
 * | `service.pause` | 变更 | 它写 `service_pause` 那一行，并**顺带作废**全部排队授权 |
 * | `service.resume` | 变更 | 它写同一行。改得少不等于没改 —— 判据是写不写库 |
 * | `service.pause_status` | 只读 | 它只读四张表。那个全表 `COUNT(*)` 是**读**的代价，不是一次状态变更 |
 *
 * 三条都写在 `control-plane.ts` 的清单里（那是装配期会断言的唯一来源），
 * 这里重复一遍是因为**读这一段的人多半正在决定要不要再加一条操作**。
 *
 * ## 变更类操作要一次性 nonce，而这里是它最要紧的一处
 *
 * 暂停必须是一次**有人真的按了**的动作。一个可以被重放的暂停请求，
 * 等于一个可以被重放的紧急按钮 —— 而重放一次「暂停」在功能上完全看不出来
 * （界面照样显示「已停用」）。nonce 在这里不是一层合规装饰。
 *
 * ## 参数：**只接受空对象**，多一个字段就拒
 *
 * 最省事的实现是把 body 收下、什么也不做。那是本工程反复拒绝的那种写法：
 * 一个没人读的参数**看起来**在做点什么。有人读到
 * `POST /api/service/pause {"reason": "…"}` 会合理地以为这个理由被记下来了，
 * 而它没有 —— 而且按迁移 v8 的注释，那个字段正是**最不该**存在的一个
 * （紧急时刻的「原因」通常就是一个本机路径，而自由文本落在与审计同一个文件里）。
 *
 * 因此违约是**显式**的拒绝，不是静默忽略。
 *
 * ## 审计里有什么、没有什么
 *
 * 有：四个计数（作废了几条、跳过几条、还剩几条待执行、几件写入正在停）
 * 与一个闭集枚举的失败原因（`reason`）。全是数字或枚举值。
 *
 * 没有：`persist_error` / `revoke_error` 的**原文**。理由不是隐私，
 * 是**机制**：SQLite 的错误消息里会带本机绝对路径
 * （`unable to open database file: D:\…`），而 `screenMetadata` 对绝对路径
 * 是**抛错**而不是丢弃。把原文塞进审计，会让一条本该记录
 * 「有人按过紧急停用」的记录**在落库失败的那一刻写不出来** ——
 * 而那正是最需要它的时刻。
 *
 * 原文去哪儿了：进 daemon 日志（`PauseNotice` → `on_notice`），
 * 并且**留在交回给控制台的响应里**（`revoke_message` / `persist_message`）。
 * 响应与审计的这份不对称是刻意的：响应是同一台机器上的操作者当场读一次，
 * 审计是一条要长期留存、并穿过那道筛查契约的记录。
 *
 * ## 两个失败，两种回答
 *
 *  - `revoke_error`：暂停**已经生效**（`paused` 是 1，在途写入已经停了），
 *    只是排队授权没全废掉。**照常返回**，把 `revoke_failed: true` 与
 *    「还剩几条」交给界面 —— 把它抛成错误会让一次部分成功看起来像一次失败，
 *    而失败那一侧恰好是危险的那一侧（操作者会以为「没停成」，再去按一次）。
 *  - `persist_error`：暂停**没有成为事实**。这条**抛**。但抛之前审计已经写了
 *    （见上），且错误详情里带着「实际发生了什么」——
 *    停止是真的发生了，重启之后不会被记得也是真的。
 */

import { BridgeError } from '@lwb/contracts';
import type { OperationDefinition, OperationRegistry, RequestContext } from '@lwb/ipc';
import { screenMetadata } from '@lwb/audit';
import type {
  PauseOutcome,
  PauseService,
  PauseStatus,
  PendingAuthorization,
  RecoveryOperation,
  StoppingWrite,
} from '@lwb/executor';
import type { Repositories } from '@lwb/persistence';

import { originOf } from './workspaces.ts';

/** 紧急停用控制操作统一要求的能力。**不授予模型侧**（`NEVER_GRANTED_TO_MODEL` 里逐条钉住）。 */
export const SERVICE_CONTROL_CAPABILITY = 'service.control' as const;

// ---------------------------------------------------------------------------
// 来源与入参
// ---------------------------------------------------------------------------

/**
 * 只有本地控制台可以暂停或恢复整个服务。
 *
 * 与 `connections.ts` 的 `requireLocalConsole` 是同一个判断，同样**不能共用**：
 * 两处抛的错误码/理由集合各自对应各自的对象类别，而这里多一层含义 ——
 * 它是**第二道**。第一道是能力表：`service.control` 不在
 * `CAPABILITIES_BY_AUDIENCE['mcp-adapter']` 里，因此适配器在握手时
 * 算不出这个证明。这一道挡的是接线错误（有人把这些操作注册进了
 * 适配器那份注册表）。
 *
 * 值得写下来的是：**即使模型侧有办法按到这个按钮，它也不该能按**。
 * 模型自己把服务停掉是一次拒绝服务，而它在工具面上的表现是
 * 「所有工具突然都返回 PAUSED」—— 使用者会去查一个不存在的问题。
 */
function requireLocalConsole(context: RequestContext): void {
  if (originOf(context) !== 'local_console') {
    throw new BridgeError('NOT_AUTHORIZED', '只有本地控制台可以暂停或恢复本地服务。', {
      reason: 'ORIGIN_NOT_LOCAL',
    });
  }
}

/**
 * 本次操作**不接受任何参数**。
 *
 * `null` / `undefined` / `{}` 都算空；多一个键就拒，理由见文件头。
 */
function requireEmptyBody(input: unknown, operation: string): void {
  if (input === null || input === undefined) return;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new BridgeError('INVALID_ARGUMENT', `${operation} 不接受参数。`);
  }
  const keys = Object.keys(input);
  if (keys.length > 0) {
    throw new BridgeError(
      'INVALID_ARGUMENT',
      `${operation} 不接受参数，但收到了 ${keys.join('、')}。` +
        '本操作刻意没有可写字段：紧急停用不记录自由文本原因（它会落进与审计同一个文件），' +
        '而一个被静默忽略的字段会让人以为它被记下来了。',
    );
  }
}

// ---------------------------------------------------------------------------
// 回报字段
// ---------------------------------------------------------------------------

/**
 * 一件正在停的写入。
 *
 * `holder_pid` 是**唯一**一处把进程号交给界面的地方，而它该在这里：
 * 操作者按下紧急停用之后紧接着要问的就是「哪个进程还在动」。它只出现在
 * 控制台这条通道上 —— 工具面（`bridge_status`）拿到的只有**计数**
 * （见 `BridgeStatusData.pause`），因此进程号不会经模型出站。
 */
function describeStopping(write: StoppingWrite): Record<string, unknown> {
  return {
    operation_id: write.operation_id,
    change_id: write.change_id,
    workspace_id: write.workspace_id,
    state: write.state,
    holder_pid: write.holder_pid,
    acquired_at: write.acquired_at,
    heartbeat_at: write.heartbeat_at,
    slot_blocked: write.slot_blocked,
  };
}

function describePending(auth: PendingAuthorization): Record<string, unknown> {
  return {
    change_id: auth.change_id,
    workspace_id: auth.workspace_id,
    state: auth.state,
    expires_at: auth.expires_at,
  };
}

function describeRecovery(operation: RecoveryOperation): Record<string, unknown> {
  return {
    operation_id: operation.operation_id,
    change_id: operation.change_id,
    // 空串表示**修改集那一行不在了**（见 `PauseService.status`）。
    // 不在这里把空串换成别的字面量：界面要能区分「查不到工作区」
    // 与「工作区 id 就叫这个」。
    workspace_id: operation.workspace_id,
  };
}

/**
 * 暂停的完整报告（`service.pause_status` 的返回值）。
 *
 * 四个数组原样返回，**不做分页**：这里的数量级是「这台机器上正在写的东西」
 * 与「还没被作废的排队授权」，正常是 0 ~ 个位数。给一张 0 行的表加一个
 * 游标，只会让界面多一条永远用不上的分支。
 */
function describeStatus(status: PauseStatus): Record<string, unknown> {
  return {
    paused: status.paused,
    paused_at: status.paused_at,
    updated_at: status.updated_at,
    stopping: status.stopping.map(describeStopping),
    unrevoked_change_sets: status.unrevoked_change_sets.map(describePending),
    recovery_operations: status.recovery_operations.map(describeRecovery),
    unrecallable_file_rows: status.unrecallable_file_rows,
  };
}

/**
 * 一次 `engage()` / `release()` 的结果。
 *
 * `revoke_failed` / `persist_failed` 是**布尔**，原文另放
 * `revoke_message` / `persist_message`（见文件头：审计与响应刻意不对称）。
 */
function describeOutcome(outcome: PauseOutcome): Record<string, unknown> {
  return {
    // 调用之前就已经停着。**四步仍然全部做过**（见 `PauseService.engage`），
    // 因此界面不能把这一位读成「什么也没发生」。
    already: outcome.already,
    revoked: outcome.revoked.map((item) => ({
      change_id: item.change_id,
      workspace_id: item.workspace_id,
      from: item.from,
      to: item.to,
      approval_id: item.approval_id,
      operation_id: item.operation_id,
    })),
    skipped: outcome.skipped.map((item) => ({
      change_id: item.change_id,
      reason: item.reason,
      current_state: item.current_state,
    })),
    revoke_failed: outcome.revoke_error !== null,
    revoke_message: outcome.revoke_error,
    persist_failed: outcome.persist_error !== null,
    persist_message: outcome.persist_error,
    status: describeStatus(outcome.status),
  };
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

/**
 * 一次停用/恢复的审计行。
 *
 * `subject` 用固定字面量 `local_service`：被作用的对象是**服务本身**，
 * 它没有 id。其余控制动作记的是被作用的对象（工作区 id、连接 id），
 * 工具调用记的是调用方 —— 三处取法不同不是不一致，而是「这条事件在讲谁」
 * 本来就不一样（同 `record.ts` 的说明）。
 *
 * 元数据**穿过**同一道筛查（`screenMetadata`），而不是「这里只写几个数字
 * 所以不必」。审计库的泄漏面等于整个状态库，而筛查的价值来自
 * 「每一个写元数据的调用点都要过它」—— 一处例外就是下一处例外的范本。
 */
function recordServiceEvent(
  repos: Repositories,
  action: 'service.pause' | 'service.resume',
  outcome: PauseOutcome,
): void {
  repos.audit.append({
    subject: 'local_service',
    action,
    // 落库失败 ⇒ 这次动作**没有成为事实**，因此它是一次 `error`，不是 `allow`。
    // 废止失败仍然是 `allow`：暂停生效了，只是它的一个子动作没做完
    // （`reason` 与 `unrevoked_changes` 把这件事写清楚）。
    outcome: outcome.persist_error === null ? 'allow' : 'error',
    error_code: outcome.persist_error === null ? null : 'PAUSED',
    metadata: screenMetadata({
      reason: failureReason(outcome),
      revoked_changes: outcome.revoked.length,
      skipped_changes: outcome.skipped.length,
      unrevoked_changes: outcome.status.unrevoked_change_sets.length,
      stopping_writes: outcome.status.stopping.length,
    }),
  });
}

/**
 * 失败原因的**闭集枚举**。原文不进审计（见文件头），因此这里必须是一个
 * 能独立读懂的说法 —— 而不是把消息截断到 200 字符。
 */
function failureReason(outcome: PauseOutcome): string | null {
  if (outcome.persist_error !== null && outcome.revoke_error !== null) {
    return 'PERSIST_AND_REVOKE_FAILED';
  }
  if (outcome.persist_error !== null) return 'PERSIST_FAILED';
  if (outcome.revoke_error !== null) return 'REVOKE_FAILED';
  return null;
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

export interface PauseOperationsDeps {
  readonly repos: Repositories;
  /**
   * 与协调器、工具面**同一个**实例（装配根只造一个）。
   *
   * 这一点是结构性的，不是约定：两个 `PauseService` 会造出两个互不知晓的
   * 中止信号，于是「按了停用但有一个执行者没停」成为可能。
   */
  readonly pause: PauseService;
}

/**
 * 注册全部紧急停用控制操作。
 *
 * 操作名与能力分段同名，理由同 `workspaces.ts` / `connections.ts`。
 */
export function registerPauseOperations(registry: OperationRegistry, deps: PauseOperationsDeps): void {
  const definitions: OperationDefinition[] = [
    {
      name: 'service.pause_status',
      required: SERVICE_CONTROL_CAPABILITY,
      handler: (input, context) => {
        requireLocalConsole(context);
        requireEmptyBody(input, 'service.pause_status');
        // 现值现算，不读任何缓存：这个接口的全部价值就是
        // 「此刻到底还剩几件在停」。
        return describeStatus(deps.pause.status());
      },
    },
    {
      name: 'service.pause',
      required: SERVICE_CONTROL_CAPABILITY,
      handler: (input, context) => {
        requireLocalConsole(context);
        requireEmptyBody(input, 'service.pause');
        const outcome = deps.pause.engage();
        // **先写审计，再决定抛不抛。** 顺序是刻意的：落库失败的时候
        // 「有人按过这个按钮」反而更重要，而一条先抛出去的错误会让这次
        // 审计根本来不及写。
        recordServiceEvent(deps.repos, 'service.pause', outcome);

        if (outcome.persist_error !== null) {
          // 暂停**没有成为事实**。详情里带的是「实际发生了什么」，
          // 而不是一句笼统的失败 —— 操作者接下来要决定的是
          // 「再按一次，还是直接断电」，而这两个答案取决于
          // 在途写入到底停了没有。
          throw new BridgeError(
            'PAUSED',
            '紧急停用没有写入状态库，因此重启之后本服务不会记得自己停过。',
            {
              reason: 'PERSIST_FAILED',
              stopped_in_flight: outcome.status.stopping.length,
              revoked_changes: outcome.revoked.length,
              revoke_failed: outcome.revoke_error !== null,
            },
          );
        }

        return describeOutcome(outcome);
      },
    },
    {
      name: 'service.resume',
      required: SERVICE_CONTROL_CAPABILITY,
      handler: (input, context) => {
        requireLocalConsole(context);
        requireEmptyBody(input, 'service.resume');
        const outcome = deps.pause.release();
        recordServiceEvent(deps.repos, 'service.resume', outcome);
        // 恢复**不**恢复任何批准：被 `service.pause` 作废掉的排队授权
        // 不会因为这一行而回来（理由写在 `PauseService.release` 的注释里）。
        // 因此返回体里的 `revoked` 恒为空数组 —— 那是事实，不是省略。
        return describeOutcome(outcome);
      },
    },
  ];

  for (const definition of definitions) registry.register(definition);
}
