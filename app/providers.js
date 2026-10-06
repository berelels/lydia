const { persona } = require('./chat');
const { t } = require('./i18n');

/**
 * Chat engines other than Claude. Same shape as ChatSession: send(text),
 * close(), and onDelta / onDone / onState callbacks. The conversation only
 * lives in `history`, in memory: closing the session forgets it.
 */
class HistoryChat {
  constructor({ onDelta, onDone, onState }) {
    this.onDelta = onDelta;
    this.onDone = onDone;
    this.onState = onState;
    this.history = []; // { role: 'user' | 'assistant', text }
    this.busy = false;
    this.abort = null;
  }

  send(text) {
    if (this.busy) return false;
    this.busy = true;
    this.history.push({ role: 'user', text });
    this.onState('thinking');
    this.abort = new AbortController();
    let reply = '';
    const delta = (t) => {
      if (!t) return;
      if (!reply) this.onState('speaking');
      reply += t;
      this.onDelta(t);
    };
    this.stream(delta, this.abort.signal)
      .then(() => {
        this.history.push({ role: 'assistant', text: reply });
        this.finish({ text: reply });
      })
      .catch((err) => {
        this.history.pop(); // the question goes unanswered: let it be asked again
        if (err.name !== 'AbortError') this.finish({ text: '', error: this.explain(err) });
      });
    return true;
  }

  finish(result) {
    this.busy = false;
    this.onState('idle');
    this.onDone(result);
  }

  close() {
    this.abort?.abort();
    this.busy = false;
    this.history = [];
  }
}

/** Reads a fetch body line by line. */
async function* lines(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) yield buf.trim();
}

// ---------- Gemini (Google AI Studio key) ----------

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
let geminiList = null; // models this key can call, best first
const blocked = new Set(); // models that answered "no free quota" (limit 0) this run

/** Flash models to try, best first: newest stable, then lite, then previews. */
async function geminiCandidates(key, wanted) {
  if (wanted) return [wanted];
  if (!geminiList) {
    const res = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw new HttpError(res.status, await res.text());
    const { models = [] } = await res.json();
    const names = chatModelsOf(models).filter((n) => /flash/.test(n));
    // The -latest alias first, then the newest numbered flash, then the lite ones.
    const rank = (n) => (n === 'gemini-flash-latest' ? 0 : /lite/.test(n) ? 2 : /(preview|exp)/.test(n) ? 3 : 1);
    geminiList = names.sort((a, b) => rank(a) - rank(b) || b.localeCompare(a, undefined, { numeric: true }));
    if (!geminiList.length) geminiList = ['gemini-flash-latest'];
  }
  return geminiList.filter((m) => !blocked.has(m));
}

/** Plain text chat models: "gemini-3.8-flash", "gemini-flash-latest", "gemini-pro-latest"... not omni, robotics, image, audio. */
function chatModelsOf(models) {
  return models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini-(\d+(\.\d+)?-)?(flash|pro)(-lite)?(-latest|-preview[\w-]*)?$/.test(n));
}

/** What a 429 says: no free quota at all for this model, the daily one used up, or "wait N s". */
function quotaOf(body) {
  try {
    const e = JSON.parse(body).error ?? {};
    const details = e.details ?? [];
    const v = details.flatMap((d) => d.violations ?? []);
    const retry = details.find((d) => /RetryInfo/.test(d['@type'] ?? ''))?.retryDelay;
    return {
      none: /limit: 0\b/.test(e.message ?? ''),
      daily: v.some((x) => /PerDay/i.test(x.quotaId ?? '')),
      retry: retry ? Math.ceil(parseFloat(retry)) : 0,
      model: v.find((x) => x.quotaDimensions?.model)?.quotaDimensions.model ?? '',
    };
  } catch {
    return { none: false, daily: false, retry: 0, model: '' };
  }
}

/** Text models this key can use, newest first (for the model picker). */
async function geminiModels(key) {
  const res = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(4000) });
  if (!res.ok) return [];
  const { models = [] } = await res.json();
  return chatModelsOf(models)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .slice(0, 12);
}

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

