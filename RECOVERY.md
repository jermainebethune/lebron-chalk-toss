# Recovery — deploying from a new machine

Written after actually testing it: cloning this repo fresh into an empty directory,
installing, and running a dry-run deploy. Everything below is verified, not assumed.

**Short version: the app is safe.** The code is on GitHub, the data is in D1, and the secrets
live on the Worker. None of that is on any one laptop. To ship from a new machine you need
two commands and a browser.

---

## Deploying from scratch

```bash
git clone https://github.com/jermainebethune/lebron-chalk-toss.git
cd lebron-chalk-toss
npm install
npx wrangler login      # opens a browser, one time
npx wrangler deploy
```

That is genuinely all of it. Verified: a fresh clone installs, passes 15/15 unit tests, and
`wrangler deploy --dry-run` resolves both bindings.

---

## What survives a dead laptop, and why

| Thing | Lives where | Safe? |
|---|---|---|
| Source, prompts, guard, eval, photos | GitHub | ✅ |
| 22 seasons, 1,912 games | D1, on Cloudflare | ✅ |
| `TURNSTILE_SECRET`, `API_KEY` | Worker secrets, on Cloudflare | ✅ |
| Turnstile widget + sitekey | Cloudflare | ✅ |
| AI Gateway `chalk-toss` | Cloudflare | ✅ |
| DNS, custom domain, routes | Cloudflare | ✅ |

**Secrets do not need re-entering to deploy.** They are attached to the Worker, not to your
machine, and `wrangler deploy` leaves them alone. You only need their values again if the
Worker itself is deleted and recreated.

---

## What is only on this laptop

Four things. None of them stop you deploying; one of them cannot be recovered.

### 1. `~/.chalk_toss_api_key` — **not recoverable, regenerate it**

The API key for `/api/ask`. Cloudflare stores secrets **write-only** — nothing can read it
back, including you. If the laptop dies and you have no copy, the old value is gone forever.

Not a crisis. Generate a new one and overwrite:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" \
  | tee ~/.chalk_toss_api_key \
  | npx wrangler secret put API_KEY
chmod 600 ~/.chalk_toss_api_key
```

Only consequence: any script or person using the old key stops working. The website is
unaffected — it authenticates with Turnstile, not this key.

### 2. `~/.balldontlie_key` — recoverable from balldontlie

Only needed to **regenerate the dataset** (`node extract.mjs > seed.sql`). The deployed Worker
never calls balldontlie. Retrieve it from your balldontlie account and write it to
`~/.balldontlie_key` with `chmod 600`.

### 3. The `hey` CLI — reinstall and re-authenticate

Only used by `deploy.sh` to email a deploy summary. Without it, `deploy.sh` prints
`(hey CLI not found — no email)` and **the deploy still succeeds.** Nothing breaks.

### 4. Full-size source photos — recoverable from Wikimedia Commons

Kept outside the repo at `../source-photos/`. The optimised copies that the site actually
serves **are** committed in `public/img/`, so the site is unaffected. You would only want the
originals to re-crop or re-export at a different size.

---

## Rebuilding everything from nothing

Only needed if the Cloudflare resources are deleted too — not for a dead laptop.

```bash
npx wrangler d1 create lebron-oracle     # update database_id in wrangler.jsonc
npm run schema
npm run seed                             # seed.sql is committed, no API key needed
npx wrangler secret put TURNSTILE_SECRET # from the Turnstile dashboard
npx wrangler secret put API_KEY          # any new random value
npx wrangler deploy
```

Note that `seed.sql` is committed, so **the dataset can be restored without a balldontlie
subscription.** That was not deliberate at the time, but it means cancelling that
subscription costs you nothing unless you want fresher data.

You would also need to recreate the AI Gateway named `chalk-toss` (or remove the `gateway`
option in `src/index.js`), and re-point the custom domain.

---

## The one gap worth closing

The **API key is the only unrecoverable item**, and it exists in exactly one place on one
laptop. If that matters to you, put it in a password manager now — it takes ten seconds and
removes the only irreversible loss in this list.

Everything else here is an inconvenience measured in minutes.
