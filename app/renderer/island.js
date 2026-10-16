const $ = (id) => document.getElementById(id);
const island = $('island');
const orb = $('lydia');
const { t } = i18n; // i18n.js, loaded before this file
i18n.setLang(i18n.resolve('system', navigator.languages)); // until the saved choice arrives
const fmt = (x) => i18n.num(x);
const rand = (a, b) => a + Math.random() * (b - a);

let state = { expanded: false, paused: false, issue: null, notice: null };
let stats = null;

// ---------- feed ----------

function renderActions(actions = []) {
  const box = $('actions');
  const key = actions.map((a) => (a.id ?? '') + a.label).join('|');
  box.parentElement.classList.toggle('has-actions', actions.length > 0);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(
    ...actions.map((a) => {
      const b = document.createElement('button');
      b.textContent = a.label;
      if (a.primary) b.className = 'primary';
      b.addEventListener('click', () => (a.run ? a.run() : window.lydia.action(a.id)));
      return b;
    }),
  );
}

function showMessage(m) {
  const [a, b] = m.lines;
  $('feed-1').textContent = b ? a : 'Lydia';
  $('feed-2').textContent = m.title;
  $('feed-3').textContent = b ?? a ?? '';
  renderActions(m.actions);
}

function render() {
  const alerting = !!state.issue || state.notice?.kind === 'alert';
  island.classList.toggle('expanded', state.expanded);
  island.classList.toggle('alert', alerting);
  island.classList.toggle('paused', state.paused);
  $('btn-pause').classList.toggle('on', state.paused);
  $('btn-pause').title = t(state.paused ? 'tool.resume' : 'tool.pause');

  const now = $('feed-2');
  now.classList.toggle('alert', alerting);
  if (state.notice) return showMessage(state.notice);
  $('feed-1').textContent = '';
  if (state.issue) {
    // Something is wrong: say so, then what it is (the details live in the task manager).
    now.textContent = t('home.issue');
    $('feed-3').textContent = [state.issue.title, state.issue.lines[0]].filter(Boolean).join(' · ');
    renderActions(state.issue.actions);
    return;
  }
  const news = [badges.chat].filter(Boolean);
  if (news.length) {
    // Something arrived while you were away: say what, with a way straight to it.
    now.textContent = news.length === 1 ? news[0].text : t('home.news');
    $('feed-3').textContent = news.length === 1 ? '' : news.map((n) => n.text).join(' · ');
    renderActions(news.map((n) => ({ label: n.see, primary: false, run: n.open })));
    return;
  }
  renderActions([]);
  now.textContent = t('home.greet');
  $('feed-3').textContent = statusLine();
}

/** One calm sentence about how things are. */
function statusLine() {
  if (state.paused) return t('status.paused');
  return t('status.calm');
}

function chip(id, percent, text, hot) {
  const el = $(id);
  el.querySelector('.ring').style.setProperty('--p', Math.max(0, Math.min(100, percent)).toFixed(1));
  el.querySelector('b').textContent = text;
  el.classList.toggle('hot', hot);
}

function metrics() {
  const { ram, cpu, disk, temp } = stats;
  const list = [
    ['RAM', `${Math.round(ram.percent)}%`],
    ['CPU', `${Math.round(cpu)}%`],
    [t('metric.disk'), `${Math.round(disk.percent)}%`],
  ];
  if (temp.cpu != null) list.push([t('metric.temp_cpu'), `${Math.round(temp.cpu)}°`]);
  if (temp.gpu != null) list.push([t('metric.temp_gpu'), `${Math.round(temp.gpu)}°`]);
  return list;
}

function renderStats() {
  const { ram, cpu, disk, temp, threshold } = stats;
  renderPill(false);
  if (!state.expanded) return; // the panel is hidden: skip ring animations
  $('cpu-mini').textContent = `${fmt(ram.usedGB)} / ${fmt(ram.totalGB)} GB`;
  chip('chip-ram', ram.percent, `${Math.round(ram.percent)}%`, ram.percent >= threshold);
  chip('chip-cpu', cpu, `${Math.round(cpu)}%`, cpu >= 90);
  chip('chip-disk', disk.percent, `${Math.round(disk.percent)}%`, disk.percent >= 92);
  // The ring follows whichever is closer to its limit.
  const c = temp.cpu ?? 0;
  const g = temp.gpu ?? 0;
  const ring = Math.max(((c - 30) / 65) * 100, ((g - 30) / 70) * 100);
  const el = $('chip-temp');
  el.querySelector('.ring').style.setProperty('--p', Math.max(0, Math.min(100, ring)).toFixed(1));
  $('t-cpu').textContent = `CPU ${temp.cpu == null ? '--' : Math.round(temp.cpu) + '°'}`;
  $('t-gpu').textContent = `GPU ${temp.gpu == null ? '--' : Math.round(temp.gpu) + '°'}`;
  el.classList.toggle('hot', c >= 85 || g >= 90);
}

// ---------- collapsed pill: cycles RAM → CPU → Disco → Temp ----------

