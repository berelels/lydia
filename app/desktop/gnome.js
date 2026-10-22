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
    this.panelHidden = false;
    this.superMine = false;
    this.bannersMine = false;
    this.version = 0; // of the extension running in the shell (Watch says it)
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
        // /lydia/Desktop: lydia.Desktop.Super ()
        if (/\.Super \(\)/.test(line)) this.events.superKey();
        if (/\.NotificationsChanged \(\)/.test(line)) this.events.notifications?.();
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
      call('Watch', [process.pid, Math.round(z.x), Math.round(z.y), Math.round(z.width), Math.round(z.height)], (err, out) => {
        if (!err) this.version = Number(/uint32 (\d+)/.exec(out)?.[1]) || this.version;
      });
      // again: the extension may have been reloaded
      if (this.panelHidden) call('SetPanel', ['true']);
      if (this.superMine) call('SetSuper', ['true']);
      if (this.bannersMine) call('SetBanners', ['true']);
    };
    // The monitor needs a moment to subscribe before the first Watch makes the extension report.
    setTimeout(watch, 300);
    this.timer = setInterval(watch, 5000);
  }

  stop() {
    // back at once, not when the extension notices she's gone
    if (this.panelHidden) call('SetPanel', ['false']);
    if (this.superMine) call('SetSuper', ['false']);
    if (this.bannersMine) call('SetBanners', ['false']);
    clearInterval(this.timer);
    this.monitor?.kill();
  }

  /** Hide GNOME's top panel while she runs (the extension brings it back when she stops). */
  setPanel(hidden) {
    this.panelHidden = hidden;
    call('SetPanel', [hidden ? 'true' : 'false']);
    return !hidden || this.version >= 2; // older helpers don't know how (yet: the shell runs the old copy until it restarts)
  }

  /** The Super key opens her instead of the overview. */
  setSuper(mine) {
    this.superMine = mine;
    call('SetSuper', [mine ? 'true' : 'false']);
    return !mine || this.version >= 3;
  }

  /** GNOME's notification banners stay quiet while she shows them (helper 6+). */
  setBanners(mine) {
    this.bannersMine = mine;
    call('SetBanners', [mine ? 'true' : 'false']);
  }

  /** The system's notifications (WhatsApp, Discord...): cb(list | null). */
  notifications(cb) {
    if (this.version < 4) return cb(null);
    call('Notifications', [], (err, out) => {
      // ('[{"id":1,...}]',)  (GVariant text: \\ and \' escaped)
      const m = /^\('(.*)',\)\s*$/s.exec(out);
      if (err || !m) return cb(null);
      try {
        cb(JSON.parse(m[1].replace(/\\(.)/g, '$1')));
      } catch {
        cb(null);
      }
    });
  }

  notification(id, action) {
    if (this.version >= 4 && Number.isInteger(id)) call(action === 'open' ? 'ActivateNotification' : 'DismissNotification', [id]);
  }

  overview() {
    if (this.version >= 3) call('Overview');
    else if (process.env.XDG_SESSION_TYPE !== 'wayland') execFile('xdotool', ['key', 'super'], { timeout: 1000 }, () => {}); // an older helper
    else return false;
    return true;
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
