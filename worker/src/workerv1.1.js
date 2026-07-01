/**
 * Quotient -> ServiceM8 Cloudflare Worker (reliable, no waitUntil)
 *
 * REQUIRED Cloudflare env vars:
 *   - SM8_API_KEY
 *
 * For PDF attachment (Quotient sends quote_url like "/q/..."):
 *   - QUOTIENT_BASE_URL   (e.g. https://go.quotientapp.com)
 *
 * Aliases accepted:
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
 * Accepted quote billing behaviour:
 *   - Uses payload.selected_items for prices/quantities.
 *   - Fetches quote HTML to detect visible Quotient subtotal structure.
 *   - Creates one ServiceM8 billing line per material/equipment section subtotal BEFORE Services.
 *   - Uses the previous section heading as the ServiceM8 billing item name/description.
 *   - Keeps Services items line-for-line; it does NOT subtotal Services.
 *   - Adds idempotency markers so accepted webhook retries do not duplicate billing lines.
 */

const SM8_API = 'https://api.servicem8.com/api_1.0';

/* -------------------------
   Response helpers
-------------------------- */

function makeTextResponse(body, status = 200) {
  const finalStatus = Number.isInteger(status) && status >= 200 && status <= 599 ? status : 200;
  return new Response(safeStr(body), {
    status: finalStatus,
    headers: {
      'content-type': 'text/plain; charset=UTF-8',
      'cache-control': 'no-store',
    },
  });
}

async function finaliseResponse(response) {
  if (!(response instanceof Response)) {
    return makeTextResponse('OK', 200);
  }

  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }

  const status =
    Number.isInteger(response.status) && response.status >= 200 && response.status <= 599
      ? response.status
      : 200;

  return makeTextResponse(text || (status === 200 ? 'OK' : 'Response'), status);
}

/* -------------------------
   Helpers
-------------------------- */

