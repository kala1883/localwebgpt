/**
 * 工具面测试的公用装置（LWB-017）。
 *
 * ## 与 `tests/search/harness.ts` 的分工
 *
 * 那一份桩的是**护栏**（`WinfsOps`）与策略判定，供**单个包**的测试用。
 * 这一份在它之上再桩两件只有装配层才需要的东西：
 *
 *  - **状态库**（连接、工作区、授权行）—— 真实 `better-sqlite3` 内存库，
 *    不是 Map。理由：工具面的授权链要**穿过**这些表（授权行 → 工作区行 →
 *    登记表），用 Map 假装它们等于把被测的顺序逻辑换成桩自己的顺序。
 *  - **登记表**（`WorkspaceRegistry`）—— 真实实现 + 可换的探测器。`authorizeAccess`
 *    每次都会重新探测根身份，而「每次重新探测」正是这条链上的一环，
 *    桩掉它会让「根被换掉」这件事在测试里不存在。
 *
 * 桩只回答事实，判定一律留给被测代码 —— 与搜索装置同一条原则。
 *
 * `ops` 与 `probe` 可以一起换成真实护栏后端（`tests/windows/` 与证据脚本
 * 需要「真实身份、真实句柄」的场合）：那时登记、复核、读取三段用的都是
 * 同一个真实来源。两者必须**同时**为真，理由见 `ToolHarnessOptions.probe`。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BridgeError, isErr, isOk } from '@lwb/contracts';
import type { Envelope, ErrEnvelope } from '@lwb/contracts';
import { BlobStore } from '@lwb/blob-store';
import { EgressBudgetStore } from '@lwb/egress';
import { ExecutionCoordinator, createNativeApplier, PauseService } from '@lwb/executor';
import { createReadTicketAuthority } from '@lwb/files';
import type { ConcurrencyGate } from '@lwb/limits';
import type { RequestContext } from '@lwb/ipc';
import { OperationRegistry, createProcessProbe } from '@lwb/ipc';
import {
  Repositories,
  closeDatabase,
  openDatabase,
  type OpenDatabaseResult,
  type WorkspaceRecord,
} from '@lwb/persistence';
import type { WinfsError, WinfsOps, WinfsVolumeInfo } from '@lwb/winfs';
import {
  WorkspaceRegistry,
  ancestorPaths,
  parseAbsoluteRoot,
  rootKey,
  type RootFacts,
  type RootProbe,
  type WorkspaceEnvironment,
} from '@lwb/workspaces';

import { capabilityFlagsWith } from '../../apps/daemon/src/gates.ts';
import { CommandProcessManager } from '../../apps/daemon/src/lifecycle/command-processes.ts';
import type { PlatformGates } from '../../apps/daemon/src/gates.ts';
import { createToolSurface } from '../../apps/daemon/src/tools/index.ts';
import type { ToolHandlerDeps, ToolLimits, ToolSurfaceFacts } from '../../apps/daemon/src/tools/index.ts';
import { makeOps, treeOf, type NodeSpec } from '../search/harness.ts';

export const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
export const KEY = 'lwb-tools-test-key-0123456789abcdef0123';
export const ADAPTER_CONNECTION = 'conn-adapter';
export const OTHER_CONNECTION = 'conn-other';

/** 测试环境：受保护存储根与主目录都在 `C:\LWBTEST` 下，因此业务路径不与之相交。 */
export const TOOL_TEST_ENV: WorkspaceEnvironment = {
  store_root: 'C:\\LWBTEST\\store',
  home_directory: 'C:\\LWBTEST\\home',
  extra_broad_probes: [],
  protected_refs: [],
  policy_version: 7,
};

export const DIRECTORY_ROOT = 'C:\\LWBTEST\\work\\proj';
export const FILE_ROOT = 'C:\\LWBTEST\\work\\notes\\todo.md';

/** 外部验收状态：默认未签署；它不再关闭任何操作能力。 */
export const GATES_OFF: PlatformGates = {
  g0_platform_verified: false,
  native_guard_verified: false,
  compatibility_section3_passed: false,
  g4_concurrency_fault_passed: false,
};
/** 所有验收事实设为 true 的状态页装置，仅用于测试展示/诊断。 */
export const GATES_ON: PlatformGates = {
  g0_platform_verified: true,
  native_guard_verified: true,
  compatibility_section3_passed: true,
  g4_concurrency_fault_passed: true,
};

