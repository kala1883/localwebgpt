#!/usr/bin/env node
/** Build the local console without forwarding tunnel or IPC credentials. */

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
for (const name of [
  'CONTROL_PLANE_API_KEY',
  'CONTROL_PLANE_TUNNEL_ID',
  'OPENAI_API_KEY',
  'LWB_IPC_SECRET_MCP_ADAPTER',
  'LWB_IPC_SECRET_CONSOLE',
]) {
  delete env[name];
}

const child = spawn(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['--workspace', '@lwb/console', 'run', 'build'],
  {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    windowsHide: true,
    // npm.cmd is a Windows command shim; arguments above are fixed constants.
    shell: process.platform === 'win32',
  },
);

child.once('error', (error) => {
  process.stderr.write(`控制台构建无法启动：${error.message}\n`);
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  if (signal !== null) {
    process.stderr.write(`控制台构建被信号终止：${signal}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
