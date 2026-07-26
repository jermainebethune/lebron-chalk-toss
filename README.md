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
question → Worker → authorize ──→ AI Gateway → Workers AI (writes SQL)
                    (Turnstile        │                      ↓
                     or API key)      │                    guard
                                      │                      ↓
                                   cache hit           D1 (runs it)
                                   0 Neurons                 ↓
                                      │                  real rows
                                      ↓                      ↓
        answer ←── AI Gateway → Workers AI (describes rows) ←┘
```

## Keeping the data current

A cron trigger (10:00 UTC daily — after every box score from the night before is final)
runs `src/ingest.js`: it polls balldontlie for games newer than `MAX(games.date)`, filters
out DNP rows (0 minutes on the floor is not a game played), inserts what's new, upserts the
affected season rows from `/season_averages`, and stamps `data_provenance`. The page's
kicker line counts the live table, so a night's ingestion is visible the next morning.

The watermark is polled per-season from where it falls through the current season, so a
database that has been stale for months backfills whole missed seasons — its first
production run loaded the entire 2025-26 season (70 games) in under a second. Runs are
idempotent; offseason runs find nothing and cost nothing but the poll.

`POST /api/ingest` (API key only) runs the same code path on demand. The balldontlie key
lives as the `BALLDONTLIE_KEY` Worker secret.

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

## Deploying from a new machine

```bash
git clone https://github.com/jermainebethune/lebron-chalk-toss.git
cd lebron-chalk-toss && npm install
npx wrangler login && npx wrangler deploy
```

Secrets live on the Worker, data lives in D1, so neither is on any laptop. See
[RECOVERY.md](RECOVERY.md) for what is machine-only and what cannot be recovered.

## Layout

| File | Purpose |
|---|---|
| `src/index.js` | Request flow and error handling |
| `src/oracle.js` | The pipeline with no transport attached — question in, rows out |
| `src/mcp.js` | The MCP server — same pipeline, spoken to by other models |
| `src/limiter.js` | The rate-limiting Durable Object |
| `src/budget.js` | The rate-limit decision, as testable arithmetic |
| `src/access.js` | Who may spend a Neuron — Turnstile or API key |
| `src/guard.js` | SQL validation — the security boundary |
| `src/prompts.js` | The two prompts and the schema shown to the model |
| `src/ui.js` | Single-page frontend — design, chalk-burst canvas, Turnstile wiring |
| `public/img/` | Photographs, served by the static assets binding |
| `extract.mjs` | Regenerates `seed.sql` from the balldontlie API |
| `deploy.sh` | Deploys, then emails a summary — only if the deploy succeeded |
| `test/guard.test.js` | 15 unit tests against the guard |
| `test/budget.test.js` | 10 unit tests against the rate-limit arithmetic |
| `diagrams/` | Source HTML for every diagram — self-contained, no build step |
| `eval/cases.js` | The answer key — 20 questions with queries we trust |
| `eval/run.mjs` | Runs the answer key against the live app |

## Evaluating the SQL layer

Every bug below was a SQL-generation error, and every one was found by hand, one at a time.
That is not a strategy. `npm run eval` is the systematic version.

Each case pairs a question in English with **a query we wrote ourselves and trust**. The
runner executes both and compares the *results* — not the SQL text, because there are many
correct ways to write the same query and string-matching would fail on harmless rewording
while passing subtly wrong logic.

```
$ npm run eval

  opponent-not-team         ✓ 9 rows
  truncation-disclosed      ✓ capped at 100, disclosed
  awards-refused            ✓ refused
  ...
  20/20 passed (100%)
