/**
 * 安全暂停与紧急停用（LWB-034）。
 *
 * ## 这个模块要回答的问题
 *
 * 操作者在认定出问题的那一刻按下「紧急停用」。从那一刻起，这台机器上
 * 有四件事必须立刻为真，而且**每一件都要能被查出来为真**：
 *
 * | # | 事实 | 它由谁保证 |
 * | --- | --- | --- |
 * | 1 | 新的读取、命令执行与新应用被阻断 | 暂停状态**落库**（迁移 v8）；工具守卫与命令运行期间的授权监视都读取它 |
 * | 2 | 已排队的授权被废止 | `invalidateMany` 以 `SERVICE_PAUSED` 为触发因作废全部待执行修改集 |
 * | 3 | 进行中的写在安全边界停下 | 本模块的 `stopSignal()` 接进协调器**既有**的 `AbortController` |
 * | 4 | 已经算好但还没交回的结果不再发出 | 工具面的返回前复查多一格暂停判据（`guard.ts` 第 5 步） |
 *
 * 第 3 件是这一格最容易做错的地方，也是本模块存在的主要理由。
 *
 * ## 「不会粗暴杀写进程而假装零影响」
 *
 * 这一条是验收标准的原话，它禁止的是**最省事**的那种实现：给进程发一个
 * 终止信号，然后界面回到「已暂停，一切正常」。那样做的实际后果是
 * 盘上留着半份内容、状态库里写着 `APPLYING`、而没有任何人知道 ——
 * 因为知道这件事的那个进程已经没了。
 *
 * 本模块走的是另一条路：**不杀进程，只中止意图**。协调器本来就有
 * 一个 `AbortController`（超时与心跳丢失都靠它），中止信号在写盘人
 * 自己的安全边界上被检查：动笔之前中止 ⇒ 一个字节都没动；
 * 动笔之后中止 ⇒ 这次写按**不知道写到哪**处理，进待恢复。
 * 两条路都不假装，而两条路都不需要杀进程。
 *
 * 执行者还活在原地，因此它能把「我停了 / 我写到一半」如实落库。
 * 一个被杀掉的进程没有这个机会 —— 那才是「粗暴杀」真正的代价。
 *
 * ## 次序：先落库，再中止
 *
 * 四步的次序不是随意的，它是这一格正确性的一部分：
 *
 * ```
 * ① 落库（paused = 1）       ← 先让它成为事实
 * ② 中止在途写入             ← 同一个 AbortController，不换新的
 * ③ 废止排队授权             ← 改的是修改集，不是这次中止
 * ④ 交回一份**现值现算**的状态 ← 调用方据此写审计、据此报给操作者
 * ```
 *
 * ① 必须在 ② 之前，因为工具面与 `applyChange` 读的是**库**：先落库意味着
 * 在 ① 之后开始的每一次写入都会在**开始之前**被拒，于是 ② 只需要收拾
 * 那些在 ① 之前就已经开始的。反过来（先中止后落库）会留下一个窗口，
 * 窗口里开始的写入既没被中止也没被阻断 —— 它得靠别的东西兜住，
 * 而一个安全动作不该依赖「别的东西兜得住」。
 *
 * ③ 在 ② 之后：废止写的是状态库，而它要覆盖的范围恰好是「还没动笔的那些」。
 * 一个已经进入 `APPLYING` 的修改集**不**在废止范围内（`INVALIDATABLE_STATES`
 * 只含 `PENDING_APPROVAL` / `APPROVED` / `QUEUED`），它会作为 `skipped`
 * 被如实报出来 —— 那一格归 ② 管，不归 ③。
 *
 * ## 暂停**落库**，而不是活在内存里
 *
 * 理由写在迁移 v8 里，这里只重复那一句最要紧的：一次崩溃重启会**静默地**
 * 清掉一个只活在内存里的紧急停用，而一个「忘记自己停过」的安全动作
 * 比没有这个动作更危险。落库还让工具面与控制台读**同一个**来源。
 *
 * ## 这个模块**不写审计**
 *
 * 暂停与恢复的完整记录（谁、什么时候、结果）由控制层写
 * （`apps/daemon/src/control/pause.ts` 的 `service.pause` / `service.resume`），
 * 与本工程其余控制动作一致（`workspaces.ts`、`connections.ts` 同）。
 * 本模块因此不依赖 `@lwb/audit`，也不接受任何**自由文本**入参 ——
 * 「为什么按它」没有进这张表，理由写在迁移 v8 的注释里（那一段值得读：
 * 它讲的是一列看起来无害的 `reason` 如何变成一条把本机路径写进状态库的路）。
 *
 * ## `release()` 不恢复任何批准 —— 这是刻意的
 *
 * 紧急停用按下时被废止的那些排队授权**不会**因为恢复而回来。理由不是
 * 实现偷懒，是这两句话的意思不同：
 *
 *  - 「暂停」= 现在别动；
 *  - 「紧急停用」= 从此刻起，已经排好队但还没动笔的一律作废。
 *
 * 操作者按下的是一个**紧急**按钮。如果恢复会把作废的批准变回可用，
 * 那么「紧急停用 → 恢复」就成了一次带副作用的深呼吸，而那个副作用
 * （一批旧的批准复活）正好发生在操作者最不想要它的时候。
 * 要重新写，就重新准备一次修改集 —— 那是几步操作，而这几步是**故意的**。
 *
 * ## 废止那一步失败了怎么办
 *
 * 不撤 ①，不吞，如实报。
 *
 * 不撤 ①：暂停是操作者要的，而废止只是它的一个**子动作**；因为子动作
 * 失败就把主动作回滚，得到的是「什么也没停」—— 那是把一次部分成功
 * 变成一次彻底失败，而失败的那一侧正好是危险的那一侧。
 *
 * 如实报：`PauseOutcome.revoke_error` 会带着原因交回调用方，由控制层
 * 记进审计并报给操作者。不复用的做法是「报个成功、假装都作废了」——
 * 那正是「假装零影响」的另一种写法。
 *
 * 而「还剩几条没作废」这件事**不另存一个标志位**：`status()` 每次从
 * `changes` 表现算（`unrevoked_change_sets`）。存标志位会造出第二份
 * 真相，而它一定会与表里的行分叉 —— 分叉的那一天，界面显示的正是
 * 那个过期的数字。
 */

