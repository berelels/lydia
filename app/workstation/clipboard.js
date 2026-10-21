const { spawn } = require('child_process');
const { nativeImage } = require('electron');
const path = require('path');
const readline = require('readline');

/**
 * Clipboard history: text and images you copy, newest first, kept only in
 * memory (gone when Lydia closes). Pinned items survive "Clear". It can be
 * paused, and text that looks like a password or a key is never kept.
 *
 * The clipboard itself is read and written by clipwatch.py (GTK, its own
 * process): Electron's clipboard API in the main process can block it for
 * good while the app that owns the selection doesn't answer.
 */

const MAX = 80;
let items = []; // { id, kind: 'text' | 'image', text?, png? (base64), thumb?, size?, at, pinned }
let paused = false;
let helper = null;
let stopped = false;
let onChange = () => {};

// "Hunter2!x9" style secrets, API keys, tokens: not kept.
const SECRET = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s])\S{8,64}$|^(sk|pk|ghp|gho|xox[bap]|AIza|AQ\.)[\w.-]{10,}$|^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;

function copied(msg) {
  if (paused) return;
  // the same thing again (an app re-announcing it, or one put back from here) isn't a new copy
  if (items[0] && (msg.kind === 'text' ? items[0].text === msg.text : items[0].png === msg.png)) return;
  if (msg.kind === 'image' && msg.png) {
    const img = nativeImage.createFromBuffer(Buffer.from(msg.png, 'base64'));
    if (img.isEmpty()) return;
    const thumb = img.resize({ width: Math.min(240, msg.w) }).toDataURL();
    push({ kind: 'image', png: msg.png, thumb, size: `${msg.w}×${msg.h}` });
  } else if (msg.kind === 'text' && msg.text && !SECRET.test(msg.text.trim())) {
    push({ kind: 'text', text: msg.text.slice(0, 20000) });
  }
}

function push(item) {
  // the same text copied again moves to the top instead of repeating
  items = items.filter((x) => !(x.kind === 'text' && item.kind === 'text' && x.text === item.text && !x.pinned));
  items.unshift({ id: Date.now() + Math.random(), at: Date.now(), pinned: false, ...item });
  const pinned = items.filter((x) => x.pinned);
  items = [...items.filter((x) => !x.pinned).slice(0, MAX - pinned.length), ...pinned].sort((a, b) => b.at - a.at);
  onChange();
}

function start(cb) {
  onChange = cb;
  stopped = false;
  helper = spawn('python3', [path.join(__dirname, 'clipwatch.py')], { stdio: ['pipe', 'pipe', 'ignore'] });
  helper.on('error', () => {}); // no python3 / GTK: no history, nothing else breaks
  helper.stdin.on('error', () => {});
  readline.createInterface({ input: helper.stdout }).on('line', (line) => {
    try {
      copied(JSON.parse(line));
    } catch {}
  });
  helper.on('exit', () => {
    helper = null;
    if (!stopped) setTimeout(() => !stopped && start(onChange), 5000); // came down: once more, later
  });
}
function stop() {
  stopped = true;
  helper?.kill();
}

/** For the page: images as thumbnails only (the full ones stay here). */
const list = () => items.map(({ png, ...x }) => x);

/** Puts an item back on the clipboard (to paste it). */
function use(id) {
  const x = items.find((y) => y.id === id);
  if (!x || !helper) return false;
  helper.stdin.write(JSON.stringify(x.kind === 'text' ? { text: x.text } : { png: x.png }) + '\n');
  x.at = Date.now();
  items.sort((a, b) => b.at - a.at);
  return true;
}
/** New text on the clipboard (dictation where it can't be typed). */
function put(text) {
  helper?.stdin.write(JSON.stringify({ text }) + '\n');
  return !!helper;
}
function pin(id) {
  const x = items.find((y) => y.id === id);
  if (x) x.pinned = !x.pinned;
}
function remove(id) {
  items = items.filter((y) => y.id !== id);
}
function clear() {
  items = items.filter((x) => x.pinned);
}
function setPaused(v) {
  paused = !!v;
}

module.exports = { start, stop, list, use, put, pin, remove, clear, setPaused, isPaused: () => paused };
