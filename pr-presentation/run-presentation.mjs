#!/usr/bin/env node
/**
 * Run one headless Claude Code session that follows the pr-presentation
 * skill and writes the deck.
 *
 * The skill is loaded from the action's plugin directory (--plugin-dir) and
 * invoked as `/pr-presentation <pr url> <work folder>`, as a user would. The
 * session's working directory is the checkout, so the skill's collect step
 * finds it and the repository's CLAUDE.md loads. The work folder and the
 * skill directory are additional directories, so the session can read the
 * skill's references and write the run's files.
 *
 * The session gets the tools the skill names and no web or timer tools. Bash
 * allows node, which runs the skill's scripts, and the git commands that read
 * history (log, blame, show). The scripts run the other git and gh commands. The caller's read-only job token, passed as GH_TOKEN, bounds what
 * gh and git can do.
 *
 * A session that exits non-zero, times out or leaves no deck fails the run.
 *
 * Environment: PR_NUMBER (or argv[2]), GITHUB_REPOSITORY, GITHUB_SERVER_URL,
 * RUNNER_TEMP, GITHUB_WORKSPACE, GH_TOKEN, ANTHROPIC_API_KEY.
 * Step outputs: execution-file (the stream-json transcript, written before
 * any failure check), deck-file.
 *
 * Usage: node pr-presentation/run-presentation.mjs <pr-number>
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tuning: deliberately hard-coded, each a one-line edit. The skill picks the
// models of its subagents.
const MODEL = 'claude-opus-5-5';
const EFFORT = 'high';
const MAX_BUDGET_USD = 15;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// The tools the session is offered, and the ones auto-approved as a whole.
// Write/Edit are bounded by the session's directories.
const TOOLS = 'Read,Write,Edit,Glob,Grep,Bash,Agent';
const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent'];

// Bash commands auto-approved: node runs the skill's scripts, and git log, blame
// and show read the history of the touched lines. Read, Grep and Glob cover
// reading and searching. An auto-approve list, not a capability boundary.
const ALLOWED_BASH_COMMANDS = ['node', 'git log', 'git blame', 'git show'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.join(HERE, 'plugin');
const SKILL_DIR = path.join(PLUGIN_DIR, 'skills', 'pr-presentation');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} must be set`);
  return value;
}

// A step output ($GITHUB_OUTPUT), or stdout when run locally.
function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  } else {
    console.log(`${name}=${value}`);
  }
}

// One `claude` process: prompt on stdin, stream-json transcript from stdout,
// stderr passed through to the job log.
function runClaude(prompt, { cwd, additionalDirectories }) {
  const allowedTools = [
    ...ALLOWED_TOOLS,
    ...ALLOWED_BASH_COMMANDS.map((cmd) => `Bash(${cmd}:*)`),
  ].join(',');
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose', // required for stream-json in --print mode
    '--model', MODEL,
    '--effort', EFFORT,
    '--max-budget-usd', String(MAX_BUDGET_USD),
    '--tools', TOOLS,
    '--allowedTools', allowedTools,
    '--permission-mode', 'dontAsk',
    // Only the checkout's own settings: no user settings, hooks, plugins or
    // MCP servers of the runner.
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--plugin-dir', PLUGIN_DIR,
    '--add-dir', ...additionalDirectories,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 10_000).unref();
    }, SESSION_TIMEOUT_MS);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (status) => {
      clearTimeout(timer);
      resolve({ stdout, status, timedOut });
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// The final `result` event of the transcript: outcome and cost of the session.
function extractResult(stdout) {
  let result = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === 'result') result = event;
  }
  return result;
}

async function main() {
  const prNumber = process.argv[2] || process.env.PR_NUMBER;
  if (!prNumber) fail('PR number required (argv[2] or PR_NUMBER)');
  const repo = requireEnv('GITHUB_REPOSITORY');
  const runnerTemp = requireEnv('RUNNER_TEMP');
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const prUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/pull/${prNumber}`;

  const workDir = path.join(runnerTemp, 'pr-presentation', 'work');
  fs.mkdirSync(workDir, { recursive: true });

  const outDir = path.join(runnerTemp, 'pr-presentation', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const transcriptPath = path.join(outDir, 'transcript.jsonl');
  const deckPath = path.join(outDir, `pr-${prNumber}-deck.html`);

  const run = await runClaude(`/pr-presentation ${prUrl} ${workDir}`, {
    cwd: workspace,
    additionalDirectories: [workDir, SKILL_DIR],
  });

  // Before any failure check, so the transcript survives a failed run.
  fs.writeFileSync(transcriptPath, run.stdout || '');
  writeOutput('execution-file', transcriptPath);

  if (run.timedOut) {
    fail(`Presentation timed out after ${SESSION_TIMEOUT_MS / 60000} minutes.`);
  }
  if (run.status !== 0) {
    fail(`Presentation session exited ${run.status} — see the log above.`);
  }
  const result = extractResult(run.stdout || '');
  if (!result || result.is_error) {
    fail(`Presentation session ended with ${result?.subtype || 'no result'} — see the transcript.`);
  }
  const deckSource = path.join(workDir, 'deck.html');
  if (!fs.existsSync(deckSource)) {
    fail(`Presentation produced no deck: ${deckSource} is missing. Last reply: ${result.result || '(empty)'}`);
  }
  fs.copyFileSync(deckSource, deckPath);
  writeOutput('deck-file', deckPath);

  const cost =
    typeof result.total_cost_usd === 'number'
      ? ` ($${result.total_cost_usd.toFixed(2)})`
      : '';
  console.log(`Deck written to ${deckPath} in ${result.num_turns ?? '?'} turns${cost}.`);
}

main().catch((err) => fail(String(err?.stack || err)));
