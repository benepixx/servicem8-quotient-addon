'use strict';

// Tests for the Cloudflare Worker (worker/src/index.js).
// extractJobNumber is tested by defining it locally here, matching the
// implementation in worker/src/index.js, since that file uses ESM.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── extractJobNumber ──────────────────────────────────────────────────────────
// Mirrors worker/src/index.js extractJobNumber()

function extractJobNumber(title) {
  if (!title) return null;
  const match = title.match(/#?(\d+)/);
  return match ? match[1] : null;
}

test('extractJobNumber handles #NNNN – Description format', () => {
  assert.equal(extractJobNumber('#6786 \u2013 Bathroom Reno'), '6786');
});

test('extractJobNumber handles Job #NNNN – Description format', () => {
  assert.equal(extractJobNumber('Job #6786 \u2013 Home Security'), '6786');
});

test('extractJobNumber handles Job NNNN format', () => {
  assert.equal(extractJobNumber('Job 6786'), '6786');
});

test('extractJobNumber handles NNNN - Description format', () => {
  assert.equal(extractJobNumber('6786 - Solar Install'), '6786');
});

test('extractJobNumber handles title from problem statement example', () => {
  assert.equal(extractJobNumber('Home Security System #6786'), '6786');
});

test('extractJobNumber returns null for null input', () => {
  assert.equal(extractJobNumber(null), null);
});

test('extractJobNumber returns null for undefined input', () => {
  assert.equal(extractJobNumber(undefined), null);
});

test('extractJobNumber returns null for title with no number', () => {
  assert.equal(extractJobNumber('Bathroom Reno'), null);
});

test('extractJobNumber returns null for empty string', () => {
  assert.equal(extractJobNumber(''), null);
});
