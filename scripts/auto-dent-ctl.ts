#!/usr/bin/env npx tsx
/**
 * auto-dent-ctl — Control running auto-dent batches.
 *
 * Subcommands:
 *   status              List active batches with last-worked-on info
 *   halt [batch-id]     Halt a specific batch (or all active batches)
 *   score [batch-id]    Score batches — efficiency, success rate, cost-per-PR
 *   score --post-hoc    Include live merge status checks
 *   cleanup [batch-id]  Close superseded PRs whose issues are already resolved from GitHub
 *   watchdog [--threshold N]  Check active batches for stale heartbeats, halt if stuck
 *
 * Usage:
 *   npx tsx scripts/auto-dent-ctl.ts status
 *   npx tsx scripts/auto-dent-ctl.ts halt
 *   npx tsx scripts/auto-dent-ctl.ts halt batch-260321-0136-a1b2
 *   npx tsx scripts/auto-dent-ctl.ts watchdog --threshold 600
 */

import { readdirSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { BatchState, RunMetrics } from './auto-dent-run.js';
import { checkMergeStatus, cleanupSupersededPRs, loadPromptTemplate, renderTemplate } from './auto-dent-run.js';
import {
  scoreBatch,
  scoreRunMetrics,
  postHocScoreBatch,
  formatBatchScoreTable,
  formatRunScoreLine,
  formatPostHocLine,
} from './auto-dent-score.js';

function getRepoRoot(): string {
  try {
    const gitCommonDir = execSync(
      'git rev-parse --path-format=absolute --git-common-dir',
      { encoding: 'utf8' },
    ).trim();
    return gitCommonDir.replace(/\/\.git$/, '');
  } catch {
    return process.cwd();
  }
}

function getLogsDir(): string {
  return join(getRepoRoot(), 'logs', 'auto-dent');
}

export interface BatchInfo {
  batchId: string;
  dir: string;
  state: BatchState;
  active: boolean;
  halted: boolean;
}

export function discoverBatches(logsDir: string): BatchInfo[] {
  if (!existsSync(logsDir)) return [];

  const batches: BatchInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync(logsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const dir = join(logsDir, entry);
    const stateFile = join(dir, 'state.json');
    if (!existsSync(stateFile)) continue;

    try {
      const state: BatchState = JSON.parse(readFileSync(stateFile, 'utf8'));
      const haltFile = join(dir, 'HALT');
      batches.push({
        batchId: state.batch_id || entry,
        dir,
        state,
        active: !state.batch_end && !state.stop_reason,
        halted: existsSync(haltFile),
      });
    } catch {
      // Corrupt state file — skip
    }
  }

  return batches;
}

export function formatBatchStatus(batch: BatchInfo): string {
  const s = batch.state;
  const status = batch.halted
    ? 'HALT REQUESTED'
    : batch.active
      ? 'RUNNING'
      : s.stop_reason || 'STOPPED';

  const elapsed = Math.floor(
    (s.batch_end || Date.now() / 1000) - s.batch_start,
  );
  const hours = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);

  const totalCost = (s.run_history || []).reduce(
    (sum: number, r: any) => sum + (r.cost_usd || 0),
    0,
  );

  const lines = [
    `  Batch:     ${batch.batchId}`,
    `  Status:    ${status}`,
    `  Guidance:  ${s.guidance}`,
    `  Runs:      ${s.run}${s.max_runs > 0 ? ` / ${s.max_runs}` : ''}`,
    `  Duration:  ${hours}h ${mins}m`,
    `  Cost:      $${totalCost.toFixed(2)}`,
    `  PRs:       ${s.prs.length > 0 ? s.prs.join(' ') : 'none'}`,
  ];

  if (s.last_issue) lines.push(`  Last issue:    ${s.last_issue}`);
  if (s.last_pr) lines.push(`  Last PR:       ${s.last_pr}`);
  if (s.last_case) lines.push(`  Last case:     ${s.last_case}`);
  if (s.last_branch) lines.push(`  Last branch:   ${s.last_branch}`);
  if (s.last_worktree) lines.push(`  Last worktree: ${s.last_worktree}`);

  if (s.run_history && s.run_history.length > 0) {
    lines.push('  Runs:');
    for (const r of s.run_history) {
      const rm = Math.floor(r.duration_seconds / 60);
      const rs = r.duration_seconds % 60;
      const status = r.exit_code === 0 ? 'ok' : `exit ${r.exit_code}`;
      const prCount = r.prs.length;
      const issueCount =
        r.issues_filed.length + r.issues_closed.length;
      lines.push(
        `    #${r.run}: ${rm}m${rs}s $${r.cost_usd.toFixed(2)} ${r.tool_calls}tc ${status}${prCount > 0 ? ` ${prCount}PR` : ''}${issueCount > 0 ? ` ${issueCount}iss` : ''}${r.stop_requested ? ' STOP' : ''}`,
      );
    }
  }

  return lines.join('\n');
}

