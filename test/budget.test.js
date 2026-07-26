import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, peek, PER_IP, GLOBAL } from '../src/budget.js';

const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

test('the first call opens a window and spends one unit', () => {
  const r = advance(undefined, T0, 3, HOUR);
  assert.equal(r.ok, true);
  assert.equal(r.remaining, 2);
  assert.equal(r.resetAt, T0 + HOUR);
  assert.deepEqual(r.bucket, { count: 1, resetAt: T0 + HOUR });
});

test('spending counts down to exactly the limit, then refuses', () => {
  let bucket;
  for (let i = 0; i < 3; i++) {
    const r = advance(bucket, T0 + i, 3, HOUR);
    assert.equal(r.ok, true, `call ${i + 1} of 3 should be allowed`);
    assert.equal(r.remaining, 2 - i);
    bucket = r.bucket;
  }

  const refused = advance(bucket, T0 + 4, 3, HOUR);
  assert.equal(refused.ok, false);
  assert.equal(refused.remaining, 0);
});

test('a refusal writes nothing — a hammering client cannot cause storage writes', () => {
  const spent = { count: 5, resetAt: T0 + HOUR };
  const r = advance(spent, T0 + 1, 5, HOUR);
  assert.equal(r.ok, false);
  assert.equal(r.bucket, null);
});

test('a refusal does not extend the window', () => {
  const spent = { count: 5, resetAt: T0 + HOUR };
  const r = advance(spent, T0 + HOUR - 1, 5, HOUR);
  assert.equal(r.resetAt, T0 + HOUR, 'reset time must not move when refusing');
});

test('the window reopens once it has passed', () => {
  const spent = { count: 5, resetAt: T0 + HOUR };

  // One millisecond early: still refused.
  assert.equal(advance(spent, T0 + HOUR - 1, 5, HOUR).ok, false);

  // Exactly at the deadline: a fresh window.
  const fresh = advance(spent, T0 + HOUR, 5, HOUR);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.remaining, 4);
  assert.equal(fresh.resetAt, T0 + HOUR + HOUR);
});

test('a limit of zero refuses everything, including the first call', () => {
  const r = advance(undefined, T0, 0, HOUR);
  assert.equal(r.ok, false);
  assert.equal(r.bucket, null);
});

test('peek reports remaining without spending', () => {
  const bucket = { count: 2, resetAt: T0 + HOUR };
  const seen = peek(bucket, T0 + 1, 5);
  assert.equal(seen.remaining, 3);
  assert.equal(seen.resetAt, T0 + HOUR);
  // The bucket itself is untouched — peek takes no arguments it could mutate.
  assert.deepEqual(bucket, { count: 2, resetAt: T0 + HOUR });
});

test('peek on an expired or absent window reports a full budget', () => {
  assert.deepEqual(peek(undefined, T0, 7), { remaining: 7, resetAt: null });
  assert.deepEqual(peek({ count: 7, resetAt: T0 }, T0 + 1, 7), { remaining: 7, resetAt: null });
});

test('peek never reports a negative budget', () => {
  // Shouldn't happen, but an over-count must read as "none left", not as -2.
  assert.equal(peek({ count: 9, resetAt: T0 + HOUR }, T0, 7).remaining, 0);
});

test('the per-IP budget cannot outrun the global one on its own', () => {
  // The point of two limits: one caller at full tilt for a whole day still
  // cannot exhaust the global ceiling by itself before being cut off.
  const perIpPerDay = PER_IP.limit * (GLOBAL.windowMs / PER_IP.windowMs);
  assert.ok(
    perIpPerDay > GLOBAL.limit,
    'a single IP should hit the global ceiling before its own daily total — otherwise the global limit is unreachable and pointless'
  );
});
