import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import Database from 'better-sqlite3';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;
const repoRoot = path.resolve(import.meta.dirname, '../..');
const sourceScripts = path.join(repoRoot, 'scripts', 'windows');
const secretSentinel = 'UNINSTALL_TEST_RUNTIME_API_KEY_MUST_NOT_APPEAR';

interface Fixture {
  readonly root: string;
  readonly runtime: string;
  readonly stateRoot: string;
  readonly workspace: string;
  readonly database: string;
}

function makeFixture(parent: string, workspacePath: (root: string, workspace: string) => string): Fixture {
  const root = mkdtempSync(path.join(parent, 'lwb-uninstall-'));
  const runtime = path.join(root, 'LocalWebGPT-runtime');
  const stateRoot = path.join(root, 'protected-state');
  const workspace = path.join(root, 'workspace');
  const databaseDirectory = path.join(stateRoot, 'db');
  const database = path.join(databaseDirectory, 'bridge.sqlite');

  mkdirSync(runtime, { recursive: true });
  mkdirSync(databaseDirectory, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(runtime, 'package.json'), '{"name":"local-workspace-bridge","version":"0.1.0"}\n');
  writeFileSync(path.join(runtime, '.env'), `runtime_API_key=${secretSentinel}\n`);
  for (const script of ['Start-LocalWebGPT.ps1', 'Stop-LocalWebGPT.ps1', 'Uninstall-LocalWebGPT.ps1']) {
    copyFileSync(path.join(sourceScripts, script), path.join(runtime, script));
  }

  const db = new Database(database);
  try {
    db.exec('CREATE TABLE workspaces (canonical_root TEXT NOT NULL)');
    db.prepare('INSERT INTO workspaces(canonical_root) VALUES (?)').run(workspacePath(root, workspace));
  } finally {
    db.close();
  }

  return { root, runtime, stateRoot, workspace, database };
}

function runUninstaller(
  fixture: Fixture,
  additionalArgs: readonly string[] = [],
  workingDirectory = repoRoot,
) {
  return spawnSync(
    'pwsh.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.join(fixture.runtime, 'Uninstall-LocalWebGPT.ps1'),
      '-RuntimeDirectory',
      fixture.runtime,
      '-StateRoot',
      fixture.stateRoot,
      '-ConfirmTargetRuntimeStopped',
      '-Confirm:$false',
      ...additionalArgs,
    ],
    {
      cwd: workingDirectory,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, NODE_PATH: path.join(repoRoot, 'node_modules') },
    },
  );
}

