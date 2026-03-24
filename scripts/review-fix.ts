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

import { spawnSync, execSync } from 'node:child_process';
import {
  reviewBattery,
  formatBatteryReport,
  MAX_FIX_ROUNDS,
  BUDGET_CAP_USD,
  type ReviewDimension,
  type BatteryResult,
  type ReviewFinding,
} from '../src/review-battery.js';

// ── CLI ─────────────────────────────────────────────────────────────

interface CliArgs {
  prUrl: string;
  issueNum: string;
  repo: string;
  dryRun: boolean;
  maxRounds: number;
  budgetCap: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let prUrl = '', issueNum = '', repo = '';
  let dryRun = false, maxRounds = MAX_FIX_ROUNDS, budgetCap = BUDGET_CAP_USD;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--pr': prUrl = args[++i] ?? ''; break;
      case '--issue': issueNum = args[++i] ?? ''; break;
      case '--repo': repo = args[++i] ?? ''; break;
      case '--dry-run': dryRun = true; break;
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
  --max-rounds N  Max review-fix rounds (default: ${MAX_FIX_ROUNDS})
  --budget N      Budget cap in USD (default: ${BUDGET_CAP_USD})

Example:
  npx tsx scripts/review-fix.ts \\
    --pr https://github.com/Garsson-io/kaizen/pull/832 \\
    --issue 666 --repo Garsson-io/kaizen --dry-run`);
    process.exit(1);
  }

  return { prUrl, issueNum, repo, dryRun, maxRounds, budgetCap };
}

// ── Pre-fetch context ───────────────────────────────────────────────

function gh(cmd: string): string {
  try {
    return execSync(`gh ${cmd}`, { encoding: 'utf8', timeout: 30_000 }).trim();
  } catch {
    return '';
  }
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

function spawnFix(prompt: string): { success: boolean; costUsd: number; output: string } {
  const result = spawnSync('claude', [
    '-p', prompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--model', 'sonnet',
  ], {
    encoding: 'utf8',
    timeout: 600_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let costUsd = 0, output = '';
  try {
    const parsed = JSON.parse(result.stdout);
    output = parsed.result ?? '';
    costUsd = parsed.cost_usd ?? parsed.total_cost_usd ?? 0;
  } catch {
    output = result.stdout;
  }

  return { success: result.status === 0, costUsd, output };
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs();
  let totalCost = 0;
  const startTime = Date.now();
  const rounds: Array<{ verdict: string; gaps: number; reviewCost: number; fixCost: number }> = [];

  console.log(`\n=== review-fix: ${opts.prUrl} vs #${opts.issueNum} ===\n`);

  const ctx = prefetch(opts.prUrl, opts.issueNum, opts.repo);
  console.log('');

  for (let round = 1; round <= opts.maxRounds; round++) {
    // ── REVIEW ──
    console.log(`--- Round ${round}/${opts.maxRounds}: REVIEW ---`);

    const battery = reviewBattery({
      dimensions: ['requirements'] as ReviewDimension[],
      prUrl: opts.prUrl,
      issueNum: opts.issueNum,
      repo: opts.repo,
      timeoutMs: 120_000,
    });

    totalCost += battery.costUsd;
    const allFindings = battery.dimensions.flatMap(d => d.findings);
    const gaps = allFindings.filter(f => f.status !== 'DONE');

    console.log(`  Cost: $${battery.costUsd.toFixed(2)} | Findings: ${allFindings.length} | Gaps: ${gaps.length}`);
    for (const f of allFindings) {
      const icon = f.status === 'DONE' ? 'PASS' : f.status;
      console.log(`  ${icon}: ${f.requirement}`);
    }

    // ── PASS? ──
    if (battery.verdict === 'pass') {
      rounds.push({ verdict: 'pass', gaps: 0, reviewCost: battery.costUsd, fixCost: 0 });
      console.log(`\n=== PASS after ${round} round(s) ===\n`);
      console.log(formatBatteryReport(battery));
      finish(rounds, totalCost, startTime, 'pass');
      return;
    }

    // ── BUDGET? ──
    if (totalCost >= opts.budgetCap) {
      rounds.push({ verdict: 'budget', gaps: gaps.length, reviewCost: battery.costUsd, fixCost: 0 });
      console.log(`\nBudget exceeded ($${totalCost.toFixed(2)} >= $${opts.budgetCap})`);
      finish(rounds, totalCost, startTime, 'budget_exceeded');
      return;
    }

    // ── DRY RUN? ──
    if (opts.dryRun) {
      rounds.push({ verdict: 'dry_run', gaps: gaps.length, reviewCost: battery.costUsd, fixCost: 0 });
      console.log('\n--dry-run: showing fix prompt, not executing\n');
      console.log(buildFixPrompt(opts.issueNum, opts.repo, opts.prUrl, ctx.prBranch, ctx.issueBody, allFindings, ctx.isMerged));
      finish(rounds, totalCost, startTime, 'dry_run');
      return;
    }

    // ── LAST ROUND? ──
    if (round === opts.maxRounds) {
      rounds.push({ verdict: 'max_rounds', gaps: gaps.length, reviewCost: battery.costUsd, fixCost: 0 });
      console.log(`\nMax rounds (${opts.maxRounds}) reached with ${gaps.length} remaining gaps`);
      console.log(formatBatteryReport(battery));
      finish(rounds, totalCost, startTime, 'max_rounds');
      return;
    }

    // ── FIX ──
    console.log(`\n--- Round ${round}/${opts.maxRounds}: FIX (${gaps.length} gaps) ---`);
    const fixPrompt = buildFixPrompt(
      opts.issueNum, opts.repo, opts.prUrl, ctx.prBranch, ctx.issueBody, allFindings, ctx.isMerged,
    );
    const fix = spawnFix(fixPrompt);
    totalCost += fix.costUsd;

    console.log(`  Fix cost: $${fix.costUsd.toFixed(2)} | Success: ${fix.success}`);
    rounds.push({ verdict: 'fixed', gaps: gaps.length, reviewCost: battery.costUsd, fixCost: fix.costUsd });

    if (!fix.success) {
      console.log('Fix session failed. Stopping.');
      finish(rounds, totalCost, startTime, 'fix_failed');
      return;
    }

    console.log('Fix session done. Re-reviewing...\n');
  }
}

function finish(
  rounds: Array<{ verdict: string; gaps: number; reviewCost: number; fixCost: number }>,
  totalCost: number,
  startTime: number,
  outcome: string,
) {
  const duration = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n=== review-fix summary ===`);
  console.log(`Outcome: ${outcome}`);
  console.log(`Rounds: ${rounds.length}`);
  console.log(`Total cost: $${totalCost.toFixed(2)}`);
  console.log(`Duration: ${duration}s`);
  console.log('');
  console.log('| Round | Verdict | Gaps | Review$ | Fix$ |');
  console.log('|-------|---------|------|---------|------|');
  for (const [i, r] of rounds.entries()) {
    console.log(`| ${i + 1} | ${r.verdict} | ${r.gaps} | $${r.reviewCost.toFixed(2)} | $${r.fixCost.toFixed(2)} |`);
  }

  process.exit(outcome === 'pass' ? 0 : 1);
}

main();
