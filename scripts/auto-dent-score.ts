/**
 * auto-dent-score — Extract structured metrics from run results.
 *
 * Scoring foundation for the auto-dent experimentation framework (#506).
 * Takes RunMetrics/RunResult and produces a RunScore with derived metrics.
 *
 * See issue #507.
 */

import type { RunMetrics, RunResult, MergeStatus } from './auto-dent-run.js';

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
  /** Cognitive mode used for this run */
  mode: string;
  /** Net lines removed (positive = deletion) */
  lines_deleted: number;
  /** Issues closed as not-planned (pruned, not fixed) */
  issues_pruned: number;
  /** Cost relative to rolling average (e.g. 2.0 = 2x the avg). null if first run. */
  cost_vs_avg: number | null;
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
  /** Total net lines deleted across all runs */
  total_lines_deleted: number;
  /** Total issues pruned across all runs */
  total_issues_pruned: number;
  /** Average cost per successful run (NaN if no successes) */
  avg_cost_per_success: number;
  /** Average duration per run */
  avg_duration_seconds: number;
  /** Overall efficiency: total PRs / total cost */
  overall_efficiency: number;
  /** Per-run scores */
  runs: RunScore[];
  /** Per-mode effectiveness breakdown */
  mode_breakdown: ModeStats[];
  /** Number of runs flagged as cost anomalies (>= 2x rolling avg) */
  cost_anomaly_count: number;
  /** Mode diversity score: 0 = all runs in one mode, 1 = perfectly even distribution */
  mode_diversity: number;
  /** Post-hoc merge results (populated by postHocScoreBatch) */
  post_hoc?: PostHocBatchResult;
}

export interface ModeStats {
  /** Cognitive mode name */
  mode: string;
  /** Number of runs in this mode */
  runs: number;
  /** Number of successful runs (exit 0 + PR) */
  successes: number;
  /** Success rate as fraction 0..1 */
  success_rate: number;
  /** Total cost for runs in this mode */
  cost_usd: number;
  /** Total PRs created by runs in this mode */
  prs: number;
  /** Average cost per run in this mode */
  avg_cost: number;
  /** Efficiency: PRs per dollar */
  efficiency: number;
  /** Total net lines deleted */
  lines_deleted: number;
  /** Total issues pruned */
  issues_pruned: number;
}

export interface PostHocPRResult {
  /** PR URL */
  url: string;
  /** Current merge status */
  status: MergeStatus;
}

export interface PostHocBatchResult {
  /** Per-PR merge outcomes */
  prs: PostHocPRResult[];
  /** Number of PRs that successfully merged */
  merged_count: number;
  /** Number of PRs still open or queued */
  pending_count: number;
  /** Number of PRs closed without merging */
  closed_count: number;
  /** Merge rate: merged / total (NaN if no PRs) */
  merge_rate: number;
  /** Effective efficiency: merged PRs / total cost (0 if no cost) */
  effective_efficiency: number;
  /** Timestamp of scoring */
  scored_at: string;
}

/** Score a single run from RunMetrics (stored in state.run_history). */
export function scoreRunMetrics(
  metrics: RunMetrics,
  priorHistory?: RunMetrics[],
): RunScore {
  const prCount = metrics.prs.length;
  const cost = metrics.cost_usd;

  let costVsAvg: number | null = null;
  if (priorHistory && priorHistory.length > 0) {
    const avgCost =
      priorHistory.reduce((s, r) => s + r.cost_usd, 0) / priorHistory.length;
    costVsAvg = avgCost > 0 ? cost / avgCost : null;
  }

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
    mode: metrics.mode ?? 'exploit',
    lines_deleted: metrics.lines_deleted ?? 0,
    issues_pruned: metrics.issues_pruned ?? 0,
    cost_vs_avg: costVsAvg,
  };
}

