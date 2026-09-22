# reconcile-since-tags action

A composite GitHub Action that reconciles Javadoc `@since` tags against a
library's **published release history** instead of git history.

It downloads the `-sources.jar` of every release from Maven Central, records — per
public/protected API element — the full set of versions it appears in, and derives
`@since` as *the start of the contiguous run of presence that reaches the latest
release* (so backports to dead-end maintenance lines are ignored). It then, in the
checked-out repo:

- **fills** missing `@since` tags,
- **fixes** wrong ones,
- **creates** a minimal `/** @since X */` for undocumented types,
- **removes** redundant tags that merely repeat the enclosing type's version.

The action only edits the working tree (and formats the files it touched). It does
**not** commit or push — the caller decides what to do with the result.

## Inputs

| input | required | default | description |
|---|---|---|---|
| `group-id` | yes | | Maven groupId of the published artifacts |
| `artifacts` | yes | | newline-separated modules: `<artifact>` (src root defaults to `<artifact>/src/main/java`) or `<artifact>=<source-root>` |
| `version` | no | *(pom)* | target version; blank derives `major.minor` from `project.version` |
| `formatter` | no | `auto` | `auto` \| `spotless` \| `formatter` \| `none` |
| `filter` | no | `all` | `all` \| `add` (only insert) \| `update` (only fix/remove) |
| `write` | no | `true` | `false` for a dry run (reports only, no edits) |
| `index-dir` | no | `.since-index` | where the built index lives; give a separate-timeline group its own dir |

Output: `version` — the resolved target version.

Source roots are resolved relative to the repository root and must exist: a root
that is not there fails the run instead of silently reconciling nothing. Modules
whose directory is not named after the published artifact therefore need the
explicit `<artifact>=<source-root>` form.

> **One `artifacts` list == one shared version timeline.** The index merges every
> artifact's presence sets onto a single version axis (so classes that move between
> modules are tracked). That's only correct when the modules release on the *same*
> versions. An artifact versioned independently (e.g. an add-on that once had its own
> `1.x`/`10.x` scheme before aligning) must be a **separate invocation** with its own
> `index-dir` — otherwise its foreign versions inject false gaps and corrupt `@since`
> for everything. See the two-step example below.

## What it caches

- **Sources** (`~/.cache/since-tags`), keyed by the artifacts' Maven metadata —
  no re-download when nothing was released. The key is scoped to the invocation's
  artifact list, so several invocations in one repository (a matrix of one artifact
  per shard, or a separately-versioned module with its own `index-dir`) keep
  separate caches instead of restoring and then re-saving each other's sources.
  Sources are only stored when they were actually downloaded.
- **Built index** (`.since-index`), keyed by metadata **+** the tool hash — when it
  hits, the run skips download *and* parsing and just applies.

## Usage

The action runs against the repo you've already checked out. A typical
`workflow_dispatch` caller that opens a PR with the result:

```yaml
name: Update @since tags
on:
  workflow_dispatch:
    inputs:
      branch: { description: Branch to reconcile, required: true, default: main }

permissions:
  contents: write
  pull-requests: write

jobs:
  reconcile:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
        with:
          ref: ${{ inputs.branch }}
          fetch-depth: 0
      - run: git config core.hooksPath /dev/null   # husky isn't set up in CI
      - uses: actions/setup-java@c1e323688fd81a25caa38c78aa6df2d33d3e20d9 # v4.8.0
        with:
          distribution: temurin
          java-version: 21
          cache: maven

      - uses: vaadin/github-actions/reconcile-since-tags@v1   # pin to a SHA in production
        with:
          group-id: com.vaadin
          artifacts: |
            flow-server
            flow-data
            flow-html-components
            flow-polymer-template
            flow-dnd
            flow-webpush
            flow-react

      - uses: peter-evans/create-pull-request@c5a7806660adbe173f04e3e038b0ccdcd758773c # v6.1.0
        with:
          base: ${{ inputs.branch }}
          branch: since-tags/${{ inputs.branch }}
          add-paths: "**/*.java"
          title: "docs: reconcile @since tags"
          commit-message: "docs: reconcile @since tags"
          delete-branch: true
```

> Note: PRs opened with the default `GITHUB_TOKEN` don't trigger the repo's CI.
> Pass a PAT to `create-pull-request` (`token:`) if you need checks to run.

### A separately-versioned module

Add a second invocation with its own `index-dir` before the PR step; both edit the
working tree, so one `create-pull-request` picks up all the changes:

```yaml
      - uses: vaadin/github-actions/reconcile-since-tags@<sha>
        with:
          group-id: com.vaadin
          index-dir: .since-index-spring
          artifacts: |
            vaadin-spring
```

## Assumptions / limits

- `@since` is assumed to equal the **artifact version** (true for Flow and most
  single-scheme libraries; not for projects whose `@since` tracks a separate
  platform version).
- Artifacts on a different version scheme must be run as a separate invocation —
  don't mix timelines in one `artifacts` list.
- The library must publish `-sources.jar` artifacts, and **every** listed release
  must be downloadable. A release that still cannot be fetched or unpacked after
  retries fails the run instead of leaving a hole in the index: presence is per
  artifact but the release axis is shared, so a hole reads as "this artifact's API
  did not exist yet" and re-dates `@since` for every type in that module to the
  release after the hole. Retries are tunable via the `SINCE_FETCH_ATTEMPTS`
  (default `4`) and `SINCE_FETCH_DELAY` (default `3` seconds, doubled per attempt)
  environment variables. An artifact that yields no index entries at all (no usable
  `-sources.jar` in any release) fails the run for the same reason.

## Contents

- `action.yml` — the composite action.
- `SinceTool.java` — the engine (jbang single-file; JavaParser).
- `build-index.sh` — downloads + indexes one artifact's release history.
- `run.sh` — orchestrates index → apply → format-touched-only.
