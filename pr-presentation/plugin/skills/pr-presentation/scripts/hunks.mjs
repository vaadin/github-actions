#!/usr/bin/env node
// Number the hunks of a PR diff and check that the plan and the slides cover all of them.
//
// Usage:
//   hunks.mjs split    --diff pr.diff --out <WORK>
//       Writes <WORK>/hunks.json and <WORK>/annotated.md: one "## H07" section per hunk with its diff.
//   hunks.mjs chain    --work <WORK>
//       Checks <WORK>/chain.md: every code hunk raises a question, every question has an answer from the code or
//       is open, and every link of the chain refers to the questions that prove it.
//   hunks.mjs plan     --work <WORK>
//       Checks <WORK>/plan.md: every code hunk ID under "Hunks:" or "Omitted:" (tests are not shown), tips of at most
//       20 words, at most 4 new things per slide, each name in Introduces in the slide's code, line ranges that start
//       at real code, and each slide estimated to fit one screen.
//   hunks.mjs reader   --work <WORK>
//       Writes <WORK>/reader/slides/: the deck as the reader sees it (titles, sentences, code, tips), from
//       plan.md, without the notes, one numbered file per slide. The reader check of the skill sees
//       only this folder, one file at a time. Removes a <WORK>/reader/reading.md left by an earlier reader.
//       Also writes <WORK>/reader.md, the whole deck, for the orchestrator.
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

