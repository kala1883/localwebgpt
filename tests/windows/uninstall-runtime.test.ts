import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import Database from 'better-sqlite3';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;
const repoRoot = path.resolve(import.meta.dirname, '../..');
const sourceScripts = path.join(repoRoot, 'packaging', 'windows');
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
});
