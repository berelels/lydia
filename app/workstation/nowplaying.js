const { execFile } = require('child_process');
const fs = require('fs');

/**
 * What is playing (MPRIS: Spotify, browsers, players), for the player in the
 * Controls tab and the music card on the closed bar: title, artist, cover,
 * position, and that app's own volume. Covers become data: URLs (the page only
 * loads its own files), cached by address.
 */

const exec = (cmd, args) => new Promise((r) => execFile(cmd, args, { timeout: 2500, env: { ...process.env, LC_ALL: 'C' } }, (err, out) => r(err ? '' : String(out))));
const gdbus = (args) => new Promise((r) => execFile('gdbus', ['call', '--session', ...args], { timeout: 2500 }, (err, out) => r(err ? '' : String(out))));
const PATH = ['--object-path', '/org/mpris/MediaPlayer2'];

async function players() {
  const out = await gdbus(['--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.ListNames']);
  return out.match(/org\.mpris\.MediaPlayer2\.[^']+/g) ?? [];
}

const str = (text, key) => new RegExp(`'${key}': <'((?:[^'\\\\]|\\\\.)*)'>`).exec(text)?.[1]?.replace(/\\'/g, "'") ?? '';
const list = (text, key) => new RegExp(`'${key}': <\\['((?:[^'\\\\]|\\\\.)*)'`).exec(text)?.[1] ?? '';
const num = (text, key) => Number(new RegExp(`'${key}': <(?:u?int64 |uint64 )?(-?\\d+)>`).exec(text)?.[1] ?? 0);

const covers = new Map(); // url -> data URL
async function cover(url) {
  if (!url) return '';
  if (covers.has(url)) return covers.get(url);
  let data = '';
  try {
    if (url.startsWith('file://')) {
      const file = decodeURIComponent(url.slice(7));
      data = `data:image/${file.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(file).toString('base64')}`;
    } else if (/^https:\/\//.test(url)) {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (res.ok) data = `data:${res.headers.get('content-type') || 'image/jpeg'};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
    }
  } catch {}
  if (covers.size > 30) covers.clear();
  covers.set(url, data);
  return data;
}

// ---------- that app's own volume (its audio stream), else the player's MPRIS volume ----------

/** Audio streams playing now: [{ index, name, binary, pid, volume, muted }] */
async function streams() {
  const out = await exec('pactl', ['list', 'sink-inputs']);
  return out
    .split(/^Sink Input #/m)
    .slice(1)
    .map((b) => ({
      index: Number(/^(\d+)/.exec(b)?.[1]),
      name: /application\.name = "([^"]*)"/.exec(b)?.[1] ?? '',
      binary: /application\.process\.binary = "([^"]*)"/.exec(b)?.[1] ?? '',
      pid: Number(/application\.process\.id = "(\d+)"/.exec(b)?.[1] ?? 0),
      volume: Number(/Volume:[^\n]*?(\d+)%/.exec(b)?.[1] ?? NaN),
      muted: /Mute: yes/.test(b),
    }));
}
/** The stream of a player: same process, else the same app by name ("Brave", "spotify"). */
function streamOf(list, p) {
  const keys = [p.app, p.identity].filter(Boolean).map((x) => x.toLowerCase());
  const pid = Number(/instance(\d+)$/.exec(p.player)?.[1] ?? 0);
  return list.find((s) => pid && s.pid === pid) ?? list.find((s) => keys.some((k) => `${s.name} ${s.binary}`.toLowerCase().includes(k))) ?? null;
}
const identities = new Map(); // player -> "Spotify", "Brave"
async function identity(player) {
  if (!identities.has(player)) {
    const out = await gdbus(['--dest', player, ...PATH, '--method', 'org.freedesktop.DBus.Properties.Get', 'org.mpris.MediaPlayer2', 'Identity']);
    identities.set(player, /'([^']*)'/.exec(out)?.[1] ?? '');
  }
  return identities.get(player);
}

/** The player to show: the one playing, else a paused one. null when nothing has media. */
async function nowPlaying() {
  const names = await players();
  const all = await Promise.all(
    names.map(async (name) => {
      const out = await gdbus(['--dest', name, ...PATH, '--method', 'org.freedesktop.DBus.Properties.GetAll', 'org.mpris.MediaPlayer2.Player']);
      return { name, out, status: str(out, 'PlaybackStatus') };
    }),
  );
  const p = all.find((x) => x.status === 'Playing') ?? all.find((x) => x.status === 'Paused' && str(x.out, 'xesam:title'));
  if (!p) return null;
  const length = num(p.out, 'mpris:length') / 1e6;
  const who = { player: p.name, app: p.name.replace('org.mpris.MediaPlayer2.', '').split('.')[0], identity: await identity(p.name) };
  const stream = streamOf(await streams(), who);
  const mprisVolume = Number(/'Volume': <([\d.]+)>/.exec(p.out)?.[1]);
  return {
    trackId: /'mpris:trackid': <(?:objectpath )?'([^']*)'>/.exec(p.out)?.[1] ?? '',
    canSeek: /'CanSeek': <true>/.test(p.out),
    // its own stream's volume (what the mixer shows for that app), else what the player says
    volume: stream ? stream.volume : Number.isFinite(mprisVolume) ? Math.round(mprisVolume * 100) : null,
    player: p.name,
    app: p.name.replace('org.mpris.MediaPlayer2.', '').split('.')[0],
    status: p.status,
    title: str(p.out, 'xesam:title'),
    artist: list(p.out, 'xesam:artist'),
    cover: await cover(str(p.out, 'mpris:artUrl')),
    length: length > 0 && length < 24 * 3600 ? length : 0, // lives report a huge length
    position: num(p.out, 'Position') / 1e6,
  };
}

/** Jump to `seconds` in the current track. */
async function seek(player, trackId, seconds) {
  if (!/^org\.mpris\.MediaPlayer2\.[\w.-]+$/.test(player) || !/^\/[\w/]*$/.test(trackId)) return;
  await gdbus(['--dest', player, ...PATH, '--method', 'org.mpris.MediaPlayer2.Player.SetPosition', `'${trackId}'`, String(Math.max(0, Math.round(seconds * 1e6)))]);
}

/** That app's volume (0-100): its audio stream in the mixer, else the player's MPRIS volume. */
async function setVolume(player, value) {
  if (!/^org\.mpris\.MediaPlayer2\.[\w.-]+$/.test(player)) return;
  const pct = Math.max(0, Math.min(100, Math.round(Number(value))));
  const who = { player, app: player.replace('org.mpris.MediaPlayer2.', '').split('.')[0], identity: await identity(player) };
  const stream = streamOf(await streams(), who);
  if (stream) await exec('pactl', ['set-sink-input-volume', String(stream.index), `${pct}%`]);
  else await gdbus(['--dest', player, ...PATH, '--method', 'org.freedesktop.DBus.Properties.Set', 'org.mpris.MediaPlayer2.Player', 'Volume', `<${pct / 100}>`]);
}

/** play / pause / next / previous on that player. */
async function control(player, action) {
  if (!/^org\.mpris\.MediaPlayer2\.[\w.-]+$/.test(player)) return;
  const method = { play: 'Play', pause: 'Pause', toggle: 'PlayPause', next: 'Next', previous: 'Previous' }[action];
  if (method) await gdbus(['--dest', player, ...PATH, '--method', `org.mpris.MediaPlayer2.Player.${method}`]);
}

module.exports = { nowPlaying, control, seek, setVolume, streamOf };