/** 把 RootFacts 补成原生层返回的完整结构（登记表只读其中一部分字段）。 */
export function asVolumeInfo(f: RootFacts): WinfsVolumeInfo {
  return {
    ok: true,
    ...f,
    drive_type: f.drive_type as WinfsVolumeInfo['drive_type'],
    file_system_flags: 0,
    volume_label: null,
    max_component_length: 255,
    recall_on_open: false,
    recall_on_data_access: false,
  };
}

/**
 * 桩探测：按路径返回预设的根身份。
 *
 * **必须回答整条祖先链**，不只是根自己：`WorkspaceRegistry.#collectFacts`
 * 会逐级向上探测（驱动器根形态、重解析点、云占位都可能在祖先上）。
 * 只备了根的那一份会让登记在「祖先探测」这一步失败，
 * 而错误信息指向的却是根 —— 那种失败很难看出是桩没配全。
 */
export class FakeProbe {
  readonly calls: string[] = [];
  readonly #byPath = new Map<string, RootFacts>();

  constructor(entries: readonly RootFacts[]) {
    for (const entry of entries) this.#byPath.set(rootKey(entry.path), entry);
  }

  /** 覆盖某条路径的事实（构造「根被换掉」这类用例）。 */
  set(entry: RootFacts): void {
    this.#byPath.set(rootKey(entry.path), entry);
  }

  async statVolume(req: { path: string }): Promise<WinfsVolumeInfo | WinfsError> {
    this.calls.push(req.path);
    const hit = this.#byPath.get(rootKey(req.path));
    if (hit === undefined) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: `桩：未预设路径 ${req.path}`,
        win32_error: 2,
      };
    }
    return asVolumeInfo(hit);
  }
}

/**
 * 路径 → 一个稳定的、**逐路径不同**的文件索引。
 *
 * 为什么不给所有路径一个常量：`WorkspaceRegistry` 登记时除了比对路径字符串，
 * 还会拿候选根的**祖先链身份**与在册工作区比对（`screen.ts` 的
 * `overlapsWithExisting` 第三段）。如果桩让每个祖先都报同一个 `file_id`，
 * 第二个工作区的祖先链里必然有一个与第一个工作区的根同身份 ——
 * 登记会被判成 `WRITABLE_ROOT_OVERLAP`，而那是桩自己造出来的，不是被测代码的。
 *
 * 按 `rootKey` 派生（小写、去尾分隔符）而不是按原样字符串：Windows 上
 * 同一个目录的两种大小写写法必须得到同一个身份，否则这个桩会放过
 * 「同一个物理对象被登记两次」。
 *
 * 与夹具桩的 `fileIdOf` 不是一回事：那一个派生的是**真实磁盘路径**的身份，
 * 必须与它自己 `stat` 出来的结果一致；这一个只服务于本文件的假事实。
 */
export function fileIdOfPath(path: string): string {
  return createHash('sha256').update(rootKey(path), 'utf8').digest('hex').slice(0, 16);
}

export function directoryFacts(path: string, over: Partial<RootFacts> = {}): RootFacts {
  return {
    path,
    volume_id: 'c6e22015',
    file_id: fileIdOfPath(path),
    drive_type: 'fixed',
    file_system: 'NTFS',
    is_cloud_placeholder: false,
    is_reparse: false,
    is_directory: true,
    link_count: 1,
    volume_info_available: true,
    ...over,
  };
}

export function fileFacts(path: string, over: Partial<RootFacts> = {}): RootFacts {
  return directoryFacts(path, { is_directory: false, ...over });
}