import type { ChangeSetState } from '@lwb/contracts';
import type { InvalidationOutcome, InvalidationSkip } from '@lwb/changes';
import { invalidateMany, PENDING_CHANGE_STATES } from '@lwb/changes';
import type { Repositories } from '@lwb/persistence';

/** 一次写入的**进行中**三个状态。与 `OperationsRepo.listUnfinished` 同一组。 */
const EXECUTION_CHANGE_STATES: readonly ChangeSetState[] = ['QUEUED', 'VALIDATING', 'APPLYING'];

/**
 * 中止理由。**一句话，没有插值。**
 *
 * 将来读执行日志的人要能从这句话直接知道两件事：这次中止不是超时、
 * 也不是心跳丢失，而是**有人按了按钮**；以及这次停顿**不是终局**。
 * 因此它是常量而不是一个模板 —— 一个可以插值的理由，迟早会有人往里
 * 塞一个路径或一段用户内容，而它落到的是执行日志与恢复记录里。
 */
export const PAUSE_ABORT_REASON = '本地服务已紧急停用：在途写入在下一个安全边界停止，未完成的部分按待恢复处理。';

/** 一件**此刻还占着写执行槽**的写入。 */
export interface StoppingWrite {
  readonly operation_id: string;
  readonly change_id: string;
  readonly workspace_id: string;
  /** 操作自己的状态。`APPLYING` 意味着它可能已经动过盘。 */
  readonly state: ChangeSetState;
  /** 正在写它的那个进程。界面据此说「哪个进程正在停」。 */
  readonly holder_pid: number;
  readonly acquired_at: string;
  readonly heartbeat_at: string;
  /**
   * 这块地是否已经被标为阻断。被阻断的槽位与「正在写」不同：
   * 前者的持有者多半已经不在了。两者都报出来，由界面分开说。
   */
  readonly slot_blocked: boolean;
}

