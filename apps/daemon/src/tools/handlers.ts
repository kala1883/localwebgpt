/**
 * 工具处理器（LWB-017 步骤 1）。
 *
 * ## 每个处理器返回信封，不抛异常
 *
 * 「异常 → 信封」只有一处翻译（`errors.ts`），而处理器**一律不抛**：
 * 它们捕获一切，把结果或错误作为**返回值**交给 IPC 层。这样
 * `packages/ipc/src/server.ts` 里那条 `{ ok:false, code:'OPERATION_FAILED',
 * reason: error.message }` 的兜底路径在本工具面上**永远不会被走到** ——
 * 那条 `reason` 是本地排障文本，可以有绝对路径，而 IPC 层无从判断。
 *
 * ## 身份与判定都来自本进程之外
 *
 * 处理器不自己判断「这次调用能不能碰这个工作区」，它调
 * `resolveWorkspaceAccess()`（一条链：连接记录 → 授权行 → `decide()` →
 * 每次重新探测根身份的登记表）。处理器这一层的职责只有三件：
 * 校验入参形态、把判定结果交给 `@lwb/files` / `@lwb/search` /
 * `@lwb/git-reader`、把结果或错误装进信封。
 *
 * ## 入参校验在这一层，而且只有这一次
 *
 * `input` 从 IPC 来，类型是 `unknown`。用 `TOOL_INPUT_SCHEMAS` 里的
 * **同一个** schema（适配器就是把它转成 JSON Schema 挂到 `tools/list` 的）
 * 解析：未知字段被 `strictObject` 拒绝，无效枚举被 `z.enum` 拒绝。
 * 于是「工具描述里说能接受什么」与「实际接受什么」不可能不一致 ——
 * 它们字面上是同一个对象。
 *
 * 校验排在判定之前是有意的：`workspace_id` 是判定的输入，没有它无从判定。
 * 反过来的顺序（先判定再校验）在物理上做不到。这不是给未授权调用开的口子：
 * 校验失败的回答只关于**调用方自己发来的那份参数**，不含任何本机事实。
 */

import { createHash, randomUUID } from 'node:crypto';

import {
  BridgeError,
  CONTRACT_VERSION,
  TOOL_INPUT_SCHEMAS,
  err,
  newRequestId,
  ok,
} from '@lwb/contracts';
import type {
  BridgeStatusData,
  CapabilityFlags,
  ChangeApplyData,
  ChangeApplyInput,
  ChangeGetData,
  ChangeItem,
  ChangeListData,
  ChangePrepareInput,
  ChangePrepareData,
  CommandExecInput,
  ChangeRevertPrepareData,
  Envelope,
  FileListData,
  FileReadData,
  GitDiffData,
  GitStatusData,
  ImplementedToolName,
  FileCreateInput,
  FileDeleteInput,
  FileEditInput,
  TextSearchData,
  ToolName,
  WorkspaceListData,
} from '@lwb/contracts';
import type { z } from 'zod';
import type { BlobStore } from '@lwb/blob-store';
import {
  changeGetDataOf,
  changeListDataOf,
  ownedChangeOf,
  prepareChange,
  prepareRevert,
} from '@lwb/changes';
import type { ChangeQueryLimits, PrepareLimits } from '@lwb/changes';
import {
  approveAndQueue,
  reloadChangeSet,
} from '@lwb/approvals';
import { applyChange, canBeginWrite, DEFAULT_APPLY_WAIT_MS } from '@lwb/executor';
import type {
  ApplyServiceDeps,
  ApplyServiceNotice,
  ExecutionCoordinator,
  PauseStatus,
} from '@lwb/executor';
import { listDirectory, readFile } from '@lwb/files';
import type { ListLimits, ReadLimits, ReadTicketAuthority, ReadTicketPayload } from '@lwb/files';
import { gitDiff, gitStatus } from '@lwb/git-reader';
import type { GitLimits } from '@lwb/git-reader';
import { textSearch } from '@lwb/search';
import type { SearchLimits } from '@lwb/search';
import { classifyFile } from '@lwb/policy';
import type { FileRule, PolicyAction } from '@lwb/policy';
import { emitContent, mintClearance } from '@lwb/egress';
import type { WinfsOps } from '@lwb/winfs';
import type { RequestContext } from '@lwb/ipc';
import type { ConcurrencyGate, LimitTable } from '@lwb/limits';
import type { ConnectionRecord, WorkspaceRecord } from '@lwb/persistence';
import type { CommandProcessManager, CommandProcessResult } from '../lifecycle/command-processes.ts';

import { capabilityFlagsFrom, limitationsOf } from '../gates.ts';
import type { PlatformGates } from '../gates.ts';
import {
  resolveConnection,
  resolveWorkspaceAccess,
  usableWorkspaces,
  type ToolAccessDeps,
} from './access.ts';
import { isSafeForModel, toModelPayload } from './errors.ts';

// ---------------------------------------------------------------------------
// 依赖
// ---------------------------------------------------------------------------

/**
 * 装配根提供的事实。**没有默认值**：这三个值都是本机事实，
 * 由代码里的常量或进程启动参数决定，猜一个默认值就等于在
 * `bridge_status` 里编造一次事实。
 */
export interface ToolSurfaceFacts {
  readonly server_version: string;
  /** 本地 IPC 协议版本。与 `contract_version` 不是一个东西。 */
  readonly protocol_version: string;
  readonly gates: PlatformGates;
  /**
   * 现在停着吗（LWB-034 的紧急停用）。**每次读都现查状态库。**
   *
   * ## 它为什么是一个函数而不是一个布尔字段
   *
   * 在 LWB-034 之前这里是 `paused: boolean`，而装配根填的是写死的 `false`
   * —— 那时状态库里确实没有设置表，工具面也没有任何东西能让它变成 `true`。
   * 那次缺席被记在 `docs/PROGRESS.md` 的偏差里，而记录它的方式正是
   * 「留一个恒为 false 的字段」。
   *
   * 现在状态源有了（迁移 v8 的 `service_pause` 单行表），于是那个字段
   * 有一个**必然的**实现：读库。把类型从 `boolean` 改成 `() => boolean`
   * 是在结构上钉住这件事 —— 一个字段可以被写死，一个函数不行：
   * 想让它恒为 `false`，得有人专门写 `() => false`，而那一眼就看得出来。
   *
   * 它刻意**不**返回完整的暂停报告（`PauseStatus` 要扫四张表，其中一次
   * 是全表扫描），因为这一条路径上每个字节都乘以**每一次工具调用**
   * —— 守卫在调用前后各问一次。
   */
  readonly paused: () => boolean;
  /**
   * 暂停的完整报告。**只有 `bridge_status` 调它**。
   *
   * 它由装配根从**那一个** `PauseService` 上取，而不是在这里另算一遍：
   * 「还握着写盘权的有几件」与「还剩几条没废止」这两个问题的答案
   * 只能有一处推导，否则控制台与工具面迟早会在某一格上给出不同的数。
   */
  readonly pause_status: () => PauseStatus;
}

/** 本地操作者收紧后的限额。省略即用各包的默认值。 */
export interface ToolLimits {
  readonly read?: Partial<ReadLimits>;
  readonly list?: Partial<ListLimits>;
  readonly search?: Partial<SearchLimits>;
  readonly git?: Partial<GitLimits>;
  readonly prepare?: Partial<PrepareLimits>;
  readonly change_query?: Partial<ChangeQueryLimits>;
}

