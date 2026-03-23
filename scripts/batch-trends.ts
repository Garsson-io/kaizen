/**
 * batch-trends — Cross-batch trend analysis from events.jsonl telemetry.
 *
 * Scans multiple batch directories, reads events.jsonl from each,
 * and produces time-series trend data: cost/PR, success rate, avg duration.
 *
 * Usage:
 *   npx tsx scripts/batch-trends.ts <parent-dir>
 *   npx tsx scripts/batch-trends.ts <parent-dir> --json
 *   npx tsx scripts/batch-trends.ts <batch-dir-1> <batch-dir-2> ...
 *
 * Builds on: #648 (batch-summary), #649 (EventEmitter)
 * Addresses: #652 (cross-batch trend analysis)
 * Parent: #249 (Observability horizon)
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { parseEventsFile, summarizeEvents, type BatchSummary } from './batch-summary.js';

export interface BatchDataPoint {
  batch_id: string;
  timestamp: string;
  total_runs: number;
  successful_runs: number;
  failed_runs: number;
  success_rate: number;
  total_prs: number;
  total_cost_usd: number;
  cost_per_pr_usd: number;
  avg_run_duration_minutes: number;
  total_lifecycle_violations: number;
  failure_classes: Record<string, number>;
  horizon_distribution: Record<string, number>;
  area_distribution: Record<string, number>;
  mode_distribution: Record<string, number>;
}

export interface TrendReport {
  batch_count: number;
  date_range: { earliest: string; latest: string };
  datapoints: BatchDataPoint[];
  trends: {
    cost_per_pr: TrendDirection;
    success_rate: TrendDirection;
    avg_duration: TrendDirection;
    lifecycle_violations: TrendDirection;
    mode_diversity: TrendDirection;
  };
  totals: {
    total_runs: number;
    total_prs: number;
    total_cost_usd: number;
    total_failures: number;
  };
}

export interface TrendDirection {
  direction: 'improving' | 'worsening' | 'stable' | 'insufficient_data';
  first_half_avg: number;
  second_half_avg: number;
  change_pct: number;
}

/**
 * Discover batch directories under a parent directory.
 * Batch dirs are identified by containing an events.jsonl file.
 */
export function discoverBatchDirs(parentDir: string): string[] {
  if (!existsSync(parentDir)) return [];
  const entries = readdirSync(parentDir);
  const dirs: string[] = [];

  for (const entry of entries) {
    const fullPath = resolve(parentDir, entry);
    try {
      if (statSync(fullPath).isDirectory()) {
        const eventsPath = resolve(fullPath, 'events.jsonl');
        if (existsSync(eventsPath)) {
          dirs.push(fullPath);
        }
      }
    } catch {
      // Skip entries we can't stat
    }
  }

  return dirs.sort();
}

/**
 * Convert a BatchSummary into a BatchDataPoint with trend-relevant metrics.
 */
export function toDataPoint(summary: BatchSummary, timestamp: string): BatchDataPoint {
  const successRate = summary.total_runs > 0
    ? Math.round((summary.successful_runs / summary.total_runs) * 1000) / 10
    : 0;

  return {
    batch_id: summary.batch_id,
    timestamp,
    total_runs: summary.total_runs,
    successful_runs: summary.successful_runs,
    failed_runs: summary.failed_runs,
    success_rate: successRate,
    total_prs: summary.total_prs,
    total_cost_usd: summary.total_cost_usd,
    cost_per_pr_usd: summary.cost_per_pr_usd,
    avg_run_duration_minutes: summary.avg_run_duration_minutes,
    total_lifecycle_violations: summary.total_lifecycle_violations,
    failure_classes: summary.failure_classes,
    horizon_distribution: summary.horizon_distribution,
    area_distribution: summary.area_distribution,
    mode_distribution: summary.mode_distribution,
  };
}

/**
 * Compute trend direction by comparing first-half vs second-half averages.
 * `lowerIsBetter` controls whether a decrease is "improving" or "worsening".
 */
export function computeTrend(
  values: number[],
  lowerIsBetter: boolean,
): TrendDirection {
  if (values.length < 2) {
    return { direction: 'insufficient_data', first_half_avg: 0, second_half_avg: 0, change_pct: 0 };
  }

  const mid = Math.ceil(values.length / 2);
  const firstHalf = values.slice(0, mid);
  const secondHalf = values.slice(mid);

  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  const changePct = firstAvg !== 0
    ? Math.round(((secondAvg - firstAvg) / firstAvg) * 1000) / 10
    : 0;

  const threshold = 5; // 5% change threshold for stable
  let direction: TrendDirection['direction'];
  if (Math.abs(changePct) < threshold) {
    direction = 'stable';
  } else if (lowerIsBetter) {
    direction = changePct < 0 ? 'improving' : 'worsening';
  } else {
    direction = changePct > 0 ? 'improving' : 'worsening';
  }

  return {
    direction,
    first_half_avg: Math.round(firstAvg * 100) / 100,
    second_half_avg: Math.round(secondAvg * 100) / 100,
    change_pct: changePct,
  };
}

/**
 * Build a TrendReport from multiple batch directories.
 */