/** 一个候选根 + 它的整条祖先链。 */
export function chainFor(root: string, over: Partial<RootFacts> = {}): RootFacts[] {
  const parsed = parseAbsoluteRoot(root);
  if (!parsed.ok) throw new Error(`测试根不合法：${parsed.detail}`);
  const out: RootFacts[] = [directoryFacts(parsed.normalized, over)];
  for (const ancestor of ancestorPaths(parsed.normalized)) {
    out.push(directoryFacts(ancestor));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

export interface ToolHarnessOptions {
  /** 工作区根类型。`file` 时根的相对路径是空串，见 `targetPath`。 */
  readonly kind?: 'directory' | 'file';
  /** 树（相对路径 → 节点）。供列举/读取/搜索/Git 用。 */
  readonly tree?: Readonly<Record<string, NodeSpec>>;
  /** 覆盖工作区根（配合 `ops` 用真实目录）。 */
  readonly root?: string;
  readonly other_root?: string;
  /** 覆盖后端。省略即用内存树桩。 */
  readonly ops?: WinfsOps;
  /**
   * 覆盖探测器。省略即用 `FakeProbe`（本文件默认，事实由 `root_file_id`
   * 与路径派生）。
   *
   * 传真实护栏后端时**必须一起传**：否则登记时记下的是桩编的身份，
   * 而每次调用护栏都会拿那个身份去核对真实对象，得到的是
   * 「根被换掉」—— 那是装置自己的锅。
   *
   * 后端与探测器同时为真时，`root_file_id` / `root_volume_id` 不再有意义
   * （身份由探测器当场问出来）。
   */
  readonly probe?: RootProbe;
  /** 根的物理身份。**必须与 `ops` 认的那个一致**，否则登记表会判定「根被换掉」。 */
  readonly root_file_id?: string;
  /**
   * 覆盖登记环境（受保护存储根、主目录、额外广域探针）。
   *
   * 省略即 `TOOL_TEST_ENV`（全部落在 `C:\LWBTEST\` 下，与桩路径不冲突）。
   * 接**真实护栏后端**时要一并给：那时根是真的临时目录，而
   * `TOOL_TEST_ENV` 里那两个 `C:\LWBTEST\` 路径是桩时代的产物 ——
   * 它们恰好不会被真实根命中，于是这条错配不会失败，只会让
   * 「受保护存储根不可被登记为工作区」这条判定在真实用例里**没被验到**。
   */
  readonly environment?: WorkspaceEnvironment;
  /**
   * 外部验收状态，仅供 bridge_status / diagnostics 展示。给函数时每次读取都会刷新；
   * 它不决定能力开关，也不替代 per-workspace grants。
   */
  readonly gates?: PlatformGates | (() => PlatformGates);
  /** 每工作区的恢复置位。默认全 false。 */
  readonly recovery?: (workspace: WorkspaceRecord) => boolean;
  readonly limits?: ToolLimits;
  /** 单调搜索时钟；生产/性能装置应传入随真实耗时推进的时钟。 */
  readonly search_clock?: () => number;
  /** 工具操作的时间来源；与 `search_clock` 同轴时可测实际墙钟预算。 */
  readonly now?: () => number;
  /**
   * 每连接每小时出站字节上限（LWB-018）。省略即生产初值。
   *
   * 之所以要能注入：`EgressBudgetStore` 的上限在**构造时**固定，没有
   * 「改小一点」的办法；而「额度用完之后工具面怎么回答」这条路径
   * 只有在额度真的用完时才会被走到（读 64 MiB 去碰它不现实）。
   */
  readonly egress_bytes_per_hour?: number;
  /**
   * 覆盖并发闸门（LWB-018）。
   *
   * 省略即由 `createToolSurface` 按生效限额建一个 —— 那正是生产路径，
   * 因此默认装置里跑的也是真闸门。要构造「额度已满」的用例时必须注入：
   * 否则用例得先并发跑满 4 个位置，而那会把「满了之后怎么回答」
   * 这件事埋在装置细节里。
   */
  readonly concurrency?: ConcurrencyGate;
  /**
   * 全局暂停。给一个函数时**每次调用都会重新问它**。
   *
   * 为什么允许可变：「先正常地准备好一条已批准的修改集、再暂停、
   * 再点应用」是 LWB-032 验收 1 的形状：批准必须发生在暂停之前，
   * 否则那一刻根本没有已批准的修改集可谈。写死不动的 `true`
   * 造不出那个顺序。
   *
   * ## 省略时的默认值（LWB-034 之后变了）
   *
   * 从前它是恒 `false` 的，因为暂停「没有状态库里的行」。
   * 现在**有了**（`service_pause`，迁移 v8），因此省略时这里问的是
   * **真实的 `PauseService`** —— 于是「真的按一次紧急停用」在装置里
   * 是可达的（`harness.pause.engage()`），而不是只能靠这个开关假造。
   *
   * 保留这个覆盖仍然有用：`engage()` 会顺带作废全部排队授权，
   * 而有些用例要的只是「暂停为真」这**一个**事实，不想要那一步的副作用。
   * 覆盖因此是「只改这一个读数」，不是「假装按过一次按钮」——
   * 两者的差别，在用例读 `pause_status` 时看得出来（见下面
   * `pause_status` 那一段的说明）。
   */
  readonly paused?: boolean | (() => boolean);
  /**
   * 覆盖暂停服务的**读**那一侧（`isPaused` / `status`）。
   *
   * 只覆盖读，不覆盖 `engage()` / `release()` —— 交回给用例的
   * `harness.pause` 永远是那个真实实现，理由见它的说明。
   *
   * 之所以允许覆盖：装置要能构造「暂停状态读不出来、而前像读得出来」
   * 这一格（LWB-034 之后「把库关掉」构造不出它了 —— 那时最先失败的
   * 正是暂停那一格）。用一个不碰库的桩把这**一个**读数固定住，
   * 比让用例去把库弄坏再挑失败顺序要好。
   */
  readonly pause_source?: PauseSource;
  readonly server_version?: string;
  readonly build_id?: string;
  readonly protocol_version?: string;
  /**
   * 覆盖快照库。省略即按需建一个真实对象目录（临时目录）。
   *
   * 之所以能覆盖：**空目录本身就是一个用例**。`change_get` 遇到
   * 「快照被清掉了」时会拒绝返回差异而不是返回一份空差异，
   * 而构造那个状态最直接的办法就是给一个指不到字节的对象目录 ——
   * 否则用例要先建立修改集、再去删快照，而那会把「拒绝」这件事
   * 埋在两步的时序里。
   */
  readonly blobs?: BlobStore;
  /** Per-harness physical snapshot quota for storage-pressure regressions. */
  readonly blob_store_max_bytes?: number;
  /**
   * 覆盖执行协调器（LWB-032）。
   *
   * 省略即建一个**真的**：真 `createNativeApplier`（写盘走本装置那份
   * `ops`，默认为内存树桩）、真 `createProcessProbe`。因此工具面里的
   * 应用与别处跑的是同一批代码，而不是一个「测试专用的应用」——
   * 后者恰好会在最需要被验的那几格（超时、重复调用、被阻断）上说好话。
   *
   * 要构造「上一个写手还活着 ⇒ 工作区被阻断」那一类用例时注入一个
   * 自己回答的探针，而不是改这个默认值：默认值越接近生产越好。
   *
   * 也可以给一个**工厂**：协调器要用本装置那份真实 `ops` / `blobs`
   * 才能建出真的应用器，而那两样只有装置自己拿得到。工厂因此收
   * 一个 `CoordinatorParts`，用法是「拿它包一层，再交给协调器」——
   * LWB-032 的「写盘卡在半路」那一格就是这么造的：它要的是**同一个**
   * `createNativeApplier`，只是在它前面加一道闸，而不是另一个应用器。
   */
  readonly coordinator?:
    | ExecutionCoordinator
    | ((parts: CoordinatorParts) => ExecutionCoordinator);
  /**
   * 应用调用的等待预算与异常出口（LWB-032）。
   *
   * 省略即默认预算（15 秒）与静默。给 `wait_ms: 0` 是为了构造
   * 「本次没能等到结论」那一格 —— 那条路径在生产里要等 15 秒才看得到，
   * 而它恰恰是「模型不该宣称文件已保存」的唯一依据。
   */
  readonly apply_options?: ToolHandlerDeps['apply_options'];
}

/**
 * 建一个协调器所需要的三样东西。**只有装置自己拿得到。**
 *
 * 分开成一个类型而不是把 `ops` / `blobs` 也做成装置选项：那两样在装置里
 * 已经各有一个「生产是什么就用什么」的默认值，再开一个口子只会让
 * 「本用例用了哪个护栏后端」变成两处可写的地方。
 */
/**
 * 暂停服务在装置里的**读**那一侧。
 *
 * 写成 `Pick<…>` 而不是手抄两个方法签名：真实实现改了签名，这里会跟着变，
 * 而一个手抄的接口不会 —— 它会安静地留在原地，直到某天有人照着它写一个桩。
 * 单独起名字是因为它确实是一个独立的东西：桩只需要满足它，
 * 而「暂停」的完整能力（`engage` / `release`）不在其中。
 */
export type PauseSource = Pick<PauseService, 'isPaused' | 'status'>;

export interface CoordinatorParts {
  readonly repos: Repositories;
  readonly ops: WinfsOps;
  readonly blobs: BlobStore;
  /**
   * 协调器那口钟（锚在 `NOW` 上、真实在走，见 `makeToolHarness` 里那段）。
   *
   * **属于这里，而不是可选项。** 工厂造出来的协调器与默认那个必须在
   * 同一根时间轴上：协调器自己会重判批准与修改集的有效期，而那两只表
   * 是工具面那口钟（恒为 `NOW`）盖的章。工厂若忘了传 `now`，协调器就退回
   * 真实当下 —— 于是同一个用例里「默认协调器能过、工厂协调器过期」，
   * 而失败会落在「批准已过期」上，与被测的东西毫无关系。
   * 把它做成必填，忘传是一处编译错误而不是一次难查的红。
   */
  readonly now: () => number;
  /**
   * 紧急停用的停止源（LWB-034）。**与 `now` 同一条理由，也同一条修法。**
   *
   * 工厂造出来的协调器与默认那个必须听**同一只**停止信号：否则一个用例
   * 可以「用工厂协调器跑、按真实的紧急停用」，而那次执行根本不听 ——
   * 界面说已暂停，写盘人一直写下去。这是 LWB-034 三个验收里最要紧的一条，
   * 而它恰恰只在工厂那条路上会被漏掉。
   */
  readonly stop: () => AbortSignal;
}

export interface ToolHarness {
  readonly opened: OpenDatabaseResult;
  readonly repos: Repositories;
  readonly registry: WorkspaceRegistry;
  /**
   * 快照库。**唯一的真实磁盘**：状态库是内存库、工作区树是桩，
   * 而 `change_prepare` / `change_get` 要真的把字节落进一个对象目录
   * 再读回来。用临时目录而不是桩：快照库的关键性质（按内容寻址、
   * 落盘后校验、原子改名）恰恰在桩里不存在。
   *
   * `close()` 会连同临时目录一起删掉。
   */
  readonly blobs: BlobStore;
  /**
   * 登记与每次调用复核所用的探测器。默认实现是 `FakeProbe`，
   * 经由 `options.probe` 换成真实后端时这里就是那个后端 ——
   * 因此类型是 `RootProbe` 而不是 `FakeProbe`。
   */
  readonly probe: RootProbe;
  /**
   * 执行协调器。与 `deps.coordinator` 是**同一个对象** —— 这里也交出来
   * 是因为测试要能在工具调用**之外**推进它（`runOnce` / `drain`），
   * 用来构造「同一条修改集先被别处执行过」这一格。
   */
  readonly coordinator: ExecutionCoordinator;
  /**
   * 全局暂停服务（LWB-034）。与装配根一样，**一个装置一个实例**，
   * 且工具面读的就是它 —— 因此 `engage()` 之后紧接着的每一次工具调用
   * 都会看到暂停，不需要用例再改任何开关。
   *
   * 它**永远**是真实实现，即使 `options.pause_source` 换掉了读那一侧：
   * 那个选项只改「工具面看到什么」，不改「按按钮会发生什么」。
   * 两件事混在一个开关里，会让某天一个用例以为自己按过按钮。
   */
  readonly pause: PauseService;
  /**
   * 协调器那口钟：`NOW` 起算，逐真实毫秒推进。
   *
   * 用例**必须**用它给批准/排队盖章（`approveChange` / `approveAndQueue`
   * 的 `now`）。用 `NOW` 会让批准在执行前那次复核里判成过期，用真实当下
   * 会让修改集判成过期 —— 两只表都对不上第三只。理由写在
   * `makeToolHarness` 里那段「协调器的钟」。
   */
  readonly now: () => number;
  readonly deps: ToolHandlerDeps;
  readonly operations: OperationRegistry;
  readonly workspace: WorkspaceRecord;
  /** 第二个工作区（只读授权给 `OTHER_CONNECTION`），用于跨连接隔离用例。 */
  readonly otherWorkspace: WorkspaceRecord;
  contextFor(connectionId: string, requestId?: string): RequestContext;
  adapterContext(requestId?: string): RequestContext;
  ops(): WinfsOps;
  /** 授权行内容，供「同连接、不同能力」的用例改写。 */
  grant(connectionId: string, workspaceId: string, capabilities: readonly string[]): void;
  close(): void;
}

/**
 * 建一个装配好的工具面。
 *
 * 两个连接、两个工作区，授权是**交叉缺失**的：
 * 适配器连接只被授权 `ws-a`，另一个连接只被授权 `ws-b`。
 * 这样「两条配置不同的连接不能读取对方工作区」在装置里就是默认状态，
 * 而不是需要额外构造的用例。
 */
export async function makeToolHarness(options: ToolHarnessOptions = {}): Promise<ToolHarness> {
  const kind = options.kind ?? 'directory';
  const opened = openDatabase({ path: ':memory:' });
  const repos = new Repositories(opened.db);

  const adapterRoot = options.root ?? (kind === 'file' ? FILE_ROOT : DIRECTORY_ROOT);
  const otherRoot = options.other_root ?? 'C:\\LWBTEST\\work\\other';
  // 默认与 `directoryFacts` 派生的一致（而不是写死一个常量）：
  // 写死会让「探测到的根身份」与「登记时记下的」来自两个不同的规则。
  const adapterFileId = options.root_file_id ?? fileIdOfPath(adapterRoot);

  const probe: RootProbe =
    options.probe ??
    new FakeProbe([
      ...chainFor(adapterRoot, { is_directory: kind === 'directory', file_id: adapterFileId }),
      ...chainFor(otherRoot),
    ]);

  let newIdCounter = 0;
  const registry = new WorkspaceRegistry({
    repos,
    probe,
    environment: options.environment ?? TOOL_TEST_ENV,
    newId: () => `ws_${String(++newIdCounter).padStart(4, '0')}`,
  });

  repos.connections.create({
    id: ADAPTER_CONNECTION,
    principal_kind: 'model_surface',
    principal_id: 'principal-adapter',
    alias: 'ChatGPT 网页',
    enabled: true,
  });
  repos.connections.create({
    id: OTHER_CONNECTION,
    principal_kind: 'model_surface',
    principal_id: 'principal-other',
    alias: '另一条连接',
    enabled: true,
  });

  const workspace = await registry.register({
    alias: '项目',
    kind,
    path: adapterRoot,
    mode: 'read_propose_apply_with_local_approval',
    // 登记只允许来自本地控制台 —— 装置也走真实登记路径，
    // 这样工作区行是**被校验过的**，而不是手写进去的。
    origin: 'local_console',
  });
  const otherWorkspace = await registry.register({
    alias: '另一个项目',
    kind: 'directory',
    path: otherRoot,
    mode: 'read_propose_apply_with_local_approval',
    origin: 'local_console',
  });

  const capabilities = ['read', 'list', 'search', 'git_read', 'propose', 'command_exec'];
  repos.grants.put({
    id: 'grant-adapter',
    connection_id: ADAPTER_CONNECTION,
    workspace_id: workspace.id,
    capabilities,
  });
  repos.grants.put({
    id: 'grant-other',
    connection_id: OTHER_CONNECTION,
    workspace_id: otherWorkspace.id,
    capabilities,
  });

  const stub = makeOps(treeOfSafe(options.tree));
  const ops = options.ops ?? stub.ops;
  const gatesSource = options.gates ?? GATES_OFF;
  const currentGates = (): PlatformGates =>
    typeof gatesSource === 'function' ? gatesSource() : gatesSource;
  const gates = currentGates();

  // 这口钟：**锚在 `NOW` 上，但真的在走**。
  //
  // 两半都不能少，理由各是一条真实的失败：
  //
  //  - **必须会走。** 这里的时钟读的是「租约还在不在」
  //    （`slot-rules.ts` 第 5 步 `now_ms < Date.parse(expires_at)`）。
  //    一口不走的钟会让租约**永不失效**，于是「租约过期之后才去探进程」
  //    那条分支在装置里根本到不了 —— 而它正是「不产生第二次写」的判据之一。
  //  - **必须锚在 `NOW` 上。** 协调器自己也做有效期判定：`claimForExecution`
  //    会重判批准与修改集的有效期（方案 §9.3 的「执行开始时再次校验」）。
  //    而修改集与批准的 `expires_at` 是**工具面那口钟**（恒为 `NOW`）盖的章。
  //    用真实当下（2026 年）去看 2026-01-01 盖的章，每一次应用都会在
  //    「修改集已超过有效期」上被拒 —— 而那不是被测代码的错，是装置
  //    让两个组件读了两只对不上的表。
  //
  // 锚定之后两条路读的是同一根时间轴：`NOW` 起算，逐真实毫秒推进。
  // 装置把它交给用例（`ToolHarness.now`），用例据此给自己的批准盖章。
  //
  // 它有三个读者，而且**必须**是同一个值：协调器（`now`）、用例
  // （`harness.now`，用来给批准盖章）、以及 `PauseService`（`now`，用它
  // 判定「这条批准过期没有」）。第三个读者是后加的，理由与前两个一样：
  // 让 `engage()` 自己去读 `new Date()` 的话，它会拿真实当下去看一张
  // 2026-01-01 的表，于是每一次紧急停用都把批准判成「早就过期了」——
  // 而真正发生的事是「有人按了停用」。
  const clockOrigin = Date.now();
  const anchoredNow = (): number => NOW + (Date.now() - clockOrigin);

  // 暂停：允许是一个每次重新求值的来源（理由见 `ToolHarnessOptions.paused`）。
  //
  // 省略时落到**真实实现**上。装置里没有一个「假的状态源」是刻意的：
  // `guard.ts` 与 `applyChange` 读的都是 `isPaused()`，让它去读状态库
  // 意味着用例可以真的按一次紧急停用，而这条路径在装置之外的每一处
  // 也都是这么走的。
  //
  // 那口钟要显式传进去：`engage()` 会拿它的 `now` 去和 `approvals.expires_at`
  // 比大小，而批准是**工具面那口钟**（`NOW` 锚定）盖的章。不传的话这里比的是
  // 真实当下对 2026-01-01，于是每一次暂停都把批准判成「早就过期了」，
  // 而真实的读者看到的是「有人按了停用」—— 两件事，而审计里只能留一条。
  const pauseService = new PauseService({ repos, now: () => new Date(anchoredNow()).toISOString() });
  const pauseReading: PauseSource = options.pause_source ?? pauseService;
  const pausedSource: boolean | (() => boolean) | undefined = options.paused;
  const isPaused = (): boolean => {
    if (pausedSource === undefined) return pauseReading.isPaused();
    return typeof pausedSource === 'function' ? pausedSource() : pausedSource;
  };

  const facts: ToolSurfaceFacts = {
    server_version: options.server_version ?? '0.1.0-test',
    build_id: options.build_id ?? 'test-build-id',
    protocol_version: options.protocol_version ?? 'lwb-ipc-v1',
    gates,
    paused: isPaused,
    pause_status: () => {
      const status = pauseReading.status();
      const paused = isPaused();
      return {
        ...status,
        paused,
        // 被覆盖成 `true` 而库里并没有那一行时，`paused_at` 只能是 `null`：
        // 装置不替一次假的暂停编一个时刻。真实的暂停两个字段一起来。
        paused_at: paused ? status.paused_at : null,
      };
    },
  };

  const objectsRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb-tools-objects-'));
  const blobs = options.blobs ?? new BlobStore({
    objectsRoot,
    registry: repos.blobs,
    ...(options.blob_store_max_bytes === undefined ? {} : { maxBytes: options.blob_store_max_bytes }),
  });
  const toolNow = options.now ?? (() => NOW);

  // 写盘的人是真 `createNativeApplier`，探活的人是 `createProcessProbe`
  // —— 两者都是装配根会用的那一个（`apps/daemon/src/runtime/assembly.ts`），
  // 因此这里没有「测试专用的应用路径」。
  const defaultCoordinator = (): ExecutionCoordinator =>
    new ExecutionCoordinator({
      repos,
      probe: createProcessProbe(),
      apply: createNativeApplier({ repos, ops, blobs }),
      holder: { pid: process.pid, started_at: new Date(NOW - 60_000).toISOString() },
      now: anchoredNow,
      // 紧急停用那条线（LWB-034）。装配根也是这么接的，而且**必须**这么接：
      // 省略它的话，装置里按下的紧急停用止不住任何一次在途写入 ——
      // 而「按了停用、写盘人还在写」正是这一格最坏的读数。
      // 默认装置要与生产读同一组事实，否则 `harness.pause.engage()`
      // 在用例里看着像按过按钮，实际只是改了一个没人问的读数。
      stop: () => pauseService.stopSignal(),
    });
  const coordinator =
    options.coordinator === undefined
      ? defaultCoordinator()
      : typeof options.coordinator === 'function'
        ? options.coordinator({ repos, ops, blobs, now: anchoredNow, stop: () => pauseService.stopSignal() })
        : options.coordinator;

  const commandProcesses = new CommandProcessManager();
  const deps: ToolHandlerDeps = {
    repos,
    registry,
    blobs,
    budgets: new EgressBudgetStore({
      limit_bytes_per_hour: options.egress_bytes_per_hour ?? 64 * 1024 * 1024,
      now: toolNow,
    }),
    // 每次现读 verification status 与逐工作区 recovery 状态；verification status
    // 只用于诊断，能力是否可调用由 grant 决定。
    capability_flags: (workspace) =>
      capabilityFlagsWith(options.recovery ?? (() => false))(workspace),
    now: toolNow,
    ops,
    coordinator,
    command_processes: commandProcesses,
    ...(options.apply_options === undefined ? {} : { apply_options: options.apply_options }),
    authority: createReadTicketAuthority({ key: KEY }),
    clock: options.search_clock ?? toolNow,
    // 每次重新问一遍暂停与验收状态：`facts` 本身是构造时那一份快照，
    // 而这两个都是**当下**的读数（`guard.ts` 第 1 步、`bridge_status`）。
    status: () => ({ ...facts, gates: currentGates() }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  };

  const operations = new OperationRegistry();
  createToolSurface({ ...deps, operations });

  return {
    opened,
    repos,
    registry,
    blobs,
    probe,
    coordinator,
    pause: pauseService,
    now: anchoredNow,
    deps,
    operations,
    workspace,
    otherWorkspace,
    contextFor(connectionId, requestId) {
      return {
        audience: 'mcp-adapter',
        connection_id: connectionId,
        pid: 4242,
        request_id: requestId ?? 'req_1',
      };
    },
    adapterContext(requestId) {
      return {
        audience: 'mcp-adapter',
        connection_id: ADAPTER_CONNECTION,
        pid: 4242,
        request_id: requestId ?? 'req_1',
      };
    },
    ops: () => ops,
    grant(connectionId, workspaceId, caps) {
      repos.grants.put({
        id: `grant-${connectionId}-${workspaceId}`,
        connection_id: connectionId,
        workspace_id: workspaceId,
        capabilities: caps,
      });
    },
    close() {
      closeDatabase(opened.db);
      // 删临时目录。**同步**删，不是发一个不管的 promise：`close()` 的
      // 调用点都在 `after()` 里，一个还没跑完的清理会与下一次 `mkdtemp`
      // 抢同一个前缀，也会在进程退出时留下残留。
      //
      // `maxRetries` 是给 Windows 的：杀毒/索引服务会对刚写完的文件持
      // 短暂的句柄，一次 EBUSY 不该让收尾变红。`force` 同理 ——
      // 用例有权把对象目录搬空或搬走。
      rmSync(objectsRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}

function treeOfSafe(entries: Readonly<Record<string, NodeSpec>> | undefined): Map<string, NodeSpec> {
  // 树为空时至少放一个无关文件：一个完全空的桩会让「什么都没读到」
  // 与「桩没配好」长得一样，而这两种情况在断言里必须能分开。
  // 树的构造直接复用搜索装置的 `treeOf`（自动补中间目录），不另写一份。
  return treeOf(entries ?? { 'README.md': { content: '# hello\n' } });
}

// ---------------------------------------------------------------------------
// 断言助手
// ---------------------------------------------------------------------------

/**
 * 从工具信封里取出数据，失败时把错误码带进断言消息。
 *
 * 用 `isOk` 而不是 `assert.fail` 做收窄：后者的 `never` 返回类型
 * 是否参与控制流分析取决于声明形态，而这里的收窄必须是**确定的**——
 * 收窄掉的时候，下面那句会变成「从联合上取 data」而不是编译错误。
 */
export function dataOf<T>(envelope: Envelope<T>, hint = ''): T {
  if (!isOk(envelope)) {
    throw new Error(`${hint} 期望成功信封，实际失败：${envelope.error.code} ${envelope.error.message}`);
  }
  return envelope.data;
}

export function errorOf(envelope: Envelope<unknown>, hint = ''): ErrEnvelope {
  if (!isErr(envelope)) throw new Error(`${hint} 期望失败信封，实际成功`);
  return envelope;
}

/**
 * 调用一个工具操作（处理器**返回**信封，不抛异常 —— 这里断言这一点）。
 *
 * `T` 默认 `unknown`，用例写上具体的结果类型只是为了少一次断言内的取值收窄；
 * 类型参数与下面的转型**不构成任何校验** —— 「结果真的是那个形状」由
 * `TOOL_OUTPUT_SCHEMAS` 的解析来证明，而不是由这里的类型参数。
 */
export async function callTool<T = unknown>(
  harness: ToolHarness,
  name: string,
  input: unknown,
  context?: RequestContext,
): Promise<Envelope<T>> {
  const definition = harness.operations.lookup(name);
  assert.ok(definition !== undefined, `操作 ${name} 未注册`);
  const result = await definition.handler(input, context ?? harness.adapterContext());
  assert.ok(
    typeof result === 'object' && result !== null && 'ok' in (result as Record<string, unknown>),
    `操作 ${name} 应返回信封而不是抛出；实际返回 ${typeof result}`,
  );
  return result as Envelope<T>;
}

/** 期望一个 `BridgeError`（用于直接调用不经过信封的函数）。 */
export async function expectBridgeError(
  code: string,
  fn: () => Promise<unknown> | unknown,
  hint = '',
): Promise<BridgeError> {
  try {
    await fn();
  } catch (cause) {
    assert.ok(cause instanceof BridgeError, `${hint} 应抛 BridgeError，实际：${String(cause)}`);
    assert.equal(cause.code, code, `${hint} 的错误码`);
    return cause;
  }
  assert.fail(`${hint} 应当抛出 ${code}，但没有抛错`);
}
