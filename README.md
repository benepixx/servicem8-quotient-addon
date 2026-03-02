# servicem8-quotient-addon

A Node.js ServiceM8 addon that integrates with [Quotient](https://www.quotientapp.com/) to create and manage quotes directly from ServiceM8 jobs.

## Workflow

| Trigger | Action |
|---|---|
| New job created in ServiceM8 | Empty quote created in Quotient, bound to customer name, email, phone, address & job details |
| Job Action: "Create / Open Quote" | Opens a popup showing quote details with a direct link to edit in Quotient |
| Job Action: "Sync Quote Status" | Polls Quotient; if accepted, attaches signed PDF, syncs line items to SM8 billing, moves job to correct queue |
| Quote accepted in Quotient | Signed PDF attached → line items pushed to billing → job moved to **Parts to Order** or **Ready to Book** queue |

## Project Structure

```
servicem8-quotient-addon/
├── manifest.json       # ServiceM8 addon manifest
├── server.js           # HTTP server with webhook signature validation
├── index.js            # Main handler (webhooks + job actions)
├── lib/
│   ├── servicem8.js    # ServiceM8 REST API client
│   ├── quotient.js     # Quotient API client
│   └── jobQueue.js     # Billing sync & queue routing
├── tests/
│   └── index.test.js   # Unit tests (node --test)
├── .env.example        # Environment variable template
├── package.json
└── README.md
```

## Setup

### 1. Prerequisites

```bash
npm install
```

Copy `.env.example` and fill in your credentials (for Self Hosted only — see deployment options below):

```bash
cp .env.example .env
```

### 2. Run tests

```bash
npm test
```

---

## Deployment

ServiceM8 offers two addon types that work with this code. Choose whichever matches your situation:

---

### Option A — Simple Function (Node.js) ✅ Recommended

ServiceM8 **hosts and runs** your function — no server, no infrastructure needed.

1. **Build the deployment zip:**
   ```bash
   npm install
   npm run package
   # → creates addon.zip in the project root
   ```

2. **Create the addon in ServiceM8:**
   - Go to **ServiceM8 Developer Console** → *Add new addon*
   - Choose **Simple Function (Node.js)**
   - Upload `addon.zip`
   - Set environment variables in the console (no `.env` file needed):

   | Variable | Value |
   |---|---|
   | `QUOTIENT_API_KEY` | Your Quotient API key |
   | `QUOTIENT_ACCOUNT_ID` | Your Quotient account ID |
   | `SM8_PARTS_TO_ORDER_QUEUE_UUID` | Queue UUID for "Parts to Order" |
   | `SM8_READY_TO_BOOK_QUEUE_UUID` | Queue UUID for "Ready to Book" |

   > ℹ️ `SM8_WEBHOOK_SECRET` is **not needed** for Simple Function — ServiceM8 authenticates calls internally.

3. **Upload `manifest.json`** in the addon settings (or paste its contents), then activate the addon.

---

### Option B — Self Hosted Web Service

You run the server on your own infrastructure and give ServiceM8 the public URL.

1. **Configure environment variables** (fill in `.env` or set them in your hosting platform):

   | Variable | Description |
   |---|---|
   | `PORT` | Port to listen on (default: `3000`) |
   | `QUOTIENT_API_KEY` | Your Quotient API key |
   | `QUOTIENT_ACCOUNT_ID` | Your Quotient account ID |
   | `SM8_WEBHOOK_SECRET` | Webhook secret from ServiceM8 addon settings |
   | `SM8_PARTS_TO_ORDER_QUEUE_UUID` | Queue UUID for "Parts to Order" |
   | `SM8_READY_TO_BOOK_QUEUE_UUID` | Queue UUID for "Ready to Book" |

2. **Start the server:**
   ```bash
   npm start
   # → ServiceM8-Quotient addon server listening on port 3000
   ```
   The server must be reachable at a public HTTPS URL (e.g. via a reverse proxy like nginx + Let's Encrypt, or a platform like Railway, Render, or Fly.io).

3. **Create the addon in ServiceM8:**
   - Go to **ServiceM8 Developer Console** → *Add new addon*
   - Choose **Self Hosted Web Service**
   - Enter your public URL as the endpoint (e.g. `https://yourhost.com/`)
   - Copy the webhook secret shown and set it as `SM8_WEBHOOK_SECRET`
   - Upload `manifest.json` or paste its contents, then activate the addon.

---

### Finding your queue UUIDs

After connecting your ServiceM8 account, call the API to list your queues:

```
GET https://api.servicem8.com/api_1.0/jobqueue.json
Authorization: Bearer <your_access_token>
```

Copy the `uuid` values for your "Parts to Order" and "Ready to Book" queues.

---

### Update `manifest.json`

Before publishing, replace the placeholder URLs in `manifest.json`:

```json
"iconURL": "https://yourhost.com/quotient-icon.png",
"supportURL": "https://yourhost.com/support",
"supportEmail": "support@yourdomain.com"
```

## How it works

- When a new job is created (INSERT webhook), the addon creates a Quotient quote using the job's primary contact details (email/phone from `jobcontact`, falling back to the company record). The quote ID is stored as `[quotient_quote_id:XXX]` in the job description, and a note is added to the job.
- **Create / Open Quote** action: opens a popup with customer details, quote status, total, and a link to edit in Quotient. Creates a quote first if none exists, then logs a job note.
- **Sync Quote Status** action: fetches the latest status from Quotient. If accepted, it:
  1. Downloads and attaches the signed PDF to the SM8 job
  2. Replaces all existing billing line items with the accepted quote's line items
  3. Moves the job to the correct queue based on whether any parts need ordering
  4. Logs a summary note to the job
  5. Shows a summary popup with the synced line items

## Security

Incoming webhook requests are authenticated using an HMAC-SHA256 signature. Set `SM8_WEBHOOK_SECRET` to the secret configured in your ServiceM8 addon settings. When the secret is set, any request with an invalid or missing `X-ServiceM8-Webhook-Signature` header is rejected with HTTP 401.
