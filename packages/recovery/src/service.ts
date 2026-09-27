/**
 * 启动恢复与未知结果协调（LWB-030）。
 *
 * 四步，逐条对着任务书：
 *
 *  1. **启动时先处理未终结操作，再开放工作区写能力** —— `sweepStartup`。
 *     装配根把它放在原生护栏之后、工具面之前（`apps/daemon/src/runtime/assembly.ts`
 *     的第 12 步），因此「先处理、再开放」是一段结构，不是一句注释。
 *  2. **在受控句柄下比较当前身份/哈希与旧、新状态** —— `inspect`。
 *     每一条都另起一次护栏调用重新观测，不复用任何旧回执。
 *  3. **只有可证明安全的状态协调才自动完成** —— `reconcile`。
 *     判据是「这次定案一个字节都不写」（见 `plan.ts` 的文件头）。
 *  4. **恢复写入需要本地恢复授权；禁用连接不妨碍操作者查看恢复记录**
 *     —— `authorize` / `repair` / `records`。
 *
 * ## 这个模块与模型之间没有边
 *
 * 它不出现在工具面里，也不接受任何工具参数：`authorize` 要的 `actor`
 * 来自**认证过的本机控制台会话**，而不是请求体里的一个字段；
 * `repair` 要的授权是 `recovery_authorizations` 里的一行。
 * 因此 `approved: true`、`user_id`、`session_id`、`conversation_label`
 * 在这条路径上**不存在** —— 不是「被忽略了」，是根本没有被读的地方。
 * 这条性质由 `tests/unit/recovery-boundary.test.ts` 静态地钉住
 * （`apps/mcp-adapter/` 里不许出现 `@lwb/recovery`）。
 *
 * ## 写路径复用执行器的那一条，不另起一条
 *
 * 把基线写回去用的是 `@lwb/executor` 的 `NativeWriter.restore` —— 与
 * `apply.ts` 的有界回滚是**同一个函数**。在这里重写一遍「带前置条件的
 * 写回」会是本工程里第二条写用户文件的路径，而两条路径里被忘记的
 * 那一条，正是那一次会覆盖掉别人改动的写入。
 *
 * 差别只有前置条件从哪来：`apply.ts` 用的是「我们写完之后留下的那一份」，
 * 这里是**刚刚在这次观测里读到的**那一份。两者都要求「对象身份 + 内容哈希
 * 同时成立」，因此都挡得住「在我们决定之后、写下去之前有人动过它」。
 *
 * ## 所有写进日志的文字在这里就已经脱敏
 *
 * `repos.journal.append` **不**做脱敏（`appendItemEvent` 才做），而护栏的
 * 错误消息里带着目标文件的绝对路径。LWB-029 正是在这条缝上发现了一个真实
 * 的泄漏：一句没脱敏的话经「抛出的异常 → 改动级日志行」进了执行日志。
 * 因此本模块自己拼的每一句 `detail` 都先过 `redactRoot`，
 * 包括从 `WinfsError.message` 转过来的那些。
 */

import { BridgeError, LIMITS, TERMINAL_CHANGE_STATES } from '@lwb/contracts';
import type { ChangeSetState } from '@lwb/contracts';
import type { BlobStore } from '@lwb/blob-store';
import {
  EXECUTION_CHANGE_STATES,
  EXECUTION_OPERATION_STATES,
  transitionChange,
  transitionOperation,
} from '@lwb/changes';
import { createNativeWriter, scopeOf, type NativeWriter } from '@lwb/executor';
import { guardFailureFacts, guardVerdictClause } from '@lwb/executor';
import { readItemEvents, itemOutcomes, redactRoot } from '@lwb/executor';
import type { ReadScope } from '@lwb/files';
import type {
  ChangeItemRecord,
  ChangeSetRecord,
  OperationRecord,
  Repositories,
  WorkspaceRecord,
} from '@lwb/persistence';
import type { WinfsOps } from '@lwb/winfs';

import {
  planDigestOf,
  reconciliationOf,
  repairOf,
  type ItemPlan,
  type Reconciliation,
  type RecoveryPlan,
  type RepairPlan,
} from './plan.ts';
import {
  classifyItem,
  NO_JOURNAL_EVIDENCE,
  observationOf,
  type ItemVerdict,
  type JournalEvidence,
  type Observation,
  type UnknownReason,
} from './verdict.ts';

/**
 * 恢复写入用的日志阶段名。
 *
 * 与 `coordinator.ts` 的 `JOURNAL_STAGE` 同一风格：小写、读得懂，
 * 而**不复用状态机的枚举名** —— 日志回答「发生过什么」，把它写成状态的
 * 第二份副本，会让「状态是 APPLIED 但日志说 recovery_manual」这种真正的
 * 矛盾再也读不出来。
 */
export const RECOVERY_STAGE = {
  /** 启动时把上一个进程留下的操作标为待恢复。**一条都没有改字节。** */
  swept: 'recovery_swept',
  /** 判定完成并**自动定案**（`APPLIED` 或 `ROLLED_BACK`）。 */
  reconciled: 'recovery_reconciled',
  /** 判定完成但**没能定案**：至少一条属于第三种内容或身份不明。 */
  manual: 'recovery_manual_required',
  /** 操作者授权之后的一次收场写入。**这个阶段名本身就意味着动过字节。** */
  repaired: 'recovery_repaired',
  /** 收场写到一半没写成。留下的现场与「写了一半」相同，因此要能读出来。 */
  repair_failed: 'recovery_repair_failed',
} as const;

export type RecoveryStage = (typeof RECOVERY_STAGE)[keyof typeof RECOVERY_STAGE];

export interface RecoveryDeps {
  readonly repos: Repositories;
  /** 原生护栏。**仍然只在受控句柄下用**，见 `NativeWriter`。 */
  readonly ops: WinfsOps;
  readonly blobs: BlobStore;
  readonly now: () => number;
  readonly newId: () => string;
  readonly log?: (line: string) => void;
  /**
   * 恢复授权有效期。省略时取 `LIMITS.APPROVAL_TTL_MS`（§9.3 的 10 分钟）。
   *
   * 与本地批准同一个数字，因为它们对操作者许诺的是同一件事：
   * 「你刚才点的这一下，十分钟之内有效」。不同数字会让两处措辞
   * （「批准还有 3 分钟」／「恢复授权还有 8 分钟」）需要各自解释。
   */
  readonly authorization_ttl_ms?: number;
}