export interface ToolHandlerDeps extends ToolAccessDeps {
  /** Present in production; owns shell children and reaps them during orderly shutdown. */
  readonly command_processes?: CommandProcessManager;
  /** 受控句柄后端（生产上是 `@lwb/winfs`）。 */
  readonly ops: WinfsOps;
  /**
   * 快照库。
   *
   * 它只被 `change_prepare`（写入旧/新字节）与 `change_get`（读回旧字节
   * 以生成差异）使用。**它碰的不是用户工作区**：那棵目录树在受保护根之内，
   * 由 `@lwb/secure-store` 保护，模型没有任何路径指向它（I13）。
   *
   * 装配根不给它默认值：一个「随便找个临时目录」的快照库会把快照写到
   * 受保护根之外，而那种错误在功能上完全看不出来。
   */
  readonly blobs: BlobStore;
  readonly authority: ReadTicketAuthority;
  /** 单调读数（毫秒），供搜索的时间预算用。**不是**「现在几点」。 */
  readonly clock: () => number;
  readonly status: () => ToolSurfaceFacts;
  readonly limits?: ToolLimits;
  /**
   * 已解析的生效限额（LWB-018）。
   *
   * 由装配根给出 `@lwb/limits` 的 `resolveLimits(...).limits` 的结果 ——
   * 也就是说，本地配置的收紧在这里**已经生效**，这一层不再做任何判断。
   * 省略即用冻结初值（`LIMITS`）：那是「没有任何配置层」的语义，
   * 不是「不用比」。
   */
  readonly effective_limits?: LimitTable;
  /**
   * 并发闸门。
   *
   * 注入它有两个理由：**只有一个**闸门必须跨全部工具共享（每个工具
   * 各建一个等于没有限额），而这件事由装配根保证比由每个工具自觉更可靠；
   * 测试也需要一个等待时长为 0、且不真的睡眠的闸门来构造确定性的边界。
   */
  readonly concurrency?: ConcurrencyGate;
  /**
   * 执行协调器（LWB-032）。
   *
   * **与后台推进用的是同一个**，不是「工具面自己的一个」：协调器持有
   * 执行器标识、槽租约与阻断判定的全部状态，两个实例会在同一个物理工作区上
   * 各自以为自己是持有者。装配根只造一个。
   */
  readonly coordinator: ExecutionCoordinator;
  /**
   * 应用调用的等待预算与异常出口。
   *
   * 省略即默认预算（`DEFAULT_APPLY_WAIT_MS`，15 秒）与静默 —— 但**不吞**，
   * 理由见 `apply-service.ts` 的文件头。测试用 `wait_ms: 0` 构造
   * 「还没等到结论」那一格，而不必真的等 15 秒。
   */
  readonly apply_options?: {
    readonly wait_ms?: number;
    readonly on_notice?: (notice: ApplyServiceNotice) => void;
  };
}

// ---------------------------------------------------------------------------
// 信封
// ---------------------------------------------------------------------------

/**
 * 回显给模型的关联 ID。
 *
 * 用的是 IPC 层为本次请求生成的 id（`req_…`），这样模型看到的结果与
 * 本地审计记录说的是同一件事。但它**必须先通过形状检查**才回显：
 * 回显一条来路不明的字符串就等于把这一层变成一个回音壁 ——
 * 哪怕今天它只可能是本进程生成的。
 */
const REQUEST_ID_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * 本次调用的关联 ID。**导出**是刻意的：审计（`guard.ts`）要写的
 * `request_id` 与信封里回给模型的那个**必须是同一个值** ——
 * 两处各生成一次，它们就会在某个时刻不同，而不同的时候调查者会
 * 以为「审计里没有这次调用」，不会想到是两个 ID。
 */
export function requestIdOf(context: RequestContext): string {
  return REQUEST_ID_SHAPE.test(context.request_id) ? context.request_id : newRequestId();
}

/**
 * 捕获一切，翻成一个信封。**这是本文件里唯一的 try/catch**。
 *
 * 导出给 `operations.ts` 的清单操作用：那条操作不是工具，但它同样
 * 不能抛（理由见 `operations.ts` 文件头与 `tool-catalog.ts` 的
 * `TOOL_CATALOG_OUTPUT`）。两处各写一份 catch 就等于有两个地方
 * 可以把「翻译成什么错误码」写歪。
 */
export async function asEnvelope<T>(
  context: RequestContext,
  run: () => Promise<T> | T,
): Promise<Envelope<T>> {
  const requestId = requestIdOf(context);
  try {
    return ok(await run(), requestId);
  } catch (cause) {
    return err(toModelPayload(cause), requestId);
  }
}

/** schema 推出来的入参类型。与契约接口的双向一致由 `tools.ts` 的核对表钉住。 */
type ToolInput<N extends ToolName> = z.infer<(typeof TOOL_INPUT_SCHEMAS)[N]>;

/** 入参校验。失败信息只描述**参数本身**，见文件头。 */
function parseInput<N extends ToolName>(name: N, raw: unknown): ToolInput<N> {
  const parsed = TOOL_INPUT_SCHEMAS[name].safeParse(raw);
  // 索引一个 schema 联合体，推出来的是成员的联合；具体是哪一个由 `name` 决定，
  // 而这条对应关系正是上面那张核对表钉住的东西。
  if (parsed.success) return parsed.data as ToolInput<N>;

  const issue = parsed.error.issues[0];
  throw new BridgeError('INVALID_ARGUMENT', `参数不符合该工具的输入契约（${issue?.code ?? 'INVALID'}）。`, {
    reason: 'INPUT_SCHEMA_VIOLATION',
    ...(issueFieldOf(issue) === '' ? {} : { field: issueFieldOf(issue) }),
  });
}

/**
 * 出错的字段名。**认不出的键要说出来是哪一个。**
 *
 * 未知字段的 issue（`unrecognized_keys`）在 zod 里 `path` 是**空数组** ——
 * 因为「多了一个键」不是某一个路径上的错误，而是那一层的错误。只看
 * `issue.path` 的话，`{verbose: true}` 得到的回答是「参数不合法」而
 * 不带字段名，而调用方唯一能做的修正就是猜。
 *
 * 因此这里多读一个 `keys`：它就在 zod 报这个错时携带的字段里。
 * 仍然只回**键名**，不回值 —— 键名是调用方自己发来的，值可能是内容。
 */
function issueFieldOf(issue: z.core.$ZodIssue | undefined): string {
  if (issue === undefined) return '';
  const path = issue.path.join('.');
  if (path !== '') return path;
  if (issue.code === 'unrecognized_keys') return issue.keys.join(',');
  return '';
}

// ---------------------------------------------------------------------------
// 显示用的本地文案
// ---------------------------------------------------------------------------

/**
 * 别名 / 显示名是**操作者自己写的自由文本**（连接别名、工作区别名），
 * 它会出现在模型可见的结果里。操作者完全可能把它取成 `D:\私事\项目`。
 *
 * 因此它和本进程生成的每一条文本走同一道闸：形态与内容两道都过才原样放行，
 * 否则换成中性占位符。这道检查不是怀疑操作者，是让「结果里没有本机绝对
 * 路径」这条性质**不依赖于任何人的命名习惯**。
 */
const UNNAMEABLE = '(未命名)';

function displayableAlias(alias: string): string {
  return isSafeForModel(alias) ? alias : UNNAMEABLE;
}

// ---------------------------------------------------------------------------
// 连接级能力
// ---------------------------------------------------------------------------

