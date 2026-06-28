export type ReviewVerdict = 'pass' | 'fail' | 'skipped';
export type ProcessVerdict = 'pass' | 'process-incomplete' | 'fail-open-warning';
export type LifecycleHealth = 'clean' | 'degraded' | 'critical';
/**
 * Test-health verdict (#1481/#1518). `unowned-failures` means the run observed a
 * failing test that is NOT owned by an OPEN tracking issue in the known-failures
 * registry — that PR is not merge-ready. `unknown` (no test signal observed) and
 * absence are non-blocking: absence-of-evidence is not a failure here, mirroring
 * how the review verdict is only required at terminal actions.
 */
export type TestHealthVerdict = 'pass' | 'unowned-failures' | 'unknown';

export interface QualityVerdictSignals {
  reviewVerdict?: ReviewVerdict;
  processVerdict?: ProcessVerdict;
  lifecycleHealth?: LifecycleHealth;
  testHealth?: TestHealthVerdict;
}

export interface QualityVerdictPolicyOptions {
  /**
   * True at terminal actions where a PR exists and review evidence is mandatory.
   * Run-success telemetry leaves skipped/missing review as non-failing because
   * non-PR modes legitimately have no review verdict.
   */
  requireReview?: boolean;
}

export function qualityVerdictBlockReasons(
  signals: QualityVerdictSignals,
  options: QualityVerdictPolicyOptions = {},
): string[] {
  const reasons: string[] = [];

  if (signals.reviewVerdict === 'fail') {
    reasons.push('review verdict fail');
  } else if (options.requireReview && signals.reviewVerdict === 'skipped') {
    reasons.push('review verdict skipped');
  } else if (options.requireReview && signals.reviewVerdict == null) {
    reasons.push('review verdict missing');
  }

  if (signals.processVerdict === 'process-incomplete') {
    reasons.push('process verdict process-incomplete');
  }

  if (signals.lifecycleHealth === 'critical') {
    reasons.push('lifecycle health critical');
  }

  // #1518: an observed test failure that no OPEN issue owns blocks merge. This
  // is provider-agnostic (not gated behind requireReview): unlike review, test
  // health is a hard signal for both Claude and Codex runs.
  if (signals.testHealth === 'unowned-failures') {
    reasons.push('test health unowned-failures (failing test with no owning open issue, #1518)');
  }

  return reasons;
}

export function hasHardQualityFailure(signals: QualityVerdictSignals): boolean {
  return qualityVerdictBlockReasons(signals).length > 0;
}
