import { BridgeError, newGrantId } from '@lwb/contracts';
import type { GrantRecord, Repositories, WorkspaceRecord } from '@lwb/persistence';
import { readProtectedJsonConfiguration, writeProtectedJsonConfiguration } from '@lwb/secure-store';

import { SESSION_TTL_MS } from '../control/constants.ts';
import {
  capabilitiesForWorkspaceTools,
  configuredToolsForWorkspace,
  workspaceToolsForCapabilities,
} from '../tools/catalog.ts';
import type { ImplementedToolName } from '@lwb/contracts';

export const LOCAL_CONFIGURATION_SCHEMA_VERSION = 1;
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 0;
export const DEFAULT_SESSION_ABSOLUTE_TIMEOUT_MS = SESSION_TTL_MS;
export const MAX_SESSION_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_SESSION_TIMEOUT_MS = 60 * 1000;

export class LocalConfigurationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalConfigurationValidationError';
  }
}

export interface SessionTimeoutConfiguration {
  /** 0 disables idle expiry. */
  readonly idle_timeout_ms: number;
  /** null disables absolute expiry. */
  readonly absolute_timeout_ms: number | null;
}

export interface WorkspaceConfiguration {
  readonly workspace_id: string;
  readonly alias: string;
  readonly kind: WorkspaceRecord['kind'];
  readonly path: string;
  readonly mode: WorkspaceRecord['mode'];
  readonly enabled: boolean;
  readonly removed: boolean;
  readonly generation: number;
  readonly policy_version: number;
  /** Actual workspace-scoped MCP tool names, not control-plane operations. */
  readonly authorized_tools: readonly ImplementedToolName[];
}

export interface LocalConfigurationDocument {
  readonly schema_version: typeof LOCAL_CONFIGURATION_SCHEMA_VERSION;
  /** Monotonic workspace/grant revision used to withdraw in-flight tool results. */
  readonly authorization_revision: number;
  readonly session: SessionTimeoutConfiguration;
  readonly workspaces: readonly WorkspaceConfiguration[];
}

