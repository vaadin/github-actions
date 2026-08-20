#!/usr/bin/env node
/**
 * Prepare the review scope for the CI code review.
 *
 * It pre-computes everything the review needs so the review agent never has to
 * derive it, then writes a markdown inputs file that names each input by
 * absolute path; run-review.mjs inlines that file into the review prompt.
 *
 * Reads from the environment (set by GitHub Actions):
 *   PR_NUMBER / argv[2]  pull request number to review
 *   RUNNER_TEMP          base dir for generated files
 *   GITHUB_REPOSITORY    owner/repo, for the compare API
 *   GITHUB_WORKSPACE     PR head checkout (the review's working tree)
 *   GH_TOKEN             token for the gh CLI
 *
 * Produces under $RUNNER_TEMP/pr-review:
 *   pr.diff, pr-files.txt, pr-meta.json, base/ (merge-base worktree),
 *   existing-reviews.md (only when the PR already has reviews),
 *   review-inputs.md
 * Prints the review-inputs path to stdout.
 *
 * Usage:
 *   node code-review/prepare-review.mjs <pr-number>
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Diffs can be large; give captured output room.
const MAX_BUFFER = 100 * 1024 * 1024;

// Run a command, capture stdout as a string, let stderr pass through.
function capture(file, args) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
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

function buildReviewInputs({ metaPath, diffPath, filesPath, headPath, basePath, existingReviewsPath }) {
  return `- **PR metadata**: \`${metaPath}\` — title, description, author, labels. The
  title and description state the intent the change is reviewed against.
- **Diff**: \`${diffPath}\` — the complete review scope, exactly as GitHub
  renders it.
- **Changed files**: \`${filesPath}\`.
- **Head**: \`${headPath}\` — the PR head checkout and the review's working tree;
  read related and surrounding code here.
- **Base (pre-change state)**: \`${basePath}\` — a checkout of the merge-base;
  consult it when a finding depends on prior behavior.
${existingReviewsPath ? `- **Existing reviews**: \`${existingReviewsPath}\` — every review and review
  thread already posted on the PR.
` : ''}`;
}

// --- Existing reviews ---------------------------------------------------------
// Threads come from the reviewThreads connection — the only source of
// resolution state; the flat reviews connection supplies summary bodies and
// verdicts.

const REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100) {
        nodes { author { login } state body submittedAt }
      }
      reviewThreads(first: 100) {
        nodes {
          isResolved isOutdated path line originalLine
          comments(first: 50) {
            nodes { author { login } body createdAt isMinimized }
          }
        }
      }
    }
  }
}`;

function fetchExistingReviews(repo, prNumber) {
  const [owner, name] = repo.split('/');
  const output = capture('gh', [
    'api', 'graphql',
    '-f', `query=${REVIEWS_QUERY}`,
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
    '-F', `number=${prNumber}`,
  ]);
  return JSON.parse(output).data.repository.pullRequest;
}

function timestamp(iso) {
  return iso.slice(0, 16).replace('T', ' ') + ' UTC';
}

function authorLogin(node) {
  return node.author?.login || 'ghost';
}

const REVIEW_ACTIONS = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
};

function threadStatus(thread) {
  if (thread.isResolved) return 'resolved';
  return thread.isOutdated ? 'unresolved, outdated' : 'unresolved';
}

function threadLocation(thread) {
  if (thread.line) return `${thread.path}:${thread.line}`;
  if (thread.originalLine) return `${thread.path}:${thread.originalLine} (outdated position)`;
  return thread.path;
}

// Render the existing reviews as a chronological markdown timeline, or null
// when there is nothing to show. A thread is anchored at its first comment
// and keeps its replies nested so it stays one unit.
function renderExistingReviews(pr) {
  const events = [];

  // GitHub creates an empty COMMENTED review shell for every standalone
  // thread reply; only bodies and explicit verdicts carry information.
  for (const review of pr.reviews.nodes) {
    const body = (review.body || '').trim();
    const action = REVIEW_ACTIONS[review.state];
    if (!body && !action) continue;
    events.push({
      at: review.submittedAt,
      lines: [
        `## ${timestamp(review.submittedAt)} — @${authorLogin(review)} ${action || 'reviewed'}`,
        '',
        ...(body ? [body, ''] : []),
      ],
    });
  }

  for (const thread of pr.reviewThreads.nodes) {
    const comments = thread.comments.nodes.filter(
      (c) => !c.isMinimized && (c.body || '').trim()
    );
    if (!comments.length) continue;
    const [first, ...replies] = comments;
    const lines = [
      `## ${timestamp(first.createdAt)} — @${authorLogin(first)} commented on \`${threadLocation(thread)}\` — ${threadStatus(thread)}`,
      '',
      first.body.trim(),
      '',
    ];
    for (const reply of replies) {
      lines.push(`**@${authorLogin(reply)} replied** (${timestamp(reply.createdAt)}):`, '', reply.body.trim(), '');
    }
    events.push({ at: first.createdAt, lines });
  }

  if (!events.length) return null;
  events.sort((a, b) => a.at.localeCompare(b.at));

  const threads = pr.reviewThreads.nodes;
  const unresolved = threads.filter((t) => !t.isResolved).length;
  return [
    '# Existing reviews on this PR',
    '',
    `${threads.length} review threads (${unresolved} unresolved, ${threads.length - unresolved} resolved), in chronological order.`,
    '',
    ...events.flatMap((e) => e.lines),
  ].join('\n').trimEnd() + '\n';
}

function main() {
  const prNumber = process.argv[2] || process.env.PR_NUMBER;
  if (!prNumber) {
    console.error('PR number required (argv[2] or PR_NUMBER)');
    process.exit(2);
  }
  const runnerTemp = requireEnv('RUNNER_TEMP');
  const repo = requireEnv('GITHUB_REPOSITORY');
  const headPath = process.env.GITHUB_WORKSPACE || process.cwd();

  const scopeDir = path.join(runnerTemp, 'pr-review');
  fs.mkdirSync(scopeDir, { recursive: true });

  const diffPath = path.join(scopeDir, 'pr.diff');
  const filesPath = path.join(scopeDir, 'pr-files.txt');
  const metaPath = path.join(scopeDir, 'pr-meta.json');
  const basePath = path.join(scopeDir, 'base');
  const existingReviewsPath = path.join(scopeDir, 'existing-reviews.md');
  const reviewInputsPath = path.join(scopeDir, 'review-inputs.md');

  // The diff exactly as GitHub renders it, the changed-file list, and metadata.
  fs.writeFileSync(diffPath, capture('gh', ['pr', 'diff', prNumber]));
  fs.writeFileSync(filesPath, capture('gh', ['pr', 'diff', prNumber, '--name-only']));
  fs.writeFileSync(
    metaPath,
    capture('gh', [
      'pr', 'view', prNumber,
      '--json', 'title,body,author,labels,baseRefName,headRefName',
    ])
  );

  // Merge-base = the pre-change state, resolved by the compare API regardless
  // of local history or where the base branch has moved since.
  const headSha = capture('gh', ['pr', 'view', prNumber, '--json', 'headRefOid', '--jq', '.headRefOid']).trim();
  const baseRefSha = capture('gh', ['pr', 'view', prNumber, '--json', 'baseRefOid', '--jq', '.baseRefOid']).trim();
  const baseSha = capture('gh', ['api', `repos/${repo}/compare/${baseRefSha}...${headSha}`, '--jq', '.merge_base_commit.sha']).trim();

  execFileSync('git', ['fetch', '--depth=1', 'origin', baseSha], { stdio: 'inherit' });
  execFileSync('git', ['worktree', 'add', basePath, baseSha], { stdio: 'inherit' });

  // Existing reviews, only when there are any.
  const existingReviews = renderExistingReviews(fetchExistingReviews(repo, prNumber));
  if (existingReviews) fs.writeFileSync(existingReviewsPath, existingReviews);

  fs.writeFileSync(
    reviewInputsPath,
    buildReviewInputs({
      metaPath, diffPath, filesPath, headPath, basePath,
      existingReviewsPath: existingReviews ? existingReviewsPath : null,
    })
  );

  console.log(reviewInputsPath);
}

main();