```

Expected values are never hard-coded — they come from running the trusted query against the
live database, so reloading the dataset moves the expectations with it and fixtures cannot go
stale. Failures print both queries side by side.

Every shipped bug is a case tagged `regression`, so none of them can come back silently.
`npm run eval -- --regression` runs just those.

**A full run is ~710 Neurons, about 7% of the daily free allowance** — roughly 14 runs a day.
Run it when something changes, not on every save.

### What it immediately paid for

**It found bug 10 on its first run.** "40+ games" has 108 results; the guard's `LIMIT 100`
truncated it to 100 and the app presented that as the complete answer. Nobody would have
noticed. Results that hit the cap now say so.

**It settled the model question with a number.** The SQL model is 94% of the running cost,
and swapping it for the cheap one was previously a leap of faith. Measured:

| SQL model | Neurons/call | Eval score |
|---|---|---|
| `qwen2.5-coder-32b` | 33.2 | **20/20 (100%)** |
| `llama-3.2-3b` | 2.3 | 14/20 (70%) |

The cheap model is 14× cheaper and fails six cases — including three refusals. It answered
"how many championships?" with `SELECT COUNT(opponent) FROM games WHERE playoff = 1`, which
returns a real number that is not remotely the answer. That is the MVP bug all over again.

**14× cheaper is not worth 30% wrong.** But that is now a decision backed by a measurement
rather than an instinct, and re-running the comparison after any prompt change takes one
command.

## AI Gateway

Every inference goes through an AI Gateway (`chalk-toss`), which adds caching, request logs
and per-model analytics for nothing.

**Repeat questions cost zero.** Measured, not assumed — five identical requests consumed
**0 Neurons and 0 inference calls**, against the 178 they would otherwise have cost. Latency
drops from ~1.8s to ~0.4s.

Caching is safe here because both prompts are **self-invalidating**: the SQL prompt contains
the schema, the prose prompt contains the returned rows. Change the data or the schema and
the prompt changes, so the cache key changes. Nothing stale can be served.

### The eval has to bypass it

A suite that replays cached answers would keep passing long after the model started failing —
it would be testing the cache, not the model. So `eval/run.mjs` sends `skipCache: true`.

That flag is honoured **only for API-key callers**, so a public visitor cannot force cache
misses and drain the daily budget.

Verified by latency, which is immediate where analytics are not: 1.17s cold → 0.42s cached →
**1.36s with `skipCache`**. Real inference resumes on demand.

> **Gotcha:** the GraphQL analytics lag several minutes behind real time. A reading of "0
> Neurons consumed" right after a run looks exactly like a broken cache bypass. It was lag —
> the same numbers appeared later. Confirm behaviour with latency before trusting a fresh
> analytics query.

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

Turnstile tokens are single-use, which originally meant the widget re-challenged the same
human before every question. Now the first successful verification mints a **session
token** — two hours, HMAC-signed with the Turnstile secret, bound to the caller's IP —
which rides back on the answer and replaces the widget for the rest of the visit. An
expired or moved session falls back to one silent re-verification.

```bash
curl -X POST https://chalk-toss.jermaine-e7a.workers.dev/api/ask \
  -H 'content-type: application/json' \
  -H 'x-api-key: <key>' \
  -d '{"question":"What was his career high?"}'
```

The payload takes two optional fields beyond `question`:

- `"stream": true` switches the response to server-sent events: a `meta` event once the
  rows are final (SQL, rows, provenance), `token` events as the prose model writes, and
  `done`. Code-decided answers (unanswerable, empty result) arrive whole as a `result`
  event. Auth and validation failures still return plain JSON — the stream only opens
  once the question is actually going to run.
- `"history": [{"question", "sql"}, ...]` carries the previous exchanges (up to 4) so
  follow-ups resolve — "what about the playoffs?" reuses the prior question's conditions.
  The history is prompt context only; the SQL that runs is always freshly written this
  turn and still goes through the guard. The web page sends both fields automatically.

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

## The MCP server

The website answers questions from a text box. The MCP server answers them from whatever
else is holding a model — Claude Desktop, an IDE, another agent. Same database, same guard,
same refusal to let a model state a number it wasn't handed.

**Endpoint:** `https://chalk-toss.jermaine-e7a.workers.dev/mcp` (Streamable HTTP).
`/sse` is also routed, for clients still pinned to the older transport.

