#!/usr/bin/env node
// Collect everything about a PR that the next steps need, into one folder, from the local checkout.
//
// Usage:
//   collect.mjs --pr <url-or-number> [--repo owner/repo] [--root <checkout>] --out <WORK>
//   collect.mjs --clean --out <WORK>
//
// GitHub is asked only for what the checkout does not have: the PR metadata and the linked issues. The code
// comes from git: the diff, and two worktrees of the repository under <WORK>/src, one at the merge base of
// the PR and one at its head. Later steps read, search and show files from these worktrees.
//
// --root is the local checkout of the repository. Default: the repository of the current directory, when one
// of its remotes is the PR's repository. The worktrees share its objects.
//
// Writes:
//   pr.json             gh pr view (metadata, linked issues, commits) plus root, remote and mergeBaseOid
//   pr.diff             git diff <merge base> <head>, the same diff that GitHub shows; `hunks.mjs split` numbers its hunks
//   src/base, src/head  detached git worktrees at the merge base and at the PR head
//   context.md          PR description, linked and related issues, commits, conversation and review comments
//
// --clean removes the two worktrees and keeps the other files. Each run also prunes the registrations of
// worktrees whose folder is gone, so a deleted scratchpad leaves nothing behind in the checkout.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const FIELDS = 'number,title,url,headRefOid,baseRefOid,baseRefName,headRefName,author,body,closingIssuesReferences,commits,comments,reviews,labels';
const REMOTE_RE = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i;

const isFile = (p) => existsSync(p) && statSync(p).isFile();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

// stdout of a command, or null when it fails (the error goes to stderr unless quiet).
function run(cmd, { quiet = false } = {}) {
  const res = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (res.error || res.status !== 0) {
    if (!quiet) console.error(`${cmd.join(' ')} failed: ${(res.error ? res.error.message : res.stderr).trim()}`);
    return null;
  }
  return res.stdout;
}

const gh = (...args) => run(['gh', ...args]);
const git = (root, args, opts) => run(['git', '-C', String(root), ...args], opts);

// The name of the remote of `root` that points at owner/repo, or null.
function remoteOf(root, repo) {
  if (!existsSync(join(root, '.git'))) return null;
  for (const line of (git(root, ['remote', '-v'], { quiet: true }) || '').split('\n')) {
    const [name, url] = line.trim().split(/\s+/);
    const m = url && REMOTE_RE.exec(url);
    if (m && m[1].toLowerCase() === repo.toLowerCase()) return name;
  }
  return null;
}

// The local checkout and its remote for owner/repo: --root, else the repository of the current directory.
function findRoot(arg, repo) {
  let root;
  if (arg) {
    const p = resolve(arg.replace(/^~(?=$|\/)/, homedir()));
    root = existsSync(p) ? realpathSync(p) : p;
  } else {
    const top = run(['git', 'rev-parse', '--show-toplevel'], { quiet: true });
    root = top ? top.trim() : null;
  }
  const remote = root && remoteOf(root, repo);
  if (remote) return [root, remote];
  return die(root ? `${root} has no remote for ${repo}. Pass --root <path> with a checkout of it.`
    : `The current directory is not in a git repository. Pass --root <path> with a checkout of ${repo}.`);
}

