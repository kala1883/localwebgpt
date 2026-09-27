/**
 * MCP 适配器服务（LWB-017 步骤 3、4）。
 *
 * ## 适配器不判断任何授权
 *
 * 本进程做一个**转发器**：收下 `tools/call`，把参数原样交给 daemon，
 * 把 daemon 的信封翻成 MCP 结果。它不判断工作区、不判断路径、不判断能力。
 *
 * 唯一看起来像判断的两处，都不是授权判断：
 *
 *  1. **名字检查**：`tools/call` 的名字必须是一个已知工具名。
 *     这是协议层的检查（一个不存在的工具名是无效请求），
 *     而**不是**「这个工具允不允许用」—— 后者是 daemon 的事。
 *  2. **结果形态检查**：daemon 返回的成功结果必须符合输出 schema。
 *     这是「我答应给客户端的东西必须是那个样子」，也不是授权。
 *
 * 把能力判断搬到这里（例如「清单里没有就拒绝调用」）看起来更严，
 * 实际是把同一件事判断两遍：两处判断总有分开的一天，而分开时
 * **哪一处算数**取决于谁先执行 —— 这种不确定性本身就是缺陷。
 *
 * ## 失败一律是工具结果，不是协议错误
 *
 * 业务失败（未授权、策略拒绝、超限）以 `isError: true` 返回，
 * 并且**不带** `structuredContent`：输出 schema 描述的是成功那一种结果，
 * 把失败也塞进去会让「结果符合 schema」这句话变成「两个分支之一符合」。
 *
 * 协议错误（未知工具名、参数不是对象）才抛 JSON-RPC error —— 那时
 * 调用方问的根本不是一个有效问题。
 */

import {
  BRIDGE_ERRORS,
  ERROR_ENVELOPE,
  TOOL_OUTPUT_SCHEMAS,
  isImplementedToolName,
  isToolName,
} from '@lwb/contracts';
import type { BridgeErrorPayload, OkEnvelope, ToolName } from '@lwb/contracts';
import type { IpcOutcome } from '@lwb/ipc';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { ToolCatalogResult } from '@lwb/contracts';
import { resolveSurface, SurfaceMismatchError } from './surface.ts';

/**
 * 适配器需要的、daemon 的全部能力。
 *
 * 是一个**窄接口**而不是 `IpcClient`：单元测试因此可以给一份脚本化的
 * 假实现，而生产装配传真的客户端（`IpcClient.call` 与此同形）。
 * 依赖真实管道的测试仍然要写（`tests/windows/`），但那种测试
 * 只能证明「它们连得上」，证明不了「每一种失败都被翻对了」。
 */
export interface ToolCaller {
  call(operation: string, input: unknown): Promise<IpcOutcome>;
}

export interface AdapterServerOptions {
  readonly caller: ToolCaller;
  readonly server_version: string;
  /** 本地日志出口（**stderr**）。凭证与路径不得出现在这里。 */
  readonly log: (line: string) => void;
}

/**
 * MCP 的 `arguments` → 交给 daemon 的入参。两条规则，都不是授权判断：
 *
 *  - **缺省 ⇒ `{}`**（不是 `undefined`）：daemon 侧的 schema 是 `strictObject`，
 *    它拒绝 `undefined`。这不是替模型补默认值 —— 空对象就是「零个参数」本身。
 *  - **非对象 ⇒ 拒绝**：数组、`null`、字符串、数字都不是参数集合。
 *    放行它们会把一个无效请求变成一个「daemon 说参数不合法」，
 *    而错误码会指向 daemon —— 那里根本没有收到过这条调用。
 *
 * 单独拎出来（并导出）的原因是**它今天跑不到**：SDK 自己的
 * `CallToolRequestSchema` 把 `arguments` 定成 `z.record(...).optional()`，
 * 非对象在进入本函数之前就已经被 SDK 拒绝了。留着它是因为这里约束的是
 * 「本进程答应过的事」—— SDK 的 schema 是否永远这么严，不是本进程能决定的。
 * 导出则是为了让这条规则能被直接钉住，而不是留在一条覆盖不到的分支里。
 */
export function normalizeToolArguments(raw: unknown): unknown {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new McpError(ErrorCode.InvalidParams, '工具参数必须是一个对象。');
  }
  return raw;
}

/** 漂亮的 JSON 文本。模型读的是这一份；`structuredContent` 是同一份对象。 */
function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * `requestId` 是 daemon 那条审计记录的主键，**原样带上**（放进 `details`）。
 *
 * 它必须是同一个值：模型看到「文件读取被拒绝」之后，本地要能在审计里
 * 找到**就是这一次**调用读了哪些路径（LWB-018 的第一条验收）。
 * 适配器自己另生成一个 ID 会让这两件事对不上，而它们对不上时
 * 排查者会以为是日志缺了，不会想到是 ID 被换过。
 *
 * 适配器本地合成的错误（连不上 daemon）没有这个 ID —— 那时也确实
 * 不存在任何 daemon 侧审计记录，给一个假的更糟。
 */
