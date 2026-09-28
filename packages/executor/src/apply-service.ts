/**
 * 应用服务（LWB-032）：**「把这条修改集应用掉」的唯一实现**。
 *
 * ## 为什么它必须只有一个
 *
 * 方案 §10.2 的主按钮是「批准并应用」，而工具面另有一个 `change_apply`。
 * 它们是**两个入口、一件事**。如果各写一份应用逻辑，两份迟早会在某一格上
 * 分叉 —— 而这一格多半是「超时之后怎么办」或者「重复调用要不要再写一次」，
 * 也就是**唯一写不出来的那种错误**。因此本模块是那件事的唯一实现，
 * 控制台与工具面都调它。
 *
 * ## 三件它**不做**的事
 *
 * | 不做 | 为什么 |
 * | --- | --- |
 * | 不产生批准 | 批准只有一个来源：`approvals` 表里那条绑定摘要的记录（I06）。本模块只**读**它 |
 * | 不绕开门禁 | 它调 `claimForExecution`，而门禁在那里面，且执行前会**再判一次**（方案 §9.3） |
 * | 不自造回执 | 回执来自 `@lwb/changes` 的 `operationReceiptFor` —— 与 `change_get` 逐字同一个函数 |
 *
 * ## 「重复调用不产生第二次写」是结构性的，不是一段纪律
 *
 * 三条一起保证它，每一条单独都够：
 *
 *  1. `operations` 表上 `UNIQUE(change_id)` —— 一条修改集只可能有一行操作；
 *  2. 本模块在**认领之前**先读一次操作行：只要它不可认领（见 `canBeginWrite`），
 *     就把那条唯一的操作**原样交回**，一次认领都不做 —— 执行中交回的是
 *     「还在跑」，终局交回的是结论；
 *  3. 即使走到了认领，`claimForExecution` 会在同一个事务里把批准消费掉，
 *     第二次拿到的是 `APPROVAL_CONSUMED`。
 *
 * 于是「用不同的幂等键再调一次」与「用同一个幂等键再调一次」得到**同一个
 * 答案**：那条唯一的操作。幂等键在这里不影响结果 —— 它影响的是上层的
 * 去重与审计关联，而「一个修改集只有一个操作」这件事不依赖任何键。
 *
 * **第 2 条是 LWB-032 的一处修复。** 它原本写的是「不是执行中的状态就返回」，
 * 于是「执行中」的那一格掉进了认领：而批准在认领那一刻就被消费了，
 * 复核门禁因此回一句 `APPROVAL_CONSUMED`。调用方问的是「写完了没有」，
 * 得到的却是一句关于批准的话 —— 而工具说明承诺的正是「返回该修改集唯一那条
 * 操作」。判据因此换成「不可认领」，它与「不可能产生第二次写」是同一件事。
 *
 * ## 等待预算：它是一个**读数**，不是一个取消
 *
 * 写盘可能慢（几百毫秒到几秒），而 IPC 请求在 30 秒上会被服务端答成
 * `TIMEOUT` + `outcome_unknown: true`（`packages/ipc/src/server.ts`）。
 * 那份回答对调用方是**没用**的：它既没说是哪条操作，也没说文件怎么了。
 * 因此本模块自己数一个更短的预算（默认 15 秒，恰好是那个上限的一半），
 * 到点就**如实回答「还在执行」**并让调用方去 `change_get` 查询。
 *
 * 预算到点**不取消**写入。取消一个写了一半的执行，得到的正是本工程
 * 最不愿意看到的那种状态：不知道写到了哪。所以到点时我们只是不再等，
 * 而执行继续跑到它自己的收场（成功、冲突、回滚，或 `RECOVERY_REQUIRED`）。
 * 那条被放弃的 promise 的失败由 `on_notice` 报出去 —— 静默吞掉一个
 * 没人看的失败，等于把它变成一次「看起来什么也没发生」。
 *
 * ## 紧急停用（LWB-034）
 *
 * 「暂停立即阻断新应用」在这条路上只有**一处**要改，因为控制台与工具面
 * 走的是同一个函数（这正是本模块存在的理由）。判据站在「已经不可能
 * 再有第二次写」那一步**之后**：已经发生的照实回答，还没开始的不再开始。
 * 详细的理由在 `applyChange` 第 ③ 步的注释里。
 *
 * 它**不**试图中止一次已经在跑的执行 —— 那件事归协调器的中止信号管，
 * 而这里连它跑到哪一步都不知道。
 */

