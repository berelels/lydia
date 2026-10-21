const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * The Today tab's to-do list: { id, text, due (ms or null), done }, kept in
 * ~/.config/lydia/tasks.json. A task with a time reminds you when it comes.
 */

const FILE = () => path.join(path.dirname(config.configPath()), 'tasks.json');
let tasks = null;

function load() {
  if (tasks) return tasks;
  try {
    tasks = JSON.parse(fs.readFileSync(FILE(), 'utf8')).filter((x) => x && typeof x.text === 'string');
  } catch {
    tasks = [];
  }
  return tasks;
}
function save() {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(tasks, null, 1) + '\n', { mode: 0o600 });
}

/** Open first (by time, then oldest), then the done ones (last 20). */
function list() {
  const open = load().filter((x) => !x.done).sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.id - b.id);
  const done = load().filter((x) => x.done).slice(-20).reverse();
  return [...open, ...done];
}

function add(text, due = null) {
  const t = String(text ?? '').trim().slice(0, 200);
  if (!t) return list();
  load().push({ id: Date.now(), text: t, due: Number.isFinite(due) ? due : null, done: false, reminded: false });
  save();
  return list();
}
function toggle(id) {
  const x = load().find((y) => y.id === id);
  if (x) (x.done = !x.done), save();
  return list();
}
function remove(id) {
  tasks = load().filter((y) => y.id !== id);
  save();
  return list();
}
function clearDone() {
  tasks = load().filter((y) => !y.done);
  save();
  return list();
}

/** Tasks whose time has come and that weren't announced yet (each is returned once). */
function due(now = Date.now()) {
  const out = load().filter((x) => !x.done && x.due && x.due <= now && !x.reminded);
  if (out.length) {
    out.forEach((x) => (x.reminded = true));
    save();
  }
  return out;
}

module.exports = { list, add, toggle, remove, clearDone, due };
