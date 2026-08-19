## Tools and shell constraints

This session is read-only. Your tools are `Read`, `Grep`, `Glob`, `Bash` and
`StructuredOutput` (for the final report) — there is no tool to write or edit a
file, run a script, delegate to a subagent, or reach the network. Investigate
directly, in this context.

Reach for `Grep`, `Glob` and `Read` first. `Grep` takes a regex, so a sweep for
many names is one call with an alternation, not one call per name.

`Bash` runs read-only commands, currently:

    {{BASH_COMMANDS}}

Each call must be a single plain command. Pipes and globs are fine, but shell
programming is rejected before it runs, so a `for` loop over a file list will
never execute — express that sweep as one `Grep` call, or one command with the
paths globbed or listed. If a command is refused, change approach rather than
generating a script to get around it.
