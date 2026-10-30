#!/usr/bin/env node
// Build the PR presentation from PR metadata and the slides file.
//
// Usage:
//   build.mjs --pr pr.json --slides slides.json [--src src] --out page.html
//
// pr.json:     written by collect.mjs: the `gh pr view` fields plus mergeBaseOid
// slides.json: written by hunks.mjs build from plan.md; see references/slides-json.md next to SKILL.md
// src:         the worktrees from collect.mjs (src/base, src/head); member lines then link to their line on GitHub
//
// The build only checks that the data is well-formed and that every tip key and introduced name
// exists in the slide's code. The quality rules live in SKILL.md.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const TEMPLATE = join(ASSETS, 'template.html');

const CHUNK_KEYS = new Set(['code', 'caption', 'context', 'file']);
const OPEN_KINDS = ['Suspected bug', 'Unexplained'];
const GAP_RE = /(?<![\w$.])\.\.\.(?![\w$.])/;

const splitlines = (text) => { const a = text.split(/\r?\n/); if (a.length && a.at(-1) === '') a.pop(); return a; };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
const isFile = (p) => existsSync(p) && statSync(p).isFile();
// Text with \n line ends only, like Python's universal newlines
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const isStr = (v) => typeof v === 'string';
const nonEmpty = (v) => isStr(v) && v.trim() !== '';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Python's idea of an empty value: nothing, an empty string, list or object
const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length);
const repr = (s) => (s.includes("'") && !s.includes('"') ? `"${s.replace(/\\/g, '\\\\')}"` : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
const count = (s, ch) => s.split(ch).length - 1;

// The text of a file, or null when it is missing or not UTF-8 text.
function readText(p) {
  if (!isFile(p)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(p)).replace(/\r\n?/g, '\n');
  } catch {
    return null;
  }
}

