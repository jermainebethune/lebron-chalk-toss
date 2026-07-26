/**
 * Who is allowed to spend a Neuron.
 *
 * Before this existed, /api/ask was open to anyone who knew the URL. At ~35.5
 * Neurons per question against a 10,000/day allowance, a trivial loop could
 * exhaust the daily budget in minutes and take the app down until 00:00 UTC.
 *
 * Two ways in, deliberately:
 *
 *   1. A Turnstile token — what the web page sends. Invisible to real users,
 *      expensive for scripts.
 *   2. An API key header — so the thing can still be driven programmatically,
 *      by us for testing and by anyone we choose to hand a key to.
 *
 * Checked BEFORE any inference runs, because the whole point is not spending
 * the budget on unauthorized callers.
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Turnstile tokens are single-use, so verifying per question meant the widget
// re-challenged the same human on every ask — a checkbox between every
// follow-up. Instead, the FIRST successful verification mints a short-lived
// session token (HMAC-signed, bound to the caller's IP) and later questions
// present that. One human, one challenge, a conversation's worth of questions.
const SESSION_TTL_S = 2 * 60 * 60;

export const DENIED = {
  NO_PROOF: 'Send a Turnstile token or an x-api-key header.',
  BAD_TOKEN: 'That Turnstile token was not accepted.',
  BAD_KEY: 'That API key is not valid.',
  BAD_SESSION: 'Session expired.',
};

/**
 * Constant-time-ish string compare. Not a defence against a determined
 * attacker over the network (jitter swamps the signal), but it costs nothing
 * and avoids the habit of leaking length/prefix through early return.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Signed with TURNSTILE_SECRET — a secret we already hold and rotate with the
 * widget, so no new secret to manage. Bound to the caller's IP: a leaked token
 * is useless elsewhere, and an IP change mid-session just re-verifies once.
 */
export async function mintSession(env, ip) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  return `${exp}.${await hmacHex(env.TURNSTILE_SECRET, `session:${exp}:${ip ?? ''}`)}`;
}

async function verifySession(env, token, ip) {
  if (typeof token !== 'string' || token.length > 100) return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  return safeEqual(sig, await hmacHex(env.TURNSTILE_SECRET, `session:${exp}:${ip ?? ''}`));
}

async function verifyTurnstile(token, secret, ip) {
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);

  const res = await fetch(VERIFY_URL, { method: 'POST', body: form });
  if (!res.ok) return false;
  const data = await res.json();
  return data.success === true;
}

/**
 * Returns { ok: true, via } or { ok: false, reason }.
 *
 * Fails closed: if a secret isn't configured, that path simply isn't available
 * rather than silently allowing everything through.
 */
export async function authorize(request, body, env) {
  const key = request.headers.get('x-api-key');
  if (key) {
    if (env.API_KEY && safeEqual(key, env.API_KEY)) return { ok: true, via: 'api-key' };
    return { ok: false, reason: DENIED.BAD_KEY };
  }

  if (body?.sessionToken) {
    const ip = request.headers.get('cf-connecting-ip');
    if (env.TURNSTILE_SECRET && await verifySession(env, body.sessionToken, ip)) {
      return { ok: true, via: 'session' };
    }
    // Expired or invalid — tell the client plainly so it can fall back to a
    // fresh Turnstile pass instead of showing the user an opaque failure.
    return { ok: false, reason: DENIED.BAD_SESSION };
  }

  const token = body?.turnstileToken;
  if (token) {
    if (!env.TURNSTILE_SECRET) return { ok: false, reason: DENIED.BAD_TOKEN };
    const ip = request.headers.get('cf-connecting-ip');
    const good = await verifyTurnstile(token, env.TURNSTILE_SECRET, ip);
    return good ? { ok: true, via: 'turnstile' } : { ok: false, reason: DENIED.BAD_TOKEN };
  }

  return { ok: false, reason: DENIED.NO_PROOF };
}
