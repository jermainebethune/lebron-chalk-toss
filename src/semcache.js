/**
 * Semantic cache for questions.
 *
 * AI Gateway already caches inference, but it matches on exact prompt text.
 * These are the same question and all three miss each other:
 *
 *   "What was his best scoring game against Boston?"
 *   "What's LeBron's highest scoring game vs the Celtics?"
 *   "Most points he ever put up on Boston?"
 *
 * Three misses, three full pipeline runs, ~35.5 Neurons each. Worse, the SQL
 * prompt contains today's date (the temporal anchor), so the exact-match cache
 * empties itself every midnight UTC.
 *
 * This matches on meaning: embed the question, look for a near neighbour among
 * questions already asked, and if one is close enough, reuse what it produced.
 *
 * ── The one decision that matters ────────────────────────────────────────────
 *
 * WE CACHE THE SQL, NOT THE ANSWER.
 *
 * A semantic cache is normally built to return the stored answer. Here that
 * would break the guarantee the entire app exists to provide. The database
 * updates nightly. A cached ANSWER — "his career high is 61 points" — is a
 * frozen fact, and the night ingestion adds a 62-point game it becomes a lie
 * the system states confidently in its own voice. That is precisely the
 * failure mode every other design decision here is defending against.
 *
 * A cached SQL statement has no such problem. Re-run it and it reports today's
 * rows. Every number still comes out of D1 on every single request; the only
 * thing skipped is the translation from English.
 *
 * And translation is where the money is. Measured on a real day:
 *   qwen2.5-coder-32b (writes SQL)     8,296.6 neurons   77%
 *   llama-4-scout-17b (writes prose)   2,231.9 neurons   21%
 *
 * So a hit costs an embedding (a fraction of a Neuron) plus the prose call,
 * and skips the expensive 77%. The guard still runs on the cached SQL — a
 * statement is no more trusted for having been approved once before.
 */

// bge-base (768 dims) was measured first and separated these question classes
// too narrowly to be useful — a true paraphrase scored 0.9299 while a
// same-stat/WRONG-TEAM query scored 0.9026, leaving 0.027 to place a cutoff
// in. Every question here shares heavy boilerplate ("what was his highest ___
// game against ___"), and that shared structure dominates the similarity.
// bge-large (1024 dims) is the cheapest way to buy separation. Measurements
// for both are in the README.
const EMBED_MODEL = '@cf/baai/bge-large-en-v1.5';
const GATEWAY = 'chalk-toss';

/**
 * Cosine similarity required to reuse a query.
 *
 * Chosen from measurement, not intuition. Pairwise similarities, bge-large:
 *
 *   PARAPHRASE  close wording            0.9643   <- want to catch
 *   PARAPHRASE  nickname ("Celtics")     0.9220   <- want to catch
 *   PARAPHRASE  loose wording            0.8627   <- cannot catch safely
 *   near-miss   WRONG TEAM (Miami)       0.8936   <- must never catch
 *   near-miss   WRONG STAT (rebounds)    0.8959   <- must never catch
 *   near-miss   WRONG STAT (Denver)      0.8778   <- must never catch
 *
 * Read the third line carefully: the loosest paraphrase scores BELOW every
 * near-miss. The two classes overlap, so no threshold separates them cleanly —
 * that is a property of these questions, which share so much boilerplate
 * ("what was his highest ___ game against ___") that the shared structure
 * dominates the similarity. There is no cutoff that catches every rephrasing.
 *
 * So the line is drawn to be SAFE rather than complete: above every measured
 * near-miss, and accept that loosely-worded paraphrases pay full price. 0.92
 * clears the worst near-miss (0.8959) by 0.024 and catches the two paraphrase
 * forms people actually type.
 *
 * The asymmetry justifies the caution. A miss costs ~35 Neurons. A bad hit
 * answers a question nobody asked, with real rows from a real query, and looks
 * entirely correct — the one failure this whole application is built to
 * prevent.
 *
 * Caveat worth respecting: six pairs is a small sample. Extend it with
 * GET /api/cache/probe?q=... (API key), which reports the nearest neighbours
 * and their scores WITHOUT serving from cache.
 */
export const THRESHOLD = 0.92;

