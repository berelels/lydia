const { execFile } = require('child_process');
const path = require('path');
const { unpacked } = require('../paths');
const { icon } = require('./files');

/**
 * The apps in the system tray (Discord, Steam, Claude...), through tray.py:
 * listed with their icons, opened with a click, and their own menus read and
 * clicked. Empty on a desktop with no tray watcher.
 */

const SCRIPT = unpacked(path.join(__dirname, 'tray.py'));
const SERVICE = /^(:\d+\.\d+|[\w.-]+)$/;
const OBJPATH = /^\/[\w/]*$/;

const run = (args) =>
  new Promise((resolve) =>
    execFile('python3', [SCRIPT, ...args], { timeout: 6000, maxBuffer: 8 << 20 }, (err, out) => {
      try {
        resolve(err ? null : JSON.parse(String(out)));
      } catch {
        resolve(null);
      }
    }),
  );

/** [{ service, path, id, title, icon, menu, onlyMenu }], [] with no tray */
async function list() {
  const items = (await run(['list'])) ?? [];
  return items.map((i) => ({ ...i, icon: i.icon || icon(i.iconName) }));
}

/** A left click. { ok: false } when the item only has a menu (then the menu is shown instead). */
async function activate({ service, path: p } = {}) {
  if (!SERVICE.test(service ?? '') || !OBJPATH.test(p ?? '')) return { ok: false };
  return (await run(['activate', service, p])) ?? { ok: false };
}

/** Its menu: [{ id, label, type, enabled, toggle, checked, children }] */
async function menu({ service, menu: m } = {}) {
  if (!SERVICE.test(service ?? '') || !OBJPATH.test(m ?? '')) return { items: [] };
  return (await run(['menu', service, m])) ?? { items: [] };
}

async function click({ service, menu: m, id } = {}) {
  if (!SERVICE.test(service ?? '') || !OBJPATH.test(m ?? '') || !Number.isInteger(id)) return { ok: false };
  return (await run(['click', service, m, String(id)])) ?? { ok: false };
}

module.exports = { list, activate, menu, click };
