/**
 * 工具面的 IPC 注册（LWB-017 步骤 2）。
 *
 * ## 操作名**逐字**等于 MCP 工具名
 *
 * 一条 IPC 操作 `file_read` 与一个 MCP 工具 `file_read` 同名，这不是巧合，
 * 是刻意的：适配器收到 `tools/call name="file_read"` 之后要做的映射是
 * 恒等映射，没有一张「工具名 → 操作名」的对照表可以写错、可以漏项、
 * 可以在将来与工具清单脱节。
 *
 * 代价是命名空间重合：`tools.catalog` 也住在这里，而它与任何工具都不同名。
 * 这个例外必须存在 —— 适配器需要一个**不是工具**的入口来问「有哪些工具」。
 *
 * ## 装配时的三条断言
 *
 * 1. 注册的名字里**没有**控制面方法（`isControlPlaneName`）——
 *    验收标准第一条。
 * 2. 注册的名字都是已知工具名或清单操作名（`isToolName`）——
 *    防止一个拼错的名字注册成功却永远调不到。
 * 3. `required: 'tools.read'` 确实授予了 `mcp-adapter`。
 *
 * 第 3 条不是多余的：`apps/daemon/src/control/control-plane.ts` 把
 * 「能力要求**未**授予 mcp-adapter 的操作」当成控制面操作。因此如果哪天
 * 有人把这里的 `required` 改成 `workspaces.manage`，工具操作会**变成**
 * 控制面操作，进而被挂到控制台的 HTTP 路由上 —— 而这条变化在功能上
 * 完全看不出来（工具仍然能用）。该文件的 `unclassified` 检查会拦住它
 * （工具操作不在变更类/只读类清单里，装配直接失败），
 * 这一条断言是同一件事的**第二道**、更靠近事发地的一道。
 *
 * ## 处理器返回信封，不抛异常
 *
 * 见 `handlers.ts` 文件头：IPC 层的兜底路径
 * （`{ok:false, code:'OPERATION_FAILED', reason: error.message}`）
 * 带的是**本地排障文本**，它可能含绝对路径。因此本层不能让它被走到。
 */

import { BridgeError, TOOL_CATALOG_OPERATION, isControlPlaneName, isToolName } from '@lwb/contracts';
import type { ImplementedToolName, ToolCatalogResult } from '@lwb/contracts';
import { IMPLEMENTED_TOOL_NAMES } from '@lwb/contracts';
import { hasCapability } from '@lwb/ipc';
import type { OperationRegistry, RequestContext } from '@lwb/ipc';

import { assertNoControlPlane, catalogFor } from './catalog.ts';
import { TOOL_HANDLERS, asEnvelope } from './handlers.ts';
import type { ToolHandlerDeps } from './handlers.ts';
import { withToolGuard } from './guard.ts';
import type { GuardDeps } from './guard.ts';

/** 工具面所有操作要求的能力。见文件头第 3 条。 */
const TOOL_CAPABILITY = 'tools.read';

/**
 * 清单操作的入参：**必须为空**。
 *
 * 这里刻意不是「忽略入参」：`resolveConnection` 从通道取身份，因此
 * 一个 `{"connection_id": "..."}` 本来就会被忽略 —— 但被忽略的字段与
 * 被拒绝的字段在排障时是两件完全不同的事。模型通道上不该存在的参数
 * 应该**响亮地**失败（ADR-003 §4：身份字段无从传入）。
 */
function assertNoArguments(input: unknown, context: RequestContext): void {
  // `undefined` / `null` / `{}` 都算「没有参数」：JSON 里不存在 undefined，
  // 而「参数是 null」与「没给参数」在协议上无法区分，硬要区分只会
  // 让一个合法的空调用失败。
  if (input === undefined || input === null) return;
  // 数组**不算**空对象：`[]` 的 `Object.keys` 也是 0 项，把它放行会让
  // 「参数是一个空数组」与「没有参数」得到同一个答案 —— 而它们不是同一件事。
  if (typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0) return;
  throw new BridgeError('INVALID_ARGUMENT', `${TOOL_CATALOG_OPERATION} 不接受任何参数。`, {
    reason: 'INPUT_SCHEMA_VIOLATION',
    request_id: context.request_id,
  });
}

export interface ToolOperationsResult {
  /** 注册的操作名，供启动日志与测试核对。**不含凭证**。 */
  readonly registered: readonly string[];
}

