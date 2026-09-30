import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

/** Protected configuration file I/O stays inside the secure-store boundary. */
export class ProtectedConfigurationFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectedConfigurationFileError';
  }
}

/** Return null only when the configuration file does not exist. */
export function readProtectedJsonConfiguration(filePath: string): string | null {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ProtectedConfigurationFileError('受保护 JSON 配置必须是普通文件。');
    }
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error instanceof ProtectedConfigurationFileError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw new ProtectedConfigurationFileError('无法读取受保护 JSON 配置。');
  }
}

/** Write a complete JSON document through a same-directory atomic rename. */
export function writeProtectedJsonConfiguration(filePath: string, contents: string): void {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, contents, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, filePath);
  } catch {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* Preserve the write error. */ }
    }
    try { unlinkSync(temporaryPath); } catch { /* A successful rename already consumed the temporary file. */ }
    throw new ProtectedConfigurationFileError('无法原子保存受保护 JSON 配置。');
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
