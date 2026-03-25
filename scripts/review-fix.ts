#!/usr/bin/env npx tsx
/**
 * review-fix.ts — Full review-fix cycle for a PR against its issue.
 *
 * Usage:
 *   npx tsx scripts/review-fix.ts --pr <url> --issue <num> --repo <owner/repo>
 *   npx tsx scripts/review-fix.ts --pr <url> --issue <num> --repo <owner/repo> --dry-run
 *
 * Flow:
 *   1. REVIEW: Run requirements battery (claude -p) → structured findings
 *   2. If PASS → done
 *   3. If gaps → FIX: Spawn claude -p session that:
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

import { spawn as asyncSpawn, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import {
  reviewBattery,
  formatBatteryReport,
  listDimensions,
  MAX_FIX_ROUNDS,
  BUDGET_CAP_USD,
  type BatteryResult,
  type ReviewFinding,
} from '../src/review-battery.js';
import { ghExec } from './auto-dent-github.js';

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
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const msg = JSON.parse(line.trim());
      if (msg.type === 'result') {
        return {
          found: true,
          success: msg.subtype !== 'error_during_generation',
          // total_cost_usd is a top-level field on the result message (not nested in usage)
          costUsd: msg.total_cost_usd ?? 0,
          output: msg.result ?? '',
        };
      }
    } catch { continue; }
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
  checkFn: (logFile: string, pid: number) => { done: boolean; success: boolean; costUsd: number; output: string },
): { action: FixRunningAction; state: ReviewFixState } {
  if (!state.activeFix) {
    return { action: 'reset', state: { ...state, phase: 'needs_review' } };
  }
  const { pid, logFile } = state.activeFix;
  const result = checkFn(logFile, pid);
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
      { round: state.currentRound, phase: 'fix', verdict: result.success ? 'fixed' : 'fix_failed', gaps: 0, reviewCost: 0, fixCost: result.costUsd },
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

// ── State persistence ───────────────────────────────────────────────

interface ReviewFixState {
  prUrl: string;
  issueNum: string;
  repo: string;
  maxRounds: number;
  budgetCap: number;
  currentRound: number;
  totalCostUsd: number;
  startedAt: string;
  /** Current phase within a round */
  phase: 'needs_review' | 'needs_fix' | 'fix_running' | 'done';
  /** Active fix session (when phase is fix_running) */
  activeFix?: { pid: number; logFile: string; promptFile: string };
  rounds: Array<{
    round: number;
    phase: 'review' | 'fix' | 'done';
    verdict: string;
    gaps: number;
    reviewCost: number;
    fixCost: number;
    findings?: ReviewFinding[];
  }>;
  outcome?: string;
  prBranch?: string;
  isMerged?: boolean;
}

