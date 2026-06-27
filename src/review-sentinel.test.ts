import { describe, expect, it } from 'vitest';
import {
  buildReviewSentinelRecord,
  expectedPrReviewDimensions,
  serializeReviewSentinel,
  validateReviewSentinel,
} from './review-sentinel.js';

const PR_URL = 'https://github.com/Garsson-io/kaizen/pull/997';

describe('review sentinel contract', () => {
  it('validates a complete structured sentinel', () => {
    const record = buildReviewSentinelRecord({
      prUrl: PR_URL,
      round: 1,
      dimensionsReviewed: expectedPrReviewDimensions(),
      findingCount: 12,
      totalDone: 12,
    });

    const result = validateReviewSentinel(serializeReviewSentinel(record), {
      prUrl: PR_URL,
      round: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.record?.dimensionsReviewed).toEqual(expectedPrReviewDimensions());
  });

  it('rejects tampered sentinel content', () => {
    const record = buildReviewSentinelRecord({
      prUrl: PR_URL,
      round: 1,
      dimensionsReviewed: expectedPrReviewDimensions(),
      findingCount: 12,
      totalDone: 12,
    });
    const tampered = { ...record, totalMissing: 1 };

    const result = validateReviewSentinel(JSON.stringify(tampered), {
      prUrl: PR_URL,
      round: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('integrity_mismatch');
  });

  it('rejects sentinels missing expected review dimensions', () => {
    const record = buildReviewSentinelRecord({
      prUrl: PR_URL,
      round: 1,
      dimensionsReviewed: ['correctness'],
      findingCount: 1,
      totalDone: 1,
    });

    const result = validateReviewSentinel(serializeReviewSentinel(record), {
      prUrl: PR_URL,
      round: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('missing_expected_dimensions');
  });
});
