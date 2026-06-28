import {
  qualityVerdictBlockReasons,
  type LifecycleHealth,
  type ProcessVerdict,
  type ReviewVerdict,
  type TestHealthVerdict,
} from '../src/verdict-binding-policy.js';
import { providerClaimsHookSupport, type HookActivationVerdict } from './auto-dent-hook-activation.js';
import type { Provider } from './auto-dent-provider.js';
import type { WorkflowGateId, WorkflowGateState } from './workflow-gate-ledger.js';

export type WorkflowRepairState =
  | 'not_required'
  | 'repair_scheduled'
  | 'merge_ready'
  | 'blocked_with_reason'
  | 'repair_budget_exhausted';

export interface AutoMergeSafetySignals {
  /** Number of PRs this terminal action would affect. Non-PR runs have no merge action. */
  prCount: number;
  /** False only for explicit synthetic runs where review is intentionally not applicable. */
  reviewRequired: boolean;
  reviewVerdict?: ReviewVerdict;
  processVerdict?: ProcessVerdict;
  lifecycleHealth?: LifecycleHealth;
  /**
   * Test-health verdict for the run (#1481/#1518). `unowned-failures` blocks the
   * merge; `pass`/`unknown`/absent do not. Consumed via the shared
   * `qualityVerdictBlockReasons` SSOT — no separate rule here.
   */
  testHealth?: TestHealthVerdict;
  /** Canonical workflow gate states emitted by the process ledger (#1533). */
  workflowGateStates?: Partial<Record<WorkflowGateId, WorkflowGateState>>;
  /** Evidence-repair loop state emitted with the workflow gate ledger (#1533). */
  workflowRepairState?: WorkflowRepairState;
  /**
   * Hook-activation verdict for the run (#843/#1500). `undefined` means no
   * `system.init` event was observed this run, so hook state is unknown.
   * `degraded` is already provider-correct by construction
   * (`degraded = providerClaimsHookSupport(provider) && !active`), so it is only
   * ever true on a hook-expecting provider that ran with kaizen hooks absent.
   */
  hookActivation?: HookActivationVerdict;
  /**
   * Run provider. Used only to classify the *absent* verdict: no `system.init`
   * on a hook-expecting provider is unknown enforcement state → not merge-ready.
   * Reuses `providerClaimsHookSupport` (the #1500 SSOT); never re-derives it.
   */
  provider?: Provider;
}

export interface AutoMergeSafetyDecision {
  allow: boolean;
  reasons: string[];
}

/**
 * Hook-activation merge-readiness reasons (#1220 completion / #843/#1500).
 *
 * Layered HERE rather than inside the shared `qualityVerdictBlockReasons`
 * (src/verdict-binding-policy.ts) on purpose: the hook-activation types and the
 * `providerClaimsHookSupport` SSOT live in `scripts/`, and `src/` must not depend
 * on `scripts/`. The auto-merge gate is the consumer that needs this binding, so
 * the hook layer sits at the merge gate while review/process/lifecycle stay in
 * the shared quality SSOT — one decision, no duplicated rules.
 *
 * Gated behind `reviewRequired` so synthetic / test-task probe PRs (the
 * established exception) are unaffected, mirroring the `skipped`/`missing`
 * review treatment in the shared policy.
 */
export function hookActivationBlockReasons(signals: AutoMergeSafetySignals): string[] {
  if (!signals.reviewRequired) return [];

  if (signals.hookActivation?.degraded) {
    // Provider-correct by construction: only true on a hook-expecting provider.
    return ['hook enforcement degraded (kaizen hooks did not load)'];
  }
  if (
    !signals.hookActivation &&
    signals.provider &&
    providerClaimsHookSupport(signals.provider)
  ) {
    // No `system.init` observed on a hook-expecting provider: unknown enforcement
    // state must count as NOT ready (absence-of-evidence ≠ ready).
    return ['hook activation unknown (no system.init observed on a hook-expecting provider)'];
  }
  return [];
}

export function workflowGateBlockReasons(signals: AutoMergeSafetySignals): string[] {
  if (signals.prCount <= 0) return [];

  const reasons: string[] = [];
  if (
    signals.workflowRepairState === 'repair_scheduled' ||
    signals.workflowRepairState === 'blocked_with_reason' ||
    signals.workflowRepairState === 'repair_budget_exhausted'
  ) {
    reasons.push(`workflow repair state ${signals.workflowRepairState}`);
  }

  for (const [gate, state] of Object.entries(signals.workflowGateStates ?? {}) as Array<[WorkflowGateId, WorkflowGateState]>) {
    if (state === 'invalid' || state === 'blocked' || state === 'pending') {
      reasons.push(`workflow gate ${gate} ${state}`);
    }
  }
  return [...new Set(reasons)];
}

export function autoMergeBlockReasons(signals: AutoMergeSafetySignals): string[] {
  if (signals.prCount <= 0) return [];
  return [
    ...qualityVerdictBlockReasons(signals, { requireReview: signals.reviewRequired }),
    ...workflowGateBlockReasons(signals),
    ...hookActivationBlockReasons(signals),
  ];
}

export function decideAutoMergeSafety(signals: AutoMergeSafetySignals): AutoMergeSafetyDecision {
  const reasons = autoMergeBlockReasons(signals);
  return {
    allow: reasons.length === 0,
    reasons,
  };
}
