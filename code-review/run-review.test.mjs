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

// Runs run-review.mjs against a stub `claude` that records its arguments and
// the prompt it receives on stdin, and reports no findings. `extraEnv` adds
// environment variables.
function runReview(profile, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-review-'));
  fs.mkdirSync(path.join(dir, 'pr-review'));
  fs.writeFileSync(path.join(dir, 'pr-review', 'review-inputs.md'), INPUTS);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const promptFile = path.join(dir, 'prompt.md');
  const argsFile = path.join(dir, 'args');
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh\nprintf '%s\\0' "$@" > '${argsFile}'\ncat > '${promptFile}'\n` +
      `echo '{"type":"result","structured_output":{"findings":[]}}'\n`,
    { mode: 0o755 }
  );
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    RUNNER_TEMP: dir,
    GITHUB_WORKSPACE: dir,
    ...extraEnv,
  };
  delete env.GITHUB_OUTPUT;
  delete env.PROFILE;
  delete env.SETTINGS;
  if (!('INSTRUCTIONS_FILE' in extraEnv)) delete env.INSTRUCTIONS_FILE;
  if (profile !== undefined) env.PROFILE = profile;
  const result = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : null;
  const args = fs.existsSync(argsFile)
    ? fs.readFileSync(argsFile, 'utf8').split('\0').slice(0, -1)
    : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...result, prompt, args };
}

// The value of a `--flag value` pair in the recorded arguments, or undefined.
function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
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

test('pins the model and the effort level and logs both', () => {
  const { status, stderr, stdout, args } = runReview();
  assert.strictEqual(status, 0, stderr);
  assert.strictEqual(argValue(args, '--model'), 'claude-opus-5');
  assert.strictEqual(argValue(args, '--effort'), 'high');
  assert.match(stdout, /model claude-opus-5, effort high\./);
});

test('offers only research tools and advertises the read-only commands', () => {
  const { status, stderr, args } = runReview();
  assert.strictEqual(status, 0, stderr);
  assert.strictEqual(argValue(args, '--tools'), 'Read,Grep,Glob,Bash');
  const toolInstructions = argValue(args, '--append-system-prompt');
  assert.ok(!toolInstructions.includes('{{BASH_COMMANDS}}'));
  assert.match(toolInstructions, /\n {4}ls, cat, .*sed -n.*\n/);
});

test('appends the generated instructions after the tool instructions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instructions-'));
  const file = path.join(dir, 'claude-instructions.md');
  const instructions = '# Reference checkouts\n\nSee flow.\n';
  fs.writeFileSync(file, instructions);
  const withFile = runReview(undefined, { INSTRUCTIONS_FILE: file });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(withFile.status, 0, withFile.stderr);

  for (const extraEnv of [{}, { INSTRUCTIONS_FILE: '' }]) {
    const without = runReview(undefined, extraEnv);
    assert.strictEqual(without.status, 0, without.stderr);
    const toolInstructions = argValue(without.args, '--append-system-prompt');
    assert.match(toolInstructions, /^## Tools and shell constraints\n/);
    assert.ok(!toolInstructions.includes('# Reference checkouts'));
    assert.strictEqual(
      argValue(withFile.args, '--append-system-prompt'),
      `${toolInstructions}\n\n${instructions}`
    );
  }
});
