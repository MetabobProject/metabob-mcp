/**
 * The local store's SQLite adapter (SPEC §runtime): both runtimes' SQLite behind one interface, agreeing on what
 * binds and what comes back. The unit suite runs under Bun (bun:sqlite); the Node backend runs in
 * tests/workflows/w9-node-runtime.test.ts and the no-Bun package smoke.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite, sqliteAvailable } from '../../src/sqlite';

const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the SQLite adapter', () => {
  test('this runtime has a SQLite', () => {
    expect(sqliteAvailable()).toBe(true);
  });

  test('a boolean binds as 1 or 0, undefined as NULL, and get returns undefined for no row', () => {
    const db = openSqlite(join(dir, 'a.db'));
    db.exec('CREATE TABLE t (id TEXT, flag INTEGER, note TEXT)');
    db.run('INSERT INTO t VALUES (?, ?, ?)', ['a', true, undefined]);
    db.run('INSERT INTO t VALUES (?, ?, ?)', ['b', false, 'x']);
    expect(db.query('SELECT id, flag, note FROM t ORDER BY id').all()).toEqual([
      { id: 'a', flag: 1, note: null },
      { id: 'b', flag: 0, note: 'x' },
    ]);
    expect(db.query('SELECT id FROM t WHERE flag = ?').get(true)).toEqual({ id: 'a' });
    expect(db.query('SELECT id FROM t WHERE id = ?').get('missing')).toBeUndefined();
    db.close();
  });

  test('the file reopens with its rows, as a store does across launches', () => {
    const path = join(dir, 'b.db');
    const first = openSqlite(path);
    first.exec('CREATE TABLE t (v INTEGER)');
    first.run('INSERT INTO t VALUES (?)', [7]);
    first.close();
    const again = openSqlite(path);
    expect(again.query('SELECT v FROM t').all()).toEqual([{ v: 7 }]);
    again.close();
  });
});
