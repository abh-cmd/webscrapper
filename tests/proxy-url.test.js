const test = require('node:test');
const assert = require('node:assert/strict');

const { toPlaywrightProxy } = require('../src/net/proxy-url');

test('a proxy URL with embedded credentials splits into server/username/password', () => {
  const result = toPlaywrightProxy('http://myuser:myp%40ss@proxy.example.invalid:8080');
  assert.equal(result.server, 'http://proxy.example.invalid:8080');
  assert.equal(result.username, 'myuser');
  assert.equal(result.password, 'myp@ss');
});

test('a proxy URL with no credentials produces only a server field', () => {
  const result = toPlaywrightProxy('http://proxy.example.invalid:8080');
  assert.equal(result.server, 'http://proxy.example.invalid:8080');
  assert.equal('username' in result, false);
  assert.equal('password' in result, false);
});
