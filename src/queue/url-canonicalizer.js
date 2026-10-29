// Canonical-URL deduplication: two URLs that differ only in ways that
// don't change what page gets fetched (host case, trailing slash, query
// param order, fragment) should be treated as the same work item.

function canonicalizeUrl(rawUrl) {
  const url = new URL(rawUrl);

  url.hostname = url.hostname.toLowerCase();
  url.hash = '';

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  const sortedParams = new URLSearchParams([...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)));
  url.search = sortedParams.toString();

  return url.toString();
}

module.exports = { canonicalizeUrl };
