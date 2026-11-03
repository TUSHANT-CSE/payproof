# ADR 0002 — Transactional webhook outbox

**Status:** Accepted · 2026-11-03

## Context

State changes must notify merchants, but HTTP delivery is unreliable and slow. Delivering inline inside the business transaction creates two failures: a slow merchant endpoint holds a database transaction open, and a committed state change can be lost if the process dies before the request completes. Delivering before commit can emit a webhook for a transaction that later rolls back.

## Decision

Use a transactional outbox.

- `enqueueWebhook()` inserts a `webhook_deliveries` row **inside the same transaction** as the intent transition.
- A background worker polls due rows, POSTs the stored payload, and updates `DELIVERED`, `PENDING` with a future `next_attempt_at`, or `FAILED`.
- Payloads are signed at enqueue time with `HMAC-SHA256(secret, timestamp + "." + rawBody)`.
- Delivery is **at-least-once**; consumers deduplicate on `deliveryId`.
- Backoff is configurable (`WEBHOOK_BACKOFF_MS`); after `WEBHOOK_MAX_ATTEMPTS` the row becomes `FAILED` and stays visible on the dashboard.
- The demo receiver `/webhook-sink` verifies the signature against the raw body and records validity.

## Consequences

- A rolled-back transition emits no webhook; a committed transition always has a queued delivery. That is the property worth protecting.
- Merchants will occasionally receive duplicates. This is documented and is why `deliveryId` exists.
- The database doubles as the queue. For this scale that is simpler and more reliable than adding a broker; it also makes delivery state inspectable with SQL.
- A single worker is enough for the demo. Multiple workers would need `FOR UPDATE SKIP LOCKED` or an equivalent claim step; that is a Phase 2 concern.
- Old `DELIVERED` rows need pruning in a long-running deployment.

## Alternatives rejected

- **Inline `fetch` after commit** — loses deliveries on crash, blocks request latency, no retry state.
- **Inline `fetch` inside the transaction** — holds locks on a third-party timeout; can emit for rolled-back work.
- **External queue (Kafka/SQS)** — operationally heavier than the problem, and still needs an outbox for atomicity.
- **Change data capture** — attractive later, unnecessary for a single-process reference implementation.
