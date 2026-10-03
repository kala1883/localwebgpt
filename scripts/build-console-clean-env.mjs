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

const npmArguments = ['--workspace', '@lwb/console', 'run', 'build'];
const isWindows = process.platform === 'win32';
const npmCli = process.env['npm_execpath'] ??
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const child = spawn(
  isWindows ? process.execPath : 'npm',
  isWindows ? [npmCli, ...npmArguments] : npmArguments,
  {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    windowsHide: true,
    // Run npm's JS entry point directly on Windows, avoiding cmd/shell shims.
    shell: false,
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
