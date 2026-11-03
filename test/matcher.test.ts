import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOCK_SKEW_MS,
  findLateSuggestion,
  findMatch,
  isEligible,
} from '../src/domain/matcher.ts';

const alert = { amountPaise: 25_000, receivedAt: 1_000_000, utr: '412345678901' };

function candidate(overrides: Partial<Parameters<typeof isEligible>[0]> = {}) {
  return {
    id: 'pi_a',
    amountPaise: 25_000,
    status: 'ACTIVE',
    createdAt: 990_000,
    expiresAt: 1_200_000,
    ...overrides,
  };
}

test('exact paise amount is required — no tolerance', () => {
  assert.equal(isEligible(candidate(), alert), true);
  assert.equal(isEligible(candidate({ amountPaise: 25_001 }), alert), false);
  assert.equal(isEligible(candidate({ amountPaise: 24_999 }), alert), false);
});

test('only live intents are eligible', () => {
  for (const status of ['QUEUED', 'OBSERVED', 'RECONCILED', 'EXPIRED', 'CANCELLED']) {
    assert.equal(isEligible(candidate({ status }), alert), false, status);
  }
  assert.equal(isEligible(candidate({ status: 'AWAITING_VERIFICATION' }), alert), true);
});

test('alert must fall inside the intent lifetime (with clock skew)', () => {
  const skew = candidate({ createdAt: alert.receivedAt + CLOCK_SKEW_MS });
  assert.equal(isEligible(skew, alert), true, 'exactly at skew boundary');

  const tooOld = candidate({ createdAt: alert.receivedAt + CLOCK_SKEW_MS + 1 });
  assert.equal(isEligible(tooOld, alert), false, 'alert older than the intent');

  const tooLate = candidate({ expiresAt: alert.receivedAt - 1 });
  assert.equal(isEligible(tooLate, alert), false, 'alert after the window');
});

test('oldest eligible intent wins (FIFO tie-break)', () => {
  const match = findMatch(alert, [
    candidate({ id: 'pi_new', createdAt: 995_000 }),
    candidate({ id: 'pi_old', createdAt: 985_000 }),
  ]);
  assert.equal(match?.id, 'pi_old');
});

test('no match returns null', () => {
  assert.equal(findMatch(alert, [candidate({ amountPaise: 1 })]), null);
  assert.equal(findMatch(alert, []), null);
});

test('late alerts only become suggestions inside the grace window', () => {
  const alertAfterExpiry = { ...alert, receivedAt: 1_300_000 };
  const expired = candidate({ id: 'pi_exp', status: 'EXPIRED', expiresAt: 1_200_000 });

  assert.equal(findLateSuggestion(alertAfterExpiry, [expired], 300_000)?.id, 'pi_exp');
  assert.equal(findLateSuggestion(alertAfterExpiry, [expired], 50_000), null, 'outside grace');

  const live = candidate({ status: 'ACTIVE' });
  assert.equal(findLateSuggestion(alertAfterExpiry, [live], 300_000), null, 'live is not late');

  const wrongAmount = candidate({ status: 'EXPIRED', amountPaise: 1, expiresAt: 1_200_000 });
  assert.equal(findLateSuggestion(alertAfterExpiry, [wrongAmount], 300_000), null);
});

test('most recently expired suggestion wins', () => {
  const alertAfterExpiry = { ...alert, receivedAt: 1_400_000 };
  const suggestion = findLateSuggestion(
    alertAfterExpiry,
    [
      candidate({ id: 'pi_old', status: 'EXPIRED', expiresAt: 1_100_000 }),
      candidate({ id: 'pi_recent', status: 'EXPIRED', expiresAt: 1_300_000 }),
    ],
    300_000,
  );
  assert.equal(suggestion?.id, 'pi_recent');
});
