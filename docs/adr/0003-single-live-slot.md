# ADR 0003 — One live slot per receiving account

**Status:** Accepted · 2026-11-03

## Context

A bank alert contains an amount, a UTR and a time. It does not contain the merchant's order ID. If two intents for the same amount are live at the same time on the same VPA, an incoming credit is genuinely ambiguous: attributing it to either one is a guess. Guessing is how double-fulfilment and false "paid" states happen.

A personal or business UPI VPA also cannot create per-order virtual accounts without an aggregator.

## Decision

Allow **at most one live intent** (`ACTIVE` or `AWAITING_VERIFICATION`) per receiving account at any time. Additional intents are accepted into `QUEUED` and promoted FIFO when the live slot is freed by observation, expiry or cancellation.

The invariant is enforced by the database, not by application checks:

```sql
CREATE UNIQUE INDEX one_live_slot_per_account
  ON payment_intents (account_id)
  WHERE status IN ('ACTIVE', 'AWAITING_VERIFICATION');
```

A second active insert fails at the storage layer even if application logic is buggy or two requests race. Promotion uses a guarded `UPDATE ... WHERE status='QUEUED'`, and the sweeper promotes after expiry.

## Consequences

- Attribution ambiguity from same-amount concurrent orders is eliminated by construction.
- Throughput per account is bounded by how fast a customer completes payment (or by the window). Merchants who need parallelism add receiving accounts; the schema already scopes the invariant to `account_id`.
- Customers may wait in `QUEUED`. The checkout page states this explicitly instead of showing a QR that could collide.
- If a customer abandons the QR, the slot stays occupied until expiry; the sweeper is therefore part of correctness, not just cleanup.
- AWAITING_VERIFICATION still occupies the slot: the customer claims to have paid, so replacing that intent immediately would recreate ambiguity.

## Alternatives rejected

- **Match by amount across all open intents** — ambiguous with equal amounts and vulnerable to alert reordering.
- **Put the order ID in the UPI note and match on it** — banks and apps do not reliably preserve or expose the note in credit alerts.
- **Unique amounts per open order** — fragile, awkward for pricing (`₹249.00`, `₹249.01`), and still ambiguous on duplicates.
- **Virtual account per order** — correct but requires a PSP/aggregator integration, which is outside the self-hosted premise.
- **First-come-first-served guess with manual fix later** — makes the ledger wrong by default and hides the ambiguity from the operator.
