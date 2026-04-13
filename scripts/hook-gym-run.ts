/**
 * hook-gym-run.ts — Live runner: spawns claude -p with --include-hook-events,
 * captures the stream, produces a HookTimeline, validates it against the
 * scenario's ground truth, and writes output files.
 *
 * Design notes:
 * - Subprocess spawning is injectable via RunOptions.spawn for unit-testability.
 *   The default is child_process.spawn.
 * - I/O is done through an injectable writer interface for the same reason.
 * - Budget tracking is advisory (soft warning, not kill) — we already paid.
 * - Timeout enforcement kills the child process after scenario.timeoutSeconds.
 */

import { spawn as realSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HookTimeline, Scenario } from './hook-gym-schema.js';
import { createHookStreamProcessor, parseLogFile } from './hook-gym-stream.js';
import { renderPrompt, getScenario, SCENARIOS } from './hook-gym-scenarios.js';
import { validateFixtureFile, validateAgainstScenario, formatValidationReport, type ValidationReport } from './hook-gym-validate.js';
import { formatTimeline, summarizeTimeline } from './hook-gym-format.js';

export interface RunResult {
  scenario: string;
  passed: boolean;
  timeline: HookTimeline;
  validation: ValidationReport;
  selfCheckPassed: boolean;
  timedOut: boolean;
  budgetExceeded: boolean;
  durationMs: number;
  outDir: string;
  streamLines: string[];
}

export interface RunOptions {
  /** Override subprocess spawner (for unit tests). */
  spawn?: typeof realSpawn;
  /** Override output root (for unit tests). Default: `.hook-gym/runs`. */
  outRoot?: string;
  /** Override host repo (for unit tests). */
  hostRepo?: string;
  /** Override model (--model CLI flag). */
  modelOverride?: string;
  /** Print raw hook event JSON to stderr (--debug flag). */
  debug?: boolean;
  /** Logger for status messages. Default: console.log. */
  log?: (...args: unknown[]) => void;
}