/**
 * 连接级能力开关。
 *
 * 全局字段表示 daemon 支持的操作；`recovery_required` 是**逐工作区**的事实，连接级上的诚实说法是
 * 「至少有一个授权工作区正等待人工恢复」，所以取的是**或**。
 * 取与会让模型在读到一个待恢复的工作区之前先得到一个「一切正常」的世界图景。
 *
 * 全局能力描述一致；该连接的恢复状态则由自己的授权工作区现算。
 */
function connectionFlags(connection: ConnectionRecord, deps: ToolHandlerDeps): CapabilityFlags {
    const base = capabilityFlagsFrom();
  const recovery = usableWorkspaces(deps.repos, connection.id).some(
    (workspace) => deps.capability_flags(workspace).recovery_required,
  );
  return { ...base, recovery_required: recovery };
}

// ---------------------------------------------------------------------------
// 工具 → 策略动作
// ---------------------------------------------------------------------------

/**
 * 每个工具做判定时要报的动作名。**这是唯一的来源**：处理器不写字面量，
 * 而是从这里取，因此不可能出现「注册/文档说这是读取、执行时按另一个动作判」。
 *
 * 两个连接级工具映射为 `null`，因为它们**不做工作区判定**，也就没有动作 ——
 * 用一个看起来像动作的占位值（比如借用 `'list'`）会让读者以为它们经过了
 * `decide()`。
 *
 * 这张表里**读取类**的动作（`list` / `read` / `search` / `git_status` /
 * `git_diff` / `snapshot_read`）在 `ACTION_SPECS` 里 `requires_ticket` 都是
 * false，而 `resolveWorkspaceAccess` 对它们传的 `presented` 恒为
 * `{generation:null,policy_version:null}`。
 *
 * LWB-025 之后表里第一次出现了一个**需要票据**的动作（`change_prepare`），
 * 因此上面那句话不再是全表成立的。它仍然是安全的，但理由换了一条：
 * `change_prepare` 的处理器**必须**先验签读取票据、从票据里取代次，
 * 再把它作为 `presented` 交给判定 —— 见 `changePrepare` 与
 * `WorkspaceAccessRequest.presented` 的说明。这个性质由单元测试逐条钉住
 * （而不是在这里再写一遍推导：两处判断总有分开的一天）。
 */
export const TOOL_POLICY_ACTIONS = {
  bridge_status: null,
  workspace_list: null,
  file_list: 'list',
  file_read: 'read',
  text_search: 'search',
  git_status: 'git_status',
  git_diff: 'git_diff',
  change_prepare: 'change_prepare',
  file_create: 'file_create',
  file_edit: 'change_prepare',
  file_delete: 'file_delete',
  // 读的是**快照库与状态库**，不是用户工作区。`snapshot_read` 这个面
  // 因此与 `file_read` 分开：它的出站义务是 `block` 而不是 `redact`
  // —— 一份差异被局部脱敏之后行号会对不上，而那正是差异的全部意义。
  change_get: 'snapshot_read',
  // 只读状态库，且只读**本连接自己**的行（SQL 里的 `owner_connection_id`）。
  // 没有动作 = 不做工作区判定，与 `bridge_status` 同类。
  change_list: null,
  // `propose` 是本地控制台配置的逐目录读写授权；具体写入仍由受保护执行器完成。
  change_apply: 'change_apply',
  // 撤销**提议**：与 `change_prepare` 一样由该 workspace 的 propose grant 授权；
  // 它只生成逆向修改集，不直接写用户文件。
  change_revert_prepare: 'change_revert_prepare',
  command_exec: 'command_exec',
} satisfies Readonly<Record<ImplementedToolName, PolicyAction | null>>;

// ---------------------------------------------------------------------------
// 处理器
// ---------------------------------------------------------------------------

async function bridgeStatus(input: unknown, context: RequestContext, deps: ToolHandlerDeps): Promise<Envelope<BridgeStatusData>> {
  return await asEnvelope(context, () => {
    parseInput('bridge_status', input);
    const connection = resolveConnection(context, deps);
    const gates = deps.status().gates;
    const flags = connectionFlags(connection, deps);
    // 一次，不是两次：`pause_status()` 扫四张表，而下面「停着没有」
    // 与三个计数必须来自**同一次**读，否则同一份回答里会出现
    // 「paused: false，但有 2 件写入正在停止」这种自相矛盾的话。
    const pause = deps.status().pause_status();

    return {
      connection_alias: displayableAlias(connection.alias),
      server_version: deps.status().server_version,
      protocol_version: deps.status().protocol_version,
      contract_version: CONTRACT_VERSION,
      capabilities: flags,
      gates: {
        g0_platform_verified: gates.g0_platform_verified,
        native_guard_verified: gates.native_guard_verified,
      },
      paused: pause.paused,
      paused_at: pause.paused_at,
      pause: {
        stopping_writes: pause.stopping.length,
        unrevoked_change_sets: pause.unrevoked_change_sets.length,
        recovery_operations: pause.recovery_operations.length,
      },
      // 限制说明从能力支持、验收状态与暂停读数推导；具体目录权限由 grant 决定。
      limitations: limitationsOf(flags, gates, pause),
    };
  });
}

/**
 * 本连接的工作区清单。
 *
 * 它**不探测磁盘**：返回的是授权状态（谁被授权、什么模式、什么代次），
 * 不是可达性。根被拔掉、盘符消失这类事实由第一次真正的读取报出来 ——
 * 在这里预先声明一个「可达」字段会让它成为一份缓存的、会过期的断言。
 */
async function workspaceList(input: unknown, context: RequestContext, deps: ToolHandlerDeps): Promise<Envelope<WorkspaceListData>> {
  return await asEnvelope(context, () => {
    parseInput('workspace_list', input);
    const connection = resolveConnection(context, deps);
    const usable = usableWorkspaces(deps.repos, connection.id);
    const page = usable.slice(0, MAX_WORKSPACES_LISTED);

    return {
      workspaces: page.map((workspace) => ({
        workspace_id: workspace.id,
        display_name: displayableAlias(workspace.alias),
        kind: workspace.kind,
        mode: workspace.mode,
        enabled: workspace.enabled,
        capabilities: deps.capability_flags(workspace),
        generation: workspace.generation,
        single_file_path: singleFilePathOf(workspace),
      })),
      // 截断必须**如实**报出来：一个被静默截短的清单会让模型以为
      // 「授权的工作区就这些」，而它据此回答用户时无法自查。
      truncated: usable.length > page.length,
    };
  });
}

/**
 * 单文件工作区的模型可见路径。**是空串**，不是文件名。
 *
 * 根的相对路径按定义就是空串，而策略层对 `kind:'file'` 的要求也正是
 * 「只接受空相对路径」（`WORKSPACE_KIND_MISMATCH`）—— 于是这里回的
 * 恰好是 `file_read` / `git_diff` 下一次该给的那个值。
 *
 * 曾经考虑过回文件名（`.env` → `.env`）：它看起来更好用，但那个值
 * **任何工具都不接受**（拿它去读会落到根的外面）。一个长得像入参、
 * 实际不是入参的字段比一个空串危险得多。文件名本身由 `file_list`
 * 给出（单文件工作区的条目里就有）。
 */
function singleFilePathOf(workspace: WorkspaceRecord): string | null {
  return workspace.kind === 'file' ? '' : null;
}

/**
 * 清单最多列出多少个工作区。
 *
 * 它是**显示上限**，不是安全边界：超过它时 `truncated` 为真，模型据此
 * 知道自己看到的不是全部。定在 `packages/contracts/src/limits.ts` 之外，
 * 是因为那里放的是「一次调用能带出多少字节 / 多少个对象」这类**资源**限额，
 * 而这个数是「一屏能看几个」。单用户本机上它不可能被触及，留着只是因为
 * 契约里有 `truncated` 这个字段，而它必须对应某一个真实的判断。
 */