// A pane as a list of chunk objects; a bare string is one chunk.
function chunks(v) {
  if (v == null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map((c) => (isStr(c) ? { code: c } : c));
}

const paneCode = (v) => chunks(v).filter(isObj).map((c) => c.code || '').join('\n');

// How often key appears in code as a whole name, the same rule the page uses for tooltips.
function countWhole(code, key) {
  const start = /[\w$]/.test(key[0]) ? '(?<![\\w$])' : '';
  const end = /[\w$]/.test(key.at(-1)) ? '(?![\\w$])' : '';
  return (code.match(new RegExp(start + escapeRe(key) + end, 'g')) || []).length;
}

// Structure of before/after; returns the code of each pane.
function checkPanes(where, obj, errors) {
  if (empty(obj.before) && empty(obj.after)) errors.push(`${where}: needs 'before' or 'after'`);
  for (const side of ['before', 'after']) {
    chunks(obj[side]).forEach((c, k) => {
      const unknown = isObj(c) ? Object.keys(c).filter((x) => !CHUNK_KEYS.has(x)).sort() : [];
      if (!isObj(c)) errors.push(`${where}.${side}[${k}]: a chunk is a string or an object with 'code'`);
      else if (unknown.length) errors.push(`${where}.${side}[${k}]: unknown keys [${unknown.map(repr).join(', ')}]`);
      else if (!nonEmpty(c.code)) errors.push(`${where}.${side}[${k}]: 'code' must be a non-empty string`);
      else if ('file' in c && !nonEmpty(c.file)) errors.push(`${where}.${side}[${k}]: 'file' must be the path of the file in the repo`);
    });
  }
  for (const f of ['beforeLabel', 'afterLabel', 'text']) {
    if (f in obj && !nonEmpty(obj[f])) errors.push(`${where}.${f}: must be a non-empty string`);
  }
  if ('align' in obj && typeof obj.align !== 'boolean') errors.push(`${where}.align: must be true or false`);
  return { before: paneCode(obj.before), after: paneCode(obj.after) };
}

// A step list: old code in run order, one sentence and a few lines for each step. Its tips match as Before.
function checkSteps(where, obj, errors) {
  let steps = obj.steps;
  if (!empty(obj.before) || !empty(obj.after)) errors.push(`${where}: a slide with 'steps' has no 'before' or 'after'`);
  if (!Array.isArray(steps) || steps.length < 2) {
    errors.push(`${where}.steps: must be a list of at least 2 steps`);
    steps = [];
  }
  steps.forEach((st, k) => {
    if (!isObj(st) || Object.keys(st).some((x) => !['text', 'code', 'where'].includes(x))) {
      errors.push(`${where}.steps[${k}]: a step is an object with 'text', 'code' and optional 'where'`);
      return;
    }
    for (const f of ['text', 'code']) if (!nonEmpty(st[f])) errors.push(`${where}.steps[${k}]: '${f}' must be a non-empty string`);
  });
  return { before: steps.filter(isObj).map((st) => st.code || '').join('\n'), after: '' };
}

// Every tip key must exist in the pane(s) it applies to, or the tip would silently disappear.
function checkTips(where, obj, code, errors) {
  for (const [field, sides] of [['tips', ['before', 'after']], ['beforeTips', ['before']], ['afterTips', ['after']]]) {
    const tips = field in obj ? obj[field] : {};
    if (!isObj(tips)) {
      errors.push(`${where}.${field}: must be an object mapping code text to an explanation`);
      continue;
    }
    for (const [k, t] of Object.entries(tips)) {
      if (!nonEmpty(t)) errors.push(`${where}.${field}[${repr(k)}]: needs explanation text`);
      const m = /@(\d+)$/.exec(k);
      const [key, nth] = m ? [k.slice(0, m.index), Number(m[1])] : [k, 1];
      if (!key) {
        errors.push(`${where}.${field}: empty key`);
        continue;
      }
      if (Math.max(...sides.map((side) => countWhole(code[side], key))) < nth) {
        errors.push(`${where}.${field}[${repr(k)}]: not found in the slide's code as a whole name` + (nth > 1 ? ` ${nth} times` : ''));
      }
    }
  }
}

function validate(doc) {
  const errors = [];
  if (!nonEmpty(doc.summary)) errors.push("'summary' is missing");
  const slides = doc.slides;
  if (!Array.isArray(slides) || !slides.length) return [...errors, "'slides' must be a non-empty array"];
  const open = doc.open ?? [];
  if (!Array.isArray(open)) errors.push("'open' must be a list of open questions");
  else open.forEach((o, i) => {
    if (!isObj(o) || !OPEN_KINDS.includes(o.kind) || !Array.isArray(o.questions) || !nonEmpty(o.text)) {
      errors.push(`open[${i}]: needs 'kind' (${OPEN_KINDS.join(', ')}), 'questions' and 'text'`);
    } else if ('slide' in o && !(Number.isInteger(o.slide) && o.slide >= 1 && o.slide <= slides.length)) {
      errors.push(`open[${i}].slide: must be the number of a slide, from 1`);
    }
  });
  slides.forEach((sl, i) => {
    const where = `slides[${i}]`;
    for (const f of ['title', 'text']) if (!nonEmpty(sl[f])) errors.push(`${where}: missing '${f}'`);
    let intro = sl.introduces;
    if (!Array.isArray(intro) || !intro.every(nonEmpty)) {
      errors.push(`${where}: 'introduces' must be a list of names`);
      intro = [];
    }
    if ('parts' in sl) errors.push(`${where}: 'parts' is not supported; make each screen a slide of its own`);
    const code = 'steps' in sl ? checkSteps(where, sl, errors) : checkPanes(where, sl, errors);
    checkTips(where, sl, code, errors);
    const allCode = code.before + '\n' + code.after;
    for (const name of intro) {
      if (!name.startsWith('idea:') && !countWhole(allCode, name)) errors.push(`${where}.introduces: ${repr(name)} not found in the slide's code as a whole name`);
    }
  });
  return errors;
}

// Source links: a method, class, field with a modifier or CSS rule starts a "member"; the page uses the
// same rule to put an empty line between members.
const STATEMENT_RE = /^(if|for|while|switch|try|else|do|catch|finally|return|throw|new|case|yield|await|const|let|var)\b/;
const MODIFIER_RE = /^(public|private|protected|static|final|abstract|default|class|interface|enum|record|export|async|function|get|set)\b/;
const SIGNATURE_RE = /^[\w$<>\[\],.?]+(\s+[\w$<>\[\],.?]+)*\s+[\w$]+\s*\(/;
const JS_METHOD_RE = /^#?[\w$]+\s*\([^)]*\)\s*\{$/;

function startsMember(line) {
  const n = line.trim();
  if (!n || STATEMENT_RE.test(n) || (n.startsWith('@') && !n.startsWith('@media'))) return false;
  const bare = n.replace(/\[[^\]]*\]/g, '');
  if (/(&&|\|\||!=|==|\?\s|^[,.:?&|+-])/.test(bare) || count(n, ')') > count(n, '(')) return false;
  if (MODIFIER_RE.test(n) || SIGNATURE_RE.test(n) || JS_METHOD_RE.test(n)) return true;
  return n.endsWith('{') && !/(=>|->|=|;)/.test(bare) && /^[.#:\[\w*&>~+-]/.test(n);
}

// The worktrees hold the whole repository, so the build reads only the files of the deck's chunks
function deckPaths(doc) {
  const paths = [];
  for (const sl of doc.slides) for (const side of ['before', 'after']) for (const c of chunks(sl[side])) if (c.file) paths.push(c.file);
  return [...new Set(paths)];
}

// [path, line number] of the first line in `paths` under `root` that matches a slide line; '...' matches anything.
function findInSources(line, root, paths) {
  const text = line.trim().split(/\s+/).join(' ');
  const pieces = text.split(GAP_RE).map((p) => escapeRe(p.trim()));
  const pattern = new RegExp('^' + pieces.join('\\s*.*?\\s*') + '$');
  for (const path of paths) {
    const src = readText(join(root, path));
    if (src === null) continue;
    const lines = splitlines(src);
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i].trim().split(/\s+/).join(' '))) return [path, i + 1];
    }
  }
  return null;
}

