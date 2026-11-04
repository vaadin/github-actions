# code-review

Composite action that reviews a pull request with a single headless
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) session and
posts the findings as a single PR review:

1. **Prepare** — pre-computes everything the review needs so the review agent
   never has to derive it: the PR diff exactly as GitHub renders it, the
   changed-file list, the PR metadata, a merge-base worktree (the pre-change
   state), and the PR's existing reviews, all named by absolute path in an
   inputs file that is inlined into the review prompt.
2. **Review** — one read-only Claude Code session reviews the changes against
   the focus areas of the selected [profile](#profiles), writes a
   free-text judgement per finding, grades each finding's `value`
   (`high` / `medium` / `low`), rates the risk of the change (`low` /
   `medium` / `high`, `code` profile only), and reports once as structured
   output.
3. **Select & post** — selection is mechanical: findings at or above the
   value bar are posted as one review — each finding as an inline review
   thread (demoted line-level → file-level → summary list as anchoring
   fails) plus a summary body with an overview line, the risk of the change
   and a table. The agent
   never hears which tiers ship, so it has no incentive to inflate borderline
   findings.

A markdown summary of **every** finding — posted and withheld, each with the
agent's judgement — is uploaded as a workflow artifact on every run, so the
pipeline's selection behavior can be reviewed independently of what reached
the PR.

The review session runs the Claude Code CLI directly (pinned in
[action.yml](action.yml)); the session is read-only via `--tools`
(Read/Grep/Glob/Bash only — no write, subagent, or web tools), with a
read-only Bash command allowlist that is also advertised to the agent.

Shared scripts in [`lib/`](../lib/) provide optional read-only reference
repository checkouts, instruction injection, and the session job summary.

## Profiles

The `profile` input selects the review prompt. The profiles share the tools,
the findings schema, the value tiers and the posting.

| Profile | Prompt | Reviews | Categories | Risk |
|---|---|---|---|---|
| `code` (default) | [prompts/review.md](prompts/review.md) | Framework and library code | `correctness`, `documentation`, `tests`, `conventions` | yes |
| `docs` | [prompts/review-docs.md](prompts/review-docs.md) | Documentation pages and their code examples | `accuracy`, `clarity`, `examples`, `placement`, `conventions` | no |

A profile with risk adds a `risk` object (`level`, `reason`) to the
structured output. The agent rates the risk of merging the change by its
impact, blast radius, uncertainty and reversibility. The risk goes into the
findings file, the findings summary and the review body.

The prompts ship with the action. A caller cannot pass a prompt file, so a
pull request cannot change the prompt that reviews it. Pass
repository-specific context with `extra-instructions`.

## Auto-approval

Set `auto-approve: 'true'` to let the action approve a pull request. The
action approves only when all of these conditions are true:

- The review posts no findings. Findings below the value bar do not block
  the approval.
- The risk is at or below `auto-approve-max-risk` (default `low`). Only the
  `code` profile rates risk, so the `docs` profile never approves.
- The conventional commit type of the PR title is one of
  `auto-approve-types` (default `chore, docs, test`). A scope, such as
  `chore(deps):`, is permitted. A breaking change, such as `chore!:`, never
  matches.
- The PR head is still the commit that the review read.

The approval replaces the "nothing to flag" comment review, and adds a note
that it was automatic. The `github-token` must be allowed to approve pull
requests. For `github.token`, enable "Allow GitHub Actions to create and
approve pull requests" in the repository settings. A token cannot approve a
pull request that its own identity opened. When GitHub refuses the approval,
the action posts the review as a comment and logs a warning.

## Tuning

Deliberately hard-coded, each a one-line edit:

| Constant | Where | Value |
|---|---|---|
| Model | `MODEL` in [run-review.mjs](run-review.mjs) | `claude-opus-5` |
| Value bar (minimum tier posted) | `VALUE_BAR` in [run-review.mjs](run-review.mjs) | `medium` |
| Session timeout | `SESSION_TIMEOUT_MS` in [run-review.mjs](run-review.mjs) | 30 min |
| Claude Code version | Install step in [action.yml](action.yml) | pinned exact |

## Requirements

The calling workflow must, before invoking this action:

- **Check out the PR head** (`refs/pull/<number>/head`) — it is the review's
  working tree. The prepare step fetches the merge-base commit with the
  `github-token` input, so the checkout can set `persist-credentials: false`.
- **Set up Node** (≥ 20; preinstalled on GitHub runners, but callers typically
  pin a version).

The job needs `pull-requests: write` (post the review) and `issues: write`
(if the caller reacts to the trigger comment).

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `anthropic-api-key` | yes | | Anthropic API key (pass `secrets.ANTHROPIC_API_KEY`). |
| `pr-number` | yes | | Number of the pull request to review. |
| `profile` | no | `code` | Review profile: `code` or `docs`. See [Profiles](#profiles). |
| `github-token` | no | `github.token` | Token used to prepare the review inputs (including fetching the merge-base commit, so it needs read access to private repositories) and post the review; its identity is the review author. Pass a bot token to post under a bot identity. |
| `reference-repos` | no | `''` | Upstream repositories to clone as read-only context, one `owner/repo \| description` per line. |
| `extra-instructions` | no | `''` | Repository-specific review instructions, injected as project instructions. |
| `extra-allowed-tools` | no | `''` | Read-only additions to the Bash auto-approve allowlist, comma- or newline-separated, in `--allowedTools` syntax. |
| `auto-approve` | no | `'false'` | Set `'true'` to approve pull requests that meet the conditions in [Auto-approval](#auto-approval). |
| `auto-approve-max-risk` | no | `low` | The highest risk that auto-approval accepts: `low`, `medium` or `high`. |
| `auto-approve-types` | no | `chore, docs, test` | The conventional commit types of the PR title that auto-approval accepts, comma- or newline-separated. |
| `upload-execution-log` | no | `'false'` | Set `'true'` to upload the full execution log as an artifact (world-readable on public repositories). Typically wired to `vars.CLAUDE_DEBUG`. |

## Artifacts

- `code-review-findings-pr<N>-…` — the findings summary markdown, uploaded on
  every run: the risk of the change (when the profile rates it), and every
  reported finding with location, category, value tier, summary,
  explanation, and judgement, grouped into posted / withheld.
- `code-review-execution-…` — the full execution log, only when
  `upload-execution-log` is `'true'`.

## Example caller workflow

```yaml
name: Code Review

# Reviews a pull request, triggered automatically when a PR is opened
# (eligibility rules on the job condition) or by a "/code-review" PR comment.

on:
  issue_comment:
    types: [created]
  pull_request:
    types: [opened]
    branches: [main]

# One review per PR at a time; a re-trigger queues instead of aborting a run
# that may be mid-posting.
concurrency:
  group: code-review-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false

env:
  PR_NUMBER: ${{ github.event.issue.number || github.event.pull_request.number }}

jobs:
  review:
    # Comment trigger: collaborators only. Auto trigger on opened PRs skips
    # drafts, chore PRs, known bots, and non-collaborators (also keeps fork
    # PRs out, which would fail on missing secrets anyway).
    if: |
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request &&
       github.event.comment.body == '/code-review' &&
       contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)) ||
      (github.event_name == 'pull_request' &&
       github.event.pull_request.draft == false &&
       !contains(fromJSON('["dependabot[bot]", "vaadin-bot"]'), github.event.pull_request.user.login) &&
       contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.pull_request.author_association) &&
       !startsWith(github.event.pull_request.title, 'chore:') &&
       !startsWith(github.event.pull_request.title, 'chore('))
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      pull-requests: write
    steps:
      - name: React to trigger
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          if [ "${{ github.event_name }}" = "issue_comment" ]; then
            target="issues/comments/${{ github.event.comment.id }}"
          else
            target="issues/$PR_NUMBER"
          fi
          gh api "repos/${{ github.repository }}/$target/reactions" \
            -f content=eyes

      - name: Checkout PR branch
        uses: actions/checkout@v6
        with:
          ref: refs/pull/${{ env.PR_NUMBER }}/head
          fetch-depth: 1
          # The action authenticates with its `github-token` input.
          persist-credentials: false

      - name: Setup Node
        uses: actions/setup-node@v6
        with:
          node-version: '24'

      - name: Run code review
        uses: vaadin/github-actions/code-review@main # pin to a SHA
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          pr-number: ${{ env.PR_NUMBER }}
          upload-execution-log: ${{ vars.CLAUDE_DEBUG }}
```
