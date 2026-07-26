/**
 * The pipeline itself, with no transport attached.
 *
 * This used to live inside index.js, next to the HTTP handler. It moved out
 * when the MCP server arrived: two transports now answer the same question,
 * and the one thing that must NOT vary between them is what happens between
 * "a question came in" and "here are the rows". A second copy of resolve()
 * would be a second place for the guard to be skipped.
 *
 * index.js owns HTTP and SSE. mcp.js owns the tool surface. Both call in here.
 */

import { guard, MAX_LIMIT } from './guard.js';
import { sqlPrompt, prosePrompt } from './prompts.js';
import { lookup as cacheLookup, store as cacheStore } from './semcache.js';

// Two jobs, two models, chosen for what each job actually needs.
//
// Writing SQL is the hard step and the one that breaks answers, so it gets a
// code-specialized model. Summarizing rows that were handed to you is easy, so
// it gets a small cheap one — a bigger model can't improve a summary whose
// facts are already fixed, it can only cost more Neurons.
//
// Response envelopes vary across model families — see textOf() below, which
// normalizes them so swapping either model here doesn't break the caller.
export const SQL_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';
// 3.2-3b wrote fine prose until the rule list grew (full team names over
// nicknames, ordinal dates, count-vs-describe) — then it started dropping
// rows and mirroring nicknames. Prose is ~6% of per-question cost, so a
// mid-size upgrade is a rounding error next to the SQL call. llama-3.1-8b
// was the first choice but is deprecated (runtime 5028) — probed the
// catalog and Scout is the smallest current model that follows the rules.
export const PROSE_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

// Every inference goes through AI Gateway: caching, request logs, and per-model
// analytics for free. Both prompts are self-invalidating — the SQL prompt
// contains the schema, the prose prompt contains the returned rows — so a data
// or schema change produces a different prompt and therefore a cache miss.
// Nothing stale can be served.
const GATEWAY = 'chalk-toss';
const gatewayOpts = (skipCache) => ({ gateway: { id: GATEWAY, skipCache: Boolean(skipCache) } });

export const TRUNCATION_NOTE = (n) => ` (Showing the first ${n} results — there are more.)`;

/**
 * Run inference, retrying once on a transient failure.
 *
 * Workers AI occasionally errors for no reason attributable to the request —
 * an eval run failed six of twenty cases with 500s that were not reproducible
 * minutes later, and the same suite passed 20/20 immediately after. Without a
 * retry, one upstream blip becomes a user-facing error on a question that is
 * perfectly answerable.
 *
 * One retry, not many: if the second attempt also fails, something is actually
 * wrong and hammering it will not help.
 */
export async function infer(env, model, inputs, skipCache) {
  try {
    return await env.AI.run(model, inputs, gatewayOpts(skipCache));
  } catch (err) {
    console.warn('inference failed, retrying once', model, err?.message);
    await new Promise((r) => setTimeout(r, 250));
    return env.AI.run(model, inputs, gatewayOpts(skipCache));
  }
}

/**
 * Pull text out of a Workers AI response.
 *
 * Model families disagree on the envelope, and even a single model does not
 * always put a string in `response` — it can arrive as a number, or as an
 * object when the model emits structured output. Assuming `.response` is a
 * string is how this broke the first time, so normalize instead of trusting.
 */
export function textOf(result) {
  if (result == null) return '';

  const direct = result.response;
  if (typeof direct === 'string') return direct;
  if (typeof direct === 'number' || typeof direct === 'boolean') return String(direct);

  // OpenAI-style envelope (gpt-oss, granite) — and its streaming delta form.
  const choice = result.choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice;
  const delta = result.choices?.[0]?.delta?.content;
  if (typeof delta === 'string') return delta;

  // Some models return content as an array of parts.
  if (Array.isArray(direct)) {
    return direct.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  }
  if (direct && typeof direct === 'object' && typeof direct.text === 'string') {
    return direct.text;
  }

  return '';
}

const UNVERIFIED = { verified: 0, source: 'no provenance record', updated_at: null };

export async function provenance(env) {
  try {
    const row = await env.DB.prepare(
      'SELECT verified, source, updated_at FROM data_provenance WHERE id = 1'
    ).first();
    return row ?? { verified: 0, source: 'unknown', updated_at: null };
  } catch {
    // Table missing means the seed never ran — treat as unverified, never as fine.
    return UNVERIFIED;
  }
}

