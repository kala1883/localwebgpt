/**
 * 本地恢复控制操作（LWB-037）。
 *
 * 恢复记录可以在模型连接停用、工作区暂停或内容闸门关闭时查看；但真正
 * 的恢复写入仍只能走 `RecoveryService` 的「重新观测 → 摘要核对 → 一次性
 * 授权 → 受保护写回」链路。这里不接受 user_id、approved 或路径等可伪造
 * 身份/范围字段，操作者身份只取自已经过控制面认证的 RequestContext。
 */

import { BridgeError, LIMITS } from '@lwb/contracts';
import { screenMetadata } from '@lwb/audit';
import type { BlobStore } from '@lwb/blob-store';
import type { OperationDefinition, OperationRegistry, RequestContext } from '@lwb/ipc';
import { planDigestOf, type Inspection, type RecoveryRecord, type RecoveryService } from '@lwb/recovery';
import type { Repositories } from '@lwb/persistence';

import { originOf } from './workspaces.ts';

/** 恢复读操作使用修改集复核能力；写操作使用本地批准能力。 */
export const RECOVERY_READ_CAPABILITY = 'changes.read' as const;
export const RECOVERY_WRITE_CAPABILITY = 'approvals.decide' as const;

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BridgeError('INVALID_ARGUMENT', '恢复操作需要一个对象参数。');
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BridgeError('INVALID_ARGUMENT', `字段 ${field} 必须是非空字符串。`);
  }
  return value;
}

function requireConfirmed(value: unknown, operation: string): void {
  if (value !== true) {
    throw new BridgeError(
      'INVALID_ARGUMENT',
      `${operation} 必须带 confirmed: true；恢复写入不会接受默认确认。`,
    );
  }
}

function requireLocalConsole(context: RequestContext): string {
  if (originOf(context) !== 'local_console') {
    throw new BridgeError('NOT_AUTHORIZED', '只有本地控制台可以处理恢复记录。', {
      reason: 'ORIGIN_NOT_LOCAL',
    });
  }
  return context.connection_id;
}

function recordOf(recovery: RecoveryService, operationId: string): RecoveryRecord {
  const record = recovery.records(operationId);
  if (record === null) throw new BridgeError('NOT_FOUND', '没有找到该恢复操作。');
  return record;
}

function safeRecord(record: RecoveryRecord): Record<string, unknown> {
  return {
    operation_id: record.operation_id,
    change_id: record.change_id,
    workspace_id: record.workspace_id,
    operation_state: record.operation_state,
    change_state: record.change_state,
    recovered: record.recovered,
    plan: null,
    plan_digest: null,
    observed_at: new Date().toISOString(),
    items: record.items.map((item) => ({
      item_id: item.item_id,
      path: item.canonical_path,
      op: item.op,
      original_sha256: item.before_sha256,
      proposed_sha256: item.after_sha256,
      // `records()` 的 after_sha256 是账本中的最终结果；当前观测值只在
      // `recovery.get` 的 inspection 中加入，避免把旧回执冒充当前现场。
      current_sha256: item.after_sha256,
      current_state: item.state,
      reason: null,
      error_code: item.error_code,
      updated_at: item.updated_at,
    })),
    authorizations: record.authorizations,
    journal: record.journal,
  };
}

function safeInspection(inspection: Inspection): Record<string, unknown> {
  return {
    operation_id: inspection.operation.id,
    plan_digest: planDigestOf(inspection.plan),
    plan:
      inspection.repair.kind === 'ok'
        ? {
            kind: 'ok',
            action: inspection.repair.action,
            digest: planDigestOf(inspection.plan),
            targets: inspection.repair.targets.map((target) => target.item.canonical_path),
          }
        : {
            kind: 'refused',
            reason: inspection.repair.reason,
            detail: inspection.repair.detail,
          },
    items: inspection.items.map(({ item, verdict }) => ({
      item_id: item.id,
      path: item.canonical_path,
      op: item.op,
      original_sha256: item.base_sha256,
      proposed_sha256: item.target_sha256,
      current_sha256:
        verdict.kind === 'ORIGINAL' || verdict.kind === 'TARGET_REACHED' || verdict.kind === 'THIRD_CONTENT'
          ? verdict.observed_sha256
          : null,
      current_state: verdict.kind,
      reason: verdict.kind === 'IDENTITY_UNKNOWN' ? verdict.reason : null,
      error_code: null,
      updated_at: null,
    })),
  };
}

