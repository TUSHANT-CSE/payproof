import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_TRANSITIONS, canTransition } from '../src/domain/lifecycle.ts';

test('happy path: queued → active → observed → reconciled', () => {
  assert.equal(canTransition('QUEUED', 'ACTIVE'), true);
  assert.equal(canTransition('ACTIVE', 'OBSERVED'), true);
  assert.equal(canTransition('AWAITING_VERIFICATION', 'OBSERVED'), true);
  assert.equal(canTransition('OBSERVED', 'RECONCILED'), true);
});

test('money cannot skip verification', () => {
  assert.equal(canTransition('ACTIVE', 'RECONCILED'), false);
  assert.equal(canTransition('AWAITING_VERIFICATION', 'RECONCILED'), false);
  assert.equal(canTransition('QUEUED', 'OBSERVED'), false);
});

test('expired and reconciled are terminal', () => {
  assert.deepEqual(ALLOWED_TRANSITIONS.EXPIRED, []);
  assert.deepEqual(ALLOWED_TRANSITIONS.RECONCILED, []);
  assert.equal(canTransition('RECONCILED', 'OBSERVED'), false);
  assert.equal(canTransition('EXPIRED', 'ACTIVE'), false);
});

test('unknown states never transition', () => {
  assert.equal(canTransition('WAT', 'ACTIVE'), false);
  assert.equal(canTransition('ACTIVE', 'WAT'), false);
});
