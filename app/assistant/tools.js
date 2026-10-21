const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const i18n = require('../i18n');
const { t } = i18n;
const { normalize } = require('./intents');
const audio = require('../audio');

/**
 * What Lydia can do on the computer. Each tool: a description and JSON schema
 * (for the language model), a risk level, and run(args) -> { ok, say }.
 *
 * Risk: "low" runs right away; "confirm" waits for a yes from the user.
 * Nothing here deletes files, sends messages, pays or runs arbitrary commands.
 */

const run = (cmd, args, timeout = 4000) =>
  new Promise((resolve) => execFile(cmd, args, { timeout }, (err, out = '') => resolve(err ? null : String(out))));
const detach = (cmd, args) => {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  p.on('error', () => {});
  p.unref();
};

// ---------- volume ----------

async function volume() {
  const l = await audio.level('sink');
  return l ? { level: l.volume, muted: l.muted } : null;
}
async function setVolume(level) {
  const v = Math.max(0, Math.min(100, Math.round(level)));
  await audio.setMute('sink', false);
  const ok = await audio.setLevel('sink', v);
  return ok ? { ok: true, say: t('do.volume', { n: v }), undo: null } : { ok: false, say: t('do.no_audio') };
}

// ---------- media (MPRIS: Spotify, browsers, players) ----------

async function players() {
  const out = await run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.ListNames']);
  return out?.match(/org\.mpris\.MediaPlayer2\.[^']+/g) ?? [];
}
async function playerStatus(name) {
  const out = await run('gdbus', ['call', '--session', '--dest', name, '--object-path', '/org/mpris/MediaPlayer2', '--method', 'org.freedesktop.DBus.Properties.Get', 'org.mpris.MediaPlayer2.Player', 'PlaybackStatus']);
  return /'(\w+)'/.exec(out ?? '')?.[1] ?? '';
}
/** The player to act on: the one playing, else one that is paused, else any. */
async function pickPlayer() {
  const list = await players();
  const status = await Promise.all(list.map(playerStatus));
  return list[status.indexOf('Playing')] ?? list[status.indexOf('Paused')] ?? list[0] ?? null;
}

// ---------- music: play something on Spotify (or YouTube Music) ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SPOTIFY = 'org.mpris.MediaPlayer2.spotify';

/**
 * A Spotify link for what was asked, without the Spotify API (it needs an
 * account login): the first open.spotify.com result of a web search. A
 * playlist or album is preferred when the words ask for one.
 */
async function spotifyUri(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${query} site:open.spotify.com`)}`;
  let html = '';
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, signal: AbortSignal.timeout(6000) });
    html = await res.text();
  } catch {
    return null;
  }
  const found = [...html.matchAll(/open\.spotify\.com(?:\/intl-[a-z-]+)?\/(track|artist|album|playlist)\/([A-Za-z0-9]{22})/g)].map((m) => ({ kind: m[1], id: m[2] }));
  if (!found.length) return null;
  const want = /\bplaylist\b/.test(query) ? 'playlist' : /\b(album|disco)\b/.test(query) ? 'album' : null;
  const pick = (want && found.find((f) => f.kind === want)) ?? found.find((f) => f.kind === 'track' || f.kind === 'artist') ?? found[0];
  return `spotify:${pick.kind}:${pick.id}`;
}

/** Spotify running and answering on D-Bus (opened if needed). */
async function spotifyReady(app) {
  if ((await players()).includes(SPOTIFY)) return true;
  detach('gtk-launch', [app.id]);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if ((await players()).includes(SPOTIFY)) {
      await sleep(1500); // it shows up on D-Bus a moment before it can play
      return true;
    }
  }
  return false;
}

async function playMusic({ query, app }) {
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, say: t('do.cant') };
  const spotify = app !== 'youtube' && findApp('spotify');
  if (spotify && /spotify/i.test(spotify.id + spotify.name)) {
    if (!(await spotifyReady(spotify))) return { ok: false, say: t('do.no_app', { name: 'Spotify' }) };
    const uri = await spotifyUri(q);
    const call = (u) => run('gdbus', ['call', '--session', '--dest', SPOTIFY, '--object-path', '/org/mpris/MediaPlayer2', '--method', 'org.mpris.MediaPlayer2.Player.OpenUri', u]);
    if (uri && (await call(uri)) !== null) return { ok: true, say: t('do.playing', { q, app: 'Spotify' }) };
    await call(`spotify:search:${q}`); // couldn't pick a result: at least show the search
    return { ok: true, say: t('do.spotify_search', { q }) };
  }
  openUrl(`https://music.youtube.com/search?q=${encodeURIComponent(q)}`);
  return { ok: true, say: t('do.youtube', { q }) };
}

