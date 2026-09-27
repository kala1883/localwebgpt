#!/usr/bin/env node
/** Explicit opt-in launcher for the resource-intensive LWB-044 NTFS benchmark. */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', 'tests/performance/lwb-044.test.ts'],
  {
    cwd: repoRoot,
    env: { ...process.env, LWB_PERF_RUN: '1' },
    stdio: 'inherit',
    windowsHide: true,
  },
);

if (result.error) {
  process.stderr.write(`LWB-044 benchmark failed to start: ${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
