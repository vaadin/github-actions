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
// the prompt it receives on stdin, and reports no findings.
function runReview(profile, extraAllowedTools) {
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
  };
  delete env.GITHUB_OUTPUT;
  delete env.PROFILE;
  delete env.SETTINGS;
  delete env.EXTRA_ALLOWED_TOOLS;
  if (profile !== undefined) env.PROFILE = profile;
  if (extraAllowedTools !== undefined) env.EXTRA_ALLOWED_TOOLS = extraAllowedTools;
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

test('passes no Bash allow rule and advertises the read-only commands', () => {
  const { status, stderr, args } = runReview();
  assert.strictEqual(status, 0, stderr);
  assert.ok(!args.includes('--allowedTools'), args.join(' '));
  assert.strictEqual(argValue(args, '--tools'), 'Read,Grep,Glob,Bash');
  const toolInstructions = argValue(args, '--append-system-prompt');
  assert.ok(!toolInstructions.includes('{{BASH_COMMANDS}}'));
  const commands = toolInstructions.match(/\n {4}(ls, cat, .*)\n/)[1].split(', ');
  assert.ok(commands.includes('sed -n'), commands.join(', '));
  // Left out on purpose: the prompts forbid computing a diff, the checkout is
  // shallow, and these need approval or write files.
  for (const excluded of ['git diff', 'git log', 'git blame', 'awk', 'sed']) {
    assert.ok(!commands.includes(excluded), `${excluded} is advertised`);
  }
});

test('passes only the extra allowed tools of the caller', () => {
  const { status, stderr, args } = runReview(undefined, 'Bash(mvn dependency:tree)\n Bash(npm ls) ,');
  assert.strictEqual(status, 0, stderr);
  assert.strictEqual(
    argValue(args, '--allowedTools'),
    'Bash(mvn dependency:tree),Bash(npm ls)'
  );
});
