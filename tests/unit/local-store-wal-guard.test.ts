/**
 * The local store survives every state SQLite can read (src/local-store.ts@store-open): it is judged by whether
 * SQLite can read it, never by the sizes of its -wal and -shm side files. A zero-byte -wal beside a non-empty -shm
 * is how macOS's SQLite leaves a healthy store after a clean close, so a size rule would delete the store, with
 * every recorded finding and queued task, on each launch there. Only a store SQLite cannot read is set aside,
 * renamed rather than deleted, and the store starts fresh.
 *
 * Assertions are on data (getSeedById), never on the side files' presence: opening in WAL mode recreates them.
 * Every handle is closed before a file is written or moved (Windows/EBUSY, tests/helpers/temp-store.ts).
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { LocalStore } from '../../src/local-store';
import { makeTempStore, trackStore, cleanupTempStores } from '../helpers/temp-store';

afterEach(cleanupTempStores);

const SURVIVOR_ID = 'agf_survivor';

function plantSeed(store: LocalStore, id: string): void {
  store.upsertSeed({
    id,
    workspace_id: 'ws-wal-guard',
    file_path: 'src/local-store.ts',
    line_start: 124,
    line_end: 139,
    category: 'data-loss',
    severity: 'CRITICAL',
    brief: 'planted by the WAL-guard regression test',
    confidence: 0.9,
    refs_json: '[]',
    produced_at: Date.now(),
    stale: false,
  });
}

/** Remove a sidecar sidecar-file if present. Caller must have closed the store. */
function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

