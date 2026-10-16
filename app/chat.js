const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { t } = require('./i18n');

// Who she is, in the interface's language (she still answers in the user's).
const persona = () => t('persona');

function findClaude() {
  for (const p of [path.join(os.homedir(), '.local/bin/claude'), '/usr/local/bin/claude', '/usr/bin/claude']) {
    if (fs.existsSync(p)) return p;
  }
  try {
    return execFileSync('sh', ['-lc', 'command -v claude']).toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * One temporary conversation: a `claude -p` process kept alive between turns
 * (stream-json in and out), with no tools and nothing saved to disk. Closing it
 * forgets everything, like a temporary chat.
 *
 * Events: onDelta(text), onDone({ text, error }), onState('thinking' | 'speaking' | 'idle').
 */
class ChatSession {
  constructor({ onDelta, onDone, onState, model }) {
    this.onDelta = onDelta;
    this.onDone = onDone;
    this.onState = onState;
    this.model = model;
    this.proc = null;
    this.buf = '';
    this.reply = '';
    this.busy = false;
  }

  start() {
    if (this.proc) return;
    const bin = findClaude();
    if (!bin) throw new Error(t('claude.not_found'));
    const dir = path.join(os.homedir(), '.cache', 'lydia', 'chat');
    fs.mkdirSync(dir, { recursive: true });
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--no-session-persistence',
      '--tools', '',
      '--system-prompt', persona(),
    ];
    if (this.model) args.push('--model', this.model);
    this.proc = spawn(bin, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d) => this.read(d));
    this.proc.stderr.on('data', () => {});
    this.proc.on('error', (err) => this.fail(err.message));
    this.proc.on('exit', () => {
      this.proc = null;
      if (this.busy) this.fail(t('claude.interrupted'));
    });
  }

  send(text) {
    if (this.busy) return false;
    this.start();
    this.busy = true;
    this.reply = '';
    this.onState('thinking');
    const msg = { type: 'user', message: { role: 'user', content: text } };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
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
      if (e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta') {
        if (!this.reply) this.onState('speaking');
        this.reply += e.event.delta.text;
        this.onDelta(e.event.delta.text);
      } else if (e.type === 'result') {
        const text = this.reply || e.result || '';
        this.busy = false;
        this.onState('idle');
        if (e.is_error) this.onDone({ text: '', error: friendly(e.result) });
        else this.onDone({ text });
      }
    }
  }

  fail(message) {
    this.busy = false;
    this.onState('idle');
    this.onDone({ text: '', error: friendly(message) });
  }

  /** Forget the conversation. */
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
  if (/not logged in|\/login/i.test(msg)) return t('claude.login');
  return msg || t('claude.failed');
}

// Model aliases the claude command understands; '' lets it pick its default.
const MODELS = () => [
  { id: '', label: t('model.default') },
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

module.exports = { ChatSession, MODELS, persona, findClaude };