Use the `workers.dev` host, not `chalk.jermainebethune.com` — the zone's bot protection
challenges API clients on the custom domain. Adding it to a client:

```json
{
  "mcpServers": {
    "chalk-toss": {
      "type": "http",
      "url": "https://chalk-toss.jermaine-e7a.workers.dev/mcp"
    }
  }
}
```

No authentication. The budget is metered instead — see below.

### The tool surface is two-tiered, and the split is the point

| Tool | Cost | Who writes the SQL |
|---|---|---|
| `ask_lebron` | ~35.5 Neurons | Ours |
| `run_stat_query` | a D1 read | **Theirs** |
| `get_schema` | a D1 read | — |
| `get_season_averages` | a D1 read | — |

`run_stat_query` is the more interesting tool. A calling model that can already write SQLite
doesn't need ours to translate for it — it needs a schema, a validator it cannot talk its way
past, and a database. So it gets exactly that. The guard was written to protect D1 from our
own model; it turns out to protect it from anyone's, and a caller-written query gets no more
trust than a model-written one and no less.

That inverts the usual economics of an AI service. The *cheapest* path through this server is
also the most capable one, and it costs us a D1 read rather than a model call.

Every tool returns the SQL that ran alongside the rows, so the caller can check the work
rather than take the answer on faith — the same reason the website shows the query.

### Sessions are Durable Objects, so follow-ups work

Each MCP session is one Durable Object instance, which is what lets `ask_lebron` accept
"what about the playoffs?" without the client threading state back. The last four exchanges
are stored — persisted, not held in memory, because the object hibernates between questions
and an in-memory array would silently empty out mid-conversation after a quiet minute.
Pass `new_conversation: true` to start fresh.

### Why it's open, and how the budget survives that

Turnstile can't apply here: an MCP client is a program by definition, and there's no human to
challenge. But the thing Turnstile protects is still worth protecting — at ~35.5 Neurons a
question against a 10,000/day allowance, roughly 280 questions exhaust the day and the site
goes down until 00:00 UTC.

So the server is open and the *budget* is metered, by a second Durable Object. Counting is
exactly the job a DO exists for: a counter has to be in one place, and Workers are in every
place.

Two limits, one class, distinguished only by which instance you address:

- **20 questions per hour per client** (`ip:<addr>`) — stops one caller monopolizing the day
- **150 questions per day, server-wide** (`global`) — so all the per-client budgets together
  still can't overrun the allowance, and the website keeps working no matter what the MCP
  surface is doing

Per-IP is checked **first**. If a caller is over their own limit, that must not consume a unit
of the global budget — otherwise one abusive client drains the day's ceiling while being
refused every time.

Only the Neuron-spending tool is metered. The D1-backed tools are throttling nothing scarce,
so they run free — and a refusal says so, pointing the caller at `run_stat_query` instead of
just failing.

The window is fixed rather than sliding: a sliding window needs the timestamp of every request
in it, a fixed window needs a count and one deadline. The failure mode is a burst across the
boundary — up to 2× the limit in one instant — which for a spend cap is a rounding error.
Refusals write nothing, so hammering a spent budget can't cause a storage write per attempt,
and each write sets an alarm at the reset time to delete the instance's storage rather than
leaving a row behind for every IP that ever called.

## The semantic cache

AI Gateway caches on exact prompt text, so three wordings of one question are three
cache misses and three full pipeline runs. Worse, the SQL prompt contains today's date
(the temporal anchor), so the exact-match cache empties itself every midnight UTC.

Vectorize matches on meaning instead: embed the question, look for a near neighbour among
questions already asked, reuse what it produced.

### It caches the SQL, not the answer

This is the decision the whole feature rests on. A semantic cache normally returns the
stored *answer*. Here that would break the guarantee everything else is defending.

