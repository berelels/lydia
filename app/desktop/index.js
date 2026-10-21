const { X11Desktop } = require('./x11');
const { GnomeDesktop, probe } = require('./gnome');

/**
 * Without any way to see the desktop (Wayland with no helper, an unknown
 * compositor): no pointer, no window detection. She still works: the pill takes
 * the mouse itself, fullscreen and "covered" are just never detected.
 */
class NoDesktop {
  constructor() {
    this.name = 'none';
    this.hasPointer = false;
  }
  start() {}
  stop() {}
  activeWindow(cb) {
    cb(null);
  }
  activate() {}
  setPanel() {
    return false; // only the GNOME helper can
  }
  focusSelf(win) {
    win.focus();
    win.webContents.focus();
  }
}

/**
 * The best way to watch this desktop: the GNOME helper extension if it answers
 * (X11 or Wayland), plain X11 tools in an X11 session, else nothing.
 * cb(backend), not started yet.
 */
function pickDesktop(ctx, events, cb) {
  const wayland = process.env.XDG_SESSION_TYPE === 'wayland' || (!!process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== 'x11');
  const force = process.env.LYDIA_DESKTOP; // x11 | gnome | none, for testing
  if (force === 'x11') return cb(new X11Desktop(ctx, events));
  if (force === 'none') return cb(new NoDesktop());
  probe((gnome) => {
    if (gnome) return cb(new GnomeDesktop(ctx, events));
    if (!wayland && process.env.DISPLAY && force !== 'gnome') return cb(new X11Desktop(ctx, events));
    cb(new NoDesktop());
  });
}

module.exports = { pickDesktop, wayland: () => process.env.XDG_SESSION_TYPE === 'wayland' };
