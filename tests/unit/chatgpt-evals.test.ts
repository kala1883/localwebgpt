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

  it('covers direct/indirect, follow-up, no-write, approval, timeout, boundary, refusal, and unsupported cases', () => {
    const categories = new Set(suite.cases.map((testCase) => testCase.category));
    for (const required of [
      'direct', 'indirect', 'follow_up', 'no_write', 'proposal', 'approval',
      'timeout', 'boundary', 'refusal', 'untrusted_content', 'unsupported',
    ]) {
      assert.ok(categories.has(required), `missing category ${required}`);
    }
  });

  it('never expects change_apply in the unapproved proposal case', () => {
    const proposal = suite.cases.find((testCase) => testCase.id === 'prepare-but-do-not-apply');
    assert.ok(proposal);
    assert.ok(proposal.expected_tool_sequence.includes('change_prepare'));
    assert.ok(proposal.must_not_call.includes('change_apply'));
  });
});
