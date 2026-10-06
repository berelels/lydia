const fs = require('fs');
const path = require('path');

const GB = 1024 ** 3;

function readMeminfo() {
  const kb = {};
  for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kb[m[1]] = Number(m[2]) * 1024;
  }
  return kb;
}

/** Same numbers as psutil.virtual_memory(): used = total - available. */
function memory() {
  const kb = readMeminfo();
  const total = kb.MemTotal;
  const used = total - kb.MemAvailable;
  return { percent: (used / total) * 100, usedGB: used / GB, totalGB: total / GB };
}

/** Process name like psutil: comm, or the exe name when comm got cut at 15 chars. */
function processName(pid, comm) {
  if (comm.length < 15) return comm;
  try {
    return path.basename(fs.readlinkSync(`/proc/${pid}/exe`));
  } catch {
    return comm;
  }
}

/** Biggest users by name (all of Firefox's processes count as one). */
function topConsumers(n = 3) {
  const totals = new Map();
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let status;
    try {
      status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    } catch {
      continue;
    }
    const rss = /VmRSS:\s+(\d+)/.exec(status);
    if (!rss) continue; // kernel threads
    const name = processName(pid, /^Name:\s+(.*)$/m.exec(status)?.[1] ?? '?');
    totals.set(name, (totals.get(name) ?? 0) + Number(rss[1]) * 1024);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, bytes]) => ({ name, gb: bytes / GB }));
}

let lastCpu = null;
/** CPU use since the previous call, in percent. */
function cpu() {
  const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = f[3] + f[4];
  const total = f.reduce((a, b) => a + b, 0);
  const prev = lastCpu;
  lastCpu = { idle, total };
  if (!prev || total === prev.total) return 0;
  return (1 - (idle - prev.idle) / (total - prev.total)) * 100;
}

/** Like df: used / (used + available to users). */
function disk(mount = '/') {
  const s = fs.statfsSync(mount);
  const used = (s.blocks - s.bfree) * s.bsize;
  const avail = s.bavail * s.bsize;
  return { percent: (used / (used + avail)) * 100, freeGB: avail / GB };
}

// ---------- temperatures ----------

const HWMON = '/sys/class/hwmon';
const read = (f) => fs.readFileSync(f, 'utf8').trim();

/** Labelled inputs of one hwmon dir: [{ label, file }] in temp1, temp2... order. */
function tempInputs(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .map((f) => /^temp(\d+)_input$/.exec(f))
    .filter(Boolean)
    .sort((a, b) => a[1] - b[1])
    .map((m) => {
      let label = '';
      try {
        label = read(`${dir}/temp${m[1]}_label`);
      } catch {}
      return { label, file: `${dir}/${m[0]}` };
    });
}

/** The first input whose label is in `labels` (in that order of preference), else the first one. */
function pick(inputs, labels = []) {
  for (const want of labels) {
    const hit = inputs.find((i) => i.label.toLowerCase() === want.toLowerCase() || (want.endsWith('*') && i.label.toLowerCase().startsWith(want.slice(0, -1).toLowerCase())));
    if (hit) return hit.file;
  }
  return inputs[0]?.file ?? null;
}

// Which hwmon drivers are CPUs and GPUs, best first, and which label to read on each.
// AMD: Tdie is the real die temperature (Tctl may carry an offset); Intel: the package.
const CPU_DRIVERS = { k10temp: ['Tdie', 'Tctl'], zenpower: ['Tdie', 'Tctl'], coretemp: ['Package id 0', 'Core *'], cpu_thermal: [], soc_thermal: [] };
// GPU "edge" is the die's average (junction is its hottest spot); Intel xe/i915: the package.
const GPU_DRIVERS = { amdgpu: ['edge'], nouveau: [], radeon: [], xe: ['pkg'], i915: ['pkg'] };

/**
 * Finds the CPU and GPU temperature inputs under a sysfs hwmon dir (a parameter
 * so tests can point it at a fake tree). The GPU may instead be an NVIDIA card
 * on the closed driver, which has no hwmon: then gpu is "nvidia-smi".
 */
