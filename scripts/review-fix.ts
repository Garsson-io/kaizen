#!/usr/bin/env npx tsx
/**
 * review-fix.ts — Full review-fix cycle for a PR against its issue.
 *
 * Usage:
 *   npx tsx scripts/review-fix.ts --pr <url> --issue <num> --repo <owner/repo>
 *   npx tsx scripts/review-fix.ts --pr <url> --issue <num> --repo <owner/repo> --dry-run
 *
 * Flow:
 *   1. REVIEW: Run requirements battery with the selected provider → structured findings
 *   2. If PASS → done
 *   3. If gaps → FIX: Spawn the selected fix provider session that:
 *      a. Reads the issue
 *      b. Reads the PR diff
 *      c. Checks out the PR branch
 *      d. Fixes each MISSING/PARTIAL finding
 *      e. Runs tests
 *      f. Commits and pushes
 *   4. RE-REVIEW → loop back to 1
 *   5. Stop after MAX_FIX_ROUNDS or BUDGET_CAP_USD
 *
 * --dry-run: review only, print the fix prompt, don't spawn fix session
 */

import { spawn as asyncSpawn, spawnSync, execSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import {
  reviewBattery,
  formatBatteryReport,
  listPrDimensions,
  MAX_FIX_ROUNDS,
  BUDGET_CAP_USD,
  DATA_GAP_PREFIX,
  type BatteryResult,
  type ReviewFinding,
  type ReviewProvider,
} from '../src/review-battery.js';
import { addSection, writeAttachment } from '../src/section-editor.js';
import { parseJsonLines } from '../src/lib/json-lines.js';
import { readJsonValueFile, writeJsonObjectFile } from '../src/lib/json-file.js';
import { ghExec } from './auto-dent-github.js';
import { assessCodexRun, buildCodexExecArgs, parseCodexJsonl } from './auto-dent-codex.js';
import {
  PROVIDER_CAPABILITIES,
  validateProviderPlan,
  type ProviderCapability,
  type PlanValidation,
} from './auto-dent-provider.js';

// ── Stream-JSON parsing ─────────────────────────────────────────────

export interface StreamJsonResult {
  /** Whether a result message was found in the log */
  found: boolean;
  /** Whether the session completed without error */
  success: boolean;
  /** Total cost in USD from the result message */
  costUsd: number;
  /** The final text output */
  output: string;
}

interface StreamJsonMessage {
  type?: unknown;
  subtype?: unknown;
  total_cost_usd?: number;
  result?: string;
}

/**
 * Parse a stream-json JSONL log (--output-format stream-json --verbose).
 * Scans for the final message with type === "result" and extracts
 * success status, cost, and output text.
 *
 * Returns { found: false } if no result line has been emitted yet
 * (session still running or session produced no output).
 */
export function parseStreamJsonResult(stdout: string): StreamJsonResult {
  if (!stdout.trim()) return { found: false, success: false, costUsd: 0, output: '' };
  for (const msg of parseJsonLines<StreamJsonMessage>(stdout).reverse()) {
    if (msg.type === 'result') {
      return {
        found: true,
        success: msg.subtype !== 'error_during_generation',
        // total_cost_usd is a top-level field on the result message (not nested in usage)
        costUsd: msg.total_cost_usd ?? 0,
        output: msg.result ?? '',
      };
    }
  }
  return { found: false, success: false, costUsd: 0, output: '' };
}

// ── Fix-running phase handler ────────────────────────────────────────

export type FixRunningAction = 'wait' | 'continue' | 'reset';

/**
 * Handle the fix_running phase on resume.
 * Extracted for testability — no I/O, takes state + check function.
 *
 * Returns:
 *   'wait'     — fix session still running, caller should exit
 *   'continue' — fix session completed, caller should proceed to review loop
 *   'reset'    — activeFix is missing (corrupt state), reset to needs_review
 */
export function applyFixRunningPhase(
  state: ReviewFixState,
  checkFn: (logFile: string, pid: number, provider?: ReviewFixProvider) => { done: boolean; success: boolean; costUsd: number; output: string },
): { action: FixRunningAction; state: ReviewFixState } {
  if (!state.activeFix) {
    return { action: 'reset', state: { ...state, phase: 'needs_review' } };
  }
  const { pid, logFile } = state.activeFix;
  const provider = state.activeFix.provider ?? state.fixProvider ?? DEFAULT_REVIEW_FIX_PROVIDER;
  const result = checkFn(logFile, pid, provider);
  if (!result.done) {
    return { action: 'wait', state };
  }
  // Fix completed — record it, advance round
  const newState: ReviewFixState = {
    ...state,
    totalCostUsd: state.totalCostUsd + result.costUsd,
    currentRound: state.currentRound + 1,
    phase: 'needs_review',
    activeFix: undefined,
    rounds: [
      ...state.rounds,
      {
        round: state.currentRound,
        phase: 'fix',
        verdict: result.success ? 'fixed' : 'fix_failed',
        gaps: 0,
        reviewCost: 0,
        fixCost: result.costUsd,
        fixProvider: provider,
      },
    ],
  };
  return { action: 'continue', state: newState };
}

// ── Max rounds resolution ────────────────────────────────────────────

/**
 * Resolve the effective maxRounds for a run.
 * On resume, use the stored maxRounds from the original run so the
 * original limit is respected regardless of CLI flags.
 * On fresh start, use opts.maxRounds.
 */
export function resolveMaxRounds(opts: { resume: boolean; maxRounds: number }, state: { maxRounds: number }): number {
  return opts.resume ? state.maxRounds : opts.maxRounds;
}

// ── Deps injection ──────────────────────────────────────────────────

export type PrefetchResult = {
  issueBody: string;
  prBody: string;
  prDiff: string;
  prBranch: string;
  isMerged: boolean;
};

export interface RunFixLoopDeps {
  prefetch?: (prUrl: string, issueNum: string, repo: string) => PrefetchResult;
  launchFix?: (prompt: string, logDir: string, round: number, provider: ReviewFixProvider, repoRoot?: string) => { pid: number; logFile: string; promptFile: string; provider?: ReviewFixProvider };
  checkFix?: (logFile: string, pid: number, provider?: ReviewFixProvider) => { done: boolean; success: boolean; costUsd: number; output: string };
  runReview?: (params: { dimensions: string[]; prUrl: string; issueNum: string; repo: string; timeoutMs: number; reviewProvider?: ReviewProvider }) => Promise<BatteryResult>;
  getStateDir?: () => string;
  providerInventory?: readonly ProviderCapability[];
}

// ── State persistence ───────────────────────────────────────────────

export type ReviewFixProvider = ReviewProvider;

const DEFAULT_REVIEW_FIX_PROVIDER: ReviewFixProvider = { provider: 'claude', billing: 'subscription-cli' };

export function defaultReviewFixProviders(): {
  reviewProvider: ReviewFixProvider;
  fixProvider: ReviewFixProvider;
} {
  return {
    reviewProvider: DEFAULT_REVIEW_FIX_PROVIDER,
    fixProvider: DEFAULT_REVIEW_FIX_PROVIDER,
  };
}

export function validateReviewFixProviderPlan(
  providers: { reviewProvider: ReviewFixProvider; fixProvider: ReviewFixProvider },
  inventory: readonly ProviderCapability[] = PROVIDER_CAPABILITIES,
): PlanValidation {
  return validateProviderPlan({
    review: providers.reviewProvider.provider,
    fix: providers.fixProvider.provider,
  }, inventory);
}

function parseProviderName(value: string, flag: string): ReviewFixProvider {
  if (value === 'claude' || value === 'codex') {
    return { provider: value, billing: 'subscription-cli' };
  }
  console.error(`Invalid ${flag}: "${value}". Valid providers: claude, codex. API-token-only repair strategies are not subscription-compatible.`);
  process.exit(1);
}

function providerLabel(provider: ReviewFixProvider): string {
  return `${provider.provider} (${provider.billing})`;
}

export interface FixProviderCommand {
  command: string;
  args: string[];
}

export function buildFixProviderCommand(input: {
  provider: ReviewFixProvider;
  repoRoot?: string;
}): FixProviderCommand {
  if (input.provider.provider === 'claude') {
    return {
      command: 'claude',
      args: ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--model', 'sonnet'],
    };
  }
  return {
    command: 'codex',
    args: buildCodexExecArgs(input.repoRoot ?? process.cwd(), {
      sandbox: 'workspace-write',
      bypassApprovalsAndSandbox: false,
    }),
  };
}

function normalizeRoundProvider(
  round: ReviewFixState['rounds'][number],
  stateProviders: { reviewProvider: ReviewFixProvider; fixProvider: ReviewFixProvider },
): ReviewFixState['rounds'][number] {
  if (round.phase === 'review') {
    return { ...round, reviewProvider: round.reviewProvider ?? stateProviders.reviewProvider };
  }
  if (round.phase === 'fix') {
    return { ...round, fixProvider: round.fixProvider ?? stateProviders.fixProvider };
  }
  return round;
}

export function normalizeReviewFixState(state: ReviewFixState): ReviewFixState {
  const defaults = defaultReviewFixProviders();
  const reviewProvider = state.reviewProvider ?? defaults.reviewProvider;
  const fixProvider = state.fixProvider ?? defaults.fixProvider;
  const normalized: ReviewFixState = {
    ...state,
    reviewProvider,
    fixProvider,
    rounds: state.rounds.map((round) => normalizeRoundProvider(round, { reviewProvider, fixProvider })),
  };
  if (state.activeFix) {
    normalized.activeFix = { ...state.activeFix, provider: state.activeFix.provider ?? fixProvider };
  }
  return normalized;
}

export interface ReviewFixState {
  prUrl: string;
  issueNum: string;
  repo: string;
  reviewProvider?: ReviewFixProvider;
  fixProvider?: ReviewFixProvider;
  maxRounds: number;
  budgetCap: number;
  currentRound: number;
  totalCostUsd: number;
  startedAt: string;
  /** Current phase within a round */
  phase: 'needs_review' | 'needs_fix' | 'fix_running' | 'done';
  /** Active fix session (when phase is fix_running) */
  activeFix?: { pid: number; logFile: string; promptFile: string; provider?: ReviewFixProvider };
  rounds: Array<{
    round: number;
    phase: 'review' | 'fix' | 'done';
    verdict: string;
    gaps: number;
    reviewCost: number;
    fixCost: number;
    reviewProvider?: ReviewFixProvider;
    fixProvider?: ReviewFixProvider;
    findings?: ReviewFinding[];
  }>;
  outcome?: string;
  prBranch?: string;
  isMerged?: boolean;
}

/**
 * Resolve the state directory from a git-common-dir value.
 *
 * State must live in the MAIN repo, never inside a worktree — worktrees are
 * deleted on merge and would take their state with them (#929, #934, #939).
 *
 * @param gitCommonDir - output of `git rev-parse --git-common-dir`
 *   - In the main checkout: '.git' (relative — note: relative, not absolute)
 *   - In a worktree:        '/abs/path/to/main/.git' (the COMMON .git dir, NOT the worktree subdir)
 *     (contrast with --git-dir which returns '/abs/path/to/main/.git/worktrees/<name>')
 * @param cwd - used when gitCommonDir is '.git' (main checkout)
 */
export function resolveStateDir(gitCommonDir: string, cwd: string = process.cwd()): string {
  const mainRoot =
    gitCommonDir === '.git'
      ? cwd
      : resolve(dirname(gitCommonDir)); // parent of .git dir
  return join(mainRoot, '.claude', 'review-fix');
}

function stateDir(): string {
  let gitCommonDir = '.git';
  try {
    gitCommonDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf8' }).trim();
  } catch { /* not in a git repo — fall back to CWD */ }
  const dir = resolveStateDir(gitCommonDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function stateKey(prUrl: string): string {
  // Extract PR number from URL
  const m = prUrl.match(/\/pull\/(\d+)/);
  return m ? `pr-${m[1]}` : prUrl.replace(/[^a-zA-Z0-9]/g, '-');
}

export function loadState(prUrl: string, dir?: string): ReviewFixState | null {
  const d = dir ?? stateDir();
  const path = join(d, `${stateKey(prUrl)}.json`);
  if (!existsSync(path)) return null;
  const raw = readJsonValueFile(path);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    return normalizeReviewFixState(raw as ReviewFixState);
  } catch {
    return null;
  }
}

export function saveState(state: ReviewFixState, dir?: string): void {
  const d = dir ?? stateDir();
  const path = join(d, `${stateKey(state.prUrl)}.json`);
  writeJsonObjectFile(path, state as unknown as Record<string, unknown>, { trailingNewline: false });
}

// ── Transition guard (#929, #939) ────────────────────────────────────

const VALID_TRANSITION_PHASES = new Set(['needs_review', 'needs_fix', 'fix_running']);

/**
 * Validate whether a manual --transition is permitted.
 *
 * Guards against gaming the review gate:
 *   1. Requires at least one finding for the current round (evidence of review)
 *   2. Blocks if any finding is MUST-FIX (confidence >= 80, non-DONE)
 *   3. Rejects unknown target phases
 *
 * Pure function — no I/O, fully testable.
 */
export function validateTransition(
  targetPhase: string,
  _state: ReviewFixState, // reserved: future phase-from→phase-to validation; currently unused
  findings: ReviewFinding[],
): { allowed: boolean; reason?: string } {
  if (!VALID_TRANSITION_PHASES.has(targetPhase)) {
    return { allowed: false, reason: `Invalid target phase: "${targetPhase}". Valid phases: ${[...VALID_TRANSITION_PHASES].join(', ')}` };
  }
  if (findings.length === 0) {
    return { allowed: false, reason: 'Transition blocked: no findings recorded for the current round. Run the review battery first.' };
  }
  const mustFix = findings.filter(
    (f) => f.status !== 'DONE' && (f.confidence ?? 0) >= 80,
  );
  if (mustFix.length > 0) {
    return {
      allowed: false,
      reason: `Transition blocked: ${mustFix.length} MUST-FIX finding${mustFix.length !== 1 ? 's' : ''} remain. Fix all MUST-FIX items before advancing.`,
    };
  }
  return { allowed: true };
}

// ── CLI ─────────────────────────────────────────────────────────────

export interface CliArgs {
  prUrl: string;
  issueNum: string;
  repo: string;
  reviewProvider: ReviewFixProvider;
  fixProvider: ReviewFixProvider;
  dryRun: boolean;
  maxRounds: number;
  budgetCap: number;
  resume: boolean;
  cwd?: string;
}

export function parseArgs(argv = process.argv): CliArgs {
  const args = argv.slice(2);
  let prUrl = '', issueNum = '', repo = '';
  let dryRun = false, resume = false, maxRounds = MAX_FIX_ROUNDS, budgetCap = BUDGET_CAP_USD;
  const defaults = defaultReviewFixProviders();
  let reviewProvider = defaults.reviewProvider;
  let fixProvider = defaults.fixProvider;
  let cwd: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--pr': prUrl = args[++i] ?? ''; break;
      case '--issue': issueNum = args[++i] ?? ''; break;
      case '--repo': repo = args[++i] ?? ''; break;
      case '--review-provider': reviewProvider = parseProviderName(args[++i] ?? '', '--review-provider'); break;
      case '--fix-provider': fixProvider = parseProviderName(args[++i] ?? '', '--fix-provider'); break;
      case '--dry-run': dryRun = true; break;
      case '--resume': resume = true; break;
      case '--max-rounds': maxRounds = parseInt(args[++i] ?? '3', 10); break;
      case '--budget': budgetCap = parseFloat(args[++i] ?? '2'); break;
      case '--cwd': cwd = args[++i]; break;
    }
  }

  if (!prUrl || !issueNum || !repo) {
    console.error(`review-fix — Review a PR against its issue, fix gaps, re-review.

Usage:
  npx tsx scripts/review-fix.ts --pr <url> --issue <num> --repo <owner/repo> [options]

Options:
  --dry-run       Review only, show fix prompt, don't execute
  --resume        Resume from last saved state (skips completed rounds)
  --max-rounds N  Max review-fix rounds (default: ${MAX_FIX_ROUNDS})
  --budget N      Budget cap in USD (default: ${BUDGET_CAP_USD})
  --review-provider claude|codex
                  Review provider to record/pass to the review battery (default: claude)
  --fix-provider claude|codex
                  Fix provider for spawned repair sessions (default: claude)
  --cwd DIR       Repository/worktree root for provider subprocesses (default: current directory)

State is saved to .claude/review-fix/pr-<N>.json after each phase.
Use --resume to pick up where you left off after a crash/timeout.

Example:
  npx tsx scripts/review-fix.ts \\
    --pr https://github.com/Garsson-io/kaizen/pull/832 \\
    --issue 666 --repo Garsson-io/kaizen --dry-run`);
    process.exit(1);
  }

  const validation = validateReviewFixProviderPlan({ reviewProvider, fixProvider });
  if (!validation.ok) {
    console.error(`Provider plan rejected: ${validation.violations.map((v) => v.reason).join('; ')}`);
    process.exit(1);
  }

  return { prUrl, issueNum, repo, reviewProvider, fixProvider, dryRun, maxRounds, budgetCap, resume, cwd };
}

