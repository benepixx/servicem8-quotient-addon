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

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `PORT` | Port to listen on (default: `3000`) |
| `QUOTIENT_API_KEY` | Your Quotient API key |
| `QUOTIENT_ACCOUNT_ID` | Your Quotient account ID |
| `SM8_WEBHOOK_SECRET` | ServiceM8 webhook secret (from addon settings) — leave blank to skip validation in local dev |
| `SM8_PARTS_TO_ORDER_QUEUE_UUID` | ServiceM8 queue UUID for "Parts to Order" |
| `SM8_READY_TO_BOOK_QUEUE_UUID` | ServiceM8 queue UUID for "Ready to Book" |

To find your queue UUIDs, call the ServiceM8 API directly:
```
GET https://api.servicem8.com/api_1.0/jobqueue.json
Authorization: Bearer <access_token>
```

### 3. Run the server

```bash
npm start
# → ServiceM8-Quotient addon server listening on port 3000
```

### 4. Run tests

```bash
npm test
```

### 5. Deploy

Point your ServiceM8 addon endpoint URL to your hosted server (e.g. `https://yourhost.com/`). Update the `iconURL`, `supportURL`, and `supportEmail` fields in `manifest.json` to match.

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
