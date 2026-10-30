---
name: pr-presentation
description: Turn a GitHub pull request into an HTML slide deck that helps a developer who does not know the changed code understand what the PR does and why, before they read the diff. The deck is built from the code, not from the PR description: the slides show how the code worked, what was wrong or missing, and how each change corrects it. Suspected bugs and questions the code cannot answer stay as review notes on a closing slide. Use when the user wants a high-level or "zoomed out" view of a PR, a guided tour or presentation of it, or an easier way to read a diff, even if they only share a PR link.
argument-hint: <pr-url> <work-dir>
allowed-tools: Read, Write, Edit, Grep, Glob, Agent, Bash(node *), Bash(git log *), Bash(git blame *), Bash(git show *)
---

## Run

The work has two parts. The investigation (steps 1 to 3) reads the PR and writes `chain.md`: what the change does and why, proven from the code. The deck (steps 4 to 6) turns `chain.md` into slides: a plan, a reader agent that sees nothing but the slides and checks them, and scripts that build the deck from the plan.

The steps pass their results in files under `<WORK>`. `<SKILL>` is the base directory of this skill, printed as "Base directory for this skill" when it is invoked. `$0` is the PR URL. `$1` is `<WORK>`, the folder for all files of the run. If an argument is missing, stop and report it.

**Output.** The only result is the file `<WORK>/deck.html`. Nobody reads your replies and nobody answers questions during the run. When step 6 is done, stop with an empty reply: do not summarize the deck. If a step cannot continue, stop and report why in one sentence.

**Tools.** Read files with Read, and use its offset and limit for a line range. Search with Grep and Glob. Create `chain.md` and `plan.md` with Write, and change them with Edit. Use Bash only for the `node` commands of this skill and for `git log`, `git blame` and `git show`, one plain command per call: no `cd`, pipes, `&&`, `;`, redirects, heredocs, `$(...)` or variables. Other commands are denied.

## Investigation

**Code first.** The code is the best specification of the change. Do not trust what the author says about the PR: the description, the commit messages and the review comments tell what the author thinks the change does, so do not read them. Answer every question from the code in the checkouts under `<WORK>/src`: the diff, the code around it, callers, definitions, types, names. Tests only confirm an answer. Only a question that the code cannot answer sends you further: to the linked and related issues in `context.md`, and to the git history of the touched lines. Run git in the current directory, against the merge base `mergeBaseOid` from `pr.json`, for example `git log -L 40,60:<path> <mergeBaseOid>` or `git blame -L 40,60 <mergeBaseOid> -- <path>`. An answer from there is weaker than one from the code: say in "Looked at" where it comes from, and confirm in the code what you can. What this session already knows about the PR, from the user or from earlier work, does not count.

**Concepts.**

- Hunk: one changed block of the diff, `H01`, `H02` and so on.
- Question: what a hunk or an answer leaves unexplained.
- Answer: one to three sentences, with the file and lines that prove them.
- Unexplained: a question that the code, the issues and the history leave unanswered.
- Suspected bug: a case where the code does something wrong, found while answering a question.
- Review note: a suspected bug or an unexplained question. It marks a place where the implementation must be trusted instead of understood, so it can show a problem in the PR.
- Chain: the facts in the order a new reader needs them: how the code works, what was wrong, how each change corrects it. Each fact follows from the facts before it and refers to the questions that prove it. Each code hunk is part of the chain. A hunk that no fact needs is unexplained.

**Questions.** Start from the hunks. Read each hunk and the code around it, and write each question it raises: why did the old code do this, what goes wrong if it stays, where is this name defined, who calls this and when, which cases reach this line, what did the old condition match and what does the new one match. An answer can raise new questions. Ask them too, even when they lead to unchanged code: the chain needs the code that the change depends on.

**Answers.** Answer each question from the code. Read the lines, then write the answer and where you found it. Do not answer from memory. If the code cannot answer, check the issues and the history of the lines. If they cannot either, do not guess: mark it unexplained. Stop when every question has an answer or is unexplained.

### 1. Collect

```bash
node <SKILL>/scripts/collect.mjs --pr <PR> [--repo <owner/repo>] --out <WORK>
```

GitHub is asked only for the PR metadata and the linked issues. The code comes from the local checkout: the repository of the current directory, when one of its remotes is the PR's repository. For another checkout, pass `--root <path>`. If the current directory is not in a checkout of the PR's repository and no `--root` is given, stop and report it. The script fetches the base branch and the PR head and adds two git worktrees under `<WORK>/src`.

`<WORK>` holds:

- `src/base/`, `src/head/`: the whole repository at the merge base of the PR and at its head. Read and search them freely. Do not change them.
- `context.md`: read only `## Linked issue` and `## Related issue`. The other sections are the PR description, commits and comments.
- `pr.json`, `pr.diff`. Do not read `body` in `pr.json`: it is the PR description.

### 2. Split into hunks

