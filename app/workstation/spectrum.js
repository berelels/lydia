const { spawn } = require('child_process');

/**
 * A live audio visualizer for the music player: it listens to the sound
 * output (the default speaker's monitor) at a low rate, only while a player
 * shows it, and turns each slice of sound into a few bands, bass to treble,
 * each 0..1. Nothing is stored or sent anywhere.
 */

const RATE = 11025;
const SIZE = 512; // samples per slice: ~46 ms, ~21 updates a second
const LOW = 50; // Hz: the bands go from here...
const HIGH = 5000; // ...to here, spaced like hearing (log)

/** In-place radix-2 FFT of re/im (length a power of two). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** One slice of samples (-1..1, SIZE long) -> `count` band loudnesses in dB, bass first. */
function bands(samples, count, rate = RATE) {
  const n = samples.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = samples[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))); // Hann
  fft(re, im);
  const hz = rate / n;
  const out = [];
  for (let b = 0; b < count; b++) {
    const f0 = LOW * (HIGH / LOW) ** (b / count);
    const f1 = LOW * (HIGH / LOW) ** ((b + 1) / count);
    const k0 = Math.max(1, Math.floor(f0 / hz));
    const k1 = Math.max(k0 + 1, Math.ceil(f1 / hz));
    let peak = 0;
    for (let k = k0; k < k1 && k < n / 2; k++) peak = Math.max(peak, Math.hypot(re[k], im[k]));
    out.push(20 * Math.log10(peak / (n / 4) + 1e-9));
  }
  return out;
}

class Spectrum {
  constructor(onLevels, count = 32) {
    this.onLevels = onLevels;
    this.count = count;
    this.proc = null;
    this.rest = Buffer.alloc(0);
    this.top = -20; // the loudest lately (dB): levels are relative to it, so quiet songs move too
  }

  get running() {
    return !!this.proc;
  }

  start() {
    if (this.proc) return;
    const p = spawn('parec', ['-d', '@DEFAULT_SINK@.monitor', `--rate=${RATE}`, '--channels=1', '--format=s16le', '--latency-msec=40'], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.proc = p;
    p.on('error', () => this.stop());
    p.on('exit', () => this.proc === p && this.stop());
    p.stdout.on('data', (chunk) => this.feed(chunk));
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
    this.rest = Buffer.alloc(0);
  }

  feed(chunk) {
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const bytes = SIZE * 2;
    let off = 0;
    let last = null;
    for (; off + bytes <= buf.length; off += bytes) {
      const s = new Float64Array(SIZE);
      for (let i = 0; i < SIZE; i++) s[i] = buf.readInt16LE(off + i * 2) / 32768;
      last = bands(s, this.count);
    }
    this.rest = buf.subarray(off);
    if (!last) return; // only the newest slice is drawn
    const loudest = Math.max(...last);
    this.top = Math.max(loudest, this.top - 0.15); // follows the song's loudness down slowly
    const range = 36; // dB shown below the top
    this.onLevels(last.map((db) => Math.round(Math.max(0, Math.min(1, (db - (this.top - range)) / range)) * 100) / 100));
  }
}

module.exports = { Spectrum, bands, fft, RATE, SIZE };
