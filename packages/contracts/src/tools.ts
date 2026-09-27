/**
 * MCP 工具清单、输入 schema 与 annotations（方案 §6.1、LWB-017）。
 *
 * 这是适配器与 daemon 共用的**唯一**工具定义来源：适配器不能自行添加工具、
 * 不能放宽校验、不能改写 annotations 以「减少确认弹窗」。
 *
 * annotations 只是给客户端的提示。官方明确说明它们**不能替代**服务端
 * 鉴权、参数校验和确认机制；真正的授权在本机 daemon 中完成。
 */

import { z } from 'zod';

import type { ChangeApplyInput, ChangeGetInput, ChangeListInput, ChangePrepareInput, ChangeRevertPrepareInput, FileCreateInput, FileEditInput } from './change.ts';
import type { GitDiffInput, GitStatusInput } from './git.ts';
import { LIMITS } from './limits.ts';
import type { FileListInput } from './list.ts';
import type { FileReadInput } from './read.ts';
import type { TextSearchInput } from './search.ts';
import type { ShapeCheck } from './wire-shape.ts';

export const TOOL_NAMES = [
  'bridge_status',
  'workspace_list',
  'file_list',
  'text_search',
  'file_read',
  'git_status',
  'git_diff',
  'change_prepare',
  'file_create',
  'file_edit',
  'change_get',
  'change_list',
  'change_apply',
  'change_revert_prepare',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolAnnotations {
  /** 是否完全不改变任何状态（含服务端持久化状态）。 */
  readonly readOnlyHint: boolean;
  /** 是否可能造成破坏性结果。 */
  readonly destructiveHint?: boolean;
  /** 是否为幂等操作。 */
  readonly idempotentHint?: boolean;
  /** 是否与开放世界交互。授权私有资源时为 false，但不代表无需授权。 */
  readonly openWorldHint?: boolean;
}

export interface ToolDefinition {
  readonly name: ToolName;
  readonly title: string;
  readonly description: string;
  /** 严格对象 schema：未知字段必须被拒绝，而不是被静默丢弃。 */
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  readonly annotations: ToolAnnotations;
}

// ---------------------------------------------------------------------------
// 公共片段
// ---------------------------------------------------------------------------

const workspaceId = z
  .string()
  .min(1)
  .max(128)
  .describe('本地授权的工作区 ID。只能取自 workspace_list 的返回，不能自行构造或推测。');

const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .describe('工作区内相对路径，统一使用 / 分隔。不接受绝对路径、盘符、UNC、设备路径或 .. 。');

/**
 * 目标路径。与 `relativePath` 只差一处：**允许空串**。
 *
 * 空串在工作区里不是「没给」，而是一个**合法位置**：它就是工作区根。
 * 单文件工作区（`kind: 'file'`）里根就是这个文件本身，因此那个工作区里
 * 唯一可读的东西只能用空串表达 —— 策略层正是这么要求的
 * （`WORKSPACE_KIND_MISMATCH`：「该工作区以单个文件为根，只接受空相对路径」），
 * `file_read` 的回执路径也是空串（`tests/unit/files-read.test.ts` 里
 * 「正是下一次调用该给的值」那条）。而 `z.string().min(1)` 会把
 * **唯一合法的拼写**判成非法：模型在一个单文件工作区里读不到任何东西，
 * 而它拿到的是一句「参数不合法」。
 *
 * 之所以不在 schema 里按工作区类型分两种拼写：schema 不知道工作区类型
 * （那是本机状态，模型看不见）。放开到一个「合法的位置」是安全的 ——
 * 它是不是文件、能不能读、是不是在根之下，全部由 daemon 的判定与护栏回答，
 * 而护栏对空串的处理就是把段列表取空，即根本身。
 *
 * 契约层的 `validateRelativePath` 仍然拒绝空串（`EMPTY`），那是**另一条**
 * 边界：它校验的是「逐段的相对路径」，不是「目标」。两者不冲突，
 * 但也不能互相替换 —— 见 `docs/PROGRESS.md` 的偏差记录。
 */
const targetPath = z
  .string()
  .max(1024)
  .describe('工作区内相对路径，统一使用 / 分隔；空串表示工作区根（单文件工作区即那一个文件）。');

const cursor = z.string().min(1).max(4096).describe('上一页返回的不透明游标。');

const idempotencyKey = z
  .string()
  // 数字取自 `LIMITS`，不在 schema 里另写一遍：`@lwb/idempotency` 的解析
  // 用的是同一对常量，两处各写一个数字迟早在某一处被改动。
  .min(LIMITS.MIN_IDEMPOTENCY_KEY_CHARS)
  .max(LIMITS.MAX_IDEMPOTENCY_KEY_CHARS)
  .describe(
    '客户端生成的幂等键。同一键重复提交且内容相同会返回既有结果；内容不同会返回 IDEMPOTENCY_CONFLICT。',
  );

const lineEdit = z.strictObject({
  start_line: z.number().int().min(1).describe('1 起始的起始行（含）。'),
  end_line_exclusive: z.number().int().min(1).describe('结束行（不含）。'),
  old_lines: z
    .array(z.string().refine((s) => !/[\r\n]/.test(s), '单个元素不能包含换行符'))
    .describe('必须与基线逐字符精确匹配的旧行。禁止模糊匹配。'),
  new_lines: z
    .array(z.string().refine((s) => !/[\r\n]/.test(s), '单个元素不能包含换行符'))
    .describe('替换后的新行。'),
});

/**
 * 修改项里的 `path` 目前用的是 `relativePath`（不允许空串），
 * 于是**单文件工作区里提不出任何修改**：那个工作区唯一的位置就是空串。
 *
 * 这一处**刻意没有一起改**：`change_*` 的执行器还不存在（LWB-019 之后），
 * 现在放宽的只是一个没有实现会去读的字段，改与不改都无法被验证。
 * 记在 `docs/PROGRESS.md` 的偏差里，由实现执行器的那一步一并处理 ——
 * 那时「空串是不是合法目标」会有真实的判据（`Create-New` 的目标是根时怎么办）。
 */
const changeItem = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('edit_text'),
    path: relativePath,
    base_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe('提案所基于的整个文件原始字节 SHA-256，来自 file_read 的 sha256。'),
    read_token: z.string().min(1).describe('file_read 签发的读取票据。'),
    // 上限取自 `LIMITS.MAX_EDITS_PER_FILE`：契约校验（`@lwb/changes`）与这份
    // schema 必须给出同一个数字，写死两处迟早在其中一处被改动。
    edits: z.array(lineEdit).min(1).max(LIMITS.MAX_EDITS_PER_FILE).describe('互不重叠的精确行区间补丁。'),
  }),
  z.strictObject({
    op: z.literal('create_text'),
    path: relativePath,
    content: z.string().describe('新文件的完整文本内容（UTF-8）。'),
    newline: z.enum(['lf', 'crlf']).describe('写入使用的换行风格。'),
    bom: z.boolean().describe('是否写入 UTF-8 BOM。'),
  }),
  z.strictObject({
    op: z.literal('replace_text'),
    path: relativePath,
    base_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    read_token: z.string().min(1),
    content: z
      .string()
      .describe('整文件替换内容。仅允许用于已完整读取的小文件；截断或脱敏结果不得使用。'),
  }),
]);

