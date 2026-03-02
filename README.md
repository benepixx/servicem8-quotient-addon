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
├── index.js            # Main handler (webhooks + job actions)
├── lib/
│   ├── servicem8.js    # ServiceM8 REST API client
│   ├── quotient.js     # Quotient API client
│   └── jobQueue.js     # Billing sync & queue routing
├── package.json
└── README.md
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

| Variable | Description |
|---|---|
| `QUOTIENT_API_KEY` | Your Quotient API key |
| `QUOTIENT_ACCOUNT_ID` | Your Quotient account ID |
| `SM8_PARTS_TO_ORDER_QUEUE_UUID` | ServiceM8 queue UUID for "Parts to Order" |
| `SM8_READY_TO_BOOK_QUEUE_UUID` | ServiceM8 queue UUID for "Ready to Book" |

### 3. Deploy

Deploy as a ServiceM8 Simple Function addon. Update the `iconURL`, `supportURL`, and `supportEmail` fields in `manifest.json` to match your hosted endpoint.

## How it works

- When a new job is created, the webhook fires and creates a Quotient quote. The quote ID is stored as `[quotient_quote_id:XXX]` in the job description.
- **Create / Open Quote** action: opens a popup with customer details, quote status, total, and a link to edit in Quotient. Creates a quote first if none exists.
- **Sync Quote Status** action: fetches the latest status from Quotient. If accepted, it:
  1. Downloads and attaches the signed PDF to the SM8 job
  2. Replaces all existing billing line items with the accepted quote's line items
  3. Moves the job to the correct queue based on whether any parts need ordering
  4. Shows a summary popup with the synced line items
