const { spawn } = require('child_process');
const path = require('path');
const { findClaude } = require('./chat');
const { t } = require('./i18n');

const HOOK = path.join(__dirname, 'hook.py');

// Only for sessions Lydia runs: every tool that can change something asks her
// first (hook.py --owned answers PreToolUse). The user's settings.json is untouched.
const OWNED_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [{ hooks: [{ type: 'command', command: `/usr/bin/python3 ${HOOK} --owned`, timeout: 300 }] }],
  },
});

/**
 * A Claude Code session Lydia runs headless (`claude -p`, stream-json both ways),
 * so the user can talk to it from the island. It is a normal session: it is
 * saved, shows up in ~/.claude/projects and can be resumed in a terminal.
 *
 * resume: continue an existing session. fork: do it in a copy (for sessions that
 * may still be open elsewhere: two writers on one session would get tangled).
 */
class OwnedSession {
  constructor({ cwd, model, resume, fork, onEvent }) {
    this.cwd = cwd;
    this.model = model;
    this.resume = resume;
    this.fork = fork;
    this.onEvent = onEvent; // ({ type: 'id' | 'state' | 'usage' | 'done' | 'error', ... })
    this.id = fork ? null : resume ?? null;
    this.proc = null;
    this.buf = '';
    this.busy = false;
    this.usage = { input: 0, output: 0, cache: 0, cost: 0 };
  }

  start() {
    if (this.proc) return;
    const bin = findClaude();
    if (!bin) throw new Error(t('claude.not_found'));
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', OWNED_SETTINGS];
    if (this.model) args.push('--model', this.model);
    if (this.resume) args.push('--resume', this.resume);
    if (this.resume && this.fork) args.push('--fork-session');
    this.proc = spawn(bin, args, { cwd: this.cwd, env: { ...process.env, LYDIA_SESSION: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d) => this.read(d));
    this.proc.stderr.on('data', () => {});
    this.proc.on('error', (err) => this.fail(err.message));
    this.proc.on('exit', () => {
      this.proc = null;
      if (this.busy) this.fail(t('session.ended'));
    });
  }

  send(text) {
    if (this.busy) return false;
    this.start();
    this.busy = true;
    this.onEvent({ type: 'state', state: 'working' });
    this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    return true;
  }

  read(chunk) {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const line of lines) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.session_id && e.session_id !== this.id) {
        this.id = e.session_id; // a fork gets its own id from the first event
        this.onEvent({ type: 'id', id: this.id });
      }
      if (e.type === 'result') {
        const u = e.usage || {};
        this.usage.input += u.input_tokens || 0;
        this.usage.output += u.output_tokens || 0;
        this.usage.cache += (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        this.usage.cost += e.total_cost_usd || 0;
        this.busy = false;
        this.onEvent({ type: 'usage', usage: this.usage });
        this.onEvent({ type: 'state', state: 'idle' });
        if (e.is_error) this.onEvent({ type: 'error', error: friendly(e.result) });
        else this.onEvent({ type: 'done', text: e.result || '' });
      }
    }
  }

  fail(message) {
    this.busy = false;
    this.onEvent({ type: 'state', state: 'idle' });
    this.onEvent({ type: 'error', error: friendly(message) });
  }

  close() {
    this.busy = false;
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill();
      this.proc = null;
    }
  }
}

function friendly(msg = '') {
  if (/not logged in|\/login/i.test(msg)) return t('session.login');
  return msg || t('session.failed');
}

// Model aliases the CLI understands; '' lets Claude Code pick its default.
const MODELS = () => [
  { id: '', label: t('model.default') },
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

module.exports = { OwnedSession, MODELS };
