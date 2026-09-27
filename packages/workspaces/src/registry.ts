/**
 * 工作区登记表（LWB-009）。
 *
 * ## 代次（generation）是这里唯一的失效机制
 *
 * 方案 §5.3 要求：根重定位、重新授权、权限变更后，**全部**旧读取票据、
 * 游标、修改集与批准立即失效。实现这一点有两种思路：
 *
 *  1. 失效时把所有绑定了该工作区的对象逐个改掉。
 *  2. 让每个对象自带它签发时的代次，取用时与当前代次比对。
 *
 * 本工程选 (2)，并且这不是风格偏好：(1) 要求「找得到全部旧对象」，
 * 而票据是**无状态**的（方案 §6 用签名载荷实现，不落库），根本找不到。
 * 因此失效只能靠「当前代次是多少」这一个数字，而它必须在**每一次取用**时
 * 被检查 —— 所以本文件所有对外入口都收一个代次并比对，没有旁路。
 *
 * ## 根身份每次访问都重新探测，不缓存
 *
 * 同名路径被替换为另一个目录后，字符串前缀与登记时完全一样，
 * 只有身份变了。缓存哪怕 1 秒，也会把「已知的不确定」变成
 * 「未知的不确定」——而这一秒足够发生一次写入。实测一次 statVolume
 * 约 1.3ms（docs/evidence/lwb-003），比读一个文件本身便宜得多。
 */

import { BridgeError } from '@lwb/contracts';
import type { WorkspaceKind, WorkspaceMode } from '@lwb/contracts';
import {
  assessBroadDirectory,
  findProtectedIdentityMatch,
  isInsideStore,
  type ProtectedIdentityRef,
} from '@lwb/secure-store';
import type { Repositories, WorkspaceRecord } from '@lwb/persistence';
import type { WinfsVolumeInfo, WinfsError } from '@lwb/winfs';

import { ancestorPaths, lastSegment, parseAbsoluteRoot, rootKey } from './root-path.ts';
import { RootRejectedError, type RootRejection } from './rejections.ts';
import {
  screenRoot,
  validateAlias,
  type ExistingRoot,
  type RootFacts,
  type WorkspaceAdminOrigin,
} from './screen.ts';

// ---------------------------------------------------------------------------
// 依赖形状
// ---------------------------------------------------------------------------

/**
 * 卷/形态探测。`PowerShellWinfsBackend` 在结构上满足它，
 * 因此生产代码直接传后端，测试传一个只会返回预设事实的桩。
 */
export interface RootProbe {
  statVolume(req: { path: string }): Promise<WinfsVolumeInfo | WinfsError>;
}

/**
 * 与具体部署相关的路径事实。
 *
 * 全部**注入**而不是在这里读环境变量：`broadDirectoryProbes()` 会读
 * `USERPROFILE`/`TEMP` 等一串变量，让筛查结果随测试机器的环境变化，
 * 那种测试是测不出东西的。生产入口 `resolveWorkspaceEnvironment()`
 * 负责把环境读一次。
 */
export interface WorkspaceEnvironment {
  /** 受保护存储根（凭证、状态库、快照、日志）。 */
  readonly store_root: string;
  /** 当前用户主目录。 */
  readonly home_directory: string;
  /** 额外视为「过宽」的目录。 */
  readonly extra_broad_probes: readonly string[];
  /** 受保护对象身份，用于按身份（而不只是按路径）拒绝。 */
  readonly protected_refs: readonly ProtectedIdentityRef[];
  /** 当前策略版本；登记与策略变更时写入工作区行。 */
  readonly policy_version: number;
}

export interface WorkspaceRegistryOptions {
  readonly repos: Repositories;
  readonly probe: RootProbe;
  readonly environment: WorkspaceEnvironment;
  /** 新工作区 id 的生成器。默认 `ws_<32 位十六进制>`。 */
  readonly newId?: () => string;
  readonly now?: () => string;
}

// ---------------------------------------------------------------------------
// 入参 / 出参
// ---------------------------------------------------------------------------

export interface RegisterWorkspaceInput {
  readonly alias: string;
  readonly kind: WorkspaceKind;
  readonly path: string;
  readonly mode: WorkspaceMode;
  /** 调用来源。除 `local_console` 外一律拒绝。 */
  readonly origin: WorkspaceAdminOrigin;
}

