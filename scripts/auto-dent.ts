#!/usr/bin/env npx tsx
/**
 * auto-dent — TypeScript batch runner.
 *
 * `scripts/auto-dent.sh` is kept as a compatibility wrapper. Batch state,
 * stop checks, planning, cooldown, and finalization live here so the harness is
 * testable and does not drift between Bash and TypeScript implementations.
 */

import { execFileSync, spawn, spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { uniqueNamesGenerator, adjectives, animals } from 'unique-names-generator';
import { ghResult, type GhResult } from '../src/lib/gh-exec.js';
import { readState, writeState, type BatchState } from './auto-dent-run.js';

export interface AutoDentOptions {
  maxRuns: number;
  cooldown: number;
  budget: string;
  maxBudget: string;
  maxFailures: number;
  maxRunSeconds: number;
  dryRun: boolean;
  testTask: boolean;
  experiment: boolean;
  noPlan: boolean;
  provider: 'claude' | 'codex';
  resumeStateFile: string;
  guidance: string;
}

export interface RepoConfig {
  kaizenRepo: string;
  hostRepo: string;
}

export interface BudgetStatus {
  totalCost: number;
  remaining: number;
  exceeded: boolean;
}

export interface StopDecision {
  stop: boolean;
  reason: string;
}

export interface ResumeBatch {
  stateFile: string;
  logDir: string;
  haltFile: string;
  state: BatchState;
}

export interface TsxCommand {
  command: 'npx';
  args: string[];
}

export interface OuterHarnessUpdate {
  pullStatus: number;
  beforeHead: string;
  afterHead: string;
  changedFiles: string[];
  stdout: string;
}

export interface PostStructuredSummaryDeps {
  generateSummary?: (scriptDir: string, logDir: string) => string;
  postIssueComment?: (args: string[]) => GhResult;
  log?: (line: string) => void;
}

const DEFAULT_OPTIONS: AutoDentOptions = {
  maxRuns: 0,
  cooldown: 30,
  budget: '',
  maxBudget: '',
  maxFailures: 3,
  maxRunSeconds: 1200,
  dryRun: false,
  testTask: false,
  experiment: false,
  noPlan: false,
  provider: 'claude',
  resumeStateFile: '',
  guidance: '',
};

const OUTER_HARNESS_RELOAD_PATHS = new Set([
  'scripts/auto-dent.ts',
  'scripts/auto-dent-run.ts',
  'scripts/auto-dent-ctl.ts',
  'scripts/auto-dent-plan.ts',
  'scripts/auto-dent-github.ts',
  'scripts/auto-dent-events.ts',
  'scripts/auto-dent-artifacts.ts',
  'scripts/batch-summary.ts',
  'scripts/batch-outcome.ts',
  'scripts/batch-artifacts-upload.ts',
  'src/lib/json-file.ts',
]);

function usage(): string {
  return `auto-dent — Autonomous batch kaizen runner

Usage: auto-dent.sh [options] <guidance>
       auto-dent.sh --status
       auto-dent.sh --halt [batch-id]
       auto-dent.sh --score [--post-hoc] [batch-id]
       auto-dent.sh --watchdog [--threshold N]

Options:
  --max-runs N         Stop after N iterations (default: unlimited)
  --cooldown N         Seconds between runs (default: 30)
  --budget N.NN        Max USD per run (passed to claude --max-budget-usd)
  --max-budget N.NN    Max USD for entire batch (stops when cumulative cost exceeds)
  --max-failures N     Stop after N consecutive failures (default: 3)
  --max-run-seconds N  Wall-time timeout per run in seconds (default: 1200 = 20min)
  --no-plan            Skip planning pre-pass (use discovery mode)
  --provider NAME      Agent provider: claude (default) or codex
  --dry-run            Show what would run without executing
  --test-task          Use synthetic fast task instead of /kaizen-deep-dive
  --experiment         Enable extra pipeline diagnostics
  --resume FILE        Resume an existing batch from state.json (used by self-update)
  --status             Show status of all batches (active and stopped)
  --halt [batch-id]    Halt a specific batch, or all active batches
  --score [batch-id]   Score batch(es) — efficiency, success rate, cost-per-PR
  --cleanup [batch-id] Close superseded PRs whose issues are already resolved
  --reflect [batch-id] Cross-run pattern analysis and learning
  --reflect --prompt [batch-id]  Output rendered reflection prompt for Claude
  --history            Cross-batch aggregate stats (all-time metrics)
  --trends             Cross-batch trend analysis (cost/PR, success rate over time)
  --aggregate [batch-id]  Append batch(es) to aggregate.jsonl (backfill)
  --watchdog [--threshold N]  Check heartbeats, halt stale batches (default: 600s)
  --help               Show this help

Self-update: between runs, auto-dent pulls main. Single-run runner changes take
effect on the next iteration; outer-harness changes hot-reload by starting
\`auto-dent.ts --resume <state.json>\` and exiting the old process.

Halt: Ctrl+C halts from the same terminal. From another terminal:
  ./scripts/auto-dent.sh --halt              # halt all active
  ./scripts/auto-dent.sh --halt batch-id     # halt one batch

Examples:
  ./scripts/auto-dent.sh "focus on hooks reliability"
  ./scripts/auto-dent.sh --max-runs 5 --budget 5.00 "improve test coverage"
  ./scripts/auto-dent.sh --max-budget 50.00 --budget 5.00 "fix area/skills issues"`;
}

export function parseAutoDentArgs(argv: string[]): AutoDentOptions {
  const opts = { ...DEFAULT_OPTIONS };
  const positional: string[] = [];

  for (let i = 0; i < argv.length;) {
    const arg = argv[i];
    switch (arg) {
      case '--max-runs':
        opts.maxRuns = parseInt(requiredValue(argv, i), 10);
        i += 2;
        break;
      case '--cooldown':
        opts.cooldown = parseInt(requiredValue(argv, i), 10);
        i += 2;
        break;
      case '--budget':
        opts.budget = requiredValue(argv, i);
        i += 2;
        break;
      case '--max-budget':
        opts.maxBudget = requiredValue(argv, i);
        i += 2;
        break;
      case '--max-failures':
        opts.maxFailures = parseInt(requiredValue(argv, i), 10);
        i += 2;
        break;
      case '--max-run-seconds':
        opts.maxRunSeconds = parseInt(requiredValue(argv, i), 10);
        i += 2;
        break;
      case '--dry-run':
        opts.dryRun = true;
        i += 1;
        break;
      case '--test-task':
        opts.testTask = true;
        i += 1;
        break;
      case '--no-plan':
        opts.noPlan = true;
        i += 1;
        break;
      case '--resume':
        opts.resumeStateFile = requiredValue(argv, i);
        i += 2;
        break;
      case '--provider': {
        const provider = requiredValue(argv, i);
        if (provider !== 'claude' && provider !== 'codex') {
          throw new Error(`Unknown provider: ${provider}`);
        }
        opts.provider = provider;
        i += 2;
        break;
      }
      case '--experiment':
        opts.experiment = true;
        i += 1;
        break;
      case '--help':
        throw new Error('SHOW_HELP');
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        positional.push(arg);
        i += 1;
    }
  }

  opts.guidance = positional.join(' ');
  if (!opts.guidance && opts.testTask) opts.guidance = 'synthetic pipeline test';
  return opts;
}

function requiredValue(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${argv[index]}`);
  }
  return value;
}

export function getRepoRoot(scriptDir: string): string {
  try {
    const gitCommonDir = execFileSync(
      'git',
      ['-C', scriptDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8' },
    ).trim();
    return gitCommonDir.replace(/\/\.git$/, '');
  } catch {
    return resolve(scriptDir, '..');
  }
}

export function loadRepoConfig(repoRoot: string): RepoConfig {
  const configFile = join(repoRoot, 'kaizen.config.json');
  if (!existsSync(configFile)) return { kaizenRepo: '', hostRepo: '' };
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  return {
    kaizenRepo: config.kaizen?.repo || '',
    hostRepo: config.host?.repo || '',
  };
}

export function buildTsxScriptArgs(scriptDir: string, scriptName: string, ...args: string[]): string[] {
  return ['tsx', join(scriptDir, scriptName), ...args];
}

export function buildAutoDentResumeCommand(scriptDir: string, stateFile: string): TsxCommand {
  return {
    command: 'npx',
    args: buildTsxScriptArgs(scriptDir, 'auto-dent.ts', '--resume', stateFile),
  };
}

export function loadResumeBatch(stateFileInput: string): ResumeBatch {
  const stateFile = resolve(stateFileInput);
  const logDir = dirname(stateFile);
  return {
    stateFile,
    logDir,
    haltFile: join(logDir, 'HALT'),
    state: readState(stateFile),
  };
}

export function isOuterHarnessReloadPath(file: string): boolean {
  return OUTER_HARNESS_RELOAD_PATHS.has(file.replace(/\\/g, '/'));
}

export function shouldHotReloadOuterHarness(update: Pick<OuterHarnessUpdate, 'pullStatus' | 'beforeHead' | 'afterHead' | 'changedFiles'>): boolean {
  return update.pullStatus === 0
    && update.beforeHead !== ''
    && update.afterHead !== ''
    && update.beforeHead !== 'unknown'
    && update.afterHead !== 'unknown'
    && update.beforeHead !== update.afterHead
    && update.changedFiles.some(isOuterHarnessReloadPath);
}

export function createInitialState(
  batchId: string,
  guidance: string,
  batchStart: number,
  opts: AutoDentOptions,
  repos: RepoConfig,
): BatchState {
  return {
    batch_id: batchId,
    guidance,
    batch_start: batchStart,
    max_runs: opts.maxRuns,
    cooldown: opts.cooldown,
    budget: opts.budget || (null as unknown as string),
    max_budget: opts.maxBudget || (null as unknown as string),
    max_failures: opts.maxFailures,
    kaizen_repo: repos.kaizenRepo || (null as unknown as string),
    host_repo: repos.hostRepo || (null as unknown as string),
    run: 0,
    consecutive_failures: 0,
    current_cooldown: opts.cooldown,
    stop_reason: '',
    prs: [],
    issues_filed: [],
    issues_closed: [],
    cases: [],
    last_issue: '',
    last_pr: '',
    last_case: '',
    last_branch: '',
    last_worktree: '',
    progress_issue: '',
    test_task: opts.testTask,
    experiment: opts.experiment,
    provider: opts.provider,
    max_run_seconds: opts.maxRunSeconds,
    last_heartbeat: 0,
  };
}

export function readStateKey(stateFile: string, key: keyof BatchState): string {
  const value = readState(stateFile)[key];
  return value === null || value === undefined ? '' : String(value);
}

export function updateStateKey(stateFile: string, key: keyof BatchState, value: unknown): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(key))) {
    throw new Error(`[state-io] Invalid state key: ${String(key)}`);
  }
  const state = readState(stateFile);
  (state as unknown as Record<string, unknown>)[key] = value;
  writeState(stateFile, state);
}

export function checkHaltFile(haltFile: string, stateFile: string): boolean {
  if (!haltFile || !existsSync(haltFile)) return false;
  console.log(`>>> Halt file detected: ${haltFile}`);
  updateStateKey(stateFile, 'stop_reason', 'halt file (remote request)');
  return true;
}

export function checkBudget(state: BatchState): BudgetStatus | null {
  if (!state.max_budget) return null;
  const totalCost = (state.run_history || []).reduce(
    (sum, run) => sum + (run.cost_usd || 0),
    0,
  );
  const maxBudget = parseFloat(state.max_budget);
  return {
    totalCost,
    remaining: maxBudget - totalCost,
    exceeded: totalCost >= maxBudget,
  };
}

export function stopDecision(state: BatchState, nextRun: number): StopDecision {
  if (state.stop_reason) return { stop: true, reason: state.stop_reason };
  if (state.max_runs > 0 && nextRun > state.max_runs) {
    return { stop: true, reason: `max runs reached (${state.max_runs})` };
  }
  if (state.consecutive_failures >= state.max_failures) {
    return { stop: true, reason: `${state.max_failures} consecutive failures` };
  }
  const budget = checkBudget(state);
  if (budget?.exceeded) {
    return {
      stop: true,
      reason: `budget exhausted ($${budget.totalCost.toFixed(2)} >= $${state.max_budget})`,
    };
  }
  return { stop: false, reason: '' };
}

export function writeBatchSummary(stateFile: string, nowEpoch = Math.floor(Date.now() / 1000)): string {
  const state = readState(stateFile);
  const duration = nowEpoch - state.batch_start;
  const totalCost = (state.run_history || []).reduce(
    (sum, run) => sum + (run.cost_usd || 0),
    0,
  );
  if (!state.stop_reason) state.stop_reason = 'completed';
  state.batch_end = nowEpoch;
  writeState(stateFile, state);

  const summaryPath = stateFile.replace(/state\.json$/, 'batch-summary.txt');
  const lines = [
    `batch_id=${state.batch_id}`,
    `guidance=${state.guidance}`,
    `runs=${state.run}`,
    `total_duration_seconds=${duration}`,
    `total_cost_usd=${totalCost.toFixed(2)}`,
    `stop_reason=${state.stop_reason || 'completed'}`,
    `prs=${state.prs.join(' ')}`,
    `issues_filed=${state.issues_filed.join(' ')}`,
    `issues_closed=${state.issues_closed.join(' ')}`,
    `cases=${state.cases.join(' ')}`,
  ];

  if (state.run_history && state.run_history.length > 0) {
    lines.push('');
    for (const run of state.run_history) {
      lines.push(`run_${run.run}_duration=${run.duration_seconds}`);
      lines.push(`run_${run.run}_cost=${(run.cost_usd || 0).toFixed(2)}`);
      lines.push(`run_${run.run}_tools=${run.tool_calls}`);
      lines.push(`run_${run.run}_exit=${run.exit_code}`);
      if (run.prs.length > 0) lines.push(`run_${run.run}_prs=${run.prs.join(' ')}`);
    }
  }

  writeFileSync(summaryPath, `${lines.join('\n')}\n`);
  return summaryPath;
}

export function formatBatchSummary(state: BatchState, nowEpoch = Math.floor(Date.now() / 1000)): string {
  const duration = nowEpoch - state.batch_start;
  const hours = Math.floor(duration / 3600);
  const mins = Math.floor((duration % 3600) / 60);
  const totalCost = (state.run_history || []).reduce(
    (sum, run) => sum + (run.cost_usd || 0),
    0,
  );

  const lines = [
    '',
    '╔══════════════════════════════════════════════════════════╗',
    '║               auto-dent — Batch Summary                 ║',
    '╠══════════════════════════════════════════════════════════╣',
    `║ Batch ID:  ${state.batch_id}`,
    `║ Guidance:  ${state.guidance}`,
    `║ Runs:      ${state.run}`,
    `║ Duration:  ${hours}h ${mins}m`,
    `║ Stop:      ${state.stop_reason || 'completed'}`,
  ];
  if (totalCost > 0) lines.push(`║ Cost:      $${totalCost.toFixed(2)}`);
  lines.push('╠══════════════════════════════════════════════════════════╣');

  if (state.prs.length > 0) {
    lines.push('║ PRs created:');
    for (const pr of state.prs) lines.push(`║   ${pr}`);
  } else {
    lines.push('║ PRs created: none');
  }
  if (state.issues_filed.length > 0) {
    lines.push('║ Issues filed:');
    for (const issue of state.issues_filed) lines.push(`║   ${issue}`);
  }
  if (state.issues_closed.length > 0) {
    lines.push(`║ Issues closed: ${state.issues_closed.join(' ')}`);
  }
  if (state.run_history && state.run_history.length > 0) {
    lines.push('╠══════════════════════════════════════════════════════════╣');
    lines.push('║ Per-run metrics:');
    for (const run of state.run_history) {
      const rm = Math.floor(run.duration_seconds / 60);
      const rs = run.duration_seconds % 60;
      const status = run.exit_code === 0 ? 'ok' : `exit ${run.exit_code}`;
      const prSuffix = run.prs.length > 0 ? ` ${run.prs.length}PR` : '';
      const stopSuffix = run.stop_requested ? ' STOP' : '';
      lines.push(
        `║   #${run.run}: ${rm}m${rs}s $${(run.cost_usd || 0).toFixed(2)} ${run.tool_calls}tc ${status}${prSuffix}${stopSuffix}`,
      );
    }
  }
  lines.push('╚══════════════════════════════════════════════════════════╝', '');
  return lines.join('\n');
}

