const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Hearing and speaking, all on this computer.
 * - listen(): records from the default microphone (pw-record, 16 kHz mono)
 *   until you stop talking; the audio never touches the disk except one
 *   temporary WAV in the RAM-backed runtime dir, deleted right after.
 * - transcribe(): whisper.cpp, if installed in ~/.local/share/lydia/voice.
 * - speak(): Kokoro, a natural female voice, if installed there (kokoro_server.py
 *   keeps it loaded). Without it she shows her answers instead of saying them.
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
  server: path.join(__dirname, 'kokoro_server.py'),
};

const can = {
  hear: () => fs.existsSync(paths.whisper) && fs.existsSync(paths.model),
  speak: () => fs.existsSync(paths.python) && fs.existsSync(paths.kokoro) && fs.existsSync(paths.voices),
};

// ---------- listening ----------

/**
 * Records until silence follows speech (or `max` ms, or stop()). Calls
 * onLevel(0..1) as you talk, for the "listening" animation.
 * Resolves the WAV path, or null if nobody spoke.
 */
function listen({ onLevel = () => {}, max = 15_000, quietMs = 1100, waitMs = 6000 } = {}) {
  let stop = () => {};
  const done = new Promise((resolve) => {
    const rec = spawn('pw-record', ['--rate', String(RATE), '--channels', '1', '--format', 's16', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    let bytes = 0;
    let spoke = false;
    let quietSince = 0;
    let noise = 0; // the room's level, learned in the first moments
    let samples = 0;
    const started = Date.now();
    const finish = () => {
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
  return { done, stop: () => stop() };
}

function wavHeader(dataLen) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}

// ---------- transcription ----------

/** WAV -> text with whisper.cpp; the file is deleted either way. */
function transcribe(file, lang = 'pt') {
  return new Promise((resolve) => {
    if (!can.hear()) {
      fs.rmSync(file, { force: true });
      return resolve({ error: 'no-stt' });
    }
    const threads = String(Math.max(2, Math.min(8, os.cpus().length - 2)));
    execFile(paths.whisper, ['-m', paths.model, '-f', file, '-l', lang, '-t', threads, '-nt', '-np'], { timeout: 60_000, maxBuffer: 1 << 20 }, (err, out) => {
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

/** Sentences, so the first one plays while the next ones are being made. */
const sentences = (text) => text.match(/[^.!?…]+[.!?…]*\s*/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];

/** Says `text` aloud; resolves when done. A new call interrupts the previous one. */
async function speak(text, lang = 'pt') {
  shutUp();
  const mine = generation;
  const clean = String(text).replace(/[*_`#>]/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 800);
  if (!clean || !can.speak() || !(await kokoro())) return;
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
const warmUp = () => can.speak() && kokoro();

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

module.exports = { listen, transcribe, speak, shutUp, stopVoice, warmUp, micMuted, unmuteMic, can, paths, HOME };
