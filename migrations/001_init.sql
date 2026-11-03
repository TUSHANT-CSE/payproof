-- PayProof initial schema
-- Evidence is recorded, truth is reconciled.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vpa TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  webhook_url TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  vpa TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  order_id TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  note TEXT,
  status TEXT NOT NULL CHECK (status IN
    ('QUEUED','ACTIVE','AWAITING_VERIFICATION','OBSERVED','RECONCILED','EXPIRED','CANCELLED')),
  created_at BIGINT NOT NULL,
  activated_at BIGINT,
  expires_at BIGINT,
  claimed_at BIGINT,
  observed_at BIGINT,
  reconciled_at BIGINT,
  UNIQUE (merchant_id, order_id)
);

-- Invariant: at most ONE live payment slot per receiving account.
CREATE UNIQUE INDEX IF NOT EXISTS one_live_slot_per_account
  ON payment_intents (account_id)
  WHERE status IN ('ACTIVE', 'AWAITING_VERIFICATION');

CREATE INDEX IF NOT EXISTS idx_intents_status ON payment_intents (status);
CREATE INDEX IF NOT EXISTS idx_intents_created ON payment_intents (created_at);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  source TEXT NOT NULL,
  raw TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  utr TEXT NOT NULL,
  received_at BIGINT NOT NULL,
  intent_id TEXT REFERENCES payment_intents(id),
  created_at BIGINT NOT NULL,
  UNIQUE (account_id, utr)
);

CREATE TABLE IF NOT EXISTS intent_transitions (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES payment_intents(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transitions_intent ON intent_transitions (intent_id, created_at);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES payment_intents(id),
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL,
  last_error TEXT,
  delivered_at BIGINT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliveries_due ON webhook_deliveries (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS statement_lines (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  utr TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  txn_date TEXT NOT NULL,
  matched_intent_id TEXT REFERENCES payment_intents(id),
  imported_at BIGINT NOT NULL,
  UNIQUE (account_id, utr)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  entry_group TEXT NOT NULL,
  account_code TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_paise INTEGER NOT NULL,
  intent_id TEXT REFERENCES payment_intents(id),
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_reviews (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id),
  reason TEXT NOT NULL,
  suggested_intent_id TEXT REFERENCES payment_intents(id),
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at BIGINT NOT NULL
);
