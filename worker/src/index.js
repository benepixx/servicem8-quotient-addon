/**
 * Quotient -> ServiceM8 Cloudflare Worker
 *
 * REQUIRED Cloudflare env vars:
 *   - SM8_API_KEY
 *
 * For PDF attachment (Quotient often sends quote_url like "/q/..."):
 *   - QUOTIENT_BASE_URL   (e.g. https://go.quotientapp.com)
 *
 * NOTE: This Worker will ALSO accept these aliases (to avoid naming mismatches):
 *   - QUOTIENT_BASEURL
 *   - QUOTIENT_URL
 *
 * OPTIONAL env vars:
 *   - SM8_AWAITING_ACCEPTANCE_QUEUE_NAME   (default: "Awaiting Acceptance")
 *   - SM8_ACCEPTED_QUEUE_NAME              (default: "Invoicing/Administration")
 *
 * Webhook endpoint:
 *   POST /webhook
 *
 * Behaviour:
 *   - quote_sent:
 *       - move job to Awaiting Acceptance queue
 *       - attach the quote PDF to the job (best-effort)
 *       - add a job note (best-effort; falls back to .txt attachment if notes blocked)
 *   - quote_accepted:
 *       - attach the quote PDF AGAIN (so the signed version is captured)
 *       - change job status to "Work Order"
 *       - add ALL accepted quote items to billing WITHOUT deleting existing items
 *         - ensures each line has an Item Code by creating/finding a ServiceM8 Material (material.item_number)
 *         - crops fields if needed
 *       - move job to Invoicing/Administration queue
 *       - add a job note (best-effort; falls back to .txt attachment if notes blocked)
 *   - customer_viewed_quote (aka "client viewed quote"):
 *       - add a job note (best-effort; falls back to .txt attachment if notes blocked)
 *
 * Important:
 *   - Quotient can report webhook errors if your endpoint is slow.
 *     This Worker ACKs immediately (200 OK) and does SM8 work in the background via ctx.waitUntil().
 */

const SM8_API = 'https://api.servicem8.com/api_1.0';

/* -------------------------
   Small helpers
-------------------------- */

