// The workstation tabs: Controls, Today, Clipboard, Apps, Wallpaper, Power
// (and uptime / speed test in System). Loaded after island.js and uses its
// helpers ($, t, esc, setView). Everything goes through window.lydia.ws().

const ws = (action, args) => window.lydia.ws(action, args);
let wsTimer = 0;

const SVG = {
  wifi: '<path class="stroke" d="M3.5 9.5a12 12 0 0 1 17 0M6.5 12.8a7.5 7.5 0 0 1 11 0M9.6 16a3 3 0 0 1 4.8 0"/><circle cx="12" cy="19" r="1.3"/>',
  wired: '<path class="stroke" d="M8 4v5M16 4v5M6 9h12v3a6 6 0 0 1-12 0V9zM12 18v3"/>',
  bluetooth: '<path class="stroke" d="M7 7.5l10 9-5 4.5V3l5 4.5-10 9"/>',
  night: '<path class="stroke" d="M18 14.5A7 7 0 1 1 9.5 6a5.5 5.5 0 0 0 8.5 8.5z"/>',
  dnd: '<circle class="stroke" cx="12" cy="12" r="8"/><path class="stroke" d="M8 12h8"/>',
  dark: '<circle class="stroke" cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path class="stroke" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  muted: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path class="stroke" d="M16 9.5l5 5M21 9.5l-5 5"/>',
  mic: '<path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/><path class="stroke" d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5"/>',
  micOff: '<path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/><path class="stroke" d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5M4 4l16 16"/>',
  sun: '<circle cx="12" cy="12" r="3.6"/><path class="stroke" d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6"/>',
  prev: '<path d="M7 5.5h2v13H7zM19 5.5v13L10 12z"/>',
  next: '<path d="M15 5.5h2v13h-2zM5 5.5v13l9-6.5z"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>',
  pin: '<path d="M9 4h6l-1 5 3 3H7l3-3z"/><path class="stroke" d="M12 12v7"/>',
  close: '<path class="stroke" d="M7 7l10 10M17 7 7 17"/>',
  check: '<path class="stroke" d="M6 12.5l4 4 8-9"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24">${SVG[name]}</svg>`;
const clock = (secs) => {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

// ---------- Controls ----------

let ctl = null;
let media = null;
let sliding = false; // don't redraw a slider under the finger
const tile = (what, ico, label, sub, on, can = true) =>
  `<button class="ctl-tile ${on ? 'on' : ''}" data-what="${what}" ${can ? '' : 'disabled'}>${icon(ico)}<span><b>${esc(label)}</b><small>${esc(sub)}</small></span></button>`;

function renderControls() {
  if (!ctl) return;
  const n = ctl.network;
  const tiles = [];
  if (n?.wifi) tiles.push(tile('wifi', 'wifi', t('ctl.wifi'), n.wifi.ssid || t(n.wifi.on ? 'ctl.on' : 'ctl.off'), n.wifi.on));
  else if (n) tiles.push(tile('', 'wired', t(n.wired ? 'ctl.wired' : 'ctl.offline'), n.wired ?? '', !!n.wired, false));
  if (ctl.bluetooth) tiles.push(tile('bluetooth', 'bluetooth', t('ctl.bluetooth'), ctl.bluetooth.connected[0] ?? t(ctl.bluetooth.on ? 'ctl.on' : 'ctl.off'), ctl.bluetooth.on));
  if (ctl.nightLight !== null) tiles.push(tile('nightLight', 'night', t('ctl.night'), t(ctl.nightLight ? 'ctl.on' : 'ctl.off'), ctl.nightLight));
  if (ctl.dnd !== null) tiles.push(tile('dnd', 'dnd', t('ctl.dnd'), t(ctl.dnd ? 'ctl.on' : 'ctl.off'), ctl.dnd));
  if (ctl.dark !== null) tiles.push(tile('dark', 'dark', t('ctl.dark'), t(ctl.dark ? 'ctl.on' : 'ctl.off'), ctl.dark));
  $('ctl-grid').innerHTML = tiles.join('');

  if (sliding) return;
  const s = ctl.sound;
  const rows = [];
  if (s && s.volume !== null) {
    rows.push(`<div class="ctl-row"><button class="ctl-ico" data-what="mute" title="${esc(t('ctl.volume'))}">${icon(s.muted ? 'muted' : 'volume')}</button>
      <input type="range" min="0" max="100" value="${s.volume}" data-what="volume">
      <select data-what="sink" title="${esc(t('ctl.output'))}">${s.sinks.map((k) => `<option value="${esc(k.name)}" ${k.name === s.current ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}</select></div>`);
  }
  const m = ctl.mic;
  if (m && m.volume !== null) {
    rows.push(`<div class="ctl-row"><button class="ctl-ico" data-what="micMute" title="${esc(t('ctl.input'))}">${icon(m.muted ? 'micOff' : 'mic')}</button>
      <input type="range" min="0" max="100" value="${m.volume}" data-what="micVolume">
      <select data-what="source" title="${esc(t('ctl.input'))}">${m.sources.map((k) => `<option value="${esc(k.name)}" ${k.name === m.current ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}</select></div>`);
  }
  if (ctl.brightness !== null) {
    rows.push(`<div class="ctl-row"><span class="ctl-ico" title="${esc(t('ctl.brightness'))}">${icon('sun')}</span>
      <input type="range" min="1" max="100" value="${ctl.brightness}" data-what="brightness"></div>`);
  }
  $('ctl-sliders').innerHTML = rows.join('');
  for (const r of $('ctl-sliders').querySelectorAll('input[type="range"]')) r.style.setProperty('--v', `${r.value}%`); // (inline style="" is blocked by the page's CSP)
}

let playerKey = '';
let volTimer = 0; // the volume sliders (player and music card) send at most every 60 ms
let playerAt = 0; // when `media` was read: the position runs on from there while it plays
/** The player in Controls: like the bar's music card, larger. Rebuilt only when the song changes. */
function renderPlayer() {
  const p = media;
  const box = $('player');
  if (!p) {
    playerKey = '';
    box.classList.remove('has');
    box.innerHTML = `<div class="player-empty muted">${esc(t('ctl.nothing'))}</div>`;
    return;
  }
  const key = `${p.player}|${p.title}|${p.cover?.length ?? 0}`;
  if (key !== playerKey) {
    playerKey = key;
    box.classList.add('has');
    box.innerHTML = `
      <div class="cp-bg"></div>
      <div class="cover"></div>
      <div class="meta"><b>${esc(p.title || p.identity || p.app)}</b><small>${esc(p.artist || p.identity || p.app)}</small></div>
      <div class="cp-pos"><input type="range" min="0" max="1000" value="0"><small class="time"></small></div>
      <div class="buttons">
        <button data-act="previous">${icon('prev')}</button>
        <button data-act="toggle" class="big"></button>
        <button data-act="next">${icon('next')}</button>
      </div>
      <label class="cp-vol" title="${esc(t('music.volume'))}">${icon('volume')}<input type="range" min="0" max="100"></label>`;
    const url = p.cover ? `url("${p.cover}")` : '';
    box.querySelector('.cp-bg').style.backgroundImage = url;
    box.querySelector('.cover').style.backgroundImage = url;
  }
  box.querySelector('[data-act="toggle"]').innerHTML = icon(p.status === 'Playing' ? 'pause' : 'play');
  box.classList.toggle('playing', p.status === 'Playing');
  box.querySelector('.cp-pos').hidden = !p.length;
  const vol = box.querySelector('.cp-vol input');
  box.querySelector('.cp-vol').hidden = p.volume == null;
  if (p.volume != null && document.activeElement !== vol) {
    vol.value = p.volume;
    vol.style.setProperty('--v', `${p.volume}%`);
  }
  tickPlayer();
}
function tickPlayer() {
  const p = media;
  const pos = $('player').querySelector('.cp-pos input');
  if (!p?.length || !pos || document.activeElement === pos) return;
  const now = Math.min(p.length, p.position + (p.status === 'Playing' ? (Date.now() - playerAt) / 1000 : 0));
  pos.value = Math.round((now / p.length) * 1000);
  pos.style.setProperty('--v', `${(now / p.length) * 100}%`);
  $('player').querySelector('.time').textContent = `${clock(now)} / ${clock(p.length)}`;
}
setInterval(() => island.dataset.view === 'controls' && state.expanded && tickPlayer(), 500);
$('player').addEventListener('input', (e) => {
  const r = e.target;
  if (r.type !== 'range' || !media) return;
  if (r.closest('.cp-vol')) {
    r.style.setProperty('--v', `${r.value}%`);
    clearTimeout(volTimer);
    volTimer = setTimeout(() => ws('media.volume', { player: media.player, value: Number(r.value) }), 60);
  } else r.style.setProperty('--v', `${r.value / 10}%`);
});
$('player').addEventListener('change', async (e) => {
  const r = e.target;
  if (r.type !== 'range' || !media?.length || r.closest('.cp-vol')) return;
  const seconds = (r.value / 1000) * media.length;
  media = { ...media, position: seconds };
  playerAt = Date.now();
  r.blur();
  await ws('media.seek', { player: media.player, trackId: media.trackId, seconds });
});

async function loadControls() {
  const [c, m] = await Promise.all([ws('controls.get'), ws('media.get')]);
  if (c) ctl = c;
  media = m;
  playerAt = Date.now();
  renderControls();
  renderPlayer();
}

$('ctl-grid').addEventListener('click', async (e) => {
  const b = e.target.closest('.ctl-tile[data-what]');
  if (!b || !b.dataset.what) return;
  b.classList.toggle('on'); // answers at once; the real state follows
  const what = b.dataset.what;
  const now = { wifi: ctl.network?.wifi?.on, bluetooth: ctl.bluetooth?.on, nightLight: ctl.nightLight, dnd: ctl.dnd, dark: ctl.dark }[what];
  const c = await ws('controls.set', { what, value: !now });
  if (c) (ctl = c), renderControls();
});
let slideTimer = 0;
$('ctl-sliders').addEventListener('input', (e) => {
  const r = e.target;
  if (r.type !== 'range') return;
  sliding = true;
  r.style.setProperty('--v', `${r.value}%`);
  clearTimeout(slideTimer);
  slideTimer = setTimeout(() => ws('controls.set', { what: r.dataset.what, value: Number(r.value) }), 60);
});
$('ctl-sliders').addEventListener('change', async (e) => {
  const what = e.target.dataset.what;
  if (e.target.type === 'range') {
    sliding = false;
    return;
  }
  if (what === 'sink' || what === 'source') {
    const c = await ws('controls.set', { what, value: e.target.value });
    if (c) (ctl = c), renderControls();
  }
});
$('ctl-sliders').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-what="mute"], button[data-what="micMute"]');
  if (!b) return;
  const mic = b.dataset.what === 'micMute';
  const c = await ws('controls.set', { what: b.dataset.what, value: mic ? !ctl.mic.muted : !ctl.sound.muted });
  if (c) (ctl = c), renderControls();
});
$('player').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || !media) return;
  media = await ws('media.do', { player: media.player, action: b.dataset.act });
  playerAt = Date.now();
  renderPlayer();
});

