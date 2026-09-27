/**
 * 控制平面路由表（LWB-012 步骤 3）。
 *
 * ## 这张表存在的意义：把一条验收标准变成一次注册期断言
 *
 * 「MCP 连接凭证不能调用控制 API」这句话有几种写法，强度完全不同：
 *
 *  - **靠约定**：「适配器不许转发这些接口」。它保证的是写这句话那天的情况。
 *  - **靠逐条检查**：每个 handler 开头写一句 `if (audience !== 'console') throw`。
 *    它保证的是「每个 handler 的作者都记得写」—— 而新加一个接口的人
 *    最容易漏的就是这一句，且漏了之后**一切照常工作**。
 *  - **靠类型**：不可能，因为能力是按字符串查表的。
 *  - **靠构造期不可能**：路由注册时断言「这条路由要求的能力，模型侧没有」，
 *    不满足就**拒绝注册**，daemon 起不来。
 *
 * 这里是第四种。它之所以比前三种强，是因为**失败的方向**：
 * 前三种漏掉时是「静默地多了一条模型可达的控制接口」，
 * 第四种漏掉时是「daemon 拒绝启动，且错误信息说明原因」。
 * 一个必须被解决才能继续的错误，和一个永远没人发现的洞，
 * 差别就在这里。
 *
 * 断言用的是 `@lwb/ipc` 的 `hasCapability('mcp-adapter', …)` —— 与 IPC 层
 * 实际鉴权时查的是**同一张表**。因此这里不可能出现「注册期认为模型没有、
 * 运行时却给模型了」的漂移：它们读的是同一个对象。
 *
 * ## 未鉴权路由必须逐条列名
 *
 * 有一类路由**必须**在没有会话时可达，否则会话永远建立不起来
 * —— 兑换启动令牌那一条就是。允许一个「没有能力要求」的路由存在，
 * 等于在这张表上开一个洞；因此这类路由只能出现在 `UNAUTHENTICATED_ROUTES`
 * 这个显式清单里，清单之外的一律拒绝注册。清单本身很短，
 * 而且每一条都要在注释里说明**为什么它必须免鉴权**。
 */

import type { Capability } from '@lwb/ipc';
import { hasCapability } from '@lwb/ipc';
import type { OperationRegistry, RequestContext } from '@lwb/ipc';
import type { ControlSession } from './session.ts';

export interface ControlRouteContext {
  readonly session: ControlSession;
  readonly operation: string;
  readonly body: Record<string, unknown>;
  readonly request_id: string;
}

export type ControlRouteHandler = (context: ControlRouteContext) => Promise<unknown> | unknown;

export interface ControlRoute {
  /**
   * 允许的方法。
   *
   * 只有这三个，且**没有 `OPTIONS`**：不实现 CORS 预检是防线的一部分
   * （见 server.ts 的文件头），因此 `OPTIONS` 不是「没实现」，
   * 而是「刻意不实现」。
   */
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** 必须是以 `/` 开头的固定路径。**不接受通配符**（见 register 的说明）。 */
  readonly path: string;
  /**
   * 这条路由要求的能力。
   *
   * `undefined` 表示免鉴权路由 —— 只允许出现在 `UNAUTHENTICATED_ROUTES` 里。
   */
  readonly capability: Capability | undefined;
  /** 是否会改变本机状态。变更类路由要求 CSRF 头与一次性 nonce。 */
  readonly mutating: boolean;
  readonly handler: ControlRouteHandler;
}

/**
 * **必须**免鉴权的路径清单。
 *
 * 只有两条，且都与会话的建立/销毁有关：
 *  - `POST /api/session`：用启动令牌换会话。它没有会话可用，因为它就是来拿会话的。
 *  - `DELETE /api/session`：登出。它需要会话才谈得上登出 —— 但它**不修改任何
 *    工作区状态**，且幂等（没有会话时也返回成功）。放进免鉴权清单是为了让
 *    「过期后点登出」不被 401 挡住，从而把用户卡在一个既登不出也进不去的状态。
 *
 * 注意 `DELETE /api/session` 虽然免鉴权，但它**不是**变更类路由：
 * 它改的是会话表，不是用户的任何东西。把它标成变更类会要求它带 CSRF 头，
 * 而拿不到会话的一方也就拿不到 CSRF 令牌 —— 同样会把用户卡住。
 */
export const UNAUTHENTICATED_ROUTES: readonly string[] = ['POST /api/session', 'DELETE /api/session'];

export class ControlRouteTable {
  readonly #routes = new Map<string, ControlRoute>();

