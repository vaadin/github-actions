---
name: pr-presentation
description: Turn a GitHub pull request into a reveal.js slide deck that explains the change from its code, not from the PR description: each hunk raises questions, the code answers them, and the slides tell that chain step by step (background code, bugs as steps, fixes as old and new code, tooltips). Questions the code cannot answer are reported as possible problems in the PR. This copy runs in CI: the action collects the PR into the work folder before the session starts.
argument-hint: <work-dir>
allowed-tools: Read, Write, Edit, Grep, Glob, Agent, Bash(mkdir *), Bash(node *)
---

## The idea

**Code first.** The code is the best specification of the change. Do not trust what the author says about the PR: the description, the commit messages and the review comments tell what the author thinks the change does, so do not read them. Answer every question from the code in the checkouts under `<WORK>/src`: the diff, the code around it, callers, definitions, types, names. Tests only confirm an answer. Only a question that the code cannot answer sends you further: to the linked and related issues in `context.md`. An answer from there is weaker than one from the code: say in "Looked at" where it comes from, and confirm in the code what you can. What you know about the PR or the repository from elsewhere does not count.

**Concepts.**

- Hunk: one changed block of the diff, `H01`, `H02` and so on.
- Question: what a hunk or an answer leaves unexplained.
- Answer: one to three sentences, with the file and lines that prove them.
- Open question: a question that neither the code nor the issues can answer. It stays in the deck as a review note. It marks a place where the implementation must be trusted instead of understood, so it can show a problem in the PR.
- Chain: the facts in the order a new reader needs them: how the code works, what was wrong, how each change corrects it.
- Area: code outside the change that the chain needs.
- New thing: a name or concept that no earlier slide explained, also a term from outside the code.

**Logical chain.** The deck tells the chain: one or more facts per slide, with the code that proves them. Each fact follows from the facts before it and refers to the questions that prove it. Each code hunk is part of the chain. A hunk that no fact needs is an open question.

**Questions.** Start from the hunks. Read each hunk and the code around it, and write each question it raises: why did the old code do this, what goes wrong if it stays, where is this name defined, who calls this and when, which cases reach this line, what did the old condition match and what does the new one match. Answers raise new questions, also about unchanged code. Ask those too: they show which areas the reader must know.

**Answers.** Answer each question from the code. Read the lines, then write the answer and where you found it. Do not answer from memory. If the code cannot answer, check the issues. If they cannot either, do not guess: record an open question. Stop when every question has an answer or is open.

Three steps do this work. Two agents do the rest: a reader that sees nothing but the slides, and a builder that turns the plan into the deck. Start each agent in the foreground (`run_in_background: false`) and wait for its reply. Do not continue an agent with `SendMessage`: start a new one. The steps pass their results in files under `<WORK>`. `<SKILL>` is the base directory of this skill, printed as "Base directory for this skill" when it is invoked. `$0` is `<WORK>`, the folder for all files of the run. If the argument is missing, stop and report it.

**Output.** The only result is the file `<WORK>/deck.html`. Nobody reads your replies and nobody answers questions during the run. When step 5 is done, stop with an empty reply: do not summarize the deck. If a step cannot continue, stop and report why in one sentence.

## 1. Inputs

`<WORK>` holds the PR, collected before this session started:

- `src/base/`, `src/head/`: the whole repository at the merge base of the PR and at its head. Read and search them freely; the deck can show any file from them. Do not change them.
- `context.md`: read only `## Linked issue` and `## Related issue`. The other sections are the PR description, commits and comments.
- `pr.json`, `pr.diff`. Do not read `body` in `pr.json`: it is the PR description.
- `hunks.json`, `annotated.md`: the diff split into hunks. A hunk is what git made: every `@@` header of `pr.diff` starts one, numbered in diff order across all files, `H01`, `H02` and so on. Each hunk has a kind from its path: `code`, `test`, `screenshot` or `generated`. Only `code` hunks must raise a question and be on a slide. `annotated.md` is the diff with one `## H07 ...` section per hunk. Read it to see the hunks.

## 2. Investigate

Ask and answer as described above. Write `<WORK>/chain.md` in this format:

````markdown
## Questions

### Q1 (from H01): Why does the old code set `labelItem.selected = true`?
- Looked at: src/base/packages/select/src/vaadin-select-base-mixin.js L489-491, src/base/packages/vaadin-lumo-styles/src/components/select-value-button.css L34-37
- Answer: only the copy of the selected item gets `selected`. The Lumo rule `::slotted(*:not([selected]))` uses this to find the placeholder item.
- New questions: Q2

