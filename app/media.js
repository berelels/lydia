const { execFile } = require('child_process');

/**
 * Is music playing? Read from MPRIS, the D-Bus interface every Linux media
 * player (and browser tab with media) exposes. Music only: a YouTube video or
 * a film doesn't count.
 */

const MUSIC_APPS = /spotify|rhythmbox|lollypop|amberol|elisa|audacious|clementine|strawberry|cmus|mpd|quodlibet|deadbeef|tauon|cider|youtube.?music|g4music|gapless|harmonoid|museeks|nuclear|sublime|tidal|feishin|euphonica|tauon|mousai|shortwave|goodvibes/i;
const VIDEO_APPS = /vlc|mpv|totem|celluloid|smplayer|haruna|clapper|kodi|showtime|dragon|parole|xplayer|kaffeine|freetube|plex|jellyfin|stremio/i;
const AUDIO_FILE = /\.(mp3|flac|ogg|oga|opus|m4a|aac|wav|wma|alac|ape|mka)(\?|$)/i;

/**
 * One player's state -> is it music? `player` is the bus name's tail
 * ("spotify", "brave.instance9941"), plus its PlaybackStatus and metadata.
 */
function isMusic({ player, status, album = '', url = '' }) {
  if (status !== 'Playing') return false;
  if (MUSIC_APPS.test(player)) return true;
  if (VIDEO_APPS.test(player)) return AUDIO_FILE.test(url);
  // A browser or anything else: music sites (YouTube Music, Spotify Web,
  // Deezer...) give an album; a video or a film never does.
  return album.trim() !== '' || AUDIO_FILE.test(url);
}

/** gdbus' text for GetAll(org.mpris.MediaPlayer2.Player) -> { status, album, url } */
function parsePlayer(text) {
  const str = (key) => new RegExp(`'${key}': <'((?:[^'\\\\]|\\\\.)*)'>`).exec(text)?.[1] ?? '';
  return { status: str('PlaybackStatus'), album: str('xesam:album'), url: str('xesam:url') };
}

const gdbus = (args) =>
  new Promise((resolve) => execFile('gdbus', ['call', '--session', ...args], { timeout: 2000 }, (err, out) => resolve(err ? '' : String(out))));

/** Resolves true when some player is playing music right now. */
async function musicPlaying() {
  const names = (await gdbus(['--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.ListNames']))
    .match(/org\.mpris\.MediaPlayer2\.[^']+/g) ?? [];
  for (const name of names) {
    const out = await gdbus(['--dest', name, '--object-path', '/org/mpris/MediaPlayer2', '--method', 'org.freedesktop.DBus.Properties.GetAll', 'org.mpris.MediaPlayer2.Player']);
    if (isMusic({ player: name.slice('org.mpris.MediaPlayer2.'.length), ...parsePlayer(out) })) return true;
  }
  return false;
}

module.exports = { musicPlaying, isMusic, parsePlayer };
