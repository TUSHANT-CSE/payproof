import type { Db, Store } from '../db.ts';
import type { Intent } from '../domain/types.ts';
import { toIntent } from '../domain/map.ts';
import { recordTransition } from '../domain/lifecycle.ts';
import { ApiError } from '../lib/errors.ts';
import { parseRupeesToPaise } from '../lib/money.ts';
import { serialize, uid } from '../lib/util.ts';
import { enqueueWebhook } from './webhooks.ts';
import { getAccount, getMerchant } from './merchant.ts';

export interface StatementLine {
  utr: string;
  amountPaise: number;
  txnDate: string;
}

export interface ParsedStatement {
  lines: StatementLine[];
  errors: string[];
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

const INR_HEADERS = new Set(['amount', 'amount_rupees', 'amount_inr', 'rupees']);
const PAISE_HEADERS = new Set(['amount_paise', 'paise']);

/**
 * Parse a bank statement export. Supported header:
 *   utr,amount_rupees,date        (or amount_paise)
 * Headerless files are read as utr,amount,date.
 */
export function parseStatementCsv(csv: string): ParsedStatement {
  const lines: StatementLine[] = [];
  const errors: string[] = [];
  const rawLines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) return { lines, errors: ['Statement is empty'] };

  let utrIdx = 0;
  let amountIdx = 1;
  let dateIdx = 2;
  let amountIsPaise = false;
  let firstDataRow = 0;

  const header = splitCsvLine(rawLines[0]).map((c) => c.toLowerCase());
  if (header.includes('utr')) {
    utrIdx = header.indexOf('utr');
    const paiseAt = header.findIndex((h) => PAISE_HEADERS.has(h));
    const rupeesAt = header.findIndex((h) => INR_HEADERS.has(h));
    if (paiseAt >= 0) {
      amountIdx = paiseAt;
      amountIsPaise = true;
    } else if (rupeesAt >= 0) {
      amountIdx = rupeesAt;
    } else {
      return { lines, errors: ['Header must contain an amount column (amount_rupees or amount_paise)'] };
    }
    const dateAt = header.indexOf('date');
    dateIdx = dateAt >= 0 ? dateAt : -1;
    firstDataRow = 1;
  }

  for (let i = firstDataRow; i < rawLines.length; i++) {
    const cells = splitCsvLine(rawLines[i]);
    const lineNo = i + 1;
    const utr = cells[utrIdx] ?? '';
    if (!/^[A-Za-z0-9]{6,32}$/.test(utr)) {
      errors.push(`Line ${lineNo}: invalid UTR "${utr}"`);
      continue;
    }
    const rawAmount = cells[amountIdx] ?? '';
    const amountPaise = amountIsPaise
      ? /^\d+$/.test(rawAmount)
        ? Number(rawAmount)
        : null
      : parseRupeesToPaise(rawAmount);
    if (amountPaise === null || !Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
      errors.push(`Line ${lineNo}: invalid amount "${rawAmount}"`);
      continue;
    }
    const date = dateIdx >= 0 ? (cells[dateIdx] ?? '') : '';
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push(`Line ${lineNo}: date must be YYYY-MM-DD (got "${date}")`);
      continue;
    }
    lines.push({ utr, amountPaise, txnDate: date || new Date().toISOString().slice(0, 10) });
  }
  return { lines, errors };
}

export interface ImportSummary {
  total: number;
  imported: number;
  duplicates: number;
  reconciled: number;
  unmatched: number;
  amountReconciledPaise: number;
}

/**
 * Import a statement and reconcile OBSERVED intents whose alert UTR appears in
 * it with the exact amount. A row that does not match stays visible in the
 * report as `unmatched`; nothing is ever force-matched.
 */
