const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

// Real runtime robots.txt enforcement. Before this module, robots.txt was
// only ever checked manually, once, during adapter development (Phases
// 2/4/5/6) and recorded as a static flag in `source_compliance` — nothing
// in the crawler itself re-checked it on every request. That is a real gap
// against "robots.txt is honoured by default" (the requirements document),
// closed here.
//
// Fails OPEN (allowed: true) whenever robots.txt cannot be determined —
// unreachable host, network error, timeout, or a non-2xx response (a
// missing robots.txt conventionally means "no restriction," not "deny
// everything"). It fails CLOSED only on an explicit matching Disallow
// rule. This keeps every existing local-fixture/offline test unaffected
// (127.0.0.1 has no robots.txt to fetch, so those requests default-allow
// immediately) while giving the four real production sources genuine,
// live enforcement.

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // origin -> { fetchedAt, groups }

function fetchText(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      done({ ok: false, reason: `invalid URL: ${error.message}` });
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'ClaudeBot' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        done({ ok: false, reason: `HTTP ${res.statusCode}`, statusCode: res.statusCode });
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({ ok: true, statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });

    request.on('timeout', () => { request.destroy(); done({ ok: false, reason: 'timeout' }); });
    request.on('error', (error) => done({ ok: false, reason: error.message }));
  });
}

// Groups: [{ userAgents: ['claudebot', '*'], rules: [{ type: 'allow'|'disallow', pattern: '/path' }] }]
function parseRobotsTxt(text) {
  const groups = [];
  let current = null;
  let sawRuleSinceUserAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;
    const field = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (field === 'user-agent') {
      if (!current || sawRuleSinceUserAgent) {
        current = { userAgents: [], rules: [] };
        groups.push(current);
        sawRuleSinceUserAgent = false;
      }
      current.userAgents.push(value.toLowerCase());
    } else if (field === 'allow' || field === 'disallow') {
      if (!current) continue;
      current.rules.push({ type: field, pattern: value });
      sawRuleSinceUserAgent = true;
    }
  }

  return groups;
}

function selectGroup(groups, userAgent) {
  const ua = userAgent.toLowerCase();
  const exact = groups.find((g) => g.userAgents.includes(ua));
  if (exact) return exact;
  const wildcard = groups.find((g) => g.userAgents.includes('*'));
  return wildcard || null;
}

// Minimal robots.txt pattern matcher (Google's documented subset): '*'
// matches any sequence of characters, '$' anchors the end of the URL path,
// otherwise the pattern must match as a literal prefix.
function patternToRegExp(pattern) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + (anchored ? '$' : ''));
}

function isPathAllowed(groups, userAgent, path) {
  const group = selectGroup(groups, userAgent);
  if (!group || group.rules.length === 0) return { allowed: true, matchedRule: null, group: group ? group.userAgents.join(',') : null };

  let best = null; // longest-pattern-wins, per the de-facto standard
  for (const rule of group.rules) {
    if (!rule.pattern) {
      // An empty Disallow means "disallow nothing" (allow everything).
      if (rule.type === 'disallow') continue;
    }
    const regExp = patternToRegExp(rule.pattern);
    if (regExp.test(path)) {
      if (!best || rule.pattern.length >= best.pattern.length) best = rule;
    }
  }

  if (!best) return { allowed: true, matchedRule: null, group: group.userAgents.join(',') };
  return { allowed: best.type === 'allow', matchedRule: `${best.type === 'allow' ? 'Allow' : 'Disallow'}: ${best.pattern}`, group: group.userAgents.join(',') };
}

async function getRobotsGroups(origin) {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.groups;

  const result = await fetchText(`${origin}/robots.txt`);
  const groups = result.ok ? parseRobotsTxt(result.body) : [];
  cache.set(origin, { fetchedAt: Date.now(), groups, fetchOk: result.ok, fetchReason: result.ok ? null : result.reason });
  return groups;
}

// The main entry point the crawler calls. `sourceName` is used to look up
// a recorded override (source_compliance) — a source explicitly signed off
// to bypass robots.txt bypasses this check entirely, per the existing
// enforcement in compliance-repository.js (an override without a reason
// and a named signer cannot be recorded in the first place).
async function checkRobotsCompliance(targetUrl, { userAgent = 'ClaudeBot', sourceName = null } = {}) {
  if (sourceName) {
    try {
      const { isDatabaseConfigured } = require('../db/connection');
      if (isDatabaseConfigured()) {
        const { getSourceCompliance } = require('./compliance-repository');
        const compliance = await getSourceCompliance(sourceName);
        if (compliance && compliance.robotsTxtOverride && compliance.robotsTxtOverrideSignedOffBy) {
          return { allowed: true, reason: 'override', overrideSignedOffBy: compliance.robotsTxtOverrideSignedOffBy };
        }
      }
    } catch (error) {
      // A compliance-lookup failure must never silently grant access —
      // fall through to the real robots.txt check instead.
    }
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (error) {
    return { allowed: true, reason: 'invalid URL, cannot evaluate — default allow' };
  }

  const origin = `${parsed.protocol}//${parsed.host}`;
  const groups = await getRobotsGroups(origin);
  const cached = cache.get(origin);

  if (!cached.fetchOk) {
    return { allowed: true, reason: `robots.txt unavailable (${cached.fetchReason}) — default allow` };
  }

  const path = parsed.pathname + parsed.search;
  const decision = isPathAllowed(groups, userAgent, path);
  return { ...decision, reason: decision.allowed ? 'permitted by robots.txt' : 'disallowed by robots.txt' };
}

function clearRobotsCache() {
  cache.clear();
}

module.exports = { checkRobotsCompliance, parseRobotsTxt, isPathAllowed, clearRobotsCache };