export function extractJobNumber(title) {
  if (!title) return null;
  const matches = String(title).match(/#\s*(\d+)/g);
  if (matches && matches.length) {
    const last = matches[matches.length - 1];
    const m = last.match(/#\s*(\d+)/);
    return m ? m[1] : null;
  }
  return null;
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
      'quote_url is relative but QUOTIENT_BASE_URL is not set, for example https://go.quotientapp.com'
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
  return t.length > max ? `${t.slice(0, max)}...` : t;
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

function normaliseLookupText(s) {
  return safeStr(s)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMoneyValue(s) {
  const cleaned = safeStr(s)
    .replace(/£/g, '')
    .replace(/,/g, '')
    .replace(/[^\d.-]/g, '')
    .trim();

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function shortCodeFromHeading(heading) {
  const h = normaliseSpaces(heading).toUpperCase();
  if (!h) return 'ITEM';

  const cleaned = h.replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
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
  const s = safeStr(str);
  let h = 2166136261;

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return (h >>> 0).toString(36).slice(0, 4).toUpperCase();
}

function formatTimestampForNote(isoStr) {
  const s = safeStr(isoStr).trim();
  if (!s) return '';

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    day: 'numeric',
    month: 'long',
  }).format(d).replace(',', '');
}

function decodeHtmlEntities(str) {
  return safeStr(str)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtmlToText(html) {
  return decodeHtmlEntities(
    safeStr(html)
      .replace(/\r/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/section>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function normaliseForCompare(s) {
  return safeStr(s).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
}

function appendUniqueBlock(existing, heading, content) {
  const existingText = safeStr(existing).trim();
  const contentText = safeStr(content).trim();

  if (!contentText) return existingText;

  const block = `${heading}\n${contentText}`.trim();

  if (!existingText) return block;

  const existingNorm = normaliseForCompare(existingText).toLowerCase();
  const blockNorm = normaliseForCompare(block).toLowerCase();
  const contentNorm = normaliseForCompare(contentText).toLowerCase();

  if (existingNorm.includes(blockNorm) || existingNorm.includes(contentNorm)) {
    return existingText;
  }

  return `${existingText}\n\n${block}`;
}

/* -------------------------
   Fetch with timeout
-------------------------- */

async function fetchWithTimeout(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...(options || {}), signal: controller.signal });
    return res;
  } catch (e) {
    const msg =
      e && e.name === 'AbortError'
        ? `${label || 'fetch'} timed out after ${timeoutMs}ms`
        : `${label || 'fetch'} failed: ${safeStr(e?.message || e)}`;

    throw new Error(msg);
  } finally {
    clearTimeout(id);
  }
}

/* -------------------------
   ServiceM8 requests
-------------------------- */

async function sm8Fetch(method, path, body, apiKey, extraHeaders, timeoutMs = 12000) {
  const url = `${SM8_API}${path}`;

  const headers = {
    'X-API-Key': apiKey,
    Accept: 'application/json',
    ...(extraHeaders || {}),
  };

  const options = { method, headers };

  if (body !== null && body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const res = await fetchWithTimeout(url, options, timeoutMs, `SM8 ${method} ${path}`);
  const text = await res.text();

  return { res, text };
}

async function sm8Request(method, path, body, apiKey, extraHeaders, timeoutMs) {
  const { res, text } = await sm8Fetch(method, path, body, apiKey, extraHeaders, timeoutMs);

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
  const data = await sm8Request('GET', `/job.json?$filter=${filter}`, null, apiKey, null, 12000);
  return Array.isArray(data) ? data[0] : null;
}

async function updateJob(jobUUID, fields, apiKey) {
  return sm8Request('POST', `/job/${jobUUID}.json`, fields, apiKey, null, 12000);
}

async function findQueueByName(name, apiKey) {
  const queues = await sm8Request('GET', '/jobqueue.json', null, apiKey, null, 12000);

  if (!Array.isArray(queues)) return null;

  return queues.find((q) => q && q.name === name) || null;
}

async function moveJobToQueueByName(jobUUID, queueName, apiKey) {
  const q = await findQueueByName(queueName, apiKey);

  if (!q) {
    return { ok: false, message: `Queue "${queueName}" not found in ServiceM8.` };
  }

  await updateJob(jobUUID, { queue_uuid: q.uuid }, apiKey);

  return { ok: true, message: `Job moved to "${queueName}".` };
}

/* -------------------------
   Quotient HTML parsing
-------------------------- */

function findMatchingDivEnd(html, startIndex) {
  const divRegex = /<\/?div\b[^>]*>/gi;
  divRegex.lastIndex = startIndex;

  let depth = 0;
  let started = false;
  let match;

  while ((match = divRegex.exec(html)) !== null) {
    const tag = match[0];
    const isClosing = /^<\/div/i.test(tag);

    if (!started) {
      started = true;
      depth = 1;
      continue;
    }

    if (isClosing) {
      depth -= 1;

      if (depth === 0) {
        return divRegex.lastIndex;
      }
    } else {
      depth += 1;
    }
  }

  return -1;
}

function extractScopeOfWorksFromHtml(html) {
  const src = safeStr(html);
  if (!src) return '';

  const blockRegex = /<div[^>]*class="[^"]*\btItem-text\b[^"]*\btItemId-\d+\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi;
  let match;

  while ((match = blockRegex.exec(src)) !== null) {
    const blockHtml = match[0];
    const blockText = stripHtmlToText(blockHtml);

    if (!/scope\s+of\s+works?/i.test(blockText)) continue;

    const classMatch = blockHtml.match(/\btItemId-(\d+)\b/i);

    if (classMatch) {
      const itemId = classMatch[1];
      const parentRegex = new RegExp(
        `<div[^>]*class="[^"]*\\btItemId-${itemId}\\b[^"]*"[^>]*>`,
        'i'
      );

      const beforeBlock = src.slice(0, match.index + blockHtml.length);
      const allParents = [...beforeBlock.matchAll(new RegExp(parentRegex.source, 'gi'))];

      if (allParents.length) {
        const lastParent = allParents[allParents.length - 1];
        const startIndex = lastParent.index;
        const endIndex = findMatchingDivEnd(src, startIndex);

        if (startIndex >= 0 && endIndex > startIndex) {
          const containerHtml = src.slice(startIndex, endIndex);
          let text = stripHtmlToText(containerHtml);

          const lines = text.split('\n').map((l) => l.trimEnd());
          const headingIndex = lines.findIndex((l) => /^scope\s+of\s+works?$/i.test(l.trim()));

          if (headingIndex >= 0) {
            text = lines.slice(headingIndex + 1).join('\n').replace(/\n{3,}/g, '\n\n').trim();
          }

          if (text) return text;
        }
      }
    }

    const lines = blockText.split('\n').map((l) => l.trimEnd());
    const headingIndex = lines.findIndex((l) => /^scope\s+of\s+works?$/i.test(l.trim()));

    const text =
      headingIndex >= 0
        ? lines.slice(headingIndex + 1).join('\n').replace(/\n{3,}/g, '\n\n').trim()
        : blockText.trim();

    if (text) return text;
  }

  return '';
}

async function appendScopeOfWorksToJobDescription(job, payload, env, apiKey) {
  const quoteUrl = buildFullQuoteUrl(payload, env);

  const pageRes = await fetchWithTimeout(
    quoteUrl,
    { method: 'GET' },
    12000,
    `Quotient fetch page ${quoteUrl}`
  );

  if (!pageRes.ok) {
    throw new Error(`Failed to fetch quote page ${pageRes.status}`);
  }

  const html = await pageRes.text();
  const scopeText = extractScopeOfWorksFromHtml(html);

  if (!scopeText) {
    return { updated: false, message: 'No "Scope of Works" section found on quote.' };
  }

  const existingDescription = safeStr(job?.job_description || job?.description || '');
  const newDescription = appendUniqueBlock(existingDescription, 'Scope of Works', scopeText);

  if (newDescription === existingDescription) {
    return { updated: false, message: 'Scope of Works already present in job description.' };
  }

  await updateJob(job.uuid, { job_description: newDescription }, apiKey);

  return { updated: true, message: 'Scope of Works appended to job description.' };
}

async function fetchQuoteHtmlForStructure(payload, env) {
  const quoteUrl = buildFullQuoteUrl(payload, env);

  const pageRes = await fetchWithTimeout(
    quoteUrl,
    { method: 'GET' },
    12000,
    `Quotient fetch page ${quoteUrl}`
  );

  if (!pageRes.ok) {
    throw new Error(`Failed to fetch quote page for structure ${pageRes.status}`);
  }

  return await pageRes.text();
}

function findSubtotalLinesFromPlainText(plainText) {
  const rawLines = safeStr(plainText)
    .split('\n')
    .map((l) => normaliseSpaces(l))
    .filter(Boolean);

  const subtotals = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    const sameLine = line.match(/^Subtotal\s+(-?£?\d[\d,]*\.\d{2})$/i);

    if (sameLine) {
      subtotals.push({
        lineIndex: i,
        amount: parseMoneyValue(sameLine[1]),
        raw: line,
      });
      continue;
    }

    if (/^Subtotal$/i.test(line)) {
      const next = rawLines[i + 1] || '';
      const amount = parseMoneyValue(next);

      if (amount !== null) {
        subtotals.push({
          lineIndex: i,
          amount,
          raw: `${line} ${next}`,
        });
      }
    }
  }

  return { lines: rawLines, subtotals };
}

function findItemPositionsInQuoteText(items, lines) {
  const positions = [];
  let cursor = 0;

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    const heading = normaliseLookupText(item?.heading);
    const description = normaliseLookupText(item?.description);

    if (!heading && !description) {
      positions.push({ itemIndex, lineIndex: cursor, item });
      continue;
    }

    let found = -1;

    for (let i = cursor; i < lines.length; i++) {
      const lineNorm = normaliseLookupText(lines[i]);

      if (heading && lineNorm === heading) {
        found = i;
        break;
      }

      if (heading && lineNorm.includes(heading)) {
        found = i;
        break;
      }

      if (description && description.length > 20 && lineNorm.includes(description.slice(0, 40))) {
        found = i;
        break;
      }
    }

    if (found < 0) {
      found = cursor;
    }

    positions.push({ itemIndex, lineIndex: found, item });
    cursor = found + 1;
  }

  return positions;
}

function isMoneyOnlyLine(line) {
  return /^-?£?\d[\d,]*\.\d{2}$/i.test(normaliseSpaces(line));
}

function isIgnoredSectionTitleCandidate(line) {
  const l = normaliseSpaces(line);

  if (!l) return true;
  if (/^subtotal\b/i.test(l)) return true;
  if (/^total\b/i.test(l)) return true;
  if (/^vat\b/i.test(l)) return true;
  if (/^discount\b/i.test(l)) return true;
  if (/^services?$/i.test(l)) return true;
  if (/^scope\s+of\s+works?/i.test(l)) return true;
  if (/^the services associated/i.test(l)) return true;
  if (/^prepared for\b/i.test(l)) return true;
  if (/^proposal number\b/i.test(l)) return true;
  if (/^address$/i.test(l)) return true;
  if (/^phone website$/i.test(l)) return true;
  if (/^company number vat number$/i.test(l)) return true;
  if (/^x\s+\d+/i.test(l)) return true;
  if (isMoneyOnlyLine(l)) return true;

  return false;
}

function findSectionTitleForGroup(lines, previousSubtotalLineIndex, firstItemLineIndex) {
  for (let i = firstItemLineIndex - 1; i > previousSubtotalLineIndex; i--) {
    const candidate = normaliseSpaces(lines[i]);

    if (isIgnoredSectionTitleCandidate(candidate)) continue;
    if (candidate.length > 90) continue;

    return candidate;
  }

  return '';
}

/* -------------------------
   ServiceM8: Materials catalogue
-------------------------- */

async function findMaterialByItemNumber(itemNumber, apiKey) {
  const code = safeStr(itemNumber).trim();
  if (!code) return null;

  const filter = encodeURIComponent(`item_number eq '${code.replace(/'/g, "\\'")}'`);
  const data = await sm8Request('GET', `/material.json?$filter=${filter}`, null, apiKey, null, 12000);

  return Array.isArray(data) ? data[0] : null;
}

async function createMaterial(itemNumber, name, unitPrice, unitCost, apiKey) {
  const payload = {
    name: clampStr(normaliseSpaces(name), 70),
    item_number: clampStr(normaliseSpaces(itemNumber), 30),
  };

  if (unitPrice !== null && unitPrice !== undefined) payload.price = moneyStr(unitPrice, 4);
  if (unitCost !== null && unitCost !== undefined) payload.cost = moneyStr(unitCost, 4);

  const { res, text } = await sm8Fetch('POST', '/material.json', payload, apiKey, null, 12000);

  if (!res.ok) {
    throw new Error(`SM8 Material create failed ${res.status}: ${text}`);
  }

  const created = (() => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  })();

  if (created && created.uuid) return created;

  const fetched = await findMaterialByItemNumber(payload.item_number, apiKey);

  if (!fetched) {
    throw new Error('Material created but could not be re-fetched by item_number.');
  }

  return fetched;
}

async function getOrCreateMaterialForQuoteItem(item, apiKey) {
  const heading = pickFirstNonEmpty(item?.heading, item?.description, 'Quote item');
  const providedCode = normaliseSpaces(item?.item_code);

  const baseCodeRaw = providedCode || shortCodeFromHeading(heading);
  const baseCodeClean = baseCodeRaw
    .toUpperCase()
    .replace(/[^A-Z0-9\- _]/g, '')
    .replace(/\s+/g, '-')
    .replace(/_+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  const baseCode = clampStr(baseCodeClean || 'ITEM', 30);

  const qty = Math.max(1, toNumber(item?.quantity, 1));
  const unitPrice = Math.max(0, toNumber(item?.unit_price, 0));
  const unitCost = Math.max(0, toNumber(item?.cost_price, 0));

  let mat = await findMaterialByItemNumber(baseCode, apiKey);

  if (mat) {
    return { material: mat, itemNumber: baseCode };
  }

  try {
    mat = await createMaterial(baseCode, heading, unitPrice, unitCost, apiKey);
    return { material: mat, itemNumber: baseCode };
  } catch (e) {
    console.warn('Material create failed for base code, will try with suffix:', e?.message || e);
  }

  const suf = hashSuffix(`${baseCode}|${heading}|${unitPrice}|${qty}`);
  const trimmed = clampStr(baseCode.slice(0, Math.max(1, 30 - (suf.length + 1))), 30);
  const altCode = clampStr(`${trimmed}-${suf}`, 30);

  mat = await findMaterialByItemNumber(altCode, apiKey);

  if (mat) {
    return { material: mat, itemNumber: altCode };
  }

  mat = await createMaterial(altCode, heading, unitPrice, unitCost, apiKey);

  return { material: mat, itemNumber: altCode };
}

/* -------------------------
   ServiceM8: Job Materials / Billing
-------------------------- */

async function listJobMaterials(jobUUID, apiKey) {
  const materials = await sm8Request(
    'GET',
    `/jobmaterial.json?$filter=job_uuid eq '${jobUUID}'`,
    null,
    apiKey,
    null,
    12000
  );

  return Array.isArray(materials) ? materials : [];
}

function quoteLineMarker(quoteNumber, code) {
  return `QSM8:${safeStr(quoteNumber)}:${safeStr(code)}`;
}

function generatedQuoteCode(quoteNumber, type, index = 1) {
  const q = safeStr(quoteNumber || 'UNKNOWN').replace(/[^0-9A-Za-z]+/g, '').slice(-10) || 'UNKNOWN';
  const t = safeStr(type || 'ITEM').replace(/[^0-9A-Za-z]+/g, '').toUpperCase().slice(0, 8) || 'ITEM';
  const i = String(Math.max(1, Number(index) || 1)).padStart(2, '0');

  return clampStr(`Q${q}-${t}-${i}`, 30);
}

function cleanProvidedItemCode(code) {
  return clampStr(
    normaliseSpaces(code)
      .toUpperCase()
      .replace(/[^A-Z0-9\- _/]+/g, '')
      .replace(/\s+/g, '-')
      .replace(/_+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, ''),
    30
  );
}

function lineTotalExTax(item) {
  const itemTotal = Number(item?.item_total);

  if (Number.isFinite(itemTotal)) {
    return itemTotal;
  }

  return toNumber(item?.quantity, 1) * toNumber(item?.unit_price, 0);
}

function lineCostTotal(item) {
  return Math.max(0, toNumber(item?.quantity, 1)) * Math.max(0, toNumber(item?.cost_price, 0));
}

function getExpectedQuoteExTaxTotal(payload) {
  const totalEx = Number(payload?.total_excludes_tax);

  if (Number.isFinite(totalEx)) {
    return totalEx;
  }

  const totalInc = Number(payload?.total_includes_tax);

  if (Number.isFinite(totalInc) && /exclusive/i.test(safeStr(payload?.amounts_are))) {
    return totalInc / 1.2;
  }

  return null;
}

function buildSubtotalGroupDescription(quoteNumber, sectionTitle, groupItems, subtotalAmount, sourceAmount) {
  const detailLines = groupItems.map((item) => {
    const qty = toNumber(item?.quantity, 1);
    const total = lineTotalExTax(item);
    const itemCode = normaliseSpaces(item?.item_code);
    const itemName = normaliseSpaces(item?.heading || item?.description || 'Item');

    return `- ${qty} x ${itemName}${itemCode ? ` [${itemCode}]` : ''}: £${moneyStr(total, 2)}`;
  });

  const sourceLine =
    sourceAmount !== null && Number.isFinite(sourceAmount)
      ? `Quotient visual subtotal: £${moneyStr(sourceAmount, 2)}`
      : '';

  return [
    sectionTitle || `Grouped subtotal from accepted Quotient quote #${quoteNumber}.`,
    sourceLine,
    '',
    ...detailLines,
  ]
    .filter((x) => safeStr(x).trim() !== '')
    .join('\n');
}

function buildServiceBillingLine(item, quoteNumber, serviceIndex) {
  const providedCode = cleanProvidedItemCode(item?.item_code);
  const code = providedCode || generatedQuoteCode(quoteNumber, 'SVC', serviceIndex + 1);
  const heading = pickFirstNonEmpty(item?.heading, item?.description, `Service item ${serviceIndex + 1}`);
  const desc = safeStr(item?.description).trim();

  return {
    ...item,
    source: 'service_line',
    key: quoteLineMarker(quoteNumber, code),
    item_code: code,
    heading,
    description: desc,
    quantity: Math.max(1, toNumber(item?.quantity, 1)),
    unit_price: Math.max(0, toNumber(item?.unit_price, lineTotalExTax(item))),
    cost_price: Math.max(0, toNumber(item?.cost_price, 0)),
    item_total: lineTotalExTax(item),
    item_count: 1,
  };
}

function subtotalGroupsFromHtml(items, payload, html) {
  const quoteNumber = payload?.quote_number ?? 'unknown';
  const plainText = stripHtmlToText(html);
  const parsed = findSubtotalLinesFromPlainText(plainText);
  const lines = parsed.lines;
  const subtotals = parsed.subtotals;

  if (!Array.isArray(items) || items.length === 0) {
    return {
      lines: [],
      materialCount: 0,
      serviceCount: 0,
      groupCount: 0,
    };
  }

  const itemPositions = findItemPositionsInQuoteText(items, lines);
  const servicesLineIndex = lines.findIndex((l) => /^services?$/i.test(normaliseSpaces(l)));

  const billingLines = [];
  let previousSubtotalLineIndex = -1;
  const usedItemIndexes = new Set();

  /*
    Build one billing line for each material/equipment section subtotal BEFORE Services.

    Example:
      CCTV Section
      Line Item
      Line Item
      Subtotal 147.55

    becomes:
      ServiceM8 billing item name: CCTV Section
      ServiceM8 billing value: 147.55
  */
  for (let subtotalIndex = 0; subtotalIndex < subtotals.length; subtotalIndex++) {
    const subtotal = subtotals[subtotalIndex];

    // Do not convert the Services subtotal, or grand subtotal after Services, into one line.
    if (servicesLineIndex >= 0 && subtotal.lineIndex > servicesLineIndex) {
      break;
    }

    const groupPositions = itemPositions.filter((pos) => {
      if (usedItemIndexes.has(pos.itemIndex)) return false;
      if (servicesLineIndex >= 0 && pos.lineIndex > servicesLineIndex) return false;

      return pos.lineIndex > previousSubtotalLineIndex && pos.lineIndex < subtotal.lineIndex;
    });

    const groupItems = groupPositions.map((pos) => pos.item);
    const previousSubtotalBeforeThisGroup = previousSubtotalLineIndex;

    previousSubtotalLineIndex = subtotal.lineIndex;

    if (groupItems.length === 0) {
      continue;
    }

    for (const pos of groupPositions) {
      usedItemIndexes.add(pos.itemIndex);
    }

    const firstItemLineIndex = groupPositions[0]?.lineIndex ?? 0;
    const sectionTitle = findSectionTitleForGroup(lines, previousSubtotalBeforeThisGroup, firstItemLineIndex);

    const calculatedSubtotal = groupItems.reduce((sum, item) => sum + lineTotalExTax(item), 0);
    const calculatedCost = groupItems.reduce((sum, item) => sum + lineCostTotal(item), 0);

    const code = generatedQuoteCode(quoteNumber, 'SUB', billingLines.length + 1);
    const heading =
      sectionTitle ||
      normaliseSpaces(groupItems[0]?.heading || groupItems[0]?.description || `Subtotal ${billingLines.length + 1}`);

    billingLines.push({
      source: 'materials_subtotal_group',
      key: quoteLineMarker(quoteNumber, code),
      item_code: code,
      heading,
      description: buildSubtotalGroupDescription(
        quoteNumber,
        sectionTitle || heading,
        groupItems,
        calculatedSubtotal,
        subtotal.amount
      ),
      quantity: 1,
      unit_price: calculatedSubtotal,
      cost_price: calculatedCost,
      item_total: calculatedSubtotal,
      tax_rate: 20,
      item_count: groupItems.length,
      visual_subtotal: subtotal.amount,
      visual_subtotal_raw: subtotal.raw,
    });
  }

  /*
    From Services onwards, keep items line-for-line.
    Do not use the visible Services subtotal as a billing line.
  */
  const servicePositions = itemPositions.filter((pos) => {
    if (usedItemIndexes.has(pos.itemIndex)) return false;
    if (servicesLineIndex < 0) return false;

    return pos.lineIndex > servicesLineIndex;
  });

  servicePositions.forEach((pos, serviceIndex) => {
    usedItemIndexes.add(pos.itemIndex);
    billingLines.push(buildServiceBillingLine(pos.item, quoteNumber, serviceIndex));
  });

  /*
    Safety fallback for anything unmatched.
    Keep unmatched items line-for-line rather than making a wrong subtotal.
  */
  const remainingItems = items.filter((_, idx) => !usedItemIndexes.has(idx));

  remainingItems.forEach((item, idx) => {
    billingLines.push(buildServiceBillingLine(item, quoteNumber, servicePositions.length + idx));
  });

  return {
    lines: billingLines,
    materialCount: billingLines
      .filter((g) => g.source === 'materials_subtotal_group')
      .reduce((sum, g) => sum + toNumber(g.item_count, 0), 0),
    serviceCount: billingLines
      .filter((g) => g.source === 'service_line')
      .reduce((sum, g) => sum + toNumber(g.item_count, 0), 0),
    groupCount: billingLines.length,
  };
}

async function buildAcceptedBillingLines(items, payload, env) {
  try {
    const html = await fetchQuoteHtmlForStructure(payload, env);
    const plan = subtotalGroupsFromHtml(items, payload, html);

    if (plan.lines.length > 0) {
      console.log(
        'Accepted quote billing lines built from HTML:',
        plan.lines.map((g) => ({
          code: g.item_code,
          heading: g.heading,
          source: g.source,
          item_count: g.item_count,
          item_total: moneyStr(g.item_total, 2),
          visual_subtotal: g.visual_subtotal ?? null,
        }))
      );

      return plan;
    }
  } catch (e) {
    console.warn('Could not build accepted quote billing lines from HTML:', e?.message || e);
  }

  // Fallback: one line per accepted item if HTML structure parsing fails.
  const quoteNumber = payload?.quote_number ?? 'unknown';
  const fallbackLines = items.map((item, idx) => buildServiceBillingLine(item, quoteNumber, idx));

  return {
    lines: fallbackLines,
    materialCount: 0,
    serviceCount: fallbackLines.length,
    groupCount: fallbackLines.length,
  };
}

function existingBillingMarkers(existing) {
  const markers = new Set();

  for (const m of existing) {
    const haystack = `${safeStr(m?.name)}\n${safeStr(m?.notes)}\n${safeStr(m?.item_number)}\n${safeStr(m?.material?.item_number)}`;
    const re = /QSM8:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/g;

    let match;

    while ((match = re.exec(haystack)) !== null) {
      markers.add(match[0]);
    }
  }

  return markers;
}

async function addBillingLineToServiceM8(jobUUID, line, apiKey) {
  let materialUUID = '';
  let itemNumber = '';

  try {
    const { material, itemNumber: code } = await getOrCreateMaterialForQuoteItem(line, apiKey);
    materialUUID = material?.uuid || '';
    itemNumber = code || line.item_code || '';
  } catch (e) {
    console.warn('Material lookup/create failed; falling back to name-only jobmaterial:', e?.message || e);
  }

  const qtyNum = Math.max(1, toNumber(line?.quantity, 1));
  const unitPriceNum = Math.max(0, toNumber(line?.unit_price, 0));
  const unitCostNum = Math.max(0, toNumber(line?.cost_price, 0));

  // Keep marker at the start so it is not truncated off ServiceM8 notes.
  const notes = clampStr(
    `${line.key}\n${safeStr(line?.description).trim()}`.trim(),
    255
  );

  const payload = {
    active: 1,
    job_uuid: jobUUID,
    quantity: moneyStr(qtyNum, 4),
    price: moneyStr(unitPriceNum, 4),
    displayed_amount: moneyStr(unitPriceNum, 4),
    displayed_amount_is_tax_inclusive: '0',
    notes,
  };

  if (materialUUID) {
    payload.material_uuid = materialUUID;
    payload.name = clampStr(normaliseSpaces(line.heading), 500);
  } else {
    const fallbackCode = normaliseSpaces(itemNumber || line?.item_code) || shortCodeFromHeading(line.heading);
    payload.name = clampStr(`[${clampStr(fallbackCode, 30)}] ${normaliseSpaces(line.heading)} ${line.key}`, 500);
  }

  if (unitCostNum > 0) {
    payload.cost = moneyStr(unitCostNum, 4);
    payload.displayed_cost = moneyStr(unitCostNum, 4);
  }

  const { res, text } = await sm8Fetch('POST', '/jobmaterial.json', payload, apiKey, null, 12000);

  if (!res.ok) {
    throw new Error(`SM8 JobMaterial create failed ${res.status}: ${text}`);
  }
}

async function addAcceptedQuoteItemsToBilling(jobUUID, payload, env, apiKey) {
  const items = Array.isArray(payload?.selected_items) ? payload.selected_items : [];

  if (items.length === 0) {
    return {
      added: 0,
      skipped: 0,
      failed: 0,
      firstError: '',
      materialCount: 0,
      serviceCount: 0,
      groupCount: 0,
      plannedTotal: 0,
      expectedTotal: getExpectedQuoteExTaxTotal(payload),
      totalMessage: 'No selected_items were present in the accepted quote payload.',
    };
  }

  const plan = await buildAcceptedBillingLines(items, payload, env);
  const plannedTotal = plan.lines.reduce((sum, line) => sum + toNumber(line?.item_total, 0), 0);
  const expectedTotal = getExpectedQuoteExTaxTotal(payload);

  let totalMessage = '';

  if (expectedTotal !== null) {
    const diff = Math.abs(plannedTotal - expectedTotal);

    totalMessage = diff <= 0.02
      ? `Quote total check OK: planned £${moneyStr(plannedTotal, 2)} ex VAT matches Quotient £${moneyStr(expectedTotal, 2)} ex VAT.`
      : `Quote total warning: planned £${moneyStr(plannedTotal, 2)} ex VAT, Quotient says £${moneyStr(expectedTotal, 2)} ex VAT.`;
  } else {
    totalMessage = `Quote total check skipped: Quotient did not provide a usable ex-VAT total. Planned £${moneyStr(plannedTotal, 2)} ex VAT.`;
  }

  const existing = await listJobMaterials(jobUUID, apiKey);
  const markers = existingBillingMarkers(existing);

  let added = 0;
  let skipped = 0;
  let failed = 0;
  let firstError = '';

  for (const line of plan.lines) {
    if (markers.has(line.key)) {
      skipped += 1;
      continue;
    }

    try {
      await addBillingLineToServiceM8(jobUUID, line, apiKey);
      markers.add(line.key);
      added += 1;
    } catch (e) {
      const msg = safeStr(e?.message || e);

      console.warn('SM8 accepted quote billing line failed:', msg, {
        key: line.key,
        heading: line.heading,
      });

      failed += 1;

      if (!firstError) {
        firstError = msg;
      }
    }
  }

  return {
    added,
    skipped,
    failed,
    firstError,
    materialCount: plan.materialCount,
    serviceCount: plan.serviceCount,
    groupCount: plan.groupCount,
    plannedTotal,
    expectedTotal,
    totalMessage,
  };
}

/* -------------------------
   ServiceM8: Notes + Attachments
-------------------------- */

async function sm8CreateAttachment(jobUUID, filename, fileTypeExt, apiKey) {
  const { res, text } = await sm8Fetch(
    'POST',
    '/Attachment.json',
    {
      related_object: 'job',
      related_object_uuid: jobUUID,
      attachment_name: filename,
      file_type: fileTypeExt || '',
      active: true,
    },
    apiKey,
    null,
    12000
  );

  if (!res.ok) {
    throw new Error(`SM8 attachment create failed ${res.status}: ${text}`);
  }

  const attachmentUUID = res.headers.get('x-record-uuid');

  if (!attachmentUUID) {
    throw new Error(`Missing x-record-uuid from SM8. Body: ${text}`);
  }

  console.log('SM8 attachment record created:', attachmentUUID, 'name:', filename);

  return attachmentUUID;
}

async function sm8UploadAttachmentFile(attachmentUUID, filename, bytes, mimeType, apiKey) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType || 'application/octet-stream' }), filename);

  const url = `${SM8_API}/Attachment/${attachmentUUID}.file`;

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        Accept: 'application/json',
      },
      body: form,
    },
    20000,
    `SM8 upload Attachment/${attachmentUUID}.file`
  );

  const text = await res.text();

  console.log('SM8 attachment upload response:', attachmentUUID, 'status:', res.status, 'body:', text);

  if (!res.ok) {
    throw new Error(`SM8 attachment upload failed ${res.status}: ${text}`);
  }
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

  if (!noteText) {
    return { ok: false, message: 'Empty note; skipped.' };
  }

  try {
    await sm8Request(
      'POST',
      '/note.json',
      {
        related_object: 'job',
        related_object_uuid: jobUUID,
        note: noteText,
      },
      apiKey,
      null,
      12000
    );

    return { ok: true, message: 'Job note added.' };
  } catch (err) {
    const msg = safeStr(err?.message || err);

    console.warn('SM8 note create failed:', msg);

    try {
      const filename = `Quotient Note (${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}).txt`;

      await sm8AttachBytesToJob(
        jobUUID,
        filename,
        new TextEncoder().encode(noteText),
        'text/plain',
        apiKey
      );

      return { ok: true, message: 'Job note endpoint blocked; added as text attachment instead.' };
    } catch (fallbackErr) {
      const fbMsg = safeStr(fallbackErr?.message || fallbackErr);

      console.warn('SM8 note fallback attachment failed:', fbMsg);

      return {
        ok: false,
        message: `Could not add job note and fallback failed: ${msg}`,
      };
    }
  }
}