/** 一条的完整检查结果：判定 + 判定所依据的那次观测。 */
export interface ItemInspection {
  readonly item: ChangeItemRecord;
  readonly observation: Observation;
  readonly verdict: ItemVerdict;
  readonly journal: JournalEvidence;
}

export interface Inspection {
  readonly operation: OperationRecord;
  readonly change: ChangeSetRecord;
  readonly workspace: WorkspaceRecord;
  readonly scope: ReadScope;
  readonly items: readonly ItemInspection[];
  /** 这次执行的条目级日志总条数。0 表示账上什么都没记。 */
  readonly journal_events: number;
  readonly plan: RecoveryPlan;
  readonly reconciliation: Reconciliation;
  readonly repair: RepairPlan;
}

export interface ReconcileReport {
  readonly operation_id: string;
  readonly change_id: string;
  readonly workspace_id: string;
  readonly before: ChangeSetState;
  readonly after: ChangeSetState;
  readonly reconciliation: Reconciliation;
  readonly plan_digest: string;
  /** 工作区阻断是否随之解除。 */
  readonly blockade: BlockadeOutcome;
  readonly items: readonly ItemReceipt[];
}

export interface ItemReceipt {
  readonly canonical_path: string;
  readonly op: ChangeItemRecord['op'];
  readonly verdict: ItemVerdict['kind'];
  readonly reason: UnknownReason | null;
  readonly observed_file_id: string | null;
  readonly observed_sha256: string | null;
  readonly detail: string;
}

/**
 * 解除阻断的结果。
 *
 * `not_blocked` 与 `refused` 必须分开：前者是「本来就没事」，
 * 后者是「该解，但按规定不能解」—— 而后者是**需要人来看**的那种。
 */
export type BlockadeOutcome =
  | { readonly kind: 'cleared' }
  | { readonly kind: 'not_blocked' }
  | { readonly kind: 'refused'; readonly reason: string; readonly detail: string };

export interface StartupRecoveryReport {
  /** 上一个进程留下的未终结操作（`QUEUED` / `VALIDATING` / `APPLYING`）。 */
  readonly leftovers: number;
  readonly reconciled: readonly ReconcileReport[];
  /** 判定了但没能自动定案、仍然等人处理的。 */
  readonly awaiting_manual: readonly ReconcileReport[];
  /** 护栏不可用等原因导致**判都没判成**的操作。它们留在原状态。 */
  readonly undecidable: readonly { readonly operation_id: string; readonly detail: string }[];
}

/**
 * 恢复记录（步骤 4 的后半句）。
 *
 * **它的每一个字段都来自状态库。** 这是刻意的：一个「禁用连接之后
 * 连记录都看不了」的恢复流程，会把操作者逼到「先启用那条连接」这条路上，
 * 而启用连接是一个比看记录危险得多的动作。
 */
export interface RecoveryRecord {
  readonly operation_id: string;
  readonly change_id: string;
  readonly workspace_id: string;
  readonly operation_state: ChangeSetState;
  readonly change_state: ChangeSetState;
  readonly recovered: boolean;
  readonly items: readonly {
    readonly item_id: string;
    readonly canonical_path: string;
    readonly op: string;
    readonly state: string;
    readonly before_sha256: string | null;
    readonly after_sha256: string | null;
    readonly error_code: string | null;
    readonly updated_at: string;
  }[];
  readonly authorizations: readonly {
    readonly id: string;
    readonly decision: string;
    readonly state: string;
    readonly actor: string;
    readonly digest: string;
    readonly expires_at: string;
    readonly consumed_at: string | null;
    readonly created_at: string;
  }[];
  /** 执行日志（已脱敏，读到的是**写下去时的那份**）。 */
  readonly journal: readonly {
    readonly seq: number;
    readonly item_id: string | null;
    readonly stage: string;
    readonly error_code: string | null;
    readonly detail: string | null;
  }[];
}

export class RecoveryService {
  readonly #deps: RecoveryDeps;
  readonly #writer: NativeWriter;

  constructor(deps: RecoveryDeps) {
    this.#deps = deps;
    // 与 `apply.ts` 同一个写盘适配器。见文件头「写路径复用执行器的那一条」。
    this.#writer = createNativeWriter({ repos: deps.repos, ops: deps.ops, blobs: deps.blobs });
  }

  // -------------------------------------------------------------------------
  // 步骤 1：启动时先处理未终结操作
  // -------------------------------------------------------------------------

  /**
   * 启动时的恢复扫描。**在任何写能力开放之前跑。**
   *
   * 三件事，顺序不能换：
   *
   *  1. 把上一个进程留下的 `QUEUED` / `VALIDATING` / `APPLYING` 一律标成
   *     `RECOVERY_REQUIRED`。**绝不自动重放** —— `listUnfinished` 的原文。
   *     标记而不是直接定案，是为了让「还没判定」这个中间态可持久：
   *     判定本身要读磁盘，而它可能失败、进程可能再死一次。
   *  2. 对**所有**处在 `RECOVERY_REQUIRED` 的操作重新判定一次并尝试定案。
   *     包括上一次启动没能定案的那些 —— 操作者可能刚把那个多余的文件
   *     删掉了，而这一次判定就会看到「名字空着」并把它定案成 `ROLLED_BACK`。
   *  3. 判不成的（护栏不可用、快照取不到）**原样留着**，一个字都不改。
   *     它们会出现在 `undecidable` 里，而那个清单就是操作者要做的事。
   */
  async sweepStartup(): Promise<StartupRecoveryReport> {
    const leftovers = this.#deps.repos.operations.listUnfinished();
    for (const operation of leftovers) {
      this.#markForRecovery(operation);
    }
    if (leftovers.length > 0) {
      this.#log(
        `启动恢复：上一个进程留下 ${String(leftovers.length)} 个未终结操作，已全部标为待恢复（未重放、未改字节）。`,
      );
    }

