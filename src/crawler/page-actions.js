const DEFAULT_AGE_GATE_SELECTORS = {
  dobInput: ['#dob-input', 'input[type="date"]', 'input[name="dob"]', 'input[name="date_of_birth"]'],
  submitButton: ['#verify-btn', 'button:has-text("Enter")', 'button:has-text("Verify")', 'button:has-text("Continue")', 'button:has-text("Submit")']
};

function resolveDob(context = {}, actionConfig = {}) {
  return context.ageGateDob
    || context.sourceConfig?.ageGateDob
    || actionConfig.dob
    || actionConfig.value
    || process.env.AGE_GATE_DOB
    || null;
}

async function findFirstLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (count > 0) return locator;
  }
  return null;
}

async function dismissAgeGate(page, context = {}, actionConfig = {}) {
  const dob = resolveDob(context, actionConfig);
  if (!dob) {
    return { applied: false, skipped: true, reason: 'missing-date-of-birth' };
  }

  const input = await findFirstLocator(page, actionConfig.dobSelectors || DEFAULT_AGE_GATE_SELECTORS.dobInput);
  if (!input) {
    return { applied: false, skipped: true, reason: 'dob-input-not-found' };
  }

  await input.fill(dob);

  const submit = await findFirstLocator(page, actionConfig.submitSelectors || DEFAULT_AGE_GATE_SELECTORS.submitButton);
  if (submit) {
    await submit.click();
  } else {
    await input.press('Enter').catch(() => {});
  }

  return { applied: true, skipped: false };
}

async function runPageAction({ page, sourceAdapter = null, context = {}, sourceConfig = {} } = {}) {
  if (!page) {
    throw new Error('runPageAction requires a page object.');
  }

  if (sourceAdapter && typeof sourceAdapter.preparePage === 'function') {
    return sourceAdapter.preparePage({ page, context: { ...context, sourceConfig } });
  }

  const configuredAction = sourceConfig.pageAction || sourceConfig.page_action || null;
  if (!configuredAction) {
    return { applied: false, skipped: true, reason: 'no-page-action-configured' };
  }

  const normalized = typeof configuredAction === 'string' ? { type: configuredAction } : configuredAction;
  if (normalized.type === 'age-gate' || normalized.type === 'age_gate' || normalized.type === 'dob-form') {
    return dismissAgeGate(page, { ...context, sourceConfig }, normalized);
  }

  return { applied: false, skipped: true, reason: `unsupported-page-action:${normalized.type || 'unknown'}` };
}

module.exports = {
  runPageAction,
  dismissAgeGate
};