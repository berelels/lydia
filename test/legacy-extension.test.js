const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { build, OUT } = require('../build/legacy-extension');

test('the GNOME 42-44 helper is built from the current one', () => {
  for (const [name, text] of Object.entries(build())) assert.strictEqual(fs.readFileSync(path.join(OUT, name), 'utf8'), text, `${name}: run node build/legacy-extension.js`);
});