function printBanner(state: BatchState, logDir: string, haltFile: string): void {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║                 auto-dent (TypeScript)                  ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║ Batch ID:  ${state.batch_id}`);
  console.log(`║ Guidance:  ${state.guidance}`);
  console.log(`║ Max runs:  ${state.max_runs === 0 ? 'unlimited' : state.max_runs}`);
  console.log(`║ Cooldown:  ${state.cooldown}s`);
  if (state.budget) console.log(`║ Budget/run: $${state.budget}`);
  if (state.max_budget) console.log(`║ Max budget: $${state.max_budget} (total batch)`);
  console.log(`║ Run timeout: ${state.max_run_seconds}s (${Math.floor((state.max_run_seconds || 0) / 60)}min)`);
  if (state.test_task) console.log('║ Mode:      TEST TASK (synthetic pipeline probe)');
  if (state.experiment) console.log('║ Experiment: enabled (extra diagnostics)');
  console.log(`║ Max consecutive failures: ${state.max_failures}`);
  if (state.kaizen_repo) console.log(`║ Kaizen repo: ${state.kaizen_repo}`);
  if (state.host_repo) console.log(`║ Host repo:   ${state.host_repo}`);
  console.log(`║ Logs:      ${logDir}`);
  console.log(`║ State:     ${join(logDir, 'state.json')}`);
  console.log(`║ Halt:      touch ${haltFile}  (or --halt from another terminal)`);
  console.log('║ Self-update: enabled (pulls main; hot-reloads outer harness)');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
}

function runCtl(scriptDir: string, args: string[]): never {
  const result = spawnSync('npx', buildTsxScriptArgs(scriptDir, 'auto-dent-ctl.ts', ...args), {
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

function runCommand(command: string, args: string[], cwd?: string): number {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  return result.status ?? 1;
}

function captureCommand(command: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function changedFilesBetween(repoRoot: string, beforeHead: string, afterHead: string): string[] {
  if (!beforeHead || !afterHead || beforeHead === afterHead || beforeHead === 'unknown' || afterHead === 'unknown') {
    return [];
  }
  try {
    return execFileSync('git', ['-C', repoRoot, 'diff', '--name-only', `${beforeHead}..${afterHead}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function pullMainForSelfUpdate(repoRoot: string): OuterHarnessUpdate {
  const beforeHead = captureCommand('git', ['-C', repoRoot, 'rev-parse', 'HEAD']);
  const pull = spawnSync('git', ['-C', repoRoot, 'pull', '--ff-only', 'origin', 'main'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  });
  const afterHead = captureCommand('git', ['-C', repoRoot, 'rev-parse', 'HEAD']);
  const pullStatus = pull.status ?? 1;
  return {
    pullStatus,
    beforeHead,
    afterHead,
    stdout: pull.stdout || '',
    changedFiles: pullStatus === 0 ? changedFilesBetween(repoRoot, beforeHead, afterHead) : [],
  };
}

function startAutoDentResume(scriptDir: string, stateFile: string): boolean {
  const { command, args } = buildAutoDentResumeCommand(scriptDir, stateFile);
  try {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.unref();
    return true;
  } catch (err) {
    console.log(`>>> Hot reload handoff failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function runPlanningPrepass(scriptDir: string, stateFile: string, logDir: string): void {
  const planScript = join(scriptDir, 'auto-dent-plan.ts');
  if (!existsSync(planScript)) return;
  console.log('>>> Running planning pre-pass...');
  const status = runCommand('npx', buildTsxScriptArgs(scriptDir, 'auto-dent-plan.ts', stateFile));
  if (status === 0) {
    const planPath = join(logDir, 'plan.json');
    if (existsSync(planPath)) {
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      console.log(`>>> Plan ready: ${(plan.items || []).length} items queued.`);
      const postStatus = spawnSync('npx', buildTsxScriptArgs(scriptDir, 'auto-dent-run.ts', '--post-plan', stateFile), {
        stdio: 'ignore',
      });
      if ((postStatus.status ?? 1) !== 0) console.log('>>> Plan posting skipped (non-fatal).');
    }
  } else {
    console.log('>>> Planning skipped (non-fatal). Runs will use discovery mode.');
  }
  console.log('');
}

export function postStructuredSummary(
  scriptDir: string,
  logDir: string,
  progressIssue: string,
  kaizenRepo: string,
  deps: PostStructuredSummaryDeps = {},
): void {
  const log = deps.log ?? console.log;
  if (!existsSync(join(logDir, 'events.jsonl'))) {
    log('>>> No events.jsonl found — skipping structured summary.');
    return;
  }
  log('>>> Generating structured batch summary from events.jsonl...');
  let summary = '';
  try {
    summary = (deps.generateSummary ?? ((s, l) =>
      execFileSync('npx', buildTsxScriptArgs(s, 'batch-summary.ts', l), {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })))(scriptDir, logDir).trim();
  } catch {
    summary = '';
  }
  if (summary && progressIssue && kaizenRepo) {
    log(`>>> Posting batch summary to ${progressIssue}...`);
    const postIssueComment = deps.postIssueComment ?? ghResult;
    const status = postIssueComment(['issue', 'comment', progressIssue, '--repo', kaizenRepo, '--body', summary]);
    if ((status.status ?? 1) !== 0) log('>>> Summary posting skipped (non-fatal).');
  }
  if (summary) {
    writeFileSync(join(logDir, 'batch-summary-report.md'), `${summary}\n`);
    log(`>>> Structured summary saved to ${join(logDir, 'batch-summary-report.md')}`);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function cooldown(seconds: number, haltFile: string, stateFile: string, isShuttingDown: () => boolean): Promise<boolean> {
  console.log(`Cooling down for ${seconds}s before next run... (touch ${haltFile} to stop)`);
  let remaining = seconds;
  while (remaining > 0) {
    const interval = Math.min(remaining, 3);
    await sleep(interval * 1000);
    remaining -= interval;
    if (isShuttingDown()) return true;
    if (checkHaltFile(haltFile, stateFile)) return true;
  }
  return false;
}

async function main(): Promise<void> {
  const scriptDir = dirname(new URL(import.meta.url).pathname);
  const first = process.argv[2];

  if (first === '--status') runCtl(scriptDir, ['status']);
  if (first === '--halt') runCtl(scriptDir, ['halt', ...process.argv.slice(3)]);
  if (first === '--score') runCtl(scriptDir, ['score', ...process.argv.slice(3)]);
  if (first === '--cleanup') runCtl(scriptDir, ['cleanup', ...process.argv.slice(3)]);
  if (first === '--reflect') runCtl(scriptDir, ['reflect', ...process.argv.slice(3)]);
  if (first === '--watchdog') runCtl(scriptDir, ['watchdog', ...process.argv.slice(3)]);
  if (first === '--history') runCtl(scriptDir, ['history']);
  if (first === '--aggregate') runCtl(scriptDir, ['aggregate', ...process.argv.slice(3)]);
  if (first === '--trends') {
    const repoRoot = getRepoRoot(scriptDir);
    const status = runCommand('npx', buildTsxScriptArgs(scriptDir, 'batch-trends.ts', join(repoRoot, 'logs', 'auto-dent'), ...process.argv.slice(3)));
    process.exit(status);
  }

  let opts: AutoDentOptions;
  try {
    opts = parseAutoDentArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof Error && err.message === 'SHOW_HELP') {
      console.log(usage());
      return;
    }
    console.error(err instanceof Error ? err.message : String(err));
    console.error('Usage: auto-dent.sh [options] <guidance>');
    process.exit(1);
  }

  if (!opts.guidance && !opts.testTask && !opts.resumeStateFile) {
    console.error('Error: guidance prompt is required (or use --test-task)');
    console.error('Usage: auto-dent.sh [options] <guidance>');
    process.exit(1);
  }

  const repoRoot = getRepoRoot(scriptDir);
  let batchStart: number;
  let logDir: string;
  let haltFile: string;
  let stateFile: string;
  let state: BatchState;

  if (opts.resumeStateFile) {
    const resumed = loadResumeBatch(opts.resumeStateFile);
    ({ stateFile, logDir, haltFile, state } = resumed);
    batchStart = state.batch_start;
    console.log(`>>> Resuming auto-dent batch ${state.batch_id} from ${stateFile}`);
  } else {
    const repos = loadRepoConfig(repoRoot);
    const batchId = uniqueNamesGenerator({
      dictionaries: [adjectives, animals],
      separator: '-',
    });
    batchStart = Math.floor(Date.now() / 1000);
    logDir = join(repoRoot, 'logs', 'auto-dent', batchId);
    mkdirSync(logDir, { recursive: true });
    haltFile = join(logDir, 'HALT');
    stateFile = join(logDir, 'state.json');
    state = createInitialState(batchId, opts.guidance, batchStart, opts, repos);
    writeState(stateFile, state);
  }

  let shuttingDown = false;
  const handleShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('');
    console.log('>>> Received shutdown signal. Finishing current run, then stopping...');
    updateStateKey(stateFile, 'stop_reason', 'signal (SIGTERM/SIGINT)');
  };
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);

  printBanner(state, logDir, haltFile);
  if (opts.maxRuns === 0 && !opts.maxBudget) {
    console.log('WARNING: No --max-runs or --max-budget set. This batch will run indefinitely.');
    console.log('   Consider: --max-budget 50.00 or --max-runs 20');
    console.log('');
  }

  if (opts.dryRun) {
    console.log('[dry-run] Would execute per run:');
    console.log(`  npx ${buildTsxScriptArgs(scriptDir, 'auto-dent-run.ts', stateFile).join(' ')}`);
    console.log(`[dry-run] Provider: ${opts.provider}`);
    console.log('');
    console.log('[dry-run] State file:');
    console.log(readFileSync(stateFile, 'utf8').trimEnd());
    return;
  }

  if (!opts.resumeStateFile && !opts.testTask && !opts.noPlan) {
    runPlanningPrepass(scriptDir, stateFile, logDir);
  }

  while (true) {
    if (shuttingDown) break;
    if (checkHaltFile(haltFile, stateFile)) break;

    const current = readState(stateFile);
    const nextRun = current.run + 1;
    const decision = stopDecision(current, nextRun);
    if (decision.stop) {
      console.log(`>>> Stopping: ${decision.reason}`);
      if (!current.stop_reason) updateStateKey(stateFile, 'stop_reason', decision.reason);
      break;
    }

    const budget = checkBudget(current);
    if (budget && !budget.exceeded) {
      console.log(
        `>>> Budget: $${budget.totalCost.toFixed(2)} spent / $${current.max_budget} max ($${budget.remaining.toFixed(2)} remaining)`,
      );
    }

    console.log('>>> Pulling main for self-update...');
    const update = pullMainForSelfUpdate(repoRoot);
    if (current.experiment) {
      console.log(`>>> [experiment] main HEAD before pull: ${update.beforeHead.slice(0, 8)}`);
    }
    if (update.pullStatus === 0) {
      process.stdout.write(update.stdout);
      console.log('>>> Main updated.');
    } else {
      console.log('>>> Main already up-to-date (or pull failed, continuing with current).');
    }
    if (current.experiment) {
      console.log(`>>> [experiment] main HEAD after pull: ${update.afterHead.slice(0, 8)}`);
      if (update.changedFiles.length > 0) {
        console.log(`>>> [experiment] changed files: ${update.changedFiles.join(', ')}`);
      }
    }
    if (shouldHotReloadOuterHarness(update)) {
      const changedHarnessFiles = update.changedFiles.filter(isOuterHarnessReloadPath);
      console.log(`>>> Outer harness changed: ${changedHarnessFiles.join(', ')}`);
      console.log(`>>> Restarting auto-dent from ${stateFile}...`);
      if (startAutoDentResume(scriptDir, stateFile)) return;
      console.log('>>> Hot reload handoff skipped; continuing current process.');
    }

    if (nextRun > 1) {
      console.log('>>> Cleaning up superseded PRs...');
      const cleanup = spawnSync('npx', buildTsxScriptArgs(scriptDir, 'auto-dent-ctl.ts', 'cleanup', current.batch_id), { stdio: 'ignore' });
      if ((cleanup.status ?? 1) !== 0) console.log('>>> Cleanup skipped (non-fatal).');
    }

    if (nextRun > 1 && (nextRun - 1) % 5 === 0) {
      console.log('>>> Running cross-run reflection (every 5 runs)...');
      const reflect = spawnSync('npx', buildTsxScriptArgs(scriptDir, 'auto-dent-ctl.ts', 'reflect', '--post', current.batch_id), { stdio: 'ignore' });
      console.log((reflect.status ?? 1) === 0
        ? '>>> Reflection complete (posted to progress issue).'
        : '>>> Reflection skipped (non-fatal).');
    }

    const runner = join(scriptDir, 'auto-dent-run.ts');
    if (!existsSync(runner)) {
      console.log(`>>> ERROR: Runner not found: ${runner}`);
      updateStateKey(stateFile, 'stop_reason', 'runner not found');
      break;
    }

    console.log(`━━━ Run #${nextRun} starting at ${new Date().toString()} ━━━`);
    runCommand('npx', buildTsxScriptArgs(scriptDir, 'auto-dent-run.ts', stateFile));

    const afterRun = readState(stateFile);
    if (afterRun.stop_reason) {
      console.log(`>>> Stopping: ${afterRun.stop_reason}`);
      break;
    }
    if (shuttingDown) break;

    const elapsed = Math.floor(Date.now() / 1000) - batchStart;
    const hours = Math.floor(elapsed / 3600);
    const mins = Math.floor((elapsed % 3600) / 60);
    const runsLabel = afterRun.max_runs > 0 ? `${afterRun.run}/${afterRun.max_runs}` : String(afterRun.run);
    console.log('━━━ Batch Progress ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Runs: ${runsLabel} completed | ${afterRun.consecutive_failures} consecutive failures`);
    console.log(`  PRs:  ${afterRun.prs.length} created | Issues: ${afterRun.issues_closed.length} closed`);
    console.log(`  Time: ${hours}h ${mins}m elapsed`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (afterRun.max_runs > 0 && afterRun.run >= afterRun.max_runs) {
      updateStateKey(stateFile, 'stop_reason', `max runs reached (${afterRun.max_runs})`);
      break;
    }
    if (shuttingDown) break;
    if (checkHaltFile(haltFile, stateFile)) break;
    if (await cooldown(afterRun.current_cooldown || afterRun.cooldown, haltFile, stateFile, () => shuttingDown)) break;
  }

  const summaryPath = writeBatchSummary(stateFile);
  const finalStateBeforeClose = readState(stateFile);
  postStructuredSummary(scriptDir, logDir, finalStateBeforeClose.progress_issue || '', finalStateBeforeClose.kaizen_repo || '');
  spawnSync('npx', buildTsxScriptArgs(scriptDir, 'auto-dent-run.ts', '--close-batch', stateFile), {
    stdio: 'ignore',
  });

  const finalState = readState(stateFile);
  console.log(formatBatchSummary(finalState));
  console.log(`State: ${stateFile}`);
  console.log(`Summary: ${summaryPath}`);

  console.log('>>> Appending batch to aggregate...');
  const aggregate = spawnSync('npx', buildTsxScriptArgs(scriptDir, 'auto-dent-ctl.ts', 'aggregate', finalState.batch_id), {
    stdio: 'ignore',
  });
  if ((aggregate.status ?? 1) !== 0) console.log('>>> Aggregate append skipped (non-fatal).');
  spawnSync('npx', buildTsxScriptArgs(scriptDir, 'auto-dent-ctl.ts', 'halt-state', stateFile), { stdio: 'inherit' });
}

const isDirectRun =
  process.argv[1]?.endsWith('auto-dent.ts') ||
  process.argv[1]?.endsWith('auto-dent.js');

if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
