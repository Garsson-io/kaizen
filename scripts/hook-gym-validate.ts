/**
 * hook-gym-validate.ts — Validate a HookTimeline against a Scenario's ground truth.
 *
 * This is the "score what we parsed" step. Works on any HookTimeline regardless
 * of source — hand-written fixtures (for invariant validation before the live
 * runner exists), captured live logs (PR 3+), or replayed fixtures (PR 5).
 *
 * Decouples "did the right hooks fire with the right decisions" from
 * "how did we obtain the timeline in the first place".
 */

import { readFileSync } from 'node:fs';
import type {
  HookExpectation,
  GateExpectation,
  HookTimeline,
  ParsedHookEvent,
  Scenario,
  ConfusionPair,
  ExpectedDecision,
  HookDecision,
} from './hook-gym-schema.js';
import { SEVERITY_WEIGHT } from './hook-gym-schema.js';
import { parseLogFile } from './hook-gym-stream.js';

// ── Types ──────────────────────────────────────────────────────────

export interface HookMatchResult {
  expected: HookExpectation;
  /** Events whose hook_name or hook_event matches the expectation's pattern */
  candidates: ParsedHookEvent[];
  /** Whether at least one candidate satisfied the expected decision */
  matched: boolean;
  /** Decision actually observed (for failure reporting) */
  actualDecision: string;
  /** Human-readable miss reason when not matched */
  reason?: string;
}

export interface GateMatchResult {
  expected: GateExpectation;
  actuallyActivated: boolean;
  actuallyCleared: boolean;
  matched: boolean;
  reason?: string;
}

export interface ValidationReport {
  scenario: string;
  passed: boolean;

  hookResults: HookMatchResult[];
  gateResults: GateMatchResult[];

  hooksMatched: number;
  hooksTotal: number;
  gatesMatched: number;
  gatesTotal: number;

  /** Severity-3 hook mismatches — the gate-critical misses */
  criticalMisses: number;
  /** Weighted loss summed across all mismatches */
  totalLoss: number;
  /** Mismatches in compact (hook, expected, actual) form */
  confusionPairs: ConfusionPair[];
}

// ── Matching logic ─────────────────────────────────────────────────

/**
 * Does an event satisfy an expectation's decision?
 *
 * The expected decision maps to hook decisions as follows:
 *   - "fire"        → hook fired at all (exit_code 0, any decision)
 *   - "skip"        → hook did NOT fire (no candidate events exist)
 *   - "allow"       → decision = allow | none (non-denying)
 *   - "deny"        → decision = deny
 *   - "block"       → decision = block
 *   - "set-gate"    → decision = set-gate
 *   - "clear-gate"  → decision = clear-gate
 */
function decisionSatisfies(expected: ExpectedDecision, actual: HookDecision | null): boolean {
  switch (expected) {
    case 'fire':
      // Any actual firing satisfies. 'none' = fired cleanly with no explicit decision.
      return actual !== null;
    case 'skip':
      // Special case — handled at the caller level (no candidates)
      return false;
    case 'allow':
      return actual === 'allow' || actual === 'none';
    case 'deny':
      return actual === 'deny';
    case 'block':
      return actual === 'block';
    case 'set-gate':
      return actual === 'set-gate';
    case 'clear-gate':
      return actual === 'clear-gate';
  }
}

function findCandidates(
  events: ParsedHookEvent[],
  expectation: HookExpectation,
): ParsedHookEvent[] {
  return events.filter(
    (e) =>
      e.eventType === expectation.eventType &&
      e.hookName.includes(expectation.hookPattern),
  );
}

function evaluateHookExpectation(
  events: ParsedHookEvent[],
  expectation: HookExpectation,
): HookMatchResult {
  const candidates = findCandidates(events, expectation);

  // Skip means: NO matching event should exist
  if (expectation.expectedDecision === 'skip') {
    const matched = candidates.length === 0;
    return {
      expected: expectation,
      candidates,
      matched,
      actualDecision: candidates.length > 0 ? 'fired' : 'skipped',
      reason: matched
        ? undefined
        : `expected no ${expectation.eventType}/${expectation.hookPattern} event, but ${candidates.length} fired`,
    };
  }

  if (candidates.length === 0) {
    return {
      expected: expectation,
      candidates,
      matched: false,
      actualDecision: 'not-fired',
      reason: `no ${expectation.eventType} event matched pattern "${expectation.hookPattern}"`,
    };
  }

  // At least one candidate must satisfy the decision + optional gate check
  const satisfying = candidates.find((c) => {
    if (!decisionSatisfies(expectation.expectedDecision, c.decision)) return false;
    // For set-gate/clear-gate: also check the specific gate name
    if (expectation.expectedGate && c.reason !== expectation.expectedGate) return false;
    return true;
  });
  if (satisfying) {
    return {
      expected: expectation,
      candidates,
      matched: true,
      actualDecision: satisfying.decision ?? 'none',
    };
  }

  // Report the first candidate's decision as the "actual"
  const firstActual = candidates[0].decision ?? 'none';
  return {
    expected: expectation,
    candidates,
    matched: false,
    actualDecision: firstActual,
    reason: `expected ${expectation.expectedDecision}, got ${firstActual} (${candidates.length} candidate event(s))`,
  };
}