// ---------------------------------------------------------------------------
// 输入 schema（按工具名索引）
// ---------------------------------------------------------------------------

/**
 * 这些 schema 是**每个工具能接受什么**的唯一来源：MCP 适配器把它转成
 * JSON Schema 挂到 `tools/list`，daemon 用它校验真正到达的调用。
 *
 * 之所以单列成一张按名字索引的表（而不是留在下面 `TOOLS` 的字面量里）：
 * 工厂之外的代码只能拿到 `z.ZodObject<z.ZodRawShape>` 这个**被抹平的类型**，
 * 于是「schema 推出来的形状」与「契约里的入参接口」之间就无法做编译期核对。
 * 单列之后 `z.infer<typeof TOOL_INPUT_SCHEMAS['file_read']>` 是有具体形状的，
 * 下面那张核对表才成立。
 */
const noInput = z.strictObject({});

const fileListInput = z.strictObject({
  workspace_id: workspaceId,
  path: targetPath.optional().describe('相对目录路径；省略或空串表示工作区根。'),
  cursor: cursor.optional(),
  max_entries: z.number().int().min(1).max(LIMITS.MAX_DIRECTORY_ENTRIES).optional(),
  depth: z.number().int().min(0).max(8).optional().describe('递归深度，0 表示只列当前层。'),
});

