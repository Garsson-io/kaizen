import type { LifecycleHealth, ProcessVerdict } from './auto-dent-lifecycle.js';

export type ReviewVerdict = 'pass' | 'fail' | 'skipped';

export interface AutoMergeSafetySignals {
  /** Number of PRs this terminal action would affect. Non-PR runs have no merge action. */
  prCount: number;
  /** False only for explicit synthetic runs where review is intentionally not applicable. */
  reviewRequired: boolean;
  reviewVerdict?: ReviewVerdict;
  processVerdict?: ProcessVerdict;
  lifecycleHealth?: LifecycleHealth;
}

export interface AutoMergeSafetyDecision {
  allow: boolean;
  reasons: string[];
}

export function autoMergeBlockReasons(signals: AutoMergeSafetySignals): string[] {
  if (signals.prCount <= 0) return [];

  const reasons: string[] = [];

  if (signals.reviewVerdict === 'fail') {
    reasons.push('review verdict fail');
  } else if (signals.reviewRequired && signals.reviewVerdict === 'skipped') {
    reasons.push('review verdict skipped');
  } else if (signals.reviewRequired && signals.reviewVerdict == null) {
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

export function decideAutoMergeSafety(signals: AutoMergeSafetySignals): AutoMergeSafetyDecision {
  const reasons = autoMergeBlockReasons(signals);
  return {
    allow: reasons.length === 0,
    reasons,
  };
}
