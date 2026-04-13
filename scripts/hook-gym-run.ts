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
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
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
 * Clone the host repo into a temp dir and install kaizen as a plugin.
 *
 * Uses the real plugin installation path (`claude plugins install`) so the
 * test proves the same mechanism any host project uses. The kaizen marketplace
 * must already be registered (typically via `claude plugins marketplace add`
 * during dev setup).
 *
 * Returns the temp dir path on success, undefined on failure.
 */
function cloneAndSetup(
  hostRepo: string,
  scenarioName: string,
  kaizenRepoPath: string,
  log: (...args: unknown[]) => void,
): string | undefined {
  const dir = join(tmpdir(), `hook-gym-${scenarioName}-${Date.now()}`);
  log(`[hook-gym] Cloning ${hostRepo} into temp dir...`);
  try {
    execSync(
      `git clone --depth 1 "https://github.com/${hostRepo}.git" "${dir}"`,
      { stdio: 'pipe', timeout: 60_000 },
    );
  } catch (err) {
    log(`[hook-gym] Clone failed: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }

  // Install kaizen — full setup, same as any host project:
  // 1. Register marketplace + install plugin (hooks fire via plugin.json)
  // 2. Run kaizen-setup config + scaffold (creates kaizen.config.json + policies)
  // 3. Inject CLAUDE.md instructions fragment (so the agent knows the workflow)
  log(`[hook-gym] Installing kaizen from ${kaizenRepoPath}...`);
  try {
    // Plugin installation
    execSync(
      `claude plugins marketplace add "${kaizenRepoPath}" 2>/dev/null || true`,
      { stdio: 'pipe', timeout: 15_000, cwd: dir },
    );
    execSync(
      `claude plugins install kaizen@kaizen --scope project`,
      { stdio: 'pipe', timeout: 15_000, cwd: dir },
    );

    // Config step — creates kaizen.config.json
    const repoSlug = hostRepo;
    const repoName = hostRepo.split('/').pop() ?? 'fixture';
    execSync(
      `npx --prefix "${kaizenRepoPath}" tsx "${kaizenRepoPath}/src/kaizen-setup.ts" ` +
      `--step config --name "${repoName}" --repo "${repoSlug}" ` +
      `--description "Hook Gym test fixture" --kaizen-repo "Garsson-io/kaizen"`,
      { stdio: 'pipe', timeout: 15_000, cwd: dir },
    );

    // Scaffold step — creates policies-local.md
    execSync(
      `npx --prefix "${kaizenRepoPath}" tsx "${kaizenRepoPath}/src/kaizen-setup.ts" --step scaffold`,
      { stdio: 'pipe', timeout: 15_000, cwd: dir },
    );

    // Inject CLAUDE.md instructions fragment
    const fragmentPath = join(kaizenRepoPath, '.agents', 'kaizen', 'instructions-fragment.md');
    if (existsSync(fragmentPath)) {
      let fragment = readFileSync(fragmentPath, 'utf-8');
      fragment = fragment.replace(/\{\{KAIZEN_ROOT\}\}/g, kaizenRepoPath);
      const claudeMdPath = join(dir, 'CLAUDE.md');
      const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf-8') : '';
      if (!existing.toLowerCase().includes('kaizen')) {
        writeFileSync(claudeMdPath, existing + '\n' + fragment);
      }
    }

    // Gitignore runtime artifacts that hooks create as side-effects,
    // so the dirty-files hook doesn't block PR creation.
    const gitignorePath = join(dir, '.gitignore');
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
    if (!existing.includes('.kaizen/telemetry')) {
      writeFileSync(gitignorePath, existing + '\n.kaizen/telemetry/\n');
    }

    // Commit all setup-generated files so the working tree is clean.
    // The dirty-files hook blocks PR creation when there are uncommitted changes,
    // and kaizen-setup creates .agents/, CLAUDE.md, kaizen.config.json, etc.
    execSync(
      'git add -A && git commit -m "chore: kaizen setup (hook-gym)" --no-verify',
      { stdio: 'pipe', timeout: 10_000, cwd: dir },
    );

    log(`[hook-gym] Full kaizen setup complete (files committed).`);
  } catch (err) {
    log(`[hook-gym] Setup failed: ${err instanceof Error ? err.message : err}`);
    log(`[hook-gym] Hooks may not fire correctly.`);
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

  // For non-self-dogfood repos, clone the fixture repo into a temp dir
  // and install kaizen hooks there. The agent runs from the clone root
  // where hooks resolve naturally via .claude/settings.json.
  let agentCwd: string | undefined;
  let tempCloneDir: string | undefined;
  const isSelfDogfood = hostRepo === getHostRepo();

  if (opts.cwd === null) {
    // Explicit null = skip auto-clone (unit tests with mocked spawn).
    agentCwd = undefined;
  } else if (opts.cwd) {
    agentCwd = opts.cwd;
  } else if (!isSelfDogfood) {
    const kaizenRoot = resolve(__dirname, '..');
    tempCloneDir = cloneAndSetup(hostRepo, scenario.name, kaizenRoot, log);
    if (!tempCloneDir) {
      log(`[hook-gym] ❌ Cannot run scenario without a fixture repo clone. Aborting.`);
      return {
        scenario: scenario.name, passed: false, timeline: { events: [], gatesActivated: {}, gatesCleared: {} },
        validation: { scenario: scenario.name, passed: false, hookResults: [], gateResults: [], hooksMatched: 0, hooksTotal: 0, gatesMatched: 0, gatesTotal: 0, criticalMisses: 0, totalLoss: 0, confusionPairs: [] },
        selfCheckPassed: false, timedOut: false, budgetExceeded: false, durationMs: 0, outDir: '', streamLines: [],
      };
    }
    agentCwd = tempCloneDir;
  }

  log(`[hook-gym] Running scenario: ${scenario.name} (model=${model}, timeout=${scenario.timeoutSeconds}s, budget=$${scenario.maxBudget.toFixed(2)}${agentCwd ? `, cwd=${agentCwd}` : ''})`);

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
