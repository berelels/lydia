const { execFile } = require('child_process');

/**
 * The Controls tab: network, Bluetooth, sound output, volume, brightness,
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
  const vol = await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']);
  const m = /Volume:\s+([\d.]+)/.exec(vol ?? '');
  return { sinks, current: def, volume: m ? Math.round(Number(m[1]) * 100) : null, muted: /MUTED/.test(vol ?? '') };
}

async function brightness() {
  const out = await run('gdbus', ['call', '--session', '--dest', 'org.gnome.SettingsDaemon.Power', '--object-path', '/org/gnome/SettingsDaemon/Power', '--method', 'org.freedesktop.DBus.Properties.Get', 'org.gnome.SettingsDaemon.Power.Screen', 'Brightness']);
  const n = Number(/<(-?\d+)>/.exec(out ?? '')?.[1]);
  return Number.isFinite(n) && n >= 0 ? n : null; // -1: no adjustable screen (a desktop monitor)
}

async function state() {
  const [net, bt, snd, bright, night, banners, scheme, theme] = await Promise.all([
    network(),
    bluetooth(),
    sound(),
    brightness(),
    gget(COLOR, 'night-light-enabled'),
    gget(NOTIF, 'show-banners'),
    gget(IFACE, 'color-scheme'),
    gget(IFACE, 'gtk-theme'),
  ]);
  return {
    network: net,
    bluetooth: bt,
    sound: snd,
    brightness: bright,
    nightLight: night === null ? null : night === 'true',
    dnd: banners === null ? null : banners === 'false',
    dark: scheme === null ? null : /prefer-dark/.test(scheme) || (!/prefer-light/.test(scheme) && /dark/i.test(theme ?? '')),
  };
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
      await run('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', `${Math.max(0, Math.min(100, Math.round(Number(value))))}%`]);
      break;
    case 'mute':
      await run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', value ? '1' : '0']);
      break;
    case 'brightness':
      await run('gdbus', ['call', '--session', '--dest', 'org.gnome.SettingsDaemon.Power', '--object-path', '/org/gnome/SettingsDaemon/Power', '--method', 'org.freedesktop.DBus.Properties.Set', 'org.gnome.SettingsDaemon.Power.Screen', 'Brightness', `<int32 ${Math.max(1, Math.min(100, Math.round(Number(value))))}>`]);
      break;
    case 'nightLight':
      await gset(COLOR, 'night-light-enabled', value ? 'true' : 'false');
      break;
    case 'dnd':
      await gset(NOTIF, 'show-banners', value ? 'false' : 'true');
      break;
    case 'dark': {
      const theme = (await gget(IFACE, 'gtk-theme'))?.replace(/'/g, '') ?? '';
      await gset(IFACE, 'color-scheme', value ? 'prefer-dark' : 'default');
      if (/-(light|dark)$/i.test(theme)) await gset(IFACE, 'gtk-theme', theme.replace(/-(light|dark)$/i, value ? '-Dark' : '-Light'));
      break;
    }
    default:
      break;
  }
  return state();
}

module.exports = { state, set };
