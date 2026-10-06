#!/usr/bin/env python3
"""Prints the pointer position ("x y") whenever it changes, ~20 times a second.

Electron only learns where the cursor is from events its own windows receive,
and Lydia's window lets every click and motion through while collapsed, so it
asks X11 directly. Exits when stdin closes (Lydia quit or crashed).
"""
import ctypes
import ctypes.util
import select
import sys

x11 = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XQueryPointer.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong,
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_uint),
]

display = x11.XOpenDisplay(None)
if not display:
    sys.exit("no X display")
root = x11.XDefaultRootWindow(display)

root_ret, child = ctypes.c_ulong(), ctypes.c_ulong()
rx, ry, wx, wy = (ctypes.c_int() for _ in range(4))
mask = ctypes.c_uint()
last = None

while True:
    # Waiting on stdin doubles as the 50 ms sleep and notices the parent leaving.
    ready, _, _ = select.select([sys.stdin], [], [], 0.05)
    if ready and not sys.stdin.readline():
        break
    x11.XQueryPointer(display, root, ctypes.byref(root_ret), ctypes.byref(child),
                      ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(wx), ctypes.byref(wy),
                      ctypes.byref(mask))
    pos = (rx.value, ry.value)
    if pos != last:
        last = pos
        sys.stdout.write(f"{pos[0]} {pos[1]}\n")
        sys.stdout.flush()
