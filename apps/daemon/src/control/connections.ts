/**
 * 连接控制操作（LWB-018 步骤 3 的落地）。
 *
 * ## 为什么 LWB-018 需要它
 *
 * 步骤 3 是「**暂停连接后**阻断新请求和未发送结果，清理旧缓存/游标」。
 * 前半句在工具面已经成立（`guard.ts` 的返回前复查 + `resolveConnection`
 * 对停用连接的拒绝），但在这之前没有任何**生产路径**能把一条连接停用：
 * `connections.enabled` 只有测试代码写过。一条只能由测试触发的撤权路径，
 * 其验收证据是「机制成立，但没人能拉动它」—— 那不足以证明撤权可用。
 *
 * ## 为什么能力名与工作区分开
 *
 * `workspaces.manage` 是「登记/暂停/移除本机目录」。连接不是目录：
 * 它的暂停表达的是「这条凭证现在不许再调用工具面」，与某个根的登记无关。
 * 合用一个能力名会让「暂停一条连接」在审计与能力表里读起来像一次
 * 工作区动作 —— 而排障时首先要知道的是「动的是哪一类对象」。
 *
 * 新增能力要同时改四处（`packages/ipc/src/audience.ts` 的闭集、
 * audience 映射、`NEVER_GRANTED_TO_MODEL`，以及 `control-plane.ts` 的
 * 变更/只读分类），四处都是**装配期**断言，漏一处就无法启动 ——
 * 这是刻意的：能力表是这个工程的授权唯一来源，它不该能被随手扩展。
 *
 * ## 与 `workspaces.ts` 的对称与不对称
 *
 * 对称的部分：入参解析、来源翻译（只认本地控制台）、审计写法、
 * 错误原样上抛，全部照搬。
 *
 * 不对称的部分只有一处，且是实质的：`connections.resume` **不**做
 * 根身份复核。`workspaces.resume` 要复核，因为一个工作区绑在一个磁盘对象上，
 * 而「同名路径被换成另一个目录」必须由操作者显式跨过。连接**没有**磁盘对象，
 * 它的身份就是 `audience` 派生密钥（`packages/ipc/src/audience.ts`），
 * 恢复它不牵涉任何本机文件事实。给这里加一次「复核」只会是一个
 * 没有复核对象的动作 —— 而那比没有更坏：它会让读代码的人以为
 * 恢复连接时发生过一次身份检查。
 *
 * ## 恢复**不**重置出站额度
 *
 * `EgressBudgetStore` 按 connection_id 记用量。停用再启用**不清零**：
 * 清零会把「暂停→恢复」变成一种重置出站窗口的手段，而窗口是
 * 「这条连接一小时内最多带走多少字节」的唯一表达。方向是安全的
 * （恢复后的连接继承旧用量，只会更紧），而反过来只要有人图方便
 * 调一次 `prune`，这条路就通了。`prune` 自身只清窗口内用量为 0 的条目
 * （见 `packages/egress/src/budget.ts`），因此它不构成同样的口子。
 *
 * ## 审计的先后顺序（与 `packages/workspaces` 同）
 *
 * 先改状态、后写审计，两步各在自己的事务里。因此存在一个窄窗口：
 * 状态已变而记录没写成。这里**不**把它包成一个事务，理由是控制层拿不到
 * `SqliteDatabase`（状态库的写入口在 `@lwb/persistence` 里），而
 * 「为这件事在控制层开一个事务接口」会把事务边界散到两个包里。
 * 这个窗口的后果是**可自证**的：`connections.list` 会如实回报
 * `enabled` 与 `updated_at`，操作者能看到状态确实变了。
 * 与工具调用的差别正在于此 —— 那里没有第二处能自证「内容出站过」，
 * 所以那条路径是 fail-closed（见 `guard.ts` 的 `recordAndReturn`）。
 */

import { BridgeError } from '@lwb/contracts';
import type { OperationDefinition, OperationRegistry, RequestContext } from '@lwb/ipc';
import { screenMetadata } from '@lwb/audit';
import type { ConnectionRecord, PrincipalKind, Repositories } from '@lwb/persistence';

import { originOf } from './workspaces.ts';

/** 连接控制操作统一要求的能力。**不授予模型侧**（`NEVER_GRANTED_TO_MODEL` 里逐条钉住）。 */
export const CONNECTIONS_MANAGE_CAPABILITY = 'connections.manage' as const;

// ---------------------------------------------------------------------------
// 入参解析
// ---------------------------------------------------------------------------

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BridgeError('INVALID_ARGUMENT', '连接操作需要一个对象参数。');
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
 * 只有本地控制台可以改连接状态。
 *
 * 与 `packages/workspaces` 的 `#requireLocal` 是同一个判断，但**不能**共用：
 * 那里抛的是 `RootRejectedError`（面向根筛查的拒绝理由集合），
 * 而这里根本没有根。用一个「拒绝理由数组」去表达一次与根无关的拒绝，
 * 会让将来读它的人以为连接登记也要过根筛查。
 *
 * 它是**第二道**。第一道是能力表：`connections.manage` 不在
 * `CAPABILITIES_BY_AUDIENCE['mcp-adapter']` 里，适配器的握手算不出这个证明。
 * 这一道挡的是接线错误（有人把这些操作注册进了适配器那份注册表）。
 */
