import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandProcessManager } from '../../apps/daemon/src/lifecycle/command-processes.ts';
import type { ChildProcess } from 'node:child_process';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('late confirmation did not arrive'); await delay(10); }
}

test('real Windows child exit plus delayed termination acknowledgement reports late confirmation exactly once',
  {skip:process.platform !== 'win32',timeout:10000}, async () => {
    let child: ChildProcess | undefined;
    let confirmations = 0;
    const abort = new AbortController();
    const manager = new CommandProcessManager({
      termination_wait_ms: 50,
      // The command below has no spawned descendants. Delay ONLY the acknowledgement,
      // after actually stopping the exact process owned by this test.
      terminate_tree: async owned => {
        child = owned;
        const stopped = owned.kill();
        await delay(400);
        return stopped;
      },
    });
    try {
      const result = await manager.run({
        shell:'powershell',command:'Start-Sleep -Seconds 30',cwd:process.cwd(),signal:abort.signal,
        on_started:() => abort.abort(),on_termination_confirmed:() => { confirmations++; },
      });
      assert.equal(result.termination_unknown,true);
      assert.equal(confirmations,0);
      await until(() => confirmations === 1);
      assert.equal(result.termination_unknown,true); // Never rewrite the result already delivered.
      await delay(50); assert.equal(confirmations,1);
      await manager.terminateAll(); // No false permanent unknown-process counter remains.
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
