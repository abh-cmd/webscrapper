// Playwright's proxy launch option wants { server, username, password } as
// separate fields, not a single URL with embedded credentials — this
// converts one to the other so PROXY_LIST can stay a plain list of URLs
// (the natural format most proxy providers hand out).
function toPlaywrightProxy(proxyUrl) {
  const parsed = new URL(proxyUrl);
  const server = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  const result = { server };
  if (parsed.username) result.username = decodeURIComponent(parsed.username);
  if (parsed.password) result.password = decodeURIComponent(parsed.password);
  return result;
}

module.exports = { toPlaywrightProxy };
