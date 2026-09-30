# cherry-pick

Composite action that cherry-picks merged pull requests to maintenance
branches. It runs
[`scripts/cherryPick.js`](https://github.com/vaadin/platform-build-script/blob/main/scripts/cherryPick.js)
from `vaadin/platform-build-script`:

- **Label driven** — every pull request merged into any branch within the
  lookback window and labelled `target/<branch>` is cherry-picked onto
  `<branch>`, in merge order, and a pull request titled
  `<title> (#<number>) (CP: <branch>)` is opened for it. The original pull
  request is then labelled `cherry-picked-<branch>`.
- **Per-branch tracking** — a target that already has `cherry-picked-<branch>`
  or `need to pick manually <branch>` is skipped, so runs are idempotent and
  every run picks up everything that is pending.
- **Conflict resolution with Claude Code** — merge conflicts are handed to
  Claude, which resolves them, runs the verify instructions and commits. The
  result is only accepted when the cherry-pick is complete and produced a new
  commit; such pull requests carry a warning and the `ai-resolved-conflict`
  label. Claude gets no GitHub credentials and cannot push, reset or abort.
- **Manual fallback** — picks that cannot be completed (conflicts Claude could
  not resolve, empty picks, missing target branches, errors) are labelled
  `need to pick manually <branch>`.

## Requirements

The calling workflow must, before invoking this action:

- **Check out the repository** with `fetch-depth: 0` and
  `persist-credentials: false`. The action fails otherwise.
- **Set up the toolchain** Claude needs for the verify instructions (JDK, Node,
  …).

`git`, `curl` and `node` (≥ 20) must be on the `PATH`; all are preinstalled on
GitHub runners.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | yes | | PAT or app token with contents, pull-requests and issues write access, and read access to `vaadin/platform-build-script` (pass `secrets.GHTK`). |
| `anthropic-api-key` | no | `''` | Anthropic API key. When empty, conflicts are labelled for manual picking. |
| `verify-instructions` | no | `''` | How Claude tests and formats the resolved changes in this repository. |
| `extra-allowed-tools` | no | `''` | Additions to the tool allowlist needed by the verify instructions, comma- or newline-separated, in `--allowedTools` syntax. |
| `dry-run` | no | `'false'` | Set `'true'` to only log what would be picked. |
| `lookback-days` | no | `'30'` | How far back to look for merged pull requests. |
| `script-ref` | no | `main` | Ref of `vaadin/platform-build-script` to take the script from. |

## Example caller workflow

```yaml
name: Cherry Pick

on:
  push:
    branches:
      - main
  # Catches PRs merged into maintenance branches and target/* labels added
  # after the merge.
  schedule:
    - cron: '0 */3 * * *'
  workflow_dispatch:
    inputs:
      dry-run:
        description: Only log what would be picked
        type: boolean
        default: false

# Every run picks up everything that is pending, so queue runs instead of
# running them in parallel.
concurrency:
  group: ${{ github.workflow }}
  cancel-in-progress: false

jobs:
  cherry-pick:
    runs-on: ubuntu-latest
    timeout-minutes: 180
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          persist-credentials: false

      # Repository-specific toolchain setup goes here: setup-java/setup-node,
      # dependency install, licenses, ...
      - name: Setup JDK 21
        uses: actions/setup-java@v5
        with:
          java-version: '21'
          distribution: 'temurin'
          cache: 'maven'

      - name: Cherry-pick
        uses: vaadin/github-actions/cherry-pick@main # pin to a SHA
        env:
          MAVEN_ARGS: -ntp -B
        with:
          github-token: ${{ secrets.GHTK }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          dry-run: ${{ inputs.dry-run || false }}
          verify-instructions: |
            - Run the unit tests of the affected module(s), e.g. mvn test -pl <module>
            - Run the formatter: mvn spotless:apply
          extra-allowed-tools: Bash(mvn:*)
```
