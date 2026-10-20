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
        if (err.name !== 'AbortError') this.finish({ text: '', error: this.explain(err), status: err.status, auto: !this.model });
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
const resting = new Map(); // model -> until when: overloaded (503) or silent, skip it for a while
let lastGood = ''; // the model that answered last: tried first next time
const REST_MS = 10 * 60_000;
const START_MS = 15_000; // a model that hasn't started answering by then is skipped
const HEDGE_MS = 4_000; // ...but after this long the next one already joins the race

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
  const now = Date.now();
  const ok = geminiList.filter((m) => !blocked.has(m));
  const fresh = ok.filter((m) => !(resting.get(m) > now));
  const order = fresh.length ? fresh : ok; // all resting: try them anyway
  return lastGood && order.includes(lastGood) ? [lastGood, ...order.filter((m) => m !== lastGood)] : order;
}

/**
 * Gemini 2.5 and 3 think before answering, which can take 10 s or more. For a
 * quick chat: as little as each model allows (flash: minimal, pro: low).
 */
function thinkingFor(model) {
  if (/gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/gemini-(\d+(\.\d+)?-)?pro/.test(model)) return /2\.5/.test(model) ? null : { thinkingLevel: 'low' };
  if (/-latest$/.test(model)) return { thinkingLevel: 'low' }; // the aliases may point at a model without "minimal"
  if (/gemini-3/.test(model)) return { thinkingLevel: 'minimal' };
  return null;
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

/**
 * A model out of quota (429): each Gemini model has its own, so the next one
 * is tried. It rests until the quota comes back: no free quota at all ->
 * never this run; daily -> some hours; per minute -> what Google says (or 1 min).
 */
function quotaRest(model, body) {
  const q = quotaOf(body);
  if (q.none) return blocked.add(model);
  resting.set(model, Date.now() + (q.daily ? 6 * 3600_000 : Math.max(60, q.retry || 60) * 1000));
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

  /** One request; aborted if the model hasn't started answering within START_MS. */
  async request(model, signal, thinking = true, cancel = null) {
    const config = thinking && thinkingFor(model);
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: persona() }] },
      contents: this.history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
      ...(config ? { generationConfig: { thinkingConfig: config } } : {}),
    });
    const ac = new AbortController();
    const stop = () => ac.abort();
    signal.addEventListener('abort', stop);
    cancel?.addEventListener('abort', stop);
    const timer = setTimeout(() => ac.abort(new Error('slow')), START_MS);
    try {
      const res = await fetch(`${GEMINI}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.key },
        body,
        signal: ac.signal,
      });
      // Some models don't take a thinking setting: ask again without it.
      if (res.status === 400 && config) {
        const text = await res.text();
        if (/thinking/i.test(text)) return this.request(model, signal, false, cancel);
        return { res, text };
      }
      return { res, text: res.ok ? '' : await res.text() };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      cancel?.removeEventListener('abort', stop);
    }
  }

  /** The model the user picked: its answer, or why not. */
  async only(model, signal) {
    let r;
    try {
      r = await this.request(model, signal);
    } catch (err) {
      if (err?.message === 'slow') throw Object.assign(new HttpError(503, ''), { model }); // explained as "overloaded"
      throw err;
    }
    if (r.res.ok) return { res: r.res, model };
    throw Object.assign(new HttpError(r.res.status, r.text), { model });
  }

  /**
   * Automatic: the models race. The best one starts; if it hasn't started
   * answering within HEDGE_MS (or fails), the next one joins, and so on. The
   * first to answer wins and the others are cancelled. Overloaded (503) or
   * silent models rest for a while; ones with no free quota are dropped.
   */
  race(models, signal) {
    return new Promise((resolve, reject) => {
      const attempts = new Map(); // model -> AbortController
      let next = 0;
      let done = false;
      let last = null;
      let hedge = 0;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(hedge);
        for (const ac of attempts.values()) ac.abort();
        fn(value);
      };
      const launch = () => {
        clearTimeout(hedge);
        if (done) return;
        if (next >= models.length) {
          if (!attempts.size) finish(reject, last ?? new HttpError(503, ''));
          return;
        }
        const model = models[next++];
        const ac = new AbortController();
        attempts.set(model, ac);
        if (next > 1) this.onState('retrying'); // a second model joined: say why it's taking long
        hedge = setTimeout(() => attempts.size < 3 && launch(), HEDGE_MS); // at most 3 at once
        this.request(model, signal, true, ac.signal).then(
          ({ res, text }) => {
            attempts.delete(model);
            if (done) return res.body?.cancel?.();
            if (res.ok) return finish(resolve, { res, model });
            if (process.env.LYDIA_DEBUG) console.log(`[lydia] gemini ${model} -> ${res.status} ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
            last = Object.assign(new HttpError(res.status, text), { model });
            if (res.status === 429) quotaRest(model, text); // this model's quota is used up: the next one has its own
            else if (res.status === 503) resting.set(model, Date.now() + REST_MS); // overloaded right now
            else if (!attempts.size) return finish(reject, last); // a real error, nothing else running
            else return;
            launch();
          },
          (err) => {
            attempts.delete(model);
            if (done) return;
            if (signal.aborted) return finish(reject, err);
            if (err?.message !== 'slow') {
              if (!attempts.size) finish(reject, err); // offline
              return;
            }
            if (process.env.LYDIA_DEBUG) console.log(`[lydia] gemini ${model} -> no answer in ${START_MS / 1000} s`);
            resting.set(model, Date.now() + REST_MS);
            last = Object.assign(new HttpError(503, ''), { model }); // explained as "overloaded"
            launch();
          },
        );
      };
      signal.addEventListener('abort', () => finish(reject, signal.reason ?? new Error('aborted')), { once: true });
      launch();
    });
  }

  async stream(delta, signal) {
    const { res, model } = this.model ? await this.only(this.model, signal) : await this.race(await geminiCandidates(this.key, ''), signal);
    this.used = lastGood = model;
    if (process.env.LYDIA_DEBUG) console.log(`[lydia] gemini ${model} answering (thinking: ${JSON.stringify(thinkingFor(model))})`);
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

/**
 * One non-streaming Gemini call (for function calling): the candidates in
 * order, skipping overloaded or silent ones like the chat does.
 * -> { parts: [...], model } or throws HttpError.
 */
async function geminiGenerate(key, body) {
  // The same race as the chat: the best model starts, the next joins after HEDGE_MS
  // (at most 3 at once), the first good answer wins.
  const models = await geminiCandidates(key, '');
  return new Promise((resolve, reject) => {
    const running = new Map();
    let next = 0;
    let done = false;
    let last = null;
    let hedge = 0;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(hedge);
      for (const ac of running.values()) ac.abort();
      fn(v);
    };
    const launch = () => {
      clearTimeout(hedge);
      if (done) return;
      if (next >= models.length) return void (!running.size && finish(reject, last ?? new HttpError(503, '')));
      const model = models[next++];
      const ac = new AbortController();
      running.set(model, ac);
      hedge = setTimeout(() => running.size < 3 && launch(), HEDGE_MS);
      const config = thinkingFor(model);
      const call = (thinking) =>
        fetch(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ ...body, ...(thinking && config ? { generationConfig: { ...(body.generationConfig ?? {}), thinkingConfig: config } } : {}) }),
          signal: ac.signal,
        });
      const timer = setTimeout(() => ac.abort(new Error('slow')), START_MS);
      // a model that doesn't take that thinking setting: ask it again without
      call(true)
        .then(async (res) => (res.status === 400 && config && /thinking/i.test(await res.clone().text()) ? call(false) : res))
        .then(async (res) => {
          clearTimeout(timer);
          running.delete(model);
          if (done) return;
          if (res.ok) {
            lastGood = model;
            const data = await res.json();
            if (process.env.LYDIA_DEBUG) console.log(`[lydia] gemini tools ${model} -> ok`);
            return finish(resolve, { parts: data.candidates?.[0]?.content?.parts ?? [], model });
          }
          const text = await res.text();
          if (process.env.LYDIA_DEBUG) console.log(`[lydia] gemini tools ${model} -> ${res.status} ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
          last = Object.assign(new HttpError(res.status, text), { model });
          if (res.status === 429) quotaRest(model, text);
          else if (res.status === 503) resting.set(model, Date.now() + REST_MS);
          else if (!running.size) return finish(reject, last);
          else return;
          launch();
        })
        .catch((err) => {
          clearTimeout(timer);
          running.delete(model);
          if (done) return;
          if (err?.message !== 'slow' && err?.cause?.message !== 'slow' && ac.signal.reason?.message !== 'slow') return void (!running.size && finish(reject, err));
          if (process.env.LYDIA_DEBUG) console.log(`[lydia] gemini tools ${model} -> no answer in ${START_MS / 1000} s`);
          resting.set(model, Date.now() + REST_MS);
          last = Object.assign(new HttpError(503, ''), { model });
          launch();
        });
    };
    launch();
  });
}

module.exports = { GeminiChat, OllamaChat, ollamaModels, geminiModels, stopOllama, geminiGenerate };
