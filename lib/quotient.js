'use strict';

const https = require('https');

class Quotient {
  constructor() {
    this.apiKey = process.env.QUOTIENT_API_KEY;
    this.accountId = process.env.QUOTIENT_ACCOUNT_ID;
    this.hostname = 'api.quotientapp.com';
  }

  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const options = {
        hostname: this.hostname,
        path: `/v1${path}`,
        method,
        headers: {
          'X-API-Key': this.apiKey,
          'X-Account-ID': this.accountId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      };
      if (payload) {
        options.headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch (err) {
              console.error('Quotient JSON parse error:', err.message, data);
              resolve({});
            }
          } else {
            reject(new Error(`Quotient API error ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  _requestBuffer(path) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        path: `/v1${path}`,
        method: 'GET',
        headers: {
          'X-API-Key': this.apiKey,
          'X-Account-ID': this.accountId,
        },
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => { chunks.push(chunk); });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(Buffer.concat(chunks));
          } else {
            reject(new Error(`Quotient PDF error ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  async createQuote(params) {
    const raw = await this._request('POST', '/quotes', {
      customer: {
        name: params.customerName,
        email: params.customerEmail,
        phone: params.customerPhone,
        address: params.customerAddress,
      },
      quote: {
        title: params.title,
        notes: params.notes,
        reference: params.reference,
        line_items: [],
      },
    });
    return {
      id: raw.id,
      viewUrl: raw.view_url || raw.viewUrl,
      status: raw.status,
    };
  }

  async getQuote(quoteId) {
    const raw = await this._request('GET', `/quotes/${quoteId}`);
    return {
      id: raw.id,
      status: raw.status,
      viewUrl: raw.view_url || raw.viewUrl,
      lineItems: raw.line_items || raw.lineItems || [],
      totalAmount: raw.total_amount || raw.totalAmount,
      customerName: raw.customer ? (raw.customer.name || '') : '',
      acceptedAt: raw.accepted_at || raw.acceptedAt,
      signedAt: raw.signed_at || raw.signedAt,
    };
  }

  getSignedQuotePDF(quoteId) {
    return this._requestBuffer(`/quotes/${quoteId}/pdf`);
  }

  updateQuote(quoteId, params) {
    return this._request('PUT', `/quotes/${quoteId}`, params);
  }
}

module.exports = Quotient;
