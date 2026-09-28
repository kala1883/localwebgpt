import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const releaseRoot = path.join(repoRoot, 'docs/release');

describe('LWB-045 release evidence artifacts', () => {
  it('contains a valid SPDX inventory for the locked dependency graph', () => {
    const sbomText = readFileSync(path.join(releaseRoot, 'sbom.json'), 'utf8');
    const sbom = JSON.parse(sbomText) as {
      spdxVersion?: string;
      packages?: readonly { name?: string; versionInfo?: string }[];
    };

    assert.equal(sbom.spdxVersion, 'SPDX-2.3');
    assert.ok((sbom.packages?.length ?? 0) > 100, 'workspace dependency inventory should not be empty or truncated');
    assert.doesNotMatch(sbomText, /(?:^|\s)[A-Z]:\\Users\\/i, 'SBOM must not embed a developer profile path');
    assert.doesNotMatch(sbomText, /file:\/\/\/(?:Users|home)\//i, 'SBOM must not embed a local package source URL');
    assert.ok(
      sbom.packages?.some((pkg) => pkg.name === 'local-workspace-bridge' && pkg.versionInfo === '0.1.0'),
      'SBOM must describe the product root package',
    );
  });

  it('binds the record to the current source snapshot and SBOM without exposing absolute paths', () => {
    const record = readFileSync(path.join(releaseRoot, 'build-record.md'), 'utf8');
    const lockfileHash = createHash('sha256')
      .update(readFileSync(path.resolve(import.meta.dirname, '../../package-lock.json')))
      .digest('hex');
    // Git may check this tracked JSON out with CRLF on Windows although the
    // build record was generated from LF bytes. Hash the canonical text so the
    // evidence remains stable across checkout line-ending conversions.
    const sbomCanonical = readFileSync(path.join(releaseRoot, 'sbom.json'), 'utf8').replace(/\r\n/g, '\n');
    const sbomHash = createHash('sha256')
      .update(sbomCanonical, 'utf8')
      .digest('hex');

    assert.match(record, /Source commit: `(?:[0-9a-f]{40}|unavailable)`/);
    assert.match(record, /Source manifest SHA-256: `[0-9a-f]{64}`/);
    assert.ok(record.includes('package-lock.json SHA-256: `' + lockfileHash + '`'));
    assert.ok(record.includes('SPDX SBOM SHA-256: `' + sbomHash + '`'));
    assert.match(record, /not a digital signature/);
    assert.doesNotMatch(record, /(?:^|\s)[A-Z]:\\Users\\/i);
  });

  it('fingerprints a dirty source tree with a tracked file deletion and an untracked replacement', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'lwb-release-source-migration-'));
    const sourceRoot = path.join(fixtureRoot, 'source');
    const runtimeRoot = path.join(fixtureRoot, 'runtime');
    const outputDirectory = path.join(runtimeRoot, 'docs', 'release');
    const trackedFile = path.join(sourceRoot, 'packaging', 'windows', 'old-launcher.ps1');
    const replacementFile = path.join(sourceRoot, 'scripts', 'windows', 'launcher.ps1');
    mkdirSync(path.dirname(trackedFile), { recursive: true });
    mkdirSync(path.dirname(replacementFile), { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(trackedFile, 'old launcher\n');

    const runGit = (args: readonly string[]): void => {
      const result = spawnSync('git', args, { cwd: sourceRoot, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    };

    try {
      runGit(['init', '--quiet']);
      runGit(['add', '--', 'packaging/windows/old-launcher.ps1']);
      runGit([
        '-c', 'user.name=LocalWebGPT test',
        '-c', 'user.email=lwb-release-test@example.invalid',
        'commit', '--quiet', '-m', 'fixture source',
      ]);
      rmSync(trackedFile);
      writeFileSync(replacementFile, 'replacement launcher\n');

      writeFileSync(
        path.join(runtimeRoot, 'package.json'),
        JSON.stringify({ name: 'lwb-runtime-fixture', version: '1.2.3', private: true }),
      );
      writeFileSync(
        path.join(runtimeRoot, 'package-lock.json'),
        JSON.stringify({
          name: 'lwb-runtime-fixture',
          version: '1.2.3',
          lockfileVersion: 3,
          requires: true,
          packages: { '': { name: 'lwb-runtime-fixture', version: '1.2.3' } },
        }),
      );
      writeFileSync(path.join(runtimeRoot, 'payload.txt'), 'runtime payload fixture\n');

      const npmExecPath = process.env['npm_execpath'];
      const viaNpmScript = typeof npmExecPath === 'string' && npmExecPath.length > 0;
      const result = spawnSync(
        viaNpmScript ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm',
        viaNpmScript
          ? [
            npmExecPath!,
            'run',
            'release:evidence',
            '--',
            `--source-root=${sourceRoot}`,
            `--runtime-root=${runtimeRoot}`,
            `--output-dir=${outputDirectory}`,
          ]
          : [
            'run',
            'release:evidence',
            '--',
            `--source-root=${sourceRoot}`,
            `--runtime-root=${runtimeRoot}`,
            `--output-dir=${outputDirectory}`,
          ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          ...(!viaNpmScript && process.platform === 'win32' ? { shell: true } : {}),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const record = readFileSync(path.join(outputDirectory, 'build-record.md'), 'utf8');
      assert.match(record, /Source working tree: dirty/);
      assert.match(record, /Source manifest SHA-256: `[0-9a-f]{64}` \(1 files;/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('build mode fingerprints a runtime payload and records pinned binary hashes', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'lwb-release-runtime-'));
    const runtimeRoot = path.join(fixtureRoot, 'runtime');
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(
      path.join(runtimeRoot, 'package.json'),
      JSON.stringify({ name: 'lwb-runtime-fixture', version: '1.2.3', private: true }),
    );
    writeFileSync(
      path.join(runtimeRoot, 'package-lock.json'),
      JSON.stringify({
        name: 'lwb-runtime-fixture',
        version: '1.2.3',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'lwb-runtime-fixture', version: '1.2.3' } },
      }),
    );
    writeFileSync(path.join(runtimeRoot, 'payload.txt'), 'runtime payload fixture\n');

    try {
      const npmExecPath = process.env['npm_execpath'];
      const viaNpmScript = typeof npmExecPath === 'string' && npmExecPath.length > 0;
      const result = spawnSync(
        viaNpmScript ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm',
        viaNpmScript
          ? [
            npmExecPath!,
            'run',
            'release:evidence',
            '--',
            `--source-root=${repoRoot}`,
            `--runtime-root=${runtimeRoot}`,
            `--output-dir=${path.join(runtimeRoot, 'docs', 'release')}`,
            `--sqlite-prebuild-sha256=${'a'.repeat(64)}`,
            `--tunnel-client-sha256=${'b'.repeat(64)}`,
          ]
          : [
            'run',
            'release:evidence',
            '--',
            `--source-root=${repoRoot}`,
            `--runtime-root=${runtimeRoot}`,
            `--output-dir=${path.join(runtimeRoot, 'docs', 'release')}`,
            `--sqlite-prebuild-sha256=${'a'.repeat(64)}`,
            `--tunnel-client-sha256=${'b'.repeat(64)}`,
          ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          ...(!viaNpmScript && process.platform === 'win32' ? { shell: true } : {}),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const record = readFileSync(path.join(runtimeRoot, 'docs', 'release', 'build-record.md'), 'utf8');
      assert.match(record, /Evidence type: packaged-runtime evidence/);
      assert.match(record, /Runtime package: `lwb-runtime-fixture@1\.2\.3`/);
      assert.match(record, /Runtime payload manifest SHA-256: `[0-9a-f]{64}` \(3 files/);
      assert.ok(record.includes(`tunnel-client executable SHA-256: \`${'b'.repeat(64)}\``));
      assert.ok(record.includes(`better-sqlite3 Windows x64 prebuild SHA-256: \`${'a'.repeat(64)}\``));
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
