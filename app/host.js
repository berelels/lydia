const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Inside the Flatpak, Lydia still works on the computer itself: the system's
 * tools (nmcli, pactl, gsettings, gdbus...) run on the host through
 * flatpak-spawn, and the host's files are read where the sandbox shows them
 * (/run/host/usr...). Outside a Flatpak nothing here changes anything.
 *
 * Required first by main.js: the modules take execFile/spawn from
 * child_process when they load, so those must already be the wrapped ones.
 */

const inFlatpak = !!process.env.FLATPAK_ID;

/** Where the host sees this Flatpak's /app (to hand it our Python scripts). */
const appPath = (() => {
  if (!inFlatpak) return '';
  try {
    return /^app-path=(.+)$/m.exec(fs.readFileSync('/.flatpak-info', 'utf8'))?.[1].trim() ?? '';
  } catch {
    return '';
  }
})();

/** A host file as the sandbox sees it: /usr/share/... -> /run/host/usr/share/... */
const hostPath = (p) => (inFlatpak && /^\/(usr|etc)\//.test(p) ? `/run/host${p}` : p);

/** The user's real data and config folders (in the Flatpak, XDG_* point inside ~/.var/app). */
const hostData = () => (inFlatpak ? path.join(os.homedir(), '.local', 'share') : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
const hostConfig = () => (inFlatpak ? path.join(os.homedir(), '.config') : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));

if (inFlatpak) {
  const toHost = (a) => (typeof a === 'string' && a.startsWith('/app/') && appPath ? appPath + a.slice(4) : a);
  const local = (cmd) => cmd === process.execPath || cmd === 'flatpak-spawn';
  /** (cmd, args, opts) -> the same, run on the host */
  const wrap = (cmd, args = [], opts = {}) => {
    if (local(cmd)) return [cmd, args, opts];
    const env = opts.env ? Object.entries(opts.env).filter(([k, v]) => v !== undefined && process.env[k] !== v).map(([k, v]) => `--env=${k}=${v}`) : [];
    const dir = opts.cwd ? [`--directory=${opts.cwd}`] : [];
    // --watch-bus: whatever she started on the host ends when she does
    return ['flatpak-spawn', ['--host', '--watch-bus', ...env, ...dir, toHost(cmd), ...args.map(toHost)], opts];
  };
  /** execFile/spawn accept (cmd, [args], [opts], [cb]) */
  const parse = (cmd, rest) => {
    const args = Array.isArray(rest[0]) ? rest.shift() : [];
    const opts = rest[0] && typeof rest[0] === 'object' ? rest.shift() : {};
    return [cmd, args, opts, rest];
  };
  const { execFile, execFileSync, spawn, spawnSync } = cp;
  cp.execFile = (cmd, ...rest) => {
    const [c, a, o, tail] = parse(cmd, rest);
    return execFile(...wrap(c, a, o), ...tail);
  };
  cp.execFileSync = (cmd, ...rest) => {
    const [c, a, o] = parse(cmd, rest);
    return execFileSync(...wrap(c, a, o));
  };
  cp.spawn = (cmd, ...rest) => {
    const [c, a, o] = parse(cmd, rest);
    return spawn(...wrap(c, a, o));
  };
  cp.spawnSync = (cmd, ...rest) => {
    const [c, a, o] = parse(cmd, rest);
    return spawnSync(...wrap(c, a, o));
  };
}

module.exports = { inFlatpak, hostPath, hostData, hostConfig };