### Q2 (from Q1): What does setting `selected` do on an item?
- Looked at: src/base/packages/item/src/vaadin-item-mixin.js L30-34, L104-106
- Answer: `selected` has the observer `_selectedChanged`, which writes `aria-selected`.
- New questions: none

## Areas

- The `selected` property of an item and its observer (src/base/packages/item/src/vaadin-item-mixin.js L30-34, L104-106): Q2

## Chain

1. The field shows one item: a copy of the selected item, or a placeholder item. (Q4)
2. `__appendValueItemElement` removes `aria-selected` from the copy. (Q3)

## Open questions

none
````

- Each question names the hunk or the question that raised it.
- "Areas" lists the code outside the change that the chain needs, with the questions that need it.
- Keep only the facts the reader needs to follow what was wrong and how the change corrects it. If the change removes an attribute that must not be there, the chain needs the code that adds and removes it, not the reason the attribute is wrong in the accessibility standard.
- Open questions: a change without a reason in the code, a case the change does not cover, a line that does not do what it seems to do, a hunk that no fact needs.

Check, correct each problem, repeat until it shows none:

```bash
node <SKILL>/scripts/hunks.mjs chain --work <WORK>
```

Write the whole chain before you plan any slide: the plan may use only facts from the chain.

## 3. Present

Turn `chain.md` into `<WORK>/plan.md`: the slides, their order, the code on each slide and each tip. The builder (step 5) follows the plan exactly, so the plan holds every decision. Do not write JSON and do not build the deck yourself.

Before you put code on a slide, open the files from "Looked at" again, choose the exact lines, and take each tip key from their text. Do not trust line numbers from the chain or from memory.

### The reader

The reader reads the deck alone, in a browser, before the diff. Read `<SKILL>/references/reader.md` before you plan, and the files that its section "The reader" tells the reader to read. That section lists what the reader knows and what the deck must explain: a name from "Knows without explanation" is not a new thing and needs no tip, a name from "Does not know" gets a tip where it first appears. Every word the reader sees is yours: the summary, the titles, the slide sentences and the tips.

### Slides

- Put the slides in the order of the chain. Each slide shows one or more facts and the lines from "Looked at" of their questions.
- Show only what the chain needs. If a slide needs a new fact, add its question and answer to `chain.md` first.
- An area gets a slide of its own only if the chain needs it before the first change, and only the lines the chain uses.
- Show each open question in a tip on the code it is about, starting with "Open question:". It is a review note for the author, not part of the explanation: the reader check skips it, and it is not a new thing.
- Do not show tests, snapshots or screenshots.

Kinds of slides:

- **Background**: unchanged code the chain needs before the first change. All its code is context.
- **Bug**: for a fix, the steps that caused the bug as a step list, in the order they run. Each step has one sentence and the one to three lines of old code that do it. The slide sentence tells what went wrong. The tip on the line that causes the bug starts with "Bug:" and names the cases that had the bug and the cases that did not. Example with three steps: 1. `__appendValueItemElement` removes `aria-selected` from the copy. 2. Then `__attachSelectedItem` sets `labelItem.selected = true`. 3. The observer `_selectedChanged` writes `aria-selected` again.
- **Fix**: right after the bug slide. Only the changed lines, old on the left and new on the right. Its sentence tells how the change removes the cause.
- **Change**: any other change, old on the left and new on the right.

### Rules

One slide, one screen, one idea:

- A slide fits one screen. If not, make the code smaller or continue on the next slide.
- A slide has a maximum of 4 new things. Explain each on the slide where it first occurs, and do not use it before that slide.
- Each slide text is clear on its own. Do not refer to other slides by number, or with "continuing" or "as shown before".

Code:

- Real lines from the PR, with their indentation. Do not change or join lines. To shorten, skip lines only.
- Start each block with its enclosing line: the method signature, the class line, the CSS selector.
- Show an unchanged line only if it opens a shown block, or the text or a tip mentions it. A one-line change gets a few lines, not a full method.
- Do not show comments.
- Each piece of code on one slide only. Exception: the fix slide shows the changed lines of the bug slide again.
- Mark all unchanged code `(context)`, on either side. The page shows it below the changed code. `Labels:` names only changed code.
- Put old and new versions of the same code at the same chunk position, so the page aligns them and marks the changes. If the two sides are not versions of the same code, set `Align: off`.

