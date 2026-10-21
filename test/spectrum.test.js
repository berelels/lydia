const test = require('node:test');
const assert = require('node:assert');
const { bands, RATE, SIZE } = require('../app/workstation/spectrum');

const tone = (hz) => Float64Array.from({ length: SIZE }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / RATE));
const loudest = (b) => b.indexOf(Math.max(...b));

test('a low tone lights the bass bands, a high one the treble', () => {
  const low = bands(tone(80), 32);
  const high = bands(tone(3000), 32);
  assert.ok(loudest(low) < 8, `80 Hz -> band ${loudest(low)}`);
  assert.ok(loudest(high) > 24, `3 kHz -> band ${loudest(high)}`);
});

test('silence is far below a tone', () => {
  const quiet = Math.max(...bands(new Float64Array(SIZE), 32));
  const loud = Math.max(...bands(tone(440), 32));
  assert.ok(loud - quiet > 60);
});
