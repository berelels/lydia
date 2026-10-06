import signal
import sys
import time

import cairo
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gio, GLib, Gtk  # noqa: E402

from . import config
from .character import RADIUS, draw_bubble, draw_character
from .monitor import RamMonitor

WIDTH, HEIGHT = 380, 270
CX, CY = WIDTH // 2, 95
FPS_MS = 40


class LydiaWindow(Gtk.ApplicationWindow):
    def __init__(self, app, cfg):
        super().__init__(application=app, title="Lydia")
        self.cfg = cfg
        self.monitor = RamMonitor(cfg)
        self.alert = 0.0
        self.alert_target = 0.0
        self.paused = False
        self.bubble_text = None
        self.bubble_timer = 0
        self.demo_until = 0.0
        self.t0 = time.monotonic()

        self.set_decorated(False)
        self.set_resizable(False)
        self.set_default_size(WIDTH, HEIGHT)
        self.set_keep_above(True)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        self.set_accept_focus(False)
        self.set_focus_on_map(False)
        self.set_type_hint(Gdk.WindowTypeHint.UTILITY)
        self.stick()

        visual = self.get_screen().get_rgba_visual()
        if visual is not None:
            self.set_visual(visual)
        self.set_app_paintable(True)
        css = Gtk.CssProvider()
        css.load_from_data(b"window, window.background { background: transparent; box-shadow: none; }")
        Gtk.StyleContext.add_provider_for_screen(
            self.get_screen(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )

        self.area = Gtk.DrawingArea()
        self.area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)
        self.area.connect("draw", self.on_draw)
        self.area.connect("button-press-event", self.on_click)
        self.add(self.area)

        self.connect("realize", lambda *_: self.update_input_shape())
        self.place()

        GLib.timeout_add(FPS_MS, self.tick)
        GLib.timeout_add_seconds(int(cfg["check_interval_seconds"]), self.poll_ram)

    # ---- placement -------------------------------------------------------
    def place(self):
        display = Gdk.Display.get_default()
        mon = display.get_primary_monitor() or display.get_monitor(0)
        work = mon.get_workarea()
        self.move(work.x + (work.width - WIDTH) // 2, work.y + 4)

    def update_input_shape(self):
        """Only the character and the bubble take clicks; the rest lets them through."""
        gdk_window = self.get_window()
        if gdk_window is None:
            return
        r = RADIUS + 12
        region = cairo.Region(cairo.RectangleInt(CX - r, CY - r - 24, 2 * r, 2 * r + 44))
        if self.bubble_text:
            region.union(cairo.RectangleInt(20, CY + RADIUS + 14, WIDTH - 40, HEIGHT - CY - RADIUS - 14))
        gdk_window.input_shape_combine_region(region, 0, 0)

    # ---- behaviour -------------------------------------------------------
    def show_bubble(self, text, seconds=None):
        self.bubble_text = text
        self.update_input_shape()
        if self.bubble_timer:
            GLib.source_remove(self.bubble_timer)
        self.bubble_timer = GLib.timeout_add_seconds(
            int(seconds or self.cfg["bubble_seconds"]), self.hide_bubble
        )

    def hide_bubble(self):
        self.bubble_text = None
        self.bubble_timer = 0
        self.update_input_shape()
        return False

    def poll_ram(self):
        if self.paused:
            return True
        status = self.monitor.poll()
        simulated = time.monotonic() < self.demo_until
        self.alert_target = 1.0 if (status["over"] or simulated) else 0.0
        if status["event"] == "alert":
            self.show_bubble("Ei, a memória está apertada!\n" + self.monitor.summary(), 14)
        elif status["event"] == "recovered":
            self.show_bubble("Ufa, a RAM voltou ao normal.", 5)
        return True

    def test_alert(self, *_):
        self.demo_until = time.monotonic() + 12
        self.alert_target = 1.0
        self.show_bubble("Teste: assim eu aviso quando a RAM passar de "
                         f"{self.cfg['ram_threshold_percent']:.0f}%.\n" + self.monitor.summary(), 12)
        return True

    def toggle_pause(self, *_):
        self.paused = not self.paused
        self.alert_target = 0.0
        self.show_bubble("Zzz... alertas pausados." if self.paused else "Voltei! Vou ficar de olho na RAM.", 4)

    def on_click(self, _area, event):
        if event.button == 3:
            menu = Gtk.Menu()
            for label, handler in (
                ("Mostrar uso de RAM", lambda *_: self.show_bubble(self.monitor.summary(), 8)),
                ("Testar alerta", self.test_alert),
                ("Retomar alertas" if self.paused else "Pausar alertas", self.toggle_pause),
                ("Sair", lambda *_: self.get_application().quit()),
            ):
                item = Gtk.MenuItem(label=label)
                item.connect("activate", handler)
                menu.append(item)
            menu.show_all()
            menu.popup_at_pointer(event)
        elif event.button == 1:
            if self.bubble_text:
                self.hide_bubble()
            else:
                self.show_bubble(self.monitor.summary(), 8)
        return True

    # ---- drawing ---------------------------------------------------------
    def pointer_look(self):
        win = self.get_window()
        if win is None:
            return (0.0, 0.0)
        seat = Gdk.Display.get_default().get_default_seat()
        _screen, px, py = seat.get_pointer().get_position()
        _ok, ox, oy = win.get_origin()
        dx, dy = px - (ox + CX), py - (oy + CY)
        dist = (dx * dx + dy * dy) ** 0.5 or 1.0
        k = min(1.0, dist / 350)
        return (dx / dist * k, dy / dist * k)

    def tick(self):
        self.alert += (self.alert_target - self.alert) * 0.12
        self.area.queue_draw()
        return True

    def on_draw(self, _area, cr):
        cr.set_operator(cairo.OPERATOR_CLEAR)
        cr.paint()
        cr.set_operator(cairo.OPERATOR_OVER)
        t = time.monotonic() - self.t0
        draw_character(cr, CX, CY, t, self.alert, self.paused, self.pointer_look())
        if self.bubble_text:
            draw_bubble(cr, WIDTH, CY + RADIUS + 22, self.bubble_text)
        return False


class LydiaApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="dev.lydia.Companion", flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.window = None

    def do_activate(self):
        if self.window is None:
            self.window = LydiaWindow(self, config.load())
            GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR1, self.window.test_alert)
            GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, lambda: self.quit() or False)
            GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, lambda: self.quit() or False)
            self.window.show_all()
            self.window.show_bubble("Oi! Eu sou a Lydia.", 4)
        self.window.present()


def main():
    return LydiaApp().run(sys.argv[:1])
