#!/usr/bin/env node
/**
 * Post or update the PR comment that links to the deck.
 *
 * Runs in the pr-presentation action as a plain step, after the deck is
 * uploaded as an artifact, with the comment token: the only step of the
 * action that writes to GitHub. One comment per PR: a hidden marker in the
 * body finds the comment of an earlier run, which is then updated in place.
 *
 * The comment is minimal: one line with the link, and a <sub> line with the
 * generation time that links to the workflow run.
 *
 * Reads from the environment (set by GitHub Actions):
 *   PR_NUMBER / argv[2]  pull request number
 *   GITHUB_REPOSITORY    owner/repo
 *   GH_TOKEN             token with pull-requests write; its identity is the
 *                        comment author
 *   ARTIFACT_URL         the artifact-url output of the upload step
 *   GITHUB_SERVER_URL, GITHUB_RUN_ID
 *                        the workflow run, linked from the time stamp
 *   DRY_RUN              if set, print the body and exit without calling the
 *                        GitHub API
 *
 * Usage:
 *   node pr-presentation/post-comment.mjs <pr-number>
 */

import { execFileSync } from 'node:child_process';

const MARKER = '<!-- pr-presentation -->';

function capture(file, args) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
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

// 2026-10-27 15:12 UTC
function timestamp(date) {
  return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function commentBody({ artifactUrl, runUrl, generatedAt }) {
  return [
    `[Slide deck](${artifactUrl}) that explains this pull request from its code.`,
    '',
    `<sub>Generated [${timestamp(generatedAt)}](${runUrl})</sub>`,
    '',
    MARKER,
  ].join('\n');
}

// The id of the comment of an earlier run, or null.
function findExistingComment(repo, prNumber) {
  const ids = capture('gh', [
    'api', `repos/${repo}/issues/${prNumber}/comments`, '--paginate',
    '--jq', `.[] | select(.body | contains("${MARKER}")) | .id`,
  ]).trim();
  return ids ? ids.split('\n')[0] : null;
}

function main() {
  const prNumber = process.argv[2] || process.env.PR_NUMBER;
  if (!prNumber) {
    console.error('PR number required (argv[2] or PR_NUMBER)');
    process.exit(2);
  }
  const repo = requireEnv('GITHUB_REPOSITORY');
  const artifactUrl = requireEnv('ARTIFACT_URL');
  const runUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${requireEnv('GITHUB_RUN_ID')}`;

  const body = commentBody({ artifactUrl, runUrl, generatedAt: new Date() });

  if (process.env.DRY_RUN) {
    console.log('--- comment body ---\n');
    console.log(body);
    return;
  }

  const existing = findExistingComment(repo, prNumber);
  const response = existing
    ? capture('gh', ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existing}`, '-f', `body=${body}`])
    : capture('gh', ['api', '-X', 'POST', `repos/${repo}/issues/${prNumber}/comments`, '-f', `body=${body}`]);
  const comment = JSON.parse(response);
  console.log(`${existing ? 'Updated' : 'Posted'} comment ${comment.html_url} as ${comment.user.login}`);
}

main();
