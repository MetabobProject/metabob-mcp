import { describe, expect, test } from 'bun:test';

import {
  computeAdvertisedShapes,
  startPresenceAdvertiser,
} from '../../src/presence-advertiser';

describe('computeAdvertisedShapes', () => {
  test('un-indexed → only always-serviceable shapes', () => {
    const s = computeAdvertisedShapes(false);
    expect(s).toContain('mcp:tool_call');
    expect(s).toContain('code:analysis_context');
    expect(s).not.toContain('code:cochange_prediction');
    expect(s).not.toContain('code:impact_analysis');
    expect(s).not.toContain('code:git_change_assignment');
  });

  test('indexed → adds the CPG-dependent shapes', () => {
    const s = computeAdvertisedShapes(true);
    expect(s).toContain('code:cochange_prediction');
    expect(s).toContain('code:impact_analysis');
    expect(s).toContain('code:git_change_assignment');
    expect(s).toContain('mcp:tool_call');
    expect(s.length).toBe(5);
  });

  test('deterministic output (stable for change-detection)', () => {
    expect(computeAdvertisedShapes(true)).toEqual(computeAdvertisedShapes(true));
    expect(computeAdvertisedShapes(false)).toEqual(computeAdvertisedShapes(false));
  });
});

describe('startPresenceAdvertiser', () => {
  test('re-advertises the computed set as capability changes', async () => {
    const calls: string[][] = [];
    let indexed = false;
    const stop = startPresenceAdvertiser({
      heartbeat: {
        async setShapes(shapes: string[]) {
          calls.push(shapes);
        },
      },
      isIndexed: () => indexed,
      intervalMs: 5,
    });

    await new Promise((r) => setTimeout(r, 20)); // un-indexed ticks
    indexed = true;
    await new Promise((r) => setTimeout(r, 20)); // indexed ticks
    stop();

    // setShapes was called with the un-indexed set, then the indexed set.
    expect(calls.some((c) => !c.includes('code:cochange_prediction'))).toBe(true);
    expect(calls.some((c) => c.includes('code:cochange_prediction'))).toBe(true);
  });

  test('stop() halts further re-advertisement', async () => {
    let count = 0;
    const stop = startPresenceAdvertiser({
      heartbeat: {
        async setShapes() {
          count += 1;
        },
      },
      isIndexed: () => false,
      intervalMs: 5,
    });
    await new Promise((r) => setTimeout(r, 15));
    stop();
    const after = count;
    await new Promise((r) => setTimeout(r, 20));
    expect(count).toBe(after);
  });
});
