/**
 * auto-dent-outcome.ts — derive a run's terminal `outcome` from the quality
 * verdicts the same run already computed.
 *
 * #1224 / #1227: a run's `outcome` is a TERMINAL signal — batch summaries,
 * cross-batch steering, and humans deciding whether to merge all read it. The
 * bug it closes: `outcome` was computed from only `stopRequested`/`exitCode`/
 * `modeSuccess()` and never consulted `review_verdict`, `process_verdict`, or
 * `lifecycle_health` — verdicts already carried on the SAME `run.complete`
 * event. So a run with `review_verdict:fail` + `process_verdict:process-
 * incomplete` still stamped `outcome:success` (auto-dent grading its own
 * homework as passing while the rubric said fail). That false-green is exactly
 * how PR #1212 was acted on (see #1220, #1227).
 *
 * This module is the BINDING: a base `success` is only honoured when no quality
 * verdict is red. It is PURE (no I/O) so the rule is exhaustively unit-testable
 * and cannot drift from the data the event already carries.
 */

import type { LifecycleHealth, ProcessVerdict } from './auto-dent-lifecycle.js';

/** The terminal outcome enum emitted on `run.complete`. */
export type RunOutcome = 'success' | 'empty_success' | 'failure' | 'stop';

/** Review battery verdict as recorded on the run. */
export type RunReviewVerdict = 'pass' | 'fail' | 'skipped';

export interface RunVerdicts {
  /** Review battery verdict. `skipped` is NOT a failure (no review ran). */
  reviewVerdict?: RunReviewVerdict;
  /** Process-completeness verdict. Anything other than `pass` is degraded. */
  processVerdict?: ProcessVerdict;
  /** Lifecycle health. Only `critical` forces a downgrade. */
  lifecycleHealth?: LifecycleHealth;
}

/**
 * True when the run's quality verdicts say the work was NOT clean, so a
 * `success` outcome would be a false green.
 *
 * Red signals (any one is enough):
 *   - `reviewVerdict === 'fail'`          — the review battery FAILed.
 *   - `processVerdict !== 'pass'`         — process-incomplete / fail-open-warning
 *                                           (no durable plan/impl/PR/test/review
 *                                           evidence behind the claims).
 *   - `lifecycleHealth === 'critical'`    — claimed-to-ship-without-building, or
 *                                           claimed-green-but-ran-nothing.
 *
 * `reviewVerdict === 'skipped'` is deliberately NOT red: a run that legitimately
 * ran no review (e.g. explore/reflect modes) must not be downgraded. A red
 * `process_verdict` already catches a run that should have reviewed but didn't.
 */
export function hasRedVerdict(verdicts: RunVerdicts): boolean {
  if (verdicts.reviewVerdict === 'fail') return true;
  if (verdicts.processVerdict != null && verdicts.processVerdict !== 'pass') return true;
  if (verdicts.lifecycleHealth === 'critical') return true;
  return false;
}

/**
 * Derive the final `outcome` by binding the base outcome to the quality
 * verdicts. Only a base `success` can be downgraded — `empty_success`, `stop`,
 * and `failure` are already non-success / terminal and pass through unchanged.
 *
 * A base `success` with ANY red verdict becomes `failure`: a run the rubric
 * graded as failing must never roll up to success.
 */
export function deriveRunOutcome(base: RunOutcome, verdicts: RunVerdicts): RunOutcome {
  if (base !== 'success') return base;
  return hasRedVerdict(verdicts) ? 'failure' : 'success';
}
