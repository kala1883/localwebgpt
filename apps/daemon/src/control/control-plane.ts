/**
 * 控制平面的装配（LWB-012 步骤 3）。
 *
 * ## 「控制平面上有哪些接口」由能力表决定，不由谁记得加
 *
 * 装配时遍历 IPC 操作注册表，把**能力要求不属于模型侧**的操作
 * 逐条映射成控制平面的 HTTP 路由。这不是偷懒，是让
 * 「哪些操作属于控制平面」这件事只有一个来源。
 *
 * 直觉写法是维护一张手写清单：`const CONTROL_OPERATIONS = ['workspaces.register', …]`。
 * 它的失效方式很隐蔽 —— 将来有人加了一个 `approvals.decide` 的操作，
 * 注册进了 IPC，忘了加进这张清单。结果是**控制台上没有这个按钮**，
 * 而 IPC 上它是可用的。听起来是「少了个功能」，不像安全问题。
 * 但当维护者为了让按钮出现而把清单补上时，他要做的判断是
 * 「这个操作该不该出现在控制台」—— 而这个问题本可以不需要问。
 *
 * ## 变更类操作必须被**显式**分类
 *
 * `MUTATING_OPERATIONS` 与 `READ_ONLY_OPERATIONS` 覆盖全部控制操作，
 * 且装配时**断言二者之并等于控制操作全集**。少分类一个就拒绝装配。
 *
 * 为什么不让「变更与否」也从能力推导：能力是粗粒度的
 * （`workspaces.manage` 同时覆盖 `list` 与 `register`），
 * 而分类错误的后果是单向的 —— 把一个变更类操作误判为只读，
 * 它就**不需要一次性 nonce** 了，而这条失效在功能上完全看不出来
 * （按钮照常工作）。所以宁可让它必须被写下来。
 */

import { BridgeError, CONTROL_TOKEN_PREFIX } from '@lwb/contracts';
import type { OperationRegistry } from '@lwb/ipc';
import { hasCapability } from '@lwb/ipc';
import {
  ControlRouteTable,
  registerOperationRoutes,
  type ControlRoute,
} from './routes.ts';
import { ControlSessionStore, type ControlSession } from './session.ts';
import {
  ControlServer,
  bodyDigest,
  type ControlEvent,
  type ControlServerOptions,
  type StaticControlAsset,
} from './server.ts';

/** 会改变本机状态的控制操作。变更类路由要求 CSRF 头与一次性 nonce。 */
export const MUTATING_OPERATIONS: readonly string[] = [
  'workspaces.register',
  'workspaces.access.set',
  'workspaces.pause',
  'workspaces.resume',
  'workspaces.remove',
  'workspaces.reverify',
  'workspaces.relocate',
  // LWB-018 步骤 3：暂停连接会使该连接此前签发的票据、游标与批准全部失效，
  // 因此它是一次**撤销**，而不是一次配置修改 —— 变更类的判定不需要犹豫。
  'connections.pause',
  'connections.resume',
  // LWB-021：拒绝是终态（`REJECTED` 在 `TERMINAL_CHANGE_STATES` 里），
  // 一个修改集被拒之后不可能再被批准 —— 这个判定是单向的。
  'approvals.reject',
  // LWB-021 主按钮：记录批准、把修改集推进到 QUEUED、创建唯一操作。
  // 三件事都会改变本机状态，因此它**必须**带一次性 nonce：nonce 绑的是
  // 「这次动作 + 这份内容」，而重放一次批准就是重放一次写入授权。
  'approvals.approve_and_apply',
  // LWB-034 的紧急停用。它改的是**整个服务**的状态（`service_pause` 那一行），
  // 并且顺带作废全部排队授权 —— 一次请求能让若干条已在 `QUEUED` 的修改集
  // 变成 `INVALIDATED`，因此它是一次**撤销**，与 `connections.pause` 同类。
  //
  // nonce 在这里还有一层意义：暂停必须是一次**有人真的按了**的动作。
  // 一个可以被重放的暂停请求，等于一个可以被重放的紧急按钮。
  'service.pause',
  // 恢复同样会改变本机状态（`paused = 0`）。它**不**恢复任何被作废的
  // 批准（见 `PauseService.release`），因此「恢复」比它读起来的样子小 ——
  // 但「变更与否」问的是它写不写库，而不是它改得多不多。
  'service.resume',
  // LWB-037：保留当前/重新提议只写审计；恢复授权与兑现会写授权、日志及
  // 受保护工作区，因此都必须是变更类并要求一次性 nonce。
  'recovery.keep_current',
  'recovery.repropose',
  'recovery.authorize',
  'recovery.repair',
  // 快照导出把受保护内容交给本机文件保存界面；它须绑定内容与目标，
  // 且每次都要求本地会话、CSRF 与一次性 nonce。
  'recovery.export_snapshot',
];