// ---------- apps (.desktop files) ----------

const APP_DIRS = [
  path.join(os.homedir(), '.local/share/applications'),
  '/usr/local/share/applications',
  '/usr/share/applications',
  path.join(os.homedir(), '.local/share/flatpak/exports/share/applications'),
  '/var/lib/flatpak/exports/share/applications',
  '/var/lib/snapd/desktop/applications',
];
let appCache = null;
/** Installed apps: [{ id, name, names: [normalized names and keywords] }] */
// ---------- app names in the user's language ----------
// GNOME shows "Arquivos", not "Files": some .desktop files carry Name[pt_BR],
// others (Ubuntu, Zorin) leave it to a gettext catalog named in
// X-Ubuntu-Gettext-Domain / X-GNOME-Gettext-Domain. Those .mo files are read here.

const LOCALES = { pt: ['pt_BR', 'pt'], es: ['es'], en: [] };
const catalogs = new Map(); // "pt_BR/nautilus" -> Map(msgid -> msgstr) | null

/** A compiled gettext catalog (.mo): just the msgid -> msgstr pairs. */
function readMo(file) {
  const b = fs.readFileSync(file);
  const le = b.readUInt32LE(0) === 0x950412de;
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const n = u32(8);
  const orig = u32(12);
  const trans = u32(16);
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const id = b.toString('utf8', u32(orig + i * 8 + 4), u32(orig + i * 8 + 4) + u32(orig + i * 8));
    const str = b.toString('utf8', u32(trans + i * 8 + 4), u32(trans + i * 8 + 4) + u32(trans + i * 8));
    if (id && str) map.set(id, str.split('\0')[0]);
  }
  return map;
}
function catalog(locale, domain) {
  const key = `${locale}/${domain}`;
  if (!catalogs.has(key)) {
    let map = null;
    for (const base of ['/usr/share/locale-langpack', '/usr/share/locale']) {
      try {
        map = readMo(path.join(base, locale, 'LC_MESSAGES', `${domain}.mo`));
        break;
      } catch {}
    }
    catalogs.set(key, map);
  }
  return catalogs.get(key);
}
/** A .desktop key (Name, Keywords...) as GNOME would show it in the interface language. */
function localized(get, key) {
  const value = get(key);
  const domain = get('X-GNOME-Gettext-Domain') || get('X-Ubuntu-Gettext-Domain');
  for (const loc of LOCALES[i18n.lang()] ?? []) {
    const own = get(`${key}[${loc}]`);
    if (own) return own;
    const tr = value && domain && /^[\w.-]+$/.test(domain) ? catalog(loc, domain)?.get(value) : null;
    if (tr) return tr;
  }
  return value;
}

