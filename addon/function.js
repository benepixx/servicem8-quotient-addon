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

  getCompany(uuid) {
    return this._request('GET', `/company/${uuid}.json`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    .title-box { background: #f0f4ff; border: 1px solid #c0d0ff; border-radius: 6px; padding: 12px 16px; margin: 12px 0; font-size: 18px; font-weight: bold; letter-spacing: 0.01em; }
    .info-box { background: #fff8dc; border: 1px solid #ffe58f; border-radius: 4px; padding: 12px; margin: 12px 0; font-size: 13px; color: #6b4f00; }
    .btn-open { display: inline-block; background: #0070f3; color: #fff; padding: 10px 20px; border-radius: 4px; text-decoration: none; font-size: 15px; font-weight: bold; margin-top: 12px; }
    .btn-close { display: inline-block; background: #f5f5f5; color: #333; border: 1px solid #ddd; padding: 8px 16px; border-radius: 4px; font-size: 14px; margin-top: 8px; cursor: pointer; }
    .meta { font-size: 13px; color: #555; margin: 4px 0; }
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
  const jobUUID = event.jobUUID;
  const companyUUID = event.companyUUID;
  const sm8 = new ServiceM8(event.auth.accessToken);

  const [job, company] = await Promise.all([
    sm8.getJob(jobUUID),
    sm8.getCompany(companyUUID),
  ]);

  const jobNumber = job.generated_job_id || '';
  const jobDescription = job.job_description || '';
  const customerName = company.name || '';
  const jobAddress = job.job_address || '';

  const suggestedTitle = jobNumber
    ? `#${jobNumber} \u2013 ${jobDescription}`.replace(/\s*\u2013\s*$/, '')
    : jobDescription;

  const html = renderPopup(`
    <h2>Create Quote in Quotient</h2>
    <p class="meta"><strong>Customer:</strong> ${escapeHtml(customerName)}</p>
    <p class="meta"><strong>Address:</strong> ${escapeHtml(jobAddress)}</p>
    <p style="margin-top:16px;margin-bottom:4px;"><strong>Suggested Quote Title:</strong></p>
    <div class="title-box">${escapeHtml(suggestedTitle)}</div>
    <div class="info-box">
      \uD83D\uDCCB Name your quote using the title above in Quotient.<br>
      When the customer accepts, this job will be updated automatically.
    </div>
    <a class="btn-open" href="https://app.quotientapp.com" target="_blank">Open Quotient \u2197</a>
    <br>
    <button class="btn-close" onclick="var c=SMClient.init();c.closeWindow();">Close</button>
  `);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: html,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

async function handler(event) {
  try {
    const eventType = event.eventType || event.type || '';

    if (eventType === 'quotient_open_quote') {
      return await handleOpenQuote(event);
    }

    return { statusCode: 400, body: `Unknown event type: ${eventType}` };
  } catch (err) {
    console.error('Handler error:', err);
    return { statusCode: 500, body: `Internal error: ${err.message}` };
  }
}

module.exports = { handler, escapeHtml };
