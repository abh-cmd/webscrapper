function getHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch (error) {
    return null;
  }
}

// Matches an exact registered domain or any subdomain of it (e.g.
// "shop.wine.com" matches domain "wine.com"). Deliberately does not attempt
// broader normalization (IDN, punycode, trailing dots, etc.) per the Phase 3
// instruction not to over-engineer URL handling.
function hostnameMatches(url, domains) {
  const host = getHostname(url);
  if (!host) return false;

  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

module.exports = {
  getHostname,
  hostnameMatches
};
