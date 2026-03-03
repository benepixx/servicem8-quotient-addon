const SM8_API = 'https://api.servicem8.com/api_1.0';

export function extractJobNumber(title) {
  if (!title) return null;
  const match = title.match(/#?(\d+)/);
  return match ? match[1] : null;
}

async function sm8Request(method, path, body, accessToken) {
  const url = `${SM8_API}${path}`;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SM8 API error ${res.status}: ${text}`);
  }
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

async function findJobByNumber(jobNumber, accessToken) {
  const data = await sm8Request(
    'GET',
    `/job.json?$filter=generated_job_id eq ${encodeURIComponent(jobNumber)}`,
    null,
    accessToken
  );
  return Array.isArray(data) ? data[0] : null;
}

async function clearJobMaterials(jobUUID, accessToken) {
  const materials = await sm8Request(
    'GET',
    `/jobmaterial.json?$filter=job_uuid eq '${jobUUID}'`,
    null,
    accessToken
  );
  if (!Array.isArray(materials)) return;
  await Promise.allSettled(
    materials.map((m) =>
      sm8Request('DELETE', `/jobmaterial/${m.uuid}.json`, null, accessToken)
    )
  );
}

async function addJobMaterials(jobUUID, items, accessToken) {
  await Promise.allSettled(
    items.map((item) =>
      sm8Request('POST', '/jobmaterial.json', {
        job_uuid: jobUUID,
        name: item.heading || item.description || '',
        quantity: item.quantity || 1,
        unit_price: item.unit_price || 0,
        unit_cost: item.cost_price || 0,
        notes: item.description || '',
        is_billable: 1,
        material_type: 'MATERIAL',
      }, accessToken)
    )
  );
}

async function addJobNote(jobUUID, note, accessToken) {
  return sm8Request('POST', '/jobnote.json', {
    job_uuid: jobUUID,
    note,
    note_type: 'private',
  }, accessToken);
}

async function setJobQueue(jobUUID, queueUUID, accessToken) {
  return sm8Request('POST', `/job/${jobUUID}.json`, { queue_uuid: queueUUID }, accessToken);
}

async function handleWebhook(payload, env) {
  const accessToken = env.SM8_ACCESS_TOKEN;
  const jobNumber = extractJobNumber(payload.title);
  if (!jobNumber) {
    return new Response('Could not extract job number from quote title', { status: 400 });
  }

  const job = await findJobByNumber(jobNumber, accessToken);
  if (!job) {
    return new Response(`No SM8 job found for job number ${jobNumber}`, { status: 404 });
  }

  const jobUUID = job.uuid;
  const quoteNumber = payload.quote_number;
  const eventName = payload.event_name;

  if (eventName === 'quote_accepted') {
    const items = payload.selected_items || [];
    await clearJobMaterials(jobUUID, accessToken);
    await addJobMaterials(jobUUID, items, accessToken);

    const needsParts = items.some((item) => (item.cost_price || 0) > 0);
    const queueUUID = needsParts
      ? env.SM8_PARTS_TO_ORDER_QUEUE_UUID
      : env.SM8_READY_TO_BOOK_QUEUE_UUID;
    const queueName = needsParts ? 'Parts to Order' : 'Ready to Book';

    if (queueUUID) {
      await setJobQueue(jobUUID, queueUUID, accessToken);
    }

    await addJobNote(
      jobUUID,
      `Quotient quote #${quoteNumber} was accepted. ${items.length} item(s) added to billing. Job moved to "${queueName}".`,
      accessToken
    );
  } else if (eventName === 'quote_declined') {
    await addJobNote(jobUUID, `Quotient quote #${quoteNumber} was declined.`, accessToken);
  } else if (eventName === 'quote_sent') {
    await addJobNote(jobUUID, `Quotient quote #${quoteNumber} has been sent to the customer.`, accessToken);
  } else if (eventName === 'quote_completed') {
    await addJobNote(jobUUID, `Quotient quote #${quoteNumber} is completed.`, accessToken);
  } else if (eventName === 'customer_viewed_quote') {
    await addJobNote(jobUUID, `Customer viewed Quotient quote #${quoteNumber}.`, accessToken);
  } else if (eventName === 'customer_asked_question') {
    const question = payload.question || payload.message || '';
    const note = question
      ? `Customer asked a question on Quotient quote #${quoteNumber}: ${question}`
      : `Customer asked a question on Quotient quote #${quoteNumber}.`;
    await addJobNote(jobUUID, note, accessToken);
  }

  return new Response('OK', { status: 200 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/webhook') {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      try {
        return await handleWebhook(payload, env);
      } catch (err) {
        console.error('Webhook handler error:', err);
        return new Response(`Internal error: ${err.message}`, { status: 500 });
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};