export function formatLastState(state: BatchState): string {
  const lines: string[] = [];
  lines.push('╔══════════════════════════════════════════════════════════╗');
  lines.push('║             auto-dent — Last Worked On                  ║');
  lines.push('╠══════════════════════════════════════════════════════════╣');
  lines.push(`║ Batch:       ${state.batch_id}`);
  lines.push(`║ Run:         ${state.run}`);
  if (state.last_issue) lines.push(`║ Last issue:    ${state.last_issue}`);
  if (state.last_pr) lines.push(`║ Last PR:       ${state.last_pr}`);
  if (state.last_case) lines.push(`║ Last case:     ${state.last_case}`);
  if (state.last_branch) lines.push(`║ Last branch:   ${state.last_branch}`);
  if (state.last_worktree)
    lines.push(`║ Last worktree: ${state.last_worktree}`);
  if (!state.last_issue && !state.last_pr && !state.last_case) {
    lines.push('║ (no artifacts tracked yet)');
  }
  lines.push('╚══════════════════════════════════════════════════════════╝');
  return lines.join('\n');
}

export function formatBatchScoreOutput(batch: BatchInfo, postHoc: boolean = false): string {
  const s = batch.state;
  const history = s.run_history || [];

  if (history.length === 0) {
    return `  Batch ${batch.batchId}: no run history to score.`;
  }

  const batchScore = scoreBatch(history);
  const lines: string[] = [
    `  Batch: ${batch.batchId}`,
    '',
    formatBatchScoreTable(batchScore),
    '',
    '  Per-run scores:',
  ];

  for (let i = 0; i < batchScore.runs.length; i++) {
    const runScore = batchScore.runs[i];
    const runNum = history[i].run;
    lines.push(`    #${runNum}: ${formatRunScoreLine(runScore)}`);
  }

  if (postHoc && s.prs.length > 0) {
    lines.push('');
    lines.push('  Post-hoc merge status:');
    const prStatuses = s.prs.map((url) => ({
      url,
      status: checkMergeStatus(url),
    }));
    const postHocResult = postHocScoreBatch(prStatuses, batchScore.total_cost_usd);
    batchScore.post_hoc = postHocResult;

    for (const pr of postHocResult.prs) {
      lines.push(`    ${pr.url} — ${pr.status}`);
    }
    lines.push(`  ${formatPostHocLine(postHocResult)}`);
  }

  return lines.join('\n');
}

export function haltBatch(batchDir: string): void {
  const haltFile = join(batchDir, 'HALT');
  writeFileSync(haltFile, `halted at ${new Date().toISOString()}\n`);
}

// Watchdog — detect stalled batches via heartbeat staleness

/** Default staleness threshold in seconds (10 minutes). */
export const DEFAULT_WATCHDOG_THRESHOLD_SEC = 600;

export interface WatchdogResult {
  batchId: string;
  heartbeatAge: number;
  stale: boolean;
  halted: boolean;
  action: 'halt_created' | 'already_halted' | 'healthy' | 'no_heartbeat';
}

/**
 * Check a single batch for heartbeat staleness.
 *
 * A batch is stale when:
 *   - It has a non-zero last_heartbeat AND
 *   - (now - last_heartbeat) > thresholdSec
 *
 * If the heartbeat is 0 (never set — batch hasn't started its first run
 * or is using an older runner), we report 'no_heartbeat' but don't halt.
 */
