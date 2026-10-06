const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findClaude } = require('./chat');

/**
 * What the setup wizard checks and does: Claude login, the GNOME helper
 * extension, Claude Code hooks, start on login. Everything that writes outside
 * Lydia's own folder only runs from a button the user pressed in the wizard.
 */

const HOME = os.homedir();
const EXT_UUID = 'lydia-helper@berelels';
const EXT_SRC = path.join(__dirname, '..', 'gnome-extension', EXT_UUID);
const EXT_DIR = path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'gnome-shell', 'extensions', EXT_UUID);
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const HOOK = path.join(__dirname, 'hook.py');
const AUTOSTART = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'autostart', 'lydia.desktop');

const run = (cmd, args, timeout = 8000) =>
  new Promise((resolve) => execFile(cmd, args, { timeout }, (err, out = '') => resolve(err ? null : String(out))));

// ---------- terminals ----------

/** The user's terminal, running `args` in `cwd`. false if none was found. */
function openTerminal(cwd, args) {
  const tries = [
    ['gnome-terminal', [`--working-directory=${cwd}`, '--', ...args]],
    ['kgx', ['--working-directory', cwd, '--', ...args]],
    ['ptyxis', ['--new-window', '--working-directory', cwd, '--', ...args]],
    ['konsole', ['--workdir', cwd, '-e', ...args]],
    ['x-terminal-emulator', ['-e', ...args]],
    ['xterm', ['-e', ...args]],
  ];
  const next = (i) => {
    if (i >= tries.length) return;
    const [cmd, a] = tries[i];
    const p = spawn(cmd, a, { cwd, detached: true, stdio: 'ignore' });
    p.on('error', () => next(i + 1));
    p.unref();
  };
  next(0);
  return true;
}

// ---------- Claude ----------

async function claudeStatus() {
  const bin = findClaude();
  if (!bin) return { installed: false, loggedIn: false };
  const out = await run(bin, ['auth', 'status', '--json']);
  try {
    const s = JSON.parse(out);
    return { installed: true, loggedIn: !!s.loggedIn, email: s.email ?? '' };
  } catch {
    return { installed: true, loggedIn: false };
  }
}

/** `claude auth login` in a terminal: it opens the browser and the user signs in there. */
function claudeLogin() {
  const bin = findClaude();
  if (!bin) return false;
  return openTerminal(HOME, [bin, 'auth', 'login']);
}

// ---------- Ollama ----------

async function ollamaStatus(models) {
  const installed = !!(await run('sh', ['-c', 'command -v ollama']))?.trim();
  return { installed, models };
}

// ---------- GNOME helper extension ----------

const isGnome = () => /gnome/i.test(process.env.XDG_CURRENT_DESKTOP || '');

async function enabledExtensions() {
  const out = await run('gsettings', ['get', 'org.gnome.shell', 'enabled-extensions']);
  return (out?.match(/'([^']+)'/g) ?? []).map((s) => s.slice(1, -1));
}

/** missing | installed (needs enabling) | enabled (works after the next login) | active */
async function extensionStatus(backend) {
  if (!isGnome()) return { gnome: false, state: 'unsupported' };
  if (backend === 'gnome') return { gnome: true, state: 'active' };
  if (!fs.existsSync(path.join(EXT_DIR, 'metadata.json'))) return { gnome: true, state: 'missing' };
  return { gnome: true, state: (await enabledExtensions()).includes(EXT_UUID) ? 'enabled' : 'installed' };
}

/** Copies the extension to the user's extensions and adds it to the enabled list (nothing else changes). */
async function installExtension() {
  if (!isGnome()) return { ok: false };
  fs.cpSync(EXT_SRC, EXT_DIR, { recursive: true });
  const list = await enabledExtensions();
  if (!list.includes(EXT_UUID)) {
    const value = `[${[...list, EXT_UUID].map((s) => `'${s}'`).join(', ')}]`;
    if ((await run('gsettings', ['set', 'org.gnome.shell', 'enabled-extensions', value])) === null) return { ok: false };
  }
  return { ok: true };
}

// ---------- Claude Code hooks ----------

