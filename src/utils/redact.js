// Secrets must never appear in a log line or a report file — API keys,
// proxy credentials, database passwords. Nothing in this project logs a
// config value directly (see startup-validator.js's redactedPresence()),
// but an ERROR MESSAGE is a different risk: if a proxy connection fails,
// or a database driver reports a connection error, the underlying
// library's error message can legitimately contain the full connection
// URL, credentials included. This is the last line of defense — applied
// to every error message before it's written to a report file or printed
// (see crawler.js's finalizeFailure and utils/logging.js).

const PATTERNS = [
  // protocol://user:password@host -> protocol://***:***@host
  [/(\w+:\/\/)([^:/\s@]+):([^@\s]+)@/g, '$1***:***@'],
  // Authorization: Bearer <token> / Basic <token>
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  // Common API key shapes (OpenAI-style sk-..., generic 32+ char hex/base64 tokens after "key"/"token"/"password"/"secret")
  [/\b(sk-[A-Za-z0-9]{16,})\b/g, '***'],
  [/\b((?:api[_-]?key|token|password|secret)\s*[:=]\s*)["']?[^\s"',}]{6,}["']?/gi, '$1***']
];

function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  let result = text;
  for (const [pattern, replacement] of PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

module.exports = { redactSecrets };