const textSearchInput = z.strictObject({
  workspace_id: workspaceId,
  query: z.string().min(1).max(LIMITS.MAX_SEARCH_QUERY_CHARS).describe('字面量查询串。'),
  path: targetPath.optional(),
  path_glob: z
    .string()
    .max(256)
    .optional()
    .describe('受限 glob（仅支持 *、?、**），不支持任意正则。'),
  case_sensitive: z.boolean().optional(),
  cursor: cursor.optional(),
  max_matches: z.number().int().min(1).max(LIMITS.MAX_SEARCH_MATCHES).optional(),
});

const fileReadInput = z.strictObject({
  workspace_id: workspaceId,
  path: targetPath,
  start_line: z.number().int().min(1).optional(),
  max_lines: z.number().int().min(1).max(LIMITS.MAX_READ_LINES).optional(),
  cursor: cursor.optional(),
});

const gitStatusInput = z.strictObject({
  workspace_id: workspaceId,
  path: targetPath.optional(),
});

const gitDiffInput = z.strictObject({
  workspace_id: workspaceId,
  path: targetPath,
  comparison: z.enum(['head_vs_worktree', 'index_vs_worktree', 'head_vs_index']).optional(),
});

const changePrepareInput = z.strictObject({
  workspace_id: workspaceId,
  idempotency_key: idempotencyKey,
  summary: z
    .string()
    .min(1)
    .max(500)
    .describe('本次修改的简要说明。这是不受信文案，只用于展示，不作为批准依据。'),
  items: z.array(changeItem).min(1).max(LIMITS.MAX_CHANGE_FILES),
});

const proposalSummary = z
  .string()
  .min(1)
  .max(500)
  .describe('本次修改的简要说明。这是不受信文案，只用于展示，不作为批准依据。');

const fileCreateInput = z.strictObject({
  workspace_id: workspaceId,
  idempotency_key: idempotencyKey,
  summary: proposalSummary,
  path: relativePath,
  content: z.string().describe('新文件的完整文本内容（UTF-8）。'),
  newline: z.enum(['lf', 'crlf']).describe('写入使用的换行风格。'),
  bom: z.boolean().describe('是否写入 UTF-8 BOM。'),
});

const fileEditInput = z.strictObject({
  workspace_id: workspaceId,
  idempotency_key: idempotencyKey,
  summary: proposalSummary,
  path: relativePath,
  base_sha256: z.string().regex(/^[0-9a-f]{64}$/).describe('来自最新 file_read 的整个文件 SHA-256。'),
  read_token: z.string().min(1).describe('来自最新 file_read 的读取票据。'),
  edits: z.array(lineEdit).min(1).max(LIMITS.MAX_EDITS_PER_FILE).describe('互不重叠的精确行区间补丁。'),
});

const changeGetInput = z.strictObject({
  change_id: z.string().min(1).max(128).optional(),
  operation_id: z.string().min(1).max(128).optional(),
  path: relativePath.optional(),
  cursor: cursor.optional(),
});

const changeListInput = z.strictObject({
  workspace_id: workspaceId.optional(),
  cursor: cursor.optional(),
  max_items: z.number().int().min(1).max(100).optional(),
});

const changeApplyInput = z.strictObject({
  change_id: z.string().min(1).max(128),
  idempotency_key: idempotencyKey,
});

const changeRevertPrepareInput = z.strictObject({
  change_id: z.string().min(1).max(128),
  idempotency_key: idempotencyKey,
});