// ── Pre-fetch context ───────────────────────────────────────────────

function gh(cmd: string): string {
  try { return ghExec(`gh ${cmd}`); } catch { return ''; }
}

function prefetch(prUrl: string, issueNum: string, repo: string) {
  console.log('Prefetching context...');
  const issueBody = gh(`issue view ${issueNum} --repo ${repo} --json title,body --jq '.title + "\\n\\n" + .body'`);
  const prBody = gh(`pr view ${prUrl} --json title,body --jq '.title + "\\n\\n" + .body'`);
  const prDiff = gh(`pr diff ${prUrl}`);
  const prBranch = gh(`pr view ${prUrl} --json headRefName --jq '.headRefName'`);
  const prState = gh(`pr view ${prUrl} --json state --jq '.state'`);
  const isMerged = prState === 'MERGED';

  console.log(`  Issue #${issueNum}: ${issueBody.split('\n')[0].slice(0, 80)}`);
  console.log(`  PR: ${prBody.split('\n')[0].slice(0, 80)}`);
  console.log(`  Branch: ${prBranch} (${prState})`);
  console.log(`  Diff: ${prDiff.split('\n').length} lines`);

  return { issueBody, prBody, prDiff, prBranch, isMerged };
}

// ── Fix prompt ──────────────────────────────────────────────────────