Conditions: when the change touches a condition (a selector, an `if`, a flag check), the slide text tells what the old condition matched in practice and why the new one matches the same. Example: "The old selector `:not([selected])` matched only the placeholder item, because every copy had `selected`. The button has `placeholder` only while it shows that item, so the new selector matches the same item."

Text and tips:

- A title of 2 to 5 words and one sentence of about 25 words. Everything else goes in tips.
- Use only the concepts the reader needs to follow what was wrong and how the change corrects it.
- A tip on each changed line and each new name: one point, a maximum of 20 words. Do not write a tip that only tells what a line does.
- No tips on unchanged lines, except a line the reader would not connect to the change without one. That tip names the changed line it explains.
- Short sentences, simple words, no em dashes. Many readers are not native speakers of English.

### The plan

Write `<WORK>/plan.md` in this format. Refer to code by file and lines. Do not copy code: the builder reads the lines from the files.

````markdown
Summary: a maximum of three short sentences for the title slide.
Omitted: none                                    <- or code hunks that are on no slide, with the reason

## 1. <title>
Hunks: none                                      <- the code hunks that this slide shows
Text: one sentence.
Introduces: valueButton, idea: placeholder item  <- the new things, a maximum of 4
After:
- src/head/<path> L530-549, skip L531-540 (context)

## 2. <title of a bug slide>
Hunks: none
Text: what went wrong.
Introduces: ...
Steps:
1. One sentence for this step.
   - src/base/<path> L523 (in: __appendValueItemElement)
2. One sentence for this step.
   - src/base/<path> L491 (in: __attachSelectedItem)
Tips:
- `labelItem.selected = true;` (both): Bug: ...

## 3. <title of a fix slide>
Hunks: H01, H02
Text: how the change removes the cause.
Introduces: ...
Labels: Old / New                                <- only if not "Before / After"
Before:
- src/base/<path> L475-492, skip L476-487
After:
- src/head/<path> L475-489, skip L476-487
Tips:
- `itemElement.removeAttribute('selected');` (after): what this line does against the bug.
````

- A code reference is `src/base/...` (old code) or `src/head/...` (new code), with lines and optional skips. A skipped range shows as one `...` line. Add `(context)` for unchanged code, `(caption: "...")` for a heading.
- A tip key is exact text from the code on that side: a name, a call or a full line. `name@2` is the second occurrence. `(both)`, `(before)` and `(after)` tell the side.
- Each code hunk is on a slide (`Hunks:`) or in `Omitted:`. Test hunks are in neither.

Check, correct each problem, repeat until it shows none:

```bash
node <SKILL>/scripts/hunks.mjs plan --work <WORK>
```

Then read only the titles and the slide texts in order. They must tell the chain without the code.

## 4. Read (Sonnet agent)

The reader knows nothing but the slides: not this skill, not the PR, not the plan or the chain, not that there were earlier rounds.

1. Run `node <SKILL>/scripts/hunks.mjs reader --work <WORK>`. It writes one numbered file per slide to `<WORK>/reader/slides/` and removes the `reading.md` of an earlier round.
2. Start a new agent in the foreground with `model: "sonnet"`. Its prompt is the full text of `<SKILL>/references/reader.md`, with `<REPO>` replaced by `<WORK>/src/head`, `<SLIDES>` by `<WORK>/reader/slides` and `<NOTES>` by `<WORK>/reader/reading.md`. Add nothing else.
3. For each item in `<WORK>/reader/reading.md`: if the slide does not need it to show what was wrong and how the change corrects it, remove it. Otherwise explain it on the slide where it first occurs, or replace it with a name from the code on that slide. Tips that start with "Open question:" stay. Keep the rules of step 3; if a slide gets too full, continue on the next slide. Run `hunks.mjs plan` until it shows no problems.
4. Repeat with a new reader agent. Stop when `reading.md` has no items, or after two corrections.

## 5. Build (Sonnet agent)

Start a new agent in the foreground with `model: "sonnet"` and this prompt:

> Read `<SKILL>/references/builder.md` and follow it. `<WORK>` is `<path>`, `<SKILL>` is `<skill path>`.

Run `node <SKILL>/scripts/hunks.mjs slides --work <WORK>` and look at some PNGs in `<WORK>/shots`. If the check shows problems, start a new builder with the same prompt, followed by the output of the check without changes. If the builder reports a problem that needs a design change, correct the plan and start a new builder.