// A detached worktree of `root` at `sha` in `path`. An existing worktree is kept when it is at that
// commit and clean; anything else in `path` is replaced.
function worktree(root, path, sha) {
  if (existsSync(path)) {
    const isWt = isFile(join(path, '.git'));
    if (isWt && (git(path, ['rev-parse', 'HEAD'], { quiet: true }) || '').trim() === sha
      && !(git(path, ['status', '--porcelain'], { quiet: true }) || '').trim()) return 'kept';
    if (isWt) git(root, ['worktree', 'remove', '--force', path]);
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
  if (git(root, ['worktree', 'add', '--detach', '--quiet', path, sha]) === null) process.exit(1);
  return 'added';
}

// The main checkout of a linked worktree.
function commonRoot(path) {
  const common = (git(path, ['rev-parse', '--git-common-dir'], { quiet: true }) || '.git').trim();
  return dirname(realpathSync(resolve(path, common)));
}

function clean(out) {
  const prFile = join(out, 'pr.json');
  const root = isFile(prFile) ? JSON.parse(readFileSync(prFile, 'utf8')).root : null;
  const roots = new Set();
  for (const side of ['base', 'head']) {
    const path = join(out, 'src', side);
    if (!isFile(join(path, '.git'))) continue;
    const r = root || commonRoot(path);
    roots.add(r);
    if (git(r, ['worktree', 'remove', '--force', path]) !== null) console.log(`Removed worktree ${path}`);
  }
  for (const r of roots) git(r, ['worktree', 'prune']);
}

const comments = (list) => (list || []).map((c) => `**${c.author.login}:** ${c.body}\n`);

function collect(a) {
  const out = a.out;
  mkdirSync(out, { recursive: true });
  const repoArgs = a.repo ? ['--repo', a.repo] : [];

  const raw = gh('pr', 'view', a.pr, ...repoArgs, '--json', FIELDS);
  if (raw === null) process.exit(1);
  const pr = JSON.parse(raw);
  const repo = pr.url.split('/').slice(3, 5).join('/');
  const { number: n, headRefOid: head, baseRefName: baseBranch } = pr;

  const [root, remote] = findRoot(a.root, repo);
  if (git(root, ['fetch', '--quiet', remote, baseBranch, `pull/${n}/head`]) === null) console.error('Fetch failed; using what the checkout already has');
  const baseRef = `${remote}/${baseBranch}`;
  for (const ref of [head, baseRef]) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { quiet: true }) === null) {
      die(`${ref} is not in ${root}. Fetch it, or pass --root with a checkout that has it.`);
    }
  }
  const mergeBase = git(root, ['merge-base', baseRef, head]);
  if (mergeBase === null) process.exit(1);
  const mb = mergeBase.trim();

  git(root, ['worktree', 'prune']);
  const states = {};
  for (const [side, sha] of [['base', mb], ['head', head]]) states[side] = worktree(root, join(out, 'src', side), sha);

  Object.assign(pr, { root, remote, mergeBaseOid: mb });
  writeFileSync(join(out, 'pr.json'), JSON.stringify(pr, null, 1));
  const diff = git(root, ['diff', '--no-color', '--no-ext-diff', '-M', mb, head]);
  if (diff === null) process.exit(1);
  writeFileSync(join(out, 'pr.diff'), diff);

  const md = [`# PR #${pr.number}: ${pr.title}`, '',
    `${pr.url} by ${pr.author.login}, ${pr.headRefName} -> ${pr.baseRefName}`,
    '', '## Description', '', pr.body || '(empty)', ''];
  for (const ref of pr.closingIssuesReferences || []) {
    const issue = gh('issue', 'view', String(ref.number), '--repo', `${ref.repository.owner.login}/${ref.repository.name}`,
      '--json', 'number,title,body,comments');
    if (issue) {
      const i = JSON.parse(issue);
      md.push(`## Linked issue #${i.number}: ${i.title}`, '', i.body || '', '', ...comments(i.comments));
    }
  }
  // Issues the description refers to, so the investigation can read them without reading the description
  const closing = new Set((pr.closingIssuesReferences || []).map((ref) => ref.number));
  const body = pr.body || '';
  const refs = [...body.matchAll(/(?<![\w/])#(\d+)\b/g), ...body.matchAll(new RegExp(`github\\.com/${escapeRe(repo)}/issues/(\\d+)`, 'g'))].map((m) => Number(m[1]));
  for (const k of new Set(refs)) {
    if (closing.has(k) || k === pr.number) continue;
    const issue = gh('issue', 'view', String(k), '--repo', repo, '--json', 'number,title,body,state,comments');
    if (issue) {
      const i = JSON.parse(issue);
      md.push(`## Related issue #${i.number} (${i.state.toLowerCase()}): ${i.title}`, '', i.body || '', '', ...comments(i.comments));
    }
  }
  md.push('## Commits', '', ...(pr.commits || []).map((c) => `- ${c.messageHeadline}` + (c.messageBody ? `\n  ${c.messageBody}` : '')), '');
  const talk = comments(pr.comments);
  talk.push(...(pr.reviews || []).filter((r) => r.body).map((r) => `**${r.author.login} (${r.state.toLowerCase()}):** ${r.body}\n`));
  // --slurp puts the pages of the review comments into one array of arrays
  const review = gh('api', `repos/${repo}/pulls/${pr.number}/comments`, '--paginate', '--slurp');
  for (const c of review ? JSON.parse(review).flat() : []) {
    talk.push(`**${c.user.login}** on \`${c.path}\`:\n\`\`\`\n${(c.diff_hunk || '').slice(-400)}\n\`\`\`\n${c.body}\n`);
  }
  md.push('## Conversation and review comments', '', ...(talk.length ? talk : ['(none)']));
  writeFileSync(join(out, 'context.md'), md.join('\n') + '\n');

  console.log(`Collected PR #${pr.number} of ${repo} into ${out} from ${root}`);
  console.log(`  src/base: worktree at ${mb.slice(0, 10)} (merge base of ${baseRef}), ${states.base}`);
  console.log(`  src/head: worktree at ${head.slice(0, 10)} (PR head), ${states.head}`);
}

const USAGE = 'usage: collect.mjs --pr <url-or-number> [--repo owner/repo] [--root <checkout>] --out <WORK>\n       collect.mjs --clean --out <WORK>';

function main() {
  let a;
  try {
    ({ values: a } = parseArgs({ options: {
      pr: { type: 'string' }, repo: { type: 'string' }, root: { type: 'string' }, out: { type: 'string' }, clean: { type: 'boolean' },
    } }));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  if (!a.out || (!a.clean && !a.pr)) {
    console.error(USAGE);
    process.exit(2);
  }
  if (a.clean) clean(a.out);
  else collect(a);
}

main();