const HOOK_CMD = `/usr/bin/python3 ${HOOK}`;
// Tool events take a matcher; PermissionRequest waits for an answer (hook.py gives up at 110 s).
const HOOK_EVENTS = {
  SessionStart: {},
  UserPromptSubmit: {},
  PreToolUse: { matcher: '*' },
  PostToolUse: { matcher: '*' },
  Notification: {},
  Stop: {},
  SessionEnd: {},
  PermissionRequest: { matcher: '*', timeout: 120 },
};
const isOurs = (h) => typeof h?.command === 'string' && h.command.includes('/hook.py') && h.command.includes('lydia');

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return { text: '', data: {} };
  const text = fs.readFileSync(SETTINGS, 'utf8');
  return { text, data: text.trim() ? JSON.parse(text) : {} };
}

/** settings.json with Lydia's hooks added (install) or taken out (remove); everything else kept. */
function withHooks(data, install) {
  const out = structuredClone(data);
  const hooks = (out.hooks ??= {});
  for (const [event, opts] of Object.entries(HOOK_EVENTS)) {
    const groups = (hooks[event] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
    if (install) groups.push({ ...(opts.matcher ? { matcher: opts.matcher } : {}), hooks: [{ type: 'command', command: HOOK_CMD, timeout: opts.timeout ?? 5 }] });
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete out.hooks;
  return out;
}

/** Line diff (LCS) between two texts: [{ op: ' ' | '+' | '-', line }]. Settings files are small. */
function diffLines(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) (out.push({ op: ' ', line: x[i] }), i++, j++);
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', line: x[i++] });
    else out.push({ op: '+', line: y[j++] });
  }
  while (i < n) out.push({ op: '-', line: x[i++] });
  while (j < m) out.push({ op: '+', line: y[j++] });
  return out;
}

function hooksInstalled() {
  try {
    return Object.values(readSettings().data.hooks ?? {}).some((groups) => groups.some((g) => (g.hooks ?? []).some(isOurs)));
  } catch {
    return false;
  }
}

/** What installing (or removing) would change in settings.json, for the user to read first. */
function hooksPlan(install) {
  let cur;
  try {
    cur = readSettings();
  } catch {
    return { error: 'parse' };
  }
  const before = cur.text.trim() ? JSON.stringify(cur.data, null, 2) : '';
  const after = JSON.stringify(withHooks(cur.data, install), null, 2);
  const lines = diffLines(before, after);
  // Only the changed lines and a little context around them.
  const keep = lines.map((l, i) => lines.slice(Math.max(0, i - 2), i + 3).some((x) => x.op !== ' '));
  return { path: SETTINGS.replace(HOME, '~'), diff: lines.filter((_, i) => keep[i]), changes: lines.some((l) => l.op !== ' ') };
}

/** Writes the change, keeping the previous file as settings.json.bak-lydia. */
function applyHooks(install) {
  const cur = readSettings();
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (cur.text) fs.writeFileSync(`${SETTINGS}.bak-lydia`, cur.text);
  fs.writeFileSync(SETTINGS, JSON.stringify(withHooks(cur.data, install), null, 2) + '\n');
  return { ok: true, backup: cur.text ? `${SETTINGS.replace(HOME, '~')}.bak-lydia` : '' };
}

// ---------- start on login ----------

const autostartOn = () => fs.existsSync(AUTOSTART);

function setAutostart(on, app) {
  if (!on) {
    fs.rmSync(AUTOSTART, { force: true });
    return { ok: true };
  }
  // Packaged: the app itself. From the source folder: its Electron with this folder.
  const exec = app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`;
  fs.mkdirSync(path.dirname(AUTOSTART), { recursive: true });
  fs.writeFileSync(
    AUTOSTART,
    ['[Desktop Entry]', 'Type=Application', 'Name=Lydia', 'Comment=Desktop companion', `Exec=${exec}`, 'X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-Delay=3', 'NoDisplay=true', ''].join('\n'),
  );
  return { ok: true };
}

module.exports = {
  openTerminal,
  claudeStatus,
  claudeLogin,
  ollamaStatus,
  extensionStatus,
  installExtension,
  hooksInstalled,
  hooksPlan,
  applyHooks,
  autostartOn,
  setAutostart,
  diffLines,
  withHooks,
};