```bash
node <SKILL>/scripts/hunks.mjs split --diff <WORK>/pr.diff --out <WORK>
```

A hunk is what git made: every `@@` header of `pr.diff` starts one, numbered in diff order across all files, `H01`, `H02` and so on. Each hunk gets a kind from its path: `code`, `test`, `screenshot` or `generated`. Only `code` hunks must raise a question. The script writes `hunks.json` and `annotated.md`, the diff with one `## H07 ...` section per hunk, and prints one line per hunk. Read `annotated.md` to see the hunks.

### 3. Investigate

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

### Q3 (from H02): How does `__attachSelectedItem` make the copy?
- Looked at: src/head/packages/select/src/vaadin-select-base-mixin.js L475-489, L517-526
- Answer: an item with a `label` attribute gets a new item with that text. Any other item is copied with `cloneNode(true)`, and `__appendValueItemElement` removes `selected`, `aria-selected`, `tabindex` and the focus states from the copy.
- Suspected bug: a cloned item keeps its `id`. When the application sets an `id` on an item, the page has two elements with that `id`.
- New questions: none

### Q4 (from H03): Why does the change remove `aria-selected` from the copy, and not stop `_selectedChanged` from writing it?
- Looked at: src/base/packages/item/src/vaadin-item-mixin.js L104-106, the linked issue in context.md, the history of src/base/packages/select/src/vaadin-select-base-mixin.js L517-526
- Unexplained: both places would fix the bug. The issue and the history do not tell why the change picks the copy.
- New questions: none

## Chain

1. The field shows a copy of the selected item, and only this copy gets `selected`, so the Lumo rule can find the placeholder item. (Q1, Q3)
2. Setting `selected` makes the observer `_selectedChanged` write `aria-selected` on the copy. (Q2)
````

- Each question names the hunk or the question that raised it.
- Keep only the facts the reader needs to follow what was wrong and how the change corrects it. If the change removes an attribute that must not be there, the chain needs the code that adds and removes it, not the reason the attribute is wrong in the accessibility standard.
- Review notes are lines in the entry of their question:
  - `- Unexplained: <what nothing answers>`: the code, the issues and the history give no answer, for example no reason for a change, a value or a check. A question without an answer must have this line. It can also follow an answer that tells what the code does but not why.
  - `- Suspected bug: <case>`: the code does something wrong in a case you found by reading it. Name the case. It is a finding from reading, not from running the code.
- Q1 and Q2 have no review line: they are answered, and nothing in the answers looks wrong.

Check, correct each problem, repeat until it shows none:

```bash
node <SKILL>/scripts/hunks.mjs chain --work <WORK>
```

Write the whole chain before you plan any slide.

## Deck

The deck tells the chain of `chain.md`: one or more facts per slide, with the code that proves them. It uses only facts from the chain. The deck can show any file from `src/base` and `src/head`.

**Concepts.**

- New thing: a name or concept that no earlier slide explained, also a term from outside the code.
- Review note tip: a tip that shows a review note of `chain.md` on the code it is about.

### 4. Present

Turn `chain.md` into `<WORK>/plan.md`: the slides, their order, the code on each slide and each tip. Step 6 builds the deck from the plan with a script, so the plan holds every decision. Do not write `slides.json` by hand.

Before you put code on a slide, open the files from "Looked at" again, choose the exact lines, and take each tip key from their text. Do not trust line numbers from the chain or from memory.

#### The reader

The reader reads the deck alone, in a browser, before the diff. Read `<SKILL>/references/reader.md` before you plan, and the files that its section "The reader" tells the reader to read. That section lists what the reader knows and what the deck must explain: a name from "Knows without explanation" is not a new thing and needs no tip, a name from "Does not know" gets a tip where it first appears. Every word the reader sees is yours: the summary, the titles, the slide sentences and the tips.

#### Slides

- Put the slides in the order of the chain. Each slide shows one or more facts and the lines from "Looked at" of their questions.
- Show only what the chain needs. If a slide needs a new fact, add its question and answer to `chain.md` first.
- Code outside the change (a file in "Looked at" that the diff does not touch) gets a slide of its own only if the chain needs it before the first change, and only the lines the chain uses.
- Show each review note in a tip on the code it is about, starting with its kind and its questions: `Suspected bug (Q3): ...`, `Unexplained (Q4): ...`. It is for the author, not part of the explanation, and it is not a new thing. The page marks these tips and lists every review note of `chain.md` on a closing slide, also the ones without code on a slide.
- Do not show tests, snapshots or screenshots.

Kinds of slides:

- **Background**: unchanged code the chain needs before the first change. All its code is context.
- **Bug**: only for a change that fixes wrong behavior. The case that goes wrong as a step list, in the order it runs: what the user or the application does, then what the old code does, until the wrong result. Each step has one sentence and the one to three lines of old code that do it. The slide sentence names the case and the wrong result. Example with three steps: 1. The user selects an item, and `__appendValueItemElement` removes `aria-selected` from its copy. 2. Then `__attachSelectedItem` sets `labelItem.selected = true`. 3. The observer `_selectedChanged` writes `aria-selected` again, so the copy in the field is read as a selected option.
  A change that replaces how the code works, without a case that goes wrong, has no bug slide: change slides show the old way on the left and the new way on the right.