const splitlines = (text) => { const a = text.split(/\r?\n/); if (a.length && a.at(-1) === '') a.pop(); return a; };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
const isFile = (p) => existsSync(p) && statSync(p).isFile();
// Text with \n line ends only, like Python's universal newlines
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const words = (s) => (s.trim() ? s.trim().split(/\s+/) : []);
const repoPath = (p) => p.replace(/^src\/(?:base|head)\//, '');
// Python's repr of a string, for messages that quote code
const repr = (s) => (s.includes("'") && !s.includes('"') ? `"${s.replace(/\\/g, '\\\\')}"` : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);

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
const REF_RE = /^\s*- (src\/(?:base|head)\/\S+) L(\d+)(?:-(\d+))?((?:, skip L\d+-\d+)*)(.*)$/gm;
const STEP_LINE = 24, STEP_TEXT = 28, STEP_PANE = 44, STEP_ARROW = 24;
const COMMENT_START_RE = /^\s*(\/\/|\/\*|\*|<!--|#\s|})/;

// The code references of one side of a slide: {path, shown (lines, or null when the file is missing), ctx}.
function planRefs(work, block) {
  const refs = [];
  for (const m of block.matchAll(REF_RE)) {
    const path = m[1];
    const a = Number(m[2]);
    const b = Number(m[3] || a);
    const ctx = m[5].includes('(context)');
    const f = join(work, path);
    if (!isFile(f)) {
      refs.push({ path, shown: null, ctx });
      continue;
    }
    const src = read(f).split('\n');
    const skips = [...m[4].matchAll(/skip L(\d+)-(\d+)/g)].map((x) => [Number(x[1]), Number(x[2])]);
    const shown = [];
    let n = a;
    while (n <= b) {
      const skip = skips.find((s) => s[0] === n);
      if (skip) {
        shown.push('...');
        n = skip[1] + 1;
      } else {
        shown.push(n - 1 < src.length ? src[n - 1] : '');
        n += 1;
      }
    }
    refs.push({ path, shown, ctx });
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
    const key = repoPath(r.path) + '\0' + (r.shown || []).join('\n');
    if (r.ctx && !seen.has(key)) {
      seen.add(key);
      ctxRefs.push(r);
    }
  }
  const ctx = code(ctxRefs, CTX_LINE, CTX_PANE, CTX_CHUNK + FILE);
  return textHeight(text) + Math.max(...main) + (ctx ? 16 + ctx : 0);
}

// What the planner must keep: every hunk placed, tip length, new things per slide.
function cmdPlan(args) {
  const work = args.work;
  const hunks = JSON.parse(read(join(work, 'hunks.json')));
  const text = read(join(work, 'plan.md'));
  let problems = 0;
  const placed = new Set();
  for (const m of text.matchAll(/^(?:Hunks|Omitted):(.*)$/gm)) for (const i of m[1].match(/\bH\d{2,}\b/g) || []) placed.add(i);
  for (const h of hunks) {
    if (h.kind === 'code' && !placed.has(h.id)) {
      console.log(`MISSING ${h.id} ${h.kind} ${h.path} ${h.header}`);
      problems += 1;
    }
  }
  for (const m of text.matchAll(/^- (``?)(.+?)\1 \((?:before|after|both)\): (.+)$/gm)) {
    const n = words(m[3]).length;
    if (n > TIP_WORDS) {
      console.log(`LONG TIP ${n} words: ${m[2].trim().slice(0, 80)}`);
      problems += 1;
    }
  }
  for (const slide of planSlides(text)) {
    const title = slide.split('\n')[0];
    const items = [...slide.matchAll(/^Introduces:(.*)$/gm)].flatMap((m) => m[1].split(',')).filter((i) => i.trim() && i.trim().toLowerCase() !== 'none');
    if (items.length > MAX_NEW) {
      console.log(`TOO MANY NEW THINGS ${items.length}: ${title.slice(3)}`);
      problems += 1;
    }
    // The slide must fit one screen, its line ranges must start at real code, and its names must be in its code
    let sides = slideSides(work, slide);
    const steps = slideSteps(work, slide);
    const textLine = (slide.match(/^Text:(.*)$/m) || ['', ''])[1];
    const height = steps.length ? stepsHeight(textLine, steps) : slideHeight(textLine, sides);
    if (steps.length) sides = [steps.flatMap((st) => st.refs), []];
    if (height > SCREEN) {
      console.log(`TOO HIGH about ${height}px of ${SCREEN}px: ${title.slice(3)} (skip lines, or continue on the next slide)`);
      problems += 1;
    }
    const code = sides.flat().flatMap((r) => r.shown || []).join('\n');
    for (const r of sides.flat()) {
      if (r.shown === null) {
        console.log(`NO FILE ${r.path}: ${title.slice(3)}`);
        problems += 1;
      } else if (r.shown.length && (!r.shown[0].trim() || COMMENT_START_RE.test(r.shown[0]))) {
        console.log(`BAD RANGE ${r.path} starts with ${repr(r.shown[0].trim().slice(0, 40))}: ${title.slice(3)} (start at the enclosing line)`);
        problems += 1;
      }
    }
    for (const i of items) {
      const name = i.trim();
      if (!name.startsWith('idea:') && !new RegExp('(?<![\\w$-])' + escapeRe(name.replace(/^`+|`+$/g, '')) + '(?![\\w$-])').test(code)) {
        console.log(`NOT IN CODE \`${name}\` in Introduces: ${title.slice(3)} (use idea: for a concept)`);
        problems += 1;
      }
    }
  }
  console.log(`${problems} problem(s): every code hunk on a slide or omitted, tips at most ${TIP_WORDS} words, ` +
    `at most ${MAX_NEW} new things per slide, names in Introduces in the code, each slide fits one screen`);
  process.exit(problems ? 1 : 0);
}

const planSlides = (text) => text.split(/^(?=## )/m).filter((s) => s.startsWith('## '));

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

// Write <WORK>/reader/, one file per slide, and <WORK>/reader.md: the deck as the reader sees it, without the planner's notes.
function cmdReader(args) {
  const work = args.work;
  const text = read(join(work, 'plan.md'));
  const summary = (text.match(/^Summary:(.*)$/m) || ['', ''])[1].trim();
  const folder = join(work, 'reader', 'slides');
  mkdirSync(folder, { recursive: true });
  for (const old of readdirSync(folder)) if (old.endsWith('.md')) rmSync(join(folder, old));
  rmSync(join(work, 'reader', 'reading.md'), { force: true });
  const files = [['00-title.md', ['# Title slide', '', summary, '']]];
  planSlides(text).forEach((slide, idx) => {
    const n = idx + 1;
    const title = slide.split('\n')[0].replace(/^## \d+\.\s*/, '');
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
        out.push(`${label}, ${repoPath(r.path)}:`, '```', ...r.shown, '```', '');
      }
    }
    const tips = [...slide.matchAll(/^- (``?)(.+?)\1 \((before|after|both)\): (.+)$/gm)];
    if (tips.length) {
      out.push('Tooltips (the reader sees each one on the code it names):');
      out.push(...tips.map((m) => `- on \`${m[2].trim()}\`: ${m[4]}`));
      out.push('');
    }
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    files.push([`${String(n).padStart(2, '0')}-${slug}.md`, out]);
  });
  for (const [name, out] of files) writeFileSync(join(folder, name), out.join('\n'));
  writeFileSync(join(work, 'reader.md'), files.flatMap(([, out]) => out).join('\n'));
  console.log(`Wrote ${files.length} slide files to ${folder} and the whole deck to ${join(work, 'reader.md')}`);
}

// What the investigation must keep: every code hunk raises a question, every question has an answer or is open,
// and every link of the chain refers to the questions that prove it.
function cmdChain(args) {
  const work = args.work;
  const hunks = JSON.parse(read(join(work, 'hunks.json')));
  const text = read(join(work, 'chain.md'));
  const sections = {};
  for (const m of text.matchAll(/^## (.+?)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)) sections[m[1]] = m[2];
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
  console.log(`${problems} problem(s): ${questions.length} questions, ${links.length} links in the chain`);
  process.exit(problems ? 1 : 0);
}

const USAGE = 'usage: hunks.mjs split --diff pr.diff --out <WORK> | hunks.mjs chain|plan|reader|slides --work <WORK>';

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const cmds = { split: cmdSplit, chain: cmdChain, plan: cmdPlan, reader: cmdReader, slides: cmdSlides };
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