export function extractJobNumber(title) {
  if (!title) return null;
  const match = String(title).match(/#?(\d+)/);
  return match ? match[1] : null;
}

function safeStr(v) {
  return v === undefined || v === null ? '' : String(v);
}

function isAbsoluteUrl(u) {
  return typeof u === 'string' && (u.startsWith('https://') || u.startsWith('http://'));
}

function normaliseBaseUrl(u) {
  const s = safeStr(u).trim();
  if (!s) return '';
  return s.replace(/\/+$/, '');
}

function getQuotientBaseUrl(env) {
  const base = env?.QUOTIENT_BASE_URL ?? env?.QUOTIENT_BASEURL ?? env?.QUOTIENT_URL ?? '';
  return normaliseBaseUrl(base);
}

function buildFullQuoteUrl(payload, env) {
  const q = payload?.quote_url;
  if (!q) throw new Error('No quote_url in payload');
  if (isAbsoluteUrl(q)) return q;

  const base = getQuotientBaseUrl(env);
  if (!base) {
    throw new Error(
      'quote_url is relative but QUOTIENT_BASE_URL is not set (e.g. https://youraccount.quotientapp.com)'
    );
  }

  return new URL(q, base).toString();
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickFirstNonEmpty(...vals) {
  for (const v of vals) {
    const s = safeStr(v).trim();
    if (s) return s;
  }
  return '';
}

function truncate(s, max = 240) {
  const t = safeStr(s);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function moneyStr(n, dp = 2) {
  const x = Number(n);
  const v = Number.isFinite(x) ? x : 0;
  return v.toFixed(dp);
}

function clampStr(s, maxLen) {
  const t = safeStr(s);
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function normaliseSpaces(s) {
  return safeStr(s).replace(/\s+/g, ' ').trim();
}

function shortCodeFromHeading(heading) {
  // Build a human-ish shorthand code, <= 30 chars (SM8 material.item_number limit in docs)
  // Example: "Ajax Systems Street Siren c/w Brandplate Black/White"
  // -> "AJAX-STREET-SIREN"
  const h = normaliseSpaces(heading).toUpperCase();
  if (!h) return 'ITEM';

  // Remove punctuation that tends to cause issues in codes
  const cleaned = h.replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Drop common filler words
  const stop = new Set(['THE', 'AND', 'WITH', 'C/W', 'CW', 'OF', 'FOR', 'A', 'AN', 'TO', 'IN', 'ON', 'AT']);
  const parts = cleaned
    .split(' ')
    .filter(Boolean)
    .filter((p) => !stop.has(p))
    .map((p) => (p.length > 10 ? p.slice(0, 10) : p));

  const joined = parts.join('-') || cleaned.replace(/\s+/g, '-');
  const compact = joined.replace(/-+/g, '-').replace(/^-+|-+$/g, '');

  return clampStr(compact || 'ITEM', 30);
}

function hashSuffix(str) {
  // tiny deterministic suffix for uniqueness without crypto libs
  const s = safeStr(str);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // base36, 4 chars
  return (h >>> 0).toString(36).slice(0, 4).toUpperCase();
}

function normaliseItemKey(materialUUID, itemNumber, qty, unitPrice) {
  // De-dupe key (avoid duplicates if Quotient retries)
  return `${safeStr(materialUUID)}|${safeStr(itemNumber)}|${safeStr(qty)}|${safeStr(unitPrice)}`;
}

/* -------------------------
   ServiceM8 low-level request
-------------------------- */

async function sm8Fetch(method, path, body, apiKey, extraHeaders) {
  const url = `${SM8_API}${path}`;

  const headers = {
    'X-Api-Key': apiKey,
    Accept: 'application/json',
    ...(extraHeaders || {}),
  };

  const options = { method, headers };

  if (body !== null && body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const text = await res.text();
  return { res, text };
}

async function sm8Request(method, path, body, apiKey, extraHeaders) {
  const { res, text } = await sm8Fetch(method, path, body, apiKey, extraHeaders);

  if (!res.ok) {
    throw new Error(`SM8 API error ${res.status}: ${text}`);
  }

  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/* -------------------------
   ServiceM8: Jobs / Queues
-------------------------- */

async function findJobByNumber(jobNumber, apiKey) {
  const filter = encodeURIComponent(`generated_job_id eq '${jobNumber}'`);
  const data = await sm8Request('GET', `/job.json?$filter=${filter}`, null, apiKey);
  return Array.isArray(data) ? data[0] : null;
}

async function updateJob(jobUUID, fields, apiKey) {
  return sm8Request('POST', `/job/${jobUUID}.json`, fields, apiKey);
}

async function setJobQueue(jobUUID, queueUUID, apiKey) {
  return updateJob(jobUUID, { queue_uuid: queueUUID }, apiKey);
}

async function findQueueByName(name, apiKey) {
  const queues = await sm8Request('GET', '/jobqueue.json', null, apiKey);
  if (!Array.isArray(queues)) return null;
  return queues.find((q) => q && q.name === name) || null;
}

async function moveJobToQueueByName(jobUUID, queueName, apiKey) {
  const q = await findQueueByName(queueName, apiKey);
  if (!q) return { ok: false, message: `Queue "${queueName}" not found in ServiceM8.` };
  await setJobQueue(jobUUID, q.uuid, apiKey);
  return { ok: true, message: `Job moved to "${queueName}".` };
}

/* -------------------------
   ServiceM8: Materials catalogue (for Item Codes)
   We create/find a Material and then reference it via jobmaterial.material_uuid so the "Item Code"
   column is populated (material.item_number).
-------------------------- */

async function findMaterialByItemNumber(itemNumber, apiKey) {
  const code = safeStr(itemNumber).trim();
  if (!code) return null;

  const filter = encodeURIComponent(`item_number eq '${code.replace(/'/g, "\\'")}'`);
  const data = await sm8Request('GET', `/material.json?$filter=${filter}`, null, apiKey);
  return Array.isArray(data) ? data[0] : null;
}

async function createMaterial(itemNumber, name, unitPrice, unitCost, apiKey) {
  // From SM8 docs snippets: material.name is required, item_number max length 30. Keep name short-ish.
  const payload = {
    name: clampStr(normaliseSpaces(name), 70),
    item_number: clampStr(normaliseSpaces(itemNumber), 30),
  };

  // Price/cost are helpful defaults when adding to job; safe to include.
  if (unitPrice !== null && unitPrice !== undefined) payload.price = moneyStr(unitPrice, 4);
  if (unitCost !== null && unitCost !== undefined) payload.cost = moneyStr(unitCost, 4);

  const { res, text } = await sm8Fetch('POST', '/material.json', payload, apiKey);
  if (!res.ok) throw new Error(`SM8 Material create failed ${res.status}: ${text}`);

  // Some endpoints return created record; others just OK. We’ll try to re-fetch by item_number.
  const created = (() => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  })();

  if (created && created.uuid) return created;

  const fetched = await findMaterialByItemNumber(payload.item_number, apiKey);
  if (!fetched) throw new Error('Material created but could not be re-fetched by item_number.');
  return fetched;
}

async function getOrCreateMaterialForQuoteItem(item, apiKey) {
  const heading = pickFirstNonEmpty(item?.heading, item?.description, 'Quote item');
  const providedCode = normaliseSpaces(item?.item_code);

  // SM8 material item_number must be unique. If providedCode is long/unsafe, sanitise + crop.
  const baseCodeRaw = providedCode || shortCodeFromHeading(heading);
  const baseCodeClean = baseCodeRaw
    .toUpperCase()
    .replace(/[^A-Z0-9\- _]/g, '') // keep simple
    .replace(/\s+/g, '-')
    .replace(/_+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  const baseCode = clampStr(baseCodeClean || 'ITEM', 30);

  const qty = Math.max(1, toNumber(item?.quantity, 1));
  const unitPrice = Math.max(0, toNumber(item?.unit_price, 0));
  const unitCost = Math.max(0, toNumber(item?.cost_price, 0));

  // 1) try base code
  let mat = await findMaterialByItemNumber(baseCode, apiKey);
  if (mat) return { material: mat, itemNumber: baseCode };

  // 2) create base code
  try {
    mat = await createMaterial(baseCode, heading, unitPrice, unitCost, apiKey);
    return { material: mat, itemNumber: baseCode };
  } catch (e) {
    console.warn('Material create failed for base code, will try with suffix:', e?.message || e);
  }

  // 3) try with short hash suffix (ensure <= 30)
  const suf = hashSuffix(`${baseCode}|${heading}|${unitPrice}|${qty}`);
  const trimmed = clampStr(baseCode.slice(0, Math.max(1, 30 - (suf.length + 1))), 30);
  const altCode = clampStr(`${trimmed}-${suf}`, 30);

  mat = await findMaterialByItemNumber(altCode, apiKey);
  if (mat) return { material: mat, itemNumber: altCode };

  mat = await createMaterial(altCode, heading, unitPrice, unitCost, apiKey);
  return { material: mat, itemNumber: altCode };
}

/* -------------------------
   ServiceM8: Job Materials (billing line items)
   Key points:
   - DO NOT delete existing items.
   - Add accepted quote items.
   - Include Item Code by attaching a material_uuid (from Materials catalogue).
   - Use UNIT price fields (SM8 validates displayed_amount as a unit price).
-------------------------- */

async function listJobMaterials(jobUUID, apiKey) {
  const materials = await sm8Request(
    'GET',
    `/jobmaterial.json?$filter=job_uuid eq '${jobUUID}'`,
    null,
    apiKey
  );
  return Array.isArray(materials) ? materials : [];
}

async function addAcceptedQuoteItemsToBilling(jobUUID, quoteItems, apiKey) {
  const items = Array.isArray(quoteItems) ? quoteItems : [];
  if (items.length === 0) return { added: 0, skipped: 0, failed: 0, firstError: '' };

  const existing = await listJobMaterials(jobUUID, apiKey);

  // Build a de-dupe set using material_uuid (if present) plus qty + unit displayed amount.
  const existingKeys = new Set(
    existing.map((m) =>
      normaliseItemKey(
        m?.material_uuid || '',
        m?.material_uuid ? '' : (m?.name || ''),
        m?.quantity || '',
        m?.displayed_amount || m?.price || ''
      )
    )
  );

  let added = 0;
  let skipped = 0;
  let failed = 0;
  let firstError = '';

  for (const item of items) {
    const heading = pickFirstNonEmpty(item?.heading, item?.description, 'Quote item');
    const description = safeStr(item?.description).trim();
    const qtyNum = Math.max(1, toNumber(item?.quantity, 1));

    // UNIT PRICE (not total)
    const unitPriceNum = Math.max(0, toNumber(item?.unit_price, 0));
    const unitCostNum = Math.max(0, toNumber(item?.cost_price, 0));

    // SM8 uses strings; quantity is decimal(4) style often
    const quantity = moneyStr(qtyNum, 4);
    const unitPriceStr = moneyStr(unitPriceNum, 4);
    const unitCostStr = moneyStr(unitCostNum, 4);

    // Quotient payload is tax-exclusive -> displayed is tax-exclusive
    const displayed_amount = unitPriceStr;
    const displayed_amount_is_tax_inclusive = '0';

    // Ensure item code: use/create a ServiceM8 Material and reference by UUID
    let materialUUID = '';
    let itemNumber = '';
    try {
      const { material, itemNumber: code } = await getOrCreateMaterialForQuoteItem(item, apiKey);
      materialUUID = material?.uuid || '';
      itemNumber = code || '';
    } catch (e) {
      console.warn('Material lookup/create failed; falling back to name-only jobmaterial:', e?.message || e);
    }

    // Crop “name” if we’re forced to use it; material.name is more constrained than jobmaterial.name.
    const jobMaterialName = clampStr(normaliseSpaces(heading), 500);

    const key = normaliseItemKey(materialUUID || '', itemNumber || jobMaterialName, quantity, displayed_amount);
    if (existingKeys.has(key)) {
      skipped += 1;
      continue;
    }

    const payload = {
      active: 1,
      job_uuid: jobUUID,
      quantity,
      price: unitPriceStr,
      displayed_amount,
      displayed_amount_is_tax_inclusive,
    };

    if (materialUUID) {
      payload.material_uuid = materialUUID;
      // name can still be supplied, but material_uuid will populate the item code column.
      payload.name = clampStr(normaliseSpaces(heading), 500);
    } else {
      // No material_uuid (no item code column), but at least prefix the heading with our best code
      const fallbackCode = normaliseSpaces(item?.item_code) || shortCodeFromHeading(heading);
      payload.name = clampStr(`[${clampStr(fallbackCode, 30)}] ${normaliseSpaces(heading)}`, 500);
    }

    if (unitCostNum > 0) {
      payload.cost = unitCostStr;
      payload.displayed_cost = unitCostStr;
    }

    // Notes can get long; keep concise to avoid UI/export limits in downstream systems.
    if (description) payload.notes = clampStr(description, 255);

    try {
      const { res, text } = await sm8Fetch('POST', '/jobmaterial.json', payload, apiKey);
      if (!res.ok) {
        const msg = `SM8 JobMaterial create failed ${res.status}: ${text}`;
        console.warn(msg, { payload });
        failed += 1;
        if (!firstError) firstError = msg;
      } else {
        added += 1;
        existingKeys.add(key);
      }
    } catch (e) {
      const msg = safeStr(e?.message || e);
      console.warn('SM8 JobMaterial create exception:', msg, { payload });
      failed += 1;
      if (!firstError) firstError = msg;
    }
  }

  return { added, skipped, failed, firstError };
}

/* -------------------------
   ServiceM8: Notes (with fallback)
-------------------------- */

async function sm8CreateAttachment(jobUUID, filename, fileTypeExt, apiKey) {
  const { res, text } = await sm8Fetch(
    'POST',
    '/attachment.json',
    {
      related_object: 'job',
      related_object_uuid: jobUUID,
      attachment_name: filename,
      file_type: fileTypeExt || '',
      active: true,
    },
    apiKey
  );

  if (!res.ok) throw new Error(`SM8 attachment create failed ${res.status}: ${text}`);

  const attachmentUUID = res.headers.get('x-record-uuid');
  if (!attachmentUUID) throw new Error(`Missing x-record-uuid from SM8. Body: ${text}`);

  return attachmentUUID;
}

async function sm8UploadAttachmentFile(attachmentUUID, filename, bytes, mimeType, apiKey) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType || 'application/octet-stream' }), filename);

  const url = `${SM8_API}/Attachment/${attachmentUUID}.file`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      Accept: 'application/json',
    },
    body: form,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`SM8 attachment upload failed ${res.status}: ${text}`);
}