class GeminiChat extends HistoryChat {
  constructor(opts) {
    super(opts);
    this.key = opts.key;
    this.model = opts.model;
  }

  async stream(delta, signal) {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: persona() }] },
      contents: this.history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
    });
    // A model with no free quota for this account (429, "limit: 0") is skipped
    // for the next one; any other error stops here.
    let res;
    let last;
    for (const model of await geminiCandidates(this.key, this.model)) {
      res = await fetch(`${GEMINI}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.key },
        body,
        signal,
      });
      if (res.ok) {
        this.used = model;
        break;
      }
      const text = await res.text();
      if (process.env.LYDIA_DEBUG) console.log(`[lydia] gemini ${model} -> ${res.status} ${text.slice(0, 600).replace(/\s+/g, ' ')}`);
      last = new HttpError(res.status, text);
      last.model = model;
      if (res.status === 429 && quotaOf(text).none && !this.model) {
        blocked.add(model); // no free quota for this one on this account
        continue;
      }
      if (res.status === 503 && !this.model) continue; // overloaded right now: try the next
      throw last;
    }
    if (!res?.ok) throw last ?? new HttpError(429, '');
    for await (const line of lines(res)) {
      if (!line.startsWith('data:')) continue;
      try {
        const e = JSON.parse(line.slice(5));
        for (const part of e.candidates?.[0]?.content?.parts ?? []) if (!part.thought) delta(part.text);
      } catch {}
    }
  }

  explain(err) {
    if (err.status === 400 && /API key/i.test(err.body || '')) return t('gemini.bad_key');
    if (err.status === 401) return t('gemini.401');
    if (err.status === 403) return t('gemini.403');
    if (err.status === 429) {
      const q = quotaOf(err.body);
      if (q.none) return t('gemini.no_quota');
      if (q.daily) return t('gemini.daily', { model: q.model || err.model });
      if (q.retry) return t('gemini.retry', { s: q.retry });
      return t('gemini.429');
    }
    if (err.status === 503) return t('gemini.503');
    if (err.status) return t('gemini.status', { status: err.status });
    return t('gemini.offline');
  }
}

// ---------- Ollama (local) ----------

const OLLAMA = 'http://127.0.0.1:11434';
const { spawn } = require('child_process');
let ollamaProc = null; // the server Lydia started (if it wasn't running already)

const ollamaUp = () => fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok, () => false);

/** Starts `ollama serve` if nothing answers, and waits for it (a few seconds at most). */
async function ensureOllama() {
  if (await ollamaUp()) return true;
  if (!ollamaProc) {
    ollamaProc = spawn('ollama', ['serve'], { stdio: 'ignore' });
    ollamaProc.on('error', () => (ollamaProc = null));
    ollamaProc.on('exit', () => (ollamaProc = null));
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await ollamaUp()) return true;
  }
  return false;
}

/** Stops the server only if Lydia started it; the model leaves memory with it. */
function stopOllama() {
  ollamaProc?.kill();
  ollamaProc = null;
}

async function ollamaModels() {
  const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) });
  const { models = [] } = await res.json();
  return models.map((m) => m.name);
}

class OllamaChat extends HistoryChat {
  constructor(opts) {
    super(opts);
    this.model = opts.model;
  }

  async stream(delta, signal) {
    if (!(await ensureOllama())) throw Object.assign(new Error('down'), { code: 'DOWN' });
    const model = this.model || (await ollamaModels())[0];
    if (!model) throw Object.assign(new Error('no model'), { code: 'NO_MODEL' });
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'system', content: persona() }, ...this.history.map((m) => ({ role: m.role, content: m.text }))],
      }),
      signal,
    });
    if (!res.ok) throw new HttpError(res.status, await res.text());
    for await (const line of lines(res)) {
      try {
        delta(JSON.parse(line).message?.content);
      } catch {}
    }
  }

  explain(err) {
    if (err.code === 'NO_MODEL') return t('ollama.no_model');
    if (err.status === 404) return t('ollama.404');
    return t('ollama.down');
  }
}

module.exports = { GeminiChat, OllamaChat, ollamaModels, geminiModels, stopOllama };
