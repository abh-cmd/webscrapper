const test = require('node:test');
const assert = require('node:assert/strict');

const { redactSecrets } = require('../src/utils/redact');

test('a proxy URL with embedded credentials is redacted', () => {
  const message = 'Failed to connect: http://myuser:sup3rSecret!@proxy.example.invalid:8080/tunnel';
  const redacted = redactSecrets(message);
  assert.ok(!redacted.includes('myuser'));
  assert.ok(!redacted.includes('sup3rSecret'));
  assert.ok(redacted.includes('proxy.example.invalid'), 'the host itself is not a secret and should remain for debugging');
});

test('a Bearer token in an Authorization header string is redacted', () => {
  const message = 'AI provider HTTP 401: {"headers":{"Authorization":"Bearer sk-abcdefghijklmnopqrstuvwxyz1234567890"}}';
  const redacted = redactSecrets(message);
  assert.ok(!redacted.includes('sk-abcdefghijklmnopqrstuvwxyz1234567890'));
});

test('a database connection string with a password is redacted', () => {
  const message = 'connect ECONNREFUSED — postgres://wineoutlet:hunter2pass@localhost:5432/wineoutlet';
  const redacted = redactSecrets(message);
  assert.ok(!redacted.includes('hunter2pass'));
  assert.ok(redacted.includes('localhost'));
});

test('a plain error message with no secrets is left completely unchanged', () => {
  const message = 'Wine.com denied access to this page via a DataDome anti-bot challenge (HTTP 403).';
  assert.equal(redactSecrets(message), message);
});

test('a key=value style secret is redacted', () => {
  const redacted = redactSecrets('config error: api_key=AKIAIOSFODNN7EXAMPLE1234 is invalid');
  assert.ok(!redacted.includes('AKIAIOSFODNN7EXAMPLE1234'));
});

test('null/undefined/non-string input passes through unchanged rather than throwing', () => {
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), undefined);
  assert.equal(redactSecrets(42), 42);
});
