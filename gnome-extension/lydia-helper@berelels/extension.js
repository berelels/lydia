// Lydia helper: what Lydia can't see by herself on Wayland (and sees better on
// X11): where the pointer is, whether a window is fullscreen on the primary
// monitor (and which), and whether one reaches the strip below the top panel.
// Exposed on the session bus as lydia.Desktop. Idle unless Lydia keeps calling Watch.
// It can also hide the top panel while Lydia runs (she takes its place, the
// overview included), and
// hand her the Super key (it opens her instead of the overview); both come
// back as soon as Lydia stops calling. And it lists the system's notifications
// (WhatsApp, Discord...) for her bell, to open or dismiss them.
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'lydia.Desktop';
const PATH = '/lydia/Desktop';
const IFACE = `
<node>
  <interface name="lydia.Desktop">
    <method name="Watch">
      <arg type="u" name="pid" direction="in"/>
      <arg type="i" name="x" direction="in"/>
      <arg type="i" name="y" direction="in"/>
      <arg type="i" name="width" direction="in"/>
      <arg type="i" name="height" direction="in"/>
      <arg type="u" name="version" direction="out"/>
    </method>
    <method name="ActiveWindow">
      <arg type="t" name="id" direction="out"/>
    </method>
    <method name="Activate">
      <arg type="t" name="id" direction="in"/>
    </method>
    <method name="FocusSelf"/>
    <method name="SetPanel">
      <arg type="b" name="hidden" direction="in"/>
    </method>
    <method name="SetSuper">
      <arg type="b" name="mine" direction="in"/>
    </method>
    <method name="Overview"/>
    <method name="Notifications">
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="ActivateNotification">
      <arg type="u" name="id" direction="in"/>
    </method>
    <method name="DismissNotification">
      <arg type="u" name="id" direction="in"/>
    </method>
    <signal name="NotificationsChanged"/>
    <signal name="Super"/>
    <signal name="Pointer">
      <arg type="i" name="x"/>
      <arg type="i" name="y"/>
    </signal>
    <signal name="Windows">
      <arg type="b" name="fullscreen"/>
      <arg type="s" name="wmClass"/>
      <arg type="u" name="pid"/>
      <arg type="b" name="covered"/>
    </signal>
  </interface>
</node>`;

const VERSION = 4;
const KEEPALIVE_MS = 15000; // Lydia calls Watch every 5 s; silent this long, she is gone
const POINTER_MS = 50;
const WINDOWS_MS = 700; // moves and resizes have no cheap global signal
// GNOME 49 replaced get_maximized() with is_maximized()
const maximized = (w) => (w.is_maximized ? w.is_maximized() : w.get_maximized() === Meta.MaximizeFlags.BOTH);

const COVERING = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY];

export default class LydiaHelper extends Extension {
  enable() {
    this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
    this._dbus.export(Gio.DBus.session, PATH);
    this._owner = Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    this._pid = 0;
    this._zone = null;
    this._until = 0;
    this._last = { pointer: '', windows: '' };
    this._signals = [];
    this._timers = [];
    this._wantHidden = false;
    this._panelHidden = false;
    this._wantSuper = false;
    this._superId = 0; // our overlay-key handler while the Super key is Lydia's
    this._refitId = 0; // waiting for the work area to change (see _refitAfter)
    // notifications: each gets a number Lydia can name it by
    this._notifs = new Map(); // id -> notification
    this._notifIds = new WeakMap(); // notification -> id
    this._nextNotif = 1;
    const changed = () => this._dbus?.emit_signal('NotificationsChanged', null);
    const watchSource = (src) => src.connectObject('notification-added', changed, 'notification-removed', changed, this);
    Main.messageTray.getSources().forEach(watchSource);
    Main.messageTray.connectObject('source-added', (_t, src) => (watchSource(src), changed()), 'source-removed', changed, this);
  }

  disable() {
    Main.messageTray.disconnectObject(this);
    Main.messageTray.getSources().forEach((src) => src.disconnectObject(this));
    this._notifs.forEach((n) => n.disconnectObject(this));
    this._notifs.clear();
    if (this._refitId) global.display.disconnect(this._refitId);
    this._refitId = 0;
    this._wantHidden = false;
    this._applyPanel();
    this._wantSuper = false;
    this._applySuper();
    this._sleep();
    Gio.bus_unown_name(this._owner);
    this._dbus.unexport();
    this._dbus = null;
  }

