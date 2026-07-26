import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTemporal, lookup, store, THRESHOLD } from '../src/semcache.js';

// A question whose SQL is only correct *today* must never be cached. This is
// the failure the whole exclusion exists to prevent: "this season" resolving
// to WHERE season = '2025-26', cached, and still being served next November.
test('questions about a moving "now" are excluded', () => {
  const temporal = [
    'How many points did he score this season?',
    'What were his averages last season?',
    'Who did he play most recently?',
    'What is his current team?',
    'How many games has he played so far?',
    'Did he play yesterday?',
    'What about the latest game?',
    'How has he done in the past month?',
  ];
  for (const q of temporal) {
    assert.equal(isTemporal(q), true, `should be excluded: ${q}`);
  }
});

test('questions with fixed answers are cacheable', () => {
  const stable = [
    'What was his highest scoring game against Boston?',
    'How many triple-doubles does he have?',
    'What were his averages in 2012-13?',
    'Which game did he score 61 points?',
    'How many playoff games has he played?',
    'What is his career high in assists?',
  ];
  for (const q of stable) {
    assert.equal(isTemporal(q), false, `should be cacheable: ${q}`);
  }
});

test('temporal matching is on whole words, not substrings', () => {
  // "thistle", "lastly", "nowhere" contain temporal words as substrings.
  // A substring match would refuse to cache perfectly stable questions.
  assert.equal(isTemporal('Did he ever score against the Nowhere team?'), false);
  assert.equal(isTemporal('What was his fastest game?'), false);
  assert.equal(isTemporal('How many blowouts has he had?'), false);
});

test('the threshold is conservative enough to prefer misses', () => {
  // A bad hit answers a question nobody asked, with real-looking numbers.
  // A miss just costs Neurons. The cutoff must sit near the top of the range.
  assert.ok(THRESHOLD >= 0.9, 'threshold must be strict');
  assert.ok(THRESHOLD < 1, 'threshold of 1 would never hit');
});

// ── lookup() guards ─────────────────────────────────────────────────────────
// A stub binding that fails the test if it is ever consulted. These cases must
// return before any embedding happens — each one costs a Neuron fraction and,
// more importantly, must not produce a hit.
const forbidden = {
  AI: { run: () => assert.fail('must not embed') },
  VECTORIZE: { query: () => assert.fail('must not query the index') },
};

test('a follow-up never consults the cache', async () => {
  const r = await lookup(forbidden, 'what about the playoffs?', {
    history: [{ question: 'best game vs Boston', sql: 'SELECT 1' }],
  });
  assert.equal(r.hit, false);
  assert.equal(r.skipped, 'follow-up');
});

test('a temporal question never consults the cache', async () => {
  const r = await lookup(forbidden, 'How many points this season?', {});
  assert.equal(r.hit, false);
  assert.equal(r.skipped, 'temporal question');
});

test('skipCache bypasses the semantic cache too', async () => {
  // The eval harness sets this. If it only bypassed AI Gateway, the suite
  // would replay cached SQL and pass even after SQL generation regressed —
  // testing the cache instead of the model.
  const r = await lookup(forbidden, 'What is his career high?', { skipCache: true });
  assert.equal(r.hit, false);
  assert.equal(r.skipped, 'cache bypassed');
});

test('a missing binding degrades instead of throwing', async () => {
  const r = await lookup({}, 'What is his career high?', {});
  assert.equal(r.hit, false);
  assert.equal(r.skipped, 'no vectorize binding');
});

test('a lookup failure degrades to a cold answer rather than an error', async () => {
  const broken = {
    AI: { run: () => { throw new Error('AI is down'); } },
    VECTORIZE: { query: () => assert.fail('never reached') },
  };
  const r = await lookup(broken, 'What is his career high?', {});
  assert.equal(r.hit, false);
  assert.equal(r.skipped, 'lookup failed');
});

// ── threshold behaviour ─────────────────────────────────────────────────────
const fakeEnv = (score, metadata) => ({
  AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
  VECTORIZE: { query: async () => ({ matches: [{ score, metadata }] }) },
});

test('a match at or above the threshold is served', async () => {
  const r = await lookup(fakeEnv(THRESHOLD, { sql: 'SELECT 1', question: 'x' }), 'anything', {});
  assert.equal(r.hit, true);
  assert.equal(r.sql, 'SELECT 1');
});

test('a match just below the threshold is not served', async () => {
  const r = await lookup(fakeEnv(THRESHOLD - 0.001, { sql: 'SELECT 1', question: 'x' }), 'anything', {});
  assert.equal(r.hit, false);
  // The near-miss score comes back so it can be logged and used for tuning.
  assert.equal(r.score, THRESHOLD - 0.001);
  assert.ok(Array.isArray(r.vector), 'the vector is returned so a miss embeds only once');
});

test('a high-scoring match with no cached SQL is not served', async () => {
  // Defensive: metadata could be missing or malformed. A hit whose sql is
  // undefined would sail into guard() and throw on a perfectly good question.
  const r = await lookup(fakeEnv(0.99, { question: 'x' }), 'anything', {});
  assert.equal(r.hit, false);
});

test('store refuses to remember a temporal question', async () => {
  const env = { VECTORIZE: { upsert: () => assert.fail('must not write') } };
  assert.equal(await store(env, 'points this season?', 'SELECT 1', [0.1]), false);
});

test('store degrades rather than throwing when the write fails', async () => {
  const env = { VECTORIZE: { upsert: async () => { throw new Error('index down'); } } };
  assert.equal(await store(env, 'career high?', 'SELECT 1', [0.1]), false);
});