let pillIndex = 0;
function setPill(label, value) {
  $('pill-label').textContent = label;
  $('pill-value').textContent = value;
}
function renderPill(advance) {
  if (!stats) return;
  if (state.paused) {
    setPill(t('pill.paused'), '');
    return;
  }
  if (state.issue) {
    setPill(...state.issue.pill); // stay on the problem instead of cycling
    return;
  }
  if (pillNote && Date.now() < pillNote.until) return setPill(pillNote.label, pillNote.value);
  const news = badges.chat; // stays in the pill until you look at it
  if (news) return setPill(news.label, news.value);
  const list = metrics();
  if (advance) pillIndex = (pillIndex + 1) % list.length;
  const [label, value] = list[pillIndex % list.length];
  if (!advance) {
    setPill(label, value);
    return;
  }
  const el = $('pill-metric');
  el.classList.add('out');
  setTimeout(() => {
    setPill(label, value);
    el.classList.remove('out');
  }, 220);
}
setInterval(() => !state.expanded && renderPill(true), 3500);

// ---------- expressions (she has no mouth: it is all in the eyes) ----------

let happyTimer = 0;
function smile(ms) {
  orb.classList.add('happy');
  clearTimeout(happyTimer);
  happyTimer = setTimeout(() => orb.classList.remove('happy'), ms);
}

// A little timeline of class changes, cancelled if another one starts.
let scene = [];
function play(steps) {
  scene.forEach(clearTimeout);
  scene = steps.map(([at, fn]) => setTimeout(fn, at));
}
const add = (...c) => () => orb.classList.add(...c);
const drop = (...c) => () => orb.classList.remove(...c);

// ---------- idle activities, and how she reacts when you come close ----------

// Picked at random when idle. Music is not (she listens only when music really
// plays).
const ACTIVITIES = ['nap', 'game', 'book', 'plant', 'cube', 'draw', 'coffee', 'lunch'];

/** The part of the day: coffee in the morning, lunch around noon, sleepy at night. */
function dayPart(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= 22 || h < 6) return 'night';
  if (h < 11) return 'morning';
  if (h >= 11.5 && h < 14) return 'noon';
  return 'day';
}
/** A random idle activity, weighted by the time of day. */
function pickActivity() {
  const part = dayPart();
  const weights = { nap: part === 'night' ? 4 : 1, game: 1, book: 1, plant: 1, cube: 1, draw: 1, coffee: part === 'morning' ? 3 : 0, lunch: part === 'noon' ? 3 : 0 };
  let r = Math.random() * Object.values(weights).reduce((a, b) => a + b, 0);
  for (const [name, w] of Object.entries(weights)) if ((r -= w) < 0) return name;
  return 'nap';
}
setInterval(() => (orb.dataset.time = dayPart()), 60_000);
let activity = 'none';
let activityTimer = 0;

let compact = false; // fullscreen notch: small, but she still naps, listens to music, plays
let gone = false; // hidden for a game or a video: nobody to see her
const idle = () => !state.expanded && !state.issue && !state.paused && !state.notice && !gone;

function setActivity(name) {
  activity = name;
  orb.dataset.activity = name;
}

function scheduleActivity(ms) {
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => {
    if (!idle() || activity !== 'none') return scheduleActivity(15_000);
    startActivity(pickActivity(), rand(25_000, 50_000));
  }, ms);
}

function startActivity(name, ms) {
  play([]);
  orb.classList.remove('startle', 'wake', 'happy');
  setActivity(name);
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => {
    setActivity('none');
    scheduleActivity(rand(30_000, 70_000));
  }, ms);
}

/** Someone came close while she was busy: react, then go back to normal. */
function react() {
  const was = activity;
  if (was === 'none') return false;
  clearTimeout(activityTimer);
  if (was === 'music') {
    play([
      [0, add('startle')],
      [900, () => setActivity('none')],
      [1000, drop('startle')],
      [1250, () => smile(900)],
    ]);
  } else if (was !== 'nap') {
    // game, book, plant, cube, drawing, coffee, lunch: a start, whatever she held goes flying, a blink
    play([
      [0, add('startle')],
      [900, () => setActivity('none')],
      [1000, drop('startle')],
      [1150, add('blink')],
      [1260, drop('blink')],
    ]);
  } else if (was === 'nap') {
    play([
      [0, () => setActivity('none')],
      [0, add('wake')],
      [700, drop('wake')],
      [850, add('blink')],
      [960, drop('blink')],
      [1100, add('blink')],
      [1210, drop('blink')],
    ]);
  }
  scheduleActivity(rand(40_000, 80_000));
  return true;
}

function stopActivityQuietly() {
  if (activity === 'none') return;
  play([]);
  orb.classList.remove('startle', 'wake');
  setActivity('none');
  scheduleActivity(rand(30_000, 60_000));
}

orb.dataset.time = dayPart();
scheduleActivity(rand(20_000, 40_000));

// ---------- state from the main process ----------

