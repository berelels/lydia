const { app, BrowserWindow, Menu, ipcMain, screen, safeStorage, shell, clipboard, nativeTheme, globalShortcut, dialog } = require('electron');
const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const i18n = require('./i18n');
const { t } = i18n;
const sys = require('./monitor');
const { ChatSession, MODELS, findClaude } = require('./chat');
const { GeminiChat, OllamaChat, ollamaModels, geminiModels, stopOllama, geminiGenerate, geminiSpeech } = require('./providers');
const { pickDesktop } = require('./desktop');
const setup = require('./setup');
const voice = require('./assistant/voice');
const brain = require('./assistant/brain');
const { TOOLS, findApp } = require('./assistant/tools');
const intents = require('./assistant/intents');
const voiceInstall = require('./assistant/install');
const controls = require('./workstation/controls');
const nowplaying = require('./workstation/nowplaying');
const { Spectrum } = require('./workstation/spectrum');
const { weather } = require('./workstation/weather');
const today = require('./workstation/today');
const clip = require('./workstation/clipboard');
const files = require('./workstation/files');

// Under Wayland, run through XWayland: a native Wayland window can't place
// itself at the top of the screen or stay above the others. Chromium picks its
// platform before this file runs, so the switch only works on the command line:
// start again with it.
if (process.env.WAYLAND_DISPLAY && !process.argv.some((a) => a.startsWith('--ozone-platform=')) && process.env.LYDIA_NATIVE_WAYLAND !== '1') {
  app.relaunch({ args: [...process.argv.slice(1), '--ozone-platform=x11'] });
  app.exit(0);
}

// Window-local geometry. The window never moves or resizes: it starts at the
// very top of the screen (see-through over the panel), the island grows and
// slides inside it, and the X11 input shape follows, so the rest stays click-through.
const GEOM = {
  winW: 840,
  winH: 530, // below the panel: room for the tallest view (+ its shadow)
  pill: { w: 210, h: 38 }, // hanging from the panel when nothing is below it
  music: { w: 360, h: 86 }, // something is playing (and nothing is below): a small player
  // A window right below the panel (a maximized browser's address bar): just a
  // thin handle, so she covers nothing. (GNOME draws its panel above every
  // window, so she can't live inside it.)
  lip: { w: 64, h: 7 },
  mini: { w: 64, h: 24 }, // fullscreen: just her eyes peeking from the top edge
  panel: { w: 720, h: 200 }, // w and h follow the open view, see VIEW_W / VIEW_H
  glow: 24, // room for the shadow around the visible island
};
// Size of the open panel for each view (the renderer uses the same numbers).
const VIEW_H = { notif: 400, home: 170, look: 460, tasks: 330, chat: 440, setup: 440, controls: 320, today: 390, clip: 380, apps: 380, wall: 270, power: 170 };
const VIEW_W = { notif: 560, home: 660, look: 720, tasks: 780, chat: 780, setup: 720, controls: 680, today: 780, clip: 660, apps: 700, wall: 780, power: 660 };
const HOVER_IN_MS = 90;
const HOVER_IN_FULLSCREEN_MS = 350; // reaching for a video's controls shouldn't pop her open
const HOVER_OUT_MS = 450;
const MORPH_MS = 420;

let win;
let cfg;
let watch; // { ram, cpuTemp, gpuTemp, hogs }
const state = {
  expanded: false,
  pinned: process.argv.includes('--pin-open'),
  paused: false,
  over: { ram: false, cpuTemp: false, gpuTemp: false }, // above the limit right now
  notice: null, // { kind, title, lines, actions, until }
  fullscreen: false, // a fullscreen window on the primary monitor hides the panel
  game: false, // ...and it is a Steam game
  peeking: false, // hidden for a game, but sneaking a look right now
  covered: false, // some window reaches the strip right below the panel, where she would hang
  view: 'home', // which view the open panel shows
  pokeUntil: 0, // SIGHUP: act as if the mouse were on her for a moment
  news: false, // a reply came while you were away, not seen yet
  byKey: false, // opened with the Super key: stays open until Super again, Esc, or the keyboard goes elsewhere
  voice: 'idle', // idle | listening | thinking | speaking
};
let hoverSince = 0;
let mouseOnCard = false; // the pointer is on the music card (it takes clicks then)
let leaveSince = 0;
let lastCursor = '';
let shapeTimer = null;
let shapeNow = null;
// top: where the island hangs inside the window (below the panel, or 0 in fullscreen).
// top: the collapsed island; topOpen: the open panel (both hang from the panel, or the screen edge).
const layout = { panel: 0, top: 0, topOpen: 0, lip: false, edge: false, compact: false, hidden: false, peek: false, winH: GEOM.winH };

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);

function islandRect(kind) {
  const w = kind === 'panel' ? VIEW_W[state.view] ?? GEOM.panel.w : GEOM[kind].w;
  const h = kind === 'panel' ? VIEW_H[state.view] ?? GEOM.panel.h : GEOM[kind].h;
  return { x: Math.round((GEOM.winW - w) / 2), y: kind === 'panel' ? layout.topOpen : layout.top, width: w, height: h };
}
const collapsedKind = () => (layout.lip ? 'lip' : layout.compact ? 'mini' : layout.music ? 'music' : 'pill');

function grow(r, m) {
  const x = Math.max(0, r.x - m);
  const y = Math.max(0, r.y - m);
  return {
    x,
    y,
    width: Math.min(GEOM.winW, r.x + r.width + m) - x,
    height: Math.min(layout.winH, r.y + r.height + m) - y,
  };
}

const inside = (p, r) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

function place() {
  const d = screen.getPrimaryDisplay();
  const area = d.workArea;
  const x = Math.round(area.x + (area.width - GEOM.winW) / 2);
  layout.panel = Math.max(0, area.y - d.bounds.y) + cfg.island_y_offset;
  layout.winH = GEOM.winH + layout.panel;
  win.setBounds({ x, y: d.bounds.y, width: GEOM.winW, height: layout.winH });
  relayout(true);
}

/**
 * Fullscreen: the island slides up to the screen edge (there is no panel) and,
 * unless something is wrong, shrinks to a small notch so it doesn't cover the video.
 */
const gameMode = () => state.game && cfg.hide_in_games;
// Out of sight: a Steam game (with peeks) or any other fullscreen, like a video (without).
const hideMode = () => gameMode() || (state.fullscreen && !state.game && cfg.hide_in_fullscreen);
const PREFS = ['music_card', 'hide_in_games', 'hide_in_fullscreen', 'chat_provider', 'language', 'voice_followup', 'voice_cloud', 'hide_gnome_panel', 'super_opens', 'super_tab', 'bar_content', 'weather_city', 'font_family', 'font_weight'];
const prefs = () => ({ ...Object.fromEntries(PREFS.map((k) => [k, cfg[k]])), lang: i18n.lang(), panelOk: desktop?.name === 'gnome' });

/** "system" follows the desktop's language; pt, en and es pick one. */
function applyLanguage() {
  i18n.setLang(i18n.resolve(cfg.language, app.getPreferredSystemLanguages?.() ?? [app.getLocale()]));
}

function relayout(force = false) {
  // Nothing below: she hangs from the panel. A window up there (a maximized
  // browser's address bar...): only a thin handle, unless something needs you
  // (then her eyes peek out). Fullscreen has no panel: she hangs from the screen
  // edge, as a small notch unless something is wrong.
  const needsYou = !!currentIssue();
  const covered = !state.fullscreen && state.covered && !state.ignoreCovered;
  // Unseen news shows as the full pill (it says what arrived) until you look.
  const lip = covered && !needsYou && !state.news && state.voice === 'idle';
  let top = state.fullscreen ? 0 : layout.panel;
  const topOpen = top;
  let compact = (state.fullscreen && !currentIssue()) || (covered && needsYou);
  let hidden = false;
  const peek = gameMode() && state.peeking;
  if (hideMode() && !peek && state.notice?.kind !== 'alert') {
    hidden = true; // out of sight above the screen edge; alerts still slide in
    top = -(GEOM.pill.h + GEOM.glow);
    compact = true;
  } else if (peek) compact = true;
  const music = !!state.mediaCard && !lip && !compact && !hidden;
  const next = { top, topOpen, lip, edge: state.fullscreen, compact, hidden, peek, music };
  if (!force && Object.entries(next).every(([k, v]) => layout[k] === v)) return;
  Object.assign(layout, next);
  if (process.env.LYDIA_DEBUG) {
    const why = { fullscreen: state.fullscreen, game: state.game, covered: state.covered, issue: !!currentIssue(), notice: state.notice?.kind ?? null };
    console.log(`[lydia] layout ${JSON.stringify(next)} ${JSON.stringify(why)}`);
  }
  send('layout', next);
  applyShape();
}