function startUninstaller(fixture: Fixture) {
  return spawn(
    'pwsh.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.join(fixture.runtime, 'Uninstall-LocalWebGPT.ps1'),
      '-RuntimeDirectory',
      fixture.runtime,
      '-StateRoot',
      fixture.stateRoot,
      '-ConfirmTargetRuntimeStopped',
      '-Confirm:$false',
    ],
    {
      cwd: repoRoot,
      windowsHide: true,
      env: { ...process.env, NODE_PATH: path.join(repoRoot, 'node_modules') },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

describeWindows('guarded LocalWebGPT runtime uninstall', () => {
  let fixtureParent = '';

  before(() => {
    fixtureParent = mkdtempSync(path.join(os.tmpdir(), 'lwb-uninstall-tests-'));
  });

  after(() => {
    if (fixtureParent) rmSync(fixtureParent, { recursive: true, force: true });
  });

  it('removes only a stopped runtime and preserves workspace plus protected state without logging .env values', async () => {
    const fixture = makeFixture(fixtureParent, (_root, workspace) => workspace);
    writeFileSync(path.join(fixture.workspace, 'keep.txt'), 'workspace bytes\n');
    const readOnlyPayload = path.join(fixture.runtime, 'readonly-payload.txt');
    writeFileSync(readOnlyPayload, 'read-only runtime payload\n');
    chmodSync(readOnlyPayload, 0o444);
    symlinkSync(fixture.workspace, path.join(fixture.runtime, 'workspace-link'), 'junction');
    const stateBefore = readFileSync(fixture.database);

    const result = runUninstaller(fixture, [], fixture.runtime);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const deadline = Date.now() + 10_000;
    while (existsSync(fixture.runtime) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(existsSync(fixture.runtime), false, 'the exact runtime directory should be removed');
    assert.equal(readFileSync(path.join(fixture.workspace, 'keep.txt'), 'utf8'), 'workspace bytes\n');
    assert.deepEqual(readFileSync(fixture.database), stateBefore, 'protected state database must remain byte-identical');
    assert.equal(result.stdout.includes(secretSentinel), false, 'runtime credentials must never be logged');
    assert.equal(result.stderr.includes(secretSentinel), false, 'runtime credentials must never be logged to stderr');
  });

  it('refuses to remove a runtime nested under an authorized workspace', () => {
    const outer = mkdtempSync(path.join(fixtureParent, 'lwb-uninstall-overlap-'));
    const runtime = path.join(outer, 'LocalWebGPT-runtime');
    const stateRoot = path.join(fixtureParent, `state-${Date.now()}`);
    const databaseDirectory = path.join(stateRoot, 'db');
    mkdirSync(runtime, { recursive: true });
    mkdirSync(databaseDirectory, { recursive: true });
    writeFileSync(path.join(runtime, 'package.json'), '{"name":"local-workspace-bridge","version":"0.1.0"}\n');
    writeFileSync(path.join(runtime, '.env'), `runtime_API_key=${secretSentinel}\n`);
    for (const script of ['Start-LocalWebGPT.ps1', 'Stop-LocalWebGPT.ps1', 'Uninstall-LocalWebGPT.ps1']) {
      copyFileSync(path.join(sourceScripts, script), path.join(runtime, script));
    }
    const database = path.join(databaseDirectory, 'bridge.sqlite');
    const db = new Database(database);
    try {
      db.exec('CREATE TABLE workspaces (canonical_root TEXT NOT NULL)');
      db.prepare('INSERT INTO workspaces(canonical_root) VALUES (?)').run(outer);
    } finally {
      db.close();
    }
    const fixture: Fixture = { root: outer, runtime, stateRoot, workspace: outer, database };

    const result = runUninstaller(fixture);

    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0, 'workspace overlap must block uninstall');
    assert.equal(existsSync(runtime), true);
    assert.equal(readFileSync(path.join(runtime, '.env'), 'utf8').includes(secretSentinel), true);
    assert.equal(result.stdout.includes(secretSentinel), false);
    assert.equal(result.stderr.includes(secretSentinel), false);
  });

  it('supports WhatIf without stopping or removing anything', () => {
    const fixture = makeFixture(fixtureParent, (_root, workspace) => workspace);
    const result = runUninstaller(fixture, ['-WhatIf']);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(fixture.runtime), true);
    assert.equal(existsSync(fixture.database), true);
    assert.equal(result.stdout.includes(secretSentinel), false);
    assert.equal(result.stderr.includes(secretSentinel), false);
  });

  it('pins entries while uninstall races a junction swap and preserves the external canary', async () => {
    const fixture = makeFixture(fixtureParent, (_root, workspace) => workspace);
    const canaryPath = path.join(fixture.workspace, 'keep.txt');
    writeFileSync(canaryPath, 'external canary must survive\n');
    const victims = Array.from({ length: 64 }, (_, index) => `swap-${String(index).padStart(3, '0')}`);
    for (const victim of victims) {
      const directory = path.join(fixture.runtime, victim);
      mkdirSync(directory);
      writeFileSync(path.join(directory, 'payload.txt'), 'runtime-only bytes\n');
    }

    const uninstaller = startUninstaller(fixture);
    let stdout = '';
    let stderr = '';
    let readyResolve!: () => void;
    let closeResolve!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      closeResolve = resolve;
    });
    uninstaller.stdout.setEncoding('utf8');
    uninstaller.stderr.setEncoding('utf8');
    uninstaller.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes('handed to a hidden helper')) readyResolve();
    });
    uninstaller.stderr.on('data', (chunk: string) => { stderr += chunk; });
    uninstaller.once('error', (error) => { stderr += error.message; readyResolve(); });
    uninstaller.once('close', (code, signal) => closeResolve({ code, signal }));

    const raced = await Promise.race([
      ready.then(() => 'ready' as const),
      closed.then(() => 'closed' as const),
    ]);
    assert.equal(raced, 'ready', `uninstaller did not hand off to cleanup: ${stdout}\n${stderr}`);

    const swapProgram = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const runtime = process.argv[1];