    const pending = this.#deps.repos.operations.listByStates(['RECOVERY_REQUIRED']);
    const reconciled: ReconcileReport[] = [];
    const awaiting: ReconcileReport[] = [];
    const undecidable: { operation_id: string; detail: string }[] = [];

    for (const operation of pending) {
      let inspection: Inspection | null;
      try {
        inspection = await this.inspect(operation.id);
      } catch (error) {
        undecidable.push({ operation_id: operation.id, detail: messageOf(error) });
        continue;
      }
      if (inspection === null) {
        undecidable.push({ operation_id: operation.id, detail: '操作在原状态库里的关联行已不存在。' });
        continue;
      }
      if (inspection.reconciliation.kind === 'MANUAL') {
        this.#journalManual(inspection);
        awaiting.push(await this.reconcile(operation.id, inspection));
        continue;
      }
      reconciled.push(await this.reconcile(operation.id, inspection));
    }

    return {
      leftovers: leftovers.length,
      reconciled,
      awaiting_manual: awaiting,
      undecidable,
    };
  }

  /**
   * 把一条遗留操作标为待恢复：**改动与操作两行同时**，外加一条改动级日志。
   *
   * `from` 取「它当时在哪个状态」而不是写死三个：转状态机那张表已经规定了
   * 三条合法的边（三个执行状态各自都能到 `RECOVERY_REQUIRED`），
   * 而在这里再写一遍「哪些状态可以标」就是同一个规则的第二个副本。
   *
   * 标记失败**不抛出去**：一条改不动的操作（例如它的修改集已经被别的路径
   * 带到了终态）不该让整个守护进程起不来 —— 它已经被 `inspect` 跳过，
   * 而跳过的事实会出现在 `undecidable` 里。真正该让启动失败的，
   * 是状态库打不开，而那件事发生在更早的步骤里。
   */
  #markForRecovery(operation: OperationRecord): void {
    const from = operation.state;
    try {
      this.#deps.repos.transaction(() => {
        // `from` 用 `EXECUTION_*` 那两个常量，而不是 `[operation.state]`：
        // 后者的类型是 `ChangeSetState`，而它同时装着五个修改集独有的状态，
        // 传给 `transitionOperation` 编译不过。那道编译错误值得保留
        // （见 `state-machine.ts` 的说明），而它在这里的答案是
        // 「我们本来问的就是执行中的那三个状态」—— 那句话本来就有一个名字。
        transitionChange(this.#deps.repos, {
          change_id: operation.change_id,
          from: EXECUTION_CHANGE_STATES,
          to: 'RECOVERY_REQUIRED',
        });
        transitionOperation(this.#deps.repos, {
          operation_id: operation.id,
          from: EXECUTION_OPERATION_STATES,
          to: 'RECOVERY_REQUIRED',
          // 待恢复**不是**终局：它的字节还在等人处理，而 `finished_at`
          // 一旦写上，保留策略就会把它当成一条已经收场的记录。
          finished: false,
        });
        this.#appendJournal({
          operation_id: operation.id,
          stage: RECOVERY_STAGE.swept,
          error_code: 'PROCESS_EXITED_DURING_EXECUTION',
          detail:
            `上一个进程在 ${from} 状态下退出，本次启动把它标为待恢复。` +
            '没有重放这次执行，也没有改动工作区里的任何字节。',
        });
      });
    } catch (error) {
      this.#log(`启动恢复：操作 ${operation.id} 无法标为待恢复（${messageOf(error)}），保持原样。`);
    }
  }

  // -------------------------------------------------------------------------
  // 步骤 2：在受控句柄下重新观测
  // -------------------------------------------------------------------------

  /**
   * 判定一个操作。**只读** —— 不写状态、不写日志、不碰用户文件。
   *
   * 操作不存在时返回 `null`（而不是抛）：调用方在启动扫描里逐条遍历，
   * 而一条「关联行已经不在了」的记录应当进入待人工清单，不该中断整轮扫描。
   */
  async inspect(operationId: string, precomputed?: Inspection): Promise<Inspection | null> {
    if (precomputed !== undefined) return precomputed;

    const repos = this.#deps.repos;
    const operation = repos.operations.findById(operationId);
    if (operation === null) return null;
    const change = repos.changes.findById(operation.change_id);
    if (change === null) return null;
    const workspace = repos.workspaces.findById(change.workspace_id);
    if (workspace === null) return null;

    const scope = scopeOf(workspace);
    const items = repos.changes.items(change.id).sort((a, b) => a.seq - b.seq);
    const events = readItemEvents(repos, operation.id);
    const outcomes = itemOutcomes(events);

    const inspected: ItemInspection[] = [];
    for (const item of items) {
      const journal = journalOf(events, item.id, outcomes);
      // **另起一次护栏调用。** 不复用任何旧回执，也不看操作记录里写着的
      // 「上次观察到什么」—— 这一步要回答的是「现在是什么」。
      const observation = observationOf(
        await this.#observe(scope, item),
      );
      inspected.push({ item, observation, verdict: classifyItem({ item, observation, journal }), journal });
    }

    const planItems: ItemPlan[] = inspected.map((entry) => ({
      item: entry.item,
      verdict: entry.verdict,
    }));
    const plan: RecoveryPlan = {
      operation_id: operation.id,
      change_id: change.id,
      workspace_id: change.workspace_id,
      volume_id: workspace.volume_id,
      root_file_id: workspace.root_file_id,
      items: planItems,
    };

    return {
      operation,
      change,
      workspace,
      scope,
      items: inspected,
      journal_events: events.length,
      plan,
      reconciliation: reconciliationOf(planItems),
      repair: repairOf(planItems),
    };
  }

  async #observe(scope: ReadScope, item: ChangeItemRecord): Promise<
    | {
        readonly ok: true;
        readonly file_id: string;
        readonly sha256: string | null;
        readonly size: number;
        readonly canonical_path: string;
      }
    | { readonly ok: false; readonly reason: UnknownReason; readonly detail: string }
  > {
    const read = await this.#writer.readState(scope, item);
    if (read.ok) {
      if (read.canonical_path === null) {
        // 护栏取不到规范路径 ⇒ 它无法证明这个目标在工作区根之下。
        // 退回 `item.canonical_path` 充当规范路径正是 I03 禁止的那件事：
        // 一份对不上文件系统的回执不是证据。因此按「没看成」处理。
        return {
          ok: false,
          reason: 'READ_FAILED',
          detail: '护栏无法证明该目标位于工作区根之下（取不到规范路径），因此不作任何判定。',
        };
      }
      return {
        ok: true,
        file_id: read.file_id,
        sha256: read.sha256,
        size: read.size,
        canonical_path: read.canonical_path,
      };
    }

    const error = read.error;
    if (error.code === 'NOT_FOUND') {
      // 这里是**一条事实**而不是一次失败：护栏按物理身份逐级固定了根，
      // 然后在这个根之下走不到那个名字。对新建条目它是「还没建出来」，
      // 对改写条目它是 §8.4 的「身份变化」。
      return { ok: false, reason: 'OBJECT_MISSING', detail: `护栏在受控句柄下走不到这个路径：${this.#safe(scope, error.message)}` };
    }
    if (error.code === 'NATIVE_GUARD_UNAVAILABLE') {
      return {
        ok: false,
        reason: 'GUARD_UNAVAILABLE',
        detail: `护栏不可用，这一次观测什么都没证明：${this.#safe(scope, error.message)}`,
      };
    }
    return {
      ok: false,
      reason: 'READ_FAILED',
      detail: `读取失败（${error.code}）：${this.#safe(scope, error.message)}`,
    };
  }

  // -------------------------------------------------------------------------
  // 步骤 3：只有可证明安全的协调才自动完成
  // -------------------------------------------------------------------------

  /**
   * 定案一个操作。**只在判定已经给出 `APPLIED` / `ROLLED_BACK` 时动状态。**
   *
   * `MANUAL` 时它**不改状态、不写字节**：那一条日志的意义正是「我们看过了，
   * 但没动它」。一个连状态都不改的判定如果连日志都不留，操作者读到的会是
   * 「这个操作从上次崩溃起就没人管过」。
   *
   * 但它**要写回执**（`operation_item_results`），而这不是一回事：
   * 回执记的是「这次观测到每一条是什么」，不是「这件事怎么收场了」。
   * 不写的话，一份等着人工处理的记录在 `records()` 里会读成
   * `items: []` —— 操作者最需要逐条目清单的那一刻（「是哪个文件？
   * 是第三种内容还是身份不明？」），记录里偏偏一条都没有。
   * `UNKNOWN` 这个回执状态本来就是为这一格准备的（见 `receiptStateOf`）。
   *
   * `recovered = true` 只写在 `APPLIED` 上（§8.1：「核验后可协调为
   * APPLIED（recovered=true）」）。它记的是**这一次定案是恢复流程做出的**，
   * 而不是「我们确定是我们写的」—— 后者从来就不在判定里。
   */
  async reconcile(operationId: string, precomputed?: Inspection): Promise<ReconcileReport> {
    const inspection = precomputed ?? (await this.inspect(operationId));
    if (inspection === null) {
      throw new BridgeError('CHANGE_NOT_FOUND', '操作或它的关联行不存在，无法定案。');
    }

    const { operation, change, reconciliation } = inspection;
    const receipts = receiptsOf(inspection);

    if (reconciliation.kind === 'MANUAL') {
      // 回执落在一个短事务里：一次扫描不该留下「一半条目记了、一半没记」。
      // 它们全是 `UNKNOWN` —— 一条都不声称「回来了」。
      this.#deps.repos.transaction(() => {
        this.#writeReceipts(operation.id, inspection);
      });
      return {
        operation_id: operation.id,
        change_id: change.id,
        workspace_id: change.workspace_id,
        before: operation.state,
        after: operation.state,
        reconciliation,
        plan_digest: planDigestOf(inspection.plan),
        blockade: { kind: 'not_blocked' },
        items: receipts,
      };
    }

    // 两个 `as const` 不是装饰：`APPLIED` 与 `ROLLED_BACK` 同时在
    // `ChangeSetState` 与 `OperationState` 里，而下面两行各要一个。
    // 写成 `as const` 让这一处同时满足两张表，且**不会**把
    // `ChangeSetState` 里那五个修改集独有的状态带进来。
    const target = reconciliation.kind === 'APPLIED' ? ('APPLIED' as const) : ('ROLLED_BACK' as const);
    const summary = reconciliation.kind === 'APPLIED'
      ? `核验到目标状态：本次执行的 ${String(receipts.length)} 个条目全部已在批准的目标内容上，协调为已应用。`
      : `核验到原状态：本次执行的 ${String(receipts.length)} 个条目全部仍在基线上，协调为已回滚。`;

    this.#deps.repos.transaction(() => {
      transitionChange(this.#deps.repos, {
        change_id: change.id,
        from: ['RECOVERY_REQUIRED'],
        to: target,
      });
      transitionOperation(this.#deps.repos, {
        operation_id: operation.id,
        from: ['RECOVERY_REQUIRED'],
        to: target,
        recovered: target === 'APPLIED',
        finished: true,
      });
      this.#appendJournal({
        operation_id: operation.id,
        stage: RECOVERY_STAGE.reconciled,
        error_code: null,
        detail: summary,
      });
      this.#writeReceipts(operation.id, inspection);
    });

    const blockade = this.#liftBlockade(inspection);

    this.#log(
      `启动恢复：操作 ${operation.id}（${change.workspace_id}）经重新观测后协调为 ${target}；` +
        `本次定案没有写入任何字节。`,
    );

    return {
      operation_id: operation.id,
      change_id: change.id,
      workspace_id: change.workspace_id,
      before: operation.state,
      after: target,
      reconciliation,
      plan_digest: planDigestOf(inspection.plan),
      blockade,
      items: receipts,
    };
  }

  /**
   * 解除该工作区的写阻断。
   *
   * ## 前置条件与 `ExecutionCoordinator#clearBlockade` 是同一条
   *
   * 「导致阻断的那个操作必须已经终结」。写在这里是对着**同一个导出常量**
   * （`TERMINAL_CHANGE_STATES`）判的一次，不是第二份规则。
   *
   * 之所以不是直接调协调器的方法：协调器今天**还没有被装配进守护进程**
   * （接线属 LWB-032），而「启动时先处理未终结操作，再开放工作区写能力」
   * 这句话要求解除阻断就发生在这一步 —— 一个判定成 `APPLIED` 却仍然
   * 被阻断的工作区，会让 `requiresRecovery` 永远为真，于是这个能力开关
   * 从「有事要你处理」变成一块擦不掉的红字。LWB-032 把协调器接进来之后，
   * 装配根应当改传 `coordinator.clearBlockade`，让实现回到唯一一处。
   */
  #liftBlockade(inspection: Inspection): BlockadeOutcome {
    const repos = this.#deps.repos;
    const { workspace } = inspection;

    return repos.transaction(() => {
      const slot = repos.write_slots.find(workspace.volume_id, workspace.root_file_id);
      if (slot === null) return { kind: 'not_blocked' } as BlockadeOutcome;
      if (slot.blocked_at === null) return { kind: 'not_blocked' } as BlockadeOutcome;

      const previous = repos.operations.findById(slot.operation_id);
      if (previous === null) {
        return {
          kind: 'refused',
          reason: 'SLOT_OPERATION_MISSING',
          detail: '写执行槽指向的操作不存在，解除阻断需要人工核验。',
        } as BlockadeOutcome;
      }
      if (!TERMINAL_CHANGE_STATES.includes(previous.state)) {
        return {
          kind: 'refused',
          reason: 'PREVIOUS_NOT_TERMINAL',
          detail:
            `导致阻断的操作 ${previous.id} 仍是 ${previous.state}，字节下落尚未定案，` +
            '不能解除阻断。',
        } as BlockadeOutcome;
      }

      repos.write_slots.unblock({
        volume_id: workspace.volume_id,
        root_file_id: workspace.root_file_id,
      });
      return { kind: 'cleared' } as BlockadeOutcome;
    });
  }

  // -------------------------------------------------------------------------
  // 步骤 4：本地恢复授权，以及**它才允许的**那一次写入
  // -------------------------------------------------------------------------

  /**
   * 本机操作者为一个操作签发恢复授权。
   *
   * 两件事在签发时就被挡住，因为它们**在授权之前**就该被挡住：
   *
   *  - 这个操作现在判出来是 `MANUAL` 之外的收场（无事可做）—— 拒绝；
   *  - 收场需要删掉一个新建的文件 —— 拒绝（`CREATED_OBJECT_NOT_REMOVED`）。
   *
   * 摘要当场算、当场存：授权绑定的是**此刻的现场**。
   */
  async authorize(input: {
    readonly operation_id: string;
    /** 认证过的本机会话身份（`console:<session_id>`）。**不是**工具参数。 */
    readonly actor: string;
  }): Promise<{ readonly authorization_id: string; readonly digest: string; readonly expires_at: string }> {
    const inspection = await this.inspect(input.operation_id);
    if (inspection === null) {
      throw new BridgeError('CHANGE_NOT_FOUND', '操作或它的关联行不存在，无法授权。');
    }
    if (inspection.operation.state !== 'RECOVERY_REQUIRED') {
      throw new BridgeError(
        'CHANGE_STATE_INVALID',
        `操作当前是 ${inspection.operation.state}，不是待恢复，无需恢复授权。`,
        { state: inspection.operation.state },
      );
    }
    if (inspection.repair.kind === 'refused') {
      throw new BridgeError('RECOVERY_REQUIRED', inspection.repair.detail, {
        reason: inspection.repair.reason,
      });
    }

    const digest = planDigestOf(inspection.plan);
    const expiresAt = new Date(this.#now() + this.#ttlMs()).toISOString();
    const id = this.#deps.newId();

    this.#deps.repos.recovery_authorizations.create({
      id,
      operation_id: inspection.operation.id,
      workspace_id: inspection.change.workspace_id,
      volume_id: inspection.workspace.volume_id,
      root_file_id: inspection.workspace.root_file_id,
      decision: inspection.repair.action,
      digest,
      actor: input.actor,
      expires_at: expiresAt,
    });

    this.#log(
      `恢复授权已签发：操作 ${inspection.operation.id}，决定 ${inspection.repair.action}，` +
        `涉及 ${String(inspection.repair.targets.length)} 个条目，有效期至 ${expiresAt}。`,
    );
    return { authorization_id: id, digest, expires_at: expiresAt };
  }

  /**
   * 兑现一次恢复授权：重新观测 → 重算摘要 → 消费授权 → 把已经写下去的那些收回基线。
   *
   * ## 顺序是安全性质的一部分
   *
   * 1. **先判定，后消费。** 判定不通过时授权原样保留 —— 否则一次
   *    「文件还没准备好」的尝试会白白烧掉操作者的授权，而他并不会知道
   *    为什么第二次点就没反应了。
   * 2. **摘要当场重算。** 存下来的是签发时那一个，而 `consume` 的 WHERE
   *    里比的是**现在**这一个。磁盘在授权之后被改动过 ⇒ 两个摘要不等 ⇒
   *    数据库拒绝这次消费。这就是「授权之后、执行之前用户又编辑了它」
   *    这一格的全部防线，而它在**一次写入发生之前**就已经生效。
   * 3. **写出去了才记账。** `restore` 每成功一条就记一条 `recovery_repaired`
   *    并写一条回执；失败则记 `recovery_repair_failed` 并**停下**，
   *    不重试（与 `apply.ts` 的上界一致：每条目一次）。
   *
   * ## 写回的前置条件来自**刚刚这次观测**
   *
   * `expected_file_id` / `expected_sha256` 取的是 `inspection` 里刚读到的
   * 那一对，而不是授权签发时那一对 —— 后者已经由摘要比对挡在门外了，
   * 而护栏要的是「此刻能不能动它」。两个条件重叠是刻意的：
   * 一个是计划级的，一个是写入级的（在护栏自己的句柄里核）。
   */
  async repair(input: {
    readonly operation_id: string;
    readonly authorization_id: string;
  }): Promise<ReconcileReport & { readonly repaired: number; readonly failed: string | null }> {
    const repos = this.#deps.repos;
    const inspection = await this.inspect(input.operation_id);
    if (inspection === null) {
      throw new BridgeError('CHANGE_NOT_FOUND', '操作或它的关联行不存在，无法执行恢复。');
    }

    const authorization = repos.recovery_authorizations.requireById(input.authorization_id);
    if (authorization.operation_id !== inspection.operation.id) {
      throw new BridgeError('NOT_AUTHORIZED', '这条恢复授权属于另一个操作。');
    }
    if (inspection.repair.kind === 'refused') {
      throw new BridgeError('RECOVERY_REQUIRED', inspection.repair.detail, {
        reason: inspection.repair.reason,
      });
    }
    const planForRepair = inspection.repair;
    if (planForRepair.action !== authorization.decision) {
      // 今天只有一条动作，因此这条分支只可能来自一条被人改过的行。
      // 留着它是因为「授权说 A、执行做 B」这件事必须有一次显式失败。
      throw new BridgeError('NOT_AUTHORIZED', '恢复授权记录的动作与当前判定不符，拒绝执行。');
    }

    // 2. 摘要当场重算并消费。磁盘变过 ⇒ 这里抛，一个字节都不会写。
    const digest = planDigestOf(inspection.plan);
    repos.recovery_authorizations.consume({
      authorization_id: authorization.id,
      digest,
      now: new Date(this.#now()).toISOString(),
    });

    let repaired = 0;
    let failure: string | null = null;

    for (const target of planForRepair.targets) {
      const verdict = target.verdict;
      if (verdict.kind !== 'TARGET_REACHED') continue; // `repairOf` 已经保证不会走到这里。

      const bytes = await this.#writer.baselineBytes(target.item);
      if (!bytes.ok) {
        failure = `${target.item.canonical_path}：取不到基线字节，${this.#safe(inspection.scope, bytes.detail)}`;
        this.#journalRepairFailure(inspection, target.item, failure);
        break;
      }

      const outcome = await this.#writer.restore(inspection.scope, {
        item: target.item,
        // 按**磁盘规范拼写**写回，而它取自**刚刚这次观测**，不是条目里
        // 存的那个：护栏的 `Assert-HandleMatches` 要求请求拼写与句柄的
        // 最终路径一致，而条目里的拼写是准备修改集时的。中间某级目录
        // 被改过大小写之后两者会分叉，用旧拼写写下去会被护栏拒绝。
        relative_path: verdict.observed_path,
        expected_file_id: verdict.observed_file_id,
        expected_sha256: verdict.observed_sha256,
        bytes: bytes.bytes,
      });

      if (!outcome.ok) {
        // 与 `apply.ts` 同一个判定、同一个说法（`@lwb/executor` 的
        // `guardVerdictClause`）：这里曾经只有两句，于是护栏在写回途中
        // 死掉时（`touched` 缺席的客户端合成失败）会印成**「未进入破坏性
        // 区域」**—— 而恢复路径上的这句话正是操作者决定「这个文件能不能
        // 信」的依据。把未知印成否定的那一句，正好把本工程最要紧的那个
        // 「我不知道」说没了。
        failure =
          `${target.item.canonical_path}：写回基线失败（${outcome.error.code}），` +
          `${guardVerdictClause(guardFailureFacts(outcome.error))}。`;
        this.#journalRepairFailure(inspection, target.item, failure);
        break;
      }

      // 独立回读：回到基线这件事不能靠写入方自己的回执来确认。
      const after = await this.#observe(inspection.scope, target.item);
      const back =
        after.ok && after.sha256 === target.item.base_sha256 && after.file_id === target.item.base_file_id;
      if (!back) {
        failure = `${target.item.canonical_path}：写回之后独立回读没有证实它回到了基线。`;
        this.#journalRepairFailure(inspection, target.item, failure);
        break;
      }

      repaired += 1;
      repos.operations.setItemResult({
        operation_id: inspection.operation.id,
        item_id: target.item.id,
        state: 'RECOVERED_ORIGINAL',
        before_sha256: verdict.observed_sha256,
        after_sha256: after.sha256,
        error_code: null,
      });
      this.#appendJournal({
        operation_id: inspection.operation.id,
        item_id: target.item.id,
        stage: RECOVERY_STAGE.repaired,
        observed_file_id: after.file_id,
        observed_sha256: after.sha256,
        target_sha256: target.item.base_sha256,
        error_code: null,
        detail: `按本地恢复授权把「${target.item.canonical_path}」写回基线，并经独立回读证实。`,
      });
    }

    if (failure !== null) {
      // 写了一半就停。**不重试**，也不把状态往前推 —— 现场比进来时更复杂了，
      // 而它正需要一次新的判定。留一条日志把「写到哪」说清楚。
      this.#log(`恢复写入中止：${failure}`);
      const resent = await this.inspect(inspection.operation.id);
      const receipts = resent === null ? receiptsOf(inspection) : receiptsOf(resent);
      return {
        operation_id: inspection.operation.id,
        change_id: inspection.change.id,
        workspace_id: inspection.change.workspace_id,
        before: inspection.operation.state,
        after: inspection.operation.state,
        reconciliation: { kind: 'MANUAL', reason: 'MIXED' },
        plan_digest: digest,
        blockade: { kind: 'not_blocked' },
        items: receipts,
        repaired,
        failed: failure,
      };
    }

    // 全部收回去了 ⇒ 再判定一次。这一次每一条都应当在基线上，
    // 于是 `reconcile` 会把它定案成 `ROLLED_BACK` 并解除阻断。
    // **不直接写 `ROLLED_BACK`**：定案要走同一个判定，否则「回滚完成」
    // 就成了一句我们自己说的话，而不是一次观测的结果。
    const after = await this.reconcile(inspection.operation.id);
    return { ...after, repaired, failed: null };
  }

  // -------------------------------------------------------------------------
  // 恢复记录：**与连接状态无关**
  // -------------------------------------------------------------------------

  /**
   * 读一份恢复记录。**不碰护栏、不碰磁盘、不看连接的启用状态。**
   *
   * 这是步骤 4 后半句「禁用连接不妨碍操作者查看恢复记录」的实现：
   * 它的每一个字段都来自状态库，而状态库的读取不需要任何能力开关。
   * 因此一个被停用的连接、一个刚好不可用的护栏，都不会让操作者
   * 失去「我的机器上现在有什么在等人处理」这个问题的答案。
   */
  records(operationId: string): RecoveryRecord | null {
    const repos = this.#deps.repos;
    const operation = repos.operations.findById(operationId);
    if (operation === null) return null;
    const change = repos.changes.findById(operation.change_id);
    if (change === null) return null;

    const paths = new Map(repos.changes.items(change.id).map((item) => [item.id, item]));

    return {
      operation_id: operation.id,
      change_id: change.id,
      workspace_id: change.workspace_id,
      operation_state: operation.state,
      change_state: change.state,
      recovered: operation.recovered,
      items: repos.operations.itemResults(operation.id).map((row) => ({
        item_id: row.item_id,
        canonical_path: paths.get(row.item_id)?.canonical_path ?? '<条目已不在>',
        op: paths.get(row.item_id)?.op ?? '<未知>',
        state: row.state,
        before_sha256: row.before_sha256,
        after_sha256: row.after_sha256,
        error_code: row.error_code,
        updated_at: row.updated_at,
      })),
      authorizations: repos.recovery_authorizations.listForOperation(operation.id).map((row) => ({
        id: row.id,
        decision: row.decision,
        state: row.state,
        actor: row.actor,
        digest: row.digest,
        expires_at: row.expires_at,
        consumed_at: row.consumed_at,
        created_at: row.created_at,
      })),
      journal: repos.journal.list(operation.id).map((row) => ({
        seq: row.seq,
        item_id: row.item_id,
        stage: row.stage,
        error_code: row.error_code,
        detail: row.detail,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // 能力开关的真值来源
  // -------------------------------------------------------------------------

  /**
   * 这个工作区现在**要不要人工恢复**。
   *
   * 装配根把它交给 `capabilityFlagsWith`，于是「逐工作区的
   * `recovery_required`」从一个恒为 `false` 的常量变成一次真实的查询
   * （LWB-025 起的那条记录在案的偏差，在这里落地）。
   *
   * 两个条件取**或**，而它们防的是不同的事：
   *
   *  - 有一个操作停在 `RECOVERY_REQUIRED` —— 盘上有说不清的字节；
   *  - 写执行槽被阻断 —— 那块地不许新的执行器进来。
   *    这一条**独立于**上一条：阻断可以比操作的状态晚一步解除，
   *    而「阻断还在、却报一切正常」会让下一个执行器直接撞上一个
   *    本该拦住它的门。
   *
   * 每次调用现查，不缓存。缓存会把「已经处理完了」这件事延迟到下一次
   * 失效为止，而读到这个值的是**工具面**：一个滞后的 `true` 会让模型
   * 在操作者刚处理完之后继续说「这个工作区需要人工恢复」。
   * 查询走 `changesets_workspace_idx` 与主键，是两次索引命中。
   */
  requiresRecovery(workspace: WorkspaceRecord): boolean {
    if (this.#deps.repos.operations.listRecoveryRequiredByWorkspace(workspace.id).length > 0) {
      return true;
    }
    const slot = this.#deps.repos.write_slots.find(workspace.volume_id, workspace.root_file_id);
    return slot !== null && slot.blocked_at !== null;
  }

  /** 当前**全部**等待人工恢复的工作区 id。给启动日志与排障用。 */
  workspacesAwaitingRecovery(): readonly string[] {
    const ids = new Set<string>();
    for (const operation of this.#deps.repos.operations.listByStates(['RECOVERY_REQUIRED'])) {
      const change = this.#deps.repos.changes.findById(operation.change_id);
      if (change !== null) ids.add(change.workspace_id);
    }
    for (const slot of this.#deps.repos.write_slots.list()) {
      if (slot.blocked_at !== null) ids.add(slot.workspace_id);
    }
    return [...ids].sort();
  }

  // -------------------------------------------------------------------------
  // 收尾的小件
  // -------------------------------------------------------------------------

  #now(): number {
    return this.#deps.now();
  }

  #ttlMs(): number {
    return this.#deps.authorization_ttl_ms ?? LIMITS.APPROVAL_TTL_MS;
  }

  #log(line: string): void {
    this.#deps.log?.(line);
  }

  /**
   * 把一句话里可能出现的**工作区根绝对路径**换成占位符。
   *
   * 这是 `@lwb/executor` 的 `redactRoot`，不是这里重新实现的 —— 两个
   * 「擦掉根」的实现里被漏掉的那一个，就是会漏出去的那一个。
   */
  #safe(scope: ReadScope, text: string): string {
    return redactRoot(text, scope);
  }

  #appendJournal(input: {
    readonly operation_id: string;
    readonly item_id?: string;
    readonly stage: RecoveryStage;
    readonly observed_file_id?: string | null;
    readonly observed_sha256?: string | null;
    readonly target_sha256?: string | null;
    readonly error_code?: string | null;
    readonly detail: string;
  }): void {
    this.#deps.repos.journal.append({
      operation_id: input.operation_id,
      item_id: input.item_id ?? null,
      stage: input.stage,
      observed_file_id: input.observed_file_id ?? null,
      observed_sha256: input.observed_sha256 ?? null,
      target_sha256: input.target_sha256 ?? null,
      error_code: input.error_code ?? null,
      // 上面的 `detail` 在**造出它的地方**就已经脱敏。见文件头。
      detail: input.detail,
    });
  }

  /**
   * 逐条目回执。**判成人工时也会写**（见 `reconcile`）。
   *
   * `before_sha256` 取条目里的基线哈希而不是「上次观测到什么」：基线和目标
   * 都是**被批准的那一份**，是这一条计划里唯一稳定的两个锚点。`after_sha256`
   * 取的却是**这一次的观测**，因此它会随着现场变化被下一次扫描改写 ——
   * 这正是「`updated_at` 记的是我们什么时候记的这笔账」那句话的用处。
   */
  #writeReceipts(operationId: string, inspection: Inspection): void {
    for (const entry of inspection.items) {
      const { item, verdict } = entry;
      this.#deps.repos.operations.setItemResult({
        operation_id: operationId,
        item_id: item.id,
        state: receiptStateOf(verdict),
        before_sha256: item.base_sha256,
        after_sha256: verdict.kind === 'IDENTITY_UNKNOWN' ? null : verdict.observed_sha256,
        // 判不出的那两种都要留下**为什么**：一个没有错误码的 `UNKNOWN`
        // 让操作者只知道「有一条不对」，而记录存在的意义正是说清是哪一条、
        // 哪里不对。`THIRD_CONTENT` 没有单独的 reason 字段（种类即原因），
        // 因此用它自己的名字，与 `#journalManual` 的 `error_code` 同一套词。
        error_code: receiptReasonOf(verdict),
      });
    }
  }

  #journalManual(inspection: Inspection): void {
    const blocking = inspection.items.filter(
      (entry) => entry.verdict.kind === 'IDENTITY_UNKNOWN' || entry.verdict.kind === 'THIRD_CONTENT',
    );
    const first = blocking[0];
    this.#appendJournal({
      operation_id: inspection.operation.id,
      stage: RECOVERY_STAGE.manual,
      error_code: inspection.reconciliation.reason,
      detail:
        `${String(blocking.length)} 个条目无法自动协调（${inspection.reconciliation.reason}）；` +
        '本流程没有改动任何一个字节，现场保留等待人工处理。' +
        (first === undefined ? '' : `首个条目：「${first.item.canonical_path}」${first.verdict.detail}`),
    });
  }

  #journalRepairFailure(inspection: Inspection, item: ChangeItemRecord, detail: string): void {
    this.#appendJournal({
      operation_id: inspection.operation.id,
      item_id: item.id,
      stage: RECOVERY_STAGE.repair_failed,
      error_code: 'REPAIR_INCOMPLETE',
      detail,
    });
  }
}

