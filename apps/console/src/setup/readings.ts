/**
 * 控制台读数（LWB-035 步骤 2 的地基）。
 *
 * ## 这一层只回答一个问题：这份读数**还算不算数**
 *
 * 任务书步骤 2 的后半句是「**不把进程运行等同于平台可调用**」，
 * 验收标准 3 是「**停机/睡眠/断网状态不显示成正常在线**」。这两句话
 * 有一个共同的前提：界面必须能区分「读到一个值」与「这个值仍然有效」。
 * 一个只保存 `StatusReading` 的界面，无论它把那一行渲染成什么颜色，
 * 都答不出「这台机器现在答不答话」—— 因为它手上那一份可能是十分钟前的。
 *
 * 因此这一层是**两个**字段而不是一个：`value` 与 `observed_at`。
 * 任何一处只肯传 `value` 的调用点，都会在这里被类型拦住。
 *
 * ## 解析是显式的，缺字段一律落到 `null`
 *
 * 三个读数都来自控制 API 的 JSON。它们不是完全可信的输入：
 * 页面可能连的是一个**旧版本**的 daemon（升级到一半、两份二进制并存），
 * 也可能是某个中间层（代理壳、Service Worker）改过的响应。
 * 因此每个读数都过一遍 `parse*`，而不是 `as StatusReading` 一把梭。
 *
 * 关键的一条：**缺字段的解析结果是 `null`，不是 `false` 也不是 `true`**。
 * 一个把缺失的门禁读成 `false` 的实现，恰好也会把真实的 `false` 渲染成
 * 同一句话 —— 于是「没有读数」与「读到了未通过」变得无法区分，
 * 而这两件事对操作者的意义完全不同（一个是去查服务，一个是去看证据）。
 * `null` 会被上层渲染成「无读数」，见 `platform.ts`。
 */

import type { CapabilityFlags } from '@lwb/contracts';

export const MODEL_WORKSPACE_CAPABILITIES = ['read', 'list', 'search', 'git_read', 'propose', 'command_exec'] as const;
export type ModelWorkspaceCapability = (typeof MODEL_WORKSPACE_CAPABILITIES)[number];

/**
 * 一份带时刻的读数。
 *
 * `observed_at` 是**控制台拿到它的时刻**（本机时钟，ISO 8601），
 * 不是服务端生成它的时刻。理由：界面要回答的是「我这块屏幕上这句话
 * 还成不成立」，而那个判定只能基于「我上一次问话是什么时候」。
 * 服务端时刻另有用途（诊断里会带上），但它不参与新鲜度判定 ——
 * 那需要两台时钟一致，而本机与它自己的服务之间本来就不需要这个假设。
 */
export interface Reading<T> {
  readonly value: T;
  /** 控制台取到这份读数的时刻（ISO 8601，本机时钟）。 */
  readonly observed_at: string;
}

/**
 * 新鲜度。**只有 `fresh` 才有资格被渲染成一个正面结论。**
 *
 * 与「读数对不对」是两件事：一份 `fresh` 的读数照样可能是
 * 「服务停用中」。这里只回答「它是不是最近问到的」。
 */
export type Freshness = 'fresh' | 'stale' | 'absent';

/**
 * 默认的过期阈值：30 秒。
 *
 * **它是一个显示口径，不是一条策略。** 契约与策略层里没有任何东西依赖
 * 这个数字；它只决定屏幕上那句话是「在运行」还是「读数已过期」。
 * 宿主页面知道自己的轮询节奏（它每隔几秒取一次），因此可以传自己的值；
 * 默认值取三倍于常见的 10 秒节奏：**连着三次没答话就不再算在线**。
 *
 * 这个数字刻意不小（不是 2 秒）：一个把「一次网络抖动」渲染成
 * 「服务掉线了」的界面，会让操作者学会忽略这个提示 —— 而一个被忽略的
 * 掉线提示，等于没有掉线提示。
 */
export const DEFAULT_STALE_AFTER_MS = 30_000;

/**
 * 判定一份读数目前算不算数。
 *
 * 四种输入，**三种都不算 fresh**，而这是刻意的：
 *
 * | 输入 | 结果 | 为什么 |
 * | --- | --- | --- |
 * | 没有读数 | `absent` | 还没问过，或问失败了 |
 * | 时刻解析不出来 | `stale` | 解析不出来就无法证明它新；方向必须是保守的那一边 |
 * | 时刻在未来 | `stale` | 只可能是时钟被动过（休眠唤醒后对时是典型场景），因此**无法**据此断定新鲜 |
 * | 在阈值之内 | `fresh` | 这是唯一一条正面结论 |
 */
