# PayProof

**Reconciliation-first UPI collection toolkit — evidence is not truth.**

PayProof is a teaching-grade reference implementation for accepting UPI payments into your own bank account without pretending that an SMS notification is settlement. It turns the messy part of "direct-to-bank" collection into an explicit lifecycle:

```
bank alert  = evidence
statement   = truth
RECONCILED  = the only success state
```

This is **not** a payment gateway, not a PSP, and not authorised to collect money for third parties. It moves no money; it observes, records, matches and reports.

---

## Why this exists

Direct-to-bank UPI collection (the kind of thing self-hosted gateways do) depends on parsing bank SMS, Gmail alerts or notification mirrors. Those feeds are useful but weak proof:

- an SMS can be delayed, replayed, spoofed or lost;
- an alert proves *a credit happened*, not *which order it belongs to*;
- two open orders with the same amount are indistinguishable from an alert alone;
- "marked paid" on alert delivery is how merchants get burned by late settlements and chargebacks.

PayProof refuses to collapse evidence into truth. It records every alert, attributes only exact matches inside a live window, queues everything ambiguous for a human, and posts a double-entry ledger entry only when a bank statement confirms the UTR and amount.

---

## What it does

- **Payment intents** with idempotent `(merchant, orderId)` keys and paise-exact amounts.
- **One live slot per receiving account**, enforced by a partial unique index, with FIFO promotion of waiters.
- **Server-authoritative payment windows** and a sweeper that expires and promotes.
- **Exact alert attribution**: amount must match to the paise, alert must fall inside the intent lifetime (± 60 s clock skew), and only `ACTIVE` / `AWAITING_VERIFICATION` intents are eligible.
- **Late-alert review queue**: an alert after expiry is *never* auto-applied; an operator can link it explicitly (recorded as `manual_review_late_match`).
- **Statement import** (`utr,amount_rupees,date`) is the only path from `OBSERVED` to `RECONCILED`.
- **Double-entry ledger** posted on reconciliation (DEBIT bank / CREDIT merchant payable).
- **Transactional webhook outbox** with HMAC-SHA256 signatures, exponential backoff, permanent-failure state and a local receiver that verifies signatures.
- **Zero-install default DB**: embedded Postgres (PGlite/WASM), with `pg` + Docker Compose for a real Postgres.
- **Dashboard, checkout page and intent timeline** for exploring every state change.

---

## Quickstart

Requires **Node.js >= 22.18** (tested on Node 26; uses native TypeScript type-stripping and `.ts` import specifiers — no build step, no `tsx`).

```bash
cd payproof
npm install

# One command: fresh demo DB, full lifecycle, server left running on :4100
npm run demo
```

Then open <http://127.0.0.1:4100/>. The demo creates an intent, rejects a one-paise-short alert, matches the real alert, delivers signed webhooks, imports the statement, reconciles, and prints the ledger totals. Stop it with `Ctrl+C`.

Other commands:

```bash
npm start        # normal server on :4000 (persistent DB in ./data/pgdata)
npm test         # 29 tests: matcher, lifecycle, HTTP flow, webhook delivery/retry
npm run typecheck
npm run reset    # delete local databases (stop the server first)
```

`npm run demo` uses its own database at `./data/demo-pgdata` and wipes it on each run, so it never disturbs `npm start` data.

### Postgres instead of PGlite

```bash
docker compose up -d
cp .env.example .env
# in .env:
#   DB_DRIVER=postgres
#   DATABASE_URL=postgres://payproof:payproof@localhost:5432/payproof
npm start
```

Migrations in `migrations/` run automatically on boot. Both drivers are exercised through the same `Db` interface; the integration tests run on PGlite.

---

## The lifecycle

```
POST /api/intents
      │
      ▼
   QUEUED ──────────────► ACTIVE ──────────────► AWAITING_VERIFICATION
      │  slot frees          │  buyer claims            │
      │                      │                          │
      │                      ▼                          ▼
      │                   OBSERVED ◄────────────────────┘   (bank alert matched exactly)
      │                      │
      │                      │  statement: UTR + exact amount
      │                      ▼
      │                  RECONCILED   ← the only state in which an order should be fulfilled
      │
      └──► CANCELLED        ACTIVE/AWAITING ──► EXPIRED (sweeper, window elapsed)
```

