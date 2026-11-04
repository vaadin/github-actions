#!/usr/bin/env node
/**
 * Post the code-review findings to the PR as one review.
 *
 * Runs in the code-review action as a plain step, after run-review.mjs. Reads
 * the findings file that step wrote: the curated findings at or above the
 * value bar. run-review.mjs fails the job when the review session is lost, so
 * this step only ever sees a real result. An empty findings array is a real
 * result and posts a body-only "no findings" review.
 *
 * Every finding is posted as its own inline review thread, demoted
 * line-level → file-level → summary list as anchoring fails. The summary body
 * holds the overview line, the risk of the change (when the profile rates
 * it), a table over all findings, and the full prose of any findings that
 * could not be attached to the diff.
 *
 * Posting uses the GraphQL pending-review flow so all threads and the summary
 * are posted as one review (single notification).
 *
 * With AUTO_APPROVE, a review without findings approves the PR instead of
 * commenting, when the risk is at or below AUTO_APPROVE_MAX_RISK, the title
 * has one of AUTO_APPROVE_TYPES, and the PR head is still the reviewed commit.
 * When GitHub refuses the approval (the token may not approve, or it belongs
 * to the PR author), the review posts as a comment instead. An approval holds
 * only while the latest review approves the head it reviewed: after posting,
 * the run dismisses the approvals on commits other than the head, its own
 * included when the head moved while it approved, and the one on the head
 * when that is the commit it reviewed and did not approve. The action's
 * dismiss-stale-approval mode dismisses them on every push. Only the
 * approvals of the GH_TOKEN identity are dismissed, so human ones stay.
 *
 * Reads from the environment (set by GitHub Actions):
 *   PR_NUMBER / argv[2]  pull request number reviewed
 *   FINDINGS_FILE        findings JSON written by run-review.mjs
 *                        ({findings: [...], risk?}); each finding has file,
 *                        line, summary, explanation, category, judgement,
 *                        value; risk has level and reason
 *   GITHUB_REPOSITORY    owner/repo
 *   GH_TOKEN             token for the gh CLI; its identity is the review
 *                        author
 *   GITHUB_WORKSPACE     the reviewed PR head checkout; its HEAD is the
 *                        reviewed commit
 *   AUTO_APPROVE         'true' to approve PRs that meet the conditions
 *   AUTO_APPROVE_MAX_RISK  highest accepted risk level; default 'low'
 *   AUTO_APPROVE_TYPES   accepted conventional commit types of the title,
 *                        comma- or newline-separated; default
 *                        'chore, docs, test'
 *   DRY_RUN              if set, print the routing and rendered bodies and
 *                        exit without calling the GitHub API
 *
 * Usage:
 *   node code-review/post-review.mjs <pr-number>
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_BUFFER = 100 * 1024 * 1024;

function capture(file, args) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} must be set`);
  return value;
}

// The pull request the scripts work on: its number from argv[2] or
// PR_NUMBER, and its repository from GITHUB_REPOSITORY.
export function prArguments() {
  const prNumber = process.argv[2] || process.env.PR_NUMBER;
  if (!prNumber) fail('PR number required (argv[2] or PR_NUMBER)');
  return { prNumber: Number(prNumber), repo: requireEnv('GITHUB_REPOSITORY') };
}

// Run a GraphQL query/mutation via gh. Numbers go through -F so they arrive
// typed; everything else as strings (valid over the wire for enums and IDs).
function graphql(query, variables = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
  }
  return JSON.parse(capture('gh', args)).data;
}

function normalize(finding) {
  return {
    ...finding,
    category: (finding.category || 'uncategorized').toLowerCase(),
  };
}

// --- Rendering ------------------------------------------------------------
// Every finding starts with a category emoji on the title and ends in the
// same meta line: file link, category.

// The categories of every profile: code, then docs. A profile reuses a
// category, such as conventions, when it means the same thing.
const CATEGORY_EMOJI = {
  correctness: '⚠️',
  documentation: '📝',
  tests: '🧪',
  conventions: '📐',
  accuracy: '⚠️',
  clarity: '💬',
  examples: '🧩',
  placement: '🗂️',
};

function categoryEmoji(finding) {
  return CATEGORY_EMOJI[finding.category] || '👀';
}

function findingTitle(finding) {
  return `**${categoryEmoji(finding)} ${finding.summary}**`;
}

// Pipes would break the table; newlines can't appear inside a cell.
function tableCell(text) {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

// One table over ALL findings, commented and unanchored alike, in report
// order (most severe first). The first column holds only the category emoji.
function findingsTable(findings) {
  return [
    '| | Finding |',
    '| --- | --- |',
    ...findings.map((f) => `| ${categoryEmoji(f)} | ${tableCell(f.summary)} |`),
  ].join('\n');
}

function fileLabel(finding) {
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}

// Link to the blob at the head SHA so non-anchored findings stay clickable.
function fileLink(repo, headSha, finding) {
  if (!finding.file) return null;
  const base = finding.file.split('/').pop();
  const label = finding.line ? `${base}:${finding.line}` : base;
  const anchor = finding.line ? `#L${finding.line}` : '';
  return `[${label}](https://github.com/${repo}/blob/${headSha}/${encodeURI(finding.file)}${anchor})`;
}

function findingMeta(repo, headSha, finding) {
  const meta = [fileLink(repo, headSha, finding), `\`${finding.category}\``]
    .filter(Boolean)
    .join(' · ');
  return `<sub>${meta}</sub>`;
}

function findingBlock(repo, headSha, finding) {
  const explanation = (finding.explanation || '').trim();
  return [findingTitle(finding), explanation, findingMeta(repo, headSha, finding)]
    .filter(Boolean)
    .join('\n');
}

function threadBody(repo, headSha, finding, { aroundLine } = {}) {
  const parts = [];
  if (aroundLine) {
    parts.push(`_Around line ${aroundLine} — could not attach to the exact diff line._`);
  }
  parts.push(
    findingTitle(finding),
    finding.explanation || '',
    findingMeta(repo, headSha, finding)
  );
  return parts.filter(Boolean).join('\n\n');
}

function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function joinNaturally(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// One-line overview that opens every summary body; doubles as the whole body
// when there is nothing else to show, so "reviewed, nothing found" stays
// distinguishable from "review never happened".
function overviewLine(unanchored, inlineCount) {
  const clauses = [];
  if (inlineCount) {
    clauses.push(
      inlineCount === 1 ? 'left **1 comment**' : `left **${inlineCount} comments**`
    );
  }
  if (unanchored.length) {
    clauses.push(
      `collected ${pluralize(unanchored.length, 'finding')} below that could not be attached to the diff`
    );
  }
  if (!clauses.length) {
    return '✅ Nothing to flag — the changes look good.';
  }
  return `Reviewed the changes — ${joinNaturally(clauses)}.`;
}

const RISK_EMOJI = { low: '🟢', medium: '🟡', high: '🔴' };

// The risk of the change, as rated by the review agent.
function riskLine(risk) {
  const reason = (risk.reason || '').replace(/\s*\n\s*/g, ' ').trim();
  const level = `**Risk: ${RISK_EMOJI[risk.level] || '⚪'} ${risk.level}**`;
  return reason ? `${level} — ${reason}` : level;
}