/**
 * The two things every question needs from D1 before any inference can start:
 * data provenance, and the temporal anchor.
 *
 * These used to be two awaited queries, one after the other. They are entirely
 * independent, so that was two sequential round trips to a database that lives
 * in exactly one region (ENAM/IAD) while the Worker runs wherever the caller
 * is. Measured from the colo next door to the database, one round trip is
 * ~95ms warm; from Tokyo it is a Pacific crossing. Paying that twice, in
 * series, before the expensive step had even begun, was pure waste.
 *
 * Now one statement. Every field is a subquery, which matters: the row comes
 * back even when a table is empty, so an unseeded database degrades to
 * "unverified, no anchor" rather than to an exception.
 *
 * The tradeoff, stated honestly: because it is one statement, a MISSING table
 * (as opposed to an empty one) now takes out both values instead of just one.
 * That state means the schema was never applied, and answering carefully in
 * that situation is not worth a second round trip on every healthy request.
 */
async function preflight(env) {
  try {
    const row = await env.DB.prepare(`
      SELECT (SELECT MAX(season) FROM seasons)                     AS latest_season,
             (SELECT verified    FROM data_provenance WHERE id = 1) AS verified,
             (SELECT source      FROM data_provenance WHERE id = 1) AS source,
             (SELECT updated_at  FROM data_provenance WHERE id = 1) AS updated_at
    `).first();

    return {
      provenance: row?.source != null
        ? { verified: row.verified, source: row.source, updated_at: row.updated_at }
        : UNVERIFIED,
      // Without today's date and the actual latest season, "last season"
      // resolves against the model's training-era sense of now — it
      // confidently hardcoded 2022-23 in production. The date in the prompt
      // also rolls the AI Gateway cache daily, which is correct: "this season"
      // is allowed to mean something new tomorrow.
      anchor: row?.latest_season
        ? { today: new Date().toISOString().slice(0, 10), latestSeason: row.latest_season }
        : null,
    };
  } catch (e) {
    // Never throws. A failed preflight means answering without an anchor and
    // reporting the data as unverified — degraded, but still an answer.
    console.warn('preflight query failed, answering without an anchor', e?.message);
    return { provenance: UNVERIFIED, anchor: null };
  }
}

/**
 * Follow-up context arrives from the client, which makes it user input.
 * Cap the count and the field lengths, and drop anything malformed rather
 * than erroring — a mangled history should degrade to a cold question, not
 * take the request down. The SQL here is only ever prompt context; the only
 * SQL that reaches D1 is what the model writes THIS turn, and that still
 * goes through the guard.
 */
export function cleanHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h) => typeof h?.question === 'string' && typeof h?.sql === 'string'
      && h.question.trim() && h.sql.trim()
      && h.question.length <= 300 && h.sql.length <= 2000)
    .slice(-4)
    .map((h) => ({ question: h.question.trim(), sql: h.sql.trim() }));
}

const UNANSWERABLE_ANSWER =
  "That can't be answered from this database. It holds every game he has played — minutes, points, rebounds, assists, steals, blocks, turnovers, opponent and date — plus season averages. No awards, salary, draft or biographical data.";

const QUERY_FAILED_ANSWER =
  "That can't be answered from this database. It holds every game he has played plus season averages — no awards, salary, draft or biographical data.";

/**
 * Everything up to (but not including) the prose step: SQL generation, the
 * guard, and the D1 query. Shared by every caller so they cannot drift apart.
 *
 * Returns { done } when the answer is already decided in code — unanswerable,
 * query failure, empty result — or { sql, rows, truncated, provenance } when
 * there are rows for the prose model to describe.
 */
