/**
 * 装配根（装配根）。
 *
 * ## 这个文件补的是谁的空缺
 *
 * `npm run daemon` 一直指向 `apps/daemon/src/main.ts`，而那个文件（以及
 * 它需要的这一层）在任务清单里**没有任何一条任务认领** —— LWB-039 交付的是
 * `apps/daemon/lifecycle/` 与 `packaging/launcher/`，也就是常驻、睡眠唤醒、
 * 开机启动那一层，它假设「已经有一个能启动的 daemon 进程」。偏差项 55
 * 从 LWB-017 起就记着这件事。本文件把 `docs/PROGRESS.md` 里那句
 * 「装配根仍不存在」变成一句可运行的事实。
 *
 * ## 启动顺序是有理由的，不是随手排的
 *
 * | # | 做什么 | 为什么必须在这个位置 |
 * | --- | --- | --- |
 * | 1 | 解析参数 | 未知参数一律拒绝（见 `options.ts`），这一步不碰任何东西 |
 * | 2 | 解析受保护根 | 后面每一步都要用它 |
 * | 3 | 启动 Windows 助手 | 身份、ACL、DPAPI 三件事都要它；不可用即拒绝启动 |
 * | 4 | 取当前用户 SID | 互斥量的名字由它决定 |
 * | 5 | 抢单实例互斥量 | **在创建任何状态之前**：第二个实例不该先动过库再退出 |
 * | 6 | 加固受保护根并回读校验 | 校验不过拒绝启动，不接受「先跑起来，ACL 稍后再说」 |
 * | 7 | 取/建凭证 | 必须在加固之后：加固之前写进去的凭证不享受那套 DACL |
 * | 8 | 打开状态库 | |
 * | 9 | 确保模型侧连接行存在（**默认停用**） | 行是「认识这个名字」，启用是「允许它调用」 |
 * | 10 | 起原生护栏 | 第 11 步要它探测身份 |
 * | 11 | 探测受保护对象身份 | 探测不到就停止启动（`collectProtectedRefs` 的契约） |
 * | 12 | 启动恢复扫描 | **必须在第 13 步之前**，见下 |
 * | 13 | 登记表、工具面、控制操作 | 三者共用**同一个**操作注册表 |
 * | 14 | 控制平面监听 | 绑定之后端口才确定，启动令牌的 URL 才能拼对 |
 * | 15 | 数据管道 | |
 * | 16 | 过期清理 | 「重连后的启动清理」，见下 |
 * | 17 | 签发启动令牌并打印 | 最后一步：此前任何一步失败都不该留下一张能进控制台的 URL |
 *
 * ## 第 12 步为什么必须排在工具面之前
 *
 * LWB-030 步骤 1 的原文是「启动时先处理未终结操作，**再**开放工作区写能力」。
 * 这句话在本文件里的落点是一处**行序**：`RecoveryService.sweepStartup()` 在
 * `createToolSurface` 之前跑完。工具面是模型侧唯一能碰到工作区的入口，
 * 它的开关里有一项 `recovery_required`（逐工作区，见 `gates.ts` 的
 * `capabilityFlagsWith`），而那一项的数据源就是这次扫描的结果。
 *
 * 反过来写（先建工具面、再扫描）会留下一个真实的窗口：从上一步跑完到
 * 下一步开始之间，一个 `APPLYING` 的操作会被工具面当成「正在写」而
 * 不是「等人处理」，于是那个工作区在窗口期内是可写的。
 *
 * 恢复扫描**不阻塞启动**：判不成的操作留成 `undecidable` 记在事实里，
 * 而不是让 daemon 起不来。它一个字节都不写（见 `packages/recovery/src/plan.ts`
 * 文件头「自动完成的判据是这次定案一字节都不写」），因此「先跑它」
 * 不会带来任何「启动时动了用户文件」的风险。
 *
 * ## 退出路径与启动失败的清理路径是**同一条**
 *
 * 两者都走 `#unwind()`：按相反顺序执行同一批撤销动作。分头写两份的后果是
 * 「启动失败时留着的东西」与「正常退出时留着的东西」不一样，而后者天天被走、
 * 前者一年走一次 —— 于是只在失败路径上泄漏的那些（一个没关的库、
 * 一个还占着名字的管道）会长期不被发现。
 *
 * ## 启动时清理一次过期项
 *
 * `sweepExpired` 收掉到期的批准与修改集。放在启动时而不是只放在定时任务里，
 * 理由与 LWB-024 证据里的那条一致：**daemon 不在运行的这段时间，时钟照走**。
 * 一次关机三天之后的重启，如果只在「下一次定时扫描」时才清理，那么这段时间里
 * `approvals.list` 会列出一批实际已经过期的批准（读时投影会把它们显示成
 * 过期，但行本身仍写着 ACTIVE）。启动时清一次，让「行上的事实」与
 * 「读时的投影」在服务可用之前就对齐。
 *
 * 它**只报数量**：清理报告里带的是 change_id，而启动日志不该出现用户
 * 工作区里的标识符 —— 数量足以回答「这次启动收掉了东西没有」。
 */

import { arch, hostname, platform } from 'node:os';

