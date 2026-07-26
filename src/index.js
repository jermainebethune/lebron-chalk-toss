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
async function infer(env, model, inputs, skipCache) {
  try {
    return await env.AI.run(model, inputs, gatewayOpts(skipCache));
  } catch (err) {
    console.warn('inference failed, retrying once', model, err?.message);
    await new Promise((r) => setTimeout(r, 250));
    return env.AI.run(model, inputs, gatewayOpts(skipCache));
  }
}

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

/**
 * Follow-up context arrives from the client, which makes it user input.
 * Cap the count and the field lengths, and drop anything malformed rather
 * than erroring — a mangled history should degrade to a cold question, not
 * take the request down. The SQL here is only ever prompt context; the only
 * SQL that reaches D1 is what the model writes THIS turn, and that still
 * goes through the guard.
 */
function cleanHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h) => typeof h?.question === 'string' && typeof h?.sql === 'string'
      && h.question.trim() && h.sql.trim()
      && h.question.length <= 300 && h.sql.length <= 2000)
    .slice(-4)
    .map((h) => ({ question: h.question.trim(), sql: h.sql.trim() }));
}

/**
 * Everything up to (but not including) the prose step: SQL generation, the
 * guard, and the D1 query. Shared by the JSON and streaming paths so the two
 * cannot drift apart.
 *
 * Returns { done } when the answer is already decided in code — unanswerable,
 * query failure, empty result — or { sql, rows, truncated, provenance } when
 * there are rows for the prose model to describe.
 */
async function resolve(question, history, env, skipCache = false) {
  const meta = await provenance(env);

  // 1. Question -> SQL
  const drafted = await infer(env, SQL_MODEL, {
    messages: sqlPrompt(question, history),
    max_tokens: 300,
    temperature: 0,
  }, skipCache);
  const raw = textOf(drafted).trim();

  if (/^UNANSWERABLE/i.test(raw)) {
    return { done: {
      answer:
        "That can't be answered from this database. It holds every game he has played — minutes, points, rebounds, assists, steals, blocks, turnovers, opponent and date — plus season averages. No awards, salary, draft or biographical data.",
      sql: null,
      rows: [],
      provenance: meta,
    } };
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
    return { done: {
      answer:
        "That can't be answered from this database. It holds every game he has played plus season averages — no awards, salary, draft or biographical data.",
      sql,
      rows: [],
      provenance: meta,
    } };
  }

  // 4. The empty case is decided in code, never by the model.
  //
  // This was originally an instruction in the prose prompt ("if the rows are
  // empty, say so") and the small model fired that branch about one time in
  // three even when rows WERE present — reporting no results over a populated
  // table. A branch the code can evaluate should never be delegated to a model.
  // Returning early also skips an inference call we don't need.
  if (rows.length === 0) {
    return { done: {
      answer: 'No games in the database match that.',
      sql,
      rows,
      provenance: meta,
    } };
  }

  // 5. Did we hit the row ceiling? Then this is a PARTIAL answer, and saying so
  //    is not optional. Found by the eval harness: "40+ games" has 108 results,
  //    the guard's LIMIT 100 cut it to 100, and the answer read as complete.
  //    A truncated result presented as whole is the same failure as a wrong
  //    number — the user cannot tell it is incomplete.
  const truncated = rows.length >= MAX_LIMIT;

  return { sql, rows, truncated, provenance: meta };
}

const TRUNCATION_NOTE = (n) => ` (Showing the first ${n} results — there are more.)`;

async function ask(question, history, env, skipCache = false) {
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

  return { answer, sql: r.sql, rows: r.rows, truncated: r.truncated, provenance: r.provenance };
}

/**
 * The streaming variant. Same pipeline, but the response is server-sent
 * events, and the prose model's tokens are forwarded as they arrive instead
 * of being collected first. The page shows the answer forming immediately
 * rather than staring at a spinner through the whole prose call.
 *
 * Event protocol — every event is a JSON object with a `type`:
 *   meta    { sql, rows, truncated, provenance }  rows are final before prose starts
 *   token   { text }                              a fragment of the answer
 *   result  { ...full JSON answer }               code-decided answers, sent whole
 *   error   { error, guarded }
 *   done    {}
 *
 * Errors after the stream opens can't change the HTTP status — the 200 is
 * long gone — so they travel as an `error` event and the client renders them
 * exactly as it renders a non-2xx JSON body.
 */
function askStream(question, history, env, skipCache = false) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        const r = await resolve(question, history, env, skipCache);
        if (r.done) {
          send({ type: 'result', ...r.done });
          send({ type: 'done' });
          return;
        }

        send({ type: 'meta', sql: r.sql, rows: r.rows, truncated: r.truncated, provenance: r.provenance });

        const ai = await infer(env, PROSE_MODEL, {
          messages: prosePrompt(question, r.sql, r.rows, r.truncated),
          max_tokens: 200,
          temperature: 0,
          stream: true,
        }, skipCache);

        // Workers AI streams SSE bytes: `data: {"response":"tok"}` lines ending
        // with `data: [DONE]`. Chunk boundaries can split a line, so buffer the
        // partial tail between reads.
        const reader = ai.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let wrote = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const payload = line.match(/^data: ?(.*)/)?.[1];
            if (!payload || payload === '[DONE]') continue;
            let text = '';
            try { text = textOf(JSON.parse(payload)); } catch { continue; }
            if (text) {
              wrote = true;
              send({ type: 'token', text });
            }
          }
        }

        if (!wrote) send({ type: 'token', text: 'The query ran but produced no summary.' });
        if (r.truncated) send({ type: 'token', text: TRUNCATION_NOTE(MAX_LIMIT) });
        send({ type: 'done' });
      } catch (err) {
        if (err instanceof SqlRejected) {
          send({ type: 'error', error: `Rejected the generated query: ${err.message}`, guarded: true });
        } else {
          console.error('ask failed', err);
          send({ type: 'error', error: 'Something went wrong running that question.', guarded: false });
        }
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
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

      const history = cleanHistory(payload?.history);

      // stream: true switches the response to server-sent events. Auth and
      // validation failures above still return JSON — the stream only begins
      // once the question is actually going to run, so the client can treat
      // "content-type: application/json" as the error path.
      if (payload?.stream === true) {
        return askStream(question.trim(), history, env, skipCache);
      }

      try {
        return json(await ask(question.trim(), history, env, skipCache));
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
