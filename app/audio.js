const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Sound through whatever this computer runs: PipeWire's own tools (wpctl,
 * pw-record, pw-play) when PipeWire is the sound server, else PulseAudio's
 * (pactl, parec, pacat, paplay), which also talk to PipeWire through its
 * PulseAudio side. Ubuntu 22.04, Mint 21 and Debian 11 still run PulseAudio.
 */

const C = { ...process.env, LC_ALL: 'C' }; // "Volume:", "Mute: yes" in English, whatever the system language
const run = (cmd, args, timeout = 4000) => new Promise((r) => execFile(cmd, args, { timeout, env: C }, (err, out = '') => r(err ? null : String(out))));

const found = new Map();
/** Is `cmd` somewhere in PATH? */
function has(cmd) {
  if (!found.has(cmd)) {
    found.set(
      cmd,
      (process.env.PATH || '/usr/bin:/bin').split(':').some((dir) => {
        try {
          fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }),
    );
  }
  return found.get(cmd);
}

let pw = null;
/** PipeWire's tools, or PulseAudio's? Decided once. */
function pipewire() {
  if (pw === null) {
    let info = '';
    if (has('pactl')) {
      try {
        info = execFileSync('pactl', ['info'], { timeout: 1500, env: C }).toString();
      } catch {}
    }
    // pipewire-bin is installed on some PulseAudio systems too (Ubuntu 22.04): only use it when it's the server
    pw = has('wpctl') && has('pw-play') && (!info || /PipeWire/i.test(info));
  }
  return pw;
}

const NODE = { sink: ['@DEFAULT_AUDIO_SINK@', '@DEFAULT_SINK@'], source: ['@DEFAULT_AUDIO_SOURCE@', '@DEFAULT_SOURCE@'] };

/** { volume 0..100, muted } of the default output ('sink') or microphone ('source'); null without sound. */
async function level(kind) {
  if (pipewire()) {
    const out = await run('wpctl', ['get-volume', NODE[kind][0]]); // "Volume: 0.45 [MUTED]"
    const m = /Volume:\s+([\d.]+)/.exec(out ?? '');
    return m ? { volume: Math.round(Number(m[1]) * 100), muted: /MUTED/.test(out) } : null;
  }
  const [vol, mute] = await Promise.all([run('pactl', [`get-${kind}-volume`, NODE[kind][1]]), run('pactl', [`get-${kind}-mute`, NODE[kind][1]])]);
  const m = /(\d+)%/.exec(vol ?? ''); // "Volume: front-left: 29491 /  45% / -20.81 dB, ..."
  return m ? { volume: Number(m[1]), muted: /yes/.test(mute ?? '') } : null;
}

/** Sets the level (0..100); true if it worked. */
async function setLevel(kind, pct) {
  const v = `${Math.max(0, Math.min(100, Math.round(Number(pct))))}%`;
  const ok = pipewire() ? await run('wpctl', ['set-volume', NODE[kind][0], v]) : await run('pactl', [`set-${kind}-volume`, NODE[kind][1], v]);
  return ok !== null;
}

/** Mutes or unmutes; true if it worked. */
async function setMute(kind, on) {
  const ok = pipewire() ? await run('wpctl', ['set-mute', NODE[kind][0], on ? '1' : '0']) : await run('pactl', [`set-${kind}-mute`, NODE[kind][1], on ? '1' : '0']);
  return ok !== null;
}

/** Raw 16-bit mono PCM from the default microphone on stdout. */
function record(rate) {
  if (pipewire()) return spawn('pw-record', ['--rate', String(rate), '--channels', '1', '--format', 's16', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
  return spawn('parec', [`--rate=${rate}`, '--channels=1', '--format=s16le', '--latency-msec=40'], { stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Plays a WAV file. */
function playFile(wav) {
  return spawn(pipewire() ? 'pw-play' : 'paplay', [wav], { stdio: 'ignore' });
}

/** A player that takes raw 16-bit mono PCM on stdin. */
function playRaw(rate) {
  if (pipewire()) return spawn('pw-play', ['--rate', String(rate), '--channels', '1', '--format', 's16', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
  return spawn('pacat', ['--playback', `--rate=${rate}`, '--channels=1', '--format=s16le'], { stdio: ['pipe', 'ignore', 'ignore'] });
}

module.exports = { level, setLevel, setMute, record, playFile, playRaw, has };
