'use strict';

const https = require('https');

// ── ServiceM8 ────────────────────────────────────────────────────────────────

class ServiceM8 {
  constructor(accessToken) {
    this.accessToken = accessToken;
  }

  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const options = {
        hostname: 'api.servicem8.com',
        path: `/api_1.0${path}`,
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
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
              console.error('ServiceM8 JSON parse error:', err.message, data);
              resolve({});
            }
          } else {
            reject(new Error(`ServiceM8 API error ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  getJob(uuid) {
    return this._request('GET', `/job/${uuid}.json`);
  }

  updateJob(uuid, data) {
    return this._request('POST', `/job/${uuid}.json`, data);
  }

  getCompany(uuid) {
    return this._request('GET', `/company/${uuid}.json`);
  }

  getJobAttachments(jobUUID) {
    return this._request('GET', `/attachment.json?$filter=related_object_uuid eq '${encodeURIComponent(jobUUID)}'`);
  }

  getJobMaterials(jobUUID) {
    return this._request('GET', `/jobmaterial.json?$filter=job_uuid eq '${encodeURIComponent(jobUUID)}'`);
  }

  addJobMaterial(jobUUID, lineItem) {
    return this._request('POST', '/jobmaterial.json', {
      job_uuid: jobUUID,
      name: lineItem.name || lineItem.description,
      quantity: lineItem.quantity || 1,
      unit_price: lineItem.unit_price || lineItem.unitPrice || 0,
      unit_cost: lineItem.unit_cost || lineItem.unitCost || 0,
      notes: lineItem.notes || '',
      is_billable: 1,
      material_type: lineItem.material_type || 'MATERIAL',
    });
  }

  deleteJobMaterial(materialUUID) {
    return this._request('DELETE', `/jobmaterial/${materialUUID}.json`);
  }

  attachFile(jobUUID, pdfBuffer, filename) {
    return new Promise((resolve, reject) => {
      const boundary = '----SM8Boundary' + Date.now().toString(16);
      const CRLF = '\r\n';
      const bodyParts = [];

      const addField = (name, value) => {
        bodyParts.push(Buffer.from(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`
        ));
      };
      addField('related_object_uuid', jobUUID);
      addField('related_object', 'job');

      bodyParts.push(Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}Content-Type: application/pdf${CRLF}${CRLF}`
      ));
      bodyParts.push(pdfBuffer);
      bodyParts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));

      const body = Buffer.concat(bodyParts);
      const options = {
        hostname: 'api.servicem8.com',
        path: '/api_1.0/attachment.json',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch (err) {
              console.error('ServiceM8 attachFile JSON parse error:', err.message, data);
              resolve({});
            }
          } else {
            reject(new Error(`ServiceM8 attach error ${res.statusCode}: ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  setJobQueue(jobUUID, queueUUID) {
    return this._request('POST', `/job/${jobUUID}.json`, { queue_uuid: queueUUID });
  }

  getJobContacts(jobUUID) {
    return this._request('GET', `/jobcontact.json?$filter=job_uuid eq '${encodeURIComponent(jobUUID)}'`);
  }

  addJobNote(jobUUID, note) {
    return this._request('POST', '/jobnote.json', {
      job_uuid: jobUUID,
      note,
      note_type: 'private',
    });
  }

  listQueues() {
    return this._request('GET', '/jobqueue.json');
  }
}

// ── Quotient ─────────────────────────────────────────────────────────────────

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

// ── JobQueue ─────────────────────────────────────────────────────────────────

const PARTS_TO_ORDER_QUEUE_UUID = process.env.SM8_PARTS_TO_ORDER_QUEUE_UUID || '';
const READY_TO_BOOK_QUEUE_UUID = process.env.SM8_READY_TO_BOOK_QUEUE_UUID || '';

class JobQueue {
  constructor(sm8Client) {
    this.sm8 = sm8Client;
  }

