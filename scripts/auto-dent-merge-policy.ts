import {
  qualityVerdictBlockReasons,
  type LifecycleHealth,
  type ProcessVerdict,
  type ReviewVerdict,
} from '../src/verdict-binding-policy.js';


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
  return qualityVerdictBlockReasons(signals, { requireReview: signals.reviewRequired });
}

export function decideAutoMergeSafety(signals: AutoMergeSafetySignals): AutoMergeSafetyDecision {
  const reasons = autoMergeBlockReasons(signals);
  return {
    allow: reasons.length === 0,
    reasons,
  };
}
