const { execFile, execFileSync, spawn } = require('child_process');
const { nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { apps } = require('../assistant/tools');

/**
 * Apps with their icons (for the Apps tab), wallpapers with thumbnails (for
 * the Wallpaper tab), power actions, uptime and a download speed test.
 */

const run = (cmd, args, timeout = 5000) => new Promise((r) => execFile(cmd, args, { timeout }, (err, out = '') => r(err ? null : String(out))));

// ---------- app icons (from the icon theme, as data URLs, cached) ----------

const ICON_ROOTS = [path.join(os.homedir(), '.local/share/icons'), path.join(os.homedir(), '.icons'), '/usr/local/share/icons', '/usr/share/icons'];
const ICON_DIRS = [
  path.join(os.homedir(), '.local/share/icons'),
  '/usr/share/icons/hicolor',
  '/usr/share/icons/Adwaita',
  '/usr/share/icons/ZorinBlue-Light',
  '/usr/share/icons/Yaru',
  '/var/lib/flatpak/exports/share/icons/hicolor',
  path.join(os.homedir(), '.local/share/flatpak/exports/share/icons/hicolor'),
  '/usr/share/pixmaps',
];

/** The icon theme the user picked, whatever the desktop (null if it can't be told). */
function iconThemeName() {
  const get = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { timeout: 1500 }).toString().trim().replace(/^'|'$/g, '') || null;
    } catch {
      return null;
    }
  };
  const desk = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().split(':');
  if (desk.includes('kde')) {
    try {
      return /^\[Icons\][^[]*?^Theme=(.+)$/m.exec(fs.readFileSync(path.join(os.homedir(), '.config/kdeglobals'), 'utf8'))?.[1].trim() || 'breeze';
    } catch {
      return 'breeze';
    }
  }
  if (desk.includes('xfce')) return get('xfconf-query', ['-c', 'xsettings', '-p', '/Net/IconThemeName']);
  if (desk.includes('x-cinnamon')) return get('gsettings', ['get', 'org.cinnamon.desktop.interface', 'icon-theme']);
  if (desk.includes('mate')) return get('gsettings', ['get', 'org.mate.interface', 'icon-theme']);
  return get('gsettings', ['get', 'org.gnome.desktop.interface', 'icon-theme']);
}

/** That theme's folders, then the themes it inherits from, in order. */
function themeDirs(name, seen = new Set()) {
  if (!name || seen.has(name) || seen.size > 6) return [];
  seen.add(name);
  const dirs = ICON_ROOTS.map((r) => path.join(r, name)).filter((d) => fs.existsSync(d));
  let inherits = [];
  for (const d of dirs) {
    try {
      inherits = /^Inherits=(.+)$/m.exec(fs.readFileSync(path.join(d, 'index.theme'), 'utf8'))?.[1].split(',').map((x) => x.trim()) ?? [];
      break;
    } catch {}
  }
  return [...dirs, ...inherits.flatMap((i) => themeDirs(i, seen))];
}

const SIZES = ['scalable', '256x256', '128x128', '96x96', '64x64', '48x48', 'symbolic'];
let iconIndex = null;
/** name -> best file, built once by walking the icon dirs: the user's theme first, apps/ before the rest. */
function indexIcons() {
  if (iconIndex) return iconIndex;
  iconIndex = new Map();
  const order = [...new Set([...themeDirs(iconThemeName()), ...ICON_DIRS])];
  let prio = 0;
  const rank = (file) => {
    const i = SIZES.findIndex((s) => file.includes(`/${s}/`));
    return prio * 1000 + (file.includes('/apps/') ? 0 : 100) + (i < 0 ? 50 : i); // settings icons live under categories/, devices/...
  };
  const ranks = new Map();
  const walk = (dir, depth = 0) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (/\.(png|svg)$/.test(e.name) && (/\/(apps|categories|devices|preferences|places)\//.test(full) || dir === '/usr/share/pixmaps')) {
        const name = e.name.replace(/\.(png|svg)$/, '');
        const r = rank(full);
        if (!iconIndex.has(name) || r < ranks.get(name)) {
          iconIndex.set(name, full);
          ranks.set(name, r);
        }
      }
    }
  };
  for (const d of order) {
    walk(d);
    prio++;
  }
  return iconIndex;
}
const iconCache = new Map();
function icon(name) {
  if (!name) return '';
  if (iconCache.has(name)) return iconCache.get(name);
  const file = path.isAbsolute(name) ? name : indexIcons().get(name);
  let data = '';
  if (file && fs.existsSync(file)) {
    if (file.endsWith('.svg')) data = `data:image/svg+xml;base64,${fs.readFileSync(file).toString('base64')}`;
    else {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) data = img.resize({ width: 48, height: 48 }).toDataURL();
    }
  }
  iconCache.set(name, data);
  return data;
}

