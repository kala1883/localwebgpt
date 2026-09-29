import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const isWindows = process.platform === 'win32';
const repoRoot = path.resolve(import.meta.dirname, '../..');
const buildScriptSource = [
  path.join(repoRoot, 'deployment', 'windows', 'build-runtime.ps1'),
  path.join(repoRoot, 'packaging', 'windows', 'build-runtime.ps1'),
].find((candidate) => existsSync(candidate));
const describeRuntimeIntegrity = isWindows && buildScriptSource !== undefined ? describe : describe.skip;

describeRuntimeIntegrity('Windows runtime package integrity', () => {
  it('rejects a poisoned archive and matching sidecar before creating or executing package content', async () => {
    assert.ok(buildScriptSource, 'a Windows runtime builder must exist in a source checkout');
    const builderSource = await readFile(buildScriptSource, 'utf8');
    const pin = /\$pinnedTunnelArchiveHash\s*=\s*'(?<sha256>[0-9a-f]{64})'/i.exec(builderSource)?.groups?.sha256;
    assert.ok(pin, 'the runtime builder must contain a version-controlled archive hash, not trust its local sidecar');

    const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb-runtime-integrity-'));
    const sourceRoot = path.join(scratchRoot, 'source');
    const outputRoot = path.join(scratchRoot, 'runtime-output');
    const buildScript = path.join(sourceRoot, 'deployment', 'windows', 'build-runtime.ps1');
    const archiveName = 'tunnel-client-v0.0.15-windows-amd64.zip';
    const vendorRoot = path.join(sourceRoot, '.lwb-local', 'tunnel-client', 'v0.0.15');
    const archivePath = path.join(vendorRoot, archiveName);
    const checksumPath = path.join(vendorRoot, 'SHA256SUMS.txt');
    const sqlitePrebuild = path.join(sourceRoot, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');

    try {
      await mkdir(path.dirname(buildScript), { recursive: true });
      await mkdir(path.dirname(sqlitePrebuild), { recursive: true });
      await mkdir(vendorRoot, { recursive: true });
      await writeFile(buildScript, await readFile(buildScriptSource));
      await writeFile(sqlitePrebuild, 'test-only native placeholder\n', 'utf8');

      // Simulate an attacker who can replace both ignored local-cache files.
      // The sidecar is internally consistent with the fake archive, but neither
      // value equals the version-controlled expected hash in the build script.
      const poisonedArchive = Buffer.from('attacker-controlled tunnel-client archive', 'utf8');
      const poisonedHash = createHash('sha256').update(poisonedArchive).digest('hex');
      assert.notEqual(poisonedHash, pin);
      await writeFile(archivePath, poisonedArchive);
      await writeFile(checksumPath, `${poisonedHash}  ${archiveName}\n`, 'utf8');

      const result = spawnSync(
        'pwsh.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', buildScript, '-OutputDirectory', outputRoot],
        { cwd: sourceRoot, encoding: 'utf8', windowsHide: true },
      );
      assert.equal(result.error, undefined, result.error?.message);
      assert.notEqual(result.status, 0, 'poisoned archive/sidecar pair must be rejected');
      assert.match(`${result.stdout}\n${result.stderr}`, /version-pinned tunnel-client archive hash/i);
      assert.equal(existsSync(outputRoot), false);
    } finally {
      await rm(scratchRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
