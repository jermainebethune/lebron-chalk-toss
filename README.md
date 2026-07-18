# The Chalk Toss

Ask a question about LeBron James' career in plain English. Get back real numbers.

**Live:** [chalk.jermainebethune.com](https://chalk.jermainebethune.com)
**API:** [chalk-toss.jermaine-e7a.workers.dev](https://chalk-toss.jermaine-e7a.workers.dev)

```
"When did he score 40+ against Boston?"
→ SELECT date, opponent, points FROM games WHERE opponent = 'BOS' AND points >= 40
→ 9 rows from D1
→ "He scored 40 or more against Boston on 2006-02-15, 2008-05-18, 2010-04-04, …"
```

Built on Cloudflare Workers, Workers AI, and D1. Runs on the free tier.

## The idea

A chatbot asked "how many points does LeBron have?" answers from training data, and can be
confidently wrong. This never asks the model what it knows.

The model has exactly two jobs:

1. Turn a question into a SQL query
2. Describe rows that were handed to it

Every number a user sees came out of the database in between. The model cannot invent a
statistic because it is never asked to recall one.

```
question → Worker → authorize → Workers AI (writes SQL) → guard → D1 (runs it)
                    (Turnstile                                      ↓
                     or API key)                                  real rows
                                                                    ↓
        answer ← Workers AI (describes rows) ←──────────────────────┘
```

## Running it

```bash
npm install
npx wrangler login

npm run schema     # create tables in D1
npm run seed       # load data
npm run deploy

npm test           # guard unit tests
```

To regenerate the dataset you need a [balldontlie](https://balldontlie.io) API key with
stats access in `~/.balldontlie_key`:

```bash
node extract.mjs > seed.sql && npm run seed
```

The key is only used by the extractor. The deployed Worker reads D1 and nothing else, so
there is no secret in production.

## Layout

| File | Purpose |
|---|---|
| `src/index.js` | Request flow and error handling |
| `src/access.js` | Who may spend a Neuron — Turnstile or API key |
| `src/guard.js` | SQL validation — the security boundary |
| `src/prompts.js` | The two prompts and the schema shown to the model |
| `src/ui.js` | Single-page frontend |
| `extract.mjs` | Regenerates `seed.sql` from the balldontlie API |
| `test/guard.test.js` | 15 tests against the guard |

## Who can spend a Neuron

`/api/ask` was originally open to anyone who knew the URL. At ~35.5 Neurons per question
against a 10,000/day allowance, a trivial loop could exhaust the daily budget in minutes and
take the app down until 00:00 UTC.

Two ways in now, checked **before any inference runs**:

- **A Turnstile token** — what the page sends. Cloudflare's CAPTCHA alternative; usually
  invisible, occasionally a one-click checkbox for traffic that looks automated. Tokens are
  single-use, so the widget is reset after every question.
- **An `x-api-key` header** — so the thing stays drivable programmatically, for testing and
  for anyone handed a key.

Both secrets live as Worker secrets (`wrangler secret put`), never in the repo. The check
fails closed: if a secret isn't configured, that path is simply unavailable rather than
silently open.

```bash
curl -X POST https://chalk-toss.jermaine-e7a.workers.dev/api/ask \
  -H 'content-type: application/json' \
  -H 'x-api-key: <key>' \
  -d '{"question":"What was his career high?"}'
```

Worth naming the mistake this fixed: the SQL guard was built carefully against an
interesting threat — a model writing dangerous queries — while an ordinary one went
unconsidered for the whole build. Anyone could just call it. Hardening the interesting
attack surface is not the same as hardening the whole thing.

## The guard

An LLM writing SQL against your database is a real risk. The guard is an **allowlist with a
preprocessing pass**, not a keyword blocklist, because a blocklist is trivially defeated:

```sql
SELECT 1 /* comment */ ; DROP TABLE games
```

Scanning for `DROP` first sees a comment hiding a semicolon. So the order matters:

1. Strip comments and string literals, so nothing can hide syntax
2. Assert what remains is a single `SELECT` or `WITH`
3. Only then scan for forbidden constructs
4. Inject our own `LIMIT`, and cap any the model supplied

Blanking literals first also avoids false positives — `WHERE note = 'Roster update'` is data,
not a verb, and still works.

The D1 binding should also be read-only in production. The guard is defence in depth, not
the only defence.

## What went wrong while building it

The architecture worked immediately. Everything below was found by running it, and each one
is a more useful lesson than the parts that worked.

**1. The model catalog disagreed with the runtime.** The first model choice returned
"deprecated" at runtime while the account's own model-search API still listed it as
available with no deprecation flag — and listed a second dead model too. Fixed by
test-running six candidates against the live runtime before committing. Don't trust a
catalog you can probe.

**2. Ambiguous schema comments produced wrong SQL.** "40+ against Boston" became
`team = 'BOS'`, but `team` is *his* team. Zero rows. Fixed in the schema comments — and
notably, this model follows schema comments far more reliably than rules in the system
prompt. A later fix that was ignored as a prompt rule worked immediately when moved into a
schema comment.

**3. Right numbers, wrong question.** "How many games in Miami?" produced
`COUNT(*) FROM seasons` = 2, and the summary read "He played 2 games in Miami." Every number
was real; the sentence was still wrong. Fixed by documenting in the schema that `games` is a
curated sample and counts must come from `seasons.games`.

**4. The summarizer contradicted the database.** About one run in three it reported "no
matching games" while D1 had returned rows. The cause was a prompt instruction — "if the rows
are empty, say so" — that a small model fired regardless of the rows. **Fixed by deciding the
empty case in code, before the model is called at all.** A branch the code can evaluate
should never be delegated to a model. It also saves an inference call.

**5. An empty column answered a question it shouldn't have.** "How many MVPs did he win?"
returned **0**. The dataset has no awards data, so `accolades` was NULL on every row. The
column had already been removed from the model's schema prompt, but the model invented a
query against it anyway, the column still physically existed, and the query *succeeded*.

This is the one worth internalizing:

> Grounding a model in a datastore prevents **invented** numbers. It does not prevent a
> **wrong query** from producing a confidently wrong answer. An empty column is more
> dangerous than a missing one, because an empty column answers.

Fixed by dropping the column and catching D1 errors, so a query against absent data reads as
"not in this database" rather than as a number.

**6. Off-by-one in an inclusive range.** "40+" generated `points > 40`, silently excluding
19 exactly-40-point games. Caught by checking a boundary case rather than trusting an answer
that looked right.

## Photographs — attribution still needed

The two photos in `public/img/` are from Wikimedia Commons (filenames matched the Commons
naming convention), resized and re-compressed from ~900 KB down to 220 KB total.

**Most LeBron photographs on Commons are CC BY-SA, which requires naming the photographer,
linking the licence, and noting that the image was modified.** These are cropped and resized,
so that last part applies. The site footer currently carries a placeholder credit; it needs
the real photographer and licence before this counts as properly attributed.

To fix: find each file's page on Wikimedia Commons, take the author and licence, and replace
the `#photo-credit` line in `src/ui.js`.

## Limits worth stating

- **`games` is a curated sample**, not every game — selected by objective thresholds (40+
  points, playoff 35+, triple-doubles). Counting questions route to `seasons.games`, which
  holds true totals.
- **No awards, salary, or biographical data.** Those questions are refused rather than
  guessed. Deliberately left absent instead of hand-entered.
- **The guard has never fired in production.** Injection attempts are refused by the model at
  the prompt layer first. Those tests prove the *prompt* held, not the validator — the guard
  exists for the day the prompt doesn't, and is proven by the unit tests.
- **The custom domain sits behind the zone's bot protection**, which challenges non-browser
  clients. The `workers.dev` URL is kept live as the unchallenged path for API use.

## Cost

Everything fits the Cloudflare free tier: 100k Worker requests/day, 10k Workers AI
Neurons/day, 5M D1 rows read/day.

Measured over a day of development and testing, via the GraphQL analytics API
(`aiInferenceAdaptiveGroups` — there is no REST endpoint for this):

| Model | Role | Requests | Neurons | Per request |
|---|---|---|---|---|
| `qwen2.5-coder-32b` | writes the SQL | 64 | 2,127.7 | **33.2** |
| `llama-3.2-3b` | describes the rows | 50 | 115.9 | **2.3** |

**~35.5 Neurons per question → roughly 280 questions/day** within the free allowance.

Two things worth reading off that table:

**The SQL model is 94% of the cost.** It runs 14× more expensive per call than the
summarizer. Switching `SQL_MODEL` to `llama-3.2-3b` would cut cost to ~4.6 Neurons/question
(~2,100/day), but SQL quality is the single biggest source of wrong answers, so the
expensive model earns its place. The lever exists if traffic ever justifies pulling it.

**64 SQL calls but only 50 prose calls.** The other 14 questions were refused as
unanswerable or returned zero rows, and short-circuited before the second inference. The
early return that fixed bug #4 also eliminated 22% of inference calls — correctness and cost
happening to point the same direction.

Data from the [balldontlie API](https://balldontlie.io). Per-player box scores require a paid
tier; the free tier serves team-level results only.
