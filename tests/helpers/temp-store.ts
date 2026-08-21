/**
 * Temp-directory LocalStore fixtures.
 *
 * Windows cannot unlink an open file. A test that opens a LocalStore (bun:sqlite)
 * in a temp dir and then rmSync's that dir without closing the handle passes on
 * Linux/macOS and fails on Windows with
 *
 *   error: EBUSY: resource busy or locked, rm 'C:\...\Temp\mcp-coord-XqTcna'
 *
 * which is how the windows-latest CI leg came to be red. Route the fixture
 * through here so the close-then-remove order is not something each new test file
 * has to remember.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { LocalStore } from '../../src/local-store';

const openStores: LocalStore[] = [];
const tempDirs: string[] = [];

export interface TempStore {
  store: LocalStore;
  dir: string;
  dbPath: string;
}

/** An initialised LocalStore in a fresh temp dir, both cleaned up by cleanupTempStores(). */
export function makeTempStore(prefix: string): TempStore {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  const dbPath = join(dir, 'sidecar.db');
  const store = new LocalStore(dbPath);
  store.init();
  openStores.push(store);
  return { store, dir, dbPath };
}

/**
 * Track a store the test opened itself — e.g. re-opening the same on-disk DB to
 * simulate a new session. close() is idempotent, so tracking a store the test also
 * closes explicitly is safe.
 */
export function trackStore<T extends LocalStore>(store: T): T {
  openStores.push(store);
  return store;
}

/** Close every tracked store, THEN remove the temp dirs. Call from afterEach. */
export function cleanupTempStores(): void {
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      // A test may have closed it already; the removal below is what matters.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    // retries: Windows can hold a lock briefly after close (indexer, AV scanner).
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
