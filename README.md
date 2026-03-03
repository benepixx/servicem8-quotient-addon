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
   - Optionally configure the queue name settings in the console if your SM8 queues use different names than the defaults:

   | Setting | Default |
   |---|---|
   | SM8 Queue Name — Parts to Order | `Parts to Order` |
   | SM8 Queue Name — Ready to Book | `Ready to Book` |

3. Upload `addon/manifest.json` and activate the addon.

---

## Part 2: Cloudflare Worker (`worker/`)

The Worker receives webhooks from Quotient and updates ServiceM8 automatically. It runs on Cloudflare's free tier — no server, no hosting costs.

### Prerequisites

- **Node.js 18+** — [Download here](https://nodejs.org). To check if you already have it:
  ```bash
  node --version
  ```
- **A Cloudflare account** — [Sign up free at cloudflare.com](https://dash.cloudflare.com/sign-up). You don't need to add a domain or a credit card.
- **A ServiceM8 OAuth access token** — see [Getting your SM8 access token](#getting-your-sm8-access-token) below.

---

### Step 1 — Install Wrangler (Cloudflare's CLI)

Open your terminal, navigate to the `worker/` folder, and install dependencies:

```bash
cd worker
npm install
```

This installs Wrangler locally. You'll run it as `npx wrangler` from inside the `worker/` folder.

Verify it works:

```bash
npx wrangler --version
```

---

### Step 2 — Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser window. Log in with your Cloudflare account and click **Allow**. You only need to do this once — Wrangler saves the login token on your machine.

---

### Step 3 — (Optional) Change queue names

Open `worker/wrangler.toml`. The `[vars]` section has the SM8 queue names the Worker will look for:

```toml
[vars]
SM8_PARTS_TO_ORDER_QUEUE_NAME = "Parts to Order"
SM8_READY_TO_BOOK_QUEUE_NAME  = "Ready to Book"
```

**Leave these as-is** unless your ServiceM8 queues are named something different. The Worker looks up queues by name automatically — no UUIDs needed.

---

### Step 4 — Add your SM8 access token as a secret

Your ServiceM8 access token is sensitive — it must **never** be committed to the repo. Wrangler stores it encrypted in Cloudflare's systems.

Run this command and paste in your token when prompted:

```bash
npx wrangler secret put SM8_ACCESS_TOKEN
```

> **Don't have a token yet?** See [Getting your SM8 access token](#getting-your-sm8-access-token) below.

---

### Step 5 — Deploy

```bash
npx wrangler deploy
```

Wrangler will build and upload the Worker. At the end you'll see output like:

```
Published servicem8-quotient-webhook (1.23 sec)
  https://servicem8-quotient-webhook.<your-account>.workers.dev
```

Your webhook URL is:

```
https://servicem8-quotient-webhook.<your-account>.workers.dev/webhook
```

Copy this URL — you'll need it in the next step.

---

### Step 6 — Configure Quotient webhooks

1. Log in to [Quotient](https://app.quotientapp.com)
2. Go to **Settings → Integrations → Webhooks**
3. Click **Add webhook**
4. Paste your Worker URL into the endpoint field:
   ```
   https://servicem8-quotient-webhook.<your-account>.workers.dev/webhook
   ```
5. Enable **all** of the following events:
   - `quote_sent`
   - `quote_accepted`
   - `quote_completed`
   - `customer_viewed_quote`
   - `customer_asked_question`
   - `quote_declined`
6. Save the webhook.

That's it — Quotient will now POST to your Worker every time one of these events happens.

---

### Getting your SM8 access token

The Worker needs a ServiceM8 OAuth access token to call the SM8 API on your behalf.

**Option A — From the SM8 Developer Console (simplest)**

1. Go to [developer.servicem8.com](https://developer.servicem8.com)
2. Open your addon → **Settings**
3. Under **OAuth**, copy the access token shown for your account.

**Option B — Via OAuth flow**

Follow the [ServiceM8 OAuth guide](https://developer.servicem8.com/docs/authentication) to generate a token with these scopes:

```
read_jobs manage_jobs manage_job_materials read_customers manage_customers
read_job_attachments publish_job_attachments read_job_queues manage_job_queues
```

---

### Re-deploying after changes

Any time you change `worker/src/index.js` or `worker/wrangler.toml`, just run:

```bash
cd worker
npx wrangler deploy
```

Secrets (like `SM8_ACCESS_TOKEN`) are stored in Cloudflare and persist between deploys — you only need to set them once.

---

### Viewing live logs

To watch real-time logs from your Worker (useful for debugging):

```bash
cd worker
npx wrangler tail
```

---

## Running Tests

```bash
node --test tests/index.test.js tests/worker.test.js
```