function apps() {
  if (appCache) return appCache;
  const seen = new Map();
  for (const dir of APP_DIRS) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.desktop'));
    } catch {
      continue;
    }
    for (const f of files) {
      if (seen.has(f)) continue; // the user's own copy wins
      let text;
      try {
        text = fs.readFileSync(path.join(dir, f), 'utf8');
      } catch {
        continue;
      }
      const entry = text.split(/^\[/m).find((s) => s.startsWith('Desktop Entry]')) ?? '';
      const get = (k) => new RegExp(`^${k.replace(/[[\]]/g, '\\$&')}=(.*)$`, 'm').exec(entry)?.[1]?.trim() ?? '';
      if (/^true$/i.test(get('NoDisplay')) || /^true$/i.test(get('Hidden')) || get('Type') !== 'Application') {
        seen.set(f, null);
        continue;
      }
      const name = get('Name');
      const label = localized(get, 'Name') || name;
      const names = [name, label, ...localized(get, 'Keywords').split(';'), get('Name[pt_BR]'), get('Name[pt]'), get('Name[es]'), get('GenericName'), get('GenericName[pt_BR]'), ...get('Keywords').split(';'), ...get('Keywords[pt_BR]').split(';'), f.replace(/\.desktop$/, '').split('.').pop()]
        .map(normalize)
        .filter(Boolean);
      // The program it runs ("gnome-calculator", flatpak's --command=spotify), to find it among processes.
      const exec = get('Exec');
      const bin = /--command=(\S+)/.exec(exec)?.[1] ?? path.basename(exec.split(/\s+/)[0] ?? '');
      seen.set(f, { id: f.replace(/\.desktop$/, ''), name, label, names, bin, iconName: get('Icon') });
    }
  }
  appCache = [...seen.values()].filter(Boolean);
  setTimeout(() => (appCache = null), 60_000); // new installs show up within a minute
  return appCache;
}
// GNOME translates app names through its own catalogs, not the .desktop file:
// the usual Portuguese / Spanish names, to the English one (or "browser").
const SYNONYMS = {
  calculadora: 'calculator', arquivos: 'files', 'gerenciador de arquivos': 'files', pastas: 'files', archivos: 'files', explorador: 'files',
  configuracoes: 'settings', configuracao: 'settings', ajustes: 'settings', configuracion: 'settings', preferencias: 'settings',
  'editor de texto': 'text editor', 'bloco de notas': 'text editor', 'bloc de notas': 'text editor', notepad: 'text editor',
  loja: 'software', 'loja de apps': 'software', 'loja de aplicativos': 'software', tienda: 'software',
  camera: 'camera', camara: 'camera', 'monitor do sistema': 'system monitor', 'monitor del sistema': 'system monitor', 'gerenciador de tarefas': 'system monitor',
  calendario: 'calendar', relogio: 'clocks', reloj: 'clocks', fotos: 'photos', imagens: 'image viewer', musicas: 'music', videos: 'videos',
  navegador: 'browser', 'navegador web': 'browser', internet: 'browser', browser: 'browser', 'web browser': 'browser',
};
let defaultBrowser;
function browserApp() {
  if (defaultBrowser === undefined) {
    try {
      const id = require('child_process').execFileSync('xdg-settings', ['get', 'default-web-browser'], { timeout: 1500 }).toString().trim().replace(/\.desktop$/, '');
      defaultBrowser = apps().find((a) => a.id === id) ?? null;
    } catch {
      defaultBrowser = null;
    }
  }
  return defaultBrowser;
}

/** Best app for what was said: its name, a translated name, a keyword, then its id. */
function findApp(target) {
  let q = normalize(target);
  if (!q) return null;
  const said = q;
  q = SYNONYMS[q] ?? q;
  const spoken = (app) => app && (said !== q ? { ...app, label: target } : { ...app, label: app.name }); // "calculadora", not "Calculator"
  if (q === 'browser') return spoken(browserApp() ?? findApp('firefox'));
  const words = (s) => s.split(' ');
  const score = (a) => {
    const name = normalize(a.name);
    if (name === q) return 6;
    if (a.names.includes(q)) return 5; // translated name, generic name, keyword
    if (name.startsWith(`${q} `) || words(name).includes(q)) return 4; // "brave" -> "Brave Web Browser"
    if (a.names.some((n) => n.startsWith(q))) return 3;
    if (normalize(a.id).includes(q)) return 2;
    if (q.length >= 4 && a.names.some((n) => n.includes(q))) return 1;
    return 0;
  };
  let best = null;
  let bestScore = 0;
  for (const a of apps()) {
    const s = score(a);
    if (s > bestScore || (s === bestScore && s > 0 && a.name.length < best.name.length)) [best, bestScore] = [a, s];
  }
  return spoken(best);
}

