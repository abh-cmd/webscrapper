const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { checkRobotsCompliance, parseRobotsTxt, isPathAllowed, clearRobotsCache } = require('../src/compliance/robots-checker');

test('parseRobotsTxt: groups rules under the correct user-agent, ignores comments/blank lines', () => {
  const groups = parseRobotsTxt(`
    # comment
    User-agent: ClaudeBot
    Disallow: /private
    Allow: /private/public-page

    User-agent: *
    Disallow: /
  `);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].userAgents, ['claudebot']);
  assert.equal(groups[0].rules.length, 2);
  assert.deepEqual(groups[1].userAgents, ['*']);
});

test('isPathAllowed: exact user-agent group is preferred over the wildcard group', () => {
  const groups = parseRobotsTxt('User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n');
  const result = isPathAllowed(groups, 'ClaudeBot', '/anything');
  assert.equal(result.allowed, false);
  assert.equal(result.group, 'claudebot');
});

test('isPathAllowed: falls back to the wildcard group when no exact match exists', () => {
  const groups = parseRobotsTxt('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /\n');
  const result = isPathAllowed(groups, 'ClaudeBot', '/anything');
  assert.equal(result.allowed, true);
  assert.equal(result.group, '*');
});

test('isPathAllowed: longest matching pattern wins (a specific Allow overrides a broad Disallow)', () => {
  const groups = parseRobotsTxt('User-agent: ClaudeBot\nDisallow: /product\nAllow: /product/public\n');
  const blocked = isPathAllowed(groups, 'ClaudeBot', '/product/secret');
  const allowed = isPathAllowed(groups, 'ClaudeBot', '/product/public/page');
  assert.equal(blocked.allowed, false);
  assert.equal(allowed.allowed, true);
});

test('isPathAllowed: an end-anchored pattern ($) only matches the exact path', () => {
  const groups = parseRobotsTxt('User-agent: ClaudeBot\nDisallow: /\nAllow: /$\n');
  assert.equal(isPathAllowed(groups, 'ClaudeBot', '/').allowed, true);
  assert.equal(isPathAllowed(groups, 'ClaudeBot', '/anything').allowed, false);
});

test('isPathAllowed: no rules at all for the matched group means allow', () => {
  const groups = parseRobotsTxt('User-agent: ClaudeBot\n');
  assert.equal(isPathAllowed(groups, 'ClaudeBot', '/whatever').allowed, true);
});

test('checkRobotsCompliance: fails OPEN when the host is unreachable (no server listening)', async () => {
  const result = await checkRobotsCompliance('http://127.0.0.1:1/some-path', {});
  assert.equal(result.allowed, true);
  assert.match(result.reason, /default allow/);
});

test('checkRobotsCompliance: fails OPEN when robots.txt returns 404 (absence means no restriction)', async () => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const result = await checkRobotsCompliance(`http://127.0.0.1:${port}/anything`, {});
  assert.equal(result.allowed, true);

  server.close();
  clearRobotsCache();
});

test('checkRobotsCompliance: a real local server with a Disallow rule genuinely blocks the matching path', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('User-agent: ClaudeBot\nDisallow: /blocked\nAllow: /open\n');
      return;
    }
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const blocked = await checkRobotsCompliance(`http://127.0.0.1:${port}/blocked/page`, {});
  const open = await checkRobotsCompliance(`http://127.0.0.1:${port}/open/page`, {});
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.matchedRule, 'Disallow: /blocked');
  assert.equal(open.allowed, true);

  server.close();
  clearRobotsCache();
});

test('checkRobotsCompliance: caches robots.txt per origin (a second lookup does not re-fetch)', async () => {
  let fetchCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      fetchCount += 1;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /blocked\n');
      return;
    }
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  await checkRobotsCompliance(`http://127.0.0.1:${port}/blocked/1`, {});
  await checkRobotsCompliance(`http://127.0.0.1:${port}/blocked/2`, {});
  assert.equal(fetchCount, 1);

  server.close();
  clearRobotsCache();
});
