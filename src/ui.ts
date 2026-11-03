import type { Account, Intent, Merchant, ReviewRow } from './domain/types.ts';
import type { DashboardStats, IntentDetail } from './services/intents.ts';
import type { ReconciliationReport } from './services/reconciliation.ts';
import type { Delivery } from './domain/types.ts';
import { fmtINR } from './lib/money.ts';

export function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function clock(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('en-IN', { hour12: false });
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const BADGE: Record<string, string> = {
  QUEUED: 'muted',
  ACTIVE: 'info',
  AWAITING_VERIFICATION: 'warn',
  OBSERVED: 'violet',
  RECONCILED: 'ok',
  EXPIRED: 'muted',
  CANCELLED: 'muted',
  PENDING: 'warn',
  DELIVERED: 'ok',
  FAILED: 'danger',
  OPEN: 'warn',
  RESOLVED: 'ok',
  DISMISSED: 'muted',
};

export function badge(status: string, label?: string): string {
  return `<span class="badge ${BADGE[status] ?? 'muted'}"><i></i>${esc(label ?? status)}</span>`;
}

const CSS = `
:root{
  --bg:#070b12;--panel:#0d141f;--panel2:#111a28;--line:#1d2a3c;--text:#e7eef8;--muted:#8ca0b8;
  --accent:#2dd4bf;--accent2:#60a5fa;--ok:#34d399;--warn:#fbbf24;--danger:#fb7185;--violet:#a78bfa;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit;text-decoration:none}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.wrap{max-width:1180px;margin:0 auto;padding:0 22px 72px}
header.top{border-bottom:1px solid var(--line);background:rgba(7,11,18,.86);backdrop-filter:blur(8px);position:sticky;top:0;z-index:5}
.topbar{max-width:1180px;margin:0 auto;padding:14px 22px;display:flex;align-items:center;gap:18px}
.logo{font-weight:700;letter-spacing:-.02em;font-size:18px;display:flex;align-items:center;gap:9px}
.logo .dot{width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 14px var(--accent)}
.logo em{font-style:normal;color:var(--accent)}
.tag{color:var(--muted);font-size:12px;border:1px solid var(--line);padding:3px 8px;border-radius:99px}
nav{margin-left:auto;display:flex;gap:16px;font-size:13.5px;color:var(--muted)}
nav a:hover{color:var(--text)}
.hero{padding:42px 0 26px;display:flex;gap:28px;align-items:flex-end;justify-content:space-between;flex-wrap:wrap}
.hero h1{font-size:34px;line-height:1.1;letter-spacing:-.03em;margin:0 0 10px;max-width:640px}
.hero h1 span{color:var(--accent)}
.hero p{margin:0;color:var(--muted);max-width:620px}
.hero .vpa{text-align:right;font-size:13px;color:var(--muted)}
.hero .vpa b{display:block;color:var(--text);font-size:16px;font-family:ui-monospace,monospace}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:8px 0 30px}
.stat{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.stat .k{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}
.stat .v{font-size:26px;font-weight:650;letter-spacing:-.02em;margin-top:6px;font-variant-numeric:tabular-nums}
.stat .s{font-size:12px;color:var(--muted);margin-top:3px}
.stat.alert .v{color:var(--warn)}
.grid{display:grid;grid-template-columns:1.05fr .95fr;gap:20px;align-items:start}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px}
.panel h2{font-size:15px;margin:0 0 4px;letter-spacing:-.01em}
.panel .hint{color:var(--muted);font-size:12.5px;margin:0 0 16px}
.panel + .panel{margin-top:20px}
label{display:block;font-size:11.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:12px 0 6px}
input,select,textarea{width:100%;background:#080e17;border:1px solid var(--line);color:var(--text);border-radius:9px;padding:10px 12px;font:inherit;font-size:14px;outline:none}
input:focus,select:focus,textarea:focus{border-color:#2a4a63;box-shadow:0 0 0 3px rgba(45,212,191,.08)}
textarea{min-height:110px;resize:vertical;font-family:ui-monospace,monospace;font-size:12.5px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
button,.btn{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:#03211d;border:0;border-radius:9px;padding:10px 16px;font-weight:650;font-size:13.5px;cursor:pointer;font-family:inherit}
button:hover{filter:brightness(1.06)}
button.ghost,.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--text);font-weight:500}
button.danger{background:transparent;border:1px solid #43202a;color:var(--danger)}
.actions{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;align-items:center}
.msg{border-radius:11px;padding:11px 14px;font-size:13.5px;margin-bottom:18px;border:1px solid}
.msg.ok{border-color:#134e3c;background:#08211a;color:#8ff0d2}
.msg.err{border-color:#4c1d28;background:#210b11;color:#ffb3c0}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600;padding:0 10px 9px}
td{padding:11px 10px;border-top:1px solid var(--line);vertical-align:middle}
tr:hover td{background:#0b1320}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.badge{display:inline-flex;align-items:center;gap:6px;border-radius:99px;padding:3px 9px;font-size:11px;font-weight:600;letter-spacing:.02em;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.badge i{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.9}
.badge.ok{color:var(--ok);border-color:#124634;background:#082019}
.badge.info{color:var(--accent2);border-color:#17385c;background:#08172a}
.badge.warn{color:var(--warn);border-color:#4a3610;background:#1d1505}
.badge.danger{color:var(--danger);border-color:#4c1d28;background:#210b11}
.badge.violet{color:var(--violet);border-color:#33265c;background:#150f29}
.badge.muted{color:var(--muted)}
.empty{color:var(--muted);font-size:13px;padding:18px 0;text-align:center;border:1px dashed var(--line);border-radius:11px;margin-top:12px}
.review{border:1px solid var(--line);border-radius:12px;padding:13px 14px;margin-top:10px;background:var(--panel2)}
.review .top{display:flex;justify-content:space-between;gap:10px;align-items:center}
.review .why{font-size:12.5px;color:var(--muted);margin-top:7px}
.review form{display:inline}
.review .actions{margin-top:10px}
.kv{display:flex;justify-content:space-between;gap:14px;padding:8px 0;border-top:1px solid var(--line);font-size:13px}
.kv span{color:var(--muted)}
.mono.small{font-size:11.5px;color:var(--muted);word-break:break-all}
.split{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.foot{color:#5d708a;font-size:11.5px;text-align:center;margin-top:44px;line-height:1.7}
.brand{font-family:ui-monospace,monospace}
.checkout-body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:26px 16px;background:
 radial-gradient(900px 500px at 50% -10%,rgba(45,212,191,.09),transparent 60%),var(--bg)}
.checkout{width:100%;max-width:430px;background:var(--panel);border:1px solid var(--line);border-radius:20px;overflow:hidden}
.checkout .head{padding:20px 24px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center}
.checkout .body{padding:24px}
.checkout .amount{font-size:34px;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.checkout .order{color:var(--muted);font-size:12.5px;margin-top:3px}
.qrbox{background:#fff;border-radius:14px;padding:12px;width:250px;margin:20px auto 6px;display:flex;justify-content:center}
.qrbox svg{display:block;width:100%;height:auto}
.timer{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;color:var(--muted);margin-top:15px}
.timer b{font-family:ui-monospace,monospace;font-size:17px;color:var(--text);letter-spacing:.04em}
.bar{height:4px;background:#0a111b;border-radius:99px;overflow:hidden;margin-top:7px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));width:100%;transition:width .9s linear}
.notice{border:1px solid var(--line);background:var(--panel2);border-radius:11px;padding:12px 14px;font-size:13px;color:var(--muted);margin-top:16px}
.notice b{color:var(--text);display:block;margin-bottom:2px}
.checkout .foot2{padding:16px 24px 22px;border-top:1px solid var(--line);font-size:11.5px;color:#5d708a;text-align:center}
.steps{counter-reset:s;margin:0;padding:0;list-style:none}
.steps li{position:relative;padding:0 0 14px 35px;color:var(--muted);font-size:13px}
.steps li:before{counter-increment:s;content:counter(s);position:absolute;left:0;top:0;width:22px;height:22px;border-radius:50%;border:1px solid #26435a;color:var(--accent);display:grid;place-items:center;font-size:11px;font-family:ui-monospace,monospace}
.steps li b{color:var(--text);font-weight:600}
.timeline{margin:4px 0 0;padding:0;list-style:none}
.timeline li{position:relative;padding:0 0 16px 24px;border-left:1px solid var(--line);margin-left:6px}
.timeline li:before{content:"";position:absolute;left:-4.5px;top:2px;width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px rgba(45,212,191,.1)}
.timeline li:last-child{padding-bottom:0}
.timeline .t{font-size:13px}
.timeline .m{font-size:11.5px;color:var(--muted);margin-top:1px}
.log{font-family:ui-monospace,monospace;font-size:11.5px;border:1px solid var(--line);border-radius:11px;max-height:260px;overflow:auto;background:#080e17}
.log div{padding:8px 11px;border-bottom:1px solid var(--line);display:flex;gap:9px;flex-wrap:wrap;align-items:baseline}
.log div:last-child{border-bottom:0}
.log .ev{color:var(--accent)}
.log .ok{color:var(--ok)}
.log .bad{color:var(--danger)}
@media(max-width:900px){.stats{grid-template-columns:1fr 1fr}.grid,.split{grid-template-columns:1fr}.hero{padding-top:28px}.hero h1{font-size:27px}}
`;

function layout(title: string, body: string, opts: { bare?: boolean } = {}): string {
  if (opts.bare) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header class="top"><div class="topbar">
  <a class="logo" href="/"><span class="dot"></span>pay<em>proof</em></a>
  <span class="tag">evidence ≠ truth</span>
  <nav><a href="/">Dashboard</a><a href="/health">Health</a></nav>
</div></header>
<div class="wrap">${body}<div class="foot">PayProof demo · reconciliation-first UPI collections · all data local<br>
Only <b>RECONCILED</b> means settled. Bank alerts are evidence, not proof.</div></div>
</body></html>`;
}

function msgBanner(msg?: string, kind?: string): string {
  if (!msg) return '';
  return `<div class="msg ${kind === 'err' ? 'err' : 'ok'}">${esc(msg)}</div>`;
}

function empty(text: string): string {
  return `<div class="empty">${esc(text)}</div>`;
}

export interface DashboardData {
  merchant: Merchant;
  account: Account;
  stats: DashboardStats;
  intents: Intent[];
  reviews: ReviewRow[];
  deliveries: Array<Delivery & { order_id: string }>;
  report: ReconciliationReport;
  log: Array<{
    at: number;
    event: string;
    deliveryId: string;
    orderId: string;
    amount: string;
    signatureOk: boolean;
    body: string;
  }>;
  liveSlot: Intent | null;
  msg?: string;
  kind?: string;
}

export function dashboardPage(data: DashboardData): string {
  const { merchant, account, stats, intents, reviews, deliveries, report } = data;
  const live = stats.byStatus.ACTIVE ?? 0;

  const statsHtml = `
  <div class="stats">
    <div class="stat"><div class="k">Live slot</div><div class="v">${live}<span style="font-size:13px;color:var(--muted);font-weight:400"> / 1</span></div><div class="s">${data.liveSlot ? 'occupied · ' + esc(data.liveSlot.order_id) : 'free — next intent activates instantly'}</div></div>
    <div class="stat alert"><div class="k">Awaiting statement</div><div class="v">${stats.awaitingReconciliation}</div><div class="s">₹${fmtINR(stats.awaitingValuePaise)} observed, not reconciled</div></div>
    <div class="stat"><div class="k">Review queue</div><div class="v">${stats.openReviews}</div><div class="s">unattributed bank alerts</div></div>
    <div class="stat"><div class="k">Webhook outbox</div><div class="v">${stats.pendingDeliveries}</div><div class="s">${stats.failedDeliveries} failed permanently</div></div>
  </div>`;

  const intentRows = intents.length
    ? intents
        .map(
          (i) => `<tr>
        <td><a href="/intents/${esc(i.id)}"><span class="mono">${esc(i.order_id)}</span></a><div class="mono small">${esc(i.id.slice(0, 14))}…</div></td>
        <td class="num">₹${fmtINR(i.amount_paise)}</td>
        <td>${badge(i.status)}</td>
        <td class="mono small">${clock(i.created_at)}</td>
        <td class="num"><a class="btn ghost" style="padding:5px 10px;font-size:11.5px" href="/checkout/${esc(i.id)}">Checkout</a></td>
      </tr>`,
        )
        .join('')
    : '';

  const reviewCards = reviews.length
    ? reviews
        .map(
          (r) => `<div class="review">
      <div class="top"><span class="mono">UTR ${esc(r.utr ?? '')}</span>${badge('OPEN', r.reason.replaceAll('_', ' '))}</div>
      <div class="why">₹${fmtINR(r.amount_paise ?? 0)} via ${esc(r.source ?? 'unknown')} · received ${ago(r.received_at ?? r.created_at)}
      ${r.suggested_intent_id ? `<br>Suggested intent: <a class="mono" href="/intents/${esc(r.suggested_intent_id)}">${esc(r.suggested_intent_id.slice(0, 16))}…</a> (most recent expired, same amount)` : '<br>No intent of this amount was ever open.'}</div>
      <div class="actions">
        ${r.suggested_intent_id ? `<form method="post" action="/ui/review/${esc(r.id)}"><input type="hidden" name="action" value="link"><button style="padding:7px 12px;font-size:12px">Link to suggested intent</button></form>` : ''}
        <form method="post" action="/ui/review/${esc(r.id)}"><input type="hidden" name="action" value="dismiss"><button class="ghost" style="padding:7px 12px;font-size:12px">Dismiss</button></form>
      </div>
    </div>`,
        )
        .join('')
    : empty('No unattributed alerts. Every observed credit either matched exactly or has been resolved.');

  const deliveryRows = deliveries
    .map(
      (d) => `<tr>
      <td><span class="mono">${esc(d.event)}</span><div class="mono small">${esc(d.order_id)}</div></td>
      <td>${badge(d.status)}</td>
      <td class="num">${d.attempts}</td>
      <td class="mono small">${d.last_error ? esc(d.last_error.slice(0, 42)) : '—'}</td>
      <td class="mono small">${clock(d.created_at)}</td>
    </tr>`,
    )
    .join('');

  const logHtml = data.log.length
    ? data.log
        .slice()
        .reverse()
        .map(
          (l) => `<div><span class="ev">${esc(l.event)}</span>
        <span class="${l.signatureOk ? 'ok' : 'bad'}">${l.signatureOk ? 'sig ✓' : 'sig ✗'}</span>
        <span>${esc(l.orderId)}</span><span>₹${esc(l.amount)}</span>
        <span class="mono" style="color:#5d708a">${clock(l.at)}</span></div>`,
        )
        .join('')
    : '<div style="color:var(--muted)">No webhooks received yet. The outbox will POST signed deliveries to /webhook-sink.</div>';

  const observedList = report.observedAwaitingStatement.length
    ? report.observedAwaitingStatement
        .map(
          (o) => `<div class="kv"><span><a href="/intents/${esc(o.id)}" class="mono">${esc(o.order_id)}</a></span><span>₹${fmtINR(o.amount_paise)}</span></div>`,
        )
        .join('')
    : empty('Nothing observed is waiting for a statement.');

  const unmatchedList = report.unmatchedLines.length
    ? report.unmatchedLines
        .map(
          (u) => `<div class="kv"><span class="mono">${esc(u.utr)}</span><span>₹${fmtINR(u.amount_paise)} · ${esc(u.txn_date)}</span></div>`,
        )
        .join('')
    : '<div class="empty" style="border:0">No unmatched statement lines.</div>';

  const ledgerLine = report.ledger.length
    ? report.ledger
        .map((l) => `<div class="kv"><span>${esc(l.direction)} · ${l.entries} entries</span><span>₹${fmtINR(l.total_paise)}</span></div>`)
        .join('')
    : '<div class="kv"><span>No ledger entries yet</span><span>₹0.00</span></div>';

  const body = `
  ${msgBanner(data.msg, data.kind)}
  <section class="hero">
    <div>
      <h1>Collect once. <span>Prove it twice.</span></h1>
      <p>A UPI collection toolkit where a bank alert is only <em>evidence</em>. Money is marked settled only after the bank statement matches the alert and a double-entry ledger is posted.</p>
    </div>
    <div class="vpa">Receiving account<b>${esc(account.vpa)}</b>${esc(merchant.name)} · ${esc(account.label)}</div>
  </section>
  ${statsHtml}
  <div class="grid">
    <div>
      <div class="panel">
        <h2>Create a payment intent</h2>
        <p class="hint">One intent per order. Only one can hold the live slot; the rest wait in FIFO.</p>
        <form method="post" action="/ui/intents">
          <div class="row">
            <div><label>Order ID</label><input name="orderId" placeholder="ORD-1042" required></div>
            <div><label>Amount (₹)</label><input name="amount" placeholder="249.00" inputmode="decimal" required></div>
          </div>
          <label>Note (optional)</label>
          <input name="note" placeholder="Blue cotton shirt" maxlength="80">
          <div class="actions"><button type="submit">Create intent →</button><span class="mono small">POST /api/intents</span></div>
        </form>
      </div>

      <div class="panel">
        <h2>Simulate a bank alert</h2>
        <p class="hint">Stand-in for the SMS / Gmail observer. Exact paise amount required to match. Reusing a UTR is ignored.</p>
        <form method="post" action="/ui/simulate">
          <div class="row">
            <div><label>Amount (₹)</label><input name="amount" placeholder="249.00" inputmode="decimal" required></div>
            <div><label>UTR (blank = random)</label><input name="utr" placeholder="412345678901" maxlength="32"></div>
          </div>
          <label>Source</label>
          <select name="source">
            <option value="sms">Bank SMS</option>
            <option value="gmail">Gmail alert</option>
            <option value="cdp">Messages Web (CDP)</option>
            <option value="statement">Manual entry</option>
          </select>
          <div class="actions"><button type="submit">Send alert →</button><span class="mono small">POST /api/simulator/alert</span></div>
        </form>
      </div>

      <div class="panel">
        <h2>Import bank statement</h2>
        <p class="hint">CSV: <span class="mono">utr,amount_rupees,date</span>. Only OBSERVED intents with a matching UTR + exact amount become RECONCILED.</p>
        <form method="post" action="/ui/import">
          <textarea name="csv" placeholder="utr,amount_rupees,date
412345678901,249.00,2026-11-03"></textarea>
          <div class="actions"><button type="submit">Import & reconcile →</button><span class="mono small">POST /api/reconciliation/import</span></div>
        </form>
      </div>
    </div>

    <div>
      <div class="panel">
        <h2>The 60-second demo</h2>
        <p class="hint">What this screen is proving.</p>
        <ol class="steps">
          <li><b>Create an intent.</b> It takes the account's only live slot and gets a dynamic QR + 5-minute window.</li>
          <li><b>Send a bank alert.</b> Exact amount and inside the window → intent becomes <span class="mono">OBSERVED</span>. Webhook fires with <span class="mono">NOT_RECONCILED</span>.</li>
          <li><b>Import the statement.</b> UTR + amount match → <span class="mono">RECONCILED</span>, two ledger rows posted, second webhook says <span class="mono">RECONCILED</span>.</li>
          <li><b>Try to break it.</b> Wrong amount, late alert, duplicate UTR — none of them can mark money as settled.</li>
        </ol>
        <div class="kv" style="margin-top:8px"><span>API key (demo)</span><span class="mono">${esc(merchant.api_key)}</span></div>
        <div class="kv"><span>Webhook secret</span><span class="mono">${esc(merchant.webhook_secret.slice(0, 10))}…</span></div>
        <div class="kv"><span>Settlement invariant</span><span>statement + exact UTR</span></div>
      </div>

      <div class="panel">
        <h2>Review queue</h2>
        <p class="hint">Late or unattributable alerts. Nothing here changes payment state automatically.</p>
        ${reviewCards}
      </div>
    </div>
  </div>

  <div class="panel" style="margin-top:20px">
    <h2>Payment intents</h2>
    <p class="hint">Newest first. Click through for the full transition timeline.</p>
    ${intents.length ? `<table><thead><tr><th>Order</th><th class="num">Amount</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>${intentRows}</tbody></table>` : empty('No intents yet. Create one above.')}
  </div>

  <div class="split" style="margin-top:20px">
    <div class="panel">
      <h2>Reconciliation report</h2>
      <p class="hint">Observed money is not settled money.</p>
      <div class="kv"><span>Reconciled payments</span><span>${report.reconciledCount} · ₹${fmtINR(report.reconciledValuePaise)}</span></div>
      <div style="margin-top:14px"><div class="k" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">Observed, awaiting statement</div>${observedList}</div>
      <div style="margin-top:16px"><div class="k" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">Unmatched statement lines</div>${unmatchedList}</div>
      <div style="margin-top:16px"><div class="k" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">Double-entry ledger</div>${ledgerLine}</div>
    </div>
    <div class="panel">
      <h2>Webhook outbox</h2>
      <p class="hint">HMAC-SHA256 over <span class="mono">timestamp.body</span>, retried with backoff.</p>
      ${deliveries.length ? `<table><thead><tr><th>Event</th><th>Status</th><th class="num">Tries</th><th>Last error</th><th>Created</th></tr></thead><tbody>${deliveryRows}</tbody></table>` : empty('No webhook deliveries yet.')}
      <div style="margin-top:18px"><div class="k" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">Received at /webhook-sink</div><div class="log" style="margin-top:8px">${logHtml}</div></div>
    </div>
  </div>`;
  return layout('PayProof · dashboard', body);
}

export interface CheckoutData {
  detail: IntentDetail;
  qrSvg: string;
  serverNow: number;
}

export function checkoutPage({ detail, qrSvg, serverNow }: CheckoutData): string {
  const { intent, merchant, account } = detail;
  const remaining = Math.max(0, (intent.expires_at ?? serverNow) - serverNow);
  const mins = String(Math.floor(remaining / 60000)).padStart(2, '0');
  const secs = String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0');
  const windowMs = Math.max(1, (intent.expires_at ?? serverNow) - intent.created_at);
  const pct = Math.max(0, Math.min(100, (remaining / windowMs) * 100));
  const upi = new URLSearchParams({
    pa: merchant.vpa,
    pn: merchant.name,
    am: (intent.amount_paise / 100).toFixed(2),
    cu: 'INR',
    tn: intent.note?.slice(0, 40) || `Order ${intent.order_id}`,
    tr: intent.order_id,
  });
  const upiHref = `upi://pay?${upi.toString()}`;

  const statusCopy: Record<string, { title: string; body: string; tone: string }> = {
    QUEUED: {
      title: 'Waiting for the live slot',
      body: 'Another payment is using this receiving account. This intent activates automatically when it finishes.',
      tone: 'muted',
    },
    ACTIVE: {
      title: 'Scan to pay',
      body: 'Pay the exact amount from any UPI app. Do not edit the amount — attribution is paise-exact.',
      tone: 'info',
    },
    AWAITING_VERIFICATION: {
      title: 'Checking with the bank',
      body: 'You told us you paid. We are watching the bank alert feed; settlement still requires the statement.',
      tone: 'warn',
    },
    OBSERVED: {
      title: 'Payment seen — not settled yet',
      body: 'A bank alert matched this order. A human/statement reconciliation must confirm it before we call it success.',
      tone: 'violet',
    },
    RECONCILED: {
      title: 'Payment reconciled',
      body: 'The bank statement matched this alert and the ledger is posted. This is the only true success state.',
      tone: 'ok',
    },
    EXPIRED: {
      title: 'Payment window closed',
      body: 'No credit was attributed in time. If money left your account, it will appear in the review queue for a human.',
      tone: 'muted',
    },
    CANCELLED: {
      title: 'Intent cancelled',
      body: 'This order was cancelled by the merchant.',
      tone: 'muted',
    },
  };
  const copy = statusCopy[intent.status] ?? statusCopy.ACTIVE;
  const showQr = intent.status === 'ACTIVE' || intent.status === 'QUEUED';
  const claimable = intent.status === 'ACTIVE';

  const body = `
  <div class="checkout-body"><div class="checkout">
    <div class="head">
      <a class="logo" href="/"><span class="dot"></span>pay<em>proof</em></a>
      ${badge(intent.status, intent.status.replaceAll('_', ' '))}
    </div>
    <div class="body">
      <div class="amount">₹${fmtINR(intent.amount_paise)}</div>
      <div class="order">${esc(intent.order_id)} · ${esc(intent.note ?? 'UPI collection')}</div>
      ${showQr ? `<div class="qrbox">${qrSvg}</div>` : ''}
      <div style="text-align:center;margin-top:${showQr ? '4' : '18'}px">
        ${showQr ? `<a class="btn ghost" href="${esc(upiHref)}" style="font-size:12.5px">Open UPI app</a>` : ''}
      </div>
      ${intent.status === 'ACTIVE' ? `<div class="timer"><span>Time remaining</span><b id="clock">${mins}:${secs}</b></div><div class="bar"><i id="bar" style="width:${pct}%"></i></div>` : ''}
      <div class="notice"><b>${esc(copy.title)}</b>${esc(copy.body)}</div>
      ${intent.status === 'RECONCILED' ? '<div class="notice" style="border-color:#124634;background:#082019;color:#8ff0d2"><b>Proof of payment</b>Only now should an order be fulfilled.</div>' : ''}
      ${claimable ? `<form method="post" action="/ui/claim/${esc(intent.id)}" style="margin-top:14px"><button type="submit" style="width:100%;justify-content:center">I have paid →</button></form>` : ''}
      <div style="text-align:center;margin-top:12px"><a class="mono small" href="/intents/${esc(intent.id)}">view timeline</a></div>
    </div>
    <div class="foot2">${esc(account.label)} · ${esc(merchant.vpa)}<br>Bank alerts are evidence. The statement is truth.</div>
  </div></div>
  <script>
  (function(){
    const id = ${JSON.stringify(intent.id)};
    const initial = ${JSON.stringify(intent.status)};
    async function tick(){
      try{
        const r = await fetch('/api/public/intents/' + encodeURIComponent(id), {cache:'no-store'});
        if(!r.ok) return;
        const j = await r.json();
        if(j.status !== initial){ location.reload(); return; }
        if(j.status === 'ACTIVE' && j.expiresAt){
          const s = Math.max(0, Math.floor((j.expiresAt - j.serverTime)/1000));
          const m = String(Math.floor(s/60)).padStart(2,'0');
          const ss = String(s%60).padStart(2,'0');
          const c = document.getElementById('clock'); if(c) c.textContent = m + ':' + ss;
          const total = Math.max(1, Math.floor((j.expiresAt - j.createdAt)/1000));
          const b = document.getElementById('bar'); if(b) b.style.width = Math.max(0, Math.min(100,(s/total)*100)) + '%';
          if(s === 0){ location.reload(); }
        }
      }catch(e){}
    }
    setInterval(tick, 2000); tick();
  })();
  </script>`;
  return layout(`Pay ₹${fmtINR(intent.amount_paise)} · ${intent.order_id}`, body, { bare: true });
}

export function intentPage(detail: IntentDetail): string {
  const { intent, merchant, alert, transitions, deliveries } = detail;
  const timeline = transitions
    .map(
      (t) => `<li><div class="t">${t.from_status ? `${esc(t.from_status)} → ` : ''}<b>${esc(t.to_status)}</b></div>
      <div class="m">${esc(t.reason.replaceAll('_', ' '))} · ${clock(t.created_at)}</div></li>`,
    )
    .join('');

  const deliveriesHtml = deliveries.length
    ? deliveries
        .map(
          (d) => `<div class="kv"><span class="mono">${esc(d.event)}</span><span>${badge(d.status)} <span class="mono small">${d.attempts} tries</span></span></div>
        ${d.last_error ? `<div class="mono small" style="padding-bottom:6px">${esc(d.last_error)}</div>` : ''}`,
        )
        .join('')
    : '<div class="kv"><span>No webhooks yet</span><span>—</span></div>';

  const body = `
  <section class="hero"><div>
    <h1 style="font-size:28px">Order <span class="mono">${esc(intent.order_id)}</span></h1>
    <p>₹${fmtINR(intent.amount_paise)} · ${esc(merchant.name)} · created ${clock(intent.created_at)}</p>
  </div><div class="vpa">${badge(intent.status, intent.status.replaceAll('_', ' '))}</div></section>
  <div class="split">
    <div class="panel">
      <h2>Transition timeline</h2>
      <p class="hint">Every state change is recorded; none is inferred from a screenshot.</p>
      <ul class="timeline">${timeline || '<li>No transitions</li>'}</ul>
    </div>
    <div>
      <div class="panel">
        <h2>Evidence</h2>
        <p class="hint">What the observer saw, if anything.</p>
        <div class="kv"><span>Alert</span><span class="mono">${alert ? esc(alert.utr) : 'none'}</span></div>
        <div class="kv"><span>Source</span><span>${alert ? esc(alert.source) : '—'}</span></div>
        <div class="kv"><span>Alert amount</span><span>₹${alert ? fmtINR(alert.amount_paise) : '—'}</span></div>
        <div class="kv"><span>Received</span><span>${alert ? clock(alert.received_at) : '—'}</span></div>
        ${alert ? `<div class="mono small" style="margin-top:10px">${esc(alert.raw)}</div>` : ''}
        <div class="actions"><a class="btn ghost" href="/checkout/${esc(intent.id)}">Open checkout</a></div>
      </div>
      <div class="panel">
        <h2>Webhook deliveries</h2>
        <p class="hint">Outbox entries for this intent.</p>
        ${deliveriesHtml}
      </div>
    </div>
  </div>
  <div class="panel" style="margin-top:20px">
    <h2>Machine-readable state</h2>
    <pre class="mono" style="background:#080e17;border:1px solid var(--line);border-radius:11px;padding:14px;overflow:auto;font-size:12px">${esc(
      JSON.stringify(
        {
          id: intent.id,
          orderId: intent.order_id,
          amountPaise: intent.amount_paise,
          status: intent.status,
          createdAt: intent.created_at,
          activatedAt: intent.activated_at,
          expiresAt: intent.expires_at,
          claimedAt: intent.claimed_at,
          observedAt: intent.observed_at,
          reconciledAt: intent.reconciled_at,
          alert: alert ? { utr: alert.utr, source: alert.source, receivedAt: alert.received_at } : null,
        },
        null,
        2,
      ),
    )}</pre>
  </div>`;
  return layout(`Intent ${intent.order_id} · PayProof`, body);
}