export function buildFixPrompt(
  issueNum: string,
  repo: string,
  prUrl: string,
  prBranch: string,
  issueBody: string,
  findings: ReviewFinding[],
  isMerged: boolean,
): string {
  const gaps = findings.filter(f => f.status !== 'DONE');
  const gapList = gaps.map((f, i) =>
    `${i + 1}. [${f.status}] ${f.requirement}\n   ${f.detail}`
  ).join('\n\n');

  const checkoutInstructions = isMerged
    ? `This PR is already MERGED. The branch "${prBranch}" may be deleted.
To fix gaps, create a follow-up branch from main:
1. \`git checkout main && git pull\`
2. \`git checkout -b fix/${issueNum}-review-gaps\`
3. Make your fixes on this new branch
4. Push and create a new PR: \`gh pr create --title "fix: address review gaps for #${issueNum}" --body "Follow-up to ${prUrl}. Addresses requirement gaps found by adversarial review."\``
    : `1. Check out the PR branch: \`git checkout ${prBranch}\` (or \`gh pr checkout ${prUrl}\`)`;

  return `You are fixing requirement gaps in a PR.

## Issue #${issueNum}

${issueBody.slice(0, 3000)}

## PR: ${prUrl}

## Gaps Found by Adversarial Review

${gapList}

## Instructions

${checkoutInstructions}
2. Read the current state: \`gh pr diff ${prUrl}\`
3. For each gap:
   - MISSING: implement what's missing
   - PARTIAL: complete what's incomplete
   - If a gap is out of scope, explain why and skip it
4. Run tests: \`npm test\`
5. Commit with a message referencing the gap: \`git commit -m "fix: address review finding — <requirement>"\`
6. Push: \`git push\`

## Stop Conditions

Stop when ONE of:
1. All addressable gaps are fixed, committed, and pushed
2. A gap requires changes beyond this PR's scope (explain and skip)
3. Tests fail and you can't fix them in 3 attempts

Be surgical. Fix gaps, don't refactor. Minimum viable fix for each finding.`;
}

