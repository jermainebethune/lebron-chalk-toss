/**
 * SQL guard.
 *
 * The model writes SQL. This decides whether that SQL is allowed to touch the
 * database. It is an allowlist, not a blocklist: the statement must positively
 * look like a single bounded read, or it is rejected.
 *
 * Blocklists fail here. "Reject anything containing DROP" is defeated by
 * comments, casing, and string literals, and it can only ever block the
 * attacks you thought of. So the order below matters:
 *
 *   1. strip anything that can hide syntax (comments, string literals)
 *   2. assert the skeleton that remains is a single SELECT
 *   3. only then look for specific forbidden constructs
 *
 * The D1 binding should ALSO be read-only in production. This is defence in
 * depth, not the only defence.
 */

const MAX_LIMIT = 100;
const MAX_LENGTH = 2000;

// Anything that mutates, attaches, or reaches outside a plain read.
const FORBIDDEN = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE',
  'REPLACE', 'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'ANALYZE',
  'GRANT', 'REVOKE', 'LOAD_EXTENSION', 'RETURNING',
];

export class SqlRejected extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SqlRejected';
  }
}

/**
 * Remove comments and string literals so they can't smuggle syntax past the
 * checks below. Literals become empty strings, which keeps the statement
 * structurally intact ('BOS' -> '') without leaving their contents scannable.
 */
function skeleton(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')           // -- line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* block comments */
    .replace(/'(?:[^']|'')*'/g, "''")    // 'string literals', SQL-escaped '' included
    .replace(/"(?:[^"]|"")*"/g, '""')    // "quoted identifiers"
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip a markdown fence if the model wrapped its answer in one. Small models
 * do this constantly no matter how the prompt is worded, so handle it rather
 * than fight it.
 */
export function unfence(raw) {
  const fenced = raw.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : raw).trim();
}

/**
 * Validate and normalize model-authored SQL.
 * Returns the statement to run. Throws SqlRejected if it isn't safe.
 */
export function guard(raw) {
  if (!raw || !raw.trim()) {
    throw new SqlRejected('The model returned nothing.');
  }

  let sql = unfence(raw).replace(/;\s*$/, '').trim();

  if (sql.length > MAX_LENGTH) {
    throw new SqlRejected('Query is implausibly long.');
  }

  const bare = skeleton(sql);
  const upper = bare.toUpperCase();

  // 1. Single statement. After stripping the one trailing semicolon above,
  //    any semicolon left is a second statement trying to ride along.
  if (bare.includes(';')) {
    throw new SqlRejected('Only one statement per question is allowed.');
  }

  // 2. Must be a read. WITH is allowed because CTEs are genuinely useful for
  //    "best season by X" questions, but it still has to reach a SELECT.
  if (!/^(SELECT|WITH)\b/.test(upper)) {
    throw new SqlRejected('Only SELECT statements can be run.');
  }
  if (!/\bSELECT\b/.test(upper)) {
    throw new SqlRejected('Statement never selects anything.');
  }

  // 3. No mutating or environment-reaching keywords anywhere in the skeleton.
  for (const word of FORBIDDEN) {
    if (new RegExp(`\\b${word}\\b`).test(upper)) {
      throw new SqlRejected(`"${word}" is not permitted in a question.`);
    }
  }

  // 4. Bound the result set ourselves. A model-supplied LIMIT is respected
  //    only if it's smaller than ours — we never trust it to be the ceiling.
  const existing = upper.match(/\bLIMIT\s+(\d+)\s*$/);
  if (existing) {
    if (Number(existing[1]) > MAX_LIMIT) {
      sql = sql.replace(/\bLIMIT\s+\d+\s*$/i, `LIMIT ${MAX_LIMIT}`);
    }
  } else {
    sql = `${sql} LIMIT ${MAX_LIMIT}`;
  }

  return sql;
}
