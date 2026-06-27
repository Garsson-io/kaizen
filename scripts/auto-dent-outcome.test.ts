/**
 * Tests for deriveRunOutcome — the #1224/#1227 verdict→outcome binding.
 *
 * Adversarial intent: prove a red run can NEVER stamp `outcome:success`, using
 * the exact event shape that let PR #1212 land (success + review fail +
 * process-incomplete + degraded). And prove the binding does NOT over-fire:
 * a clean run, and a `skipped` review, must stay success.
 */

import { describe, it, expect } from 'vitest';
import { deriveRunOutcome, hasRedVerdict } from './auto-dent-outcome.js';

describe('deriveRunOutcome — verdict binding (#1224)', () => {
  it('downgrades success→failure on the exact #1212 evidence shape', () => {
    // run-2: outcome:success, review_verdict:fail, process_verdict:process-incomplete, lifecycle:degraded
    expect(
      deriveRunOutcome('success', {
        reviewVerdict: 'fail',
        processVerdict: 'process-incomplete',
        lifecycleHealth: 'degraded',
      }),
    ).toBe('failure');
  });

  it('downgrades success→failure when only review verdict is fail', () => {
    expect(deriveRunOutcome('success', { reviewVerdict: 'fail' })).toBe('failure');
  });

  it('downgrades success→failure when process verdict is process-incomplete', () => {
    expect(deriveRunOutcome('success', { processVerdict: 'process-incomplete' })).toBe('failure');
  });

  it('downgrades success→failure when process verdict is fail-open-warning', () => {
    expect(deriveRunOutcome('success', { processVerdict: 'fail-open-warning' })).toBe('failure');
  });

  it('downgrades success→failure when lifecycle health is critical', () => {
    expect(deriveRunOutcome('success', { lifecycleHealth: 'critical' })).toBe('failure');
  });

  it('keeps success when all verdicts are clean', () => {
    expect(
      deriveRunOutcome('success', {
        reviewVerdict: 'pass',
        processVerdict: 'pass',
        lifecycleHealth: 'clean',
      }),
    ).toBe('success');
  });

  it('does NOT downgrade for a skipped review (no review ran ≠ fail)', () => {
    expect(
      deriveRunOutcome('success', {
        reviewVerdict: 'skipped',
        processVerdict: 'pass',
        lifecycleHealth: 'clean',
      }),
    ).toBe('success');
  });

  it('does NOT downgrade for degraded lifecycle alone (soft signal)', () => {
    // process-incomplete is the hard signal; degraded without a red review/process
    // is not enough on its own — degraded almost always co-occurs with a red
    // process verdict (auto-dent-run sets degraded when processVerdict !== pass),
    // which IS caught. Bare degraded must not over-fire.
    expect(
      deriveRunOutcome('success', {
        reviewVerdict: 'pass',
        processVerdict: 'pass',
        lifecycleHealth: 'degraded',
      }),
    ).toBe('success');
  });

  it('keeps success when verdicts are absent (back-compat / explore runs)', () => {
    expect(deriveRunOutcome('success', {})).toBe('success');
  });

  it.each(['empty_success', 'failure', 'stop'] as const)(
    'passes %s through unchanged regardless of verdicts',
    (base) => {
      expect(
        deriveRunOutcome(base, {
          reviewVerdict: 'fail',
          processVerdict: 'process-incomplete',
          lifecycleHealth: 'critical',
        }),
      ).toBe(base);
      expect(deriveRunOutcome(base, {})).toBe(base);
    },
  );
});

describe('hasRedVerdict', () => {
  it('is true for any single red verdict', () => {
    expect(hasRedVerdict({ reviewVerdict: 'fail' })).toBe(true);
    expect(hasRedVerdict({ processVerdict: 'process-incomplete' })).toBe(true);
    expect(hasRedVerdict({ processVerdict: 'fail-open-warning' })).toBe(true);
    expect(hasRedVerdict({ lifecycleHealth: 'critical' })).toBe(true);
  });

  it('is false for clean / skipped / degraded-only / empty', () => {
    expect(hasRedVerdict({})).toBe(false);
    expect(hasRedVerdict({ reviewVerdict: 'skipped' })).toBe(false);
    expect(hasRedVerdict({ reviewVerdict: 'pass', processVerdict: 'pass' })).toBe(false);
    expect(hasRedVerdict({ lifecycleHealth: 'degraded' })).toBe(false);
  });
});
