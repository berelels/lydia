// Music or not: what MPRIS says about each player.
const { test } = require('node:test');
const assert = require('node:assert');
const { isMusic, parsePlayer } = require('../app/media');

test('a YouTube video or live in the browser is not music', () => {
  assert.strictEqual(isMusic({ player: 'brave.instance9941', status: 'Playing', album: '' }), false);
});

test('YouTube Music / Spotify Web in the browser give an album: music', () => {
  assert.strictEqual(isMusic({ player: 'chromium.instance12', status: 'Playing', album: 'Abbey Road' }), true);
});

test('a music app playing is music; paused is not', () => {
  assert.strictEqual(isMusic({ player: 'spotify', status: 'Playing' }), true);
  assert.strictEqual(isMusic({ player: 'spotify', status: 'Paused' }), false);
});

test('a video player: only audio files count', () => {
  assert.strictEqual(isMusic({ player: 'vlc', status: 'Playing', url: 'file:///home/x/filme.mkv', album: 'x' }), false);
  assert.strictEqual(isMusic({ player: 'mpv', status: 'Playing', url: 'file:///home/x/song.flac' }), true);
});

test('parses gdbus GetAll output', () => {
  const out = "({'PlaybackStatus': <'Playing'>, 'Metadata': <{'xesam:album': <'Kind of Blue'>, 'xesam:title': <'So What'>, 'xesam:url': <'file:///m/so what.mp3'>}>, 'Volume': <1.0>},)";
  assert.deepStrictEqual(parsePlayer(out), { status: 'Playing', album: 'Kind of Blue', url: 'file:///m/so what.mp3' });
});