import { BridgeError } from '@lwb/contracts';
import type { ChangeApplyData } from '@lwb/contracts';
import { isExecutionChangeState, operationReceiptFor, ownedChangeOf } from '@lwb/changes';
import type { OperationReceipt } from '@lwb/contracts';
import type { Repositories } from '@lwb/persistence';

/**
 * 这次调用**有没有可能开始一次写入**。
 *
 * ## 判据为什么是「操作行可不可认领」
 *
 * `claimForExecution` 会拒绝除 `QUEUED` 之外的每一个状态（`OPERATION_NOT_QUEUED`），
 * 而 `operations` 表上的 `UNIQUE(change_id)` 又保证了一条修改集永远只有一行
 * 操作。两件事合起来是这句话：
 *
 * > 只有「还没有操作行」与「有操作行且它已排队、尚未被认领」两种情形下，
 * > 一次调用才**有可能**产生写入；其余情形下它无论如何都产生不了。
 *
 * 于是这个判据就是「会不会写」的**精确**答案，而它有两个用它的地方，
 * 且必须给同一个答案：
 *
 *  - `applyChange` 用它决定「交回那条操作」还是「去认领并执行」；
 *  - 工具面（`changeApply`）用它决定这次调用该按**写面**判还是按**回执面**判。
 *
 * 两处之间有一个理论上的窗口（后台推进可能在两次调用之间认领了那条
 * `QUEUED` 操作），而它只在**一个方向**上是可能的：`QUEUED` 之后的每一个
 * 状态都不可逆，因此「先判成写、后变成读」是可能的，「先判成读、后变成写」
 * 不可能。前者只会让一次调用多过一次写面判定（结论是「交回回执」），
 * 后者会把一次真实写入放进读面 —— 而它到不了，所以不担心。
 */
export function canBeginWrite(repos: Repositories, changeId: string): boolean {
  const operation = repos.operations.findByChangeId(changeId);
  return operation === null || operation.state === 'QUEUED';
}

import { claimRefusalToError } from './claim.ts';
import type { ExecutionCoordinator, RunOutcome } from './coordinator.ts';

/**
 * 默认等待预算（毫秒）。
 *
 * 15 秒不是量出来的，是**推出来的**：IPC 服务端的请求上限是 30 秒
 * （`REQUEST_TIMEOUT_MS`），而那个上限一旦命中，调用方拿到的是一个
 * 不含任何事实的 `TIMEOUT`。取一半，是为了保证「本模块自己先答」
 * 而不是「传输层替本模块答」。
 */
export const DEFAULT_APPLY_WAIT_MS = 15_000;

export interface ApplyServiceNotice {
  /** 等待预算到点之后，那次执行仍然抛了。**没人再看它了，因此必须报出来。** */
  readonly kind: 'ABANDONED_APPLY_FAILED';
  readonly change_id: string;
  readonly detail: string;
}

export interface ApplyServiceDeps {
  readonly repos: Repositories;
  /** 执行协调器。**是同一个**那个被后台推进用的协调器，不是第二个。 */
  readonly coordinator: ExecutionCoordinator;
  /** 本次调用最多等多久。省略即 `DEFAULT_APPLY_WAIT_MS`。 */
  readonly wait_ms?: number;
  /** 记录不可抛的异常。省略时静默 —— 但**不吞**，理由见文件头。 */
  readonly on_notice?: (notice: ApplyServiceNotice) => void;
}

export interface ApplyRequest {
  readonly change_id: string;
  /**
   * 发起本次调用的**连接标识**。
   *
   * 它只用来做一件事：让「不是你的修改集」与「不存在的修改集」得到
   * **逐字相同**的回答（`ownedChangeOf` 的契约）。workspace/tool 授权已在工具入口
   * 核验；执行层继续检查 daemon 内部的一次性摘要绑定、操作状态与工作区代次。
   */
  readonly connection_id: string;
}

/**
 * 应用一条已由上层授权并排队的修改集。MCP 路径的写权限来自 workspace `propose`
 * grant；持久化的一次性批准行是内部摘要绑定/去重记录，不代表等待本地用户点击。
 *
 * 抛出的一切都是 `BridgeError`：调用方（工具面）把它翻成信封，
 * 控制台把它翻成 HTTP 回答。两者的拒绝文案因此也是同一句。
 */
