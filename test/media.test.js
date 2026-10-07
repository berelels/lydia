// Who is playing or recording sound, read from `pactl list sink-inputs / source-outputs` (C locale).
const { test } = require('node:test');
const assert = require('node:assert');
const { parseStreams } = require('../app/monitor');

const sample = `Sink Input #126
	Driver: protocol-native.c
	Corked: no
	Properties:
		application.name = "Brave"
		application.process.id = "12458"
		application.process.binary = "brave"
Sink Input #130
	Corked: yes
	Properties:
		application.process.id = "4242"
		application.process.binary = "spotify"
Source Output #7
	Properties:
		application.process.id = "88"
		application.process.binary = "gpu-screen-recorder"
`;

test('each stream with its program, pid and paused state', () => {
  assert.deepStrictEqual(parseStreams(sample), [
    { pid: 12458, binary: 'brave', corked: false },
    { pid: 4242, binary: 'spotify', corked: true },
    { pid: 88, binary: 'gpu-screen-recorder', corked: false },
  ]);
});

test('no sound server or no streams: nothing', () => {
  assert.deepStrictEqual(parseStreams(''), []);
});
