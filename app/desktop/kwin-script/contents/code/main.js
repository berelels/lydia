// Lydia helper for KDE Plasma (Wayland): what she can't see by herself there.
// Sends the pointer position and whether the active window is fullscreen to
// her bridge (lydia.KWin on the session bus), as short text events:
//   "P x y"            the pointer moved
//   "F 1 class pid"    the active window is fullscreen (0: it isn't)
// Loaded by Lydia when she starts and unloaded when she quits.

const send = (event) => callDBus('lydia.KWin', '/lydia/KWin', 'lydia.KWin', 'Event', event);

let lastPointer = '';
function pointer() {
  const p = workspace.cursorPos;
  const key = `${Math.round(p.x)} ${Math.round(p.y)}`;
  if (key === lastPointer) return;
  lastPointer = key;
  send(`P ${key}`);
}

let lastFull = '';
let watched = null;
function fullscreen() {
  const w = workspace.activeWindow || workspace.activeClient; // Plasma 6 / 5
  const full = !!(w && w.fullScreen);
  const state = full ? `F 1 ${String(w.resourceClass || '').replace(/\s/g, '_') || '-'} ${w.pid || 0}` : 'F 0 - 0';
  if (state === lastFull) return;
  lastFull = state;
  send(state);
}
function activated(w) {
  if (watched) watched.fullScreenChanged.disconnect(fullscreen);
  watched = w && w.fullScreenChanged ? w : null;
  if (watched) watched.fullScreenChanged.connect(fullscreen);
  fullscreen();
}

workspace.cursorPosChanged.connect(pointer);
(workspace.windowActivated || workspace.clientActivated).connect(activated);
activated(workspace.activeWindow || workspace.activeClient);
pointer();
