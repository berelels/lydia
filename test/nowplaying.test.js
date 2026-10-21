const test = require('node:test');
const assert = require('node:assert');
const { streamOf } = require('../app/workstation/nowplaying');

const list = [
  { index: 41, name: 'Brave', binary: 'brave', pid: 9001, volume: 80 },
  { index: 52, name: 'spotify', binary: 'spotify', pid: 3333, volume: 55 },
];

test("a player's audio stream: same process first, else the app's name", () => {
  assert.equal(streamOf(list, { player: 'org.mpris.MediaPlayer2.spotify', app: 'spotify', identity: 'Spotify' }).index, 52);
  assert.equal(streamOf(list, { player: 'org.mpris.MediaPlayer2.brave.instance9001', app: 'brave', identity: 'Brave' }).index, 41);
  assert.equal(streamOf([{ ...list[0], pid: 1 }], { player: 'org.mpris.MediaPlayer2.brave.instance777', app: 'brave', identity: 'Brave' }).index, 41);
  assert.equal(streamOf(list, { player: 'org.mpris.MediaPlayer2.vlc', app: 'vlc', identity: 'VLC media player' }), null);
});