export function freshnessOf<T>(
  reading: Reading<T> | null,
  now: string,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): Freshness {
  if (reading === null) return 'absent';
  const observed = Date.parse(reading.observed_at);
  const at = Date.parse(now);
  if (Number.isNaN(observed) || Number.isNaN(at)) return 'stale';
  const age = at - observed;
  // `age < 0`：读数来自未来。休眠唤醒之后系统时钟会被校正，
  // 而校正的方向可能是向后的 —— 于是「刚取到的读数」在时间轴上落到了
  // 后面的位置。此刻我们**不能**说它新，因为无法区分它与一次伪造。
  if (age < 0) return 'stale';
  return age <= staleAfterMs ? 'fresh' : 'stale';
}

/** 把新鲜度翻成一句给操作者看的话。`absent` 与 `stale` **必须**分开说。 */
export function describeFreshness(freshness: Freshness): string {
  switch (freshness) {
    case 'fresh':
      return '刚刚取到';
    case 'stale':
      return '读数已过期';
    case 'absent':
      return '没有读数';
  }
}

// ---------------------------------------------------------------------------
// 读数本体
// ---------------------------------------------------------------------------

/**
 * 机器身份。
 *
 * 它来自 `/api/status`，也就是**本机 daemon 自己报的**，而不是浏览器算的。
 * 浏览器算不出主机名，任何在页面里拼出来的「机器」都只是猜测 ——
 * 而「非技术用户能知道当前哪台机器」（验收标准 1）要的是事实。
 *
 * **刻意不含用户名与 SID**：这一行回答的是「哪台机器」。
 * 用户名回答的是「哪个账户」，它既不能帮操作者认出机器，
 * 又会随着每一次诊断导出流出去（见 `diagnostic.ts`）。
 */
export interface MachineIdentity {
  readonly hostname: string;
  /** 形如 `win32 10.0.26200`。两个字段合成一句，因为没人分开用它们。 */
  readonly os: string;
  readonly arch: string;
}

/**
 * 门禁事实（四格）。
 *
 * 与 `apps/daemon/src/gates.ts` 的 `PlatformGates` **同形但是另一份类型**：
 * 控制台不能 import daemon（两个应用之间没有依赖边），因此这里重复一遍字段名。
 * 重复的风险是漂移，而漂移由一处运行期检查接住：`parseGates` 逐字段解析，
 * 服务端多一个字段、少一个字段都不会静默通过。
 */
export interface Gates {
  readonly g0_platform_verified: boolean;
  readonly native_guard_verified: boolean;
  readonly compatibility_section3_passed: boolean;
  readonly g4_concurrency_fault_passed: boolean;
}

/** `/api/status` 里控制台用得上的那部分。缺失的一律 `null`。 */
export interface StatusReading {
  readonly version: string | null;
  readonly protocol_version: string | null;
  readonly gates: Gates | null;
  readonly capability_flags: CapabilityFlags | null;
  readonly limitations: readonly string[];
  readonly machine: MachineIdentity | null;
  readonly workspaces: number | null;
  readonly connections: number | null;
  readonly routes: readonly string[];
}

/** 连接登记行（`connections.list` 的一条）。 */
export interface ConnectionRow {
  readonly connection_id: string;
  readonly alias: string;
  readonly principal_kind: string;
  readonly enabled: boolean;
  readonly generation: number;
}

/**
 * 工作区登记行（`workspaces.list` 的一条）。
 *
 * `root` 是**本机绝对路径**。它出现在这里是有意的：这一行是给
 * **本地操作者**看的，而「哪些目录正在暴露」这个问题只有绝对路径答得了
 * —— 藏起来会让他无法确认登记的是哪一个目录（`apps/daemon/src/control/workspaces.ts`
 * 的 `describeRecord` 写了同一条理由）。它不会流向模型。
 *
 * 但因此有一条**必须**遵守的规则：任何**会被复制出去**的文本
 * （诊断、导出、日志）都不得直接带上这个对象 —— 见 `diagnostic.ts` 的
 * `toDiagnosticWorkspaces`，那是唯一被允许的转换。
 */
