#!/usr/bin/env node
/**
 * Run the PR presentation: one headless Claude Code session follows the
 * pr-presentation skill on the inputs that prepare-presentation.mjs
 * collected and writes the deck.
 *
 * The skill is loaded from the action's own plugin directory (--plugin-dir),
 * so nothing is copied into the workspace, and the prompt invokes it as
 * `/pr-presentation <work folder>`, as a user would. The skill directory and
 * the work folder are additional working directories of the session, so it
 * can read the skill's references and write the run's files.
 *
 * The skill writes files under the work folder and starts its own reader and
 * builder subagents, so the session is offered Write, Edit and Agent, and no
 * web or timer tools. What keeps it harmless: it gets no GitHub token, and
 * Bash is limited to node, mkdir and read-only commands. The caller's
 * read-only job token is the boundary for anything that still reaches git
 * through the checkout.
 *
 * Failure semantics are strict: a session that exits non-zero, times out, or
 * leaves no deck fails the run.
 *
 * Reads from the environment (set by GitHub Actions):
 *   PR_NUMBER / argv[2]  pull request number, for the deck file name
 *   RUNNER_TEMP          expects the work folder in
 *                        $RUNNER_TEMP/pr-presentation/work; writes outputs to
 *                        $RUNNER_TEMP/pr-presentation/output
 *   GITHUB_WORKSPACE     the checkout; the session's working directory, so the
 *                        repository's CLAUDE.md and .claude settings load as
 *                        the skill's reader profile expects
 *   ANTHROPIC_API_KEY    inherited by the claude process (bills the run)
 *
 * Produces under $RUNNER_TEMP/pr-presentation/output:
 *   transcript.jsonl     the session's stream-json transcript (execution log)
 *   pr-<N>-deck.html     the deck; an unzipped artifact takes its file name
 *
 * Writes step outputs ($GITHUB_OUTPUT): execution-file, deck-file.
 * execution-file is written as soon as the transcript exists, so the log
 * survives a failed run.
 *
 * Usage:
 *   node pr-presentation/run-presentation.mjs <pr-number>
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Tuning constants -------------------------------------------------------
// Deliberately hard-coded; each is a one-line edit.

// The session's effort level. The models are the defaults of the installed
// Claude Code version: the session's own, and the `sonnet` alias the skill
// asks for its subagents.
const EFFORT = 'high';

// Safety stop for one run: the session is cut off when it spends this much.
const MAX_BUDGET_USD = 15;

// Hard timeout on the session; a hung CLI process fails the run instead of
// burning the job's full time budget.
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// --- Tool surface -----------------------------------------------------------

// The tools the model is offered (via --tools): what the skill uses and
// nothing else — no web, no timers.
const TOOLS = 'Read,Write,Edit,Glob,Grep,Bash,Agent';

// Tools that are auto-approved as a whole. Write/Edit are bounded by the
// working directories (the checkout, the work folder, the skill directory).
const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent'];

// Commands Bash may run without a permission prompt: the skill's own scripts
// (node), the folders it creates (mkdir), and read-only shell utilities the
// sessions use to read code. An auto-approve list, not a capability boundary.
const ALLOWED_BASH_COMMANDS = [
  'node', 'mkdir', 'cd', 'ls', 'cat', 'find', 'grep', 'rg', 'head', 'tail',
  'wc', 'sed', 'awk', 'sort', 'uniq', 'cut', 'tr', 'basename', 'echo',
];

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

// Write a step output ($GITHUB_OUTPUT), or print it when run locally. All
// values here are file paths — single-line, no delimiter games needed.
function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  } else {
    console.log(`${name}=${value}`);
  }
}

// The environment of the claude process: everything of this process except
// a GitHub token, which the session must never see.
function sessionEnv() {
  const { GH_TOKEN, GITHUB_TOKEN, ...env } = process.env;
  return env;
}

// Run one headless `claude` process: prompt on stdin, stream-json transcript
// collected from stdout, stderr passed through to the job log. Enforces
// SESSION_TIMEOUT_MS with SIGTERM, then SIGKILL after a grace period.
function runClaude(prompt, { cwd, additionalDirectories }) {
  const allowedTools = [
    ...ALLOWED_TOOLS,
    ...ALLOWED_BASH_COMMANDS.map((cmd) => `Bash(${cmd}:*)`),
  ].join(',');
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose', // required for stream-json in --print mode
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
      env: sessionEnv(),
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

// The final `result` event of the stream-json transcript, carrying the
// whole-session cost and outcome.
function extractResult(stdout) {
  let result = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // non-JSON noise; stream-json is one JSON object per line
    }
    if (event.type === 'result') result = event;
  }
  return result;
}

async function main() {
  const prNumber = process.argv[2] || process.env.PR_NUMBER;
  if (!prNumber) fail('PR number required (argv[2] or PR_NUMBER)');
  const runnerTemp = requireEnv('RUNNER_TEMP');
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();

  const workDir = path.join(runnerTemp, 'pr-presentation', 'work');
  if (!fs.existsSync(path.join(workDir, 'hunks.json'))) {
    fail(`Missing ${workDir}/hunks.json — run prepare-presentation.mjs first.`);
  }

  const outDir = path.join(runnerTemp, 'pr-presentation', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const transcriptPath = path.join(outDir, 'transcript.jsonl');
  const deckPath = path.join(outDir, `pr-${prNumber}-deck.html`);

  const run = await runClaude(`/pr-presentation ${workDir}`, {
    cwd: workspace,
    additionalDirectories: [workDir, SKILL_DIR],
  });

  // Persist the transcript and expose it before any failure check — a lost
  // run is exactly when the transcript is most useful for debugging.
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