  register(route: ControlRoute): void {
    // 路径形态：固定字面量，不含通配符与参数段。
    //
    // 这一条是「禁用通用代理路由」在**路由层**的落实。一个带 `:param` 或 `*`
    // 的路由（形如 `/api/*`）本身就是一个转发器：它把「客户端决定访问什么」
    // 引了进来。控制平面的每一个动作都应当能被人在代码里一眼数出来。
    if (!/^\/[A-Za-z0-9/_.-]*$/.test(route.path) || route.path.includes('//')) {
      throw new Error(
        `控制平面路由 ${route.method} ${route.path} 不是固定路径。` +
          '本服务不注册通配路由：通配路由等于一个转发器，而控制平面的动作必须能被逐条数清。',
      );
    }

    const key = `${route.method} ${route.path}`;
    if (this.#routes.has(key)) {
      // 同 reason as OperationRegistry：覆盖注册会让「实际生效的是哪一个」
      // 取决于加载顺序，而加载顺序在部署里最容易被无意改变。
      throw new Error(`控制平面路由 ${key} 已注册，拒绝覆盖。`);
    }

    if (route.capability === undefined) {
      if (!UNAUTHENTICATED_ROUTES.includes(key)) {
        throw new Error(
          `控制平面路由 ${key} 没有能力要求，又不在 UNAUTHENTICATED_ROUTES 清单里。` +
            '免鉴权路由必须逐条列名并说明理由 —— 否则这张表上就多了一个没有守卫的洞。',
        );
      }
    } else if (hasCapability('mcp-adapter', route.capability)) {
      // 这一条就是验收标准 2「MCP 连接凭证不能调用控制 API」。
      //
      // 注意判断的方向：不是「检查模型有没有这个能力然后放行」，
      // 而是**只要模型有这个能力，这条控制路由就注册不出来**。
      // 于是「控制平面上出现了一条模型可达的路由」这件事，
      // 在程序里根本没有对应的状态。
      throw new Error(
        `控制平面路由 ${key} 要求的能力 ${route.capability} 已授予 mcp-adapter 身份；拒绝注册。` +
          '控制平面的任何路由都不能要求一个模型侧具备的能力 —— 那等于把它开放给了模型。',
      );
    }

    this.#routes.set(key, route);
  }

  lookup(method: string, path: string): ControlRoute | undefined {
    return this.#routes.get(`${method} ${path}`);
  }

  /** 全部路由。供测试与证据脚本逐条遍历（这也是「能数清」的一部分）。 */
  routes(): readonly ControlRoute[] {
    return [...this.#routes.values()].sort((a, b) =>
      `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
    );
  }

  keys(): readonly string[] {
    return [...this.#routes.keys()].sort();
  }
}

export interface OperationRouteOptions {
  /** 是否改变本机状态。变更类会要求 CSRF 与一次性 nonce。 */
  readonly mutating: boolean;
}

/**
 * 把 IPC 操作暴露成控制平面的 HTTP 路由。
 *
 * **同一个 handler，两种传输**。这不是为了省代码 —— 它是为了让
 * 「控制台做的事情」与「控制台以外能做哪些控制操作」永远是同一份实现。
 * 两份实现会漂移，而漂移出来的那部分不会有测试覆盖。
 *
 * 能力要求取自操作定义本身（`definition.required`），因此
 * `ControlRouteTable.register` 的那条断言自动对每个操作生效：
 * 一个要求 `workspaces.manage` 的操作能被注册成控制路由，
 * 而 `workspaces.manage` 不在模型的能力表里 —— 注册因此成功，
 * 且成功这件事本身就说明了它不可被模型调用。
 *
 * 路径由操作名生成（`workspaces.register` → `/api/workspaces/register`），
 * 是**固定字面量**，不是 `/api/:name` 那种转发形态。
 *
 * 上下文里的 `audience` 固定为 `'console'`。这是安全的，因为本函数注册的路由
 * **只**由控制平面服务器分发，而服务器在调用 handler 之前已经验过会话
 * （`ControlRouteTable` 保证它们都有能力要求，能力要求保证它们都要会话）。
 * 换言之：`audience: 'console'` 不是一句声明，是这条路径的**结论**。
 */
export function registerOperationRoutes(
  table: ControlRouteTable,
  registry: OperationRegistry,
  operationNames: readonly string[],
  options: OperationRouteOptions,
): void {
  for (const name of operationNames) {
    const definition = registry.lookup(name);
    if (definition === undefined) {
      throw new Error(`控制平面要暴露的操作 ${name} 未在操作注册表中定义；接线错误。`);
    }
    table.register({
      method: 'POST',
      path: `/api/${name.split('.').join('/')}`,
      capability: definition.required,
      mutating: options.mutating,
      handler: (context) => {
        const requestContext: RequestContext = {
          audience: 'console',
          connection_id: `console:${context.session.session_id}`,
          pid: process.pid,
          request_id: context.request_id,
        };
        return registry.invoke(definition, context.body, requestContext);
      },
    });
  }
}
