# claude-code

Composite action that runs [Claude Code](https://github.com/anthropics/claude-code-action)
in tag mode — responding to `@claude` mentions in issue comments, PR review
comments, and PR reviews — with the configuration shared across Vaadin
repositories:

- **Review-thread scoping** — when triggered from a PR review comment, the
  prompt anchors Claude to the triggering thread (file/line/comment ids) so a
  reply like "@claude fix this" doesn't make it address every review comment
  on the PR.
- **Reference repositories** — optionally clone upstream repositories
  read-only, expose them as additional working directories, and describe them
  to Claude in an appended system prompt.
- **Playwright MCP** — a pinned Playwright MCP server driving the runner's
  preinstalled Chrome, for verifying UI behavior.
- **Session summary** — outcome, turns, duration, cost, token usage, and any
  permission denials (with what to add to the allowlist) in the job summary.
- **Execution log artifact** — opt-in upload of the full stream-json trace for
  debugging.

## Requirements

The calling workflow must, before invoking this action:

- **Check out the repository**
- **Set up the toolchain** Claude needs to build and test the repository
  (JDK, Node, dependency install, licenses, …).

`git` and `node` (≥ 20) must be on the `PATH`; both are preinstalled on GitHub
runners, and callers typically set up Node explicitly anyway.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `anthropic-api-key` | yes | | Anthropic API key (pass `secrets.ANTHROPIC_API_KEY`). |
| `reference-repos` | no | `''` | Upstream repositories to clone as read-only context, one `owner/repo \| description` per line. |
| `extra-allowed-tools` | no | `''` | Repository-specific additions to the base tool allowlist, comma- or newline-separated, in `--allowedTools` syntax. |
| `extra-system-prompt` | no | `''` | Repository-specific instructions appended to the system prompt. |
| `playwright-mcp-version` | no | `0.0.77` | Pinned Playwright MCP server version. |
| `upload-execution-log` | no | `'false'` | Set `'true'` to upload the full execution log as an artifact (world-readable on public repositories). Typically wired to `vars.CLAUDE_DEBUG`. |

## Outputs

| Output | Description |
|---|---|
| `execution-file` | Path to the stream-json execution log of the run. |

## Example caller workflow

```yaml
name: Claude Code

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

jobs:
  claude:
    # Skip workflow if the comment does not tag claude or the author is not a
    # maintainer. Having this check here ensures that this scenario does not
    # even start a runner.
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude') &&
        contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)) ||
      (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@claude') &&
        contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)) ||
      (github.event_name == 'pull_request_review' && contains(github.event.review.body, '@claude') &&
        contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.review.author_association))
    runs-on: ubuntu-latest
    permissions:
      # Required by actions/checkout
      contents: read
      # Required by anthropics/claude-code-action to generate a short-lived
      # app token (contents/pull_requests/issues: write) that is revoked at the
      # end of the run. Thus, there should be no need to grant additional write
      # permissions to the workflow itself.
      id-token: write
      # Required by github_ci MCP server, which uses the workflow token instead
      # of the short-lived app token
      actions: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          ref: ${{ github.event.repository.default_branch }}
          fetch-depth: 1
          persist-credentials: false

      # Repository-specific toolchain setup goes here: setup-java/setup-node,
      # dependency install, licenses, ...
      - name: Setup Node
        uses: actions/setup-node@v6
        with:
          node-version: '24'

      - name: Run Claude Code
        uses: vaadin/github-actions/claude-code@main # pin to a SHA
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          extra-allowed-tools: Bash(yarn test:*),Bash(yarn lint:*)
```
