// "Alert when block rate for a source exceeds a configured threshold, or
// when a run yields zero items... Alert when the image rejection or
// placeholder rate for a source exceeds a threshold... Do not hard-code
// operational thresholds if the specification says they must be
// configurable."
//
// This module only EVALUATES metrics against configurable thresholds and
// returns structured alert objects — it does not send email/Slack/pager
// notifications anywhere, since no such channel exists or was requested.
// A real notifier is a thin, pluggable function (see notify()) that
// defaults to console output; wiring a real paging/notification service
// is a separate, disclosed gap (see README).

const DEFAULT_THRESHOLDS = {
  blockRate: 0.5,          // fraction of attempted pages classified ACCESS_DENIED
  zeroItems: true,         // alert if pagesAttempted > 0 but pagesSucceeded === 0
  imageRejectionRate: 0.3,
  imagePlaceholderRate: 0.3
};

function loadThresholdsFromEnv(env = process.env) {
  return {
    blockRate: env.ALERT_BLOCK_RATE_THRESHOLD !== undefined ? Number(env.ALERT_BLOCK_RATE_THRESHOLD) : DEFAULT_THRESHOLDS.blockRate,
    zeroItems: env.ALERT_ZERO_ITEMS_ENABLED !== undefined ? env.ALERT_ZERO_ITEMS_ENABLED !== 'false' : DEFAULT_THRESHOLDS.zeroItems,
    imageRejectionRate: env.ALERT_IMAGE_REJECTION_RATE_THRESHOLD !== undefined ? Number(env.ALERT_IMAGE_REJECTION_RATE_THRESHOLD) : DEFAULT_THRESHOLDS.imageRejectionRate,
    imagePlaceholderRate: env.ALERT_IMAGE_PLACEHOLDER_RATE_THRESHOLD !== undefined ? Number(env.ALERT_IMAGE_PLACEHOLDER_RATE_THRESHOLD) : DEFAULT_THRESHOLDS.imagePlaceholderRate
  };
}

function evaluateAlerts(metrics, thresholds = DEFAULT_THRESHOLDS) {
  const alerts = [];

  if (metrics.pagesAttempted > 0 && metrics.blockRate > thresholds.blockRate) {
    alerts.push({
      type: 'BLOCK_RATE_EXCEEDED',
      sourceName: metrics.sourceName,
      severity: 'high',
      message: `Block rate ${(metrics.blockRate * 100).toFixed(1)}% exceeds threshold ${(thresholds.blockRate * 100).toFixed(1)}% for source "${metrics.sourceName}".`,
      value: metrics.blockRate,
      threshold: thresholds.blockRate
    });
  }

  if (thresholds.zeroItems && metrics.pagesAttempted > 0 && metrics.pagesSucceeded === 0) {
    alerts.push({
      type: 'ZERO_ITEMS_EXTRACTED',
      sourceName: metrics.sourceName,
      severity: 'high',
      message: `${metrics.pagesAttempted} pages were attempted for "${metrics.sourceName}" but zero items were extracted — the site's markup may have changed, or the source may be fully blocked.`,
      value: 0,
      threshold: 0
    });
  }

  if (metrics.imagesQueued > 0 && metrics.rejectionRate > thresholds.imageRejectionRate) {
    alerts.push({
      type: 'IMAGE_REJECTION_RATE_EXCEEDED',
      sourceName: metrics.sourceName,
      severity: 'medium',
      message: `Image rejection rate ${(metrics.rejectionRate * 100).toFixed(1)}% exceeds threshold ${(thresholds.imageRejectionRate * 100).toFixed(1)}% for source "${metrics.sourceName}".`,
      value: metrics.rejectionRate,
      threshold: thresholds.imageRejectionRate
    });
  }

  if (metrics.imagesQueued > 0 && metrics.placeholderRate > thresholds.imagePlaceholderRate) {
    alerts.push({
      type: 'IMAGE_PLACEHOLDER_RATE_EXCEEDED',
      sourceName: metrics.sourceName,
      severity: 'medium',
      message: `Placeholder image rate ${(metrics.placeholderRate * 100).toFixed(1)}% exceeds threshold ${(thresholds.imagePlaceholderRate * 100).toFixed(1)}% for source "${metrics.sourceName}".`,
      value: metrics.placeholderRate,
      threshold: thresholds.imagePlaceholderRate
    });
  }

  return alerts;
}

function consoleNotifier(alert) {
  console.warn(`[ALERT:${alert.severity}] ${alert.type} — ${alert.message}`);
}

async function checkAndNotify(sourceName, { thresholds = null, notify = consoleNotifier, metricsOptions = {} } = {}) {
  const { computeRunMetrics } = require('./run-metrics');
  const metrics = await computeRunMetrics(sourceName, metricsOptions);
  const resolvedThresholds = thresholds || loadThresholdsFromEnv();
  const alerts = evaluateAlerts(metrics, resolvedThresholds);
  for (const alert of alerts) notify(alert);
  return { metrics, alerts };
}

module.exports = { DEFAULT_THRESHOLDS, loadThresholdsFromEnv, evaluateAlerts, consoleNotifier, checkAndNotify };
