// Run with: node --test code-review/run-review.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'run-review.mjs');
const INPUTS = '- **Diff**: `/tmp/pr-review/pr.diff`';

// Runs run-review.mjs against a stub `claude` that records the prompt it
// receives on stdin and reports no findings.
function runReview(profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-review-'));
  fs.mkdirSync(path.join(dir, 'pr-review'));
  fs.writeFileSync(path.join(dir, 'pr-review', 'review-inputs.md'), INPUTS);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const promptFile = path.join(dir, 'prompt.md');
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh\ncat > '${promptFile}'\n` +
      `echo '{"type":"result","structured_output":{"findings":[]}}'\n`,
    { mode: 0o755 }
  );
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    RUNNER_TEMP: dir,
    GITHUB_WORKSPACE: dir,
  };
  delete env.GITHUB_OUTPUT;
  delete env.PROFILE;
  delete env.SETTINGS;
  if (profile !== undefined) env.PROFILE = profile;
  const result = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...result, prompt };
}

function promptTemplate(file) {
  return fs.readFileSync(path.join(HERE, 'prompts', file), 'utf8');
}

test('reviews with the profile prompt and the review inputs inlined', () => {
  for (const [profile, file] of [
    [undefined, 'review.md'],
    ['', 'review.md'],
    ['code', 'review.md'],
    ['docs', 'review-docs.md'],
  ]) {
    const { status, stderr, prompt } = runReview(profile);
    assert.strictEqual(status, 0, `profile ${profile}: ${stderr}`);
    assert.strictEqual(
      prompt.trimEnd(),
      promptTemplate(file).replaceAll('{{REVIEW_INPUTS}}', INPUTS).trimEnd(),
      `profile ${profile}`
    );
  }
});

test('fails on an unknown profile before starting a session', () => {
  for (const profile of ['foo', 'toString', '__proto__']) {
    const { status, stderr, prompt } = runReview(profile);
    assert.strictEqual(status, 1, `profile ${profile}`);
    assert.match(stderr, /Unknown review profile .*Expected one of: code, docs\./);
    assert.strictEqual(prompt, null, `profile ${profile}`);
  }
});