function errorPayload(error: BridgeErrorPayload, requestId?: string): CallToolResult {
  const details = {
    ...(error.details ?? {}),
    ...(requestId === undefined ? {} : { request_id: requestId }),
  };
  const payload: BridgeErrorPayload = {
    ...error,
    ...(Object.keys(details).length === 0 ? {} : { details }),
  };
  return {
    isError: true,
    // 失败结果不带 `structuredContent`：见文件头。
    // 文本里带上完整信封（含 request_id），这样纯文本客户端看到的
    // 与结构化客户端看到的**是同一件事**，排障时也能引用同一个关联 ID。
    content: [{ type: 'text', text: pretty({ ok: false, error: payload }) }],
  };
}

function localError(code: keyof typeof BRIDGE_ERRORS, details?: Record<string, string | boolean>): CallToolResult {
  const spec = BRIDGE_ERRORS[code];
  return errorPayload({
    code,
    message: spec.summary,
    category: spec.category,
    auto_retry: spec.autoRetry,
    ...(details === undefined ? {} : { details }),
  });
}

/**
 * IPC 层的失败码 → 模型可见的错误载荷。
 *
 * 这是**翻译**，不是判断：它读的是 IPC 层已经做出的结论。`reason` 字段
 * （本地排障文本）**一律丢弃** —— 它是为本地写的，可能含路径。
 * 保留的 `code` 是一个稳定短标签，用来区分「服务没在跑」与「超时」。
 */
function payloadForIpcFailure(outcome: Extract<IpcOutcome, { ok: false }>): CallToolResult {
  const details: Record<string, string | boolean> = {
    // 结果未知必须**如实**带出去：契约里写明这类回答不得被当作失败，
    // 而模型只能从载荷里知道这一点。
    outcome_unknown: outcome.outcome_unknown,
    ipc_code: outcome.code,
  };

  switch (outcome.code) {
    case 'UNKNOWN_OPERATION':
      // 名字是已知工具名，但 daemon 里没有这条操作 —— 只可能是
      // 「契约里有、本版本没实现」（`change_*`）。
      return localError('UNSUPPORTED_OPERATION', details);
    case 'CAPABILITY_DENIED':
      return localError('NOT_AUTHORIZED', details);
    case 'IPC_UNAVAILABLE':
    case 'IPC_INTERRUPTED':
    case 'TIMEOUT':
      return localError('SERVICE_UNAVAILABLE', details);
    default:
      // `OPERATION_FAILED` 不该出现在工具面上（处理器不抛异常，
      // 见 daemon 的 `handlers.ts`）。走到这里说明装配出了问题，
      // 因此报 INTERNAL_ERROR —— 而不是把它的 `reason` 交给模型。
      return localError('INTERNAL_ERROR', details);
  }
}

