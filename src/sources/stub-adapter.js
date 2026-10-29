const { hostnameMatches } = require('./hostname-utils');

// Shared factory for production-source adapters whose real page structure
// has not been inspected yet. These adapters correctly identify their
// source (so the registry/routing layer is fully real and testable) but
// fail clearly and explicitly on extract() instead of guessing selectors.
// Do not use this for a source once real DOM inspection informs actual
// extraction logic — replace canHandle/extract with real implementations.
function createStubAdapter({ name, displayName, hostnames }) {
  function canHandle(url) {
    return hostnameMatches(url, hostnames);
  }

  async function extract() {
    const err = new Error(
      `${displayName} extraction is not yet implemented: the real ${displayName} product-page DOM has not been inspected, so no selectors have been written. ` +
      'This adapter currently only establishes the source-registry/adapter-contract boundary (Phase 3).'
    );
    err.type = 'NOT_IMPLEMENTED';
    throw err;
  }

  return {
    name,
    hostnames,
    canHandle,
    extract
  };
}

module.exports = {
  createStubAdapter
};