window.lydia.on('state', (s) => {
  const opened = s.expanded && !state.expanded;
  if (!s.expanded && state.expanded) setView('home'); // open again on the main view
  const kind = s.notice?.kind;
  const newNotice = kind && kind !== state.notice?.kind;
  state = s;
  if (s.issue || s.paused) stopActivityQuietly();
  syncMusic();
  render();
  if (stats) renderStats();
  if (opened && react()) return;
  if (newNotice && (kind === 'hello' || kind === 'ok')) smile(1800);
  else if (opened && !s.issue && !s.paused && !s.notice) smile(900);
});
window.lydia.on('stats', (s) => {
  stats = s;
  renderStats();
  if (!state.notice) render();
});
window.lydia.on('geometry', (g) => {
  const css = document.documentElement.style;
  css.setProperty('--pill-w', `${g.pill.w}px`);
  css.setProperty('--pill-h', `${g.pill.h}px`);
  css.setProperty('--panel-w', `${g.panel.w}px`);
  css.setProperty('--panel-h', `${g.panel.h}px`);
  css.setProperty('--mini-w', `${g.mini.w}px`);
  css.setProperty('--lip-w', `${g.lip.w}px`);
  css.setProperty('--lip-h', `${g.lip.h}px`);
  css.setProperty('--mini-h', `${g.mini.h}px`);
});
let laidOut = false;
window.lydia.on('layout', (l) => {
  if (!laidOut) island.style.transition = 'none'; // first placement: no slide
  const css = document.documentElement.style;
  css.setProperty('--top', `${l.top}px`);
  css.setProperty('--top-open', `${l.topOpen}px`);
  island.classList.toggle('lip', !!l.lip);
  island.classList.toggle('edge', !!l.edge);
  compact = l.compact;
  island.classList.toggle('mini', compact);
  island.classList.toggle('gone', !!l.hidden);
  island.classList.toggle('peek', !!l.peek);
  gone = !!l.hidden && !l.peek;
  if (gone) stopActivityQuietly();
  if (!laidOut) {
    void island.offsetHeight;
    island.style.transition = '';
    laidOut = true;
  }
});
window.lydia.on('prefs', (p) => {
  $('language').value = p.language;
  if (p.lang !== i18n.lang()) {
    i18n.setLang(p.lang);
    translatePage();
  }
  for (const b of document.querySelectorAll('#default-provider button')) b.classList.toggle('on', b.dataset.p === p.chat_provider);
  for (const sw of document.querySelectorAll('.switch[data-pref]')) {
    sw.classList.toggle('on', !!p[sw.dataset.pref]);
    sw.setAttribute('aria-checked', String(!!p[sw.dataset.pref]));
  }
});
window.lydia.on('demo', (name) => [...ACTIVITIES, 'music'].includes(name) && startActivity(name, 10 * 60_000));
window.lydia.on('view', (v) => setView(v, false));

// ---------- eyes follow the mouse ----------

// While the mouse moves on her monitor she follows it; when it rests or is on
// another monitor she looks around on her own, mostly down at the screen, as if
// watching what you are watching.
let lastMove = 0;
function lookAt(x, y) {
  orb.style.setProperty('--lx', x.toFixed(2));
  orb.style.setProperty('--ly', y.toFixed(2));
}
window.lydia.on('cursor', (p) => {
  // passing over the collapsed pill without pulling it: fade so what's below shows
  const ir = island.getBoundingClientRect();
  const over = p.x >= ir.left && p.x < ir.right && p.y >= ir.top && p.y < ir.bottom;
  island.classList.toggle('ghost', over && !p.armed && !state.expanded && island.classList.contains('edge'));
  if (!p.near) return;
  lastMove = Date.now();
  const r = orb.getBoundingClientRect();
  const dx = p.x - (r.left + r.width / 2);
  const dy = p.y - (r.top + r.height / 2);
  const dist = Math.hypot(dx, dy) || 1;
  const reach = 6 * Math.min(1, dist / 260); // in SVG units
  lookAt((dx / dist) * reach, (dy / dist) * reach * 0.75);
});

const GLANCES = [
  [0, 5.5, 3], // down at the screen (the most common, hence repeated)
  [0, 5.5, 3],
  [-2.5, 5, 2],
  [2.5, 5, 2],
  [-5.5, 1, 1],
  [5.5, 1, 1],
  [0, 0, 1],
];
function wander() {
  setTimeout(wander, rand(1800, 4200));
  if (Date.now() - lastMove < 3000) return; // the mouse leads for now
  const [x, y] = GLANCES[Math.floor(Math.random() * GLANCES.length)];
  lookAt(x, y);
}
setTimeout(wander, 2000);

// ---------- blinking ----------

function blinkLater() {
  setTimeout(() => {
    const busy = state.paused || activity === 'nap' || activity === 'music' || orb.classList.contains('happy');
    if (!busy) {
      orb.classList.add('blink');
      setTimeout(() => orb.classList.remove('blink'), 120);
      if (Math.random() < 0.2) {
        setTimeout(() => orb.classList.add('blink'), 240);
        setTimeout(() => orb.classList.remove('blink'), 360);
      }
    }
    blinkLater();
  }, 2500 + Math.random() * 3500);
}
blinkLater();

// ---------- colors ----------

const BODY = ['#8f63f7', '#4f7cff', '#1fb5c9', '#2fbf71', '#f2a33a', '#ec5fa8', '#6b6f80', '#e6e2f0'];
const EYES = ['#f6f1ff', '#a5f3fc', '#fde68a', '#fbcfe8', '#bbf7d0', '#17131f'];
const DEFAULT = { body: BODY[0], eye: EYES[0] };
let look = { ...DEFAULT };

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t));

