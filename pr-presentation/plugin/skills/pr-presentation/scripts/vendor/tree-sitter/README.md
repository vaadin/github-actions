Vendored so the skill runs on plain `node` with no install step.

- `tree-sitter.js`, `tree-sitter.wasm`: [web-tree-sitter](https://www.npmjs.com/package/web-tree-sitter) 0.25.10 (MIT, `LICENSE`).
- `grammars/*.wasm`: [tree-sitter-wasms](https://www.npmjs.com/package/tree-sitter-wasms) 0.1.13 (Unlicense, `grammars/LICENSE`), built for tree-sitter 0.20. Version 0.25.10 of the runtime is the one that loads them: 0.22 crashes on custom element names in the HTML grammar, and 0.27 cannot load them.

Used by `../../enclosing.mjs`.