// ── Fix session ─────────────────────────────────────────────────────

/**
 * Launch a fix session as a detached background process.
 * Returns immediately with the PID and log path.
 * The caller should save these to state and exit.
 * On --resume, call checkFixResult() to see if it's done.
 */
function launchFix(prompt: string, logDir: string, round: number, provider: ReviewFixProvider, repoRoot = process.cwd()): { pid: number; logFile: string; promptFile: string; provider: ReviewFixProvider } {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const promptFile = join(logDir, `fix-round${round}-${timestamp}.prompt.txt`);
  const logFile = join(logDir, `fix-round${round}-${timestamp}.log`);

  writeFileSync(promptFile, prompt);

  // Spawn the selected fix provider as a detached process — survives parent exit.
  const out = openSync(logFile, 'w');
  const err = openSync(logFile + '.stderr', 'w');
  const stdin = openSync(promptFile, 'r');
  const command = buildFixProviderCommand({ provider, repoRoot });

  const child = asyncSpawn(command.command, command.args, {
    cwd: repoRoot,
    detached: true,
    stdio: [stdin, out, err],
  });
  child.on('error', (spawnError) => {
    const message = `Provider spawn error: ${spawnError.message}\n`;
    writeFileSync(logFile, message, { flag: 'a' });
    writeFileSync(logFile + '.stderr', message, { flag: 'a' });
  });

  child.unref();
  const pid = child.pid ?? 0;

  // Write a PID file for monitoring
  writeFileSync(logFile + '.pid', String(pid));

  console.log(`  Fix session launched (detached)`);
  console.log(`  Provider: ${providerLabel(provider)}`);
  console.log(`  PID: ${pid}`);
  console.log(`  Prompt: ${promptFile}`);
  console.log(`  Log: ${logFile}`);
  console.log(`  Monitor: tail -f ${logFile}`);

  return { pid, logFile, promptFile, provider };
}

