const test = require('node:test');
const assert = require('node:assert');
const { newer } = require('../app/updates');

test('newer compares versions, with or without the v', () => {
  assert.ok(newer('1.0.1', '1.0.0'));
  assert.ok(newer('v1.10.0', '1.9.9'));
  assert.ok(newer('2', '1.9.9'));
  assert.ok(!newer('1.0.0', '1.0.0'));
  assert.ok(!newer('v1.0.0', '1.0.1'));
  assert.ok(!newer('1.2.0-beta', '1.2.0'));
});