/** 一条**仍然待执行**的修改集 —— 也就是「排队授权还没被废止」的活证据。 */
export interface PendingAuthorization {
  readonly change_id: string;
  readonly workspace_id: string;
  readonly state: ChangeSetState;
  readonly expires_at: string;
}

/** 一个等着人处理的恢复现场。 */
export interface RecoveryOperation {
  readonly operation_id: string;
  readonly change_id: string;
  readonly workspace_id: string;
}

export interface PauseStatus {
  readonly paused: boolean;
  /** 这一次暂停是什么时候开始的。没有暂停过则 `null`。 */
  readonly paused_at: string | null;
  /**
   * 这张表最后一次被写的时刻。`null` 表示这台机器**从来没有被暂停过** ——
   * 它与「暂停过、已恢复」不同（那一行会留下 `updated_at`），
   * 而界面需要能说出这个差别。
   */
  readonly updated_at: string | null;
  /**
   * 此刻还占着写执行槽的写入。**空不等于这台机器上没有写在跑** ——
   * 它是「现在还握着写盘权的那几个」，界面用它说「正在停止：N 件」，
   * 而这句话只在它非空时才有意义。
   */
  readonly stopping: readonly StoppingWrite[];
  /**
   * 仍然待执行的修改集。暂停中它非空，意味着**废止那一步没做完**
   * （或者有人在暂停期间又从控制台排了一条 —— 控制台不受暂停阻断，
   * 而那种改动集在暂停期间不会被应用）。现值现算，不存标志位。
   */
  readonly unrevoked_change_sets: readonly PendingAuthorization[];
  /** 等着人处理的恢复现场。暂停与它们无关，但界面必须在同一屏里说清楚。 */
  readonly recovery_operations: readonly RecoveryOperation[];
  /**
   * 已经**交出去**的文件访问行数 —— 「已返回给 ChatGPT 的内容无法撤回」
   * 这一句的可观测形式。
   *
   * 它的口径比那句话**宽**：口径是「结果已经交回适配器进程」
   * （`audit_file_access.delivered = 1`），而适配器拿到之后是不是真的
   * 送到了浏览器那一端，本进程不知道。取宽的那一侧是刻意的，
   * 理由写在 `AuditRepo.countDeliveredFileAccess` 里：一个偏小的
   * 「收不回来」读数会让人以为漏得没那么多。
   */
  readonly unrecallable_file_rows: number;
}

/** `engage()` / `release()` 交回的东西。 */
export interface PauseOutcome {
  readonly status: PauseStatus;
  /** 调用之前就已经是暂停中。**四步仍然全部做过。** */
  readonly already: boolean;
  /** 被这次暂停作废掉的修改集。 */
  readonly revoked: readonly InvalidationOutcome[];
  /** 看的时候还在、动手时已经走掉的修改集。**这不是错误**（见 `invalidateMany`）。 */
  readonly skipped: readonly InvalidationSkip[];
  /**
   * 废止那一步**整体抛错**时的消息。非 `null` 表示没能把排队授权全部作废，
   * 而暂停本身仍然是生效的 —— 这两件事必须分开读。控制层要在
   * `status().unrevoked_change_sets` 里看得见剩下的那几条。
   */
  readonly revoke_error: string | null;
  /**
   * 落库那一步抛错时的消息。非 `null` 表示**暂停没有成为事实**：
   * 在途写入已经停了、排队授权可能也废了，但重启之后这台机器不会记得
   * 自己停过，而工具面读到的 `paused` 是 `false`。控制台必须把它当失败报。
   *
   * 它由控制层翻成一条错误（本模块不抛），因为**审计要先写**：
   * 「有人按过」这件事在落库失败时反而更重要，而一条抛出去的错误
   * 会让控制层来不及记下它。
   */
  readonly persist_error: string | null;
}