async function sm8AttachBytesToJob(jobUUID, filename, bytes, mimeType, apiKey) {
  const ext = (() => {
    const m = safeStr(filename).toLowerCase().match(/(\.[a-z0-9]+)$/);
    return m ? m[1] : '';
  })();

  const attachmentUUID = await sm8CreateAttachment(jobUUID, filename, ext, apiKey);
  await sm8UploadAttachmentFile(attachmentUUID, filename, bytes, mimeType, apiKey);
  return attachmentUUID;
}

async function addJobNote(jobUUID, note, apiKey) {
  const noteText = safeStr(note).trim();
  if (!noteText) return { ok: false, message: 'Empty note; skipped.' };

  try {
    await sm8Request(
      'POST',
      '/note.json',
      {
        related_object: 'job',
        related_object_uuid: jobUUID,
        note: noteText,
      },
      apiKey
    );
    return { ok: true, message: 'Job note added.' };
  } catch (err) {
    const msg = safeStr(err?.message || err);
    console.warn('SM8 note create failed:', msg);

    try {
      const filename = `Quotient Note (${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}).txt`;
      await sm8AttachBytesToJob(jobUUID, filename, new TextEncoder().encode(noteText), 'text/plain', apiKey);
      return { ok: true, message: 'Job note endpoint blocked; added as text attachment instead.' };
    } catch (fallbackErr) {
      const fbMsg = safeStr(fallbackErr?.message || fallbackErr);
      console.warn('SM8 note fallback attachment failed:', fbMsg);
      return { ok: false, message: `Could not add job note (and fallback failed): ${msg}` };
    }
  }
}

