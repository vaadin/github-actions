// Run with: node --test code-review/check-reviewed.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'check-reviewed.mjs');
const HEAD = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);

function review(overrides) {
  return {
    viewerDidAuthor: true,
    state: 'COMMENTED',
    url: 'https://github.com/o/r/pull/1#pullrequestreview-1',
    commit: { oid: HEAD },
    ...overrides,
  };
}

// Runs check-reviewed.mjs against a stub `gh` that answers the reviews query
// with the given reviews, and returns the `skip` step output and the
// arguments the stub received.
function checkReviewed(reviews) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-reviewed-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const response = path.join(dir, 'response.json');
  fs.writeFileSync(
    response,
    JSON.stringify({
      data: { repository: { pullRequest: { headRefOid: HEAD, reviews: { nodes: reviews } } } },
    })
  );
  const argsFile = path.join(dir, 'args');
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh\nprintf '%s\\0' "$@" > '${argsFile}'\ncat '${response}'\n`,
    { mode: 0o755 }
  );
  const outputFile = path.join(dir, 'output');
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_OUTPUT: outputFile,
  };
  const result = spawnSync(process.execPath, [SCRIPT, '1'], { env, encoding: 'utf8' });
  const output = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
  const args = fs.readFileSync(argsFile, 'utf8').split('\0').slice(0, -1);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(result.status, 0, result.stderr);
  return { output, args };
}

test('skips when the token identity already reviewed the head commit', () => {
  const { output, args } = checkReviewed([review({ commit: { oid: OLDER } }), review()]);
  assert.strictEqual(output, 'skip=true\n');
  const vars = args.slice(args.indexOf('-f', 3));
  assert.deepStrictEqual(vars, ['-f', 'owner=o', '-f', 'name=r', '-F', 'number=1']);
});

test('reviews when no submitted review by the token identity covers the head commit', () => {
  for (const [label, reviews] of [
    ['no reviews', []],
    ['older commit', [review({ commit: { oid: OLDER } })]],
    ['someone else', [review({ viewerDidAuthor: false })]],
    ['pending', [review({ state: 'PENDING' })]],
    ['commit no longer exists', [review({ commit: null })]],
  ]) {
    assert.strictEqual(checkReviewed(reviews).output, 'skip=false\n', label);
  }
});
