/** Global platform sign-off facts are informational; workspace grants control access. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BRIDGE_CAPABILITY_FLAGS, BRIDGE_GATES, capabilityFlagsFrom, limitationsOf } from '../../apps/daemon/src/gates.ts';
import type { PlatformGates } from '../../apps/daemon/src/gates.ts';

const combinations: readonly PlatformGates[] = [false, true].flatMap((g0) =>
  [false, true].flatMap((native) =>
    [false, true].flatMap((compat) =>
      [false, true].map((g4) => ({
        g0_platform_verified: g0,
        native_guard_verified: native,
        compatibility_section3_passed: compat,
        g4_concurrency_fault_passed: g4,
      })),
    ),
  ),
);

describe('platform verification facts do not act as hidden global feature gates', () => {
  it('all verification combinations produce the same global capability availability', () => {
    assert.equal(combinations.length, 16);
    for (const gates of combinations) {
      assert.deepEqual(capabilityFlagsFrom(), {
        read_enabled: true,
        git_enabled: true,
        proposal_enabled: true,
        direct_write_enabled: true,
        recovery_required: false,
      });
    }
  });

  it('keeps incomplete verification visible without claiming the connection was verified', () => {
    assert.deepEqual(BRIDGE_GATES, {
      g0_platform_verified: false,
      native_guard_verified: false,
      compatibility_section3_passed: false,
      g4_concurrency_fault_passed: false,
    });
    assert.equal(BRIDGE_CAPABILITY_FLAGS.direct_write_enabled, true);
    assert.equal(BRIDGE_CAPABILITY_FLAGS.read_enabled, true);
    const lines = limitationsOf(BRIDGE_CAPABILITY_FLAGS, BRIDGE_GATES);
    assert.ok(lines.some((line) => line.includes('只作状态提示')));
    assert.ok(lines.some((line) => line.includes('显式授权的工作区')));
  });
});