/**
 * Check if a detached fix session has completed.
 * Returns null if still running, or the result if done.
 */
export function checkFixResult(logFile: string, pid: number, provider: ReviewFixProvider = DEFAULT_REVIEW_FIX_PROVIDER): { done: boolean; success: boolean; costUsd: number; output: string } {
  // Check if process is still running
  let running = false;
  if (pid > 0) {
    try {
      process.kill(pid, 0); // signal 0 = check if alive
      running = true;
    } catch {
      running = false;
    }
  }

  if (!existsSync(logFile)) {
    return { done: !running, success: false, costUsd: 0, output: '' };
  }

  const stdout = readFileSync(logFile, 'utf8');
  const stderrFile = logFile + '.stderr';
  const stderr = existsSync(stderrFile) ? readFileSync(stderrFile, 'utf8').slice(0, 500) : '';

  // If process is still running and log is empty, nothing has happened yet
  if (running && !stdout.trim()) {
    return { done: false, success: false, costUsd: 0, output: '' };
  }

  // Parse provider-specific JSONL — look for the final result message.
  if (provider.provider === 'codex') {
    const parsedCodex = parseCodexJsonl(stdout);
    const assessment = assessCodexRun(parsedCodex);
    const output = parsedCodex.finalText || parsedCodex.text;
    if (running && !assessment.hasTerminalEvent) {
      return { done: false, success: false, costUsd: 0, output: '' };
    }
    if (assessment.hasTerminalEvent) {
      return {
        done: true,
        success: assessment.failureNotes.length === 0,
        costUsd: 0,
        output: output || stderr,
      };
    }
    if (running) {
      return { done: false, success: false, costUsd: 0, output: '' };
    }
    const malformed = parsedCodex.malformedLines.slice(0, 3).join('\n');
    return { done: true, success: false, costUsd: 0, output: malformed || output || stderr || stdout.slice(0, 500) };
  }

  const parsed = parseStreamJsonResult(stdout);
  if (parsed.found) {
    return { done: true, success: parsed.success, costUsd: parsed.costUsd, output: parsed.output };
  }

  // No result line yet
  if (running) {
    return { done: false, success: false, costUsd: 0, output: '' };
  }
  // Process exited without a result line — failure
  console.log(`  Fix stderr: ${stderr}`);
  return { done: true, success: false, costUsd: 0, output: stdout.slice(0, 500) };
}