/**
 * Questions whose SQL goes stale.
 *
 * "How many points did he score this season?" may well produce
 * `WHERE season = '2025-26'` as a literal. That SQL is correct today and wrong
 * in November. The prompt asks the model to prefer `(SELECT MAX(season) ...)`,
 * but "asks" is not "guarantees", and a cache entry outlives the assumption.
 *
 * So questions that refer to a moving now are never cached and never served
 * from cache. They are a small minority of questions and the whole reason the
 * temporal anchor exists — spending Neurons on them is the correct trade.
 */
const TEMPORAL = /\b(this|last|latest|current|recent|recently|past|now|today|tonight|yesterday|so far|these days|nowadays|upcoming|next)\b/i;

export function isTemporal(question) {
  return TEMPORAL.test(question);
}

/** Stable id for a question, so re-asking it updates one row instead of adding another. */
async function idFor(question) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(question));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** Normalize before embedding so trivial differences don't produce distinct vectors. */
function normalize(question) {
  return question.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?!.]+$/, '');
}

async function embed(env, question) {
  const result = await env.AI.run(
    EMBED_MODEL,
    { text: [normalize(question)] },
    { gateway: { id: GATEWAY } }
  );
  const vector = result?.data?.[0];
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('embedding model returned no vector');
  }
  return vector;
}

/**
 * Look for a cached query for this question.
 *
 * Returns:
 *   { hit: true,  sql, score, question }  reuse this SQL
 *   { hit: false, score, vector }         no match; vector is handed back so
 *                                         store() doesn't embed a second time
 *   { hit: false, skipped: reason }       cache deliberately not consulted
 *
 * Never throws. A cache is an optimization, and an optimization that can take
 * down the request it was meant to speed up is a liability — any failure here
 * degrades to a normal cold question.
 */
export async function lookup(env, question, { history = [], skipCache = false } = {}) {
  if (skipCache) return { hit: false, skipped: 'cache bypassed' };
  if (!env.VECTORIZE) return { hit: false, skipped: 'no vectorize binding' };

  // Follow-ups resolve against the conversation, not the question text alone.
  // "What about the playoffs?" means nothing on its own and its SQL is only
  // correct in the context that produced it.
  if (history.length) return { hit: false, skipped: 'follow-up' };
  if (isTemporal(question)) return { hit: false, skipped: 'temporal question' };

  try {
    const vector = await embed(env, question);
    const res = await env.VECTORIZE.query(vector, { topK: 1, returnMetadata: 'all' });
    const top = res?.matches?.[0];

    if (top && top.score >= THRESHOLD && typeof top.metadata?.sql === 'string') {
      return { hit: true, sql: top.metadata.sql, score: top.score, question: top.metadata.question };
    }
    return { hit: false, score: top?.score ?? 0, vector };
  } catch (err) {
    console.warn('semantic cache lookup failed, answering cold', err?.message);
    return { hit: false, skipped: 'lookup failed' };
  }
}

/**
 * Remember that this question produced this SQL.
 *
 * `vector` comes from the preceding lookup() so a miss embeds once, not twice.
 * Also never throws: failing to write the cache must not fail the answer that
 * was already computed successfully.
 */
export async function store(env, question, sql, vector) {
  if (!env.VECTORIZE || !sql || !vector) return false;
  if (isTemporal(question)) return false;

  try {
    await env.VECTORIZE.upsert([
      {
        id: await idFor(normalize(question)),
        values: vector,
        // Kept small on purpose: metadata rides along with every query result.
        metadata: { question: question.slice(0, 300), sql: sql.slice(0, 2000) },
      },
    ]);
    return true;
  } catch (err) {
    console.warn('semantic cache store failed', err?.message);
    return false;
  }
}

/**
 * Report the nearest neighbour and its score without serving from cache.
 *
 * This is the tuning instrument for THRESHOLD. Embeddings don't come with an
 * obvious cutoff — the right one is whatever separates true paraphrases from
 * the "points vs rebounds against Boston" near-misses on THIS question
 * distribution, and that's an empirical question, not a guessable one.
 */
export async function probe(env, question) {
  const vector = await embed(env, question);
  const res = await env.VECTORIZE.query(vector, { topK: 5, returnMetadata: 'all' });
  return {
    question,
    temporal: isTemporal(question),
    threshold: THRESHOLD,
    matches: (res?.matches ?? []).map((m) => ({
      score: m.score,
      wouldHit: m.score >= THRESHOLD,
      question: m.metadata?.question,
      sql: m.metadata?.sql,
    })),
  };
}