export interface LocalConfigurationOptions {
  readonly file_path: string;
  readonly repos: Repositories;
  readonly model_connection_id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSessionTimeouts(value: unknown): SessionTimeoutConfiguration {
  if (!isRecord(value)) throw new LocalConfigurationValidationError('session 必须是对象。');
  const idle = value['idle_timeout_ms'];
  const absolute = value['absolute_timeout_ms'];
  if (typeof idle !== 'number' || !Number.isSafeInteger(idle) || idle < 0 || idle > MAX_SESSION_TIMEOUT_MS) {
    throw new LocalConfigurationValidationError('idle_timeout_ms 必须为 0（禁用）或不超过 30 天的毫秒数。');
  }
  if (idle > 0 && idle < MIN_SESSION_TIMEOUT_MS) {
    throw new LocalConfigurationValidationError('启用空闲期限时，idle_timeout_ms 不能少于 1 分钟。');
  }
  if (absolute !== null && (typeof absolute !== 'number' || !Number.isSafeInteger(absolute) || absolute < MIN_SESSION_TIMEOUT_MS || absolute > MAX_SESSION_TIMEOUT_MS)) {
    throw new LocalConfigurationValidationError('absolute_timeout_ms 必须为 null（无限）或 1 分钟至 30 天之间的毫秒数。');
  }
  if (idle > 0 && absolute !== null && idle > absolute) {
    throw new LocalConfigurationValidationError('idle_timeout_ms 不能大于 absolute_timeout_ms。');
  }
  return { idle_timeout_ms: idle as number, absolute_timeout_ms: absolute as number | null };
}

function assertWorkspace(value: unknown): WorkspaceConfiguration {
  if (!isRecord(value)) throw new Error('本机配置中的工作区必须是对象。');
  const workspaceId = value['workspace_id'];
  const alias = value['alias'];
  const kind = value['kind'];
  const root = value['path'];
  const mode = value['mode'];
  const enabled = value['enabled'];
  const removed = value['removed'];
  const generation = value['generation'];
  const policyVersion = value['policy_version'];
  const tools = value['authorized_tools'];
  if (typeof workspaceId !== 'string' || workspaceId.length === 0 || typeof alias !== 'string' || alias.length === 0) {
    throw new Error('本机配置的工作区缺少 workspace_id 或 alias。');
  }
  if (kind !== 'directory' && kind !== 'file') throw new Error('本机配置的工作区 kind 无效。');
  if (typeof root !== 'string' || root.length === 0) throw new Error('本机配置的工作区 path 无效。');
  if (mode !== 'read_only' && mode !== 'read_propose_apply_with_local_approval') {
    throw new Error('本机配置的工作区 mode 无效。');
  }
  if (typeof enabled !== 'boolean' || typeof removed !== 'boolean') throw new Error('本机配置的工作区 enabled / removed 必须为布尔值。');
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1 ||
      typeof policyVersion !== 'number' || !Number.isSafeInteger(policyVersion) || policyVersion < 1) {
    throw new Error('本机配置的工作区 generation / policy_version 无效。');
  }
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string')) {
    throw new Error('本机配置的 authorized_tools 必须是工具名称数组。');
  }
  const canonicalTools = [...new Set(tools as string[])];
  if (canonicalTools.length !== tools.length) throw new Error('本机配置的 authorized_tools 含重复名称。');
  const capabilities = capabilitiesForWorkspaceTools(canonicalTools, kind, mode);
  const closedTools = workspaceToolsForCapabilities(capabilities, kind, mode);
  if (closedTools.length !== canonicalTools.length || closedTools.some((tool) => !canonicalTools.includes(tool))) {
    throw new Error('本机配置的 authorized_tools 必须与工作区 grant 能力闭包一致。');
  }
  // Catch invalid config values for access modes / root kinds during startup,
  // before those values can appear in the runtime permission snapshot.
  if (kind !== 'directory' && capabilities.includes('command_exec')) {
    throw new Error('单文件工作区不能授权 command_exec。');
  }
  return {
    workspace_id: workspaceId,
    alias,
    kind,
    path: root,
    mode,
    enabled,
    removed,
    generation,
    policy_version: policyVersion,
    authorized_tools: closedTools,
  };
}

function assertDocument(value: unknown): LocalConfigurationDocument {
  if (!isRecord(value) || value['schema_version'] !== LOCAL_CONFIGURATION_SCHEMA_VERSION) {
    throw new Error('本机配置 schema_version 不受支持。');
  }
  const authorizationRevision = value['authorization_revision'];
  if (
    typeof authorizationRevision !== 'number' ||
    !Number.isSafeInteger(authorizationRevision) ||
    authorizationRevision < 0
  ) throw new Error('本机配置 authorization_revision 无效。');
  if (!Array.isArray(value['workspaces'])) throw new Error('本机配置 workspaces 必须是数组。');
  const workspaces = (value['workspaces'] as unknown[]).map(assertWorkspace);
  const ids = workspaces.map((workspace) => workspace.workspace_id);
  if (new Set(ids).size !== ids.length) throw new Error('本机配置中存在重复 workspace_id。');
  return {
    schema_version: LOCAL_CONFIGURATION_SCHEMA_VERSION,
    authorization_revision: authorizationRevision,
    session: assertSessionTimeouts(value['session']),
    workspaces: workspaces.sort((left, right) => left.workspace_id.localeCompare(right.workspace_id)),
  };
}

function workspaceFromRecord(
  workspace: WorkspaceRecord,
  grant: GrantRecord | null,
): WorkspaceConfiguration {
  return {
    workspace_id: workspace.id,
    alias: workspace.alias,
    kind: workspace.kind,
    path: workspace.canonical_root,
    mode: workspace.mode,
    enabled: workspace.enabled,
    removed: workspace.removed_at !== null,
    generation: workspace.generation,
    policy_version: workspace.policy_version,
    authorized_tools: workspace.removed_at === null ? configuredToolsForWorkspace(workspace, grant) : [],
  };
}