/* -------------------------
   Quotient PDF download
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

  return (
    candidates.find((u) => u.toLowerCase().endsWith('.pdf')) ||
    candidates.find((u) => u.toLowerCase().includes('pdf')) ||
    candidates[0] ||
    null
  );
}

async function tryDownloadPdfAtUrl(url) {
  const res = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      headers: {
        Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
      },
    },
    15000,
    `Quotient download ${url}`
  );

  if (!res.ok) return null;

  const contentType = safeStr(res.headers.get('content-type')).toLowerCase();
  const bytes = await res.arrayBuffer();
  const u8 = new Uint8Array(bytes);

  const isPdfByMagic =
    u8.length >= 4 &&
    u8[0] === 0x25 &&
    u8[1] === 0x50 &&
    u8[2] === 0x44 &&
    u8[3] === 0x46;

  const isPdfByHeader = contentType.includes('application/pdf');

  if (isPdfByHeader || isPdfByMagic) {
    return { bytes };
  }

  return null;
}

async function downloadQuotientPdf(payload, env) {
  const quoteUrl = buildFullQuoteUrl(payload, env);

  const patternUrls = [
    `${quoteUrl}.pdf`,
    `${quoteUrl}/pdf`,
    `${quoteUrl}/print`,
    `${quoteUrl}?format=pdf`,
    `${quoteUrl}?pdf=1`,
    `${quoteUrl}?download=pdf`,
    `${quoteUrl}?print=pdf`,
  ];

  for (const u of patternUrls) {
    try {
      const got = await tryDownloadPdfAtUrl(u);

      if (got) {
        return { pdfUrl: u, bytes: got.bytes };
      }
    } catch {}
  }

  const pageRes = await fetchWithTimeout(
    quoteUrl,
    { method: 'GET' },
    12000,
    `Quotient fetch page ${quoteUrl}`
  );

  if (!pageRes.ok) {
    throw new Error(`Failed to fetch quote page ${pageRes.status}`);
  }

  const html = await pageRes.text();
  const pdfUrl = pickPdfLinkFromHtml(html, quoteUrl);

  if (!pdfUrl) {
    throw new Error(
      'Could not find a PDF download link on the quote page. Ensure print PDF downloads are enabled in Quotient.'
    );
  }

  const got = await tryDownloadPdfAtUrl(pdfUrl);

  if (!got) {
    throw new Error(`Found a likely PDF link but it did not download as a PDF: ${pdfUrl}`);
  }

  return { pdfUrl, bytes: got.bytes };
}

async function attachQuotePdfToJob(jobUUID, payload, env, apiKey, variant) {
  const quoteNumber = payload?.quote_number ?? 'unknown';
  const baseName = `Quotient Quote #${quoteNumber}`;
  const filename = variant === 'accepted' ? `${baseName} (Signed).pdf` : `${baseName}.pdf`;

  const { pdfUrl, bytes } = await downloadQuotientPdf(payload, env);

  console.log('Quotient PDF downloaded:', pdfUrl, 'bytes:', bytes.byteLength);

  const attachmentUUID = await sm8AttachBytesToJob(
    jobUUID,
    filename,
    bytes,
    'application/pdf',
    apiKey
  );

  console.log('SM8 PDF attachment complete:', attachmentUUID, 'job:', jobUUID);

  return attachmentUUID;
}

/* -------------------------
   Main processing
-------------------------- */

