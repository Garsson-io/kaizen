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
 *   reflect [batch-id]  Cross-run pattern analysis (#551)
 *   reflect --post [batch-id]  Post reflection summary to progress issue (#571)
 *   watchdog [--threshold N]  Check active batches for stale heartbeats, halt if stuck
 *
 * Usage:
 *   npx tsx scripts/auto-dent-ctl.ts status
 *   npx tsx scripts/auto-dent-ctl.ts halt
 *   npx tsx scripts/auto-dent-ctl.ts halt batch-260321-0136-a1b2
 *   npx tsx scripts/auto-dent-ctl.ts watchdog --threshold 600
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, appendFileSync } from 'fs';
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
 * Format a batch reflection as a GitHub issue comment (markdown).
 * Designed to be posted to the batch progress issue every 5 runs.
 */
export function formatBatchReflectionComment(reflection: BatchReflection): string {
  const lines: string[] = [
    `### Mid-Batch Reflection (after run ${reflection.runCount})`,
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| **Success rate** | ${(reflection.successRate * 100).toFixed(0)}% (${Math.round(reflection.successRate * reflection.runCount)}/${reflection.runCount} runs) |`,
    `| **Total cost** | $${reflection.totalCost.toFixed(2)} |`,
    `| **Avg cost/run** | $${reflection.runCount > 0 ? (reflection.totalCost / reflection.runCount).toFixed(2) : '0.00'} |`,
    `| **PRs created** | ${reflection.totalPrs} |`,
    `| **Issues closed** | ${reflection.issuesClosedCount} |`,
    `| **Avg cost/PR** | ${reflection.avgCostPerPr > 0 ? '$' + reflection.avgCostPerPr.toFixed(2) : 'N/A'} |`,
    '',
  ];

  if (reflection.insights.length > 0) {
    lines.push('**Insights:**');
    for (const insight of reflection.insights) {
      const icon = insight.type === 'success_pattern' ? ':white_check_mark:' :
                   insight.type === 'failure_pattern' ? ':warning:' :
                   insight.type === 'efficiency' ? ':chart_with_upwards_trend:' : ':bulb:';
      lines.push(`- ${icon} ${insight.message}`);
    }
  } else {
    lines.push('_No significant patterns detected yet._');
  }

  return lines.join('\n');
}

/**
 * Post a mid-batch reflection summary to the batch progress issue.
 * Non-fatal: returns false if posting fails.
 */
export function postBatchReflectionToProgressIssue(
  batch: BatchInfo,
): boolean {
  const state = batch.state;
  const progressIssue = state.progress_issue;
  const repo = state.kaizen_repo || state.host_repo;

  if (!progressIssue || !repo) {
    console.log('  [reflect] no progress issue or repo configured — skipping post');
    return false;
  }

  const m = progressIssue.match(/issues\/(\d+)/);
  if (!m) {
    console.log('  [reflect] could not parse issue number from progress_issue');
    return false;
  }
  const issueNum = m[1];

  const history = state.run_history || [];
  if (history.length === 0) {
    console.log('  [reflect] no run history to reflect on');
    return false;
  }

  const reflection = buildBatchReflection(batch);
  const comment = formatBatchReflectionComment(reflection);

  try {
    execSync(
      `gh issue comment ${issueNum} --repo ${repo} --body ${JSON.stringify(comment)}`,
      { encoding: 'utf8', timeout: 30_000 },
    );
    console.log(`  [reflect] posted mid-batch reflection to progress issue #${issueNum}`);
    return true;
  } catch (e: any) {
    console.log(`  [reflect] warning: failed to post reflection — ${e.message?.split('\n')[0] || 'failed'}`);
    return false;
  }
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
 * Persisted reflection summary — written to {logDir}/reflection-summary.json
 * and read by buildTemplateVars() to inject insights into subsequent run prompts.
 */
export interface PersistedReflection {
  timestamp: string;
  runCount: number;
  successRate: number;
  avgCostPerPr: number;
  insights: ReflectionInsight[];
  /** Issue numbers extracted from failure patterns that subsequent runs should avoid */
  avoidIssues: string[];
}

/**
 * Persist the batch reflection to the batch log directory so that
 * subsequent runs can read it and incorporate insights into their prompts.
 * Returns the path written, or null if persistence failed.
 */
export function persistReflectionSummary(
  batch: BatchInfo,
  reflection: BatchReflection,
): string | null {
  const summaryPath = join(batch.dir, 'reflection-summary.json');

  // Extract issue numbers from failure/recommendation insights
  const avoidIssues: string[] = [];
  for (const insight of reflection.insights) {
    if (insight.type === 'failure_pattern' || insight.type === 'recommendation') {
      const issueMatches = insight.message.match(/#(\d+)/g);
      if (issueMatches) {
        avoidIssues.push(...issueMatches.map((m) => m.replace('#', '')));
      }
    }
  }

  const summary: PersistedReflection = {
    timestamp: new Date().toISOString(),
    runCount: reflection.runCount,
    successRate: reflection.successRate,
    avgCostPerPr: reflection.avgCostPerPr,
    insights: reflection.insights,
    avoidIssues: [...new Set(avoidIssues)],
  };

  try {
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');

    // Append to reflection history so consecutive reflections can see prior conclusions
    const historyPath = join(batch.dir, 'reflection-history.json');
    let history: PersistedReflection[] = [];
    try {
      if (existsSync(historyPath)) {
        history = JSON.parse(readFileSync(historyPath, 'utf8'));
      }
    } catch { /* start fresh if corrupted */ }
    history.push(summary);
    writeFileSync(historyPath, JSON.stringify(history, null, 2) + '\n');

    console.log(`  [reflect] persisted reflection summary to ${summaryPath} (history: ${history.length} entries)`);
    return summaryPath;
  } catch (e: any) {
    console.log(`  [reflect] warning: failed to persist reflection — ${e.message?.split('\n')[0] || 'failed'}`);
    return null;
  }
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
    pr_merge_status: state.prs.length > 0
      ? state.prs.map(url => {
          const status = checkMergeStatus(url);
          const label = status === 'merged' ? '**merged**'
            : status === 'auto_queued' ? '**open** (auto-merge queued)'
            : status === 'closed' ? '**closed**'
            : status === 'open' ? '**open**'
            : 'unknown';
          return `- ${url} — ${label}`;
        }).join('\n')
      : '',
  };
}

// Cross-batch aggregate — persistent outcome data (#586)

export interface AggregateBatchRecord {
  /** Batch identifier */
  batch_id: string;
  /** Batch guidance string */
  guidance: string;
  /** Epoch timestamp when batch started */
  batch_start: number;
  /** Epoch timestamp when batch ended */
  batch_end: number;
  /** Total runs completed */
  total_runs: number;
  /** Number of successful runs (exit 0 + PR) */
  successful_runs: number;
  /** Success rate as fraction 0..1 */
  success_rate: number;
  /** Total cost in USD */
  total_cost_usd: number;
  /** Total PRs created */
  total_prs: number;
  /** Total issues closed */
  total_issues_closed: number;
  /** Total issues filed */
  total_issues_filed: number;
  /** Total duration in seconds */
  total_duration_seconds: number;
  /** Stop reason */
  stop_reason: string;
  /** Per-mode breakdown: mode → {runs, successes, prs, cost} */
  mode_breakdown: Record<string, { runs: number; successes: number; prs: number; cost: number }>;
  /** Issue numbers attempted (from issues_closed + issues_filed) */
  issues_attempted: string[];
  /** PR URLs */
  prs: string[];
  /** Timestamp when this record was written */
  recorded_at: string;
}

/**
 * Build an AggregateBatchRecord from a BatchInfo.
 */
export function buildAggregateBatchRecord(batch: BatchInfo): AggregateBatchRecord {
  const s = batch.state;
  const history = s.run_history || [];
  const scores = history.map(scoreRunMetrics);

  const totalCost = scores.reduce((sum, r) => sum + r.cost_usd, 0);
  const totalPrs = scores.reduce((sum, r) => sum + r.pr_count, 0);
  const totalIssuesClosed = scores.reduce((sum, r) => sum + r.issues_closed_count, 0);
  const totalIssuesFiled = scores.reduce((sum, r) => sum + r.issues_filed_count, 0);
  const totalDuration = scores.reduce((sum, r) => sum + r.duration_seconds, 0);
  const successfulRuns = scores.filter((r) => r.success).length;
  const successRate = scores.length > 0 ? successfulRuns / scores.length : 0;

  // Mode breakdown
  const modeBreakdown: Record<string, { runs: number; successes: number; prs: number; cost: number }> = {};
  for (const score of scores) {
    if (!modeBreakdown[score.mode]) {
      modeBreakdown[score.mode] = { runs: 0, successes: 0, prs: 0, cost: 0 };
    }
    modeBreakdown[score.mode].runs++;
    if (score.success) modeBreakdown[score.mode].successes++;
    modeBreakdown[score.mode].prs += score.pr_count;
    modeBreakdown[score.mode].cost += score.cost_usd;
  }

  // Issues attempted (union of closed + filed)
  const issuesAttempted = Array.from(new Set([...s.issues_closed, ...s.issues_filed]));

  return {
    batch_id: batch.batchId,
    guidance: s.guidance,
    batch_start: s.batch_start,
    batch_end: s.batch_end || Math.floor(Date.now() / 1000),
    total_runs: history.length,
    successful_runs: successfulRuns,
    success_rate: successRate,
    total_cost_usd: totalCost,
    total_prs: totalPrs,
    total_issues_closed: totalIssuesClosed,
    total_issues_filed: totalIssuesFiled,
    total_duration_seconds: totalDuration,
    stop_reason: s.stop_reason || 'completed',
    mode_breakdown: modeBreakdown,
    issues_attempted: issuesAttempted,
    prs: s.prs,
    recorded_at: new Date().toISOString(),
  };
}

/**
 * Append a batch record to the aggregate JSONL file.
 * Idempotent: skips if batch_id already exists in the file.
 */
export function appendBatchToAggregate(
  logsDir: string,
  batch: BatchInfo,
): { action: 'appended' | 'already_exists' | 'error'; path: string } {
  const aggregatePath = join(logsDir, 'aggregate.jsonl');

  // Check for duplicate
  if (existsSync(aggregatePath)) {
    const existing = readFileSync(aggregatePath, 'utf8');
    const lines = existing.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.batch_id === batch.batchId) {
          return { action: 'already_exists', path: aggregatePath };
        }
      } catch { /* skip malformed lines */ }
    }
  }

  const record = buildAggregateBatchRecord(batch);
  appendFileSync(aggregatePath, JSON.stringify(record) + '\n');
  return { action: 'appended', path: aggregatePath };
}

