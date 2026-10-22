const { execFile, spawn } = require('child_process');
const audio = require('../audio');

/**
 * The Controls tab: network, Bluetooth, sound output and input, volumes, brightness,
 * night light, dark mode, do not disturb. Each one is read from (and set
 * through) the system's own tools; whatever this computer doesn't have is
 * simply left out (no Wi-Fi card, a desktop monitor without brightness...).
 */

const run = (cmd, args, timeout = 4000) =>
  new Promise((resolve) => execFile(cmd, args, { timeout, env: { ...process.env, LC_ALL: 'C' } }, (err, out = '') => resolve(err ? null : String(out))));
const gget = async (schema, key) => (await run('gsettings', ['get', schema, key]))?.trim() ?? null;
const gset = (schema, key, value) => run('gsettings', ['set', schema, key, value]);

const COLOR = 'org.gnome.settings-daemon.plugins.color';
const NOTIF = 'org.gnome.desktop.notifications';
const IFACE = 'org.gnome.desktop.interface';

// ---------- night light, do not disturb, dark mode: each desktop keeps them its own way ----------

const DESK = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().split(':');
const on = (d) => DESK.includes(d);
const isTrue = (v) => (v == null ? null : /true/.test(v));
const unquote = (v) => v?.replace(/'/g, '').trim() ?? '';
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Is there a theme by that name (system or the user's)? */
const themeExists = (name) => !!name && [require('../host').hostPath('/usr/share/themes'), path.join(os.homedir(), '.themes'), path.join(os.homedir(), '.local/share/themes')].some((d) => fs.existsSync(path.join(d, name)));
/**
 * The dark or light twin of a theme name, if it is installed: "Yaru-dark" <->
 * "Yaru", "ZorinGrey-Light" <-> "ZorinGrey-Dark", "Mint-Y-Dark-Aqua" <-> "Mint-Y-Aqua".
 */
function twin(name, dark) {
  const tries = dark
    ? [name.replace(/-light$/i, '-dark'), name.replace(/-Light$/, '-Dark'), name.replace(/^(Mint-[XYL])(?!-Dark)/, '$1-Dark'), `${name}-dark`, `${name}-Dark`]
    : [name.replace(/-dark$/i, '-light'), name.replace(/-Dark$/, '-Light'), name.replace(/-dark$/i, ''), name.replace(/-Dark(?=-)/, '')];
  return tries.find((n) => n !== name && themeExists(n)) ?? null;
}

const kread = async (file, group, key) => {
  for (const cmd of ['kreadconfig6', 'kreadconfig5']) if (audio.has(cmd)) return (await run(cmd, ['--file', file, '--group', group, '--key', key]))?.trim() ?? null;
  return null;
};
const kwrite = async (file, group, key, value) => {
  for (const cmd of ['kwriteconfig6', 'kwriteconfig5']) if (audio.has(cmd)) return run(cmd, ['--file', file, '--group', group, '--key', key, value]);
  return null;
};
const xfconf = (channel, prop) => run('xfconf-query', ['-c', channel, '-p', prop]);
const xfset = async (channel, prop, type, value) => (await run('xfconf-query', ['-c', channel, '-p', prop, '-s', value])) ?? run('xfconf-query', ['-c', channel, '-p', prop, '-n', '-t', type, '-s', value]);

/** { get() -> { nightLight, dnd, dark } (null: this desktop doesn't have it), set(what, value) } */
const SWITCHES = on('x-cinnamon')
  ? {
      get: async () => {
        const [night, banners, scheme, theme] = await Promise.all([gget('org.cinnamon.settings-daemon.plugins.color', 'night-light-enabled'), gget('org.cinnamon.desktop.notifications', 'display-notifications'), gget('org.x.apps.portal', 'color-scheme'), gget('org.cinnamon.desktop.interface', 'gtk-theme')]);
        return { nightLight: isTrue(night), dnd: banners == null ? null : !isTrue(banners), dark: scheme ? /prefer-dark/.test(scheme) : theme == null ? null : /dark/i.test(theme) };
      },
      set: async (what, value) => {
        if (what === 'nightLight') await gset('org.cinnamon.settings-daemon.plugins.color', 'night-light-enabled', String(!!value));
        if (what === 'dnd') await gset('org.cinnamon.desktop.notifications', 'display-notifications', String(!value));
        if (what === 'dark') {
          await gset('org.x.apps.portal', 'color-scheme', value ? 'prefer-dark' : 'default'); // Mint 21+
          for (const [schema, key] of [['org.cinnamon.desktop.interface', 'gtk-theme'], ['org.cinnamon.theme', 'name']]) {
            const t = twin(unquote(await gget(schema, key)), value);
            if (t) await gset(schema, key, t);
          }
        }
      },
    }
  : on('mate')
    ? {
        get: async () => {
          const [dnd, theme] = await Promise.all([gget('org.mate.NotificationDaemon', 'do-not-disturb'), gget('org.mate.interface', 'gtk-theme')]);
          return { nightLight: null, dnd: isTrue(dnd), dark: theme == null ? null : /dark/i.test(theme) };
        },
        set: async (what, value) => {
          if (what === 'dnd') await gset('org.mate.NotificationDaemon', 'do-not-disturb', String(!!value));
          if (what === 'dark') {
            const t = twin(unquote(await gget('org.mate.interface', 'gtk-theme')), value);
            if (t) await gset('org.mate.interface', 'gtk-theme', t);
          }
        },
      }
    : on('xfce')
      ? {
          get: async () => {
            const [dnd, theme] = await Promise.all([xfconf('xfce4-notifyd', '/do-not-disturb'), xfconf('xsettings', '/Net/ThemeName')]);
            return { nightLight: null, dnd: dnd == null ? false : isTrue(dnd), dark: theme == null ? null : /dark/i.test(theme) };
          },
          set: async (what, value) => {
            if (what === 'dnd') await xfset('xfce4-notifyd', '/do-not-disturb', 'bool', String(!!value));
            if (what === 'dark') {
              const t = twin((await xfconf('xsettings', '/Net/ThemeName'))?.trim() ?? '', value);
              if (t) await xfset('xsettings', '/Net/ThemeName', 'string', t);
            }
          },
        }
      : on('kde')
        ? {
            get: async () => {
              const [night, scheme] = await Promise.all([kread('kwinrc', 'NightColor', 'Active'), kread('kdeglobals', 'General', 'ColorScheme')]);
              return { nightLight: night == null ? null : night === 'true', dnd: null, dark: scheme == null ? null : /dark/i.test(scheme) };
            },
            set: async (what, value) => {
              if (what === 'nightLight') {
                await kwrite('kwinrc', 'NightColor', 'Active', value ? 'true' : 'false');
                await run('dbus-send', ['--session', '--type=method_call', '--dest=org.kde.KWin', '/KWin', 'org.kde.KWin.reconfigure']);
              }
              if (what === 'dark') await run('plasma-apply-colorscheme', [value ? 'BreezeDark' : 'BreezeLight'], 8000);
            },
          }
        : {
            // GNOME and the desktops built on its settings (Ubuntu, Zorin, Pop, Budgie)
            get: async () => {
              const [night, banners, scheme, theme] = await Promise.all([gget(COLOR, 'night-light-enabled'), gget(NOTIF, 'show-banners'), gget(IFACE, 'color-scheme'), gget(IFACE, 'gtk-theme')]);
              return {
                nightLight: isTrue(night),
                dnd: banners == null ? null : !isTrue(banners),
                dark: scheme == null ? null : /prefer-dark/.test(scheme) || (!/prefer-light/.test(scheme) && /dark/i.test(theme ?? '')),
              };
            },
            set: async (what, value) => {
              if (what === 'nightLight') await gset(COLOR, 'night-light-enabled', value ? 'true' : 'false');
              if (what === 'dnd') await gset(NOTIF, 'show-banners', value ? 'false' : 'true');
              if (what === 'dark') {
                const theme = unquote(await gget(IFACE, 'gtk-theme'));
                await gset(IFACE, 'color-scheme', value ? 'prefer-dark' : 'default');
                if (/-(light|dark)$/i.test(theme)) await gset(IFACE, 'gtk-theme', theme.replace(/-(light|dark)$/i, value ? '-Dark' : '-Light'));
              }
            },
          };

async function network() {
  const out = await run('nmcli', ['-t', '-f', 'TYPE,STATE,CONNECTION', 'device']);
  if (out === null) return null;
  const devs = out.trim().split('\n').map((l) => l.split(':'));
  const wifiDev = devs.find((d) => d[0] === 'wifi');
  const wired = devs.find((d) => d[0] === 'ethernet' && d[1] === 'connected');
  const radio = (await run('nmcli', ['-t', '-f', 'WIFI', 'general']))?.trim() === 'enabled';
  let ssid = '';
  if (wifiDev?.[1] === 'connected') ssid = wifiDev[2];
  return { wifi: wifiDev ? { on: radio, ssid } : null, wired: wired ? wired[2] : null };
}

async function bluetooth() {
  const out = await run('bluetoothctl', ['show']);
  if (!out || !/Controller/.test(out)) return null;
  const on = /Powered:\s*yes/.test(out);
  let connected = [];
  if (on) {
    const devs = (await run('bluetoothctl', ['devices', 'Connected'])) ?? '';
    connected = devs.trim().split('\n').map((l) => l.replace(/^Device\s+\S+\s+/, '')).filter(Boolean);
  }
  return { on, connected };
}

/** Sound outputs with friendly names, and which one is in use. */
async function sound() {
  const out = await run('pactl', ['list', 'sinks']);
  const def = (await run('pactl', ['get-default-sink']))?.trim();
  if (!out) return null;
  const sinks = out
    .split(/^Sink #/m)
    .slice(1)
    .map((b) => ({ name: /Name:\s*(\S+)/.exec(b)?.[1], label: /Description:\s*(.+)/.exec(b)?.[1]?.trim() }))
    .filter((s) => s.name && !/snd_aloop|Loopback/i.test(s.name + s.label)); // the loopback device is not a speaker
  const l = await audio.level('sink');
  return { sinks, current: def, volume: l?.volume ?? null, muted: !!l?.muted };
}

/** Microphones (not the "monitor" of each output), which one is in use, its level. */
async function mic() {
  const out = await run('pactl', ['list', 'sources']);
  const def = (await run('pactl', ['get-default-source']))?.trim();
  if (!out) return null;
  const sources = out
    .split(/^Source #/m)
    .slice(1)
    .map((b) => ({ name: /Name:\s*(\S+)/.exec(b)?.[1], label: /Description:\s*(.+)/.exec(b)?.[1]?.trim() }))
    .filter((s) => s.name && !s.name.endsWith('.monitor') && !/snd_aloop|Loopback/i.test(s.name + s.label));
  if (!sources.length) return null;
  const l = await audio.level('source');
  return { sources, current: def, volume: l?.volume ?? null, muted: !!l?.muted };
}

async function brightness() {
  const out = await run('gdbus', ['call', '--session', '--dest', 'org.gnome.SettingsDaemon.Power', '--object-path', '/org/gnome/SettingsDaemon/Power', '--method', 'org.freedesktop.DBus.Properties.Get', 'org.gnome.SettingsDaemon.Power.Screen', 'Brightness']);
  const n = Number(/<(-?\d+)>/.exec(out ?? '')?.[1]);
  return Number.isFinite(n) && n >= 0 ? n : null; // -1: no adjustable screen (a desktop monitor)
}

async function state() {
  const [net, bt, snd, input, bright, sw] = await Promise.all([network(), bluetooth(), sound(), mic(), brightness(), SWITCHES.get()]);
  return { network: net, bluetooth: bt, sound: snd, mic: input, brightness: bright, ...sw };
}

/** One change from the tab: { what, value }. Returns the new state. */
async function set({ what, value }) {
  switch (what) {
    case 'wifi':
      await run('nmcli', ['radio', 'wifi', value ? 'on' : 'off']);
      break;
    case 'bluetooth':
      await run('bluetoothctl', ['power', value ? 'on' : 'off']);
      break;
    case 'sink':
      if (typeof value === 'string' && /^[\w.:-]+$/.test(value)) await run('pactl', ['set-default-sink', value]);
      break;
    case 'volume':
      await audio.setLevel('sink', value);
      break;
    case 'mute':
      await audio.setMute('sink', !!value);
      break;
    case 'source':
      if (typeof value === 'string' && /^[\w.:-]+$/.test(value)) await run('pactl', ['set-default-source', value]);
      break;
    case 'micVolume':
      await audio.setLevel('source', value);
      break;
    case 'micMute':
      await audio.setMute('source', !!value);
      break;
    case 'brightness':
      await run('gdbus', ['call', '--session', '--dest', 'org.gnome.SettingsDaemon.Power', '--object-path', '/org/gnome/SettingsDaemon/Power', '--method', 'org.freedesktop.DBus.Properties.Set', 'org.gnome.SettingsDaemon.Power.Screen', 'Brightness', `<int32 ${Math.max(1, Math.min(100, Math.round(Number(value))))}>`]);
      break;
    case 'nightLight':
    case 'dnd':
    case 'dark':
      await SWITCHES.set(what, !!value);
      break;
    default:
      break;
  }
  return state();
}

// ---------- Wi-Fi networks and Bluetooth devices: list, connect, disconnect ----------

/** nmcli -t separates fields with ':' and escapes ':' inside them as '\:'. */
const fields = (line) => line.split(/(?<!\\):/).map((f) => f.replace(/\\:/g, ':'));

/** Networks nearby, the one in use first, then the strongest: [{ ssid, signal, secure, inUse, known }] */
async function wifiList(rescan = false) {
  const [out, saved] = await Promise.all([
    run('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', rescan ? 'yes' : 'auto'], 15_000),
    run('nmcli', ['-t', '-f', 'NAME,TYPE', 'connection', 'show']),
  ]);
  if (out === null) return null;
  const known = new Set((saved ?? '').trim().split('\n').map(fields).filter((f) => /wireless/.test(f[1] ?? '')).map((f) => f[0]));
  return parseWifi(out, known);
}
function parseWifi(out, known = new Set()) {
  const best = new Map();
  for (const line of out.trim().split('\n')) {
    const [use, ssid, signal, security] = fields(line);
    if (!ssid) continue; // hidden networks
    const net = { ssid, signal: Number(signal) || 0, secure: !!security && security !== '--', inUse: use === '*', known: known.has(ssid) };
    const prev = best.get(ssid);
    if (!prev || net.inUse || (!prev.inUse && net.signal > prev.signal)) best.set(ssid, net);
  }
  return [...best.values()].sort((a, b) => b.inUse - a.inUse || b.known - a.known || b.signal - a.signal);
}

/** Connect: a saved network as it is; a new one with its password (given on stdin, not in the command line). */
function wifiConnect(ssid, password = '') {
  return new Promise((resolve) => {
    const args = password ? ['--ask', 'device', 'wifi', 'connect', ssid] : ['connection', 'up', 'id', ssid];
    const p = spawn('nmcli', args, { env: { ...process.env, LC_ALL: 'C' } });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.stdout.on('data', (d) => (err += d));
    p.on('error', () => resolve({ ok: false }));
    p.on('exit', (code) => resolve({ ok: code === 0, wrongPassword: /secrets were required|password|802-1x/i.test(err), error: code ? err.trim().split('\n').pop() : '' }));
    if (password) p.stdin.write(`${password}\n`);
    p.stdin.end();
    setTimeout(() => p.kill(), 45_000);
  });
}
async function wifiConnectNew(ssid, password) {
  // never seen: nmcli makes the connection; seen before: bring it up
  const known = (await run('nmcli', ['-t', '-f', 'NAME', 'connection', 'show'])) ?? '';
  if (!password && known.split('\n').includes(ssid)) return wifiConnect(ssid);
  if (!password) {
    const r = await run('nmcli', ['device', 'wifi', 'connect', ssid], 45_000); // open network
    return { ok: r !== null };
  }
  return wifiConnect(ssid, password);
}
const wifiDisconnect = async (ssid) => ({ ok: (await run('nmcli', ['connection', 'down', 'id', ssid], 15_000)) !== null });

/** Devices the system knows (and, after a scan, the ones around): [{ mac, name, paired, connected, icon }] */
async function btList(scan = false) {
  if (scan) await run('bluetoothctl', ['--timeout', '6', 'scan', 'on'], 10_000);
  const [all, paired, connected] = await Promise.all(['', 'Paired', 'Connected'].map((k) => run('bluetoothctl', k ? ['devices', k] : ['devices'])));
  if (all === null) return null;
  const macs = (out) => new Set([...(out ?? '').matchAll(/^Device (\S+)/gm)].map((m) => m[1]));
  const isPaired = macs(paired);
  const isConnected = macs(connected);
  const list = [...all.matchAll(/^Device (\S+) (.+)$/gm)]
    .map(([, mac, name]) => ({ mac, name: name.trim(), paired: isPaired.has(mac), connected: isConnected.has(mac) }))
    .filter((d) => d.paired || d.name.replace(/-/g, ':') !== d.mac) // unnamed ones around are just addresses
    .slice(0, 30);
  await Promise.all(
    list.map(async (d) => {
      d.icon = /Icon: (\S+)/.exec((await run('bluetoothctl', ['info', d.mac])) ?? '')?.[1] ?? '';
    }),
  );
  return list.sort((a, b) => b.connected - a.connected || b.paired - a.paired || a.name.localeCompare(b.name));
}
const MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;
async function btConnect(mac) {
  if (!MAC.test(mac)) return { ok: false };
  const info = (await run('bluetoothctl', ['info', mac])) ?? '';
  if (!/Paired: yes/.test(info)) {
    // a new one: pair, trust (so it reconnects by itself), then connect
    if ((await run('bluetoothctl', ['--timeout', '20', 'pair', mac], 25_000)) === null) return { ok: false };
    await run('bluetoothctl', ['trust', mac]);
  }
  const out = await run('bluetoothctl', ['--timeout', '15', 'connect', mac], 20_000);
  return { ok: /Connection successful|already connected/i.test(out ?? '') };
}
async function btDisconnect(mac) {
  if (!MAC.test(mac)) return { ok: false };
  return { ok: (await run('bluetoothctl', ['disconnect', mac], 10_000)) !== null };
}

const setSwitch = (what, value) => SWITCHES.set(what, !!value);

module.exports = { setSwitch, state, set, wifiList, wifiConnectNew, wifiDisconnect, btList, btConnect, btDisconnect, parseWifi };
