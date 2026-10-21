const $ = (id) => document.getElementById(id);
const island = $('island');
const orb = $('lydia'); // Lydia herself: only in the chat view
const { t } = i18n; // i18n.js, loaded before this file
i18n.setLang(i18n.resolve('system', navigator.languages)); // until the saved choice arrives
const fmt = (x) => i18n.num(x);

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

/** One ring of the System tab: percent, the big number, a line below. */
function gauge(id, percent, text, sub, hot) {
  const el = $(id);
  el.querySelector('.ring').style.setProperty('--p', Math.max(0, Math.min(100, percent)).toFixed(1));
  el.querySelector('b').textContent = text;
  el.querySelector('small').textContent = sub;
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
  if (!state.expanded || island.dataset.view !== 'tasks') return; // not on screen: skip ring animations
  const temps = [temp.cpu != null && `${Math.round(temp.cpu)}°`, temp.gpu != null && `GPU ${Math.round(temp.gpu)}°`].filter(Boolean).join(' · ');
  gauge('g-cpu', cpu, `${Math.round(cpu)}%`, temps, cpu >= 90 || (temp.cpu ?? 0) >= 85 || (temp.gpu ?? 0) >= 90);
  gauge('g-ram', ram.percent, `${Math.round(ram.percent)}%`, `${fmt(ram.usedGB)} / ${fmt(ram.totalGB)} GB`, ram.percent >= threshold);
  gauge('g-disk', disk.percent, `${Math.round(disk.percent)}%`, t('metric.free', { n: fmt(Math.round(disk.freeGB)) }), disk.percent >= 92);
}

// ---------- the closed bar: a clock and/or RAM → CPU → Disk → Temp in turns ----------
// (prefs.bar_content: "info", "clock" or "both"; something important shows in any case)

