import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { describe, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { acquireSingleInstance } from '@lwb/ipc';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;
const STOP_SCRIPT = fileURLToPath(new URL('../../scripts/windows/Stop-LocalWebGPT.ps1', import.meta.url));

function currentUserSid(): string {
  const output = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const sid = /"(?<sid>S-1-[^"]+)"/.exec(output)?.groups?.sid;
  if (sid === undefined) throw new Error('whoami did not return the current Windows user SID.');
  return sid;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PSModulePath', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function runStopScript(): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', STOP_SCRIPT], {
    env: childEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });

  return awaitableChildResult(child, () => ({ stdout, stderr }));
}

function awaitableChildResult(
  child: ReturnType<typeof spawn>,
  output: () => { readonly stdout: string; readonly stderr: string },
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, ...output() });
    });
  });
}

describeWindows('Windows LocalWebGPT stop command E2E', () => {
  it('sends the SID-scoped request and receives the bounded STOPPING acknowledgement', async (context: TestContext) => {
    const instance = await acquireSingleInstance({ userSid: currentUserSid(), onConnection: (socket) => socket.destroy() });
    if (instance.kind === 'occupied') {
      context.skip('A LocalWebGPT instance already owns this user pipe; the test does not contact it.');
      return;
    }

    try {
      const result = await runStopScript();
      assert.equal(result.code, 0, 'the stop client must exit successfully after the server acknowledges');
      assert.equal(result.signal, null);
      await instance.stop_requested;
    } finally {
      await new Promise<void>((resolve) => instance.server.close(() => resolve()));
    }
  });
});
