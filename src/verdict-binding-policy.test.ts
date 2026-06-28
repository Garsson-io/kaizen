import { describe, it, expect } from 'vitest';
import { qualityVerdictBlockReasons, hasHardQualityFailure } from './verdict-binding-policy.js';

describe('qualityVerdictBlockReasons — test-health (#1481/#1518)', () => {
  it('blocks on unowned-failures', () => {
    const reasons = qualityVerdictBlockReasons({ reviewVerdict: 'pass', testHealth: 'unowned-failures' });
    expect(reasons.some(r => r.includes('test health unowned-failures'))).toBe(true);
    expect(hasHardQualityFailure({ testHealth: 'unowned-failures' })).toBe(true);
  });

  it('does not block on pass / unknown / absent (absence-of-evidence is not failure)', () => {
    expect(qualityVerdictBlockReasons({ reviewVerdict: 'pass', testHealth: 'pass' })).toEqual([]);
    expect(qualityVerdictBlockReasons({ reviewVerdict: 'pass', testHealth: 'unknown' })).toEqual([]);
    expect(qualityVerdictBlockReasons({ reviewVerdict: 'pass' })).toEqual([]);
  });

  it('is provider-agnostic: blocks even when review is not required', () => {
    expect(
      qualityVerdictBlockReasons({ testHealth: 'unowned-failures' }, { requireReview: false }),
    ).toHaveLength(1);
  });

  it('regression: existing review/process/lifecycle rules are unchanged', () => {
    expect(qualityVerdictBlockReasons({ reviewVerdict: 'fail' })).toContain('review verdict fail');
    expect(qualityVerdictBlockReasons({ processVerdict: 'process-incomplete' })).toContain('process verdict process-incomplete');
    expect(qualityVerdictBlockReasons({ lifecycleHealth: 'critical' })).toContain('lifecycle health critical');
    expect(qualityVerdictBlockReasons({ reviewVerdict: 'pass' })).toEqual([]);
  });
});