export async function resolve(question, history, env, skipCache = false) {
  // 0. The two independent preflights, together.
  //
  // The D1 preflight and the cache lookup need nothing from each other — one
  // reads provenance and the latest season, the other embeds the question and
  // searches Vectorize. Running them in series meant the cache lookup ADDED
  // its own latency to every question that missed, which would have made the
  // cache a net loss on exactly the requests it cannot help. In parallel it
  // hides behind a round trip that was happening anyway.
  //
  // Promise.all is safe here precisely because neither can reject: preflight
  // catches, and cacheLookup is documented never to throw. A rejection would
  // otherwise take down a request that both are only trying to improve.
  const [pre, cached] = await Promise.all([
    preflight(env),
    // 1. Question -> SQL, from the semantic cache if a near-identical question
    //    has been asked before. The cache holds SQL, never answers, so a hit
    //    still runs the query against D1 below and still reports today's rows.
    cacheLookup(env, question, { history, skipCache }),
  ]);

  const meta = pre.provenance;
  const anchor = pre.anchor;

  let sql;
  let toRemember = null;

  if (cached.hit) {
    // Guard it anyway. A statement is not more trustworthy for having been
    // approved once before — the guard is cheap and it is the only thing
    // standing between generated SQL and the database.
    sql = guard(cached.sql);
  } else {
    const drafted = await infer(env, SQL_MODEL, {
      messages: sqlPrompt(question, history, anchor),
      max_tokens: 300,
      temperature: 0,
    }, skipCache);
    const raw = textOf(drafted).trim();

    if (/^UNANSWERABLE/i.test(raw)) {
      // Deliberately not cached. "UNANSWERABLE" is a judgement about the
      // schema, and the schema can gain a column — a cached refusal would
      // outlive the reason for it.
      return { done: { answer: UNANSWERABLE_ANSWER, sql: null, rows: [], provenance: meta } };
    }

    // 2. Validate before it goes anywhere near D1
    sql = guard(raw);

    // Only remember queries that survive the guard, and only once the query
    // has actually run — see below. Caching a statement D1 rejects would
    // reliably reproduce a failure instead of a result.
    if (cached.vector) toRemember = { question, sql, vector: cached.vector };
  }

  // 3. Run it. Real numbers enter here and nothing downstream can change them.
  //
  // A query that references a column we don't have is the model asking about
  // data that doesn't exist — awards, salaries, whatever it imagined. That must
  // read as "not in this database", never as a number. Answering "0 MVPs" from
  // an empty column is the worst possible outcome: confidently wrong, and
  // indistinguishable from a real answer.
  let rows;
  try {
    const result = await env.DB.prepare(sql).all();
    rows = result.results ?? [];
  } catch (dbErr) {
    console.error('query failed', sql, dbErr);
    // Not cached: this statement is now known not to run. Remembering it would
    // turn a one-off model mistake into a permanently reproducible failure.
    return { done: { answer: QUERY_FAILED_ANSWER, sql, rows: [], provenance: meta } };
  }

  // The query parsed, ran, and returned. Only now is it worth remembering.
  // Awaited rather than fire-and-forget: a Worker can be torn down the moment
  // the response is sent, and a dropped write here would silently mean the
  // cache never fills.
  if (toRemember) {
    await cacheStore(env, toRemember.question, toRemember.sql, toRemember.vector);
  }

  // 4. The empty case is decided in code, never by the model.
  //
  // This was originally an instruction in the prose prompt ("if the rows are
  // empty, say so") and the small model fired that branch about one time in
  // three even when rows WERE present — reporting no results over a populated
  // table. A branch the code can evaluate should never be delegated to a model.
  // Returning early also skips an inference call we don't need.
  if (rows.length === 0) {
    return { done: { answer: 'No games in the database match that.', sql, rows, provenance: meta } };
  }

  // 5. Did we hit the row ceiling? Then this is a PARTIAL answer, and saying so
  //    is not optional. Found by the eval harness: "40+ games" has 108 results,
  //    the guard's LIMIT 100 cut it to 100, and the answer read as complete.
  //    A truncated result presented as whole is the same failure as a wrong
  //    number — the user cannot tell it is incomplete.
  const truncated = rows.length >= MAX_LIMIT;

  // Reported so a hit is visible rather than invisible. A cache that silently
  // changes where answers come from is a cache you cannot debug — and `score`
  // is the raw material for tuning THRESHOLD against real traffic.
  const cache = cached.hit
    ? { hit: true, score: cached.score, matched: cached.question }
    : { hit: false, ...(cached.skipped ? { skipped: cached.skipped } : { nearest: cached.score ?? 0 }) };

  return { sql, rows, truncated, provenance: meta, cache };
}

/**
 * The whole pipeline, answer collected rather than streamed.
 */
export async function ask(question, history, env, skipCache = false) {
  const r = await resolve(question, history, env, skipCache);
  if (r.done) return r.done;

  // 6. Rows -> prose. The model only ever sees a non-empty result set.
  const written = await infer(env, PROSE_MODEL, {
    messages: prosePrompt(question, r.sql, r.rows, r.truncated),
    max_tokens: 200,
    temperature: 0,
  }, skipCache);

  let answer = textOf(written).trim() || 'The query ran but produced no summary.';
  if (r.truncated) {
    answer += TRUNCATION_NOTE(MAX_LIMIT);
  }

  return {
    answer,
    sql: r.sql,
    rows: r.rows,
    truncated: r.truncated,
    provenance: r.provenance,
    cache: r.cache,
  };
}
