/** Local snapshot quota: a useful default plus an immutable upper ceiling. */

export const SNAPSHOT_STORE_MAX_BYTES_ENV = 'LWB_SNAPSHOT_STORE_MAX_BYTES';
export const DEFAULT_SNAPSHOT_STORE_MAX_BYTES = 1024 * 1024 * 1024;
export const HARD_MAX_SNAPSHOT_STORE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Resolve the per-user local setting. Operators may lower or raise the default,
 * but can never configure a value above the hard ceiling. Invalid settings fail
 * startup rather than silently removing the storage bound.
 */
export function snapshotStoreMaxBytesFromEnvironment(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SNAPSHOT_STORE_MAX_BYTES;
  const normalized = raw.trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error(`${SNAPSHOT_STORE_MAX_BYTES_ENV} 必须是十进制正整数（字节）。`);
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value > HARD_MAX_SNAPSHOT_STORE_BYTES) {
    throw new Error(
      `${SNAPSHOT_STORE_MAX_BYTES_ENV} 超过硬上限 ${HARD_MAX_SNAPSHOT_STORE_BYTES} 字节；` +
        '请收紧配置或清理已过保留期的快照。',
    );
  }
  return value;
}