export function createAdapterServer(options: AdapterServerOptions): Server {
  const server = new Server(
    { name: 'local-workspace-bridge', version: options.server_version },
    { capabilities: { tools: {} } },
  );

  const fetchCatalog = async (): Promise<ToolCatalogResult> => {
    const outcome = await options.caller.call('tools.catalog', {});
    if (!outcome.ok) {
      // IPC 层自己的失败（连不上、超时、未知操作）。
      throw new SurfaceMismatchError(`无法取得工具清单：IPC ${outcome.code}。`);
    }
    // 清单操作用**与工具同一种信封**：`ok:false` 是 daemon 给出的答案
    // （连接被停用、凭据类型不符），而不是传输故障。两者分开报，
    // 是因为它们的排查方向完全不同 —— 一个去看进程，一个去看本机配置。
    //
    // 这里只做形状判别，**不把失败信封交给调用方**：`tools/list` 要么挂出
    // 一份完整的清单，要么什么都不挂（理由见 `surface.ts`）。
    const raw: unknown = outcome.result;
    if (typeof raw !== 'object' || raw === null) {
      throw new SurfaceMismatchError('工具清单的形状无法识别。');
    }
    const envelope = raw as { readonly ok?: unknown; readonly error?: { readonly code?: unknown } };
    if (envelope.ok !== true) {
      const code = typeof envelope.error?.code === 'string' ? envelope.error.code : 'UNRECOGNIZED';
      throw new SurfaceMismatchError(`工具清单被本机拒绝：${code}。`);
    }
    const result = raw as OkEnvelope<ToolCatalogResult>;
    // 不在这里做 zod 校验：清单的形状由 `resolveSurface` 逐条核对，
    // 而它核对的是**语义**（名字认不认识、有没有输出 schema），
    // 比形状检查更严格 —— 多一道形状检查只会多一个失败点。
    return result.data;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const surface = resolveSurface(await fetchCatalog());
      // 一行本地日志。它是「模型为什么看不到 file_read」这个问题唯一一眼可答的地方，
      // 而这个问题在没有这行日志时的表现是「工具列表里少了一个」——
      // 那看起来像客户端的事。工具名不是秘密，`reason`（本机排障文本）
      // 刻意不进这一行，也不进任何模型可见的地方。
      options.log(
        `tools/list：挂出 ${surface.available.length} 个工具（${surface.available.join('、') || '无'}）。`,
      );
      return { tools: [...surface.tools] };
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : '未知原因';
      options.log(`tools/list 失败：${detail}`);
      // **整份清单**失败，不返回部分结果：见 surface.ts 文件头。
      // 这里的 `detail` 只进本地日志，不进 JSON-RPC 的 message ——
      // 那个 message 会到达模型。
      throw new McpError(ErrorCode.InternalError, '本地工具面当前不可用；未能取得工具清单。');
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    if (!isToolName(name)) {
      // 未知工具名是**协议层**问题：调用方问的不是一个有效问题。
      throw new McpError(ErrorCode.InvalidParams, `未知工具 ${String(name)}。`);
    }

    const args = normalizeToolArguments(request.params.arguments);

    const outcome = await options.caller.call(name, args);
    if (!outcome.ok) {
      options.log(`工具 ${name} 的 IPC 调用失败：${outcome.code}`);
      return payloadForIpcFailure(outcome);
    }

    return toCallToolResult(name, outcome.result, options.log);
  });

  return server;
}

/**
 * daemon 的结果 → MCP 结果，中间隔一道输出 schema 校验。
 *
 * ## 先认失败信封，再认成功信封
 *
 * 顺序是**功能性的**，不是风格：daemon 的处理器从不抛异常，因此
 * 「策略拒绝」「未授权」「超限」都是以 `ok:false` 的**正常返回**到达这里。
 * 若拿成功 schema 去套它们，每一次业务失败都会被判成「结果不符合输出契约」，
 * 于是模型看到的是 `INTERNAL_ERROR`（本地服务内部错误）——
 * 排查方向被整个引到反的方向去，而真实答案一直是「被拒绝了」。
 *
 * 判别失败信封时**不做内容级消毒**：`error.details` 由 daemon 的处理器填写、
 * 由 `toModelPayload` 消毒，那是那条链路上的责任。这里再把关一次
 * 只能在「形状」这一层，因此就说成「形状检查」——多说一句
 * 「已消毒」就是一句这里证明不了的话。
 *
 * ## 校验失败时**不**把结果交出去
 *
 * 那份结果会被客户端按 `outputSchema` 校验，而一个不符合 schema 的结果
 * 要么被客户端拒绝（那时我们本可以先说清楚），要么被客户端**放过**
 * （那时我们宣称的契约就已经不成立了）。
 */
function toCallToolResult(
  name: ToolName,
  result: unknown,
  log: (line: string) => void,
): CallToolResult {
  if (!isImplementedToolName(name)) {
    // `resolveSurface` 已经保证只有实现了的工具会被调用到；走到这里
    // 说明有人绕过了那一层（例如直接调 `createAdapterServer`）。
    // 用 `isImplementedToolName` 而不是「取不到就返回 undefined」：
    // 后者在一次表结构改动（比如换成 `z.any()` 的兜底）之后
    // 会**静默通过**，而那时这个函数就不再拒绝任何结果了。
    log(`工具 ${name} 没有输出契约；已拒绝返回结果。`);
    return localError('UNSUPPORTED_OPERATION');
  }

  // 失败信封：daemon 已经给出了一个诚实的错误码，翻译过去就是全部的工作。
  const failure = ERROR_ENVELOPE.safeParse(result);
  if (failure.success) {
    // `request_id` 是本地审计的关联 ID，原样带走 —— 见 `errorPayload`。
    return errorPayload(failure.data.error, failure.data.request_id);
  }

  const parsed = TOOL_OUTPUT_SCHEMAS[name].safeParse(result);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    log(
      `工具 ${name} 的结果不符合输出契约：${parsed.error.issues.length} 处，` +
        `首处 ${first?.code ?? 'INVALID'} @ ${first?.path.join('.') ?? ''}`,
    );
    return localError('INTERNAL_ERROR');
  }

  return {
    content: [{ type: 'text', text: pretty(parsed.data) }],
    structuredContent: parsed.data,
  };
}
