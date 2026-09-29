#!/usr/bin/env node
/**
 * Generate a lockfile SPDX SBOM and source/runtime fingerprint record.
 *
 * The record is evidence about exactly the bytes in the selected tree; it is
 * not a code-signature and does not claim that an independent reviewer passed
 * the security or release gates.
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELEASE_SUBDIR = 'docs/release';

function parseArguments(args) {
  const options = {};
  for (const arg of args) {
    const match = /^--([a-z0-9-]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`Invalid argument: ${arg}`);
    const [, key, value] = match;
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate argument: --${key}`);
    options[key] = value;
  }
  return options;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256(readFileSync(filePath));
}

function execText(file, args, cwd) {
  return execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function runNpm(args, cwd) {
  const npmExecPath = process.env['npm_execpath'];
  const fromNpmScript = typeof npmExecPath === 'string' && npmExecPath.length > 0;
  return spawnSync(
    fromNpmScript ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm',
    fromNpmScript ? [npmExecPath, ...args] : args,
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(!fromNpmScript && process.platform === 'win32' ? { shell: true } : {}),
    },
  );
}

function gitSourceState(sourceRoot) {
  const commit = execText('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], sourceRoot);
  const status = execText(
    'git',
    ['-C', sourceRoot, 'status', '--porcelain', '--untracked-files=normal'],
    sourceRoot,
  );
  const files = execFileSync(
    'git',
    ['-C', sourceRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: sourceRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.length > 0)
    .filter((entry) => !entry.replaceAll('\\', '/').startsWith(`${RELEASE_SUBDIR}/`));

  let presentFileCount = 0;
  const entries = files.map((relativePath) => {
    const fullPath = path.resolve(sourceRoot, relativePath);
    const relativeCheck = path.relative(sourceRoot, fullPath);
    if (relativeCheck === '..' || relativeCheck.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCheck)) {
      throw new Error('Git source manifest contains a path outside the source root.');
    }
    try {
      const stat = lstatSync(fullPath);
      const digest = stat.isSymbolicLink()
        ? sha256(`symlink:${readlinkSync(fullPath)}`)
        : sha256File(fullPath);
      presentFileCount += 1;
      return `${relativePath.replaceAll('\\', '/')}\0${digest}\n`;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        // `git ls-files --cached` includes tracked files deleted in a dirty
        // worktree. Bind the absence into the manifest instead of failing or
        // silently treating the source tree as if the path never existed.
        return `${relativePath.replaceAll('\\', '/')}\0<deleted-in-worktree>\n`;
      }
      throw error;
    }
  });

  return {
    commit,
    dirty: status.length > 0,
    fileCount: presentFileCount,
    manifestSha256: sha256(entries.sort().join('')),
  };
}

function walkPayload(root, outputDirectory) {
  const outputRelative = path.relative(root, outputDirectory);
  const entries = [];

  const visit = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, item.name);
      const relativePath = path.relative(root, fullPath);
      if (relativePath === outputRelative || relativePath.startsWith(`${outputRelative}${path.sep}`)) continue;
      if (item.name === '.git') continue;
      if (item.isDirectory()) {
        visit(fullPath);
      } else {
        const stat = lstatSync(fullPath);
        const digest = stat.isSymbolicLink()
          ? sha256(`symlink:${readlinkSync(fullPath)}`)
          : sha256File(fullPath);
        entries.push(`${relativePath.replaceAll('\\', '/')}\0${digest}\n`);
      }
    }
  };

  visit(root);
  entries.sort();
  return { fileCount: entries.length, manifestSha256: sha256(entries.join('')) };
}

function npmSbom(runtimeRoot) {
  const result = runNpm(
    ['sbom', '--package-lock-only', '--omit=dev', '--sbom-format=spdx', '--sbom-type=application'],
    runtimeRoot,
  );
  if (result.error || result.status !== 0) {
    throw new Error(`npm sbom failed${result.status === null ? '' : ` (exit ${String(result.status)})`}.`);
  }
  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch {
    throw new Error('npm sbom did not return valid JSON.');
  }
  if (document.spdxVersion !== 'SPDX-2.3' || !Array.isArray(document.packages) || document.packages.length === 0) {
    throw new Error('npm sbom output lacks the expected SPDX-2.3 package inventory.');
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

function writePackagedBuildInfo(runtimeRoot, source, packageInfo) {
  const buildInfo = {
    schema_version: 1,
    build_id: `sha256:${source.manifestSha256}`,
    source_commit: source.commit,
    source_manifest_sha256: source.manifestSha256,
    package_name: packageInfo.name,
    package_version: packageInfo.version,
  };
  writeFileSync(
    path.join(runtimeRoot, '.lwb-build-info.json'),
    `${JSON.stringify(buildInfo, null, 2)}\n`,
    { encoding: 'utf8' },
  );
  return buildInfo;
}

function buildRecord({ sourceRoot, runtimeRoot, source, payload, packageInfo, sbomText, buildInfo, extra }) {
  const lockfile = path.join(runtimeRoot, 'package-lock.json');
  const npmVersionResult = runNpm(['--version'], runtimeRoot);
  if (npmVersionResult.error || npmVersionResult.status !== 0) {
    throw new Error('Unable to determine the npm version for the build record.');
  }
  const npmVersion = npmVersionResult.stdout.trim();
  const nodeVersion = process.version;
  const kind = path.resolve(sourceRoot) === path.resolve(runtimeRoot) ? 'source-checkout evidence' : 'packaged-runtime evidence';
  const tunnelLine = extra['tunnel-client-sha256']
    ? `- tunnel-client executable SHA-256: \`${extra['tunnel-client-sha256']}\`\n`
    : '';
  const cloudflaredLine = extra['cloudflared-sha256']
    ? `- cloudflared executable SHA-256: \`${extra['cloudflared-sha256']}\`\n`
    : '';
  const sqliteLine = extra['sqlite-prebuild-sha256']
    ? `- better-sqlite3 Windows x64 prebuild SHA-256: \`${extra['sqlite-prebuild-sha256']}\`\n`
    : '';
  const tunnelArchiveLine = extra['tunnel-archive-sha256']
    ? `- verified tunnel-client archive SHA-256: \`${extra['tunnel-archive-sha256']}\`\n`
    : '';
  const tunnelVersionLine = extra['tunnel-client-version']
    ? `- tunnel-client version: \`${extra['tunnel-client-version']}\`\n`
    : '';
  const buildIdLine = buildInfo ? `- Runtime build ID: \`${buildInfo.build_id}\`\n` : '';

  return [
    '# LocalWebGPT build record',
    '',
    `- Evidence type: ${kind}`,
    `- Generated at (UTC): ${new Date().toISOString()}`,
    `- Source commit: \`${source.commit}\``,
    `- Source working tree: ${source.dirty ? 'dirty; see the source manifest fingerprint below' : 'clean'}`,
    `- Source manifest SHA-256: \`${source.manifestSha256}\` (${String(source.fileCount)} files; excludes generated \`${RELEASE_SUBDIR}/\` evidence)`,
    buildIdLine.trimEnd(),
    `- Runtime package: \`${packageInfo.name}@${packageInfo.version}\``,
    `- Runtime payload manifest SHA-256: \`${payload.manifestSha256}\` (${String(payload.fileCount)} files; excludes generated release evidence)`,
    `- package-lock.json SHA-256: \`${sha256File(lockfile)}\``,
    `- SPDX SBOM SHA-256: \`${sha256(sbomText)}\` (${String(JSON.parse(sbomText).packages.length)} packages)`,
    `- Node.js: \`${nodeVersion}\`; npm: \`${npmVersion}\``,
    tunnelVersionLine.trimEnd(),
    tunnelArchiveLine.trimEnd(),
    tunnelLine.trimEnd(),
    cloudflaredLine.trimEnd(),
    sqliteLine.trimEnd(),
    '',
    'The tree fingerprints bind this record to the exact source/runtime files without recording absolute paths or file contents. This record is not a digital signature, an independent security review, or a G0–G6 approval.',
    '',
  ].filter((line) => line.length > 0).join('\n');
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const sourceRoot = path.resolve(args['source-root'] ?? REPO_ROOT);
  const runtimeRoot = path.resolve(args['runtime-root'] ?? REPO_ROOT);
  const outputDirectory = path.resolve(args['output-dir'] ?? path.join(REPO_ROOT, RELEASE_SUBDIR));
  const packageInfo = JSON.parse(readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'));
  if (!packageInfo.name || !packageInfo.version || !readFileSync(path.join(runtimeRoot, 'package-lock.json'))) {
    throw new Error('Runtime package metadata or lockfile is missing.');
  }

  const sbomText = npmSbom(runtimeRoot);
  const source = gitSourceState(sourceRoot);
  const buildInfo = path.resolve(sourceRoot) === path.resolve(runtimeRoot)
    ? null
    : writePackagedBuildInfo(runtimeRoot, source, packageInfo);
  const payload = path.resolve(sourceRoot) === path.resolve(runtimeRoot)
    ? source
    : walkPayload(runtimeRoot, outputDirectory);
  const record = buildRecord({ sourceRoot, runtimeRoot, source, payload, packageInfo, sbomText, buildInfo, extra: args });

  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(path.join(outputDirectory, 'sbom.json'), sbomText, { encoding: 'utf8' });
  writeFileSync(path.join(outputDirectory, 'build-record.md'), record, { encoding: 'utf8' });
  process.stdout.write(
    `Release evidence written: SPDX-2.3 SBOM (${String(JSON.parse(sbomText).packages.length)} packages); ` +
      `source=${source.manifestSha256}; payload=${payload.manifestSha256}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`Release evidence generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
