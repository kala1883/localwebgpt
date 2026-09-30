/**
 * Per-workspace MCP permissions managed only by the local console.
 * The public surface intentionally targets one fixed ChatGPT web connection;
 * callers can never choose another connection or inject control-only grants.
 */
import { BridgeError, newGrantId } from '@lwb/contracts';
import { screenMetadata } from '@lwb/audit';
import type { OperationDefinition, OperationRegistry, RequestContext } from '@lwb/ipc';
import type { Repositories } from '@lwb/persistence';
import type { LocalConfigurationStore } from '../config/local-configuration.ts';
import { WORKSPACES_MANAGE_CAPABILITY, originOf } from './workspaces.ts';

export const MODEL_WORKSPACE_CAPABILITIES = ['read', 'list', 'search', 'git_read', 'propose', 'command_exec'] as const;
export type ModelWorkspaceCapability = (typeof MODEL_WORKSPACE_CAPABILITIES)[number];

export interface WorkspaceAccessOperationsDeps {
  readonly repos: Repositories;
  /** Always present in production; isolated operation tests use the repository mirror. */
  readonly configuration?: LocalConfigurationStore;
  /** Set by daemon assembly, never taken from a request. */
  readonly model_connection_id: string;
}

function requireLocal(context: RequestContext): void {
  if (originOf(context) !== 'local_console') {
    throw new BridgeError('NOT_AUTHORIZED', '只有本地控制台可以查看或修改 ChatGPT 的目录授权。');
  }
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BridgeError('INVALID_ARGUMENT', '目录授权操作需要一个对象参数。');
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BridgeError('INVALID_ARGUMENT', `字段 ${field} 必须是非空字符串。`);
  }
  return value;
}

function parseCapabilities(value: unknown): readonly ModelWorkspaceCapability[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new BridgeError('INVALID_ARGUMENT', 'capabilities 必须是允许能力名称组成的数组。');
  }
  const requested = value as string[];
  if (new Set(requested).size !== requested.length) {
    throw new BridgeError('INVALID_ARGUMENT', 'capabilities 中不能有重复项。');
  }
  const unknown = requested.filter(
    (item) => !(MODEL_WORKSPACE_CAPABILITIES as readonly string[]).includes(item),
  );
  if (unknown.length > 0) {
    // In particular, `apply` and `control` are not MCP grants.
    throw new BridgeError('INVALID_ARGUMENT', '包含不允许授予 ChatGPT 的能力。');
  }
  return MODEL_WORKSPACE_CAPABILITIES.filter((item) => requested.includes(item));
}

function grantView(
  grant: { readonly workspace_id: string; readonly capabilities: readonly string[]; readonly enabled: boolean },
): Record<string, unknown> {
  const invalid = grant.capabilities.some(
    (item) => !(MODEL_WORKSPACE_CAPABILITIES as readonly string[]).includes(item),
  );
  if (invalid) throw new BridgeError('STORAGE_UNAVAILABLE', '目录授权含未知能力，已拒绝显示或使用。');
  const capabilities = grant.enabled
    ? MODEL_WORKSPACE_CAPABILITIES.filter((item) => grant.capabilities.includes(item))
    : [];
  return {
    workspace_id: grant.workspace_id,
    enabled: grant.enabled && capabilities.length > 0,
    capabilities,
  };
}

export function registerWorkspaceAccessOperations(
  registry: OperationRegistry,
  deps: WorkspaceAccessOperationsDeps,
): void {
  const definitions: OperationDefinition[] = [
    {
      name: 'workspaces.access.list',
      required: WORKSPACES_MANAGE_CAPABILITY,
      handler: (_input, context) => {
        requireLocal(context);
        const connection = deps.repos.connections.findById(deps.model_connection_id);
        if (connection === null || connection.principal_kind !== 'model_surface') {
          throw new BridgeError('NOT_AUTHORIZED', 'ChatGPT 网页连接尚未在本机正确登记。');
        }
        const grants = deps.configuration?.listGrantsByConnection(connection.id) ??
          deps.repos.grants.listByConnection(connection.id);
        return grants.map((grant) => {
          if (deps.configuration === undefined) return grantView(grant);
          const workspace = deps.repos.workspaces.findById(grant.workspace_id);
          if (workspace === null || !deps.configuration.matchesWorkspace(workspace)) {
            return grantView({ ...grant, capabilities: [], enabled: false });
          }
          return grantView(grant);
        });
      },
    },
    {
      name: 'workspaces.access.set',
      required: WORKSPACES_MANAGE_CAPABILITY,
      handler: (input, context) => {
        requireLocal(context);
        const body = asRecord(input);
        const workspaceId = requireString(body['workspace_id'], 'workspace_id');
        const capabilities = parseCapabilities(body['capabilities']);
        const connection = deps.repos.connections.findById(deps.model_connection_id);
        if (connection === null || connection.principal_kind !== 'model_surface') {
          throw new BridgeError('NOT_AUTHORIZED', 'ChatGPT 网页连接尚未在本机正确登记。');
        }
        const workspace = deps.repos.workspaces.findById(workspaceId);
        if (workspace === null) throw new BridgeError('NOT_FOUND', '工作区不存在。');
        if (workspace.removed_at !== null) {
          throw new BridgeError('WORKSPACE_NOT_GRANTED', '已移除的工作区不能重新授予 ChatGPT。');
        }
        if (workspace.mode === 'read_only' && capabilities.some((capability) => capability === 'propose' || capability === 'command_exec')) {
          throw new BridgeError('INVALID_ARGUMENT', '只读工作区不能授予文件修改或命令执行能力。');
        }
        if (workspace.kind !== 'directory' && capabilities.includes('command_exec')) {
          throw new BridgeError('INVALID_ARGUMENT', '命令执行只能授予目录工作区，不能授予单文件工作区。');
        }

        const previous = deps.repos.grants.find(connection.id, workspace.id);
        const grant = deps.repos.grants.put({
          id: previous?.id ?? newGrantId(),
          connection_id: connection.id,
          workspace_id: workspace.id,
          capabilities,
          // 空集是撤销：不仅能力为空，grant 本身也从模型的工作区清单中消失。
          enabled: capabilities.length > 0,
        });
        deps.repos.audit.append({
          subject: workspace.id,
          action: 'workspace.access.set',
          outcome: 'allow',
          workspace_id: workspace.id,
          connection_id: connection.id,
          metadata: screenMetadata({
            alias: workspace.alias,
            enabled: grant.enabled,
            capabilities: grant.enabled ? capabilities.join(',') : '',
          }),
        });
        deps.configuration?.refreshWorkspaceSnapshot(deps.repos);
        return grantView(grant);
      },
    },
  ];

  for (const definition of definitions) registry.register(definition);
}