/* -------------------------
   Quotient PDF download (robust)
-------------------------- */

function pickPdfLinkFromHtml(html, baseUrl) {
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  const candidates = [];
  let m;

  while ((m = hrefRe.exec(html)) !== null) {
    const href = m[1];
    if (!href) continue;
    const lower = href.toLowerCase();

    if (lower.includes('pdf') || lower.includes('print') || lower.includes('download')) {
      try {
        candidates.push(new URL(href, baseUrl).toString());
      } catch {}
    }
  }

  const direct =
    candidates.find((u) => u.toLowerCase().endsWith('.pdf')) ||
    candidates.find((u) => u.toLowerCase().includes('pdf')) ||
    candidates[0];

  return direct || null;
}

async function tryDownloadPdfAtUrl(url) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
    },
  });

  if (!res.ok) return null;

  const contentType = safeStr(res.headers.get('content-type')).toLowerCase();
  const bytes = await res.arrayBuffer();

  const u8 = new Uint8Array(bytes);
  const isPdfByMagic =
    u8.length >= 4 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46;
  const isPdfByHeader = contentType.includes('application/pdf');

  if (isPdfByHeader || isPdfByMagic) return { bytes, contentType: contentType || 'application/pdf' };
  return null;
}

async function downloadQuotientPdf(payload, env) {
  const quoteUrl = buildFullQuoteUrl(payload, env);

  const patternUrls = [
    `${quoteUrl}.pdf`,
    `${quoteUrl}/pdf`,
    `${quoteUrl}?format=pdf`,
    `${quoteUrl}?pdf=1`,
    `${quoteUrl}?download=pdf`,
    `${quoteUrl}?print=pdf`,
  ];

  for (const u of patternUrls) {
    try {
      const got = await tryDownloadPdfAtUrl(u);
      if (got) return { pdfUrl: u, bytes: got.bytes };
    } catch {}
  }

  const pageRes = await fetch(quoteUrl, { method: 'GET' });
  if (!pageRes.ok) throw new Error(`Failed to fetch quote page ${pageRes.status}`);
  const html = await pageRes.text();

  const pdfUrl = pickPdfLinkFromHtml(html, quoteUrl);
  if (!pdfUrl) {
    throw new Error(
      'Could not find a PDF download link on the quote page. Ensure “Enable Print PDF downloads” is enabled in Quotient.'
    );
  }

  const got = await tryDownloadPdfAtUrl(pdfUrl);
  if (!got) throw new Error(`Found a likely PDF link but it did not download as a PDF: ${pdfUrl}`);

  return { pdfUrl, bytes: got.bytes };
}

