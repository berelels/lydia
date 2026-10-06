// Installing Lydia's Claude Code hooks must keep everything else in settings.json.
const { test } = require('node:test');
const assert = require('node:assert');
const { withHooks, diffLines } = require('../app/setup');

const theirs = { type: 'command', command: 'notify-send done' };
const base = { autoMode: true, hooks: { Stop: [{ hooks: [theirs] }] }, model: 'opus' };
const ours = (d) => Object.values(d.hooks ?? {}).flatMap((g) => g.flatMap((x) => x.hooks)).filter((h) => h.command.includes('lydia'));

test('install adds one Lydia hook per event and keeps the user\'s', () => {
  const out = withHooks(base, true);
  assert.strictEqual(out.autoMode, true);
  assert.strictEqual(out.model, 'opus');
  assert.deepStrictEqual(out.hooks.Stop[0].hooks, [theirs]);
  assert.strictEqual(ours(out).length, 8);
  assert.strictEqual(out.hooks.PermissionRequest.at(-1).hooks[0].timeout, 120);
  assert.strictEqual(out.hooks.PreToolUse.at(-1).matcher, '*');
  assert.strictEqual(out.hooks.Stop.at(-1).matcher, undefined);
});

test('installing twice changes nothing', () => {
  const once = withHooks(base, true);
  assert.deepStrictEqual(withHooks(once, true), once);
});

test('remove gives back exactly the original', () => {
  assert.deepStrictEqual(withHooks(withHooks(base, true), false), base);
  assert.deepStrictEqual(withHooks(withHooks({}, true), false), {});
});

test('the input is never modified', () => {
  const copy = structuredClone(base);
  withHooks(base, true);
  assert.deepStrictEqual(base, copy);
});

test('diffLines marks added and removed lines', () => {
  const d = diffLines('a\nb\nc', 'a\nx\nc');
  assert.deepStrictEqual(d.map((l) => l.op + l.line), [' a', '-b', '+x', ' c']);
});
