// Run with: node --test code-review/post-review.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalBlocker, approvalConfig, approvalsToDismiss } from './post-review.mjs';

const DEFAULTS = { maxRisk: 'low', types: ['chore', 'docs', 'test'] };
const LOW = { level: 'low', reason: 'Only touches docs.' };
const APPROVABLE = { findings: [], risk: LOW, title: 'docs: fix a typo', ...DEFAULTS };
const blocker = (changes) => approvalBlocker({ ...APPROVABLE, ...changes });

// Approving reviews as the approvals query returns them: the token's own,
// and a human one.
const auto = (id, oid) => ({
  id,
  url: `https://example.test/reviews/${id}`,
  viewerDidAuthor: true,
  commit: oid && { oid },
});
const human = (id, oid) => ({ ...auto(id, oid), viewerDidAuthor: false });

test('reads the auto-approve settings', () => {
  assert.strictEqual(approvalConfig({}), null);
  assert.strictEqual(approvalConfig({ AUTO_APPROVE: 'false' }), null);
  assert.deepStrictEqual(approvalConfig({ AUTO_APPROVE: 'true' }), DEFAULTS);
  assert.deepStrictEqual(
    approvalConfig({
      AUTO_APPROVE: ' true ',
      AUTO_APPROVE_MAX_RISK: 'medium',
      AUTO_APPROVE_TYPES: 'Docs:, chore\n\n test ,',
    }),
    { maxRisk: 'medium', types: ['docs', 'chore', 'test'] }
  );
  assert.throws(
    () => approvalConfig({ AUTO_APPROVE: 'true', AUTO_APPROVE_MAX_RISK: 'critical' }),
    /Unknown auto-approve-max-risk "critical"\. Expected one of: low, medium, high\./
  );
});

test('approves a PR that meets every condition', () => {
  assert.strictEqual(blocker({}), null);
  assert.strictEqual(blocker({ title: 'Chore(deps): bump x' }), null);
  assert.strictEqual(blocker({ risk: { level: 'medium' }, maxRisk: 'medium' }), null);
});

test('does not approve a PR that misses a condition', () => {
  assert.match(blocker({ findings: [{}] }), /the review has 1 finding$/);
  assert.match(blocker({ findings: [{}, {}] }), /2 findings$/);
  assert.match(blocker({ risk: undefined }), /rated no risk/);
  assert.match(blocker({ risk: { level: 'medium' } }), /risk medium is above low/);
  assert.match(blocker({ title: 'feat: add x' }), /the type feat is not one of chore, docs, test/);
  assert.match(blocker({ title: 'Fix a typo' }), /no conventional commit type/);
  assert.match(blocker({ title: 'chore!: drop Node 18' }), /breaking change/);
});

test('dismisses only the own approvals that no longer hold', () => {
  const reviews = [auto('old', 'old'), auto('head', 'head'), auto('gone', null), human('human', 'old')];
  const ids = (...args) => approvalsToDismiss(reviews, ...args).map((review) => review.id);
  assert.deepStrictEqual(ids('head'), ['old', 'gone']);
  assert.deepStrictEqual(ids('head', 'head'), ['old', 'head', 'gone']);
  // A review of an older commit says nothing about the head
  assert.deepStrictEqual(ids('head', 'old'), ['old', 'gone']);
});

// --- The scripts against a stub gh ------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'acme/widgets';
const PUSHED = 'New commits were pushed after the automatic approval.';
const NOT_APPROVED = 'The latest review did not approve the pull request.';

// A stub `gh` that answers each GraphQL call from the fixture file and
// records the calls, each as its operation and variables. `fail` lists the
// calls to refuse: 'approve', or 'dismiss:<review id>'.
const GH_STUB = `
import fs from 'node:fs';
const { pr, approvals, fail = [] } = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
const vars = {};
let query = '';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] !== '-f' && args[i] !== '-F') continue;
  i += 1;
  const [key, ...rest] = args[i].split('=');
  if (key === 'query') query = rest.join('=');
  else vars[key] = rest.join('=');
}
const OPS = [
  ['dismiss', /dismissPullRequestReview/],
  ['submit', /submitPullRequestReview/],
  ['thread', /addPullRequestReviewThread/],
  ['delete-pending', /deletePullRequestReview/],
  ['approve', /event: APPROVE/],
  ['comment', /event: COMMENT/],
  ['add-pending', /addPullRequestReview/],
  ['approvals', /states: APPROVED/],
  ['pr', /states: PENDING/],
];
const op = (OPS.find(([, pattern]) => pattern.test(query)) || ['unknown'])[0];
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify({ op, vars }) + '\\n');
const call = op === 'dismiss' ? 'dismiss:' + vars.reviewId : op;
if (op === 'unknown' || fail.includes(call)) {
  console.error('gh stub: refused ' + call);
  process.exit(1);
}
const review = { id: 'review', url: 'https://example.test/' + op, author: { login: 'bot' } };
const data = {
  pr: { repository: { pullRequest: pr } },
  approvals: { repository: { pullRequest: approvals } },
  dismiss: { dismissPullRequestReview: { pullRequestReview: { id: vars.reviewId } } },
  submit: { submitPullRequestReview: { pullRequestReview: review } },
  thread: { addPullRequestReviewThread: { thread: { id: 'thread' } } },
  'delete-pending': { deletePullRequestReview: { pullRequestReview: { id: vars.reviewId } } },
  approve: { addPullRequestReview: { pullRequestReview: review } },
  comment: { addPullRequestReview: { pullRequestReview: review } },
  'add-pending': { addPullRequestReview: { pullRequestReview: { id: 'pending' } } },
}[op];
console.log(JSON.stringify({ data }));
`;

