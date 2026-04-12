#!/usr/bin/env npx tsx
/**
 * hook-gym.ts — Synthetic problem runner with hook observability.
 *
 * Spawns cheap agents (haiku/sonnet) on simple synthetic problems
 * with --include-hook-events to capture full hook lifecycle.
 *
 * Usage:
 *   npx tsx scripts/hook-gym.ts --list
 *   npx tsx scripts/hook-gym.ts --run probe-hooks --dry-run
 *   npx tsx scripts/hook-gym.ts --run probe-hooks
 *   npx tsx scripts/hook-gym.ts --run-all
 *   npx tsx scripts/hook-gym.ts --replay <log-file>
 *
 * See docs/hook-gym-spec.md for full design.
 */

import { execSync } from 'node:child_process';
import { SCENARIOS, getScenario, renderPrompt } from './hook-gym-scenarios.js';
import type { Scenario } from './hook-gym-schema.js';
import { SEVERITY_WEIGHT } from './hook-gym-schema.js';

// ── CLI helpers ────────────────────────────────────────────────────

function getFlag(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

// ── Config ─────────────────────────────────────────────────────────

function getHostRepo(): string {
  try {
    return execSync('jq -r ".host.repo" kaizen.config.json', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'Garsson-io/kaizen';
  }
}

// ── Commands ───────────────────────────────────────────────────────

function cmdList(): void {
  console.log('Available scenarios:\n');
  const maxName = Math.max(...SCENARIOS.map((s) => s.name.length));

  for (const s of SCENARIOS) {
    const hookCount = s.expectedHooks.length;
    const gateCount = s.expectedGates.length;
    const totalWeight = s.expectedHooks.reduce(
      (sum, h) => sum + (SEVERITY_WEIGHT[h.severity] ?? 1),
      0,
    );

    console.log(
      `  ${s.name.padEnd(maxName)}  ${s.model.padEnd(6)}  $${s.maxBudget.toFixed(2)}  ${s.timeoutSeconds}s  ${hookCount} hooks  ${gateCount} gates  weight=${totalWeight}`,
    );
    console.log(`  ${''.padEnd(maxName)}  ${s.description}`);
    console.log();
  }

  console.log(`Total: ${SCENARIOS.length} scenarios`);
}

function cmdDryRun(scenarioName: string): void {
  const scenario = getScenario(scenarioName);
  if (!scenario) {
    console.error(`Unknown scenario: ${scenarioName}`);
    console.error(`Available: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    process.exit(1);
  }

  const hostRepo = getHostRepo();
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  const rendered = renderPrompt(scenario.prompt, {
    timestamp,
    host_repo: hostRepo,
  });

  console.log(`=== Scenario: ${scenario.name} ===`);
  console.log(`Model: ${scenario.model}`);
  console.log(`Budget: $${scenario.maxBudget.toFixed(2)}`);
  console.log(`Timeout: ${scenario.timeoutSeconds}s`);
  console.log(`Host repo: ${hostRepo}`);
  console.log();
  console.log('--- Expected hooks ---');
  for (const h of scenario.expectedHooks) {
    const w = SEVERITY_WEIGHT[h.severity] ?? 1;
    console.log(
      `  [sev=${h.severity} w=${w}] ${h.eventType.padEnd(14)} ${h.expectedDecision.padEnd(10)} ${h.description}`,
    );
  }
  console.log();
  console.log('--- Expected gates ---');
  for (const g of scenario.expectedGates) {
    const activate = g.shouldActivate ? 'SET' : 'skip';
    const clear = g.shouldClear ? '→ CLEAR' : '→ stays';
    console.log(`  ${g.gate}: ${activate} ${clear}`);
  }
  console.log();
  console.log('--- Rendered prompt ---');
  console.log(rendered);
}

function cmdRun(scenarioName: string): void {
  console.log(`\n[hook-gym] Live run not yet implemented (PR 3).`);
  console.log(`[hook-gym] Use --dry-run to see the prompt.\n`);
  process.exit(0);
}

function cmdRunAll(): void {
  console.log(`\n[hook-gym] Run-all not yet implemented (PR 3).`);
  console.log(`[hook-gym] Use --list to see available scenarios.\n`);
  process.exit(0);
}

function cmdReplay(logPath: string): void {
  console.log(`\n[hook-gym] Replay not yet implemented (PR 5).`);
  process.exit(0);
}

// ── Main ───────────────────────────────────────────────────────────

function main(): void {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(`hook-gym — Synthetic problem runner with hook observability

Usage:
  npx tsx scripts/hook-gym.ts --list                    List scenarios
  npx tsx scripts/hook-gym.ts --run <name> --dry-run    Show rendered prompt
  npx tsx scripts/hook-gym.ts --run <name>              Run scenario (live)
  npx tsx scripts/hook-gym.ts --run-all                 Run all scenarios
  npx tsx scripts/hook-gym.ts --replay <log>            Replay captured log

Options:
  --model <model>    Override scenario model (haiku, sonnet, opus)
  --debug            Print raw hook event JSON
  --dry-run          Show prompt without spawning agent

See docs/hook-gym-spec.md for full design.`);
    process.exit(0);
  }

  if (hasFlag('--list')) {
    cmdList();
    return;
  }

  const scenarioName = getFlag('--run');
  if (scenarioName) {
    if (hasFlag('--dry-run')) {
      cmdDryRun(scenarioName);
    } else {
      cmdRun(scenarioName);
    }
    return;
  }

  if (hasFlag('--run-all')) {
    cmdRunAll();
    return;
  }

  const logPath = getFlag('--replay');
  if (logPath) {
    cmdReplay(logPath);
    return;
  }

  // No command — show help
  console.log('No command specified. Use --help for usage.');
  process.exit(1);
}

main();
