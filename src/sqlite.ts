// Contract (behaviour): SPEC §runtime
/**
 * The local store's SQLite, under either runtime: `bun:sqlite` under Bun, `node:sqlite` (`DatabaseSync`, Node
 * 22.13 / 23.4 and later) under Node. One file and one schema, so a machine that runs the server under the other
 * runtime keeps its store.
 *
 * Only what the store uses is exposed: `exec`, `run(sql, params)`, and `query(sql)` with `all` and `get`. The two
 * backends differ in what they bind and return, and the adapter makes them agree: a boolean binds as 1 or 0 and
 * `undefined` as NULL (node:sqlite refuses both), and `get` returns `undefined` for no row (Bun returns `null`).
 */
import { createRequire } from 'node:module';

export type SqlValue = string | number | bigint | null | boolean | undefined | Uint8Array;

export interface Statement {
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
}

export interface Sqlite {
  exec(sql: string): void;
  run(sql: string, params?: SqlValue[]): void;
  query(sql: string): Statement;
  close(): void;
}

const require = createRequire(import.meta.url);

function bind(params: SqlValue[]): Array<string | number | bigint | null | Uint8Array> {
  return params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p === undefined ? null : p));
}

/**
 * Whether this runtime has a SQLite the store can open: Bun always; Node when `node:sqlite` loads. Read without
 * opening anything, so the launcher can decide where to run.
 */
export function sqliteAvailable(): boolean {
  if (process.versions.bun) return true;
  try {
    quietly(() => require('node:sqlite'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Node 22 prints an ExperimentalWarning the first time `node:sqlite` loads. stderr is the server's log channel and
 * the warning says nothing a user can act on, so that one warning is dropped; every other warning passes.
 */
function quietly<T>(load: () => T): T {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message ?? '';
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (/sqlite/i.test(text) && (type === 'ExperimentalWarning' || (warning as Error)?.name === 'ExperimentalWarning')) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return load();
  } finally {
    process.emitWarning = emit;
  }
}

/** Open (creating) the database at `path`. Throws when this runtime has no SQLite. */
export function openSqlite(path: string): Sqlite {
  if (process.versions.bun) {
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const db = new Database(path, { create: true });
    return {
      exec: (sql) => { db.exec(sql); },
      run: (sql, params = []) => { db.run(sql, bind(params) as never); },
      query: (sql) => {
        const st = db.query(sql);
        return {
          all: (...p) => st.all(...(bind(p) as never[])),
          get: (...p) => st.get(...(bind(p) as never[])) ?? undefined,
        };
      },
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = quietly(() => require('node:sqlite')) as { DatabaseSync: new (path: string) => NodeSqlite };
  const db = new DatabaseSync(path);
  return {
    exec: (sql) => { db.exec(sql); },
    run: (sql, params = []) => { db.prepare(sql).run(...bind(params)); },
    query: (sql) => {
      const st = db.prepare(sql);
      return {
        all: (...p) => st.all(...bind(p)),
        get: (...p) => st.get(...bind(p)) ?? undefined,
      };
    },
    close: () => db.close(),
  };
}

/** The part of node:sqlite's DatabaseSync the adapter uses (typed here, since @types/node may predate it). */
interface NodeSqlite {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}
