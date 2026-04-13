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
 * - For non-self-dogfood repos, the runner auto-clones the host repo into a
 *   temp dir so the spawned agent's git/gh operations target the right remote.
 */

import { spawn as realSpawn, execSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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
  /**
   * Override cwd for the spawned claude process.
   * - undefined (default): auto-clone for non-self-dogfood repos, inherit cwd otherwise.
   * - null: skip auto-clone, inherit cwd (for unit tests with mocked spawn).
   * - string: use that directory directly.
   */
  cwd?: string | null;
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
 * Clone the host repo into a temp dir and install kaizen hooks for subprocess
 * isolation. The spawned agent runs in this temp dir so its git push / gh pr
 * create target the right remote, and kaizen hooks are active (symlinked from
 * the current kaizen repo so we test the *current* hooks, not a stale install).
 *
 * Returns the temp dir path on success, undefined on failure.
 */
function cloneAndSetup(
  hostRepo: string,
  scenarioName: string,
  log: (...args: unknown[]) => void,
): string | undefined {
  const dir = join(tmpdir(), `hook-gym-${scenarioName}-${Date.now()}`);
  log(`[hook-gym] Cloning ${hostRepo} into temp dir for isolation...`);
  try {
    execSync(
      `git clone --depth 1 "https://github.com/${hostRepo}.git" "${dir}"`,
      { stdio: 'pipe', timeout: 30_000 },
    );
  } catch (err) {
    log(`[hook-gym] Clone failed: ${err instanceof Error ? err.message : err}`);
    log(`[hook-gym] Falling back to current directory (agent may target wrong repo).`);
    return undefined;
  }

  // Install kaizen hooks via symlinks from the current kaizen repo.
  // This ensures the spawned agent tests the *current* hooks (from this
  // worktree), not whatever version was last installed as a plugin.
  const kaizenRoot = resolve(__dirname, '..');
  try {
    // Symlink .claude/hooks → kaizen's hooks
    mkdirSync(join(dir, '.claude'), { recursive: true });
    execSync(`ln -sf "${kaizenRoot}/.claude/hooks" "${join(dir, '.claude/hooks')}"`, { stdio: 'pipe' });

    // Symlink .claude-plugin → kaizen's plugin manifest (hooks reference ${CLAUDE_PLUGIN_ROOT})
    execSync(`ln -sf "${kaizenRoot}/.claude-plugin" "${join(dir, '.claude-plugin')}"`, { stdio: 'pipe' });

    // Symlink node_modules + dist so TS hooks can find their compiled output
    execSync(`ln -sf "${kaizenRoot}/node_modules" "${join(dir, 'node_modules')}"`, { stdio: 'pipe' });
    if (existsSync(join(kaizenRoot, 'dist'))) {
      execSync(`ln -sf "${kaizenRoot}/dist" "${join(dir, 'dist')}"`, { stdio: 'pipe' });
    }

    // Copy settings.json if it exists (project-level hook registrations)
    const settingsSrc = join(kaizenRoot, '.claude', 'settings.json');
    if (existsSync(settingsSrc)) {
      mkdirSync(join(dir, '.claude'), { recursive: true });
      execSync(`cp "${settingsSrc}" "${join(dir, '.claude/settings.json')}"`, { stdio: 'pipe' });
    }

    log(`[hook-gym] Hooks installed in temp clone (symlinked from ${kaizenRoot})`);
  } catch (err) {
    log(`[hook-gym] Hook setup failed: ${err instanceof Error ? err.message : err}`);
    log(`[hook-gym] Hooks may not fire in the spawned agent.`);
  }

  log(`[hook-gym] Clone ready at ${dir}`);
  return dir;
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

  // Determine cwd for the spawned agent.
  // For non-self-dogfood repos, auto-clone into a temp dir so the agent's
  // git push / gh pr create target the right remote and don't pollute the
  // kaizen repo's working tree.
  let agentCwd: string | undefined;
  let tempCloneDir: string | undefined;
  const isSelfDogfood = hostRepo === getHostRepo();

  if (opts.cwd === null) {
    // Explicit null = skip auto-clone (unit tests with mocked spawn).
    agentCwd = undefined;
  } else if (opts.cwd) {
    // Explicit path = use directly.
    agentCwd = opts.cwd;
  } else if (!isSelfDogfood) {
    // Auto-clone the host repo + install kaizen hooks for isolation.
    tempCloneDir = cloneAndSetup(hostRepo, scenario.name, log);
    agentCwd = tempCloneDir;
  }
  // else: self-dogfood — run in CWD (the kaizen repo itself), hooks present.

  log(`[hook-gym] Running scenario: ${scenario.name} (model=${model}, timeout=${scenario.timeoutSeconds}s, budget=$${scenario.maxBudget.toFixed(2)}, cwd=${agentCwd ?? 'inherited'})`);

  const streamLines: string[] = [];
  const processor = createHookStreamProcessor();
  const startMs = Date.now();

  const result = await new Promise<{ timedOut: boolean; exitCode: number }>((resolve) => {
    const args = [
      '-p', rendered,
      '--model', model,
      '--verbose',
      '--output-format', 'stream-json',
      '--include-hook-events',
      '--max-turns', '50',
      '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep',
    ];

    const child: ChildProcess = spawnFn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      ...(agentCwd ? { cwd: agentCwd } : {}),
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

  // Clean up temp clone if we made one
  if (tempCloneDir) {
    try {
      rmSync(tempCloneDir, { recursive: true, force: true });
      log(`[hook-gym] Cleaned up temp clone at ${tempCloneDir}`);
    } catch {
      log(`[hook-gym] Warning: failed to clean up ${tempCloneDir}`);
    }
  }

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

  // A timeout is only a failure if the scenario doesn't expect one.
  // Scenarios like probe-hooks expect the agent to hit the stop-gate and
  // be killed by the timeout — that's correct behavior, not a failure.
  const timeoutIsFailure = result.timedOut && !scenario.expectTimeout;
  const passed = validation.passed && !timeoutIsFailure && !budgetExceeded && selfCheckPassed;

  // Print validation report
  log('');
  log(formatValidationReport(validation));
  log(summarizeTimeline(scenario.name, timeline));

  if (result.timedOut && scenario.expectTimeout) {
    log(`[hook-gym] ⏱ Expected timeout after ${scenario.timeoutSeconds}s (scenario.expectTimeout=true).`);
  } else if (result.timedOut) {
    log(`[hook-gym] ❌ TIMEOUT after ${scenario.timeoutSeconds}s`);
  }
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