function withDatabaseWorkspaceSnapshot(
  document: LocalConfigurationDocument,
  repos: Repositories,
  modelConnectionId: string,
  preserveJsonTools = false,
): LocalConfigurationDocument {
  const savedById = new Map(document.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
  const rows = repos.workspaces.list({ include_disabled: true, include_removed: true });
  const current = rows.map((workspace) => {
    const saved = savedById.get(workspace.id);
    const previousGrant = repos.grants.find(modelConnectionId, workspace.id);
    const entry = workspaceFromRecord(workspace, previousGrant);
    // Existing JSON rows are authoritative. A mismatch with the protected DB
    // workspace record will fail closed in matchesWorkspace() until the local
    // operator saves a workspace change through the screened console path.
    return preserveJsonTools && saved !== undefined
      ? saved
      : preserveJsonTools
        ? { ...entry, authorized_tools: [] }
        : entry;
  });
  const currentIds = new Set(rows.map((workspace) => workspace.id));
  const orphans = document.workspaces
    .filter((workspace) => !currentIds.has(workspace.workspace_id))
    // Without the matching protected DB identity, a JSON row can never authorize
    // a root. Keep its display data for recovery, but strip all tool grants.
    .map((workspace) => ({ ...workspace, authorized_tools: [] as readonly ImplementedToolName[] }));
  return assertDocument({
    schema_version: LOCAL_CONFIGURATION_SCHEMA_VERSION,
    authorization_revision: document.authorization_revision,
    session: document.session,
    workspaces: [...current, ...orphans],
  });
}

/** Protected JSON settings are the source of truth for session timeouts and MCP workspace grants. */
export class LocalConfigurationStore {
  readonly #filePath: string;
  readonly #modelConnectionId: string;
  readonly #repos: Repositories;
  #document: LocalConfigurationDocument;

  private constructor(options: LocalConfigurationOptions, document: LocalConfigurationDocument) {
    this.#filePath = options.file_path;
    this.#modelConnectionId = options.model_connection_id;
    this.#repos = options.repos;
    this.#document = document;
  }

  static loadOrMigrate(options: LocalConfigurationOptions): LocalConfigurationStore {
    let document: LocalConfigurationDocument;
    let existingConfiguration = false;
    let existingText: string | null;
    try {
      existingText = readProtectedJsonConfiguration(options.file_path);
    } catch {
      throw new Error('本机 JSON 配置文件无法安全读取；daemon 已拒绝启动。');
    }
    if (existingText !== null) {
      existingConfiguration = true;
      let parsed: unknown;
      try {
        parsed = JSON.parse(existingText) as unknown;
      } catch {
        throw new Error('本机 JSON 配置无法解析；为避免默认放宽访问，daemon 已拒绝启动。');
      }
      try {
        document = assertDocument(parsed);
      } catch (error) {
        throw new Error(`本机 JSON 配置无效：${error instanceof Error ? error.message : '无法验证配置'}；daemon 已拒绝启动。`);
      }
    } else {
      existingConfiguration = false;
      const workspaces = options.repos.workspaces
        .list({ include_disabled: true, include_removed: true })
        .map((workspace) => workspaceFromRecord(workspace, options.repos.grants.find(options.model_connection_id, workspace.id)));
      document = {
        schema_version: LOCAL_CONFIGURATION_SCHEMA_VERSION,
        authorization_revision: 0,
        session: {
          idle_timeout_ms: DEFAULT_SESSION_IDLE_TIMEOUT_MS,
          absolute_timeout_ms: DEFAULT_SESSION_ABSOLUTE_TIMEOUT_MS,
        },
        workspaces,
      };
    }

    const store = new LocalConfigurationStore(options, document);
    store.#document = withDatabaseWorkspaceSnapshot(
      document,
      options.repos,
      options.model_connection_id,
      existingConfiguration,
    );
    store.#persist(store.#document);
    store.#reconcileGrantRows(options.repos);
    return store;
  }

  get document(): LocalConfigurationDocument {
    return structuredClone(this.#document);
  }

  get sessionTimeouts(): SessionTimeoutConfiguration {
    return { ...this.#document.session };
  }

  get authorizationRevision(): number {
    return this.#document.authorization_revision;
  }

  updateSessionTimeouts(value: unknown): SessionTimeoutConfiguration {
    let session: SessionTimeoutConfiguration;
    try {
      session = assertSessionTimeouts(value);
    } catch (error) {
      if (error instanceof LocalConfigurationValidationError) {
        throw new BridgeError('INVALID_ARGUMENT', error.message);
      }
      throw error;
    }
    const next = assertDocument({ ...this.#document, session });
    this.#persist(next);
    this.#document = next;
    return { ...session };
  }

  /** Mirror a successful workspace/grant mutation into the canonical JSON file. */
  refreshWorkspaceSnapshot(repos: Repositories): void {
    const snapshot = withDatabaseWorkspaceSnapshot(this.#document, repos, this.#modelConnectionId);
    const next = assertDocument({
      ...snapshot,
      authorization_revision: this.#document.authorization_revision + 1,
    });
    this.#persist(next);
    this.#document = next;
    this.#reconcileGrantRows(repos);
  }

  findGrant(connectionId: string, workspaceId: string): GrantRecord | null {
    if (connectionId !== this.#modelConnectionId) return null;
    const workspace = this.#document.workspaces.find((item) => item.workspace_id === workspaceId);
    if (workspace === undefined) return null;
    const capabilities = capabilitiesForWorkspaceTools(workspace.authorized_tools, workspace.kind, workspace.mode);
    const mirror = this.#repos.grants.find(connectionId, workspaceId);
    return {
      id: mirror?.id ?? `json-config:${workspace.workspace_id}`,
      connection_id: connectionId,
      workspace_id: workspace.workspace_id,
      capabilities,
      enabled: capabilities.length > 0,
      created_at: mirror?.created_at ?? '',
      updated_at: mirror?.updated_at ?? '',
    };
  }

  listGrantsByConnection(connectionId: string): readonly GrantRecord[] {
    if (connectionId !== this.#modelConnectionId) return [];
    return this.#document.workspaces
      .map((workspace) => this.findGrant(connectionId, workspace.workspace_id))
      .filter((grant): grant is GrantRecord => grant !== null);
  }

  matchesWorkspace(workspace: WorkspaceRecord): boolean {
    const configured = this.#document.workspaces.find((item) => item.workspace_id === workspace.id);
    return configured !== undefined &&
      configured.alias === workspace.alias &&
      configured.kind === workspace.kind &&
      configured.path === workspace.canonical_root &&
      configured.mode === workspace.mode &&
      configured.enabled === workspace.enabled &&
      configured.removed === (workspace.removed_at !== null) &&
      configured.generation === workspace.generation &&
      configured.policy_version === workspace.policy_version;
  }

  /** Apply the JSON tool lists to their SQLite mirror before IPC services open. */
  #reconcileGrantRows(repos: Repositories): void {
    const configured = new Map(this.#document.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
    for (const workspace of repos.workspaces.list({ include_disabled: true, include_removed: true })) {
      const entry = configured.get(workspace.id);
      const tools = entry?.authorized_tools ?? [];
      const capabilities = capabilitiesForWorkspaceTools(tools, workspace.kind, workspace.mode);
      const previous = repos.grants.find(this.#modelConnectionId, workspace.id);
      if (previous === null && capabilities.length === 0) continue;
      if (
        previous !== null &&
        previous.enabled === (capabilities.length > 0) &&
        previous.capabilities.length === capabilities.length &&
        previous.capabilities.every((capability, index) => capability === capabilities[index])
      ) continue;
      repos.grants.put({
        id: previous?.id ?? newGrantId(),
        connection_id: this.#modelConnectionId,
        workspace_id: workspace.id,
        capabilities,
        enabled: capabilities.length > 0,
      });
    }
  }

  #persist(document: LocalConfigurationDocument): void {
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    try {
      writeProtectedJsonConfiguration(this.#filePath, serialized);
    } catch {
      throw new Error('无法安全保存本机 JSON 配置；当前设置未确认写入。');
    }
  }
}
