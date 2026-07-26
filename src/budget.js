/**
 * The Neuron budget, as arithmetic and numbers.
 *
 * Separate from limiter.js so it can be tested: limiter.js imports
 * `cloudflare:workers` for the Durable Object base class, which only resolves
 * inside the Workers runtime. Everything here is plain JavaScript, so
 * `node --test` can reach it. The interesting part of a rate limiter is the
 * decision, not the storage — this is the decision.
 */

// Per-caller: enough to hold a real conversation with the oracle, not enough
// for one client to eat the day. 20/hour against a ~280/day total means it
// takes 14 hours of sustained maximum use by a single IP to exhaust the
// allowance — by which time the global ceiling below has already stopped it.
export const PER_IP = { limit: 20, windowMs: 60 * 60 * 1000 };

// The whole MCP surface's daily share. The web page has to keep working even
// if the MCP server is being hammered, so MCP gets a slice of the day rather
// than all of it. 150 questions is a bit over half the daily capacity.
export const GLOBAL = { limit: 150, windowMs: 24 * 60 * 60 * 1000 };

/**
 * Decide whether one unit may be spent, and what the bucket becomes.
 *
 * A fixed window, not a sliding one. A sliding window needs the timestamp of
 * every request in the window; a fixed window needs a count and one deadline.
 * The failure mode of a fixed window is a burst across the boundary — up to
 * 2x the limit in one instant — which for a spend cap is a rounding error and
 * nowhere near worth the storage.
 *
 * Returns { ok, remaining, resetAt, bucket }. `bucket` is null when there is
 * nothing to write, which is every refusal — a client hammering a spent
 * budget should not be able to cause a storage write per attempt.
 */
export function advance(bucket, now, limit, windowMs) {
  let b = bucket;
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
  }

  if (b.count >= limit) {
    return { ok: false, remaining: 0, resetAt: b.resetAt, bucket: null };
  }

  const next = { count: b.count + 1, resetAt: b.resetAt };
  return { ok: true, remaining: limit - next.count, resetAt: next.resetAt, bucket: next };
}

/**
 * Read the budget without spending from it. Used by the status reporting in
 * ask_lebron's response, which should be able to say "3 questions left"
 * without one of them being the question that asked.
 */
export function peek(bucket, now, limit) {
  if (!bucket || now >= bucket.resetAt) {
    return { remaining: limit, resetAt: null };
  }
  return { remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt };
}
