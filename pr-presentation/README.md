# pr-presentation

Composite action that explains a pull request as a slide deck, built from the
code of the change by a single headless
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) session, and
links the deck from one comment on the PR:

1. **Present** — one Claude Code session runs the
   [pr-presentation skill](plugin/skills/pr-presentation/SKILL.md) with the
   read-only token: the skill collects the PR into a work folder (metadata,
   linked issues, the diff, two worktrees at the merge base and the head),
   investigates the code, plans the slides and builds `deck.html`.
2. **Upload & comment** — the deck is uploaded as a plain HTML artifact
   (`archive: false`, so the artifact URL opens it in the browser), and a
   posting step creates or updates one comment on the PR with the comment
   token: a line with the link, and a `<sub>` line with the generation time
   that links to the workflow run.

The session job summary shows the outcome, duration, cost and token usage
of the session (subagents included), and any tool calls that were denied.

## The skill

[`plugin/skills/pr-presentation/`](plugin/skills/pr-presentation/) is the
pr-presentation skill: it turns a pull request into a slide deck that
explains the change from its code, not from the PR description.

[`plugin/`](plugin/) is a Claude Code plugin that holds nothing but the
skill. The run script loads it with `--plugin-dir` and starts the session
with the prompt `/pr-presentation <PR URL> <work folder>`, as a user would.

## Tuning

Deliberately hard-coded, each a one-line edit:

| Constant | Where | Value |
|---|---|---|
| Model | `MODEL` in [run-presentation.mjs](run-presentation.mjs) | `claude-opus-5-5` |
| Effort | `EFFORT` in [run-presentation.mjs](run-presentation.mjs) | `high` |
| Budget cap | `MAX_BUDGET_USD` in [run-presentation.mjs](run-presentation.mjs) | 15 |
| Session timeout | `SESSION_TIMEOUT_MS` in [run-presentation.mjs](run-presentation.mjs) | 30 min |
| Claude Code version | Install step in [action.yml](action.yml) | pinned exact |

The reader and builder subagents run on the `sonnet` alias that the skill
asks for, as that Claude Code version resolves it.

## Requirements

The calling workflow must, before invoking this action:

- **Check out the repository** with `actions/checkout` and `fetch-depth: 0`:
  the skill fetches the base branch and the PR head itself and computes the
  merge base in the checkout. Any ref is fine. Credential persistence must
  stay enabled (the default) so that fetch works on a private repository.
- **Set up Node** (≥ 20; preinstalled on GitHub runners, but callers typically
  pin a version).

The runner needs Chrome for the slide screenshots of the build step;
`ubuntu-latest` has it preinstalled.

The job needs only `contents: read` and `pull-requests: read`: the comment
is posted with `comment-token`, which the caller supplies from a secret.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `anthropic-api-key` | yes | | Anthropic API key (pass `secrets.ANTHROPIC_API_KEY`). |
| `pr-number` | yes | | Number of the pull request to present. |
| `github-token` | no | `github.token` | Read-only token that the session uses to collect the PR. |
| `comment-token` | yes | | Token with `pull-requests: write`, used only to post or update the comment; its identity is the comment author. |

## Artifacts

- `pr-<N>-deck.html` — the deck, uploaded on every successful run. Opens in
  the browser for logged-in users; kept for the repository's artifact
  retention period.

## Example caller workflow

```yaml
name: PR Presentation

# Builds a slide deck for a pull request on a "/pr-presentation" PR comment.

on:
  issue_comment:
    types: [created]

# One deck per PR at a time; a re-trigger queues instead of aborting a run
# that may be mid-posting.
concurrency:
  group: pr-presentation-${{ github.event.issue.number }}
  cancel-in-progress: false

env:
  PR_NUMBER: ${{ github.event.issue.number }}

jobs:
  present:
    if: |
      github.event.issue.pull_request &&
      github.event.comment.body == '/pr-presentation' &&
      contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    steps:
      - name: React to trigger
        env:
          GH_TOKEN: ${{ secrets.COMMENT_TOKEN }}
        run: |
          gh api "repos/${{ github.repository }}/issues/comments/${{ github.event.comment.id }}/reactions" \
            -f content=eyes

      - name: Checkout
        uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - name: Setup Node
        uses: actions/setup-node@v6
        with:
          node-version: '24'

      - name: Build the presentation
        uses: vaadin/github-actions/pr-presentation@main # pin to a SHA
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          pr-number: ${{ env.PR_NUMBER }}
          comment-token: ${{ secrets.COMMENT_TOKEN }}
```
