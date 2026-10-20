// Everyday voice commands, understood without the language model.
const { test } = require('node:test');
const assert = require('node:assert');
const { parse } = require('../app/assistant/intents');

const cases = [
  ['Lydia, volume 30', 'set_volume', { level: 30 }],
  ['coloca o volume em trinta por cento', 'set_volume', { level: 30 }],
  ['volume no máximo', 'set_volume', { level: 100 }],
  ['aumenta o volume', 'change_volume', { delta: 10 }],
  ['abaixa o som, por favor', 'change_volume', { delta: -10 }],
  ['set the volume to 45%', 'set_volume', { level: 45 }],
  ['sube el volumen', 'change_volume', { delta: 10 }],
  ['muta', 'mute', { on: true }],
  ['volta o som', 'mute', { on: false }],
  ['pausa a música', 'media', { action: 'pause' }],
  ['próxima música', 'media', { action: 'next' }],
  ['toca', 'media', { action: 'play' }],
  ['abre o YouTube', 'open', { target: 'youtube', web: false }],
  ['abre o gmail no navegador', 'open', { target: 'gmail', web: true }],
  ['Open Spotify', 'open', { target: 'spotify', web: false }],
  ['abre a calculadora', 'open', { target: 'calculadora', web: false }],
  ['toca lo-fi no youtube', 'youtube_search', { query: 'lo-fi' }],
  ['pesquisa receita de bolo de cenoura', 'web_search', { query: 'receita de bolo de cenoura' }],
  ['search for weather tomorrow', 'web_search', { query: 'weather tomorrow' }],
  ['fecha o brave', 'close_app', { name: 'brave' }],
  ['que horas são?', 'time_now', {}],
  ['me avisa em 5 minutos', 'timer', { seconds: 300 }],
  ['timer de 30 segundos', 'timer', { seconds: 30 }],
  ['bloqueia a tela', 'lock_screen', {}],
  ['modo escuro', 'set_theme', { dark: true }],
  ['como está o pc?', 'system_status', {}],
  ['abre o spotify pra mim', 'open', { target: 'spotify', web: false }],
  ['toca uma música do AC/DC no spotify', 'play_music', { query: 'ac/dc', app: 'spotify' }],
  ['toca Back in Black', 'play_music', { query: 'back in black', app: '' }],
  ['coloca lo-fi pra tocar', 'play_music', { query: 'lo-fi', app: '' }],
  ['quero ouvir Legião Urbana', 'play_music', { query: 'legiao urbana', app: '' }],
];

for (const [text, tool, args] of cases) {
  test(`"${text}" -> ${tool}`, () => {
    assert.deepStrictEqual(parse(text), { tool, args });
  });
}

test('questions and chit-chat are not commands', () => {
  for (const text of ['qual a capital da França?', 'me conta uma piada', 'what is love', 'oi, tudo bem?']) assert.strictEqual(parse(text), null, text);
});

// Gemini rejects the whole request (400) if one tool declaration is invalid.
test('tool declarations are valid for Gemini function calling', () => {
  const { declarations } = require('../app/assistant/tools');
  for (const d of declarations()) {
    assert.match(d.name, /^[a-z_]+$/);
    for (const [k, p] of Object.entries(d.parameters.properties)) {
      assert.ok(['string', 'integer', 'boolean', 'number'].includes(p.type), `${d.name}.${k} type`);
      if (p.enum) assert.ok(p.enum.every((v) => typeof v === 'string' && v.length > 0), `${d.name}.${k} has an empty enum value`);
    }
    for (const r of d.parameters.required ?? []) assert.ok(r in d.parameters.properties, `${d.name} requires unknown ${r}`);
  }
});