const MAX_WORKSPACES_LISTED = 64;

async function fileList(input: unknown, context: RequestContext, deps: ToolHandlerDeps): Promise<Envelope<FileListData>> {
  return await asEnvelope(context, async () => {
    const parsed = parseInput('file_list', input);
    const access = await resolveWorkspaceAccess(
      { workspace_id: parsed.workspace_id, action: TOOL_POLICY_ACTIONS.file_list, path: parsed.path ?? '' },
      context,
      deps,
    );

    return await listDirectory(
      {
        scope: access.scope,
        connection_id: access.connection.id,
        decision: access.decision,
        input: parsed,
        now: deps.now(),
      },
      {
        ops: deps.ops,
        authority: deps.authority,
        budget: access.budget,
        ...(deps.limits?.list === undefined ? {} : { limits: deps.limits.list }),
      },
    );
  });
}

async function fileRead(input: unknown, context: RequestContext, deps: ToolHandlerDeps): Promise<Envelope<FileReadData>> {
  return await asEnvelope(context, async () => {
    const parsed = parseInput('file_read', input);
    const access = await resolveWorkspaceAccess(
      { workspace_id: parsed.workspace_id, action: TOOL_POLICY_ACTIONS.file_read, path: parsed.path },
      context,
      deps,
    );

    return await readFile(
      {
        scope: access.scope,
        connection_id: access.connection.id,
        decision: access.decision,
        input: parsed,
        now: deps.now(),
      },
      {
        ops: deps.ops,
        authority: deps.authority,
        budget: access.budget,
        ...(deps.limits?.read === undefined ? {} : { limits: deps.limits.read }),
      },
    );
  });
}

async function textSearchTool(input: unknown, context: RequestContext, deps: ToolHandlerDeps): Promise<Envelope<TextSearchData>> {
  return await asEnvelope(context, async () => {
    const parsed = parseInput('text_search', input);
    const access = await resolveWorkspaceAccess(
      { workspace_id: parsed.workspace_id, action: TOOL_POLICY_ACTIONS.text_search, path: parsed.path ?? '' },
      context,
      deps,
    );

    return await textSearch(
      {
        scope: access.scope,
        connection_id: access.connection.id,
        decision: access.decision,
        input: parsed,
        now: deps.now(),
      },
      {
        ops: deps.ops,
        authority: deps.authority,
        budget: access.budget,
        clock: deps.clock,
        // 没有取消通道：`RequestContext` 里没有取消信号，IPC 层也没有把
        // 连接断开传下来。因此搜索只会因为**自己的**时间/字节预算而停，
        // 结果里的 `cancelled` 恒为 false。断线留一个仍在跑的搜索，
        // 是 LWB-018 的账（偏差记录里有）。
        ...(deps.limits?.search === undefined ? {} : { limits: deps.limits.search }),
      },
    );
  });
}

async function gitStatusTool(input: unknown, context: RequestContext, deps: ToolHandlerDeps): Promise<Envelope<GitStatusData>> {
  return await asEnvelope(context, async () => {
    const parsed = parseInput('git_status', input);
    const access = await resolveWorkspaceAccess(
      { workspace_id: parsed.workspace_id, action: TOOL_POLICY_ACTIONS.git_status, path: parsed.path ?? '' },
      context,
      deps,
    );

    return await gitStatus(
      {
        scope: access.scope,
        connection_id: access.connection.id,
        decision: access.decision,
        input: parsed,
      },
      {
        ops: deps.ops,
        budget: access.budget,
        ...(deps.limits?.git === undefined ? {} : { limits: deps.limits.git }),
      },
    );
  });
}

async function gitDiffTool(input: unknown, context: RequestContext, deps: ToolHandlerDeps): Promise<Envelope<GitDiffData>> {
  return await asEnvelope(context, async () => {
    const parsed = parseInput('git_diff', input);
    const access = await resolveWorkspaceAccess(
      { workspace_id: parsed.workspace_id, action: TOOL_POLICY_ACTIONS.git_diff, path: parsed.path },
      context,
      deps,
    );

    return await gitDiff(
      {
        scope: access.scope,
        connection_id: access.connection.id,
        decision: access.decision,
        input: parsed,
      },
      {
        ops: deps.ops,
        budget: access.budget,
        ...(deps.limits?.git === undefined ? {} : { limits: deps.limits.git }),
      },
    );
  });
}

type CommandCancellationCode =
  | 'CONNECTION_DISABLED'
  | 'WORKSPACE_NOT_GRANTED'
  | 'WORKSPACE_GENERATION_CHANGED'
  | 'POLICY_DENIED'
  | 'PAUSED'
  | 'RECOVERY_REQUIRED'
  | 'STORAGE_UNAVAILABLE';

