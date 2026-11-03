# ADR 0001 — Evidence is not truth

**Status:** Accepted · 2026-11-03

## Context

Direct-to-bank UPI collection relies on weak observation channels: bank SMS, Gmail alerts, Android notification mirrors, or a browser callback. Each of them can be delayed, replayed, spoofed or lost, and none of them carries a reliable order identity. An alert proves that *some* credit happened, not *which* order it belongs to.

The common shortcut is to mark an order paid as soon as a matching SMS arrives. That is how merchants end up fulfilling orders for payments that later fail, arrive twice, or belong to a different order with the same amount. A related shortcut is to trust the checkout page's "success" callback, which is client-controlled.

## Decision

Model the problem as two distinct truths:

1. `OBSERVED` — a bank alert matched an intent exactly. This is recorded evidence. It emits `payment.observed` with `settlementState: "NOT_RECONCILED"` and **must not** be used to fulfil an order.
2. `RECONCILED` — an imported bank statement contains the same UTR and exact amount. Only this transition posts the double-entry ledger and emits `settlementState: "RECONCILED"`.

No other path may reach `RECONCILED`; the state machine rejects shortcuts (`ACTIVE → RECONCILED` is invalid). Late alerts do not match at all: they become review items that a human may explicitly link, recorded as `manual_review_late_match`.

## Consequences

- The product is explicitly reconciliation-first. Checkout success is deliberately unsatisfying until the statement lands; the UI says "payment seen, not settled".
- Operators need a statement-ingestion path (CSV today, bank PDF/email later). Without it, nothing settles — which is the honest failure mode.
- Consumers of webhooks must branch on `settlementState` rather than on HTTP 200 or `event` alone.
- Matching stays strict (exact paise, live window, ±60 s skew). Ambiguity goes to a human, not to a heuristic.
- Some legitimate same-day sales will sit in `OBSERVED` until the next statement. That latency is visible and measurable, not hidden.

## Alternatives rejected

- **Auto-fulfil on alert** — loses the distinction between evidence and truth; the exact failure this project exists to prevent.
- **Order-specific virtual accounts** — the correct industrial answer, but it requires an aggregator/bank integration and defeats the self-hosted premise.
- **Amount offsets (₹249.00 → ₹249.07)** — makes alerts unique but breaks paise-exact pricing, confuses customers and still fails on duplicates.
- **Balance polling** — cannot attribute a credit to an order or produce a UTR.
- **Browser callback as truth** — client-controlled; only useful as a hint (`AWAITING_VERIFICATION`).