export function analyzeTrends(batchDirs: string[]): TrendReport {
  const datapoints: BatchDataPoint[] = [];

  for (const dir of batchDirs) {
    const eventsPath = resolve(dir, 'events.jsonl');
    const envelopes = parseEventsFile(eventsPath);
    if (envelopes.length === 0) continue;

    const summary = summarizeEvents(envelopes);
    const earliest = envelopes[0]?.timestamp ?? new Date().toISOString();
    datapoints.push(toDataPoint(summary, earliest));
  }

  // Sort by timestamp
  datapoints.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const dateRange = {
    earliest: datapoints[0]?.timestamp ?? '',
    latest: datapoints[datapoints.length - 1]?.timestamp ?? '',
  };

  const trends = {
    cost_per_pr: computeTrend(datapoints.map(d => d.cost_per_pr_usd), true),
    success_rate: computeTrend(datapoints.map(d => d.success_rate), false),
    avg_duration: computeTrend(datapoints.map(d => d.avg_run_duration_minutes), true),
    lifecycle_violations: computeTrend(datapoints.map(d => d.total_lifecycle_violations), true),
    mode_diversity: computeTrend(datapoints.map(d => Object.keys(d.mode_distribution).length), false),
  };

  const totals = {
    total_runs: datapoints.reduce((s, d) => s + d.total_runs, 0),
    total_prs: datapoints.reduce((s, d) => s + d.total_prs, 0),
    total_cost_usd: Math.round(datapoints.reduce((s, d) => s + d.total_cost_usd, 0) * 100) / 100,
    total_failures: datapoints.reduce((s, d) => s + d.failed_runs, 0),
  };

  return { batch_count: datapoints.length, date_range: dateRange, datapoints, trends, totals };
}

/**
 * Format a TrendReport as human-readable text.
 */
export function formatTrendReport(report: TrendReport): string {
  const lines: string[] = [];

  lines.push(`## Cross-Batch Trend Analysis`);
  lines.push('');
  lines.push(`Analyzed **${report.batch_count} batches** from ${formatDate(report.date_range.earliest)} to ${formatDate(report.date_range.latest)}.`);
  lines.push('');

  // Totals
  lines.push('### Totals');
  lines.push(`- **Total runs:** ${report.totals.total_runs}`);
  lines.push(`- **Total PRs:** ${report.totals.total_prs}`);
  lines.push(`- **Total cost:** $${report.totals.total_cost_usd.toFixed(2)}`);
  lines.push(`- **Total failures:** ${report.totals.total_failures}`);
  lines.push('');

  // Trends
  lines.push('### Trends');
  lines.push(formatTrendLine('Cost/PR', report.trends.cost_per_pr, '$'));
  lines.push(formatTrendLine('Success rate', report.trends.success_rate, '%'));
  lines.push(formatTrendLine('Avg duration', report.trends.avg_duration, 'm'));
  lines.push(formatTrendLine('Lifecycle violations', report.trends.lifecycle_violations, ''));
  lines.push(formatTrendLine('Mode diversity', report.trends.mode_diversity, ' modes'));
  lines.push('');

  // Per-batch table
  lines.push('### Per-Batch Breakdown');
  lines.push('| Batch | Runs | PRs | Cost | Cost/PR | Success% | Avg Duration |');
  lines.push('|-------|------|-----|------|---------|----------|-------------|');
  for (const dp of report.datapoints) {
    lines.push(`| ${dp.batch_id} | ${dp.total_runs} | ${dp.total_prs} | $${dp.total_cost_usd.toFixed(2)} | $${dp.cost_per_pr_usd.toFixed(2)} | ${dp.success_rate}% | ${dp.avg_run_duration_minutes}m |`);
  }

  return lines.join('\n');
}

function formatDate(iso: string): string {
  if (!iso) return 'N/A';
  return iso.slice(0, 10);
}

function formatTrendLine(label: string, trend: TrendDirection, unit: string): string {
  const arrow = trend.direction === 'improving' ? '↗' :
    trend.direction === 'worsening' ? '↘' :
    trend.direction === 'stable' ? '→' : '?';
  const status = trend.direction === 'improving' ? '(improving)' :
    trend.direction === 'worsening' ? '(needs attention)' :
    trend.direction === 'stable' ? '(stable)' : '(not enough data)';

  if (trend.direction === 'insufficient_data') {
    return `- **${label}:** ${status}`;
  }
  return `- **${label}:** ${trend.first_half_avg}${unit} → ${trend.second_half_avg}${unit} (${trend.change_pct > 0 ? '+' : ''}${trend.change_pct}%) ${arrow} ${status}`;
}

// CLI entry point
if (process.argv[1]?.endsWith('batch-trends.ts') || process.argv[1]?.endsWith('batch-trends.js')) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const jsonMode = process.argv.includes('--json');

  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/batch-trends.ts <parent-dir|batch-dir...> [--json]');
    process.exit(1);
  }

  let batchDirs: string[];
  if (args.length === 1) {
    // Single arg: could be a parent dir containing batch subdirs, or a single batch dir
    const resolved = resolve(args[0]);
    const discovered = discoverBatchDirs(resolved);
    if (discovered.length > 0) {
      batchDirs = discovered;
    } else if (existsSync(resolve(resolved, 'events.jsonl'))) {
      batchDirs = [resolved];
    } else {
      console.error(`No batch directories with events.jsonl found in ${resolved}`);
      process.exit(1);
    }
  } else {
    batchDirs = args.map(a => resolve(a));
  }

  const report = analyzeTrends(batchDirs);

  if (report.batch_count === 0) {
    console.error('No events found in any batch directory');
    process.exit(1);
  }

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatTrendReport(report));
  }
}