function requireLocalConsole(context: RequestContext): void {
  if (originOf(context) !== 'local_console') {
    throw new BridgeError('NOT_AUTHORIZED', '只有本地控制台可以改变连接状态。', {
      reason: 'ORIGIN_NOT_LOCAL',
    });
  }
}

// ---------------------------------------------------------------------------
// 回报字段
// ---------------------------------------------------------------------------

/**
 * 回给控制台的连接描述。
 *
 * **刻意不含两项**：
 *
 *  - `credential_ref`：它指向这条连接的凭证。今天它是恒为 null 的列
 *    （还没有生产路径写它），正因如此更不能顺手带出来 —— 一旦有人把
 *    它实现成明文路径或密钥库条目名，一个「本来就没用」的返回字段
 *    会立刻变成一个把凭证引用送到前端的通道，而届时的改动者
 *    不会有理由去检查一个他正在看却没有在改的那一行。
 *  - `principal_id`：身份值。控制台需要区分的是「哪条连接」，
 *    那由 `connection_id` 与 `alias` 回答；`principal_kind` 保留，
 *    因为操作者判断一条连接能不能被模型用到，看的就是它。
 */
function describeConnection(record: ConnectionRecord): Record<string, unknown> {
  return {
    connection_id: record.id,
    alias: record.alias,
    principal_kind: record.principal_kind,
    enabled: record.enabled,
    generation: record.generation,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

export interface ConnectionOperationsDeps {
  readonly repos: Repositories;
}

/**
 * 注册全部连接控制操作。
 *
 * 操作名与能力同名分段，理由同 `workspaces.ts`：`connections.manage`
 * 这个名字在审计、能力表与操作名三处一致。
 */
export function registerConnectionOperations(
  registry: OperationRegistry,
  deps: ConnectionOperationsDeps,
): void {
  const definitions: OperationDefinition[] = [
    {
      name: 'connections.list',
      required: CONNECTIONS_MANAGE_CAPABILITY,
      handler: (_input, context) => {
        requireLocalConsole(context);
        return { connections: deps.repos.connections.list().map(describeConnection) };
      },
    },
    {
      name: 'connections.pause',
      required: CONNECTIONS_MANAGE_CAPABILITY,
      handler: (input, context) => {
        requireLocalConsole(context);
        const body = asRecord(input);
        return describeConnection(
          setEnabled(deps.repos, requireString(body['connection_id'], 'connection_id'), false),
        );
      },
    },
    {
      name: 'connections.resume',
      required: CONNECTIONS_MANAGE_CAPABILITY,
      handler: (input, context) => {
        requireLocalConsole(context);
        const body = asRecord(input);
        return describeConnection(
          setEnabled(deps.repos, requireString(body['connection_id'], 'connection_id'), true),
        );
      },
    },
  ];

  for (const definition of definitions) registry.register(definition);
}

/**
 * 改状态 + 写审计。
 *
 * 审计里只放别名与结构化字段，**不放**任何凭证或本机路径（方案 §9）。
 * `subject` 用连接 id：与本工程其余生命周期动作一致（记录的是**被作用的
 * 那个对象**）。工具调用记的是调用方，那是有意的例外，理由写在
 * `packages/audit/src/record.ts`。
 *
 * 元数据**穿过**同一道筛查（`screenMetadata`），而不是「这里只写几个安全
 * 字段所以不必」。审计库的泄漏面等于整个状态库，而筛查的价值来自
 * 「每一个写元数据的调用点都要过它」—— 一处例外就是下一处例外的范本。
 * 这一条与 `packages/audit/src/record.ts` 里那句自述是同一条规则。
 */
function setEnabled(repos: Repositories, connectionId: string, enabled: boolean): ConnectionRecord {
  const record = repos.connections.setEnabled(connectionId, enabled);
  repos.audit.append({
    subject: record.id,
    action: enabled ? 'connection.resume' : 'connection.pause',
    outcome: 'allow',
    connection_id: record.id,
    metadata: screenMetadata({
      alias: record.alias,
      // 代次是这次动作**最要紧**的一个字段：它是守卫在返回前比的那一个 ——
      // 调用进行中被暂停/恢复会当场命中，已经算好的结果不说出去。
      // **不要**把它读成「此前签发的读取票据与游标全部失效」：那些绑的是
      // 工作区代次，不是连接代次（偏离项 61，已实测）。
      generation: record.generation,
      principal_kind: record.principal_kind satisfies PrincipalKind,
    }),
  });
  return record;
}