// While hidden for a game she sneaks a look every few minutes.
let peekTimer = 0;
function schedulePeek() {
  clearTimeout(peekTimer);
  if (!gameMode()) return;
  peekTimer = setTimeout(() => {
    if (!gameMode()) return;
    state.peeking = true;
    relayout();
    peekTimer = setTimeout(() => {
      state.peeking = false;
      relayout();
      schedulePeek();
    }, 3400);
  }, (150 + Math.random() * 270) * 1000);
}

/** Only the visible island takes the mouse. While it morphs, both outlines do. */
function applyShape() {
  clearTimeout(shapeTimer);
  if (!alive()) return;
  // The shape also clips drawing; hidden, nothing needs drawing.
  const target = layout.hidden
    ? { x: 0, y: 0, width: 1, height: 1 }
    : grow(islandRect(state.expanded ? 'panel' : collapsedKind()), GEOM.glow);
  // Collapsed (or hidden) she lets every click through; only the open panel takes them.
  win.setIgnoreMouseEvents((!state.expanded && desktop.hasPointer && !mouseOnCard) || layout.hidden);
  win.setShape(shapeNow ? [shapeNow, target] : [target]);
  shapeTimer = setTimeout(() => alive() && win.setShape([target]), MORPH_MS + 80);
  shapeNow = target;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const deg = (c) => `${Math.round(c)} °C`;
const pct = (x) => `${Math.round(x)}%`;

function hotProcesses() {
  return watch.hogs.latest.slice(0, 2).map((p) => `${p.name} ${pct(p.percent)}`).join(' · ');
}

function hogActions(h) {
  const stop = h.unit ? t('hog.stop_service') : t('hog.stop');
  return [
    { id: `stop:${h.pid}`, label: stop, primary: true },
    { id: `ignore:${h.name}`, label: t('hog.ignore') },
  ];
}

function hogNotice(h) {
  const where = h.unit ? t('hog.service', { name: h.unit.name }) : `PID ${h.pid}`;
  return {
    kind: 'alert',
    title: t('hog.title', { name: h.name, pct: pct(h.percent) }),
    lines: [`${h.minutes ? t('hog.since', { n: h.minutes }) : t('hog.since_lt')} · ${where}`, t('hog.why')],
    actions: hogActions(h),
  };
}

/** What is wrong right now, even after the notice about it went away. */
function currentIssue() {
  if (state.paused) return null;
  const hog = watch.hogs.active()[0];
  if (hog) return { pill: [hog.name, pct(hog.percent)], ...hogNotice(hog) };
  const temp = sys.temperatures();
  if (state.over.cpuTemp && temp.cpu != null)
    return { pill: ['CPU', deg(temp.cpu)], title: t('issue.cpu', { deg: deg(temp.cpu) }), lines: [t('issue.top', { list: hotProcesses() })] };
  if (state.over.gpuTemp && temp.gpu != null)
    return { pill: ['GPU', deg(temp.gpu)], title: t('issue.gpu', { deg: deg(temp.gpu) }), lines: [] };
  if (state.over.ram) {
    const m = sys.memory();
    return { pill: ['RAM', pct(m.percent)], title: t('issue.ram'), lines: ramLines().slice(1) };
  }
  return null;
}

function pushState() {
  relayout();
  const n = state.notice;
  send('state', {
    expanded: state.expanded,
    paused: state.paused,
    issue: currentIssue(),
    notice: n && { kind: n.kind, title: n.title, lines: n.lines, actions: n.actions ?? [] },
  });
}

// ---------- keyboard focus (only the chat needs it) ----------

let focusReturn = null; // the window that had the keyboard before the chat took it
function takeFocus() {
  if (!alive() || win.isFocused()) return;
  desktop.activeWindow((id) => {
    focusReturn = id;
    desktop.focusSelf(win);
  });
}
function giveFocusBack() {
  if (!alive() || !win.isFocused() || !focusReturn) return;
  desktop.activate(focusReturn);
  focusReturn = null;
}

// ---------- chat with Claude (temporary: nothing is saved) ----------

const CHAT_IDLE_MS = 20 * 60 * 1000;
let chat = null;
let chatProvider = null; // this conversation's engine; a new conversation goes back to the default
let chatModel = ''; // '' = the engine's default
const provider = () => chatProvider ?? cfg.chat_provider;
let chatIdle = 0;
let lastAsked = ''; // the question being answered (re-asked if the engine changes)
let fellBack = false;
function chatSession() {
  if (!chat) {
    const events = {
      onDelta: (text) => send('chat', { type: 'delta', text }),
      onDone: (r) => {
        // Every Gemini model out of quota or overloaded: answer with Claude instead, once.
        if (r.error && [429, 503].includes(r.status) && r.auto && provider() === 'gemini' && lastAsked && !fellBack && findClaude()) {
          fellBack = true;
          chat?.close();
          chat = null;
          chatProvider = 'claude';
          chatModel = '';
          send('chat', { type: 'note', text: t('chat.fell_back', { who: 'Claude' }) });
          try {
            return void chatSession().send(lastAsked);
          } catch {}
        }
        fellBack = false;
        send('chat', { type: 'done', ...r });
        const after = afterChat;
        afterChat = null;
        after?.(r);
      },
      onState: (s) => send('chat', { type: 'state', state: s }),
    };
    if (provider() === 'gemini') {
      const key = geminiKey();
      if (!key) throw new Error(t('chat.need_key'));
      chat = new GeminiChat({ ...events, key, model: chatModel });
    } else if (provider() === 'ollama') chat = new OllamaChat({ ...events, model: chatModel || cfg.ollama_model });
    else chat = new ChatSession({ ...events, model: chatModel });
  }
  clearTimeout(chatIdle);
  chatIdle = setTimeout(endChat, CHAT_IDLE_MS); // momentary, like a temporary chat
  return chat;
}
// The Gemini key is encrypted with the system keyring (Electron safeStorage);
// with no real keyring available it is not stored at all.
const keyFile = () => path.join(path.dirname(config.configPath()), 'gemini.key');
const secureStore = () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
function geminiKey() {
  try {
    return safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch {
    return '';
  }
}
function saveGeminiKey(key) {
  if (!secureStore()) return t('key.no_keyring');
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), safeStorage.encryptString(key), { mode: 0o600 });
  return null;
}
let geminiList = null;
async function chatInfo() {
  let ollama = [];
  try {
    ollama = await ollamaModels();
  } catch {}
  const key = geminiKey();
  if (key && !geminiList) geminiList = await geminiModels(key).catch(() => []);
  const models = {
    claude: MODELS(),
    gemini: [{ id: '', label: t('model.auto') }, ...(geminiList ?? []).map((m) => ({ id: m, label: m.replace(/^gemini-/, '') }))],
    ollama: [{ id: '', label: t('model.first_installed') }, ...ollama.map((m) => ({ id: m, label: m }))],
  }[provider()];
  return { provider: provider(), default: cfg.chat_provider, model: chatModel, models, geminiKey: !!key, secure: secureStore(), ollama };
}

function endChat({ keepProvider = false } = {}) {
  clearTimeout(chatIdle);
  chat?.close();
  chat = null;
  if (!keepProvider) {
    chatProvider = null;
    chatModel = '';
  }
  stopOllama(); // frees the model's memory, if Lydia was the one running it
  send('chat', { type: 'reset' });
}

// ---------- task manager ----------

function ownProcess(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return Number(/^Uid:\s+(\d+)/m.exec(st)?.[1]) === process.getuid();
  } catch {
    return false;
  }
}

