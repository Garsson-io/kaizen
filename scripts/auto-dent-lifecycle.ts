// Auto-dent run lifecycle validation.
//
// The agent emits AUTO_DENT_PHASE markers as it moves through the pipeline
// (PICK -> EVALUATE -> IMPLEMENT -> TEST -> PR -> MERGE -> REFLECT). Those
// markers are *claims*. This module turns the claims into a verified, classified
// signal so the harness can see — and steer on — when a run's narrative doesn't
// hold together:
//
//   - ordering violations  : a phase appeared earlier than a prior phase (degraded)
//   - critical gaps         : a phase that implies prior work is present without it,
//                             e.g. PR without IMPLEMENT or MERGE without PR (critical)
//   - phantom phases        : a claimed-green outcome that ran nothing,
//                             e.g. TEST result=pass with count=0 (critical) — the
//                             "verify outcomes, not commands" failure (#943, #950)
//
// Validation is observability + steering, never a hard block (#1103): a heuristic
// false-positive must not halt an unattended batch.

import { readFileSync } from 'fs';
import { parsePhaseMarkers } from './auto-dent-stream.js';
import type { WorkflowGateId } from './workflow-gate-ledger.js';

/** Canonical phase order. Phases not in this list (floating) are ignored for ordering. */
export const LIFECYCLE_ORDER = ['PICK', 'EVALUATE', 'IMPLEMENT', 'TEST', 'PR', 'MERGE', 'REFLECT'];

/** Phases that can appear anywhere without breaking ordering. */
export const FLOATING_PHASES = new Set(['DECOMPOSE', 'STOP']);

/**
 * Phases that, when present, require an earlier phase to also be present.
 * A present phase whose required predecessor is absent is a *critical gap* —
 * the run claims to have shipped without doing the prerequisite work.
 */
export const REQUIRED_PREDECESSORS: Record<string, string> = {
  PR: 'IMPLEMENT',
  MERGE: 'PR',
};

export type LifecycleHealth = 'clean' | 'degraded' | 'critical';

export interface LifecycleValidation {
  /** Back-compat: true when there are no *ordering* violations. */
  valid: boolean;
  phasesPresent: string[];
  phasesMissing: string[];
  /** Ordering violations: `phase` appeared after `after` (out of canonical order). */
  violations: Array<{ phase: string; after: string }>;
  /** Critical gaps: `phase` is present but its required `requires` predecessor is absent. */
  criticalGaps: Array<{ phase: string; requires: string }>;
  /** Phantom phases: a claimed-green outcome that ran nothing. */
  phantomPhases: Array<{ phase: string; reason: string }>;
  /** Overall health: critical (gaps/phantoms) > degraded (ordering) > clean. */
  health: LifecycleHealth;
}

/**
 * Validate lifecycle phase ordering and integrity from a run log file.
 * Reads the log, extracts AUTO_DENT_PHASE markers, and classifies the run.
 */
