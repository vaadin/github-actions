#!/usr/bin/env node
/**
 * Run the CI code review: one headless Claude Code session reviews the
 * prepared PR inputs, grades each of its own findings into a value tier, and
 * reports once as structured output; then mechanical selection decides what
 * ships.
 *
 * The session is read-only. --tools restricts the set the model is offered to
 * research tools (no Write/Edit, no subagents, no web) — --allowedTools does
 * not do that: it is only an auto-approve list for the permission layer, used
 * here to approve the read-only Bash commands below. The StructuredOutput
 * tool injected by --json-schema survives --tools and is auto-allowed.
 *
 * The agent never hears which value tiers ship: selection is mechanical here
 * (VALUE_BAR), so the agent has no incentive to inflate borderline findings
 * into a "kept" tier. Findings at or above the bar go to the findings file
 * that post-review.mjs posts; ALL findings, with their judgements, go to a
 * markdown summary kept as a workflow artifact for reviewing how the
 * pipeline performs.
 *
 * Failure semantics are strict: a session that exits non-zero, times out, or
 * never produces structured output fails the run — a lost review is never
 * mistaken for a clean "no findings" result.
 *
 * Reads from the environment (set by GitHub Actions):
 *   RUNNER_TEMP          expects the prepared review inputs in
 *                        $RUNNER_TEMP/pr-review; writes all outputs to
 *                        $RUNNER_TEMP/review-output
 *   GITHUB_WORKSPACE     the PR head checkout; the session's working tree
 *   ANTHROPIC_API_KEY    inherited by the claude process (bills the review)
 *   SETTINGS             optional settings JSON for --settings, produced by
 *                        lib/claude-prepare.mjs (carries additionalDirectories)
 *   EXTRA_ALLOWED_TOOLS  optional repository-specific --allowedTools additions,
 *                        comma- or newline-separated
 *
 * Produces under $RUNNER_TEMP/review-output:
 *   transcript.jsonl     the session's stream-json transcript (execution log)
 *   findings.json        the emitted findings; the input of post-review.mjs
 *   findings-summary.md  every finding with judgement and value; the artifact
 *
 * Writes step outputs ($GITHUB_OUTPUT) for the later action steps:
 * execution-file, findings-file. execution-file is written as soon as the
 * transcript exists, so the log survives a failed run.
 *
 * Usage:
 *   node code-review/run-review.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Tuning constants -------------------------------------------------------
// Deliberately hard-coded; each is a one-line edit.

// The session's model, passed as an explicit ID so the pinned Claude Code
// version (see action.yml) can move independently of the model.
const MODEL = 'claude-opus-5';

// The minimum value tier a finding needs to be posted to the PR. The prompt
// never mentions it: the agent classifies, this script selects. 'medium'
// posts high+medium; 'high' posts high only; 'low' posts everything.
const VALUE_BAR = 'medium';

// Hard timeout on the review session; a hung CLI process fails the run
// instead of burning the job's full time budget.
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// --- Tool surface -----------------------------------------------------------

// The tools the model is offered (via --tools): research tools only, so the
// read-only claim is true at the model layer.
const TOOLS = 'Read,Grep,Glob,Bash';

// Read-only commands Bash may run without a permission prompt. An
// auto-approve list, not a capability boundary — that is --tools above. Kept
// as bare command names so the same list feeds both --allowedTools and the
// command list advertised to the agent in prompts/_tools.md: an advertised
// allowlist that has drifted from the real one is worse than none at all.
//
// `sed` and `awk` are a deliberate compromise: prefix patterns cannot exclude
// flags, so `Bash(sed:*)` also admits `sed -i`. --tools withholding
// Write/Edit is the real guarantee here; a review agent has no motive to
// mutate the tree.
const ALLOWED_BASH_COMMANDS = [
  'git diff', 'git log', 'git show', 'git blame', 'git status',
  'ls', 'cat', 'find', 'grep', 'rg', 'head', 'tail', 'wc',
  'sed', 'awk', 'sort', 'uniq', 'comm', 'diff', 'cut', 'tr', 'basename',
];

const TIER_RANK = { high: 3, medium: 2, low: 1 };

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} must be set`);
  return value;
}

// Normalize a comma- or newline-separated tool list, dropping empty entries.
function parseToolList(raw) {
  return (raw || '')
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
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

// Run one headless `claude` process: prompt on stdin, stream-json transcript
// collected from stdout, stderr passed through to the job log. Enforces
// SESSION_TIMEOUT_MS with SIGTERM, then SIGKILL after a grace period.
function runClaude(prompt, { cwd, allowedTools, toolInstructions, schema, settings }) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose', // required for stream-json in --print mode
    '--model', MODEL,
    '--tools', TOOLS,
    '--allowedTools', allowedTools,
    '--append-system-prompt', toolInstructions,
    '--json-schema', JSON.stringify(schema),
  ];
  if (settings) args.push('--settings', settings);

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      cwd,
      env: process.env,
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
// whole-session cost and the schema-validated `structured_output` payload.
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

// --- Findings summary -------------------------------------------------------
// One markdown document over ALL findings — posted and withheld — with the
// agent's judgement and value tier for each, so the pipeline's selection
// behavior can be reviewed from the artifact alone.

function findingLocation(finding) {
  return typeof finding.line === 'number'
    ? `${finding.file}:${finding.line}`
    : finding.file;
}

function oneLine(text) {
  return String(text ?? '').replace(/\s*\n\s*/g, ' ').trim();
}