/** Score a single run from RunResult (available immediately after run). */
export function scoreRunResult(
  result: RunResult,
  exitCode: number,
  durationSeconds: number,
  mode: string = 'exploit',
  priorHistory?: RunMetrics[],
): RunScore {
  const prCount = result.prs.length;
  const cost = result.cost;

  let costVsAvg: number | null = null;
  if (priorHistory && priorHistory.length > 0) {
    const avgCost =
      priorHistory.reduce((s, r) => s + r.cost_usd, 0) / priorHistory.length;
    costVsAvg = avgCost > 0 ? cost / avgCost : null;
  }

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
    mode,
    lines_deleted: result.linesDeleted,
    issues_pruned: result.issuesPruned,
    cost_vs_avg: costVsAvg,
  };
}

/** Score an entire batch from run_history. */
export function scoreBatch(runHistory: RunMetrics[]): BatchScore {
  const runs = runHistory.map((m, i) =>
    scoreRunMetrics(m, i > 0 ? runHistory.slice(0, i) : undefined),
  );
  const successfulRuns = runs.filter((r) => r.success);

  const totalCost = runs.reduce((s, r) => s + r.cost_usd, 0);
  const totalPrs = runs.reduce((s, r) => s + r.pr_count, 0);
  const totalIssuesClosed = runs.reduce(
    (s, r) => s + r.issues_closed_count,
    0,
  );
  const totalDuration = runs.reduce((s, r) => s + r.duration_seconds, 0);
  const totalLinesDeleted = runs.reduce(
    (s, r) => s + r.lines_deleted,
    0,
  );
  const totalIssuesPruned = runs.reduce(
    (s, r) => s + r.issues_pruned,
    0,
  );

  const costAnomalyCount = runs.filter(
    (r) => r.cost_vs_avg !== null && r.cost_vs_avg >= 2,
  ).length;

  return {
    total_runs: runs.length,
    successful_runs: successfulRuns.length,
    success_rate: runs.length > 0 ? successfulRuns.length / runs.length : 0,
    total_cost_usd: totalCost,
    total_prs: totalPrs,
    total_issues_closed: totalIssuesClosed,
    total_duration_seconds: totalDuration,
    total_lines_deleted: totalLinesDeleted,
    total_issues_pruned: totalIssuesPruned,
    avg_cost_per_success:
      successfulRuns.length > 0
        ? totalCost / successfulRuns.length
        : NaN,
    avg_duration_seconds:
      runs.length > 0 ? totalDuration / runs.length : 0,
    overall_efficiency: totalCost > 0 ? totalPrs / totalCost : 0,
    runs,
    mode_breakdown: scoreModeBreakdown(runs),
    cost_anomaly_count: costAnomalyCount,
    mode_diversity: computeModeDiversity(runs),
  };
}

export type CostAnomalySeverity = 'normal' | 'warning' | 'anomaly';

export interface CostAnomalyResult {
  severity: CostAnomalySeverity;
  cost_vs_avg: number;
  rolling_avg: number;
  run_cost: number;
}

/**
 * Detect cost anomalies by comparing a run's cost to the rolling average.
 *
 * Thresholds:
 *   - warning: cost >= 2x rolling average
 *   - anomaly: cost >= 4x rolling average
 *   - normal: below 2x
 *
 * Returns null if there's no prior history to compare against.
 */
export function detectCostAnomaly(
  runCost: number,
  priorHistory: RunMetrics[],
): CostAnomalyResult | null {
  if (priorHistory.length === 0) return null;

  const avgCost =
    priorHistory.reduce((s, r) => s + r.cost_usd, 0) / priorHistory.length;
  if (avgCost <= 0) return null;

  const ratio = runCost / avgCost;
  let severity: CostAnomalySeverity = 'normal';
  if (ratio >= 4) severity = 'anomaly';
  else if (ratio >= 2) severity = 'warning';

  return {
    severity,
    cost_vs_avg: ratio,
    rolling_avg: avgCost,
    run_cost: runCost,
  };
}

