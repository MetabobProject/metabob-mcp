/**
 * Regression test for the LocalStore WAL-recovery guard (src/local-store.ts:130-139).
 *
 * THE BUG: init() deleted sidecar.db (+ -wal + -shm) whenever the -wal file was
 * zero bytes. A 0-byte -wal is an ordinary post-checkpoint state, so a perfectly
 * healthy store was destroyed on process launch — taking every agent-recorded
 * `agf_*` finding, the schedule queue, and the agent_tasks / agent_resolutions
 * rows whose entire reason to exist is surviving across sessions.
 *
 * The guard now requires BOTH halves of the documented corruption pattern:
 * `walSize === 0 && shmSize > 0`.
 *
 * THE DISCRIMINATORS are the two "benign 0-byte -wal ... survives" cases below
 * (-shm absent, and -shm present but empty). Under the old guard the -wal stat
 * alone decided, so both states unlinked all three files and the reopened store
 * came back empty. Do not weaken them: they are the only assertions here that
 * distinguish fixed code from broken code.
 *
 * Verified empirically, not assumed: the pre-fix LocalStore was extracted from
 * git HEAD into a scratch dir and driven through these exact fixture states —
 * both survive-cases returned null for the planted seed (i.e. this file goes red
 * on the old code), while the corrupt case cleared on both old and new.
 *
 * The remaining two cases (-wal absent, hot -wal) pass on the old code too. They
 * are coverage rounding, not discriminators, and are labelled as such.
 *
 * Assertions are on DATA (getSeedById), never on existsSync of -wal/-shm —
 * init() runs `PRAGMA journal_mode=WAL` and immediately recreates both files,
 * so file-presence assertions would be flaky by construction.
 *
 * Every sqlite handle is closed before any file is written or unlinked
 * (Windows/EBUSY — see tests/helpers/temp-store.ts).
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { writeFileSync, unlinkSync } from 'node:fs';

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
  test('DISCRIMINATOR — benign 0-byte -wal with -shm absent: the store survives with its data', () => {
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

  test('DISCRIMINATOR — benign 0-byte -wal AND 0-byte -shm: the store survives with its data', () => {
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

  test('genuinely corrupt 0-byte -wal + non-empty -shm: the store is cleared and remains usable', () => {
    const { store, dbPath } = makeTempStore('mcp-wal-guard-');
    plantSeed(store, SURVIVOR_ID);
    store.close();

    // The documented unopenable pattern left by an abrupt process kill.
    writeFileSync(dbPath + '-wal', '');
    writeFileSync(dbPath + '-shm', Buffer.alloc(32768));

    const reopened = trackStore(new LocalStore(dbPath));
    reopened.init();

    // Recovery still recovers: the old rows are gone...
    expect(reopened.getSeedById(SURVIVOR_ID)).toBeNull();
    // ...and the fresh database is fully usable.
    plantSeed(reopened, 'agf_after_recovery');
    expect(reopened.getSeedById('agf_after_recovery')).not.toBeNull();
  });

  // Coverage rounding: passes on the old code too (statSync throws → catch).
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
