#!/usr/bin/env node
/**
 * Decide whether the review can be skipped because the PR head commit was
 * already reviewed under the identity of the github-token.
 *
 * Runs in the code-review action as its first step when the skip-if-reviewed
 * input is 'true'. An automatic trigger such as marking a draft ready for
 * review otherwise reviews a commit again that an earlier requested review
 * already covered. Only submitted reviews count; a pending review left behind
 * by an interrupted run does not.
 *
 * Reads from the environment (set by GitHub Actions):
 *   PR_NUMBER / argv[2]  pull request number
 *   GITHUB_REPOSITORY    owner/repo
 *   GH_TOKEN             token for the gh CLI; its identity is the review
 *                        author
 *
 * Writes the step output ($GITHUB_OUTPUT) `skip`: 'true' when the head commit
 * already has a review by that identity, else 'false'.
 *
 * Usage:
 *   node code-review/check-reviewed.mjs <pr-number>
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} must be set`);
    process.exit(2);
  }
  return value;
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  } else {
    console.log(`${name}=${value}`);
  }
}

// viewerDidAuthor tells the token's own reviews apart without resolving its
// login, which an installation token cannot do through the viewer field.
const REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviews(last: 100) {
        nodes { viewerDidAuthor state url commit { oid } }
      }
    }
  }
}`;

function main() {
  const prNumber = process.argv[2] || process.env.PR_NUMBER;
  if (!prNumber) {
    console.error('PR number required (argv[2] or PR_NUMBER)');
    process.exit(2);
  }
  const repo = requireEnv('GITHUB_REPOSITORY');
  const [owner, name] = repo.split('/');

  const output = execFileSync('gh', [
    'api', 'graphql',
    '-f', `query=${REVIEWS_QUERY}`,
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
    '-F', `number=${prNumber}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const pr = JSON.parse(output).data.repository.pullRequest;

  const earlier = pr.reviews.nodes.find(
    (review) =>
      review.viewerDidAuthor &&
      review.state !== 'PENDING' &&
      review.commit?.oid === pr.headRefOid
  );
  if (earlier) {
    console.log(`Head ${pr.headRefOid} was already reviewed in ${earlier.url}; skipping the review.`);
  }
  writeOutput('skip', earlier ? 'true' : 'false');
}

main();