/**
 * Read all aggregate records from the JSONL file.
 */
export function readAggregate(logsDir: string): AggregateBatchRecord[] {
  const aggregatePath = join(logsDir, 'aggregate.jsonl');
  if (!existsSync(aggregatePath)) return [];

  const content = readFileSync(aggregatePath, 'utf8');
  const records: AggregateBatchRecord[] = [];
  for (const line of content.split('\n').filter(Boolean)) {
    try {
      records.push(JSON.parse(line));
    } catch { /* skip malformed lines */ }
  }
  return records;
}

export interface AggregateStats {
  totalBatches: number;
  totalRuns: number;
  totalCost: number;
  totalPrs: number;
  totalIssuesClosed: number;
  overallSuccessRate: number;
  avgCostPerPr: number;
  avgCostPerRun: number;
  modeEffectiveness: Record<string, { runs: number; successes: number; prs: number; cost: number; successRate: number; efficiency: number }>;
  recentBatches: Array<{ batch_id: string; guidance: string; runs: number; prs: number; cost: number; success_rate: number }>;
}

/**
 * Compute aggregate statistics across all batches.
 */
export function computeAggregateStats(records: AggregateBatchRecord[]): AggregateStats {
  const totalBatches = records.length;
  const totalRuns = records.reduce((s, r) => s + r.total_runs, 0);
  const totalCost = records.reduce((s, r) => s + r.total_cost_usd, 0);
  const totalPrs = records.reduce((s, r) => s + r.total_prs, 0);
  const totalIssuesClosed = records.reduce((s, r) => s + r.total_issues_closed, 0);
  const totalSuccessful = records.reduce((s, r) => s + r.successful_runs, 0);
  const overallSuccessRate = totalRuns > 0 ? totalSuccessful / totalRuns : 0;
  const avgCostPerPr = totalPrs > 0 ? totalCost / totalPrs : 0;
  const avgCostPerRun = totalRuns > 0 ? totalCost / totalRuns : 0;

  // Aggregate mode effectiveness
  const modes: Record<string, { runs: number; successes: number; prs: number; cost: number }> = {};
  for (const record of records) {
    for (const [mode, stats] of Object.entries(record.mode_breakdown)) {
      if (!modes[mode]) modes[mode] = { runs: 0, successes: 0, prs: 0, cost: 0 };
      modes[mode].runs += stats.runs;
      modes[mode].successes += stats.successes;
      modes[mode].prs += stats.prs;
      modes[mode].cost += stats.cost;
    }
  }

  const modeEffectiveness: AggregateStats['modeEffectiveness'] = {};
  for (const [mode, stats] of Object.entries(modes)) {
    modeEffectiveness[mode] = {
      ...stats,
      successRate: stats.runs > 0 ? stats.successes / stats.runs : 0,
      efficiency: stats.cost > 0 ? stats.prs / stats.cost : 0,
    };
  }

  // Recent batches (last 10, sorted by batch_start desc)
  const sorted = [...records].sort((a, b) => b.batch_start - a.batch_start);
  const recentBatches = sorted.slice(0, 10).map((r) => ({
    batch_id: r.batch_id,
    guidance: r.guidance,
    runs: r.total_runs,
    prs: r.total_prs,
    cost: r.total_cost_usd,
    success_rate: r.success_rate,
  }));

  return {
    totalBatches,
    totalRuns,
    totalCost,
    totalPrs,
    totalIssuesClosed,
    overallSuccessRate,
    avgCostPerPr,
    avgCostPerRun,
    modeEffectiveness,
    recentBatches,
  };
}