/**
 * 只读的控制操作。仍然要求会话（它们是控制平面的接口），但不要求 nonce。
 *
 * `approvals.list` 属于这里，尽管它回报的是批准状态：它**不写库**。
 * 这一点值得写下来 —— 最自然的实现是在列出前顺手把过期的 `ACTIVE`
 * 归一化成 `EXPIRED`（`ApprovalsRepo.expireDue` 就是干这个的），
 * 但那会让一个只读接口产生状态变更，而「只读接口为什么要一次性 nonce」
 * 从此没有答案。有效状态改由读取时投影（`effectiveApprovalState`），
 * 与执行前门禁用的是同一个函数。
 */
export const READ_ONLY_OPERATIONS: readonly string[] = [
  'workspaces.list',
  'workspaces.access.list',
  'workspaces.describe',
  'connections.list',
  'approvals.list',
  // LWB-034：控制台要靠它显示「停用还没停完」——正在停的写入有几件、
  // 还剩几条排队授权没被作废、有几个恢复现场在等人。
  //
  // 它属于只读，尽管它读的东西里包含一个全表 `COUNT(*)`
  // （`unrecallable_file_rows`）：那个开销是**读**的代价，不是一次
  // 状态变更。把它归成变更类会要求操作者每刷新一次界面签一次 nonce，
  // 而那样做的唯一后果是有人把它挪回只读 —— 一个为了合规而生的
  // 错误分类，会在被修掉的时候顺手带走这条接口本身。
  'service.pause_status',
  // LWB-036：控制台复核待批准的修改集。两个都不写库。
  //
  // 它们属于只读这件事值得写下来，因为 `changes.get` 有时会**读快照**、
  // 有时会**读不到**（闸门拒绝时抛错）——而那两件事都不是状态变更。
  // 把它归成变更类会要求每翻一页签一次 nonce，代价与 `service.pause_status`
  // 那条注释写的一模一样：一个为了合规而生的错误分类，会在被修掉的时候
  // 顺手带走这条接口本身。
  'changes.list',
  'changes.get',
  // LWB-037：恢复记录与历史只读，页面刷新不应消耗一次性 nonce。
  'recovery.list',
  'recovery.get',
  'history.list',
];

export interface ControlPlaneOptions {
  readonly operations: OperationRegistry;
  readonly sessions: ControlSessionStore;
  readonly static_assets?: ReadonlyMap<string, StaticControlAsset>;
  readonly port?: number;
  readonly onEvent?: (event: ControlEvent) => void;
  /** 供 `GET /api/status` 回报。**不得含凭证**。 */
  readonly status?: () => Record<string, unknown>;
}

export interface ControlPlane {
  readonly server: ControlServer;
  readonly routes: ControlRouteTable;
  readonly sessions: ControlSessionStore;
}

/**
 * 遍历操作注册表，挑出属于控制平面的那些。
 *
 * 判据是「该操作要求的能力**没有**授予 mcp-adapter」。
 * 用 `hasCapability` 而不是自己维护一份名单：这个函数与 IPC 层鉴权时
 * 读的是同一张表，因此不可能出现「装配时以为模型够不着、运行时却够得着」。
 */
export function controlOperationNames(operations: OperationRegistry): readonly string[] {
  const definitions = operations.names().map((name) => operations.lookup(name));
  return definitions
    .filter((definition) => definition !== undefined)
    .filter((definition) => definition.required !== undefined && !hasCapability('mcp-adapter', definition.required))
    .map((definition) => definition.name)
    .sort();
}

