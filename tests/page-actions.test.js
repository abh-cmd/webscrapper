const test = require('node:test');
const assert = require('node:assert/strict');

const { dismissAgeGate, runPageAction } = require('../src/crawler/page-actions');
const { resolveSource } = require('../src/sources/source-registry');

function fakePage() {
  const calls = [];
  const selectors = new Map();

  selectors.set('#dob-input', {
    count: async () => 1,
    fill: async (value) => { calls.push(`fill:${value}`); },
    press: async (key) => { calls.push(`press:${key}`); }
  });

  selectors.set('#verify-btn', {
    count: async () => 1,
    click: async () => { calls.push('click:#verify-btn'); }
  });

  return {
    calls,
    locator(selector) {
      const entry = selectors.get(selector);
      if (!entry) {
        return {
          first() {
            return {
              count: async () => 0,
              fill: async () => { throw new Error('unexpected fill'); },
              click: async () => { throw new Error('unexpected click'); },
              press: async () => { throw new Error('unexpected press'); }
            };
          }
        };
      }
      return {
        first() {
          return entry;
        }
      };
    }
  };
}

test('dismissAgeGate fills the DOB field and clicks the submit button', async () => {
  const page = fakePage();
  const result = await dismissAgeGate(page, { ageGateDob: '1990-01-01' });

  assert.deepEqual(result, { applied: true, skipped: false });
  assert.deepEqual(page.calls, ['fill:1990-01-01', 'click:#verify-btn']);
});

test('runPageAction delegates Flaviar URLs to the Flaviar adapter page action', async () => {
  const adapter = resolveSource({ url: 'https://www.barefootwine.com/pinot-noir.html' });
  const page = fakePage();

  const result = await runPageAction({
    page,
    sourceAdapter: adapter,
    context: { ageGateDob: '1991-02-03' },
    sourceConfig: { ageGateDob: '1991-02-03' }
  });

  assert.equal(adapter.name, 'flaviar');
  assert.deepEqual(result, { applied: true, skipped: false });
  assert.deepEqual(page.calls, ['fill:1991-02-03', 'click:#verify-btn']);
});