async function attachQuotePdfToJob(jobUUID, payload, env, apiKey, variant) {
  const quoteNumber = payload?.quote_number ?? 'unknown';
  const baseName = `Quotient Quote #${quoteNumber}`;
  const filename =
    variant === 'accepted'
      ? `${baseName} (Signed).pdf`
      : `${baseName}.pdf`;

  const { pdfUrl, bytes } = await downloadQuotientPdf(payload, env);
  console.log('Quotient PDF downloaded:', pdfUrl, 'bytes:', bytes.byteLength);

  const attachmentUUID = await sm8AttachBytesToJob(jobUUID, filename, bytes, 'application/pdf', apiKey);
  return attachmentUUID;
}

/* -------------------------
   Background processing
-------------------------- */

async function processWebhook(payload, env) {
  const apiKey = env?.SM8_API_KEY;
  if (!apiKey) throw new Error('Missing SM8_API_KEY secret');

  const eventName = payload?.event_name;
  const quoteNumber = payload?.quote_number;

  console.log('Processing event:', eventName, 'quote:', quoteNumber);

  const jobNumber = extractJobNumber(payload?.title);
  if (!jobNumber) throw new Error('Could not extract job number from quote title');

  const job = await findJobByNumber(jobNumber, apiKey);
  if (!job) throw new Error(`No SM8 job found for job number ${jobNumber}`);

  const jobUUID = job.uuid;

  if (eventName === 'quote_sent') {
    const awaitingName = env?.SM8_AWAITING_ACCEPTANCE_QUEUE_NAME || 'Awaiting Acceptance';

    let moveMsg = '';
    try {
      const move = await moveJobToQueueByName(jobUUID, awaitingName, apiKey);
      moveMsg = move.message;
    } catch (e) {
      console.warn('Queue move failed:', e?.message || e);
      moveMsg = 'Queue move failed — see Worker logs.';
    }

    let pdfMsg = '';
    try {
      await attachQuotePdfToJob(jobUUID, payload, env, apiKey, 'sent');
      pdfMsg = 'Quote PDF attached to job.';
    } catch (e) {
      console.warn('PDF attach failed:', e?.message || e);
      pdfMsg = `Quote PDF could not be attached — ${truncate(e?.message || e)}`;
    }

    const noteText = `Quotient quote #${quoteNumber} has been sent to the customer. ${moveMsg} ${pdfMsg}`;
    const noteRes = await addJobNote(jobUUID, noteText, apiKey);
    if (!noteRes.ok) console.warn('Note result:', noteRes.message);

    return;
  }

  if (eventName === 'quote_accepted') {
    // 0) Re-upload the PDF to capture the signed version
    let signedPdfMsg = '';
    try {
      await attachQuotePdfToJob(jobUUID, payload, env, apiKey, 'accepted');
      signedPdfMsg = 'Signed quote PDF attached to job.';
    } catch (e) {
      console.warn('Signed PDF attach failed:', e?.message || e);
      signedPdfMsg = `Signed PDF could not be attached — ${truncate(e?.message || e)}`;
    }

    // 1) Change job status from Quote -> Work Order
    let statusMsg = '';
    try {
      await updateJob(jobUUID, { status: 'Work Order' }, apiKey);
      statusMsg = 'Job status set to "Work Order".';
    } catch (e) {
      console.warn('Job status update failed:', e?.message || e);
      statusMsg = `Job status update failed — ${truncate(e?.message || e)}`;
    }

    // 2) Add items to billing (with item codes via Materials catalogue)
    let billingMsg = '';
    try {
      const { added, skipped, failed, firstError } = await addAcceptedQuoteItemsToBilling(
        jobUUID,
        payload?.selected_items || [],
        apiKey
      );

      if (failed > 0) {
        billingMsg = `Billing updated from accepted quote (added ${added}, skipped ${skipped}, failed ${failed}). First error: ${truncate(firstError)}`;
      } else {
        billingMsg = `Billing updated from accepted quote (added ${added}, skipped ${skipped}).`;
      }
    } catch (e) {
      console.warn('Billing update failed:', e?.message || e);
      billingMsg = `Billing update failed — ${truncate(e?.message || e)}`;
    }

    // 3) Move job to Invoicing/Administration queue
    const acceptedQueueName = env?.SM8_ACCEPTED_QUEUE_NAME || 'Invoicing/Administration';
    let moveMsg = '';
    try {
      const move = await moveJobToQueueByName(jobUUID, acceptedQueueName, apiKey);
      moveMsg = move.message;
    } catch (e) {
      console.warn('Accepted queue move failed:', e?.message || e);
      moveMsg = `Queue move failed — ${truncate(e?.message || e)}`;
    }

    // 4) Add note (best-effort)
    const noteText = `Quotient quote #${quoteNumber} was accepted. ${signedPdfMsg} ${statusMsg} ${billingMsg} ${moveMsg}`;
    const noteRes = await addJobNote(jobUUID, noteText, apiKey);
    if (!noteRes.ok) console.warn('Note result:', noteRes.message);

    return;
  }

  if (
    eventName === 'customer_viewed_quote' ||
    eventName === 'client_viewed_quote' ||
    eventName === 'client viewed quote'
  ) {
    const who =
      payload?.quote_for?.name_first || payload?.quote_for?.name_last
        ? `${safeStr(payload?.quote_for?.name_first)} ${safeStr(payload?.quote_for?.name_last)}`.trim()
        : safeStr(payload?.for).trim();

    const when = safeStr(payload?.viewed_when || payload?.when || payload?.viewed_at).trim();

    const viewedMsg = when
      ? `Customer viewed Quotient quote #${quoteNumber} (${who}) at ${when}.`
      : `Customer viewed Quotient quote #${quoteNumber} (${who}).`;

    const noteRes = await addJobNote(jobUUID, viewedMsg, apiKey);
    if (!noteRes.ok) console.warn('Note result:', noteRes.message);

    return;
  }

  if (eventName === 'customer_asked_question') {
    const question = payload?.question || payload?.message || '';
    const note = question
      ? `Customer asked a question on Quotient quote #${quoteNumber}: ${question}`
      : `Customer asked a question on Quotient quote #${quoteNumber}.`;
    const noteRes = await addJobNote(jobUUID, note, apiKey);
    if (!noteRes.ok) console.warn('Note result:', noteRes.message);
    return;
  }

  if (eventName === 'quote_declined') {
    const noteRes = await addJobNote(jobUUID, `Quotient quote #${quoteNumber} was declined.`, apiKey);
    if (!noteRes.ok) console.warn('Note result:', noteRes.message);
    return;
  }

  if (eventName === 'quote_completed') {
    const noteRes = await addJobNote(jobUUID, `Quotient quote #${quoteNumber} is completed.`, apiKey);
    if (!noteRes.ok) console.warn('Note result:', noteRes.message);
    return;
  }

  console.log('Unhandled Quotient event_name:', eventName);
}

/* -------------------------
   Worker entrypoint
-------------------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/webhook') {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }

      ctx.waitUntil(
        (async () => {
          try {
            await processWebhook(payload, env);
          } catch (err) {
            console.error('Background processing error:', err);
          }
        })()
      );

      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },
};
