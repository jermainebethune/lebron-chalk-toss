import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guard, unfence, SqlRejected } from '../src/guard.js';

const rejects = (sql, why) =>
  assert.throws(() => guard(sql), SqlRejected, why ?? `should reject: ${sql}`);

test('allows a plain SELECT and adds a LIMIT', () => {
  const out = guard("SELECT date, points FROM games WHERE opponent = 'BOS'");
  assert.match(out, /LIMIT 100$/);
});

test('allows a CTE that reaches a SELECT', () => {
  const out = guard('WITH best AS (SELECT * FROM seasons) SELECT * FROM best');
  assert.match(out, /^WITH best/);
});

test('strips a markdown fence', () => {
  assert.equal(unfence('```sql\nSELECT 1\n```'), 'SELECT 1');
  assert.match(guard('```sql\nSELECT * FROM games\n```'), /^SELECT \* FROM games/);
});

test('tolerates a trailing semicolon', () => {
  assert.match(guard('SELECT * FROM games;'), /^SELECT \* FROM games/);
});

test('blocks stacked statements', () => {
  rejects('SELECT 1; DROP TABLE games');
  rejects('SELECT 1; DELETE FROM games;');
});

test('blocks every mutating verb', () => {
  rejects('DROP TABLE games');
  rejects('DELETE FROM games');
  rejects("UPDATE games SET points = 100");
  rejects("INSERT INTO games VALUES (1)");
  rejects('ALTER TABLE games ADD COLUMN x TEXT');
  rejects('CREATE TABLE evil (a TEXT)');
  rejects('PRAGMA table_info(games)');
  rejects("ATTACH DATABASE 'x.db' AS x");
  rejects('VACUUM');
});

test('is not fooled by casing or whitespace', () => {
  rejects('  dRoP   TaBlE   games  ');
  rejects('select 1; drop table games');
});

test('is not fooled by a comment hiding the mutation', () => {
  rejects('SELECT 1 /* comment */ ; DROP TABLE games');
  rejects('SELECT 1 --\n; DROP TABLE games');
});

test('does not false-positive on forbidden words inside string literals', () => {
  // 'Update' here is data, not a verb — the skeleton pass blanks literals first.
  const out = guard("SELECT * FROM games WHERE note = 'Roster update'");
  assert.match(out, /Roster update/);
});

test('does not false-positive on a column named like a keyword', () => {
  const out = guard('SELECT "create" FROM games');
  assert.ok(out.startsWith('SELECT'));
});

test('caps an oversized model-supplied LIMIT', () => {
  assert.match(guard('SELECT * FROM games LIMIT 99999'), /LIMIT 100$/);
});

test('respects a smaller model-supplied LIMIT', () => {
  assert.match(guard('SELECT * FROM games LIMIT 5'), /LIMIT 5$/);
});

test('rejects non-SELECT leading keywords', () => {
  rejects('EXPLAIN SELECT * FROM games');
  rejects('SELCT * FROM games');
});

test('rejects empty and absurd input', () => {
  rejects('');
  rejects('   ');
  rejects('SELECT ' + 'x'.repeat(3000));
});

test('rejects RETURNING, which can mutate under a SELECT-looking shape', () => {
  rejects("SELECT * FROM games WHERE id IN (DELETE FROM games RETURNING id)");
});
