#!/usr/bin/env node
/**
 * 测试运行器。
 *
 * 存在的理由：Node 的 `--test` glob 支持在不同小版本上行为不一致，
 * 而本工程需要按目录（tests/unit、tests/windows、tests/security …）
 * 与按任务号筛选。这里显式收集文件再交给 `node --test`，
 * 保证在 Windows 与 CI 上得到同样结果。
 *
 * 用法：
 *   node scripts/run-tests.mjs                  # 全部测试
 *   node scripts/run-tests.mjs tests/unit       # 只跑某个目录
 *   node scripts/run-tests.mjs --grep LWB-010   # 只跑文件名/内容含该串的测试
 */

import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_ROOTS = ['tests', 'packages', 'apps', 'native'];

/** 这些目录不参与测试收集。 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'generated',
  'coverage',
  'winfs-spike',
]);

const args = process.argv.slice(2);
let grep = null;
const explicitRoots = [];

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--grep') {
    grep = args[i + 1] ?? null;
    i += 1;
  } else if (arg.startsWith('--grep=')) {
    grep = arg.slice('--grep='.length);
  } else {
    explicitRoots.push(arg);
  }
}

const roots = explicitRoots.length > 0 ? explicitRoots : DEFAULT_ROOTS;

async function collect(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await collect(full)));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

let files = [];
for (const root of roots) {
  const abs = path.resolve(repoRoot, root);
  if (!existsSync(abs)) continue;
  files.push(...(await collect(abs)));
}

files = [...new Set(files)].sort();

if (grep) {
  const needle = grep.toLowerCase();
  const filtered = [];
  for (const file of files) {
    if (file.toLowerCase().includes(needle)) {
      filtered.push(file);
      continue;
    }
    const content = await readFile(file, 'utf8');
    if (content.toLowerCase().includes(needle)) filtered.push(file);
  }
  files = filtered;
}

if (files.length === 0) {
  console.error('未找到匹配的测试文件。');
  process.exit(explicitRoots.length > 0 || grep ? 1 : 0);
}

console.log(`运行 ${files.length} 个测试文件：`);
for (const file of files) {
  console.log(`  - ${path.relative(repoRoot, file)}`);
}
console.log('');

const relativeFiles = files.map((f) => path.relative(repoRoot, f));

const child = spawn(
  process.execPath,
  ['--test', '--import', 'tsx', ...relativeFiles],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  },
);

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`测试进程被信号终止：${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