  async processAcceptedQuote(jobUUID, quote) {
    const existing = await this.sm8.getJobMaterials(jobUUID);
    const deleteResults = await Promise.allSettled(
      (existing || []).map((m) => this.sm8.deleteJobMaterial(m.uuid))
    );
    deleteResults
      .filter((r) => r.status === 'rejected')
      .forEach((r) => console.error('Failed to delete job material:', r.reason));

    const lineItems = quote.lineItems || [];
    const addResults = await Promise.allSettled(
      lineItems.map((item) =>
        this.sm8.addJobMaterial(jobUUID, {
          name: item.description || item.name,
          quantity: item.quantity || 1,
          unit_price: item.unit_price || item.unitPrice || 0,
          unit_cost: item.unit_cost || item.unitCost || 0,
          notes: item.notes || '',
          material_type: 'MATERIAL',
        })
      )
    );
    addResults
      .filter((r) => r.status === 'rejected')
      .forEach((r) => console.error('Failed to add job material:', r.reason));

    const needsParts = lineItems.some(
      (item) => (item.unit_cost || item.unitCost || 0) > 0
    );

    const queueUUID = needsParts ? PARTS_TO_ORDER_QUEUE_UUID : READY_TO_BOOK_QUEUE_UUID;
    const queueName = needsParts ? 'Parts to Order' : 'Ready to Book';

    if (queueUUID) {
      await this.sm8.setJobQueue(jobUUID, queueUUID);
    }

    return { lineItems, queueName };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACCEPTED_STATUSES = ['accepted', 'approved', 'won'];

function extractQuoteId(text) {
  if (!text) return null;
  const match = text.match(/\[quotient_quote_id:([^\]]+)\]/);
  return match ? match[1] : null;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPopup(bodyHtml) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://platform.servicem8.com/sdk/1.0/sdk.css">
  <script src="https://platform.servicem8.com/sdk/1.0/sdk.js"></script>
  <style>
    body { font-family: sans-serif; padding: 16px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 13px; }
    th { background: #f5f5f5; }
    .status-waiting { background: #fff8dc; padding: 12px; border-radius: 4px; color: #856404; }
    .status-ok { background: #d4edda; padding: 12px; border-radius: 4px; color: #155724; }
  </style>
</head>
<body>
${bodyHtml}
<script>
  var client = SMClient.init();
  client.resizeWindow(document.body.scrollWidth, document.body.scrollHeight);
</script>
</body>
</html>`;
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleOpenQuote(event) {
  const { uuid: jobUUID, company_id: companyId, job_description: jobDescription } = event;
  const sm8 = new ServiceM8(event.auth.accessToken);
  const quotient = new Quotient();

  let quoteId = extractQuoteId(jobDescription);

  if (!quoteId) {
    const [job, company, contacts] = await Promise.all([
      sm8.getJob(jobUUID),
      sm8.getCompany(companyId),
      sm8.getJobContacts(jobUUID),
    ]);

    const primaryContact = Array.isArray(contacts) ? contacts[0] : null;
    const customerEmail = (primaryContact && primaryContact.email) || company.email || '';
    const customerPhone = (primaryContact && primaryContact.phone) || company.phone || '';
    const customerName = (primaryContact && primaryContact.name) || company.name || '';

    const created = await quotient.createQuote({
      customerName,
      customerEmail,
      customerPhone,
      customerAddress: job.job_address || '',
      title: `Job: ${job.job_description || jobUUID}`,
      notes: job.job_description || '',
      reference: jobUUID,
    });

    quoteId = created.id;
    const marker = `[quotient_quote_id:${quoteId}]`;
    const desc = job.job_description ? `${job.job_description} ${marker}` : marker;
    await sm8.updateJob(jobUUID, { job_description: desc });
    await sm8.addJobNote(jobUUID, `Quotient quote created (ID: ${quoteId}). View: ${created.viewUrl}`);
  }

  const quote = await quotient.getQuote(quoteId);

  const html = renderPopup(`
    <h2>Quotient Quote</h2>
    <p><strong>Customer:</strong> ${escapeHtml(quote.customerName)}</p>
    <p><strong>Status:</strong> ${escapeHtml(quote.status)}</p>
    <p><strong>Total:</strong> ${quote.totalAmount != null ? '$' + Number(quote.totalAmount).toFixed(2) : 'N/A'}</p>
    <p><a href="${escapeHtml(quote.viewUrl)}" target="_blank">Edit in Quotient ↗</a></p>
    <button onclick="var c=SMClient.init();c.closeWindow();">Close</button>
  `);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: html,
  };
}

async function handleSyncStatus(event) {
  const { uuid: jobUUID, job_description: jobDescription } = event;
  const sm8 = new ServiceM8(event.auth.accessToken);
  const quotient = new Quotient();

  const quoteId = extractQuoteId(jobDescription);

  if (!quoteId) {
    const html = renderPopup(`
      <div class="status-waiting">
        <strong>No quote found.</strong> Use "Create / Open Quote" first.
      </div>
      <br><button onclick="var c=SMClient.init();c.closeWindow();">Close</button>
    `);
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: html };
  }

  const quote = await quotient.getQuote(quoteId);

  if (!ACCEPTED_STATUSES.includes((quote.status || '').toLowerCase())) {
    const html = renderPopup(`
      <div class="status-waiting">
        ⏳ Quote is <strong>${escapeHtml(quote.status)}</strong> — waiting for customer acceptance.
      </div>
      <p><a href="${escapeHtml(quote.viewUrl)}" target="_blank">View in Quotient ↗</a></p>
      <button onclick="var c=SMClient.init();c.closeWindow();">Close</button>
    `);
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: html };
  }

  const pdfBuffer = await quotient.getSignedQuotePDF(quoteId);
  await sm8.attachFile(jobUUID, pdfBuffer, `quote-${quoteId}-signed.pdf`);

  const jobQueue = new JobQueue(sm8);
  const { lineItems, queueName } = await jobQueue.processAcceptedQuote(jobUUID, quote);

  await sm8.addJobNote(
    jobUUID,
    `Quotient quote accepted. ${lineItems.length} line item(s) synced to billing. Job moved to "${queueName}". Quote ID: ${quoteId}.`
  );

  const rows = lineItems
    .map(
      (item) =>
        `<tr>
          <td>${escapeHtml(item.description || item.name || '')}</td>
          <td>${item.quantity || 1}</td>
          <td>$${Number(item.unit_price || item.unitPrice || 0).toFixed(2)}</td>
          <td>$${Number((item.quantity || 1) * (item.unit_price || item.unitPrice || 0)).toFixed(2)}</td>
        </tr>`
    )
    .join('');

  const html = renderPopup(`
    <div class="status-ok">
      ✅ Quote <strong>accepted</strong>. PDF attached, billing updated, job moved to <strong>${escapeHtml(queueName)}</strong>.
    </div>
    <table>
      <thead><tr><th>Description</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <br><button onclick="var c=SMClient.init();c.closeWindow();">Close</button>
  `);

  return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: html };
}

// ── Main handler ──────────────────────────────────────────────────────────────

async function handler(event) {
  try {
    const eventType = event.eventType || event.type || '';

    if (eventType === 'quotient_open_quote') {
      return await handleOpenQuote(event);
    }

    if (eventType === 'quotient_sync_status') {
      return await handleSyncStatus(event);
    }

    return { statusCode: 400, body: `Unknown event type: ${eventType}` };
  } catch (err) {
    console.error('Handler error:', err);
    return { statusCode: 500, body: `Internal error: ${err.message}` };
  }
}

module.exports = { handler, extractQuoteId, escapeHtml };