function buildRoutes(options: ControlPlaneOptions, sessions: ControlSessionStore): ControlRouteTable {
  const table = new ControlRouteTable();
  // `/api/status` 要能自描述「本服务有哪些接口」。用局部闭包引用这张表，
  // 而不是把它挂到模块级变量上 —— 后者在测试里会串（同一进程里建了两个
  // 控制平面时，第二个会看到第一个的表），而且那种串法不会报错。
  const listRoutes = (): readonly string[] => table.routes().map((route) => `${route.method} ${route.path}`);

  // ---- 会话：本表上仅有的两条免鉴权路由（见 routes.ts 的清单与理由） ----

  table.register({
    method: 'POST',
    path: '/api/session',
    capability: undefined,
    mutating: false,
    handler: (context) => {
      const token = context.body['token'];
      if (typeof token !== 'string' || !token.startsWith(CONTROL_TOKEN_PREFIX.bootstrap)) {
        // 形状先挡一道：不是启动令牌的东西连哈希都不用算。
        //
        // **必须是 BridgeError 而不是普通 Error**：非 BridgeError 会被服务器
        // 折成 INTERNAL_ERROR / 500（见 server.ts 的错误收敛）。那意味着
        // 「客户端发了个格式不对的令牌」在控制台看来是「本地服务内部错误」——
        // 操作者会去查服务端的 bug，而这其实是他的地址栏里少了一段。
        throw new BridgeError('INVALID_ARGUMENT', '启动令牌格式不正确。');
      }
      const issued = sessions.redeem(token);
      if (issued === null) {
        // 无效 / 过期 / 已用过，一律 403 且不区分：区分它们会给猜测者
        // 一个「这一张存在但过期了」的信号（见 session.ts 的 redeem）。
        throw new BridgeError('NOT_AUTHORIZED', '启动令牌无效、已过期或已被使用。');
      }
      return {
        session_id: issued.session.session_id,
        csrf_token: issued.session.csrf_token,
        expires_at: issued.session.expires_at,
        // `cookie_value` 由服务器在响应头里下发，**不进响应体**：
        // 响应体会被控制台打印到控制台日志，而 cookie 值是凭证。
        cookie_value: issued.cookie_value,
      };
    },
  });

  table.register({
    method: 'DELETE',
    path: '/api/session',
    capability: undefined,
    mutating: false,
    handler: (context) => {
      const revoked = context.body['session_id'];
      if (typeof revoked === 'string' && revoked.length > 0) sessions.revoke(revoked);
      return { logged_out: true };
    },
  });

  // ---- 服务状态：只回报事实，不含凭证 ----

  table.register({
    method: 'GET',
    path: '/api/status',
    capability: 'audit.read',
    mutating: false,
    handler: () => ({
      ...(options.status?.() ?? {}),
      // 只回报**数量**，不回报会话 id 之外的任何东西。
      sessions: sessions.sessions().map((session) => ({
        session_id: session.session_id,
        created_at: session.created_at,
        expires_at: session.expires_at,
      })),
      routes: listRoutes(),
    }),
  });

  // ---- 一次性 nonce ----

  table.register({
    method: 'POST',
    path: '/api/nonces',
    // 取 `approvals.decide`：nonce 存在的理由就是给授权类动作做一次性绑定，
    // 因此签发它就等于「使用授权能力」的一部分。
    capability: 'approvals.decide',
    // **不是**变更类：签发一张 nonce 不改变任何用户状态，
    // 而要求它自带 nonce 会变成一个先有鸡还是先有蛋的问题。
    // 它仍然要求会话与 CSRF 头（任何非 GET 请求都要求 CSRF）。
    mutating: false,
    handler: (context) => {
      const operation = context.body['operation'];
      const subject = context.body['subject'];
      const digest = context.body['digest'];
      if (typeof operation !== 'string' || typeof subject !== 'string' || typeof digest !== 'string') {
        // 同上：调用方参数缺失是 INVALID_ARGUMENT（400），不是服务端内部错误。
        throw new BridgeError('INVALID_ARGUMENT', '签发 nonce 需要 operation / subject / digest 三个字符串字段。');
      }
      const issued = sessions.issueNonce(context.session, { operation, subject, digest });
      return { nonce: issued.nonce, expires_at: issued.expires_at, digest };
    },
  });

  // ---- 控制操作：由能力表推导，逐条映射 ----

  const names = controlOperationNames(options.operations);
  const mutating = names.filter((name) => MUTATING_OPERATIONS.includes(name));
  const readOnly = names.filter((name) => READ_ONLY_OPERATIONS.includes(name));

  const unclassified = names.filter(
    (name) => !MUTATING_OPERATIONS.includes(name) && !READ_ONLY_OPERATIONS.includes(name),
  );
  if (unclassified.length > 0) {
    throw new Error(
      `控制操作 ${unclassified.join('、')} 没有被分类为变更类或只读类；拒绝装配控制平面。` +
        '分类决定它是否需要一次性 nonce，而误判为只读的后果在功能上完全看不出来。' +
        `请把它加入 MUTATING_OPERATIONS 或 READ_ONLY_OPERATIONS，并说明理由。`,
    );
  }
  const stale = [...MUTATING_OPERATIONS, ...READ_ONLY_OPERATIONS].filter((name) => !names.includes(name));
  if (stale.length > 0) {
    // 反向也要查：清单里留下一个已不存在（或已被改成模型可达）的操作，
    // 说明这份清单已经与能力表脱节，而它下一次就会被照着抄。
    throw new Error(
      `控制操作清单里的 ${stale.join('、')} 并不属于控制平面（未注册，或其能力已授予模型侧）。` +
        '清单与能力表已经脱节，请一并核对。',
    );
  }

  registerOperationRoutes(table, options.operations, mutating, { mutating: true });
  registerOperationRoutes(table, options.operations, readOnly, { mutating: false });

  return table;
}

export function createControlPlane(options: ControlPlaneOptions): ControlPlane {
  const sessions = options.sessions;
  const table = buildRoutes(options, sessions);
  const serverOptions: ControlServerOptions = {
    routes: table,
    sessions,
    ...(options.static_assets === undefined ? {} : { static_assets: options.static_assets }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  };
  return { server: new ControlServer(serverOptions), routes: table, sessions };
}

export { bodyDigest, ControlSessionStore, ControlServer };
export type { ControlSession, ControlEvent };
