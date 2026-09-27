/**
 * 夹具访问入口（供测试与本地验证脚本使用）。
 *
 * 设计原则：测试**不允许**自己凭空造路径或断言自己以为的字节。
 * 所有关于夹具的期望值都必须来自 build-fixtures.ts 生成的 manifest.json，
 * 这样「测试通过」才真的对应「生成器产出的那份字节」。
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const GENERATED_DIR = path.join(here, 'generated');
export const TESTREPO_DIR = path.join(GENERATED_DIR, 'testrepo');
export const CANARY_DIR = path.join(GENERATED_DIR, 'outside-canary');
export const MANIFEST_PATH = path.join(GENERATED_DIR, 'manifest.json');

export interface FixtureFileEntry {
  relPath: string;
  sha256: string;
  bytes: number;
  gitState:
    | 'committed_and_modified'
    | 'committed'
    | 'staged'
    | 'untracked'
    | 'deleted'
    | 'ignored_by_lwb_policy';
  editable: boolean;
  note: string;
  lineCount: number | null;
  hasBom: boolean;
  newline: 'lf' | 'crlf' | 'mixed' | 'none';
  contentKind: 'text' | 'binary-ish';
}

export interface FixtureManifest {
  generated_by: string;
  fixture_version: number;
  note: string;
  repo_root: string;
  canary_root: string;
  canary_sha256: string;
  head_commit: string;
  git_status_porcelain: string[];
  files: FixtureFileEntry[];
}

/** 确保夹具存在；不存在则同步构建（只构建一次，进程内缓存）。 */
export function ensureFixtures(): void {
  if (existsSync(MANIFEST_PATH)) return;
  execFileSync(process.execPath, ['--import', 'tsx', path.join(here, 'build-fixtures.ts')], {
    cwd: path.resolve(here, '..', '..'),
    stdio: 'inherit',
  });
}

export async function loadManifest(): Promise<FixtureManifest> {
  ensureFixtures();
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as FixtureManifest;
}

/** 把夹具相对路径解析为测试仓库内的绝对路径。 */
export function repoPath(relPath: string): string {
  return path.join(TESTREPO_DIR, ...relPath.split('/'));
}

export function findFile(manifest: FixtureManifest, relPath: string): FixtureFileEntry {
  const entry = manifest.files.find((f) => f.relPath === relPath);
  if (!entry) throw new Error(`夹具清单中没有 ${relPath}`);
  return entry;
}

export function filesWithState(
  manifest: FixtureManifest,
  state: FixtureFileEntry['gitState'],
): FixtureFileEntry[] {
  return manifest.files.filter((f) => f.gitState === state);
}

/** 读取授权外金丝雀的当前哈希，用于断言「范围外文件未被改动」。 */
export async function canarySha256(): Promise<string> {
  const { createHash } = await import('node:crypto');
  const bytes = await readFile(path.join(CANARY_DIR, 'canary.txt'));
  return createHash('sha256').update(bytes).digest('hex');
}
