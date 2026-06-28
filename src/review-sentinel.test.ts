import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildReviewSentinelRecord,
  expectedPrReviewDimensions,
  serializeReviewSentinel,
  validateReviewSentinel,
} from './review-sentinel.js';

const PR_URL = 'https://github.com/Garsson-io/kaizen/pull/997';

describe('review sentinel contract', () => {
  it('uses the shared YAML frontmatter parser for expected review dimensions', () => {
    const source = readFileSync('src/review-sentinel.ts', 'utf8');

    expect(source).not.toContain('content.match(/^---\\n');
    expect(source).not.toContain('YAML.parse(match[1])');
  });

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

  it('rejects a sentinel with findingCount=0 (no stored findings)', () => {
    const record = buildReviewSentinelRecord({
      prUrl: PR_URL,
      round: 1,
      dimensionsReviewed: expectedPrReviewDimensions(),
      findingCount: 0,
      totalDone: 0,
      totalPartial: 0,
      totalMissing: 0,
    });

    const result = validateReviewSentinel(serializeReviewSentinel(record), {
      prUrl: PR_URL,
      round: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_findingCount');
  });

  it('throws for malformed PR URLs before building a sentinel', () => {
    expect(() =>
      buildReviewSentinelRecord({
        prUrl: 'https://github.com/Garsson-io/kaizen/pull/not-a-number',
        round: 1,
      }),
    ).toThrow('invalid PR URL');
  });
});