let pillIndex = 0;
function setPill(label, value, important = false) {
  $('pill-label').textContent = label;
  $('pill-value').textContent = value;
  $('pill-metric').classList.toggle('important', important);
}
function renderBarClock() {
  $('pill-clock').textContent = new Intl.DateTimeFormat(i18n.htmlLang(), { hour: '2-digit', minute: '2-digit' }).format(new Date());
}
renderBarClock();
setInterval(renderBarClock, 5000);
function renderPill(advance) {
  if (!stats) return;
  if (state.paused) return setPill(t('pill.paused'), '', true);
  if (voiceState === 'listening' || voiceState === 'thinking') return setPill(t(voiceState === 'listening' ? 'voice.listening' : 'voice.thinking'), '', true);
  if (state.issue) return setPill(...state.issue.pill, true); // stay on the problem instead of cycling
  if (pillNote && Date.now() < pillNote.until) return setPill(pillNote.label, pillNote.value, true);
  const news = badges.chat; // stays in the pill until you look at it
  if (news) return setPill(news.label, news.value, true);
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

let compact = false; // fullscreen: the bar shrinks to a small notch (only the clock)
let gone = false; // hidden for a game or a video

// ---------- state from the main process ----------

window.lydia.on('state', (s) => {
  const kind = s.notice?.kind;
  const newNotice = kind && kind !== state.notice?.kind;
  // A notice or a problem shows on the home view (it opens the island for it);
  // when it's over, or the island closes, back to the last tab.
  const telling = s.notice || s.issue || badges.chat;
  if (newNotice || (s.issue && !state.issue)) setView('home');
  else if ((!s.expanded && state.expanded) || (!telling && island.dataset.view === 'home')) setView(telling ? 'home' : lastTab);
  state = s;
  render();
  if (stats) renderStats();
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
  island.classList.toggle('bar', !!l.bar); // GNOME's panel hidden: the closed island is the whole top bar
  gone = !!l.hidden && !l.peek;
  if (!laidOut) {
    void island.offsetHeight;
    island.style.transition = '';
    laidOut = true;
  }
});
window.lydia.on('prefs', (p) => {
  $('language').value = p.language;
  island.dataset.bar = p.bar_content;
  for (const b of document.querySelectorAll('#bar-content button')) b.classList.toggle('on', b.dataset.v === p.bar_content);
  document.querySelector('.switch[data-pref="super_opens"]').hidden = !p.panelOk;
  if (p.lang !== i18n.lang()) {
    i18n.setLang(p.lang);
    translatePage();
  }
  for (const b of document.querySelectorAll('#default-provider button')) b.classList.toggle('on', b.dataset.p === p.chat_provider);
  document.querySelector('.switch[data-pref="hide_gnome_panel"]').hidden = !p.panelOk; // only with the GNOME helper
  for (const sw of document.querySelectorAll('.switch[data-pref]')) {
    sw.classList.toggle('on', !!p[sw.dataset.pref]);
    sw.setAttribute('aria-checked', String(!!p[sw.dataset.pref]));
  }
});
window.lydia.on('view', (v) => setView(v, false));

// ---------- the pointer passing over the closed bar ----------

window.lydia.on('cursor', (p) => {
  // passing over it without pulling it down: fade so what's below shows
  const ir = island.getBoundingClientRect();
  const over = p.x >= ir.left && p.x < ir.right && p.y >= ir.top && p.y < ir.bottom;
  island.classList.toggle('ghost', over && !p.armed && !state.expanded && island.classList.contains('edge'));
  if (looking('chat')) follow(p);
});

// ---------- Lydia in the chat: her eyes follow the mouse, she blinks, thinks and talks ----------

function follow(p) {
  const r = orb.getBoundingClientRect();
  const dx = p.x - (r.left + r.width / 2);
  const dy = p.y - (r.top + r.height / 2);
  const dist = Math.hypot(dx, dy) || 1;
  const reach = 6 * Math.min(1, dist / 260); // in SVG units
  orb.style.setProperty('--lx', ((dx / dist) * reach).toFixed(2));
  orb.style.setProperty('--ly', ((dy / dist) * reach * 0.75).toFixed(2));
}
let happyTimer = 0;
function smile(ms) {
  orb.classList.add('happy');
  clearTimeout(happyTimer);
  happyTimer = setTimeout(() => orb.classList.remove('happy'), ms);
}
function blinkLater() {
  setTimeout(() => {
    if (looking('chat') && !orb.classList.contains('happy')) {
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
orb.addEventListener('click', () => smile(1200));

// ---------- accent color ----------

const ACCENTS = ['#8f63f7', '#4f7cff', '#1fb5c9', '#2fbf71', '#f2a33a', '#ec5fa8', '#6b6f80', '#e6e2f0'];
const DEFAULT_ACCENT = ACCENTS[0];
let accent = DEFAULT_ACCENT;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t));

/** The active tab, switches and sliders take it, with a readable ink on top. */
function applyAccent(color) {
  accent = color || DEFAULT_ACCENT;
  // her body is the accent color: highlight → deep shade
  orb.style.setProperty('--b0', mix(accent, '#ffffff', 0.6));
  orb.style.setProperty('--b1', accent);
  orb.style.setProperty('--b2', mix(accent, '#000000', 0.3));
  orb.style.setProperty('--b3', mix(accent, '#000000', 0.58));
  const css = document.documentElement.style;
  css.setProperty('--lav', mix(accent, '#ffffff', 0.12));
  const [r, g, b] = hex(accent);
  css.setProperty('--lav-ink', 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#111' : '#fff');
  for (const b of $('sw-accent').querySelectorAll('.swatch[data-color]')) b.classList.toggle('on', b.dataset.color === accent);
}
function pickAccent(color) {
  applyAccent(color);
  window.lydia.setAccent(color);
}

for (const c of ACCENTS) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.setProperty('--c', c);
  b.dataset.color = c;
  b.title = c;
  b.addEventListener('click', () => pickAccent(c));
  $('sw-accent').append(b);
}
{
  const custom = document.createElement('label');
  custom.className = 'swatch custom';
  const input = document.createElement('input');
  input.type = 'color';
  input.addEventListener('input', () => applyAccent(input.value));
  input.addEventListener('change', () => pickAccent(input.value));
  custom.append(input);
  $('sw-accent').append(custom);
}
$('look-reset').addEventListener('click', () => pickAccent(DEFAULT_ACCENT));
window.lydia.on('accent', applyAccent);
applyAccent(DEFAULT_ACCENT);

// ---------- views and input ----------

// Same heights as VIEW_H in main.js (it shapes the clickable area from them).
const VIEW_H = { home: 170, look: 410, tasks: 330, chat: 440, setup: 440, controls: 320, today: 300, clip: 380, apps: 380, wall: 250, power: 170 };
const VIEW_W = { home: 660, look: 720, tasks: 780, chat: 780, setup: 720, controls: 680, today: 780, clip: 660, apps: 700, wall: 780, power: 660 };
let lastTab = 'controls'; // opening again (with nothing to tell) goes back to it
function setView(view, tell = true) {
  if (!(view in VIEW_H)) return;
  const was = island.dataset.view;
  island.dataset.view = view;
  if (document.querySelector(`.tabs .tab[data-view="${view}"]`)) lastTab = view;
  document.documentElement.style.setProperty('--panel-h', `${VIEW_H[view]}px`);
  document.documentElement.style.setProperty('--panel-w', `${VIEW_W[view]}px`);
  for (const el of document.querySelectorAll('.tab[data-view]')) el.classList.toggle('active', el.dataset.view === view);
  if (tell && view !== was) window.lydia.setView(view);
  if (view === 'tasks') startTasks();
  else stopTasks();
  if (view === 'chat') focusChat();
  if (view === 'setup' && was !== 'setup') startSetup();
  if (view === 'chat') badges.chat = null;
  renderBadge();
  window.dispatchEvent(new CustomEvent('lydia-view', { detail: { view, was } })); // the workstation tabs (workstation.js)
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
for (const b of document.querySelectorAll('#bar-content button')) {
  b.addEventListener('click', () => window.lydia.setPref('bar_content', b.dataset.v));
}
$('btn-overview').addEventListener('click', () => window.lydia.ws('sys.overview'));
$('btn-settings').addEventListener('click', () => window.lydia.ws('sys.settings'));

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
  window.dispatchEvent(new CustomEvent('lydia-view', { detail: { view: island.dataset.view, was: island.dataset.view } }));
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
    if ((e.state === 'retrying' || e.state === 'note') && current && !raw) current.innerHTML = `<span class="hint">${esc(t('chat.retrying'))}</span>`;
    else {
      orb.classList.toggle('think', e.state === 'thinking');
      orb.classList.toggle('talk', e.state === 'speaking');
    }
  } else if (e.type === 'delta' && current) {
    raw += e.text;
    current.innerHTML = md(raw);
    messages.scrollTop = messages.scrollHeight;
  } else if (e.type === 'note') {
    if (current && !raw) current.innerHTML = `<span class="hint">${esc(e.text)}</span>`;
    refreshProvider(); // the engine switch shows in the Claude / Gemini / Local buttons
  } else if (e.type === 'done') {
    if (!looking('chat') && !e.error) notifyBadge('chat', 'Chat', t('chat.new_reply'), { text: t('news.chat'), see: t('news.see_chat'), open: () => setView('chat') });
    chatBusy = false;
    $('chat-send').disabled = false;
    if (voiceState !== 'speaking') orb.classList.remove('think', 'talk'); // the reply is over (unless she is saying it)
    if (!e.error) smile(1400);
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

const SETUP_STEPS = ['hi', 'chat', 'voice', 'desktop', 'done'];
let voiceStep = null; // the install's current step, or { error }
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
    if ((step === 'chat' && claudeWaiting) || step === 'desktop' || step === 'voice') setupRefresh();
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

  voice: (i) => {
    const v = i.voice;
    const ready = v.hear && v.speak;
    const plan = v.plan.map((p) => `<li>${esc(p.what)} · ${esc(p.from)} · ${p.mb} MB</li>`).join('');
    const total = v.plan.reduce((a, p) => a + p.mb, 0);
    const parts = `<div class="status">${v.speak ? ok(t('setup.voice_speak_ok')) : `<span>${t('setup.voice_speak_no')}</span>`}</div><div class="status">${v.hear ? ok(t('setup.voice_hear_ok')) : `<span>${t('setup.voice_hear_no')}</span>`}</div>`;
    let body;
    if (ready) body = `<div class="status">${ok(t('setup.voice_ready'))}${btn('voice-test', t('setup.voice_test'))}</div>`;
    else if (v.installing || (voiceStep && !voiceStep.error)) body = `<div class="status"><span>${t(`setup.voice_step_${voiceStep?.step ?? 'whisper-get'}`)}</span></div>`;
    else
      body = `${parts}<span class="s-text">${t('setup.voice_plan', { mb: total })}</span><ul class="plan">${plan}</ul>
        <div class="status">${btn('voice-install', t('setup.voice_install', { mb: total }))}<span class="s-err">${esc(voiceStep?.error ?? '')}</span></div>`;
    return `
      <p class="s-title">${t('setup.voice')}</p>
      <p class="s-text">${t('setup.voice_text', { key: (v.key ?? '—').replace('Super', 'Super').replace('Space', t('key.space')) })}</p>
      <div class="s-section">${body}</div>
      ${v.micMuted ? `<div class="s-section"><span class="warn">${t('voice.mic_muted')}</span> ${btn('voice-unmute', t('voice.unmute'), true)}</div>` : ''}`;
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
        ${item(i.voice.hear && i.voice.speak ? 'on' : 'off', t('setup.sum_voice', { state: t(i.voice.hear && i.voice.speak ? 'setup.sum_on' : 'setup.sum_off') }))}
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
window.lydia.on('voice-install', (e) => {
  if (e.step === 'all' || e.step === 'error') return;
  voiceStep = { step: e.step };
  if (SETUP_STEPS[setupStep] === 'voice') ((setupKey = ''), renderSetup());
});
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
  else if (act === 'voice-install') {
    voiceStep = { step: 'whisper-get' };
    redraw();
    const r = await window.lydia.voiceInstall();
    voiceStep = r.ok ? null : { error: t('setup.voice_failed', { why: r.error ?? '' }) };
    await setupRefresh();
    redraw();
  } else if (act === 'voice-test') window.lydia.voiceToggle();
  else if (act === 'voice-unmute') {
    await window.lydia.voiceUnmute();
    await setupRefresh();
  }
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
// Where the desktop can't report the pointer (Wayland with no helper), hover comes from here.
island.addEventListener('mouseenter', () => window.lydia.hover(true));
island.addEventListener('mouseleave', () => window.lydia.hover(false));
$('btn-mic').addEventListener('click', () => window.lydia.voiceToggle());

// ---------- voice: listening, thinking, speaking ----------

let voiceState = 'idle';
window.lydia.on('voice', (v) => {
  if (v.level != null) island.style.setProperty('--lv', v.level.toFixed(2));
  if (v.state === voiceState && v.heard == null) return;
  voiceState = v.state;
  island.dataset.voice = v.state;
  orb.classList.toggle('think', v.state === 'thinking');
  orb.classList.toggle('talk', v.state === 'speaking');
  $('btn-mic').classList.toggle('on', v.state === 'listening');
  renderPill(false);
});
// A spoken question goes to the chat too, so the answer stays there.
window.lydia.on('chat-voice', ({ text }) => {
  bubble('me', md(text));
  current = bubble('her typing', '');
  raw = '';
  chatBusy = true;
  $('chat-send').disabled = true;
});
$('btn-menu').addEventListener('click', () => window.lydia.menu());

translatePage();
setView('controls', false);