// ---------- Today ----------

let todos = [];
let timerEnd = 0;
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function renderWeek() {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const count = {};
  for (const x of todos) if (x.due && !x.done) count[dayKey(new Date(x.due))] = (count[dayKey(new Date(x.due))] ?? 0) + 1;
  const fmtDay = new Intl.DateTimeFormat(i18n.htmlLang(), { weekday: 'short' });
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const k = dayKey(d);
    days.push(`<div class="day ${k === dayKey(now) ? 'today' : ''}"><small>${esc(fmtDay.format(d).replace('.', ''))}</small><b>${d.getDate()}</b><i>${count[k] ? '•'.repeat(Math.min(3, count[k])) : ''}</i></div>`);
  }
  $('week').innerHTML = days.join('');
}

function renderTodos() {
  renderWeek();
  const time = new Intl.DateTimeFormat(i18n.htmlLang(), { hour: '2-digit', minute: '2-digit' });
  const date = new Intl.DateTimeFormat(i18n.htmlLang(), { day: 'numeric', month: 'short' });
  const today = dayKey(new Date());
  const rows = todos.map((x) => {
    const when = x.due ? (dayKey(new Date(x.due)) === today ? time.format(x.due) : `${date.format(x.due)} ${time.format(x.due)}`) : '';
    const late = x.due && !x.done && x.due < Date.now();
    return `<div class="todo-item ${x.done ? 'done' : ''}" data-id="${x.id}">
      <button class="check" data-do="toggle">${x.done ? icon('check') : ''}</button>
      <span class="text">${esc(x.text)}</span>
      ${when ? `<small class="${late ? 'late' : ''}">${esc(when)}</small>` : ''}
      <button class="x" data-do="remove">${icon('close')}</button></div>`;
  });
  const anyDone = todos.some((x) => x.done);
  $('todo').innerHTML = rows.length ? rows.join('') + (anyDone ? `<button class="link small clear-done">${esc(t('today.clear_done'))}</button>` : '') : `<div class="muted empty">${esc(t('today.empty'))}</div>`;
}

