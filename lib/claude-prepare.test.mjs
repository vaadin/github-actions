// Run with: node --test lib/claude-prepare.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-prepare.mjs');

// Runs claude-prepare.mjs with a fresh runner temp directory and workspace,
// and returns its outputs together with the files left in the workspace.
function prepare(extraInstructions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-prepare-'));
  const runnerTemp = path.join(dir, 'temp');
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(runnerTemp);
  fs.mkdirSync(path.join(workspace, '.git', 'info'), { recursive: true });
  const outputFile = path.join(dir, 'output');
  const env = {
    ...process.env,
    RUNNER_TEMP: runnerTemp,
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputFile,
  };
  delete env.REFERENCE_REPOS;
  delete env.EXTRA_ADDITIONAL_DIRECTORIES;
  delete env.EXTRA_INSTRUCTIONS;
  if (extraInstructions !== undefined) env.EXTRA_INSTRUCTIONS = extraInstructions;
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: workspace, env, encoding: 'utf8' });
  // GITHUB_OUTPUT entries in the `name<<DELIMITER\nvalue\nDELIMITER` form.
  const outputs = Object.fromEntries(
    [...fs.readFileSync(outputFile, 'utf8').matchAll(/^(\w+)<<(\w+)\n([\s\S]*?)\n?\2$/gm)]
      .map(([, name, , value]) => [name, value])
  );
  const instructions = outputs.instructions_file
    ? fs.readFileSync(outputs.instructions_file, 'utf8')
    : null;
  const workspaceFiles = fs.readdirSync(workspace, { recursive: true }).sort();
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...result, outputs, instructions, runnerTemp, workspaceFiles };
}

test('writes the extra instructions outside the workspace', () => {
  const { status, stderr, outputs, instructions, runnerTemp, workspaceFiles } =
    prepare('Check the changelog.');
  assert.strictEqual(status, 0, stderr);
  assert.strictEqual(outputs.instructions_file, path.join(runnerTemp, 'claude-instructions.md'));
  assert.strictEqual(instructions, 'Check the changelog.\n');
  assert.deepStrictEqual(workspaceFiles, ['.git', path.join('.git', 'info')]);
});

test('outputs no instructions file without instructions', () => {
  const { status, stderr, outputs, workspaceFiles } = prepare();
  assert.strictEqual(status, 0, stderr);
  assert.strictEqual(outputs.instructions_file, '');
  assert.deepStrictEqual(workspaceFiles, ['.git', path.join('.git', 'info')]);
});