/** One picked color becomes the orb's four gradient stops: highlight → deep shade. */
function applyLook(l) {
  look = { ...DEFAULT, ...l };
  const s = orb.style;
  s.setProperty('--b0', mix(look.body, '#ffffff', 0.6));
  s.setProperty('--b1', look.body);
  s.setProperty('--b2', mix(look.body, '#000000', 0.3));
  s.setProperty('--b3', mix(look.body, '#000000', 0.58));
  s.setProperty('--eye-user', look.eye);
  markSwatches();
}

function swatchRow(id, colors, key) {
  const row = $(id);
  for (const c of colors) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.setProperty('--c', c);
    b.dataset.color = c;
    b.title = c;
    b.addEventListener('click', () => pick(key, c));
    row.append(b);
  }
  const custom = document.createElement('label');
  custom.className = 'swatch custom';
  custom.title = t('look.custom');
  const input = document.createElement('input');
  input.type = 'color';
  input.addEventListener('input', () => applyLook({ ...look, [key]: input.value }));
  input.addEventListener('change', () => pick(key, input.value));
  custom.append(input);
  row.append(custom);
}

function markSwatches() {
  for (const [id, key] of [['sw-body', 'body'], ['sw-eye', 'eye']]) {
    for (const b of $(id).querySelectorAll('.swatch[data-color]')) b.classList.toggle('on', b.dataset.color === look[key]);
  }
}

function pick(key, color) {
  applyLook({ ...look, [key]: color });
  window.lydia.setLook(look);
}

swatchRow('sw-body', BODY, 'body');
swatchRow('sw-eye', EYES, 'eye');
$('look-reset').addEventListener('click', () => {
  applyLook(DEFAULT);
  window.lydia.setLook(look);
});
window.lydia.on('look', applyLook);
applyLook(DEFAULT);

// ---------- views and input ----------

// Same heights as VIEW_H in main.js (it shapes the clickable area from them).
const VIEW_H = { home: 200, look: 290, tasks: 330, chat: 440, setup: 440 };
function setView(view, tell = true) {
  if (!(view in VIEW_H)) return;
  const was = island.dataset.view;
  island.dataset.view = view;
  document.documentElement.style.setProperty('--panel-h', `${VIEW_H[view]}px`);
  const tab = { tasks: 'home' }[view] ?? view;
  for (const el of document.querySelectorAll('.tab[data-view]')) el.classList.toggle('active', el.dataset.view === tab);
  if (tell && view !== was) window.lydia.setView(view);
  if (view === 'tasks') startTasks();
  else stopTasks();
  if (view === 'chat') focusChat();
  if (view === 'setup' && was !== 'setup') startSetup();
  if (view === 'chat') badges.chat = null;
  renderBadge();
}
for (const tab of document.querySelectorAll('.tab[data-view]')) tab.addEventListener('click', () => setView(tab.dataset.view));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.lydia.collapse();
});
for (const sw of document.querySelectorAll('.switch[data-pref]')) {
  sw.addEventListener('click', () => window.lydia.setPref(sw.dataset.pref, !sw.classList.contains('on')));
}
for (const b of document.querySelectorAll('#default-provider button')) {
  b.addEventListener('click', () => window.lydia.setPref('chat_provider', b.dataset.p));
}
for (const b of document.querySelectorAll('.play button')) {
  b.addEventListener('click', () => startActivity(b.dataset.activity, rand(40_000, 60_000)));
}

$('language').addEventListener('change', (e) => window.lydia.setPref('language', e.target.value));

// ---------- language ----------

/** Fills every [data-i18n] text, title and placeholder, then redraws what the code writes. */
function translatePage() {
  document.documentElement.lang = i18n.htmlLang();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const el of document.querySelectorAll('.swatch.custom')) el.title = t('look.custom');
  const pickLang = $('language');
  const value = pickLang.value || 'system';
  fillSelect(pickLang, [{ id: 'system', label: t('lang.system') }, ...i18n.LANGS.map((l) => ({ id: l, label: i18n.NAMES[l] }))], value);
  render();
  if (stats) renderStats();
  renderPill(false);
  if (island.dataset.view === 'tasks') loadTasks();
  refreshProvider().then(() => !messages.querySelector('.msg') && hello());
  if (island.dataset.view === 'setup') renderSetup();
}

// ---------- notifications: a reply came while you were looking elsewhere ----------

// What arrived, until it is seen: { label, value } for the pill, text and a button for the panel.
const badges = { chat: null };
const BADGE_MARK = { chat: '…' }; // the dot says what kind it is
let hadNews = false;
let pillNote = null; // { label, value, until }: a moment in the pill when it arrives
function renderBadge() {
  const kind = badges.chat ? 'chat' : '';
  $('badge').className = 'badge' + (kind ? ` on ${kind}` : '');
  $('badge').textContent = BADGE_MARK[kind] ?? '';
  island.dataset.badge = kind; // the thin handle shows it as its color
  const news = !!badges.chat;
  if (news !== hadNews) window.lydia.news((hadNews = news)); // behind a window she peeks out instead of a thin line
}
function notifyBadge(kind, label, value, extra) {
  badges[kind] = { label, value, ...extra };
  renderBadge();
  pillNote = { label, value, until: Date.now() + 6000 };
  renderPill(false);
  orb.classList.add('notify');
  setTimeout(() => orb.classList.remove('notify'), 1200);
}
const looking = (view) => state.expanded && island.dataset.view === view;
// ---------- task manager ----------