function findSensors(root = HWMON, { nvidia = fs.existsSync('/proc/driver/nvidia/gpus'), thermal = '/sys/class/thermal' } = {}) {
  const found = { cpu: null, gpu: null };
  let dirs = [];
  try {
    dirs = fs.readdirSync(root).map((h) => path.join(root, h));
  } catch {}
  const chips = dirs
    .map((dir) => {
      let name = '';
      try {
        name = read(`${dir}/name`);
      } catch {}
      return { dir, name, inputs: tempInputs(dir) };
    })
    .filter((c) => c.inputs.length);
  const rank = (table) => (c) => Object.keys(table).indexOf(c.name);
  const best = (table, prefer = () => 0) =>
    chips
      .filter((c) => c.name in table)
      .sort((a, b) => rank(table)(a) - rank(table)(b) || prefer(b) - prefer(a))[0];
  const cpu = best(CPU_DRIVERS);
  if (cpu) found.cpu = pick(cpu.inputs, CPU_DRIVERS[cpu.name]);
  // An APU next to a graphics card: the card is the one with a junction or VRAM sensor.
  const gpu = best(GPU_DRIVERS, (c) => (c.inputs.some((i) => /junction|mem|vram/i.test(i.label)) ? 1 : 0));
  if (gpu) found.gpu = pick(gpu.inputs, GPU_DRIVERS[gpu.name]);
  else if (nvidia) found.gpu = 'nvidia-smi';
  // No CPU hwmon (some VMs, older laptops): the thermal zone the kernel calls the package.
  if (!found.cpu) found.cpu = thermalZone(['x86_pkg_temp', 'cpu-thermal', 'acpitz'], thermal);
  return found;
}

function thermalZone(types, root) {
  let zones = [];
  try {
    zones = fs.readdirSync(root).filter((z) => z.startsWith('thermal_zone'));
  } catch {
    return null;
  }
  for (const type of types) {
    for (const z of zones) {
      try {
        if (read(`${root}/${z}/type`) === type) return `${root}/${z}/temp`;
      } catch {}
    }
  }
  return null;
}

function readTemp(file) {
  if (!file) return null;
  try {
    const c = Number(read(file)) / 1000;
    return Number.isFinite(c) && c > 0 && c < 150 ? c : null; // 0 or absurd: a sensor that isn't really there
  } catch {
    return null;
  }
}

// The closed NVIDIA driver only answers through nvidia-smi: asked in the background
// at most every 5 s, never blocking a reading.
let nvidiaTemp = null;
let nvidiaAsked = 0;
function nvidiaReading() {
  const now = Date.now();
  if (now - nvidiaAsked > 5000) {
    nvidiaAsked = now;
    require('child_process').execFile('nvidia-smi', ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'], { timeout: 3000 }, (err, out) => {
      const c = Number(String(out).split('\n')[0]);
      nvidiaTemp = !err && Number.isFinite(c) && c > 0 ? c : null;
    });
  }
  return nvidiaTemp;
}

let sensors;
/** -> { cpu: °C | null, gpu: °C | null } */
function temperatures() {
  sensors ??= findSensors();
  return { cpu: readTemp(sensors.cpu), gpu: sensors.gpu === 'nvidia-smi' ? nvidiaReading() : readTemp(sensors.gpu) };
}

const fmt = (x) => x.toFixed(1).replace('.', ',');

/**
 * Says when a reading stays above a limit: after `needed` readings in a row,
 * then again only after the cooldown, or sooner if it gets 5 points worse.
 * "recovered" once it drops 5 points below the limit.
 */
class ThresholdWatch {
  constructor({ threshold, needed, cooldownSeconds, read }) {
    this.threshold = threshold;
    this.needed = needed;
    this.cooldown = cooldownSeconds * 1000;
    this.read = read;
    this.streak = 0;
    this.alerted = false;
    this.lastAlertAt = -Infinity;
    this.lastAlertValue = 0;
  }

  /** -> { value, over, event: null | 'alert' | 'recovered' } */
  poll() {
    const value = this.read();
    if (value == null) return { value, over: false, event: null };
    const over = value >= this.threshold;
    const now = performance.now();
    let event = null;

    this.streak = over ? this.streak + 1 : 0;
    if (over && this.streak >= this.needed) {
      const first = !this.alerted && now - this.lastAlertAt >= this.cooldown;
      const worse = this.alerted && value >= this.lastAlertValue + 5 && now - this.lastAlertAt >= 60_000;
      if (first || worse) {
        event = 'alert';
        this.alerted = true;
        this.lastAlertAt = now;
        this.lastAlertValue = value;
      }
    } else if (this.alerted && value < this.threshold - 5) {
      event = 'recovered';
      this.alerted = false;
    }
    return { value, over, event };
  }
}

const RamMonitor = (cfg) =>
  new ThresholdWatch({
    threshold: cfg.ram_threshold_percent,
    needed: cfg.consecutive_checks,
    cooldownSeconds: cfg.alert_cooldown_seconds,
    read: () => memory().percent,
  });

