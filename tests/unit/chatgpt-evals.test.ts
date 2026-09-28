import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { TOOL_NAMES } from '@lwb/contracts';

interface EvalCase {
  readonly id: string;
  readonly category: string;
  readonly setup: string;
  readonly prompt: string;
  readonly expected_tool_sequence: readonly string[];
  readonly must_not_call: readonly string[];
  readonly assertions: readonly string[];
}

interface EvalSuite {
  readonly version: string;
  readonly status: string;
  readonly cases: readonly EvalCase[];
}

const suitePath = path.resolve(import.meta.dirname, '../evals/chatgpt/cases.json');
const suite = JSON.parse(readFileSync(suitePath, 'utf8')) as EvalSuite;

describe('ChatGPT conversation evaluation set', () => {
  it('is an explicitly unrun, well-formed suite with unique cases', () => {
    assert.equal(suite.version, '1');
    assert.equal(suite.status, 'NOT_RUN');
    assert.ok(suite.cases.length >= 10);

    const ids = suite.cases.map((testCase) => testCase.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const testCase of suite.cases) {
      assert.ok(testCase.id.length > 0);
      assert.ok(testCase.category.length > 0);
      assert.ok(testCase.setup.length > 0);
      assert.ok(testCase.prompt.length > 0);
      assert.ok(testCase.assertions.length > 0);
      for (const tool of [...testCase.expected_tool_sequence, ...testCase.must_not_call]) {
        assert.ok(TOOL_NAMES.includes(tool as (typeof TOOL_NAMES)[number]), `${testCase.id}: unknown tool ${tool}`);
      }
    }
  });

  it('covers direct/indirect, follow-up, no-write, direct writes, timeout, boundary, refusal, and unsupported cases', () => {
    const categories = new Set(suite.cases.map((testCase) => testCase.category));
    for (const required of [
      'direct', 'indirect', 'follow_up', 'no_write', 'direct_write',
      'timeout', 'boundary', 'refusal', 'untrusted_content', 'unsupported',
      'direct_command',
    ]) {
      assert.ok(categories.has(required), `missing category ${required}`);
    }
  });

  it('expects a granted single-file creation to write directly in one tool call', () => {
    const create = suite.cases.find((testCase) => testCase.id === 'create-file-within-workspace-grant');
    assert.ok(create);
    assert.equal(create.category, 'direct_write');
    assert.deepEqual(create.expected_tool_sequence, ['file_create']);
    assert.ok(create.must_not_call.includes('change_apply'));
    assert.ok(create.assertions.some((assertion) => assertion.includes('state=APPLIED')));
  });

  it('expects a granted single-file edit to apply directly and validate its receipt', () => {
    const edit = suite.cases.find((testCase) => testCase.id === 'edit-file-within-workspace-grant');
    assert.ok(edit);
    assert.equal(edit.category, 'direct_write');
    assert.deepEqual(edit.expected_tool_sequence, ['file_edit']);
    assert.ok(edit.must_not_call.includes('change_apply'));
    assert.ok(edit.assertions.some((assertion) => assertion.includes('state=APPLIED')));
  });

  it('uses prepare/apply for multi-file writes without per-change approval', () => {
    const multiFile = suite.cases.find((testCase) => testCase.id === 'multi-file-change-within-workspace-grant');
    assert.ok(multiFile);
    assert.deepEqual(multiFile.expected_tool_sequence, ['change_prepare', 'change_apply']);
    assert.ok(multiFile.assertions.some((assertion) => assertion.includes('do not ask for another per-change console approval')));
  });

  it('requires an explicit command task and a separate command_exec workspace grant', () => {
    const granted = suite.cases.find((testCase) => testCase.id === 'explicit-command-with-command-grant');
    const longRunning = suite.cases.find((testCase) => testCase.id === 'command-over-25-seconds-has-no-local-hard-deadline');
    const denied = suite.cases.find((testCase) => testCase.id === 'command-grant-required-for-shell');
    const timeout = suite.cases.find((testCase) => testCase.id === 'command-timeout-is-not-safe-to-replay');
    const replay = suite.cases.find((testCase) => testCase.id === 'command-same-key-replay-suppressed');
    assert.ok(granted && longRunning && denied && timeout && replay);
    assert.deepEqual(granted.expected_tool_sequence, ['command_exec']);
    assert.deepEqual(longRunning.expected_tool_sequence, ['command_exec']);
    assert.ok(longRunning.assertions.some((assertion) => assertion.includes('may run longer than 25 seconds')));
    assert.ok(denied.must_not_call.includes('command_exec'));
    assert.ok(timeout.must_not_call.includes('command_exec'));
    assert.ok(timeout.setup.includes('may still be running'));
    assert.ok(replay.must_not_call.includes('command_exec'));
    assert.ok(replay.assertions.some((assertion) => assertion.includes('Do not mint a new idempotency_key')));
    assert.ok(granted.assertions.some((assertion) => assertion.includes('Do not claim the workspace root is a sandbox')));
  });
});
