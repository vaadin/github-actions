// The lines that open the blocks around a line of code: a nested class, a method or function, a CSS rule, an
// HTML element in a Lit template. hunks.mjs puts them above a range that starts inside such a block, so a
// slide shows where its code belongs. Parsed with tree-sitter (vendor/tree-sitter, see its README).
import { extname } from 'node:path';
import { Language, Parser } from './vendor/tree-sitter/tree-sitter.js';

const GRAMMARS = new URL('./vendor/tree-sitter/grammars/', import.meta.url);
const EXT = { '.java': 'java', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript', '.mts': 'typescript', '.css': 'css' };

await Parser.init();
const parsers = {};
for (const lang of ['java', 'javascript', 'typescript', 'css', 'html']) {
  const p = new Parser();
  p.setLanguage(await Language.load(new URL(`tree-sitter-${lang}.wasm`, GRAMMARS).pathname));
  parsers[lang] = p;
}

const CLASS = new Set(['class_declaration', 'class', 'abstract_class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'annotation_type_declaration']);
const FUNC = new Set(['method_declaration', 'constructor_declaration', 'method_definition', 'function_declaration', 'generator_function_declaration']);
const CSS_BLOCK = new Set(['rule_set', 'media_statement', 'supports_statement', 'at_rule', 'keyframes_statement']);
const VALUE = new Set(['arrow_function', 'function_expression', 'function', 'object']);
const NAMED = new Set(['variable_declarator', 'pair', 'assignment_expression', 'public_field_definition', 'field_definition']);
const BODY = new Set(['class_body', 'block', 'statement_block', 'object', 'enum_body', 'interface_body', 'declaration_list']);

// A node that gives structure: a class, a method or function, an anonymous class, a function or object that
// is the value of a named declaration or property, a CSS rule, an HTML element.
function structural(n) {
  const t = n.type;
  if (CLASS.has(t) || FUNC.has(t) || CSS_BLOCK.has(t) || t === 'element') return true;
  if (t === 'object_creation_expression') return n.namedChildren.some((c) => c.type === 'class_body');
  return VALUE.has(t) && !!n.parent && NAMED.has(n.parent.type);
}

// The row where the header of a block ends: the line that opens its body. An HTML element gets only the first
// line of its start tag, since a Lit start tag can run over many lines of attributes.
function headerEnd(n) {
  if (n.type === 'element') return n.startPosition.row;
  const body = n.childForFieldName('body') || n.namedChildren.find((c) => BODY.has(c.type));
  return body ? body.startPosition.row : n.startPosition.row;
}

function insideMember(n) {
  for (let p = n.parent; p; p = p.parent) if (CLASS.has(p.type) || FUNC.has(p.type)) return true;
  return false;
}

// html`...` or svg`...`: its text gets an HTML parse
function litTemplate(n) {
  if (n.type !== 'template_string' || n.parent?.type !== 'call_expression') return null;
  const fn = n.parent.childForFieldName('function');
  return fn && /^(html|svg)$/.test(fn.text) ? n : null;
}

// The elements of a Lit template around (row, col), with ${...} blanked so the columns stay the same
function templateBlocks(tpl, row, col) {
  const text = tpl.text.slice(1, -1).replace(/\$\{[^}]*\}/g, (m) => m.replace(/[^\n]/g, ' '));
  const base = tpl.startPosition.row;
  const r = row - base;
  const c = r === 0 ? col - tpl.startPosition.column - 1 : col;
  const out = [];
  for (let n = parsers.html.parse(text).rootNode.descendantForPosition({ row: r, column: Math.max(0, c) }); n; n = n.parent) {
    if (n.type === 'element' && n.startPosition.row < r) {
      out.push({ from: n.startPosition.row + base, to: n.startPosition.row + base, span: n.endPosition.row - n.startPosition.row + 1 });
    }
  }
  return out;
}

const trees = new Map();

// The header lines of the blocks around `line` (1-based) of `file`, whose text is `src`: [{from, to}], 1-based,
// outermost first; null for a language without a grammar. Left out, each with everything above it: a class
// that is not inside another class or a method (the class of the file, also inside a mixin function), and a
// block that spans more than half of the file (a connector function, a CSS @media around the whole file).
export function enclosing(file, src, line) {
  const lang = EXT[extname(file)];
  if (!lang) return null;
  const key = file + '\0' + src.length;
  if (!trees.has(key)) trees.set(key, parsers[lang].parse(src));
  const lines = src.split('\n');
  const row = line - 1;
  const col = Math.max(0, (lines[row] || '').search(/\S/));
  const found = [];
  let inTemplate = false;
  for (let n = trees.get(key).rootNode.descendantForPosition({ row, column: col }); n; n = n.parent) {
    if (!inTemplate && litTemplate(n) && n.startPosition.row < row) {
      found.push(...templateBlocks(n, row, col));
      inTemplate = true;
    }
    // A line in the header of a block (a signature after an annotation) is not inside the block
    if (structural(n) && headerEnd(n) < row) {
      const head = VALUE.has(n.type) ? n.parent : n;
      found.push({ from: head.startPosition.row, to: headerEnd(n), span: n.endPosition.row - n.startPosition.row + 1, top: CLASS.has(n.type) && !insideMember(n) });
    }
  }
  const cut = found.findIndex((f) => f.top || f.span > lines.length / 2);
  return (cut >= 0 ? found.slice(0, cut) : found).reverse().map((f) => ({ from: f.from + 1, to: f.to + 1 }));
}
