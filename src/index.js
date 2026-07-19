import { guard, SqlRejected, MAX_LIMIT } from './guard.js';
import { sqlPrompt, prosePrompt } from './prompts.js';
import { authorize } from './access.js';
import { page } from './ui.js';

// Two jobs, two models, chosen for what each job actually needs.
//
// Writing SQL is the hard step and the one that breaks answers, so it gets a
// code-specialized model. Summarizing rows that were handed to you is easy, so
// it gets a small cheap one — a bigger model can't improve a summary whose
// facts are already fixed, it can only cost more Neurons.
//
// Response envelopes vary across model families — see textOf() below, which
// normalizes them so swapping either model here doesn't break the caller.
const SQL_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';
const PROSE_MODEL = '@cf/meta/llama-3.2-3b-instruct';

// Every inference goes through AI Gateway: caching, request logs, and per-model
// analytics for free. Both prompts are self-invalidating — the SQL prompt
// contains the schema, the prose prompt contains the returned rows — so a data
// or schema change produces a different prompt and therefore a cache miss.
// Nothing stale can be served.
const GATEWAY = 'chalk-toss';
const gatewayOpts = (skipCache) => ({ gateway: { id: GATEWAY, skipCache: Boolean(skipCache) } });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * Pull text out of a Workers AI response.
 *
 * Model families disagree on the envelope, and even a single model does not
 * always put a string in `response` — it can arrive as a number, or as an
 * object when the model emits structured output. Assuming `.response` is a
 * string is how this broke the first time, so normalize instead of trusting.
 */
function textOf(result) {
  if (result == null) return '';

  const direct = result.response;
  if (typeof direct === 'string') return direct;
  if (typeof direct === 'number' || typeof direct === 'boolean') return String(direct);

  // OpenAI-style envelope (gpt-oss, granite).
  const choice = result.choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice;

  // Some models return content as an array of parts.
  if (Array.isArray(direct)) {
    return direct.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  }
  if (direct && typeof direct === 'object' && typeof direct.text === 'string') {
    return direct.text;
  }

  return '';
}

async function provenance(env) {
  try {
    const row = await env.DB.prepare(
      'SELECT verified, source, updated_at FROM data_provenance WHERE id = 1'
    ).first();
    return row ?? { verified: 0, source: 'unknown', updated_at: null };
  } catch {
    // Table missing means the seed never ran — treat as unverified, never as fine.
    return { verified: 0, source: 'no provenance record', updated_at: null };
  }
}

async function ask(question, env, skipCache = false) {
  const meta = await provenance(env);

  // 1. Question -> SQL
  const drafted = await env.AI.run(SQL_MODEL, {
    messages: sqlPrompt(question),
    max_tokens: 300,
    temperature: 0,
  }, gatewayOpts(skipCache));
  const raw = textOf(drafted).trim();

  if (/^UNANSWERABLE/i.test(raw)) {
    return {
      answer:
        "That can't be answered from this database. It holds every game he has played — minutes, points, rebounds, assists, steals, blocks, turnovers, opponent and date — plus season averages. No awards, salary, draft or biographical data.",
      sql: null,
      rows: [],
      provenance: meta,
    };
  }

  // 2. Validate before it goes anywhere near D1
  const sql = guard(raw);

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
    return {
      answer:
        "That can't be answered from this database. It holds every game he has played plus season averages — no awards, salary, draft or biographical data.",
      sql,
      rows: [],
      provenance: meta,
    };
  }

  // 4. The empty case is decided in code, never by the model.
  //
  // This was originally an instruction in the prose prompt ("if the rows are
  // empty, say so") and the small model fired that branch about one time in
  // three even when rows WERE present — reporting no results over a populated
  // table. A branch the code can evaluate should never be delegated to a model.
  // Returning early also skips an inference call we don't need.
  if (rows.length === 0) {
    return {
      answer: 'No games in the database match that.',
      sql,
      rows,
      provenance: meta,
    };
  }

  // 5. Did we hit the row ceiling? Then this is a PARTIAL answer, and saying so
  //    is not optional. Found by the eval harness: "40+ games" has 108 results,
  //    the guard's LIMIT 100 cut it to 100, and the answer read as complete.
  //    A truncated result presented as whole is the same failure as a wrong
  //    number — the user cannot tell it is incomplete.
  const truncated = rows.length >= MAX_LIMIT;

  // 6. Rows -> prose. The model only ever sees a non-empty result set.
  const written = await env.AI.run(PROSE_MODEL, {
    messages: prosePrompt(question, sql, rows, truncated),
    max_tokens: 200,
    temperature: 0,
  }, gatewayOpts(skipCache));

  let answer = textOf(written).trim() || 'The query ran but produced no summary.';
  if (truncated) {
    answer += ` (Showing the first ${MAX_LIMIT} results — there are more.)`;
  }

  return { answer, sql, rows, truncated, provenance: meta };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return new Response(page, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname === '/api/ask') {
      if (request.method !== 'POST') {
        return json({ error: 'Send a POST with {"question": "..."}' }, 405);
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: 'Body must be JSON.' }, 400);
      }
      const question = payload?.question;

      if (typeof question !== 'string' || !question.trim()) {
        return json({ error: 'Ask a question.' }, 400);
      }
      if (question.length > 300) {
        return json({ error: 'Keep the question under 300 characters.' }, 400);
      }

      // Authorize BEFORE any inference. Everything above this line is free to
      // evaluate; everything below it spends Neurons.
      const allowed = await authorize(request, payload, env);
      if (!allowed.ok) {
        return json({ error: allowed.reason }, 401);
      }

      // The eval harness must bypass the cache, or it tests the cache rather
      // than the model — a suite that replays yesterday's answers would pass
      // even after the model started failing. Restricted to API-key callers so
      // a public visitor cannot force cache misses and drain the budget.
      const skipCache = allowed.via === 'api-key' && payload?.skipCache === true;

      try {
        return json(await ask(question.trim(), env, skipCache));
      } catch (err) {
        if (err instanceof SqlRejected) {
          // The guard did its job. Say so plainly rather than letting the model
          // improvise an answer — an unguarded fallback is exactly where a
          // made-up statistic would appear.
          return json(
            { error: `Rejected the generated query: ${err.message}`, guarded: true },
            422
          );
        }
        // Log the detail, return a generic message. The stack and any model
        // error text stay server-side.
        console.error('ask failed', err);
        return json({ error: 'Something went wrong running that question.' }, 500);
      }
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, provenance: await provenance(env) });
    }

    return json({ error: 'Not found' }, 404);
  },
};
