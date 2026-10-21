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

const { parseWifi } = require('../app/workstation/controls');
const { kindOf } = require('../app/workstation/weather');

test('Wi-Fi list: escaped colons, one entry per name (the strongest), the one in use first', () => {
  const nets = parseWifi('*:Casa\\:5G:72:WPA2\n:Vizinho:40:WPA1 WPA2\n:Vizinho:65:WPA2\n::30:WPA2\n:Cafe:55:--', new Set(['Cafe']));
  assert.deepEqual(nets.map((n) => [n.ssid, n.signal, n.secure, n.inUse, n.known]), [
    ['Casa:5G', 72, true, true, false],
    ['Cafe', 55, false, false, true],
    ['Vizinho', 65, true, false, false],
  ]);
});

test('weather codes to pictures', () => {
  assert.equal(kindOf(0, true), 'sun');
  assert.equal(kindOf(1, false), 'moon');
  assert.equal(kindOf(3, true), 'cloud');
  assert.equal(kindOf(45, true), 'fog');
  assert.equal(kindOf(65, true), 'rain');
  assert.equal(kindOf(81, false), 'rain');
  assert.equal(kindOf(73, true), 'snow');
  assert.equal(kindOf(95, true), 'storm');
});