// ---------------------------------------------------------------------------
// 纯的小件
// ---------------------------------------------------------------------------

/**
 * 判定 → 回执状态（`operation_item_results.state`）。
 *
 * `RECOVERED_TARGET` / `RECOVERED_ORIGINAL` 说的都是**核验**，不是归属 ——
 * 与 §8.4 那句「恢复回执应说明『核验到目标状态』，不编造执行归属或时间」
 * 同一个措辞。判不出的两条都落 `UNKNOWN`，具体原因进 `error_code`：
 * 一个 `CONFLICT` 会声称「写入前的复核发现了冲突」，而这一步根本不在写入前。
 */
function receiptStateOf(
  verdict: ItemVerdict,
): 'RECOVERED_TARGET' | 'RECOVERED_ORIGINAL' | 'UNKNOWN' {
  switch (verdict.kind) {
    case 'TARGET_REACHED':
      return 'RECOVERED_TARGET';
    case 'ORIGINAL':
      return 'RECOVERED_ORIGINAL';
    case 'THIRD_CONTENT':
    case 'IDENTITY_UNKNOWN':
      return 'UNKNOWN';
    default: {
      const never: never = verdict;
      throw new Error(`未处理的判定：${String(never)}`);
    }
  }
}

/**
 * 判定 → 回执上的 `error_code`。
 *
 * 只有「没能给出结论」的那两种有码：`ORIGINAL` / `TARGET_REACHED` 是结论，
 * 给它们配一个错误码会把一次核验说成一次出错。
 */
