/**
 * The Chalk Toss as an MCP server.
 *
 * The website answers questions from a text box. This answers them from
 * whatever else is holding a model — Claude Desktop, an IDE, another agent.
 * Same database, same guard, same refusal to let a model state a number it
 * wasn't handed.
 *
 * The tool surface is deliberately two-tiered, and the split is the design:
 *
 *   ask_lebron       spends Neurons. Our model writes the SQL. Metered.
 *   run_stat_query   spends nothing. THEIR model writes the SQL, our guard
 *                    decides whether it runs. Unmetered.
 *
 * The second one is the more interesting tool. A calling model that can write
 * SQLite doesn't need ours to translate for it — it needs a schema, a
 * validator it can't talk its way past, and a database. So it gets exactly
 * that. The guard was written to protect D1 from our own model; it turns out
 * to protect it from anyone's.
 *
 * Every session is a Durable Object, which is what makes follow-up questions
 * work without the client having to thread state back: "what about the
 * playoffs?" resolves against what this session already asked.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';

import { guard, SqlRejected, MAX_LIMIT } from './guard.js';
import { SCHEMA } from './prompts.js';
import { ask, provenance } from './oracle.js';
import { spend } from './limiter.js';

// Matches cleanHistory()'s window in oracle.js. Four exchanges is what the SQL
// prompt replays; keeping more here would just be storage nothing reads.
const HISTORY_DEPTH = 4;

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

// Tools that only read. Declaring it lets a client skip the "allow this?"
// prompt for reads and reserve it for things that actually change something —
// nothing here ever does.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export class ChalkTossMCP extends McpAgent {
  server = new McpServer({
    name: 'chalk-toss',
    version: '1.0.0',
  });

  /**
   * Conversation state for this session. Persisted rather than held in memory
   * because the Durable Object hibernates between questions — an in-memory
   * array would silently empty out mid-conversation after a quiet minute.
   */
  async history() {
    return (await this.ctx.storage.get('history')) ?? [];
  }

  async remember(question, sql) {
    if (!sql) return; // Refusals carry no context worth resolving against.
    const next = [...(await this.history()), { question, sql }].slice(-HISTORY_DEPTH);
    await this.ctx.storage.put('history', next);
  }

  async init() {
    this.server.registerTool(
      'ask_lebron',
      {
        title: 'Ask a question about LeBron James in plain English',
        description:
          "Answer a natural-language question about LeBron James's career from a database of all 1,982 games he has played (regular season and playoffs, full stat line) plus per-season averages. A model translates the question to SQL, a validator checks it, D1 runs it, and the answer describes only the rows that came back — so the numbers are read from the database, never recalled. Returns the answer, the SQL that produced it, and the rows themselves, so you can check the work. Rate limited, because it spends model budget; prefer run_stat_query if you can write SQLite yourself. Contains NO awards, salary, draft, biographical or three-point data.",
        inputSchema: {
          question: z
            .string()
            .min(1)
            .max(300)
            .describe('The question, in plain English. e.g. "What was his best scoring game against Boston?"'),
          new_conversation: z
            .boolean()
            .optional()
            .describe(
              'Start fresh, forgetting earlier questions in this session. Leave unset to ask a follow-up — "what about the playoffs?" will resolve against what you already asked.'
            ),
        },
        annotations: READ_ONLY,
      },
      async ({ question, new_conversation }) => {
        // Meter first. Everything before this line is free; everything after
        // it spends the day's allowance.
        const budget = await spend(this.env, this.props?.ip);
        if (!budget.ok) return fail(budget.reason);

        if (new_conversation) await this.ctx.storage.delete('history');
        const history = new_conversation ? [] : await this.history();

        try {
          const result = await ask(question.trim(), history, this.env);
          await this.remember(question.trim(), result.sql);

          return text(
            JSON.stringify(
              {
                answer: result.answer,
                sql: result.sql,
                rows: result.rows,
                truncated: result.truncated ?? false,
                provenance: result.provenance,
                // Where the SQL came from. A cache that silently changes the
                // provenance of an answer is one you cannot debug, and the
                // `nearest` score on a miss is the raw material for tuning the
                // hit threshold against real questions.
                cache: result.cache,
                questions_remaining_this_hour: budget.remaining,
              },
              null,
              2
            )
          );
        } catch (err) {
          if (err instanceof SqlRejected) {
            // Worth surfacing rather than flattening into "something failed":
            // the caller learns the query was refused, not that the data is
            // missing, and can rephrase instead of concluding wrongly.
            return fail(
              `The query generated for that question was rejected by the SQL guard: ${err.message} Try rephrasing, or write the query yourself with run_stat_query.`
            );
          }
          console.error('mcp ask_lebron failed', err);
          return fail('Something went wrong answering that question.');
        }
      }
    );

    this.server.registerTool(
      'run_stat_query',
      {
        title: 'Run your own SQLite query against the stats database',
        description:
          "Run a read-only SQLite SELECT against the LeBron James stats database and get the rows back as JSON. Call get_schema first for the table definitions. Free and unmetered — no model runs, so prefer this over ask_lebron when you can write the query yourself. The statement must be a single SELECT (a WITH ... SELECT is fine); anything that writes, attaches, or stacks a second statement is rejected, and results are capped at " +
          MAX_LIMIT +
          ' rows.',
        inputSchema: {
          sql: z
            .string()
            .min(1)
            .max(2000)
            .describe('A single SQLite SELECT statement. No semicolon needed, no markdown fence.'),
        },
        annotations: READ_ONLY,
      },
      async ({ sql }) => {
        // The same guard the website's model answers to. A caller-written
        // query gets no more trust than a model-written one — and no less.
        let checked;
        try {
          checked = guard(sql);
        } catch (err) {
          if (err instanceof SqlRejected) {
            return fail(`Rejected: ${err.message} Only a single bounded SELECT is allowed.`);
          }
          throw err;
        }

        try {
          const result = await this.env.DB.prepare(checked).all();
          const rows = result.results ?? [];
          return text(
            JSON.stringify(
              {
                sql: checked,
                row_count: rows.length,
                // A capped result presented as a whole one is the same failure
                // as a wrong number: the caller cannot tell it is incomplete.
                truncated: rows.length >= MAX_LIMIT,
                rows,
              },
              null,
              2
            )
          );
        } catch (dbErr) {
          // Almost always a column that isn't there — the caller asking for
          // data this database doesn't hold. Say that, rather than returning
          // an empty result that reads like a real answer of "none".
          return fail(
            `The query was valid but failed to run: ${dbErr.message}. Check get_schema — this database has no awards, salary, draft, biographical or three-point data.`
          );
        }
      }
    );

    this.server.registerTool(
      'get_schema',
      {
        title: 'Get the database schema',
        description:
          'Return the full schema of the LeBron James stats database — tables, columns, what the values mean, and an explicit list of what is NOT in it — plus current row counts and data provenance. Call this before writing a query with run_stat_query.',
        inputSchema: {},
        annotations: READ_ONLY,
      },
      async () => {
        const [counts, meta] = await Promise.all([
          this.env.DB.prepare(
            'SELECT COUNT(*) AS games, COUNT(DISTINCT season) AS seasons FROM games'
          )
            .first()
            .catch(() => null),
          provenance(this.env),
        ]);

        return text(
          JSON.stringify(
            {
              dialect: 'SQLite (Cloudflare D1)',
              schema: SCHEMA,
              contents: counts
                ? `${counts.games} games across ${counts.seasons} seasons, regular season and playoffs. Complete, not a sample.`
                : 'Row counts unavailable.',
              provenance: meta,
              constraints: [
                'Read-only. Single SELECT or WITH...SELECT per call.',
                `Results are capped at ${MAX_LIMIT} rows; a LIMIT larger than that is lowered.`,
                'Team and opponent are 3-letter uppercase codes. "against X" means opponent = \'X\'.',
                'fg_pct is a decimal proportion (0.417 = 41.7%), and is OVERALL field-goal percentage — there is no three-point data of any kind.',
              ],
            },
            null,
            2
          )
        );
      }
    );

    this.server.registerTool(
      'get_season_averages',
      {
        title: 'Get per-season averages',
        description:
          "Return LeBron James's per-season averages — team, age, games played, points/rebounds/assists per game, and field-goal percentage — for one season or all of them. Free and unmetered. A convenience wrapper over the seasons table for when you don't want to write SQL.",
        inputSchema: {
          season: z
            .string()
            .regex(/^\d{4}-\d{2}$/, 'Seasons look like "2012-13".')
            .optional()
            .describe('A single season, e.g. "2012-13". Omit for every season, oldest first.'),
        },
        annotations: READ_ONLY,
      },
      async ({ season }) => {
        try {
          const stmt = season
            ? this.env.DB.prepare('SELECT * FROM seasons WHERE season = ? ORDER BY season').bind(season)
            : this.env.DB.prepare('SELECT * FROM seasons ORDER BY season');
          const rows = (await stmt.all()).results ?? [];

          if (season && rows.length === 0) {
            return fail(
              `No season "${season}" in the database. Call get_season_averages with no argument to see which seasons exist.`
            );
          }

          return text(JSON.stringify({ row_count: rows.length, seasons: rows }, null, 2));
        } catch (dbErr) {
          console.error('mcp get_season_averages failed', dbErr);
          return fail('Could not read the seasons table.');
        }
      }
    );
  }
}
