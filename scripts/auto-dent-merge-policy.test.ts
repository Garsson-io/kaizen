import { describe, expect, it } from 'vitest';
import { autoMergeBlockReasons, decideAutoMergeSafety } from './auto-dent-merge-policy.js';

describe('auto-dent merge policy (#1220)', () => {
  it('allows a PR only when required review passed and no hard process/lifecycle verdict failed', () => {
    expect(
      decideAutoMergeSafety({
        prCount: 1,
        reviewRequired: true,
        reviewVerdict: 'pass',
        processVerdict: 'pass',
        lifecycleHealth: 'clean',
      }),
    ).toEqual({ allow: true, reasons: [] });
  });

  it.each([
    ['review FAIL', { reviewVerdict: 'fail' as const }, 'review verdict fail'],
    ['review skipped', { reviewVerdict: 'skipped' as const }, 'review verdict skipped'],
    ['review missing', { reviewVerdict: undefined }, 'review verdict missing'],
    ['process incomplete', { processVerdict: 'process-incomplete' as const }, 'process verdict process-incomplete'],
    ['critical lifecycle', { lifecycleHealth: 'critical' as const }, 'lifecycle health critical'],
  ])('blocks auto-merge on %s', (_name, patch, reason) => {
    expect(
      autoMergeBlockReasons({
        prCount: 1,
        reviewRequired: true,
        reviewVerdict: 'pass',
        processVerdict: 'pass',
        lifecycleHealth: 'clean',
        ...patch,
      }),
    ).toContain(reason);
  });

  it('does not block non-PR runs', () => {
    expect(
      decideAutoMergeSafety({
        prCount: 0,
        reviewRequired: true,
        reviewVerdict: 'skipped',
        processVerdict: 'process-incomplete',
        lifecycleHealth: 'critical',
      }),
    ).toEqual({ allow: true, reasons: [] });
  });

  it('allows synthetic non-review runs unless a hard fail was observed', () => {
    expect(
      decideAutoMergeSafety({
        prCount: 1,
        reviewRequired: false,
        reviewVerdict: 'skipped',
        processVerdict: 'pass',
        lifecycleHealth: 'clean',
      }).allow,
    ).toBe(true);

    expect(
      decideAutoMergeSafety({
        prCount: 1,
        reviewRequired: false,
        reviewVerdict: 'fail',
        processVerdict: 'pass',
        lifecycleHealth: 'clean',
      }).allow,
    ).toBe(false);
  });
});