function renderTimer() {
  const left = (timerEnd - Date.now()) / 1000;
  const box = $('timers');
  if (left > 0) {
    box.innerHTML = `<span class="timer-left">${esc(t('today.timer_left', { left: clock(left) }))}</span><button class="s-btn plain" data-cancel>${esc(t('today.cancel'))}</button>`;
  } else if (!box.querySelector('[data-min]')) {
    box.innerHTML = `<span class="muted">${esc(t('today.timer'))}</span>${[5, 15, 25, 60].map((m) => `<button class="s-btn plain" data-min="${m}">${m} min</button>`).join('')}`;
  }
}

function renderClock() {
  const now = new Date();
  const lang = i18n.htmlLang();
  $('clock-time').textContent = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(now);
  $('clock-day').textContent = new Intl.DateTimeFormat(lang, { weekday: 'long' }).format(now);
  $('clock-date').textContent = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long' }).format(now);
}

async function loadToday() {
  renderClock();
  const [list, end] = await Promise.all([ws('tasks.get'), ws('timer.get')]);
  todos = list ?? [];
  timerEnd = end ?? 0;
  renderTodos();
  renderTimer();
}

$('task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('task-text').value.trim();
  if (!text) return;
  let due = null;
  const hm = $('task-time').value;
  if (hm) {
    const [h, m] = hm.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() < Date.now() - 60_000) d.setDate(d.getDate() + 1); // a time already gone: tomorrow
    due = d.getTime();
  }
  todos = (await ws('tasks.add', { text, due })) ?? todos;
  $('task-text').value = '';
  $('task-time').value = '';
  renderTodos();
});
$('todo').addEventListener('click', async (e) => {
  if (e.target.closest('.clear-done')) {
    todos = (await ws('tasks.clearDone')) ?? todos;
    return renderTodos();
  }
  const b = e.target.closest('button[data-do]');
  if (!b) return;
  const id = Number(b.closest('.todo-item').dataset.id);
  todos = (await ws(`tasks.${b.dataset.do}`, { id })) ?? todos;
  renderTodos();
});
$('timers').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.min) timerEnd = await ws('timer.start', { seconds: Number(b.dataset.min) * 60 });
  else if ('cancel' in b.dataset) timerEnd = await ws('timer.cancel');
  $('timers').innerHTML = '';
  renderTimer();
});

