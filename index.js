'use strict';

const ServiceM8 = require('./lib/servicem8');
const Quotient = require('./lib/quotient');
const JobQueue = require('./lib/jobQueue');

const ACCEPTED_STATUSES = ['accepted', 'approved', 'won'];

/**
 * Parse [quotient_quote_id:XXX] marker from a job description string.
 * @param {string} text
 * @returns {string|null}
 */
function extractQuoteId(text) {
  if (!text) return null;
  const match = text.match(/\[quotient_quote_id:([^\]]+)\]/);
  return match ? match[1] : null;
}

/**
 * Render a minimal HTML popup using the ServiceM8 SDK.
 * @param {string} bodyHtml
 * @returns {string}
 */
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

/**
 * Handle a new job webhook — create a Quotient quote if none exists yet.
 */
async function handleJobWebhook(event) {
  const { uuid: jobUUID, company_id: companyId, job_description: jobDescription } = event;

  // Only act on new jobs (no existing quote marker)
  if (extractQuoteId(jobDescription)) {
    return { statusCode: 200, body: 'Quote already exists.' };
  }

  const sm8 = new ServiceM8(event.auth.accessToken);
  const quotient = new Quotient();

  const [job, company] = await Promise.all([
    sm8.getJob(jobUUID),
    sm8.getCompany(companyId),
  ]);

  const quote = await quotient.createQuote({
    customerName: company.name || '',
    customerEmail: company.email || '',
    customerPhone: company.phone || '',
    customerAddress: job.job_address || '',
    title: `Job: ${job.job_description || jobUUID}`,
    notes: job.job_description || '',
    reference: jobUUID,
  });

  const marker = `[quotient_quote_id:${quote.id}]`;
  const updatedDescription = jobDescription
    ? `${jobDescription} ${marker}`
    : marker;

  await sm8.updateJob(jobUUID, { job_description: updatedDescription });

  return { statusCode: 200, body: 'Quote created.' };
}

/**
 * Handle "Create / Open Quote" job action — show popup with quote details.
 */
async function handleOpenQuote(event) {
  const { uuid: jobUUID, company_id: companyId, job_description: jobDescription } = event;
  const sm8 = new ServiceM8(event.auth.accessToken);
  const quotient = new Quotient();

  let quoteId = extractQuoteId(jobDescription);

  if (!quoteId) {
    // Create a new quote
    const [job, company] = await Promise.all([
      sm8.getJob(jobUUID),
      sm8.getCompany(companyId),
    ]);

    const created = await quotient.createQuote({
      customerName: company.name || '',
      customerEmail: company.email || '',
      customerPhone: company.phone || '',
      customerAddress: job.job_address || '',
      title: `Job: ${job.job_description || jobUUID}`,
      notes: job.job_description || '',
      reference: jobUUID,
    });

    quoteId = created.id;
    const marker = `[quotient_quote_id:${quoteId}]`;
    const desc = job.job_description ? `${job.job_description} ${marker}` : marker;
    await sm8.updateJob(jobUUID, { job_description: desc });
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

/**
 * Handle "Sync Quote Status" job action — sync accepted quote to SM8.
 */
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

  // Quote accepted — attach PDF, sync line items, move queue
  const pdfBuffer = await quotient.getSignedQuotePDF(quoteId);
  await sm8.attachFile(jobUUID, pdfBuffer, `quote-${quoteId}-signed.pdf`);

  const jobQueue = new JobQueue(sm8);
  const { lineItems, queueName } = await jobQueue.processAcceptedQuote(jobUUID, quote);

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

/**
 * Escape HTML special characters.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Main Lambda / Simple Function handler.
 * @param {Object} event
 * @returns {Promise<Object>}
 */
async function handler(event) {
  try {
    const eventType = event.eventType || event.type || '';

    if (eventType === 'webhook' && event.object === 'job') {
      return await handleJobWebhook(event);
    }

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
