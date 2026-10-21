const { execFile } = require('child_process');
const fs = require('fs');

/**
 * What is playing (MPRIS: Spotify, browsers, players), for the player in the
 * Controls tab: title, artist, cover, position. Covers become data: URLs
 * (the page only loads its own files), cached by address.
 */

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
  return {
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

/** play / pause / next / previous on that player. */
async function control(player, action) {
  if (!/^org\.mpris\.MediaPlayer2\.[\w.-]+$/.test(player)) return;
  const method = { play: 'Play', pause: 'Pause', toggle: 'PlayPause', next: 'Next', previous: 'Previous' }[action];
  if (method) await gdbus(['--dest', player, ...PATH, '--method', `org.mpris.MediaPlayer2.Player.${method}`]);
}

module.exports = { nowPlaying, control };
