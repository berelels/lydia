const { spawn } = require('child_process');

/**
 * The tempo of what is playing, so the music card's wave moves with it.
 * It listens to the sound output (the default speaker's monitor) at a low
 * rate, only while something plays and the card or the player is visible;
 * nothing is stored or sent anywhere. From the loudness over time it finds
 * the beats' rhythm (autocorrelation of the onsets) and reports beats per minute.
 */

const RATE = 11025;
const HOP = 256; // samples per loudness frame: ~23 ms
const FPS = RATE / HOP;
const WINDOW_S = 8; // how much of the past the rhythm is read from

/**
 * Beats per minute from an onset curve (how much louder each frame got), or
 * null when there is no clear pulse. Between 60 and 180; tempos near 120 are
 * slightly preferred, so a beat isn't mistaken for half or double of itself.
 */
function estimateBpm(onsets, fps = FPS) {
  const n = onsets.length;
  if (n < fps * 3) return null;
  const mean = onsets.reduce((a, b) => a + b, 0) / n;
  const x = onsets.map((v) => v - mean);
  const energy = x.reduce((a, v) => a + v * v, 0);
  if (energy < 1e-6) return null;
  // how alike the curve is to itself `lag` frames later (fractional lags interpolated)
  const ac = (lag) => {
    const l0 = Math.floor(lag);
    const frac = lag - l0;
    let sum = 0;
    for (let i = 0; i + l0 + 1 < n; i++) sum += x[i] * (x[i + l0] * (1 - frac) + x[i + l0 + 1] * frac);
    return sum / energy;
  };
  let best = null;
  for (let bpm = 60; bpm <= 180; bpm += 1) {
    const lag = (60 / bpm) * fps;
    // the beat and the bar of two: a real tempo repeats at both, half of it only at the second
    const corr = Math.max(ac(lag - 0.5), ac(lag), ac(lag + 0.5));
    const twice = Math.max(ac(2 * lag - 0.5), ac(2 * lag), ac(2 * lag + 0.5));
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = (corr + 0.5 * twice) * prior;
    if (!best || score > best.score) best = { bpm, score, corr };
  }
  return best && best.corr > 0.08 ? best.bpm : null;
}

class Tempo {
  constructor(onBpm) {
    this.onBpm = onBpm;
    this.proc = null;
    this.onsets = [];
    this.recent = []; // the last few estimates: the middle one is reported (steadier)
    this.prev = 0; // the previous frame's loudness
    this.rest = Buffer.alloc(0);
    this.timer = 0;
  }

  get running() {
    return !!this.proc;
  }

  start() {
    if (this.proc) return;
    const p = spawn('parec', ['-d', '@DEFAULT_SINK@.monitor', `--rate=${RATE}`, '--channels=1', '--format=s16le', '--latency-msec=60'], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.proc = p;
    p.on('error', () => this.stop());
    p.on('exit', () => this.proc === p && this.stop());
    p.stdout.on('data', (chunk) => this.feed(chunk));
    this.timer = setInterval(() => this.report(), 1500);
  }

  stop() {
    clearInterval(this.timer);
    this.proc?.kill();
    this.proc = null;
    this.onsets = [];
    this.recent = [];
    this.rest = Buffer.alloc(0);
  }

  /** Raw samples in: loudness per frame, and how much it rose (the onsets). */
  feed(chunk) {
    let buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const frameBytes = HOP * 2;
    let off = 0;
    for (; off + frameBytes <= buf.length; off += frameBytes) {
      let sum = 0;
      for (let i = 0; i < HOP; i++) {
        const v = buf.readInt16LE(off + i * 2) / 32768;
        sum += v * v;
      }
      const loud = Math.log1p(1000 * Math.sqrt(sum / HOP));
      this.onsets.push(Math.max(0, loud - this.prev));
      this.prev = loud;
    }
    this.rest = buf.subarray(off);
    const max = Math.round(WINDOW_S * FPS);
    if (this.onsets.length > max) this.onsets.splice(0, this.onsets.length - max);
  }

  report() {
    const bpm = estimateBpm(this.onsets);
    if (!bpm) return;
    this.recent = [...this.recent.slice(-2), bpm];
    const mid = [...this.recent].sort((a, b) => a - b)[Math.floor(this.recent.length / 2)];
    this.onBpm(mid);
  }
}

module.exports = { Tempo, estimateBpm, FPS };