function getHostRepo(): string {
  try {
    const config = JSON.parse(readFileSync('kaizen.config.json', 'utf-8'));
    return config?.host?.repo ?? 'Garsson-io/kaizen';
  } catch {
    return 'Garsson-io/kaizen';
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/**
 * Run a single scenario live. Spawns `claude -p`, captures the hook-event
 * stream, validates against ground truth, writes output files.
 */
export async function runScenario(
  scenario: Scenario,
  opts: RunOptions = {},
): Promise<RunResult> {
  const spawnFn = opts.spawn ?? realSpawn;
  const outRoot = opts.outRoot ?? '.hook-gym/runs';
  const hostRepo = opts.hostRepo ?? getHostRepo();
  const model = opts.modelOverride ?? scenario.model;
  const log = opts.log ?? console.log;
  const debug = opts.debug ?? false;

  const ts = timestamp();
  const outDir = resolve(outRoot, `${ts}-${scenario.name}`);
  mkdirSync(outDir, { recursive: true });

  const rendered = renderPrompt(scenario.prompt, {
    timestamp: ts,
    host_repo: hostRepo,
  });

  log(`[hook-gym] Running scenario: ${scenario.name} (model=${model}, timeout=${scenario.timeoutSeconds}s, budget=$${scenario.maxBudget.toFixed(2)})`);

  const streamLines: string[] = [];
  const processor = createHookStreamProcessor();
  const startMs = Date.now();

  const result = await new Promise<{ timedOut: boolean; exitCode: number }>((resolve) => {
    const args = [
      '-p', rendered,
      '--model', model,
      '--output-format', 'stream-json',
      '--include-hook-events',
      '--max-turns', '50',
      '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep',
    ];

    const child: ChildProcess = spawnFn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    } as SpawnOptions);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`[hook-gym] Timeout (${scenario.timeoutSeconds}s) — killing subprocess.`);
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
    }, scenario.timeoutSeconds * 1000);

    let stdoutBuf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, newlineIdx).trim();
        stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
        if (!line) continue;
        streamLines.push(line);
        try {
          const msg = JSON.parse(line);
          const wasHook = processor.process(msg);
          if (wasHook && debug) {
            process.stderr.write(`[hook-event] ${line}\n`);
          }
        } catch {
          // Non-JSON line (e.g. stderr mixed in) — skip.
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (debug) process.stderr.write(chunk);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ timedOut, exitCode: code ?? 1 });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      log(`[hook-gym] Spawn error: ${err.message}`);
      resolve({ timedOut, exitCode: 1 });
    });
  });

  const durationMs = Date.now() - startMs;
  const timeline = processor.getTimeline();

  log(`[hook-gym] Finished in ${(durationMs / 1000).toFixed(1)}s — ${timeline.events.length} hook events captured.`);

  // Validate against ground truth
  const validation = validateAgainstScenario(timeline, scenario);

  // Budget check (advisory)
  const budgetExceeded = false; // TODO: parse cost from stream when Claude CLI exposes it

  // Write output files
  writeFileSync(join(outDir, 'stream.jsonl'), streamLines.join('\n') + '\n');
  writeFileSync(join(outDir, 'timeline.md'), formatTimeline(timeline));
  writeFileSync(join(outDir, 'result.json'), JSON.stringify({
    scenario: scenario.name,
    model,
    durationMs,
    timedOut: result.timedOut,
    budgetExceeded,
    exitCode: result.exitCode,
    hookEventCount: timeline.events.length,
    validation: {
      passed: validation.passed,
      hookMatches: validation.hookResults.length,
      gateMatches: validation.gateResults.length,
    },
    timeline,
  }, null, 2) + '\n');

  log(`[hook-gym] Output written to ${outDir}`);

  // Self-check: re-validate from the just-written fixture
  let selfCheckPassed = false;
  try {
    const replayReport = validateFixtureFile(join(outDir, 'stream.jsonl'), scenario);
    selfCheckPassed = replayReport.passed === validation.passed;
    if (!selfCheckPassed) {
      log(`[hook-gym] ⚠ Self-check MISMATCH: live=${validation.passed}, replay=${replayReport.passed}`);
    } else {
      log(`[hook-gym] Self-check: fixture replay matches live verdict (${validation.passed ? 'PASS' : 'FAIL'}).`);
    }
  } catch (err) {
    log(`[hook-gym] Self-check failed to run: ${err instanceof Error ? err.message : err}`);
  }

  const passed = validation.passed && !result.timedOut && !budgetExceeded && selfCheckPassed;

  // Print validation report
  log('');
  log(formatValidationReport(validation));
  log(summarizeTimeline(scenario.name, timeline));

  if (result.timedOut) log(`[hook-gym] ❌ TIMEOUT after ${scenario.timeoutSeconds}s`);
  if (budgetExceeded) log(`[hook-gym] ❌ BUDGET EXCEEDED ($${scenario.maxBudget.toFixed(2)})`);
  if (!selfCheckPassed) log(`[hook-gym] ❌ SELF-CHECK FAILED (fixture replay disagrees with live verdict)`);

  return {
    scenario: scenario.name,
    passed,
    timeline,
    validation,
    selfCheckPassed,
    timedOut: result.timedOut,
    budgetExceeded,
    durationMs,
    outDir,
    streamLines,
  };
}

/**
 * Run all scenarios serially, print a summary table, exit non-zero on any fail.
 */
export async function runAll(
  scenarios: Scenario[] = SCENARIOS,
  opts: RunOptions = {},
): Promise<{ results: RunResult[]; allPassed: boolean }> {
  const log = opts.log ?? console.log;
  const results: RunResult[] = [];

  log(`[hook-gym] Running ${scenarios.length} scenarios...\n`);

  for (const scenario of scenarios) {
    const result = await runScenario(scenario, opts);
    results.push(result);
    log('');
  }

  // Summary table
  log('=== Hook Gym Summary ===\n');
  const maxName = Math.max(...results.map((r) => r.scenario.length));
  for (const r of results) {
    const status = r.passed ? '✅ PASS' : '❌ FAIL';
    const events = `${r.timeline.events.length} events`;
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
    const flags = [
      r.timedOut ? 'TIMEOUT' : '',
      r.budgetExceeded ? 'BUDGET' : '',
      !r.selfCheckPassed ? 'SELF-CHECK' : '',
    ].filter(Boolean).join(', ');
    const flagStr = flags ? ` (${flags})` : '';
    log(`  ${r.scenario.padEnd(maxName)}  ${status}  ${events}  ${dur}${flagStr}`);
  }

  const allPassed = results.every((r) => r.passed);
  const passCount = results.filter((r) => r.passed).length;
  log(`\n${passCount}/${results.length} scenarios passed.`);

  return { results, allPassed };
}