// ---------- System: uptime and speed ----------

async function loadSystem() {
  const s = await ws('stats.get');
  if (!s) return;
  const h = Math.floor(s.uptime / 3600);
  const m = Math.floor((s.uptime % 3600) / 60);
  $('sys-up').textContent = h ? `${h}h ${m}min` : `${m} min`;
}
$('sys-speed').addEventListener('click', async () => {
  const b = $('sys-speed');
  if (b.disabled) return;
  b.disabled = true;
  b.textContent = t('sys.testing');
  const r = await ws('stats.speed');
  b.disabled = false;
  b.textContent = t('sys.speed');
  $('sys-net').textContent = r?.mbps ? `${fmt(r.mbps)} Mbit/s` : t('sys.speed_fail');
});

// ---------- Clipboard ----------

let clipItems = [];
let clipPaused = false;

function renderClip() {
  const q = $('clip-search').value.trim().toLowerCase();
  const list = clipItems.filter((x) => !q || (x.kind === 'text' && x.text.toLowerCase().includes(q)));
  $('clip-pause').textContent = t(clipPaused ? 'clip.resume' : 'clip.pause');
  const rows = list.map(
    (x) => `<div class="clip-item ${x.pinned ? 'pinned' : ''}" data-id="${x.id}" title="${esc(t('clip.paste_tip'))}">
      ${x.kind === 'image' ? `<img src="${x.thumb}" alt=""><small>${esc(x.size)}</small>` : `<span class="text">${esc(x.text.slice(0, 400))}</span>`}
      <span class="acts"><button data-do="pin" class="${x.pinned ? 'on' : ''}" title="${esc(t(x.pinned ? 'clip.unpin' : 'clip.pin'))}">${icon('pin')}</button><button data-do="remove" title="${esc(t('clip.remove'))}">${icon('close')}</button></span></div>`,
  );
  const note = clipPaused ? `<div class="muted empty">${esc(t('clip.paused'))}</div>` : '';
  $('clip-list').innerHTML = note + (rows.length ? rows.join('') : clipPaused ? '' : `<div class="muted empty">${esc(t('clip.empty'))}</div>`);
}
async function loadClip() {
  const r = await ws('clip.get');
  if (!r) return;
  clipItems = r.items;
  clipPaused = r.paused;
  renderClip();
}
$('clip-search').addEventListener('input', renderClip);
$('clip-pause').addEventListener('click', async () => {
  clipPaused = await ws('clip.pause', { on: !clipPaused });
  renderClip();
});
$('clip-clear').addEventListener('click', async () => {
  clipItems = (await ws('clip.clear')) ?? clipItems;
  renderClip();
});
$('clip-list').addEventListener('click', async (e) => {
  const item = e.target.closest('.clip-item');
  if (!item) return;
  const id = Number(item.dataset.id);
  const b = e.target.closest('button[data-do]');
  if (b) {
    clipItems = (await ws(`clip.${b.dataset.do}`, { id })) ?? clipItems;
    return renderClip();
  }
  ws('clip.use', { id, paste: true });
});
window.lydia.on('clip-changed', () => island.dataset.view === 'clip' && loadClip());