export function checkBatchHealth(
  batch: BatchInfo,
  thresholdSec: number,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): WatchdogResult {
  const heartbeat = batch.state.last_heartbeat || 0;

  if (heartbeat === 0) {
    return {
      batchId: batch.batchId,
      heartbeatAge: 0,
      stale: false,
      halted: batch.halted,
      action: 'no_heartbeat',
    };
  }

  const age = nowEpoch - heartbeat;
  const stale = age > thresholdSec;

  if (stale && !batch.halted) {
    return {
      batchId: batch.batchId,
      heartbeatAge: age,
      stale: true,
      halted: false,
      action: 'halt_created',
    };
  }

  if (stale && batch.halted) {
    return {
      batchId: batch.batchId,
      heartbeatAge: age,
      stale: true,
      halted: true,
      action: 'already_halted',
    };
  }

  return {
    batchId: batch.batchId,
    heartbeatAge: age,
    stale: false,
    halted: batch.halted,
    action: 'healthy',
  };
}

/**
 * Run the watchdog across all active batches.
 * Returns results for each batch checked. Creates HALT files for stale batches.
 */
export function runWatchdog(
  logsDir: string,
  thresholdSec: number = DEFAULT_WATCHDOG_THRESHOLD_SEC,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): WatchdogResult[] {
  const batches = discoverBatches(logsDir);
  const active = batches.filter((b) => b.active);
  const results: WatchdogResult[] = [];

  for (const batch of active) {
    const result = checkBatchHealth(batch, thresholdSec, nowEpoch);
    if (result.action === 'halt_created') {
      haltBatch(batch.dir);
    }
    results.push(result);
  }

  return results;
}

export function formatWatchdogResult(result: WatchdogResult): string {
  const ageStr = result.heartbeatAge > 0
    ? `${Math.floor(result.heartbeatAge / 60)}m${result.heartbeatAge % 60}s`
    : 'N/A';

  switch (result.action) {
    case 'halt_created':
      return `  STALE ${result.batchId} — heartbeat ${ageStr} ago — HALT file created`;
    case 'already_halted':
      return `  STALE ${result.batchId} — heartbeat ${ageStr} ago — already halted`;
    case 'no_heartbeat':
      return `  SKIP  ${result.batchId} — no heartbeat recorded`;
    case 'healthy':
      return `  OK    ${result.batchId} — heartbeat ${ageStr} ago`;
  }
}

// Batch reflection — cross-run pattern analysis (#551)

export interface ReflectionInsight {
  type: 'success_pattern' | 'failure_pattern' | 'efficiency' | 'recommendation';
  message: string;
}

export interface BatchReflection {
  batchId: string;
  runCount: number;
  totalCost: number;
  totalPrs: number;
  issuesClosedCount: number;
  successRate: number;
  avgCostPerPr: number;
  insights: ReflectionInsight[];
  runHistoryTable: string;
}

/**
 * Build a batch reflection from state data.
 * Analyzes run history to find patterns, efficiency anomalies, and recommendations.
 */
