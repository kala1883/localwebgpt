/**
 * 工具清单的 IPC 载荷（LWB-017）。
 *
 * ## 它为什么在 `contracts` 而不在 daemon 里
 *
 * 因为它是**两个进程之间**的东西：daemon 回答，适配器据此决定挂出哪些工具。
 * 放在 daemon 里，适配器就只能靠相对路径去 import daemon 的内部模块 ——
 * 那条依赖会让「适配器可以引用 daemon 的任何东西」，包括它不该知道的部分。
 *
 * ## 它**不是**模型可见的数据
 *
 * `reason` 是本机排障文本（例如 `WORKSPACE_TOOL_NOT_GRANTED`），只给适配器记日志用，
 * **不进** `tools/list`、也不进任何工具结果。模型看到的只有
 * 「这个工具在不在清单里」这一件事。
 *
 * ## 为什么清单要由 daemon 回答
 *
 * 「此刻哪些工具可用」取决于本机连接和逐工作区授权，适配器不知道这些。
 * 由适配器自己猜就等于在工具面上宣称一个未经验证的能力。
 * 理由的完整版写在 `apps/daemon/src/tools/catalog.ts` 的文件头。
 */

import { z } from 'zod';

import { okEnvelopeOf } from './tool-outputs.ts';
import { checkShape } from './wire-shape.ts';
import { CONTROL_PLANE_ROUTES, TOOL_NAMES } from './tools.ts';
import type { ToolName } from './tools.ts';

/** 查询工具清单的 IPC 操作名。**不是**一个 MCP 工具名。 */
export const TOOL_CATALOG_OPERATION = 'tools.catalog';

export interface ToolCatalogEntry {
  readonly name: ToolName;
  readonly available: boolean;
  /**
   * 不可用的原因，供适配器记本地日志。
   *
   * `null` 表示可用。它是一个**开放的短标签**（`WORKSPACE_TOOL_NOT_GRANTED` /
   * `NOT_IMPLEMENTED` / …），因此这里只约束「是个非空串或 null」——
   * 把取值写死成枚举会让 daemon 每加一种原因都要改契约，
   * 而这份数据从不流向模型，收窄它的收益是零。
   */
  readonly reason: string | null;
}

export interface ToolCatalogResult {
  readonly tools: readonly ToolCatalogEntry[];
}

const toolCatalogEntrySchema = z.strictObject({
  name: z.enum(TOOL_NAMES),
  available: z.boolean(),
  reason: z.string().min(1).nullable(),
});
checkShape<ToolCatalogEntry, typeof toolCatalogEntrySchema>(true);

const toolCatalogResultSchema = z.strictObject({
  tools: z.array(toolCatalogEntrySchema),
});
checkShape<ToolCatalogResult, typeof toolCatalogResultSchema>(true);

export const TOOL_CATALOG_RESULT = toolCatalogResultSchema;

/**
 * 清单操作的结果信封。**与工具同一种形状**（`ok` / `data` / `request_id`）。
 *
 * 为什么它不是一个裸的 `{tools}`：这条操作也会失败（连接被停用、凭据不匹配、
 * 参数不为空），而失败必须有一个**诚实的错误码**交到适配器手上。
 * 裸返回意味着失败只能靠抛异常表达，而异常会在 IPC 层被折成
 * `OPERATION_FAILED` —— 那句「本进程有 bug」对一个「连接被停用」来说是错的，
 * 而且它把本进程唯一一条「带自由文本 reason 的兜底路径」重新打开了。
 *
 * 于是本工具面上的**每一条**操作都回信封，没有例外 ——
 * 「IPC 的兜底路径不会被走到」因此是一条可以被测试钉住的性质，
 * 而不是一句「我们都记得不抛」。
 */
export const TOOL_CATALOG_OUTPUT = okEnvelopeOf(toolCatalogResultSchema);

/**
 * 这个名字是不是控制面方法。
 *
 * 直接读 `CONTROL_PLANE_ROUTES` —— 不在本文件里另抄一份。验收标准
 * 「无控制平面方法出现在 tools/list」检查的是这个函数的返回值为假，
 * 而它之所以可信，正因为「哪些名字属于控制面」只有一个来源。
 */
export function isControlPlaneName(name: string): boolean {
  return (CONTROL_PLANE_ROUTES as readonly string[]).includes(name);
}
