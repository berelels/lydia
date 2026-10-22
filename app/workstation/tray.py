#!/usr/bin/env python3
"""The apps in the system tray (Discord, Steam, Spotify...): the
StatusNotifierItems the desktop's watcher knows (KDE has one; on GNOME the
AppIndicator extension is it). One command per run, JSON on stdout:

    tray.py list                       -> [{service, path, id, title, icon, iconName, menu, onlyMenu}]
    tray.py activate SERVICE PATH      -> {ok}           (a left click: usually shows the app)
    tray.py menu SERVICE MENUPATH      -> {items: [...]} (its menu, as dbusmenu describes it)
    tray.py click SERVICE MENUPATH ID  -> {ok}           (one of the menu's entries)
"""
import base64
import json
import os
import sys

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf, Gio, GLib  # noqa: E402

SNI = "org.kde.StatusNotifierItem"
MENU = "com.canonical.dbusmenu"
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def call(service, path, iface, method, args=None, reply=None, timeout=1500):
    return bus.call_sync(service, path, iface, method, args, GLib.VariantType(reply) if reply else None, Gio.DBusCallFlags.NONE, timeout, None)


def props(service, path):
    return call(service, path, "org.freedesktop.DBus.Properties", "GetAll", GLib.Variant("(s)", (SNI,)), "(a{sv})").unpack()[0]


def split(entry):
    """':1.91@/org/ayatana/...', ':1.40/StatusNotifierItem' or a bus name alone."""
    if "@" in entry:
        service, path = entry.split("@", 1)
    elif "/" in entry:
        i = entry.index("/")
        service, path = entry[:i], entry[i:]
    else:
        service, path = entry, "/StatusNotifierItem"
    return service, path


def pixmap_png(pixmaps):
    """IconPixmap (ARGB32, network byte order) -> a PNG data URL, the size closest to 48."""
    if not pixmaps:
        return ""
    w, h, data = min(pixmaps, key=lambda p: abs(p[0] - 48))
    if not w or not h:
        return ""
    raw = bytes(data)
    rgba = bytearray(len(raw))
    rgba[0::4], rgba[1::4], rgba[2::4], rgba[3::4] = raw[1::4], raw[2::4], raw[3::4], raw[0::4]
    pb = GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(bytes(rgba)), GdkPixbuf.Colorspace.RGB, True, 8, w, h, w * 4)
    ok, buf = pb.save_to_bufferv("png", [], [])
    return "data:image/png;base64," + base64.b64encode(buf).decode() if ok else ""


def theme_icon(name, theme_path):
    """An icon shipped in the app's own folder (IconThemePath), as a data URL."""
    if not name or not theme_path:
        return ""
    for root, _dirs, files in os.walk(theme_path):
        for ext in (".png", ".svg"):
            if name + ext in files:
                with open(os.path.join(root, name + ext), "rb") as f:
                    kind = "svg+xml" if ext == ".svg" else "png"
                    return f"data:image/{kind};base64," + base64.b64encode(f.read()).decode()
    return ""


def list_items():
    try:
        entries = call("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", ("org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems")), "(v)").unpack()[0]
    except GLib.Error:
        return None  # no watcher: this desktop shows no tray
    items = []
    for entry in entries:
        service, path = split(entry)
        try:
            p = props(service, path)
        except GLib.Error:
            continue
        if p.get("Status") == "Passive":
            continue  # it asked not to be shown right now
        name = p.get("IconName") or ""
        icon = pixmap_png(p.get("IconPixmap")) if not name else theme_icon(name, p.get("IconThemePath") or "")
        tip = p.get("ToolTip")
        title = p.get("Title") or (tip[2] if tip else "") or p.get("Id") or ""
        items.append({
            "service": service,
            "path": path,
            "id": p.get("Id") or "",
            "title": title,
            "icon": icon,
            "iconName": name if not icon else "",
            "menu": p.get("Menu") or "",
            "onlyMenu": bool(p.get("ItemIsMenu")),
        })
    return items


def layout(node):
    item_id, attrs, children = node
    label = attrs.get("label", "").replace("__", "\0").replace("_", "").replace("\0", "_")
    return {
        "id": item_id,
        "label": label,
        "type": attrs.get("type", "standard"),
        "enabled": attrs.get("enabled", True),
        "visible": attrs.get("visible", True),
        "toggle": attrs.get("toggle-type", ""),
        "checked": attrs.get("toggle-state", 0) == 1,
        "children": [layout(c) for c in children],
    }


def menu(service, menu_path):
    try:
        call(service, menu_path, MENU, "AboutToShow", GLib.Variant("(i)", (0,)), "(b)")
    except GLib.Error:
        pass  # optional in the spec
    _rev, root = call(service, menu_path, MENU, "GetLayout", GLib.Variant("(iias)", (0, -1, [])), "(u(ia{sv}av))").unpack()
    return [c for c in layout(root)["children"] if c["visible"]]


def main():
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "list":
        out = list_items()
    elif cmd == "activate":
        try:
            call(args[0], args[1], SNI, "Activate", GLib.Variant("(ii)", (0, 0)))
            out = {"ok": True}
        except GLib.Error:
            out = {"ok": False}  # many (Ayatana) items only have a menu
    elif cmd == "menu":
        out = {"items": menu(args[0], args[1])}
    elif cmd == "click":
        call(args[0], args[1], MENU, "Event", GLib.Variant("(isvu)", (int(args[2]), "clicked", GLib.Variant("i", 0), 0)))
        out = {"ok": True}
    else:
        raise SystemExit("unknown command")
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
