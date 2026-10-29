const test = require('node:test');
const assert = require('node:assert/strict');

const { isKillSwitchEngaged, loadDisabledSources, isSourceDisabled } = require('../src/net/kill-switch');

test('kill switch is disengaged by default (no env configured)', () => {
  assert.equal(isKillSwitchEngaged({}), false);
});

test('kill switch engages only on the exact string "true"', () => {
  assert.equal(isKillSwitchEngaged({ CRAWLER_KILL_SWITCH: 'true' }), true);
  assert.equal(isKillSwitchEngaged({ CRAWLER_KILL_SWITCH: 'TRUE' }), false);
  assert.equal(isKillSwitchEngaged({ CRAWLER_KILL_SWITCH: '1' }), false);
});

test('no source is disabled by default', () => {
  assert.equal(isSourceDisabled('wine-com', {}), false);
  assert.deepEqual(loadDisabledSources({}), new Set());
});

test('DISABLED_SOURCES disables exactly the listed sources, case-insensitively, trimmed', () => {
  const env = { DISABLED_SOURCES: ' wine-com, Total-Wine ,,vivino' };
  assert.equal(isSourceDisabled('wine-com', env), true);
  assert.equal(isSourceDisabled('total-wine', env), true);
  assert.equal(isSourceDisabled('vivino', env), true);
  assert.equal(isSourceDisabled('wine-searcher', env), false);
});