Every transition is written to `intent_transitions` with a reason. Nothing is inferred from a screenshot, a browser callback or a client claim.

| State | Meaning | Can fulfil? |
| --- | --- | --- |
| `QUEUED` | Waiting for the account's single live slot | No |
| `ACTIVE` | QR/window is live, awaiting credit | No |
| `AWAITING_VERIFICATION` | Customer says they paid; observers are watching | No |
| `OBSERVED` | A bank alert matched exactly — evidence only | No |
| `RECONCILED` | Statement confirmed UTR + amount; ledger posted | **Yes** |
| `EXPIRED` | Window elapsed without attribution | No |
| `CANCELLED` | Merchant cancelled | No |

---

## Architecture

```
 merchant                         PayProof                              bank
    │                                │                                    │
    │ POST /api/intents              │                                    │
    ├───────────────────────────────►│ intent (ACTIVE or QUEUED)          │
    │                                │  ├─ dynamic QR / UPI intent        │
    │                                │  └─ window timer + sweeper         │
    │                                │                                    │
    │                                │◄──── SMS / Gmail / Android ────────┤
    │                                │      alert (amount, UTR, time)     │
    │                                │                                    │
    │                                │ exact amount + live window?        │
    │                                │   yes → OBSERVED                   │
    │                                │   no  → review queue (no state)    │
    │                                │                                    │
    │                                │◄──── statement CSV ────────────────┤
    │                                │      UTR + amount                  │
    │                                │   match → RECONCILED               │
    │                                │           + double-entry ledger    │
    │                                │                                    │
    │◄──── signed webhooks ──────────┤ outbox: HMAC, retries, backoff     │
```

### Invariants

1. **Evidence never settles money.** Only a statement match moves an intent to `RECONCILED`.
2. **Exact paise matching.** No tolerance, no "close enough".
3. **One live slot per receiving account**, enforced by the database (`one_live_slot_per_account`), not by application hope.
4. **Late alerts are review items**, never automatic matches.
5. **Alert ingestion is idempotent** on `(account_id, utr)`; statement import is idempotent on `(account_id, utr)`.
6. **Webhooks are enqueued in the same transaction** as the state change that produced them.
7. **Every state change is recorded** with a reason in `intent_transitions`.

---

## Data model

| Table | Purpose |
| --- | --- |
| `merchants` | API key, receiving VPA, webhook URL + secret |
| `accounts` | Receiving accounts; the live-slot invariant is per account |
| `payment_intents` | Order, amount (paise), status, timestamps; `UNIQUE(merchant_id, order_id)` |
| `alerts` | Raw observed bank credits; `UNIQUE(account_id, utr)` |
| `intent_transitions` | Append-only state history with reasons |
| `webhook_deliveries` | Outbox: payload, signature, attempts, next attempt, last error |
| `statement_lines` | Imported statement rows; `UNIQUE(account_id, utr)` |
| `ledger_entries` | Double-entry rows posted at reconciliation |
| `alert_reviews` | Unattributed / late alerts awaiting a human |

The partial unique index is the important one:

```sql
CREATE UNIQUE INDEX one_live_slot_per_account
  ON payment_intents (account_id)
  WHERE status IN ('ACTIVE', 'AWAITING_VERIFICATION');
```

---

## API

All collection endpoints require `X-API-Key: <merchant key>` (or `?key=` for read-only browser links). The demo key is `pk_demo_dev`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness |
| `POST` | `/api/intents` | Create an intent (idempotent per order ID) |
| `GET` | `/api/intents` | List intents (`?limit=`) |
| `GET` | `/api/intents/:id` | Intent + timeline + alert + deliveries |
| `POST` | `/api/intents/:id/claim` | Customer says "I paid" → `AWAITING_VERIFICATION` |
| `POST` | `/api/intents/:id/cancel` | Cancel and free the slot |
| `POST` | `/api/simulator/alert` | Ingest a bank alert (observer stand-in) |
| `POST` | `/api/reconciliation/import` | Import statement CSV |
| `GET` | `/api/reconciliation/report` | Observed/unmatched/ledger report |
| `GET` | `/api/review` | Open review queue |
| `POST` | `/api/review/:id/resolve` | `{ action: "link" \| "dismiss", intentId? }` |
| `GET` | `/api/public/intents/:id` | Narrow status polling for the checkout page |