export type PauseNotice =
  | { readonly kind: 'REVOKE_FAILED'; readonly detail: string }
  | { readonly kind: 'PERSIST_FAILED'; readonly detail: string };

export interface PauseServiceDeps {
  readonly repos: Repositories;
  /**
   * 记录**不可抛**的异常。与协调器的 `on_notice` 同一种约定：
   * 省略时静默 —— 但调用方拿到的 `PauseOutcome` 里一定看得到同样的内容，
   * 因为这两条路服务的是两个不同的读者（本进程的日志与界面）。
   */
  readonly on_notice?: (notice: PauseNotice) => void;
  /**
   * 读时刻的那口钟，返回 ISO 串。省略即真实当下。
   *
   * 它存在，是因为「这条批准过期没有」这个判断**必须与写这条批准的那口钟
   * 是同一口**：`invalidateMany` 拿它的 `now` 去和 `approvals.expires_at`
   * 比，而那个时刻是 `Repositories` 的钟写下的。两口径不一致时的后果不是
   * 报错，而是**如实的事实被记成另一个** —— 一次「操作者按停用」会被记成
   * 「批准本来就过期了」，于是审计里看不见有人按过。
   *
   * 默认值就是 `Repositories` 的默认钟（真实当下），因此生产装配不必传它；
   * 传它的是注入过时钟的场景（测试、以及将来任何可重放的时间轴）。
   */
  readonly now?: () => string;
}

/**
 * 全局暂停。**一个进程一个实例**，而它的 `stopSignal()` 必须交给
 * **那一个**协调器 —— 两个实例会造出两个互不知晓的中止信号，
 * 于是「按了停用但有一个执行者没停」成为可能。
 */
export class PauseService {
  readonly #repos: Repositories;
  readonly #onNotice: (notice: PauseNotice) => void;
  readonly #now: () => string;

  /**
   * 当前这一轮的中止信号。**换它只有一处**：`release()`。
   *
   * `engage()` 刻意**不**换：一个已经开始的执行在 `#execute` 里拿着
   * 这个对象的引用并挂了监听器，换掉它等于让那一次中止落在一张
   * 没人听的旧信号上 —— 写盘人会一直写下去，而界面说「已暂停」。
   * 重复按暂停因此是无害的（这正是它该有的样子）。
   */
  #stop = new AbortController();

  constructor(deps: PauseServiceDeps) {
    this.#repos = deps.repos;
    this.#onNotice = deps.on_notice ?? ((): void => {});
    this.#now = deps.now ?? ((): string => new Date().toISOString());

    // 让信号与状态库对齐。库里写着「停着」的话，这一轮的中止信号
    // **一出生就是中止的** —— 上一轮进程在停用期间死掉、这一轮重启，
    // 正是这行代码要覆盖的那一格。
    //
    // 它**不调 `engage()`**：启动不是一次操作者的动作，因此它既不写
    // `updated_at`（那会让「上次暂停于」变成一个关于重启时刻的假话），
    // 也不再去作废一遍排队授权（上一次按下去的时候已经做过，而且
    // 那些修改集在库里已经是 `INVALIDATED` 了）。
    //
    // 读库失败就让它抛：构造不出一个「不知道自己停没停」的暂停服务，
    // 比构造出一个然后靠各调用点自觉要好。装配根本来就会因此起不来，
    // 而那是一个如实的失败。
    if (this.#repos.service_pause.isPaused()) {
      this.#stop.abort(new Error(PAUSE_ABORT_REASON));
    }
  }

