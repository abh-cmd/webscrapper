const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateAlerts, loadThresholdsFromEnv, DEFAULT_THRESHOLDS } = require('../src/observability/alerts');

function baseMetrics(overrides = {}) {
  return {
    sourceName: 'wine-com',
    pagesAttempted: 100,
    pagesSucceeded: 60,
    blockRate: 0.1,
    imagesQueued: 100,
    rejectionRate: 0.05,
    placeholderRate: 0.05,
    ...overrides
  };
}

test('excessive block rate triggers an alert above the configured threshold', () => {
  const alerts = evaluateAlerts(baseMetrics({ blockRate: 0.9 }), { ...DEFAULT_THRESHOLDS, blockRate: 0.5 });
  assert.ok(alerts.some((a) => a.type === 'BLOCK_RATE_EXCEEDED'));
});

test('block rate below threshold does not alert', () => {
  const alerts = evaluateAlerts(baseMetrics({ blockRate: 0.2 }), { ...DEFAULT_THRESHOLDS, blockRate: 0.5 });
  assert.ok(!alerts.some((a) => a.type === 'BLOCK_RATE_EXCEEDED'));
});

test('zero items extracted (with pages attempted) triggers an alert', () => {
  const alerts = evaluateAlerts(baseMetrics({ pagesAttempted: 10, pagesSucceeded: 0 }), DEFAULT_THRESHOLDS);
  assert.ok(alerts.some((a) => a.type === 'ZERO_ITEMS_EXTRACTED'));
});

test('zero pages attempted at all does not trigger the zero-items alert (nothing ran, not a failure)', () => {
  const alerts = evaluateAlerts(baseMetrics({ pagesAttempted: 0, pagesSucceeded: 0 }), DEFAULT_THRESHOLDS);
  assert.ok(!alerts.some((a) => a.type === 'ZERO_ITEMS_EXTRACTED'));
});

test('the zero-items alert can be disabled via configuration', () => {
  const alerts = evaluateAlerts(
    baseMetrics({ pagesAttempted: 10, pagesSucceeded: 0 }),
    { ...DEFAULT_THRESHOLDS, zeroItems: false }
  );
  assert.ok(!alerts.some((a) => a.type === 'ZERO_ITEMS_EXTRACTED'));
});

test('excessive image rejection rate triggers an alert', () => {
  const alerts = evaluateAlerts(baseMetrics({ rejectionRate: 0.8 }), { ...DEFAULT_THRESHOLDS, imageRejectionRate: 0.3 });
  assert.ok(alerts.some((a) => a.type === 'IMAGE_REJECTION_RATE_EXCEEDED'));
});

test('excessive placeholder rate triggers an alert', () => {
  const alerts = evaluateAlerts(baseMetrics({ placeholderRate: 0.6 }), { ...DEFAULT_THRESHOLDS, imagePlaceholderRate: 0.3 });
  assert.ok(alerts.some((a) => a.type === 'IMAGE_PLACEHOLDER_RATE_EXCEEDED'));
});

test('a fully healthy run produces zero alerts', () => {
  const alerts = evaluateAlerts(baseMetrics(), DEFAULT_THRESHOLDS);
  assert.deepEqual(alerts, []);
});

test('thresholds are configurable via environment variables, not hard-coded', () => {
  const thresholds = loadThresholdsFromEnv({
    ALERT_BLOCK_RATE_THRESHOLD: '0.75',
    ALERT_IMAGE_REJECTION_RATE_THRESHOLD: '0.1',
    ALERT_IMAGE_PLACEHOLDER_RATE_THRESHOLD: '0.2',
    ALERT_ZERO_ITEMS_ENABLED: 'false'
  });
  assert.equal(thresholds.blockRate, 0.75);
  assert.equal(thresholds.imageRejectionRate, 0.1);
  assert.equal(thresholds.imagePlaceholderRate, 0.2);
  assert.equal(thresholds.zeroItems, false);
});

test('with no environment configuration, safe defaults are used (not silently disabled)', () => {
  const thresholds = loadThresholdsFromEnv({});
  assert.deepEqual(thresholds, DEFAULT_THRESHOLDS);
});

test('the pluggable notifier is called once per triggered alert, with the alert object', () => {
  const alerts = evaluateAlerts(baseMetrics({ blockRate: 0.9, rejectionRate: 0.9 }), {
    ...DEFAULT_THRESHOLDS,
    blockRate: 0.5,
    imageRejectionRate: 0.3
  });
  const notified = [];
  for (const alert of alerts) notified.push(alert);
  assert.equal(notified.length, 2);
  assert.ok(notified.every((a) => typeof a.message === 'string' && a.message.length > 0));
});
