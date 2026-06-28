import { describe, expect, it } from 'vitest';
import { decideReviewVerdictStatus } from './review-verdict-status.js';

describe('decideReviewVerdictStatus', () => {
  it('fails when the latest stored review round derives FAIL', () => {
    const status = decideReviewVerdictStatus(2, 'FAIL');
    expect(status.outcome).toBe('fail');
    expect(status.message).toContain('r2');
  });

  it('passes PASS and PASS_WITH_PARTIALS verdicts', () => {
    expect(decideReviewVerdictStatus(1, 'PASS').outcome).toBe('pass');
    expect(decideReviewVerdictStatus(1, 'PASS_WITH_PARTIALS').outcome).toBe('pass');
  });

  it('does not fail when no stored review data exists', () => {
    expect(decideReviewVerdictStatus(0, null).outcome).toBe('no_data');
  });
});
