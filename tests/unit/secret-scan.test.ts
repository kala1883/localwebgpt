import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { findSecretPatterns, scanWorkspace } from '../../scripts/secret-scan.ts';

describe('working-tree secret scan patterns', () => {
  it('detects an OpenAI project key shape without returning its contents', () => {
    const candidate = ['sk', 'proj', 'A'.repeat(56)].join('-');
    const findings = findSecretPatterns(`safe line\n${candidate}\n`);

    assert.deepEqual(findings, [{ kind: 'openai-project-api-key', line: 2 }]);
    assert.equal(JSON.stringify(findings).includes(candidate), false);
  });

  it('detects a long legacy API key shape', () => {
    const candidate = `sk-${'B'.repeat(56)}`;
    assert.deepEqual(findSecretPatterns(candidate), [{ kind: 'openai-api-key', line: 1 }]);
  });

  it('detects a Slack token shape without returning its contents', () => {
    const candidate = ['xoxb', 'synthetic', 'test', 'canary'].join('-');
    const findings = findSecretPatterns(`safe line\n${candidate}\n`);

    assert.deepEqual(findings, [{ kind: 'slack-api-token', line: 2 }]);
    assert.equal(JSON.stringify(findings).includes(candidate), false);
  });

  it('skips only ignored untracked fixtures; generated secrets are scanned after staging', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lwb-generated-secret-scan-'));
    const candidate = ['xoxb', 'synthetic', 'test', 'canary'].join('-');
    const generated = path.join(root, 'tests', 'fixtures', 'generated');
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
      writeFileSync(path.join(root, '.gitignore'), 'tests/fixtures/generated/\n', 'utf8');
      mkdirSync(generated, { recursive: true });
      writeFileSync(path.join(generated, 'token.txt'), `${candidate}\n`, 'utf8');
      writeFileSync(path.join(root, 'source.ts'), `${candidate}\n`, 'utf8');

      assert.deepEqual(scanWorkspace(root).map((finding) => finding.file), ['source.ts']);

      execFileSync('git', ['add', '--force', '--', 'tests/fixtures/generated/token.txt'], {
        cwd: root,
        windowsHide: true,
      });
      assert.deepEqual(
        scanWorkspace(root).map((finding) => finding.file).sort(),
        ['source.ts', 'tests/fixtures/generated/token.txt'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not reject short documentation placeholders or unrelated text', () => {
    assert.deepEqual(findSecretPatterns('Use sk-... as a placeholder.\nordinary text'), []);
  });

  it('skips only a gitignored, untracked root .env; a tracked .env still fails the scan', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lwb-secret-scan-'));
    const candidate = `sk-proj-${'C'.repeat(56)}`;
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
      writeFileSync(path.join(root, '.gitignore'), '.env\n', 'utf8');
      writeFileSync(path.join(root, '.env'), `${candidate}\n`, 'utf8');

      assert.deepEqual(scanWorkspace(root), []);

      execFileSync('git', ['add', '--force', '--', '.env'], { cwd: root, windowsHide: true });
      assert.deepEqual(scanWorkspace(root), [
        { file: '.env', kind: 'openai-project-api-key', line: 1 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
