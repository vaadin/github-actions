# Build the deck from the plan

You change `<WORK>/plan.md` into `<WORK>/slides.json` and build the deck. The plan is the design. Follow it exactly: do not change the order, the slides, the texts or the tips. Your task is to make the deck build and show the code that the plan refers to.

## Inputs

- `<WORK>/plan.md`: the slides, the code as file and line ranges, the tips.
- `<WORK>/src/base`, `<WORK>/src/head`: checkouts of the repository before and after the PR. The plan refers to files in them.

## slides.json

```json
{
  "summary": "A maximum of three short sentences for the title slide.",
  "omitted": {"H14": "Why this code hunk is on no slide."},
  "slides": [
    {
      "title": "One item in the field",
      "text": "One sentence.",
      "introduces": ["valueButton", "idea: placeholder item"],
      "after": [{"code": "...", "file": "packages/x/src/x.js", "context": true}],
      "afterLabel": "Context"
    },
    {
      "title": "aria-selected comes back",
      "text": "One sentence: what went wrong.",
      "introduces": ["_selectedChanged"],
      "steps": [
        {"text": "One sentence.", "where": "__appendValueItemElement", "code": "itemElement.removeAttribute('aria-selected');"},
        {"text": "One sentence.", "where": "__attachSelectedItem", "code": "labelItem.selected = true;"}
      ],
      "tips": {"labelItem.selected = true;": "Bug: ..."}
    },
    {
      "title": "Remove selected from the copy",
      "text": "One sentence: how the change removes the cause.",
      "introduces": [],
      "before": [{"code": "..."}],
      "after": [{"code": "...", "caption": "Optional heading"}],
      "afterTips": {"itemElement.removeAttribute('selected');": "..."}
    }
  ]
}
```

### Slides

- Each slide is one screen. All slides are horizontal.
- Each slide has `title`, `text` and `introduces`.
- `introduces` lists the new things of the slide. A name must be in the code of the slide as a full name. A concept without a name is `"idea: ..."`.
- A slide has `before` and `after` panes, or `steps`.
- If a pane is empty, the page does not show it. The other pane gets the full width.
- `beforeLabel` and `afterLabel` replace the labels "Before" and "After".
- The page aligns chunk N of `before` with chunk N of `after`, line by line, and marks removed and added lines, while the pairs are the same type and share enough lines. Inside a changed line, the page also marks the changed words. `"align": false` stops this.

### Panes and chunks

- A pane is a string or a list of chunks. A chunk is a string or `{"code", "file", "caption", "context"}`.
- `file` is the path of the chunk's file in the repo, such as `packages/date-picker/src/vaadin-month-calendar.js`. The page shows it above the chunk.
- `"context": true` marks unchanged code. The page shows the context of both sides in one gray pane below the changed code, across the two columns, with the label "Context". The same code is shown one time. A side with only context gets no column: the changed code of the other side takes the full width. A slide with only context shows it at the normal size.
- `caption` is a short heading above a chunk.
- `...` marks skipped code: a line of its own, or in place of arguments.

### Steps

- `steps` is a list of at least 2 steps. Each step is `{"text", "where", "code"}`: one sentence, the name of the method, and the lines of code that do the step.
- The page shows the steps as a numbered list with arrows between them.
- The tips of the slide (`tips`, `beforeTips`) apply to the step code.

### Tips

- A tip key is exact code text: a name, a call or a full line. It matches the first location where it is a full name. `"key@2"` matches the second location.
- `tips` apply to the two panes. `beforeTips` and `afterTips` apply to one pane.
- A key that matches no code is a build error.
- The page shows inline code in backticks in all texts and tips.

## Procedure

1. Write `slides.json` with a Node script, `<WORK>/make_slides.mjs`. Do not write the JSON by hand.
   - Read each code reference from its file exactly, with its indentation.
   - Put one `...` line in place of each skipped range, with the indentation of the first skipped line that is not blank.
   - Remove the same indentation from all chunks of a side that come from the same file: the smallest indentation of these chunks.
   - Do not include comment lines.
   - Give each chunk `file`: the path of its file in the repo (the plan path without `src/base/` or `src/head/`).
   - Change the plan into JSON with this table:

     | Plan | slides.json |
     | --- | --- |
     | `Summary`, `Omitted` | `summary`, `omitted` |
     | `## N. <title>`, `Text`, `Introduces` | `title`, `text`, `introduces` |
     | `Before:`, `After:` | `before`, `after`: lists of chunks |
     | `src/base/<path>`, `src/head/<path>` | chunk key `file`: `<path>` |
     | `(context)`, `(caption: "...")` | chunk keys `context`, `caption` |
     | `Labels: X` or `Labels: X / Y` | `beforeLabel`, `afterLabel` (a side without code gets no label) |
     | `Align: off` | `"align": false` |
     | `Steps:` | `steps`: `{"text", "where", "code"}` for each step; `where` from `(in: ...)` |
     | tips `(both)`, `(before)`, `(after)` | `tips`, `beforeTips`, `afterTips` |
2. Build and check:
   ```bash
   S=<SKILL>/scripts
   node $S/build.mjs --pr <WORK>/pr.json --slides <WORK>/slides.json --src <WORK>/src --out <WORK>/deck.html
   node $S/hunks.mjs slides --work <WORK>
   node $S/check.mjs <WORK>/deck.html <WORK>/shots
   ```
   `check.mjs` saves one PNG for each slide and shows overflow. Do not open a visible browser.
3. Correct these problems, then build and check again:
   - **A tip key or a name is not found**: change the key until it matches the code exactly. For a name in `introduces` that is not in the code, write `idea: <name>`.
   - **A line range starts with a comment, a blank line or a closing brace, or stops before its block closes**: move it to the enclosing line and the closing line.
   - **A NOT SHOWN hunk in `hunks.mjs slides`**: change the line range of the plan to include the hunk.
4. Look at the PNGs of the first two slides and of each slide that overflows.

Do not change the design. Report each problem that needs a design change, such as overflow or code that does not exist.

Reply with the path of the HTML file, the problems that you corrected and the problems that you report.