export function validateRunLifecycle(logFile: string): LifecycleValidation {
  const logContent = readFileSync(logFile, 'utf8');
  const markers = parsePhaseMarkers(logContent);
  const phasesPresent = markers.map((m) => m.phase);
  const orderedPhases = phasesPresent.filter((p) => !FLOATING_PHASES.has(p));
  const presentSet = new Set(phasesPresent);

  // Ordering violations (back-compat).
  const violations: Array<{ phase: string; after: string }> = [];
  for (let i = 1; i < orderedPhases.length; i++) {
    const prevIdx = LIFECYCLE_ORDER.indexOf(orderedPhases[i - 1]);
    const currIdx = LIFECYCLE_ORDER.indexOf(orderedPhases[i]);
    if (prevIdx === -1 || currIdx === -1) continue;
    if (currIdx < prevIdx) {
      violations.push({ phase: orderedPhases[i], after: orderedPhases[i - 1] });
    }
  }

  // Critical gaps: a present phase whose required predecessor never appeared.
  const criticalGaps: Array<{ phase: string; requires: string }> = [];
  for (const [phase, requires] of Object.entries(REQUIRED_PREDECESSORS)) {
    if (presentSet.has(phase) && !presentSet.has(requires)) {
      criticalGaps.push({ phase, requires });
    }
  }

  // Phantom phases: a claimed-green outcome that ran nothing.
  // Today: TEST result=pass with a count that is missing or zero.
  const phantomPhases: Array<{ phase: string; reason: string }> = [];
  for (const marker of markers) {
    if (marker.phase !== 'TEST') continue;
    if (marker.fields.result !== 'pass') continue;
    const rawCount = marker.fields.count;
    const count = rawCount === undefined ? NaN : Number.parseInt(rawCount, 10);
    if (rawCount === undefined || !Number.isFinite(count) || count <= 0) {
      phantomPhases.push({
        phase: 'TEST',
        reason: `result=pass but count=${rawCount ?? 'missing'} (claimed green, ran nothing)`,
      });
    }
  }

  const phasesMissing = LIFECYCLE_ORDER.filter((p) => !presentSet.has(p));

  const health: LifecycleHealth =
    criticalGaps.length > 0 || phantomPhases.length > 0
      ? 'critical'
      : violations.length > 0
        ? 'degraded'
        : 'clean';

  return {
    valid: violations.length === 0,
    phasesPresent,
    phasesMissing,
    violations,
    criticalGaps,
    phantomPhases,
    health,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// External evidence verification (#1138, epic #1134)
//
// validateRunLifecycle above classifies a run from the agent's AUTO_DENT_PHASE
// markers — but those are the *worker's self-report*. Epic #1134's principle is
// "auto-dent is the judge; the agent is the worker; hooks are useful feedback but
// not the source of truth." A run can emit PR/MERGE/REFLECT markers with zero
// corresponding external artifacts and still classify as clean. This is the
// batch-level instance of "verify outcomes, not commands" (#943, #950).
//
// The functions below cross-check claimed phases against evidence the harness
// extracts INDEPENDENTLY of the agent (PRs, cases, filed/closed issues, the
// review-battery verdict). They read only external outcomes — never the markers'
// truthiness — so they judge Claude and Codex identically. They are pure: the
// caller assembles the evidence (the only impure part), the verifier decides.
// Like all lifecycle validation, this is observability + steering, never a hard
// block (#1103).

/**
 * External outcomes of a run, extracted by the harness independently of the
 * agent's self-report. This is the judge's evidence. Provider-independent:
 * assembled the same way whether the worker was Claude or Codex.
 */
export interface LifecycleEvidence {
  /** PRs the harness extracted from the run output. */
  prsCreated: number;
  /** Case worktrees the harness extracted. */
  casesCreated: number;
  /** Issues filed or closed — durable reflection output. */
  issuesFiledOrClosed: number;
  /** Requirements-review verdict computed externally by the review battery. */
  reviewVerdict: 'pass' | 'fail' | 'skipped' | null | undefined;
}

/** A claimed phase whose corroborating external evidence is missing. */
export interface ProcessGap {
  phase: string;
  reason: string;
}

export interface EvidenceVerification {
  /** Claims that the external outcomes do not corroborate. */
  processGaps: ProcessGap[];
  /** true when every claimed phase has corroborating external evidence. */
  processComplete: boolean;
}

export type ProcessVerdict = 'pass' | 'process-incomplete' | 'fail-open-warning';
export type ProcessCheckStatus = 'pass' | 'fail' | 'warning' | 'not-applicable';
export type MergeReadinessEvidence = 'ready' | 'not-ready' | 'unknown' | 'not-applicable';
export type ProviderReviewEvidenceStatus = 'pass' | 'fail' | 'skipped' | 'missing' | 'pending';

export interface ProcessEvidence {
  /** The run intentionally stopped/skipped before producing work artifacts. */
  intentionalNoOp?: boolean;
  /** Durable ticket identity evidence exists. */
  ticketIdentityEvidence?: boolean;
  /** Durable plan or claimed-plan assignment evidence exists. */
  planEvidence?: boolean;
  /** Durable implementation evidence exists (case/worktree or equivalent). */
  implementationEvidence?: boolean;
  /** Durable PR evidence exists. */
  prEvidence?: boolean;
  /** Durable test evidence exists. */
  testEvidence?: boolean;
  /** Review-battery verdict exists (pass/fail both count as evidence). */
  reviewEvidence?: boolean;
  /**
   * Optional per-provider review evidence for hybrid/provider-comparison runs.
   * `pass` and `fail` both prove a provider review completed; skipped/missing/pending
   * mean the worker cannot claim review completion for that provider.
   */
  providerReviewEvidence?: Record<string, ProviderReviewEvidenceStatus>;
  /** Durable reflection output exists. */
  reflectionEvidence?: boolean;
  /** Related-area DRY/refactor pass evidence exists. */
  dryRefactorEvidence?: boolean;
  /** Meet-reality evidence exists. */
  meetRealityEvidence?: boolean;
  /** Hook/provider activation or external substitute evidence exists. */
  hookProviderEvidence?: boolean;
  /** Merge readiness signal for PR-producing runs. */
  mergeReadiness?: MergeReadinessEvidence;
}

export interface ProcessCheck {
  id: WorkflowGateId;
  status: ProcessCheckStatus;
  reason: string;
  remediation?: string;
}

function completedReviewProviderStatuses(providerEvidence: Record<string, ProviderReviewEvidenceStatus>): {
  complete: boolean;
  incompleteProviders: string[];
} {
  const entries = Object.entries(providerEvidence);
  if (entries.length === 0) {
    return { complete: false, incompleteProviders: ['(none recorded)'] };
  }
  const incompleteProviders = entries
    .filter(([, status]) => status !== 'pass' && status !== 'fail')
    .map(([provider, status]) => `${provider}:${status}`);
  return { complete: incompleteProviders.length === 0, incompleteProviders };
}

export interface ProcessValidation {
  verdict: ProcessVerdict;
  checks: ProcessCheck[];
  failedChecks: ProcessCheck[];
  warningChecks: ProcessCheck[];
}

function addCheck(
  checks: ProcessCheck[],
  id: ProcessCheck['id'],
  required: boolean,
  present: boolean | undefined,
  failReason: string,
  passReason: string,
  remediation?: string,
): void {
  if (!required) {
    checks.push({ id, status: 'not-applicable', reason: 'not required for this run' });
    return;
  }
  if (present === true) {
    checks.push({ id, status: 'pass', reason: passReason });
    return;
  }
  checks.push({ id, status: 'fail', reason: failReason, remediation });
}

function legacyGateReason(id: WorkflowGateId, reason: string): string {
  return `${id}: ${reason}`;
}

/**
 * Validate durable process evidence for a run. This is the richer #1149 layer:
 * marker claims describe what the worker says happened; `ProcessEvidence`
 * describes what the harness can corroborate through durable artifacts.
 */
export function validateProcessEvidence(
  validation: LifecycleValidation,
  evidence: ProcessEvidence,
): ProcessValidation {
  const present = new Set(validation.phasesPresent);
  const checks: ProcessCheck[] = [];
  const hasProducingClaim =
    present.has('IMPLEMENT') ||
    present.has('TEST') ||
    present.has('PR') ||
    present.has('MERGE') ||
    present.has('REFLECT');
  const hasDurableArtifact =
    evidence.implementationEvidence === true ||
    evidence.prEvidence === true ||
    evidence.reflectionEvidence === true;
  const intentionalNoOp =
    evidence.intentionalNoOp === true &&
    !hasProducingClaim &&
    !hasDurableArtifact;
  const hasWorkClaim =
    !intentionalNoOp &&
    (present.has('EVALUATE') ||
      hasProducingClaim ||
      evidence.implementationEvidence === true ||
      evidence.prEvidence === true);

  const needsImplementation =
    present.has('IMPLEMENT') || present.has('TEST') || present.has('PR') || present.has('MERGE') || evidence.prEvidence === true;
  const needsPr = present.has('PR') || present.has('MERGE') || evidence.prEvidence === true;
  const needsTest = present.has('TEST') || present.has('PR') || present.has('MERGE') || evidence.prEvidence === true;
  const needsReview = present.has('PR') || present.has('MERGE') || evidence.prEvidence === true;
  const needsReflection = present.has('REFLECT');
  const needsMergeReadiness = present.has('PR') || present.has('MERGE') || evidence.prEvidence === true;

  addCheck(
    checks,
    'ticket-identity',
    hasWorkClaim,
    evidence.ticketIdentityEvidence,
    'work was claimed or produced without durable ticket identity evidence',
    'durable ticket identity evidence exists',
    'record the issue number, title, URL, repo, and scope linkage',
  );
  addCheck(
    checks,
    'plan-testplan',
    hasWorkClaim,
    evidence.planEvidence,
    'work was claimed or produced without durable plan evidence',
    'durable plan evidence exists',
    'store or claim a concrete plan before implementation',
  );
  addCheck(
    checks,
    'worktree-case',
    needsImplementation,
    evidence.implementationEvidence,
    'implementation/PR progress was claimed without durable worktree/case evidence',
    'durable worktree/case evidence exists',
    'create or record the case/worktree or other implementation artifact before claiming implementation',
  );
  addCheck(
    checks,
    'implementation-tests',
    needsTest,
    evidence.testEvidence,
    'tests were claimed or a PR was produced without durable test evidence',
    'durable test evidence exists',
    'run tests and record a non-empty test result before claiming TEST/PR success',
  );
  addCheck(
    checks,
    'dry-refactor',
    needsPr,
    evidence.dryRefactorEvidence,
    'a PR exists or was claimed without related-area DRY/refactor evidence',
    'related-area DRY/refactor evidence exists',
    'record the related-area simplification sweep or the explicit reason no refactor was warranted',
  );
  addCheck(
    checks,
    'meet-reality',
    needsPr,
    evidence.meetRealityEvidence,
    'a PR exists or was claimed without meet-reality evidence',
    'meet-reality evidence exists',
    'try the PR/workflow and record observed outputs and side effects',
  );
  addCheck(
    checks,
    'review-requirements-impact',
    needsReview,
    evidence.reviewEvidence,
    'a PR exists or was claimed without review evidence',
    'review evidence exists',
    'run the review battery and store a pass/fail verdict',
  );

  if (needsReview && evidence.providerReviewEvidence !== undefined) {
    const providerReview = completedReviewProviderStatuses(evidence.providerReviewEvidence);
    if (!providerReview.complete) {
      checks.push({
        id: 'review-requirements-impact',
        status: 'fail',
        reason: `provider review evidence incomplete: ${providerReview.incompleteProviders.join(', ')}`,
        remediation: 'wait for every selected provider review to finish and store its pass/fail evidence before claiming review success',
      });
    }
  }

  addCheck(
    checks,
    'reflection',
    needsReflection,
    evidence.reflectionEvidence,
    'REFLECT was claimed without durable reflection output',
    'durable reflection evidence exists',
    'file/close the follow-up issue or record the durable reflection artifact',
  );

  if (!needsMergeReadiness) {
    checks.push({ id: 'pr-ci-merge-cleanup', status: 'not-applicable', reason: 'no PR-producing phase required merge readiness' });
  } else if (evidence.prEvidence !== true) {
    checks.push({
      id: 'pr-ci-merge-cleanup',
      status: 'fail',
      reason: 'PR/MERGE was claimed but no durable PR evidence exists',
      remediation: 'create the PR or avoid claiming PR/MERGE',
    });
  } else if (evidence.mergeReadiness === 'ready') {
    checks.push({ id: 'pr-ci-merge-cleanup', status: 'pass', reason: 'PR and merge readiness evidence are ready' });
  } else if (evidence.mergeReadiness === 'not-applicable') {
    checks.push({ id: 'pr-ci-merge-cleanup', status: 'not-applicable', reason: 'merge readiness not applicable' });
  } else {
    const state = evidence.mergeReadiness ?? 'unknown';
    checks.push({
      id: 'pr-ci-merge-cleanup',
      status: 'warning',
      reason: `merge readiness is ${state}`,
      remediation: 'treat as fail-open steering and re-check PR merge readiness next run',
    });
  }
  addCheck(
    checks,
    'hook-provider-activation',
    needsPr,
    evidence.hookProviderEvidence,
    'a PR exists or was claimed without hook/provider activation evidence',
    'hook/provider activation evidence exists',
    'record provider identity, hook expectation/activation, or schema-valid external substitute evidence',
  );

  const failedChecks = checks.filter((check) => check.status === 'fail');
  const warningChecks = checks.filter((check) => check.status === 'warning');
  const verdict: ProcessVerdict =
    failedChecks.length > 0 ? 'process-incomplete'
      : warningChecks.length > 0 ? 'fail-open-warning'
        : 'pass';

  return { verdict, checks, failedChecks, warningChecks };
}

/**
 * Cross-check a run's claimed lifecycle phases against the external outcomes the
 * harness extracted. Returns the unsupported claims (process gaps). Conservative
 * by design: each rule fires only when a claim is contradicted by a hard,
 * harness-observed fact, so a false positive is unlikely and — per #1103 — never
 * halts a batch regardless.
 */
export function verifyLifecycleEvidence(
  validation: LifecycleValidation,
  evidence: LifecycleEvidence,
): EvidenceVerification {
  const present = new Set(validation.phasesPresent);
  const gaps: ProcessGap[] = [];

  // PR / MERGE claimed but nothing shipped externally.
  if ((present.has('PR') || present.has('MERGE')) && evidence.prsCreated <= 0) {
    const claimed = present.has('MERGE') ? 'MERGE' : 'PR';
    gaps.push({
      phase: claimed,
      reason: `claimed ${claimed} but the harness extracted 0 PRs from the run`,
    });
  }

  // IMPLEMENT claimed but produced no work artifact (no case worktree, no PR).
  if (present.has('IMPLEMENT') && evidence.casesCreated <= 0 && evidence.prsCreated <= 0) {
    gaps.push({
      phase: 'IMPLEMENT',
      reason: 'claimed IMPLEMENT but no case worktree and no PR were produced',
    });
  }

  // REFLECT claimed but produced no durable output (no issue filed or closed).
  if (present.has('REFLECT') && evidence.issuesFiledOrClosed <= 0) {
    gaps.push({
      phase: 'REFLECT',
      reason: 'claimed REFLECT but no issues were filed or closed',
    });
  }

  // A PR shipped but review evidence is absent — the review battery never
  // produced a verdict for it. Gated on the external fact (prsCreated > 0), not
  // on a claim, so it catches PRs the agent never announced too.
  if (
    evidence.prsCreated > 0 &&
    (evidence.reviewVerdict == null || evidence.reviewVerdict === 'skipped')
  ) {
    gaps.push({
      phase: 'PR',
      reason: `a PR was created but review evidence is ${evidence.reviewVerdict ?? 'missing'}`,
    });
  }

  return { processGaps: gaps, processComplete: gaps.length === 0 };
}

/**
 * Fold an evidence verification into a marker-derived lifecycle health. A
 * process-incomplete run is at least `degraded`; an already-`critical` run stays
 * critical. Evidence gaps never *downgrade* health.
 */
export function foldEvidenceIntoHealth(
  health: LifecycleHealth,
  verification: EvidenceVerification,
): LifecycleHealth {
  if (verification.processComplete) return health;
  return health === 'critical' ? 'critical' : 'degraded';
}

/** One-line human summary of an evidence verification, for logs and steering. */
export function summarizeEvidence(v: EvidenceVerification): string {
  if (v.processComplete) return 'process complete (claims corroborated by outcomes)';
  return `process-incomplete: ${v.processGaps.map((g) => g.reason).join('; ')}`;
}

/** One-line summary of the #1149 durable process verdict, for logs and steering. */
export function summarizeProcessValidation(v: ProcessValidation): string {
  if (v.verdict === 'pass') return 'process verdict pass (durable evidence complete)';
  const actionable = [...v.failedChecks, ...v.warningChecks];
  return `${v.verdict}: ${actionable.map((check) => legacyGateReason(check.id, check.reason)).join('; ')}`;
}

/**
 * Render a one-line human summary of a lifecycle validation result, suitable for
 * console logs, run logs, and steering insights. Critical findings are named.
 */
export function summarizeLifecycle(v: LifecycleValidation): string {
  if (v.health === 'clean') {
    const chain = v.phasesPresent.length > 0 ? v.phasesPresent.join(' -> ') : 'no phases';
    return `lifecycle clean (${chain})`;
  }

  const parts: string[] = [];
  for (const g of v.criticalGaps) parts.push(`${g.phase} without ${g.requires}`);
  for (const p of v.phantomPhases) parts.push(`phantom ${p.phase} (${p.reason})`);
  for (const o of v.violations) parts.push(`${o.phase} after ${o.after}`);

  const label = v.health === 'critical' ? 'CRITICAL' : 'degraded';
  return `lifecycle ${label}: ${parts.join('; ')}`;
}