export const TOOL_INPUT_SCHEMAS = {
  bridge_status: noInput,
  workspace_list: noInput,
  file_list: fileListInput,
  text_search: textSearchInput,
  file_read: fileReadInput,
  git_status: gitStatusInput,
  git_diff: gitDiffInput,
  change_prepare: changePrepareInput,
  file_create: fileCreateInput,
  file_edit: fileEditInput,
  change_get: changeGetInput,
  change_list: changeListInput,
  change_apply: changeApplyInput,
  change_revert_prepare: changeRevertPrepareInput,
};
// 这里刻意**不写** `satisfies Record<ToolName, z.ZodObject<z.ZodRawShape>>`：
// 那个写法会把每一项的上下文类型定成被抹平的 `z.ZodObject<z.ZodRawShape>`，
// 于是 `z.infer` 拿到的是 `{ [k: string]: unknown }` —— 下面的核对因此永远
// 报「契约不可赋值给 schema」，而正确反应是**根本没法核对**。
// 「键齐全」由下面的 `AllInputChecks` 保证（少一个键就编译失败），
// 那是比 `satisfies` 更严的一条检查，因为它同时钉住了每一项的内容。

// ---------------------------------------------------------------------------
// 输入 schema ↔ 契约入参接口的编译期核对
// ---------------------------------------------------------------------------

/** 契约里每个工具接受什么。`bridge_status` / `workspace_list` 不接受参数。 */
interface ToolInputContracts {
  readonly bridge_status: Record<string, never>;
  readonly workspace_list: Record<string, never>;
  readonly file_list: FileListInput;
  readonly text_search: TextSearchInput;
  readonly file_read: FileReadInput;
  readonly git_status: GitStatusInput;
  readonly git_diff: GitDiffInput;
  readonly change_prepare: ChangePrepareInput;
  readonly file_create: FileCreateInput;
  readonly file_edit: FileEditInput;
  readonly change_get: ChangeGetInput;
  readonly change_list: ChangeListInput;
  readonly change_apply: ChangeApplyInput;
  readonly change_revert_prepare: ChangeRevertPrepareInput;
}

/**
 * 这两个工具不接受任何参数，因此核对的是「一个键都没有」。
 *
 * 核对的是 schema **声明的形状**（`.shape`），不是 `z.infer` 推出来的结果。
 * 理由是实测的：zod 4 把 `strictObject({})` 的**输出类型**算成
 * `Record<string, never>` —— 一个带 `string` 索引签名的类型，`keyof` 是
 * `string` 而不是 `never`。对它做 `keyof` 判断回答不了「有没有具名键」，
 * 反而会把这句检查变成一个永远为假的断言。形状则是一个普通的对象类型，
 * `keyof` 就是那几个字段名，而且**新增字段恰好出现在那里**（报错会带上字段名）。
 *
 * 「未知字段必须被拒绝」这一条不靠这里，靠的是 `z.strictObject` 本身，
 * 由运行时用例钉住（`tests/unit/daemon-tools.test.ts`）。
 */
type NoArguments<S extends z.ZodObject<z.ZodRawShape>> = keyof S['shape'] extends never
  ? true
  : { must_not_accept_arguments: keyof S['shape'] };

type InputCheck<N extends ToolName> = N extends 'bridge_status' | 'workspace_list'
  ? NoArguments<(typeof TOOL_INPUT_SCHEMAS)[N]>
  : ShapeCheck<ToolInputContracts[N], (typeof TOOL_INPUT_SCHEMAS)[N]>;

type AllInputChecks = { readonly [N in ToolName]: InputCheck<N> };

/**
 * 让上面那张核对表真的被求值。
 *
 * 每一项必须恰好是 `true`；schema 与契约任一方向不可赋值时，这一项的类型
 * 会变成带错误名（`contract_is_not_assignable_to_schema` 等）的对象字面量，
 * 赋值给 `AllInputChecks` 即编译失败，而报错位置就在**出错的那个工具**上。
 *
 * `TOOL_NAMES` 新增一个工具而这里没有对应项时同样是编译失败（少一个键）
 * —— 「加了工具但忘了给它 schema」因此不是一种可能的状态。
 */
