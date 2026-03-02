'use strict';

const http = require('http');
const crypto = require('crypto');
const { handler } = require('./index');

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.SM8_WEBHOOK_SECRET || '';

/**
 * Verify the HMAC-SHA256 signature that ServiceM8 attaches to webhook requests.
 * Returns true if the signature is valid (or if no secret is configured, which
 * allows local development without a secret).
 *
 * @param {string} rawBody  - Raw request body string
 * @param {string} signature - Value of X-ServiceM8-Webhook-Signature header
 * @returns {boolean}
 */
function verifySignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) {
    console.warn(
      'WARNING: SM8_WEBHOOK_SECRET is not set. Webhook signature validation is disabled. ' +
      'Set this variable in production to prevent unauthorized requests.'
    );
    return true; // Skip validation when no secret configured
  }
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Read the full body of an IncomingMessage as a string.
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Health-check endpoint
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    console.error('Failed to read request body:', err);
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  // Validate webhook signature for webhook events
  const signature = req.headers['x-servicem8-webhook-signature'];
  const contentType = req.headers['content-type'] || '';

  // Webhooks carry a signature; action popups do not
  if (signature !== undefined && !verifySignature(rawBody, signature)) {
    console.warn('Invalid webhook signature — request rejected');
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    console.error('Failed to parse JSON body:', err);
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid JSON');
    return;
  }

  let result;
  try {
    result = await handler(event);
  } catch (err) {
    console.error('Unhandled handler error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
    return;
  }

  const statusCode = result.statusCode || 200;
  const headers = result.headers || {};
  if (!headers['Content-Type']) {
    headers['Content-Type'] = 'text/plain';
  }

  res.writeHead(statusCode, headers);
  res.end(result.body || '');
});

server.listen(PORT, () => {
  console.log(`ServiceM8-Quotient addon server listening on port ${PORT}`);
});

module.exports = server; // Export for testing
