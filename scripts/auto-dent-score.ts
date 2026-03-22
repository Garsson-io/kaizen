/**
 * auto-dent-score — Extract structured metrics from run results.
 *
 * Scoring foundation for the auto-dent experimentation framework (#506).
 * Takes RunMetrics/RunResult and produces a RunScore with derived metrics.
 *
 * See issue #507.
 */

import type { RunMetrics, RunResult } from './auto-dent-run.js';

export interface RunScore {
  /** Whether the run succeeded: exit code 0 AND at least one PR created */
  success: boolean;
  /** Total cost in USD */
  cost_usd: number;
  /** Number of tool calls made */
  tool_calls: number;
  /** Number of PRs created */
  pr_count: number;
  /** Number of issues closed */
  issues_closed_count: number;
  /** Number of issues filed */
  issues_filed_count: number;
  /** Run duration in seconds */
  duration_seconds: number;
  /** PRs per dollar spent (0 if no cost) */
  efficiency: number;
  /** Cost per PR (Infinity if no PRs, 0 if no cost) */
  cost_per_pr: number;
  /** Whether the agent requested a stop */
  stop_requested: boolean;
}

export interface BatchScore {
  /** Number of runs in the batch */
  total_runs: number;
  /** Number of successful runs (exit 0 + PR) */
  successful_runs: number;
  /** Success rate as a fraction 0..1 */
  success_rate: number;
  /** Total cost across all runs */
  total_cost_usd: number;
  /** Total PRs created */
  total_prs: number;
  /** Total issues closed */
  total_issues_closed: number;
  /** Total duration in seconds */
  total_duration_seconds: number;
  /** Average cost per successful run (NaN if no successes) */
  avg_cost_per_success: number;
  /** Average duration per run */
  avg_duration_seconds: number;
  /** Overall efficiency: total PRs / total cost */
  overall_efficiency: number;
  /** Per-run scores */
  runs: RunScore[];
}

/** Score a single run from RunMetrics (stored in state.run_history). */
export function scoreRunMetrics(metrics: RunMetrics): RunScore {
  const prCount = metrics.prs.length;
  const cost = metrics.cost_usd;
  return {
    success: metrics.exit_code === 0 && prCount > 0,
    cost_usd: cost,
    tool_calls: metrics.tool_calls,
    pr_count: prCount,
    issues_closed_count: metrics.issues_closed.length,
    issues_filed_count: metrics.issues_filed.length,
    duration_seconds: metrics.duration_seconds,
    efficiency: cost > 0 ? prCount / cost : 0,
    cost_per_pr: prCount > 0 ? cost / prCount : Infinity,
    stop_requested: metrics.stop_requested,
  };
}

/** Score a single run from RunResult (available immediately after run). */
export function scoreRunResult(
  result: RunResult,
  exitCode: number,
  durationSeconds: number,
): RunScore {
  const prCount = result.prs.length;
  const cost = result.cost;
  return {
    success: exitCode === 0 && prCount > 0,
    cost_usd: cost,
    tool_calls: result.toolCalls,
    pr_count: prCount,
    issues_closed_count: result.issuesClosed.length,
    issues_filed_count: result.issuesFiled.length,
    duration_seconds: durationSeconds,
    efficiency: cost > 0 ? prCount / cost : 0,
    cost_per_pr: prCount > 0 ? cost / prCount : Infinity,
    stop_requested: result.stopRequested,
  };
}

/** Score an entire batch from run_history. */
export function scoreBatch(runHistory: RunMetrics[]): BatchScore {
  const runs = runHistory.map(scoreRunMetrics);
  const successfulRuns = runs.filter((r) => r.success);

  const totalCost = runs.reduce((s, r) => s + r.cost_usd, 0);
  const totalPrs = runs.reduce((s, r) => s + r.pr_count, 0);
  const totalIssuesClosed = runs.reduce(
    (s, r) => s + r.issues_closed_count,
    0,
  );
  const totalDuration = runs.reduce((s, r) => s + r.duration_seconds, 0);

  return {
    total_runs: runs.length,
    successful_runs: successfulRuns.length,
    success_rate: runs.length > 0 ? successfulRuns.length / runs.length : 0,
    total_cost_usd: totalCost,
    total_prs: totalPrs,
    total_issues_closed: totalIssuesClosed,
    total_duration_seconds: totalDuration,
    avg_cost_per_success:
      successfulRuns.length > 0
        ? totalCost / successfulRuns.length
        : NaN,
    avg_duration_seconds:
      runs.length > 0 ? totalDuration / runs.length : 0,
    overall_efficiency: totalCost > 0 ? totalPrs / totalCost : 0,
    runs,
  };
}

/** Format a RunScore as a compact one-line summary. */
export function formatRunScoreLine(score: RunScore): string {
  const status = score.success ? 'pass' : 'fail';
  const parts = [
    status,
    `$${score.cost_usd.toFixed(2)}`,
    `${score.tool_calls} tools`,
    `${score.pr_count} PRs`,
    `${score.duration_seconds}s`,
  ];
  if (score.efficiency > 0) {
    parts.push(`${score.efficiency.toFixed(2)} PR/$`);
  }
  return parts.join(' | ');
}

/** Format a BatchScore as a multi-line summary table. */
export function formatBatchScoreTable(score: BatchScore): string {
  const lines = [
    `| Metric | Value |`,
    `|--------|-------|`,
    `| **Runs** | ${score.total_runs} (${score.successful_runs} successful) |`,
    `| **Success rate** | ${(score.success_rate * 100).toFixed(0)}% |`,
    `| **Total cost** | $${score.total_cost_usd.toFixed(2)} |`,
    `| **Total PRs** | ${score.total_prs} |`,
    `| **Issues closed** | ${score.total_issues_closed} |`,
    `| **Avg cost/success** | ${isNaN(score.avg_cost_per_success) ? 'N/A' : '$' + score.avg_cost_per_success.toFixed(2)} |`,
    `| **Efficiency** | ${score.overall_efficiency > 0 ? score.overall_efficiency.toFixed(2) + ' PR/$' : 'N/A'} |`,
  ];
  return lines.join('\n');
}