function stateDir(): string {
  const dir = join(process.cwd(), '.claude', 'review-fix');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function stateKey(prUrl: string): string {
  // Extract PR number from URL
  const m = prUrl.match(/\/pull\/(\d+)/);
  return m ? `pr-${m[1]}` : prUrl.replace(/[^a-zA-Z0-9]/g, '-');
}

function loadState(prUrl: string): ReviewFixState | null {
  const path = join(stateDir(), `${stateKey(prUrl)}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state: ReviewFixState): void {
  const path = join(stateDir(), `${stateKey(state.prUrl)}.json`);
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// ── CLI ─────────────────────────────────────────────────────────────

interface CliArgs {
  prUrl: string;
  issueNum: string;
  repo: string;
  dryRun: boolean;
  maxRounds: number;
  budgetCap: number;
  resume: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let prUrl = '', issueNum = '', repo = '';
  let dryRun = false, resume = false, maxRounds = MAX_FIX_ROUNDS, budgetCap = BUDGET_CAP_USD;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--pr': prUrl = args[++i] ?? ''; break;
      case '--issue': issueNum = args[++i] ?? ''; break;
      case '--repo': repo = args[++i] ?? ''; break;
      case '--dry-run': dryRun = true; break;
      case '--resume': resume = true; break;
      case '--max-rounds': maxRounds = parseInt(args[++i] ?? '3', 10); break;
      case '--budget': budgetCap = parseFloat(args[++i] ?? '2'); break;
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

State is saved to .claude/review-fix/pr-<N>.json after each phase.
Use --resume to pick up where you left off after a crash/timeout.

Example:
  npx tsx scripts/review-fix.ts \\
    --pr https://github.com/Garsson-io/kaizen/pull/832 \\
    --issue 666 --repo Garsson-io/kaizen --dry-run`);
    process.exit(1);
  }

  return { prUrl, issueNum, repo, dryRun, maxRounds, budgetCap, resume };
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

function buildFixPrompt(
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
function launchFix(prompt: string, logDir: string, round: number): { pid: number; logFile: string; promptFile: string } {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const promptFile = join(logDir, `fix-round${round}-${timestamp}.prompt.txt`);
  const logFile = join(logDir, `fix-round${round}-${timestamp}.log`);

  writeFileSync(promptFile, prompt);

  // Spawn claude as a detached process — survives parent exit
  const out = openSync(logFile, 'w');
  const err = openSync(logFile + '.stderr', 'w');

  const child = asyncSpawn('bash', [
    '-c',
    `cat "${promptFile}" | claude -p --output-format stream-json --verbose --dangerously-skip-permissions --model sonnet`,
  ], {
    detached: true,
    stdio: ['pipe', out, err],
  });

  child.unref();
  const pid = child.pid ?? 0;

  // Write a PID file for monitoring
  writeFileSync(logFile + '.pid', String(pid));

  console.log(`  Fix session launched (detached)`);
  console.log(`  PID: ${pid}`);
  console.log(`  Prompt: ${promptFile}`);
  console.log(`  Log: ${logFile}`);
  console.log(`  Monitor: tail -f ${logFile}`);

  return { pid, logFile, promptFile };
}

/**
 * Check if a detached fix session has completed.
 * Returns null if still running, or the result if done.
 */
export function checkFixResult(logFile: string, pid: number): { done: boolean; success: boolean; costUsd: number; output: string } {
  // Check if process is still running
  let running = false;
  try {
    process.kill(pid, 0); // signal 0 = check if alive
    running = true;
  } catch {
    running = false;
  }

  if (!existsSync(logFile)) {
    return { done: !running, success: false, costUsd: 0, output: '' };
  }

  const stdout = readFileSync(logFile, 'utf8');

  // If process is still running and log is empty, nothing has happened yet
  if (running && !stdout.trim()) {
    return { done: false, success: false, costUsd: 0, output: '' };
  }

  // Parse stream-json JSONL — look for the result message
  const parsed = parseStreamJsonResult(stdout);
  if (parsed.found) {
    return { done: true, success: parsed.success, costUsd: parsed.costUsd, output: parsed.output };
  }

  // No result line yet
  if (running) {
    return { done: false, success: false, costUsd: 0, output: '' };
  }
  // Process exited without a result line — failure
  const stderrFile = logFile + '.stderr';
  const stderr = existsSync(stderrFile) ? readFileSync(stderrFile, 'utf8').slice(0, 500) : '';
  console.log(`  Fix stderr: ${stderr}`);
  return { done: true, success: false, costUsd: 0, output: stdout.slice(0, 500) };
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs();
  const startTime = Date.now();

  // Resume or start fresh
  let state: ReviewFixState;
  const existing = loadState(opts.prUrl);
  if (opts.resume && existing && !existing.outcome) {
    state = existing;
    console.log(`\n=== review-fix: RESUMING ===`);
    console.log(`  Phase: ${state.phase} | Round: ${state.currentRound}`);
    console.log(`  Previous cost: $${state.totalCostUsd.toFixed(2)} | Rounds completed: ${state.rounds.length}`);
  } else {
    state = {
      prUrl: opts.prUrl,
      issueNum: opts.issueNum,
      repo: opts.repo,
      maxRounds: opts.maxRounds,
      budgetCap: opts.budgetCap,
      currentRound: 1,
      totalCostUsd: 0,
      startedAt: new Date().toISOString(),
      phase: 'needs_review',
      rounds: [],
    };
  }

  console.log(`\n=== review-fix: ${opts.prUrl} vs #${opts.issueNum} ===\n`);

  const statePath = join(stateDir(), stateKey(opts.prUrl) + '.json');
  const ctx = prefetch(opts.prUrl, opts.issueNum, opts.repo);
  state.prBranch = ctx.prBranch;
  state.isMerged = ctx.isMerged;
  saveState(state);
  console.log(`  State: ${statePath}`);
  console.log('');

  // ── Check if a fix session is still running ──
  if (state.phase === 'fix_running') {
    const pid = state.activeFix?.pid;
    const logFile = state.activeFix?.logFile;
    console.log(`--- Checking fix session (PID ${pid ?? 'unknown'}) ---`);

    const { action, state: nextState } = applyFixRunningPhase(state, checkFixResult);
    state = nextState;

    if (action === 'reset') {
      console.log('  Warning: fix_running phase but no activeFix record — resetting to review');
      saveState(state);
    } else if (action === 'wait') {
      console.log(`  Fix session still running (PID ${pid})`);
      console.log(`  Monitor: tail -f ${logFile}`);
      console.log(`  Re-run with --resume to check again.`);
      finish(state, startTime);
      return;
    } else {
      const lastFix = state.rounds[state.rounds.length - 1];
      console.log(`  Fix session completed | Cost: $${lastFix?.fixCost.toFixed(2)} | Success: ${lastFix?.verdict === 'fixed'}`);
      saveState(state);
    }
  }

  // ── Main review-fix loop ──
  // Use stored maxRounds on resume so the original limit is respected.
  const maxRounds = resolveMaxRounds(opts, state);
  for (let round = state.currentRound; round <= maxRounds; round++) {
    state.currentRound = round;
    state.phase = 'needs_review';
    saveState(state);

    // ── REVIEW ──
    console.log(`--- Round ${round}/${maxRounds}: REVIEW ---`);

    const dimensions = listDimensions().filter(d => d !== 'plan-coverage'); // plan-coverage is for pre-implementation
    const battery = reviewBattery({
      dimensions,
      prUrl: opts.prUrl,
      issueNum: opts.issueNum,
      repo: opts.repo,
      timeoutMs: 180_000,
    });

    state.totalCostUsd += battery.costUsd;
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
      state.rounds.push({ round, phase: 'review', verdict: 'review_failed', gaps: -1, reviewCost: battery.costUsd, fixCost: 0 });
      saveState(state);
      continue;
    }

    state.rounds.push({
      round, phase: 'review', verdict: battery.verdict,
      gaps: gaps.length, reviewCost: battery.costUsd, fixCost: 0,
      findings: allFindings,
    });
    saveState(state);

    // ── PASS? ──
    if (battery.verdict === 'pass') {
      console.log(`\n=== PASS after ${round} round(s) ===\n`);
      console.log(formatBatteryReport(battery));
      state.outcome = 'pass';
      state.phase = 'done';
      saveState(state);
      finish(state, startTime);
      return;
    }

    // ── BUDGET? ──
    if (state.totalCostUsd >= opts.budgetCap) {
      console.log(`\nBudget exceeded ($${state.totalCostUsd.toFixed(2)} >= $${opts.budgetCap})`);
      state.outcome = 'budget_exceeded';
      state.phase = 'done';
      saveState(state);
      finish(state, startTime);
      return;
    }

    // ── DRY RUN? ──
    if (opts.dryRun) {
      console.log('\n--dry-run: showing fix prompt, not executing\n');
      console.log(buildFixPrompt(opts.issueNum, opts.repo, opts.prUrl, ctx.prBranch, ctx.issueBody, allFindings, ctx.isMerged));
      state.outcome = 'dry_run';
      state.phase = 'done';
      saveState(state);
      finish(state, startTime);
      return;
    }

    // ── LAST ROUND? ──
    if (round === maxRounds) {
      console.log(`\nMax rounds (${maxRounds}) reached with ${gaps.length} remaining gaps`);
      console.log(formatBatteryReport(battery));
      state.outcome = 'max_rounds';
      state.phase = 'done';
      saveState(state);
      finish(state, startTime);
      return;
    }

    // ── LAUNCH FIX (detached) ──
    console.log(`\n--- Round ${round}/${maxRounds}: LAUNCHING FIX (${gaps.length} gaps) ---`);
    const fixPrompt = buildFixPrompt(
      opts.issueNum, opts.repo, opts.prUrl, ctx.prBranch, ctx.issueBody, allFindings, ctx.isMerged,
    );
    const fixInfo = launchFix(fixPrompt, stateDir(), round);
    state.phase = 'fix_running';
    state.activeFix = fixInfo;
    saveState(state);

    console.log(`\n  Fix session is running in the background.`);
    console.log(`  Run \`tail -f ${fixInfo.logFile}\` to observe.`);
    console.log(`  Run \`npx tsx scripts/review-fix.ts --pr ${opts.prUrl} --issue ${opts.issueNum} --repo ${opts.repo} --resume\` when done.`);
    finish(state, startTime);
    return;
  }
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