/** Format a RunScore as a compact one-line summary. */
export function formatRunScoreLine(score: RunScore): string {
  const status = score.success ? 'pass' : 'fail';
  const parts = [
    status,
    score.mode,
    `$${score.cost_usd.toFixed(2)}`,
    `${score.tool_calls} tools`,
    `${score.pr_count} PRs`,
    `${score.duration_seconds}s`,
  ];
  if (score.efficiency > 0) {
    parts.push(`${score.efficiency.toFixed(2)} PR/$`);
  }
  if (score.lines_deleted > 0) {
    parts.push(`-${score.lines_deleted} lines`);
  }
  if (score.issues_pruned > 0) {
    parts.push(`${score.issues_pruned} pruned`);
  }
  if (score.cost_vs_avg != null) {
    parts.push(`${score.cost_vs_avg.toFixed(1)}x avg`);
  }
  return parts.join(' | ');
}

/** Format a BatchScore as a multi-line summary table. */
export function formatBatchScoreTable(score: BatchScore): string {
  // Compute mode distribution from per-run scores
  const modeCounts: Record<string, number> = {};
  for (const run of score.runs) {
    modeCounts[run.mode] = (modeCounts[run.mode] || 0) + 1;
  }
  const modeStr = Object.entries(modeCounts)
    .map(([mode, count]) => `${mode}:${count}`)
    .join(', ');

  const lines = [
    `| Metric | Value |`,
    `|--------|-------|`,
    `| **Runs** | ${score.total_runs} (${score.successful_runs} successful) |`,
    `| **Success rate** | ${(score.success_rate * 100).toFixed(0)}% |`,
    `| **Total cost** | $${score.total_cost_usd.toFixed(2)} |`,
    `| **Total PRs** | ${score.total_prs} |`,
    `| **Issues closed** | ${score.total_issues_closed} |`,
    `| **Lines deleted** | ${score.total_lines_deleted} |`,
    `| **Issues pruned** | ${score.total_issues_pruned} |`,
    `| **Avg cost/success** | ${isNaN(score.avg_cost_per_success) ? 'N/A' : '$' + score.avg_cost_per_success.toFixed(2)} |`,
    `| **Efficiency** | ${score.overall_efficiency > 0 ? score.overall_efficiency.toFixed(2) + ' PR/$' : 'N/A'} |`,
  ];
  if (modeStr) {
    lines.push(`| **Modes** | ${modeStr} |`);
    lines.push(`| **Mode diversity** | ${(score.mode_diversity * 100).toFixed(0)}% |`);
  }
  if (score.cost_anomaly_count > 0) {
    lines.push(`| **Cost anomalies** | ${score.cost_anomaly_count} runs >= 2x avg |`);
  }
  if (score.post_hoc) {
    const ph = score.post_hoc;
    lines.push(
      `| **PR merge rate** | ${isNaN(ph.merge_rate) ? 'N/A' : (ph.merge_rate * 100).toFixed(0) + '%'} (${ph.merged_count}/${ph.prs.length}) |`,
    );
    if (ph.effective_efficiency > 0) {
      lines.push(
        `| **Effective efficiency** | ${ph.effective_efficiency.toFixed(2)} merged/$  |`,
      );
    }
  }

  // Append per-mode breakdown if there are multiple modes
  if (score.mode_breakdown && score.mode_breakdown.length > 1) {
    lines.push(formatModeBreakdown(score.mode_breakdown));
  }

  return lines.join('\n');
}

/**
 * Build post-hoc merge results from PR URLs and their statuses.
 * The caller is responsible for fetching statuses (e.g. via checkMergeStatus).
 */
export function postHocScoreBatch(
  prStatuses: Array<{ url: string; status: MergeStatus }>,
  totalCostUsd: number,
): PostHocBatchResult {
  const prs: PostHocPRResult[] = prStatuses.map(({ url, status }) => ({
    url,
    status,
  }));

  const merged = prs.filter((p) => p.status === 'merged').length;
  const closed = prs.filter((p) => p.status === 'closed').length;
  const pending = prs.length - merged - closed;

  return {
    prs,
    merged_count: merged,
    pending_count: pending,
    closed_count: closed,
    merge_rate: prs.length > 0 ? merged / prs.length : NaN,
    effective_efficiency: totalCostUsd > 0 ? merged / totalCostUsd : 0,
    scored_at: new Date().toISOString(),
  };
}