let tasksBy = 'cpu';
let tasksTimer = 0;
let confirmName = null;
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function loadTasks() {
  const list = await window.lydia.tasks(tasksBy);
  const rows = list.map((task) => {
    const ask = confirmName === task.name;
    return `<div class="task">
      <span class="name">${esc(task.name)}${task.count > 1 ? `<small>×${task.count}</small>` : ''}</span>
      <span class="num ${task.hot ? 'hot' : ''}">${task.cpu < 10 ? fmt(task.cpu) : Math.round(task.cpu)}%</span>
      <span class="num">${fmt(task.gb)} GB</span>
      ${task.self ? '<span></span>' : `<button data-name="${esc(task.name)}" class="${ask ? 'confirm' : ''}">${t(ask ? 'tasks.confirm' : 'tasks.kill')}</button>`}
    </div>`;
  });
  $('task-list').innerHTML = `<div class="task head"><span>${t('tasks.app')}</span><span class="num">CPU</span><span class="num">${t('tasks.memory')}</span><span></span></div>${rows.join('')}`;
}
function startTasks() {
  clearInterval(tasksTimer);
  loadTasks();
  tasksTimer = setInterval(loadTasks, 2000);
}
function stopTasks() {
  clearInterval(tasksTimer);
  confirmName = null;
}
$('task-list').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-name]');
  if (!b) return;
  const name = b.dataset.name;
  if (confirmName !== name) {
    confirmName = name; // first click asks, second one stops it
    return loadTasks();
  }
  confirmName = null;
  const r = await window.lydia.taskKill(name);
  b.textContent = t(r.ok ? 'tasks.killed' : 'tasks.failed');
  b.title = r.why ?? '';
  setTimeout(loadTasks, 900);
});
for (const b of document.querySelectorAll('#tasks-sort button')) {
  b.addEventListener('click', () => {
    tasksBy = b.dataset.by;
    for (const x of document.querySelectorAll('#tasks-sort button')) x.classList.toggle('on', x === b);
    loadTasks();
  });
}
$('open-tasks').addEventListener('click', () => setView('tasks'));
$('tasks-back').addEventListener('click', () => setView('home'));

// ---------- music ----------

let musicFromPlayer = false;

/** Music playing in a player (a video or a film doesn't count): she listens along. */
function syncMusic() {
  const music = !!state.music && !state.issue && !state.paused && !gone;
  if (music && activity !== 'music') {
    startActivity('music', 6 * 60 * 60_000);
    musicFromPlayer = true;
  } else if (!music && musicFromPlayer) {
    musicFromPlayer = false;
    if (activity === 'music') stopActivityQuietly();
  }
}

// ---------- chat (temporary: nothing is saved, it all goes on "Nova conversa") ----------

const messages = $('messages');
const input = $('chat-input');
let chatBusy = false;
let current = null; // the reply being written
let raw = '';

/**
 * Markdown, the common subset Claude and Gemini write: headings, lists, quotes,
 * tables, rules, ``` blocks ```, `code`, **bold**, *italic* and links.
 * Everything is escaped first; links only open https pages in the browser.
 */