export async function importStatement(
  store: Store,
  accountId: string,
  csv: string,
): Promise<ImportSummary> {
  const parsed = parseStatementCsv(csv);
  if (parsed.errors.length > 0) {
    throw new ApiError(
      422,
      'INVALID_STATEMENT',
      `${parsed.errors.length} bad line(s): ${parsed.errors.slice(0, 3).join('; ')}`,
    );
  }
  if (parsed.lines.length === 0) {
    throw new ApiError(422, 'EMPTY_STATEMENT', 'No statement lines to import');
  }

  return serialize(() =>
    store.tx(async (d) => {
      const account = await getAccount(d, accountId);
      const merchant = await getMerchant(d, account.merchant_id);
      const summary: ImportSummary = {
        total: parsed.lines.length,
        imported: 0,
        duplicates: 0,
        reconciled: 0,
        unmatched: 0,
        amountReconciledPaise: 0,
      };

      for (const line of parsed.lines) {
        const inserted = await d.query(
          `INSERT INTO statement_lines
             (id, account_id, utr, amount_paise, txn_date, imported_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (account_id, utr) DO NOTHING
           RETURNING *`,
          ['sl_' + uid(), account.id, line.utr, line.amountPaise, line.txnDate, Date.now()],
        );
        if (inserted[0]) summary.imported++;
        else summary.duplicates++;

        const existing = await d.query(
          'SELECT * FROM statement_lines WHERE account_id = $1 AND utr = $2',
          [account.id, line.utr],
        );
        const stmt = existing[0];
        if (!stmt || stmt.matched_intent_id) continue;

        const alertRows = await d.query(
          'SELECT id, intent_id, amount_paise FROM alerts WHERE account_id = $1 AND utr = $2',
          [account.id, line.utr],
        );
        const alert = alertRows[0];
        if (!alert?.intent_id || Number(alert.amount_paise) !== line.amountPaise) {
          summary.unmatched++;
          continue;
        }

        const intentRows = await d.query('SELECT * FROM payment_intents WHERE id = $1', [
          String(alert.intent_id),
        ]);
        if (!intentRows[0]) {
          summary.unmatched++;
          continue;
        }
        const intent = toIntent(intentRows[0]);
        if (intent.status !== 'OBSERVED') {
          // Already reconciled or not in a reconcilable state — leave it for a human.
          if (intent.status !== 'RECONCILED') summary.unmatched++;
          continue;
        }

        const updated = await d.query(
          `UPDATE payment_intents SET status='RECONCILED', reconciled_at=$2
            WHERE id=$1 AND status='OBSERVED' RETURNING *`,
          [intent.id, Date.now()],
        );
        if (!updated[0]) {
          summary.unmatched++;
          continue;
        }
        await d.query('UPDATE statement_lines SET matched_intent_id=$2 WHERE id=$1', [
          String(stmt.id),
          intent.id,
        ]);
        await recordTransition(d, intent.id, 'OBSERVED', 'RECONCILED', 'bank_statement_match');
        await postLedger(d, intent.id, account.vpa, account.id, merchant.id, intent.amount_paise);
        await enqueueWebhook(d, merchant, toIntent(updated[0]), 'payment.reconciled', line.utr, 'RECONCILED');
        summary.reconciled++;
        summary.amountReconciledPaise += intent.amount_paise;
      }
      return summary;
    }),
  );
}

async function postLedger(
  d: Db,
  intentId: string,
  vpa: string,
  accountId: string,
  merchantId: string,
  amountPaise: number,
): Promise<void> {
  const group = 'rec_' + intentId;
  const now = Date.now();
  const rows: Array<[string, 'DEBIT' | 'CREDIT']> = [
    [`BANK:${accountId}:${vpa}`, 'DEBIT'],
    [`MERCHANT_PAYABLE:${merchantId}`, 'CREDIT'],
  ];
  for (const [code, direction] of rows) {
    await d.query(
      `INSERT INTO ledger_entries
         (id, entry_group, account_code, direction, amount_paise, intent_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uid(), group, code, direction, amountPaise, intentId, now],
    );
  }
}

export interface ReconciliationReport {
  observedAwaitingStatement: Array<{
    id: string;
    order_id: string;
    amount_paise: number;
    observed_at: number | null;
  }>;
  unmatchedLines: Array<{
    id: string;
    utr: string;
    amount_paise: number;
    txn_date: string;
    imported_at: number;
  }>;
  ledger: Array<{ direction: string; total_paise: number; entries: number }>;
  reconciledCount: number;
  reconciledValuePaise: number;
}

export async function reconciliationReport(d: Db, merchantId: string): Promise<ReconciliationReport> {
  const observed = await d.query(
    `SELECT id, order_id, amount_paise, observed_at FROM payment_intents
      WHERE merchant_id = $1 AND status = 'OBSERVED' ORDER BY observed_at ASC`,
    [merchantId],
  );
  const unmatched = await d.query(
    `SELECT s.id, s.utr, s.amount_paise, s.txn_date, s.imported_at
       FROM statement_lines s JOIN accounts a ON a.id = s.account_id
      WHERE a.merchant_id = $1 AND s.matched_intent_id IS NULL
      ORDER BY s.imported_at DESC LIMIT 50`,
    [merchantId],
  );
  const ledger = await d.query(
    `SELECT l.direction, SUM(l.amount_paise)::bigint AS total, COUNT(*)::int AS entries
       FROM ledger_entries l JOIN payment_intents i ON i.id = l.intent_id
      WHERE i.merchant_id = $1 GROUP BY l.direction`,
    [merchantId],
  );
  const totals = await d.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_paise),0)::bigint AS v
       FROM payment_intents WHERE merchant_id = $1 AND status = 'RECONCILED'`,
    [merchantId],
  );
  return {
    observedAwaitingStatement: observed.map((r) => ({
      id: String(r.id),
      order_id: String(r.order_id),
      amount_paise: Number(r.amount_paise),
      observed_at: r.observed_at === null ? null : Number(r.observed_at),
    })),
    unmatchedLines: unmatched.map((r) => ({
      id: String(r.id),
      utr: String(r.utr),
      amount_paise: Number(r.amount_paise),
      txn_date: String(r.txn_date),
      imported_at: Number(r.imported_at),
    })),
    ledger: ledger.map((r) => ({
      direction: String(r.direction),
      total_paise: Number(r.total),
      entries: Number(r.entries),
    })),
    reconciledCount: Number(totals[0]?.n ?? 0),
    reconciledValuePaise: Number(totals[0]?.v ?? 0),
  };
}