export function buildBatchReflection(batch: BatchInfo): BatchReflection {
  const s = batch.state;
  const history = s.run_history || [];
  const insights: ReflectionInsight[] = [];

  const scores = history.map(scoreRunMetrics);
  const totalCost = scores.reduce((sum, r) => sum + r.cost_usd, 0);
  const totalPrs = scores.reduce((sum, r) => sum + r.pr_count, 0);
  const totalIssuesClosed = scores.reduce((sum, r) => sum + r.issues_closed_count, 0);
  const successfulRuns = scores.filter((r) => r.success);
  const failedRuns = scores.filter((r) => !r.success);
  const successRate = scores.length > 0 ? successfulRuns.length / scores.length : 0;
  const avgCostPerPr = totalPrs > 0 ? totalCost / totalPrs : 0;

  // Insight: overall success rate
  if (scores.length >= 3) {
    if (successRate >= 0.8) {
      insights.push({
        type: 'success_pattern',
        message: `High success rate: ${(successRate * 100).toFixed(0)}% of runs produced PRs`,
      });
    } else if (successRate < 0.5) {
      insights.push({
        type: 'failure_pattern',
        message: `Low success rate: only ${(successRate * 100).toFixed(0)}% of runs produced PRs — consider narrowing guidance`,
      });
    }
  }

  // Insight: expensive failures (runs that cost > avg but produced nothing)
  if (scores.length >= 2) {
    const avgCost = totalCost / scores.length;
    const expensiveFailures = history.filter((r, i) => {
      return !scores[i].success && scores[i].cost_usd > avgCost * 1.5;
    });
    if (expensiveFailures.length > 0) {
      const runNums = expensiveFailures.map((r) => `#${r.run}`).join(', ');
      insights.push({
        type: 'efficiency',
        message: `Expensive failures: runs ${runNums} cost >1.5x average but produced no PRs`,
      });
    }
  }

  // Insight: cost efficiency trend (are later runs more/less efficient?)
  if (scores.length >= 4) {
    const firstHalf = scores.slice(0, Math.floor(scores.length / 2));
    const secondHalf = scores.slice(Math.floor(scores.length / 2));
    const firstAvgCost = firstHalf.reduce((s, r) => s + r.cost_usd, 0) / firstHalf.length;
    const secondAvgCost = secondHalf.reduce((s, r) => s + r.cost_usd, 0) / secondHalf.length;

    if (secondAvgCost > firstAvgCost * 1.3) {
      insights.push({
        type: 'efficiency',
        message: `Cost trending up: later runs average $${secondAvgCost.toFixed(2)} vs early $${firstAvgCost.toFixed(2)} — may be hitting diminishing returns`,
      });
    } else if (secondAvgCost < firstAvgCost * 0.7) {
      insights.push({
        type: 'success_pattern',
        message: `Cost trending down: later runs average $${secondAvgCost.toFixed(2)} vs early $${firstAvgCost.toFixed(2)} — improving efficiency`,
      });
    }
  }

  // Insight: consecutive failures
  let maxConsecFail = 0;
  let currentStreak = 0;
  for (const score of scores) {
    if (!score.success) {
      currentStreak++;
      maxConsecFail = Math.max(maxConsecFail, currentStreak);
    } else {
      currentStreak = 0;
    }
  }
  if (maxConsecFail >= 2) {
    insights.push({
      type: 'failure_pattern',
      message: `Max ${maxConsecFail} consecutive failures detected — may indicate a systemic blocker`,
    });
  }

  // Insight: stop signals
  const stopRuns = history.filter((r) => r.stop_requested);
  if (stopRuns.length > 0 && stopRuns.length < history.length) {
    insights.push({
      type: 'recommendation',
      message: `${stopRuns.length} run(s) emitted stop signals — backlog may be exhausted for this guidance`,
    });
  }

  // Insight: cost per PR benchmark
  if (avgCostPerPr > 0) {
    if (avgCostPerPr < 1.5) {
      insights.push({
        type: 'success_pattern',
        message: `Efficient: $${avgCostPerPr.toFixed(2)}/PR is below the $1.50 target`,
      });
    } else if (avgCostPerPr > 3.0) {
      insights.push({
        type: 'recommendation',
        message: `Expensive: $${avgCostPerPr.toFixed(2)}/PR is above the $3.00 threshold — consider simpler issues`,
      });
    }
  }

  // Build run history table
  const tableLines: string[] = [
    '| Run | Duration | Cost | PRs | Issues | Status |',
    '|-----|----------|------|-----|--------|--------|',
  ];
  for (let i = 0; i < history.length; i++) {
    const r = history[i];
    const dur = `${Math.floor(r.duration_seconds / 60)}m${r.duration_seconds % 60}s`;
    const status = r.exit_code === 0 ? (scores[i].success ? 'ok' : 'no-output') : `exit ${r.exit_code}`;
    tableLines.push(
      `| #${r.run} | ${dur} | $${r.cost_usd.toFixed(2)} | ${r.prs.length} | ${r.issues_closed.length} | ${status} |`,
    );
  }

  return {
    batchId: batch.batchId,
    runCount: history.length,
    totalCost,
    totalPrs,
    issuesClosedCount: totalIssuesClosed,
    successRate,
    avgCostPerPr,
    insights,
    runHistoryTable: tableLines.join('\n'),
  };
}

/**
 * Format a batch reflection for human-readable display.
 */
export function formatBatchReflection(reflection: BatchReflection): string {
  const lines: string[] = [
    `  Batch: ${reflection.batchId}`,
    `  Runs: ${reflection.runCount} | Cost: $${reflection.totalCost.toFixed(2)} | PRs: ${reflection.totalPrs} | Issues closed: ${reflection.issuesClosedCount}`,
    `  Success rate: ${(reflection.successRate * 100).toFixed(0)}% | Avg cost/PR: ${reflection.avgCostPerPr > 0 ? '$' + reflection.avgCostPerPr.toFixed(2) : 'N/A'}`,
    '',
  ];

  if (reflection.insights.length > 0) {
    lines.push('  Insights:');
    for (const insight of reflection.insights) {
      const icon = insight.type === 'success_pattern' ? '+' :
                   insight.type === 'failure_pattern' ? '!' :
                   insight.type === 'efficiency' ? '$' : '*';
      lines.push(`    [${icon}] ${insight.message}`);
    }
  } else {
    lines.push('  No significant patterns detected (too few runs or all runs similar).');
  }

  return lines.join('\n');
}

