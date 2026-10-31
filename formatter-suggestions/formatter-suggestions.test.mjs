// Run with: node --test formatter-suggestions/
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  run,
  parseDiff,
  parsePatchRanges,
  collectSuggestions,
  summaryComment,
} from './formatter-suggestions.mjs';

const SUGGESTION = 'Formatting suggestion:\n';
const PATH = 'src/main/java/com/example/Foo.java';

// What `git diff` prints after spotless:apply reformatted a file
const DIFF = `diff --git a/${PATH} b/${PATH}
index 8058f4f..e4f99f8 100644
--- a/${PATH}
+++ b/${PATH}
@@ -1,8 +1,10 @@
 package com.vaadin.flow;
+
 class Foo {
-  void f( ) {
-  }
     int x;
+    int y;

     int z;
-}
\\ No newline at end of file
+}
`;

const suggestions = (diff, prFiles, max) =>
  collectSuggestions(parseDiff(diff), new Map(prFiles), max);

test('parseDiff splits hunks into changed blocks numbered on the old file', () => {
  const [file] = parseDiff(DIFF);
  assert.strictEqual(file.path, PATH);
  assert.deepStrictEqual(
    file.blocks.map(({ oldStart, removed, added }) => ({
      oldStart,
      removed,
      added,
    })),
    [
      { oldStart: 2, removed: [], added: [''] },
      { oldStart: 3, removed: ['  void f( ) {', '  }'], added: [] },
      { oldStart: 6, removed: [], added: ['    int y;'] },
      { oldStart: 8, removed: ['}'], added: ['}'] },
    ],
  );
});

test('parsePatchRanges reads the new file lines of each hunk', () => {
  assert.deepStrictEqual(
    parsePatchRanges(
      '@@ -1,3 +1,4 @@\n a\n+b\n@@ -10 +11 @@\n-c\n+d\n@@ -20,2 +22,0 @@\n-e',
    ),
    [
      [1, 4],
      [11, 11],
    ],
  );
  assert.deepStrictEqual(parsePatchRanges(undefined), []);
});

test('changes within the pull request diff become suggestions', () => {
  const { comments, unsuggested } = suggestions(DIFF, [[PATH, [[1, 10]]]]);
  assert.deepStrictEqual(comments, [
    // An added line is suggested together with the line before it
    {
      path: PATH,
      line: 1,
      side: 'RIGHT',
      body: SUGGESTION + '```suggestion\npackage com.vaadin.flow;\n\n```',
    },
    // Removed lines are suggested as an empty replacement of all of them
    {
      path: PATH,
      line: 4,
      side: 'RIGHT',
      start_line: 3,
      start_side: 'RIGHT',
      body: SUGGESTION + '```suggestion\n```',
    },
    {
      path: PATH,
      line: 5,
      side: 'RIGHT',
      body: SUGGESTION + '```suggestion\n    int x;\n    int y;\n```',
    },
  ]);
  // A missing newline at the end of the file can't be suggested
  assert.deepStrictEqual([...unsuggested], [[PATH, 1]]);
});

test('changes outside the pull request diff and in other files are not suggested', () => {
  const { comments, unsuggested } = suggestions(DIFF, [[PATH, [[3, 3]]]]);
  assert.deepStrictEqual(comments, []);
  assert.deepStrictEqual([...unsuggested], [[PATH, 4]]);

  const other = suggestions(DIFF, [['Other.java', [[1, 10]]]]);
  assert.deepStrictEqual(other.comments, []);
  assert.deepStrictEqual([...other.unsuggested], []);
});

test('suggestions past the limit are counted instead', () => {
  const { comments, unsuggested } = suggestions(DIFF, [[PATH, [[1, 10]]]], 1);
  assert.strictEqual(comments.length, 1);
  assert.deepStrictEqual([...unsuggested], [[PATH, 3]]);
});

test('lines added around the first line of a file are suggested together with it', () => {
  // The two blocks are both anchored on the package line, and overlapping
  // suggestions can't be committed together
  const diff = `diff --git a/${PATH} b/${PATH}\n--- a/${PATH}\n+++ b/${PATH}\n@@ -1,2 +1,5 @@\n+/* header */\n+\n package a;\n+\n import b;\n`;
  const { comments, unsuggested } = suggestions(diff, [[PATH, [[1, 5]]]]);
  assert.deepStrictEqual(comments, [
    {
      path: PATH,
      line: 1,
      side: 'RIGHT',
      body: SUGGESTION + '```suggestion\n/* header */\n\npackage a;\n\n```',
    },
  ]);
  assert.deepStrictEqual([...unsuggested], []);

  // Outside the pull request diff, the merged suggestion counts both changes
  assert.deepStrictEqual(
    [...suggestions(diff, [[PATH, [[3, 3]]]]).unsuggested],
    [[PATH, 2]],
  );
});