function evaluateGateExpectation(
  timeline: HookTimeline,
  expectation: GateExpectation,
): GateMatchResult {
  const actuallyActivated = expectation.gate in timeline.gatesActivated;
  const actuallyCleared = expectation.gate in timeline.gatesCleared;

  const activateMatch = actuallyActivated === expectation.shouldActivate;
  const clearMatch = expectation.clearNonDeterministic ? true : (actuallyCleared === expectation.shouldClear);
  const matched = activateMatch && clearMatch;

  let reason: string | undefined;
  if (!matched) {
    const parts: string[] = [];
    if (actuallyActivated !== expectation.shouldActivate) {
      parts.push(
        `activate expected ${expectation.shouldActivate}, got ${actuallyActivated}`,
      );
    }
    if (actuallyCleared !== expectation.shouldClear) {
      parts.push(
        `clear expected ${expectation.shouldClear}, got ${actuallyCleared}`,
      );
    }
    reason = parts.join('; ');
  }

  return {
    expected: expectation,
    actuallyActivated,
    actuallyCleared,
    matched,
    reason,
  };
}

// ── Main entry ─────────────────────────────────────────────────────

export function validateAgainstScenario(
  timeline: HookTimeline,
  scenario: Scenario,
): ValidationReport {
  const hookResults = scenario.expectedHooks.map((h) =>
    evaluateHookExpectation(timeline.events, h),
  );
  const gateResults = scenario.expectedGates.map((g) =>
    evaluateGateExpectation(timeline, g),
  );

  const hooksMatched = hookResults.filter((r) => r.matched).length;
  const gatesMatched = gateResults.filter((r) => r.matched).length;

  // Weighted loss: sum of (weight) over mismatched hook expectations
  let totalLoss = 0;
  const confusionPairs: ConfusionPair[] = [];
  let criticalMisses = 0;

  for (const r of hookResults) {
    if (!r.matched) {
      const weight = SEVERITY_WEIGHT[r.expected.severity] ?? 1;
      totalLoss += weight;
      confusionPairs.push({
        hook: `${r.expected.eventType}/${r.expected.hookPattern}`,
        expected: r.expected.expectedDecision,
        actual: r.actualDecision,
        severity: r.expected.severity,
      });
      if (r.expected.severity >= 3) criticalMisses += 1;
    }
  }

  // Gate mismatches add to loss (treat as severity 3 since gates are
  // the whole point of the review/reflect lifecycle).
  for (const r of gateResults) {
    if (!r.matched) {
      totalLoss += SEVERITY_WEIGHT[3];
      criticalMisses += 1;
      confusionPairs.push({
        hook: `gate:${r.expected.gate}`,
        expected: `activate=${r.expected.shouldActivate}, clear=${r.expected.shouldClear}`,
        actual: `activate=${r.actuallyActivated}, clear=${r.actuallyCleared}`,
        severity: 3,
      });
    }
  }

  const passed =
    hooksMatched === hookResults.length &&
    gatesMatched === gateResults.length;

  return {
    scenario: scenario.name,
    passed,
    hookResults,
    gateResults,
    hooksMatched,
    hooksTotal: hookResults.length,
    gatesMatched,
    gatesTotal: gateResults.length,
    criticalMisses,
    totalLoss,
    confusionPairs,
  };
}

// ── Fixture loading ────────────────────────────────────────────────

/**
 * Load a fixture file and produce a HookTimeline.
 *
 * Accepts either:
 *   - A stream-json log (newline-delimited JSON) as produced by
 *     `claude -p --include-hook-events --output-format stream-json --verbose`
 *   - A JSON array of events in the same format (more convenient for
 *     hand-written invariant fixtures)
 */
export function loadFixture(fixturePath: string): HookTimeline {
  const raw = readFileSync(fixturePath, 'utf-8').trim();

  if (raw.startsWith('[')) {
    // JSON array form — wrap each event as a stream-json line
    const events = JSON.parse(raw) as Record<string, any>[];
    const nld = events.map((e) => JSON.stringify(e)).join('\n');
    return parseLogFile(nld);
  }

  // Stream-json (newline-delimited) form
  return parseLogFile(raw);
}

/**
 * Convenience: load a fixture, validate against a scenario, return the report.
 */
export function validateFixtureFile(
  fixturePath: string,
  scenario: Scenario,
): ValidationReport {
  const timeline = loadFixture(fixturePath);
  return validateAgainstScenario(timeline, scenario);
}

// ── Reporting ──────────────────────────────────────────────────────

export function formatValidationReport(report: ValidationReport): string {
  const lines: string[] = [];
  const verdict = report.passed ? '✅ PASS' : '❌ FAIL';
  lines.push(
    `=== Hook Gym Validation: ${report.scenario} — ${verdict} ===`,
  );
  lines.push(
    `Hooks: ${report.hooksMatched}/${report.hooksTotal} matched | ` +
      `Gates: ${report.gatesMatched}/${report.gatesTotal} matched | ` +
      `Critical misses: ${report.criticalMisses} | ` +
      `Loss: ${report.totalLoss}`,
  );
  lines.push('');
  lines.push('--- Hook expectations ---');
  for (const r of report.hookResults) {
    const mark = r.matched ? '✓' : '✗';
    const line = `  ${mark} [sev=${r.expected.severity}] ${r.expected.eventType}/${r.expected.hookPattern} → expected ${r.expected.expectedDecision}, got ${r.actualDecision}`;
    lines.push(line);
    if (r.reason && !r.matched) lines.push(`      ${r.reason}`);
  }
  lines.push('');
  lines.push('--- Gate expectations ---');
  for (const r of report.gateResults) {
    const mark = r.matched ? '✓' : '✗';
    lines.push(
      `  ${mark} ${r.expected.gate} — activate=${r.expected.shouldActivate} clear=${r.expected.shouldClear}`,
    );
    if (r.reason && !r.matched) lines.push(`      ${r.reason}`);
  }
  if (report.confusionPairs.length > 0) {
    lines.push('');
    lines.push('--- Confusion pairs ---');
    for (const cp of report.confusionPairs) {
      lines.push(
        `  [sev=${cp.severity}] ${cp.hook}: expected ${cp.expected}, got ${cp.actual}`,
      );
    }
  }
  return lines.join('\n');
}
