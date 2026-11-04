// Run with: node --test code-review/post-review.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import { approvalBlocker, approvalConfig } from './post-review.mjs';

const DEFAULTS = { maxRisk: 'low', types: ['chore', 'docs', 'test'] };
const LOW = { level: 'low', reason: 'Only touches docs.' };

function blocker(overrides) {
  return approvalBlocker({ findings: [], risk: LOW, title: 'docs: fix a typo', ...DEFAULTS, ...overrides });
}

test('approval is off unless AUTO_APPROVE is true', () => {
  assert.strictEqual(approvalConfig({}), null);
  assert.strictEqual(approvalConfig({ AUTO_APPROVE: 'false' }), null);
  assert.deepStrictEqual(approvalConfig({ AUTO_APPROVE: 'true' }), DEFAULTS);
});

test('approval config parses the risk and the types', () => {
  assert.deepStrictEqual(
    approvalConfig({ AUTO_APPROVE: 'true', AUTO_APPROVE_MAX_RISK: 'medium', AUTO_APPROVE_TYPES: 'chore:, Docs\nrefactor' }),
    { maxRisk: 'medium', types: ['chore', 'docs', 'refactor'] }
  );
  for (const maxRisk of ['critical', 'toString']) {
    assert.throws(
      () => approvalConfig({ AUTO_APPROVE: 'true', AUTO_APPROVE_MAX_RISK: maxRisk }),
      /Unknown auto-approve-max-risk/
    );
  }
});

test('approves a PR that meets every condition', () => {
  assert.strictEqual(blocker({}), null);
  assert.strictEqual(blocker({ title: 'chore(deps): bump x' }), null);
  assert.strictEqual(blocker({ title: 'test: cover y' }), null);
  assert.strictEqual(blocker({ risk: { level: 'medium' }, maxRisk: 'medium' }), null);
});

test('does not approve a PR that misses a condition', () => {
  const finding = { file: 'a.js', line: 1, summary: 's', value: 'medium' };
  assert.match(blocker({ findings: [finding] }), /1 finding/);
  assert.match(blocker({ risk: undefined }), /no risk/);
  assert.match(blocker({ risk: { level: 'medium' } }), /above low/);
  assert.match(blocker({ risk: { level: 'critical' } }), /above low/);
  assert.match(blocker({ title: 'feat: add z' }), /type feat is not one of/);
  assert.match(blocker({ title: 'Fix a typo' }), /no conventional commit type/);
  assert.match(blocker({ title: 'chore!: drop Node 18' }), /breaking change/);
});