// ---------- Apps ----------

let appData = null;

function renderApps() {
  if (!appData) return;
  const q = $('app-search').value.trim().toLowerCase();
  const cell = (a) => `<button class="app" data-id="${esc(a.id)}" title="${esc(a.name)} · ${esc(t('apps.fav_tip'))}">${a.icon ? `<img src="${a.icon}" alt="">` : `<i>${esc(a.name[0] ?? '?')}</i>`}<span>${esc(a.name)}</span></button>`;
  // every word of the search (its start: "explorador" finds "explorar") in the name, the English name or the keywords
  const plain = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const words = plain(q).split(/\s+/).filter((w) => w.length > 2);
  const all = appData.all.filter((a) => {
    if (!q) return true;
    const hay = plain(`${a.name} ${a.find}`);
    return hay.includes(plain(q)) || (words.length && words.every((w) => hay.includes(w.slice(0, Math.max(3, Math.min(5, w.length))))));
  });
  let html = '';
  if (!q && appData.favorites.length) html += `<div class="side-title">${esc(t('apps.favorites'))}</div><div class="apps fav">${appData.favorites.map(cell).join('')}</div><div class="side-title">${esc(t('apps.all'))}</div>`;
  html += all.length ? `<div class="apps">${all.map(cell).join('')}</div>` : `<div class="muted empty">${esc(t('apps.none'))}</div>`;
  $('app-grid').innerHTML = html;
}
async function loadApps() {
  appData = (await ws('apps.get')) ?? appData;
  renderApps();
}
$('app-search').addEventListener('input', renderApps);
$('app-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = $('app-grid').querySelector('.app');
  if (first) ws('apps.launch', { id: first.dataset.id });
});
$('app-grid').addEventListener('click', (e) => {
  const b = e.target.closest('.app');
  if (b) ws('apps.launch', { id: b.dataset.id });
});
$('app-grid').addEventListener('contextmenu', async (e) => {
  const b = e.target.closest('.app');
  if (!b) return;
  e.preventDefault();
  e.stopPropagation(); // favorite only: not Lydia's own menu too
  appData = (await ws('apps.favorite', { id: b.dataset.id })) ?? appData;
  renderApps();
});

