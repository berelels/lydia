const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findClaude } = require('./chat');
const { unpacked } = require('./paths');
const { hostData, hostConfig, inFlatpak } = require('./host');

/**
 * What the setup wizard checks and does: Claude login, the GNOME helper
 * extension, start on login. Everything that writes outside
 * Lydia's own folder only runs from a button the user pressed in the wizard.
 */

const HOME = os.homedir();
const EXT_UUID = 'lydia-helper@berelels';
const EXT_SRC = unpacked(path.join(__dirname, '..', 'gnome-extension', EXT_UUID));
const EXT_LEGACY = unpacked(path.join(__dirname, '..', 'gnome-extension', 'legacy', EXT_UUID)); // GNOME 42-44
const EXT_DIR = path.join(hostData(), 'gnome-shell', 'extensions', EXT_UUID);
const AUTOSTART = path.join(hostConfig(), 'autostart', 'lydia.desktop');

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

const extVersion = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')).version ?? 0;
  } catch {
    return 0;
  }
};

/** The major GNOME Shell version (46), or 0 if it can't be told. */
async function shellVersion() {
  return Number(/(\d+)\./.exec((await run('gnome-shell', ['--version'])) ?? '')?.[1] ?? 0);
}

/** The extension for this GNOME: the 45+ one, or the same code packaged the old way for 42-44. */
const extSource = async () => {
  const shell = await shellVersion();
  return shell && shell < 45 ? EXT_LEGACY : EXT_SRC;
};

/** missing | old (GNOME before 42) | outdated (a newer one comes with Lydia) | installed (needs enabling) | enabled (works after the next login) | active */
async function extensionStatus(backend) {
  if (!isGnome()) return { gnome: false, state: 'unsupported' };
  const shell = await shellVersion();
  if (shell && shell < 42) return { gnome: true, state: 'old' };
  const installed = extVersion(EXT_DIR);
  if (installed && installed < extVersion(await extSource())) return { gnome: true, state: 'outdated' };
  if (backend === 'gnome') return { gnome: true, state: 'active' };
  if (!installed) return { gnome: true, state: 'missing' };
  return { gnome: true, state: (await enabledExtensions()).includes(EXT_UUID) ? 'enabled' : 'installed' };
}

/** Copies the extension to the user's extensions and adds it to the enabled list (nothing else changes). */
async function installExtension() {
  if (!isGnome()) return { ok: false };
  fs.cpSync(await extSource(), EXT_DIR, { recursive: true });
  const list = await enabledExtensions();
  if (!list.includes(EXT_UUID)) {
    const value = `[${[...list, EXT_UUID].map((s) => `'${s}'`).join(', ')}]`;
    if ((await run('gsettings', ['set', 'org.gnome.shell', 'enabled-extensions', value])) === null) return { ok: false };
  }
  return { ok: true };
}

// ---------- start on login ----------

const autostartOn = () => fs.existsSync(AUTOSTART);

function setAutostart(on, app) {
  if (!on) {
    fs.rmSync(AUTOSTART, { force: true });
    return { ok: true };
  }
  // An AppImage: the file itself (it's mounted somewhere new each time). Packaged: the app. From the source folder: its Electron with this folder.
  const exec = inFlatpak ? `flatpak run ${process.env.FLATPAK_ID}` : process.env.APPIMAGE ? `"${process.env.APPIMAGE}"` : app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`;
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
  autostartOn,
  setAutostart,
};
