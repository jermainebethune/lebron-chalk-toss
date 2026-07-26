import { SqlRejected, MAX_LIMIT } from './guard.js';
import { prosePrompt } from './prompts.js';
import { authorize, mintSession } from './access.js';
import { page } from './ui.js';
import { ingestAndRecord } from './ingest.js';
import {
  PROSE_MODEL,
  TRUNCATION_NOTE,
  ask,
  cleanHistory,
  infer,
  provenance,
  resolve,
  textOf,
} from './oracle.js';
import { probe } from './semcache.js';
import { ChalkTossMCP } from './mcp.js';

// Durable Object classes have to be exported from the Worker's entrypoint for
// the runtime to find them by class_name. ChalkTossMCP is one session of the
// MCP server; RateLimiter is the per-IP Neuron budget it spends against.
export { ChalkTossMCP } from './mcp.js';
export { RateLimiter } from './limiter.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

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
function askStream(question, history, env, skipCache = false, session = null) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        const r = await resolve(question, history, env, skipCache);
        if (r.done) {
          send({ type: 'result', ...r.done, ...(session ? { session } : {}) });
          send({ type: 'done' });
          return;
        }

        send({ type: 'meta', sql: r.sql, rows: r.rows, truncated: r.truncated, provenance: r.provenance, ...(session ? { session } : {}) });

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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // The MCP server. Streamable HTTP is the current transport in the spec;
    // /sse is the older one, still routed because shipped clients pinned to it
    // outnumber the ones that have moved. Both reach the same agent.
    //
    // The caller's IP is handed over through ctx.props — the same channel an
    // OAuth provider would use to pass identity. The agent runs inside a
    // Durable Object where cf-connecting-ip is not something to rely on, and
    // the rate limiter needs to know who it is metering.
    if (url.pathname === '/mcp' || url.pathname.startsWith('/sse')) {
      ctx.props = { ...(ctx.props ?? {}), ip: request.headers.get('cf-connecting-ip') ?? null };
      return url.pathname === '/mcp'
        ? ChalkTossMCP.serve('/mcp').fetch(request, env, ctx)
        : ChalkTossMCP.serveSSE('/sse').fetch(request, env, ctx);
    }

    if (url.pathname === '/') {
      // The kicker line counts what is actually in the database, so a night's
      // ingestion is visible on the page the next morning. If the query fails
      // the page still renders — page() falls back to the last known numbers.
      let counts = null;
      try {
        counts = await env.DB.prepare(
          'SELECT COUNT(*) AS games, COUNT(DISTINCT season) AS seasons FROM games'
        ).first();
      } catch (e) {
        console.warn('count query failed, serving fallback kicker', e?.message);
      }
      return new Response(page(counts), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    // Manual ingestion trigger — same code path the cron runs, for testing
    // and catch-up. API key only: it makes outbound API calls on our key.
    if (url.pathname === '/api/ingest') {
      if (request.method !== 'POST') {
        return json({ error: 'Send a POST.' }, 405);
      }
      const allowed = await authorize(request, {}, env);
      if (!allowed.ok || allowed.via !== 'api-key') {
        return json({ error: 'API key required.' }, 401);
      }
      if (!env.BALLDONTLIE_KEY) {
        return json({ error: 'BALLDONTLIE_KEY is not configured.' }, 500);
      }
      try {
        return json(await ingestAndRecord(env, 'manual'));
      } catch (err) {
        console.error('ingest failed', err);
        return json({ error: `Ingest failed: ${err.message}` }, 500);
      }
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

      // A fresh Turnstile pass earns a session token so the next questions
      // skip the widget entirely. It rides back on the answer (meta/result
      // event when streaming, a field when JSON).
      const session = allowed.via === 'turnstile' && env.TURNSTILE_SECRET
        ? await mintSession(env, request.headers.get('cf-connecting-ip'))
        : null;

      // stream: true switches the response to server-sent events. Auth and
      // validation failures above still return JSON — the stream only begins
      // once the question is actually going to run, so the client can treat
      // "content-type: application/json" as the error path.
      if (payload?.stream === true) {
        return askStream(question.trim(), history, env, skipCache, session);
      }

      try {
        const result = await ask(question.trim(), history, env, skipCache);
        if (session) result.session = session;
        return json(result);
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

    // Threshold tuning instrument. Reports the nearest cached questions and
    // their scores WITHOUT serving from cache, so the cutoff can be chosen
    // from real numbers instead of guessed. API key only — it embeds text,
    // which costs a little, and it exposes what has been asked before.
    if (url.pathname === '/api/cache/probe') {
      const allowed = await authorize(request, {}, env);
      if (!allowed.ok || allowed.via !== 'api-key') {
        return json({ error: 'API key required.' }, 401);
      }
      const q = url.searchParams.get('q');
      if (!q) return json({ error: 'Pass ?q=<question>' }, 400);
      try {
        return json(await probe(env, q));
      } catch (err) {
        console.error('cache probe failed', err);
        return json({ error: `Probe failed: ${err.message}` }, 500);
      }
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, provenance: await provenance(env) });
    }

    return json({ error: 'Not found' }, 404);
  },

  // The nightly poll. 10:00 UTC is 5-6am Eastern — every game from the night
  // before has a final box score by then, including West Coast overtimes.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      ingestAndRecord(env, 'cron')
        .then((s) => console.log('ingest', JSON.stringify(s)))
        .catch((err) => console.error('ingest failed', err))
    );
  },
};