/** Stop every process of one app (by name), only the user's own, never Lydia herself. */
function killApp(name) {
  const mine = new Set([process.pid, ...app.getAppMetrics().map((m) => m.pid)]);
  const group = watch.hogs.tasks('ram', 999).find((g) => g.name === name);
  if (!group) return { ok: false, why: t('tasks.gone') };
  const pids = group.pids.filter((pid) => !mine.has(pid) && ownProcess(pid));
  if (!pids.length) return { ok: false, why: t('tasks.not_yours') };
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  return { ok: true, count: pids.length };
}

let lastOutside = null; // the window you were in before opening her (to paste back into)
function setExpanded(on) {
  if (state.expanded === on) return;
  state.expanded = on;
  if (!on) state.byKey = false;
  if (on) desktop.activeWindow((id) => (lastOutside = id));
  if (!on) giveFocusBack();
  applyShape();
  pushState();
  if (on) pushStats(true);
}

function notify(kind, title, lines, seconds = cfg.bubble_seconds, actions = []) {
  state.notice = { kind, title, lines, actions, until: Date.now() + seconds * 1000 };
  // In fullscreen only real problems open the panel; the rest waits for a hover.
  // During a game nothing opens it: an alert only slides the pill in.
  if (hideMode()) relayout();
  else if (kind === 'alert' || !state.fullscreen) setExpanded(true);
  pushState();
}

function ramLines() {
  const m = sys.memory();
  const top = sys.topConsumers(2).map((c) => `${c.name} ${i18n.num(c.gb)} GB`).join(' · ');
  return [t('ram.line', { pct: Math.round(m.percent), used: i18n.num(m.usedGB), total: i18n.num(m.totalGB) }), t('ram.top', { list: top })];
}

let lastTop = 0;
let topCache = [];
function pushStats(force = false) {
  const now = Date.now();
  if (force || now - lastTop > 4000) {
    topCache = state.expanded ? sys.topConsumers(2) : [];
    lastTop = now;
  }
  send('stats', {
    ram: sys.memory(),
    cpu: sys.cpu(),
    disk: sys.disk(),
    temp: sys.temperatures(),
    top: topCache,
    threshold: cfg.ram_threshold_percent,
  });
}

function check() {
  const ram = watch.ram.poll();
  const cpuT = watch.cpuTemp.poll();
  const gpuT = watch.gpuTemp.poll();
  const hogs = watch.hogs.poll();
  state.over = { ram: ram.over, cpuTemp: cpuT.over, gpuTemp: gpuT.over };
  if (!state.paused) {
    // Most specific first: a stuck process usually explains the heat.
    if (hogs.length) {
      // A browser in a video call runs hot on purpose: only a silent hog is stuck.
      const h = hogs[0];
      sys.mediaBusy(h.pid, h.name, (busy) => {
        if (busy) {
          watch.hogs.postpone(h.pid);
          if (process.env.LYDIA_DEBUG) console.log(`[lydia] ${h.name} runs hot but is playing or recording sound: not stuck`);
          return;
        }
        const n = hogNotice(h);
        notify(n.kind, n.title, n.lines, 25, n.actions);
      });
    } else if (cpuT.event === 'alert') notify('alert', t('alert.cpu', { deg: deg(cpuT.value) }), [t('issue.top', { list: hotProcesses() })], 14);
    else if (gpuT.event === 'alert') notify('alert', t('alert.gpu', { deg: deg(gpuT.value) }), [], 14);
    else if (ram.event === 'alert') notify('alert', t('alert.ram'), ramLines(), 14);
    else if (cpuT.event === 'recovered') notify('ok', t('ok.cpu', { deg: deg(cpuT.value) }), [], 5);
    else if (gpuT.event === 'recovered') notify('ok', t('ok.gpu', { deg: deg(gpuT.value) }), [], 5);
    else if (ram.event === 'recovered') notify('ok', t('ok.ram'), [], 5);
  }
  pushState();
}

function alivePid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Buttons on a notice: stop a stuck process (or its service), or ignore it. */
function runAction(id) {
  const [verb, arg] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (verb === 'voice' && arg === 'unmute') {
    state.notice = null;
    return void voice.unmuteMic().then(() => toggleVoice());
  }
  if (verb === 'voice') return void confirmPending(arg === 'yes');
  if (verb === 'ignore') {
    watch.hogs.ignore.add(arg);
    cfg.stuck_process_ignore = [...watch.hogs.ignore];
    try {
      config.save('stuck_process_ignore', cfg.stuck_process_ignore);
    } catch {}
    notify('info', t('ignore.done', { name: arg }), [t('ignore.undo')], 5);
    return;
  }
  if (verb !== 'stop') return;
  const pid = Number(arg);
  const hog = watch.hogs.active().find((h) => h.pid === pid) ?? { pid, name: `PID ${pid}`, unit: null };
  const unit = hog.unit ?? sys.unitOf(pid);
  if (unit?.scope === 'user') {
    execFile('systemctl', ['--user', 'stop', unit.name], (err) => {
      if (err) notify('alert', t('svc.fail', { name: unit.name }), [String(err.message).split('\n')[0]], 8);
      else notify('ok', t('svc.stopped', { name: unit.name }), [t('svc.back', { name: unit.name })], 10);
    });
    return;
  }
  if (unit?.scope === 'system') {
    notify('info', t('svc.system', { name: hog.name }), [t('svc.system_hint', { unit: unit.name })], 12);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const why = err.code === 'EPERM' ? t('kill.other_user', { pid }) : t('tasks.gone');
    notify('info', t('kill.not', { name: hog.name }), [why], 8);
    return;
  }
  setTimeout(() => {
    if (alivePid(pid)) {
      try {
        process.kill(pid, 'SIGKILL'); // ignored SIGTERM: it really is stuck
      } catch {}
    }
    notify('ok', t('kill.done', { name: hog.name }), [], 5);
  }, 3000);
}

function testAlert() {
  notify('alert', t('test.ram', { n: cfg.ram_threshold_percent }), ramLines(), 12);
}

/** Shows the stuck-process notice with a made-up process, buttons included (they do nothing). */
function testStuck() {
  const name = t('test.example');
  notify('alert', t('test.stuck', { name }), [`${t('hog.since', { n: 3 })} · PID 0`, t('test.stuck_why')], 12, [
    { id: 'noop:', label: t('hog.stop'), primary: true },
    { id: 'noop:', label: t('hog.ignore') },
  ]);
}

function togglePause() {
  state.paused = !state.paused;
  notify(
    'info',
    t(state.paused ? 'pause.on' : 'pause.off'),
    [],
    4,
  );
}

/**
 * Hover logic. Collapsed she never takes clicks (she hangs right over where a
 * maximized browser has its address bar), and only opens when "pulled" from
 * above: the pointer goes up to the panel (or the screen edge) right above her
 * and comes down onto her. Arriving from below or the sides just passes by.
 */
let armedAt = 0;
let pointer = null; // from the desktop backend; Electron's own value goes stale while she ignores the mouse
let hovered = false; // with no backend: the page says when the mouse is on her

