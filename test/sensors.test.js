// Sensor detection on machines we don't have: fake /sys/class/hwmon trees.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findSensors } = require('../app/monitor');

const made = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** { hwmon0: { name: 'k10temp', temps: { Tctl: 50 } } } -> a temp dir laid out like sysfs. */
function tree(chips, zones = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lydia-hwmon-'));
  made.push(root);
  const hwmon = path.join(root, 'hwmon');
  const thermal = path.join(root, 'thermal');
  fs.mkdirSync(hwmon);
  fs.mkdirSync(thermal);
  for (const [dir, chip] of Object.entries(chips)) {
    const d = path.join(hwmon, dir);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'name'), chip.name + '\n');
    Object.entries(chip.temps).forEach(([label, c], i) => {
      fs.writeFileSync(path.join(d, `temp${i + 1}_input`), `${c * 1000}\n`);
      if (label) fs.writeFileSync(path.join(d, `temp${i + 1}_label`), label + '\n');
    });
  }
  for (const [z, type] of Object.entries(zones)) {
    fs.mkdirSync(path.join(thermal, z));
    fs.writeFileSync(path.join(thermal, z, 'type'), type + '\n');
    fs.writeFileSync(path.join(thermal, z, 'temp'), '45000\n');
  }
  return { hwmon, thermal, file: (dir, n) => path.join(hwmon, dir, `temp${n}_input`), zone: (z) => path.join(thermal, z, 'temp') };
}

test('AMD desktop: k10temp Tctl and the amdgpu edge', () => {
  const t = tree({ hwmon0: { name: 'nvme', temps: { Composite: 40 } }, hwmon1: { name: 'k10temp', temps: { Tctl: 55 } }, hwmon3: { name: 'amdgpu', temps: { edge: 49, junction: 52, mem: 60 } } });
  assert.deepStrictEqual(findSensors(t.hwmon, { nvidia: false, thermal: t.thermal }), { cpu: t.file('hwmon1', 1), gpu: t.file('hwmon3', 1) });
});

test('AMD with Tdie: Tdie wins over Tctl (Tctl may carry an offset)', () => {
  const t = tree({ hwmon0: { name: 'k10temp', temps: { Tctl: 70, Tdie: 60 } } });
  assert.strictEqual(findSensors(t.hwmon, { nvidia: false, thermal: t.thermal }).cpu, t.file('hwmon0', 2));
});

test('Intel laptop: the coretemp package, Intel xe GPU package', () => {
  const t = tree({ hwmon2: { name: 'coretemp', temps: { 'Core 0': 50, 'Package id 0': 58, 'Core 1': 51 } }, hwmon4: { name: 'xe', temps: { pkg: 47, vram: 50 } } });
  assert.deepStrictEqual(findSensors(t.hwmon, { nvidia: false, thermal: t.thermal }), { cpu: t.file('hwmon2', 2), gpu: t.file('hwmon4', 1) });
});

test('NVIDIA on the closed driver: no GPU hwmon, so nvidia-smi', () => {
  const t = tree({ hwmon1: { name: 'coretemp', temps: { 'Package id 0': 58 } } });
  assert.strictEqual(findSensors(t.hwmon, { nvidia: true, thermal: t.thermal }).gpu, 'nvidia-smi');
});

test('NVIDIA on nouveau: its hwmon', () => {
  const t = tree({ hwmon5: { name: 'nouveau', temps: { '': 44 } } });
  assert.strictEqual(findSensors(t.hwmon, { nvidia: false, thermal: t.thermal }).gpu, t.file('hwmon5', 1));
});

test('APU next to a graphics card: the card (it has junction/mem sensors)', () => {
  const t = tree({ hwmon1: { name: 'amdgpu', temps: { edge: 40 } }, hwmon2: { name: 'amdgpu', temps: { edge: 55, junction: 60, mem: 62 } } });
  assert.strictEqual(findSensors(t.hwmon, { nvidia: false, thermal: t.thermal }).gpu, t.file('hwmon2', 1));
});

test('No CPU hwmon (VM, old laptop): the x86_pkg_temp thermal zone', () => {
  const t = tree({}, { thermal_zone0: 'acpitz', thermal_zone1: 'x86_pkg_temp' });
  assert.deepStrictEqual(findSensors(t.hwmon, { nvidia: false, thermal: t.thermal }), { cpu: t.zone('thermal_zone1'), gpu: null });
});

test('Nothing at all: nulls, no crash', () => {
  assert.deepStrictEqual(findSensors('/nonexistent', { nvidia: false, thermal: '/nonexistent' }), { cpu: null, gpu: null });
});
