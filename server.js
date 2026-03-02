'use strict';

const http = require('http');
const { handler } = require('./index');

const PORT = process.env.PORT || 3000;

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