/**
 * Build template variables for the reflect-batch.md prompt.
 */
export function buildReflectionTemplateVars(
  reflection: BatchReflection,
  state: BatchState,
): Record<string, string> {
  const insightLines = reflection.insights.map((i) => `- **[${i.type}]** ${i.message}`);

  return {
    batch_id: reflection.batchId,
    guidance: state.guidance,
    run_count: String(reflection.runCount),
    total_cost: reflection.totalCost.toFixed(2),
    pr_count: String(reflection.totalPrs),
    issues_closed_count: String(reflection.issuesClosedCount),
    run_history_table: reflection.runHistoryTable,
    reflection_insights: insightLines.join('\n'),
    pr_merge_status: state.prs.length > 0 ? state.prs.join('\n') : '',
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === '--help') {
    console.log(`auto-dent-ctl — Control running auto-dent batches

Usage:
  auto-dent-ctl.ts status              List batches with last-worked-on info
  auto-dent-ctl.ts halt [batch-id]     Halt specific batch (or all active)
  auto-dent-ctl.ts halt-state <file>   Print last-state from a state.json file
  auto-dent-ctl.ts score [batch-id]    Score batch(es) — efficiency, success rate, cost
  auto-dent-ctl.ts score --post-hoc [batch-id]  Include live PR merge status checks
  auto-dent-ctl.ts cleanup [batch-id]  Close superseded PRs whose issues are already resolved
  auto-dent-ctl.ts reflect [batch-id]  Cross-run pattern analysis and learning (#551)
  auto-dent-ctl.ts reflect --prompt [batch-id]  Output rendered prompt for Claude reflection
  auto-dent-ctl.ts watchdog [--threshold N]  Check heartbeats, halt stale batches (default: 600s)`);
    process.exit(0);
  }

  const logsDir = getLogsDir();

  switch (subcommand) {
    case 'status': {
      const batches = discoverBatches(logsDir);
      if (batches.length === 0) {
        console.log('No auto-dent batches found.');
        process.exit(0);
      }

      const active = batches.filter((b) => b.active);
      const stopped = batches.filter((b) => !b.active);

      if (active.length > 0) {
        console.log(`\n=== Active Batches (${active.length}) ===\n`);
        for (const b of active) {
          console.log(formatBatchStatus(b));
          console.log('');
        }
      }

      if (stopped.length > 0) {
        console.log(`=== Stopped Batches (${stopped.length}) ===\n`);
        for (const b of stopped) {
          console.log(formatBatchStatus(b));
          console.log('');
        }
      }
      break;
    }

    case 'halt': {
      const targetId = args[1];
      const batches = discoverBatches(logsDir);
      const active = batches.filter((b) => b.active && !b.halted);

      if (targetId) {
        const match = active.find((b) => b.batchId === targetId);
        if (!match) {
          console.error(`No active batch found with ID: ${targetId}`);
          const available = active.map((b) => b.batchId);
          if (available.length > 0) {
            console.error(`Active batches: ${available.join(', ')}`);
          }
          process.exit(1);
        }
        haltBatch(match.dir);
        console.log(`Halt requested for: ${match.batchId}`);
        console.log(formatLastState(match.state));
      } else {
        if (active.length === 0) {
          console.log('No active batches to halt.');
          process.exit(0);
        }
        for (const b of active) {
          haltBatch(b.dir);
          console.log(`Halt requested for: ${b.batchId}`);
          console.log(formatLastState(b.state));
          console.log('');
        }
      }
      break;
    }

    case 'score': {
      const postHoc = args.includes('--post-hoc');
      const scoreArgs = args.slice(1).filter((a) => a !== '--post-hoc');
      const targetId = scoreArgs[0];
      const batches = discoverBatches(logsDir);

      if (batches.length === 0) {
        console.log('No auto-dent batches found.');
        process.exit(0);
      }

      const targets = targetId
        ? batches.filter((b) => b.batchId === targetId)
        : batches;

      if (targets.length === 0) {
        console.error(`No batch found with ID: ${targetId}`);
        const available = batches.map((b) => b.batchId);
        console.error(`Available batches: ${available.join(', ')}`);
        process.exit(1);
      }

      for (const batch of targets) {
        console.log(formatBatchScoreOutput(batch, postHoc));
        console.log('');
      }
      break;
    }

    case 'cleanup': {
      const targetId = args[1];
      const batches = discoverBatches(logsDir);

      if (batches.length === 0) {
        console.log('No auto-dent batches found.');
        process.exit(0);
      }

      const targets = targetId
        ? batches.filter((b) => b.batchId === targetId)
        : batches.filter((b) => b.active);

      if (targets.length === 0) {
        if (targetId) {
          console.error(`No batch found with ID: ${targetId}`);
        } else {
          console.log('No active batches to clean up.');
        }
        process.exit(0);
      }

      for (const batch of targets) {
        const s = batch.state;
        const repo = s.kaizen_repo || s.host_repo;
        if (!repo) {
          console.log(`  Batch ${batch.batchId}: no repo configured, skipping.`);
          continue;
        }

        if (s.prs.length === 0) {
          console.log(`  Batch ${batch.batchId}: no PRs to clean up.`);
          continue;
        }

        console.log(`  Batch ${batch.batchId}: checking ${s.prs.length} PRs...`);
        const results = cleanupSupersededPRs(s.prs, repo);

        let closedCount = 0;
        for (const r of results) {
          if (r.action === 'closed') closedCount++;
          if (r.action !== 'still_open' && r.action !== 'already_merged') {
            console.log(`    ${r.pr} — ${r.action}${r.issue ? ` (${r.issue})` : ''}`);
          }
        }

        if (closedCount === 0) {
          console.log(`    No superseded PRs found.`);
        } else {
          console.log(`    Closed ${closedCount} superseded PR(s).`);
        }
      }
      break;
    }

    case 'watchdog': {
      const thresholdIdx = args.indexOf('--threshold');
      const threshold = thresholdIdx >= 0 && args[thresholdIdx + 1]
        ? parseInt(args[thresholdIdx + 1], 10)
        : DEFAULT_WATCHDOG_THRESHOLD_SEC;

      const results = runWatchdog(logsDir, threshold);
      if (results.length === 0) {
        console.log('No active batches to monitor.');
        process.exit(0);
      }

      for (const r of results) {
        console.log(formatWatchdogResult(r));
      }

      const staleCount = results.filter((r) => r.action === 'halt_created').length;
      if (staleCount > 0) {
        console.log(`\nWatchdog halted ${staleCount} stale batch(es).`);
        process.exit(1);
      }
      break;
    }

    case 'reflect': {
      const showPrompt = args.includes('--prompt');
      const reflectArgs = args.slice(1).filter((a) => a !== '--prompt');
      const targetId = reflectArgs[0];
      const batches = discoverBatches(logsDir);

      if (batches.length === 0) {
        console.log('No auto-dent batches found.');
        process.exit(0);
      }

      // Default to most recent batch if no ID given
      const targets = targetId
        ? batches.filter((b) => b.batchId === targetId)
        : [batches[batches.length - 1]];

      if (targets.length === 0) {
        console.error(`No batch found with ID: ${targetId}`);
        const available = batches.map((b) => b.batchId);
        console.error(`Available batches: ${available.join(', ')}`);
        process.exit(1);
      }

      for (const batch of targets) {
        const history = batch.state.run_history || [];
        if (history.length === 0) {
          console.log(`  Batch ${batch.batchId}: no run history to reflect on.`);
          continue;
        }

        const reflection = buildBatchReflection(batch);

        if (showPrompt) {
          const vars = buildReflectionTemplateVars(reflection, batch.state);
          const template = loadPromptTemplate('reflect-batch.md');
          if (template) {
            console.log(renderTemplate(template, vars));
          } else {
            console.error('Error: prompts/reflect-batch.md not found');
            process.exit(1);
          }
        } else {
          console.log(formatBatchReflection(reflection));
        }
        console.log('');
      }
      break;
    }

    case 'halt-state': {
      const stateFile = args[1];
      if (!stateFile || !existsSync(stateFile)) {
        console.error('Usage: auto-dent-ctl.ts halt-state <state-file>');
        process.exit(1);
      }
      const state: BatchState = JSON.parse(readFileSync(stateFile, 'utf8'));
      console.log(formatLastState(state));
      break;
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}

const isDirectRun =
  process.argv[1]?.endsWith('auto-dent-ctl.ts') ||
  process.argv[1]?.endsWith('auto-dent-ctl.js');

if (isDirectRun) {
  main();
}
