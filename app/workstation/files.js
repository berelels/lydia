const { execFile, spawn } = require('child_process');
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
const SIZES = ['scalable', '256x256', '128x128', '96x96', '64x64', '48x48', 'symbolic'];
let iconIndex = null;
/** name -> best file, built once by walking the icon dirs (apps/ only). */
function indexIcons() {
  if (iconIndex) return iconIndex;
  iconIndex = new Map();
  const rank = (file) => {
    const i = SIZES.findIndex((s) => file.includes(`/${s}/`));
    return i < 0 ? 50 : i;
  };
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
      else if (/\.(png|svg)$/.test(e.name) && (full.includes('/apps/') || dir === '/usr/share/pixmaps')) {
        const name = e.name.replace(/\.(png|svg)$/, '');
        const prev = iconIndex.get(name);
        if (!prev || rank(full) < rank(prev)) iconIndex.set(name, full);
      }
    }
  };
  ICON_DIRS.forEach((d) => walk(d));
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
    .map((a) => ({ id: a.id, name: a.name, icon: icon(a.iconName) }))
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
async function current() {
  const uri = (await run('gsettings', ['get', 'org.gnome.desktop.background', 'picture-uri']))?.trim().replace(/^'|'$/g, '') ?? '';
  return uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : '';
}
async function setWallpaper(file) {
  if (!IMG.test(file) || !fs.existsSync(file)) return false;
  const uri = `file://${file}`;
  await run('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri', uri]);
  await run('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri-dark', uri]);
  return true;
}

// ---------- power, uptime, speed ----------

async function power(action) {
  const cmds = {
    lock: ['loginctl', ['lock-session']],
    suspend: ['systemctl', ['suspend']],
    restart: ['systemctl', ['reboot']],
    shutdown: ['systemctl', ['poweroff']],
    logout: ['gnome-session-quit', ['--logout', '--no-prompt']],
  };
  const c = cmds[action];
  if (!c) return false;
  return (await run(c[0], c[1], 10_000)) !== null;
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

module.exports = { appList, launch, wallpapers, current, setWallpaper, power, uptime, speedTest, icon };