### Create an intent

```bash
curl -s http://localhost:4000/api/intents \
  -H 'x-api-key: pk_demo_dev' \
  -H 'content-type: application/json' \
  -d '{"orderId":"ORD-1042","amount":"249.00","note":"Blue shirt"}'
```

- `amount` is rupees (string or number, max 2 decimals) and is converted to integer paise.
- `amountPaise` may be sent instead.
- Re-posting the same `orderId` with the same amount returns the existing intent (`200`, `created:false`); a different amount is `409 ORDER_AMOUNT_MISMATCH`.

### Ingest an alert (observer stand-in)

```bash
curl -s http://localhost:4000/api/simulator/alert \
  -H 'x-api-key: pk_demo_dev' \
  -H 'content-type: application/json' \
  -d '{"amount":"249.00","utr":"412345678901","source":"sms"}'
```

Response includes `matched` (or `null`), `review` (or `null`), `duplicate`, and a reminder that observation is not settlement. Replaying the same UTR returns `duplicate:true` without touching any intent.

### Import a statement

```bash
curl -s http://localhost:4000/api/reconciliation/import \
  -H 'x-api-key: pk_demo_dev' \
  -H 'content-type: application/json' \
  -d '{"csv":"utr,amount_rupees,date\n412345678901,249.00,2026-11-03"}'
```

```json
{ "total": 1, "imported": 1, "duplicates": 0, "reconciled": 1, "unmatched": 0, "amountReconciledPaise": 24900 }
```

CSV rules: header optional; accepted amount headers are `amount_rupees` / `amount` / `amount_inr` / `rupees`, or `amount_paise`; date must be `YYYY-MM-DD` if present. A single bad line rejects the file (`422 INVALID_STATEMENT`) instead of partially importing it.

---

## Webhooks

Events: `payment.intent.active`, `payment.observed`, `payment.reconciled`, `payment.expired`, `payment.cancelled`.

Payload:

```json
{
  "event": "payment.observed",
  "deliveryId": "wd_...",
  "timestamp": 1762000000000,
  "settlementState": "NOT_RECONCILED",
  "paymentId": "pi_...",
  "orderId": "ORD-1042",
  "amount": "249.00",
  "amountPaise": 24900,
  "utr": "412345678901",
  "status": "OBSERVED",
  "expiresAt": 1762000300000
}
```

Headers: `X-PayProof-Event`, `X-PayProof-Delivery-Id`, `X-PayProof-Timestamp`, `X-PayProof-Signature`.

**Signature** = `sha256=` + HMAC-SHA256(secret, `` `${timestamp}.${rawBody}` ``). Verify against the **raw** body, not a re-serialised object:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const expected = 'sha256=' + createHmac('sha256', secret)
  .update(`${timestamp}.${rawBody}`)
  .digest('hex');

const ok = expected.length === signature.length &&
  timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
```

Delivery is at-least-once. Deduplicate on `deliveryId`, not on order ID. Retries use the backoff in `WEBHOOK_BACKOFF_MS` and stop after `WEBHOOK_MAX_ATTEMPTS` (`FAILED`). Because the outbox row is written in the same transaction as the state change, a rolled-back transition never emits a webhook and a committed one always has one queued.

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `API_KEY` | `pk_demo_dev` | Demo merchant key seeded on first boot |
| `PAYMENT_WINDOW_MS` | `300000` | Customer payment window |
| `LATE_GRACE_MS` | `1800000` | How far past expiry a late-alert suggestion is considered |
| `DB_DRIVER` | `pglite` | `pglite` or `postgres` |
| `PGLITE_DIR` | `./data/pgdata` | Embedded DB directory (`:memory:` for tests) |
| `DATABASE_URL` | — | Postgres connection string |
| `WEBHOOK_MAX_ATTEMPTS` | `6` | Attempts before `FAILED` |
| `WEBHOOK_BACKOFF_MS` | `1000,5000,25000,125000,600000,1800000` | Retry schedule |
| `WEBHOOK_TARGET` | `http://localhost:$PORT/webhook-sink` | Demo merchant target (synced on boot) |
| `DEMO_PORT` | `4100` | Port used by `npm run demo` |