// ---------- Wallpaper ----------

let wall = null;
// the big one in the middle: the wallpaper in use if it is in this folder, else the newest
const wallFocus = () => Math.max(0, wall.items.findIndex((w) => w.file === wall.current));

function renderWall() {
  if (!wall) return;
  $('wall-dir').textContent = wall.dir ? wall.dir.split('/').filter(Boolean).pop() : '';
  $('wall-dir').title = wall.dir;
  $('wall-count').textContent = wall.dir ? t('wall.count', { n: wall.items.length }) : '';
  $('wall-strip').innerHTML = !wall.dir
    ? `<div class="muted empty">${esc(t('wall.none'))}</div>`
    : wall.items.length
      ? wall.items.map((w, i) => `<button class="wall ${i === wallFocus() ? 'on' : ''} ${w.file === wall.current ? 'current' : ''}" data-file="${esc(w.file)}" data-flag="${esc(t('wall.current'))}" title="${esc(w.name)}">${w.thumb ? `<img src="${w.thumb}" alt="">` : ''}</button>`).join('')
      : `<div class="muted empty">${esc(t('wall.empty'))}</div>`;
  $('wall-strip').querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}
async function loadWall() {
  wall = (await ws('wall.get')) ?? wall;
  renderWall();
}
$('wall-pick').addEventListener('click', async () => {
  if ((await ws('wall.pickDir')) !== null) loadWall();
});
$('wall-strip').addEventListener('click', async (e) => {
  const b = e.target.closest('.wall[data-file]');
  if (!b) return;
  if (await ws('wall.set', { file: b.dataset.file })) {
    wall.current = b.dataset.file;
    renderWall();
  }
});
$('wall-strip').addEventListener('wheel', (e) => {
  // a horizontal strip: the wheel scrolls it sideways
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.currentTarget.scrollLeft += e.deltaY;
    e.preventDefault();
    e.stopPropagation();
  }
}, { passive: false });

// ---------- Power ----------

function askPower(action) {
  const box = $('power-confirm');
  box.hidden = false;
  box.dataset.action = action;
  box.innerHTML = `<span>${esc(t('power.sure', { what: t(`power.${action}`).toLowerCase() }))}</span>
    <button class="s-btn danger" data-sure="1">${esc(t('power.yes'))}</button><button class="s-btn plain" data-sure="0">${esc(t('power.no'))}</button>`;
}
async function doPower(action, sure) {
  const r = await ws('power.do', { action, sure });
  if (r?.confirm) return askPower(action);
  $('power-confirm').hidden = true;
  if (r === false) {
    $('power-confirm').hidden = false;
    $('power-confirm').innerHTML = `<span>${esc(t('power.failed'))}</span>`;
  } else window.lydia.collapse();
}
$('power-grid').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-p]');
  if (b) doPower(b.dataset.p, false);
});
$('power-confirm').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-sure]');
  if (!b) return;
  if (b.dataset.sure === '1') doPower($('power-confirm').dataset.action, true);
  else $('power-confirm').hidden = true;
});

// ---------- Notifications (the system's, through the GNOME helper) ----------