/** 核查根身份的三种结果。「无法核查」必须能与「已变更」区分开。 */
export type RootIdentityOutcome =
  | { readonly kind: 'unchanged'; readonly facts: RootFacts }
  | {
      readonly kind: 'identity_changed';
      readonly expected: { readonly volume_id: string; readonly file_id: string };
      readonly observed: { readonly volume_id: string; readonly file_id: string };
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unverifiable'; readonly code: string; readonly message: string };

/** 重新验证的结果。`relocated` 是一次**重新授权**，因此代次已递增。 */
export type ReverifyOutcome =
  | { readonly kind: 'unchanged'; readonly workspace: WorkspaceRecord }
  | {
      readonly kind: 'relocated';
      readonly workspace: WorkspaceRecord;
      readonly from: { readonly volume_id: string; readonly file_id: string };
      readonly to: { readonly volume_id: string; readonly file_id: string };
    }
  | { readonly kind: 'missing'; readonly workspace: WorkspaceRecord }
  | { readonly kind: 'unverifiable'; readonly workspace: WorkspaceRecord; readonly code: string };

/**
 * 通过授权后拿到的根。
 *
 * 这是**取用工作区根路径的唯一通道**：调用方拿不到 `AuthorizedRoot`
 * 就不应该知道根在哪。字段是只读快照，不会随着登记表变化而变化 ——
 * 因此一次操作中途工作区被移除，这次操作用的仍是它开始时的那份授权快照，
 * 而它在开始时就已通过代次与身份核查。
 */
export interface AuthorizedRoot {
  readonly workspace_id: string;
  readonly alias: string;
  readonly kind: WorkspaceKind;
  readonly mode: WorkspaceMode;
  readonly root_path: string;
  readonly volume_id: string;
  readonly file_id: string;
  readonly generation: number;
  readonly policy_version: number;
}

function isProbeError(value: WinfsVolumeInfo | WinfsError): value is WinfsError {
  return value.ok === false;
}

function toFacts(info: WinfsVolumeInfo): RootFacts {
  return {
    path: info.path,
    volume_id: info.volume_id,
    file_id: info.file_id,
    drive_type: info.drive_type,
    file_system: info.file_system,
    is_cloud_placeholder: info.is_cloud_placeholder,
    is_reparse: info.is_reparse,
    is_directory: info.is_directory,
    link_count: info.link_count,
    volume_info_available: info.volume_info_available,
  };
}

/** 把原生层错误码映射成拒绝理由。未列出的码一律 `PROBE_FAILED`（默认拒绝）。 */
function probeFailure(info: WinfsError): { reason: RootRejection['reason']; detail: string } {
  switch (info.code) {
    case 'NOT_FOUND':
      return { reason: 'NOT_FOUND', detail: info.message };
    case 'PERMISSION_DENIED':
    case 'FILE_BUSY':
      return { reason: 'ACCESS_DENIED', detail: info.message };
    case 'NATIVE_GUARD_UNAVAILABLE':
      return { reason: 'GUARD_UNAVAILABLE', detail: info.message };
    default:
      return { reason: 'PROBE_FAILED', detail: `${info.code}：${info.message}` };
  }
}

function toExisting(record: WorkspaceRecord): ExistingRoot {
  return {
    id: record.id,
    alias: record.alias,
    kind: record.kind,
    mode: record.mode,
    path: record.canonical_root,
    volume_id: record.volume_id,
    file_id: record.root_file_id,
  };
}

// ---------------------------------------------------------------------------
// 登记表
// ---------------------------------------------------------------------------

export class WorkspaceRegistry {
  readonly #repos: Repositories;
  readonly #probe: RootProbe;
  readonly #environment: WorkspaceEnvironment;
  readonly #newId: () => string;
  readonly #now: () => string;

  constructor(options: WorkspaceRegistryOptions) {
    this.#repos = options.repos;
    this.#probe = options.probe;
    this.#environment = options.environment;
    this.#newId = options.newId ?? defaultWorkspaceId;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  // --- 登记 -------------------------------------------------------------

  /**
   * 登记一个目录或单个文件（步骤 1、2、3）。
   *
   * 步骤顺序不能调换：先解析语法（便宜、不碰磁盘），再探测形态（需要原生层），
   * 最后与在册工作区比较（需要数据库）。任一步产生拒绝理由即整体拒绝，
   * 且**不写入任何行** —— 拒绝必须是可重试的纯操作。
   */
  async register(input: RegisterWorkspaceInput): Promise<WorkspaceRecord> {
    const rejections: RootRejection[] = [];

    // 来源检查放在最前面：模型侧发起的登记连探测都不该发生，
    // 否则「被拒绝的请求」也会在原生层留下痕迹，没有必要。
    if (input.origin !== 'local_console') {
      rejections.push({
        reason: 'ORIGIN_NOT_LOCAL',
        detail: `调用来源为 ${input.origin}，只有本地控制台可以登记工作区。`,
      });
      throw new RootRejectedError(rejections);
    }

    const alias = validateAlias(input.alias);
    if (!alias.ok) {
      rejections.push({ reason: 'INVALID_ALIAS', detail: alias.detail });
      throw new RootRejectedError(rejections);
    }

    const parsed = parseAbsoluteRoot(input.path);
    if (!parsed.ok) throw new RootRejectedError([{ reason: parsed.reason, detail: parsed.detail }]);
    const root = parsed.normalized;

    const collected = await this.#collectFacts(root);
    if ('rejections' in collected) throw new RootRejectedError(collected.rejections);

    const broad = assessBroadDirectory({
      storeRoot: this.#environment.store_root,
      candidateRoot: root,
      homeDirectory: this.#environment.home_directory,
      extraProbes: this.#environment.extra_broad_probes,
    });

    const protectedMatch = findProtectedIdentityMatch(
      { volume_id: collected.facts.volume_id, file_id: collected.facts.file_id },
      this.#environment.protected_refs,
    );

    const existing = this.#repos.workspaces.list().map(toExisting);
    if (existing.some((e) => e.alias === input.alias.trim())) {
      rejections.push({ reason: 'DUPLICATE_ALIAS', detail: `别名「${input.alias}」已被占用。` });
    }

    rejections.push(
      ...screenRoot({
        origin: input.origin,
        alias: input.alias,
        kind: input.kind,
        mode: input.mode,
        root,
        facts: collected.facts,
        ancestors: collected.ancestors,
        broad,
        protected_identity: protectedMatch,
        existing,
      }),
    );

    if (rejections.length > 0) throw new RootRejectedError(rejections);

    const record = this.#repos.workspaces.create({
      id: this.#newId(),
      alias: input.alias.trim(),
      kind: input.kind,
      canonical_root: root,
      volume_id: collected.facts.volume_id,
      root_file_id: collected.facts.file_id,
      policy_version: this.#environment.policy_version,
      mode: input.mode,
    });

    this.#audit('workspace.register', record, 'allow', {
      kind: record.kind,
      mode: record.mode,
      generation: record.generation,
    });
    return record;
  }

  // --- 暂停 / 恢复 / 移除 ------------------------------------------------

  /** 暂停：立即停用并递增代次，因此此前签发的票据与修改集全部失效。 */
  pause(workspaceId: string, origin: WorkspaceAdminOrigin): WorkspaceRecord {
    this.#requireLocal(origin);
    const record = this.#repos.workspaces.setEnabled(workspaceId, false);
    this.#audit('workspace.pause', record, 'allow', { generation: record.generation });
    return record;
  }

  /**
   * 恢复。
   *
   * 恢复**不是**简单地打开开关：它会重新核查根身份，身份已变的根不会被
   * 静默接受。原因见下面 `#refuseIfRootChanged` 的注释 —— 那是一条
   * 重新授权的边界，必须由本地操作者显式跨过。
   */
  async resume(workspaceId: string, origin: WorkspaceAdminOrigin): Promise<WorkspaceRecord> {
    this.#requireLocal(origin);
    const current = this.#repos.workspaces.requireById(workspaceId);
    if (current.removed_at !== null) {
      throw new BridgeError('WORKSPACE_NOT_GRANTED', '工作区已被移除，不能恢复。');
    }
    this.#refuseIfRootChanged(await this.verifyRootIdentity(workspaceId), workspaceId);
    const record = this.#repos.workspaces.setEnabled(workspaceId, true);
    this.#audit('workspace.resume', record, 'allow', { generation: record.generation });
    return record;
  }

  /**
   * 移除（步骤 4）。
   *
   * 软移除：打 `removed_at`、停用、**递增代次**。不删除行，因为
   * 历史修改集必须继续指向一个真实存在的工作区（外键是 RESTRICT，
   * 终态修改集还有墓碑触发器）。
   *
   * 移除后**可以**用同一个别名与同一个目录重新登记 —— 三条唯一索引
   * 都是 `WHERE removed_at IS NULL` 的部分索引。重新登记会得到一个新的
   * workspace_id，因此旧票据即使代次碰巧相同也对不上。
   */
  remove(workspaceId: string, origin: WorkspaceAdminOrigin): WorkspaceRecord {
    this.#requireLocal(origin);
    const record = this.#repos.workspaces.markRemoved(workspaceId);
    this.#audit('workspace.remove', record, 'allow', { generation: record.generation });
    return record;
  }

  // --- 重新验证（= 重新授权） -------------------------------------------

  /**
   * 重新验证（步骤 4）。
   *
   * 这是**重新授权**动作，不只是只读检查：身份变了就按新对象更新登记并
   * 递增代次。之所以让它改状态，是因为「按当前磁盘上的对象重新授权」
   * 正是本地操作者点这个按钮时表达的意思；如果它只报告不生效，
   * 操作者会以为已经处理好，而实际授权还绑在旧对象上。
   *
   * 反过来，「变没变」的判断由 `verifyRootIdentity` 用真实身份做出，
   * 不是靠路径字符串相等 —— 同名目录被替换后路径一模一样。
   */
  async reverify(workspaceId: string, origin: WorkspaceAdminOrigin): Promise<ReverifyOutcome> {
    this.#requireLocal(origin);
    const before = this.#repos.workspaces.requireById(workspaceId);
    if (before.removed_at !== null) {
      throw new BridgeError('WORKSPACE_NOT_GRANTED', '工作区已被移除，不能重新验证。');
    }

    const outcome = await this.verifyRootIdentity(workspaceId);
    switch (outcome.kind) {
      case 'unchanged': {
        this.#audit('workspace.reverify', before, 'allow', { result: 'unchanged' });
        return { kind: 'unchanged', workspace: before };
      }
      case 'missing': {
        // 目标消失时**不**递增代次：消失不是「换了对象」，而且此时任何访问
        // 都已经打不开根。递增会让一次临时的盘符脱机把在途修改集全部作废。
        this.#audit('workspace.reverify', before, 'deny', { result: 'missing' });
        return { kind: 'missing', workspace: before };
      }
      case 'unverifiable': {
        this.#audit('workspace.reverify', before, 'error', { result: 'unverifiable', code: outcome.code });
        return { kind: 'unverifiable', workspace: before, code: outcome.code };
      }
      case 'identity_changed': {
        const after = this.#repos.workspaces.relocate(workspaceId, {
          canonical_root: before.canonical_root,
          volume_id: outcome.observed.volume_id,
          root_file_id: outcome.observed.file_id,
        });
        this.#audit('workspace.reverify', after, 'allow', {
          result: 'relocated',
          generation: after.generation,
        });
        return { kind: 'relocated', workspace: after, from: outcome.expected, to: outcome.observed };
      }
    }
  }

  /**
   * 重定位到另一个路径（步骤 3）。
   *
   * 与 `reverify` 的区别：`reverify` 处理「同一个路径换对象」，
   * `relocate` 处理「同一个授权换路径」。后者必须对新路径**重跑完整筛查** ——
   * 否则操作者可以先登记一个安全的目录，再把它重定位到 `C:\` 上去。
   */
  async relocate(
    workspaceId: string,
    nextPath: string,
    origin: WorkspaceAdminOrigin,
  ): Promise<WorkspaceRecord> {
    this.#requireLocal(origin);
    const before = this.#repos.workspaces.requireById(workspaceId);
    if (before.removed_at !== null) {
      throw new BridgeError('WORKSPACE_NOT_GRANTED', '工作区已被移除，不能重定位。');
    }

    const parsed = parseAbsoluteRoot(nextPath);
    if (!parsed.ok) throw new RootRejectedError([{ reason: parsed.reason, detail: parsed.detail }]);
    const root = parsed.normalized;

    const collected = await this.#collectFacts(root);
    if ('rejections' in collected) throw new RootRejectedError(collected.rejections);

    const broad = assessBroadDirectory({
      storeRoot: this.#environment.store_root,
      candidateRoot: root,
      homeDirectory: this.#environment.home_directory,
      extraProbes: this.#environment.extra_broad_probes,
    });
    const protectedMatch = findProtectedIdentityMatch(
      { volume_id: collected.facts.volume_id, file_id: collected.facts.file_id },
      this.#environment.protected_refs,
    );
    // 自己不算冲突，否则任何一次重定位都会与「自己」重叠而被拒。
    const existing = this.#repos.workspaces
      .list()
      .filter((w) => w.id !== workspaceId)
      .map(toExisting);

    const rejections = screenRoot({
      origin,
      alias: before.alias,
      kind: before.kind,
      mode: before.mode,
      root,
      facts: collected.facts,
      ancestors: collected.ancestors,
      broad,
      protected_identity: protectedMatch,
      existing,
    });
    if (rejections.length > 0) throw new RootRejectedError(rejections);

    const record = this.#repos.workspaces.relocate(workspaceId, {
      canonical_root: root,
      volume_id: collected.facts.volume_id,
      root_file_id: collected.facts.file_id,
    });
    this.#audit('workspace.relocate', record, 'allow', { generation: record.generation });
    return record;
  }

  // --- 取用 --------------------------------------------------------------

  /**
   * 取用工作区根的**唯一通道**。
   *
   * 三道检查，任何一道不过都抛错，没有「尽力而为」的分支：
   *
   *  1. 在册且启用（`requireUsableById`）。
   *  2. 调用方携带的代次与当前一致（票据、游标、修改集都靠它失效）。
   *  3. **根在磁盘上的真实身份**与登记一致 —— 这一条每次重新探测，
   *     因为同名目录被替换后路径完全没变，只有身份变了。
   */
  async authorizeAccess(
    workspaceId: string,
    options: { readonly generation?: number } = {},
  ): Promise<AuthorizedRoot> {
    const record = this.#repos.workspaces.requireUsableById(workspaceId);

    if (options.generation !== undefined && options.generation !== record.generation) {
      throw new BridgeError('WORKSPACE_GENERATION_CHANGED', '工作区代次已变化，旧票据/游标/修改集失效。', {
        current_generation: record.generation,
        presented_generation: options.generation,
      });
    }

    const outcome = await this.verifyRootIdentity(workspaceId);
    this.#refuseIfRootChanged(outcome, workspaceId);

    return {
      workspace_id: record.id,
      alias: record.alias,
      kind: record.kind,
      mode: record.mode,
      root_path: record.canonical_root,
      volume_id: record.volume_id,
      file_id: record.root_file_id,
      generation: record.generation,
      policy_version: record.policy_version,
    };
  }

  /**
   * 核查一个工作区的根在磁盘上是否仍是登记时的那个对象。
   *
   * 不抛错、不改状态，只回答事实 —— 调用方（`authorizeAccess`、`reverify`、
   * `resume`）对同一个事实有不同的处置，处置写在各自那里。
   */
  async verifyRootIdentity(workspaceId: string): Promise<RootIdentityOutcome> {
    const record = this.#repos.workspaces.requireById(workspaceId);
    const probed = await this.#probe.statVolume({ path: record.canonical_root });
    if (isProbeError(probed)) {
      const mapped = probeFailure(probed);
      if (mapped.reason === 'NOT_FOUND') return { kind: 'missing' };
      return { kind: 'unverifiable', code: probed.code, message: probed.message };
    }
    if (probed.volume_id !== record.volume_id || probed.file_id !== record.root_file_id) {
      return {
        kind: 'identity_changed',
        expected: { volume_id: record.volume_id, file_id: record.root_file_id },
        observed: { volume_id: probed.volume_id, file_id: probed.file_id },
      };
    }
    return { kind: 'unchanged', facts: toFacts(probed) };
  }

  // --- 查询 --------------------------------------------------------------

  list(): WorkspaceRecord[] {
    return this.#repos.workspaces.list();
  }

  /** 供本地控制台展示：附带「根是否仍然可信」。 */
  async describe(workspaceId: string): Promise<{
    readonly workspace: WorkspaceRecord;
    readonly identity: RootIdentityOutcome;
  }> {
    return {
      workspace: this.#repos.workspaces.requireById(workspaceId),
      identity: await this.verifyRootIdentity(workspaceId),
    };
  }

  // --- 内部 --------------------------------------------------------------

  /**
   * 收集候选根及其整条祖先链的事实。
   *
   * 任何一级探测失败都直接拒绝：拿不到事实就无法证明那一级不是重解析点，
   * 而「无法证明」在本工程一律等同于「不安全」（I10）。
   */
  async #collectFacts(
    root: string,
  ): Promise<{ facts: RootFacts; ancestors: RootFacts[] } | { rejections: RootRejection[] }> {
    const own = await this.#probe.statVolume({ path: root });
    if (isProbeError(own)) {
      const mapped = probeFailure(own);
      return { rejections: [{ reason: mapped.reason, detail: mapped.detail }] };
    }

    const ancestors: RootFacts[] = [];
    for (const ancestorPath of ancestorPaths(root)) {
      const probed = await this.#probe.statVolume({ path: ancestorPath });
      if (isProbeError(probed)) {
        const mapped = probeFailure(probed);
        return {
          rejections: [
            {
              reason: 'ANCESTOR_UNVERIFIABLE',
              detail: `上级路径「${ancestorPath}」无法验证（${mapped.reason}）：${mapped.detail}`,
            },
          ],
        };
      }
      ancestors.push(toFacts(probed));
    }

    return { facts: toFacts(own), ancestors };
  }

  #requireLocal(origin: WorkspaceAdminOrigin): void {
    if (origin !== 'local_console') {
      throw new RootRejectedError([
        { reason: 'ORIGIN_NOT_LOCAL', detail: `调用来源为 ${origin}，只有本地控制台可以修改工作区。` },
      ]);
    }
  }

  /**
   * 授权路径上遇到「根已变」时的统一处置：**拒绝**。
   *
   * 这里刻意不递增代次。「核查时顺手把登记改成新对象」看起来更方便，
   * 但那等于**自动重新授权**：任何人只要在同名路径上放一个目录，
   * 就能让下一次读取把授权转到它身上。重新授权必须是本地操作者的
   * 显式动作（`reverify`），不能是读取路径的副作用。
   */
  #refuseIfRootChanged(outcome: RootIdentityOutcome, workspaceId: string): void {
    switch (outcome.kind) {
      case 'unchanged':
        return;
      case 'missing':
        throw new BridgeError('WORKSPACE_GENERATION_CHANGED', '工作区根已不存在，需要本地操作者重新验证。', {
          workspace_id: workspaceId,
          cause: 'root_missing',
        });
      case 'unverifiable':
        throw new BridgeError('NATIVE_GUARD_UNAVAILABLE', '无法核查工作区根的身份，已拒绝访问。', {
          workspace_id: workspaceId,
          code: outcome.code,
        });
      case 'identity_changed':
        throw new BridgeError(
          'WORKSPACE_GENERATION_CHANGED',
          '工作区根在磁盘上已被替换为另一个对象，原授权失效，需本地操作者重新验证。',
          {
            workspace_id: workspaceId,
            cause: 'root_replaced',
          },
        );
    }
  }

  #audit(
    action: string,
    record: WorkspaceRecord,
    outcome: 'allow' | 'deny' | 'error',
    metadata: Readonly<Record<string, string | number | boolean | null>>,
  ): void {
    // 审计里只放别名与结构化字段，**不放**本机绝对路径（方案 §9 审计约束）。
    this.#repos.audit.append({
      subject: record.id,
      action,
      outcome,
      workspace_id: record.id,
      metadata: { alias: record.alias, ...metadata },
    });
  }
}

