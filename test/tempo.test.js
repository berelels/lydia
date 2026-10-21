const test = require('node:test');
const assert = require('node:assert');
const { estimateBpm, FPS } = require('../app/workstation/tempo');

/** An onset curve with a hit every beat (and a little noise), `seconds` long. */
function beats(bpm, seconds = 8) {
  const n = Math.round(seconds * FPS);
  const period = (60 / bpm) * FPS;
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 0.15;
  return Array.from({ length: n }, (_, i) => (i % period < 1 ? 1 : 0) + noise());
}

test('the tempo of a steady beat', () => {
  for (const bpm of [72, 96, 120, 140, 170]) {
    const got = estimateBpm(beats(bpm));
    assert.ok(Math.abs(got - bpm) <= 3, `${bpm} -> ${got}`);
  }
});

test('no pulse, no tempo', () => {
  assert.equal(estimateBpm(new Array(Math.round(8 * FPS)).fill(0)), null);
  assert.equal(estimateBpm([1, 0, 1]), null); // too short to tell
});
