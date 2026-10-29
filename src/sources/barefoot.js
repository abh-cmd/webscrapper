const { extractGenericProduct } = require('./generic-adapter');
const { hostnameMatches } = require('./hostname-utils');
const { dismissAgeGate } = require('../crawler/page-actions');

const HOSTNAMES = ['flaviar.com', 'barefootwine.com'];

function canHandle(url) {
  return hostnameMatches(url, HOSTNAMES);
}

async function preparePage({ page, context = {} } = {}) {
  return dismissAgeGate(page, context, {
    type: 'age-gate',
    dob: context.ageGateDob || context.sourceConfig?.ageGateDob || null
  });
}

module.exports = {
  name: 'flaviar',
  hostnames: HOSTNAMES,
  canHandle,
  preparePage,
  extract: extractGenericProduct
};