# code-review

Composite action that reviews a pull request with
[Claude Code](https://github.com/anthropics/claude-code-action) and posts the
findings as a single PR review:

1. **Prepare** — pre-computes everything the review needs so the review agent
   never has to derive it: the PR diff exactly as GitHub renders it, the
   changed-file list, the PR metadata, and a merge-base worktree (the
   pre-change state), all named by absolute path in an overview file.
2. **Review** — Claude runs a phased multi-agent review and reports the
   result via a `ReportFindings` tool call.
3. **Post** — the findings are posted as one review: each finding as an inline
   review thread (demoted line-level → file-level → summary list as anchoring
   fails) plus a summary body with an overview line and a table over all
   findings.

Shared with the [`claude-code`](../claude-code/) action: optional read-only
reference repository checkouts, instruction injection, the session job
summary, and the opt-in execution log artifact.

## Requirements

The calling workflow must, before invoking this action:

- **Check out the PR head** (`refs/pull/<number>/head`) — it is the review's
  working tree. Credential persistence must stay enabled (the default) so the
  prepare step can fetch the merge-base commit.
- **Set up Node** (≥ 20; preinstalled on GitHub runners, but callers typically
  pin a version).

The job needs `pull-requests: write` (post the review), `issues: write` (if
the caller reacts to the trigger comment), and `id-token: write` (used by
anthropics/claude-code-action).

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `anthropic-api-key` | yes | | Anthropic API key (pass `secrets.ANTHROPIC_API_KEY`). |
| `pr-number` | yes | | Number of the pull request to review. |
| `github-token` | no | `github.token` | Token used to prepare the review inputs and post the review; its identity is the review author. Pass a bot token to post under a bot identity. |
| `reference-repos` | no | `''` | Upstream repositories to clone as read-only context, one `owner/repo \| description` per line. |
| `extra-instructions` | no | `''` | Repository-specific review instructions, injected as project instructions. |
| `extra-allowed-tools` | no | `''` | Read-only additions to the base tool allowlist, comma- or newline-separated, in `--allowedTools` syntax. |
| `upload-execution-log` | no | `'false'` | Set `'true'` to upload the full execution log as an artifact (world-readable on public repositories). Typically wired to `vars.CLAUDE_DEBUG`. |

## Outputs

| Output | Description |
|---|---|
| `execution-file` | Path to the stream-json execution log of the run. |
| `findings-file` | Path to the extracted findings JSON (the input of the last `ReportFindings` call); empty when the run produced no report. The same file is uploaded as a workflow artifact. |

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
      id-token: write
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