export interface WorkspaceRow {
  readonly workspace_id: string;
  readonly alias: string;
  readonly kind: WorkspaceKind;
  readonly mode: WorkspaceMode;
  readonly root: string;
  readonly generation: number;
  readonly policy_version: number;
  readonly enabled: boolean;
  readonly removed: boolean;
}

/** ChatGPT 网页连接对某个根的逐目录授权；没有记录等同于无权访问。 */
export interface WorkspaceAccessRow {
  readonly workspace_id: string;
  readonly enabled: boolean;
  readonly capabilities: readonly ModelWorkspaceCapability[];
}

/** 工作区类型与模式。与控制面返回的两个闭集同名同值。 */
export type WorkspaceKind = 'directory' | 'file';
export type WorkspaceMode = 'read_only' | 'read_propose_apply_with_local_approval';

/** 正在停的一件写入（`service.pause_status` 的一个条目）。 */
export interface StoppingRow {
  readonly operation_id: string;
  readonly change_id: string;
  readonly workspace_id: string;
  readonly state: string;
  readonly holder_pid: number | null;
  readonly slot_blocked: boolean;
}

/** 还排着队、尚未被作废的授权。 */
export interface PendingRow {
  readonly change_id: string;
  readonly workspace_id: string;
  readonly state: string;
  readonly expires_at: string | null;
}

/** 等着人核验的恢复现场。 */
export interface RecoveryRow {
  readonly operation_id: string;
  readonly change_id: string;
  readonly workspace_id: string;
}

/** `service.pause_status` 的读数。 */
export interface PauseStatusReading {
  readonly paused: boolean;
  readonly paused_at: string | null;
  readonly stopping: readonly StoppingRow[];
  readonly unrevoked_change_sets: readonly PendingRow[];
  readonly recovery_operations: readonly RecoveryRow[];
  readonly unrecallable_file_rows: number;
}

/**
 * 一次 `service.pause` / `service.resume` 的结果。
 *
 * 与 `PauseStatusReading` **分开两个类型**：一个是「此刻什么样」，
 * 一个是「上一次按下去发生了什么」。合成一个的话，「按完之后
 * 废止失败了」这句话会在下一次刷新时被一个干净的状态覆盖掉 ——
 * 而那正是最需要留在屏幕上的那句话。
 */
export interface PauseOutcomeReading {
  readonly already: boolean;
  readonly revoked: readonly { readonly change_id: string; readonly approval_id: string | null }[];
  readonly skipped: readonly { readonly change_id: string; readonly reason: string }[];
  readonly revoke_failed: boolean;
  readonly revoke_message: string | null;
  readonly persist_failed: boolean;
  readonly persist_message: string | null;
  readonly status: PauseStatusReading | null;
}

/** 隧道客户端的读数。**今天没有任何东西生产它**（见 `platform.ts` 的隧道那一格）。 */
export interface TunnelReading {
  /** tunnel-client 自己的 `/readyz` 是否答 200。 */
  readonly readyz: boolean;
  /** 配置文件里的 `tunnel_id` 是不是一个真 id（而不是模板里的 32 个零）。 */
  readonly tunnel_id_configured: boolean;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

function asRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function recordArray(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((item): item is Record<string, unknown> => item !== null);
}

function parseGates(raw: unknown): Gates | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const g0 = bool(record['g0_platform_verified']);
  const native = bool(record['native_guard_verified']);
  const compat = bool(record['compatibility_section3_passed']);
  const g4 = bool(record['g4_concurrency_fault_passed']);
  // 四格缺一不可：缺一格时整份门禁作废（`null`），而不是「那一格当作 false」。
  // 后者的后果是界面会说「G4 未通过」，而实际情况是**这份读数里没有 G4** ——
  // 一句话把「未通过」与「没读到」说成同一件事，正是这一层要防的。
  if (g0 === null || native === null || compat === null || g4 === null) return null;
  return {
    g0_platform_verified: g0,
    native_guard_verified: native,
    compatibility_section3_passed: compat,
    g4_concurrency_fault_passed: g4,
  };
}