/** All apps, alphabetically, with icons; favorites first. */
function appList(favorites = []) {
  const list = apps()
    .map((a) => ({ id: a.id, name: a.label, find: [a.id, ...a.names].join(' ').toLowerCase(), icon: icon(a.iconName) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const fav = favorites.map((id) => list.find((a) => a.id === id)).filter(Boolean);
  return { favorites: fav, all: list };
}
const launch = (id) => {
  if (!/^[\w.-]+$/.test(id)) return false;
  const p = spawn('gtk-launch', [id], { detached: true, stdio: 'ignore' });
  p.on('error', () => {});
  p.unref();
  return true;
};

// ---------- wallpapers ----------

const IMG = /\.(jpe?g|png|webp|bmp)$/i;
const thumbs = new Map();
/** Images in the folder (and one level of subfolders), newest first, with small thumbnails. */
function wallpapers(dir) {
  const found = [];
  const look = (d, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < 1) look(full, depth + 1);
      else if (IMG.test(e.name)) {
        try {
          found.push({ file: full, at: fs.statSync(full).mtimeMs });
        } catch {}
      }
    }
  };
  look(dir, 0);
  found.sort((a, b) => b.at - a.at);
  return found.slice(0, 60).map(({ file }) => {
    if (!thumbs.has(file)) {
      const img = nativeImage.createFromPath(file);
      thumbs.set(file, img.isEmpty() ? '' : img.resize({ width: 220, quality: 'good' }).toDataURL());
    }
    return { file, name: path.basename(file), thumb: thumbs.get(file) };
  });
}
// The desktop in use: GNOME (and Ubuntu, Zorin, Budgie, Pop), Cinnamon, MATE, XFCE or KDE
const DESK = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
const on = (name) => DESK.split(':').includes(name);
const fromUri = (uri) => (uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri.startsWith('/') ? uri : '');
const unquote = (out) => out?.trim().replace(/^'|'$/g, '') ?? '';
/** XFCE keeps one picture per monitor and workspace: all of them. */
const xfceProps = async () => ((await run('xfconf-query', ['-c', 'xfce4-desktop', '-l'])) ?? '').split('\n').filter((p) => p.endsWith('/last-image'));

async function current() {
  if (on('x-cinnamon')) return fromUri(unquote(await run('gsettings', ['get', 'org.cinnamon.desktop.background', 'picture-uri'])));
  if (on('mate')) return fromUri(unquote(await run('gsettings', ['get', 'org.mate.background', 'picture-filename'])));
  if (on('xfce')) {
    const [prop] = await xfceProps();
    return prop ? fromUri(((await run('xfconf-query', ['-c', 'xfce4-desktop', '-p', prop])) ?? '').trim()) : '';
  }
  if (on('kde')) return ''; // Plasma doesn't say it in a simple way
  return fromUri(unquote(await run('gsettings', ['get', 'org.gnome.desktop.background', 'picture-uri'])));
}
async function setWallpaper(file) {
  if (!IMG.test(file) || !fs.existsSync(file)) return false;
  const uri = `file://${file}`;
  if (on('x-cinnamon')) return (await run('gsettings', ['set', 'org.cinnamon.desktop.background', 'picture-uri', uri])) !== null;
  if (on('mate')) return (await run('gsettings', ['set', 'org.mate.background', 'picture-filename', file])) !== null;
  if (on('xfce')) {
    const props = await xfceProps();
    for (const prop of props) await run('xfconf-query', ['-c', 'xfce4-desktop', '-p', prop, '-s', file]);
    return props.length > 0;
  }
  if (on('kde')) return (await run('plasma-apply-wallpaperimage', [file], 10_000)) !== null;
  const ok = (await run('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri', uri])) !== null;
  await run('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri-dark', uri]);
  return ok;
}

/** The system's settings app, whichever this desktop has. */
function settings() {
  const ids = ['org.gnome.Settings', 'gnome-control-center', 'cinnamon-settings', 'mate-control-center', 'xfce-settings-manager', 'systemsettings', 'org.kde.systemsettings', 'budgie-control-center', 'io.elementary.settings'];
  const have = new Set(apps().map((a) => a.id));
  const id = ids.find((i) => have.has(i));
  return id ? launch(id) : false;
}

// ---------- power, uptime, speed ----------

async function power(action) {
  const cmds = {
    lock: ['loginctl', ['lock-session']],
    suspend: ['systemctl', ['suspend']],
    restart: ['systemctl', ['reboot']],
    shutdown: ['systemctl', ['poweroff']],
    logout: on('x-cinnamon')
      ? ['cinnamon-session-quit', ['--logout', '--no-prompt']]
      : on('mate')
        ? ['mate-session-save', ['--logout']]
        : on('xfce')
          ? ['xfce4-session-logout', ['--logout']]
          : on('kde')
            ? ['qdbus', ['org.kde.Shutdown', '/Shutdown', 'logout']]
            : ['gnome-session-quit', ['--logout', '--no-prompt']],
  };
  const c = cmds[action];
  if (!c) return false;
  if ((await run(c[0], c[1], 10_000)) !== null) return true;
  // any other desktop: ends the session through systemd
  if (action === 'logout' && process.env.XDG_SESSION_ID) return (await run('loginctl', ['terminate-session', process.env.XDG_SESSION_ID], 10_000)) !== null;
  return false;
}

function uptime() {
  try {
    return Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  } catch {
    return 0;
  }
}

/** Download speed in Mbit/s: ~10 MB from Cloudflare's speed test, timed. */
async function speedTest() {
  const bytes = 10_000_000;
  const t0 = performance.now();
  try {
    const res = await fetch(`https://speed.cloudflare.com/__down?bytes=${bytes}`, { signal: AbortSignal.timeout(30_000) });
    const buf = await res.arrayBuffer();
    const secs = (performance.now() - t0) / 1000;
    return { mbps: Math.round(((buf.byteLength * 8) / secs / 1e6) * 10) / 10 };
  } catch {
    return { mbps: null };
  }
}

module.exports = { appList, launch, settings, wallpapers, current, setWallpaper, power, uptime, speedTest, icon };