  /**
   * 交给协调器的那一个信号源。
   *
   * 返回的是**活的对象**（`readonly` 只防重新赋值，不防 `addEventListener`），
   * 因此协调器必须在自己的 `finally` 里摘掉监听器 —— 否则一个长命的
   * 服务进程会把每一次执行的监听器都挂在同一个信号上，而中止那一刻
   * 它们会全部触发（Node 在 11 个监听器上开始告警）。
   */
  stopSignal(): AbortSignal {
    return this.#stop.signal;
  }

  /**
   * 现在停着吗。**读库，不读内存** —— 工具面每一步都问它，
   * 而它必须与控制台看到的是同一个答案。
   *
   * 读库失败时**抛**，不返回 `false`。这一点与 `ServicePauseRepo.current()`
   * 那一侧的取舍不同，而且不矛盾：仓储那一层「没有行」是一个**已知**的
   * 含义（从来没有暂停过），而这里可能抛的是「查不出来」——
   * 把「查不出来」答成「没暂停」正是这一格最坏的失效方向，
   * 因为它会让读取继续。上游（`guard.ts`）因此把这条异常翻成一次阻断，
   * 而不是一次放行。
   */
  isPaused(): boolean {
    return this.#repos.service_pause.isPaused();
  }

  /**
   * 紧急停用。四步，见文件头。
   *
   * **幂等**：已经在暂停中时四步照做（中止仍然发一次、排队授权仍然扫一遍
   * —— 上一次可能没扫干净），但 `paused_at` 保持第一次的。
   *
   * **不抛**。落库失败与废止失败都从返回值里交回，由控制层先写审计、
   * 再决定怎么报（理由见 `PauseOutcome.persist_error`）。
   */
  engage(): PauseOutcome {
    const before = this.#repos.service_pause.current();
    const already = before.paused;

    // ① 落库。失败**不**中断后面两步：操作者要的是「停」，而落库只是
    //    让这个「停」活过重启。因为落库失败就不停手，等于把一次
    //    「停不下来」当成一次「没停过」。
    let persistError: string | null = null;
    try {
      this.#repos.service_pause.engage();
    } catch (error) {
      persistError = messageOf(error);
      this.#onNotice({ kind: 'PERSIST_FAILED', detail: persistError });
    }

    // ② 中止在途写入。同一个对象，见 `#stop` 的说明。
    if (!this.#stop.signal.aborted) {
      this.#stop.abort(new Error(PAUSE_ABORT_REASON));
    }

    // ③ 废止排队授权。整段包住：`invalidateMany` 会把「数据库写不进去」
    //    这类异常照抛（它自己只吞 STATE_CHANGED 与 NOT_FOUND），而那个
    //    时候最要紧的是**别把已经停下来的东西又启动回去**。
    let revoked: readonly InvalidationOutcome[] = [];
    let skipped: readonly InvalidationSkip[] = [];
    let revokeError: string | null = null;
    try {
      const report = invalidateMany(this.#repos, {
        change_ids: this.#repos.changes.listByStates(PENDING_CHANGE_STATES).map((c) => c.id),
        trigger: 'SERVICE_PAUSED',
        // 用本服务那口钟，**不**用 `new Date()`：这一格的 `now` 要拿去和
        // `approvals.expires_at` 比大小，而那个时刻是 `Repositories` 的钟
        // 写的。口径不一致时，一次「有人按了停用」会被记成「批准本来就
        // 过期了」—— 事实被记成另一个，而且没有任何报错。
        now: this.#now(),
      });
      revoked = report.invalidated;
      skipped = report.skipped;
    } catch (error) {
      revokeError = messageOf(error);
      this.#onNotice({ kind: 'REVOKE_FAILED', detail: revokeError });
    }

