/**
 * reflection-checks.ts — Deterministic detectors for reflection quality issues.
 *
 * Analyzes KAIZEN_IMPEDIMENTS declarations for gaming patterns (FM3).
 */

import { type Impediment, type Detection, FailureMode } from './types.js';
import { truncate } from './util.js';
import { GENERIC_WAIVER_BLOCKLIST } from '../lib/waiver-blocklist.js';

/**
 * FM3: Detect low-quality reflections that game the gate.
 *
 * Checks for:
 * - Generic waiver reasons (blocklist match)
 * - All findings waived/no-action (100% avoidance)
 * - Empty or trivial findings
 * - High ratio of positive/no-action vs filed
 */
export function detectReflectionGaming(
  impediments: Impediment[],
): Detection[] {
  const detections: Detection[] = [];

  if (impediments.length === 0) {
    detections.push({
      mode: FailureMode.REFLECTION_GAMING,
      confidence: 85,
      location: 'KAIZEN_IMPEDIMENTS',
      detail: 'Empty impediments list — reflection produced no findings at all',
    });
    return detections;
  }

  // Check for generic waiver reasons in no-action dispositions
  // Note: 'waived' is rejected by the pr-kaizen-clear gate (kaizen #198),
  // so we only check 'no-action' which is the current escape hatch
  for (const imp of impediments) {
    if (imp.disposition === 'no-action') {
      const reason = (imp.reason ?? imp.finding ?? '').toLowerCase();
      for (const blocked of GENERIC_WAIVER_BLOCKLIST) {
        if (reason.includes(blocked)) {
          detections.push({
            mode: FailureMode.REFLECTION_GAMING,
            confidence: 90,
            location: `impediment: "${truncate(imp.finding, 50)}"`,
            detail: `Generic waiver reason "${blocked}" — this pattern masks real friction. Filing ≠ implementing.`,
          });
          break;
        }
      }
    }
  }

  // Check for all-waived / all-no-action
  const actionable = impediments.filter(
    (i) => i.disposition === 'filed' || i.disposition === 'incident' || i.disposition === 'fixed-in-pr',
  );
  const avoided = impediments.filter(
    (i) => i.disposition === 'no-action',
  );

  if (actionable.length === 0 && avoided.length > 0) {
    detections.push({
      mode: FailureMode.REFLECTION_GAMING,
      confidence: 85,
      location: 'KAIZEN_IMPEDIMENTS',
      detail: `All ${avoided.length} findings are waived/no-action with zero filed — likely gaming the gate`,
    });
  } else if (
    impediments.length >= 3 &&
    avoided.length / impediments.length > 0.7
  ) {
    detections.push({
      mode: FailureMode.REFLECTION_GAMING,
      confidence: 70,
      location: 'KAIZEN_IMPEDIMENTS',
      detail: `${avoided.length}/${impediments.length} findings (${Math.round((avoided.length / impediments.length) * 100)}%) are waived/no-action — suspiciously high avoidance rate`,
    });
  }

  // Check for trivial findings (very short, no substance)
  for (const imp of impediments) {
    if (imp.finding.length < 15) {
      detections.push({
        mode: FailureMode.REFLECTION_GAMING,
        confidence: 60,
        location: `impediment: "${imp.finding}"`,
        detail: 'Finding is trivially short — may be placeholder to clear gate',
      });
    }
  }

  // Check for "filed" without actual issue reference
  for (const imp of impediments) {
    if (imp.disposition === 'filed' && !imp.ref) {
      detections.push({
        mode: FailureMode.REFLECTION_GAMING,
        confidence: 80,
        location: `impediment: "${truncate(imp.finding, 50)}"`,
        detail: 'Disposition is "filed" but no issue reference (ref) provided — may not actually be filed',
      });
    }
  }

  return detections;
}

/** Keywords that suggest an impediment is a trivial/config fix */
const TRIVIAL_FIX_SIGNALS = [
  'gitignore',
  '.gitignore',
  'tsconfig',
  'package.json',
  'typo',
  'rename',
  'unused import',
  'unused variable',
  'unused type',
  'missing comma',
  'missing semicolon',
  'duplicate line',
  'config',
  'formatting',
  'whitespace',
  'comment',
  'lint',
];

/**
 * FM8: Detect impediments filed as issues when they could have been fixed in-PR.
 *
 * Flags impediments with disposition "filed" whose description matches
 * trivial-fix signals (config changes, typos, small cleanup). These should
 * use "fixed-in-pr" instead — filing creates unnecessary context-reload cost.
 */
export function detectFiledWhenFixable(
  impediments: Impediment[],
): Detection[] {
  const detections: Detection[] = [];

  for (const imp of impediments) {
    if (imp.disposition !== 'filed') continue;

    const text = imp.finding.toLowerCase();
    for (const signal of TRIVIAL_FIX_SIGNALS) {
      if (text.includes(signal)) {
        detections.push({
          mode: FailureMode.FILED_WHEN_FIXABLE,
          confidence: 70,
          location: `impediment: "${truncate(imp.finding, 50)}"`,
          detail: `Filed as issue but description suggests trivial fix ("${signal}"). Could this have been fixed in < 10 min? Fix-first saves context-reload cost.`,
        });
        break;
      }
    }
  }

  return detections;
}

/**
 * Classify impediments by quality tier for reporting.
 */
export function classifyReflectionQuality(
  impediments: Impediment[],
): 'high' | 'medium' | 'low' | 'empty' {
  if (impediments.length === 0) return 'empty';

  const filed = impediments.filter(
    (i) => i.disposition === 'filed' && i.ref,
  ).length;
  const fixedInPr = impediments.filter(
    (i) => i.disposition === 'fixed-in-pr',
  ).length;
  const actionable = filed + fixedInPr;

  if (actionable >= 2) return 'high';
  if (actionable >= 1) return 'medium';
  return 'low';
}

