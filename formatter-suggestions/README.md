# formatter-suggestions

Composite action that reports the result of a formatter workflow on its pull
request, so that the author can fix the formatting from the pull request page
instead of running the formatter locally:

- **Review suggestions** — each change the formatter makes on lines of the
  pull request diff is posted as a suggestion, which the author accepts with
  **Add suggestion to batch** and **Commit suggestions**. The suggestions are
  taken verbatim from the formatter diff; nothing is generated.
- **Summary comment** — one comment lists the files that are not formatted,
  counts the changes that could not be suggested and points at the fix
  command. Each run updates it, and it is deleted once the format is fixed.
- **Cleanup** — a suggestion an earlier run posted and the current one no
  longer makes (accepted, formatted otherwise, or on lines that have since
  changed) is deleted, unless someone other than the bot replied to it. One
  it still makes on the same lines is not posted again.

A suggestion can only be placed on lines that are part of the pull request
diff, and can't add a missing newline at the end of a file. Such changes, and
those beyond `max-suggestions`, are counted in the summary comment.

## How it fits together

The formatter runs code of the pull request — build files, plugins — so the
workflow running it must not have write access, and a pull request from a
fork does not get it anyway. The work is therefore split in two:

1. **The formatter workflow** (`pull_request`, read-only) runs the formatter,
   writes `git diff` to a file and uploads it as an artifact, also when the
   diff is empty so that the comment of an earlier run can be removed.
2. **The report workflow** (`workflow_run`, runs this action) runs from the
   default branch with write access. It does not check out the pull request:
   it downloads the diff and parses it as text, finds the pull request from
   the commit the formatter checked, and suggests changes only in files the
   pull request changes. Diffs larger than 1 MB are rejected.

Being a `workflow_run` workflow, a change to the report workflow takes effect
only once it is on the default branch.

## Token and permissions

The action posts with the workflow `GITHUB_TOKEN`, as `github-actions[bot]`,
and recognizes its earlier suggestions by that author and the
`Formatting suggestion:` prefix. The job needs:

```yaml
permissions:
  actions: read # download the artifact of the formatter run
  pull-requests: write # post and delete the suggestions
  issues: write # post, update and delete the summary comment
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `fix-command` | yes | | Command that applies the formatting locally, shown in the summary comment, e.g. `mvn spotless:apply`. |
| `artifact-name` | no | `formatter-diff` | Artifact the formatter workflow uploaded the diff in. |
| `diff-file` | no | `formatter-diff.txt` | Name of the diff file inside the artifact. |
| `comment-marker` | no | `<!-- formatter-suggestions -->` | Hidden marker that starts the summary comment. Pass the marker of an existing comment to keep updating it. |
| `max-suggestions` | no | `'12'` | Most suggestions posted in one review. |

## Example workflows

The formatter workflow, without write access:

```yaml
name: Formatter

on:
  pull_request:

permissions:
  contents: read

jobs:
  formatter:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      # Set up the toolchain the formatter needs
      - name: Run formatter
        id: formatter
        run: |
          mvn -B spotless:apply
          git diff > formatter-diff.txt
          echo "modified=$(git status --porcelain | wc -l)" >> "$GITHUB_OUTPUT"
      - uses: actions/upload-artifact@<sha>
        with:
          name: formatter-diff
          path: formatter-diff.txt
      - name: Fail if formatting issues exist
        if: steps.formatter.outputs.modified != '0'
        run: exit 1
```

The report workflow:

```yaml
name: Formatter Suggestions

on:
  workflow_run:
    workflows: [Formatter]
    types: [completed]

permissions:
  contents: read

jobs:
  report:
    if: >-
      github.event.workflow_run.event == 'pull_request'
      && github.event.workflow_run.conclusion != 'cancelled'
    runs-on: ubuntu-latest
    permissions:
      actions: read
      pull-requests: write
      issues: write
    steps:
      - uses: vaadin/github-actions/formatter-suggestions@<sha>
        with:
          fix-command: mvn spotless:apply
```

## Tests

```sh
node --test formatter-suggestions/
```