function tick() {
  const now = Date.now();
  const [wx, wy] = win.getPosition();
  const c = pointer ?? screen.getCursorScreenPoint();
  const p = { x: c.x - wx, y: c.y - wy };
  const blind = !desktop.hasPointer; // no backend: hover comes from the page itself

  const r = islandRect(collapsedKind());
  const inColumn = p.x >= r.x - 6 && p.x < r.x + r.width + 6;
  if (inColumn && p.y <= r.y + 2) armedAt = now; // up at the screen edge, right above her
  else if (!inColumn || p.y > r.y + r.height + 6) armedAt = 0;
  const armed = armedAt > 0 && now - armedAt < 2500;

  const key = `${p.x},${p.y},${armed}`;
  if (key !== lastCursor) {
    lastCursor = key;
    send('cursor', { ...p, armed });
  }

  if (state.notice && now >= state.notice.until) {
    state.notice = null;
    pushState();
  }
  if (layout.hidden || (hideMode() && !state.expanded)) return; // no hover while out of sight

  if (!state.expanded && collapsedKind() === 'music') {
    // The music card is used where it is (its buttons, the bar, the volume): it
    // takes the mouse while the pointer is on it, and opens only when clicked.
    const on = blind ? hovered : inside(p, r);
    if (on !== mouseOnCard) {
      mouseOnCard = on;
      win.setIgnoreMouseEvents(!on);
    }
  } else if (!state.expanded) {
    if (mouseOnCard) {
      mouseOnCard = false; // the card went away under the pointer: clicks pass through again
      win.setIgnoreMouseEvents(desktop.hasPointer);
    }
    // At the screen edge (fullscreen) a video's controls are right below: there
    // she needs the pull from above. Elsewhere nothing is under her, so hover is enough.
    // The handle is only 7px tall: easier to hit, but a little slower to fire, so
    // sweeping across the browser's tabs doesn't open her.
    const hit = blind ? hovered : (armed || !layout.edge) && inside(p, grow(r, layout.lip ? 6 : 2));
    const dwell = state.fullscreen ? HOVER_IN_FULLSCREEN_MS : layout.lip ? 220 : HOVER_IN_MS;
    if (!hit) hoverSince = 0;
    else if (!hoverSince) hoverSince = now;
    else if (now - hoverSince >= dwell) setExpanded(true);
  } else if (
    (blind ? hovered : inside(p, grow(islandRect('panel'), 4))) ||
    (!blind && inside(p, grow(islandRect(collapsedKind()), 4))) || // never let go right where she was hovered
    state.pinned ||
    state.notice ||
    (state.view === 'chat' && win.isFocused()) || // typing: the pointer may wander off
    state.view === 'setup' || // the wizard stays until it is finished or skipped
    (state.byKey && win.isFocused()) || // opened with Super: until Super again, Esc, or a click elsewhere
    now < state.pokeUntil
  ) {
    leaveSince = 0;
  } else if (!leaveSince) {
    leaveSince = now;
  } else if (now - leaveSince >= HOVER_OUT_MS) {
    setExpanded(false);
  }
}

function showMenu() {
  Menu.buildFromTemplate([
    { label: t('menu.voice'), ...(voiceKey ? { accelerator: voiceKey } : {}), click: () => toggleVoice() },
    { label: t('menu.dictate'), ...(dictateKey ? { accelerator: dictateKey } : {}), click: () => toggleDictation() },
    { label: t('menu.setup'), click: openSetup },
    { label: t('menu.ram'), click: () => notify('info', t('ram.now'), ramLines(), 8) },
    { type: 'separator' },
    { label: t('menu.test_ram'), click: testAlert },
    { label: t('menu.test_stuck'), click: testStuck },
    { label: t(state.paused ? 'tool.resume' : 'tool.pause'), click: togglePause },
    { label: t(state.pinned ? 'menu.unpin' : 'menu.pin'), click: () => (state.pinned = !state.pinned) },
    { type: 'separator' },
    { label: t('menu.quit'), click: quit },
  ]).popup({ window: win });
}

