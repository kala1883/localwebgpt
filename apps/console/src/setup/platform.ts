/**
 * 「平台能不能被调用」这一句话怎么算出来（LWB-035 步骤 2 与验收标准 3）。
 *
 * ## 一个灯是不够的，因此这里是四条腿
 *
 * 这条链路上有四个各自会断的地方：本机 daemon、MCP 适配器（模型侧那条
 * 连接）、隧道客户端、以及真实网页账号的验收结论。它们**互不蕴含**：
 * daemon 在跑不代表适配器连着，适配器连着不代表隧道注册成功，
 * 隧道注册成功也不代表网页端真的能发现这些工具（G0 要的正是最后这一条）。
 * 把四件事压成一个「服务正常」的绿灯，是这一页最容易犯、也最贵的错
 * —— 它会让操作者在一个他自己无法察觉的断点上等下去。
 *
 * ## 每一条腿都带一句「这份读数**不能**证明什么」
 *
 * 这是本模块的核心设计。例如适配器那一格的本机读数只到「这条连接在
 * 登记表里是启用的」，而它**不能**证明适配器进程活着 —— 登记表里的一行
 * 与一个进程是两件事。把这句写在界面上，比把那一格涂成绿色有用得多：
 * 操作者据此知道下一个该去看哪里。
 *
 * ## `callable` 要的是**正面证据**，不是「没发现坏消息」
 *
 * 判据是「四条腿里凡是有读数的都正面，且平台侧那条腿**有**读数」。
 * 因此：
 *
 *  - 隧道那一格今天**没有**任何读数（没有任何东西生产 `TunnelReading`，
 *    见下面的 `tunnelLeg`），于是 `callable` 恒为 `false`。
 *  - 这一条不是硬编码的 `false`：`platformVerdict` 是一个纯函数，
 *    喂给它一份「隧道 readyz 通过 + 门禁全过」的读数，它会算出 `true`。
 *    证据脚本里就跑了这一格（`scripts/evidence/lwb-035.ts` §3）——
 *    一份永远算不出 `true` 的判据，与一个写死的 `false` 无法区分。
 *  - 生产装配下 `callable` 为 `false` 的**依据**是门禁常量与
 *    「隧道无读数」两件事，而它们各自都有出处（`gates.ts`、
 *    `docs/evidence/platform-capability.md`）。
 *
 * ## 断网是第四条腿之外的一件事
 *
 * `browser_online` 为假时 `callable` 直接为假，无论其它读数怎么说。
 * 理由：隧道与账号验收都要过网络，而**本机读数反映不出网络状态**
 * —— 页面可能连着一个一切正常的 daemon，同时整台机器的网络已经断了。
 * 这是一个「读数全绿而事实为假」的场景，因此它必须由网络本身来否决。
 */

import type { CapabilityFlags } from '@lwb/contracts';
import {
  DEFAULT_STALE_AFTER_MS,
  describeFreshness,
  freshnessOf,
  type ConnectionRow,
  type Freshness,
  type Gates,
  type MachineIdentity,
  type Reading,
  type StatusReading,
  type TunnelReading,
} from './readings.ts';

/** 四条腿。名字用于渲染与测试，顺序就是链路的顺序。 */
export type LegId = 'daemon' | 'mcp_adapter' | 'tunnel_client' | 'account';

/**
 * 一条腿的状态。
 *
 * 四个值而不是「在线/离线」两个，是因为**「不知道」必须能与「不好」分开**。
 * 一个把无读数渲染成红色的界面，会让人去修一个可能根本没坏的东西；
 * 一个把它渲染成绿色的界面，会让人不去修一个可能已经坏了的东西。
 * 两边的代价都落在操作者身上，因此这里给它一个自己的值。
 */
export type LegState = 'ok' | 'degraded' | 'off' | 'unknown';

export interface LegView {
  readonly id: LegId;
  readonly name: string;
  readonly state: LegState;
  /** 状态短语。**只有 `ok` 一档允许出现「在线」「正常」这类词。** */
  readonly state_label: string;
  /** 一句话结论。 */
  readonly headline: string;
  /** 这份读数**能**证明什么、**不能**证明什么。每一格都必须有。 */
  readonly detail: string;
}