// GitHub links on member lines: the PR head for the after side and context, the merge base for the before side.
function addLinks(doc, src, pr, paths) {
  const repo = pr.url.split('/').slice(3, 5).join('/');
  const baseSha = pr.mergeBaseOid || pr.baseRefOid;
  for (const sl of doc.slides) {
    for (const side of ['before', 'after']) {
      const cs = chunks(sl[side]);
      for (const c of cs) {
        const useBase = side === 'before' && !c.context;
        const root = join(src, useBase ? 'base' : 'head');
        // The chunk's own file first, then the other files of the deck
        const where = (c.file ? [c.file] : []).concat(paths);
        const links = [];
        for (const line of c.code.replace(/\n+$/, '').split('\n')) {
          if (!line.trim()) continue;
          let url = null;
          if (startsMember(line)) {
            const hit = findInSources(line, root, where);
            if (hit) url = `https://github.com/${repo}/blob/${useBase ? baseSha : pr.headRefOid}/${hit[0]}#L${hit[1]}`;
          }
          links.push(url);
        }
        c.links = links;
        // The page names the file of each chunk; without "file", the first line with a few names that
        // is found in the sources tells it (a line such as "}" is in every file)
        if (!c.file) {
          for (const line of c.code.split('\n')) {
            const hit = (line.match(/[\w$]+/g) || []).length >= 3 && findInSources(line, root, paths);
            if (hit) {
              c.file = hit[0];
              break;
            }
          }
        }
      }
      if (cs.length) sl[side] = cs;
    }
    // A step links its first line to the base source, since step code is old code
    for (const st of sl.steps || []) {
      const first = st.code.split('\n').find((l) => l.trim()) || '';
      const hit = first ? findInSources(first, join(src, 'base'), paths) : null;
      st.links = [hit ? `https://github.com/${repo}/blob/${baseSha}/${hit[0]}#L${hit[1]}` : null];
    }
  }
}

const USAGE = 'usage: build.mjs --pr pr.json --slides slides.json [--src src] --out page.html';

function main() {
  let a;
  try {
    ({ values: a } = parseArgs({ options: { pr: { type: 'string' }, slides: { type: 'string' }, src: { type: 'string' }, out: { type: 'string' } } }));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  if (!a.pr || !a.slides || !a.out) {
    console.error(USAGE);
    process.exit(2);
  }
  const pr = JSON.parse(read(a.pr));
  const doc = JSON.parse(read(a.slides));
  const errors = validate(doc);
  if (errors.length) {
    console.error('slides.json is invalid:\n  ' + errors.join('\n  '));
    process.exit(1);
  }
  const paths = deckPaths(doc);
  if (a.src) addLinks(doc, a.src, pr, paths);

  const data = {
    pr: { number: pr.number, title: pr.title, url: pr.url, repo: pr.url.split('/').slice(3, 5).join('/') },
    summary: doc.summary,
    open: doc.open || [],
    slides: doc.slides,
  };
  const payload = JSON.stringify(data).replace(/<\//g, '<\\/');
  let html = read(TEMPLATE);
  // Function replacers, so that "$" in the code is not read as a replacement pattern
  html = html.replace('__TITLE__', () => `PR ${pr.number} Presentation`);
  html = html.replace('__DATA__', () => payload);
  writeFileSync(a.out, html);
  console.log(`Wrote ${a.out}: ${doc.slides.length} slides`);
}

main();