Copy `.env.example` to `.env` only if you want to override defaults.

---

## Tests

`npm test` runs 29 tests across four files:

- `test/matcher.test.ts` — exact paise, live-only eligibility, clock skew, expiry bounds, FIFO tie-break, late-suggestion grace.
- `test/lifecycle.test.ts` — no skipping verification, terminal states, unknown states.
- `test/flow.test.ts` — full HTTP lifecycle: slot/FIFO, idempotent orders, wrong-amount review, exact match, duplicate UTR, claim rules, statement reconciliation, ledger balance, re-import idempotency, expiry + late alert, manual link, validation errors.
- `test/webhook.test.ts` — HMAC verification against a real local HTTP server, `DELIVERED` bookkeeping, retry/backoff and permanent `FAILED`.

The DB is PGlite `:memory:` per test process; no services required.

---

## Project layout

```
migrations/001_init.sql      schema + the live-slot partial unique index
src/config.ts                env loading and defaults
src/db.ts                    Db/Store abstraction, migrations, seed, PGlite lock
src/domain/                  pure matcher, transition table, row mapping, types
src/services/                intents, alerts, reconciliation, webhooks, sweeper
src/routes/                  JSON API, HTML pages, webhook sink
src/ui.ts                    server-rendered dashboard / checkout / timeline
src/app.ts, src/server.ts    Fastify assembly and process lifecycle
scripts/demo.ts              one-command end-to-end demo
scripts/reset.ts             delete local databases
docs/adr/                    the four decisions worth arguing about
test/                        node:test suites
```

---

## Roadmap

Phase 0–1 (this repo): schema, intents, exact matcher, review queue, statement reconciliation, ledger, outbox, dashboard, tests.

Next, in rough order:

1. **Real observers** — Android SMS forwarder, Gmail API, Messages-for-Web/CDP, each posting to `/api/simulator/alert`-shaped ingestion with source attestation.
2. **Statement ingestion beyond CSV** — bank PDF/email parsers that produce the same `statement_lines` shape.
3. **Merchant auth and tenancy** — hashed API keys, per-merchant accounts, key rotation, rate limits.
4. **Reconciliation operations** — bulk import, search by UTR/order, review audit log, reason codes.
5. **Refunds and chargebacks** — first-class objects with their own ledger entries, never edits to history.
6. **Operational hardening** — structured logs, metrics, dead-letter queue, signed replay tool, Postgres row locks under concurrency, backup/restore drills.
7. **Certification-grade compliance work** — PA/PG licensing analysis, bank/acquirer agreements, NPCI rules, data retention, security review. Software alone cannot make you a payment aggregator.

---

## Non-goals and safety

PayProof is an **experimental reference implementation**, not a certified or production-ready payment system. It is not affiliated with NPCI, RBI, any bank or any UPI app, and using it does not authorise you to operate a payment aggregator or handle third-party funds.

- Do not rely on browser callbacks, screenshots, alerts or this software's status as conclusive proof of settlement. Reconcile against the bank's official records.
- Use isolated test accounts and small amounts while experimenting. Observe applicable UPI limits, bank terms and NPCI requirements.
- Never commit real bank alerts, customer data, OTPs, API keys or webhook secrets. The seeded secret is demo-only; rotate anything that touches a real endpoint.
- The ledger is a reconciliation aid, not audited accounting. Handle duplicates, delays, refunds, disputes and failed payments explicitly.
- No warranty of accuracy, availability, security, compliance or fitness. Review the code and obtain qualified legal/compliance advice before any real-money use.

The design is inspired by the problem space of self-hosted UPI gateways such as YOUPI PG, but the implementation is independent and intentionally narrower: observe, prove, reconcile — do not pretend to be a bank.