// What the scripts run against: the stub gh on PATH, a checkout whose HEAD
// stands in for the reviewed commit, and the files of a run.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'post-review-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const BIN = path.join(TMP, 'bin');
const STUB = path.join(TMP, 'gh-stub.mjs');
fs.mkdirSync(BIN);
fs.writeFileSync(STUB, GH_STUB);
fs.writeFileSync(path.join(BIN, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${STUB}' "$@"\n`, {
  mode: 0o755,
});
const CHECKOUT = path.join(TMP, 'checkout');
fs.mkdirSync(CHECKOUT);
const git = (...args) => execFileSync('git', ['-C', CHECKOUT, ...args], { encoding: 'utf8' }).trim();
git('init', '-q');
git('-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-q', '--allow-empty', '-m', 'reviewed');
const REVIEWED = git('rev-parse', 'HEAD');
const FIXTURE = path.join(TMP, 'fixture.json');
const CALLS = path.join(TMP, 'calls.jsonl');
const FINDINGS_FILE = path.join(TMP, 'findings.json');

// Runs one of the scripts against the stub gh and returns its exit status,
// output and the GraphQL calls it made. `env` sets the variables of the
// action's step; a variable set to undefined is unset.
function runScript(script, argv, { fixture, env = {} }) {
  fs.writeFileSync(FIXTURE, JSON.stringify(fixture));
  fs.writeFileSync(CALLS, '');
  const fullEnv = {
    ...process.env,
    PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
    GH_FIXTURE: FIXTURE,
    GH_CALLS: CALLS,
    GITHUB_REPOSITORY: REPO,
    GITHUB_WORKSPACE: CHECKOUT,
  };
  for (const name of ['PR_NUMBER', 'FINDINGS_FILE', 'DRY_RUN', 'AUTO_APPROVE', 'AUTO_APPROVE_MAX_RISK', 'AUTO_APPROVE_TYPES']) {
    delete fullEnv[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete fullEnv[name];
    else fullEnv[name] = value;
  }
  const result = spawnSync(process.execPath, [path.join(HERE, script), ...argv], {
    env: fullEnv,
    encoding: 'utf8',
  });
  const calls = fs
    .readFileSync(CALLS, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { ...result, calls };
}

const approvals = (headRefOid, ...nodes) => ({ headRefOid, reviews: { nodes } });
const dismissals = (calls) =>
  calls.filter((call) => call.op === 'dismiss').map(({ vars }) => [vars.reviewId, vars.message]);

test('dismiss-stale-approval dismisses the own approvals of other commits', () => {
  const fixture = {
    approvals: approvals('head', auto('old', 'old'), auto('head', 'head'), auto('gone', null), human('human', 'old')),
    fail: ['dismiss:gone'],
  };
  const { status, stdout, stderr, calls } = runScript('dismiss-stale-approval.mjs', ['7'], { fixture });
  assert.strictEqual(status, 0, stderr);
  assert.deepStrictEqual(calls[0], {
    op: 'approvals',
    vars: { owner: 'acme', name: 'widgets', number: '7' },
  });
  assert.deepStrictEqual(dismissals(calls), [
    ['old', PUSHED],
    ['gone', PUSHED],
  ]);
  assert.match(stdout, /Auto-approve: dismissed https:\/\/example\.test\/reviews\/old/);
  // A refused dismissal is a warning, not a failure
  assert.match(stdout, /::warning::Auto-approve: could not dismiss https:\/\/example\.test\/reviews\/gone/);
  assert.doesNotMatch(stdout, /no stale automatic approvals/);
});

test('dismiss-stale-approval reports when every approval holds', () => {
  const fixture = { approvals: approvals('head', auto('head', 'head'), human('human', 'old')) };
  const { status, stdout, stderr, calls } = runScript('dismiss-stale-approval.mjs', ['7'], { fixture });
  assert.strictEqual(status, 0, stderr);
  assert.deepStrictEqual(calls.map((call) => call.op), ['approvals']);
  assert.match(stdout, /Auto-approve: no stale automatic approvals/);
});

test('dismiss-stale-approval takes the PR number from the environment and requires its inputs', () => {
  const fixture = { approvals: approvals('head') };
  const fromEnv = runScript('dismiss-stale-approval.mjs', [], { fixture, env: { PR_NUMBER: '8' } });
  assert.strictEqual(fromEnv.status, 0, fromEnv.stderr);
  assert.strictEqual(fromEnv.calls[0].vars.number, '8');

  const noNumber = runScript('dismiss-stale-approval.mjs', [], { fixture });
  assert.strictEqual(noNumber.status, 2);
  assert.match(noNumber.stderr, /PR number required/);
  const noRepo = runScript('dismiss-stale-approval.mjs', ['8'], { fixture, env: { GITHUB_REPOSITORY: undefined } });
  assert.strictEqual(noRepo.status, 2);
  assert.match(noRepo.stderr, /GITHUB_REPOSITORY must be set/);
  assert.deepStrictEqual([...noNumber.calls, ...noRepo.calls], []);
});

const FINDING = {
  file: 'src/widget.js',
  line: 3,
  summary: 'Off-by-one in the loop bound',
  explanation: 'The last item is skipped.',
  category: 'correctness',
  judgement: 'Bug',
  value: 'high',
};

// Runs post-review.mjs on a review of the reviewed commit with the given
// findings, on a PR at `headRefOid` holding `approved`, the approving reviews.
function postReview({ findings = [], headRefOid = REVIEWED, approved = [], fail, env }) {
  fs.writeFileSync(FINDINGS_FILE, JSON.stringify({ findings, risk: LOW }));
  const fixture = {
    pr: { id: 'PR_1', title: 'docs: fix a typo', headRefOid, reviews: { nodes: [] } },
    approvals: approvals(headRefOid, ...approved),
    fail,
  };
  return runScript('post-review.mjs', ['7'], {
    fixture,
    env: { FINDINGS_FILE, AUTO_APPROVE: 'true', ...env },
  });
}

test('an approving review keeps its approval and dismisses the ones of other commits', () => {
  const approved = [auto('old', 'old'), auto('own', REVIEWED), human('human', 'old')];
  const { status, stdout, stderr, calls } = postReview({ approved });
  assert.strictEqual(status, 0, stderr);
  assert.match(stdout, /Auto-approve: approving/);
  assert.deepStrictEqual(calls.map((call) => call.op), ['pr', 'approve', 'approvals', 'dismiss']);
  assert.strictEqual(calls[1].vars.commit, REVIEWED);
  assert.deepStrictEqual(dismissals(calls), [['old', PUSHED]]);
});

test('a review with findings dismisses the approval of the commit it reviewed', () => {
  const approved = [auto('old', 'old'), auto('own', REVIEWED), human('human', REVIEWED)];
  const { status, stdout, stderr, calls } = postReview({ findings: [FINDING], approved });
  assert.strictEqual(status, 0, stderr);
  assert.match(stdout, /Auto-approve: skipped, the review has 1 finding/);
  assert.deepStrictEqual(
    calls.map((call) => call.op),
    ['pr', 'add-pending', 'thread', 'submit', 'approvals', 'dismiss', 'dismiss']
  );
  assert.deepStrictEqual(dismissals(calls), [
    ['old', PUSHED],
    ['own', NOT_APPROVED],
  ]);
});

test('a review of a commit that is no longer the head leaves the approval of the head', () => {
  const approved = [auto('own', REVIEWED), auto('newer', 'newer')];
  const { status, stdout, stderr, calls } = postReview({ headRefOid: 'newer', approved });
  assert.strictEqual(status, 0, stderr);
  assert.match(stdout, /Auto-approve: skipped, the PR head is no longer the reviewed commit/);
  assert.deepStrictEqual(calls.map((call) => call.op), ['pr', 'comment', 'approvals', 'dismiss']);
  assert.deepStrictEqual(dismissals(calls), [['own', PUSHED]]);
});

test('a refused approval posts a comment and still dismisses the stale approvals', () => {
  const approved = [auto('old', 'old')];
  const { status, stdout, stderr, calls } = postReview({ approved, fail: ['approve'] });
  assert.strictEqual(status, 0, stderr);
  assert.match(stdout, /::warning::Auto-approve: GitHub refused the approval, posting the review as a comment/);
  assert.deepStrictEqual(calls.map((call) => call.op), ['pr', 'approve', 'comment', 'approvals', 'dismiss']);
  assert.deepStrictEqual(dismissals(calls), [['old', PUSHED]]);
});

test('a review without auto-approve touches no approvals', () => {
  const approved = [auto('old', 'old'), auto('own', REVIEWED)];
  const { status, stdout, stderr, calls } = postReview({ approved, env: { AUTO_APPROVE: undefined } });
  assert.strictEqual(status, 0, stderr);
  assert.doesNotMatch(stdout, /Auto-approve/);
  assert.deepStrictEqual(calls.map((call) => call.op), ['pr', 'comment']);
});
