/** Local operator recovery. No MCP route, no process kill, no blind slot reset. */
import { z } from 'zod';
import { BridgeError } from '@lwb/contracts';
import type { OperationRegistry } from '@lwb/ipc';
import type { Repositories } from '@lwb/persistence';
import type { CommandJobManager } from '../lifecycle/command-jobs.ts';
import { CommandJobFailure } from '../lifecycle/command-job-store.ts';
import type { ControlRouteTable } from './routes.ts';

// Identity is the per-daemon operation registry; never a process-global manager.
const bindings = new WeakMap<OperationRegistry, { jobs: CommandJobManager; repos: Repositories }>();
export function bindCommandRecovery(registry: OperationRegistry, jobs: CommandJobManager, repos: Repositories): void {
  if (bindings.has(registry)) throw new Error('Command recovery is already bound to this runtime.');
  bindings.set(registry, { jobs, repos });
}
const jobId = z.string().regex(/^job_[0-9a-f-]{36}$/);
const recoveryInput = z.strictObject({
  job_id: jobId,
  expected_updated_at: z.string().min(1),
  confirmation_job_id: jobId,
  verified_all_processes_stopped: z.literal(true),
  basis: z.enum(['process_tree_checked', 'os_reboot_verified']),
  // The control server verifies and consumes these before dispatching the handler.
  subject: z.string().optional(),
  nonce: z.string().optional(),
});
export function registerCommandRecoveryRoutes(table: ControlRouteTable, registry: OperationRegistry): void {
  const binding = bindings.get(registry);
  if (binding === undefined) return; // Unit/embedded control planes may have no command driver.
  const { jobs, repos } = binding;
  table.register({
    method: 'GET', path: '/api/commands/jobs', capability: 'changes.read', mutating: false,
    handler: () => {
      const records = jobs.localRecords().filter((r) => r.state === 'TERMINATION_UNKNOWN' || r.state === 'RECOVERED_UNKNOWN')
        .sort((a, b) => Number(a.state === 'RECOVERED_UNKNOWN') - Number(b.state === 'RECOVERED_UNKNOWN') || a.created_at.localeCompare(b.created_at));
      return {
        jobs: records.slice(0, 100).map((record) => ({
          ...jobs.view(record.owner, record.job_id),
          connection_alias: repos.connections.findById(record.owner.connection_id)?.alias ?? record.owner.connection_id,
          workspace_name: repos.workspaces.findById(record.workspace_id)?.alias ?? record.workspace_id,
        })),
        truncated: records.length > 100,
        recovery_rule: 'LOCAL_VERIFICATION_REQUIRED',
        business_result: 'UNKNOWN',
      };
    },
  });
  table.register({
    method: 'POST', path: '/api/commands/recover', capability: 'approvals.decide', mutating: true,
    handler: ({ body, session }) => {
      const parsed = recoveryInput.safeParse(body);
      if (!parsed.success || parsed.data.confirmation_job_id !== parsed.data.job_id ||
          (parsed.data.subject !== undefined && parsed.data.subject !== parsed.data.job_id)) {
        throw new BridgeError('INVALID_ARGUMENT', '必须逐项核验全部相关进程已停止，并填写同一任务编号；不能默认确认。');
      }
      const input = parsed.data;
      const record = jobs.localRecords().find((r) => r.job_id === input.job_id);
      if (record === undefined) throw new BridgeError('NOT_FOUND', '没有找到该任务。');
      try {
        return jobs.resolveUnknown(record.owner, record.job_id, input.expected_updated_at, {
          source: 'local_operator', basis: input.basis, actor: 'console:' + session.session_id,
        });
      } catch (error) {
        if (error instanceof CommandJobFailure) throw new BridgeError(error.code, error.message);
        throw error;
      }
    },
  });
}