// --- Auto-approval ----------------------------------------------------------

const RISK_RANK = { low: 1, medium: 2, high: 3 };

// The conventional commit type of a PR title, and whether it marks a breaking
// change: "chore: …", "chore(deps): …", "chore!: …".
const TITLE_TYPE = /^(\w+)(?:\([^)]*\))?(!)?:/;

// The auto-approve settings from the environment, or null when it is off.
export function approvalConfig(env) {
  if ((env.AUTO_APPROVE || '').trim() !== 'true') return null;
  const maxRisk = (env.AUTO_APPROVE_MAX_RISK || 'low').trim();
  if (!Object.hasOwn(RISK_RANK, maxRisk)) {
    throw new Error(
      `Unknown auto-approve-max-risk "${maxRisk}". Expected one of: ${Object.keys(RISK_RANK).join(', ')}.`
    );
  }
  const types = (env.AUTO_APPROVE_TYPES || 'chore, docs, test')
    .split(/[\n,]/)
    .map((type) => type.trim().replace(/:$/, '').toLowerCase())
    .filter(Boolean);
  return { maxRisk, types };
}

// Why the PR is not approved, or null when every condition holds.
export function approvalBlocker({ findings, risk, title, maxRisk, types }) {
  if (findings.length) return `the review has ${pluralize(findings.length, 'finding')}`;
  if (!risk) return 'the review rated no risk';
  if (!(RISK_RANK[risk.level] <= RISK_RANK[maxRisk])) {
    return `the risk ${risk.level} is above ${maxRisk}`;
  }
  const match = TITLE_TYPE.exec(title || '');
  if (!match) return 'the title has no conventional commit type';
  if (match[2]) return 'the title marks a breaking change';
  const type = match[1].toLowerCase();
  if (!types.includes(type)) return `the type ${type} is not one of ${types.join(', ')}`;
  return null;
}

