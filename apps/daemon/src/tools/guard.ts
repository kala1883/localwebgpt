/**
 * 工具调用的外层守卫（LWB-018 步骤 2、3）。
 *
 * ## 它为什么必须是一层**包住**处理器的东西
 *
 * LWB-018 要求「每次调用都记录」与「临返回再次检查授权」。这两件事
 * 都有一个共同的失效方式：**漏掉一个工具**。如果它们写成七个处理器
 * 各自末尾的一段代码，那么新增第八个工具的人只需要什么都不做，
 * 就得到了一个没有审计、没有复查的工具 —— 而一切照常工作。
 *
 * 因此它是注册处的包装（`operations.ts` 的循环），而不是处理器内部的
 * 代码：新增工具会自动落进这一层，**不需要任何人记得**。
 *
 * ## 顺序，以及每一步为什么在这个位置
 *
 * ```
 * 1. 全局暂停     → 工作区类调用直接拒绝（不取位置、不碰磁盘）
 * 2. 取并发位置   → 只在工作区类调用上；满了就等，等不到就是「未执行」
 * 3. 记下前像     → 连接与工作区的 enabled / generation（各一次主键查）
 * 4. 处理器       → 它自己完成授权链、读取、出站记账（不抛，只回信封）
 * 5. 返回前复查   → 前像与现在不符 ⇒ **把已经成功的信封换成失败**
 * 6. 写审计       → 事件 + 文件范围，同一个事务；写不进去就不返回内容
 * 7. 释放位置     → finally，无论上面走了哪条路
 * ```
 *
 * ## 为什么复查**不**再探一次根的真实身份
 *
 * 这一步曾经被考虑过（再做一次 `authorizeAccess`），结论是不做：
 *
 *  - 处理器在**本次调用开始时**已经探过一次根身份（`authorizeAccess`），
 *    而写入路径在执行每一个文件前还要再核一次。读取路径上，
 *    「根在调用进行到一半时被换掉」与「下一次调用开始时才发现根被换掉」
 *    之间的差别是**一次调用**，而代价是每次读取多一轮磁盘探测。
 *  - 复查要拦的是**授权状态的变化**（暂停、撤销、移除、代次递增），
 *    而这些全部落在状态库里，是两次主键查能拿到的**确定**事实。
 *  - 把「磁盘探测」放进这一层还会让它的失败方式变得含糊：探测失败
 *    既可能是「根没了」（该拒绝）也可能是「盘刚好在忙」（该重试），
 *    而这一层没有足够信息分辨，只能保守拒绝 —— 那就是把一次
 *    可恢复的抖动升级成一次确定的失败。
 *
 * 因此这一层的复查是**窄而有界**的：三张表的主键查，比较代次。
 * 它拦住的东西写在 `recheck` 里，**没有**拦的东西写在它的注释里。
 *
 * ## 关于「工作区 id 是从入参里读的」
 *
 * ADR-003 §4 禁止把身份字段（`user_id` / `session_id` / `principal_id` /
 * `conversation_label`）当作授权依据。这一层读的 `workspace_id` **不是**
 * 身份字段：它是**目标选择器**，表示本次动作要作用在哪个工作区上 ——
 * 而授权链（`resolveWorkspaceAccess`）才是判定它能不能被作用的唯一地方。
 * 这一层拿它做的事只有一件：**发现它变了**（被暂停、被撤销、代次递增）。
 *
 * 这个区别不是文字游戏：如果这一层拿 `workspace_id` 去**放行**任何东西，
 * 它就是一条绕过授权链的路。它只用来**更早地拒绝**，因此方向是单向的 ——
 * 一个伪造的 id 在这里最多让调用失败，绝不会让它通过。
 */

import { BridgeError, err } from '@lwb/contracts';
import type { BridgeErrorCode, Envelope, ImplementedToolName } from '@lwb/contracts';
import { extractFileAccess, recordToolCall, targetFileAccess } from '@lwb/audit';
import type { FileAccessRow } from '@lwb/audit';
import type { ConcurrencyGate, ConcurrencyLease } from '@lwb/limits';
import type { RequestContext } from '@lwb/ipc';
import type { Repositories } from '@lwb/persistence';

