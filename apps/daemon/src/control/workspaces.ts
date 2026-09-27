/**
 * 工作区控制操作（LWB-009 步骤 4、LWB-008 步骤 2 的落地）。
 *
 * ## 这一层做什么、不做什么
 *
 * 它只做三件事：把 IPC 请求体解析成登记表的入参、把**调用来源**翻译成
 * `WorkspaceAdminOrigin`、把登记表的错误原样上抛。判断本身全在
 * `@lwb/workspaces`，本文件里没有任何 `if (可以吗)` 式的授权逻辑 ——
 * 那种逻辑散落在多层时会各自漂移。
 *
 * ## 「外部模型不能创建工作区」是怎么保证的
 *
 * 三道，且**只有第一道是安全边界**：
 *
 *  1. `required: 'workspaces.manage'`。这个能力只映射给 `console` audience
 *     （见 `@lwb/ipc` 的 `CAPABILITIES_BY_AUDIENCE`），适配器连不上这些操作。
 *     这是真正的边界，因为它由服务端在握手时决定，请求方影响不了。
 *  2. `RequiredRoles` 把 `audience` 翻成 `local_console | model_surface`，
 *     登记表对非 `local_console` 一律拒绝。它挡的是**接线错误** ——
 *     例如有人把这些操作注册进了适配器那份注册表，此时第 1 道形同虚设，
 *     第 2 道会让它立刻失败。
 *  3. 注释。第 3 道不是机制，列在这里是因为它容易被人当成机制。
 */

import { BridgeError, type WorkspaceKind, type WorkspaceMode } from '@lwb/contracts';
import type { OperationDefinition, OperationRegistry, RequestContext } from '@lwb/ipc';
import type { WorkspaceRegistry } from '@lwb/workspaces';
import type { WorkspaceAdminOrigin } from '@lwb/workspaces';

/** 控制操作统一要求的能力。**不授予模型侧**（`NEVER_GRANTED_TO_MODEL` 里逐条钉住）。 */
export const WORKSPACES_MANAGE_CAPABILITY = 'workspaces.manage' as const;

/**
 * audience → 来源。
 *
 * 只认 `console`。写成映射而不是 `audience === 'console' ? ... : ...`，
 * 是为了在新增 audience 时**编译期**就会暴露：`Record<Audience, ...>` 少一个键
 * 会直接报错，而三元表达式会静默地把新 audience 归到 `model_surface` 一侧
 * —— 那正好是安全的那一侧，所以这个方向是对的，但显式更好。
 */
export function originOf(context: RequestContext): WorkspaceAdminOrigin {
  return context.audience === 'console' ? 'local_console' : 'model_surface';
}

// ---------------------------------------------------------------------------
// 入参解析
// ---------------------------------------------------------------------------

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BridgeError('INVALID_ARGUMENT', '工作区操作需要一个对象参数。');
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BridgeError('INVALID_ARGUMENT', `字段 ${field} 必须是非空字符串。`);
  }
  return value;
}

const KINDS: readonly WorkspaceKind[] = ['directory', 'file'];
const MODES: readonly WorkspaceMode[] = ['read_only', 'read_propose_apply_with_local_approval'];

function requireKind(value: unknown): WorkspaceKind {
  if (typeof value !== 'string' || !(KINDS as readonly string[]).includes(value)) {
    throw new BridgeError('INVALID_ARGUMENT', `字段 kind 必须是 ${KINDS.join(' 或 ')}。`);
  }
  return value as WorkspaceKind;
}