The database updates nightly. A cached answer — "his career high is 61 points" — is a
frozen fact, and the night ingestion adds a 62-point game it becomes a lie the system
states confidently in its own voice.

A cached *SQL statement* has no such problem. Re-run it, get today's rows. Every number
still comes from D1 on every request; only the translation from English is skipped. And
translation is where the money is — measured on a real day, `qwen2.5-coder-32b` (SQL)
burned 8,296 Neurons against `llama-4-scout-17b` (prose) at 2,232. A hit skips 77% of the
cost and still runs the query.

The guard runs on cached SQL too. A statement isn't more trustworthy for having been
approved once before.

### Choosing the threshold — the measurement that changed the design

The cutoff was set by measuring, not by intuition. Pairwise cosine similarity:

| Pair | bge-base (768d) | bge-large (1024d) |
|---|---|---|
| Paraphrase — close wording | 0.9269 | **0.9643** |
| Paraphrase — nickname ("Celtics" for "Boston") | 0.9074 | **0.9220** |
| Paraphrase — loose wording | 0.8625 | 0.8627 |
| Near-miss — **wrong team** (Miami vs Boston) | 0.9007 | 0.8936 |
| Near-miss — **wrong stat** (rebounds vs points) | 0.8958 | 0.8959 |
| Near-miss — **wrong stat** (Denver assists vs rebounds) | 0.8773 | 0.8778 |

Read the third row against the fourth. **The loosest paraphrase scores below every
near-miss.** The classes overlap, so no threshold separates them cleanly. These questions
share so much boilerplate — "what was his highest ___ game against ___" — that the shared
structure dominates the similarity, and the part that actually distinguishes them (one
team name, one stat name) is a small fraction of the sentence.

That killed the original plan of an aggressive cutoff. The line is drawn to be *safe*
rather than complete: **0.92**, above every measured near-miss by 0.024, catching the two
paraphrase forms people actually type and letting loosely-worded ones pay full price.

`bge-large` earns its extra 256 dimensions here — it pulls real paraphrases up and pushes
near-misses down. `bge-base` cannot express this policy at all: its nickname paraphrase
(0.9074) scores *below* its own wrong-team near-miss (0.9007), so any threshold catching
the first also catches the second.

The asymmetry justifies the caution. A miss costs ~35 Neurons. A bad hit answers a
question nobody asked, with real rows from a real query, and looks entirely correct.

Six pairs is a small sample. `GET /api/cache/probe?q=...` (API key) reports nearest
neighbours and scores without serving from cache, for extending it.

### What is never cached

- **Follow-ups.** "What about the playoffs?" means nothing on its own.
- **Temporal questions** — anything matching this/last/latest/current/recent/today. "How
  many points this season?" may produce `WHERE season = '2025-26'` as a literal, correct
  today and wrong in November. A cache entry outlives the assumption behind it.
- **UNANSWERABLE verdicts.** That's a judgement about the schema, and the schema can gain
  a column.
- **Queries D1 rejected.** Caching a statement known not to run would turn a one-off model
  mistake into a permanently reproducible failure.

### Gotcha: Vectorize is eventually consistent

An upsert is not immediately queryable. Two measurement runs produced nonsense — a seeded
question scoring 0 against an index that genuinely did contain it moments later. If you
seed and query in quick succession, you are measuring indexing lag, not similarity.

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

**7. A partial table answered questions it couldn't actually answer.** `games` began as 238
rows curated by *scoring* thresholds. Asked "what game did he have the most blocks?", the app
correctly refused — blocks weren't stored at all. But simply adding the column would have
produced something worse than a refusal: his three 5-block games were **21, 17 and 15-point
nights**, none of which met the scoring criteria, so the query would have returned a 4-block
game and presented it as a career high. Every number real, the answer wrong.

Fixed by loading **all 1,912 games** and the full stat line. ~1,900 rows is nothing for D1,
and the curation was buying tidiness at the cost of correctness.

