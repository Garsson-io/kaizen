/**
 * telemetry-analysis.ts — Analyze collected hook telemetry data.
 *
 * Reads the hooks.jsonl file produced by hook-telemetry.sh and computes
 * per-hook statistics: average duration, p95, failure rate, invocation count.
 * Identifies slow hooks and performance regressions.
 *
 * This closes the observability gap where hook timing data was collected
 * (via hook-telemetry.sh) but never analyzed or surfaced.
 *
 * Part of horizon #249 (Observability), epic #451 (Hook performance).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface HookTelemetryRecord {
  hook: string;
  timestamp: string;
  duration_ms: number;
  exit_code: number;
  branch: string;
  case_id: string;
}

interface HookStats {
  hook: string;
  count: number;
  avg_ms: number;
  p95_ms: number;
  max_ms: number;
  failure_rate: number;
  failures: number;
}

interface TelemetryReport {
  total_records: number;
  time_range: { first: string; last: string } | null;
  hooks: HookStats[];
  slow_hooks: HookStats[];
  high_failure_hooks: HookStats[];
  total_overhead_ms: number;
  avg_overhead_per_event_ms: number;
}

const SLOW_THRESHOLD_MS = 100;
const HIGH_FAILURE_RATE = 0.05;

/**
 * Parse hooks.jsonl file into records. Skips malformed lines.
 */
export function parseHooksJsonl(content: string): HookTelemetryRecord[] {
  const records: HookTelemetryRecord[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        typeof parsed.hook === 'string' &&
        typeof parsed.duration_ms === 'number' &&
        typeof parsed.timestamp === 'string'
      ) {
        records.push({
          hook: parsed.hook,
          timestamp: parsed.timestamp,
          duration_ms: parsed.duration_ms,
          exit_code: typeof parsed.exit_code === 'number' ? parsed.exit_code : 0,
          branch: typeof parsed.branch === 'string' ? parsed.branch : '',
          case_id: typeof parsed.case_id === 'string' ? parsed.case_id : '',
        });
      }
    } catch {
      // Skip malformed lines
    }
  }
  return records;
}

/**
 * Compute the p95 value from a sorted array of numbers.
 */
function percentile95(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.min(idx, sorted.length - 1)];
}

/**
 * Compute per-hook statistics from telemetry records.
 */
export function computeHookStats(records: HookTelemetryRecord[]): HookStats[] {
  const byHook = new Map<string, HookTelemetryRecord[]>();
  for (const r of records) {
    const existing = byHook.get(r.hook);
    if (existing) {
      existing.push(r);
    } else {
      byHook.set(r.hook, [r]);
    }
  }

  const stats: HookStats[] = [];
  for (const [hook, hookRecords] of byHook) {
    const durations = hookRecords.map((r) => r.duration_ms).sort((a, b) => a - b);
    const failures = hookRecords.filter((r) => r.exit_code !== 0).length;
    const total = durations.reduce((sum, d) => sum + d, 0);

    stats.push({
      hook,
      count: hookRecords.length,
      avg_ms: Math.round(total / hookRecords.length),
      p95_ms: percentile95(durations),
      max_ms: durations[durations.length - 1],
      failure_rate: hookRecords.length > 0 ? failures / hookRecords.length : 0,
      failures,
    });
  }

  return stats.sort((a, b) => b.avg_ms - a.avg_ms);
}

/**
 * Build a full telemetry report from records.
 */
export function buildReport(records: HookTelemetryRecord[]): TelemetryReport {
  const stats = computeHookStats(records);
  const slowHooks = stats.filter((s) => s.p95_ms >= SLOW_THRESHOLD_MS);
  const highFailureHooks = stats.filter((s) => s.failure_rate >= HIGH_FAILURE_RATE && s.count >= 5);

  const totalOverhead = records.reduce((sum, r) => sum + r.duration_ms, 0);

  // Estimate events by counting distinct timestamp clusters (within 2s)
  const timestamps = records.map((r) => new Date(r.timestamp).getTime()).sort((a, b) => a - b);
  let eventCount = timestamps.length > 0 ? 1 : 0;
  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i] - timestamps[i - 1] > 2000) {
      eventCount++;
    }
  }

  const sortedTimestamps = records
    .map((r) => r.timestamp)
    .sort();

  return {
    total_records: records.length,
    time_range:
      sortedTimestamps.length > 0
        ? { first: sortedTimestamps[0], last: sortedTimestamps[sortedTimestamps.length - 1] }
        : null,
    hooks: stats,
    slow_hooks: slowHooks,
    high_failure_hooks: highFailureHooks,
    total_overhead_ms: totalOverhead,
    avg_overhead_per_event_ms: eventCount > 0 ? Math.round(totalOverhead / eventCount) : 0,
  };
}

/**
 * Format a report as a human-readable string for inclusion in reflection prompts.
 */
export function formatReport(report: TelemetryReport): string {
  if (report.total_records === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push(`HOOK TELEMETRY ANALYSIS (${report.total_records} records)`);
  if (report.time_range) {
    lines.push(`Period: ${report.time_range.first} → ${report.time_range.last}`);
  }
  lines.push(`Total overhead: ${report.total_overhead_ms}ms | Avg per event: ${report.avg_overhead_per_event_ms}ms`);
  lines.push('');

  if (report.slow_hooks.length > 0) {
    lines.push('Slow hooks (p95 ≥ 100ms):');
    for (const h of report.slow_hooks) {
      lines.push(`  ${h.hook}  avg=${h.avg_ms}ms  p95=${h.p95_ms}ms  max=${h.max_ms}ms  (${h.count} calls)`);
    }
    lines.push('');
  }

  if (report.high_failure_hooks.length > 0) {
    lines.push('High failure rate hooks (≥5%):');
    for (const h of report.high_failure_hooks) {
      const pct = (h.failure_rate * 100).toFixed(1);
      lines.push(`  ${h.hook}  ${pct}% failure rate  (${h.failures}/${h.count})`);
    }
    lines.push('');
  }

  if (report.slow_hooks.length === 0 && report.high_failure_hooks.length === 0) {
    lines.push('All hooks within performance budgets.');
  }

  return lines.join('\n');
}

/**
 * Read hooks.jsonl from the telemetry directory and produce a formatted report.
 * Returns empty string if no data or errors occur.
 */
export function analyzeHookTelemetry(telemetryDir?: string): string {
  try {
    const dir = telemetryDir ?? resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), '.kaizen', 'telemetry');
    const filePath = resolve(dir, 'hooks.jsonl');
    if (!existsSync(filePath)) return '';
    const content = readFileSync(filePath, 'utf-8');
    const records = parseHooksJsonl(content);
    if (records.length === 0) return '';
    const report = buildReport(records);
    return formatReport(report);
  } catch {
    return '';
  }
}