test('parseDiff numbers each file of a diff on its own hunks', () => {
  const other = 'src/main/java/com/example/Bar.java';
  const diff =
    DIFF +
    `diff --git a/${other} b/${other}\n--- a/${other}\n+++ b/${other}\n@@ -3,2 +3,2 @@\n class Bar {\n-int a;\n+  int a;\n`;
  const files = parseDiff(diff);
  assert.deepStrictEqual(
    files.map((f) => f.path),
    [PATH, other],
  );
  assert.strictEqual(files[0].blocks.length, 4);
  assert.deepStrictEqual(
    files[1].blocks.map(({ oldStart, removed, added, previous }) => ({
      oldStart,
      removed,
      added,
      previous,
    })),
    [
      {
        oldStart: 4,
        removed: ['int a;'],
        added: ['  int a;'],
        previous: 'class Bar {',
      },
    ],
  );
});

test('a changed last line is suggested, and its missing newline counted', () => {
  const diff = `diff --git a/${PATH} b/${PATH}\n--- a/${PATH}\n+++ b/${PATH}\n@@ -1,2 +1,2 @@\n class Foo {\n-  }\n\\ No newline at end of file\n+}\n`;
  const { comments, unsuggested } = suggestions(diff, [[PATH, [[1, 2]]]]);
  assert.deepStrictEqual(comments, [
    {
      path: PATH,
      line: 2,
      side: 'RIGHT',
      body: SUGGESTION + '```suggestion\n}\n```',
    },
  ]);
  assert.deepStrictEqual([...unsuggested], [[PATH, 1]]);
});

test('suggestions containing a code fence use a longer one', () => {
  const diff = `diff --git a/${PATH} b/${PATH}\n--- a/${PATH}\n+++ b/${PATH}\n@@ -1 +1 @@\n-  /** \`\`\`x\`\`\` */\n+/** \`\`\`x\`\`\` */\n`;
  const { comments } = suggestions(diff, [[PATH, [[1, 1]]]]);
  assert.strictEqual(
    comments[0].body,
    SUGGESTION + '````suggestion\n/** ```x``` */\n````',
  );
});

test('summaryComment points at the suggestions and at what could not be suggested', () => {
  const body = summaryComment({
    files: [PATH],
    suggested: 3,
    unsuggested: new Map([[PATH, 1]]),
    runUrl: 'https://github.com/vaadin/flow/actions/runs/1',
    fixCommand: 'mvn spotless:apply',
    commentMarker: '<!-- tc-formatter -->',
  });
  assert.match(body, /^<!-- tc-formatter -->\n/);
  assert.match(body, /please run `mvn spotless:apply` in your branch/);
  assert.match(body, /\*\*1 files\*\* with format errors/);
  assert.match(body, /3 formatting changes are suggested/);
  assert.match(
    body,
    /1 formatting changes could not be suggested.*`src\/main\/java\/com\/example\/Foo.java` \(1\)/,
  );
  assert.match(
    body,
    /\[differences artifact\]\(https:\/\/github.com\/vaadin\/flow\/actions\/runs\/1\)/,
  );
});

const HEAD = 'abc123';
const PATCH = '@@ -1,8 +1,10 @@';

/**
 * Runs run() against a stub of the GitHub API that records the calls
 * changing anything. `state` holds what the API returns.
 */
async function runWith(diff, state = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formatter-'));
  const diffFile = path.join(dir, 'formatter-diff.txt');
  if (diff !== null) {
    fs.writeFileSync(diffFile, diff);
  }
  const calls = [];
  const record = (name, result) => async (params) => {
    calls.push({ name, params });
    if (result instanceof Error) {
      throw result;
    }
  };
  const lists = new Map();
  const list = (items) => {
    const fn = async () => {};
    lists.set(fn, items);
    return fn;
  };
  const github = {
    paginate: async (fn) => lists.get(fn),
    graphql: async () => {
      const nodes = state.threads ?? [];
      return {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: false }, nodes },
          },
        },
      };
    },
    rest: {
      pulls: {
        list: list(state.pulls ?? [{ number: 7, head: { sha: HEAD } }]),
        listFiles: list([{ filename: PATH, patch: PATCH }]),
        createReview: record('createReview', state.createReviewError),
        deleteReviewComment: record('deleteReviewComment', state.deleteError),
      },
      issues: {
        listComments: list(state.comments ?? []),
        createComment: record('createComment'),
        updateComment: record('updateComment'),
        deleteComment: record('deleteComment'),
      },
    },
  };
  const context = {
    repo: { owner: 'vaadin', repo: 'flow' },
    payload: {
      workflow_run: {
        head_sha: HEAD,
        head_branch: 'fix',
        head_repository: { owner: { login: 'someone' } },
        html_url: 'https://github.com/vaadin/flow/actions/runs/1',
      },
    },
  };
  const core = {
    info: () => {},
    warning: (message) => calls.push({ name: 'warning', message }),
    setFailed: (message) => calls.push({ name: 'setFailed', message }),
  };
  try {
    await run({
      github,
      context,
      core,
      diffFile,
      fixCommand: 'mvn spotless:apply',
    });
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
  return calls;
}