function createWindow() {
  win = new BrowserWindow({
    width: GEOM.winW,
    height: GEOM.winH,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true, // only so the chat can type; it takes the keyboard only when asked
    hasShadow: false,
    show: false,
    type: 'dock',
    title: 'Lydia',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  place();
  win.webContents.on('console-message', (e) => {
    if (e.level !== 'info' && e.level !== 'debug') console.log(`[renderer ${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.on('preload-error', (_e, file, err) => console.log(`[preload] ${file}: ${err}`));
  // The page never leaves itself: links go to the browser (open-url), nothing opens windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    applyShape();
    send('geometry', GEOM);
    relayout(true);
    pushStats(true);
    check();
    send('accent', cfg.accent_color);
    send('prefs', prefs());
    if (!cfg.setup_done) openSetup(); // first run: the wizard instead of the hello
    else notify('hello', t('hello.title'), [t('hello.line')], 6);
    if (state.pinned) setExpanded(true);
  });
  screen.on('display-metrics-changed', place);
  screen.on('display-added', place);
  screen.on('display-removed', place);
}

ipcMain.on('menu', showMenu);
// Right click on a text field: the usual edit menu instead of Lydia's.
ipcMain.on('edit-menu', () => {
  Menu.buildFromTemplate([
    { role: 'paste', label: t('edit.paste') },
    { role: 'copy', label: t('edit.copy') },
    { role: 'cut', label: t('edit.cut') },
    { type: 'separator' },
    { role: 'selectAll', label: t('edit.select_all') },
  ]).popup({ window: win });
});
ipcMain.handle('clipboard-text', () => clipboard.readText().trim().slice(0, 4000));
ipcMain.on('view', (_e, view) => {
  if (!(view in VIEW_H) || view === state.view) return;
  state.view = view;
  if (view !== 'chat' && !state.byKey) giveFocusBack();
  applyShape();
});
ipcMain.on('collapse', () => setExpanded(false));
// the music card's title or cover: the full player in Controls
ipcMain.on('open', (_e, view) => {
  if (typeof view === 'string' && view in VIEW_H) {
    state.view = view;
    send('view', view);
  }
  mouseOnCard = false;
  setExpanded(true);
});
ipcMain.on('hover', (_e, on) => (hovered = !!on));
ipcMain.on('news', (_e, on) => {
  state.news = !!on;
  relayout();
});
ipcMain.on('chat-focus', takeFocus);
ipcMain.on('chat-send', async (_e, text) => {
  if (typeof text !== 'string' || !text.trim()) return;
  // "abre o YouTube" typed in the chat does it, like said aloud.
  const rule = intents.parse(text);
  if (rule && TOOLS[rule.tool]) {
    const r = await doTool(rule.tool, rule.args, { spoken: false, heard: text });
    return send('chat', { type: 'done', text: r.say });
  }
  try {
    lastAsked = text.trim().slice(0, 8000);
    chatSession().send(lastAsked);
  } catch (err) {
    send('chat', { type: 'done', text: '', error: err.message });
  }
});
ipcMain.on('chat-new', () => endChat());
ipcMain.handle('chat-info', chatInfo);

// ---------- voice: hear, understand, act, answer ----------

let voiceKey = null; // the global shortcut that worked
let dictateKey = null; // the same, for dictation
let afterChat = null; // what to do with the next chat reply (speak it, for a spoken question)
let listening = null; // the recording in progress
let pending = null; // a tool waiting for the user's yes: { tool, args, spoken }
let dictating = null; // a dictation recording in progress
let voiceRun = 0; // bumped on every voice state change: an old answer finishing doesn't end a new one

function setVoice(v, extra = {}) {
  voiceRun++;
  state.voice = v;
  send('voice', { state: v, ...extra });
  relayout();
}
const lang = () => i18n.lang();

// Her voice: Gemini's (more human) when there is a key and the user allows it; Kokoro otherwise and as fallback.
voice.setCloud((text) => {
  const key = cfg.voice_cloud ? geminiKey() : '';
  if (!key) throw new Error('local voice');
  return geminiSpeech(key, text, { voice: cfg.voice_name });
});

// "Thanks", "bye", "stop": the conversation ends instead of listening again.
const BYE = /^(tchau|obrigad[oa]|valeu|chega|para|pare|pode parar|thanks?( you)?|bye|stop|that'?s all|gracias|adios|basta)\b/;

/** Ctrl+Alt+Space, or her mic button: start listening, or stop and use what was said. */
async function toggleVoice({ followUp = false } = {}) {
  if (dictating) return dictating.stop();
  if (listening) return listening.stop();
  if (state.voice === 'speaking') voice.shutUp();
  if (!voice.can.hear()) {
    notify('info', t('voice.not_installed'), [t('voice.not_installed_hint')], 10);
    return;
  }
  voice.shutUp();
  // A muted microphone records only silence: say so, with a way to turn it on (a follow-up just doesn't happen).
  if (await voice.micMuted()) {
    if (followUp) return;
    notify('info', t('voice.mic_muted'), [t('voice.mic_muted_hint')], 12, [{ id: 'voice:unmute', label: t('voice.unmute'), primary: true }]);
    return;
  }
  setVoice('listening');
  voice.warmUp(); // loads the voice while you talk, so the answer isn't delayed
  // a follow-up waits less for you to start talking, and silence just ends the conversation
  listening = voice.listen({ onLevel: (level) => send('voice', { state: 'listening', level }), ...(followUp ? { waitMs: 5000 } : {}) });
  const file = await listening.done;
  const dead = listening.dead();
  listening = null;
  if (!file) {
    setVoice('idle');
    if (dead && !followUp) notify('info', t('voice.mic_silent'), [t('voice.mic_silent_hint')], 8);
    return;
  }
  setVoice('thinking');
  const r = await voice.transcribe(file, lang());
  if (r.error || !r.text) {
    setVoice('idle');
    if (followUp && !r.error) return;
    return notify('info', t(r.error === 'stt-failed' ? 'voice.stt_failed' : 'voice.didnt_hear'), [], 5);
  }
  send('voice', { state: 'thinking', heard: r.text });
  if (followUp && BYE.test(intents.normalize(r.text)) && r.text.split(/\s+/).length <= 4) return answer(t('voice.bye'), { spoken: true, heard: r.text, last: true });
  await handle(r.text, { spoken: true });
}

// ---------- dictation: talk, and the text is typed where you are ----------

const POLISH = [
  'You clean up text dictated by voice and transcribed automatically.',
  'Fix punctuation, capitalization and obvious transcription mistakes; remove filler words and false starts.',
  'Spoken commands like "new line", "nova linha", "ponto final", "vírgula" become the line break or the mark.',
  "Keep the speaker's language, words and meaning. Never answer, translate, summarize, explain or add anything.",
  'Reply with the cleaned text only.',
].join(' ');

/** Gemini tidies the transcription; without a key (or if it's slow) the raw text is used. */
async function polish(text) {
  const key = geminiKey();
  if (!key) return text;
  try {
    const r = await Promise.race([
      geminiGenerate(key, { systemInstruction: { parts: [{ text: POLISH }] }, contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { temperature: 0.2 } }, { prefer: /lite/ }),
      new Promise((_, no) => setTimeout(() => no(new Error('slow')), 8000)),
    ]);
    const out = r.parts.map((p) => p.text ?? '').join('').trim();
    return out && out.length < text.length * 1.6 + 40 ? out : text; // much longer: it answered instead of cleaning
  } catch {
    return text;
  }
}

/** Types into the focused window (X11); elsewhere it goes to the clipboard to paste. */
function typeOut(text) {
  const x11 = process.env.XDG_SESSION_TYPE !== 'wayland';
  if (!x11) {
    clip.put(text);
    return notify('ok', t('dictate.copied'), [text.length > 80 ? `${text.slice(0, 77)}…` : text], 6);
  }
  execFile('xdotool', ['type', '--clearmodifiers', '--delay', '4', '--', text], { timeout: 60_000 }, (err) => {
    if (!err) return;
    clip.put(text);
    notify('ok', t('dictate.copied'), [], 6);
  });
}

async function toggleDictation() {
  if (dictating) return dictating.stop();
  if (listening) return listening.stop(); // a conversation was going on: that ends it
  if (!voice.can.hear()) return notify('info', t('voice.not_installed'), [t('voice.not_installed_hint')], 10);
  voice.shutUp();
  if (await voice.micMuted()) {
    return notify('info', t('voice.mic_muted'), [t('voice.mic_muted_hint')], 12, [{ id: 'voice:unmute', label: t('voice.unmute'), primary: true }]);
  }
  setVoice('listening', { dictation: true });
  // longer pauses are fine here: you are thinking about what to write
  dictating = voice.listen({ onLevel: (level) => send('voice', { state: 'listening', level, dictation: true }), max: 120_000, quietMs: 2500, waitMs: 8000 });
  const file = await dictating.done;
  const dead = dictating.dead();
  dictating = null;
  if (!file) {
    setVoice('idle');
    if (dead) notify('info', t('voice.mic_silent'), [t('voice.mic_silent_hint')], 8);
    return;
  }
  setVoice('thinking', { dictation: true });
  const r = await voice.transcribe(file, lang(), { prompt: false });
  if (r.error || !r.text) {
    setVoice('idle');
    return notify('info', t(r.error === 'stt-failed' ? 'voice.stt_failed' : 'voice.didnt_hear'), [], 5);
  }
  const text = await polish(r.text);
  setVoice('idle');
  typeOut(text);
}

/** After she spoke: listen again for a reply, unless that's off or something else took over. */
function keepTalking() {
  if (!cfg.voice_followup || listening || dictating || state.voice !== 'idle') return;
  // a moment first: Bluetooth speakers are still saying the end of it, and the mic would hear her
  setTimeout(() => state.voice === 'idle' && !listening && !dictating && toggleVoice({ followUp: true }), 700);
}

/** What was said (or typed) -> an action, an answer, or a question for the chat. */
async function handle(text, { spoken }) {
  // a pending "close Brave?" answered by voice
  if (pending && /^(sim|pode|isso|claro|yes|yeah|sure|ok|si|dale|confirmo)\b/.test(intents.normalize(text))) return confirmPending(true);
  if (pending && /^(nao|não|cancela|no|nope|cancel|deixa)\b/.test(intents.normalize(text))) return confirmPending(false);
  const d = await brain.decide(text, { geminiKey: geminiKey() });
  if (d.kind === 'tool') return doTool(d.tool, d.args, { spoken, heard: text });
  if (d.kind === 'say') return answer(d.text, { spoken, heard: text });
  // a question: the chat engine answers, the chat keeps it, and she says it
  send('chat-voice', { text });
  setVoice('thinking');
  afterChat = (r) => answer(r.error ? r.error : r.text, { spoken, heard: text, inChat: true });
  try {
    lastAsked = text.slice(0, 8000);
    chatSession().send(lastAsked);
  } catch (err) {
    afterChat = null;
    answer(err.message, { spoken, heard: text });
  }
}

async function answer(text, { spoken, heard, inChat = false, kind = 'info', last = false }) {
  const short = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!inChat || !state.expanded || state.view !== 'chat') notify(kind, short.length > 140 ? `${short.slice(0, 137)}…` : short, heard ? [`“${heard}”`] : [], Math.min(14, 4 + short.length / 18));
  if (!spoken) return setVoice('idle');
  setVoice('speaking');
  const most = 8000 + short.length * 120; // ~ far longer than it takes to say it
  const was = voiceRun;
  await Promise.race([voice.speak(short, lang()), new Promise((r) => setTimeout(r, most))]);
  if (state.voice === 'speaking' && was === voiceRun) {
    setVoice('idle');
    if (!last) keepTalking();
  }
}

/** Runs a tool; one that needs a yes asks first (buttons, or "sim" out loud). */
async function doTool(name, args, { spoken, heard }) {
  const tool = TOOLS[name];
  if (tool.risk === 'confirm') {
    pending = { name, args, spoken };
    const q = tool.confirm({ ...args, name: (name === 'close_app' && findApp(args.name)?.label) || args.name });
    notify('info', q, heard ? [`“${heard}”`] : [], 20, [
      { id: 'voice:yes', label: t('voice.yes'), primary: true },
      { id: 'voice:no', label: t('voice.no') },
    ]);
    if (spoken) {
      setVoice('speaking');
      await voice.speak(q, lang());
    }
    setVoice('idle');
    if (spoken) keepTalking(); // "sim" / "não" out loud
    return { ok: true, say: q };
  }
  let r;
  try {
    r = await (LOCAL_TOOLS[name] ?? tool.run)(args ?? {});
  } catch {
    r = { ok: false, say: t('do.cant') };
  }
  await answer(r.say, { spoken, heard, kind: r.ok ? 'ok' : 'info' });
  return r;
}

async function confirmPending(yes) {
  const p = pending;
  pending = null;
  if (!p) return;
  if (state.notice) state.notice = null;
  if (!yes) return answer(t('voice.cancelled'), { spoken: p.spoken });
  let r;
  try {
    r = await (LOCAL_TOOLS[p.name] ?? TOOLS[p.name].run)(p.args);
  } catch {
    r = { ok: false, say: t('do.cant') };
  }
  return answer(r.say, { spoken: p.spoken, kind: r.ok ? 'ok' : 'info' });
}

// Tools that need what only main has: processes, notifications, the monitors.
const LOCAL_TOOLS = {
  close_app: ({ name }) => {
    // "calculadora" -> the Calculator app -> its program, gnome-calculator, among the running ones
    const app = findApp(name);
    const wanted = [intents.normalize(name), app && intents.normalize(app.bin), app && intents.normalize(app.name)].filter(Boolean);
    const groups = watch.hogs.tasks('ram', 999).filter((g) => !g.self);
    const group = groups.find((g) => wanted.includes(intents.normalize(g.name))) ?? groups.find((g) => wanted.some((w) => { const n = intents.normalize(g.name); return n.length >= 4 && w.length >= 4 && (n.includes(w) || w.includes(n)); }));
    const label = app?.label ?? name;
    if (!group) return { ok: false, say: t('do.not_running', { name: label }) };
    const r = killApp(group.name);
    return r.ok ? { ok: true, say: t('do.closed', { name: label }) } : { ok: false, say: r.why };
  },
  timer: ({ seconds }) => {
    const s = startTimer(seconds);
    const human = s >= 3600 ? t('do.hours', { n: Math.round(s / 360) / 10 }) : s >= 60 ? t('do.minutes', { n: Math.round(s / 6) / 10 }) : t('do.seconds', { n: s });
    return { ok: true, say: t('do.timer_set', { time: human.replace('.', i18n.lang() === 'en' ? '.' : ',') }) };
  },
  system_status: () => {
    const m = sys.memory();
    const temp = sys.temperatures();
    const parts = [t('do.status_ram', { n: Math.round(m.percent) }), t('do.status_cpu', { n: Math.round(sys.cpu()) })];
    if (temp.cpu != null) parts.push(t('do.status_temp', { n: Math.round(temp.cpu) }));
    return { ok: true, say: `${currentIssue() ? t('do.status_issue') : t('do.status_ok')} ${parts.join(', ')}.` };
  },
};

// One timer at a time (from the voice or the Today tab); a new one replaces it.
let timerEnd = 0;
let timerHandle = 0;
function startTimer(seconds) {
  const s = Math.max(1, Math.min(24 * 3600, Math.round(Number(seconds))));
  clearTimeout(timerHandle);
  timerEnd = Date.now() + s * 1000;
  timerHandle = setTimeout(() => {
    timerEnd = 0;
    notify('alert', t('do.timer_done'), [], 12);
    voice.speak(t('do.timer_done'), lang());
  }, s * 1000);
  return s;
}

ipcMain.on('voice-toggle', () => toggleVoice());
ipcMain.handle('voice-unmute', () => voice.unmuteMic()); // the user's own button
let voiceInstalling = false;
// Only from the wizard's "Install" button, after it showed what is downloaded and from where.
ipcMain.handle('voice-install', async () => {
  if (voiceInstalling) return { ok: false };
  voiceInstalling = true;
  const r = await voiceInstall.install(i18n.lang(), (e) => send('voice-install', e), { hear: !voice.can.hear(), speak: !voice.can.speak() });
  voiceInstalling = false;
  return r;
});

// ---------- workstation tabs: one channel, ws(action, args) ----------

const wallpaperDir = () => {
  if (cfg.wallpaper_dir && fs.existsSync(cfg.wallpaper_dir)) return cfg.wallpaper_dir;
  for (const d of ['Imagens/Wallpapers', 'Pictures/Wallpapers', 'Imagens', 'Pictures']) {
    const full = path.join(os.homedir(), d);
    if (fs.existsSync(full)) return full;
  }
  return os.homedir();
};
const POWER_CONFIRM = new Set(['restart', 'shutdown', 'logout']);

const WS = {
  'controls.get': () => controls.state(),
  'controls.set': (a) => controls.set(a ?? {}),
  'media.get': () => nowplaying.nowPlaying(),
  'media.seek': ({ player, trackId, seconds } = {}) => nowplaying.seek(player, trackId, Number(seconds)),
  'media.volume': ({ player, value } = {}) => nowplaying.setVolume(player, value),
  'media.do': async ({ player, action } = {}) => (await nowplaying.control(player, action), new Promise((r) => setTimeout(r, 350)).then(nowplaying.nowPlaying)),
  'tasks.get': () => today.list(),
  'tasks.add': ({ text, due } = {}) => today.add(text, due),
  'tasks.toggle': ({ id } = {}) => today.toggle(id),
  'tasks.remove': ({ id } = {}) => today.remove(id),
  'tasks.clearDone': () => today.clearDone(),
  'stats.get': () => ({ uptime: files.uptime() }),
  'timer.get': () => timerEnd,
  'timer.start': ({ seconds } = {}) => (startTimer(seconds), timerEnd),
  'timer.cancel': () => (clearTimeout(timerHandle), (timerEnd = 0)),
  'stats.speed': () => files.speedTest(),
  'clip.get': () => ({ items: clip.list(), paused: clip.isPaused() }),
  'clip.use': ({ id, paste } = {}) => {
    if (!clip.use(id)) return false;
    if (paste) {
      // back to the window you were in, then Ctrl+V there
      setExpanded(false);
      if (lastOutside) desktop.activate(lastOutside);
      setTimeout(() => execFile('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], () => {}), 250);
    }
    return true;
  },
  'clip.pin': ({ id } = {}) => (clip.pin(id), clip.list()),
  'clip.remove': ({ id } = {}) => (clip.remove(id), clip.list()),
  'clip.clear': () => (clip.clear(), clip.list()),
  'clip.pause': ({ on } = {}) => (clip.setPaused(on), clip.isPaused()),
  'apps.get': () => files.appList(cfg.favorite_apps),
  'apps.launch': ({ id } = {}) => {
    const ok = files.launch(id);
    if (ok) setExpanded(false);
    return ok;
  },
  'apps.favorite': ({ id } = {}) => {
    const fav = new Set(cfg.favorite_apps);
    fav.has(id) ? fav.delete(id) : fav.add(id);
    cfg.favorite_apps = [...fav].slice(0, 12);
    try {
      config.save('favorite_apps', cfg.favorite_apps);
    } catch {}
    return files.appList(cfg.favorite_apps);
  },
  'wall.get': async () => ({ dir: wallpaperDir(), items: files.wallpapers(wallpaperDir()), current: await files.current() }),
  'wall.set': ({ file } = {}) => files.setWallpaper(file),
  'wall.pickDir': async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: wallpaperDir() });
    if (r.canceled) return null;
    cfg.wallpaper_dir = r.filePaths[0];
    try {
      config.save('wallpaper_dir', cfg.wallpaper_dir);
    } catch {}
    return cfg.wallpaper_dir;
  },
  // restart / shut down / log out come back with { confirm } first; the page asks, then sends sure: true
  'power.do': ({ action, sure } = {}) => (POWER_CONFIRM.has(action) && !sure ? { confirm: true } : files.power(action)),
  // the system's notifications (through the GNOME helper)
  'notif.get': () => new Promise((r) => desktop.notifications((list) => r(list && list.map((n) => ({ ...n, icon: files.icon(n.icon) }))))),
  'notif.open': ({ id } = {}) => (desktop.notification(id, 'open'), setExpanded(false), true),
  'notif.dismiss': ({ id } = {}) => (desktop.notification(id, 'dismiss'), true),
  'notif.clear': ({ ids } = {}) => (Array.isArray(ids) && ids.forEach((id) => desktop.notification(id, 'dismiss')), true),
  'wifi.list': ({ rescan } = {}) => controls.wifiList(!!rescan),
  'wifi.connect': ({ ssid, password } = {}) => (typeof ssid === 'string' ? controls.wifiConnectNew(ssid, typeof password === 'string' ? password : '') : { ok: false }),
  'wifi.disconnect': ({ ssid } = {}) => (typeof ssid === 'string' ? controls.wifiDisconnect(ssid) : { ok: false }),
  'bt.list': ({ scan } = {}) => controls.btList(!!scan),
  'bt.connect': ({ mac } = {}) => controls.btConnect(String(mac)),
  'bt.disconnect': ({ mac } = {}) => controls.btDisconnect(String(mac)),
  'weather.get': ({ force } = {}) => weather({ city: cfg.weather_city, lang: i18n.lang(), force: !!force }),
  'fonts.list': () =>
    new Promise((r) =>
      execFile('fc-list', [':', 'family'], { timeout: 5000, maxBuffer: 4 << 20 }, (err, out = '') =>
        r(err ? [] : [...new Set(String(out).split('\n').map((l) => l.split(',')[0].trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))),
      ),
    ),
  'sys.overview': () => (setExpanded(false), desktop.overview()),
  'sys.settings': () => (setExpanded(false), files.launch('org.gnome.Settings') || files.launch('gnome-control-center')),
};
ipcMain.handle('ws', async (_e, action, args) => {
  const fn = WS[action];
  if (!fn) return null;
  try {
    return await fn(args);
  } catch (err) {
    if (process.env.LYDIA_DEBUG) console.log(`[lydia] ws ${action}: ${err.message}`);
    return null;
  }
});

/** Tasks whose time came: say so. */
function checkTasks() {
  for (const task of today.due()) {
    notify('alert', t('today.reminder', { text: task.text }), [], 15);
    voice.speak(task.text, i18n.lang());
  }
}

// ---------- setup wizard ----------

function openSetup() {
  state.view = 'setup';
  send('view', 'setup');
  setExpanded(true);
  applyShape();
}
ipcMain.handle('setup-status', async () => {
  const info = await chatInfo().catch(() => ({ geminiKey: false, secure: false, ollama: [] }));
  return {
    language: cfg.language,
    provider: cfg.chat_provider,
    claude: await setup.claudeStatus(),
    gemini: { key: info.geminiKey, secure: info.secure },
    ollama: await setup.ollamaStatus(info.ollama),
    ext: { ...(await setup.extensionStatus(desktop.name)), backend: desktop.name },
    autostart: setup.autostartOn(),
    voice: { hear: voice.can.hear(), speak: voice.can.speak(), plan: voiceInstall.PLAN.filter((p) => !voice.can[p.part]()), key: voiceKey, micMuted: await voice.micMuted(), installing: voiceInstalling },
    prefs: prefs(),
  };
});
ipcMain.handle('setup-claude-login', () => {
  giveFocusBack();
  return setup.claudeLogin();
});
ipcMain.handle('setup-ollama-pull', () => {
  giveFocusBack();
  // The server may not be running yet: start it for the download, then close the window on Enter.
  return setup.openTerminal(os.homedir(), ['sh', '-c', '(ollama serve >/dev/null 2>&1 &); sleep 2; ollama pull llama3.2; echo; read -p "Enter ↵ " x']);
});
ipcMain.handle('setup-ext-install', () => setup.installExtension().catch(() => ({ ok: false })));
ipcMain.handle('setup-autostart', (_e, on) => {
  try {
    return setup.setAutostart(!!on, app);
  } catch {
    return { ok: false };
  }
});
ipcMain.on('setup-done', () => {
  cfg.setup_done = true;
  try {
    config.save('setup_done', true);
  } catch {}
  state.view = 'home';
  send('view', 'home');
  applyShape();
  notify('hello', t('hello.title'), [t('hello.line')], 6);
});
ipcMain.on('open-key-page', () => {
  giveFocusBack();
  shell.openExternal('https://aistudio.google.com/apikey');
});
ipcMain.on('open-url', (_e, url) => {
  if (typeof url !== 'string' || !/^https:\/\/[^\s]+$/.test(url) || url.length > 2000) return;
  giveFocusBack();
  shell.openExternal(url);
});
ipcMain.handle('chat-provider', (_e, p) => {
  if (!['claude', 'gemini', 'ollama'].includes(p)) return chatInfo();
  if (p !== provider()) {
    chatProvider = p; // just this conversation; the default is set in Aparência
    chatModel = '';
    endChat({ keepProvider: true }); // a new engine starts a new conversation
  }
  return chatInfo();
});
ipcMain.handle('chat-model', (_e, m) => {
  if (typeof m === 'string' && m.length < 100 && m !== chatModel) {
    chatModel = m;
    endChat({ keepProvider: true }); // another model starts a new conversation
  }
  return chatInfo();
});
ipcMain.handle('gemini-key', (_e, key) => {
  // Classic keys look like "AIza…"; newer ones like "AQ.Ab8…": letters, digits and . _ - ~ + / =
  if (typeof key !== 'string' || !/^[\w.~+/=-]{20,400}$/.test(key.trim())) return { error: t('key.invalid') };
  const error = saveGeminiKey(key.trim());
  if (!error) {
    geminiList = null;
    endChat({ keepProvider: true });
  }
  return { error };
});
ipcMain.handle('tasks', (_e, by) => {
  const mine = new Set([process.pid, ...app.getAppMetrics().map((m) => m.pid)]);
  return watch.hogs.tasks(by === 'ram' ? 'ram' : 'cpu', 8, mine).map(({ name, cpu, gb, pids, self, hot }) => ({ name, cpu, gb, count: pids.length, self, hot }));
});
ipcMain.handle('task-kill', (_e, name) => (typeof name === 'string' ? killApp(name) : { ok: false }));
ipcMain.on('action', (_e, id) => typeof id === 'string' && runAction(id));
ipcMain.on('set-pref', (_e, key, value) => {
  if (!PREFS.includes(key)) return;
  const valid = { chat_provider: ['claude', 'gemini', 'ollama'], language: ['system', ...i18n.LANGS], bar_content: ['info', 'clock', 'both'], super_tab: ['last', 'notif', 'controls', 'today', 'tasks', 'clip', 'apps', 'wall', 'power', 'chat', 'look'] }[key];
  // text and number prefs have their own checks
  const free = {
    weather_city: (v) => typeof v === 'string' && v.length < 80,
    font_family: (v) => typeof v === 'string' && v.length < 80 && !/[;{}"<>]/.test(v),
    font_weight: (v) => [300, 400, 500, 600, 700].includes(v),
  }[key];
  if (free ? !free(value) : valid ? !valid.includes(value) : typeof value !== 'boolean') return;
  cfg[key] = value;
  try {
    config.save(key, value);
  } catch {}
  const helper = { hide_gnome_panel: () => desktop.setPanel(value), super_opens: () => desktop.setSuper(value) }[key];
  if (helper && !helper() && desktop.name === 'gnome') {
    // the shell still runs an older helper: put the new one in place; it loads when GNOME restarts
    setup.installExtension().then(() => notify('info', t('panel.restart'), [t('panel.restart_hint')], 15));
  }
  if (key === 'language') {
    applyLanguage();
    pushState(); // issues and buttons are written in main
  }
  if (gameMode()) schedulePeek();
  else state.peeking = false;
  relayout();
  send('prefs', prefs());
});
ipcMain.on('set-accent', (_e, color) => {
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return;
  cfg.accent_color = color.toLowerCase();
  try {
    config.save('accent_color', cfg.accent_color);
  } catch {}
});

// ---------- light or dark, like the system ----------

/**
 * GNOME says it two ways: the color scheme (prefer-dark / prefer-light /
 * default) and, with "default", the GTK theme's name (ZorinGrey-Light,
 * Adwaita-dark...). Followed live, so an automatic day/night switch moves her
 * too. The page picks its palette from prefers-color-scheme, which follows this.
 */
function systemDark() {
  const get = (key) => {
    try {
      return execFileSync('gsettings', ['get', 'org.gnome.desktop.interface', key], { timeout: 1500 }).toString();
    } catch {
      return null;
    }
  };
  const scheme = get('color-scheme');
  if (scheme === null) return null; // no GNOME settings: let Chromium ask the system
  if (scheme.includes('prefer-dark')) return true;
  if (scheme.includes('prefer-light')) return false;
  return /dark/i.test(get('gtk-theme') ?? '');
}
function applyTheme() {
  const dark = systemDark();
  nativeTheme.themeSource = dark === null ? 'system' : dark ? 'dark' : 'light';
}
function watchTheme() {
  applyTheme();
  const p = spawn('gsettings', ['monitor', 'org.gnome.desktop.interface'], { stdio: ['ignore', 'pipe', 'ignore'] });
  p.on('error', () => {});
  let timer = 0;
  p.stdout.on('data', (chunk) => {
    if (!/color-scheme|gtk-theme/.test(String(chunk))) return;
    clearTimeout(timer);
    timer = setTimeout(applyTheme, 200); // both keys often change together
  });
  themeWatcher = p;
}
let themeWatcher = null;

// ---------- the desktop: pointer, fullscreen windows, a window below the panel ----------

let desktop = { name: 'starting', hasPointer: false, activeWindow: (cb) => cb(null), activate() {}, setPanel: () => false, focusSelf: (w) => w.focus(), stop() {} };
let ownXid = 0;
const desktopCtx = {
  primary: () => screen.getPrimaryDisplay().bounds,
  // The strip right below the panel where she hangs, in screen coordinates.
  zone: () => {
    const d = screen.getPrimaryDisplay();
    const cx = d.bounds.x + d.bounds.width / 2;
    return { x: cx - GEOM.pill.w / 2 - 12, y: d.workArea.y, width: GEOM.pill.w + 24, height: GEOM.pill.h + 8 };
  },
  selfXid: () => (ownXid ||= alive() ? win.getNativeWindowHandle().readUInt32LE(0) : 0),
};
const desktopEvents = {
  pointer: (p) => (pointer = p),
  notifications: () => send('notif-changed'),
  // The Super key, when it is hers: open (with the keyboard, like a start menu) or close.
  superKey: () => {
    if (state.expanded) return setExpanded(false);
    if (layout.hidden) return;
    if (cfg.super_tab !== 'last' && cfg.super_tab in VIEW_H) {
      state.view = cfg.super_tab;
      send('view', cfg.super_tab);
    }
    setExpanded(true);
    state.byKey = true;
    takeFocus();
  },
  fullscreen: (full, game) => {
    if (full === state.fullscreen && game === state.game) return;
    const wasGame = state.game;
    state.fullscreen = full;
    state.game = game;
    if (game && !wasGame) {
      setExpanded(false);
      schedulePeek();
    }
    if (!game) state.peeking = false;
    if (alive()) relayout();
  },
  covered: (covered) => {
    if (covered === state.covered) return;
    state.covered = covered;
    if (process.env.LYDIA_DEBUG) console.log(`[lydia] window below the panel: ${covered}`);
    if (alive()) relayout();
  },
};
function startDesktop() {
  pickDesktop(desktopCtx, desktopEvents, (d) => {
    desktop = d;
    console.log(`[lydia] desktop: ${d.name}`);
    d.start();
    if (cfg.hide_gnome_panel) d.setPanel(true);
    if (cfg.super_opens) d.setSuper(true);
    if (alive()) applyShape(); // with no pointer source the pill takes the mouse itself
    send('prefs', prefs()); // now it is known whether the panel can be hidden
  });
}

const timers = [];
const alive = () => win && !win.isDestroyed();
const every = (ms, fn) => timers.push(setInterval(() => alive() && fn(), ms));

// Lets `kill $(cat $XDG_RUNTIME_DIR/lydia.pid)` reach the right process.
const pidFile = path.join(process.env.XDG_RUNTIME_DIR || app.getPath('temp'), 'lydia.pid');

function quit() {
  timers.forEach(clearInterval);
  desktop.stop();
  themeWatcher?.kill();
  app.quit();
  setTimeout(() => app.exit(0), 1500).unref(); // don't hang if a child process is gone
}

app.whenReady().then(() => {
  if (!gotLock) return;
  cfg = config.load();
  applyLanguage();
  watch = {
    ram: sys.RamMonitor(cfg),
    cpuTemp: new sys.ThresholdWatch({
      threshold: cfg.cpu_temp_alert_celsius,
      needed: 3,
      cooldownSeconds: 600,
      read: () => sys.temperatures().cpu,
    }),
    gpuTemp: new sys.ThresholdWatch({
      threshold: cfg.gpu_temp_alert_celsius,
      needed: 3,
      cooldownSeconds: 600,
      read: () => sys.temperatures().gpu,
    }),
    hogs: new sys.HogWatch({
      percent: cfg.stuck_process_percent,
      minutes: cfg.stuck_process_minutes,
      ignore: cfg.stuck_process_ignore,
    }),
  };
  watchTheme(); // before the window, so it never flashes the wrong palette
  createWindow();
  startDesktop();
  // Her shortcut, or the first free one (Claude's app takes Ctrl+Alt+Space, for one).
  for (const key of [cfg.voice_shortcut, 'Super+Alt+Space', 'Control+Super+Space', 'Super+Shift+Space', 'Alt+Shift+Space']) {
    try {
      if (key && globalShortcut.register(key, () => toggleVoice())) {
        voiceKey = key;
        break;
      }
    } catch {}
  }
  for (const key of [cfg.dictation_shortcut, 'Super+Alt+D', 'Control+Super+D']) {
    try {
      if (key && globalShortcut.register(key, () => toggleDictation())) {
        dictateKey = key;
        break;
      }
    } catch {}
  }
  if (process.env.LYDIA_DEBUG) console.log(`[lydia] voice shortcut: ${voiceKey ?? 'none free'}, dictation: ${dictateKey ?? 'none free'}`);
  every(50, tick);
  every(15_000, checkTasks);
  clip.start(() => send('clip-changed'));
  every(cfg.check_interval_seconds * 1000, check);
  let beat = 0; // open: every 1.5 s; collapsed (only the pill shows them): every 3 s
  every(1500, () => (state.expanded || ++beat % 2 === 0) && pushStats());
  // What is playing: the music card on the closed bar (playing, or paused a moment ago)
  let asking = false;
  let lastPlaying = 0;
  const spectrum = new Spectrum((levels) => send('levels', levels));
  app.on('before-quit', () => spectrum.stop());
  let lastCover = '';
  every(2000, async () => {
    if (hideMode() && spectrum.running) spectrum.stop();
    if (asking || hideMode()) return;
    asking = true;
    const m = await nowplaying.nowPlaying().catch(() => null);
    asking = false;
    if (m?.status === 'Playing') lastPlaying = Date.now();
    const card = cfg.music_card && !!m && Date.now() - lastPlaying < 20_000;
    if (card !== !!state.mediaCard) {
      state.mediaCard = card;
      relayout();
    }
    if (!card && !state.expanded) return;
    // the players' bars dance with the sound: it is listened to only while one of them shows
    const showing = (layout.music && !state.expanded) || (state.expanded && state.view === 'controls');
    if (m?.status === 'Playing' && showing) spectrum.start();
    else if (spectrum.running) spectrum.stop();
    // the cover (a large data URL) only when it changes
    const cover = m?.cover ?? '';
    send('media', m && { ...m, cover: cover === lastCover ? undefined : cover, at: Date.now() });
    lastCover = cover;
  });
  sys.cpu(); // prime the CPU delta
  try {
    fs.writeFileSync(pidFile, `${process.pid}\n`);
  } catch {}
});

app.on('before-quit', () => {
  timers.forEach(clearInterval);
  chat?.close();
  stopOllama();
  desktop.stop();
  themeWatcher?.kill();
  clip.stop();
  globalShortcut.unregisterAll();
  voice.stopVoice();
  listening?.stop();
  try {
    if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidFile);
  } catch {}
});
app.on('window-all-closed', quit);
// Dev control: write a command to $XDG_RUNTIME_DIR/lydia.cmd, then `kill -USR2 <pid>`.
// No file: test alert. (SIGUSR1 is Node's inspector; Chromium itself handles
// SIGHUP/SIGTERM/SIGINT by shutting down.)
const cmdFile = path.join(path.dirname(pidFile), 'lydia.cmd');
process.on('SIGUSR2', () => {
  if (!alive()) return;
  let cmd = '';
  try {
    cmd = fs.readFileSync(cmdFile, 'utf8').trim();
    fs.unlinkSync(cmdFile);
  } catch {}
  const [verb, arg] = cmd.split(/\s+/);
  if (verb === 'travado') testStuck();
  else if (verb === 'cutucar') {
    state.pokeUntil = Date.now() + 3500; // as if the mouse were on her for a moment
    setExpanded(true);
  }
  else if (verb === 'falar') handle(cmd.slice(6).trim(), { spoken: true }); // as if said aloud (tests without a mic)
  else if (verb === 'ditar') polish(cmd.slice(6).trim()).then(typeOut); // as if dictated (tests without a mic)
  else if (verb === 'limpar') {
    state.notice = null; // recordings: drop the current notice
    pushState();
  } else if (verb === 'descoberto') {
    state.ignoreCovered = arg !== 'off'; // recordings: act as if nothing were below the panel
    relayout();
  } else if (verb === 'fixar') {
    state.pinned = arg !== 'off'; // keep her open (or let her go) for recordings
    setExpanded(state.pinned);
  }
  else if (verb === 'telacheia') {
    state.fullscreen = arg === 'on'; // until the next real window change
    relayout();
  } else if (verb === 'jogo') {
    state.fullscreen = state.game = arg === 'on';
    if (state.game) setExpanded(false);
    relayout();
  } else if (verb === 'espiar') {
    state.peeking = true;
    relayout();
    setTimeout(() => {
      state.peeking = false;
      relayout();
    }, 3400);
  }
  else testAlert();
});
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