describe('LocalStore.init() WAL recovery guard', () => {
  test('benign 0-byte -wal with -shm absent: the store survives with its data', () => {
    const { store, dbPath } = makeTempStore('mcp-wal-guard-');
    plantSeed(store, SURVIVOR_ID);
    expect(store.getSeedById(SURVIVOR_ID)).not.toBeNull();
    store.close();

    // Post-checkpoint shape: an empty WAL, no shared-memory file at all.
    writeFileSync(dbPath + '-wal', '');
    removeIfPresent(dbPath + '-shm');

    const reopened = trackStore(new LocalStore(dbPath));
    reopened.init();

    const seed = reopened.getSeedById(SURVIVOR_ID);
    expect(seed).not.toBeNull();
    expect(seed?.brief).toBe('planted by the WAL-guard regression test');
  });

  test('benign 0-byte -wal AND 0-byte -shm: the store survives with its data', () => {
    const { store, dbPath } = makeTempStore('mcp-wal-guard-');
    plantSeed(store, SURVIVOR_ID);
    store.close();

    // Both sidecar files present but empty. `walSize === 0` alone matches here,
    // so the pre-fix guard wiped the database; the corrected guard does not,
    // because -shm is not non-empty.
    writeFileSync(dbPath + '-wal', '');
    writeFileSync(dbPath + '-shm', '');

    const reopened = trackStore(new LocalStore(dbPath));
    reopened.init();

    expect(reopened.getSeedById(SURVIVOR_ID)).not.toBeNull();
  });

  test('0-byte -wal beside a non-empty -shm (macOS after a clean close): the store survives with its data', () => {
    const { store, dbPath } = makeTempStore('mcp-wal-guard-');
    plantSeed(store, SURVIVOR_ID);
    store.close();

    writeFileSync(dbPath + '-wal', '');
    writeFileSync(dbPath + '-shm', Buffer.alloc(32768));

    const reopened = trackStore(new LocalStore(dbPath));
    reopened.init();
    expect(reopened.getSeedById(SURVIVOR_ID)).not.toBeNull();
    reopened.close();
  });

  test('a store SQLite cannot read is moved aside, not deleted, and a new store starts', () => {
    const { store, dbPath } = makeTempStore('mcp-wal-guard-');
    store.close();
    writeFileSync(dbPath, 'this is not a sqlite database, it is a text file of the wrong kind\n'.repeat(200));
    removeIfPresent(dbPath + '-wal');
    removeIfPresent(dbPath + '-shm');

    const reopened = trackStore(new LocalStore(dbPath));
    reopened.init();
    plantSeed(reopened, 'agf_after_recovery');
    expect(reopened.getSeedById('agf_after_recovery')).not.toBeNull();
    reopened.close();
    const aside = readdirSync(dirname(dbPath)).filter(f => f.startsWith(`${basename(dbPath)}.unreadable-`));
    expect(aside.length).toBe(1);
    expect(readFileSync(join(dirname(dbPath), aside[0]!), 'utf8')).toContain('not a sqlite database');
  });

  test('an error that is not corruption is raised with the store left where it is', () => {
    // A path SQLite cannot open (a directory): "unable to open database file", never "not a database".
    const dir = mkdtempSync(join(tmpdir(), 'mcp-store-cantopen-'));
    const dbPath = join(dir, 'sidecar.db');
    mkdirSync(dbPath);
    expect(() => new LocalStore(dbPath).init()).toThrow(/unable to open database file/);
    expect(readdirSync(dir)).toEqual(['sidecar.db']);
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a healthy store in a directory that went read-only is raised, never moved aside', () => {
    const { store, dbPath } = makeTempStore('mcp-wal-guard-');
    plantSeed(store, SURVIVOR_ID);
    store.close();
    removeIfPresent(dbPath + '-wal');
    removeIfPresent(dbPath + '-shm');
    chmodSync(dirname(dbPath), 0o500);
    try {
      expect(() => new LocalStore(dbPath).init()).toThrow();
      expect(readdirSync(dirname(dbPath)).some(f => f.includes('.unreadable-'))).toBe(false);
    } finally {
      chmodSync(dirname(dbPath), 0o700);
    }
    const reopened = trackStore(new LocalStore(dbPath));
    reopened.init();
    expect(reopened.getSeedById(SURVIVOR_ID)).not.toBeNull();
    reopened.close();
  });

  test('a store another server replaced before the retry is used, not moved aside', () => {
    const { store, dbPath } = makeTempStore('mcp-wal-guard-');
    store.close();
    writeFileSync(dbPath, 'not a database\n'.repeat(400));
    removeIfPresent(dbPath + '-wal');
    removeIfPresent(dbPath + '-shm');
    const racing = trackStore(new LocalStore(dbPath)) as LocalStore & { openReadable(): unknown };
    const real = racing.openReadable.bind(racing);
    let calls = 0;
    racing.openReadable = () => {
      calls++;
      if (calls > 1) return real();
      try {
        return real();
      } finally {
        // Between this server's failed open and its retry, the server beside it set the file aside and started a store.
        unlinkSync(dbPath);
        const other = new LocalStore(dbPath);
        other.init();
        plantSeed(other, 'agf_from_the_other_server');
        other.close();
      }
    };
    racing.init();
    expect(racing.getSeedById('agf_from_the_other_server')).not.toBeNull();
    expect(readdirSync(dirname(dbPath)).some(f => f.includes('.unreadable-'))).toBe(false);
    racing.close();
  });

  test('no -wal file at all: the store survives with its data', () => {
    const { store, dbPath } = makeTempStore('mcp-wal-guard-');
    plantSeed(store, SURVIVOR_ID);
    store.close();

    removeIfPresent(dbPath + '-wal');
    removeIfPresent(dbPath + '-shm');

    const reopened = trackStore(new LocalStore(dbPath));
    reopened.init();

    expect(reopened.getSeedById(SURVIVOR_ID)).not.toBeNull();
  });

  // Coverage rounding: passes on the old code too (walSize !== 0).
  test('hot WAL — non-empty -wal and non-empty -shm: the store survives with its data', () => {
    const { store, dbPath } = makeTempStore('mcp-wal-guard-');
    plantSeed(store, SURVIVOR_ID);
    store.close();

    // The normal state of a running process. Neither half of the corruption
    // pattern holds, so nothing may be deleted.
    writeFileSync(dbPath + '-wal', Buffer.alloc(4096));
    writeFileSync(dbPath + '-shm', Buffer.alloc(32768));

    const reopened = trackStore(new LocalStore(dbPath));
    reopened.init();

    expect(reopened.getSeedById(SURVIVOR_ID)).not.toBeNull();
  });
});
