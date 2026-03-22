/**
 * run-scenarios.ts — Autoresearch experiment runner.
 *
 * Runs all failure mode detectors against synthetic scenarios and produces
 * an ExperimentReport with detection rates and false positive rates.
 *
 * This is the core of the "hypothesis -> experiment -> measure" loop:
 * - Hypothesis: "FM-X can be detected by checking for pattern Y"
 * - Experiment: run detector Y against known-bad and known-good scenarios
 * - Measure: detection rate on bad, false positive rate on good
 */

import {
  type Scenario,
  type DiffScenario,
  type ReflectionScenario,
  type PRHistoryScenario,
  type ScenarioResult,
  type ExperimentReport,
  type Detection,
  FailureMode,
} from './types.js';
import {
  detectDryViolations,
  detectStaleReferences,
  detectEnvAssumptions,
  detectScopeCutTestability,
} from './diff-checks.js';
import { detectReflectionGaming, detectFiledWhenFixable } from './reflection-checks.js';
import { detectMultiPRCycles } from './pr-pattern-checks.js';

/**
 * Run a single scenario through the appropriate detectors.
 */
export function runScenario(scenario: Scenario): ScenarioResult {
  const detections = detectForScenario(scenario);
  const relevant = detections.filter((d) => d.mode === scenario.targetMode);
  const detected = relevant.length > 0;

  return {
    scenario,
    detections,
    passed: scenario.expectDetection ? detected : !detected,
  };
}

/**
 * Run all scenarios and produce an experiment report.
 */
export function runExperiment(scenarios: Scenario[]): ExperimentReport {
  const results = scenarios.map(runScenario);

  // Compute detection rates per failure mode (from expectDetection=true scenarios)
  const detectionRate = computeRates(
    results.filter((r) => r.scenario.expectDetection),
  );

  // Compute false positive rates (from expectDetection=false scenarios)
  const falsePositiveRate = computeRates(
    results.filter((r) => !r.scenario.expectDetection),
    true,
  );

  return {
    timestamp: new Date().toISOString(),
    scenarios: results,
    detectionRate,
    falsePositiveRate,
  };
}

function detectForScenario(scenario: Scenario): Detection[] {
  switch (scenario.kind) {
    case 'diff': {
      const s = scenario as DiffScenario;
      return [
        ...detectDryViolations(s.files),
        ...detectStaleReferences(s.files, s.renamedSymbols ?? []),
        ...detectEnvAssumptions(s.files),
        ...detectScopeCutTestability(s.files),
      ];
    }
    case 'reflection': {
      const s = scenario as ReflectionScenario;
      return [
        ...detectReflectionGaming(s.impediments),
        ...detectFiledWhenFixable(s.impediments),
      ];
    }
    case 'pr-history': {
      const s = scenario as PRHistoryScenario;
      return detectMultiPRCycles(s.prs);
    }
  }
}

function computeRates(
  results: ScenarioResult[],
  isFalsePositive = false,
): Record<FailureMode, { caught: number; total: number; rate: number }> {
  const rates: Record<
    string,
    { caught: number; total: number; rate: number }
  > = {};

  for (const fm of Object.values(FailureMode)) {
    const matching = results.filter((r) => r.scenario.targetMode === fm);
    if (matching.length === 0) {
      rates[fm] = { caught: 0, total: 0, rate: 0 };
      continue;
    }

    const caught = isFalsePositive
      ? matching.filter((r) => !r.passed).length // false positives = scenarios that incorrectly detected
      : matching.filter((r) => r.passed).length; // true positives = correctly detected

    rates[fm] = {
      caught,
      total: matching.length,
      rate: matching.length > 0 ? caught / matching.length : 0,
    };
  }

  return rates as Record<
    FailureMode,
    { caught: number; total: number; rate: number }
  >;
}

/**
 * Format an experiment report as markdown for posting to GitHub issues.
 */
export function formatReport(report: ExperimentReport): string {
  const lines: string[] = [
    `## Failure Mode Detection Report`,
    ``,
    `Generated: ${report.timestamp}`,
    `Scenarios run: ${report.scenarios.length}`,
    ``,
    `### Detection Rates (true positives)`,
    ``,
    `| Failure Mode | Caught | Total | Rate |`,
    `|-------------|--------|-------|------|`,
  ];

  for (const [fm, rate] of Object.entries(report.detectionRate)) {
    if (rate.total > 0) {
      lines.push(
        `| ${fm} | ${rate.caught} | ${rate.total} | ${Math.round(rate.rate * 100)}% |`,
      );
    }
  }

  lines.push(``, `### False Positive Rates`, ``, `| Failure Mode | Flagged | Total Clean | Rate |`, `|-------------|---------|-------------|------|`);

  for (const [fm, rate] of Object.entries(report.falsePositiveRate)) {
    if (rate.total > 0) {
      lines.push(
        `| ${fm} | ${rate.caught} | ${rate.total} | ${Math.round(rate.rate * 100)}% |`,
      );
    }
  }

  const failures = report.scenarios.filter((s) => !s.passed);
  if (failures.length > 0) {
    lines.push(``, `### Failed Scenarios`, ``);
    for (const f of failures) {
      lines.push(
        `- **${f.scenario.name}** (${f.scenario.targetMode}): expected ${f.scenario.expectDetection ? 'detection' : 'clean'}, got ${f.detections.length} detections`,
      );
    }
  }

  return lines.join('\n');
}