export interface PlatformVerdict {
  /** 平台此刻是否可被调用（网页端能发现并调用这些工具）。 */
  readonly callable: boolean;
  /** 通栏那一句话。**`callable` 为假时不许出现「在线」「正常」。** */
  readonly headline: string;
  /** 为什么不可调用（或：凭什么认为可以）。逐条。 */
  readonly reasons: readonly string[];
  readonly legs: readonly LegView[];
  /** 哪台机器。读不到时是一句「未知」，而不是省略这一行。 */
  readonly machine_line: string;
  readonly machine: MachineIdentity | null;
  readonly daemon_freshness: Freshness;
}

export interface PlatformVerdictInput {
  readonly status: Reading<StatusReading> | null;
  readonly connections: Reading<readonly ConnectionRow[]> | null;
  /** 隧道读数。**今天没有生产者**，因此默认 `null` —— 见文件头。 */
  readonly tunnel?: Reading<TunnelReading> | null;
  /** 判定时刻（由调用方传入，组件不读时钟）。 */
  readonly now: string;
  readonly stale_after_ms?: number;
  /** `navigator.onLine` 的现值。默认按「有网」处理，但它**不参与**得出正面结论。 */
  readonly browser_online?: boolean;
  /** 最近一次读取失败的原因（停机时会有）。 */
  readonly last_error?: { readonly code: string; readonly message: string } | null;
}

/** 机器身份那一行。读不到时说「未知」，不说「本机」——后者像一个结论。 */
export function machineLine(machine: MachineIdentity | null): string {
  if (machine === null) return '当前机器：未知（本机服务没有给出机器读数）';
  return `当前机器：${machine.hostname} · ${machine.os} · ${machine.arch}`;
}

function gateLines(gates: Gates | null): readonly string[] {
  if (gates === null) return ['门禁读数缺失：无法据此判断任何一项是否通过。'];
  const out: string[] = [];
  if (!gates.g0_platform_verified) {
    out.push('G0 完整验收未通过：即使 `bridge_status` / `workspace_list` 能返回，也不代表已验证真实文件读取、测试目录写入回读、身份边界与断连重连。');
  }
  if (!gates.compatibility_section3_passed) {
    out.push('平台兼容性（compatibility §3）未全部验证通过。');
  }
  if (!gates.native_guard_verified) {
    out.push('原生句柄护栏未通过验证。');
  }
  if (!gates.g4_concurrency_fault_passed) {
    out.push('G4（竞争与故障专项测试）未通过。');
  }
  return out;
}

/**
 * 本机服务那一格。
 *
 * 三句话对应三种不同的现实，且**没有一句是「正常」**：
 *  - 没有读数：服务没答话（退出 / 睡眠 / 会话失效 / 页面从没连上过）。
 *  - 读数过期：它**曾经**答过话，但此刻不算数（睡眠唤醒后是典型场景）。
 *  - 读数新鲜：它在运行 —— 仅此而已，下一句就得说平台那一半。
 */
function daemonLeg(input: PlatformVerdictInput, freshness: Freshness): LegView {
  const status = input.status?.value ?? null;
  const base = {
    id: 'daemon' as const,
    name: '本机服务（daemon）',
    detail:
      '这条读数能证明的只有一件事：本机控制 API 刚刚答过话。' +
      '它**不能**证明网页端能调用任何工具 —— 那要另外三条腿一起成立。',
  };

  if (freshness === 'absent') {
    const why =
      input.last_error === null || input.last_error === undefined
        ? '这一页还没有成功读到过本机服务。'
        : `最近一次读取失败：${input.last_error.code} —— ${input.last_error.message}`;
    return {
      ...base,
      state: 'off',
      state_label: '未答话',
      headline: '本机服务没有答话。它可能已退出、正在睡眠，或本页的会话已经失效。',
      detail: `${base.detail} ${why} 请重新运行本地启动命令，见下面的「本地启动」。`,
    };
  }

  if (freshness === 'stale') {
    return {
      ...base,
      state: 'unknown',
      state_label: '读数已过期',
      headline: '本机服务上一次答话已经超时。**这不等于在线**，也不等于已经停止。',
      detail:
        `${base.detail} 读数不会因为时间流逝而变成真的：` +
        '这台机器可能刚从睡眠中醒来，而睡眠期间它没有在服务任何人。请先「重新检测」。',
    };
  }

  const version = status?.version ?? '未知版本';
  return {
    ...base,
    state: 'ok',
    state_label: '在运行',
    headline: `本机服务在运行（${version}）。`,
    detail: base.detail,
  };
}

