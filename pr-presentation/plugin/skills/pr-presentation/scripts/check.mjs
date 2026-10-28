#!/usr/bin/env node
// Screenshots every slide of a built deck with headless Chrome, so the deck can be checked without opening a browser window.
// Usage: node check.mjs <deck.html> <out-dir>
// Needs Node 22+ (built-in WebSocket) and Chrome; set CHROME to its path if it is not in a standard place.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [deck, outDir] = process.argv.slice(2);
if (!deck || !outDir) {
  console.error('usage: node check.mjs <deck.html> <out-dir>');
  process.exit(2);
}

const chrome = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => p && existsSync(p));
if (!chrome) {
  console.error('Chrome not found; set CHROME to its path');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'pr-deck-chrome-'));
const proc = spawn(chrome, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1440,810', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function devtoolsPort() {
  const file = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) {
      const port = readFileSync(file, 'utf8').split('\n')[0];
      if (port) return port;
    }
    await sleep(100);
  }
  throw new Error('Chrome did not start');
}

let ws;
let nextId = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

try {
  const port = await devtoolsPort();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 810, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: pathToFileURL(resolve(deck)).href });
  await evaluate(`new Promise((res) => {
    const ready = () => document.fonts.ready.then(() => setTimeout(res, 300));
    const wait = () => (window.shower && shower.slides) ? ready() : setTimeout(wait, 50);
    wait();
  })`);
  await evaluate(`document.head.appendChild(document.createElement('style')).textContent = '.slide { transition: none !important; }'`);

  const count = await evaluate(`shower.slides.length`);
  mkdirSync(outDir, { recursive: true });
  const problems = [];
  for (let i = 0; i < count; i++) {
    const info = await evaluate(`new Promise((res) => {
      shower.goTo(${i});
      setTimeout(() => {
        const s = shower.activeSlide.element;
        const body = s.querySelector('.concept');
        res({
          title: (s.querySelector('h1, h2, h3')?.textContent || '').trim(),
          overflow: body ? body.scrollHeight > body.clientHeight + 1 : false,
        });
      }, 150);
    })`);
    const name = `slide-${String(i).padStart(2, '0')}.png`;
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'));
    console.log(`${name}  ${info.title}${info.overflow ? '  [OVERFLOWS]' : ''}`);
    if (info.overflow) problems.push(name);
  }
  if (problems.length) console.log(`\n${problems.length} slide(s) overflow: ${problems.join(', ')}`);
} finally {
  ws?.close();
  proc.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