function parseCapabilities(raw: unknown): CapabilityFlags | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const read = bool(record['read_enabled']);
  const git = bool(record['git_enabled']);
  const proposal = bool(record['proposal_enabled']);
  const write = bool(record['direct_write_enabled']);
  const recovery = bool(record['recovery_required']);
  if (read === null || git === null || proposal === null || write === null || recovery === null) return null;
  return {
    read_enabled: read,
    git_enabled: git,
    proposal_enabled: proposal,
    direct_write_enabled: write,
    recovery_required: recovery,
  };
}

function parseMachine(raw: unknown): MachineIdentity | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const hostname = str(record['hostname']);
  if (hostname === null) return null;
  return {
    hostname,
    os: str(record['os']) ?? '未知系统',
    arch: str(record['arch']) ?? '未知架构',
  };
}

/** 解析 `/api/status` 的响应体。**任何一处缺失都落到 `null`/空数组，从不猜测。** */
export function parseStatusReading(raw: unknown): StatusReading {
  const record = asRecord(raw) ?? {};
  return {
    version: str(record['version']),
    protocol_version: str(record['protocol_version']),
    gates: parseGates(record['gates']),
    capability_flags: parseCapabilities(record['capability_flags']),
    limitations: strArray(record['limitations']),
    machine: parseMachine(record['machine']),
    workspaces: num(record['workspaces']),
    connections: num(record['connections']),
    routes: strArray(record['routes']),
  };
}

const KINDS: readonly WorkspaceKind[] = ['directory', 'file'];
const MODES: readonly WorkspaceMode[] = ['read_only', 'read_propose_apply_with_local_approval'];

/**
 * 解析 `workspaces.list` 的响应体。
 *
 * **类型与模式不认识的行被丢掉，而不是兜底成 `read_only`。** 兜底的方向
 * 看着安全（只读总是保守的），但它是错的：一个本机不认识的模式被显示成
 * 「只读」，会让操作者以为这个目录不会被写 —— 而实际发生的是
 * 「界面没看懂那一行」。丢掉它，界面上就少一行，而少一行会被看见。
 */
export function parseWorkspaces(raw: unknown): readonly WorkspaceRow[] {
  const out: WorkspaceRow[] = [];
  for (const row of recordArray(raw)) {
    const id = str(row['workspace_id']);
    const root = str(row['root']);
    const kind = str(row['kind']);
    const mode = str(row['mode']);
    if (id === null || root === null) continue;
    if (kind === null || !(KINDS as readonly string[]).includes(kind)) continue;
    if (mode === null || !(MODES as readonly string[]).includes(mode)) continue;
    out.push({
      workspace_id: id,
      alias: str(row['alias']) ?? id,
      kind: kind as WorkspaceKind,
      mode: mode as WorkspaceMode,
      root,
      generation: num(row['generation']) ?? 0,
      policy_version: num(row['policy_version']) ?? 0,
      enabled: bool(row['enabled']) ?? false,
      removed: bool(row['removed']) ?? false,
    });
  }
  return out;
}

/**
 * 解析本地控制面返回的 ChatGPT 工作区授权。
 * 未知字段/能力一律令整份读数无效，避免 UI 把未知的额外权限显示成「无权」。
 */
export function parseWorkspaceAccess(raw: unknown): readonly WorkspaceAccessRow[] | null {
  if (!Array.isArray(raw)) return null;
  const out: WorkspaceAccessRow[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const row = asRecord(value);
    if (row === null) return null;
    const workspaceId = str(row['workspace_id']);
    const enabled = bool(row['enabled']);
    const capabilities = row['capabilities'];
    if (workspaceId === null || enabled === null || !Array.isArray(capabilities)) return null;
    if (seen.has(workspaceId)) return null;
    seen.add(workspaceId);
    if (
      capabilities.some(
        (item) => typeof item !== 'string' || !(MODEL_WORKSPACE_CAPABILITIES as readonly string[]).includes(item),
      )
    ) return null;
    const typed = capabilities as ModelWorkspaceCapability[];
    if (new Set(typed).size !== typed.length || (enabled && typed.length === 0) || (!enabled && typed.length !== 0)) {
      return null;
    }
    out.push({ workspace_id: workspaceId, enabled, capabilities: typed });
  }
  return out;
}