import { LIMITS, newLocalId } from '@lwb/contracts';
import type { CapabilityFlags } from '@lwb/contracts';
import { BlobStore } from '@lwb/blob-store';
import { collectSnapshotGarbage, sweepExpired } from '@lwb/changes';
import { RecoveryService } from '@lwb/recovery';
import { EgressBudgetStore } from '@lwb/egress';
import { createReadTicketAuthority } from '@lwb/files';
import {
  createNativeApplier,
  DEFAULT_APPLY_WAIT_MS,
  ExecutionCoordinator,
  PauseService,
} from '@lwb/executor';
import {
  createProcessProbe,
  IPC_PROTOCOL_VERSION,
  OperationRegistry,
  acquireSingleInstance,
  releaseSingleInstance,
} from '@lwb/ipc';
import type { AudienceSecrets, SessionEvent } from '@lwb/ipc';
import { ControlServer, type ControlEvent } from '../control/control-plane.ts';
import type { StaticControlAsset } from '../control/server.ts';
import { createControlPlane } from '../control/control-plane.ts';
import { ControlSessionStore } from '../control/session.ts';
import { registerApprovalOperations } from '../control/approvals.ts';
import { registerChangeOperations } from '../control/changes.ts';
import { snapshotStoreMaxBytesFromEnvironment } from './snapshot-quota.ts';
import { startSnapshotMaintenanceLoop } from './snapshot-maintenance.ts';
import { registerConnectionOperations } from '../control/connections.ts';
import { registerHistoryOperations } from '../control/history.ts';
import { registerPauseOperations } from '../control/pause.ts';
import { registerRecoveryOperations } from '../control/recovery.ts';
import { registerWorkspaceOperations } from '../control/workspaces.ts';
import { registerWorkspaceAccessOperations } from '../control/workspace-access.ts';
import { BRIDGE_GATES, capabilityFlagsFrom, capabilityFlagsWith, limitationsOf } from '../gates.ts';
import type { PlatformGates } from '../gates.ts';
import { createToolSurface } from '../tools/index.ts';
import type { ToolSurfaceFacts } from '../tools/index.ts';
import { CommandProcessManager } from '../lifecycle/command-processes.ts';
import { backupDatabaseBeforeMigration, closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import {
  CredentialStore,
  STORE_SUBDIRECTORIES,
  SecureStoreHelper,
  hardenStore,
  resolveStoreLayout,
  type HardenedStore,
} from '@lwb/secure-store';
import { disposeWinfsBackend, getWinfsBackend } from '@lwb/winfs';
import type { WinfsCapability } from '@lwb/winfs';
import { collectProtectedRefs, protectedStorePaths, resolveWorkspaceEnvironment } from '@lwb/workspaces';
import { WorkspaceRegistry } from '@lwb/workspaces';

import {
  ADAPTER_CONNECTION_ALIAS,
  ADAPTER_CONNECTION_ID,
  ADAPTER_PRINCIPAL_ID,
  DAEMON_VERSION,
} from './constants.ts';
import { loadIpcSecrets, loadRuntimeKeys } from './credentials.ts';
import { startDataPipe, type DataPipe } from './ipc-server.ts';
import { parseStartupOptions, type StartupOptions } from './options.ts';

// ---------------------------------------------------------------------------
// 对外形状
// ---------------------------------------------------------------------------

/** 启动日志的去处。**只在装配根注入**，其余各层一律不自己写控制台。 */
export type LogSink = (line: string) => void;

export interface StartupFacts {
  readonly version: string;
  readonly protocol_version: string;
  readonly store_root: string;
  readonly store_root_overridden: boolean;
  readonly gates: PlatformGates;
  readonly capability_flags: CapabilityFlags;
  /** 原生护栏的自检结论。**不可用时拒绝启动**，因此这里恒为 available。 */
  readonly guard: { readonly backend: string; readonly reason: string };
  /**
   * 数据管道名，**SID 摘要已换成 `<sid-hash>`**（`describePipe`）。
   *
   * 这一份是给人看的（启动日志、状态页）。真实名字不带在事实里：
   * 需要连它的启动器自己由 SID 算（`dataPipeName`），不需要从日志里认。
   */
  readonly pipe_name: string;
  readonly control_origin: string;
  readonly workspaces: number;
  readonly connections: number;
  readonly grants: number;
  /** 注册表里的**全部**操作名（工具面 + 控制面），排序。 */
  readonly operations: readonly string[];
  /** 其中属于工具面（模型侧）的那几个的数量。 */
  readonly tool_operations: number;
  readonly sweep: {
    readonly expired_changes: number;
    readonly expired_approvals: number;
    /**
     * 收掉的过期恢复授权数。
     *
     * 与批准分开报，因为它们是**两条**通道：一份过期的批准意味着
     * 「那次修改没被做」，一份过期的恢复授权意味着「有人打开过恢复界面、
     * 想了十分钟、然后什么都没做」—— 后者是一个值得被看见的信号，
     * 合进前者的数字里就看不见了。
     */
    readonly expired_recovery_authorizations: number;
  };
  /**
   * 启动恢复扫描的结论（LWB-030）。
   *
   * **只报数量**，理由与 `sweep` 相同：这里会出现在启动日志上，而启动日志
   * 不该出现用户工作区里的标识符。`undecidable` 的正文（哪个操作、
   * 什么原因）在状态库与恢复记录里，不在这一格里。
   */
  readonly recovery: {
    /** 上一个进程留下的未终结操作数（已全部标为待恢复，未重放）。 */
    readonly leftovers: number;
    /** 本次启动自动定案的数量。 */
    readonly reconciled: number;
    /** 判完但**没能定案**、留给操作者的数量。 */
    readonly awaiting_manual: number;
    /** 连判定都没做成的数量（护栏不可用、快照取不到…）。 */
    readonly undecidable: number;
    /** 扫描结束时仍需要人工恢复的工作区数 —— 也就是 `recovery_required` 为真的那些。 */
    readonly workspaces_flagged: number;
  };
  /**
   * 本次启动是否**新建**了凭证。
   *
   * 它值得被记下来，因为「第二次启动仍然是新建」意味着上一把密钥丢了 ——
   * 而丢了密钥的表现是「服务正常启动」，只是此前签发的读取票据与游标
   * 全部失效。没有这一格，那种失效只能靠调用方发现「我的票据突然不认了」。
   */
  readonly credentials: { readonly runtime_created: boolean; readonly ipc_created: boolean };
  /** 被启动日志筛查拦下的行数。非 0 说明有一条日志路径试图写出凭证。 */
  readonly withheld_log_lines: number;
}

export interface DaemonRuntime {
  readonly options: StartupOptions;
  readonly facts: StartupFacts;
  /**
   * 打印给操作者的控制台地址。令牌在 `#` 片段里。
   *
   * 它**会**出现在启动摘要的那一行上 —— 那是它唯一的交付渠道，
   * 不打印操作者就打不开控制台。要保证的不是「哪都不出现」，而是
   * 「只在那里出现一次」：
   *
   *  - 不进 `StartupFacts`（`bridge_status`、状态页、诊断包都从那里取数）；
   *  - 不进状态库的任何字节（审计与幂等记录都在里面）；
   *  - 不进 `withheld.targets`：它是**一次性**的（兑换即焚），且
   *    `mintBootstrap` 每次签发都会作废此前未兑换的全部令牌，
   *    因此终端里最后打印的那一行才是有效的。把它当成长期密钥去筛查，
   *    反而会让「启动日志里出现了令牌」这件事看起来正常。
   */
  readonly bootstrap_url: string;
  /** 供测试与将来的生命周期层使用。 */
  readonly control: ControlServer;
  readonly pipe: DataPipe;
  readonly repos: Repositories;
  readonly sessions: ControlSessionStore;
  /**
   * 恢复服务。**本机操作者那条通道上的东西，不在工具面里。**
   *
   * 它由装配根构造并交出去（控制台、控制平面要用 `records` /
   * `workspacesAwaitingRecovery`），而不是各自再 `new` 一个 ——
   * 第二个实例会让「谁签发的恢复授权」这个问题有两个答案。
   */
  readonly recovery: RecoveryService;
  /** Resolves when the current Windows user requests a controlled local stop. */
  readonly stop_requested: Promise<void>;
  /**
   * Minimal environment for a trusted local MCP/tunnel child process.
   * Contains only the model audience secret, never the console secret. Callers
   * must pass it directly to the child environment and must not log or persist it.
   */
  mcpAdapterEnvironment(): Readonly<Record<string, string>>;
  shutdown(): Promise<void>;
}

export class StartupFailed extends Error {
  /** 该由进程退出码表达的分类，见 `constants.ts`。 */
  readonly kind: 'startup_failed' | 'already_running';
  constructor(kind: 'startup_failed' | 'already_running', message: string) {
    super(message);
    this.name = 'StartupFailed';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// 撤销栈
// ---------------------------------------------------------------------------

interface UndoStep {
  readonly name: string;
  readonly undo: () => Promise<void> | void;
}

/**
 * 撤销栈：启动时逐条压入，退出（或失败）时**按相反顺序**弹光。
 *
 * 每一条自己负责「重复调用不出错」：正常退出与启动失败可能都会把同一批
 * 撤销动作跑到，而第二次 `closeDatabase` 抛错会让真正的错误被顶掉。
 */
class UndoStack {
  readonly #steps: UndoStep[] = [];
  #unwound = false;

  push(name: string, undo: () => Promise<void> | void): void {
    this.#steps.push({ name, undo });
  }

  async unwind(log: LogSink): Promise<void> {
    if (this.#unwound) return;
    this.#unwound = true;
    for (const step of [...this.#steps].reverse()) {
      try {
        await step.undo();
      } catch (error) {
        // 撤销失败**不**中断其余的撤销：一个关不掉的句柄不该让
        // 后面的库连接也留着。这里如实报出来，但不掩盖原始错误。
        log(`清理「${step.name}」时失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

export interface StartDaemonOptions {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 省略即写 `process.stdout`。测试注入自己的收集器。 */
  readonly log?: LogSink;
  /** CLI 从固定构建目录装入；单元/边界测试默认不托管网页。 */
  readonly static_assets?: ReadonlyMap<string, StaticControlAsset>;
}

/**
 * 启动 daemon。
 *
 * 失败一律抛 `StartupFailed`：调用方（`main.ts`）据 `kind` 决定退出码，
 * 不自己判断错误类型 —— 「哪一类失败对应哪个退出码」这件事只在一个地方说。
 */
export async function startDaemon(options: StartDaemonOptions): Promise<DaemonRuntime> {
  const rawLog: LogSink = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const stack = new UndoStack();
  const withheld = { count: 0, targets: [] as readonly string[] };

  // 日志筛查：**任何一行**日志在写出之前都对着已持有的机密比一次。
  // 特征匹配会漏（凭证可能长得不像凭证），这个不会漏 —— 它比的是我们
  // 确实持有的值。命中时这一行被替换而不是原样写出：日志是终端回滚、
  // 进程管理器日志与 bug 报告的共同来源，一行泄漏会同时进这三处。
  const log: LogSink = (line) => {
    if (withheld.targets.some((secret) => secret.length > 0 && line.includes(secret))) {
      withheld.count += 1;
      rawLog('启动日志有一行被拦截：它包含了本进程持有的凭证。这一行按设计不出现在日志里。');
      return;
    }
    rawLog(line);
  };

  try {
    // 横幅**第一行**打：启动失败时它是操作者唯一能看到的版本信息，
    // 而「你跑的是哪个版本」是排障的第一个问题。
    log(`Local Workspace Bridge daemon ${DAEMON_VERSION}（本地 IPC ${IPC_PROTOCOL_VERSION}），正在启动。`);

    // ---- 1. 参数 ----
    const startup = parseStartupOptions(options.argv, options.env);
    const snapshotMaxBytes = snapshotStoreMaxBytesFromEnvironment(
      options.env['LWB_SNAPSHOT_STORE_MAX_BYTES'],
    );

    // ---- 2. 受保护根 ----
    const { layout, overridden } = resolveStoreLayout(startup.home_override);

    // ---- 3. Windows 助手 ----
    const helper = new SecureStoreHelper();
    await helper.start();
    if (!helper.isAvailable()) {
      // 没有 DPAPI 与 ACL，凭证就只能以明文落盘。那不是一个「稍后修复」的
      // 状态，因此在这里停住，而不是先跑起来。
      throw new StartupFailed(
        'startup_failed',
        `Windows 保护机制不可用（${helper.unavailableReason() ?? '未知原因'}）；拒绝以明文方式启动。`,
      );
    }
    stack.push('Windows 助手', () => helper.stop());

    // ---- 4. 当前用户 SID ----
    const identity = await helper.whoami();
    if (!identity.ok) {
      throw new StartupFailed('startup_failed', `无法确定当前用户身份：${identity.message}`);
    }
    const userSid = identity.data.user_sid;

    // ---- 5. 单实例互斥（在创建任何状态之前）----
    const lock = await acquireSingleInstance({
      userSid,
      // acquireSingleInstance 自己识别固定停止命令；不匹配的连接直接关闭。
      onConnection: (socket) => socket.end(),
    });
    if (lock.kind === 'occupied') {
      throw new StartupFailed('already_running', lock.reason);
    }
    stack.push('单实例互斥', () => releaseSingleInstance(lock.server));

    // ---- 6. 加固受保护根 ----
    const hardened: HardenedStore = await hardenStore(helper, layout.root, STORE_SUBDIRECTORIES);
    if (hardened.current_user_sid !== userSid) {
      // 互斥量按一个 SID 抢的、DACL 按另一个 SID 设的 —— 这两件事必须
      // 是同一个人。正常路径上不可能发生；写下来是因为它的失效方式是
      // 「互斥量保护的是一个账户、存储属于另一个账户」，而那种错配
      // 在功能上完全看不出来。
      throw new StartupFailed(
        'startup_failed',
        '受保护根的实测所有者与当前进程身份不一致；拒绝启动。',
      );
    }

    // ---- 7. 凭证 ----
    const credentials = new CredentialStore({ credentialsDirectory: layout.credentials, helper });
    const runtimeKeys = await loadRuntimeKeys(credentials);
    const ipcSecrets = await loadIpcSecrets(credentials);
    withheld.targets = [runtimeKeys.value.ticket_key, ...Object.values(ipcSecrets.value)];
    log(
      `凭证就绪：运行时密钥${runtimeKeys.created ? '（本次新建）' : ''}、` +
        `IPC 密钥${ipcSecrets.created ? '（本次新建）' : ''}。指纹只用于核对，不作为凭证。`,
    );

    // ---- 8. 升级前快照与状态库 ----
    const migrationBackup = await backupDatabaseBeforeMigration(layout.databaseFile);
    if (migrationBackup !== null) {
      log(
        `状态库将从 schema v${String(migrationBackup.from_version)} 升至 v${String(migrationBackup.to_version)}；` +
          `已验证迁移前快照 ${migrationBackup.file_name}。`,
      );
    }
    const opened = openDatabase({ path: layout.databaseFile });
    stack.push('状态库', () => closeDatabase(opened.db));
    const repos = new Repositories(opened.db);

    // ---- 9. 模型侧连接行 ----
    const connection = ensureAdapterConnection(repos);
    log(
      `模型侧连接 ${connection.record.id}（${connection.created ? '本次登记' : '已登记'}，` +
        `当前${connection.record.enabled ? '已启用' : '**停用**'}）。`,
    );

    // ---- 10. 原生护栏 ----
    const guard = getWinfsBackend();
    stack.push('原生护栏', () => disposeWinfsBackend());
    const capability: WinfsCapability = await guard.ensureStarted();
    if (!capability.available) {
      // 护栏不可用时**不能**用空数组替代受保护对象身份：那会让
      // 「这个根是不是凭证目录」这条判定静默失效（`collectProtectedRefs` 的契约）。
      // 而少一次身份判定，就可能把一个凭证目录登记成工作区。
      throw new StartupFailed(
        'startup_failed',
        `文件系统护栏不可用（${capability.resolved_backend_reason}）；拒绝在身份判定缺失的情况下启动。`,
      );
    }

    // ---- 11. 受保护对象身份 ----
    const protectedRefs = await collectProtectedRefs({
      probe: guard,
      paths: protectedStorePaths(layout),
    });

    // ---- 12. 启动恢复扫描 ----
    //
    // 快照库先建起来：恢复要读基线字节，而它读的是**同一个** BlobStore
    // （见 LWB-030 步骤 2）。**它碰的不是用户工作区**：`objects` 目录在受保护根
    // 之内，而受保护根整棵子树都登记在 `protected_refs` 里（见
    // `protectedStorePaths`），因此模型没有、也不可能有一个指向它的工作区（I13）。
    //
    // 临时目录用默认值（`<root>\tmp`）：它与 `objects` 同卷，改名才是原子的，
    // 而且它是受保护根的子目录，会**继承**加固时设下的 DACL
    // （`Op-Harden` 给根设的规则带 `ContainerInherit|ObjectInherit`）。
    // 它不在 `STORE_SUBDIRECTORIES` 里，因此加固时不预先创建 ——
    // 第一次写快照时按需建立，ACL 由继承得到。
    const blobs = new BlobStore({
      objectsRoot: layout.objects,
      registry: repos.blobs,
      maxBytes: snapshotMaxBytes,
    });
    log(`快照对象存储字节上限：${String(snapshotMaxBytes)}。`);

    const recovery = new RecoveryService({
      repos,
      ops: guard,
      blobs,
      now: Date.now,
      newId: () => newLocalId('rec'),
      log,
    });
    // **先处理未终结操作，再开放写能力。** 这一行与下面 `createToolSurface`
    // 的先后顺序就是 LWB-030 步骤 1 的全部实现 —— 见文件头的第 12 步说明。
    const sweepReport = await recovery.sweepStartup();

    // ---- 12.1 启动快照保留与回收（LWB-038）----
    // 单实例锁已持有、恢复扫描已完成、数据管道尚未开放：此刻不会有新的
    // 工具操作与回收并发。逐 blob 的保护仍由权威状态表重新计算，待恢复与
    // 撤销窗口内的唯一快照不会被这次启动清理删除。
    const startupCleanupAt = new Date().toISOString();
    const sweep = sweepExpired(repos, { now: startupCleanupAt });
    const temporaryBlobs = await blobs.sweepTempFiles();
    try {
      const garbage = await collectSnapshotGarbage(
        repos,
        blobs,
        { now: startupCleanupAt },
        { isSafeToCollect: () => true },
      );
      if (garbage.refused) {
        log('启动快照回收被安全判据拒绝；本轮没有删除快照对象。');
      } else {
        log(
          `启动快照维护完成：回收 ${String(garbage.collected.length)} 个已过保留期对象，` +
            `保留或跳过 ${String(garbage.skipped.length)} 个仍被引用的对象；` +
            `清理 ${String(temporaryBlobs.length)} 个崩溃遗留临时文件。`,
        );
      }
    } catch {
      // 仅回收 pending_gc 且 refcount 为零的快照；失败不影响工作区文件，
      // 留给下次启动重试，且不把本机对象路径写入普通日志。
      log('启动快照回收未能完成；相关待回收对象保留供下次启动重试。');
    }

    // ---- 12.2 定期快照维护（LWB-038）----
    // 周期性处理运行期间过期的修改集与待回收快照。GC 的全局前提同时
    // 检查活动执行与待恢复工作区；逐对象保留仍由 snapshotGuard 复算。
    // 不周期清理 `.tmp`：活动 prepare 可能正在写同卷临时文件；临时文件只在
    // 启动恢复、数据管道开放之前清理。
    const snapshotMaintenance = startSnapshotMaintenanceLoop({
      run: async () => {
        const now = new Date().toISOString();
        const expired = sweepExpired(repos, { now });
        const noActiveOrRecovery = (): boolean =>
          repos.operations.listByStates(['QUEUED', 'VALIDATING', 'APPLYING', 'RECOVERY_REQUIRED']).length === 0 &&
          !repos.workspaces.list().some((workspace) => recovery.requiresRecovery(workspace));
        const garbage = await collectSnapshotGarbage(
          repos,
          blobs,
          { now },
          { isSafeToCollect: noActiveOrRecovery },
        );
        if (garbage.refused) {
          log(
            `定期快照回收暂缓：过期修改集 ${String(expired.expired_changes.length)}，` +
              '存在执行或恢复中的操作；下个周期重试。',
          );
        } else {
          log(
            `定期快照维护完成：过期修改集 ${String(expired.expired_changes.length)}，` +
              `回收 ${String(garbage.collected.length)} 个快照对象；保留或跳过 ${String(garbage.skipped.length)} 个。`,
          );
        }
      },
      onError: () => log('定期快照维护未完成；未确认的快照保留供下个周期重试。'),
    });
    stack.push('定期快照维护', () => snapshotMaintenance.stop());

    // ---- 12a. 全局暂停（LWB-034）----
    //
    // 它必须**早于**协调器建立：协调器的 `stop` 选项拿的是它的信号源
    // （`() => pause.stopSignal()`），而那个函数在每一次执行开始时才被调用。
    //
    // 为什么是一个**取信号的函数**而不是信号本身，写在 `ExecutionCoordinatorOptions.stop`
    // 的注释里 —— 一句话：`release()` 会换一个新控制器，收一个固定信号的话，
    // 「停用 → 恢复 → 再停用」的第二轮会挂在一个早已中止的信号上。
    //
    // 它在这里同样**不会自己跑起来**：没有定时器、没有后台循环。构造它
    // 只做一件事 —— 读一次状态库，让内存里的中止信号与库里那一行对齐
    // （上一轮进程在停用期间死掉、这一轮重启，正是那一格）。因此一次
    // 普通启动不会因为多了这个对象而改写任何一行。
    const pause = new PauseService({
      repos,
      on_notice: (notice) => {
        log(`暂停处理失败（${notice.kind}）：${notice.detail}`);
      },
    });

    // ---- 12b. 执行协调器（LWB-032）----
    //
    // 「谁能写、谁先写」的那一半。它与上面那个恢复服务是**两件事**：
    // 恢复处理「上一次写落到了哪」，协调器处理「这一次由谁写」。
    //
    // 它在这里**不会自己跑起来** —— 没有后台循环，因此启动一个协调器
    // 不产生任何写入。它今天唯一的入口是工具面的 `change_apply`；能否
    // 作用于某根，由本地控制台保存的逐工作区 `propose` grant 决定。
    //
    // 写盘的人用 `createNativeApplier`（LWB-027 ~ LWB-029），
    // 探测上一个写手还活着没有用 `createProcessProbe` —— 两者都是
    // 生产实现，不是替身。
    const coordinator = new ExecutionCoordinator({
      repos,
      apply: createNativeApplier({ repos, ops: guard, blobs }),
      probe: createProcessProbe(),
      // 紧急停用的那根线（LWB-034 步骤 2）。协调器在中止被触发时**不**
      // 自己判断结果：它照旧走那条「没有报告 ⇒ 待恢复」的路，由写盘人
      // 在安全边界上如实报出「一个字节都没动」还是「写到一半」。
      stop: () => pause.stopSignal(),
      on_notice: (notice) => {
        log(`执行协调器：${notice.kind}（操作 ${notice.operation_id}）—— ${notice.detail}`);
      },
    });

    // ---- 13. 登记表、工具面、控制操作 ----
    const environment = resolveWorkspaceEnvironment({
      store_root: layout.root,
      protected_refs: protectedRefs,
    });
    const registry = new WorkspaceRegistry({ repos, probe: guard, environment });

    const operations = new OperationRegistry();
    const facts: ToolSurfaceFacts = {
      server_version: DAEMON_VERSION,
      protocol_version: IPC_PROTOCOL_VERSION,
      gates: BRIDGE_GATES,
      // 这两个都是**函数**，不是字段（LWB-034 关掉的那条偏差）。
      // 原先这里写的是 `paused: false` 加一句「全局暂停今天没有状态源」——
      // 那句话在当时是真的，而它变成假的那一刻不会有任何东西报错。
      // 改成函数之后，「每次问都去读库」是结构上的事实：工具面的守卫
      // 在第 1 步与第 5 步各问一次，而它拿到的不可能是某个启动时刻的快照。
      paused: () => pause.isPaused(),
      pause_status: () => pause.status(),
    };

    // 出站预算**只建一个**，与并发闸门同一条理由（`tools/index.ts` 里
    // 关于「每个工具各持一份闸门」的那段说明）：两份预算各自计量，
    // 于是「本机每小时最多出站 N 字节」变成「模型 N + 控制台 N」。
    //
    // 它在工具面与复核读取之间共用，而**不是**共用同一个连接键：
    // 控制台会话按 `console:<session_id>` 记账（见 control/changes.ts），
    // 与任何一条模型连接的额度互不侵占 —— 共用一个键会让一次翻页
    // 把模型的读取额度吃掉，而那个故障在界面上完全看不出来。
    const budgets = new EgressBudgetStore({
      limit_bytes_per_hour: LIMITS.EGRESS_BYTES_PER_HOUR,
      now: Date.now,
    });

    const commandProcesses = new CommandProcessManager();
    stack.push('工作区命令进程', () => commandProcesses.terminateAll());

    const surface = createToolSurface({
      repos,
      registry,
      blobs,
      budgets,
      // 外部验收状态只作 bridge_status 诊断；每个操作的真实权限由工作区 grant 决定。
      // `recovery_required` 是**逐工作区**的，而它取的是刚刚跑完的那次扫描
      // 的结论（`requiresRecovery` 每次现查状态库与写槽，不缓存 —— 恢复
      // 记录会在 daemon 运行期间被操作者处理掉，一个缓存会让「处理完了」
      // 直到下次重启才生效）。
      capability_flags: capabilityFlagsWith((workspace) =>
        recovery.requiresRecovery(workspace),
      ),
      now: Date.now,
      ops: guard,
      coordinator,
      command_processes: commandProcesses,
      // 等待预算用默认值（15 秒，见 `DEFAULT_APPLY_WAIT_MS`）：它的依据是
      // IPC 服务端 30 秒的请求上限，而那个数字是**传输层的事实**，
      // 不是本机策略，因此不在这里另配一个。
      apply_options: {
        on_notice: (notice) => {
          // 预算到点之后那次执行仍然抛了，而已经没人在等它。
          // 报出来 —— 一句没人读的失败与「什么也没发生」在日志里长得一样。
          log(`应用调用已放弃等待，但执行随后失败（修改集 ${notice.change_id}）：${notice.detail}`);
        },
      },
      authority: createReadTicketAuthority({ key: runtimeKeys.value.ticket_key }),
      // 单调读数，供搜索的时间预算用；**不是**「现在几点」。
      clock: () => performance.now(),
      status: () => facts,
      operations,
    });

    registerWorkspaceOperations(operations, registry);
    registerWorkspaceAccessOperations(operations, {
      repos,
      model_connection_id: ADAPTER_CONNECTION_ID,
    });
    registerConnectionOperations(operations, { repos });
    registerApprovalOperations(operations, { repos });
    // 复核读取（LWB-036）。三处依赖都是**上面那一个**实例：
    // 能力开关与工具面共用同一个 `capabilityFlagsWith(...)`，出站预算
    // 共用同一个 `EgressBudgetStore`。控制台与模型因此不可能对
    // 「这个工作区现在能不能读」给出两个答案 —— 它们问的是同一个函数。
    registerChangeOperations(operations, {
      repos,
      blobs,
      budgets,
      capability_flags: capabilityFlagsWith((workspace) =>
        recovery.requiresRecovery(workspace),
      ),
    });
    registerRecoveryOperations(operations, { repos, recovery, blobs });
    registerHistoryOperations(operations, { repos });
    // 紧急停用（LWB-034）。它拿到的是上面**那一个** `PauseService` 实例 ——
    // 控制操作与协调器共用同一个中止信号，因此「按了停用」与「在途写入
    // 停下来」之间没有第二条路径可以走偏。
    registerPauseOperations(operations, { repos, pause });

    // ---- 14. 控制平面 ----
    const sessions = new ControlSessionStore({ port: startup.control_port });
    const plane = createControlPlane({
      operations,
      sessions,
      ...(options.static_assets === undefined ? {} : { static_assets: options.static_assets }),
      port: startup.control_port,
      onEvent: (event) => logControlEvent(event, log),
      status: () => ({
        version: DAEMON_VERSION,
        protocol_version: IPC_PROTOCOL_VERSION,
        gates: BRIDGE_GATES,
        capability_flags: capabilityFlagsFrom(),
        // 控制台看到的是**同一份**推导（第三个参数同样是暂停的报告）：
        // 一个被紧急停用的服务，如果只有模型那一侧被告诉「停着」，
        // 而操作者面前的控制台还写着「运行中」，那这次停用就只做了一半。
        limitations: limitationsOf(capabilityFlagsFrom(), BRIDGE_GATES, pause.status()),
        workspaces: repos.workspaces.list().length,
        connections: repos.connections.list().length,
        // 「当前是哪台机器」必须由**持有这台机器的那一侧**回答。
        //
        // LWB-035 的验收标准 1 要求非技术用户能知道「当前哪台机器」，而
        // 控制台那一侧只有一个浏览器环境：它可以读 `navigator`，但那是
        // **浏览器所在**的机器，与「本机服务跑在哪台机器上」是两个问题
        // （控制台将来可能被从另一台机器上打开）。让界面去猜，或者拿
        // 浏览器的事实冒名顶替，都会得到一个看起来像结论的错答案。
        //
        // 这个投影只走控制平面（本机回环 + 会话 + CSRF），**不进**
        // `bridge_status`：模型可见的那一份由 `tool-outputs.ts` 的
        // `strictObject` 逐字段声明，没有机器身份这一项，也不会因为这里
        // 多了一个字段而被动多出去。主机名不是凭证，但它确实是对一台
        // 机器的标识，因此按「只给需要它的那一侧」处理。
        machine: { hostname: hostname(), os: platform(), arch: arch() },
      }),
    });
    const address = await plane.server.listen();
    stack.push('控制平面', () => plane.server.close());

    // ---- 15. 数据管道 ----
    const pipe = await startDataPipe({
      userSid,
      secrets: ipcSecrets.value,
      operations,
      // 握手问的是「认不认识这个名字」；「这条连接是否启用、类型是否与通道
      // 相符」是每一次请求都要重新走的另一条链（`tools/access.ts`）。
      isRegisteredConnection: (id) => repos.connections.findById(id) !== null,
      onEvent: (event) => logSessionEvent(event, log),
    });
    stack.push('数据管道', () => pipe.close());

    // ---- 16. 启动时清理 ----
    // ---- 17. 启动令牌 ----
    const bootstrap = sessions.mintBootstrap();

    const runtimeFacts: StartupFacts = {
      version: DAEMON_VERSION,
      protocol_version: IPC_PROTOCOL_VERSION,
      store_root: layout.root,
      store_root_overridden: overridden,
      gates: BRIDGE_GATES,
      capability_flags: capabilityFlagsFrom(),
      guard: { backend: capability.backend, reason: capability.resolved_backend_reason },
      pipe_name: pipe.described_name,
      control_origin: address.origin,
      workspaces: repos.workspaces.list().length,
      connections: repos.connections.list().length,
      grants: countGrants(repos),
      // 报**注册表里全部**的操作，而不是工具面那一部分：装配根的一大职责
      // 就是「谁被注册了」，而一条只报工具操作的日志会让控制操作
      // （workspaces.register 之类）在日志里不存在 —— 而它们确实存在。
      operations: [...operations.names()].sort(),
      tool_operations: surface.operations.length,
      sweep: {
        expired_changes: sweep.expired_changes.length,
        expired_approvals: sweep.expired_approvals,
        expired_recovery_authorizations: sweep.expired_recovery_authorizations,
      },
      recovery: {
        leftovers: sweepReport.leftovers,
        reconciled: sweepReport.reconciled.length,
        awaiting_manual: sweepReport.awaiting_manual.length,
        undecidable: sweepReport.undecidable.length,
        // 现查，而不是拿 `sweepReport` 的数字相加：这里问的是「扫描结束
        // **之后**」的状态，而扫描本身刚刚可能把某个工作区的写槽解开了
        // （`#liftBlockade`），也可能把一个操作留在了待恢复。两个数字
        // 相近但不同，而这一格要回答的是「工具面此刻会拒绝谁」。
        workspaces_flagged: recovery.workspacesAwaitingRecovery().length,
      },
      credentials: {
        runtime_created: runtimeKeys.created,
        ipc_created: ipcSecrets.created,
      },
      withheld_log_lines: withheld.count,
    };

    printStartup(runtimeFacts, bootstrap.url, log);

    return {
      options: startup,
      facts: runtimeFacts,
      bootstrap_url: bootstrap.url,
      control: plane.server,
      pipe,
      repos,
      sessions,
      recovery,
      stop_requested: lock.stop_requested,
      mcpAdapterEnvironment: () => ({
        LWB_IPC_PIPE: pipe.pipe_name,
        LWB_IPC_SECRET_MCP_ADAPTER: ipcSecrets.value['mcp-adapter'],
        LWB_CONNECTION_ID: ADAPTER_CONNECTION_ID,
        LWB_ADAPTER_VERSION: DAEMON_VERSION,
      }),
      shutdown: () => stack.unwind(log),
    };
  } catch (error) {
    await stack.unwind(log);
    if (error instanceof StartupFailed) throw error;
    throw new StartupFailed(
      'startup_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

// ---------------------------------------------------------------------------
// 上面用到的小件
// ---------------------------------------------------------------------------

/**
 * 确保模型侧那条连接行存在。**新建时默认停用。**
 *
 * 「已登记」与「已启用」是两件事，而这里刻意只做前一件：
 * `connections.enabled` 的默认值是 false（`CreateConnectionInput` 的注释：
 * 授权必须由本地操作者显式打开），而本函数**不覆盖**已有行的 enabled ——
 * 一个「每次启动都把连接重新启用」的装配根，会让操作者的停用决定
 * 活不过一次重启，而那正是停用存在的理由（LWB-018 步骤 3）。
 *
 * 复用的是查询而不是 `INSERT OR IGNORE`：后者在**已存在但已停用**时
 * 与「已存在且启用」返回同样的结果，而这两者需要的日志文案不同 ——
 * 而启动日志正是操作者判断「我上次停用它了吗」的地方。
 */
function ensureAdapterConnection(repos: Repositories): {
  readonly record: { readonly id: string; readonly enabled: boolean };
  readonly created: boolean;
} {
  const existing = repos.connections.findById(ADAPTER_CONNECTION_ID);
  if (existing !== null) {
    return { record: { id: existing.id, enabled: existing.enabled }, created: false };
  }
  const created = repos.connections.create({
    id: ADAPTER_CONNECTION_ID,
    principal_kind: 'model_surface',
    principal_id: ADAPTER_PRINCIPAL_ID,
    alias: ADAPTER_CONNECTION_ALIAS,
    // 显式写 false，而不是靠默认值：这一行是**安全语义**，读代码的人
    // 不该需要去翻 `CreateConnectionInput` 才能确认它是不是停用的。
    enabled: false,
  });
  return { record: { id: created.id, enabled: created.enabled }, created: true };
}

/**
 * 授权行总数。
 *
 * `GrantsRepo` 只有 `listByConnection`（授权行天然是按连接问的），
 * 因此这里逐连接求和，而不是去加一个 `listAll` —— 后者会成为又一条
 * 「谁都能调的全表查询」，而它的第一个调用方就是这个只为了打一行日志的地方。
 *
 * **覆盖面**：它数的是「已登记连接名下的授权行」。一个其连接行已被删除的
 * 授权行会被漏掉 —— 而那种行今天不可能存在（没有任何接口删除连接行）。
 * 写下来是为了将来有人加删除接口时看得见这里。
 */
function countGrants(repos: Repositories): number {
  let total = 0;
  for (const connection of repos.connections.list()) {
    total += repos.grants.listByConnection(connection.id).length;
  }
  return total;
}

function logControlEvent(event: ControlEvent, log: LogSink): void {
  // **不打印** `request_rejected` 的 detail：那一项来自请求本身，
  // 而请求里可能有令牌（`POST /api/session` 的体就是一张启动令牌）。
  switch (event.type) {
    case 'session_established':
      log(`控制台会话建立：${event.session_id}。`);
      return;
    case 'session_rejected':
      log(`控制台会话被拒绝（${event.reason}）。`);
      return;
    case 'session_revoked':
      log(`控制台会话撤销：${event.session_id}。`);
      return;
    case 'csrf_rejected':
      // CSRF 失败**没有**理由字段：原因只可能是「头部缺失或不匹配」，
      // 而把两者的区别说出来等于告诉调用方他离成功有多近。
      log(`控制台请求被拒绝：csrf ${event.path}（会话 ${event.session_id}）。`);
      return;
    case 'nonce_rejected':
      log(`控制台请求被拒绝：nonce ${event.path}（${event.reason}）。`);
      return;
    case 'request_rejected':
      log(`控制台请求被拒绝：${event.reason} ${event.path}。`);
      return;
    case 'operation_failed':
      log(`控制操作失败：${event.path}（${event.code}）。`);
      return;
    case 'listening':
    case 'bootstrap_minted':
    case 'closed':
      // 这三件事由启动日志与退出流程自己说，重复一遍只会让日志更长。
      return;
  }
}

function logSessionEvent(event: SessionEvent, log: LogSink): void {
  switch (event.type) {
    case 'handshake_ok':
      log(`本机连接握手成功：audience=${event.audience} connection=${event.connection_id}。`);
      return;
    case 'handshake_failed':
      log(`本机连接握手失败：${event.code}（${event.reason}）`);
      return;
    case 'capability_denied':
      log(`能力拒绝：audience=${event.audience} operation=${event.operation}。`);
      return;
    case 'unknown_operation':
      log(`未知操作：${event.operation}。`);
      return;
    case 'timeout':
      log(`操作超时（结果未知）：${event.operation} ${event.request_id}。`);
      return;
    case 'protocol_error':
      log(`协议错误：${event.reason}`);
      return;
    case 'closed':
      // 对端消失是常态（适配器退出、控制台关掉），不进日志。
      return;
  }
}

/**
 * 打印启动摘要。**这一份是整个进程里唯一一处「把所有事实一次说清」的输出。**
 *
 * 它的读者是排障操作者：先说控制台地址与 IPC 管道，再说连接、工作区和
 * grant 数量、daemon 能力状态以及仍未完成的外部验收。
 */
function printStartup(
  facts: StartupFacts,
  bootstrapUrl: string,
  log: LogSink,
): void {
  log(`受保护存储根：${facts.store_root}${facts.store_root_overridden ? '（**已被覆盖**，不是用户的受保护目录）' : ''}`);
  log(`控制台地址：${bootstrapUrl}`);
  log(`数据管道：${facts.pipe_name}`);
  log(
    `已注册操作：工具面 ${String(facts.tool_operations)} 个、控制面 ` +
      `${String(facts.operations.length - facts.tool_operations)} 个。`,
  );
  log(`模型侧连接：${String(facts.connections)} 条；已登记工作区：${String(facts.workspaces)} 个；授权行：${String(facts.grants)} 条。`);
  if (facts.grants === 0) {
    log('提示：尚未为任何工作区授予 ChatGPT 工具权限；控制台状态与工作区清单仍可使用。');
  }
  log(`原生护栏：${facts.guard.backend} —— ${facts.guard.reason}`);
  log('daemon 支持的全局能力（具体目录访问仍由 workspace grant 控制）：');
  for (const [name, value] of Object.entries(facts.capability_flags)) {
    log(`  ${name} = ${String(value)}`);
  }
  for (const limitation of limitationsOf(facts.capability_flags, facts.gates)) {
    log(`  限制：${limitation}`);
  }
  log(
    `启动清理：过期批准 ${String(facts.sweep.expired_approvals)} 条、过期修改集 ` +
      `${String(facts.sweep.expired_changes)} 个、过期恢复授权 ` +
      `${String(facts.sweep.expired_recovery_authorizations)} 条。`,
  );
  printRecovery(facts, log);
  if (facts.withheld_log_lines > 0) {
    // 出现它就是一个必须修的缺陷，因此说得直白。
    log(`**启动日志有 ${String(facts.withheld_log_lines)} 行因含凭证被拦下**：这是一处缺陷，请报告。`);
  }
}

/**
 * 启动恢复那一段。**四种数字各有各的读法**，所以分四句说，不合成一句
 * 「恢复了 N 个」—— 那个数字会把「自动定案了」与「等着你处理」加在一起，
 * 而这两件事对操作者的要求正好相反（一个是别管，一个是去管）。
 *
 * 全零时也要打一行：`未终结操作 0 个` 是一条**结论**（这次启动是干净的），
 * 而「什么都没有打印」读起来像「这一步没跑」。
 */
function printRecovery(facts: StartupFacts, log: LogSink): void {
  const { recovery } = facts;
  log(
    `启动恢复：未终结操作 ${String(recovery.leftovers)} 个（已标为待恢复，未重放）；` +
      `自动定案 ${String(recovery.reconciled)} 个；留待人工 ${String(recovery.awaiting_manual)} 个；` +
      `判定不成 ${String(recovery.undecidable)} 个。`,
  );
  if (recovery.awaiting_manual > 0) {
    log(
      `提示：有 ${String(recovery.awaiting_manual)} 个操作需要**人工恢复**（内容已被改过、` +
        '或对象身份对不上）。本流程不会覆盖它们，请按 docs/recovery-playbook.md 处理。',
    );
  }
  if (recovery.undecidable > 0) {
    log(
      `提示：有 ${String(recovery.undecidable)} 个操作连判定都没做成（护栏或快照不可用）。` +
        '这些现场**一个字都没有改**，重跑一次或人工核验。',
    );
  }
  if (recovery.workspaces_flagged > 0) {
    log(
      `**写能力仍关闭**：${String(recovery.workspaces_flagged)} 个工作区带着未处理的恢复记录，` +
        '它们的 `recovery_required` 为真 —— 这是设计如此，不是故障。',
    );
  }
}