// ── Main loop (injectable for testing) ──────────────────────────────

export async function runFixLoop(opts: CliArgs, deps: RunFixLoopDeps = {}): Promise<ReviewFixState> {
  const doPrefetch = deps.prefetch ?? prefetch;
  const doLaunchFix = deps.launchFix ?? launchFix;
  const doCheckFix = deps.checkFix ?? checkFixResult;
  const doRunReview = deps.runReview ?? reviewBattery;
  const doStateDir = deps.getStateDir ?? stateDir;
  const repoRoot = opts.cwd ?? process.cwd();
  const providerDefaults = defaultReviewFixProviders();
  const requestedProviders = {
    reviewProvider: opts.reviewProvider ?? providerDefaults.reviewProvider,
    fixProvider: opts.fixProvider ?? providerDefaults.fixProvider,
  };
  const providerValidation = validateReviewFixProviderPlan(requestedProviders, deps.providerInventory);
  if (!providerValidation.ok) {
    throw new Error(`Provider plan rejected: ${providerValidation.violations.map((v) => v.reason).join('; ')}`);
  }

  // Resume or start fresh
  let state: ReviewFixState;
  const existing = loadState(opts.prUrl, doStateDir());
  if (opts.resume && existing && !existing.outcome) {
    state = normalizeReviewFixState(existing);
    console.log(`\n=== review-fix: RESUMING ===`);
    console.log(`  Phase: ${state.phase} | Round: ${state.currentRound}`);
    console.log(`  Previous cost: $${state.totalCostUsd.toFixed(2)} | Rounds completed: ${state.rounds.length}`);
  } else {
    state = {
      prUrl: opts.prUrl,
      issueNum: opts.issueNum,
      repo: opts.repo,
      reviewProvider: requestedProviders.reviewProvider,
      fixProvider: requestedProviders.fixProvider,
      maxRounds: opts.maxRounds,
      budgetCap: opts.budgetCap,
      currentRound: 1,
      totalCostUsd: 0,
      startedAt: new Date().toISOString(),
      phase: 'needs_review',
      rounds: [],
    };
  }
  state = normalizeReviewFixState(state);

  console.log(`\n=== review-fix: ${opts.prUrl} vs #${opts.issueNum} ===\n`);
  console.log(`  Review provider: ${providerLabel(state.reviewProvider ?? providerDefaults.reviewProvider)}`);
  console.log(`  Fix provider: ${providerLabel(state.fixProvider ?? providerDefaults.fixProvider)}`);

  const statePath = join(doStateDir(), stateKey(opts.prUrl) + '.json');
  const ctx = doPrefetch(opts.prUrl, opts.issueNum, opts.repo);
  state.prBranch = ctx.prBranch;
  state.isMerged = ctx.isMerged;
  saveState(state, doStateDir());
  console.log(`  State: ${statePath}`);
  console.log('');

  // ── Check if a fix session is still running ──
  if (state.phase === 'fix_running') {
    const pid = state.activeFix?.pid;
    const logFile = state.activeFix?.logFile;
    console.log(`--- Checking fix session (PID ${pid ?? 'unknown'}) ---`);

    const { action, state: nextState } = applyFixRunningPhase(state, doCheckFix);
    state = nextState;

    if (action === 'reset') {
      console.log('  Warning: fix_running phase but no activeFix record — resetting to review');
      saveState(state, doStateDir());
    } else if (action === 'wait') {
      console.log(`  Fix session still running (PID ${pid})`);
      console.log(`  Monitor: tail -f ${logFile}`);
      console.log(`  Re-run with --resume to check again.`);
      return state;
    } else {
      const lastFix = state.rounds[state.rounds.length - 1];
      console.log(`  Fix session completed | Cost: $${lastFix?.fixCost.toFixed(2)} | Success: ${lastFix?.verdict === 'fixed'}`);
      saveState(state, doStateDir());
    }
  }

  // ── Main review-fix loop ──
  // Use stored maxRounds on resume so the original limit is respected.
  const maxRounds = resolveMaxRounds(opts, state);
  for (let round = state.currentRound; round <= maxRounds; round++) {
    state.currentRound = round;
    state.phase = 'needs_review';
    saveState(state, doStateDir());

    // ── REVIEW ──
    console.log(`--- Round ${round}/${maxRounds}: REVIEW ---`);

    const dimensions = listPrDimensions();
    const battery = await doRunReview({
      dimensions,
      prUrl: opts.prUrl,
      issueNum: opts.issueNum,
      repo: opts.repo,
      cwd: repoRoot,
      timeoutMs: 180_000,
      reviewProvider: state.reviewProvider,
    });

    state.totalCostUsd += battery.costUsd;
    state.reviewProvider = battery.reviewProvider ?? state.reviewProvider;
    const allFindings = battery.dimensions.flatMap(d => d.findings);
    const gaps = allFindings.filter(f => f.status !== 'DONE');

    console.log(`  Cost: $${battery.costUsd.toFixed(2)} | Findings: ${allFindings.length} | Gaps: ${gaps.length}`);
    for (const f of allFindings) {
      const icon = f.status === 'DONE' ? 'PASS' : f.status;
      console.log(`  ${icon}: ${f.requirement}`);
    }

    // ── REVIEW FAILED? ──
    if (battery.dimensions.length === 0) {
      console.log('  Review failed (timeout or parse). Run with --resume to retry.');
      state.rounds.push({
        round,
        phase: 'review',
        verdict: 'review_failed',
        gaps: -1,
        reviewCost: battery.costUsd,
        fixCost: 0,
        reviewProvider: battery.reviewProvider ?? state.reviewProvider,
      });
      saveState(state, doStateDir());
      continue;
    }

    state.rounds.push({
      round, phase: 'review', verdict: battery.verdict,
      gaps: gaps.length, reviewCost: battery.costUsd, fixCost: 0,
      reviewProvider: battery.reviewProvider ?? state.reviewProvider,
      findings: allFindings,
    });
    saveState(state, doStateDir());

    // ── PASS? ──
    if (battery.verdict === 'pass') {
      console.log(`\n=== PASS after ${round} round(s) ===\n`);
      console.log(formatBatteryReport(battery));
      state.outcome = 'pass';
      state.phase = 'done';
      saveState(state, doStateDir());
      // Update PR body Validation section and store review report as attachment (best effort)
      try {
        const prNum = opts.prUrl.match(/\/pull\/(\d+)/)?.[1] ?? '';
        if (prNum && opts.repo) {
          const prTarget = { kind: 'pr' as const, number: prNum, repo: opts.repo };
          addSection(prTarget, 'Validation', `REVIEW PASSED — ${round} round(s), $${state.totalCostUsd.toFixed(2)} total cost\n\n${formatBatteryReport(battery)}`);
          writeAttachment(prTarget, 'review-battery', formatBatteryReport(battery));
        }
      } catch { /* best effort */ }
      return state;
    }

    // ── BUDGET? ──
    if (state.totalCostUsd >= opts.budgetCap) {
      console.log(`\nBudget exceeded ($${state.totalCostUsd.toFixed(2)} >= $${opts.budgetCap})`);
      state.outcome = 'budget_exceeded';
      state.phase = 'done';
      saveState(state, doStateDir());
      return state;
    }

    // ── DRY RUN? ──
    if (opts.dryRun) {
      console.log('\n--dry-run: showing fix prompt, not executing\n');
      console.log(buildFixPrompt(opts.issueNum, opts.repo, opts.prUrl, ctx.prBranch, ctx.issueBody, allFindings, ctx.isMerged));
      state.outcome = 'dry_run';
      state.phase = 'done';
      saveState(state, doStateDir());
      return state;
    }

    // ── NO ACTIONABLE GAPS? (kaizen #897) ──
    // Verdict can be 'fail' due to timed-out/failed dimensions even when
    // all returned findings are DONE. Don't launch a fix with nothing to fix.
    // Also: when ALL gaps are [data-gap] findings (missing plan text etc.),
    // a fix agent can't resolve them — they need the caller to provide data.
    const codeGaps = gaps.filter(f => !f.requirement.startsWith(DATA_GAP_PREFIX));
    if (gaps.length === 0 || codeGaps.length === 0) {
      const reason = gaps.length === 0
        ? `${battery.failedDimensions.length} dim(s) failed to return results`
        : `${gaps.length} gap(s) are all data-availability issues (e.g. missing plan text), not code gaps`;
      console.log(`\nVerdict is fail but no actionable code gaps (${reason}). Run with --resume to retry.`);
      state.outcome = 'no_actionable_gaps';
      state.phase = 'done';
      saveState(state, doStateDir());
      return state;
    }

    // ── LAST ROUND? ──
    if (round === maxRounds) {
      console.log(`\nMax rounds (${maxRounds}) reached with ${gaps.length} remaining gaps`);
      console.log(formatBatteryReport(battery));
      state.outcome = 'max_rounds';
      state.phase = 'done';
      saveState(state, doStateDir());
      return state;
    }

    // ── LAUNCH FIX (detached) ──
    console.log(`\n--- Round ${round}/${maxRounds}: LAUNCHING FIX (${gaps.length} gaps) ---`);
    const fixPrompt = buildFixPrompt(
      opts.issueNum, opts.repo, opts.prUrl, ctx.prBranch, ctx.issueBody, allFindings, ctx.isMerged,
    );
    const fixProvider = state.fixProvider ?? providerDefaults.fixProvider;
    const fixInfo = doLaunchFix(fixPrompt, doStateDir(), round, fixProvider, repoRoot);
    state.phase = 'fix_running';
    state.activeFix = { ...fixInfo, provider: fixInfo.provider ?? fixProvider };
    saveState(state, doStateDir());

    console.log(`\n  Fix session is running in the background.`);
    console.log(`  Run \`tail -f ${fixInfo.logFile}\` to observe.`);
    console.log(`  Run \`npx tsx scripts/review-fix.ts --pr ${opts.prUrl} --issue ${opts.issueNum} --repo ${opts.repo}${opts.cwd ? ` --cwd ${opts.cwd}` : ''} --resume\` when done.`);
    return state;
  }

  return state;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const startTime = Date.now();
  const state = await runFixLoop(opts);
  finish(state, startTime);
}

function finish(state: ReviewFixState, startTime: number) {
  const duration = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n=== review-fix summary ===`);
  console.log(`Outcome: ${state.outcome}`);
  console.log(`Rounds: ${state.rounds.length}`);
  console.log(`Total cost: $${state.totalCostUsd.toFixed(2)}`);
  console.log(`Duration: ${duration}s`);
  console.log(`State: ${join(stateDir(), stateKey(state.prUrl) + '.json')}`);
  console.log('');
  console.log('| Round | Phase | Verdict | Gaps | Review$ | Fix$ |');
  console.log('|-------|-------|---------|------|---------|------|');
  for (const r of state.rounds) {
    console.log(`| ${r.round} | ${r.phase} | ${r.verdict} | ${r.gaps} | $${r.reviewCost.toFixed(2)} | $${r.fixCost.toFixed(2)} |`);
  }

  process.exit(state.outcome === 'pass' ? 0 : 1);
}

if (process.argv[1]?.endsWith('review-fix.ts') || process.argv[1]?.endsWith('review-fix.js')) {
  main();
}
