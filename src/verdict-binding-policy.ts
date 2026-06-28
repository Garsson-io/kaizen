export type ReviewVerdict = 'pass' | 'fail' | 'skipped';
export type ProcessVerdict = 'pass' | 'process-incomplete' | 'fail-open-warning';
export type LifecycleHealth = 'clean' | 'degraded' | 'critical';

export interface QualityVerdictSignals {
  reviewVerdict?: ReviewVerdict;
  processVerdict?: ProcessVerdict;
  lifecycleHealth?: LifecycleHealth;
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

  return reasons;
}

export function hasHardQualityFailure(signals: QualityVerdictSignals): boolean {
  return qualityVerdictBlockReasons(signals).length > 0;
}