/** 解析 `connections.list` 的响应体。没有别名的行**照样保留**（别名是给人看的）。 */
export function parseConnections(raw: unknown): readonly ConnectionRow[] {
  const record = asRecord(raw);
  const rows = record === null ? [] : recordArray(record['connections']);
  const out: ConnectionRow[] = [];
  for (const row of rows) {
    const id = str(row['connection_id']);
    if (id === null) continue;
    out.push({
      connection_id: id,
      alias: str(row['alias']) ?? id,
      principal_kind: str(row['principal_kind']) ?? 'unknown',
      enabled: bool(row['enabled']) ?? false,
      generation: num(row['generation']) ?? 0,
    });
  }
  return out;
}

function parseStopping(raw: unknown): readonly StoppingRow[] {
  const out: StoppingRow[] = [];
  for (const row of recordArray(raw)) {
    const operationId = str(row['operation_id']);
    if (operationId === null) continue;
    out.push({
      operation_id: operationId,
      change_id: str(row['change_id']) ?? '',
      workspace_id: str(row['workspace_id']) ?? '',
      state: str(row['state']) ?? 'UNKNOWN',
      holder_pid: num(row['holder_pid']),
      slot_blocked: bool(row['slot_blocked']) ?? true,
    });
  }
  return out;
}

function parsePending(raw: unknown): readonly PendingRow[] {
  const out: PendingRow[] = [];
  for (const row of recordArray(raw)) {
    const changeId = str(row['change_id']);
    if (changeId === null) continue;
    out.push({
      change_id: changeId,
      workspace_id: str(row['workspace_id']) ?? '',
      state: str(row['state']) ?? 'UNKNOWN',
      expires_at: str(row['expires_at']),
    });
  }
  return out;
}

function parseRecoveryRows(raw: unknown): readonly RecoveryRow[] {
  const out: RecoveryRow[] = [];
  for (const row of recordArray(raw)) {
    const operationId = str(row['operation_id']);
    if (operationId === null) continue;
    out.push({
      operation_id: operationId,
      change_id: str(row['change_id']) ?? '',
      workspace_id: str(row['workspace_id']) ?? '',
    });
  }
  return out;
}

/** 解析 `service.pause_status`（以及 `service.pause` 结果里的 `status`）。 */
export function parsePauseStatus(raw: unknown): PauseStatusReading | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const paused = bool(record['paused']);
  if (paused === null) return null;
  return {
    paused,
    paused_at: str(record['paused_at']),
    stopping: parseStopping(record['stopping']),
    unrevoked_change_sets: parsePending(record['unrevoked_change_sets']),
    recovery_operations: parseRecoveryRows(record['recovery_operations']),
    // 这一个字段缺失时读成 0（而不是让整份读数作废）。它数的是
    // 「已经交出去、收不回来的内容有几条」，而一条被截断的响应**同时**
    // 会丢掉上面的 `paused` —— 那时整份读数已经是 `null`，
    // 界面不会显示任何一个数。因此这里兜的不是「响应不完整」，
    // 而是「对端是一个还没有这个字段的版本」，而那种情况下
    // 界面对它的说法会带上「本机读数」，见 `pause.ts`。
    unrecallable_file_rows: num(record['unrecallable_file_rows']) ?? 0,
  };
}

/** 解析 `service.pause` / `service.resume` 的结果。 */
export function parsePauseOutcome(raw: unknown): PauseOutcomeReading {
  const record = asRecord(raw) ?? {};
  return {
    already: bool(record['already']) ?? false,
    revoked: recordArray(record['revoked']).map((row) => ({
      change_id: str(row['change_id']) ?? '',
      approval_id: str(row['approval_id']),
    })),
    skipped: recordArray(record['skipped']).map((row) => ({
      change_id: str(row['change_id']) ?? '',
      reason: str(row['reason']) ?? 'UNKNOWN',
    })),
    revoke_failed: bool(record['revoke_failed']) ?? false,
    revoke_message: str(record['revoke_message']),
    persist_failed: bool(record['persist_failed']) ?? false,
    persist_message: str(record['persist_message']),
    status: parsePauseStatus(record['status']),
  };
}

/**
 * 读数的**形状**自检。
 *
 * 用途只有一个：判断「这一份响应是不是本版本的读数」。控制面在版本不匹配、
 * 或某一层把响应换成了别的东西时，`ok: true` 仍然会成立，
 * 而界面会开始显示一片「未知」。这条自检让那种情况能被说出来。
 */
export function looksLikeStatus(raw: unknown): boolean {
  const record = asRecord(raw);
  if (record === null) return false;
  return 'gates' in record || 'capability_flags' in record || 'version' in record;
}
