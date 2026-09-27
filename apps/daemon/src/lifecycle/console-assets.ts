/**
 * Read the built console into a fixed URL-to-bytes map.
 *
 * This module is in lifecycle/ because it is the process boundary that reads
 * packaged files. The control server receives only the enumerated byte map;
 * request paths are never joined to a filesystem path.
 */

import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StaticControlAsset } from '../control/server.ts';

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export class ConsoleAssetsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleAssetsError';
  }
}

function builtConsoleRoot(): string {
  return path.resolve(fileURLToPath(new URL('../../../console/dist/', import.meta.url)));
}

async function readAsset(filePath: string, relativePath: string): Promise<Buffer> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ConsoleAssetsError(`控制台资产不是普通文件：${relativePath}`);
  }
  if (metadata.size > MAX_ASSET_BYTES) {
    throw new ConsoleAssetsError(`控制台资产超过 ${String(MAX_ASSET_BYTES)} 字节：${relativePath}`);
  }
  return readFile(filePath);
}

/** 只装入 dist/index.html 与 dist/assets/ 下的安全文件名。 */
export async function loadConsoleAssets(
  root = builtConsoleRoot(),
): Promise<ReadonlyMap<string, StaticControlAsset>> {
  const assets = new Map<string, StaticControlAsset>();
  let totalBytes = 0;
  const indexPath = path.join(root, 'index.html');
  try {
    const body = await readAsset(indexPath, 'index.html');
    totalBytes += body.byteLength;
    assets.set('/index.html', { body, content_type: CONTENT_TYPES['.html'] ?? 'application/octet-stream' });
  } catch (error) {
    if (error instanceof ConsoleAssetsError) throw error;
    throw new ConsoleAssetsError('找不到已构建的控制台 index.html；请先执行 console build。');
  }

  const assetsRoot = path.join(root, 'assets');
  let entries;
  try {
    entries = await readdir(assetsRoot, { withFileTypes: true });
  } catch {
    throw new ConsoleAssetsError('找不到已构建的控制台 assets 目录；请先执行 console build。');
  }

  for (const entry of entries) {
    // Vite 的发布目录是平的。拒绝子目录与链接，避免 loader 扩成通用文件读取器。
    if (entry.isSymbolicLink() || !entry.isFile() || !/^[A-Za-z0-9._-]+$/.test(entry.name)) {
      throw new ConsoleAssetsError(`控制台 assets 目录含不支持的条目：${entry.name}`);
    }
    const extension = path.extname(entry.name).toLowerCase();
    const contentType = CONTENT_TYPES[extension];
    if (contentType === undefined) {
      throw new ConsoleAssetsError(`控制台资产扩展名不受支持：${extension || '(无扩展名)'}`);
    }
    const relativePath = `assets/${entry.name}`;
    const body = await readAsset(path.join(assetsRoot, entry.name), relativePath);
    totalBytes += body.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new ConsoleAssetsError(`控制台构建产物总量超过 ${String(MAX_TOTAL_BYTES)} 字节。`);
    }
    assets.set(`/${relativePath}`, { body, content_type: contentType });
  }

  if (![...assets.keys()].some((key) => key.endsWith('.js'))) {
    throw new ConsoleAssetsError('控制台构建产物没有 JavaScript 入口文件。');
  }
  return assets;
}
