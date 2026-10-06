const { execFile, spawn } = require('child_process');
const { isSteamGame } = require('./steam');

const DEST = ['--session', '--dest', 'lydia.Desktop', '--object-path', '/lydia/Desktop'];
const call = (method, args = [], cb = () => {}) =>
  execFile('gdbus', ['call', ...DEST, '--method', `lydia.Desktop.${method}`, ...args.map(String)], { timeout: 2000 }, (err, out) => cb(err, String(out ?? '')));

/** Is the Lydia helper extension running in GNOME Shell? cb(true | false) */
function probe(cb) {
  call('Watch', [process.pid, 0, 0, 0, 0], (err, out) => cb(!err && /\(uint32 \d+,\)/.test(out)));
}

/**
 * GNOME Shell, X11 or Wayland: the "Lydia helper" extension (gnome-extension/)
 * reports the pointer and windows over D-Bus. Signals are read from one
 * `gdbus monitor`; Watch is called every 5 s to keep the extension awake.
 */
class GnomeDesktop {
  constructor(ctx, events) {
    this.name = 'gnome';
    this.ctx = ctx;
    this.events = events;
    this.hasPointer = true;
    this.monitor = null;
    this.timer = 0;
  }

  start() {
    this.monitor = spawn('gdbus', ['monitor', ...DEST], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.monitor.on('error', () => (this.hasPointer = false));
    let buf = '';
    this.monitor.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      let pointer = null;
      for (const line of lines) {
        // /lydia/Desktop: lydia.Desktop.Pointer (512, 3)
        let m = /\.Pointer \((-?\d+), (-?\d+)\)/.exec(line);
        if (m) pointer = { x: Number(m[1]), y: Number(m[2]) };
        // /lydia/Desktop: lydia.Desktop.Windows (true, 'steam_app_620', uint32 4242, false)
        m = /\.Windows \((true|false), '((?:[^'\\]|\\.)*)', (?:uint32 )?(\d+), (true|false)\)/.exec(line);
        if (m) {
          const full = m[1] === 'true';
          this.events.fullscreen(full, full && isSteamGame(m[2], Number(m[3])));
          this.events.covered(m[4] === 'true');
        }
      }
      if (pointer) this.events.pointer(pointer); // only the latest one matters
    });
    const watch = () => {
      const z = this.ctx.zone();
      call('Watch', [process.pid, Math.round(z.x), Math.round(z.y), Math.round(z.width), Math.round(z.height)]);
    };
    // The monitor needs a moment to subscribe before the first Watch makes the extension report.
    setTimeout(watch, 300);
    this.timer = setInterval(watch, 5000);
  }

  stop() {
    clearInterval(this.timer);
    this.monitor?.kill();
  }

  activeWindow(cb) {
    call('ActiveWindow', [], (err, out) => cb(err ? null : /(\d+),?\)/.exec(out)?.[1] ?? null));
  }

  activate(id) {
    if (/^\d+$/.test(String(id))) call('Activate', [id]);
  }

  /** On Wayland a window can't take the keyboard by itself: the shell gives it to her. */
  focusSelf(win) {
    call('FocusSelf', [], () => win.webContents.focus());
    win.focus();
  }
}

module.exports = { GnomeDesktop, probe };