/** 新工作区 id。带前缀便于在日志里一眼分辨对象类型。 */
export function defaultWorkspaceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `ws_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 供本地控制台预填别名：取路径最后一段。 */
export function suggestAlias(absolutePath: string): string {
  return lastSegment(absolutePath);
}

/**
 * 单文件授权的**结构**说明。
 *
 * 这不是运行时代码，而是把 `kind: 'file'` 为什么能挡住「顺带暴露父目录」
 * 写在一个能被检索到的地方：
 *
 * 单文件工作区的根就是那个文件本身，`root_file_id` 是**该文件**的身份。
 * 文件没有子项，因此相对路径解析只可能命中这一个对象 —— 父目录里有什么、
 * 有多少，登记表里根本不存在表达它的字段。若改成「父目录为根 + 一张
 * 允许文件清单」，则每一次路径解析都必须记得查那张清单，
 * 忘掉一次就把整个父目录开放了。
 */
export const SINGLE_FILE_ROOT_NOTE = 'root = 文件本身，因此不存在能表达父目录内容的字段。';

/** 与 `isInsideStore` 同源的预过滤，导出给控制台做输入提示。 */
export function looksLikeProtectedStore(candidate: string, storeRoot: string): boolean {
  const parsed = parseAbsoluteRoot(candidate);
  if (!parsed.ok) return false;
  return isInsideStore(parsed.normalized, storeRoot) || rootKey(parsed.normalized) === rootKey(storeRoot);
}
