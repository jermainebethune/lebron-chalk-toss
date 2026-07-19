#!/usr/bin/env node
/**
 * Runs the answer key against the live app.
 *
 *   npm run eval                 every case
 *   npm run eval -- --regression only the cases that are shipped bugs
 *   npm run eval -- --only blocks-tie,career-high
 *
 * For each case: run OUR query against D1 to get the truth, ask the APP the
 * question in English, and compare the two result sets. We compare answers,
 * not SQL text — there are many correct ways to write the same query.
 *
 * Every case is a real inference (~33 Neurons for the SQL call), so a full run
 * is roughly 6% of the daily free allowance. Run it when something changes,
 * not on every save.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cases } from './cases.js';

const exec = promisify(execFile);

const API = process.env.ORACLE_API || 'https://chalk-toss.jermaine-e7a.workers.dev';
const DB = 'lebron-oracle';

const KEY = (() => {
  if (process.env.ORACLE_API_KEY) return process.env.ORACLE_API_KEY;
  try {
    return readFileSync(join(homedir(), '.chalk_toss_api_key'), 'utf8').trim();
  } catch {
    console.error('No API key. Set ORACLE_API_KEY or write it to ~/.chalk_toss_api_key');
    process.exit(2);
  }
})();

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

/** Ground truth: our own query, straight against D1. */
async function truthOf(sql) {
  const { stdout } = await exec('npx', [
    'wrangler', 'd1', 'execute', DB, '--remote', '--command', sql, '--json',
  ], { maxBuffer: 1024 * 1024 * 16 });
  const parsed = JSON.parse(stdout);
  return parsed[0]?.results ?? [];
}