/**
 * 把工具面注册进 IPC 操作表。
 *
 * 调用方是装配根（`index.ts`），不是工具处理器 —— 本文件不持有依赖，
 * 只把它们绑定到操作定义上。
 */
export function registerToolOperations(
  operations: OperationRegistry,
  deps: ToolHandlerDeps,
  guard: GuardDeps,
): ToolOperationsResult {
  if (!hasCapability('mcp-adapter', TOOL_CAPABILITY)) {
    // 装配期就失败，而不是等到模型第一次调用时收到 CAPABILITY_DENIED：
    // 后者看起来像「这条连接没被授权」，而真实原因是**这张表被改过**。
    throw new Error(
      `工具面要求能力 ${TOOL_CAPABILITY}，但它未被授予 mcp-adapter。` +
        '这不是连接配置问题，是能力表被改过；拒绝装配。',
    );
  }

  for (const name of IMPLEMENTED_TOOL_NAMES) {
    assertRegisterable(name);
  }
  assertRegisterable(TOOL_CATALOG_OPERATION);

  for (const name of IMPLEMENTED_TOOL_NAMES) {
    const handler = TOOL_HANDLERS[name];
    operations.register({
      name,
      required: TOOL_CAPABILITY,
      // 依赖在这一层绑定，处理器本身保持纯函数形状（`deps` 是显式入参，
      // 不是模块级单例）—— 这样单元测试可以给每个用例一份独立的 deps。
      //
      // **守卫在绑定之后包上去**（LWB-018）：放到循环外面就等于要求
      // 每个新增的工具自己记得调用它，而「记得」不是一种结构。
      // 包在这里之后，注册表里的每一个工具都必然经过审计与返回前复查 ——
      // 包括这一行下面将来新增的那些。
      handler: withToolGuard(name, (input, context) => handler(input, context, deps), deps, guard),
    });
  }

  operations.register({
    name: TOOL_CATALOG_OPERATION,
    required: TOOL_CAPABILITY,
    // **也回信封**，与七个工具一致：这条操作会失败（连接被停用、凭据类型不符、
    // 参数不为空），而失败需要一个诚实的错误码。摊开成裸对象的话，
    // 失败只能靠抛异常表达 —— 异常在 IPC 层会被折成 `OPERATION_FAILED`，
    // 那句「本进程有 bug」对「连接被停用」来说是错的。
    // 形状与理由见 `packages/contracts/src/tool-catalog.ts` 的 `TOOL_CATALOG_OUTPUT`。
    //
    // 它同样经过守卫（LWB-018）：清单会泄漏「本机装了哪些能力」，
    // 而「谁在什么时候问过清单」与「谁调了 file_read」是同一类事实。
    // 它不取并发位置 —— 那件事由 `needsConcurrencyLease` 按操作名判定，
    // 判据是「这次调用会不会碰工作区」。
    handler: withToolGuard(
      TOOL_CATALOG_OPERATION,
      (input, context) =>
        asEnvelope<ToolCatalogResult>(context, () => {
          assertNoArguments(input, context);
          const entries = catalogFor(context, deps);
          // 每次回答前都查一遍：这条断言的价值在于它跑在**真实返回的那份清单**上，
          // 而不是跑在某份装配期的样例上。
          //
          // 它在信封**之内**：装配不变量被破坏时模型看到的是「工具面当前不可用」
          // （适配器拿到非 ok 的信封就不会挂出任何工具），而本地日志里是
          // `INTERNAL_ERROR` —— 一个不变量被破坏，它就是本进程的 bug，
          // 而 INTERNAL_ERROR 正是这个意思。
          assertNoControlPlane(entries);
          return { tools: entries };
        }),
      deps,
      guard,
    ),
  });

  return { registered: [...IMPLEMENTED_TOOL_NAMES, TOOL_CATALOG_OPERATION] };
}

function assertRegisterable(name: string): void {
  if (isControlPlaneName(name)) {
    throw new Error(`拒绝把控制面方法 ${name} 注册进工具面。`);
  }
  if (name !== TOOL_CATALOG_OPERATION && !isToolName(name)) {
    throw new Error(`拒绝注册未知名字 ${name}：它不是任何已知工具，注册成功也永远调不到。`);
  }
}

/** 本模块导出的处理器名，供测试与启动日志使用。 */
export type ToolOperationName = ImplementedToolName | typeof TOOL_CATALOG_OPERATION;