/**
 * 模型侧那条连接那一格。
 *
 * 判据是「登记表里有没有一条 `model_surface` 的连接，以及它是否启用」。
 * 这条读数的**边界**必须写出来：登记表里的一行不是进程。
 */
function adapterLeg(input: PlatformVerdictInput, freshness: Freshness): LegView {
  const base = {
    id: 'mcp_adapter' as const,
    name: 'MCP 适配器（模型侧连接）',
    detail:
      '本机读数只到「登记表里这条连接是否启用」。它**不能**证明适配器进程活着，' +
      '也不能证明它连上了隧道 —— 那两件事只有隧道那一格谈得上。',
  };

  if (freshness !== 'fresh' || input.connections === null) {
    return {
      ...base,
      state: 'unknown',
      state_label: freshness === 'stale' ? '读数已过期' : '没有读数',
      headline: '读不到连接登记表，因此不知道模型侧那条连接现在是不是启用的。',
      detail: base.detail,
    };
  }

  const rows = input.connections.value.filter((row) => row.principal_kind === 'model_surface');
  if (rows.length === 0) {
    return {
      ...base,
      state: 'off',
      state_label: '未登记',
      headline: '本机没有任何一条模型侧连接被登记：适配器即使启动也握不上手。',
      detail: base.detail,
    };
  }

  const enabled = rows.filter((row) => row.enabled);
  if (enabled.length === 0) {
    return {
      ...base,
      state: 'off',
      state_label: '已停用',
      headline: '模型侧连接已登记但**处于停用**：这条凭证现在调不动工具面。',
      detail: `${base.detail} 恢复它需要你在本机显式操作（这是有意的：停用要活得过一次重启）。`,
    };
  }

  const names = enabled.map((row) => row.alias).join('、');
  const disabled = rows.length - enabled.length;
  return {
    ...base,
    state: disabled > 0 ? 'degraded' : 'ok',
    state_label: disabled > 0 ? '部分启用' : '已启用',
    headline: `已启用的模型侧连接：${names}${disabled > 0 ? `（另有 ${String(disabled)} 条停用）` : ''}。`,
    detail: base.detail,
  };
}

/**
 * 隧道客户端那一格。**今天永远返回 `unknown`**，而这是事实，不是缺陷：
 * 本仓库里没有任何东西生产 `TunnelReading`。
 *
 * 为什么不去补一个：隧道客户端的状态只有它自己知道，而官方给出的发现机制
 * 是它写出的 `url_file`（`docs/evidence/platform-capability.md` §3.1 起，
 * 官方指南原文：并发或洁净运行时把 `listen_addr` 换成 `127.0.0.1:0`
 * 并设置 `url_file`，让另一个进程发现 `/healthz`、`/readyz`、`/metrics`
 * 与 `/ui` 的基地址）。读那个文件、再去探一次 `/readyz`，是**本机另一个
 * 进程**该做的事 —— 不属于控制台这一层，也不属于本任务（它归 LWB-039
 * 的「隧道重连」）。
 *
 * 于是这里的选择只有两个：把这个洞涂绿，或者如实说「没有读数」。
 * 涂绿的代价是操作者会以为隧道是好的，而它今天连 `doctor` 都不过
 * （`control_plane_api_key` FAIL）。
 */