// Common sites, so "abre o YouTube" works even without an app for it.
const SITES = {
  youtube: 'https://www.youtube.com', 'youtube music': 'https://music.youtube.com', gmail: 'https://mail.google.com', email: 'https://mail.google.com',
  'google drive': 'https://drive.google.com', drive: 'https://drive.google.com', 'google docs': 'https://docs.google.com', agenda: 'https://calendar.google.com', calendar: 'https://calendar.google.com',
  maps: 'https://maps.google.com', 'google maps': 'https://maps.google.com', mapa: 'https://maps.google.com', whatsapp: 'https://web.whatsapp.com', 'whatsapp web': 'https://web.whatsapp.com',
  instagram: 'https://www.instagram.com', facebook: 'https://www.facebook.com', twitter: 'https://x.com', x: 'https://x.com', reddit: 'https://www.reddit.com', linkedin: 'https://www.linkedin.com',
  github: 'https://github.com', netflix: 'https://www.netflix.com', twitch: 'https://www.twitch.tv', 'prime video': 'https://www.primevideo.com', spotify: 'https://open.spotify.com',
  chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai', gemini: 'https://gemini.google.com', wikipedia: 'https://www.wikipedia.org', translate: 'https://translate.google.com', tradutor: 'https://translate.google.com',
};
const asUrl = (s) => {
  const q = String(s ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (/^https?:\/\//i.test(q)) return q;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/.test(q)) return `https://${q}`; // "github.com", "g1.globo.com"
  return null;
};
const openUrl = (url) => detach('xdg-open', [url]);

// ---------- the tools ----------

const TOOLS = {
  set_volume: {
    risk: 'low',
    description: 'Set the computer speaker volume to a percentage (0-100).',
    params: { level: { type: 'integer', description: 'Volume in percent, 0 to 100' } },
    required: ['level'],
    run: ({ level }) => setVolume(Number(level)),
  },
  change_volume: {
    risk: 'low',
    description: 'Raise or lower the volume by some percentage points (negative lowers).',
    params: { delta: { type: 'integer', description: 'Change in percentage points, e.g. 10 or -10' } },
    required: ['delta'],
    run: async ({ delta }) => {
      const v = await volume();
      if (!v) return { ok: false, say: t('do.no_audio') };
      return setVolume(v.level + Number(delta));
    },
  },
  mute: {
    risk: 'low',
    description: 'Mute or unmute the speakers.',
    params: { on: { type: 'boolean', description: 'true to mute, false to unmute' } },
    required: ['on'],
    run: async ({ on }) => {
      const ok = await audio.setMute('sink', on);
      return ok ? { ok: true, say: t(on ? 'do.muted' : 'do.unmuted') } : { ok: false, say: t('do.no_audio') };
    },
  },
  media: {
    risk: 'low',
    description: 'Control what is playing (music, video): play, pause, next or previous.',
    params: { action: { type: 'string', enum: ['play', 'pause', 'next', 'previous'] } },
    required: ['action'],
    run: async ({ action }) => {
      const player = await pickPlayer();
      if (!player) return { ok: false, say: t('do.no_player') };
      const method = { play: 'Play', pause: 'Pause', next: 'Next', previous: 'Previous' }[action] ?? 'PlayPause';
      const ok = (await run('gdbus', ['call', '--session', '--dest', player, '--object-path', '/org/mpris/MediaPlayer2', '--method', `org.mpris.MediaPlayer2.Player.${method}`])) !== null;
      return ok ? { ok: true, say: t(`do.media_${action}`) } : { ok: false, say: t('do.no_player') };
    },
  },
  open: {
    risk: 'low',
    description: 'Open an installed app (e.g. "Spotify", "Files", "Calculator") or a website (e.g. "YouTube", "gmail", "github.com").',
    params: { target: { type: 'string', description: 'App or site name, or a web address' }, web: { type: 'boolean', description: 'true to prefer the website over an app' } },
    required: ['target'],
    run: async ({ target, web }) => {
      const url = asUrl(target);
      if (url) return openUrl(url), { ok: true, say: t('do.opening', { name: target }) };
      const key = normalize(target);
      const app = web ? null : findApp(target);
      if (app && (!SITES[key] || normalize(app.name) === key)) {
        detach('gtk-launch', [app.id]);
        return { ok: true, say: t('do.opening', { name: app.label }) };
      }
      if (SITES[key]) return openUrl(SITES[key]), { ok: true, say: t('do.opening', { name: target }) };
      if (app) {
        detach('gtk-launch', [app.id]);
        return { ok: true, say: t('do.opening', { name: app.label }) };
      }
      return { ok: false, say: t('do.no_app', { name: target }) };
    },
  },
  open_url: {
    risk: 'low',
    description: 'Open a web address in the browser.',
    params: { url: { type: 'string', description: 'http(s) address' } },
    required: ['url'],
    run: ({ url }) => {
      const u = asUrl(url);
      if (!u) return { ok: false, say: t('do.bad_url') };
      openUrl(u);
      return { ok: true, say: t('do.opening', { name: new URL(u).hostname }) };
    },
  },
  web_search: {
    risk: 'low',
    description: 'Search the web for something in the browser.',
    params: { query: { type: 'string' } },
    required: ['query'],
    run: ({ query }) => {
      openUrl(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
      return { ok: true, say: t('do.searching', { q: query }) };
    },
  },
  play_music: {
    risk: 'low',
    description: 'Play music: a song, an artist, an album or a playlist. On Spotify when it is installed (or when asked), else YouTube Music.',
    params: { query: { type: 'string', description: 'What to play, e.g. "AC/DC", "Back in Black", "lo-fi playlist"' }, app: { type: 'string', enum: ['spotify', 'youtube'], description: 'Only if the user said where' } },
    required: ['query'],
    run: playMusic,
  },
  youtube_search: {
    risk: 'low',
    description: 'Search YouTube (to play a song or video).',
    params: { query: { type: 'string' } },
    required: ['query'],
    run: ({ query }) => {
      openUrl(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
      return { ok: true, say: t('do.youtube', { q: query }) };
    },
  },
  close_app: {
    risk: 'confirm',
    description: 'Close an app that is running (all its windows). Asks the user first.',
    params: { name: { type: 'string', description: 'App name, e.g. "brave", "spotify"' } },
    required: ['name'],
    confirm: ({ name }) => t('do.confirm_close', { name }),
    run: null, // needs the task manager's process list: set by main.js
  },
  time_now: {
    risk: 'low',
    description: 'Tell the current time.',
    params: {},
    run: () => {
      const now = new Date();
      return { ok: true, say: t('do.time', { time: now.toLocaleTimeString(t('locale'), { hour: '2-digit', minute: '2-digit' }) }) };
    },
  },
  timer: {
    risk: 'low',
    description: 'Start a timer; Lydia says so when it ends.',
    params: { seconds: { type: 'integer', description: 'Duration in seconds' } },
    required: ['seconds'],
    run: null, // set by main.js (it owns notifications and speech)
  },
  lock_screen: {
    risk: 'low',
    description: 'Lock the screen.',
    params: {},
    run: async () => {
      const ok = (await run('loginctl', ['lock-session'])) !== null || (await run('xdg-screensaver', ['lock'])) !== null;
      return ok ? { ok: true, say: t('do.locked') } : { ok: false, say: t('do.cant') };
    },
  },
  set_theme: {
    risk: 'low',
    description: 'Switch the desktop between dark and light theme.',
    params: { dark: { type: 'boolean' } },
    required: ['dark'],
    run: async ({ dark }) => {
      const theme = (await run('gsettings', ['get', 'org.gnome.desktop.interface', 'gtk-theme']))?.trim().replace(/'/g, '') ?? '';
      await run('gsettings', ['set', 'org.gnome.desktop.interface', 'color-scheme', dark ? 'prefer-dark' : 'default']);
      // Zorin / Yaru style names: "ZorinGrey-Light" <-> "ZorinGrey-Dark"
      if (/-(light|dark)$/i.test(theme)) await run('gsettings', ['set', 'org.gnome.desktop.interface', 'gtk-theme', theme.replace(/-(light|dark)$/i, dark ? '-Dark' : '-Light')]);
      return { ok: true, say: t(dark ? 'do.dark' : 'do.light') };
    },
  },
  system_status: {
    risk: 'low',
    description: 'Say how the computer is doing: memory, processor, temperatures.',
    params: {},
    run: null, // set by main.js (it owns the monitors)
  },
};

/** Declarations for Gemini function calling. */
function declarations() {
  return Object.entries(TOOLS).map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: { type: 'object', properties: tool.params, ...(tool.required ? { required: tool.required } : {}) },
  }));
}

module.exports = { TOOLS, declarations, findApp, apps, volume };
