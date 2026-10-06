const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { t } = require('./i18n');

const SOCKET = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'lydia.sock');
const STALE_MS = 2 * 60 * 60 * 1000; // a session silent this long is gone (crashed, killed)
const MAX_STEPS = 3;

const short = (s, n = 60) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const base = (p) => (p ? path.basename(String(p)) : '');

/** "Bash · npm test", "Edit · billing.ts"... what a tool call is about, in a few words. */
function describe(tool, input = {}) {
  const name = String(tool || t('bridge.tool'));
  const detail =
    input.command ||
    base(input.file_path || input.path || input.notebook_path) ||
    input.pattern ||
    input.url ||
    input.query ||
    input.description ||
    '';
  return detail ? `${name} · ${short(detail, 48)}` : name;
}

/**
 * Receives Claude Code hook events from hook.py over a Unix socket and keeps a
 * small picture of each session. A PermissionRequest keeps its connection open
 * until decide() answers it (or hook.py gives up and the terminal asks instead).
 *
 * onChange() fires whenever sessions or pending approvals change.
 */
class Bridge {
  constructor({ onChange, onEvent }) {
    this.onChange = onChange;
    this.onEvent = onEvent ?? (() => {});
    this.sessions = new Map(); // session_id -> { id, project, cwd, status, steps, updatedAt, title }
    this.pending = new Map(); // request id -> { id, sessionId, project, tool, summary, socket, at }
    this.nextId = 1;
    this.server = null;
  }

  start() {
    // A socket file left by a crash answers nothing: remove it. One that answers
    // belongs to another running Lydia: leave it alone.
    if (fs.existsSync(SOCKET)) {
      const probe = net.connect(SOCKET);
      probe.on('connect', () => probe.destroy());
      probe.on('error', () => {
        try {
          fs.unlinkSync(SOCKET);
        } catch {}
        this.listen();
      });
      return;
    }
    this.listen();
  }

  listen() {
    setInterval(() => this.sweep(), 60_000).unref();
    this.server = net.createServer((sock) => this.accept(sock));
    this.server.on('error', (err) => console.log('[lydia] bridge:', err.message));
    this.server.listen(SOCKET, () => fs.chmodSync(SOCKET, 0o600));
  }

  stop() {
    for (const p of this.pending.values()) p.socket.destroy();
    this.pending.clear();
    this.server?.close();
    try {
      fs.unlinkSync(SOCKET);
    } catch {}
  }

  accept(sock) {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d;
      if (buf.length > 256_000) return sock.destroy();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let ev;
      try {
        ev = JSON.parse(buf.slice(0, nl));
      } catch {
        return sock.destroy();
      }
      buf = '';
      this.handle(ev, sock);
    });
  }

  session(ev) {
    const id = String(ev.session_id || 'sem-id');
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, cwd: ev.cwd || '', project: base(ev.cwd) || 'Claude Code', status: 'idle', steps: [], updatedAt: 0, title: '' };
      this.sessions.set(id, s);
    }
    if (ev.cwd) {
      s.cwd = ev.cwd;
      s.project = base(ev.cwd);
    }
    if (ev.session_title) s.title = short(ev.session_title, 40);
    s.updatedAt = Date.now();
    return s;
  }

  step(s, text, done = false) {
    s.steps.push({ text, done });
    if (s.steps.length > MAX_STEPS) s.steps.shift();
  }

  handle(ev, sock) {
    // OwnedToolUse: a tool call in a session Lydia runs, waiting like a permission request.
    const owned = ev.hook_event_name === 'OwnedToolUse';
    const name = owned ? 'PermissionRequest' : ev.hook_event_name;
    if (name !== 'PermissionRequest') sock.end();
    if (name === 'SessionEnd') {
      this.sessions.delete(String(ev.session_id));
      this.dropPendingOf(String(ev.session_id));
      return this.onChange();
    }
    const s = this.session(ev);
    switch (name) {
      case 'SessionStart':
        s.status = 'idle';
        break;
      case 'UserPromptSubmit':
        s.status = 'working';
        s.steps = [];
        this.step(s, t('bridge.you', { text: short(ev.prompt ?? ev.user_input, 50) }), true);
        break;
      case 'PreToolUse':
        s.status = 'working';
        this.step(s, describe(ev.tool_name, ev.tool_input));
        break;
      case 'PostToolUse': {
        const last = s.steps[s.steps.length - 1];
        if (last) last.done = true;
        break;
      }
      case 'Notification':
        if (/permission/i.test(ev.notification_type || '')) s.status = 'waiting';
        else if (/idle/i.test(ev.notification_type || '')) s.status = 'idle';
        break;
      case 'Stop':
        s.status = 'idle';
        this.step(s, t('bridge.done'), true);
        break;
      case 'PermissionRequest': {
        s.status = 'waiting';
        const id = String(this.nextId++);
        const req = {
          id,
          sessionId: s.id,
          project: s.project,
          tool: String(ev.tool_name || ''),
          summary: describe(ev.tool_name, ev.tool_input),
          question: ev.tool_name === 'AskUserQuestion',
          owned, // a session Lydia runs: no terminal to fall back to
          socket: sock,
          at: Date.now(),
        };
        this.pending.set(id, req);
        // hook.py gave up (or Claude Code was answered in the terminal).
        sock.on('close', () => {
          if (this.pending.delete(id)) {
            if (s.status === 'waiting') s.status = 'working';
            this.onChange();
          }
        });
        this.onEvent({ type: 'permission', request: this.publicRequest(req) });
        break;
      }
      default:
        break;
    }
    this.onEvent({ type: name, session: s });
    this.onChange();
  }

  /** Answer a pending permission: 'allow', 'deny', or 'terminal' (let Claude Code ask there). */
  decide(id, decision) {
    const req = this.pending.get(String(id));
    if (!req) return false;
    this.pending.delete(req.id);
    const s = this.sessions.get(req.sessionId);
    if (s) s.status = decision === 'terminal' ? 'waiting' : 'working';
    if (decision === 'allow' || decision === 'deny') req.socket.end(decision + '\n');
    else req.socket.end();
    this.onChange();
    return true;
  }

  dropPendingOf(sessionId) {
    for (const [id, req] of this.pending) {
      if (req.sessionId === sessionId) {
        req.socket.destroy();
        this.pending.delete(id);
      }
    }
  }

  sweep() {
    const now = Date.now();
    let changed = false;
    for (const [id, s] of this.sessions) {
      if (now - s.updatedAt > STALE_MS && ![...this.pending.values()].some((p) => p.sessionId === id)) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  publicRequest(r) {
    return { id: r.id, sessionId: r.sessionId, project: r.project, tool: r.tool, summary: r.summary, question: r.question, owned: r.owned };
  }

  snapshot() {
    return {
      sessions: [...this.sessions.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ id, project, title, status, steps }) => ({ id, project, title, status, steps })),
      pending: [...this.pending.values()].map((r) => this.publicRequest(r)),
    };
  }
}

module.exports = { Bridge, SOCKET };