    // ④ 交回现值现算的状态。
    return {
      status: this.status(),
      already,
      revoked,
      skipped,
      revoke_error: revokeError,
      persist_error: persistError,
    };
  }

  /**
   * 解除暂停。
   *
   * 两件事，而且**之间不许有 `await`**：
   *
   * ```
   * ① paused = 0
   * ② 换一个新的 AbortController
   * ```
   *
   * 为什么次序是「先清标志、再换信号」而不是反过来：只要标志还立着，
   * 就没有任何新执行能开始（`applyChange` 会拒），因此 ① 之后开始的那次
   * 执行拿到的必须是**新**信号。而如果 ② 在 ① 之前，那中间的一瞬里
   * 标志还是 1、执行仍被拒，看起来无害 —— 真正的危险是将来有人把次序
   * 改成「先清标志、后换信号」而在中间插进了 `await`：那一刻新执行会拿到
   * **已经中止**的旧信号，于是它在第一步就自判中止。
   *
   * 这里没有 `await`，所以两行之间不可能被插入任何东西（JS 是单线程的，
   * 而下面两次调用都是同步的）。这一点值得写下来，因为「它们之间不许有
   * `await`」是一条**看不见的**约束：破坏它不会编译失败，只会让恢复之后的
   * 第一次写入莫名其妙地失败一次。
   *
   * **不恢复任何批准**（见文件头）。也**不清理** `unrevoked_change_sets`：
   * 那些修改集已经被作废了，`unrevoked` 因此自然归零 —— 除非 ③ 抛过错，
   * 而那种情况下它们仍然待执行，界面上仍然看得见。
   */
  release(): PauseOutcome {
    const already = !this.#repos.service_pause.current().paused;

    this.#repos.service_pause.release();
    this.#stop = new AbortController();

    return { status: this.status(), already, revoked: [], skipped: [], revoke_error: null, persist_error: null };
  }

  /**
   * 当前状态。**全部现值现算**（除暂停本身那一行），因此它不会与
   * 状态库里的行分叉。
   *
   * 四段读的是四张不同的表，因而不在同一个快照里。这一点是**接受**的：
   * 这里回答的是「此刻大致是什么情况」，而它的任何一格在下一毫秒都可能
   * 变化。把它包进一个事务只会让这四段一致于某个瞬间 ——
   * 而读它的人（界面、工具面）看到的仍然是之后的世界。
   * 真正需要一致性的那些判据（能不能写、批准还在不在）在各自的
   * 事务里重新核，不依赖这里。
   */
  status(): PauseStatus {
    const row = this.#repos.service_pause.current();

    const stopping: StoppingWrite[] = [];
    for (const slot of this.#repos.write_slots.list()) {
      const operation = this.#repos.operations.findById(slot.operation_id);
      // 槽位可能在、操作已经不在了（被删/被改）；那种行不报成「正在写」。
      // 如实报的前提是**每一条都说得出是哪一次写入**。
      if (operation === null) continue;
      if (!EXECUTION_CHANGE_STATES.includes(operation.state)) continue;
      stopping.push({
        operation_id: operation.id,
        change_id: operation.change_id,
        workspace_id: slot.workspace_id,
        state: operation.state,
        holder_pid: slot.holder_pid,
        acquired_at: slot.acquired_at,
        heartbeat_at: slot.heartbeat_at,
        slot_blocked: slot.blocked_at !== null,
      });
    }

    return {
      paused: row.paused,
      paused_at: row.paused_at,
      updated_at: row.updated_at,
      stopping,
      unrevoked_change_sets: this.#repos.changes.listByStates(PENDING_CHANGE_STATES).map((change) => ({
        change_id: change.id,
        workspace_id: change.workspace_id,
        state: change.state,
        expires_at: change.expires_at,
      })),
      recovery_operations: this.#repos.operations.listByStates(['RECOVERY_REQUIRED']).map((operation) => ({
        operation_id: operation.id,
        change_id: operation.change_id,
        // 操作行里没有 `workspace_id`，它挂在修改集上。修改集不在时给空串
        // 而不是编一个 —— 界面看到空串会显示「(未知工作区)」，
        // 而编一个 id 会让排障的人去查一个不存在的根。
        workspace_id: this.#repos.changes.findById(operation.change_id)?.workspace_id ?? '',
      })),
      unrecallable_file_rows: this.#repos.audit.countDeliveredFileAccess(),
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