const PUSHED_MESSAGE = 'New commits were pushed after the automatic approval.';
const NOT_APPROVED_MESSAGE = 'The latest review did not approve the pull request.';

function approvalNote(risk, title) {
  const type = TITLE_TYPE.exec(title)[1].toLowerCase();
  return `_Approved automatically: a \`${type}\` change with ${risk.level} risk and no findings._`;
}

// The approving reviews of the token's identity that no longer hold: the
// ones on a commit other than headSha, and the one on headSha too when it is
// rejectedSha, a commit the latest review did not approve. A review whose
// commit is gone never holds.
export function approvalsToDismiss(reviews, headSha, rejectedSha = null) {
  const keepSha = headSha === rejectedSha ? null : headSha;
  return reviews.filter((review) => review.viewerDidAuthor && review.commit?.oid !== keepSha);
}

// The commit of the PR head checkout that the review read.
function reviewedSha() {
  try {
    return capture('git', ['-C', process.env.GITHUB_WORKSPACE || '.', 'rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
}

// Summary body: overview line, then the risk of the change, then the table
// over all findings, then the full prose of the findings whose inline
// anchoring failed (visible, not collapsed) — commented findings keep their
// prose in the inline comment. Zero-findings runs still post.
function summaryBody(repo, headSha, findings, unanchored, inlineCount, risk) {
  const parts = [overviewLine(unanchored, inlineCount)];
  if (risk) {
    parts.push(riskLine(risk));
  }
  if (findings.length) {
    parts.push(findingsTable(findings));
  }
  if (unanchored.length) {
    parts.push(unanchored.map((f) => findingBlock(repo, headSha, f)).join('\n\n'));
  }
  return parts.join('\n\n');
}

// --- Posting ----------------------------------------------------------------

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      title
      headRefOid
      reviews(states: PENDING, first: 10) { nodes { id } }
    }
  }
}`;

// Only works on PENDING reviews, and pending reviews are only visible to
// their author — so everything the query above returns is a leftover of ours
// (a crashed previous run would otherwise block creating a new one forever).
const DELETE_PENDING = `mutation($reviewId: ID!) {
  deletePullRequestReview(input: {pullRequestReviewId: $reviewId}) {
    pullRequestReview { id }
  }
}`;

const ADD_PENDING = `mutation($prId: ID!) {
  addPullRequestReview(input: {pullRequestId: $prId}) {
    pullRequestReview { id }
  }
}`;

const ADD_BODY_ONLY = `mutation($prId: ID!, $body: String!) {
  addPullRequestReview(input: {pullRequestId: $prId, event: COMMENT, body: $body}) {
    pullRequestReview { url author { login } }
  }
}`;

const APPROVE_BODY_ONLY = `mutation($prId: ID!, $commit: GitObjectID!, $body: String!) {
  addPullRequestReview(input: {pullRequestId: $prId, commitOID: $commit, event: APPROVE, body: $body}) {
    pullRequestReview { url author { login } }
  }
}`;

const ADD_LINE_THREAD = `mutation($reviewId: ID!, $path: String!, $line: Int!, $body: String!) {
  addPullRequestReviewThread(input: {
    pullRequestReviewId: $reviewId, path: $path, line: $line, side: RIGHT,
    subjectType: LINE, body: $body
  }) { thread { id } }
}`;

const ADD_FILE_THREAD = `mutation($reviewId: ID!, $path: String!, $body: String!) {
  addPullRequestReviewThread(input: {
    pullRequestReviewId: $reviewId, path: $path, subjectType: FILE, body: $body
  }) { thread { id } }
}`;

const SUBMIT_REVIEW = `mutation($reviewId: ID!, $body: String!) {
  submitPullRequestReview(input: {pullRequestReviewId: $reviewId, event: COMMENT, body: $body}) {
    pullRequestReview { url author { login } }
  }
}`;

const APPROVALS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviews(states: APPROVED, last: 100) { nodes { id url viewerDidAuthor commit { oid } } }
    }
  }
}`;

