# servicem8-quotient-addon

A two-part integration between [ServiceM8](https://www.servicem8.com/) and [Quotient](https://www.quotientapp.com/) using a webhook-driven architecture.

> **Why two parts?** Quotient has no REST API — it only sends outbound webhooks. ServiceM8 SimpleFunction cannot receive inbound HTTP requests from third parties. A Cloudflare Worker bridges the gap.

---

## Architecture

```
ServiceM8 Job
    │
    │  User clicks "Create / Open Quote" (SM8 job action)
    ▼
addon/function.js  (ServiceM8 SimpleFunction)
    │  Shows popup: suggested quote title, customer info, "Open Quotient" button
    ▼
User manually creates quote in Quotient using the suggested title
    │
    │  e.g. "#6786 – Bathroom Reno"
    ▼
Quotient sends webhook → https://servicem8-quotient-webhook.<account>.workers.dev/webhook
    │
    ▼
worker/src/index.js  (Cloudflare Worker)
    │  Parses job number from quote title
    │  Looks up SM8 job UUID
    │  Takes action in ServiceM8 (add note, sync materials, move queue, etc.)
    ▼
ServiceM8 job updated automatically
```

---

## Quote Title Naming Convention

The link between Quotient and ServiceM8 is the **SM8 job number** embedded in the Quotient quote title. The worker's parser handles all of these formats:

| Quote title | Job number extracted |
|---|---|
| `#6786 – Bathroom Reno` | `6786` |
| `Job #6786 – Home Security` | `6786` |
| `Job 6786` | `6786` |
| `6786 - Solar Install` | `6786` |

The SM8 addon popup shows the **suggested quote title** (e.g. `#6786 – Bathroom Reno`) so users know exactly what to type in Quotient.

---

## Quotient Webhook Events

| `event_name` | Action taken in ServiceM8 |
|---|---|
| `quote_accepted` | Clear existing job materials → add accepted line items → move job to "Ready to Book" or "Parts to Order" queue → add private note |
| `quote_declined` | Add private note: "Quotient quote #N was declined." |
| `quote_sent` | Add private note: "Quotient quote #N has been sent to the customer." |
| `quote_completed` | Add private note: "Quotient quote #N is completed." |
| `customer_viewed_quote` | Add private note: "Customer viewed Quotient quote #N." |
| `customer_asked_question` | Add private note with the question content |

---

## Repo Structure

```
servicem8-quotient-addon/
├── addon/
│   ├── function.js          # SM8 SimpleFunction — UI only
│   ├── manifest.json        # SM8 addon manifest v2.0
│   └── .env.example         # Notes only — settings live in SM8 Developer Console
├── worker/
│   ├── src/
│   │   └── index.js         # Cloudflare Worker — Quotient webhook receiver
│   ├── wrangler.toml        # Wrangler config
│   └── package.json         # { "devDependencies": { "wrangler": "^3" } }
├── tests/
│   ├── index.test.js        # Tests for addon/function.js
│   └── worker.test.js       # Tests for worker extractJobNumber logic
├── README.md
└── .gitignore
```

---

## Part 1: ServiceM8 Addon (`addon/`)

### What it does

When a user clicks **"Create / Open Quote"** on a SM8 job, a popup appears showing:
- The **suggested quote title** to use in Quotient (e.g. `#6786 – Bathroom Reno`)
- Customer name and address for reference
- A big **"Open Quotient ↗"** button
- An info box explaining the naming convention

### Deployment

1. Zip `addon/function.js` and `addon/manifest.json` together:
   ```bash
   cd addon && zip ../addon.zip function.js manifest.json
   ```

2. In **ServiceM8 Developer Console** → *Add new addon* → **Simple Function (Node.js)**:
   - Upload `addon.zip`
   - Configure settings in the console:

   | Setting | Description |
   |---|---|
   | SM8 Queue UUID — Parts to Order | UUID of your "Parts to Order" queue (optional) |
   | SM8 Queue UUID — Ready to Book | UUID of your "Ready to Book" queue (optional) |

3. Upload `addon/manifest.json` and activate the addon.

### Finding queue UUIDs

```
GET https://api.servicem8.com/api_1.0/jobqueue.json
Authorization: Bearer <your_access_token>
```

---

## Part 2: Cloudflare Worker (`worker/`)

### Setup

```bash
cd worker
npm install
```

### Configuration

Set the SM8 access token as a Worker secret (never commit this):

```bash
wrangler secret put SM8_ACCESS_TOKEN
```

Optionally set queue UUIDs in `worker/wrangler.toml` under `[vars]`:

```toml
[vars]
SM8_PARTS_TO_ORDER_QUEUE_UUID = "your-uuid-here"
SM8_READY_TO_BOOK_QUEUE_UUID  = "your-uuid-here"
```

### Deploy

```bash
wrangler deploy
```

Your webhook URL will be:

```
https://servicem8-quotient-webhook.<your-account>.workers.dev/webhook
```

### Configure Quotient

In Quotient → Settings → Webhooks, add a new webhook pointing to your Worker URL:

```
https://servicem8-quotient-webhook.<your-account>.workers.dev/webhook
```

Enable the events: `quote_sent`, `quote_accepted`, `quote_completed`, `customer_viewed_quote`, `customer_asked_question`, `quote_declined`.

---

## Running Tests

```bash
node --test tests/index.test.js tests/worker.test.js
```
