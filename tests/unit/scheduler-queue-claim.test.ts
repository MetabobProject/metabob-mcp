/**
 * Regression: a queued file must be SENT ONCE, not once per 2s tick.
 *
 * `dequeue()` selects `WHERE processing = 0` but nothing ever writes 1, and the
 * row is deleted only after the send completes — so a 7s analysis against a 2s
 * tick re-selected the identical row and POSTed the same bundle three times
 * (duplicated billed work, duplicated telemetry, duplicated seeds).
 *
 * The two cases are deliberately different mechanisms: overlapping ticks, and
 * `stop()`'s drainP0 — which does not go through tick() at all, so it is the
 * case that a re-entrancy guard alone cannot satisfy.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../../src/local-store.js';
import { Scheduler } from '../../src/scheduler.js';
import type { Telemetry } from '../../src/telemetry.js';

const cleanups: Array<() => void> = [];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Harness {
  scheduler: Scheduler;
  /** One entry per POST to /v2/mcp/analysis/run. */
  sends: string[];
  /** Lets the in-flight send finish. */
  release: () => void;
  store: LocalStore;
  file: string;
  /** The workspace the store partitions on — queue reads are scoped to it. */
  ws: string;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'sched-claim-'));
  const file = join(dir, 'target.ts');
  writeFileSync(file, 'export const x = 1;\n');

  const store = new LocalStore(join(dir, 'sidecar.db'));
  store.init();
  store.setWorkspaceScope(dir); // queue reads are partitioned by workspace
  const ws = store.workspaceScope().id;

  const sends: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    sends.push(String(url));
    await gate; // the send is slow — this is the whole point
    return new Response(JSON.stringify({ seeds: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const telemetry = { record: () => {} } as unknown as Telemetry;
  const scheduler = new Scheduler(store, ws, 'http://analysis.invalid', 'k', telemetry, dir);

  cleanups.push(() => {
    globalThis.fetch = realFetch;
    release();
    store.close();            // close the sqlite handle before rm — Windows EBUSY
    rmSync(dir, { recursive: true, force: true });
  });

  return { scheduler, sends, release, store, file, ws };
}

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

// tick() is what the 2s interval calls; driving it directly is the only way to
// exercise the overlap without waiting on real 2s timers.
const tick = (s: Scheduler): Promise<void> => (s as unknown as { tick(): Promise<void> }).tick();

test('overlapping ticks send a queued file once, not once per tick', async () => {
  const h = harness();
  h.store.enqueue(h.file, 0, h.ws);

  const first = tick(h.scheduler);
  await sleep(10);
  const second = tick(h.scheduler);
  await sleep(10);
  const third = tick(h.scheduler);
  await sleep(10);

  expect(h.sends.length).toBe(1);

  h.release();
  await Promise.all([first, second, third]);
  await sleep(10);

  // Still one after everything settles, and the row is gone.
  expect(h.sends.length).toBe(1);
  expect(h.store.dequeue(10).length).toBe(0);
});

test('shutdown drain does not re-send a file whose send is still in flight', async () => {
  const h = harness();
  h.store.enqueue(h.file, 0, h.ws);

  const inFlight = tick(h.scheduler);
  await sleep(10);
  expect(h.sends.length).toBe(1);

  // stop() flushes P0 best-effort. It bypasses tick(), so only a real claim on
  // the row keeps it from being sent a second time.
  h.scheduler.stop();
  await sleep(20);

  expect(h.sends.length).toBe(1);

  h.release();
  await inFlight;
  await sleep(20);
  expect(h.sends.length).toBe(1);
});

test('a second, distinct file is still sent — the claim is per row', async () => {
  const h = harness();
  const other = h.file.replace('target.ts', 'other.ts');
  writeFileSync(other, 'export const y = 2;\n');
  h.store.enqueue(h.file, 0, h.ws);
  h.store.enqueue(other, 0, h.ws);

  h.release(); // sends complete immediately; tick processes the batch serially
  await tick(h.scheduler);

  // Anti-cheat: "claim every row forever" would pass the cases above.
  expect(h.sends.length).toBe(2);
  expect(h.store.dequeue(10).length).toBe(0);

  // And a claim released on completion must not block a later re-enqueue.
  h.store.enqueue(h.file, 0, h.ws);
  await tick(h.scheduler);
  expect(h.sends.length).toBe(3);
});