const DISMISS_REVIEW = `mutation($reviewId: ID!, $message: String!) {
  dismissPullRequestReview(input: {pullRequestReviewId: $reviewId, message: $message}) {
    pullRequestReview { id }
  }
}`;

// Dismiss the approvals of the token's identity on the PR that no longer
// hold; see approvalsToDismiss. Returns how many it found.
export function dismissApprovals(repo, number, { rejectedSha = null } = {}) {
  const [owner, name] = repo.split('/');
  const pr = graphql(APPROVALS_QUERY, { owner, name, number }).repository.pullRequest;
  const stale = approvalsToDismiss(pr.reviews.nodes, pr.headRefOid, rejectedSha);
  for (const review of stale) {
    const message = review.commit?.oid === pr.headRefOid ? NOT_APPROVED_MESSAGE : PUSHED_MESSAGE;
    try {
      graphql(DISMISS_REVIEW, { reviewId: review.id, message });
      console.log(`Auto-approve: dismissed ${review.url}`);
    } catch {
      // Such as when the review run and the push's dismiss-stale-approval
      // run both dismiss the same approval
      console.log(`::warning::Auto-approve: could not dismiss ${review.url}`);
    }
  }
  return stale.length;
}

// Try-then-demote: line-level → file-level → summary list. Anchoring rules
// (line must be in the PR diff; renamed/deleted/binary files) are GitHub's to
// judge — any failure demotes, nothing breaks the review. A failure is either
// a GraphQL error OR a 200 with thread: null — GitHub reports a line outside
// the diff the latter way, without an error.
function tryAddThread(mutation, variables) {
  try {
    return Boolean(graphql(mutation, variables).addPullRequestReviewThread?.thread?.id);
  } catch {
    return false;
  }
}

function postThread(repo, headSha, reviewId, finding) {
  if (finding.file && finding.line) {
    const created = tryAddThread(ADD_LINE_THREAD, {
      reviewId,
      path: finding.file,
      line: finding.line,
      body: threadBody(repo, headSha, finding),
    });
    if (created) return true;
    console.warn(`Line thread failed for ${fileLabel(finding)}, retrying file-level`);
  }
  if (finding.file) {
    const created = tryAddThread(ADD_FILE_THREAD, {
      reviewId,
      path: finding.file,
      body: threadBody(repo, headSha, finding, { aroundLine: finding.line }),
    });
    if (created) return true;
    console.warn(`File thread failed for ${finding.file}, demoting to summary`);
  }
  return false;
}

