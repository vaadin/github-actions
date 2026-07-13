# github-actions

Shared GitHub Actions for Vaadin repositories. Each action lives in its own
directory and is referenced as `vaadin/github-actions/<name>@<ref>`.

| Action | Description |
|---|---|
| [`claude-code`](claude-code/) | Runs Claude Code in tag mode (`@claude` mentions) with shared configuration: review-thread scoping, optional read-only reference repository checkouts, Playwright MCP, session summary, and an opt-in execution log artifact. |
| [`reconcile-since-tags`](reconcile-since-tags/) | Reconciles Javadoc `@since` tags against a library's published release history on Maven Central: fills missing tags, fixes wrong ones, creates minimal `@since` javadoc for undocumented types, and removes redundant tags. Leaves the working tree modified for the caller to commit. |

## Versioning

Pin actions by commit SHA, the same way the Vaadin repositories pin third-party actions:

```yaml
uses: vaadin/github-actions/claude-code@<sha>
```
