const { execFile, spawn } = require('child_process');
const path = require('path');
const { launchedBySteam } = require('./steam');

/**
 * Plain X11 (any desktop): xprop, xdotool and pointer.py (XQueryPointer).
 * Under Wayland these only see X11 apps, so it is used only in X11 sessions.
 *
 * ctx: { primary() -> bounds, zone() -> rect below the panel, selfXid() }
 * events: { pointer({x, y}), fullscreen(full, game), covered(bool) }
 */
class X11Desktop {
  constructor(ctx, events) {
    this.name = 'x11';
    this.ctx = ctx;
    this.events = events;
    this.spies = [];
    this.timers = [];
    this.fullscreen = false;
    this.missing = [];
  }

  start() {
    this.watchPointer();
    this.watchWindows();
    this.timers.push(setInterval(() => this.checkCovered(), 1500)); // dragging and resizing don't announce themselves
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.spies.forEach((p) => p.kill());
  }

  /** A missing tool: say so once, keep going without it. */
  lacks(tool) {
    if (this.missing.includes(tool)) return;
    this.missing.push(tool);
    console.log(`[lydia] ${tool} not found: some desktop features are off`);
  }

  spawn(cmd, args, tool = cmd) {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    p.on('error', () => this.lacks(tool));
    this.spies.push(p);
    return p;
  }

  // ---------- pointer (Electron's own value goes stale while she ignores the mouse) ----------

