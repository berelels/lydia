const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  ram_threshold_percent: 85,
  check_interval_seconds: 5,
  consecutive_checks: 2,
  alert_cooldown_seconds: 300,
  bubble_seconds: 9,
  // Gap in px between the panel and the island (0 = hanging right from it).
  island_y_offset: 0,
  cpu_temp_alert_celsius: 85,
  gpu_temp_alert_celsius: 90,
  // A process at >= this % of one core for this long gets reported.
  stuck_process_percent: 90,
  stuck_process_minutes: 3,
  // Names that may run hot on purpose (games, encoders...). "Ignorar" adds to it.
  stuck_process_ignore: [],
  // Steam game in fullscreen: vanish, and only sneak a look now and then.
  hide_in_games: false,
  // Any other fullscreen (a video...): vanish too, no peeks. Alerts still slide in.
  hide_in_fullscreen: false,
  // Who answers in the chat: "claude" (the claude CLI and its login), "gemini"
  // (a Google AI Studio key, kept encrypted by the system keyring) or "ollama" (local).
  chat_provider: 'claude',
  ollama_model: '', // empty: the first one installed
  // Interface language: "system" (follow the desktop), "pt", "en" or "es".
  language: 'system',
  // The setup wizard opens on the first run until it is finished or skipped.
  setup_done: false,
  // Lydia's colors (#rrggbb). Alerts still use the default stress colors.
  body_color: '#8f63f7',
  eye_color: '#f6f1ff',
};

function configPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'lydia', 'config.json');
}

/** Defaults, overridden by ~/.config/lydia/config.json (created on first run). */
function load() {
  const file = configPath();
  const cfg = { ...DEFAULTS };
  let user;
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n');
      } catch {}
    }
    return cfg;
  }
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const value = user?.[key];
    if (typeof def === 'boolean' && typeof value === 'boolean') cfg[key] = value;
    else if (key === 'chat_provider' && ['claude', 'gemini', 'ollama'].includes(value)) cfg[key] = value;
    else if (key === 'ollama_model' && typeof value === 'string') cfg[key] = value;
    else if (key === 'language' && ['system', 'pt', 'en', 'es'].includes(value)) cfg[key] = value;
    else if (typeof def === 'string' && typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) cfg[key] = value.toLowerCase();
    else if (Array.isArray(def) && Array.isArray(value)) cfg[key] = value.filter((v) => typeof v === 'string');
    else if (typeof def === 'number' && Number.isFinite(value) && (value > 0 || (value === 0 && key === 'island_y_offset'))) cfg[key] = value;
  }
  return cfg;
}

/** Sets one key in the user's file, keeping everything else they wrote. */
function save(key, value) {
  const file = configPath();
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  user[key] = value;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(user, null, 2) + '\n');
}

module.exports = { load, save, configPath, DEFAULTS };