import { toModelPayload } from './errors.ts';
import { requestIdOf } from './handlers.ts';
import type { ToolHandler, ToolHandlerDeps } from './handlers.ts';

/**
 * 需要**工作区**才能完成的工具。
 *
 * 与其余工具的区别是实质性的：这些调用会经过受控句柄后端读磁盘，
 * 而并发限额保护的正是那件事（内存、磁盘、唯一的护栏进程）。
 *
 * `bridge_status` 与 `workspace_list` 不在其中是刻意的，理由有两条：
 * 它们只读状态库，不占用被保护的那种资源；更重要的是 `bridge_status`
 * 是**诊断入口** —— 若它也受并发限额约束，那么本机刚好被占满时，
 * 调用方连「为什么我什么都做不了」都问不出来。
 */
export const WORKSPACE_TOOL_NAMES = [
  'file_list',
  'file_read',
  'text_search',
  'git_status',
  'git_diff',
  // 它经受控句柄**重读每个目标的基线**，因此属于「会读磁盘」这一类的
  // 字面判据；全局暂停也因此必须在它这里生效 —— 暂停期间建立修改集，
  // 会让待批准页面在操作者刚说了「停」之后多出一批新提案。
  'change_prepare',
  // 下面这两个是写链上的（LWB-031 / LWB-032）。它们进这张表，而不是
  // 进 `NON_WORKSPACE_TOOL_NAMES`，有两条各自独立的理由：
  //
  //  1. **它们碰受控句柄后端。** `change_apply` 经由它写用户文件，
  //     `change_revert_prepare` 经由它重读每个目标的**当下**字节
  //     （撤销的判据就是「现在盘上是什么」）。这张表的字面判据是
  //     「会经过受控句柄后端」，两者都满足。
  //  2. **全局暂停必须拦住它们。** 第 1 步的暂停判定搭在 `leased` 上，
  //     而 `leased` 就是这张表。一个**不被暂停拦住的应用工具**意味着
  //     操作者按下「停」之后，已经批准的那条修改集仍会被写进用户文件
  //     —— 那是暂停这件事唯一不能有的语义。
  //
  // ## 它们与 `change_get` 共享同一个缺口（见下一张表的说明）
  //
  // 两者的入参里都没有 `workspace_id`（按 change_id 指名），因此
  // `recheck()` 的复查只到**连接级**。理由与 `change_get` 那条相同，
  // 但**残余暴露面更大**：这两个是会写盘/会建提案的动作。真正的防线
  // 不在这一层，而在写入路径本身 —— LWB-027 在写每一个文件之前重新
  // 核对代次与文件身份，`claimForExecution` 在执行前**再判一次**批准
  // 与工作区绑定（方案 §9.3）。本层是纵深的一层，不是唯一的一层。
  'change_apply',
  'change_revert_prepare',
] as const satisfies readonly ImplementedToolName[];

/**
 * 实现了但不碰工作区的工具。上面那张表的补集，两处都由同一个判断消费。
 *
 * `change_get` 与 `change_list` 在这里：前者读快照库，后者只读状态库，
 * 两者都不会**为用户工作区**读一个字节。刻意不占并发位置也有理由：
 * 并发限额保护的是内存、磁盘与唯一的护栏进程，而这几个工具消耗的是
 * 几次主键查询与一次内存里的 LCS —— 输入已被 `MAX_EDITABLE_FILE_BYTES`
 * 封顶、格子数被 `DIFF_MAX_DP_CELLS` 封顶、输出被 128 KiB 封顶。
 * 代价是全局被占满时 `change_get` 仍然会跑；换来的是「我刚提交的提案
 * 怎么样了」这条追问在这种情况下答得出来。
 *
 * ## 这一选择带出一个必须知道的缺口
 *
 * `recheck()` 复查看的是 `claimedWorkspaceId(input)` 读到的
 * `input.workspace_id`，而 `change_get` 的入参里**没有**这个字段
 * （它按 change_id / operation_id 指名）—— 于是它的复查只到**连接级**
 * （连接被停用、连接代次变化）。工作区在本次调用期间被停用或代次递增
 * **不会**撤回它的结果。
 *
 * 残余暴露面很小且可说明：`change_get` 返回的是**已经建立、已经属于
 * 这条连接**的修改集状态与快照差异，不是用户工作区的当下内容；
 * 快照字节在建立时已过一遍同样的判定；而 `resolveWorkspaceAccess`
 * 在本次调用开始时已经跑过完整五层判定。真正的防线在写入路径：
 * LWB-027 在写每一个文件之前重新核对代次与授权。
 */
