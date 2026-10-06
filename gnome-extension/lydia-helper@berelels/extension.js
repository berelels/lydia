// Lydia helper: what Lydia can't see by herself on Wayland (and sees better on
// X11): where the pointer is, whether a window is fullscreen on the primary
// monitor (and which), and whether one reaches the strip below the top panel.
// Exposed on the session bus as lydia.Desktop. Idle unless Lydia keeps calling Watch.
import GLib from 'gi://GLib';
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

const VERSION = 1;
const KEEPALIVE_MS = 15000; // Lydia calls Watch every 5 s; silent this long, she is gone
const POINTER_MS = 50;
const WINDOWS_MS = 700; // moves and resizes have no cheap global signal
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
  }

  disable() {
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