  // ---------- D-Bus methods ----------

  Watch(pid, x, y, width, height) {
    this._pid = pid;
    this._zone = { x, y, width, height };
    this._until = Date.now() + KEEPALIVE_MS;
    if (!this._timers.length) this._wake();
    this._last.windows = ''; // a (re)connected Lydia gets the current state at once
    this._windows();
    return VERSION;
  }

  /** Hide the top panel (its space too) while Lydia keeps calling Watch. */
  SetPanel(hidden) {
    this._wantHidden = hidden;
    this._applyPanel();
  }

  /** The Super key opens Lydia (a Super signal) instead of the overview, while she keeps calling Watch. */
  SetSuper(mine) {
    this._wantSuper = mine;
    this._applySuper();
  }

  /** Lydia's "workspaces" button. */
  Overview() {
    Main.overview.toggle();
  }

  /** The notifications in the tray, newest first, as JSON (non-ASCII escaped, so gdbus prints it plainly). */
  Notifications() {
    const iconOf = (g) => (g instanceof Gio.ThemedIcon ? g.get_names()[0] : g instanceof Gio.FileIcon ? g.get_file().get_path() : '');
    const list = [];
    for (const src of Main.messageTray.getSources()) {
      for (const n of src.notifications) {
        if (!this._notifIds.has(n)) {
          const id = this._nextNotif++;
          this._notifIds.set(n, id);
          this._notifs.set(id, n);
          n.connectObject('destroy', () => this._notifs.delete(id), this);
        }
        list.push({
          id: this._notifIds.get(n),
          app: src.title ?? '',
          title: n.title ?? '',
          body: n.body ?? '',
          time: n.datetime ? n.datetime.to_unix() * 1000 : 0,
          icon: iconOf(n.gicon) || iconOf(src.icon),
        });
      }
    }
    list.sort((a, b) => b.time - a.time);
    return JSON.stringify(list).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  }

  ActivateNotification(id) {
    this._notifs.get(id)?.activate();
  }

  DismissNotification(id) {
    this._notifs.get(id)?.destroy();
  }

  ActiveWindow() {
    return global.display.focus_window?.get_id() ?? 0;
  }

  Activate(id) {
    const w = global.display.list_all_windows().find((x) => x.get_id() === id);
    if (w) Main.activateWindow(w);
  }

  /** Wayland doesn't let a window take the keyboard by itself; the shell can give it. */
  FocusSelf() {
    const w = this._self();
    if (w) Main.activateWindow(w);
  }

  // ---------- watching ----------

