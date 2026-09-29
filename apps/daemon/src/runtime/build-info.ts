/**
 * Build identity shown by `bridge_status` for deployment diagnostics.
 *
 * The packaged launcher passes a source-manifest fingerprint, not an absolute
 * path or credential. A source checkout intentionally reports only the generic
 * label; the value is a diagnostic hint, not a signature or authorization input.
 */

const PACKAGED_BUILD_ID = /^sha256:[0-9a-f]{64}$/i;

export function buildIdFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const candidate = env['LWB_BUILD_ID']?.trim() ?? '';
  return PACKAGED_BUILD_ID.test(candidate) ? candidate.toLowerCase() : 'source-checkout';
}