/** What the app actually answers. */
async function askApp(question) {
  const res = await fetch(`${API}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ question, skipCache: true }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`HTTP ${res.status}: ${body.error ?? 'no detail'}`);
  }
  return res.json();
}

const norm = (v) => (v === null || v === undefined ? null : typeof v === 'number' ? v : String(v));
const multiset = (rows, col) => rows.map((r) => norm(r[col])).sort();
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Do these two result sets say the same thing?
 *
 * The model often selects MORE columns than our truth query (date + opponent +
 * points where we asked for date + points). That is fine — extra context is
 * not an error. So we require the row COUNT to match, and every column our
 * truth query selected to be present and equal.
 *
 * Aggregates are the exception: `SELECT MAX(points)` and
 * `SELECT MAX(points) AS career_high` are the same answer under different
 * column names, so a single-cell truth is compared by value alone.
 */
function compare(truth, actual) {
  if (truth.length === 1 && Object.keys(truth[0]).length === 1) {
    const want = norm(Object.values(truth[0])[0]);
    const got = actual.flatMap((r) => Object.values(r).map(norm));
    return got.includes(want)
      ? { ok: true }
      : { ok: false, why: `expected the value ${want}, model returned ${JSON.stringify(got.slice(0, 6))}` };
  }

  if (truth.length !== actual.length) {
    return { ok: false, why: `expected ${truth.length} rows, model returned ${actual.length}` };
  }
  if (truth.length === 0) return { ok: true };

  const truthCols = Object.keys(truth[0]);
  const actualCols = new Set(Object.keys(actual[0] ?? {}));
  const shared = truthCols.filter((c) => actualCols.has(c));

  if (shared.length === 0) {
    return {
      ok: false,
      why: `no shared columns — wanted [${truthCols}], model returned [${[...actualCols]}]`,
    };
  }
  for (const col of shared) {
    if (!same(multiset(truth, col), multiset(actual, col))) {
      return { ok: false, why: `column "${col}" differs` };
    }
  }
  return { ok: true };
}

async function runCase(c) {
  const res = await askApp(c.ask);
  const refused = res.sql === null;

  if (c.refuses) {
    return refused
      ? { ok: true, detail: 'refused' }
      : { ok: false, why: `should have refused, but ran: ${res.sql}`, sql: res.sql };
  }
  if (refused) {
    return { ok: false, why: 'refused a question it should be able to answer' };
  }

  // A capped result must say so. Silently returning the first N of many is
  // indistinguishable from a complete answer, which is its own kind of wrong.
  if (c.truncates) {
    if (!res.truncated) {
      return { ok: false, why: `expected a capped result, but truncated was ${res.truncated}`, sql: res.sql };
    }
    if (!/showing the first|more\b/i.test(res.answer)) {
      return { ok: false, why: `result was capped but the answer does not admit it: "${res.answer.slice(0, 90)}"`, sql: res.sql };
    }
    return { ok: true, detail: `capped at ${res.rows.length}, disclosed` };
  }

  if (c.sqlMatches && !c.sqlMatches.test(res.sql)) {
    return { ok: false, why: `SQL did not match ${c.sqlMatches}`, sql: res.sql };
  }

  // The prose must never deny results that exist — this failed 1 run in 3 once.
  if (res.rows.length > 0 && /\bno (matching|results|data|games)\b/i.test(res.answer)) {
    return { ok: false, why: `prose denies ${res.rows.length} rows that were returned`, sql: res.sql };
  }

  const truth = await truthOf(c.truth);
  const verdict = compare(truth, res.rows);
  return verdict.ok
    ? { ok: true, detail: `${res.rows.length} row${res.rows.length === 1 ? '' : 's'}` }
    : { ...verdict, sql: res.sql, truthSql: c.truth };
}

async function main() {
  const args = process.argv.slice(2);
  const onlyRegression = args.includes('--regression');
  const onlyArg = args.find((a) => a.startsWith('--only'));
  const ids = onlyArg ? (onlyArg.split('=')[1] ?? args[args.indexOf(onlyArg) + 1] ?? '').split(',') : null;

  let selected = cases;
  if (onlyRegression) selected = selected.filter((c) => c.tag === 'regression');
  if (ids && ids[0]) selected = selected.filter((c) => ids.includes(c.id));

  console.log(`\n${C.bold}Evaluating ${selected.length} cases against ${API}${C.reset}`);
  console.log(`${C.dim}~${Math.round(selected.length * 35.5)} Neurons, about ${Math.round((selected.length * 35.5 / 10000) * 100)}% of the daily free allowance${C.reset}\n`);

  const failures = [];
  for (const c of selected) {
    process.stdout.write(`  ${c.id.padEnd(26)}`);
    let r;
    try {
      r = await runCase(c);
    } catch (err) {
      r = { ok: false, why: err.message };
    }
    if (r.ok) {
      console.log(`${C.green}✓${C.reset} ${C.dim}${r.detail ?? ''}${C.reset}`);
    } else {
      console.log(`${C.red}✗${C.reset} ${r.why}`);
      failures.push({ c, r });
    }
  }

  const passed = selected.length - failures.length;
  const pct = selected.length ? Math.round((passed / selected.length) * 100) : 100;
  const colour = failures.length === 0 ? C.green : pct >= 80 ? C.yellow : C.red;
  console.log(`\n${colour}${C.bold}${passed}/${selected.length} passed (${pct}%)${C.reset}\n`);

  if (failures.length) {
    console.log(`${C.bold}Failures in detail${C.reset}\n`);
    for (const { c, r } of failures) {
      console.log(`${C.red}✗ ${c.id}${C.reset}  ${C.dim}${c.tag === 'regression' ? '(shipped bug — do not let this regress)' : ''}${C.reset}`);
      console.log(`  asked:  ${c.ask}`);
      console.log(`  why:    ${r.why}`);
      if (r.sql) console.log(`  ${C.cyan}model:${C.reset}  ${r.sql}`);
      if (r.truthSql) console.log(`  ${C.cyan}truth:${C.reset}  ${r.truthSql.replace(/\s+/g, ' ').trim()}`);
      if (c.note) console.log(`  ${C.dim}note:   ${c.note}${C.reset}`);
      console.log();
    }
  }

  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\neval harness itself failed:', err.message);
  process.exit(2);
});