  _wake() {
    const d = global.display;
    const later = () => this._windows();
    this._signals = [
      [d, d.connect('in-fullscreen-changed', later)],
      [d, d.connect('restacked', later)],
      [d, d.connect('window-created', later)],
      [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', later)],
    ];
    this._timers = [
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, POINTER_MS, () => this._tick()),
      GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, WINDOWS_MS, () => (this._windows(), GLib.SOURCE_CONTINUE)),
    ];
  }

  _sleep() {
    for (const [obj, id] of this._signals) obj.disconnect(id);
    for (const id of this._timers) GLib.source_remove(id);
    this._signals = [];
    this._timers = [];
  }

  _tick() {
    if (Date.now() > this._until) {
      this._sleep();
      this._applyPanel(); // Lydia is gone: the panel comes back
      this._applySuper(); // ...and Super opens the overview again
      return GLib.SOURCE_REMOVE;
    }
    const [x, y] = global.get_pointer();
    const key = `${x},${y}`;
    if (key !== this._last.pointer) {
      this._last.pointer = key;
      this._dbus.emit_signal('Pointer', new GLib.Variant('(ii)', [x, y]));
    }
    return GLib.SOURCE_CONTINUE;
  }

  _applyPanel() {
    const hide = this._wantHidden && Date.now() <= this._until;
    if (hide === this._panelHidden) return;
    this._panelHidden = hide;
    this._refitAfter();
    const lm = Main.layoutManager;
    const box = lm.panelBox;
    // tracked again without struts (windows and the work area take its space) and
    // without trackFullscreen, or the shell shows it again on every overview
    try {
      lm.removeChrome(box);
      lm.addChrome(box, { affectsStruts: !hide, trackFullscreen: !hide });
    } catch (e) {
      logError(e, 'Lydia helper: panel');
      if (!box.get_parent()) lm.addChrome(box, { affectsStruts: true, trackFullscreen: true }); // never lose the panel
      this._panelHidden = false;
      box.show();
      return;
    }
    box.visible = !hide;
  }

  _applySuper() {
    const mine = this._wantSuper && Date.now() <= this._until;
    if (mine === !!this._superId) return;
    const d = global.display;
    try {
      if (mine) {
        // the shell's own handler (the overview) is held back while ours answers
        GObject.signal_handlers_block_matched(d, { signalId: 'overlay-key' });
        this._superId = d.connect('overlay-key', () => this._dbus?.emit_signal('Super', null));
      } else {
        d.disconnect(this._superId);
        this._superId = 0;
        GObject.signal_handlers_unblock_matched(d, { signalId: 'overlay-key' });
      }
    } catch (e) {
      logError(e, 'Lydia helper: Super key');
    }
  }

  /** The primary monitor's work area now. */
  _workArea() {
    const ws = global.workspace_manager.get_active_workspace();
    return ws.get_work_area_for_monitor(global.display.get_primary_monitor());
  }

  /**
   * The work area is about to change (the panel in or out). Maximized
   * windows follow by themselves; tiled ones (Zorin's tiling, a browser
   * snapped to the top) don't, and would leave the old strip empty with the
   * wallpaper showing: those touching the old top edge are stretched to the new one.
   */
  _refitAfter() {
    if (this._refitId) return; // one pending is enough: it compares with the area before all of it
    const before = this._workArea();
    const stop = () => {
      if (!this._refitId) return;
      global.display.disconnect(this._refitId);
      this._refitId = 0;
    };
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => (stop(), GLib.SOURCE_REMOVE)); // it never changed: forget it
    this._refitId = global.display.connect('workareas-changed', () => {
      stop();
      const after = this._workArea();
      const near = (a, b) => Math.abs(a - b) <= 2;
      const primary = global.display.get_primary_monitor();
      for (const actor of global.get_window_actors()) {
        const w = actor.get_meta_window();
        if (!w || w.get_monitor() !== primary || w.is_fullscreen() || w.minimized) continue;
        if (w.get_window_type() !== Meta.WindowType.NORMAL || maximized(w)) continue;
        const r = w.get_frame_rect();
        if (!near(r.y, before.y)) continue;
        const bottom = near(r.y + r.height, before.y + before.height) ? after.y + after.height : r.y + r.height;
        w.move_resize_frame(true, r.x, after.y, r.width, bottom - after.y);
      }
    });
  }

  _self() {
    return global.display.list_all_windows().find((w) => w.get_pid() === this._pid) ?? null;
  }

  _windows() {
    if (!this._dbus || !this._zone) return;
    const d = global.display;
    const primary = d.get_primary_monitor();
    const fullscreen = d.get_monitor_in_fullscreen(primary);
    const ws = global.workspace_manager.get_active_workspace();
    const z = this._zone;
    let top = null;
    let covered = false;
    for (const w of ws.list_windows()) {
      if (w.minimized || w.get_pid() === this._pid || !COVERING.includes(w.get_window_type())) continue;
      if (fullscreen && w.is_fullscreen() && w.get_monitor() === primary) top ??= w;
      const r = w.get_frame_rect();
      if (r.x < z.x + z.width && r.x + r.width > z.x && r.y < z.y + z.height && r.y + r.height > z.y) covered = true;
    }
    const state = [fullscreen, top?.get_wm_class() ?? '', top?.get_pid() ?? 0, !fullscreen && covered];
    const key = JSON.stringify(state);
    if (key === this._last.windows) return;
    this._last.windows = key;
    this._dbus.emit_signal('Windows', new GLib.Variant('(bsub)', state));
  }
}
