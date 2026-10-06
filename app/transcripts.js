const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const ACTIVE_MS = 30 * 60 * 1000; // a transcript touched this recently is a live session
const WORKING_MS = 20_000; // ...and this recently, it is working right now (tools can take a while)
const TAIL_BYTES = 1_500_000; // how far back to read when a session is opened (tool output is bulky)
const MAX_ITEMS = 200;

const short = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

/** Text the person typed, without what the app wraps around it. */
function cleanUserText(text) {
  return String(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, '[texto colado]')
    .replace(/<(command-[\w-]+|local-command-[\w-]+|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g, '')
    .trim();
}

function describeTool(name, input = {}) {
  const detail =
    input.command ||
    (input.file_path && path.basename(input.file_path)) ||
    input.pattern ||
    input.url ||
    input.query ||
    input.description ||
    input.prompt ||
    '';
  return detail ? `${name} · ${short(detail, 80)}` : name;
}

/** One transcript line → chat items ({ role: 'user' | 'assistant' | 'tool', text }). */
function itemsOf(e) {
  if (e.isSidechain || e.isMeta) return []; // subagents and app-injected lines
  const m = e.message;
  if (!m) return [];
  const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
  const out = [];
  for (const c of content) {
    if (e.type === 'user' && c.type === 'text') {
      const text = cleanUserText(c.text);
      if (text) out.push({ role: 'user', text });
    } else if (e.type === 'assistant' && c.type === 'text' && c.text.trim()) {
      out.push({ role: 'assistant', text: c.text });
    } else if (e.type === 'assistant' && c.type === 'tool_use') {
      out.push({ role: 'tool', text: describeTool(c.name, c.input) });
    }
  }
  return out;
}

/**
 * Claude Code writes every session to ~/.claude/projects/<project>/<id>.jsonl as
 * it goes. Reading them shows what each session is doing, live, with no hooks.
 */
class Transcripts {
  constructor({ onSessions, onItems }) {
    this.onSessions = onSessions;
    this.onItems = onItems;
    this.meta = new Map(); // file -> { title, cwd, size }
    this.sessions = [];
    this.open = null; // { id, file, pos, buf }
    this.scanTimer = null;
    this.tailTimer = null;
  }

  start() {
    this.scan();
    this.scanTimer = setInterval(() => this.scan(), 4000);
  }

  stop() {
    clearInterval(this.scanTimer);
    clearInterval(this.tailTimer);
  }

  scan() {
    const now = Date.now();
    const found = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return;
    }
    for (const d of dirs) {
      const dir = path.join(ROOT, d.name);
      let files;
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const file = path.join(dir, f);
        let fst;
        try {
          fst = fs.statSync(file);
        } catch {
          continue;
        }
        if (now - fst.mtimeMs > ACTIVE_MS) continue;
        const info = this.info(file, fst.size);
        found.push({
          id: f.slice(0, -6),
          file,
          project: info.cwd ? path.basename(info.cwd) : d.name.split('-').pop(),
          title: info.title,
          cwd: info.cwd,
          working: now - fst.mtimeMs < WORKING_MS,
          updatedAt: fst.mtimeMs,
        });
      }
    }
    found.sort((a, b) => b.updatedAt - a.updatedAt);
    this.recent = found;
    const key = JSON.stringify(found.map((s) => [s.id, s.title, s.working, s.project]));
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.sessions = found;
      this.onSessions(found);
    }
  }

  /** Title and folder of a session, read from the end of its file (cached by size). */
  info(file, size) {
    const cached = this.meta.get(file);
    if (cached && cached.size === size) return cached;
    const tail = readTail(file, 200_000);
    let title = cached?.title || '';
    let cwd = cached?.cwd || '';
    for (const line of tail.split('\n')) {
      if (line.includes('"custom-title"')) title = /"customTitle":"((?:[^"\\]|\\.)*)"/.exec(line)?.[1] ?? title;
      cwd = /"(?:relocatedCwd|cwd)":"((?:[^"\\]|\\.)*)"/.exec(line)?.[1] ?? cwd; // the last one wins
    }
    const v = { size, title: short(JSON.parse(`"${title}"`), 60), cwd: cwd ? JSON.parse(`"${cwd}"`) : '' };
    this.meta.set(file, v);
    return v;
  }

  /** Start following one session: its recent history now, then each new line. */
  follow(id) {
    clearInterval(this.tailTimer);
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return (this.open = null);
    let size = 0;
    try {
      size = fs.statSync(s.file).size;
    } catch {}
    const start = Math.max(0, size - TAIL_BYTES);
    const text = readRange(s.file, start, size);
    const lines = text.split('\n');
    if (start > 0) lines.shift(); // probably cut in half
    this.open = { id, file: s.file, pos: size, buf: '', usage: usageOf(s.file), seen: new Set() };
    const items = lines.flatMap(parse).slice(-MAX_ITEMS);
    this.onItems({ id, reset: true, items, usage: this.open.usage });
    this.tailTimer = setInterval(() => this.poll(), 700);
  }

  unfollow() {
    clearInterval(this.tailTimer);
    this.open = null;
  }

  poll() {
    const o = this.open;
    if (!o) return;
    let size;
    try {
      size = fs.statSync(o.file).size;
    } catch {
      return;
    }
    if (size <= o.pos) return;
    o.buf += readRange(o.file, o.pos, size);
    o.pos = size;
    const lines = o.buf.split('\n');
    o.buf = lines.pop();
    const items = lines.flatMap(parse);
    for (const line of lines) addUsage(o.usage, line, o.seen);
    if (items.length) this.onItems({ id: o.id, reset: false, items, usage: o.usage });
  }
}

/** Tokens spent so far: each assistant message once (it is written once per block). */
function addUsage(total, line, seen) {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
  try {
    const m = JSON.parse(line).message;
    if (!m?.usage || seen.has(m.id)) return;
    seen.add(m.id);
    total.input += m.usage.input_tokens || 0;
    total.output += m.usage.output_tokens || 0;
    total.cache += (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
  } catch {}
}

function usageOf(file) {
  const total = { input: 0, output: 0, cache: 0, cost: null };
  const seen = new Set();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) addUsage(total, line, seen);
  } catch {}
  return total;
}

function parse(line) {
  if (!line.trim()) return [];
  try {
    return itemsOf(JSON.parse(line));
  } catch {
    return [];
  }
}

function readRange(file, start, end) {
  const len = Math.max(0, end - start);
  if (!len) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(file, bytes) {
  try {
    const size = fs.statSync(file).size;
    return readRange(file, Math.max(0, size - bytes), size);
  } catch {
    return '';
  }
}

module.exports = { Transcripts, usageOf };