/** Compute per-mode effectiveness breakdown from run scores. */
export function scoreModeBreakdown(runs: RunScore[]): ModeStats[] {
  const byMode = new Map<string, RunScore[]>();
  for (const run of runs) {
    const group = byMode.get(run.mode) || [];
    group.push(run);
    byMode.set(run.mode, group);
  }

  const stats: ModeStats[] = [];
  for (const [mode, modeRuns] of byMode) {
    const successes = modeRuns.filter((r) => r.success).length;
    const totalCost = modeRuns.reduce((s, r) => s + r.cost_usd, 0);
    const totalPrs = modeRuns.reduce((s, r) => s + r.pr_count, 0);
    const totalLinesDeleted = modeRuns.reduce((s, r) => s + r.lines_deleted, 0);
    const totalIssuesPruned = modeRuns.reduce((s, r) => s + r.issues_pruned, 0);

    stats.push({
      mode,
      runs: modeRuns.length,
      successes,
      success_rate: modeRuns.length > 0 ? successes / modeRuns.length : 0,
      cost_usd: totalCost,
      prs: totalPrs,
      avg_cost: modeRuns.length > 0 ? totalCost / modeRuns.length : 0,
      efficiency: totalCost > 0 ? totalPrs / totalCost : 0,
      lines_deleted: totalLinesDeleted,
      issues_pruned: totalIssuesPruned,
    });
  }

  // Sort by number of runs descending (most-used mode first)
  stats.sort((a, b) => b.runs - a.runs);
  return stats;
}

/**
 * Compute mode diversity using normalized Shannon entropy.
 *
 * Returns a value in [0, 1]:
 *   0 = all runs used a single mode (no diversity)
 *   1 = runs are perfectly evenly distributed across modes
 *
 * With only one distinct mode, returns 0.
 */
export function computeModeDiversity(runs: RunScore[]): number {
  if (runs.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const r of runs) {
    counts.set(r.mode, (counts.get(r.mode) || 0) + 1);
  }

  const numModes = counts.size;
  if (numModes <= 1) return 0;

  // Shannon entropy: H = -sum(p * ln(p))
  const total = runs.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    if (p > 0) entropy -= p * Math.log(p);
  }

  // Normalize by max entropy (ln(numModes)) to get [0, 1]
  const maxEntropy = Math.log(numModes);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

/** Format per-mode breakdown as a markdown table. */
export function formatModeBreakdown(modeStats: ModeStats[]): string {
  if (modeStats.length <= 1) return '';

  const lines = [
    '',
    '**Per-mode effectiveness:**',
    '',
    '| Mode | Runs | Success | PRs | Cost | Efficiency | Deleted |',
    '|------|------|---------|-----|------|------------|---------|',
  ];

  for (const m of modeStats) {
    const rate = `${(m.success_rate * 100).toFixed(0)}%`;
    const eff = m.efficiency > 0 ? `${m.efficiency.toFixed(2)} PR/$` : '-';
    const deleted = m.lines_deleted > 0 ? `-${m.lines_deleted}` : '-';
    lines.push(
      `| ${m.mode} | ${m.runs} | ${rate} | ${m.prs} | $${m.cost_usd.toFixed(2)} | ${eff} | ${deleted} |`,
    );
  }

  return lines.join('\n');
}

/** Format post-hoc results as a compact summary line. */
export function formatPostHocLine(ph: PostHocBatchResult): string {
  const rate = isNaN(ph.merge_rate)
    ? 'N/A'
    : `${(ph.merge_rate * 100).toFixed(0)}%`;
  const parts = [
    `merge rate: ${rate}`,
    `${ph.merged_count} merged`,
    `${ph.pending_count} pending`,
    `${ph.closed_count} closed`,
  ];
  return parts.join(' | ');
}
