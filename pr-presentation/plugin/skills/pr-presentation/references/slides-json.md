# slides.json

`hunks.mjs build` writes `<WORK>/slides.json` from `plan.md` and `chain.md`, and `build.mjs` turns it into the page. Nobody writes it by hand: a problem in the deck is corrected in the plan or the chain, and the deck is built again.

```json
{
  "summary": "A maximum of three short sentences for the title slide.",
  "omitted": {"H14": "Why this code hunk is on no slide."},
  "notes": [
    {"kind": "Suspected bug", "questions": ["Q11"], "text": "One to three sentences from chain.md.", "slide": 9}
  ],
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
      ]
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

## Title and closing slide

- `summary` is the title slide.
- `notes` is the closing slide "Review notes": the notes of `chain.md` by kind. `kind` is `Suspected bug` or `Unexplained`. `slide` is the number of the first slide, from 1, whose tip starts with the kind and one of the `questions`; the page links to it. An item without `slide` is listed without a link.
- `omitted` is shown by `hunks.mjs slides`, not on the page.

## Slides

- Each slide is one screen. All slides are horizontal.
- Each slide has `title`, `text` and `introduces`.
- `introduces` lists the new things of the slide. A name must be in the code of the slide as a full name. A concept without a name is `"idea: ..."`.
- A slide has `before` and `after` panes, or `steps`.
- If a pane is empty, the page does not show it. The other pane gets the full width.
- `beforeLabel` and `afterLabel` replace the labels "Before" and "After".
- The page aligns chunk N of `before` with chunk N of `after`, line by line, and marks removed and added lines, while the pairs are the same type and share enough lines. Inside a changed line, the page also marks the changed words. `"align": false` stops this.

## Panes and chunks

- A pane is a string or a list of chunks. A chunk is a string or `{"code", "file", "caption", "context"}`.
- `file` is the path of the chunk's file in the repo, such as `packages/date-picker/src/vaadin-month-calendar.js`. The page shows it above the chunk.
- `"context": true` marks unchanged code. The page shows the context of both sides in one gray pane below the changed code, across the two columns, with the label "Context". The same code is shown one time. A side with only context gets no column: the changed code of the other side takes the full width. A slide with only context shows it at the normal size.
- `caption` is a short heading above a chunk.
- `...` marks skipped code: a line of its own, or in place of arguments.
- A line too long for its pane wraps after `(`, `,`, `.`, `[` or `{`, or at a space, never inside a name, and its next rows are indented two levels deeper.
- `hunks.mjs build` writes the code of a line range without comment lines, with one `...` line per skipped range indented like the skipped code, and with the smallest indentation of all chunks of the same file on that side removed.

## Steps

- `steps` is a list of at least 2 steps. Each step is `{"text", "where", "code"}`: one sentence, the name of the method, and the lines of code that do the step.
- The page shows the steps as a numbered list with arrows between them.
- The tips of the slide (`tips`, `beforeTips`) apply to the step code.

## Tips

- A tip key is exact code text: a name, a call or a full line. It matches the first location where it is a full name. `"key@2"` matches the second location.
- `tips` apply to the two panes. `beforeTips` and `afterTips` apply to one pane.
- A key that matches no code is a build error.
- The page shows inline code in backticks in all texts and tips.
- A tip that starts with a note kind (`Suspected bug (Q8): ...`) is a review note: the page marks its code with a wavy underline and shows the tip in red for a suspected bug, orange for the other kinds. Other tips have a dotted underline and a dark tooltip.
