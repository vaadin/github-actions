#!/usr/bin/env node
/**
 * Summarize a Claude Code run for the GitHub job summary.
 *
 * Accepts a stream-json execution log in either packaging: JSONL (the Claude
 * Code CLI's native output, one JSON object per line) or collected into one
 * JSON array (claude-code-action's execution file). The events inside are
 * identical. This script reads the log and surfaces the parts worth a
 * glance:
 *
 *   - a session summary (outcome, turns, duration, cost, token usage)
 *   - the tools Claude was denied, so the maintainer knows what to add to
 *     `--allowedTools`
 *
 * The summary is appended to $GITHUB_STEP_SUMMARY (or printed to stdout when
 * run locally).
 *
 * Usage:
 *   node lib/claude-summary.mjs <execution-file>
 */

import fs from 'node:fs';

// The log's events: a JSON array, or one JSON object per line (JSONL).
function readEvents(executionFile) {
  const raw = fs.readFileSync(executionFile, 'utf8');
  if (raw.trimStart().startsWith('[')) {
    const messages = JSON.parse(raw);
    if (!Array.isArray(messages)) {
      throw new Error('Execution file is not a JSON array of messages');
    }
    return messages;
  }
  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // non-JSON noise between events; skip
    }
  }
  return events;
}

// Pull the final result event out of the log. It is the last message with
// type "result" and carries the run's aggregates.
function readResult(executionFile) {
  const messages = readEvents(executionFile);
  const result = [...messages].reverse().find((m) => m && m.type === 'result');
  if (!result) {
    throw new Error('No result event found in execution file');
  }
  return result;
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatTokens(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : '—';
}

function formatCost(usd) {
  return typeof usd === 'number' ? `$${usd.toFixed(4)}` : '—';
}

// Show the bare command/url for the common single-field tool inputs; fall
// back to the raw JSON for anything else.
function denialInput(input) {
  if (!input) return '';
  return input.command ?? input.url ?? JSON.stringify(input);
}

// A short human-readable note for a denial, when the tool provides one.
// Bash inputs carry a `description`; other tools generally don't.
function denialNote(input) {
  return input && typeof input.description === 'string' ? input.description : '';
}

// Wrap text as inline code, choosing a backtick fence longer than any run of
// backticks in the content so commands containing backticks don't break out
// of the span. Pad with spaces when the content itself starts/ends with a
// backtick, per the CommonMark inline-code rules.
function inlineCode(text) {
  const str = String(text);
  let longestRun = 0;
  for (const match of str.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  const fence = '`'.repeat(longestRun + 1);
  const pad = str.startsWith('`') || str.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${str}${pad}${fence}`;
}

// The outcome is "success" or one of several error subtypes; is_error also
// flags a run that ended badly.
function outcomeLabel(result) {
  if (result.subtype === 'success' && !result.is_error) {
    return '✅ Success';
  }
  return `❌ ${result.subtype || 'error'}`;
}

function renderSessionSummary(result) {
  const lines = [];
  lines.push('## Claude Code session');
  lines.push('');
  lines.push('| Description | Value |');
  lines.push('|---|---|');
  lines.push(`| Outcome | ${outcomeLabel(result)} |`);
  lines.push(`| Turns | ${result.num_turns ?? '—'} |`);
  lines.push(`| Duration | ${formatDuration(result.duration_ms)} |`);
  lines.push(`| API time | ${formatDuration(result.duration_api_ms)} |`);
  lines.push(`| Cost | ${formatCost(result.total_cost_usd)} |`);
  if (result.session_id) {
    lines.push(`| Session | \`${result.session_id}\` |`);
  }
  lines.push('');
  return lines;
}

// modelUsage is keyed by model name; each entry has per-model token counts
// and cost. Render one row per model so multi-model runs stay readable.
function renderTokenUsage(result) {
  const modelUsage = result.modelUsage;
  if (!modelUsage || Object.keys(modelUsage).length === 0) {
    return [];
  }
  const lines = [];
  lines.push('### Token usage');
  lines.push('');
  lines.push('| Model | Input | Output | Cache read | Cache write | Cost |');
  lines.push('|---|--:|--:|--:|--:|--:|');
  for (const [model, u] of Object.entries(modelUsage)) {
    lines.push(
      `| \`${model}\` | ${formatTokens(u.inputTokens)} | ${formatTokens(u.outputTokens)} ` +
        `| ${formatTokens(u.cacheReadInputTokens)} | ${formatTokens(u.cacheCreationInputTokens)} ` +
        `| ${formatCost(u.costUSD)} |`
    );
  }
  lines.push('');
  return lines;
}

// Flatten the denials into a list of distinct (tool, input) pairs, collapsing
// exact duplicates into a count.
function collectDenials(denials) {
  const byKey = new Map();
  for (const denial of denials) {
    const tool = denial.tool_name;
    const input = denialInput(denial.tool_input);
    const key = `${tool} :: ${input}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(key, { tool, input, note: denialNote(denial.tool_input), count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

function renderPermissionDenials(result) {
  const denials = result.permission_denials || [];
  const lines = [];
  lines.push('### Permission denials');
  lines.push('');
  if (denials.length === 0) {
    lines.push('None — Claude used only allowed tools.');
    lines.push('');
    return lines;
  }
  lines.push(
    `Claude was blocked ${denials.length} time(s). Consider adding these to \`--allowedTools\`:`
  );
  lines.push('');
  for (const { tool, input, note, count } of collectDenials(denials)) {
    const times = count > 1 ? ` _(×${count})_` : '';
    const suffix = note ? ` — ${note}` : '';
    lines.push(`- \`${tool}\` ${inlineCode(input)}${suffix}${times}`);
  }
  lines.push('');
  return lines;
}

function main() {
  const executionFile = process.argv[2];
  if (!executionFile) {
    console.error('Usage: node lib/claude-summary.mjs <execution-file>');
    process.exit(2);
  }

  const result = readResult(executionFile);

  const markdown = [
    ...renderSessionSummary(result),
    ...renderTokenUsage(result),
    ...renderPermissionDenials(result)
  ];

  const output = markdown.join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${output}\n`);
  } else {
    console.log(output);
  }
}

main();
