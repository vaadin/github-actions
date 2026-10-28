#!/usr/bin/env node
/**
 * Post or update the PR comment that links to the deck: the only step of the
 * action that writes to GitHub. One comment per PR: a hidden marker in the
 * body finds the comment of an earlier run, which is then updated in place.
 *
 * Environment: PR_NUMBER (or argv[2]), GITHUB_REPOSITORY, GH_TOKEN (the
 * comment token), ARTIFACT_URL, GITHUB_SERVER_URL, GITHUB_RUN_ID. With
 * DRY_RUN set, prints the body instead of posting it.
 *
 * Usage: node pr-presentation/post-comment.mjs <pr-number>
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
