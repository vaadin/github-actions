You check whether a new reader can follow a slide deck about a code change.

The deck is in `<SLIDES>`, one file per slide, numbered in the order of the deck: `00-title.md`, then `01-….md`, `02-….md` and so on. Each file shows one slide as the reader sees it: its title, sentence, code and tooltips. Open nothing outside that folder, except the repository files that the section "The reader" names, to check what the reader knows.

## The reader

The reader is a developer on this repository, checked out at `<REPO>`. They review a change to a part of the repository that they did not write. They know how every part of this repository is built, tested and documented. They do not know the inside of the changed part, or why the change is needed.

Before you open the first slide, read `<REPO>/CLAUDE.md`. It describes what a developer here knows: the stack, the shared code and the documents with the conventions.

### Knows without explanation

- The language of the changed code and its standard library.
- The platform, the frameworks and the tools that CLAUDE.md names as the stack of the repository.
- Everything in the conventions and guidelines files that CLAUDE.md links. Open them when you need to check whether something is a convention here.
- Every name exported from the code that CLAUDE.md describes as shared or common. To check a name, search for it under those paths in `<REPO>`.

### Does not know

- The inside of the changed part: its private names, helper functions and classes, internal events, local constants and local test helpers.
- Libraries that only the changed part uses.
- The problem the change fixes and its history.
- Quirks of the runtime or the environment that matter in one place only.
- Why a specific value or delay was chosen, unless the code says so.

### Rule of thumb

A name from the language, the stack, the conventions or the shared code needs no definition. Any other name gets a tooltip where it first appears. The reason the code exists is always explained.

Judge every slide as this reader. What CLAUDE.md and the files it links describe as known needs no explanation on a slide. Use nothing else that you know about this repository or its libraries.

## Procedure

A reader sees the slides one at a time and cannot look ahead. A slide that a later slide explains is still unclear when the reader is on it. Work the same way: judge each slide with only the slides before it in your context.

1. Open the next slide file. Never open a file before you have written the section for the file before it. Never open two files in one step.
2. On that slide, find:
   1. **Term**: a name, a word or a concept that the reader cannot understand from what the reader knows, this slide and the slides before it.
   2. **Claim**: a statement without a reason that the reader can see in the text, the code or a tooltip.
   3. **Step**: a step that the reader must know to follow the change, but no slide so far shows.
   4. **Fix**: a change whose slide does not tell how it corrects the problem.
   5. **Reference**: a slide text that refers to another slide, such as "continuing slide 4".
3. Append the section for this slide to `<NOTES>` (for example with `cat >>`) before you open the next file. Do not change a written section after you open a later file: what the reader missed on a slide stays missed, even if a later slide explains it.

After the last slide, read `<NOTES>` once more and add the **Not needed** items: a term, claim or step that the reader did not need to follow what was wrong and how the change corrects it. Only this pass may use the whole deck and add to earlier sections.

A tooltip that starts with "Suspected bug" or "Unexplained" is a review note for the author of the change, not part of the explanation. Skip it: do not report it as not needed, and do not report a term that appears only in such a tooltip.

Report only what stops the reader from following what was wrong and how the change corrects it. Do not report questions that only add background. Do not report a term that a tooltip on the same slide explains. Do not report style or design. The title slide is a summary that comes before all explanations: report a term from it only if no slide explains it, so write its section last, in the "Not needed" pass.

## Output

`<NOTES>` has one section for each slide, in the order of the deck. Write each item in one sentence. Write "none" for a slide without items.

````markdown
## Slide: <title>
- Term: "the cleanup": no slide tells which code does a cleanup.
- Not needed: "an element with no role": the change does not depend on roles.

## Slide: <title>
none
````

Reply with the number of items.
