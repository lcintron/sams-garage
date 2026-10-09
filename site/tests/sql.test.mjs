import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyQuery, stripSql, isSqliteFile, runQuery, EXAMPLES } from '../js/sql.js';

const ok = sql => assert.equal(isReadOnlyQuery(sql).ok, true, sql);
const no = sql => assert.equal(isReadOnlyQuery(sql).ok, false, sql);

test('read statements are allowed', () => {
  ok('SELECT * FROM solicitations');
  ok('  select id from solicitations; ');
  ok('WITH x AS (SELECT 1) SELECT * FROM x');
  ok('EXPLAIN QUERY PLAN SELECT * FROM solicitations');
  ok('VALUES (1), (2)');
  ok('(SELECT 1)');
  ok("SELECT replace(title, 'a', 'b'), release_date FROM solicitations WHERE status = 'update; delete'");
  ok('SELECT * FROM pragma_table_info(\'solicitations\')');
  ok('-- comment\nSELECT 1 /* drop table x */');
  for (const e of EXAMPLES) ok(e.sql);
});

test('writes and multi-statements are rejected', () => {
  no('DELETE FROM solicitations');
  no('drop table solicitations');
  no('INSERT INTO keywords VALUES (1, 2)');
  no('UPDATE solicitations SET title = 1');
  no('SELECT 1; DELETE FROM solicitations');
  no('WITH x AS (SELECT 1) DELETE FROM solicitations');
  no('WITH x AS (SELECT 1) INSERT INTO keywords SELECT * FROM x');
  no('ATTACH DATABASE \'x\' AS y');
  no('PRAGMA query_only = OFF');
  no('SELECT 1 FROM x; PRAGMA writable_schema = 1');
  no('CREATE TABLE t (a)');
  no('');
  no('   ;  ');
  no('BEGIN; SELECT 1');
});

test('stripSql blanks literals and comments', () => {
  assert.equal(stripSql("select 'a;b' -- x\n").trim(), "select ''");
  assert.equal(stripSql('select "we""ird" from [t;x]'), 'select "" from ""');
});

test('isSqliteFile checks the header', () => {
  const good = new Uint8Array(200);
  good.set(new TextEncoder().encode('SQLite format 3'), 0);
  assert.equal(isSqliteFile(good), true);
  assert.equal(isSqliteFile(new TextEncoder().encode('<!doctype html>' + ' '.repeat(200))), false);
  assert.equal(isSqliteFile(new Uint8Array(10)), false);
});

test('runQuery caps rows and refuses writes before touching the db', () => {
  let freed = false;
  let n = 0;
  const fakeDb = {
    prepare: () => ({
      getColumnNames: () => ['n'],
      step: () => n++ < 5,
      get: () => [n],
      free: () => { freed = true; }
    })
  };
  const res = runQuery(fakeDb, 'SELECT n FROM t', 3, () => 0);
  assert.deepEqual(res.columns, ['n']);
  assert.equal(res.rows.length, 3);
  assert.equal(res.truncated, true);
  assert.equal(freed, true);
  assert.throws(() => runQuery({ prepare: () => { throw new Error('should not run'); } }, 'DROP TABLE t'), /Read-only/);
});
