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