export const NON_WORKSPACE_TOOL_NAMES = [
  'bridge_status',
  'workspace_list',
  'change_get',
  'change_list',
] as const satisfies readonly ImplementedToolName[];

const WORKSPACE_TOOLS: ReadonlySet<string> = new Set<string>(WORKSPACE_TOOL_NAMES);
const TOOL_NAMES_ALL: ReadonlySet<string> = new Set<string>([
  ...WORKSPACE_TOOL_NAMES,
  ...NON_WORKSPACE_TOOL_NAMES,
]);

/** 本操作是否受并发限额约束。非工具操作（`tools.catalog`）不受。 */
export function needsConcurrencyLease(operation: string): boolean {
  return WORKSPACE_TOOLS.has(operation);
}

/** 本操作是否是已实现的工具（而不是 `tools.catalog` 这类非工具操作）。 */
function isToolOperation(operation: string): operation is ImplementedToolName {
  return TOOL_NAMES_ALL.has(operation);
}

/** 复查读到的前像。`null` 表示「那一刻这条记录不存在」。 */
interface AccessFacts {
  readonly connection_enabled: boolean | null;
  readonly connection_generation: number | null;
  readonly workspace_enabled: boolean | null;
  readonly workspace_generation: number | null;
  readonly workspace_removed: boolean | null;
}

export interface GuardDeps {
  readonly repos: Repositories;
  readonly concurrency: ConcurrencyGate;
}

/**
 * 包装后的形状：**注册表要的形状**，不是 `ToolHandler`。
 *
 * 差在第三个参数：`ToolHandler` 把 `deps` 当入参收（处理器本身保持纯函数
 * 形状），而这一层已经把 `deps` 绑在闭包里了，注册表也只传两个参数。
 * 因此返回类型刻意**不是** `ToolHandler` —— 写成 `ToolHandler` 会要求
 * 注册表多传一个它没有的东西，而那个错误只在注册处报，离事发地很远。
 */
export type GuardedToolHandler = (
  input: unknown,
  context: RequestContext,
) => Promise<Envelope<unknown>>;

/**
 * 包装一个工具处理器，返回一个行为相同但**必然被审计与复查**的处理器。
 *
 * 它不改变工具面对外的形状（仍然是「两个参数、回一个信封」），
 * 因此 `operations.ts` 的注册循环不需要知道自己被包了一层。
 */
export function withToolGuard(
  operation: string,
  handler: ToolHandler,
  deps: ToolHandlerDeps,
  guard: GuardDeps,
): GuardedToolHandler {
  return async (input, context) => await runGuarded(operation, handler, input, context, deps, guard);
}