const STICKY = {
  id: 42,
  user: { login: 'github-actions[bot]' },
  body: '<!-- formatter-suggestions -->\nold',
};

test('run posts the suggestions in a review and the summary in a comment', async () => {
  const calls = await runWith(DIFF);
  assert.deepStrictEqual(
    calls.map((call) => call.name),
    ['createReview', 'createComment'],
  );
  assert.strictEqual(calls[0].params.commit_id, HEAD);
  // Without a body, the review is gone once its suggestions are deleted
  assert.strictEqual(calls[0].params.body, undefined);
  assert.strictEqual(calls[0].params.comments.length, 3);
  assert.match(calls[1].params.body, /3 formatting changes are suggested/);
});

/** A review thread as GraphQL returns it. */
const thread = (id, { line, startLine = null, body, replies = [] }) => ({
  path: PATH,
  line,
  startLine,
  comments: {
    nodes: [
      { databaseId: id, author: { login: 'github-actions' }, body },
      ...replies.map((login) => ({ author: { login }, body: 'ok' })),
    ],
  },
});
const REPEATED = SUGGESTION + '```suggestion\n    int x;\n    int y;\n```';

for (const [name, existing] of Object.entries({
  open: { line: 5, body: REPEATED },
  // GitHub returns the line itself as the start line of a single-line comment
  'open, with start line': { line: 5, startLine: 5, body: REPEATED },
  'multi-line': {
    line: 4,
    startLine: 3,
    body: SUGGESTION + '```suggestion\n```',
  },
})) {
  test(`run neither posts again nor deletes a suggestion it still makes (${name})`, async () => {
    const calls = await runWith(DIFF, {
      threads: [thread(1, existing)],
      comments: [STICKY],
    });
    assert.deepStrictEqual(
      calls.map((call) => call.name),
      ['createReview', 'updateComment'],
    );
    assert.strictEqual(calls[0].params.comments.length, 2);
    assert.match(calls[1].params.body, /3 formatting changes are suggested/);
  });
}

test('run deletes the suggestions it no longer makes, unless someone replied', async () => {
  const threads = [
    // A reply of the bot itself does not keep it
    thread(1, { line: null, body: REPEATED, replies: ['github-actions'] }),
    thread(2, { line: 5, body: SUGGESTION + '```suggestion\nother\n```' }),
    thread(3, { line: null, body: REPEATED, replies: ['author'] }),
    thread(4, { line: null, body: 'Not a formatting suggestion' }),
  ];
  const calls = await runWith(DIFF, { threads });
  assert.deepStrictEqual(
    calls
      .filter((call) => call.name === 'deleteReviewComment')
      .map((call) => call.params.comment_id),
    [1, 2],
  );
});

test('run counts the suggestions as not suggested when the review is refused', async () => {
  const calls = await runWith(DIFF, {
    createReviewError: new Error('Unprocessable Entity'),
  });
  const body = calls.find((call) => call.name === 'createComment').params.body;
  assert.doesNotMatch(body, /are suggested/);
  assert.match(body, /4 formatting changes could not be suggested/);
});

test('run deletes the suggestions and the comment once the format is fixed', async () => {
  const calls = await runWith('', {
    comments: [STICKY],
    threads: [thread(1, { line: 5, body: REPEATED })],
  });
  assert.deepStrictEqual(calls, [
    {
      name: 'deleteReviewComment',
      params: { owner: 'vaadin', repo: 'flow', comment_id: 1 },
    },
    {
      name: 'deleteComment',
      params: { owner: 'vaadin', repo: 'flow', comment_id: 42 },
    },
  ]);
});

test('run still deletes the comment when a suggestion can not be deleted', async () => {
  const calls = await runWith('', {
    comments: [STICKY],
    threads: [thread(1, { line: 5, body: REPEATED })],
    deleteError: new Error('Not Found'),
  });
  assert.deepStrictEqual(
    calls.map((call) => call.name),
    ['deleteReviewComment', 'warning', 'deleteComment'],
  );
});

test('run rejects an oversized diff', async () => {
  const calls = await runWith('x'.repeat(1024 * 1024 + 1));
  assert.deepStrictEqual(
    calls.map((call) => call.name),
    ['setFailed'],
  );
});

test('run does nothing when no open pull request has the commit as its head', async () => {
  const calls = await runWith(DIFF, {
    pulls: [{ number: 7, head: { sha: 'newer' } }],
  });
  assert.deepStrictEqual(calls, []);
});
