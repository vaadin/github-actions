// Run with: node --test code-review/action.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The `run: |` script of the named step of action.yml, dedented.
function stepScript(name) {
  const yml = fs.readFileSync(path.join(HERE, 'action.yml'), 'utf8');
  const step = yml.split(/^ *- name: /m).find((block) => block.startsWith(`${name}\n`));
  assert.ok(step, `step ${name}`);
  const run = /^( +)run: \|\n((?:\1 {2}.*\n|\n)*)/m.exec(step);
  assert.ok(run, `run block of step ${name}`);
  const [, indent, body] = run;
  return body.replace(new RegExp(`^${indent}  `, 'gm'), '');
}

// Runs the input check of the action with the given mode and whether an
// API key was passed, as the step's env has them.
function checkInputs(mode, hasApiKey) {
  return spawnSync('bash', ['-e', '-c', stepScript('Check inputs')], {
    env: { PATH: process.env.PATH, MODE: mode, HAS_API_KEY: String(hasApiKey) },
    encoding: 'utf8',
  });
}

test('the review mode requires the API key', () => {
  const ok = checkInputs('review', true);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(ok.stdout, '');

  const missing = checkInputs('review', false);
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stdout, /^::error::anthropic-api-key is required in the review mode$/m);
});

test('the dismiss-stale-approval mode needs no API key', () => {
  for (const hasApiKey of [true, false]) {
    const { status, stdout, stderr } = checkInputs('dismiss-stale-approval', hasApiKey);
    assert.strictEqual(status, 0, stderr);
    assert.strictEqual(stdout, '');
  }
});

test('an unknown mode fails before any step runs', () => {
  for (const mode of ['', 'approve', 'Review']) {
    const { status, stdout } = checkInputs(mode, true);
    assert.strictEqual(status, 1, `mode "${mode}"`);
    assert.match(stdout, /^::error::Unknown mode ".*"\. Expected review or dismiss-stale-approval\.$/m);
  }
});