/** 一次调用要写进审计的全部事实。分成两步（跑、记）是为了让两边共用同一份。 */
interface CallFacts {
  readonly tool: string;
  readonly request_id: string;
  readonly connection_id: string;
  readonly workspace_id: string | null;
  readonly outcome: 'allow' | 'deny' | 'error';
  readonly error_code: string | null;
  readonly bytes_out: number;
  /** `null` = 没有执行到能提取结果的程度（见 `ToolCallRecordInput.file_access`）。 */
  readonly file_access: readonly FileAccessRow[] | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

async function runGuarded(
  operation: string,
  handler: ToolHandler,
  input: unknown,
  context: RequestContext,
  deps: ToolHandlerDeps,
  guard: GuardDeps,
): Promise<Envelope<unknown>> {
  const requestId = requestIdOf(context);
  const connectionId = context.connection_id;
  const workspaceId = claimedWorkspaceId(input);
  const isTool = isToolOperation(operation);
  const leased = isTool && needsConcurrencyLease(operation);
  const budget = deps.budgets.forConnection(connectionId);

  const base = {
    tool: operation,
    request_id: requestId,
    connection_id: connectionId,
    workspace_id: workspaceId,
  } as const;

  // ---- 1. 全局暂停：工作区类调用在此止步 ---------------------------------
  // 只对工作区类调用生效：`bridge_status` 必须能回答「为什么不能用了」，
  // 而一个被暂停的服务如果连这条都拒绝，操作者就只能靠日志了。
  if (leased) {
    const gate = pauseGate(deps, 'before');
    if (gate.kind === 'unreadable') {
      // 与第 3 步读不出前像**同一条路**：不写审计，直接回一个实指的失败。
      //
      // 不写审计有两条各自独立的理由：
      //
      //  1. 与第 3 步同一个事实 —— 读不出暂停状态，多半就是状态库本身
      //     读不出来，那条说明同样写不进去。
      //  2. 写失败会把回答换成 `AUDIT_WRITE_FAILED`，而那句话里写着
      //     「本次调用已完成」—— 对一个**根本没执行**的调用，那是一句假话。
      //     一次拒绝不需要为了「留痕」而说出比实情更多的话。
      return fail(requestId, 'STORAGE_UNAVAILABLE', PAUSE_UNREADABLE_MESSAGE, {
        reason: 'PAUSE_STATE_UNREADABLE',
      });
    }
    if (gate.kind === 'block') {
      return await recordAndReturn(guard, {
        ...base,
        outcome: 'deny',
        error_code: 'PAUSED',
        bytes_out: 0,
        file_access: null,
        metadata: { reason: gate.reason },
        envelope: fail(requestId, 'PAUSED', gate.message),
      });
    }
  }

  // ---- 2. 并发位置：满则等，等不到就是「未执行」 --------------------------
  let lease: ConcurrencyLease | null = null;
  if (leased) {
    const outcome = await guard.concurrency.acquire(connectionId);
    if (!outcome.ok) {
      return await recordAndReturn(guard, {
        ...base,
        outcome: 'deny',
        error_code: 'CONCURRENCY_LIMIT_EXCEEDED',
        bytes_out: 0,
        file_access: null,
        metadata: {
          reason: outcome.reason,
          in_flight: outcome.in_flight,
          limit: outcome.limit,
        },
        envelope: fail(
          requestId,
          'CONCURRENCY_LIMIT_EXCEEDED',
          `并发额度已满（本次限 ${outcome.limit}），等待 ${outcome.waited_ms} 毫秒后仍未取得位置；` +
            '本次调用未执行，没有读取任何文件。',
        ),
      });
    }
    lease = outcome.lease;
  }

  try {
    // ---- 3. 前像 -------------------------------------------------------
    const before = readFacts(guard.repos, connectionId, workspaceId);
    const chargedBefore = budget.chargedTotal;

    // ---- 4. 处理器 -----------------------------------------------------
    // 处理器**不抛**，只回信封（见 handlers.ts 文件头）：因此这里没有 try/catch，
    // 下面按 `envelope.ok` 分支就是全部情形。真有异常穿出来，它会走到 IPC 的
    // 兜底路径 —— 那条路径带本地排障文本，而这一层拦不住它，
    // 所以「处理器不抛」是一条需要被维持的不变量，不是这里可以补的。
    const envelope = await handler(input, context, deps);
    const bytesOut = budget.chargedTotal - chargedBefore;

    // ---- 失败：处理器自己拒绝了 ------------------------------------------
    if (!envelope.ok) {
      return await recordAndReturn(guard, {
        ...base,
        outcome: outcomeOf(envelope),
        error_code: envelope.error.code,
        bytes_out: bytesOut,
        // 失败时用**入参**里的目标路径：处理器没跑出结果，但这次调用确实
        // 指向了某个文件，而「哪些读取被拒绝了」正是审计要回答的一半。
        file_access: isTool ? targetFileAccess(operation, input) : [],
        metadata: { reason: 'HANDLER_REFUSED' },
        envelope,
      });
    }

    // ---- 成功：先算清楚「回去了什么」，再决定能不能回 ---------------------
    const rows = isTool ? rowsOf(operation, envelope.data) : [];
    if (rows === null) {
      // 提取失败 = 契约与实现脱节，也就是本进程的 bug。此时**结果不发**：
      // 一张记不清范围的表比没有表更坏，而「发了但没记全」正是要防的那件事。
      // 审计里 `file_access: null`（不是 `[]`）——后者断言「没碰任何文件」。
      // 出站字节照记：字节确实出去了。
      return await recordAndReturn(guard, {
        ...base,
        outcome: 'error',
        error_code: 'INTERNAL_ERROR',
        bytes_out: bytesOut,
        file_access: null,
        metadata: { reason: 'FILE_ACCESS_EXTRACTION_FAILED' },
        envelope: fail(requestId, 'INTERNAL_ERROR', EXTRACTION_FAILED_MESSAGE),
      });
    }

    // ---- 5. 返回前复查 --------------------------------------------------
    //
    // 暂停排在最前面（LWB-034 步骤 3）：它是这四个判据里唯一**全局**的一个，
    // 而且在同时成立时报它更有用 —— 操作者按下停用按钮之后，
    // 「这条连接被停用了」与「整个服务被停用了」对读它的人是两句不同的话，
    // 而后者才是此刻的实情。
    const withheld =
      (leased ? pauseWithheld(deps) : null) ??
      recheck(guard.repos, connectionId, workspaceId, before);
    if (withheld !== null) {
      // 成功的结果被**撤回**。它读了文件、也记了出站账，但模型拿不到。
      // 审计里这些行必须是 `delivered=false`：内容没有出去，但**读了** ——
      // 见迁移 v3 对 `delivered` 的定义。把它记成「没读」是另一种谎。
      //
      // 出站字节**照记**：预算是被真实扣减的，而且刻意**不回退** ——
      // 回退会让「反复触发撤回」变成一种重置出站窗口的手段。
      return await recordAndReturn(guard, {
        ...base,
        outcome: 'deny',
        error_code: withheld.code,
        bytes_out: bytesOut,
        file_access: rows.map(withholdRow),
        metadata: { reason: 'REVOKED_BEFORE_RETURN' },
        envelope: fail(requestId, withheld.code, withheld.message),
      });
    }

    // ---- 6. 写审计 ------------------------------------------------------
    return await recordAndReturn(guard, {
      ...base,
      outcome: 'allow',
      error_code: null,
      bytes_out: bytesOut,
      file_access: rows,
      metadata: {},
      envelope,
    });
  } catch {
    // ---- 这一层自己出的错 -----------------------------------------------
    // 处理器不抛是它的契约（见 `handlers.ts` 文件头），异常只在**本层**
    // 产生，而本层里的抛出源只有 `readFacts` / `recheck` —— 状态库读不出
    // 前像。因此这个 `STORAGE_UNAVAILABLE` 是**实指的**，不是兜底话术：
    // 读不出「谁被授权」，就既复查不了也放行不了。
    //
    // 暂停那一路**不**走到这里：`pauseBlock` 自己接住了读失败并把它翻成
    // 一次 `PAUSED` 阻断（见它的说明）。两处对「读不出来」的处理不同是
    // 刻意的 —— 「读不出授权」与「读不出暂停状态」要给调用方两句不同的话，
    // 尽管两者都 fail-closed。
    //
    // 兜这一层不是保险，它与 `rowsOf` 的 `catch` 是同一个理由：穿出去的
    // 异常会落到 IPC 的兜底路径，而那条路径把本地排障文本原样送给模型。
    // 这次的异常文本里恰好没有本机路径，但兜底不能建立在运气上。
    //
    // **不**写第二条审计说明「读前像失败」：读不出来的多半正是状态库本身。
    return fail(requestId, 'STORAGE_UNAVAILABLE', GUARD_FAILED_MESSAGE, {
      reason: 'GUARD_FAILED',
    });
  } finally {
    // ---- 7. 释放 --------------------------------------------------------
    lease?.release();
  }
}

// ---------------------------------------------------------------------------
// 复查
// ---------------------------------------------------------------------------

/**
 * 读一次前像。**两次主键查**，不碰磁盘（理由见文件头）。
 *
 * `workspaceId` 为 `null`（调用方没给 / 给的不是字符串）时不查工作区表：
 * 那种调用会被处理器在解析入参时拒绝，这一层不需要为它读任何东西。
 */
function readFacts(
  repos: Repositories,
  connectionId: string,
  workspaceId: string | null,
): AccessFacts {
  const connection = repos.connections.findById(connectionId);
  const workspace = workspaceId === null ? null : repos.workspaces.findById(workspaceId);
  return {
    connection_enabled: connection?.enabled ?? null,
    connection_generation: connection?.generation ?? null,
    workspace_enabled: workspace?.enabled ?? null,
    workspace_generation: workspace?.generation ?? null,
    workspace_removed: workspace === null ? null : workspace.removed_at !== null,
  };
}

interface Withheld {
  readonly code:
    | 'CONNECTION_DISABLED'
    | 'WORKSPACE_GENERATION_CHANGED'
    | 'WORKSPACE_NOT_GRANTED'
    | 'PAUSED'
    | 'STORAGE_UNAVAILABLE';
  readonly message: string;
}

/**
 * 全局暂停这一格（LWB-034 步骤 1 的后半句与步骤 3）。
 *
 * ## 它为什么与其余判据分开
 *
 * 另外三个判据（连接停用、工作区停用、工作区移除）都是**前像 vs 现在**：
 * 它们比的是这次调用开始时记下的值与此刻的值。暂停没有前像可比 ——
 * 它是全局的、与哪条连接/哪个工作区无关，因此它只有一个问题要问：
 * **此刻是不是停着**。
 *
 * ## 为什么第 1 步与第 5 步共用它
 *
 * 「还没开始就停着」与「跑到一半被停用」是同一件事在两个时刻上的样子。
 * 分成两段代码写，两处迟早会在某一格上分叉 —— 而最容易分叉的正是
 * 下面那个读失败的分支。
 *
 * ## 读不出来时按「停着」处理，但**不这么说**
 *
 * 这是本函数唯一一条不是直接读事实的分支。「读不出暂停状态」有两件
 * 可能的真相 —— 停着、或者没停 —— 而**取哪一边**决定了危险面：
 * 按「没停」处理会让读取继续，而让读取继续正是操作者按下那个按钮
 * 要阻止的事；按「停着」处理最坏的结果是一次本来能完成的读取被拒，
 * 操作者重试即可。
 *
 * 但这一格对外的说法**不是** `PAUSED`，而是 `STORAGE_UNAVAILABLE`：
 * 「服务停着」是一句我们并不知道的话，而说出去之后操作者会去看一个
 * 并没有停的服务。两句话给调用方的**动作**是一样的（去看本地服务），
 * 因此这个区别不花调用方任何代价，却让报告与实情一致。
 *
 * `phase` 决定「未执行」还是「未发送」：这两句话在第 1 步与第 5 步之间
 * 是不同的实情，而一个把已执行的调用说成未执行的报告，会让操作者
 * 以为没有读到任何东西 —— 恰恰相反，它读了，只是没交出去。
 */
function pauseGate(deps: ToolHandlerDeps, phase: 'before' | 'after'): PauseGate {
  let paused: boolean;
  try {
    paused = deps.status().paused();
  } catch {
    return {
      kind: 'unreadable',
      message:
        phase === 'before'
          ? '读不出本地服务的暂停状态，因此本次调用未执行。'
          : '读不出本地服务的暂停状态，因此本次结果未发送。',
    };
  }
  if (!paused) return { kind: 'go' };
  return {
    kind: 'block',
    reason: 'GLOBAL_PAUSE',
    message:
      phase === 'before'
        ? '本地服务处于暂停状态，已阻断新读取与新应用。'
        : '本地服务在本次调用进行中被紧急停用；本次结果未发送。',
  };
}

type PauseGate =
  | { readonly kind: 'go' }
  | {
      readonly kind: 'block';
      /**
       * 记进审计的成因。**只在第 1 步用**：第 5 步记的是**机制**
       * （`REVOKED_BEFORE_RETURN`，与其余三个撤回事由逐字相同），
       * 因为那一步要回答的是「一个已经算好的结果为什么没出去」，
       * 而不是「谁按了按钮」—— 后者在 `error_code` 里。
       */
      readonly reason: 'GLOBAL_PAUSE';
      readonly message: string;
    }
  | { readonly kind: 'unreadable'; readonly message: string };

/**
 * 第 5 步那一格：把暂停翻成「要不要撤回这次结果」。
 *
 * 两条路各自给出**自己的**错误码：停着 ⇒ `PAUSED`，读不出来
 * ⇒ `STORAGE_UNAVAILABLE`。合成一个 `PAUSED` 是最省事的写法，
 * 而它会让一次「我不知道」以「服务停着」的名义被报出去。
 */
function pauseWithheld(deps: ToolHandlerDeps): Withheld | null {
  const gate = pauseGate(deps, 'after');
  if (gate.kind === 'go') return null;
  return gate.kind === 'unreadable'
    ? { code: 'STORAGE_UNAVAILABLE', message: gate.message }
    : { code: 'PAUSED', message: gate.message };
}

/**
 * 前像 vs 现在。返回非 null 表示**必须撤回这次结果**。
 *
 * 覆盖的情形：连接被停用、连接代次变化（重新启用也是代次变化）、
 * 工作区被停用、被移除、代次递增（重新授权、策略变更、根重定位）。
 *
 * **未覆盖，且理由是依赖而不是自证**：授权行本身在调用中途被改写。
 * `grants` 表没有代次列，而改写授权行的路径（控制台的登记/移除）
 * 会同时递增工作区代次，因此落在上面那一类里。这条推论依赖
 * `packages/workspaces` 的实现 —— 如果将来出现一条只改 grants 的路径，
 * 这一层不会发现它。写在这里是因为「这一层拦不住什么」与
 * 「这一层拦得住什么」一样需要被知道。
 */
function recheck(
  repos: Repositories,
  connectionId: string,
  workspaceId: string | null,
  before: AccessFacts,
): Withheld | null {
  const now = readFacts(repos, connectionId, workspaceId);
  if (now.connection_enabled === false) {
    return { code: 'CONNECTION_DISABLED', message: '该连接已被本地操作者停用；本次结果未发送。' };
  }
  if (before.connection_generation !== now.connection_generation) {
    return {
      code: 'CONNECTION_DISABLED',
      message: '该连接的状态在本次调用期间发生变化；本次结果未发送。',
    };
  }
  if (now.workspace_removed === true) {
    return { code: 'WORKSPACE_NOT_GRANTED', message: '该工作区已被移除；本次结果未发送。' };
  }
  if (now.workspace_enabled === false) {
    return {
      code: 'WORKSPACE_GENERATION_CHANGED',
      message: '该工作区已被停用；本次结果未发送。',
    };
  }
  if (before.workspace_generation !== null && before.workspace_generation !== now.workspace_generation) {
    return {
      code: 'WORKSPACE_GENERATION_CHANGED',
      message: '该工作区的代次在本次调用期间发生变化；本次结果未发送。',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

/** 审计写不进去时给模型的回答。**不含**底层存储错误的文本（可能含路径）。 */
const AUDIT_FAILED_MESSAGE = '本次调用已完成，但审计记录无法写入，因此结果未发送。';

/**
 * 文件范围提取失败时给模型的回答。
 *
 * 同样**不含**提取器抛出的原文：那句话里有工作区内相对路径与形状细节，
 * 而它是本地排障信息 —— 走 IPC 兜底路径时它会被原样送出去。
 * 真正的原因留在本地审计的 `metadata.reason` 里。
 */
const EXTRACTION_FAILED_MESSAGE = '本次调用已完成，但无法确定它读取了哪些范围，因此结果未发送。';

/** 前像读不出来时给模型的回答。理由与上面两条相同：不含本地排障文本。 */
const GUARD_FAILED_MESSAGE = '本次调用未能完成：本地状态库不可读，因此既无法复查授权，也无法记录本次调用。';

/**
 * 暂停状态读不出来时给模型的回答。
 *
 * 与上一条**分开**写，而不是复用：这两句话描述的是两次不同的读失败。
 * 复用会让「授权读不出来」与「暂停状态读不出来」在排障时看起来像同一件事，
 * 而它们的修法不同（前者是状态库坏了，后者是 `service_pause` 那一行
 * 或那次迁移的问题）。
 */
const PAUSE_UNREADABLE_MESSAGE = '本次调用未执行：读不出本地服务的暂停状态，因此无法判断此刻是否允许读取。';

/**
 * 写记录，然后返回信封。
 *
 * **写不进去就不返回内容**：审计是「什么离开了这台机器」的唯一记录，
 * 一条送不出去的记录等于一次没有记录的出站。代价是一次存储故障会让
 * 工具面整体不可用 —— 那是**正确**的降级方向：此时状态库本身也读不出
 * 授权，工具面本来就不该继续工作。
 *
 * 失败时**不**再写第二条记录说明「写记录失败」：那一条同样写不进去。
 */
async function recordAndReturn(guard: GuardDeps, facts: CallFacts & { readonly envelope: Envelope<unknown> }): Promise<Envelope<unknown>> {
  try {
    recordToolCall(guard.repos, {
      tool: facts.tool,
      request_id: facts.request_id,
      connection_id: facts.connection_id,
      workspace_id: facts.workspace_id,
      outcome: facts.outcome,
      error_code: facts.error_code,
      bytes_out: facts.bytes_out,
      file_access: facts.file_access,
      metadata: facts.metadata,
    });
  } catch {
    return fail(facts.request_id, 'STORAGE_UNAVAILABLE', AUDIT_FAILED_MESSAGE, {
      reason: 'AUDIT_WRITE_FAILED',
    });
  }
  return facts.envelope;
}

/**
 * 读一次结果里的文件访问行。`null` = **提取失败**，与「空数组」是两件事。
 *
 * 有意的 `catch`：`extractFileAccess` 在字段缺失/形状不符时抛（见
 * `packages/audit/src/ranges.ts` 文件头，那是刻意的），而这一层必须
 * 区分「没有文件被访问」与「我不知道碰了哪些文件」。后者要发一个失败信封，
 * 不能走异常 —— 异常会落到 IPC 兜底路径，把本地排障文本送给模型。
 */
function rowsOf(operation: string, data: unknown): readonly FileAccessRow[] | null {
  try {
    return isToolOperation(operation) ? extractFileAccess(operation, data) : [];
  } catch {
    return null;
  }
}

/** 把「读到过」翻成「没有出去」。见 `delivered` 的定义。 */
function withholdRow(row: FileAccessRow): FileAccessRow {
  return { ...row, delivered: false };
}

/**
 * 失败信封归类。
 *
 * `protocol` 类是**调用方或本进程**的问题（参数违约、内部错误），
 * `business` 类是**拒绝**（策略、授权、状态）。两者都记，但记成
 * 不同的 `outcome` —— 把「被策略拒绝」与「daemon 有 bug」记成同一件事，
 * 会让审计里的拒绝率变成一个没有意义的数字。
 */
function outcomeOf(envelope: Extract<Envelope<unknown>, { ok: false }>): 'deny' | 'error' {
  return envelope.error.category === 'protocol' ? 'error' : 'deny';
}

/** 造一个失败信封。**走 `toModelPayload`**，因此与处理器那条路径同一套消毒。 */
function fail(
  requestId: string,
  code: BridgeErrorCode,
  message: string,
  details?: Record<string, string | number | boolean | null>,
): Envelope<unknown> {
  return err(toModelPayload(new BridgeError(code, message, details)), requestId);
}

/** 入参里声称的 `workspace_id`。**只用于复查，不用于放行**（见文件头）。 */
function claimedWorkspaceId(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>)['workspace_id'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
