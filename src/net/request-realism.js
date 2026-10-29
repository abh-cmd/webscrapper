// Request realism: User-Agent rotation, a consistent realistic header set
// per session, per-session cookie handling, and timeout/redirect config.
//
// This exists to make outbound requests look like an ordinary browser
// request (a real UA, a coherent set of Accept/Accept-Language headers)
// rather than an obviously bare HTTP client — it does NOT spoof security
// signals, forge auth tokens, or otherwise defeat anti-bot systems. See
// the compliance notes in proxy-pool.js / README.

const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/125.0'
];

class UserAgentRotator {
  constructor({ userAgents = DEFAULT_USER_AGENTS } = {}) {
    if (!Array.isArray(userAgents) || userAgents.length === 0) {
      throw new Error('UserAgentRotator requires at least one user agent.');
    }
    this.userAgents = userAgents;
    this.index = 0;
  }

  next() {
    const ua = this.userAgents[this.index % this.userAgents.length];
    this.index += 1;
    return ua;
  }

  random({ random = Math.random } = {}) {
    return this.userAgents[Math.floor(random() * this.userAgents.length)];
  }
}

// Builds one coherent header set for a session and caches it, so a given
// session always presents the same User-Agent/Accept-* combination rather
// than mixing headers from different simulated browsers request-to-request
// (an inconsistency real anti-bot systems specifically look for).
class SessionHeaderBuilder {
  constructor({ rotator = new UserAgentRotator() } = {}) {
    this.rotator = rotator;
    this.sessionHeaders = new Map();
  }

  headersFor(sessionKey) {
    if (!this.sessionHeaders.has(sessionKey)) {
      const userAgent = this.rotator.next();
      this.sessionHeaders.set(sessionKey, {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br'
      });
    }
    return { ...this.sessionHeaders.get(sessionKey) };
  }

  reset(sessionKey) {
    this.sessionHeaders.delete(sessionKey);
  }
}

// A minimal per-session cookie jar. Deliberately simple (name -> value per
// session key) — enough to let a session look consistent across requests,
// not a full RFC 6265 implementation.
class SessionCookieJar {
  constructor() {
    this.bySession = new Map();
  }

  setCookie(sessionKey, name, value) {
    if (!this.bySession.has(sessionKey)) this.bySession.set(sessionKey, new Map());
    this.bySession.get(sessionKey).set(name, value);
  }

  getCookieHeader(sessionKey) {
    const cookies = this.bySession.get(sessionKey);
    if (!cookies || cookies.size === 0) return null;
    return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  clear(sessionKey) {
    this.bySession.delete(sessionKey);
  }
}

function validateRequestConfig({ timeoutMs = 30000, maxRedirects = 5 } = {}) {
  if (!(timeoutMs > 0)) throw new Error('timeoutMs must be a positive number.');
  if (!(maxRedirects >= 0)) throw new Error('maxRedirects must be a non-negative number.');
  return { timeoutMs, maxRedirects };
}

module.exports = {
  DEFAULT_USER_AGENTS,
  UserAgentRotator,
  SessionHeaderBuilder,
  SessionCookieJar,
  validateRequestConfig
};
