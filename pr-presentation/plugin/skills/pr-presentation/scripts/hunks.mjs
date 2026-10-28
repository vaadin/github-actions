#!/usr/bin/env node
// Number the hunks of a PR diff, check the chain and the plan, and build the slides from the plan.
//
// Usage:
//   hunks.mjs split    --diff pr.diff --out <WORK>
//       Writes <WORK>/hunks.json and <WORK>/annotated.md: one "## H07" section per hunk with its diff.
//   hunks.mjs chain    --work <WORK>
//       Checks <WORK>/chain.md: every code hunk raises a question, every question has an answer from the code or
//       is open, every open question has a kind, and every link of the chain refers to the questions that prove it.
//   hunks.mjs plan     --work <WORK>
//       Checks <WORK>/plan.md: every code hunk ID under "Hunks:" or "Omitted:" with a reason (tests
//       are not shown), tips of at most 20 words whose keys are in the code of their side, open-question tips that
//       name an open question of chain.md with the same kind, at most 4 new things per slide, each name in
//       Introduces in the slide's code, line ranges that start at real code, and each slide estimated to fit one screen.
//   hunks.mjs reader   --work <WORK>
//       Writes <WORK>/reader/slides/: the deck as the reader sees it (title slide, titles, sentences, code, tips), from plan.md, without the notes, one numbered file per slide. The reader check of the skill
//       sees only this folder, one file at a time. Removes a <WORK>/reader/reading.md left by an earlier reader.
//       Also writes <WORK>/reader.md, the whole deck, for the orchestrator.
//   hunks.mjs build    --work <WORK>
//       Writes <WORK>/slides.json from plan.md and chain.md, the input of build.mjs: the code of each line range as
//       the deck shows it (no comment lines, one "..." per skipped range, the common indentation of each file
//       removed), the tips, and the open questions with the slide that holds their tip.
//       See references/slides-json.md.
//   hunks.mjs slides   --work <WORK>
//       Checks which changed lines of each hunk appear in the code of <WORK>/slides.json.
//       A code hunk with none of its lines on a slide fails, unless slides.json lists it in "omitted".
//
// Lines without a name in them (braces, blank lines), imports and comments are not checked: the slides
// leave them out on purpose. Test files, screenshots and generated files are listed but not required.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const TEST_RE = /(^|\/)(src\/test\/|test\/|tests\/|__tests__\/|integration-tests\/|test-fixtures?\/)|(Test|IT)\.java$|\.(test|spec)\.[jt]sx?$/;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
const GENERATED_RE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.snap)$/;
const COMMENT_RE = /^(\/\/|\/\*|\*|<!--|#\s)/;
const GAP_RE = /(?<![\w$.])(?:\.\.\.|…)(?![\w$.])/;

// The kinds of an open question, as chain.md lists them and as a tip starts
const OPEN_KINDS = ['Suspected bug', 'Unexplained', 'Unused'];
const KINDS_RE = OPEN_KINDS.join('|');
// "- Unused (Q6, Q15): text" under "## Open questions" of chain.md
const OPEN_ITEM_RE = new RegExp(`^- (${KINDS_RE}) \\((Q\\d+(?:,\\s*Q\\d+)*)\\):\\s*(.+)$`);
// The tip of an open question starts with its kind and questions: "Unused (Q6): text"
const OPEN_TIP_RE = new RegExp(`^(${KINDS_RE}) \\((Q\\d+(?:,\\s*Q\\d+)*)\\):`);
// "- `key` (after): text" under "Tips:" of a slide; the key may be wrapped in double backticks
const TIP_RE = /^- (``?)(.+?)\1 \((before|after|both)\): (.+)$/gm;
// "- src/head/<path> L12-20, skip L14-16 (context)" under Before:, After: or a step
const REF_RE = /^\s*- (src\/(?:base|head)\/\S+) L(\d+)(?:-(\d+))?((?:, skip L\d+-\d+)*)(.*)$/gm;

const splitlines = (text) => { const a = text.split(/\r?\n/); if (a.length && a.at(-1) === '') a.pop(); return a; };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
const isFile = (p) => existsSync(p) && statSync(p).isFile();
// Text with \n line ends only, like Python's universal newlines
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const words = (s) => (s.trim() ? s.trim().split(/\s+/) : []);
const repoPath = (p) => p.replace(/^src\/(?:base|head)\//, '');
// Python's repr of a string, for messages that quote code
const repr = (s) => (s.includes("'") && !s.includes('"') ? `"${s.replace(/\\/g, '\\\\')}"` : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
const indentOf = (l) => l.match(/^\s*/)[0].length;
const minIndent = (lines) => Math.min(Infinity, ...lines.filter((l) => l.trim()).map(indentOf));
const stripIndent = (lines, n) => (Number.isFinite(n) ? lines.map((l) => (l.trim() ? l.slice(Math.min(n, indentOf(l))) : '')) : lines);
const dedent = (lines) => stripIndent(lines, minIndent(lines));
// Prose for the page: the page escapes HTML, so <kbd>Home</kbd> from the chain becomes Home
const plain = (s) => s.replace(/<\/?kbd>/g, '');

// How often key appears in code as a whole name, the same rule the page uses for tooltips.
function countWhole(code, key) {
  const start = /[\w$]/.test(key[0]) ? '(?<![\\w$])' : '';
  const end = /[\w$]/.test(key.at(-1)) ? '(?![\\w$])' : '';
  return (code.match(new RegExp(start + escapeRe(key) + end, 'g')) || []).length;
}

function kindOf(path) {
  if (IMAGE_RE.test(path)) return 'screenshot';
  if (GENERATED_RE.test(path)) return 'generated';
  if (TEST_RE.test(path)) return 'test';
  return 'code';
}

// Hunks in diff order; a binary file is one hunk without lines.
function split(diffText) {
  const hunks = [];
  let path = null;
  let cur = null;
  const newHunk = (header) => {
    const h = { id: `H${String(hunks.length + 1).padStart(2, '0')}`, path, kind: kindOf(path || ''), header, add: [], del: [], lines: [] };
    hunks.push(h);
    return h;
  };
  for (const line of splitlines(diffText)) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      path = m ? m[2] : words(line).at(-1);
      cur = null;
    } else if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) {
      path = line.slice(4).replace(/^b\//, '');
    } else if (line.startsWith('Binary files ')) {
      cur = newHunk('binary');
    } else if (line.startsWith('@@')) {
      cur = newHunk(line);
    } else if (cur !== null && cur.header !== 'binary') {
      cur.lines.push(line);
      if (line.startsWith('+')) cur.add.push(line.slice(1));
      else if (line.startsWith('-')) cur.del.push(line.slice(1));
    }
  }
  return hunks;
}

// The diff as Markdown, one section per hunk.
function annotatedMd(hunks) {
  const out = [];
  let path = null;
  for (const h of hunks) {
    if (h.path !== path) {
      path = h.path;
      out.push(`# ${path}`, '');
    }
    out.push(`## ${h.id} ${h.kind} +${h.add.length} -${h.del.length}`, '');
    if (h.header === 'binary') out.push('(binary file)');
    else out.push('```diff', h.header, ...h.lines, '```');
    out.push('');
  }
  return out.join('\n');
}

function checked(line) {
  const s = line.trim();
  return /[\w$]{2,}/.test(s) && !COMMENT_RE.test(s) && !/^(import|package)\b/.test(s);
}

const squash = (s) => s.replace(/\s+/g, '');

// All code lines on one side of every slide.
function paneLines(slides, side) {
  const out = [];
  for (const sl of slides.slides || []) {
    const v = sl[side];
    const list = v == null || v === '' ? [] : Array.isArray(v) ? v : [v];
    for (const c of list) {
      const code = typeof c === 'string' ? c : c.code || '';
      out.push(...code.split('\n'));
    }
  }
  return out;
}

// A diff line is shown when it is in the pane code, ignoring whitespace (so a long line split in two still
// counts), or when a slide line with '...' gaps matches it.
function shownIn(line, lines, joined) {
  const s = squash(line);
  // Short lines would match inside any longer code, so they must match a whole slide line
  if (s.length >= 25 ? joined.includes(s) : lines.some((l) => squash(l) === s)) return true;
  for (const l of lines) {
    if (GAP_RE.test(l)) {
      const pieces = l.split(GAP_RE).map((p) => escapeRe(squash(p)));
      if (pieces.length > 1 && new RegExp('^' + pieces.join('.*?') + '$').test(s)) return true;
    }
  }
  return false;
}

function cmdSplit(args) {
  const hunks = split(read(args.diff));
  writeFileSync(join(args.out, 'hunks.json'), JSON.stringify(hunks, null, 1));
  writeFileSync(join(args.out, 'annotated.md'), annotatedMd(hunks));
  for (const h of hunks) console.log(`${h.id}  ${h.kind.padEnd(10)} +${h.add.length} -${h.del.length}  ${h.path}`);
}

function cmdSlides(args) {
  const work = args.work;
  const hunks = JSON.parse(read(join(work, 'hunks.json')));
  const slides = JSON.parse(read(join(work, 'slides.json')));
  const omitted = slides.omitted || {};
  const sides = {};
  for (const [side, key] of [['before', 'del'], ['after', 'add']]) {
    const lines = paneLines(slides, side);
    // Step code is old code
    if (side === 'before') for (const sl of slides.slides || []) for (const st of sl.steps || []) lines.push(...(st.code || '').split('\n'));
    sides[key] = [lines, squash(lines.join(''))];
  }
  const failed = [];
  const partial = [];
  let total = 0;
  let shownTotal = 0;
  for (const h of hunks) {
    if (h.kind !== 'code') continue;
    const rows = [];
    for (const [sign, key] of [['-', 'del'], ['+', 'add']]) for (const l of h[key]) if (checked(l)) rows.push([sign, l]);
    if (!rows.length) continue;
    const missing = rows.filter(([sign, l]) => !shownIn(l, ...sides[sign === '-' ? 'del' : 'add']));
    total += rows.length;
    shownTotal += rows.length - missing.length;
    if (h.id in omitted) continue;
    if (missing.length === rows.length) failed.push([h, missing, rows.length]);
    else if (missing.length) partial.push([h, missing, rows.length]);
  }
  for (const [label, items] of [['NOT SHOWN', failed], ['PARTLY SHOWN', partial]]) {
    for (const [h, missing, n] of items) {
      console.log(`${label} ${h.id} ${h.path}  ${n - missing.length}/${n} lines shown`);
      for (const [sign, l] of missing.slice(0, 8)) console.log(`    ${sign} ${l.trim().slice(0, 110)}`);
      if (missing.length > 8) console.log(`    ... ${missing.length - 8} more`);
    }
  }
  for (const [hid, why] of Object.entries(omitted)) console.log(`OMITTED ${hid}: ${why}`);
  const others = hunks.filter((h) => h.kind !== 'code');
  if (others.length) console.log('Not required: ' + others.map((h) => `${h.id} (${h.kind})`).join(', '));
  console.log(`${shownTotal}/${total} checked lines of code hunks are on the slides; ${failed.length} hunk(s) not shown, ${partial.length} partly shown`);
  process.exit(failed.length ? 1 : 0);
}

const TIP_WORDS = 20;
const MAX_NEW = 4;
// Height of one screen in the page's pixels, and the parts of a slide, measured on built decks
const SCREEN = 790;
const HEAD = 88, TEXT_LINE = 30, TEXT_CHARS = 120;
const LINE = 24, BLANK = 12, PANE = 40, CHUNK = 16;
const CTX_LINE = 20, CTX_PANE = 36, CTX_CHUNK = 12;
const FILE = 20;
const STEP_LINE = 24, STEP_TEXT = 28, STEP_PANE = 44, STEP_ARROW = 24;
const COMMENT_START_RE = /^\s*(\/\/|\/\*|\*|<!--|#\s|})/;

// The lines as the deck shows them: no comment lines, no run of blank lines, no blank line at the ends.
function shownLines(lines) {
  const out = [];
  for (const l of lines) {
    if (COMMENT_RE.test(l.trim())) continue;
    if (!l.trim() && (!out.length || !out.at(-1).trim())) continue;
    out.push(l);
  }
  while (out.length && !out.at(-1).trim()) out.pop();
  return out;
}

// The code references of one block of a slide: {path, file, from, to, lines, shown, ctx, caption, where}.
// `lines` is the range with one "..." per skipped range, indented like the first skipped line that is not
// blank; `shown` is what the deck shows (see shownLines); both are null when the file is missing.
function planRefs(work, block) {
  const refs = [];
  for (const m of block.matchAll(REF_RE)) {
    const path = m[1];
    const a = Number(m[2]);
    const b = Number(m[3] || a);
    const tail = m[5];
    const ref = {
      path, file: repoPath(path), from: a, to: b, lines: null, shown: null,
      ctx: tail.includes('(context)'),
      caption: (/\(caption:\s*"([^"]*)"\)/.exec(tail) || [])[1],
      where: ((/\(in:\s*([^)]*)\)/.exec(tail) || [])[1] || '').trim(),
    };
    refs.push(ref);
    const f = join(work, path);
    if (!isFile(f)) continue;
    const src = read(f).split('\n');
    const skips = [...m[4].matchAll(/skip L(\d+)-(\d+)/g)].map((x) => [Number(x[1]), Number(x[2])]);
    const lines = [];
    let n = a;
    while (n <= b) {
      const skip = skips.find((s) => s[0] === n);
      if (skip) {
        const first = src.slice(skip[0] - 1, skip[1]).find((l) => l && l.trim()) || '';
        lines.push(' '.repeat(indentOf(first)) + '...');
        n = skip[1] + 1;
      } else {
        lines.push(n - 1 < src.length ? src[n - 1] : '');
        n += 1;
      }
    }
    ref.lines = lines;
    ref.shown = shownLines(lines);
  }
  return refs;
}

const textHeight = (text) => HEAD + TEXT_LINE * Math.max(1, Math.ceil(text.length / TEXT_CHARS));

// Estimated height of a slide: heading and text, then the changed code row, then the context row.
function slideHeight(text, sides) {
  const code = (refs, line, pane, chunk) => {
    if (!refs.length) return 0;
    const lines = refs.flatMap((r) => r.shown || []);
    return lines.reduce((s, l) => s + (l.trim() ? line : BLANK), 0) + pane + chunk * refs.length;
  };
  // Each chunk names its file; the page shows all context in one pane below, the same code once
  const main = sides.map((refs) => code(refs.filter((r) => !r.ctx), LINE, PANE, CHUNK + FILE));
  const ctxRefs = [];
  const seen = new Set();
  for (const r of sides.flat()) {
    const key = r.file + '\0' + (r.shown || []).join('\n');
    if (r.ctx && !seen.has(key)) {
      seen.add(key);
      ctxRefs.push(r);
    }
  }
  const ctx = code(ctxRefs, CTX_LINE, CTX_PANE, CTX_CHUNK + FILE);
  return textHeight(text) + Math.max(...main) + (ctx ? 16 + ctx : 0);
}

const planSlides = (text) => text.split(/^(?=## )/m).filter((s) => s.startsWith('## '));
// The part of plan.md before the first slide: Summary, Omitted
const planHead = (text) => text.split(/^(?=## )/m)[0];
// The value of a "Name: value" line in a block of the plan
const planLine = (block, name) => (block.match(new RegExp(`^${name}:(.*)$`, 'm')) || ['', ''])[1].trim();
const slideTitle = (slide) => slide.split('\n')[0].replace(/^## \d+\.\s*/, '').trim();
// The names under Introduces, without backticks and without "none"
const introduced = (slide) => [...slide.matchAll(/^Introduces:(.*)$/gm)].flatMap((m) => m[1].split(','))
  .map((i) => i.trim().replace(/^`+|`+$/g, '')).filter((i) => i && i.toLowerCase() !== 'none');
// The tips of a slide: {key, side, text}
const slideTips = (slide) => [...slide.matchAll(TIP_RE)].map((m) => ({ key: m[2].trim(), side: m[3], text: m[4].trim() }));

// "Omitted: H01, H08 (the reason), H04 (another reason)" -> {H01: reason, H08: reason, H04: another reason}.
// A hunk with no reason after it, before the next hunk, gets "".
function parseOmitted(line) {
  const out = {};
  if (!line || /^none$/i.test(line.trim())) return out;
  const ids = [...line.matchAll(/\bH\d{2,}\b/g)];
  let pending = [];
  ids.forEach((m, i) => {
    pending.push(m[0]);
    const next = ids[i + 1];
    const between = line.slice(m.index + m[0].length, next ? next.index : undefined);
    const reason = between.trim().replace(/^[,;:\s]+|[,;:\s]+$/g, '').replace(/^\(([\s\S]*)\)$/, '$1').trim();
    if (reason) {
      for (const id of pending) out[id] = reason;
      pending = [];
    }
  });
  for (const id of pending) out[id] = '';
  return out;
}

// The code references of the Before and After side of one slide in plan.md.
function slideSides(work, slide) {
  return ['Before', 'After'].map((side) => {
    const m = new RegExp(`^${side}:\\n((?:- .*\\n?)*)`, 'm').exec(slide);
    return m ? planRefs(work, m[1]) : [];
  });
}

// The steps of a step-list slide in plan.md: {text, refs} for each numbered step.
function slideSteps(work, slide) {
  const m = /^Steps:\n((?:(?:\d+\. |\s+- ).*\n?)*)/m.exec(slide);
  if (!m) return [];
  const steps = [];
  for (const line of m[1].split(/(?<=\n)/)) {
    const num = /^\d+\. (.*)$/.exec(line.replace(/\n$/, ''));
    if (num) steps.push({ text: num[1].trim(), block: '' });
    else if (steps.length) steps.at(-1).block += line;
  }
  return steps.map((st) => ({ text: st.text, refs: planRefs(work, st.block) }));
}

// Estimated height of a step list: heading and text, then each step with its sentence, code and arrow.
function stepsHeight(text, steps) {
  let h = textHeight(text);
  steps.forEach((st, i) => {
    const lines = st.refs.flatMap((r) => r.shown || []);
    h += STEP_TEXT * Math.max(1, Math.ceil(st.text.length / 100)) + STEP_PANE + lines.reduce((s, l) => s + (l.trim() ? STEP_LINE : BLANK), 0);
    h += i ? STEP_ARROW : 0;
  });
  return h;
}

// The "## Name" sections of chain.md
function chainSections(text) {
  const sections = {};
  for (const m of text.matchAll(/^## (.+?)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)) sections[m[1]] = m[2];
  return sections;
}

// The open questions of chain.md: items {kind, questions: ["Q11"], text}, and the lines that are not in the format.
// An indented line continues the item before it.
function openQuestions(text) {
  const items = [];
  const bad = [];
  for (const line of (chainSections(text)['Open questions'] || '').split('\n')) {
    const s = line.trim();
    if (!s || /^none$/i.test(s)) continue;
    if (/^\s/.test(line) && items.length && !s.startsWith('- ')) {
      items.at(-1).text += ' ' + s;
      continue;
    }
    const m = OPEN_ITEM_RE.exec(s);
    if (m) items.push({ kind: m[1], questions: m[2].split(/,\s*/), text: m[3].trim() });
    else bad.push(s);
  }
  return { items, bad };
}

// What the planner must keep: every hunk placed, tip length and keys, new things per slide.
function cmdPlan(args) {
  const work = args.work;
  const hunks = JSON.parse(read(join(work, 'hunks.json')));
  const text = read(join(work, 'plan.md'));
  const chainFile = join(work, 'chain.md');
  const open = isFile(chainFile) ? openQuestions(read(chainFile)).items : null;
  let problems = 0;
  const head = planHead(text);
  const placed = new Set();
  for (const m of text.matchAll(/^(?:Hunks|Omitted):(.*)$/gm)) for (const i of m[1].match(/\bH\d{2,}\b/g) || []) placed.add(i);
  for (const h of hunks) {
    if (h.kind === 'code' && !placed.has(h.id)) {
      console.log(`MISSING ${h.id} ${h.kind} ${h.path} ${h.header}`);
      problems += 1;
    }
  }
  for (const [id, reason] of Object.entries(parseOmitted(planLine(head, 'Omitted')))) {
    if (!reason) {
      console.log(`OMITTED WITHOUT REASON ${id}: write 'Omitted: ${id} (why it is on no slide)'`);
      problems += 1;
    }
  }
  for (const slide of planSlides(text)) {
    const title = slideTitle(slide);
    const items = introduced(slide);
    if (items.length > MAX_NEW) {
      console.log(`TOO MANY NEW THINGS ${items.length}: ${title}`);
      problems += 1;
    }
    // The slide must fit one screen, its line ranges must start at real code, and its names must be in its code
    let sides = slideSides(work, slide);
    const steps = slideSteps(work, slide);
    const textLine = planLine(slide, 'Text');
    const height = steps.length ? stepsHeight(textLine, steps) : slideHeight(textLine, sides);
    if (steps.length) sides = [steps.flatMap((st) => st.refs), []];
    if (height > SCREEN) {
      console.log(`TOO HIGH about ${height}px of ${SCREEN}px: ${title} (skip lines, or continue on the next slide)`);
      problems += 1;
    }
    for (const r of sides.flat()) {
      if (r.lines === null) {
        console.log(`NO FILE ${r.path}: ${title}`);
        problems += 1;
      } else if (r.lines.length && (!r.lines[0].trim() || COMMENT_START_RE.test(r.lines[0]))) {
        console.log(`BAD RANGE ${r.path} starts with ${repr(r.lines[0].trim().slice(0, 40))}: ${title} (start at the enclosing line)`);
        problems += 1;
      }
    }
    const code = { before: sides[0].flatMap((r) => r.shown || []).join('\n'), after: sides[1].flatMap((r) => r.shown || []).join('\n') };
    for (const name of items) {
      if (!name.startsWith('idea:') && !countWhole(code.before + '\n' + code.after, name)) {
        console.log(`NOT IN CODE \`${name}\` in Introduces: ${title} (use idea: for a concept)`);
        problems += 1;
      }
    }
    for (const t of slideTips(slide)) {
      const n = words(t.text).length;
      if (n > TIP_WORDS) {
        console.log(`LONG TIP ${n} words: ${t.key.slice(0, 80)}`);
        problems += 1;
      }
      const m = /@(\d+)$/.exec(t.key);
      const [key, nth] = m ? [t.key.slice(0, m.index), Number(m[1])] : [t.key, 1];
      const on = t.side === 'both' ? ['before', 'after'] : [t.side];
      if (key && Math.max(...on.map((s) => countWhole(code[s], key))) < nth) {
        console.log(`TIP KEY NOT IN CODE \`${t.key}\` (${t.side}): ${title} (exact text of a name, a call or a line on that side)`);
        problems += 1;
      }
      const o = OPEN_TIP_RE.exec(t.text);
      if (o && open) {
        for (const q of o[2].split(/,\s*/)) {
          const item = open.find((it) => it.questions.includes(q));
          if (!item) {
            console.log(`OPEN TIP ${q} is not in 'Open questions' of chain.md: ${title}`);
            problems += 1;
          } else if (item.kind !== o[1]) {
            console.log(`OPEN TIP ${q} is '${o[1]}' here but '${item.kind}' in chain.md: ${title}`);
            problems += 1;
          }
        }
      }
    }
  }
  console.log(`${problems} problem(s): every code hunk on a slide or omitted with a reason, tips at most ${TIP_WORDS} words ` +
    `with keys in the code, open-question tips from chain.md, at most ${MAX_NEW} new things per slide, names in Introduces in the code, each slide fits one screen`);
  process.exit(problems ? 1 : 0);
}

// Write <WORK>/reader/, one file per slide, and <WORK>/reader.md: the deck as the reader sees it, without the planner's notes.
function cmdReader(args) {
  const work = args.work;
  const text = read(join(work, 'plan.md'));
  const head = planHead(text);
  const summary = planLine(head, 'Summary');
  const folder = join(work, 'reader', 'slides');
  mkdirSync(folder, { recursive: true });
  for (const old of readdirSync(folder)) if (old.endsWith('.md')) rmSync(join(folder, old));
  rmSync(join(work, 'reader', 'reading.md'), { force: true });
  const files = [['00-title.md', ['# Title slide', '', summary, '']]];
  planSlides(text).forEach((slide, idx) => {
    const n = idx + 1;
    const title = slideTitle(slide);
    const out = [`# Slide ${n}: ${title}`, ''];
    out.push(...[...slide.matchAll(/^Text:(.*)$/gm)].map((m) => m[1].trim()), '');
    slideSteps(work, slide).forEach((st, i) => {
      out.push(`Step ${i + 1}: ${st.text}`, '```', ...st.refs.flatMap((r) => r.shown || []), '```', '');
    });
    const sides = slideSides(work, slide);
    for (const [side, refs] of [['Before (old code)', sides[0]], ['After (new code)', sides[1]]]) {
      for (const r of refs) {
        if (!r.shown || !r.shown.length) continue;
        const label = r.ctx ? `${side}, context (unchanged code)` : side;
        out.push(`${label}, ${r.file}:`, '```', ...r.shown, '```', '');
      }
    }
    const tips = slideTips(slide);
    if (tips.length) {
      out.push('Tooltips (the reader sees each one on the code it names):');
      out.push(...tips.map((t) => `- on \`${t.key}\`: ${t.text}`));
      out.push('');
    }
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    files.push([`${String(n).padStart(2, '0')}-${slug}.md`, out]);
  });
  for (const [name, out] of files) writeFileSync(join(folder, name), out.join('\n'));
  writeFileSync(join(work, 'reader.md'), files.flatMap(([, out]) => out).join('\n'));
  console.log(`Wrote ${files.length} slide files to ${folder} and the whole deck to ${join(work, 'reader.md')}`);
}

// The chunks of one side of a slide, in plan order, with the common indentation of each file removed.
function sideChunks(refs) {
  const indent = {};
  for (const r of refs) indent[r.file] = Math.min(indent[r.file] ?? Infinity, minIndent(r.shown || []));
  return refs.map((r) => {
    const c = { code: stripIndent(r.shown || [], indent[r.file]).join('\n'), file: r.file };
    if (r.caption) c.caption = r.caption;
    if (r.ctx) c.context = true;
    return c;
  });
}

// Write <WORK>/slides.json from plan.md and chain.md. The plan holds every decision; this only reads the code
// it refers to. A missing file or an empty range stops the build: correct the plan.
function cmdBuild(args) {
  const work = args.work;
  const text = read(join(work, 'plan.md'));
  const head = planHead(text);
  const chainFile = join(work, 'chain.md');
  const open = isFile(chainFile) ? openQuestions(read(chainFile)).items : [];
  const problems = [];
  const doc = { summary: plain(planLine(head, 'Summary')), omitted: parseOmitted(planLine(head, 'Omitted')),
    open: open.map((o) => ({ ...o, text: plain(o.text) })), slides: [] };
  if (!doc.summary) problems.push("NO SUMMARY: write 'Summary: ...' at the top of plan.md");
  const tipSlide = {};
  planSlides(text).forEach((slide, idx) => {
    const n = idx + 1;
    const title = slideTitle(slide);
    const out = { title, text: plain(planLine(slide, 'Text')), introduces: introduced(slide) };
    const steps = slideSteps(work, slide);
    const sides = slideSides(work, slide);
    for (const r of [...steps.flatMap((st) => st.refs), ...sides.flat()]) {
      if (r.shown === null) problems.push(`NO FILE ${r.path}: ${title}`);
      else if (!r.shown.length) problems.push(`NO CODE in ${r.path} L${r.from}-${r.to}: ${title} (only comments or blank lines)`);
    }
    if (steps.length) {
      out.steps = steps.map((st) => ({
        text: plain(st.text), where: st.refs.map((r) => r.where).find(Boolean) || '', code: dedent(st.refs.flatMap((r) => r.shown || [])).join('\n'),
      }));
    } else {
      ['before', 'after'].forEach((side, i) => {
        const chunks = sideChunks(sides[i]);
        if (chunks.length) out[side] = chunks;
      });
      const labels = planLine(slide, 'Labels').split('/').map((s) => s.trim()).filter(Boolean);
      if (labels.length >= 2) [out.beforeLabel, out.afterLabel] = labels;
      else if (labels.length === 1) out[out.after ? 'afterLabel' : 'beforeLabel'] = labels[0];
      if (/^off$/i.test(planLine(slide, 'Align'))) out.align = false;
    }
    for (const t of slideTips(slide)) {
      const field = t.side === 'both' ? 'tips' : `${t.side}Tips`;
      (out[field] ||= {})[t.key] = plain(t.text);
      const m = OPEN_TIP_RE.exec(t.text);
      if (m) for (const q of m[2].split(/,\s*/)) tipSlide[q] ||= n;
    }
    doc.slides.push(out);
  });
  // The closing slide links each open question to the first slide with its tip
  for (const o of doc.open) {
    const n = o.questions.map((q) => tipSlide[q]).find(Boolean);
    if (n) o.slide = n;
  }
  if (!doc.slides.length) problems.push("NO SLIDES: write each slide as '## 1. <title>'");
  for (const p of problems) console.log(p);
  if (problems.length) {
    console.log(`${problems.length} problem(s); slides.json not written`);
    process.exit(1);
  }
  const out = join(work, 'slides.json');
  writeFileSync(out, JSON.stringify(doc, null, 1));
  console.log(`Wrote ${out}: ${doc.slides.length} slides, ${doc.open.length} open question(s), ${Object.keys(doc.omitted).length} omitted hunk(s)`);
}

// What the investigation must keep: every code hunk raises a question, every question has an answer or is
// open with a kind, and every link of the chain refers to the questions that prove it.
function cmdChain(args) {
  const work = args.work;
  const hunks = JSON.parse(read(join(work, 'hunks.json')));
  const text = read(join(work, 'chain.md'));
  const sections = chainSections(text);
  let problems = 0;
  const questions = [...(sections['Questions'] || '').matchAll(/^### (Q\d+) \(from ([^)]*)\):.*?\n([\s\S]*?)(?=^### |^## |(?![\s\S]))/gm)]
    .map((m) => [m[1], m[2], m[3]]);
  if (!questions.length) {
    console.log("NO QUESTIONS: write them under '## Questions' as '### Q1 (from H01): ...'");
    problems += 1;
  }
  const openText = sections['Open questions'] || '';
  const started = new Set(questions.flatMap(([, src]) => src.match(/\bH\d{2,}\b/g) || []));
  for (const h of hunks) {
    if (h.kind === 'code' && !started.has(h.id)) {
      console.log(`NO QUESTION from ${h.id} ${h.path} ${h.header}`);
      problems += 1;
    }
  }
  for (const [q, , body] of questions) {
    const answer = /^- Answer:\s*(\S.*)$/m.exec(body);
    const looked = /^- Looked at:\s*(\S.*)$/m.exec(body);
    if (!answer && !new RegExp(`\\b${q}\\b`).test(openText)) {
      console.log(`NO ANSWER ${q}: answer it from the code, or put it in 'Open questions'`);
      problems += 1;
    }
    if (answer && !looked) {
      console.log(`NO SOURCE ${q}: write where in the code the answer comes from ('- Looked at:')`);
      problems += 1;
    }
  }
  const ids = new Set(questions.map(([q]) => q));
  const { items, bad } = openQuestions(text);
  for (const s of bad) {
    console.log(`OPEN QUESTION WITHOUT KIND: ${s.slice(0, 80)} (write '- Suspected bug (Q11): ...', '- Unexplained (...): ...' or '- Unused (...): ...')`);
    problems += 1;
  }
  for (const it of items) for (const q of it.questions) {
    if (!ids.has(q)) {
      console.log(`OPEN ${q} is not a question under '## Questions'`);
      problems += 1;
    }
  }
  const links = [...(sections['Chain'] || '').matchAll(/^\d+\. (.*)$/gm)].map((m) => m[1]);
  if (!links.length) {
    console.log("NO CHAIN: write the facts in order under '## Chain'");
    problems += 1;
  }
  links.forEach((link, i) => {
    if (!/\bQ\d+\b/.test(link)) {
      console.log(`LINK ${i + 1} refers to no question: ${link.slice(0, 70)}`);
      problems += 1;
    }
  });
  if (!('Open questions' in sections)) {
    console.log("NO 'Open questions' section: write 'none' if there are none");
    problems += 1;
  }
  console.log(`${problems} problem(s): ${questions.length} questions, ${links.length} links in the chain, ${items.length} open question(s)`);
  process.exit(problems ? 1 : 0);
}

const USAGE = 'usage: hunks.mjs split --diff pr.diff --out <WORK> | hunks.mjs chain|plan|reader|build|slides --work <WORK>';

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const cmds = { split: cmdSplit, chain: cmdChain, plan: cmdPlan, reader: cmdReader, build: cmdBuild, slides: cmdSlides };
  let values;
  try {
    ({ values } = parseArgs({ args: rest, options: { diff: { type: 'string' }, out: { type: 'string' }, work: { type: 'string' } } }));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  const need = cmd === 'split' ? ['diff', 'out'] : ['work'];
  if (!cmds[cmd] || need.some((k) => !values[k])) {
    console.error(USAGE);
    process.exit(2);
  }
  cmds[cmd](values);
}

main();
