/** Only terminates the child started by this manager; never uses image-name wildcards. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';

export async function terminateCommandTree(
  child: ChildProcess,
  rootExited: boolean,
  env: NodeJS.ProcessEnv,
  waitMs = 3_000,
): Promise<boolean> {
  const pid = child.pid;
  // A departed root PID may have been reused. Do not signal it or claim an orphan tree was reaped.
  if (typeof pid !== 'number' || rootExited) return false;
  if (process.platform === 'win32') {
    const systemRoot = process.env['SystemRoot'] ?? process.env['WINDIR'];
    if (systemRoot === undefined) return false;
    return await runTerminationCommand(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], env, waitMs);
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    // Do not fall back to unrelated PIDs, kill-by-name, or a reset of the concurrency counter.
    return false;
  }
}

export async function runTerminationCommand(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  waitMs = 3_000,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let completed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess;
    const finish = (success: boolean) => {
      if (completed) return;
      completed = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(success);
    };
    try { child = spawn(executable, [...args], { env, stdio: 'ignore', windowsHide: true }); }
    catch { finish(false); return; }
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(false);
    }, waitMs);
    timer.unref?.();
  });
}