function logPosted(review) {
  console.log(`Posted review ${review.url} as ${review.author.login}`);
}

function main() {
  const { prNumber, repo } = prArguments();
  const findingsFile = requireEnv('FINDINGS_FILE');
  let approval;
  try {
    approval = approvalConfig(process.env);
  } catch (err) {
    fail(err.message);
  }

  const report = JSON.parse(fs.readFileSync(findingsFile, 'utf8'));
  const findings = report.findings.map(normalize);
  const risk = report.risk;
  console.log(`Findings: ${findings.length} total${risk ? `, risk ${risk.level}` : ''}`);

  if (process.env.DRY_RUN) {
    console.log('\n--- inline thread bodies ---');
    for (const finding of findings) {
      console.log(`\n[${fileLabel(finding)}]\n${threadBody(repo, 'HEAD', finding)}`);
    }
    console.log('\n--- summary body ---\n');
    console.log(summaryBody(repo, 'HEAD', findings, [], findings.length, risk));
    return;
  }

  const [owner, name] = repo.split('/');
  const pr = graphql(PR_QUERY, { owner, name, number: prNumber }).repository.pullRequest;

  for (const stale of pr.reviews.nodes) {
    console.warn(`Deleting stale pending review ${stale.id}`);
    graphql(DELETE_PENDING, { reviewId: stale.id });
  }

  const reviewed = approval ? reviewedSha() : null;
  let approve = false;
  if (approval) {
    let blocker = approvalBlocker({ findings, risk, title: pr.title, ...approval });
    if (!blocker && reviewed !== pr.headRefOid) {
      blocker = 'the PR head is no longer the reviewed commit';
    }
    approve = !blocker;
    console.log(approve ? 'Auto-approve: approving' : `Auto-approve: skipped, ${blocker}`);
  }

  postReview(repo, pr, findings, risk, approve);

  // An approval holds only while the latest review approves the head it
  // reviewed. The dismiss-stale-approval run of a push during the approval
  // may have looked before the approval existed, so check the head once it
  // does. A run that did not approve withdraws the approval of the commit it
  // reviewed, but says nothing about a newer head.
  if (approval) {
    dismissApprovals(repo, prNumber, { rejectedSha: approve ? null : reviewed });
  }
}

// Post the review: an approval, a body-only comment, or the findings as
// threads under a summary.
function postReview(repo, pr, findings, risk, approve) {
  if (!findings.length) {
    const body = summaryBody(repo, pr.headRefOid, [], [], 0, risk);
    if (approve) {
      try {
        const approveBody = `${body}\n\n${approvalNote(risk, pr.title)}`;
        const result = graphql(APPROVE_BODY_ONLY, { prId: pr.id, commit: pr.headRefOid, body: approveBody });
        logPosted(result.addPullRequestReview.pullRequestReview);
        return;
      } catch {
        console.log('::warning::Auto-approve: GitHub refused the approval, posting the review as a comment');
      }
    }
    const result = graphql(ADD_BODY_ONLY, { prId: pr.id, body });
    logPosted(result.addPullRequestReview.pullRequestReview);
    return;
  }

  const pending = graphql(ADD_PENDING, { prId: pr.id });
  const reviewId = pending.addPullRequestReview.pullRequestReview.id;

  const unanchored = [];
  let posted = 0;
  for (const finding of findings) {
    if (postThread(repo, pr.headRefOid, reviewId, finding)) {
      posted += 1;
    } else {
      unanchored.push(finding);
    }
  }

  const body = summaryBody(repo, pr.headRefOid, findings, unanchored, posted, risk);
  const result = graphql(SUBMIT_REVIEW, { reviewId, body });
  logPosted(result.submitPullRequestReview.pullRequestReview);
}

// Run only as a script, not when the tests import the approval functions.
if (import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main();
}
