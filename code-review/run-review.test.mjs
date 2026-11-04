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

const RISK = { level: 'medium', reason: 'Changes shared code.' };

// Runs run-review.mjs against a stub `claude` that records the prompt it
// receives on stdin and its arguments, and reports `output` as the structured
// output (by default no findings and the risk above).
function runReview(profile, output = { findings: [], risk: RISK }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-review-'));
  fs.mkdirSync(path.join(dir, 'pr-review'));
  fs.writeFileSync(path.join(dir, 'pr-review', 'review-inputs.md'), INPUTS);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const promptFile = path.join(dir, 'prompt.md');
  const argsFile = path.join(dir, 'args.txt');
  const resultFile = path.join(dir, 'result.json');
  fs.writeFileSync(
    resultFile,
    JSON.stringify({ type: 'result', structured_output: output }) + '\n'
  );
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh\ncat > '${promptFile}'\nprintf '%s\\n' "$@" > '${argsFile}'\n` +
      `cat '${resultFile}'\n`,
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
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  const prompt = read(promptFile);
  const args = read(argsFile)?.split('\n');
  const schema = args && JSON.parse(args[args.indexOf('--json-schema') + 1]);
  const findingsFile = read(path.join(dir, 'review-output', 'findings.json'));
  const findings = findingsFile && JSON.parse(findingsFile);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...result, prompt, schema, findings };
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

test('requires and passes on the risk assessment in the code profile', () => {
  const { status, stderr, schema, findings } = runReview('code');
  assert.strictEqual(status, 0, stderr);
  assert.ok(schema.required.includes('risk'));
  assert.deepStrictEqual(schema.properties.risk.properties.level.enum, ['low', 'medium', 'high']);
  assert.deepStrictEqual(findings, { findings: [], risk: RISK });
});

test('fails when the code profile reports no valid risk', () => {
  for (const risk of [undefined, { level: 'critical', reason: '' }]) {
    const { status, stderr } = runReview('code', { findings: [], risk });
    assert.strictEqual(status, 1);
    assert.match(stderr, /no valid risk assessment/);
  }
});

test('does not assess risk in the docs profile', () => {
  const { status, stderr, schema, findings } = runReview('docs', { findings: [] });
  assert.strictEqual(status, 0, stderr);
  assert.ok(!('risk' in schema.properties));
  assert.ok(!schema.required.includes('risk'));
  assert.deepStrictEqual(findings, { findings: [] });
});