function tunnelLeg(input: PlatformVerdictInput, freshness: Freshness): LegView {
  const base = {
    id: 'tunnel_client' as const,
    name: '隧道客户端（tunnel-client）',
    detail:
      '本机没有隧道健康读数：没有任何本机进程在探它的 `/readyz`。' +
      '因此这一格既不绿也不红 —— 它是一个**没有读数**的格子。',
  };

  const reading = input.tunnel ?? null;
  if (freshness !== 'fresh' || reading === null) {
    return {
      ...base,
      state: 'unknown',
      state_label: freshness === 'stale' ? '读数已过期' : '没有读数',
      headline: '隧道状态未知。**在拿到读数之前，任何「隧道正常」的说法都没有本机证据。**',
      detail:
        `${base.detail} 已核实的阻塞点：` +
        '`tunnel-client doctor` 目前 RESULT=fail（`control_plane_api_key`），' +
        '因此隧道从未成功启动过一次。判定与依据见 `docs/evidence/platform-capability.md`。',
    };
  }

  const value = reading.value;
  if (!value.tunnel_id_configured) {
    return {
      ...base,
      state: 'off',
      state_label: '未配置',
      headline: '隧道配置文件里还没有真的 tunnel_id（仍是模板里的占位值）。',
      detail: base.detail,
    };
  }
  if (!value.readyz) {
    return {
      ...base,
      state: 'off',
      state_label: '未就绪',
      headline: '隧道客户端的 `/readyz` 没有通过：它没有把本机的工具面注册上去。',
      detail: base.detail,
    };
  }
  return {
    ...base,
    state: 'ok',
    state_label: '已就绪',
    headline: '隧道客户端报告就绪。',
    detail: base.detail,
  };
}

/**
 * 账号验收那一格。
 *
 * 它**不是**一条运行期读数，而是一个评审结论（G0）。因此它的读数来源
 * 就是 `gates.g0_platform_verified` 这一位 —— 而那一位今天为假，
 * 依据写在 `docs/evidence/platform-capability.md`（BLOCKED：没有 tunnel_id、
 * 没有 runtime key、单用户访问边界未知）。
 *
 * 把结论与读数分成两类是有后果的：**一个结论不会因为服务重启而变绿**。
 * 界面据此可以如实说「这不是本机现在能自动恢复的东西」。
 */
function accountLeg(input: PlatformVerdictInput): LegView {
  const gates = input.status?.value.gates ?? null;
  const base = {
    id: 'account' as const,
    name: '真实网页账号验收（G0）',
    detail:
      '这是一个**评审结论**，不是运行期读数：它来自一次人在环的验收，' +
      '本机无法自行重新验证。账号不支持写入或隧道不可用时必须明确 BLOCKED。',
  };

  if (gates === null) {
    return {
      ...base,
      state: 'unknown',
      state_label: '没有读数',
      headline: '读不到门禁状态，因此不知道账号验收是否已经通过。',
      detail: base.detail,
    };
  }

  if (!gates.g0_platform_verified) {
    return {
      ...base,
      state: 'off',
      state_label: '未通过',
      headline: '**尚未通过真实网页账号验收**：网页端能否发现并调用本工具面，没有证据。',
      detail:
        `${base.detail} 当前状态是 **BLOCKED**（` +
        '缺 tunnel_id 与运行时密钥，且单用户访问边界只存在于账号设置里）。' +
        'MCP Inspector 的成功不能代替这一步。',
    };
  }

  return {
    ...base,
    state: 'ok',
    state_label: '已通过',
    headline: '真实网页账号验收已通过。',
    detail: base.detail,
  };
}

/**
 * 算出四条腿与那一句结论。
 *
 * 顺序即判据：先看本机答不答话，再看平台侧有没有**正面证据**。
 * 反过来（先算平台侧）会让一个「服务都没在跑」的页面去讨论 G0，
 * 而操作者此刻该做的是先把服务启动起来。
 */
