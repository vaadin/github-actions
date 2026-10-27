#!/usr/bin/env node
/**
 * Prepare the inputs of the PR presentation.
 *
 * Everything the skill's collect and split steps produce is deterministic, so
 * this step does it before the Claude session starts, with the read-only
 * token: the session itself then needs no GitHub access at all.
 *
 * The checkout in CI is shallow, so `git merge-base` has nothing to work
 * with. The merge base comes from the compare API instead, and that commit
 * and the PR head are fetched with depth 1: the diff and the two worktrees
 * need only the two trees.
 *
 * Reads from the environment (set by GitHub Actions):
 *   PR_NUMBER / argv[2]  pull request number
 *   RUNNER_TEMP          base dir for generated files
 *   GITHUB_REPOSITORY    owner/repo
 *   GITHUB_WORKSPACE     a checkout of the repository (any ref; both commits
 *                        are fetched into it)
 *   GH_TOKEN             read-only token for the gh CLI
 *
 * Produces $RUNNER_TEMP/pr-presentation/work, the <WORK> folder of the skill:
 *   pr.json, pr.diff, context.md, src/base, src/head   from scripts/collect.mjs
 *   hunks.json, annotated.md                           from scripts/hunks.mjs split
 *
 * Usage:
 *   node pr-presentation/prepare-presentation.mjs <pr-number>
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(HERE, 'plugin', 'skills', 'pr-presentation');

// Diffs can be large; give captured output room.
const MAX_BUFFER = 100 * 1024 * 1024;

function capture(file, args, opts = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'inherit'],
    ...opts,
  });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} must be set`);
    process.exit(2);
  }
  return value;
}

function main() {
  const prNumber = process.argv[2] || process.env.PR_NUMBER;
  if (!prNumber) {
    console.error('PR number required (argv[2] or PR_NUMBER)');
    process.exit(2);
  }
  const runnerTemp = requireEnv('RUNNER_TEMP');
  const repo = requireEnv('GITHUB_REPOSITORY');
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const workDir = path.join(runnerTemp, 'pr-presentation', 'work');
  fs.mkdirSync(workDir, { recursive: true });

  // Merge base = the pre-change state, resolved by the compare API regardless
  // of local history or where the base branch has moved since.
  const prJson = capture('gh', ['pr', 'view', prNumber, '--repo', repo, '--json', 'headRefOid,baseRefOid']);
  const { headRefOid: headSha, baseRefOid: baseRefSha } = JSON.parse(prJson);
  const mergeBase = capture('gh', [
    'api', `repos/${repo}/compare/${baseRefSha}...${headSha}`, '--jq', '.merge_base_commit.sha',
  ]).trim();

  execFileSync('git', ['fetch', '--depth=1', 'origin', mergeBase, headSha], {
    stdio: 'inherit', cwd: workspace,
  });

  execFileSync('node', [
    path.join(SKILL_DIR, 'scripts', 'collect.mjs'),
    '--pr', String(prNumber), '--repo', repo, '--root', workspace,
    '--merge-base', mergeBase, '--out', workDir,
  ], { stdio: 'inherit' });

  execFileSync('node', [
    path.join(SKILL_DIR, 'scripts', 'hunks.mjs'),
    'split', '--diff', path.join(workDir, 'pr.diff'), '--out', workDir,
  ], { stdio: 'inherit' });

  console.log(workDir);
}

main();