export async function applyChange(request: ApplyRequest, deps: ApplyServiceDeps): Promise<ChangeApplyData> {
  // ① 归属。**先于一切**：一条不属于本连接的修改集，回答与不存在相同，
  //    连「本机存在这个 id」都不该被学到。
  const owned = ownedChangeOf({ change_id: request.change_id }, request.connection_id, deps.repos);

  // ② 已经**不可能**再有第二次写（见 `canBeginWrite`），把那条唯一的操作
  //    原样交回。**这一步不做认领。**
  //
  //    它同时是「重复调用」与「重试一次结果不明的写入」两条路的回答：
  //    两者都不该产生第二次写，而它们的答案与第一次**逐字相同** ——
  //    执行中就是 `in_progress: true`，终局就是那条结论。
  //
  //    回执从 `operationReceiptFor` 读，而不是从上面那次判定的副作用里拼：
  //    回执表的来源只有一个（LWB-032 里那条路被修过），拼一份「看起来一样」
  //    的对象等于给它开第二个来源。
  if (!canBeginWrite(deps.repos, owned.change_id)) {
    const existing = operationReceiptFor(owned.change_id, deps.repos);
    if (existing === null) {
      // 不可认领却读不到操作行：`canBeginWrite` 为假**只能**因为有操作行，
      // 因此走到这里说明两句话里有一句是错的。这个函数不许猜。
      throw new BridgeError('INTERNAL_ERROR', '该修改集不可认领却没有操作记录；拒绝猜测结果。', {
        reason: 'OPERATION_MISSING_FOR_UNCLAIMABLE',
        change_id: owned.change_id,
      });
    }
    return receiptData(existing);
  }

  // ③ 紧急停用（LWB-034）。**在这一步之后才判，而且这是刻意的。**
  //
  //    上面那一步回答的是「已经发生过的那一次写入是什么结果」——
  //    它是一次**查询**。暂停管的是**新的**写入（方案 §9.3 的那句话，
  //    以及 LWB-034 步骤 1 的「暂停立即阻断新应用」）。把暂停判据提到
  //    它前面，会让「暂停期间问一条早就写完了的修改集」得到一句关于暂停
  //    的话，而调用方问的是结果 —— 那正是 LWB-032 修过一次的同一类错误
  //    （调用方问「写完了没有」，得到的却是一句别的话）。
  //
  //    于是这两条路的回答是：**已经写掉的照实说，还没开始的不再开始。**
  //
  //    读失败时 `isPaused()` 抛，这里不接 —— 一个读不出「现在停着没有」的
  //    进程不许开始写入。与 `guard.ts` 那一侧同一方向，只是那边要把话说得
  //    更细（它要给调用方一个 `PAUSED` 信封），而这里抛出即可。
  if (deps.repos.service_pause.isPaused()) {
    throw new BridgeError('PAUSED', '本地服务已被紧急停用，本次修改集没有被应用。', {
      reason: 'SERVICE_PAUSED',
      change_id: owned.change_id,
    });
  }

  // ④ 真的去执行。认领与执行都在协调器里，门禁一步不少。
  const waited = await waitWithinBudget(owned.change_id, deps.coordinator.runChange(owned.change_id), deps);
  if (waited.kind === 'failed') throw waited.error;
  if (waited.kind === 'done') throwIfRefused(waited.value, owned.change_id);

  // ⑤ 回执**从落库事实重读**，而不是从上面那个返回值拼。
  //
  //    返回值只说「执行结束了、终局是哪一个」，逐文件哈希与逐文件状态
  //    在日志与回执表里。用它拼一份「看起来一样」的对象，就等于给回执
  //    开了第二个来源 —— 而两个来源意味着 `change_apply` 与 `change_get`
  //    可以对同一个操作给出不同的 `files`。
  const receipt = operationReceiptFor(owned.change_id, deps.repos);
  if (receipt === null) {
    throw new BridgeError('INTERNAL_ERROR', '执行已返回，但该修改集仍没有操作记录；拒绝猜测结果。', {
      reason: 'OPERATION_MISSING_AFTER_RUN',
    });
  }
  return receiptData(receipt);
}

