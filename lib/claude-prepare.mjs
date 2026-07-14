#!/usr/bin/env node
/**
 * Prepare a Claude Code run, shared by the claude-code and code-review
 * actions: clone the configured read-only reference repositories, inject the
 * generated instructions into the workspace, and compute the settings and
 * tool allowlist passed to anthropics/claude-code-action. Outputs are written
 * to $GITHUB_OUTPUT, or printed to stdout when run locally.
 *
 * The reference-checkout section and the caller's extra instructions are
 * injected by appending to CLAUDE.local.md in the workspace.
 *
 * Inputs (environment):
 *   REFERENCE_REPOS      optional multiline list, one "owner/repo | description"
 *                        per line
 *   EXTRA_INSTRUCTIONS   optional repository-specific instructions for Claude,
 *                        appended after the generated reference section
 *   BASE_ALLOWED_TOOLS   base tool allowlist (comma- or newline-separated)
 *   EXTRA_ALLOWED_TOOLS  optional allowlist additions (same format)
 *   EXTRA_ADDITIONAL_DIRECTORIES
 *                        optional newline-separated directories to expose as
 *                        additional working directories beyond the reference
 *                        checkouts
 *   RUNNER_TEMP          the runner's temp directory
 *   GITHUB_WORKSPACE     the checkout Claude runs in; receives CLAUDE.local.md
 *
 * Outputs ($GITHUB_OUTPUT):
 *   allowed_tools        combined value for --allowedTools
 *   settings             claude-code-action settings JSON ('' when unused)
 *
 * Usage:
 *   node lib/claude-prepare.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Parse the reference-repos input: one repository per line, an "owner/repo"
// slug optionally followed by " | description". The description is included
// verbatim in the generated instructions.
function parseReferenceRepos(raw) {
  const repos = [];
  const names = new Set();
  for (const rawLine of (raw || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const [slugPart, ...descriptionParts] = line.split('|');
    const slug = slugPart.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) {
      throw new Error(
        `Invalid reference-repos line: "${line}". Expected "owner/repo | description".`
      );
    }
    // Checkout directory name: the repo name, prefixed with the owner if two
    // entries would otherwise collide.
    let name = slug.split('/')[1];
    if (names.has(name)) name = slug.replace('/', '-');
    if (names.has(name)) {
      throw new Error(`Duplicate reference repository: "${slug}"`);
    }
    names.add(name);
    repos.push({ slug, name, description: descriptionParts.join('|').trim() });
  }
  return repos;
}

function cloneReferenceRepos(repos, referenceDir) {
  for (const repo of repos) {
    repo.dir = path.join(referenceDir, repo.name);
    execFileSync(
      'git',
      ['clone', '--depth', '1', `https://github.com/${repo.slug}.git`, repo.dir],
      { stdio: 'inherit' }
    );
  }
}

// Requires the repositories to be cloned already, so their checkout paths can
// be included in the instructions.
function buildReferenceSection(repos) {
  const repoList = repos
    .map((repo) => {
      const description = repo.description ? ` — ${repo.description}` : '';
      return `- **${repo.slug}** (at \`${repo.dir}\`)${description}`;
    })
    .join('\n');
  return `# Upstream reference checkouts

When running in CI, read-only checkouts of the following upstream
repositories are available as additional working directories, for extra
context only:

${repoList}

## How to use them

- Consult these checkouts only when the code and docs in this repository do not
  answer the question. They are a deliberate side-trip, not part of normal
  research.
- When you search them, pass the reference directory to Grep/Glob explicitly.
  Never run a repository-wide search that mixes reference sources into results
  for this repository.
- Reference only: never modify, stage, or commit anything inside them.
- They track each repository's default branch and may not match the versions
  this repository depends on. Never treat them as authoritative over this
  repository's own dependencies.`;
}

// Keep the injected file out of git without touching the repository's own
// .gitignore: in tag mode Claude has git add/commit permissions and must
// never commit the injected instructions to the PR branch, and during code
// reviews an untracked file would be noise in git status output.
// .git/info/exclude is local to the checkout, so nothing leaks into commits.
function excludeFromGit(workspace, name) {
  const gitDir = path.join(workspace, '.git');
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return;
  const infoDir = path.join(gitDir, 'info');
  const excludeFile = path.join(infoDir, 'exclude');
  const existing = fs.existsSync(excludeFile)
    ? fs.readFileSync(excludeFile, 'utf8')
    : '';
  if (existing.split('\n').includes(name)) return;
  fs.mkdirSync(infoDir, { recursive: true });
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(excludeFile, `${separator}${name}\n`);
}

// Append the generated instructions to CLAUDE.local.md in the workspace. A CI
// checkout normally has no CLAUDE.local.md (it is a gitignore-by-convention
// file), but appending keeps an existing one intact.
function injectInstructions(workspace, sections) {
  if (sections.length === 0) return;
  const file = path.join(workspace, 'CLAUDE.local.md');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const separator =
    existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  fs.appendFileSync(file, `${separator}${sections.join('\n\n')}\n`);
  excludeFromGit(workspace, 'CLAUDE.local.md');
}

// Normalize a comma- or newline-separated tool list into a single
// comma-separated line, dropping empty entries.
function parseToolList(raw) {
  return (raw || '')
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// Normalize a newline-separated directory list, dropping empty entries.
function parseDirectoryList(raw) {
  return (raw || '')
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// Write a (possibly multi-line) value to $GITHUB_OUTPUT under `name` using the
// heredoc form GitHub expects. The delimiter must not appear in the value; all
// values are fully controlled here and never contain it.
function writeOutput(name, value) {
  const delimiter = 'CLAUDE_PREPARE_EOF';
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `${name}<<${delimiter}\n${value}\n${delimiter}\n`
    );
  } else {
    console.log(`${name}=${value}`);
  }
}

function main() {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) {
    console.error('RUNNER_TEMP must be set');
    process.exit(2);
  }
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();

  const repos = parseReferenceRepos(process.env.REFERENCE_REPOS);
  cloneReferenceRepos(repos, path.join(runnerTemp, 'reference'));

  // The injected instructions: the generated reference-checkout section (when
  // any are configured), followed by the caller's own additions.
  const sections = [];
  if (repos.length > 0) {
    sections.push(buildReferenceSection(repos));
  }
  const extraInstructions = (process.env.EXTRA_INSTRUCTIONS || '').trim();
  if (extraInstructions) {
    sections.push(extraInstructions);
  }
  injectInstructions(workspace, sections);

  // Extra working directories go through settings instead of --add-dir: the
  // action's claude_args parser takes only a single value per --add-dir flag
  // and overwrites repeated flags, silently dropping all but one directory
  // (see base-action/src/parse-sdk-options.ts).
  const additionalDirectories = [
    ...repos.map((repo) => repo.dir),
    ...parseDirectoryList(process.env.EXTRA_ADDITIONAL_DIRECTORIES)
  ];
  const settings =
    additionalDirectories.length > 0
      ? JSON.stringify({ permissions: { additionalDirectories } })
      : '';

  const allowedTools = [
    ...parseToolList(process.env.BASE_ALLOWED_TOOLS),
    ...parseToolList(process.env.EXTRA_ALLOWED_TOOLS)
  ].join(',');

  writeOutput('allowed_tools', allowedTools);
  writeOutput('settings', settings);
}

main();