/**
 * Format aggregate stats for human-readable display.
 */
export function formatAggregateStats(stats: AggregateStats): string {
  const lines: string[] = [
    'Cross-Batch History',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| **Total batches** | ${stats.totalBatches} |`,
    `| **Total runs** | ${stats.totalRuns} |`,
    `| **Total cost** | $${stats.totalCost.toFixed(2)} |`,
    `| **Total PRs** | ${stats.totalPrs} |`,
    `| **Issues closed** | ${stats.totalIssuesClosed} |`,
    `| **Overall success rate** | ${(stats.overallSuccessRate * 100).toFixed(0)}% |`,
    `| **Avg cost/PR** | ${stats.avgCostPerPr > 0 ? '$' + stats.avgCostPerPr.toFixed(2) : 'N/A'} |`,
    `| **Avg cost/run** | $${stats.avgCostPerRun.toFixed(2)} |`,
  ];

  // Mode effectiveness
  const modeEntries = Object.entries(stats.modeEffectiveness);
  if (modeEntries.length > 0) {
    lines.push('');
    lines.push('Mode effectiveness (all-time):');
    lines.push('');
    lines.push('| Mode | Runs | Success | PRs | Cost | Efficiency |');
    lines.push('|------|------|---------|-----|------|------------|');
    for (const [mode, m] of modeEntries.sort((a, b) => b[1].runs - a[1].runs)) {
      const eff = m.efficiency > 0 ? `${m.efficiency.toFixed(2)} PR/$` : '-';
      lines.push(`| ${mode} | ${m.runs} | ${(m.successRate * 100).toFixed(0)}% | ${m.prs} | $${m.cost.toFixed(2)} | ${eff} |`);
    }
  }

  // Recent batches
  if (stats.recentBatches.length > 0) {
    lines.push('');
    lines.push('Recent batches:');
    lines.push('');
    lines.push('| Batch | Guidance | Runs | PRs | Cost | Success |');
    lines.push('|-------|----------|------|-----|------|---------|');
    for (const b of stats.recentBatches) {
      const guidance = b.guidance.length > 40 ? b.guidance.slice(0, 37) + '...' : b.guidance;
      lines.push(`| ${b.batch_id} | ${guidance} | ${b.runs} | ${b.prs} | $${b.cost.toFixed(2)} | ${(b.success_rate * 100).toFixed(0)}% |`);
    }
  }

  return lines.join('\n');
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
  auto-dent-ctl.ts reflect --post [batch-id]  Post reflection summary to progress issue (#571)
  auto-dent-ctl.ts reflect --prompt [batch-id]  Output rendered prompt for Claude reflection
  auto-dent-ctl.ts history             Cross-batch aggregate stats (#586)
  auto-dent-ctl.ts aggregate [batch-id]  Append batch(es) to aggregate.jsonl (called at batch end)
  auto-dent-ctl.ts watchdog [--threshold N]  Check heartbeats, halt stale batches (default: 600s)

Cross-batch learning (#586):
  The aggregate subcommand appends a batch summary to logs/auto-dent/aggregate.jsonl.
  The history subcommand reads aggregate.jsonl and shows cross-batch metrics.
  Backfill: auto-dent-ctl.ts aggregate   (no batch-id = backfill all completed)`);
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
      const postToIssue = args.includes('--post');
      const reflectArgs = args.slice(1).filter((a) => a !== '--prompt' && a !== '--post');
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

        // Always persist reflection to disk for intra-batch feedback (#603)
        persistReflectionSummary(batch, reflection);

        if (postToIssue) {
          postBatchReflectionToProgressIssue(batch);
        }

        console.log('');
      }
      break;
    }

    case 'history': {
      const records = readAggregate(logsDir);
      if (records.length === 0) {
        console.log('No aggregate data found. Batches append to aggregate.jsonl on completion.');
        console.log('Run: auto-dent-ctl.ts aggregate [batch-id] to backfill existing batches.');
        process.exit(0);
      }
      const stats = computeAggregateStats(records);
      console.log(formatAggregateStats(stats));
      break;
    }

    case 'aggregate': {
      const targetId = args[1];
      const batches = discoverBatches(logsDir);

      if (batches.length === 0) {
        console.log('No auto-dent batches found.');
        process.exit(0);
      }

      // If no target, backfill all completed batches
      const targets = targetId
        ? batches.filter((b) => b.batchId === targetId)
        : batches.filter((b) => !b.active);

      if (targets.length === 0) {
        if (targetId) {
          console.error(`No batch found with ID: ${targetId}`);
        } else {
          console.log('No completed batches to aggregate.');
        }
        process.exit(0);
      }

      let appended = 0;
      let skipped = 0;
      for (const batch of targets) {
        const result = appendBatchToAggregate(logsDir, batch);
        if (result.action === 'appended') {
          console.log(`  Appended: ${batch.batchId}`);
          appended++;
        } else if (result.action === 'already_exists') {
          skipped++;
        }
      }
      console.log(`Aggregate updated: ${appended} appended, ${skipped} already present.`);
      console.log(`File: ${join(logsDir, 'aggregate.jsonl')}`);
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
