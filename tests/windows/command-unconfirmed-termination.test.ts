import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandProcessManager } from '../../apps/daemon/src/lifecycle/command-processes.ts';
import type { ChildProcess } from 'node:child_process';

test('root exit without successful tree acknowledgement retains unknown termination and never sends recovery proof',
  {skip:process.platform !== 'win32',timeout:10000}, async () => {
    let child: ChildProcess | undefined;
    let confirmations = 0;
    const abort = new AbortController();
    const manager = new CommandProcessManager({
      termination_wait_ms:100,
      terminate_tree: async owned => {
        child = owned;
        owned.kill(); // Only this test's simple child is stopped; intentionally withhold tree acknowledgement.
        return false;
      },
    });
    try {
      const result = await manager.run({
        shell:'powershell',command:'Start-Sleep -Seconds 30',cwd:process.cwd(),signal:abort.signal,
        on_started:() => abort.abort(),on_termination_confirmed:() => {confirmations++;},
      });
      assert.equal(result.termination_unknown,true);
      await new Promise(resolve=>setTimeout(resolve,250));
      assert.equal(confirmations,0);
      await assert.rejects(manager.terminateAll(), /termination could not be confirmed/);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