let notifs = null;
let notifDnd = null;
const plainText = (html) => {
  const d = document.createElement('div');
  d.innerHTML = String(html).replace(/<[^>]*>/g, ' '); // markup out, entities decoded
  return d.textContent.replace(/\s+/g, ' ').trim();
};
function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return t('notif.now');
  if (min < 60) return t('notif.min', { n: min });
  if (min < 48 * 60) return t('notif.hour', { n: Math.round(min / 60) });
  return new Intl.DateTimeFormat(i18n.htmlLang(), { day: 'numeric', month: 'short' }).format(ms);
}
function renderNotifCount() {
  const n = notifs?.length ?? 0;
  $('notif-count').textContent = n > 9 ? '9+' : n || '';
  $('btn-notif').classList.toggle('has', n > 0);
}
function renderNotifs() {
  renderNotifCount();
  $('notif-dnd').textContent = notifDnd === null ? '' : t(notifDnd ? 'notif.dnd_on' : 'notif.dnd_off');
  $('notif-clear').hidden = !notifs?.length;
  if (notifs === null) return ($('notif-list').innerHTML = `<div class="muted empty">${esc(t('notif.unavailable'))}</div>`);
  if (!notifs.length) return ($('notif-list').innerHTML = `<div class="muted empty">${esc(t('notif.empty'))}</div>`);
  $('notif-list').innerHTML = notifs
    .map(
      (n) => `<div class="notif" data-id="${n.id}">
      ${n.icon ? `<img src="${n.icon}" alt="">` : `<i class="notif-ico">${esc((n.app || '?')[0])}</i>`}
      <div class="notif-text"><small>${esc(n.app)}${n.time ? ` · ${esc(ago(n.time))}` : ''}</small><b>${esc(plainText(n.title))}</b><span>${esc(plainText(n.body))}</span></div>
      <button class="x" data-do="dismiss">${icon('close')}</button></div>`,
    )
    .join('');
  // the stagger index for the entrance animation (an inline style="" would be blocked by the CSP)
  $('notif-list').querySelectorAll('.notif').forEach((el, i) => el.style.setProperty('--i', i));
}
async function loadNotifs() {
  notifs = await ws('notif.get');
  renderNotifs();
}
$('notif-list').addEventListener('click', async (e) => {
  const item = e.target.closest('.notif');
  if (!item) return;
  const id = Number(item.dataset.id);
  if (e.target.closest('[data-do="dismiss"]')) {
    item.classList.add('leaving'); // slides away, then the list is read again
    await ws('notif.dismiss', { id });
    setTimeout(loadNotifs, 220);
  } else ws('notif.open', { id });
});
$('notif-clear').addEventListener('click', async () => {
  $('notif-list').querySelectorAll('.notif').forEach((el) => el.classList.add('leaving'));
  await ws('notif.clear', { ids: (notifs ?? []).map((n) => n.id) });
  setTimeout(loadNotifs, 260);
});
$('notif-dnd').addEventListener('click', async () => {
  const c = await ws('controls.set', { what: 'dnd', value: !notifDnd });
  notifDnd = c?.dnd ?? notifDnd;
  renderNotifs();
});
window.lydia.on('notif-changed', () => (island.dataset.view === 'notif' && state.expanded ? loadNotifs() : ws('notif.get').then((l) => ((notifs = l), renderNotifCount()))));
setTimeout(() => ws('notif.get').then((l) => ((notifs = l), renderNotifCount())), 3000); // the bell's count from the start

// ---------- the music card on the closed bar ----------

let music = null; // the last report from main (the cover kept: it only comes when it changes)
let musicCover = '';
let seeking = false;
const PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';

/** Where the song is now: the last report plus the time since, while it plays. */
const musicPos = () => (music ? Math.min(music.length || Infinity, music.position + (music.status === 'Playing' ? (Date.now() - music.at) / 1000 : 0)) : 0);

function renderMusic() {
  if (!music) return;
  $('music-title').textContent = music.title || music.identity || music.app;
  $('music-artist').textContent = music.artist || music.identity || music.app;
  const url = musicCover ? `url("${musicCover}")` : '';
  $('music-cover').style.backgroundImage = url;
  $('music-bg').style.backgroundImage = url;
  $('music').classList.toggle('no-cover', !musicCover);
  $('music-play').innerHTML = music.status === 'Playing' ? PAUSE : PLAY;
  $('music').classList.toggle('playing', music.status === 'Playing');
  $('music-scrub').classList.toggle('off', !music.length || !music.canSeek);
  const v = $('music-volume');
  v.parentElement.hidden = music.volume == null;
  if (music.volume != null && document.activeElement !== v) {
    v.value = music.volume;
    v.style.setProperty('--v', `${music.volume}%`);
  }
}
let waveFor = 0; // the bar width the wave was drawn for
function tickMusic() {
  if (!music || !island.classList.contains('music') || seeking) return;
  if ($('music-scrub').clientWidth !== waveFor) drawWave(); // first time shown (hidden, it has no width)
  const frac = music.length ? Math.min(1, musicPos() / music.length) : 0;
  $('music-pos').value = Math.round(frac * 1000);
  $('music-scrub').style.setProperty('--f', frac.toFixed(4));
}
setInterval(tickMusic, 250);