/** The systemd unit that owns a process, so stopping it doesn't just get it restarted. */
function unitOf(pid) {
  let cg;
  try {
    cg = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
  } catch {
    return null;
  }
  const user = /\/user@\d+\.service\/(?:.*\/)?([^/\s]+\.service)\s*$/m.exec(cg);
  if (user) return { scope: 'user', name: user[1] };
  const system = /^0::\/system\.slice\/(?:.*\/)?([^/\s]+\.service)\s*$/m.exec(cg);
  if (system) return { scope: 'system', name: system[1] };
  return null;
}

const TICK = 100; // USER_HZ on Linux (getconf CLK_TCK)
const PAGE = 4096; // getconf PAGESIZE

/**
 * Finds processes stuck at ~100% of a core: the kind of thing that heats the
 * CPU for hours without anyone noticing (a frozen tray icon, a looping app).
 */
class HogWatch {
  constructor({ percent, minutes, ignore }) {
    this.percent = percent;
    this.minutes = minutes;
    this.ignore = new Set(ignore);
    this.procs = new Map(); // pid -> { ticks, at, name, since, alerted, percent }
    this.latest = []; // last poll's per-process CPU use, biggest first
  }

  poll() {
    const now = performance.now();
    const seen = new Set();
    const events = [];
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let stat;
      try {
        stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      } catch {
        continue;
      }
      const close = stat.lastIndexOf(')');
      const f = stat.slice(close + 2).split(' ');
      const ticks = Number(f[11]) + Number(f[12]); // utime + stime
      const rss = Number(f[21]) * PAGE; // resident memory
      seen.add(pid);
      let p = this.procs.get(pid);
      if (!p) {
        p = { ticks, at: now, rss, name: processName(pid, stat.slice(stat.indexOf('(') + 1, close)), since: 0, alerted: false, percent: 0 };
        this.procs.set(pid, p);
        continue;
      }
      p.rss = rss;
      const secs = (now - p.at) / 1000;
      p.percent = secs > 0 ? ((ticks - p.ticks) / TICK / secs) * 100 : 0;
      p.ticks = ticks;
      p.at = now;
      if (p.percent >= this.percent) {
        if (!p.since) p.since = now;
      } else if (p.percent < this.percent - 20) {
        p.since = 0; // a short dip doesn't reset it; really calming down does
        p.alerted = false;
      }
      if (p.since && !p.alerted && !this.ignore.has(p.name) && now - p.since >= this.minutes * 60_000) {
        p.alerted = true;
        events.push(this.describe(pid, p, now));
      }
    }
    for (const pid of this.procs.keys()) if (!seen.has(pid)) this.procs.delete(pid);
    this.latest = [...this.procs.entries()]
      .filter(([, p]) => p.percent > 0.5)
      .sort((a, b) => b[1].percent - a[1].percent)
      .slice(0, 5)
      .map(([pid, p]) => ({ pid: Number(pid), name: p.name, percent: p.percent }));
    return events;
  }

  describe(pid, p, now = performance.now()) {
    return { pid: Number(pid), name: p.name, percent: p.percent, minutes: Math.floor((now - p.since) / 60_000), unit: unitOf(pid) };
  }

  /** For the task manager: apps by name (all of Brave's processes together), biggest first. */
  tasks(by = 'cpu', n = 8, own = new Set()) {
    const groups = new Map();
    for (const [pid, p] of this.procs) {
      if (!p.rss) continue; // kernel threads
      const self = own.has(Number(pid)); // Lydia's own processes: listed as herself
      const name = self ? 'Lydia' : p.name;
      const g = groups.get(name) ?? { name, cpu: 0, gb: 0, pids: [], self };
      g.cpu += p.percent;
      g.gb += p.rss / GB;
      g.pids.push(Number(pid));
      groups.set(name, g);
    }
    const key = by === 'ram' ? (g) => g.gb : (g) => g.cpu + g.gb / 1000;
    return [...groups.values()].sort((a, b) => key(b) - key(a)).slice(0, n);
  }

  /** Hogs still going, after they were reported. */
  active() {
    const now = performance.now();
    return [...this.procs.entries()]
      .filter(([, p]) => p.alerted && p.since && !this.ignore.has(p.name))
      .map(([pid, p]) => this.describe(pid, p, now));
  }
}

module.exports = { findSensors, memory, topConsumers, cpu, disk, temperatures, ThresholdWatch, RamMonitor, HogWatch, unitOf, fmt };