  watchPointer() {
    const p = this.spawn('python3', [path.join(__dirname, '..', 'pointer.py')], 'python3');
    let buf = '';
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      const m = /^(-?\d+) (-?\d+)$/.exec(lines.pop() ?? '');
      if (m) this.events.pointer({ x: Number(m[1]), y: Number(m[2]) });
    });
    this.hasPointer = true;
    p.on('exit', () => (this.hasPointer = false));
  }

  // ---------- windows ----------

  xprop(args, cb) {
    execFile('xprop', args, { timeout: 2000 }, (err, out) => {
      if (err?.code === 'ENOENT') this.lacks('xprop');
      cb(err ? '' : out);
    });
  }

  windowOnPrimary(id, cb) {
    execFile('xwininfo', ['-id', id], { timeout: 2000 }, (err, out) => {
      if (err) return cb(false);
      const num = (k) => Number(new RegExp(`${k}:\\s+(-?\\d+)`).exec(out)?.[1] ?? NaN);
      const b = this.ctx.primary();
      const cx = num('Absolute upper-left X') + num('Width') / 2;
      const cy = num('Absolute upper-left Y') + num('Height') / 2;
      cb(cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height);
    });
  }

  /**
   * Is any visible fullscreen window covering the primary monitor? Then GNOME
   * hides the panel there. Re-checked when windows open, close, restack or
   * change focus, and when the active window's state changes.
   */
  checkFullscreen() {
    this.xprop(['-root', '_NET_CLIENT_LIST_STACKING'], (out) => {
      const ids = out.match(/0x[0-9a-f]+/gi) ?? [];
      let pending = ids.length;
      let found = null;
      const apply = (full, game) => {
        const left = this.fullscreen && !full;
        this.fullscreen = full;
        this.events.fullscreen(full, game);
        if (left) this.checkCovered(); // skipped while fullscreen, so it may be stale
      };
      const done = () => {
        if (--pending > 0) return;
        if (!found) return apply(false, false);
        this.isGameWindow(found, (game) => apply(true, game));
      };
      if (!pending) {
        pending = 1;
        return done();
      }
      for (const id of ids) {
        this.xprop(['-id', id, '_NET_WM_STATE'], (st) => {
          if (!/_NET_WM_STATE_FULLSCREEN/.test(st) || /_NET_WM_STATE_HIDDEN/.test(st)) return done();
          this.windowOnPrimary(id, (yes) => {
            if (yes) found ??= id;
            done();
          });
        });
      }
    });
  }

  /** A Steam game: Proton windows say steam_app_<id>; native ones descend from steam/reaper. */
  isGameWindow(id, cb) {
    this.xprop(['-id', id, 'WM_CLASS', '_NET_WM_PID'], (out) => {
      if (/steam_app_\d+/i.test(out)) return cb(true);
      const pid = Number(/_NET_WM_PID\(CARDINAL\) = (\d+)/.exec(out)?.[1]);
      cb(pid > 0 && launchedBySteam(pid));
    });
  }

  /**
   * Does a visible window reach the strip right below the panel where she hangs?
   * One xdotool call lists every mapped window with its geometry.
   */
  checkCovered() {
    if (this.fullscreen) return;
    const zone = this.ctx.zone();
    const self = this.ctx.selfXid();
    const apply = (out) => {
      const below = [];
      for (const m of out.matchAll(/Window (\d+)\s+Position: (-?\d+),(-?\d+).*\s+Geometry: (\d+)x(\d+)/g)) {
        const [id, x, y, w, h] = m.slice(1).map(Number);
        if (id === self) continue;
        if (x < zone.x + zone.width && x + w > zone.x && y < zone.y + zone.height && y + h > zone.y) below.push(id);
      }
      if (!below.length) return this.events.covered(false);
      // GNOME keeps minimized windows mapped, only flagged hidden.
      let pending = below.length;
      let covered = false;
      for (const id of below) {
        this.xprop(['-id', String(id), '_NET_WM_STATE'], (st) => {
          if (!/_NET_WM_STATE_HIDDEN/.test(st)) covered = true;
          if (--pending === 0) this.events.covered(covered);
        });
      }
    };
    // --desktop keeps it to normal windows of this workspace (the desktop-icons
    // layer and other full-screen helpers have none).
    execFile('xdotool', ['get_desktop'], { timeout: 2000 }, (err, desk = '') => {
      if (err?.code === 'ENOENT') return this.lacks('xdotool');
      if (err || !/^\d+$/.test(desk.trim())) return;
      const args = ['search', '--onlyvisible', '--desktop', desk.trim(), '--name', '', 'getwindowgeometry', '%@'];
      execFile('xdotool', args, { timeout: 2000 }, (_e, out = '') => apply(out));
    });
  }

  watchWindows() {
    let timer = 0;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.checkFullscreen();
        this.checkCovered();
      }, 250);
    };
    let current = '';
    let activeSpy = null;
    this.spawn('xprop', ['-spy', '-root', '_NET_CLIENT_LIST_STACKING', '_NET_ACTIVE_WINDOW']).stdout.on('data', (chunk) => {
      soon();
      const id = /_NET_ACTIVE_WINDOW.*window id # (0x[0-9a-f]+)/i.exec(String(chunk))?.[1];
      if (!id || id === current) return;
      current = id;
      activeSpy?.kill();
      activeSpy = /^0x0+$/.test(id) ? null : this.spawn('xprop', ['-spy', '-id', id, '_NET_WM_STATE']);
      activeSpy?.stdout.on('data', soon);
    });
    this.checkFullscreen();
    this.checkCovered();
  }

  // ---------- keyboard focus ----------

  /** The window that has the keyboard now (to give it back later). */
  activeWindow(cb) {
    execFile('xdotool', ['getactivewindow'], { timeout: 1000 }, (_e, out = '') => cb(out.trim() || null));
  }

  activate(id) {
    execFile('xdotool', ['windowactivate', String(id)], { timeout: 1000 }, () => {});
  }

  setPanel() {
    return false; // only the GNOME helper can
  }

  setSuper() {
    return false;
  }

  notifications(cb) {
    cb(null); // only the GNOME helper can read them
  }

  notification() {}

  /** GNOME on X11 without the helper: the overview is the Super key. */
  overview() {
    execFile('xdotool', ['key', 'super'], { timeout: 1000 }, () => {});
    return true;
  }

  /** Lydia takes the keyboard herself (X11 lets a window ask). */
  focusSelf(win) {
    win.focus();
    win.webContents.focus();
  }
}

module.exports = { X11Desktop };
