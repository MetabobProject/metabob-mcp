import { describe, expect, test } from 'bun:test';
import { runGoalPollDelayMs } from '../../src/tools/run-goal.js';

describe('run_goal polls goalWalkState gently', () => {
  test('three quick polls, then doubling to the ceiling', () => {
    const delays = Array.from({ length: 8 }, (_, n) => runGoalPollDelayMs(n, 2_000, 15_000));
    expect(delays).toEqual([2_000, 2_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
  });

  test('a full 290 s wait makes about two dozen reads, not ~145', () => {
    let elapsed = 0;
    let reads = 0;
    for (let n = 0; elapsed < 290_000; n++) { reads++; elapsed += runGoalPollDelayMs(n, 2_000, 15_000); }
    expect(reads).toBeLessThan(25);
  });
});
