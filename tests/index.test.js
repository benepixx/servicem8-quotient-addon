'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, handler } = require('../addon/function');

// ── escapeHtml ────────────────────────────────────────────────────────────────

test('escapeHtml escapes &', () => {
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
});

test('escapeHtml escapes <', () => {
  assert.equal(escapeHtml('<tag>'), '&lt;tag&gt;');
});

test('escapeHtml escapes "', () => {
  assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
});

test("escapeHtml escapes '", () => {
  assert.equal(escapeHtml("it's"), 'it&#39;s');
});

test('escapeHtml escapes all special chars together', () => {
  assert.equal(escapeHtml('<script>alert("xss")&1</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&amp;1&lt;/script&gt;');
});

test('escapeHtml returns empty string for null', () => {
  assert.equal(escapeHtml(null), '');
});

test('escapeHtml returns empty string for undefined', () => {
  assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml returns plain string unchanged', () => {
  assert.equal(escapeHtml('hello world'), 'hello world');
});

// ── handler routing ───────────────────────────────────────────────────────────

test('handler returns 400 for unknown event type', async () => {
  const result = await handler({ eventType: 'unknown_event' });
  assert.equal(result.statusCode, 400);
  assert.match(result.body, /Unknown event type/);
});

test('handler returns 400 for webhook events (auto-creation is disabled)', async () => {
  const result = await handler({
    eventType: 'webhook',
    object: 'job',
    uuid: 'job-uuid',
    company_id: 'co-uuid',
    job_description: '',
    auth: { accessToken: 'tok' },
  });
  assert.equal(result.statusCode, 400);
  assert.match(result.body, /Unknown event type/);
});