const POSIX_ABSOLUTE_PATH_SHAPE = /(?:^|[\s"'`=])(?:file:\/\/(?:localhost)?\/+|file:\/+|\/)(?:[A-Za-z0-9._~+-]+\/)*[A-Za-z0-9._~+-]+/i;

function commandOutputIsSafe(text: string): boolean {
  return isSafeForModel(text) && !POSIX_ABSOLUTE_PATH_SHAPE.test(text);
}

function commandCancellationCode(
  deps: ToolHandlerDeps,
  connectionId: string,
  workspaceId: string,
  generation: number,
): CommandCancellationCode | null {
  try {
    if (deps.status().paused()) return 'PAUSED';
    const connection = deps.repos.connections.findById(connectionId);
    if (connection === null || !connection.enabled) return 'CONNECTION_DISABLED';
    const grant = deps.repos.grants.find(connectionId, workspaceId);
    if (grant === null || !grant.enabled || !grant.capabilities.includes('command_exec')) {
      return 'WORKSPACE_NOT_GRANTED';
    }
    const workspace = deps.repos.workspaces.findById(workspaceId);
    if (workspace === null || workspace.removed_at !== null || !workspace.enabled) return 'WORKSPACE_NOT_GRANTED';
    if (workspace.generation !== generation) return 'WORKSPACE_GENERATION_CHANGED';
    if (workspace.mode !== 'read_propose_apply_with_local_approval') return 'POLICY_DENIED';
    if (deps.capability_flags(workspace).recovery_required) return 'RECOVERY_REQUIRED';
    return null;
  } catch {
    return 'STORAGE_UNAVAILABLE';
  }
}

function commandCancellationError(code: CommandCancellationCode, mayHaveChangedFiles: boolean): BridgeError {
  const partial = mayHaveChangedFiles
    ? '命令可能已经执行了一部分并产生副作用；请先检查工作区现状，不会自动回滚。'
    : '命令尚未启动。';
  switch (code) {
    case 'CONNECTION_DISABLED':
      return new BridgeError('CONNECTION_DISABLED', `连接已停用，命令已停止。${partial}`);
    case 'WORKSPACE_NOT_GRANTED':
      return new BridgeError('WORKSPACE_NOT_GRANTED', `工作区授权已撤销或停用，命令已停止。${partial}`);
    case 'WORKSPACE_GENERATION_CHANGED':
      return new BridgeError('WORKSPACE_GENERATION_CHANGED', `工作区授权状态已变化，命令已停止。${partial}`);
    case 'POLICY_DENIED':
      return new BridgeError('POLICY_DENIED', `工作区已改为只读模式，命令已停止。${partial}`);
    case 'PAUSED':
      return new BridgeError('PAUSED', `本地服务已暂停，命令已停止。${partial}`);
    case 'RECOVERY_REQUIRED':
      return new BridgeError('RECOVERY_REQUIRED', `工作区需要先完成恢复，命令已停止。${partial}`);
    case 'STORAGE_UNAVAILABLE':
      return new BridgeError('STORAGE_UNAVAILABLE', `授权状态无法复核，命令已停止。${partial}`);
  }
}

async function commandExecTool(
  input: unknown,
  context: RequestContext,
  deps: ToolHandlerDeps,
): Promise<Envelope<import('@lwb/contracts').CommandExecData>> {
  return await asEnvelope(context, async () => {
    const parsed = parseInput('command_exec', input) as CommandExecInput;
    const access = await resolveWorkspaceAccess(
      { workspace_id: parsed.workspace_id, action: TOOL_POLICY_ACTIONS.command_exec, path: '' },
      context,
      deps,
    );
    if (access.workspace.kind !== 'directory') {
      throw new BridgeError('POLICY_DENIED', '命令只能在已授权的目录工作区执行；单文件工作区不支持。');
    }
    const processes = deps.command_processes;
    if (processes === undefined) {
      throw new BridgeError('INTERNAL_ERROR', '本地命令执行器未在服务装配中启用。');
    }

    const requestHash = createHash('sha256')
      .update(JSON.stringify([access.workspace.id, parsed.shell, parsed.command]), 'utf8')
      .digest('hex');
    const idempotency = deps.repos.idempotency.begin({
      id: `idem_command_${randomUUID()}`,
      principal_id: access.connection.principal_id,
      tool: 'command_exec',
      key: parsed.idempotency_key,
      request_hash: requestHash,
    });
    if (idempotency.kind === 'conflict') {
      throw new BridgeError(
        'IDEMPOTENCY_CONFLICT',
        '这个幂等键已用于另一条命令或工作区；本次没有启动进程。为新的用户意图生成新键。',
      );
    }
    if (idempotency.kind === 'replay') {
      const priorState = idempotency.record.result_ref;
      const detail = priorState === 'not_started'
        ? '先前同键请求未能启动 shell。'
        : priorState === 'started'
          ? '先前同键请求已启动 shell，可能产生过副作用。'
          : '先前同键请求仍在执行或结果未知。';
      throw new BridgeError(
        'COMMAND_REPLAY_SUPPRESSED',
        `${detail}本次没有启动第二个进程；检查工作区现状后再决定下一步。不得换新键盲目重跑。`,
      );
    }

    const cancellation = new AbortController();
    let cancellationCode: CommandCancellationCode | null = null;
    const checkAuthorization = (): void => {
      if (cancellationCode !== null) return;
      cancellationCode = commandCancellationCode(
        deps,
        access.connection.id,
        access.workspace.id,
        access.workspace.generation,
      );
      if (cancellationCode !== null) cancellation.abort();
    };
    const authorizationWatch = setInterval(checkAuthorization, 100);
    checkAuthorization();

    let result: CommandProcessResult;
    try {
      result = await processes.run({
        shell: parsed.shell,
        command: parsed.command,
        cwd: access.workspace.canonical_root,
        signal: cancellation.signal,
      });
      // Persist only whether a process started, never its stdout/stderr. A replay
      // must not repeat an arbitrary shell command whose first response may have
      // been lost or whose side effects cannot be rolled back.
      deps.repos.idempotency.complete(
        access.connection.principal_id,
        'command_exec',
        parsed.idempotency_key,
        result.started ? 'started' : 'not_started',
      );
    } finally {
      clearInterval(authorizationWatch);
    }

    if (cancellationCode !== null) {
      throw commandCancellationError(cancellationCode, result.started);
    }
    if (result.cancelled) {
      throw new BridgeError(
        'SERVICE_UNAVAILABLE',
        `本地服务正在退出，命令已停止。${result.started ? '命令可能已经产生部分副作用；请先检查工作区，不会自动回滚。' : '命令尚未启动。'}`,
      );
    }
    if (!result.started) {
      throw new BridgeError('COMMAND_SHELL_UNAVAILABLE', '所选命令解释器无法启动；请确认本机已安装该 shell。');
    }

    // Command output is arbitrary process output, not a file-read result. Hide
    // the whole response if it contains an absolute local path or a high-confidence secret.
    const outputWithheld = !commandOutputIsSafe(`${result.stdout}\n${result.stderr}`);
    const safeStdout = outputWithheld ? '[命令输出含本机路径或凭证，已整段隐藏。]' : result.stdout;
    const safeStderr = outputWithheld ? '' : result.stderr;
    const clearance = mintClearance(access.decision, {
      connection_id: access.connection.id,
      generation: access.scope.generation,
    });
    let separator = '\n<LWB_STDERR>\n';
    while (safeStdout.includes(separator) || safeStderr.includes(separator)) separator += '<x>';
    let emission: ReturnType<typeof emitContent>;
    try {
      emission = emitContent(
        clearance,
        { path: '', content: `${safeStdout}${separator}${safeStderr}` },
        access.budget,
      );
    } catch (cause) {
      if (!(cause instanceof BridgeError) || (cause.code !== 'EGRESS_BUDGET_EXCEEDED' && cause.code !== 'SECRET_DETECTED')) {
        throw cause;
      }
      throw new BridgeError(
        cause.code,
        `命令已经启动，但其输出因${cause.code === 'SECRET_DETECTED' ? '秘密筛查' : '出站预算'}未发送；` +
          '命令可能已产生部分副作用，请先检查工作区，再决定是否重试。',
      );
    }
    const separatorAt = emission.content.indexOf(separator);
    if (separatorAt < 0) {
      throw new BridgeError(
        'INTERNAL_ERROR',
        '命令已经运行，但无法拆分其标准输出与错误输出；命令可能已产生副作用，请检查工作区。',
      );
    }

    // Revoke/cancel if permissions changed just after the polling tick. The outer
    // guard also rechecks connection/workspace state immediately before return.
    const finalCancellation = commandCancellationCode(
      deps,
      access.connection.id,
      access.workspace.id,
      access.workspace.generation,
    );
    if (finalCancellation !== null) throw commandCancellationError(finalCancellation, true);

    return {
      shell: parsed.shell,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      timed_out: result.timed_out,
      output_truncated: result.output_truncated,
      output_withheld: outputWithheld || emission.redacted,
      stdout: emission.content.slice(0, separatorAt),
      stderr: emission.content.slice(separatorAt + separator.length),
    };
  });
}

// ---------------------------------------------------------------------------
// 修改提议（LWB-025）
// ---------------------------------------------------------------------------

/**
 * 提案里全部读取票据的代次，**众口一词**才给得出来。
 *
 * ## 为什么只验签、不做绑定比对
 *
 * `verifyReadTicket` 回答的是「这串字符是不是本进程签发的一张未过期读取
 * 票据」。它**不**回答「这张票据是不是属于这条连接、这个工作区、这个文件」
 * —— 那是 `assertReadTokenMatches` 的事，而它在 `validateChangeItems` 里，
 * 拿到的是**授权之后**的代次。顺序不能反过来：绑定要比对的「当前代次」
 * 正是本次授权解析的产物。
 *
 * 因此这一步的产物只用于一件事：告诉判定「本次依据的是哪个代次」。
 * 判定随即把它与工作区行的当前代次比对，不等就拒绝
 * （`GENERATION_CHANGED`）。**一个伪造的代次在这里过不去** ——
 * 它能进入 `presented` 的唯一途径是伪造签名，而那已经越过了 HMAC。
 *
 * ## 为什么代次不一致要单独报
 *
 * 不一致的票据本来也会在 `validateChangeItems` 里被逐条拒掉
 * （那时用的代次只有一种，别的都不等）。单独报一次的价值是**说清原因**：
 * 「同一份提案里的两张票据来自不同代次」与「票据过期了」是两种不同的
 * 用户处境，而后者会让调用方去重新读一个其实不是问题的文件。
 */
function presentedOf(
  items: readonly ChangeItem[],
  now: number,
  authority: ReadTicketAuthority,
): { readonly generation: number; readonly tickets: readonly ReadTicketPayload[] } | null {
  const tickets: ReadTicketPayload[] = [];
  for (const item of items) {
    if (item.op === 'create_text' || item.op === 'delete_file') continue;
    tickets.push(authority.verifyReadTicket(item.read_token, { now }));
  }

  const first = tickets.at(0);
  if (first === undefined) return null;
  for (const ticket of tickets) {
    if (ticket.generation === first.generation) continue;
    throw new BridgeError(
      'READ_TOKEN_STALE',
      '同一份提案里的读取票据来自不同的工作区代次；请重新读取全部目标文件后再一次性提案。',
      { reason: 'TICKET_GENERATION_DISAGREE' },
    );
  }
  return { generation: first.generation, tickets };
}

/**
 * 不需要读取票据的提案（`create_text` / `delete_file`）所依据的代次。
 *
 * ## 这是一处**真实的弱化**，记在 `docs/PROGRESS.md` 的偏差里
 *
 * `create_text` 不读任何文件，`delete_file` 的基线由 daemon 在本次准备阶段读取并快照，
 * 因此二者结构上都不需要客户端读取票据；而
 * `ACTION_SPECS.change_prepare.requires_ticket` 为 true，代次为 `null` 时
 * 判定直接拒绝 —— 于是「在已存在的父目录里创建新文件」这条 V1 明列的
 * 能力会整条不可用。
 *
 * 这里取工作区行上的当前代次。于是这一次代次核对成为**同义反复**
 * （`presented === current` 必然成立）。它买到的只有「工作区行确实存在」
 * 这一件事 —— 而那件事 `resolveWorkspaceAccess` 本来就会查。**它买到的
 * 是可用性，不是安全**：真正的保护在于 `prepareChange` 把代次落库成
 * `root_generation`，而写入路径（LWB-027）在写每一个文件之前重新核对它。
 *
 * 在这里读工作区行**不构成预言机**：结果只进 `presented`，不进回答，
 * 而 `resolveWorkspaceAccess` 仍然先查授权行、后查工作区行，
 * 两种情形（不存在 / 未授权）的回答逐字不变。行不存在时给 `-1`：
 * 那个值在判定里必然与当前代次不等，因此是**失败关闭**，不是放行。
 */
function unticketedGeneration(workspaceId: string, deps: ToolHandlerDeps): number {
  return deps.repos.workspaces.findById(workspaceId)?.generation ?? -1;
}

/**
 * 提案点名的每一条路径都要过文件规则 —— **在 `prepareChange` 之前**。
 *
 * ## 为什么不能只靠 `decide()`
 *
 * `decide()` 的 `fileRuleFailures` 只看 `action.path` 这**一条**，
 * 而 `change_prepare` 是唯一一个一次调用指向多个文件的工具：调用方给的是
 * 工作区 id，被点名的文件在 `items[].path` 里。于是只跑判定的话，
 * 「提案改 `.env`」是**允许**的 —— 工作区根不是一个硬拒绝路径。
 *
 * ## 为什么必须在读取之前
 *
 * `prepareChange` 对每个已存在的目标都要**经受控句柄重读一遍基线字节**
 * 并把它们写进快照库。硬拒绝的语义是「不会读取、不会比较」，
 * 因此「等到写入时才拒绝」不成立：那时字节已经进了本进程的内存与快照库。
 *
 * ## 票据的 `canonical_path` 也要判
 *
 * `items[].path` 是调用方写下的拼写，`canonical_path` 是磁盘上的拼写。
 * `classifyFile` 两侧都按大小写不敏感匹配，因此现实中的拼写差异
 * （大小写）不会造成漏判。**剩下的缺口是 8.3 短名与硬链接**：一个指向
 * `.env` 的短名（`ENV~1`）在两条路径上都不命中 `HD-ENV`。
 * 那个缺口由写入路径按**对象身份**（volume_id / file_id）再判一次来关
 * —— 见 LWB-027 与 `docs/PROGRESS.md` 的偏差记录。
 */
function assertProposalPathsAllowed(paths: readonly string[], rules: readonly FileRule[]): void {
  for (const path of paths) {
    const verdict = classifyFile(path, rules);
    if (verdict.kind !== 'hard_deny') continue;
    throw new BridgeError(
      'POLICY_DENIED',
      `提案点名的路径命中硬拒绝规则 ${verdict.rule_id}；不会读取基线、不会建立修改集，也不会在授权目录内写入。`,
      { reason: 'HARD_DENY_IN_PROPOSAL', hard_deny_rule: verdict.rule_id, blocked_at: 'prepare' },
    );
  }
}

/**
 * `change_prepare`：建立一份不可变多文件修改集。**不写用户工作区**；
 * 具备该根的文件修改 grant 后，再调用 `change_apply` 应用。
 */
async function changePrepare(
  input: unknown,
  context: RequestContext,
  deps: ToolHandlerDeps,
): Promise<Envelope<ChangePrepareData>> {
  return await asEnvelope(context, async () => {
    const parsed = parseInput('change_prepare', input);
    return await prepareChangeRequest(parsed, TOOL_POLICY_ACTIONS.change_prepare, context, deps);
  });
}

async function fileCreate(
  input: unknown,
  context: RequestContext,
  deps: ToolHandlerDeps,
): Promise<Envelope<ChangeApplyData>> {
  return await asEnvelope(context, async () => {
    const parsed = parseInput('file_create', input) as FileCreateInput;
    const prepared = await prepareChangeRequest(
      {
        workspace_id: parsed.workspace_id,
        idempotency_key: parsed.idempotency_key,
        summary: parsed.summary,
        items: [
          {
            op: 'create_text',
            path: parsed.path,
            content: parsed.content,
            newline: parsed.newline,
            bom: parsed.bom,
          },
        ],
      },
      TOOL_POLICY_ACTIONS.file_create,
      context,
      deps,
    );
    return await applyChangeRequest(
      { change_id: prepared.change_id, idempotency_key: parsed.idempotency_key },
      context,
      deps,
    );
  });
}

async function fileEdit(
  input: unknown,
  context: RequestContext,
  deps: ToolHandlerDeps,
): Promise<Envelope<ChangeApplyData>> {
  return await asEnvelope(context, async () => {
    const parsed = parseInput('file_edit', input) as FileEditInput;
    const prepared = await prepareChangeRequest(
      {
        workspace_id: parsed.workspace_id,
        idempotency_key: parsed.idempotency_key,
        summary: parsed.summary,
        items: [
          {
            op: 'edit_text',
            path: parsed.path,
            base_sha256: parsed.base_sha256,
            read_token: parsed.read_token,
            edits: parsed.edits,
          },
        ],
      },
      TOOL_POLICY_ACTIONS.file_edit,
      context,
      deps,
    );
    return await applyChangeRequest(
      { change_id: prepared.change_id, idempotency_key: parsed.idempotency_key },
      context,
      deps,
    );
  });
}

async function fileDelete(
  input: unknown,
  context: RequestContext,
  deps: ToolHandlerDeps,
): Promise<Envelope<ChangeApplyData>> {
  return await asEnvelope(context, async () => {
    const parsed = parseInput('file_delete', input) as FileDeleteInput;
    const prepared = await prepareChangeRequest(
      {
        workspace_id: parsed.workspace_id,
        idempotency_key: parsed.idempotency_key,
        summary: parsed.summary,
        items: [{ op: 'delete_file', path: parsed.path }],
      },
      TOOL_POLICY_ACTIONS.file_delete,
      context,
      deps,
    );
    return await applyChangeRequest(
      { change_id: prepared.change_id, idempotency_key: parsed.idempotency_key },
      context,
      deps,
    );
  });
}

async function prepareChangeRequest(
  parsed: ChangePrepareInput,
  action: PolicyAction,
  context: RequestContext,
  deps: ToolHandlerDeps,
): Promise<ChangePrepareData> {
  const now = deps.now();

  // 票据先验签：`presented` 只许来自已验签的票据，而判定需要它。
  const presented = presentedOf(parsed.items, now, deps.authority);

  const access = await resolveWorkspaceAccess(
    {
      workspace_id: parsed.workspace_id,
      action,
      // `decide()` 只判一条路径，而本次调用指向**多个**文件。给根（`''`）
      // 是对这件事的诚实说法：「本次调用没有单一的目标路径」。
      // 逐路径的硬拒绝在下面，用的是判定当场交出来的那张规则表
      // （`access.decision.rules`）—— 因此两处不可能不是同一版策略。
      path: '',
      // `policy_version` 恒为 `null`：读取票据里**没有**这个字段
      // （`ReadTicketFacts` 只有 `generation`），因此填一个当下的值
      // 只会是一次假装成核对的同义反复。真实的依据是规则表本身 ——
      // 判定当场把 `decision.rules` 交出来，而下面逐路径判硬拒绝用的
      // 就是它；`prepareChange` 落库的也是当下的 `policy_version`。
      presented: {
        generation: presented?.generation ?? unticketedGeneration(parsed.workspace_id, deps),
        policy_version: null,
      },
    },
    context,
    deps,
  );

  assertProposalPathsAllowed(
    [
      ...parsed.items.map((item) => item.path),
      ...(presented?.tickets ?? []).map((ticket) => ticket.canonical_path),
    ],
    access.decision.rules,
  );

  return await prepareChange(
    {
      // 身份来自**通道**（连接记录），不是工具参数：`ChangePrepareInput`
      // 里没有 `principal_id` 这样的字段，而 schema 是 strictObject，
      // 多给一个键就会被拒绝（ADR-003 §4）。
      principal_id: access.connection.principal_id,
      connection_id: access.connection.id,
      workspace_id: access.workspace.id,
      generation: access.scope.generation,
      policy_version: access.workspace.policy_version,
      scope: access.scope,
      now,
      input: parsed,
    },
    {
      ops: deps.ops,
      authority: deps.authority,
      blobs: deps.blobs,
      repos: deps.repos,
      ...(deps.limits?.prepare === undefined ? {} : { limits: deps.limits.prepare }),
    },
  );
}

/**
 * `change_get`：一条修改集的状态、回执与（可选）逐文件差异。
 *
 * ## 为什么先判归属、再解析授权
 *
 * 授权解析按**工作区**进行，而这个工具的入参里没有 `workspace_id`
 * —— 它按 `change_id` / `operation_id` 指名，工作区只能从记录上读出来。
 * `ownedChangeOf` 只回 `{change_id, workspace_id}` 两个 id，不是整条记录：
 * 处理器除了「拿它去解析授权」之外做不了别的，因此不存在「绕过授权
 * 自己拼一个视图」的写法。
 *
 * ## 为什么判定的 `path` 给空串
 *
 * 入参里的 `path` 只是「我想看哪个文件的差异」，它**还没和修改集比对过**。
 * 拿它去判定会把一条不属于本修改集的路径变成一个 `POLICY_DENIED`
 * （而正确答案是 `PATH_NOT_IN_CHANGE`），却买不到任何安全性：
 * 真正的逐路径硬拒绝在 `diffPageOf` 里（碰快照**之前**，用的是票据级
 * 的规范拼写），以及在出站闸门里（权威那一次）。
 */
async function changeGet(
  input: unknown,
  context: RequestContext,
  deps: ToolHandlerDeps,
): Promise<Envelope<ChangeGetData>> {
  return await asEnvelope(context, async () => {
    const parsed = parseInput('change_get', input);
    const owned = ownedChangeOf(parsed, context.connection_id, deps.repos);

    const access = await resolveWorkspaceAccess(
      { workspace_id: owned.workspace_id, action: TOOL_POLICY_ACTIONS.change_get, path: '' },
      context,
      deps,
    );

    return await changeGetDataOf(
      {
        context: {
          connection_id: access.connection.id,
          scope: access.scope,
          decision: access.decision,
          budget: access.budget,
        },
        input: parsed,
      },
      {
        repos: deps.repos,
        blobs: deps.blobs,
        ...(deps.limits?.change_query === undefined ? {} : { limits: deps.limits.change_query }),
      },
    );
  });
}

/**
 * `change_list`：本连接自己建立的修改集。
 *
 * 不做工作区判定（`TOOL_POLICY_ACTIONS.change_list` 为 `null`），因为
 * 它一个用户文件字节都不碰：返回的每一行都来自状态库，且 SQL 里带着
 * `owner_connection_id = ?` —— 别的连接的行**不可能**出现在结果里。
 */
async function changeList(
  input: unknown,
  context: RequestContext,
  deps: ToolHandlerDeps,
): Promise<Envelope<ChangeListData>> {
  return await asEnvelope(context, () => {
    const parsed = parseInput('change_list', input);
    const connection = resolveConnection(context, deps);
    return changeListDataOf(
      { connection_id: connection.id, input: parsed },
      {
        repos: deps.repos,
        blobs: deps.blobs,
        ...(deps.limits?.change_query === undefined ? {} : { limits: deps.limits.change_query }),
      },
    );
  });
}

/**
 * `change_apply`：`propose` 逐目录授权即为持续的本地写入授权。
 * 这里重算落库摘要，并在同一事务内生成一次性执行批准与唯一操作，随后交给
 * 既有 Win32 受保护执行器。没有再要求用户对每个修改重复确认。
 */
async function changeApply(
  input: unknown,
  context: RequestContext,
  deps: ToolHandlerDeps,
): Promise<Envelope<ChangeApplyData>> {
  return await asEnvelope(context, async () => {
    const parsed = parseInput('change_apply', input);
    return await applyChangeRequest(parsed, context, deps);
  });
}

async function applyChangeRequest(
  parsed: ChangeApplyInput,
  context: RequestContext,
  deps: ToolHandlerDeps,
): Promise<ChangeApplyData> {
    // 归属先于一切：不是本连接的修改集，与不存在回答相同（`ownedChangeOf`）。
    const owned = ownedChangeOf(parsed, context.connection_id, deps.repos);

    // 这次调用**不可能**产生写入（见 `canBeginWrite`）⇒ 它只能是一个问题：
    // 「刚才那次写到哪了」。这一分支**必须**排在上面那道写入门禁之前，
    // 理由见 `replayApplied`。
    if (deps.repos.operations.findByChangeId(owned.change_id) !== null ||
        !canBeginWrite(deps.repos, owned.change_id)) {
      return await replayApplied(owned, context, deps);
    }

    const loaded = reloadChangeSet(deps.repos, owned.change_id);
    const nowIso = new Date(deps.now()).toISOString();

    const access = await resolveWorkspaceAccess(
      {
        workspace_id: owned.workspace_id,
        action: TOOL_POLICY_ACTIONS.change_apply,
        // 本次调用没有单一目标路径（它作用于整条修改集），给根是诚实说法。
        path: '',
        // 代次与策略版本取**这条修改集建立时的那一份**，而不是当下的。
        // 「当下」是判定层自己读的（`workspace.current_generation`），
        // 而这里要回答的是「调用方依据的是哪一版世界」—— 那正是这条记录。
        // 于是两处不一致时判定层报 `GENERATION_CHANGED`，与门禁里
        // `revalidateExecutionBindings` 的结论是同一句话。
        //
        // 走到这里时它们必然已经相等（门禁刚判过），因此这一次核对是
        // 同义反复。它买的只有一件事：**这句话写在代码里**，
        // 而不是靠「门禁先跑过了」这个行序隐含。
        presented: {
          generation: loaded.change.root_generation,
          policy_version: loaded.change.policy_version,
        },
      },
      context,
      deps,
    );

    let queued: ReturnType<typeof approveAndQueue>;
    try {
      queued = approveAndQueue({
        repos: deps.repos,
        change_id: owned.change_id,
        digest: loaded.digest,
        actor: `workspace-grant:${access.grant.id}`,
        now: nowIso,
        idempotency_key: parsed.idempotency_key,
      });
    } catch (error) {
      // Two concurrent apply calls can both pass the initial read. The unique
      // operation remains the arbiter; the loser returns that operation's receipt.
      if (deps.repos.operations.findByChangeId(owned.change_id) !== null ||
          !canBeginWrite(deps.repos, owned.change_id)) {
        return await replayApplied(owned, context, deps);
      }
      throw error;
    }

    return await applyChange(
      // 连接身份来自**通道**（这里的 `access.connection` 是解析链条的产物），
      // 不是工具参数 —— `ChangeApplyInput` 里没有 `connection_id`。
      { change_id: queued.change.id, connection_id: access.connection.id },
      applyServiceDeps(deps),
    );
}

/**
 * 已有操作时复用唯一 operation 并返回其回执，不创建第二次写入。
 * 回执仍要求该连接持有本工作区的文件修改 grant。
 */
async function replayApplied(
  owned: { readonly change_id: string; readonly workspace_id: string },
  context: RequestContext,
  deps: ToolHandlerDeps,
): Promise<ChangeApplyData> {
  const workspace = deps.repos.workspaces.findById(owned.workspace_id);
  if (workspace === null) throw new BridgeError('WORKSPACE_NOT_GRANTED', '该工作区已不可用。');
  const access = await resolveWorkspaceAccess(
    {
      workspace_id: owned.workspace_id,
      action: TOOL_POLICY_ACTIONS.change_apply,
      path: '',
      presented: { generation: workspace.generation, policy_version: workspace.policy_version },
    },
    context,
    deps,
  );

  return await applyChange(
    { change_id: owned.change_id, connection_id: access.connection.id },
    applyServiceDeps(deps),
  );
}

/** 应用服务的依赖。两个阶段共用，免得两处对「等多久」各写一个数。 */
function applyServiceDeps(deps: ToolHandlerDeps): ApplyServiceDeps {
  return {
    repos: deps.repos,
    coordinator: deps.coordinator,
    ...(deps.apply_options?.wait_ms === undefined ? {} : { wait_ms: deps.apply_options.wait_ms }),
    ...(deps.apply_options?.on_notice === undefined ? {} : { on_notice: deps.apply_options.on_notice }),
  };
}

/**
 * `change_revert_prepare`：为一次已应用的修改生成**新的**逆向修改集。
 *
 * ## 它一次用户字节都不写
 *
 * 撤销**不是**把旧的抹掉，而是「按**当前**文件重算一次改写，落成一条新的
 * 待批准修改集」（LWB-031）。因此本工具与 `change_prepare` 同类：读基线、
 * 建记录、**不写盘** —— 而这一点由 `revert.ts` 里根本不出现的
 * `writeFileGuarded` / `createFileGuarded` 静态保证，不靠本函数自觉。
 *
 * ## 归属在这里被查了**两次**，而这是刻意的
 *
 * 一次在本函数（为了拿到 `workspace_id` 去解析授权），一次在
 * `prepareRevert` 内部（`requireRevertibleSource`）。两次查的是同一条
 * 不可变记录，结果必然一致。重复的理由与 `change_get` 那条相同：
 * 把归属挂在「必须经过的一步」上，比挂在「调用方记得先调一下」上可靠。
 */
async function changeRevertPrepare(
  input: unknown,
  context: RequestContext,
  deps: ToolHandlerDeps,
): Promise<Envelope<ChangeRevertPrepareData>> {
  return await asEnvelope(context, async () => {
    const parsed = parseInput('change_revert_prepare', input);
    const owned = ownedChangeOf(parsed, context.connection_id, deps.repos);

    const access = await resolveWorkspaceAccess(
      {
        workspace_id: owned.workspace_id,
        action: TOOL_POLICY_ACTIONS.change_revert_prepare,
        // 与 `change_prepare` 同一条理由：本调用作用于整条修改集，
        // 没有单一目标路径，给根是这件事的诚实说法。
        path: '',
        presented: {
          generation: unticketedGeneration(owned.workspace_id, deps),
          policy_version: null,
        },
      },
      context,
      deps,
    );

    return await prepareRevert(
      {
        principal_id: access.connection.principal_id,
        connection_id: access.connection.id,
        workspace_id: access.workspace.id,
        generation: access.scope.generation,
        policy_version: access.workspace.policy_version,
        scope: access.scope,
        now: deps.now(),
        input: parsed,
      },
      {
        ops: deps.ops,
        authority: deps.authority,
        blobs: deps.blobs,
        repos: deps.repos,
        ...(deps.limits?.prepare === undefined ? {} : { limits: deps.limits.prepare }),
      },
    );
  });
}

export type ToolHandler = (
  input: unknown,
  context: RequestContext,
  deps: ToolHandlerDeps,
) => Promise<Envelope<unknown>>;

/**
 * **全部十六个**工具。**与 `IMPLEMENTED_TOOL_NAMES` 逐字对应**，
 * 而后者是输出 schema 那张表的键 —— 少一个处理器或漏一个 schema
 * 都会在下面的 `TOOL_HANDLERS` 上编译失败。
 *
 * LWB-032 把最后两个补上之后，`TOOL_NAMES` 与本表**一一对应**。
 * 实际可用性由 `catalog.ts` 按连接、工作区授权和恢复状态逐条裁定。
 * 表里的每一行只回答「本机有没有代码能接住这次调用」。
 */
export const TOOL_HANDLERS = {
  bridge_status: bridgeStatus,
  workspace_list: workspaceList,
  file_list: fileList,
  file_read: fileRead,
  text_search: textSearchTool,
  git_status: gitStatusTool,
  git_diff: gitDiffTool,
  change_prepare: changePrepare,
  file_create: fileCreate,
  file_edit: fileEdit,
  file_delete: fileDelete,
  change_get: changeGet,
  change_list: changeList,
  change_apply: changeApply,
  change_revert_prepare: changeRevertPrepare,
  command_exec: commandExecTool,
} satisfies Readonly<Record<ImplementedToolName, ToolHandler>>;