function appendRecoveryAudit(
  repos: Repositories,
  input: {
    readonly action: string;
    readonly actor: string;
    readonly operation_id: string;
    readonly change_id: string;
    readonly request_id: string;
    readonly outcome: 'allow' | 'error';
    readonly reason?: string | null;
  },
): void {
  repos.audit.append({
    subject: input.operation_id,
    action: input.action,
    outcome: input.outcome,
    connection_id: input.actor,
    change_id: input.change_id,
    request_id: input.request_id,
    metadata: screenMetadata({
      operation_id: input.operation_id,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  });
}

export interface RecoveryOperationsDeps {
  readonly repos: Repositories;
  readonly recovery: RecoveryService;
  readonly blobs: BlobStore;
  readonly now?: () => string;
}

export const RECOVERY_OPERATION_NAMES = [
  'recovery.list',
  'recovery.get',
  'recovery.export_snapshot',
  'recovery.keep_current',
  'recovery.repropose',
  'recovery.authorize',
  'recovery.repair',
] as const;

export function registerRecoveryOperations(registry: OperationRegistry, deps: RecoveryOperationsDeps): void {
  const definitions: OperationDefinition[] = [
    {
      name: 'recovery.list',
      required: RECOVERY_READ_CAPABILITY,
      handler: (input, context) => {
        requireLocalConsole(context);
        const body = input === undefined || input === null ? {} : asRecord(input);
        const rawLimit = body['limit'];
        if (rawLimit !== undefined && (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit))) {
          throw new BridgeError('INVALID_ARGUMENT', '字段 limit 必须是整数。');
        }
        const limit = Math.max(1, Math.min(typeof rawLimit === 'number' ? rawLimit : 50, 200));
        const operations = deps.repos.operations
          .listByStates(['RECOVERY_REQUIRED'])
          .slice(0, limit);
        return {
          records: operations.map((operation) => safeRecord(recordOf(deps.recovery, operation.id))),
          observed_at: deps.now?.() ?? new Date().toISOString(),
        };
      },
    },
    {
      name: 'recovery.get',
      required: RECOVERY_READ_CAPABILITY,
      handler: async (input, context) => {
        requireLocalConsole(context);
        const body = asRecord(input);
        const operationId = requireString(body['operation_id'], 'operation_id');
        const record = recordOf(deps.recovery, operationId);
        const inspection = await deps.recovery.inspect(operationId);
        const observedAt = deps.now?.() ?? new Date().toISOString();
        return {
          record: {
            ...safeRecord(record),
            plan: inspection === null ? null : safeInspection(inspection).plan,
            plan_digest: inspection === null ? null : safeInspection(inspection).plan_digest,
            observed_at: observedAt,
          },
          inspection: inspection === null ? null : safeInspection(inspection),
          observed_at: observedAt,
        };
      },
    },
    {
      name: 'recovery.export_snapshot',
      required: RECOVERY_WRITE_CAPABILITY,
      handler: async (input, context) => {
        const actor = requireLocalConsole(context);
        const body = asRecord(input);
        const allowedKeys = new Set(['operation_id', 'item_id', 'snapshot', 'confirmed', 'subject', 'nonce']);
        const unknownKeys = Object.keys(body).filter((key) => !allowedKeys.has(key));
        if (unknownKeys.length > 0) {
          throw new BridgeError('INVALID_ARGUMENT', `快照导出包含不支持的字段：${unknownKeys.join('、')}。`);
        }
        requireConfirmed(body['confirmed'], 'recovery.export_snapshot');
        const operationId = requireString(body['operation_id'], 'operation_id');
        const itemId = requireString(body['item_id'], 'item_id');
        const snapshot = body['snapshot'];
        if (snapshot !== 'original' && snapshot !== 'proposed') {
          throw new BridgeError('INVALID_ARGUMENT', 'snapshot 只能是 original 或 proposed。');
        }
        const expectedSubject = `recovery-export:${operationId}:${itemId}:${snapshot}`;
        if (body['subject'] !== expectedSubject) {
          throw new BridgeError('INVALID_ARGUMENT', '快照导出的授权对象与请求目标不一致。');
        }

        const record = recordOf(deps.recovery, operationId);
        if (record.operation_state !== 'RECOVERY_REQUIRED') {
          throw new BridgeError('CHANGE_STATE_INVALID', '只有待人工恢复的操作可以导出恢复快照。');
        }
        const item = deps.repos.changes.items(record.change_id).find((entry) => entry.id === itemId);
        if (item === undefined) {
          throw new BridgeError('INVALID_ARGUMENT', 'item_id 不属于该恢复操作。');
        }
        const blobId = snapshot === 'original' ? item.old_blob_id : item.new_blob_id;
        if (blobId === null) {
          throw new BridgeError('INVALID_ARGUMENT', '新建文件没有原版本快照可导出。');
        }

        const blob = deps.repos.blobs.requireById(blobId);
        if (blob.size > LIMITS.MAX_EDITABLE_FILE_BYTES) {
          throw new BridgeError('SIZE_LIMIT_EXCEEDED', '恢复快照超过导出大小上限。');
        }
        // 原始字节只从受保护快照库读取，并由 BlobStore 校验登记的长度与哈希。
        const bytes = await deps.blobs.getVerified(blob);
        if (bytes.length > LIMITS.MAX_EDITABLE_FILE_BYTES) {
          throw new BridgeError('SIZE_LIMIT_EXCEEDED', '恢复快照超过导出大小上限。');
        }

        const pathLeaf = item.canonical_path.split('/').at(-1) ?? 'snapshot';
        const safeLeaf = pathLeaf.replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/[. ]+$/g, '') || 'snapshot';
        const fileName = `recovery-${safeLeaf}-${snapshot}.snapshot`;
        deps.repos.audit.append({
          subject: operationId,
          action: 'recovery.export_snapshot',
          outcome: 'allow',
          connection_id: actor,
          change_id: record.change_id,
          request_id: context.request_id,
          bytes_out: bytes.length,
          metadata: screenMetadata({
            operation_id: operationId,
            snapshot_version: snapshot,
          }),
        });
        return {
          operation_id: operationId,
          item_id: itemId,
          snapshot,
          file_name: fileName,
          content_type: 'application/octet-stream',
          sha256: blob.sha256,
          size: bytes.length,
          content_base64: bytes.toString('base64'),
        };
      },
    },
    {
      name: 'recovery.keep_current',
      required: RECOVERY_WRITE_CAPABILITY,
      handler: (input, context) => {
        const actor = requireLocalConsole(context);
        const body = asRecord(input);
        const operationId = requireString(body['operation_id'], 'operation_id');
        const itemId = requireString(body['item_id'], 'item_id');
        const record = recordOf(deps.recovery, operationId);
        if (!record.items.some((item) => item.item_id === itemId)) {
          throw new BridgeError('INVALID_ARGUMENT', 'item_id 不属于该恢复操作。');
        }
        appendRecoveryAudit(deps.repos, {
          action: 'recovery.keep_current',
          actor,
          operation_id: operationId,
          change_id: record.change_id,
          request_id: context.request_id,
          outcome: 'allow',
        });
        return { operation_id: operationId, item_id: itemId, state_unchanged: true };
      },
    },
    {
      name: 'recovery.repropose',
      required: RECOVERY_WRITE_CAPABILITY,
      handler: (input, context) => {
        const actor = requireLocalConsole(context);
        const body = asRecord(input);
        const operationId = requireString(body['operation_id'], 'operation_id');
        const itemId = requireString(body['item_id'], 'item_id');
        const record = recordOf(deps.recovery, operationId);
        if (!record.items.some((item) => item.item_id === itemId)) {
          throw new BridgeError('INVALID_ARGUMENT', 'item_id 不属于该恢复操作。');
        }
        appendRecoveryAudit(deps.repos, {
          action: 'recovery.repropose',
          actor,
          operation_id: operationId,
          change_id: record.change_id,
          request_id: context.request_id,
          outcome: 'allow',
        });
        return {
          operation_id: operationId,
          item_id: itemId,
          state_unchanged: true,
          next_action: 'CALL_CHANGE_PREPARE_WITH_CURRENT_CONTENT',
        };
      },
    },
    {
      name: 'recovery.authorize',
      required: RECOVERY_WRITE_CAPABILITY,
      handler: async (input, context) => {
        const actor = requireLocalConsole(context);
        const body = asRecord(input);
        requireConfirmed(body['confirmed'], 'recovery.authorize');
        const operationId = requireString(body['operation_id'], 'operation_id');
        const record = recordOf(deps.recovery, operationId);
        const issued = await deps.recovery.authorize({ operation_id: operationId, actor });
        appendRecoveryAudit(deps.repos, {
          action: 'recovery.authorize',
          actor,
          operation_id: operationId,
          change_id: record.change_id,
          request_id: context.request_id,
          outcome: 'allow',
        });
        return { operation_id: operationId, ...issued };
      },
    },
    {
      name: 'recovery.repair',
      required: RECOVERY_WRITE_CAPABILITY,
      handler: async (input, context) => {
        const actor = requireLocalConsole(context);
        const body = asRecord(input);
        requireConfirmed(body['confirmed'], 'recovery.repair');
        const operationId = requireString(body['operation_id'], 'operation_id');
        const authorizationId = requireString(body['authorization_id'], 'authorization_id');
        const record = recordOf(deps.recovery, operationId);
        const result = await deps.recovery.repair({ operation_id: operationId, authorization_id: authorizationId });
        appendRecoveryAudit(deps.repos, {
          action: 'recovery.repair',
          actor,
          operation_id: operationId,
          change_id: record.change_id,
          request_id: context.request_id,
          outcome: result.failed === null ? 'allow' : 'error',
          reason: result.failed === null ? null : 'REPAIR_FAILED',
        });
        return {
          operation_id: operationId,
          state: result.after,
          repaired: result.repaired,
          failed: result.failed,
          items: result.items,
        };
      },
    },
  ];

  for (const definition of definitions) registry.register(definition);
}
