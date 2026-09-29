import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildIdFromEnvironment } from '../../apps/daemon/src/runtime/build-info.ts';

describe('bridge build identity', () => {
  it('accepts and normalizes a packaged source-manifest fingerprint', () => {
    const fingerprint = 'a'.repeat(64);
    assert.equal(
      buildIdFromEnvironment({ LWB_BUILD_ID: `sha256:${fingerprint.toUpperCase()}` }),
      `sha256:${fingerprint}`,
    );
  });

  it('does not expose malformed or user-supplied arbitrary values as a build identity', () => {
    assert.equal(buildIdFromEnvironment({}), 'source-checkout');
    assert.equal(buildIdFromEnvironment({ LWB_BUILD_ID: 'C:\\Users\\mj\\secret' }), 'source-checkout');
    assert.equal(buildIdFromEnvironment({ LWB_BUILD_ID: `sha256:${'a'.repeat(63)}` }), 'source-checkout');
  });
});