function summaryMarkdown(emitted, withheld) {
  const listEntry = (f) =>
    `- [${f.value}] \`${findingLocation(f)}\` (${f.category}) — ${oneLine(f.summary)}`;
  const section = (title, items) => [
    `## ${title} (${items.length})`,
    '',
    ...(items.length ? items.map(listEntry) : ['_none_']),
    '',
  ];
  const detailEntry = (f) => [
    `### [${f.value}] \`${findingLocation(f)}\` (${f.category})`,
    '',
    `**Summary:** ${f.summary}`,
    '',
    String(f.explanation ?? '').trim(),
    '',
    `**Judgement:** ${f.judgement}`,
    '',
  ].join('\n');
  const details = [...emitted, ...withheld];
  return [
    '# Code review findings',
    '',
    `Every finding the review agent reported, with its judgement and value`,
    `tier. Findings at or above the \`${VALUE_BAR}\` bar were posted to the`,
    'PR; the rest were withheld.',
    '',
    ...section('Posted findings', emitted),
    ...section('Withheld findings (below the bar)', withheld),
    '## Finding details',
    '',
    ...(details.length ? details.map(detailEntry) : ['_none_', '']),
  ].join('\n').trimEnd();
}

async function main() {
  const runnerTemp = requireEnv('RUNNER_TEMP');
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();

  const reviewInputsPath = path.join(runnerTemp, 'pr-review', 'review-inputs.md');
  if (!fs.existsSync(reviewInputsPath)) {
    fail(`Missing ${reviewInputsPath} — run prepare-review.mjs first.`);
  }
  const reviewInputs = fs.readFileSync(reviewInputsPath, 'utf8').trim();

  const outDir = path.join(runnerTemp, 'review-output');
  fs.mkdirSync(outDir, { recursive: true });
  const transcriptPath = path.join(outDir, 'transcript.jsonl');
  const findingsPath = path.join(outDir, 'findings.json');
  const summaryPath = path.join(outDir, 'findings-summary.md');

  const prompt = fs
    .readFileSync(path.join(HERE, 'prompts', 'review.md'), 'utf8')
    .replaceAll('{{REVIEW_INPUTS}}', reviewInputs);
  const toolInstructions = fs
    .readFileSync(path.join(HERE, 'prompts', '_tools.md'), 'utf8')
    .replaceAll('{{BASH_COMMANDS}}', ALLOWED_BASH_COMMANDS.join(', '));
  const schema = JSON.parse(
    fs.readFileSync(path.join(HERE, 'review-schema.json'), 'utf8')
  );

  const allowedTools = [
    ...ALLOWED_BASH_COMMANDS.map((cmd) => `Bash(${cmd}:*)`),
    ...parseToolList(process.env.EXTRA_ALLOWED_TOOLS),
  ].join(',');

  const run = await runClaude(prompt, {
    cwd: workspace,
    allowedTools,
    toolInstructions,
    schema,
    settings: process.env.SETTINGS || '',
  });

  // Persist the transcript and expose it before any failure check — a lost
  // review is exactly when the transcript is most useful for debugging.
  fs.writeFileSync(transcriptPath, run.stdout || '');
  writeOutput('execution-file', transcriptPath);

  if (run.timedOut) {
    fail(`Review timed out after ${SESSION_TIMEOUT_MS / 60000} minutes.`);
  }
  if (run.status !== 0) {
    fail(`Review session exited ${run.status} — see the log above.`);
  }
  const result = extractResult(run.stdout || '');
  const report = result?.structured_output;
  if (!report || !Array.isArray(report.findings)) {
    fail('Review produced no structured output — the review was lost.');
  }
  const curated = report.findings;

  // --- Mechanical selection -------------------------------------------------
  // The agent classified; the pipeline decides what ships. Tier order within
  // the posted set: high before medium (report order preserved within a tier).
  const bar = TIER_RANK[VALUE_BAR];
  const emitted = curated
    .filter((f) => TIER_RANK[f.value] >= bar)
    .sort((a, b) => TIER_RANK[b.value] - TIER_RANK[a.value]);
  const withheld = curated.filter((f) => !(TIER_RANK[f.value] >= bar));

  fs.writeFileSync(
    findingsPath,
    JSON.stringify({ findings: emitted }, null, 2) + '\n'
  );
  fs.writeFileSync(summaryPath, summaryMarkdown(emitted, withheld) + '\n');
  writeOutput('findings-file', findingsPath);

  const cost =
    typeof result.total_cost_usd === 'number'
      ? ` ($${result.total_cost_usd.toFixed(2)})`
      : '';
  console.log(
    `Review reported ${curated.length} finding(s): ${emitted.length} to post, ` +
      `${withheld.length} below the bar${cost}.`
  );
}

main().catch((err) => fail(String(err?.stack || err)));
