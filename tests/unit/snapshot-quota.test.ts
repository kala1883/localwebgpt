import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_SNAPSHOT_STORE_MAX_BYTES,
  HARD_MAX_SNAPSHOT_STORE_BYTES,
  snapshotStoreMaxBytesFromEnvironment,
} from '../../apps/daemon/src/runtime/snapshot-quota.ts';

describe('LWB-038 local snapshot quota configuration', () => {
  it('defaults to a bounded store and permits an operator-selected value under the hard ceiling', () => {
    assert.equal(snapshotStoreMaxBytesFromEnvironment(undefined), DEFAULT_SNAPSHOT_STORE_MAX_BYTES);
    assert.equal(snapshotStoreMaxBytesFromEnvironment('268435456'), 268_435_456);
    assert.equal(snapshotStoreMaxBytesFromEnvironment(String(HARD_MAX_SNAPSHOT_STORE_BYTES)), HARD_MAX_SNAPSHOT_STORE_BYTES);
  });

  it('rejects malformed, zero, unsafe, or above-ceiling values instead of silently removing the bound', () => {
    for (const raw of ['', '0', '-1', '1e9', 'NaN', String(HARD_MAX_SNAPSHOT_STORE_BYTES + 1)]) {
      assert.throws(() => snapshotStoreMaxBytesFromEnvironment(raw), /LWB_SNAPSHOT_STORE_MAX_BYTES/);
    }
  });
});
