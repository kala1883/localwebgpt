/**
 * MCP 工具面的构造（LWB-017 步骤 3）。
 *
 * ## 工具定义**只**来自本地契约，一个字段都不来自 daemon
 *
 * daemon 回答的是「此刻哪些工具可用」（一串名字），适配器拿这串名字去
 * `@lwb/contracts` 里取定义。因此即使 daemon 的返回被篡改成任意内容，
 * 也**不可能**让一个不存在的工具、一个被放宽的 schema 或一段新的描述
 * 出现在 `tools/list` 里 —— 那些东西在本进程里根本没有来源。
 *
 * 这是刻意的单向数据流：名字从 daemon 来（它是本机状态的拥有者），
 * 定义从契约来（它是工具面的拥有者）。
 *
 * ## 双向核对，且失败是**整份清单**的失败
 *
 * 两处名字集合必须一致，任何一处不符就拒绝返回**整个** `tools/list`：
 *
 *  1. daemon 给出的名字必须都在本地 `TOOLS` 里 —— 一个不认识的
 *     名字意味着两个进程对工具面的认识已经分叉；
 *  2. daemon 说「可用」的工具必须都有输出 schema —— 否则它会以
 *     「声明了 outputSchema」之外的形态出现，而客户端对
 *     `structuredContent` 的校验就会**静默失效**。
 *
 * 为什么不「跳过不认识的那个、返回其余的」：那样一来分叉这件事
 * 只表现为「少了个工具」，而少一个工具在功能上看不出异常。
 * 一个说不清自己有哪些工具的工具面，不如一个明确报错的工具面。
 *
 * ## 控制面名字在这里第二次被挡
 *
 * `assertNoControlPlane` 在 daemon 侧已经跑过。这里再挡一次不是不信任它，
 * 而是因为**验收标准说的是 MCP 的 `tools/list` 里不能出现控制面方法**——
 * 那个列表由本进程生成，因此断言必须也落在生成它的地方。
 */

import { CONTROL_PLANE_ROUTES, TOOLS_BY_NAME, isImplementedToolName, isToolName, outputSchemaOf } from '@lwb/contracts';
import type { ToolCatalogResult, ToolName } from '@lwb/contracts';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/** 工具面与 daemon 的回答不一致。**不降级、不猜测**，直接失败。 */
export class SurfaceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurfaceMismatchError';
  }
}

/**
 * 核对过的一份工具面。
 *
 * `available` 是**可用工具名**，供本地日志使用（`server.ts` 的 `tools/list`
 * 会把它打出来）。它**不用**在 `tools/call` 上：一个不在清单里的名字
 * 仍然会被转发给 daemon，由 daemon 回答「未授权 / 不可用」——
 * 在适配器里再挡一次是两个地方判断同一件事，而两处判断总有分开的一天。
 */
export interface ResolvedSurface {
  readonly tools: readonly Tool[];
  readonly available: readonly ToolName[];
}

export function resolveSurface(catalog: ToolCatalogResult): ResolvedSurface {
  const available: ToolName[] = [];

  for (const entry of catalog.tools) {
    if (!entry.available) continue;

    if ((CONTROL_PLANE_ROUTES as readonly string[]).includes(entry.name)) {
      // 类型上 `entry.name` 已经是 `ToolName`，控制面方法不在其中。
      // 这条检查因此**今天不可能为真** —— 而它要拦的是明天：
      // 有人把 `ToolName` 放宽、或把 `tools.catalog` 的来源换掉时，
      // 这里必须立刻失败而不是把控制面方法挂出去。
      throw new SurfaceMismatchError(`daemon 的清单里出现了控制面方法 ${entry.name}；拒绝装配工具面。`);
    }
    if (!isToolName(entry.name)) {
      throw new SurfaceMismatchError(`daemon 的清单里出现了未知名字 ${String(entry.name)}；拒绝装配工具面。`);
    }
    if (!isImplementedToolName(entry.name)) {
      throw new SurfaceMismatchError(
        `daemon 声称 ${entry.name} 可用，但本版本没有它的实现；拒绝装配工具面。`,
      );
    }
    available.push(entry.name);
  }

  const tools = available.map((name) => toolDefinitionOf(name));
  return { tools, available };
}

/**
 * 单个工具的 MCP 定义。
 *
 * `inputSchema` 与 `outputSchema` 都由 zod **转换**而来，不是手写的 JSON——
 * 手写的那一份与 daemon 实际校验用的 schema 之间没有任何东西能保证一致，
 * 而它们的失效方向恰好是「描述里说能接受 A、实际只接受 B」。
 */
export function toolDefinitionOf(name: ToolName): Tool {
  const definition = TOOLS_BY_NAME.get(name);
  if (definition === undefined) {
    throw new SurfaceMismatchError(`契约里没有工具 ${name} 的定义；拒绝装配工具面。`);
  }
  const outputSchema = outputSchemaOf(name);
  if (outputSchema === undefined) {
    throw new SurfaceMismatchError(`工具 ${name} 没有输出 schema；拒绝把它挂到工具面上。`);
  }

  const tool: Tool = {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: toJsonSchemaCompat(definition.inputSchema, {
      target: 'draft-2020-12',
      // 输入与输出两侧的默认策略不同：输入走 `input`（schema 接受什么就报什么），
      // 输出走 `output`。这不是调优，是两侧语义本来就不同。
      pipeStrategy: 'input',
    }) as Tool['inputSchema'],
    outputSchema: toJsonSchemaCompat(outputSchema, {
      target: 'draft-2020-12',
      pipeStrategy: 'output',
    }) as NonNullable<Tool['outputSchema']>,
  };

  // `annotations` 逐字带上。它是**提示**（MCP 规范明说客户端不该据此做判断），
  // 但提示说错方向会误导模型，所以它由契约给出、且随读取类工具一起冻结。
  if (definition.annotations !== undefined) {
    tool.annotations = definition.annotations;
  }

  return tool;
}
