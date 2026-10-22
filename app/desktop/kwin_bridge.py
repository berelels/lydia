#!/usr/bin/env python3
"""Owns lydia.KWin on the session bus and prints what the KWin script sends
(one event per line) for Lydia to read. Exits when stdin closes (Lydia quit)."""
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

XML = """<node><interface name="lydia.KWin"><method name="Event"><arg type="s" name="e" direction="in"/></method></interface></node>"""


def main():
    loop = GLib.MainLoop()
    node = Gio.DBusNodeInfo.new_for_xml(XML)

    def call(_conn, _sender, _path, _iface, method, params, invocation):
        if method == "Event":
            sys.stdout.write(params.unpack()[0].replace("\n", " ") + "\n")
            sys.stdout.flush()
        invocation.return_value(None)

    def acquired(conn, _name):
        conn.register_object("/lydia/KWin", node.interfaces[0], call, None, None)
        sys.stdout.write("ready\n")
        sys.stdout.flush()

    Gio.bus_own_name(Gio.BusType.SESSION, "lydia.KWin", Gio.BusNameOwnerFlags.NONE, acquired, None, lambda *_: loop.quit())
    GLib.io_add_watch(GLib.IOChannel.unix_new(sys.stdin.fileno()), GLib.PRIORITY_DEFAULT, GLib.IO_HUP | GLib.IO_IN, lambda *_: (loop.quit(), False)[1])
    loop.run()


if __name__ == "__main__":
    main()