export const INPUT_CONTRACT_WITNESS: AllInputChecks = {
  bridge_status: true,
  workspace_list: true,
  file_list: true,
  text_search: true,
  file_read: true,
  git_status: true,
  git_diff: true,
  change_prepare: true,
  file_create: true,
  file_edit: true,
  change_get: true,
  change_list: true,
  change_apply: true,
  change_revert_prepare: true,
};
void INPUT_CONTRACT_WITNESS;

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const READ_ONLY: ToolAnnotations = { readOnlyHint: true };

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'bridge_status',
    title: '查询桥接状态',
    description:
      '查询当前本地桥接服务的连接别名、版本、能力开关与限制说明。' +
      '不返回任何凭证。该工具只读，不改变任何状态。' +
      '注意：进程在运行不等于平台已验证可调用；请如实转述 gates 字段。',
    inputSchema: TOOL_INPUT_SCHEMAS.bridge_status,
    annotations: READ_ONLY,
  },
  {
    name: 'workspace_list',
    title: '列出已授权工作区',
    description:
      '列出当前连接获准访问的工作区别名、类型、访问模式与能力。' +
      '只能使用这里返回的 workspace_id，不能构造或推测其它 ID。' +
      '本工具不枚举本机其它目录，也不返回任何绝对路径。',
    inputSchema: TOOL_INPUT_SCHEMAS.workspace_list,
    annotations: READ_ONLY,
  },
  {
    name: 'file_list',
    title: '列出目录',
    description:
      '分页列出已授权工作区内的目录条目。遍历结果不是整个仓库的一致快照。' +
      '若返回 incomplete 或 next_cursor，必须如实说明结果不完整，不能宣称已看完全部文件。',
    inputSchema: TOOL_INPUT_SCHEMAS.file_list,
    annotations: READ_ONLY,
  },
  {
    name: 'text_search',
    title: '在工作区内搜索文本',
    description:
      '在已授权工作区内做**字面量**搜索（不是正则），返回路径、行号与片段。' +
      '必须先看 scope 字段：scanned_files / skipped_files / denied_files / complete。' +
      '搜索未覆盖全部候选文件时，绝不能把「没有命中」表述为「不存在」。',
    inputSchema: TOOL_INPUT_SCHEMAS.text_search,
    annotations: READ_ONLY,
  },
  {
    name: 'file_read',
    title: '按范围读取文件',
    description:
      '读取磁盘上**已保存**的字节，返回整个文件原始哈希、编码、换行风格与实际返回范围。' +
      '编辑器里尚未保存的内容读不到，不要假设已看到用户当前的编辑。' +
      '返回的 read_token 用于后续精确编辑提案；截断或缺页的结果不能用于编辑。',
    inputSchema: TOOL_INPUT_SCHEMAS.file_read,
    annotations: READ_ONLY,
  },
  {
    name: 'git_status',
    title: '查看 Git 状态',
    description:
      '只读查看已授权范围内的 HEAD / 索引 / 工作区状态。' +
      '不执行任何 Git 命令，不修改索引、refs 或工作区。' +
      '结果只覆盖授权范围，不是全仓安全审计。',
    inputSchema: TOOL_INPUT_SCHEMAS.git_status,
    annotations: READ_ONLY,
  },
  {
    name: 'git_diff',
    title: '查看 Git 差异',
    description:
      '只读查看单个已授权文件的差异。不接受任意提交 ID 或 Git 命令。' +
      '差异按原始字节计算，可能与 Git 的换行/属性语义不同。',
    inputSchema: TOOL_INPUT_SCHEMAS.git_diff,
    annotations: READ_ONLY,
  },
  {
    name: 'change_prepare',
    title: '准备多文件修改',
    description:
      '把一组确定的行级编辑/创建操作冻结为不可变修改集，返回 change_id 与摘要。' +
      '**本工具不会修改任何用户文件**，但它会创建持久化记录，因此不是只读操作。' +
      '调用前必须先 file_read 取得该文件最新的 sha256 与 read_token。' +
      '若工作区已授予“文件修改”，随后调用 change_apply 即可执行，无需逐次本地批准；' +
      '否则会返回授权拒绝。',
    inputSchema: TOOL_INPUT_SCHEMAS.change_prepare,
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: 'file_create',
    title: '创建文本文件',
    description:
      '在已授予“文件修改”的工作区中直接创建一个新文本文件。目标必须不存在；冲突时绝不覆盖。' +
      '创建经受保护执行器完成并返回逐文件回执；不需要逐次本机批准。',
    inputSchema: TOOL_INPUT_SCHEMAS.file_create,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'file_edit',
    title: '编辑文本文件',
    description:
      '基于最新 file_read 的完整读取票据、哈希与精确行区间，直接编辑一个已授权文本文件。' +
      '冲突时不覆盖；修改经受保护执行器完成并返回逐文件回执，无需逐次本机批准。',
    inputSchema: TOOL_INPUT_SCHEMAS.file_edit,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'change_get',
    title: '查询修改集与操作结果',
    description:
      '按 change_id 或 operation_id 查询修改集状态、逐文件差异与真实执行回执。' +
      '超时或断线后应使用本工具查询，**不要**重新发起同一个写操作。' +
      '只有 state=APPLIED 且带回执时才可宣称已保存；tests_run 永远为 false。',
    inputSchema: TOOL_INPUT_SCHEMAS.change_get,
    annotations: READ_ONLY,
  },
  {
    name: 'change_list',
    title: '列出修改集',
    description: '分页列出当前连接自己创建的修改集及其状态。不返回其它连接或其它工作区的记录。',
    inputSchema: TOOL_INPUT_SCHEMAS.change_list,
    annotations: READ_ONLY,
  },
  {
    name: 'change_apply',
    title: '应用修改集',
    description:
      '在该工作区具有“文件修改”授权时应用一个修改集；无需逐次本机批准。' +
      'daemon 会重算摘要、重新检查工作区代次和文件冲突，并以一次性执行记录交给受保护执行器。' +
      '不接受任何 approved / force / user_id 参数。' +
      '只有 state=APPLIED 才代表已落盘。只要 in_progress 为 true（state 仍是 QUEUED / VALIDATING / APPLYING），' +
      '就表示本次调用没有等到结论，**绝不能**说文件已经保存 —— 请改用 change_get 查询，不要重复调用本工具。' +
      '重复调用本身是安全的：无论换不换幂等键，返回的都是该修改集唯一那条操作，不会产生第二次写入。',
    inputSchema: TOOL_INPUT_SCHEMAS.change_apply,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'change_revert_prepare',
    title: '生成逆向修改集',
    description:
      '针对一次已应用的修改生成**新的**逆向修改集；它不会直接恢复文件，获授文件修改后可用 change_apply 执行。' +
      '若当前文件已被用户继续修改，会返回冲突而不是覆盖。' +
      'V1 不支持自动删除由插件创建的文件。',
    inputSchema: TOOL_INPUT_SCHEMAS.change_revert_prepare,
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
];

export const TOOLS_BY_NAME: ReadonlyMap<ToolName, ToolDefinition> = new Map(
  TOOLS.map((tool) => [tool.name, tool]),
);

export function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && (TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * 控制面方法名。这些**永远不能**出现在 tools/list 中，
 * MCP 适配器也没有转发它们的能力（方案 §3.4、LWB-012）。
 */
export const CONTROL_PLANE_ROUTES = [
  'workspace.add',
  'workspace.remove',
  'workspace.pause',
  'workspace.revalidate',
  'approval.grant',
  'approval.revoke',
  'change.reject',
  'recovery.resolve',
  'connection.disable',
  'policy.update',
  'credential.export',
  'diagnostics.export',
] as const;

export type ControlPlaneRoute = (typeof CONTROL_PLANE_ROUTES)[number];
