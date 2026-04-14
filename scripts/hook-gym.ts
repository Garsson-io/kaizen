#!/usr/bin/env npx tsx
/**
 * hook-gym.ts — Synthetic problem runner with hook observability.
 *
 * Usage:
 *   npx tsx scripts/hook-gym.ts --list
 *   npx tsx scripts/hook-gym.ts --run probe-hooks --host-repo Garsson-io/kaizen-test-fixture
 *   npx tsx scripts/hook-gym.ts --run probe-hooks --dry-run
 *   npx tsx scripts/hook-gym.ts --run-all --host-repo Garsson-io/kaizen-test-fixture
 *   npx tsx scripts/hook-gym.ts --validate-fixture <path> --scenario <name>
 */

import { SCENARIOS, getScenario, renderPrompt } from './hook-gym-scenarios.js';
import { SEVERITY_WEIGHT } from './hook-gym-schema.js';
import { validateFixtureFile, formatValidationReport } from './hook-gym-validate.js';
import { FixtureRepo, getHostRepo, type RunResult } from './hook-gym-harness.js';

function getFlag(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function cmdList(): void {
  console.log('Available scenarios:\n');
  const maxName = Math.max(...SCENARIOS.map((s) => s.name.length));
  for (const s of SCENARIOS) {
    const hookCount = s.expectedHooks.length;
    const gateCount = s.expectedGates.length;
    const totalWeight = s.expectedHooks.reduce(
      (sum, h) => sum + (SEVERITY_WEIGHT[h.severity] ?? 1), 0,
    );
    console.log(
      `  ${s.name.padEnd(maxName)}  ${s.model.padEnd(6)}  $${s.maxBudget.toFixed(2)}  ${s.timeoutSeconds}s  ${hookCount} hooks  ${gateCount} gates  weight=${totalWeight}`,
    );
    console.log(`  ${''.padEnd(maxName)}  ${s.description}`);
    console.log();
  }
  console.log(`Total: ${SCENARIOS.length} scenarios`);
}

function cmdDryRun(scenarioName: string, hostRepo: string): void {
  const scenario = getScenario(scenarioName);
  if (!scenario) {
    console.error(`Unknown scenario: ${scenarioName}`);
    console.error(`Available: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    process.exit(1);
  }
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rendered = renderPrompt(scenario.prompt, { timestamp: ts, host_repo: hostRepo });
  console.log(`=== Scenario: ${scenario.name} ===`);
  console.log(`Model: ${scenario.model} | Budget: $${scenario.maxBudget.toFixed(2)} | Timeout: ${scenario.timeoutSeconds}s`);
  console.log(`Host repo: ${hostRepo}\n`);
  console.log('--- Expected hooks ---');
  for (const h of scenario.expectedHooks) {
    console.log(`  [sev=${h.severity}] ${h.eventType.padEnd(14)} ${h.expectedDecision.padEnd(10)} ${h.description}`);
  }
  console.log('\n--- Expected gates ---');
  for (const g of scenario.expectedGates) {
    console.log(`  ${g.gate}: ${g.shouldActivate ? 'SET' : 'skip'} ${g.shouldClear ? '→ CLEAR' : '→ stays'}`);
  }
  console.log('\n--- Rendered prompt ---');
  console.log(rendered);
}

async function cmdRun(scenarioName: string, hostRepo: string, model?: string, debug?: boolean): Promise<void> {
  const scenario = getScenario(scenarioName);
  if (!scenario) {
    console.error(`Unknown scenario: ${scenarioName}`);
    console.error(`Available: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    process.exit(1);
  }

  const isSelf = hostRepo === getHostRepo();
  let result: RunResult;

  if (isSelf) {
    // Self-dogfood: run in CWD, no clone needed
    // TODO: implement self-dogfood path via harness
    console.error('Self-dogfood mode not yet supported via harness. Use --host-repo.');
    process.exit(1);
  }

  const fixture = await FixtureRepo.create(hostRepo);
  try {
    result = await fixture.run(scenario, { model, debug });
  } finally {
    await fixture.cleanup();
  }
  process.exit(result.passed ? 0 : 1);
}

async function cmdRunAll(hostRepo: string, model?: string, debug?: boolean): Promise<void> {
  const isSelf = hostRepo === getHostRepo();
  if (isSelf) {
    console.error('Self-dogfood mode not yet supported via harness. Use --host-repo.');
    process.exit(1);
  }

  const fixture = await FixtureRepo.create(hostRepo);
  let allPassed = true;
  const results: RunResult[] = [];

  try {
    for (const scenario of SCENARIOS) {
      const result = await fixture.run(scenario, { model, debug });
      results.push(result);
      if (!result.passed) allPassed = false;
    }
  } finally {
    await fixture.cleanup();
  }

  console.log('\n=== Summary ===\n');
  for (const r of results) {
    const status = r.passed ? '✅ PASS' : '❌ FAIL';
    console.log(`  ${r.scenario.padEnd(20)} ${status}  ${r.events.length} events  ${(r.durationMs / 1000).toFixed(1)}s`);
  }
  console.log(`\n${results.filter(r => r.passed).length}/${results.length} passed.`);
  process.exit(allPassed ? 0 : 1);
}

async function main(): Promise<void> {
  const model = getFlag('--model');
  const hostRepo = getFlag('--host-repo') ?? getHostRepo();
  const debug = hasFlag('--debug');

  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(`hook-gym — Synthetic problem runner with hook observability

Usage:
  npx tsx scripts/hook-gym.ts --list
  npx tsx scripts/hook-gym.ts --run <name> --host-repo <owner/repo>
  npx tsx scripts/hook-gym.ts --run <name> --dry-run
  npx tsx scripts/hook-gym.ts --run-all --host-repo <owner/repo>
  npx tsx scripts/hook-gym.ts --validate-fixture <path> --scenario <name>

Options:
  --model <model>    Override scenario model (haiku, sonnet, opus)
  --host-repo <r>    Target repo (default: kaizen.config.json)
  --debug            Print raw hook event JSON
  --dry-run          Show prompt without spawning agent`);
    process.exit(0);
  }

  if (hasFlag('--list')) { cmdList(); return; }

  const scenarioName = getFlag('--run');
  if (scenarioName) {
    if (hasFlag('--dry-run')) cmdDryRun(scenarioName, hostRepo);
    else await cmdRun(scenarioName, hostRepo, model, debug);
    return;
  }

  if (hasFlag('--run-all')) { await cmdRunAll(hostRepo, model, debug); return; }

  const fixturePath = getFlag('--validate-fixture');
  const scenarioForValidate = getFlag('--scenario');
  if (fixturePath && scenarioForValidate) {
    const scenario = getScenario(scenarioForValidate);
    if (!scenario) { console.error(`Unknown scenario: ${scenarioForValidate}`); process.exit(1); }
    const report = validateFixtureFile(fixturePath, scenario);
    console.log(formatValidationReport(report));
    process.exit(report.passed ? 0 : 1);
  }

  console.log('No command specified. Use --help for usage.');
  process.exit(1);
}

main();
