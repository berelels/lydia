const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { unpacked } = require('../paths');

/**
 * Hearing and speaking, all on this computer.
 * - listen(): records from the default microphone (pw-record, 16 kHz mono)
 *   until you stop talking; the audio never touches the disk except one
 *   temporary WAV in the RAM-backed runtime dir, deleted right after.
 * - transcribe(): whisper.cpp, if installed in ~/.local/share/lydia/voice.
 * - speak(): a Gemini voice when main gave one (setCloud: it sounds the most
 *   human), else Kokoro, a local female voice, if installed there
 *   (kokoro_server.py keeps it loaded). Without either she shows her answers
 *   instead of saying them.
 */

const HOME = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'lydia', 'voice');
const RUN = process.env.XDG_RUNTIME_DIR || os.tmpdir();
const RATE = 16000;

const paths = {
  whisper: path.join(HOME, 'whisper-cli'),
  model: path.join(HOME, 'ggml-small.bin'),
  python: path.join(HOME, 'kokoro', 'bin', 'python'), // its own venv: kokoro-onnx and onnxruntime
  kokoro: path.join(HOME, 'kokoro-v1.0.onnx'),
  voices: path.join(HOME, 'voices-v1.0.bin'),
  server: unpacked(path.join(__dirname, 'kokoro_server.py')),
};

const can = {
  hear: () => fs.existsSync(paths.whisper) && fs.existsSync(paths.model),
  speak: () => fs.existsSync(paths.python) && fs.existsSync(paths.kokoro) && fs.existsSync(paths.voices),
};

// ---------- listening ----------

/**
 * Records until silence follows speech (or `max` ms, or stop()). Calls
 * onLevel(0..1) as you talk, for the "listening" animation.
 * Resolves the WAV path, or null if nobody spoke; dead() says the mic gave pure silence.
 */
function listen({ onLevel = () => {}, max = 15_000, quietMs = 1100, waitMs = 6000 } = {}) {
  let stop = () => {};
  let peak = 0; // 0 all along: the microphone sends nothing at all (off, unplugged)
  const done = new Promise((resolve) => {
    const rec = spawn('pw-record', ['--rate', String(RATE), '--channels', '1', '--format', 's16', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    let bytes = 0;
    let spoke = false;
    let quietSince = 0;
    let noise = 0; // the room's level, learned in the first moments
    let samples = 0;
    const started = Date.now();
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      rec.kill('SIGINT');
      if (!spoke) return resolve(null);
      let pcm = Buffer.concat(chunks, bytes);
      if (pcm.subarray(0, 4).toString() === 'RIFF') pcm = pcm.subarray(44); // some versions write a header
      const file = path.join(RUN, `lydia-voice-${process.pid}.wav`);
      fs.writeFileSync(file, Buffer.concat([wavHeader(pcm.length), pcm]), { mode: 0o600 });
      resolve(file);
    };
    stop = finish;
    const timer = setTimeout(finish, max);
    rec.on('error', () => resolve(null));
    rec.stdout.on('data', (buf) => {
      if (over) return; // audio still in the pipe after the end: it would say "listening" again
      chunks.push(buf);
      bytes += buf.length;
      // loudness of this chunk (RMS of 16-bit samples)
      let sum = 0;
      const n = Math.floor(buf.length / 2);
      for (let i = 0; i < n; i++) {
        const v = buf.readInt16LE(i * 2) / 32768;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / Math.max(1, n));
      peak = Math.max(peak, rms);
      samples++;
      if (samples < 6) noise = Math.max(noise, rms); // ~the first 0.3 s
      const loud = rms > Math.max(0.02, noise * 2.2);
      onLevel(Math.min(1, rms * 8));
      const now = Date.now();
      if (loud) {
        spoke = true;
        quietSince = 0;
      } else if (spoke) {
        quietSince ||= now;
        if (now - quietSince > quietMs) finish();
      } else if (now - started > waitMs) finish();
    });
  });
  return { done, stop: () => stop(), dead: () => peak === 0 };
}

function wavHeader(dataLen, rate = RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}

// ---------- transcription ----------

// Names whisper gets wrong without a hint ("espotifai", "a ce dece").
const VOCABULARY = 'Lydia, Spotify, YouTube, Chrome, Brave, Firefox, VS Code, Discord, WhatsApp, Telegram, AC/DC, Wi-Fi, Bluetooth.';

/** WAV -> text with whisper.cpp; the file is deleted either way. `prompt`: words to expect (false: none). */
function transcribe(file, lang = 'pt', { prompt = VOCABULARY } = {}) {
  return new Promise((resolve) => {
    if (!can.hear()) {
      fs.rmSync(file, { force: true });
      return resolve({ error: 'no-stt' });
    }
    const threads = String(Math.max(2, Math.min(8, os.cpus().length - 2)));
    execFile(paths.whisper, ['-m', paths.model, '-f', file, '-l', lang, '-t', threads, '-nt', '-np', ...(prompt ? ['--prompt', prompt] : [])], { timeout: 60_000, maxBuffer: 1 << 20 }, (err, out) => {
      fs.rmSync(file, { force: true });
      if (err) return resolve({ error: 'stt-failed' });
      const text = String(out).replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(); // drop "[Música]", "(risos)"
      resolve({ text });
    });
  });
}

// ---------- speaking ----------

let server = null; // the Kokoro process, loaded once (the model takes a few seconds)
let ready = null;
let nextId = 0;
const waiting = new Map(); // id -> resolve({ wav } | { error })

const IDLE_MS = 10 * 60_000; // unloaded after this long unused (the model holds a few hundred MB)
let idleTimer = 0;
function kokoro() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => server?.kill(), IDLE_MS);
  if (server) return ready;
  server = spawn(paths.python, [paths.server, paths.kokoro, paths.voices], { stdio: ['pipe', 'pipe', 'ignore'] });
  ready = new Promise((resolve) => {
    let buf = '';
    server.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.ready) resolve(true);
        else waiting.get(m.id)?.(m), waiting.delete(m.id);
      }
    });
    server.on('error', () => resolve(false));
    server.on('exit', () => {
      server = null;
      resolve(false);
      for (const done of waiting.values()) done({ error: 'stopped' });
      waiting.clear();
    });
  });
  return ready;
}

