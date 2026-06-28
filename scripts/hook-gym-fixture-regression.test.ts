/**
 * hook-gym-fixture-regression.test.ts — CI-ready regression tests ($0).
 *
 * Validates all fixture files against their scenario ground truth.
 * This is the score-only replay layer: no hooks fire, no LLM cost.
 * Deterministic and fast — runs in CI on every PR.
 *
 * When hooks change, fixtures may need updating. Run live scenarios
 * with `--run` to capture new fixtures, then update the fixture files.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateFixtureFile } from './hook-gym-validate.js';
import { getScenario, INVARIANT_SCENARIOS } from './hook-gym-scenarios.js';
import { extractToolActionsFromFile } from './hook-gym-replay.js';

const FIXTURES_DIR = resolve(__dirname, '..', 'fixtures');

// ── Invariant fixture regression ──────────────────────────────────

describe('invariant fixture regression', () => {
  const invariantDir = join(FIXTURES_DIR, 'invariants');

  // Map fixture files to their scenario names
  const fixtureMap: Array<{ fixture: string; scenario: string }> = [
    { fixture: 'i1-deny-missing-closes.json', scenario: 'invariant-i1-deny-missing-closes' },
    { fixture: 'i3-deny-no-testplan.json', scenario: 'invariant-i3-deny-no-testplan' },
    { fixture: 'i8-deny-no-plan.json', scenario: 'invariant-i8-deny-no-plan' },
    { fixture: 'i27-deny-untracked-deferral.json', scenario: 'invariant-i27-deny-untracked-deferral' },
    { fixture: 'i28-deny-missing-dimension.json', scenario: 'invariant-i28-deny-missing-dimension' },
    { fixture: 'i26-deny-branch-from-feature.json', scenario: 'invariant-i26-deny-branch-from-feature' },
  ];

  for (const { fixture, scenario: scenarioName } of fixtureMap) {
    it(`${fixture} validates against ${scenarioName}`, () => {
      const fixturePath = join(invariantDir, fixture);
      expect(existsSync(fixturePath), `Fixture not found: ${fixturePath}`).toBe(true);

      const scenario = getScenario(scenarioName);
      expect(scenario, `Scenario not found: ${scenarioName}`).toBeDefined();

      const report = validateFixtureFile(fixturePath, scenario!);
      expect(report.passed, `Validation failed:\n${formatFailure(report)}`).toBe(true);
      expect(report.criticalMisses).toBe(0);
    });
  }

  it('all invariant fixture files have a matching scenario', () => {
    if (!existsSync(invariantDir)) return;
    const files = readdirSync(invariantDir).filter(f => f.endsWith('.json'));
    const mapped = fixtureMap.map(m => m.fixture);
    for (const file of files) {
      expect(mapped, `Unmapped fixture: ${file} — add it to fixtureMap`).toContain(file);
    }
  });

  it('all invariant scenarios have a matching fixture', () => {
    for (const scenario of INVARIANT_SCENARIOS) {
      const expected = fixtureMap.find(m => m.scenario === scenario.name);
      // Some invariant scenarios may not have fixtures yet (e.g., i24)
      // This is informational, not a hard failure
      if (!expected) {
        console.warn(`No fixture for scenario: ${scenario.name} — add one to fixtures/invariants/`);
      }
    }
  });
});

// ── Live fixture regression ───────────────────────────────────────

describe('live fixture regression', () => {
  const liveDir = join(FIXTURES_DIR, 'live');

  it('probe-hooks.jsonl exists and is parseable', () => {
    const fixturePath = join(liveDir, 'probe-hooks.jsonl');
    if (!existsSync(fixturePath)) {
      console.warn('No live fixture yet — run `hook-gym --run probe-hooks` to capture one');
      return;
    }

    // Validate against probe-hooks scenario
    const scenario = getScenario('probe-hooks');
    expect(scenario).toBeDefined();

    const report = validateFixtureFile(fixturePath, scenario!);
    // Live fixtures may not pass validation (hooks may have changed since capture)
    // but they must parse without errors
    expect(report.hooksTotal).toBeGreaterThan(0);
  });

  it('probe-hooks.jsonl contains extractable tool actions', () => {
    const fixturePath = join(liveDir, 'probe-hooks.jsonl');
    if (!existsSync(fixturePath)) return;

    const actions = extractToolActionsFromFile(fixturePath);
    // Live runs always have tool actions (the agent uses tools)
    expect(actions.length).toBeGreaterThan(0);
    // Every action has a tool name
    for (const action of actions) {
      expect(action.tool).toBeTruthy();
      expect(typeof action.index).toBe('number');
    }
  });
});

// ── Cross-check: score-only replay is deterministic ───────────────

describe('score-only determinism', () => {
  const invariantDir = join(FIXTURES_DIR, 'invariants');

  it('validates same fixture twice with identical results', () => {
    const fixturePath = join(invariantDir, 'i1-deny-missing-closes.json');
    if (!existsSync(fixturePath)) return;

    const scenario = getScenario('invariant-i1-deny-missing-closes')!;
    const report1 = validateFixtureFile(fixturePath, scenario);
    const report2 = validateFixtureFile(fixturePath, scenario);

    expect(report1.passed).toBe(report2.passed);
    expect(report1.hooksMatched).toBe(report2.hooksMatched);
    expect(report1.gatesMatched).toBe(report2.gatesMatched);
    expect(report1.totalLoss).toBe(report2.totalLoss);
    expect(report1.criticalMisses).toBe(report2.criticalMisses);
    expect(report1.confusionPairs).toEqual(report2.confusionPairs);
  });
});

// ── Helpers ───────────────────────────────────────────────────────

function formatFailure(report: { hookResults: Array<{ matched: boolean; expected: { hookPattern: string; expectedDecision: string }; actualDecision: string; reason?: string }>; gateResults: Array<{ matched: boolean; expected: { gate: string }; reason?: string }> }): string {
  const lines: string[] = [];
  for (const r of report.hookResults) {
    if (!r.matched) {
      lines.push(`  Hook ${r.expected.hookPattern}: expected ${r.expected.expectedDecision}, got ${r.actualDecision}${r.reason ? ` (${r.reason})` : ''}`);
    }
  }
  for (const r of report.gateResults) {
    if (!r.matched) {
      lines.push(`  Gate ${r.expected.gate}: ${r.reason ?? 'mismatch'}`);
    }
  }
  return lines.join('\n');
}
