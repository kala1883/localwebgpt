/** 历史控制操作（LWB-037）：从真实状态库读取执行终态与审计事件。 */

import { BridgeError } from '@lwb/contracts';
import type { OperationDefinition, OperationRegistry, RequestContext } from '@lwb/ipc';
import type { Repositories } from '@lwb/persistence';

import { originOf } from './workspaces.ts';

export const HISTORY_READ_CAPABILITY = 'audit.read' as const;

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BridgeError('INVALID_ARGUMENT', '历史查询需要一个对象参数。');
  }
  return input as Record<string, unknown>;
}

function requireLocalConsole(context: RequestContext): void {
  if (originOf(context) !== 'local_console') {
    throw new BridgeError('NOT_AUTHORIZED', '只有本地控制台可以读取历史。', { reason: 'ORIGIN_NOT_LOCAL' });
  }
}

export function registerHistoryOperations(registry: OperationRegistry, deps: { readonly repos: Repositories }): void {
  const definition: OperationDefinition = {
    name: 'history.list',
    required: HISTORY_READ_CAPABILITY,
    handler: (input, context) => {
      requireLocalConsole(context);
      const body = input === undefined || input === null ? {} : asRecord(input);
      const rawLimit = body['limit'];
      if (rawLimit !== undefined && (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit))) {
        throw new BridgeError('INVALID_ARGUMENT', '字段 limit 必须是整数。');
      }
      const limit = typeof rawLimit === 'number' ? rawLimit : 50;
      const operations = deps.repos.operations.listRecent(limit).map((operation) => {
        const change = deps.repos.changes.findById(operation.change_id);
        return {
          operation_id: operation.id,
          change_id: operation.change_id,
          workspace_id: change?.workspace_id ?? '',
          operation_state: operation.state,
          change_state: change?.state ?? 'UNKNOWN',
          recovered: operation.recovered,
          created_at: operation.created_at,
          started_at: operation.started_at,
          finished_at: operation.finished_at,
        };
      });
      return {
        operations,
        audit: deps.repos.audit.list({ limit }),
        observed_at: new Date().toISOString(),
      };
    },
  };
  registry.register(definition);
}

