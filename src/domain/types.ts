export type IntentStatus =
  | 'QUEUED'
  | 'ACTIVE'
  | 'AWAITING_VERIFICATION'
  | 'OBSERVED'
  | 'RECONCILED'
  | 'EXPIRED'
  | 'CANCELLED';

export interface Merchant {
  id: string;
  name: string;
  vpa: string;
  api_key: string;
  webhook_url: string;
  webhook_secret: string;
  created_at: number;
}

export interface Account {
  id: string;
  merchant_id: string;
  vpa: string;
  label: string;
  created_at: number;
}

export interface Intent {
  id: string;
  merchant_id: string;
  account_id: string;
  order_id: string;
  amount_paise: number;
  note: string | null;
  status: IntentStatus;
  created_at: number;
  activated_at: number | null;
  expires_at: number | null;
  claimed_at: number | null;
  observed_at: number | null;
  reconciled_at: number | null;
}

export interface AlertRow {
  id: string;
  account_id: string;
  source: string;
  raw: string;
  amount_paise: number;
  utr: string;
  received_at: number;
  intent_id: string | null;
  created_at: number;
}

export interface Transition {
  id: string;
  intent_id: string;
  from_status: string | null;
  to_status: string;
  reason: string;
  created_at: number;
}

export interface Delivery {
  id: string;
  intent_id: string;
  event: string;
  payload: string;
  signature: string;
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  delivered_at: number | null;
  created_at: number;
}

export interface ReviewRow {
  id: string;
  alert_id: string;
  reason: string;
  suggested_intent_id: string | null;
  status: string;
  created_at: number;
  utr?: string;
  amount_paise?: number;
  source?: string;
  received_at?: number;
}
