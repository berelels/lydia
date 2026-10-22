const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isSteamGame } = require('./steam');
const { unpacked } = require('../paths');

/**
 * KDE Plasma on Wayland: a small KWin script (kwin-script/) tells her where
 * the pointer is and whether the active window is fullscreen, through
 * kwin_bridge.py (lydia.KWin on the session bus). The script is loaded when
 * she starts and unloaded when she stops; nothing is left enabled in KWin.
 */

const SCRIPT_ID = 'lydia-helper';
const SCRIPT_SRC = unpacked(path.join(__dirname, 'kwin-script'));
const SCRIPT_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'kwin', 'scripts', SCRIPT_ID);
const MAIN = path.join(SCRIPT_DIR, 'contents', 'code', 'main.js');

const kwin = (method, args = []) =>
  new Promise((resolve) =>
    execFile('dbus-send', ['--session', '--print-reply', '--dest=org.kde.KWin', ...method, ...args], { timeout: 4000 }, (err, out) => resolve(err ? null : String(out))),
  );

class KWinDesktop {
  constructor(ctx, events) {
    this.name = 'kwin';
    this.ctx = ctx;
    this.events = events;
    this.hasPointer = false; // until the bridge is up
    this.bridge = null;
  }

  start() {
    this.bridge = spawn('python3', [unpacked(path.join(__dirname, 'kwin_bridge.py'))], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.bridge.on('error', () => (this.hasPointer = false));
    let buf = '';
    this.bridge.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      let pointer = null;
      for (const line of lines) {
        if (line === 'ready') this.load();
        let m = /^P (-?\d+) (-?\d+)$/.exec(line);
        if (m) pointer = { x: Number(m[1]), y: Number(m[2]) };
        m = /^F ([01]) (\S+) (\d+)$/.exec(line);
        if (m) this.events.fullscreen(m[1] === '1', m[1] === '1' && isSteamGame(m[2], Number(m[3])));
      }
      if (pointer) {
        this.hasPointer = true;
        this.events.pointer(pointer);
      }
    });
  }

  /** Puts the script where KWin looks and runs it (again, if a previous Lydia left it loaded). */
  async load() {
    try {
      fs.rmSync(SCRIPT_DIR, { recursive: true, force: true });
      fs.cpSync(SCRIPT_SRC, SCRIPT_DIR, { recursive: true });
    } catch {
      return;
    }
    await kwin(['/Scripting', 'org.kde.kwin.Scripting.unloadScript'], [`string:${SCRIPT_ID}`]);
    const out = await kwin(['/Scripting', 'org.kde.kwin.Scripting.loadScript'], [`string:${MAIN}`, `string:${SCRIPT_ID}`]);
    const id = /int32 (-?\d+)/.exec(out ?? '')?.[1];
    if (id == null || Number(id) < 0) return console.log('[lydia] KWin did not load her script');
    // Plasma 6 names the object /Scripting/Script<id>, Plasma 5 /<id>
    if ((await kwin([`/Scripting/Script${id}`, 'org.kde.kwin.Script.run'])) === null) await kwin([`/${id}`, 'org.kde.kwin.Script.run']);
  }

  stop() {
    kwin(['/Scripting', 'org.kde.kwin.Scripting.unloadScript'], [`string:${SCRIPT_ID}`]);
    this.bridge?.kill();
  }

  activeWindow(cb) {
    cb(null);
  }
  activate() {}
  setPanel() {
    return false;
  }
  setSuper() {
    return false;
  }
  setBanners() {}
  overview() {
    return false;
  }
  notifications(cb) {
    cb(null);
  }
  notification() {}
  focusSelf(win) {
    win.focus();
    win.webContents.focus();
  }
}

/** A KDE Plasma session on Wayland, with KWin answering on the bus? cb(bool) */
function probe(cb) {
  if (!/kde/i.test(process.env.XDG_CURRENT_DESKTOP || '')) return cb(false);
  kwin(['/Scripting', 'org.freedesktop.DBus.Peer.Ping']).then((out) => cb(out !== null));
}

module.exports = { KWinDesktop, probe };