function synth(text, lang) {
  return new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    server.stdin.write(JSON.stringify({ id, text, lang }) + '\n');
  });
}

let playing = null;
let generation = 0; // bumped by shutUp(): pending sentences are dropped
const play = (wav) =>
  new Promise((resolve) => {
    playing = spawn('pw-play', [wav], { stdio: 'ignore' });
    playing.on('error', resolve);
    playing.on('exit', () => {
      playing = null;
      fs.rmSync(wav, { force: true });
      resolve();
    });
  });

/** Raw PCM pieces into pw-play as they arrive. */
async function playStream({ rate, chunks, stop }, mine) {
  const p = spawn('pw-play', ['--rate', String(rate), '--channels', '1', '--format', 's16', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
  playing = p;
  const ended = new Promise((resolve) => p.on('exit', resolve).on('error', resolve));
  p.stdin.on('error', () => {});
  for await (const pcm of chunks) {
    if (mine !== generation || p.exitCode !== null) {
      stop();
      break;
    }
    p.stdin.write(pcm);
  }
  p.stdin.end();
  await ended;
  if (playing === p) playing = null;
}

/** Sentences, so the first one plays while the next ones are being made. */
const sentences = (text) => text.match(/[^.!?…]+[.!?…]*\s*/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];

// main sets it when there is a Gemini key: (text, lang) -> { pcm, rate } or throws
let cloud = null;
const setCloud = (fn) => (cloud = fn);

/** Says `text` aloud; resolves when done. A new call interrupts the previous one. */
async function speak(text, lang = 'pt') {
  shutUp();
  const mine = generation;
  const clean = String(text).replace(/[*_`#>]/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 800);
  if (!clean) return;
  if (cloud) {
    // the whole answer in one request (the free quota is small, the intonation more natural), played as it streams in
    let r = null;
    try {
      r = await cloud(clean, lang);
    } catch {} // no key, no quota, too slow: the local voice below
    if (r) {
      if (mine !== generation) return r.stop();
      return playStream(r, mine);
    }
    if (mine !== generation) return;
  }
  if (!can.speak() || !(await kokoro())) return;
  const parts = sentences(clean).map((s) => synth(s, lang)); // all start now, play in order
  for (const part of parts) {
    const r = await part;
    if (mine !== generation) {
      if (r.wav) fs.rmSync(r.wav, { force: true });
      continue;
    }
    if (r.wav) await play(r.wav);
  }
}
function shutUp() {
  generation++;
  playing?.kill();
  playing = null;
}
/** Starts loading the voice ahead of time (when listening begins). */
const warmUp = () => can.speak() && kokoro(); // also with the Gemini voice: it is the fallback

/** Stops the voice process (on quit). */
function stopVoice() {
  shutUp();
  clearTimeout(idleTimer);
  server?.kill();
}

// ---------- the microphone ----------

const wpctl = (args) => new Promise((r) => execFile('wpctl', args, { timeout: 3000 }, (err, out) => r(err ? '' : String(out))));
/** Is the default microphone muted? (then it records silence) */
const micMuted = async () => /MUTED/.test(await wpctl(['get-volume', '@DEFAULT_AUDIO_SOURCE@']));
/** Only when the user asks for it (the "turn on the microphone" button). */
const unmuteMic = () => wpctl(['set-mute', '@DEFAULT_AUDIO_SOURCE@', '0']);

module.exports = { listen, transcribe, speak, shutUp, stopVoice, warmUp, micMuted, unmuteMic, setCloud, can, paths, HOME };
