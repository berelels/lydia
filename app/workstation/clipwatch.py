#!/usr/bin/env python3
"""Clipboard helper for Lydia (GTK, its own process).

Reading the X clipboard from Electron's main process can block it for good
(it waits on the owner of the selection), so this small process does it:
it waits for the clipboard to change and prints one JSON line per copy:
  {"kind": "text", "text": "..."}
  {"kind": "image", "png": "<base64>", "w": 800, "h": 600}
and puts things back on the clipboard when asked, one JSON line on stdin:
  {"text": "..."}   or   {"png": "<base64>"}
"""
import base64
import json
import os
import sys

os.environ.setdefault("GDK_BACKEND", "x11")  # the X clipboard is shared with Wayland apps through XWayland

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk  # noqa: E402

clip = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def got_image(_clip, pixbuf):
    if pixbuf is None:
        return
    ok, data = pixbuf.save_to_bufferv("png", [], [])
    if ok:
        out({"kind": "image", "png": base64.b64encode(data).decode(), "w": pixbuf.get_width(), "h": pixbuf.get_height()})


def got_text(_clip, text):
    if text:
        out({"kind": "text", "text": text})


def got_targets(_clip, atoms, _n=None):
    names = [a.name() for a in (atoms or [])]
    if any(n.startswith("image/") for n in names) and not any(n in ("UTF8_STRING", "text/plain;charset=utf-8") for n in names):
        clip.request_image(got_image)
    elif names:
        clip.request_text(got_text)


def changed(_clip, _event):
    clip.request_targets(got_targets)  # also for our own changes: Lydia ignores what is already on top


def command(source, _cond):
    line = source.readline()
    if not line:
        Gtk.main_quit()
        return False
    try:
        cmd = json.loads(line)
        if "text" in cmd:
            clip.set_text(cmd["text"], -1)
        elif "png" in cmd:
            loader = GdkPixbuf.PixbufLoader.new_with_type("png")
            loader.write(base64.b64decode(cmd["png"]))
            loader.close()
            clip.set_image(loader.get_pixbuf())
        clip.store()
    except Exception as err:  # a bad line must not end the helper
        sys.stderr.write(f"clipwatch: {err}\n")
    return True


clip.connect("owner-change", changed)
GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, command)
Gtk.main()