/**
 * 回执 → 工具面的回答。**逐字段搬运，没有一处是重新算的**。
 *
 * `in_progress` 从 `state` 派生，因此它不可能与 `state` 说两句话 ——
 * 而这是这一步唯一的附加值：`ChangeSetState` 有 13 个取值，模型要判断
 * 「写完了没有」得先知道哪三个是「还没完」。把一个派生的布尔值给它，
 * 比让它去记一张表可靠。
 */
function receiptData(receipt: OperationReceipt): ChangeApplyData {
  return {
    change_id: receipt.change_id,
    operation_id: receipt.operation_id,
    state: receipt.state,
    in_progress: isExecutionChangeState(receipt.state),
    recovered: receipt.recovered,
    files: receipt.files,
    tests_run: false,
    message: receipt.message,
  };
}

/**
 * 把一次**拒绝**翻成异常，其余原样通过。
 *
 * `blocked` / `already_blocked` 也走这条路：它们与拒绝的区别是「需要人来」
 * 而不是「等一会儿」，但对调用方而言都是「这次没能写，而且原因不是我」。
 * 两者的**区别落在错误码的 details 上**，不落在「抛不抛」上 ——
 * 一个把阻断做成「成功但什么都没写」的实现在模型那边读起来像一次成功的应用。
 */
function throwIfRefused(outcome: RunOutcome, changeId: string): void {
  switch (outcome.kind) {
    case 'finished':
      return;
    case 'refused':
      throw claimRefusalToError(outcome);
    case 'blocked':
      throw new BridgeError('WORKSPACE_BUSY', outcome.message, {
        reason: 'WRITE_SLOT_BLOCKED',
        block_reason: outcome.reason,
        operation_id: outcome.previous_operation_id,
      });
    case 'already_blocked':
      throw new BridgeError('WORKSPACE_BUSY', outcome.message, {
        reason: 'WRITE_SLOT_BLOCKED',
        block_reason: outcome.blocked_reason,
        operation_id: outcome.by_operation_id,
      });
    case 'idle':
      // `runChange` 点名的是一条具体的修改集，认领一定给出结论，
      // 因此「队列里没有可执行的」在这里**不可能**成立。走到这里
      // 说明本进程的某处坏了 —— 那正是 INTERNAL_ERROR 的意思。
      throw new BridgeError('INTERNAL_ERROR', '点名执行没有交回结论（既未拒绝也未终结）。', {
        reason: 'NAMED_RUN_NEVER_IDLE',
        change_id: changeId,
      });
    default: {
      const never: never = outcome;
      throw new Error(`未处理的执行结论：${JSON.stringify(never)}`);
    }
  }
}

/** 等待的结果。三分支，因为「没等到」与「等到了但抛了」不是一回事。 */
type Waited =
  | { readonly kind: 'done'; readonly value: RunOutcome }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * 在预算之内等这次执行，到点就返回 `timeout`。**不取消它。**（理由见文件头。）
 *
 * 两个 handler 都挂在同一个 promise 上，因此它在预算之后无论成功还是失败
 * 都**已经被处理**（不会变成一次 unhandled rejection）。成功那一侧被丢弃
 * 是安全的：结果已经落库，`change_get` 读得到。失败那一侧不安全 ——
 * 因此它走 `on_notice` 报出去。
 */
async function waitWithinBudget(
  changeId: string,
  work: Promise<RunOutcome>,
  deps: ApplyServiceDeps,
): Promise<Waited> {
  const budgetMs = deps.wait_ms ?? DEFAULT_APPLY_WAIT_MS;

  return await new Promise<Waited>((resolve) => {
    let decided = false;
    const timer = setTimeout(() => {
      if (decided) return;
      decided = true;
      resolve({ kind: 'timeout' });
    }, budgetMs);

    work.then(
      (value) => {
        if (decided) return;
        decided = true;
        clearTimeout(timer);
        resolve({ kind: 'done', value });
      },
      (error: unknown) => {
        if (decided) {
          // 预算已经到点，没人在等这一次了。它**必须**被报出去：
          // 一句没人读的失败，与「什么也没发生」在日志里长得一样。
          deps.on_notice?.({
            kind: 'ABANDONED_APPLY_FAILED',
            change_id: changeId,
            detail: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        decided = true;
        clearTimeout(timer);
        resolve({ kind: 'failed', error });
      },
    );
  });
}
