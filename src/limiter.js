/**
 * The Neuron budget, enforced by a Durable Object.
 *
 * The web page is protected by Turnstile: a human passes one challenge and
 * gets a session. The MCP server cannot use that — an MCP client is a program
 * by definition, and there is no human to challenge. But the thing Turnstile
 * was protecting is still worth protecting: at ~35.5 Neurons a question
 * against a 10,000/day allowance, roughly 280 questions exhaust the day and
 * the site goes down until 00:00 UTC.
 *
 * So the MCP server is open, and the budget is metered instead. Counting is
 * exactly the job a Durable Object exists for: a counter has to be in one
 * place, and Workers are in every place.
 *
 * Two limits, both through this class, distinguished only by which instance
 * you address:
 *
 *   idFromName('ip:1.2.3.4')  per-caller — stops one client monopolizing the day
 *   idFromName('global')      the whole server's daily ceiling, so all the
 *                             per-caller budgets together still can't overrun it
 *
 * Only calls that spend Neurons are metered. The D1-backed tools cost a query
 * and nothing else, so they run unmetered — throttling them would be
 * protecting a resource that isn't scarce.
 *
 * The decision itself lives in budget.js, where it can be tested without a
 * runtime. This file is the storage around it.
 */

import { DurableObject } from 'cloudflare:workers';
import { advance, peek, PER_IP, GLOBAL } from './budget.js';

export { PER_IP, GLOBAL };

export class RateLimiter extends DurableObject {
  /**
   * Spend one unit against this instance's budget.
   *
   * Returns { ok, remaining, resetAt } — resetAt is epoch ms, so a caller that
   * gets refused can tell the user when to come back rather than "try later".
   */
  async take(limit, windowMs) {
    const stored = await this.ctx.storage.get('bucket');
    const result = advance(stored, Date.now(), limit, windowMs);

    if (result.bucket) {
      await this.ctx.storage.put('bucket', result.bucket);
      // Evict this instance's storage when the window closes. Without it,
      // every IP that ever called leaves a row behind forever. The alarm is
      // set on each write rather than only the first — cheap, and it
      // self-heals if a previous alarm was lost.
      await this.ctx.storage.setAlarm(result.resetAt);
    }

    return { ok: result.ok, remaining: result.remaining, resetAt: result.resetAt };
  }

  async peek(limit) {
    return peek(await this.ctx.storage.get('bucket'), Date.now(), limit);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

/**
 * Spend one question against both budgets.
 *
 * Order matters: per-IP first. If one caller is over their own limit, that
 * must not consume a unit of the global budget — otherwise a single abusive
 * client still drains the day's ceiling while being refused every time.
 *
 * Returns { ok: true, remaining } or { ok: false, reason } with a message
 * written for a model to relay to a human, since that is exactly what will
 * happen to it.
 */
export async function spend(env, ip) {
  const perIp = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`ip:${ip || 'unknown'}`));
  const first = await perIp.take(PER_IP.limit, PER_IP.windowMs);
  if (!first.ok) {
    return {
      ok: false,
      reason: `Rate limit reached: ${PER_IP.limit} questions per hour per client. Resets at ${new Date(first.resetAt).toISOString()}. The other tools on this server read the database directly and are not rate limited — use run_stat_query if you want to keep going.`,
    };
  }

  const global = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName('global'));
  const second = await global.take(GLOBAL.limit, GLOBAL.windowMs);
  if (!second.ok) {
    return {
      ok: false,
      reason: `This server's daily question budget is spent (${GLOBAL.limit}/day across all clients). It resets at ${new Date(second.resetAt).toISOString()}. The database tools still work — use run_stat_query or get_season_averages.`,
    };
  }

  return { ok: true, remaining: first.remaining };
}