function receiptReasonOf(verdict: ItemVerdict): string | null {
  switch (verdict.kind) {
    case 'IDENTITY_UNKNOWN':
      return verdict.reason;
    case 'THIRD_CONTENT':
      return 'THIRD_CONTENT';
    case 'ORIGINAL':
    case 'TARGET_REACHED':
      return null;
    default: {
      const never: never = verdict;
      throw new Error(`未处理的判定：${String(never)}`);
    }
  }
}

function receiptsOf(inspection: Inspection): ItemReceipt[] {
  return inspection.items.map((entry) => ({
    canonical_path: entry.item.canonical_path,
    op: entry.item.op,
    verdict: entry.verdict.kind,
    reason: entry.verdict.kind === 'IDENTITY_UNKNOWN' ? entry.verdict.reason : null,
    observed_file_id:
      entry.verdict.kind === 'IDENTITY_UNKNOWN' ? null : entry.verdict.observed_file_id,
    observed_sha256:
      entry.verdict.kind === 'IDENTITY_UNKNOWN' ? null : entry.verdict.observed_sha256,
    detail: entry.verdict.detail,
  }));
}

/**
 * 从日志里取出**这一个条目**的事实。
 *
 * 终局用 `itemOutcomes` 的折叠（每个条目的**最后一条**事件），
 * 身份取「最后一条带身份的事件」上的那个值。两件事都从同一份原始事件里
 * 取，因此不可能出现「终局说的是 A、身份来自 B」这种自相矛盾的组合。
 */
function journalOf(
  events: readonly ReturnType<typeof readItemEvents>[number][],
  itemId: string,
  outcomes: ReadonlyMap<string, { readonly kind: string; readonly events: number }>,
): JournalEvidence {
  const mine = events.filter((event) => event.item_id === itemId);
  if (mine.length === 0) return NO_JOURNAL_EVIDENCE;

  const withIdentity = mine.filter((event) => event.observed_file_id !== null);
  const last = withIdentity[withIdentity.length - 1];
  const outcome = outcomes.get(itemId);

  return {
    outcome: outcome?.kind ?? null,
    events: mine.length,
    observed_file_id: last?.observed_file_id ?? null,
    observed_sha256: last?.observed_sha256 ?? null,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