async function handleWebhook(payload, env) {
  const apiKey = env?.SM8_API_KEY;

  if (!apiKey) {
    return makeTextResponse('Missing SM8_API_KEY secret', 500);
  }

  const eventName = safeStr(payload?.event_name).trim();
  const quoteNumber = payload?.quote_number;
  const jobNumber = extractJobNumber(payload?.title);

  if (!jobNumber) {
    console.warn('Webhook skipped: no #jobnumber found in quote title.', {
      event_name: payload?.event_name,
      quote_number: payload?.quote_number,
      title: payload?.title,
    });

    return makeTextResponse('OK', 200);
  }

  const job = await findJobByNumber(jobNumber, apiKey);

  if (!job) {
    return makeTextResponse(`No SM8 job found for job number ${jobNumber}`, 404);
  }

  const jobUUID = job.uuid;

  if (eventName === 'quote_sent') {
    const awaitingName = env?.SM8_AWAITING_ACCEPTANCE_QUEUE_NAME || 'Awaiting Acceptance';
    const move = await moveJobToQueueByName(jobUUID, awaitingName, apiKey);

    let scopeMsg = '';

    try {
      const scope = await appendScopeOfWorksToJobDescription(job, payload, env, apiKey);
      scopeMsg = scope.message;
    } catch (e) {
      console.warn('Scope of Works append failed:', e?.message || e);
      scopeMsg = `Scope of Works update failed - ${truncate(e?.message || e)}`;
    }

    try {
      await attachQuotePdfToJob(jobUUID, payload, env, apiKey, 'sent');
    } catch (e) {
      console.warn('PDF attach failed:', e?.message || e);
      throw new Error(`Quote PDF could not be attached - ${truncate(e?.message || e)}`);
    }

    const noteText = `Quotient quote #${quoteNumber} has been sent to the customer. ${move.message} ${scopeMsg} Quote PDF attached to job.`;
    const noteRes = await addJobNote(jobUUID, noteText, apiKey);

    if (!noteRes.ok) {
      throw new Error(noteRes.message);
    }

    return makeTextResponse('OK', 200);
  }

  if (eventName === 'quote_accepted') {
    try {
      await attachQuotePdfToJob(jobUUID, payload, env, apiKey, 'accepted');
    } catch (e) {
      console.warn('Signed PDF attach failed:', e?.message || e);
      throw new Error(`Signed PDF could not be attached - ${truncate(e?.message || e)}`);
    }

    await updateJob(jobUUID, { status: 'Work Order' }, apiKey);

    const billing = await addAcceptedQuoteItemsToBilling(jobUUID, payload, env, apiKey);

    const acceptedQueueName = env?.SM8_ACCEPTED_QUEUE_NAME || 'Invoicing/Administration';
    const move = await moveJobToQueueByName(jobUUID, acceptedQueueName, apiKey);

    const billingMsg =
      billing.failed > 0
        ? `Billing updated from accepted quote (added ${billing.added}, skipped ${billing.skipped}, failed ${billing.failed}). Imported ${billing.groupCount || 0} billing line(s): material section subtotals before Services plus Services line-by-line. ${billing.totalMessage} First error: ${truncate(billing.firstError)}`
        : `Billing updated from accepted quote (added ${billing.added}, skipped ${billing.skipped}). Imported ${billing.groupCount || 0} billing line(s): material section subtotals before Services plus Services line-by-line. ${billing.totalMessage}`;

    const noteText = `Quotient quote #${quoteNumber} was accepted. Signed quote PDF attached to job. Job status set to "Work Order". ${billingMsg} ${move.message}`;
    const noteRes = await addJobNote(jobUUID, noteText, apiKey);

    if (!noteRes.ok) {
      throw new Error(noteRes.message);
    }

    if (billing.failed > 0) {
      throw new Error(`Billing had ${billing.failed} failures; retrying via webhook.`);
    }

    return makeTextResponse('OK', 200);
  }

  if (eventName === 'customer_viewed_quote' || eventName === 'customer_viewed') {
    const viewedAt =
      payload?.viewed_at ||
      payload?.viewed_when ||
      payload?.when ||
      payload?.occurred_at ||
      new Date().toISOString();

    const ts = formatTimestampForNote(viewedAt) || 'an unknown time';
    const viewedMsg = `Customer viewed quote at ${ts}.`;
    const noteRes = await addJobNote(jobUUID, viewedMsg, apiKey);

    if (!noteRes.ok) {
      throw new Error(noteRes.message);
    }

    return makeTextResponse('OK', 200);
  }

  if (eventName === 'customer_asked_question') {
    const question = payload?.question || payload?.message || '';

    const note = question
      ? `Customer asked a question on Quotient quote #${quoteNumber}: ${question}`
      : `Customer asked a question on Quotient quote #${quoteNumber}.`;

    const noteRes = await addJobNote(jobUUID, note, apiKey);

    if (!noteRes.ok) {
      throw new Error(noteRes.message);
    }

    return makeTextResponse('OK', 200);
  }

  if (eventName === 'quote_declined') {
    const noteRes = await addJobNote(jobUUID, `Quotient quote #${quoteNumber} was declined.`, apiKey);

    if (!noteRes.ok) {
      throw new Error(noteRes.message);
    }

    return makeTextResponse('OK', 200);
  }

  if (eventName === 'quote_completed') {
    const noteRes = await addJobNote(jobUUID, `Quotient quote #${quoteNumber} is completed.`, apiKey);

    if (!noteRes.ok) {
      throw new Error(noteRes.message);
    }

    return makeTextResponse('OK', 200);
  }

  console.log('Unhandled Quotient event_name:', eventName);

  return makeTextResponse('OK', 200);
}

/* -------------------------
   Worker entrypoint
-------------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== 'POST' || url.pathname !== '/webhook') {
      return makeTextResponse('Not Found', 404);
    }

    try {
      let payload;

      try {
        payload = await request.json();
      } catch {
        return makeTextResponse('Invalid JSON', 400);
      }

      const response = await handleWebhook(payload, env);

      return await finaliseResponse(response);
    } catch (err) {
      console.error('Webhook handler error:', err);

      return makeTextResponse(`Internal error: ${safeStr(err?.message || err)}`, 500);
    }
  },
};