> A sample can only answer questions about the axis you sampled on.

**8. `LIMIT 1` hides ties.** "Highest blocks" returned one game when three share the record —
and no prompt rule could fix it, because the SQL truncated the tie before the model ever saw
it. Superlatives now use `WHERE x = (SELECT MAX(x) ...)` so ties surface as ties.

**9. "Minutes in his career high game" ordered by minutes.** It returned his longest game (54
minutes) rather than the minutes in his 61-point game (41). Fixed by pinning "career high" to
points in the prompt — *order by the stat named, not the stat asked for*.

**10. The row cap silently truncated results.** Found by the eval harness on its first full
run, which is the entire argument for having one. "40+ games" returns 108 rows; the guard
injects `LIMIT 100`; the app returned 100 and described them as if that were all of them.
Every number real, the answer incomplete, and no way for a reader to tell. Capped results now
say so explicitly.

> A truncated answer presented as complete is the same failure as a wrong number.

## The front end

Named for the pre-game ritual, and the design follows from it: arena-dark ground, chalk-white
type, and a puff of chalk thrown from the Ask button when a question goes up. That burst is the
only motion on the page and fires on submit only, so it marks a moment rather than decorating
one. It respects `prefers-reduced-motion`.

Accent colour is Heat red because both photographs are from the Miami years — **if the photos
are ever swapped for Cleveland or Lakers shots, the accent has to move with them.**

Two things worth knowing if you edit it:

- **The hero is full-height, so anything written into the results container starts below the
  fold.** Every output state routes through one `render()` helper that writes *and* scrolls.
  Originally only the success path scrolled, which made errors and the "verification still
  clearing" message look like the page had done nothing at all.
- **Scroll to the first result slab, not the container** — the container carries large vertical
  padding, so targeting it lands the viewport in a blank gap.

## Deploy notifications

`npm run deploy` deploys and then emails a summary.

Cloudflare has **no "Worker deployed" alert type at all** — verified against all 57 alert
types on the account. The only Workers entry is log-based observability, which fires on
errors, not deployments. There *is* a Pages alert group, which is why a Pages deploy
notification is possible; Workers has no equivalent, and connecting Workers Builds does not
add one. So `deploy.sh` sends the mail itself, via the `hey` CLI.

The email carries the commit, version ID, and a **live health check of the thing just
shipped** — so it reports reality rather than merely that `wrangler` exited 0.

Two things this got wrong first time, both worth knowing:

- **The first version emailed on a failed deploy.** It piped `wrangler` into `tee` and chained
  the notifier with `&&` — but a pipeline's exit status is the *last* command's, so `tee`
  succeeding masked `wrangler` failing. Now the status is captured with `PIPESTATUS`.
- It only fires for `npm run deploy`. A bare `wrangler deploy` skips it.

## Photographs — attribution

The two photos in `public/img/` are from Wikimedia Commons, resized and re-compressed from
~900 KB down to 220 KB total. The site footer credits both photographers, links each licence,
and notes the images were cropped and resized (a CC BY-SA requirement for modified works):

- `lebron-heat-ball.jpg` — [LeBron James 2011 (cropped)](https://commons.wikimedia.org/wiki/File:LeBron_James_2011_(cropped).jpg)
  by Keith Allison, [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/)
- `lebron-miami-6.jpg` — [LeBron James at GSW (cropped)](https://commons.wikimedia.org/wiki/File:LeBron_James_at_GSW_(cropped).jpg)
  by Steve Jurvetson, [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/)

## Limits worth stating

- **`games` holds every game** — 1,912 rows, regular season and playoffs, with minutes,
  points, rebounds, assists, steals, blocks and turnovers. It was once a 238-game sample
  curated by scoring thresholds; see bug 7 below for why that had to change.
- **`seasons.games` is the regular-season total** (1,565). `games` includes the 293 playoff
  appearances, so the two counts differ on purpose.
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