- **Fix**: right after the bug slide. Only the changed lines, old on the left and new on the right. Its sentence tells how the change removes the cause.
- **Change**: any other change, old on the left and new on the right.

#### Rules

One slide, one screen, one idea:

- A slide fits one screen. If not, make the code smaller or continue on the next slide.
- A slide has a maximum of 4 new things. Explain each on the slide where it first occurs, and do not use it before that slide.
- Each slide text is clear on its own. Do not refer to other slides by number, or with "continuing" or "as shown before".

Code:

- Real lines from the PR, with their indentation. Do not change or join lines. To shorten, skip lines only.
- Start each block with its enclosing line: the method signature, the class line, the CSS selector.
- Show an unchanged line only if it opens a shown block, or the text or a tip mentions it. A one-line change gets a few lines, not a full method.
- Do not show comments. The build leaves comment lines out of every range.
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

#### The plan

Write `<WORK>/plan.md` in this format. Refer to code by file and lines. Do not copy code: the build reads the lines from the files.

````markdown
Summary: a maximum of three short sentences for the title slide.
Omitted: none                                    <- or code hunks that are on no slide, each with its reason

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

## 3. <title of a fix slide>
Hunks: H01, H02
Text: how the change removes the cause.
Introduces: ...
Labels: Old / New                                <- only if not "Before / After"
Before:
- src/base/<path> L475-492, skip L476-487
After:
- src/head/<path> L475-489, skip L476-480
Tips:
- `itemElement.removeAttribute('selected');` (after): what this line does against the bug.
- `selected.cloneNode(true)` (after): Suspected bug (Q3): the copy keeps the item's `id`, so two elements share it.
````

- A code reference is `src/base/...` (old code) or `src/head/...` (new code), with lines and optional skips. A skipped range shows as one `...` line. Add `(context)` for unchanged code, `(caption: "...")` for a heading.
- A tip key is exact text from the code on that side: a name, a call or a full line. `name@2` is the second occurrence. `(both)`, `(before)` and `(after)` tell the side.
- Each code hunk is on a slide (`Hunks:`) or in `Omitted:` with a reason in parentheses. Test hunks are in neither.

Check, correct each problem, repeat until it shows none:

```bash
node <SKILL>/scripts/hunks.mjs plan --work <WORK>
```

Then read only the titles and the slide texts in order. They must tell the chain without the code.

### 5. Read (Sonnet agent)

The reader knows nothing but the slides: not this skill, not the PR, not the plan or the chain, not that there were earlier rounds.

1. Run `node <SKILL>/scripts/hunks.mjs reader --work <WORK>`. It writes one numbered file per slide to `<WORK>/reader/slides/` and moves the `reading.md` of an earlier round to `reading-1.md`, `reading-2.md` and so on.
2. Start a new agent in the foreground (`run_in_background: false`) with `model: "sonnet"`, and wait for its reply. Its prompt is the full text of `<SKILL>/references/reader.md`, with `<REPO>` replaced by `<WORK>/src/head`, `<SLIDES>` by `<WORK>/reader/slides` and `<NOTES>` by `<WORK>/reader/reading.md`. Add nothing else.
3. For each item in `<WORK>/reader/reading.md`: if the slide does not need it to show what was wrong and how the change corrects it, remove it. Otherwise explain it on the slide where it first occurs, or replace it with a name from the code on that slide. Review note tips stay. Keep the rules of step 4; if a slide gets too full, continue on the next slide. Run `hunks.mjs plan` until it shows no problems.
4. Repeat with a new reader agent: do not continue the old one with `SendMessage`. Stop when `reading.md` has no items, or after two corrections.

### 6. Build

Run each line as its own Bash call:

```bash
node <SKILL>/scripts/hunks.mjs build --work <WORK>
node <SKILL>/scripts/build.mjs --pr <WORK>/pr.json --slides <WORK>/slides.json --src <WORK>/src --out <WORK>/deck.html
node <SKILL>/scripts/hunks.mjs slides --work <WORK>
node <SKILL>/scripts/check.mjs <WORK>/deck.html <WORK>/shots
```

`hunks.mjs build` writes `slides.json` from `plan.md` and `chain.md`. `hunks.mjs slides` shows which changed lines are on no slide. `check.mjs` saves one PNG per slide to `<WORK>/shots` and shows the slides that overflow.

Correct each problem in `plan.md` or `chain.md`, never in `slides.json`, and build again: a tip key that is not found, a NOT SHOWN hunk, a slide that overflows. Then look at the PNGs of the title slide, the first slide, each slide that overflows and the closing slide.