function requireMode(value: unknown): WorkspaceMode {
  if (typeof value !== 'string' || !(MODES as readonly string[]).includes(value)) {
    throw new BridgeError('INVALID_ARGUMENT', `字段 mode 必须是 ${MODES.join(' 或 ')}。`);
  }
  return value as WorkspaceMode;
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

/**
 * 注册全部工作区控制操作。
 *
 * 操作名刻意用点号分段并与能力同名：`workspaces.manage` 这个名字在
 * 审计、能力表和操作名三处一致，排障时不需要再建立一层心智映射。
 */
export function registerWorkspaceOperations(
  registry: OperationRegistry,
  workspaces: WorkspaceRegistry,
): void {
  const definitions: OperationDefinition[] = [
    {
      name: 'workspaces.register',
      required: WORKSPACES_MANAGE_CAPABILITY,
      handler: async (input, context) => {
        const body = asRecord(input);
        const record = await workspaces.register({
          alias: requireString(body['alias'], 'alias'),
          kind: requireKind(body['kind']),
          path: requireString(body['path'], 'path'),
          mode: requireMode(body['mode']),
          origin: originOf(context),
        });
        return describeRecord(record);
      },
    },
    {
      name: 'workspaces.list',
      required: WORKSPACES_MANAGE_CAPABILITY,
      handler: () => workspaces.list().map(describeRecord),
    },
    {
      name: 'workspaces.describe',
      required: WORKSPACES_MANAGE_CAPABILITY,
      handler: async (input) => {
        const body = asRecord(input);
        const result = await workspaces.describe(requireString(body['workspace_id'], 'workspace_id'));
        return {
          ...describeRecord(result.workspace),
          // 只回报身份核查的**结论**，不回身份值：卷/文件身份属于本机事实，
          // 控制台需要它时再单独取，避免它随着每一次列表刷新到处流动。
          identity: result.identity.kind,
        };
      },
    },
    {
      name: 'workspaces.pause',
      required: WORKSPACES_MANAGE_CAPABILITY,
      handler: (input, context) => {
        const body = asRecord(input);
        return describeRecord(
          workspaces.pause(requireString(body['workspace_id'], 'workspace_id'), originOf(context)),
        );
      },
    },
    {
      name: 'workspaces.resume',
      required: WORKSPACES_MANAGE_CAPABILITY,
      handler: async (input, context) => {
        const body = asRecord(input);
        return describeRecord(
          await workspaces.resume(
            requireString(body['workspace_id'], 'workspace_id'),
            originOf(context),
          ),
        );
      },
    },
    {
      name: 'workspaces.remove',
      required: WORKSPACES_MANAGE_CAPABILITY,
      handler: (input, context) => {
        const body = asRecord(input);
        return describeRecord(
          workspaces.remove(requireString(body['workspace_id'], 'workspace_id'), originOf(context)),
        );
      },
    },
    {
      name: 'workspaces.reverify',
      required: WORKSPACES_MANAGE_CAPABILITY,
      handler: async (input, context) => {
        const body = asRecord(input);
        const outcome = await workspaces.reverify(
          requireString(body['workspace_id'], 'workspace_id'),
          originOf(context),
        );
        return { result: outcome.kind, workspace: describeRecord(outcome.workspace) };
      },
    },
    {
      name: 'workspaces.relocate',
      required: WORKSPACES_MANAGE_CAPABILITY,
      handler: async (input, context) => {
        const body = asRecord(input);
        return describeRecord(
          await workspaces.relocate(
            requireString(body['workspace_id'], 'workspace_id'),
            requireString(body['path'], 'path'),
            originOf(context),
          ),
        );
      },
    },
  ];

  for (const definition of definitions) registry.register(definition);
}

/**
 * 回给控制台的字段。
 *
 * 含 `canonical_root`：这是**本地控制台**，操作者本来就知道自己的路径，
 * 藏起来只会让他无法确认登记的是哪一个目录。这条记录不会流向模型 ——
 * 模型侧的工作区列表由适配器另走 `workspace_list`，只回别名与能力。
 */
function describeRecord(record: {
  readonly id: string;
  readonly alias: string;
  readonly kind: WorkspaceKind;
  readonly mode: WorkspaceMode;
  readonly canonical_root: string;
  readonly generation: number;
  readonly policy_version: number;
  readonly enabled: boolean;
  readonly removed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}): Record<string, unknown> {
  return {
    workspace_id: record.id,
    alias: record.alias,
    kind: record.kind,
    mode: record.mode,
    root: record.canonical_root,
    generation: record.generation,
    policy_version: record.policy_version,
    enabled: record.enabled,
    removed: record.removed_at !== null,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}