const workspace = process.argv[2];
const victims = JSON.parse(process.argv[3]);
const deadline = Date.now() + 5000;
const pause = new Int32Array(new SharedArrayBuffer(4));
let attempts = 0;
while (Date.now() < deadline && fs.existsSync(runtime)) {
  for (const name of victims) {
    const target = path.join(runtime, name);
    const parked = path.join(runtime, name + '.parked');
    attempts++;
    try {
      if (fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink() && !fs.existsSync(parked)) {
        fs.renameSync(target, parked);
        try { fs.symlinkSync(workspace, target, 'junction'); }
        catch { if (fs.existsSync(parked) && !fs.existsSync(target)) fs.renameSync(parked, target); }
      }
      if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
        Atomics.wait(pause, 0, 0, 2);
        try { fs.rmdirSync(target); } catch {}
      }
      if (fs.existsSync(parked) && !fs.existsSync(target)) {
        try { fs.renameSync(parked, target); } catch {}
      }
    } catch {}
  }
  Atomics.wait(pause, 0, 0, 1);
}
process.stdout.write(String(attempts));
`;
    const attacker = spawn(process.execPath, [
      '-e',
      swapProgram,
      fixture.runtime,
      fixture.workspace,
      JSON.stringify(victims),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let attackerOutput = '';
    attacker.stdout.setEncoding('utf8');
    attacker.stdout.on('data', (chunk: string) => { attackerOutput += chunk; });

    const attackerClosed = new Promise<void>((resolve, reject) => {
      attacker.once('error', reject);
      attacker.once('close', (code) => code === 0 ? resolve() : reject(new Error(`swap process exited ${code}`)));
    });
    await attackerClosed;
    await closed;

    assert.ok(Number(attackerOutput) > 0, 'the concurrent swap process must attempt replacements');
    assert.equal(readFileSync(canaryPath, 'utf8'), 'external canary must survive\n');
    assert.equal(stdout.includes(secretSentinel), false);
    assert.equal(stderr.includes(secretSentinel), false);
  });

  it('refuses to delete a different ordinary directory swapped onto the runtime path', async () => {
    const fixture = makeFixture(fixtureParent, (_root, workspace) => workspace);
    const replacement = path.join(fixture.root, 'replacement-runtime');
    const parkedOriginal = path.join(fixture.root, 'original-runtime-parked');
    const replacementCanary = path.join(replacement, 'must-survive.txt');
    mkdirSync(replacement);
    writeFileSync(path.join(replacement, 'package.json'), '{"name":"local-workspace-bridge"}\n');
    writeFileSync(path.join(replacement, 'Start-LocalWebGPT.ps1'), '# fixture\n');
    writeFileSync(path.join(replacement, 'Stop-LocalWebGPT.ps1'), '# fixture\n');
    writeFileSync(replacementCanary, 'replacement directory is not the selected runtime\n');
    writeFileSync(path.join(fixture.workspace, 'keep.txt'), 'workspace canary\n');

    const swapProgram = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const runtime = process.argv[1];
const replacement = process.argv[2];
const parked = process.argv[3];
const temp = process.argv[4];
const before = new Set(fs.readdirSync(temp).filter((name) => name.startsWith('.lwb-uninstall-')));
const deadline = Date.now() + 8000;
const pause = new Int32Array(new SharedArrayBuffer(4));
let marker = null;
let swapped = false;
while (Date.now() < deadline) {
  try {
    const name = fs.readdirSync(temp).find((item) => item.startsWith('.lwb-uninstall-') && !before.has(item));
    if (name) marker = path.join(temp, name);
  } catch {}
  if (marker && !swapped && fs.existsSync(runtime) && fs.existsSync(replacement)) {
    try {
      fs.renameSync(runtime, parked);
      try {
        fs.renameSync(replacement, runtime);
        swapped = true;
      } catch {
        if (!fs.existsSync(runtime) && fs.existsSync(parked)) fs.renameSync(parked, runtime);
      }
    } catch {}
  }
  if (swapped && marker && !fs.existsSync(marker)) break;
  Atomics.wait(pause, 0, 0, 1);
}
process.stdout.write(JSON.stringify({ swapped, marker }));
`;
    const attacker = spawn(process.execPath, [
      '-e',
      swapProgram,
      fixture.runtime,
      replacement,
      parkedOriginal,
      os.tmpdir(),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let attackerOutput = '';
    attacker.stdout.setEncoding('utf8');
    attacker.stdout.on('data', (chunk: string) => { attackerOutput += chunk; });

    const result = runUninstaller(fixture);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const attackerClosed = new Promise<void>((resolve, reject) => {
      attacker.once('error', reject);
      attacker.once('close', (code) => code === 0 ? resolve() : reject(new Error(`replacement process exited ${code}`)));
    });
    await attackerClosed;

    const race = JSON.parse(attackerOutput) as { swapped: boolean; marker: string | null };
    assert.equal(race.swapped, true, 'the test must replace the runtime path after its identity was checked');
    assert.ok(race.marker, 'the test must observe the uninstaller handoff marker');
    assert.equal(readFileSync(path.join(fixture.workspace, 'keep.txt'), 'utf8'), 'workspace canary\n');
    const preservedReplacement = existsSync(replacementCanary)
      ? readFileSync(replacementCanary, 'utf8')
      : existsSync(path.join(fixture.runtime, 'must-survive.txt'))
        ? readFileSync(path.join(fixture.runtime, 'must-survive.txt'), 'utf8')
        : null;
    assert.equal(preservedReplacement, 'replacement directory is not the selected runtime\n');
  });

  it('uses handle-relative reparse-safe deletion instead of path-based recursive removal', async () => {
    const source = readFileSync(path.join(sourceScripts, 'Uninstall-LocalWebGPT.ps1'), 'utf8');
    assert.match(source, /FILE_FLAG_OPEN_REPARSE_POINT/);
    assert.match(source, /SetFileInformationByHandle/);
    assert.match(source, /GetFileIdInformationByHandleEx/);
    assert.match(source, /LWB_UNINSTALL_ROOT_IDENTITY/);
    assert.match(source, /OpenEntry\(\$Path\)/);
    assert.match(source, /markerPath = Join-Path \$temporaryPath/);
    assert.doesNotMatch(source, /Remove-TreeWithoutFollowingLinks/);
  });
});