export function platformVerdict(input: PlatformVerdictInput): PlatformVerdict {
  const staleAfter = input.stale_after_ms ?? DEFAULT_STALE_AFTER_MS;
  const daemonFreshness = freshnessOf(input.status, input.now, staleAfter);
  const connectionsFreshness = freshnessOf(input.connections, input.now, staleAfter);
  const tunnelFreshness = freshnessOf(input.tunnel ?? null, input.now, staleAfter);

  const legs: readonly LegView[] = [
    daemonLeg(input, daemonFreshness),
    adapterLeg(input, connectionsFreshness),
    tunnelLeg(input, tunnelFreshness),
    accountLeg(input),
  ];

  const byId = (id: LegId): LegView => {
    const found = legs.find((leg) => leg.id === id);
    // legs 是上面刚写下的四元组，找不到只可能是代码被改坏了。
    if (found === undefined) throw new Error(`内部错误：缺少 ${id} 这一条腿。`);
    return found;
  };

  const gates = input.status?.value.gates ?? null;
  const flags: CapabilityFlags | null = input.status?.value.capability_flags ?? null;

  const reasons: string[] = [];

  // 1. 网络。**这一条排在最前**：断网时下面每一条解释都还成立，
  //    但操作者唯一该做的是把网络接回来。
  const online = input.browser_online !== false;
  if (!online) {
    reasons.push(
      '这台机器的网络已断开。隧道与账号验收都要过网络，因此平台侧此刻一定不可调用。',
    );
  }

  // 2. 本机服务。
  if (daemonFreshness === 'absent') {
    reasons.push('本机服务没有答话，因此它此刻不可能在为任何人服务。');
  } else if (daemonFreshness === 'stale') {
    reasons.push(`本机服务的读数${describeFreshness(daemonFreshness)}，不能作为「在线」的依据。`);
  }

  // 3. 模型侧那条连接：**必须有一条启用的**，否则工具面根本握不上手。
  //
  //    这里直接算「有没有一条启用的模型侧连接」，而不是读
  //    `adapterLeg` 的 `state === 'ok'`：那一格的 `degraded`
  //    （一条启用、另一条停用）同样意味着**能调用**，用状态字符串去判
  //    会把这种情况错判成不可调用 —— 判据要落在事实上，不落在标签上。
  const adapterEnabled =
    connectionsFreshness === 'fresh' &&
    (input.connections?.value ?? []).some(
      (row) => row.principal_kind === 'model_surface' && row.enabled,
    );
  if (!adapterEnabled) {
    reasons.push(
      connectionsFreshness === 'fresh'
        ? '本机没有一条**已启用**的模型侧连接：适配器即使启动也调不动工具面。'
        : '读不到连接登记表，无法证明本机有一条可用的模型侧连接。',
    );
  }

  // 4. 平台侧：必须有一条**正面**的隧道读数。
  const tunnel = byId('tunnel_client');
  if (tunnel.state !== 'ok') {
    reasons.push(
      tunnel.state === 'unknown'
        ? '隧道状态没有本机读数：无法证明本机工具面已经被注册到平台上。'
        : `隧道这一格是「${tunnel.state_label}」。`,
    );
  }

  // 5. 门禁。
  const gateReasons = gateLines(gates);
  reasons.push(...gateReasons);

  if (flags === null) {
    reasons.push('能力开关读数缺失，无法判断本机此刻允许模型做哪些事。');
  }

  const callable =
    online &&
    daemonFreshness === 'fresh' &&
    adapterEnabled &&
    tunnel.state === 'ok' &&
    gates !== null &&
    gates.g0_platform_verified;

  const headline = callable
    ? '平台可调用：网页端应当能发现并调用本机工具面。'
    : '平台**不可调用**。本机服务可能在运行 —— 但「在运行」与「网页端能调用」是两件事。';

  const machine = input.status?.value.machine ?? null;
  const line = machineLine(machine);
  return {
    callable,
    headline,
    reasons,
    legs,
    machine,
    // 机器身份来自那一份读数。读数过期时**照样显示**（机器不会变），
    // 但要跟着一句它出自什么时候 —— 否则页面上会有一行看起来「刚刚取到」
    // 的事实，而同屏的其它格子正说着读数已过期。
    machine_line:
      machine === null || daemonFreshness === 'fresh'
        ? line
        : `${line}（出自${describeFreshness(daemonFreshness)}的那一份读数）`,
    daemon_freshness: daemonFreshness,
  };
}