/** The wavy line (like a phone's player): a long repeating wave, clipped to the part already played. */
function drawWave() {
  waveFor = $('music-scrub').clientWidth;
  const w = waveFor + 40;
  let d = 'M0 6';
  for (let x = 0; x < w; x += 16) d += ` q4 -5 8 0 t8 0`;
  $('music-wave').setAttribute('d', d);
  $('music-squiggle').setAttribute('viewBox', `0 0 ${w} 12`);
  $('music-squiggle').style.width = `${w}px`;
}

// the song's tempo: one wavelength of the wave per beat
window.lydia.on('tempo', (bpm) => $('music').style.setProperty('--beat', `${(60 / bpm).toFixed(3)}s`));
window.lydia.on('media', (m) => {
  if (!m) return void (music = null);
  if (m.cover !== undefined) musicCover = m.cover;
  music = m;
  renderMusic();
  tickMusic();
});

async function musicDo(action) {
  if (!music) return;
  const m = await ws('media.do', { player: music.player, action });
  if (m) {
    musicCover = m.cover || musicCover;
    music = { ...m, at: Date.now() };
    renderMusic();
  }
}
$('music-play').addEventListener('click', () => musicDo('toggle'));
for (const b of $('music').querySelectorAll('.music-btn')) b.addEventListener('click', () => musicDo(b.dataset.act));
$('music-pos').addEventListener('input', (e) => {
  seeking = true;
  $('music-scrub').style.setProperty('--f', (e.target.value / 1000).toFixed(4));
});
$('music-pos').addEventListener('change', async (e) => {
  if (!music?.length) return void (seeking = false);
  const seconds = (e.target.value / 1000) * music.length;
  music = { ...music, position: seconds, at: Date.now() };
  await ws('media.seek', { player: music.player, trackId: music.trackId, seconds });
  seeking = false;
});
$('music-volume').addEventListener('input', (e) => {
  const value = Number(e.target.value);
  e.target.style.setProperty('--v', `${value}%`);
  clearTimeout(volTimer);
  volTimer = setTimeout(() => music && ws('media.volume', { player: music.player, value }), 60);
});
for (const id of ['music-cover', 'music-meta']) $(id).addEventListener('click', () => window.lydia.open('controls'));

// ---------- switching ----------

const LOADERS = {
  notif: [async () => (notifDnd === null && (notifDnd = (await ws('controls.get'))?.dnd ?? null), loadNotifs()), 0],
  controls: [loadControls, 2500],
  today: [loadToday, 1000],
  tasks: [loadSystem, 30_000],
  clip: [loadClip, 0],
  apps: [loadApps, 0],
  wall: [loadWall, 0],
};
// Today's countdown ticks without asking main each second
const TICKERS = {
  today: () => {
    renderClock();
    if (timerEnd > Date.now() || $('timers').querySelector('.timer-left')) renderTimer();
  },
};

window.addEventListener('lydia-view', (e) => {
  const { view, was } = e.detail;
  clearInterval(wsTimer);
  $('power-confirm').hidden = view !== 'power' ? true : $('power-confirm').hidden;
  const l = LOADERS[view];
  if (!l) return;
  const [load, every] = l;
  load();
  if (view === 'today') wsTimer = setInterval(TICKERS.today, every);
  else if (every) wsTimer = setInterval(load, every);
  if (view === 'apps' && view !== was) setTimeout(() => $('app-search').focus({ preventScroll: true }), 60);
  if (view === 'clip' && view !== was) $('clip-search').value = '';
});

// Scrolling over the tab bar walks through the tabs.
let wheelAt = 0;
document.querySelector('.topbar').addEventListener('wheel', (e) => {
  e.preventDefault();
  if (Date.now() - wheelAt < 180) return;
  wheelAt = Date.now();
  const tabs = [...document.querySelectorAll('.tabs .tab[data-view]')].map((x) => x.dataset.view);
  const i = tabs.indexOf(island.dataset.view);
  const next = tabs[(Math.max(0, i) + (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1) + tabs.length) % tabs.length];
  setView(next);
}, { passive: false });