function md(text) {
  const codes = []; // fenced and inline code, kept out of the other rules
  const keep = (html) => `\u0000${codes.push(html) - 1}\u0000`;
  const src = String(text ?? '')
    .replace(/\r/g, '')
    .replace(/```[\w+-]*\n?([\s\S]*?)(?:```|$)/g, (_, code) => `\n${keep(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`)}\n`);
  const inline = (line) =>
    esc(line.replace(/`([^`\n]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`)))
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<i>$2</i>')
      .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
      .replace(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));

  const out = [];
  let para = [];
  let list = null; // { tag, items }
  const flushPara = () => para.length && out.push(`<p>${para.join('<br>')}</p>`) && (para = []);
  const flushList = () => list && out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`) && (list = null);
  const flush = () => (flushPara(), flushList());

  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (!line.trim()) flush();
    else if (/^\u0000\d+\u0000$/.test(line.trim())) (flush(), out.push(line.trim()));
    else if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*$/.exec(line))) (flush(), out.push(`<p class="h${Math.min(m[1].length, 3)}">${inline(m[2])}</p>`));
    else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) (flush(), out.push('<hr>'));
    else if ((m = /^\s{0,3}>\s?(.*)$/.exec(line))) (flush(), out.push(`<blockquote>${inline(m[1])}</blockquote>`));
    else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      flush();
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      out.push(`<table><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`);
    } else if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      flushPara();
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (list?.tag !== tag) (flushList(), (list = { tag, items: [] }));
      list.items.push(inline(m[2]));
    } else if (list && /^\s{2,}\S/.test(line)) list.items[list.items.length - 1] += `<br>${inline(line.trim())}`;
    else (flushList(), para.push(inline(line)));
  }
  flush();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, n) => codes[n]);
}
// Links in a reply open in the browser, never inside Lydia.
document.addEventListener('click', (e) => {
  const a = e.target.closest('.msg a[href]');
  if (!a) return;
  e.preventDefault();
  window.lydia.openUrl(a.href);
});

function hello() {
  const who = typeof chatInfo === 'undefined' ? 'Claude' : providerName(chatInfo.provider);
  const local = typeof chatInfo !== 'undefined' && chatInfo.provider === 'ollama';
  const note = local && !chatInfo.ollama.length ? `<br><br>${t('chat.no_ollama')}` : '';
  messages.innerHTML = `<div class="hello">${t('chat.hello', { who })}${note}</div>`;
}
function bubble(cls, html) {
  messages.querySelector('.hello')?.remove();
  const d = document.createElement('div');
  d.className = `msg ${cls}`;
  d.innerHTML = html;
  messages.append(d);
  messages.scrollTop = messages.scrollHeight;
  return d;
}
function focusChat() {
  refreshProvider();
  window.lydia.chatFocus();
  setTimeout(() => input.focus(), 60);
}
function sendChat() {
  const text = input.value.trim();
  if (!text || chatBusy) return;
  chatBusy = true;
  $('chat-send').disabled = true;
  bubble('me', md(text));
  input.value = '';
  input.style.height = '';
  current = bubble('her typing', '');
  raw = '';
  window.lydia.chatSend(text);
}
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  sendChat();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});
input.addEventListener('input', () => {
  input.style.height = '';
  input.style.height = `${Math.min(input.scrollHeight, 78)}px`;
});
input.addEventListener('mousedown', () => window.lydia.chatFocus());
$('chat-new').addEventListener('click', () => {
  window.lydia.chatNew();
  focusChat();
});

// Who answers: Claude (CLI login), Gemini (AI Studio key) or a local Ollama model.
const providerName = (p) => ({ claude: 'Claude', gemini: 'Gemini' })[p] ?? t('chat.local_model');
let chatInfo = { provider: 'claude', geminiKey: false, secure: true, ollama: [] };
function fillSelect(sel, options, value) {
  sel.innerHTML = options.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('');
  sel.value = value ?? '';
}
function renderProvider() {
  for (const b of document.querySelectorAll('#chat-provider button')) b.classList.toggle('on', b.dataset.p === chatInfo.provider);
  fillSelect($('chat-model'), chatInfo.models ?? [], chatInfo.model);
  $('keybox').hidden = !(chatInfo.provider === 'gemini' && !chatInfo.geminiKey);
  if (!chatInfo.secure && chatInfo.provider === 'gemini') $('key-error').textContent = t('key.no_keyring');
  if (!messages.querySelector('.msg')) hello();
}
async function refreshProvider() {
  chatInfo = await window.lydia.chatInfo();
  renderProvider();
}
for (const b of document.querySelectorAll('#chat-provider button')) {
  b.addEventListener('click', async () => {
    chatInfo = await window.lydia.chatProvider(b.dataset.p);
    renderProvider();
    if (chatInfo.provider === 'gemini' && !chatInfo.geminiKey) $('gemini-key').focus();
    else input.focus();
  });
}
$('keybox').addEventListener('submit', async (e) => {
  e.preventDefault();
  const field = $('gemini-key');
  const r = await window.lydia.geminiKey(field.value);
  field.value = ''; // never keep the key around in the page
  $('key-error').textContent = r.error ?? '';
  if (!r.error) {
    await refreshProvider();
    input.focus();
  }
});
$('gemini-key').addEventListener('mousedown', () => window.lydia.chatFocus());
$('paste-key').addEventListener('click', async () => {
  const text = await window.lydia.clipboardText();
  $('gemini-key').value = text;
  $('key-error').textContent = text ? '' : t('key.empty_clipboard');
});
$('chat-model').addEventListener('change', async (e) => {
  chatInfo = await window.lydia.chatModel(e.target.value);
  renderProvider();
  input.focus();
});
$('get-key').addEventListener('click', () => window.lydia.openKeyPage());
refreshProvider();

window.lydia.on('chat', (e) => {
  if (e.type === 'state') {
    // Gemini busy: say why it takes long, until the reply starts.
    if (e.state === 'retrying') {
      if (current && !raw) current.innerHTML = `<span class="hint">${esc(t('chat.retrying'))}</span>`;
      return;
    }
    orb.classList.toggle('think', e.state === 'thinking');
    orb.classList.toggle('talk', e.state === 'speaking');
  } else if (e.type === 'delta' && current) {
    raw += e.text;
    current.innerHTML = md(raw);
    messages.scrollTop = messages.scrollHeight;
  } else if (e.type === 'done') {
    if (!looking('chat') && !e.error) notifyBadge('chat', 'Chat', t('chat.new_reply'), { text: t('news.chat'), see: t('news.see_chat'), open: () => setView('chat') });
    chatBusy = false;
    $('chat-send').disabled = false;
    orb.classList.remove('think', 'talk');
    if (current) {
      current.classList.remove('typing');
      if (e.error) {
        current.className = 'msg err';
        current.innerHTML = md(e.error);
      } else if (!raw) current.innerHTML = md(e.text);
    }
    current = null;
    if (island.dataset.view === 'chat') input.focus();
  } else if (e.type === 'reset') {
    chatBusy = false;
    current = null;
    $('chat-send').disabled = false;
    orb.classList.remove('think', 'talk');
    hello();
  }
});
hello();

// ---------- setup wizard (first run, or "Configurar a Lydia…" in the menu) ----------

const SETUP_STEPS = ['hi', 'chat', 'desktop', 'done'];
let setupStep = 0;
let setupInfo = null;
let setupKey = ''; // what the status looked like at the last redraw
let setupTimer = 0;
let claudeWaiting = false; // the login terminal is open
let extError = '';

function startSetup() {
  setupStep = 0;
  claudeWaiting = false;
  extError = '';
  setupInfo = null;
  renderSetup();
  setupRefresh();
  clearInterval(setupTimer);
  // Only what can change by itself is watched: the Claude login and the extension.
  setupTimer = setInterval(() => {
    if (island.dataset.view !== 'setup') return clearInterval(setupTimer);
    const step = SETUP_STEPS[setupStep];
    if ((step === 'chat' && claudeWaiting) || step === 'desktop') setupRefresh();
  }, 3000);
}

async function setupRefresh() {
  const info = await window.lydia.setupStatus();
  if (info.claude.loggedIn) claudeWaiting = false;
  const key = JSON.stringify(info);
  setupInfo = info;
  if (key !== setupKey) {
    setupKey = key;
    renderSetup();
  }
}

const sw = (act, k, on, label) => `<button class="switch ${on ? 'on' : ''}" data-act="${act}" data-k="${k}" role="switch" aria-checked="${on}"><i></i><span>${label}</span></button>`;
const ok = (text) => `<span class="ok">${esc(text)}</span>`;
const btn = (act, label, plain = false) => `<button class="s-btn ${plain ? 'plain' : ''}" data-act="${act}">${esc(label)}</button>`;

const SETUP_VIEWS = {
  hi: (i) => `
    <p class="s-title">${t('setup.hi')}</p>
    <p class="s-text">${t('setup.hi_text')}</p>
    <p class="s-label">${t('setup.language')}</p>
    <div class="seg">${['system', ...i18n.LANGS]
      .map((l) => `<button data-act="lang" data-v="${l}" class="${i.language === l ? 'on' : ''}">${l === 'system' ? t('lang.system') : i18n.NAMES[l]}</button>`)
      .join('')}</div>`,

  chat: (i) => {
    const opt = (p, name, desc, status) => `
      <div class="opt ${i.provider === p ? 'on' : ''}" data-provider="${p}">
        <div class="opt-top"><b>${name}</b>${i.provider === p ? `<span class="tag">${t('setup.default')}</span>` : ''}<span class="desc">${desc}</span></div>
        <div class="status">${status}</div>
      </div>`;
    const c = i.claude;
    const claude = !c.installed
      ? `<span class="warn">${t('setup.claude_missing')}</span><button class="link small" data-act="url" data-url="https://code.claude.com/docs/en/setup">${t('setup.how_install')}</button>`
      : c.loggedIn
        ? ok(c.email ? t('setup.connected_as', { email: c.email }) : t('setup.connected'))
        : claudeWaiting
          ? `<span>${t('setup.claude_wait')}</span>${btn('claude-login', t('setup.claude_login'), true)}`
          : btn('claude-login', t('setup.claude_login'));
    const g = i.gemini;
    const gemini = g.key
      ? ok(t('setup.key_saved'))
      : !g.secure
        ? `<span class="warn">${t('key.no_keyring')}</span>`
        : `<div class="s-key"><input type="password" id="s-key" placeholder="${t('key.placeholder')}" autocomplete="off" spellcheck="false">${btn('key-paste', t('key.paste'), true)}${btn('key-save', t('key.save'))}</div>
           <button class="link small" data-act="key-get">${t('key.get')}</button><span class="s-err" id="s-key-err"></span>`;
    const o = i.ollama;
    const ollama = !o.installed
      ? `<span class="warn">${t('setup.ollama_missing')}</span><button class="link small" data-act="url" data-url="https://ollama.com/download">${t('setup.how_install')}</button>`
      : o.models.length
        ? ok(t('setup.ollama_models', { n: o.models.length }))
        : `<span>${t('setup.ollama_none')}</span>${btn('ollama-pull', t('setup.ollama_pull'))}`;
    return `
      <p class="s-title">${t('setup.chat')}</p>
      <p class="s-text">${t('setup.chat_text')}</p>
      <div class="opts">
        ${opt('claude', 'Claude', t('setup.claude_desc'), claude)}
        ${opt('gemini', 'Gemini', t('setup.gemini_desc'), gemini)}
        ${opt('ollama', 'Ollama', t('setup.local_desc'), ollama)}
      </div>`;
  },

  desktop: (i) => {
    const e = i.ext;
    const state = {
      unsupported: `<span class="warn">${t('setup.ext_other')}</span>`,
      active: ok(t('setup.ext_active')),
      enabled: ok(t('setup.ext_enabled')),
    }[e.state] ?? btn('ext-install', t('setup.ext_install'));
    return `
      <p class="s-title">${t('setup.desktop')}</p>
      ${e.gnome ? `<div class="s-section"><b>${t('setup.ext')}</b><span class="s-text">${t('setup.ext_text')}</span><div class="status">${state}<span class="s-err">${esc(extError)}</span></div></div>` : `<div class="s-section">${state}</div>`}
      <div class="s-section">
        ${sw('pref', 'hide_in_games', i.prefs.hide_in_games, t('pref.games'))}
        ${sw('pref', 'hide_in_fullscreen', i.prefs.hide_in_fullscreen, t('pref.fullscreen'))}
        ${sw('autostart', '', i.autostart, t('setup.autostart'))}
      </div>`;
  },

  done: (i) => {
    const who = i.provider === 'ollama' ? 'Ollama' : providerName(i.provider);
    const desk = ['active', 'enabled', 'unsupported'].includes(i.ext.state) || i.ext.backend === 'x11' ? 'on' : 'off';
    const item = (cls, text) => `<li class="${cls === 'off' ? 'off' : ''}">${esc(text)}</li>`;
    return `
      <p class="s-title">${t('setup.done')}</p>
      <p class="s-text">${t('setup.done_text')}</p>
      <ul class="summary">
        ${item('on', t('setup.sum_chat', { who }))}
        ${item(desk, t('setup.sum_desktop', { state: t(desk === 'on' ? 'setup.sum_on' : 'setup.sum_off') }))}
      </ul>`;
  },
};

function renderSetup() {
  const step = SETUP_STEPS[setupStep];
  $('setup-dots').innerHTML = SETUP_STEPS.map((_, i) => `<i class="${i === setupStep ? 'on' : i < setupStep ? 'done' : ''}"></i>`).join('');
  $('setup-back').hidden = setupStep === 0;
  $('setup-skip').hidden = step === 'done';
  $('setup-next').textContent = t(step === 'done' ? 'setup.finish' : 'setup.next');
  if (!setupInfo) return;
  // A redraw must not lose what is being typed.
  const typed = $('s-key')?.value ?? '';
  const focused = document.activeElement?.id;
  $('setup-body').innerHTML = SETUP_VIEWS[step](setupInfo);
  if ($('s-key')) $('s-key').value = typed;
  if (focused && $(focused)) $(focused).focus();
}

function setupGo(delta) {
  setupStep = Math.max(0, Math.min(SETUP_STEPS.length - 1, setupStep + delta));
  setupKey = '';
  renderSetup();
  setupRefresh();
  $('setup-body').scrollTop = 0;
}
$('setup-next').addEventListener('click', () => (SETUP_STEPS[setupStep] === 'done' ? window.lydia.setupDone() : setupGo(1)));
$('setup-back').addEventListener('click', () => setupGo(-1));
$('setup-skip').addEventListener('click', () => window.lydia.setupDone());
$('setup-body').addEventListener('mousedown', (e) => e.target.closest('input') && window.lydia.chatFocus());
$('setup-body').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.id === 's-key' && setupAct('key-save'));
$('setup-body').addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  const opt = e.target.closest('.opt[data-provider]');
  if (opt && setupInfo.provider !== opt.dataset.provider) {
    setupInfo.provider = opt.dataset.provider; // show it at once; saved below
    window.lydia.setPref('chat_provider', opt.dataset.provider);
    if (!a) renderSetup();
  }
  if (a) setupAct(a.dataset.act, a);
});

async function setupAct(act, el) {
  const redraw = () => ((setupKey = ''), renderSetup());
  if (act === 'lang') {
    window.lydia.setPref('language', el.dataset.v); // the page redraws on the prefs event
    setTimeout(setupRefresh, 150);
  }
  else if (act === 'url') window.lydia.openUrl(el.dataset.url);
  else if (act === 'claude-login') {
    claudeWaiting = true;
    redraw();
    window.lydia.setupClaudeLogin();
  } else if (act === 'key-paste') $('s-key').value = await window.lydia.clipboardText();
  else if (act === 'key-save') {
    const field = $('s-key');
    const r = await window.lydia.geminiKey(field?.value ?? '');
    if (field) field.value = ''; // never keep the key around in the page
    if (r.error) $('s-key-err').textContent = r.error;
    else await setupRefresh();
  } else if (act === 'key-get') window.lydia.openKeyPage();
  else if (act === 'ollama-pull') window.lydia.setupOllamaPull();
  else if (act === 'ext-install') {
    const r = await window.lydia.setupExtInstall();
    extError = r.ok ? '' : t('setup.ext_failed');
    await setupRefresh();
    redraw();
  } else if (act === 'pref') {
    window.lydia.setPref(el.dataset.k, !el.classList.contains('on'));
    setTimeout(setupRefresh, 150);
  } else if (act === 'autostart') {
    await window.lydia.setupAutostart(!el.classList.contains('on'));
    await setupRefresh();
  }
}

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (e.target.closest('input, textarea')) {
    window.lydia.chatFocus(); // the edit menu needs the keyboard on this window
    e.target.focus();
    window.lydia.editMenu();
  } else window.lydia.menu();
});
orb.addEventListener('click', () => smile(1200));
// Where the desktop can't report the pointer (Wayland with no helper), hover comes from here.
island.addEventListener('mouseenter', () => window.lydia.hover(true));
island.addEventListener('mouseleave', () => window.lydia.hover(false));
$('btn-pause').addEventListener('click', () => window.lydia.togglePause());
$('btn-menu').addEventListener('click', () => window.lydia.menu());

translatePage();
setView('home', false);
