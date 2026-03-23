/**
 * batch-summary — Generate plain-language batch summaries from events.jsonl telemetry.
 *
 * Reads the structured JSONL events emitted by EventEmitter (auto-dent-events.ts)
 * and produces a human-readable summary suitable for non-developer stakeholders.
 *
 * Usage:
 *   npx tsx scripts/batch-summary.ts <batch-dir>
 *   npx tsx scripts/batch-summary.ts <batch-dir> --json
 *
 * Exercises the telemetry infrastructure from #649 (EventEmitter).
 * Advances observability horizon #249 (L0→L1 structured reporting).
 * Addresses human-agent interface #648 (plain-language summaries).
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { EventEnvelope, RunCompleteEvent, RunIssuePickedEvent, RunPrCreatedEvent } from './auto-dent-events.js';

export interface BatchSummary {
  batch_id: string;
  total_runs: number;
  successful_runs: number;
  empty_success_runs: number;
  failed_runs: number;
  stopped_runs: number;
  total_duration_minutes: number;
  total_cost_usd: number;
  total_prs: number;
  total_issues_filed: number;
  total_issues_closed: number;
  total_tool_calls: number;
  total_lifecycle_violations: number;
  issues_worked: string[];
  prs_created: string[];
  failure_classes: Record<string, number>;
  avg_run_duration_minutes: number;
  avg_cost_per_run_usd: number;
  cost_per_pr_usd: number;
  /** Label frequency across all picked issues — enables domain/horizon distribution analysis */
  label_distribution: Record<string, number>;
  /** Horizon labels (horizon/*) grouped for quick visibility */
  horizon_distribution: Record<string, number>;
  /** Area labels (area/*) grouped for quick visibility */
  area_distribution: Record<string, number>;
  /** Cognitive mode distribution — how many runs used each mode */
  mode_distribution: Record<string, number>;
  /** Outcome breakdown by cognitive mode — which modes produce PRs vs failures */
  mode_outcomes: Record<string, ModeOutcome>;
}

export interface ModeOutcome {
  runs: number;
  success: number;
  empty_success: number;
  failure: number;
  stop: number;
  prs: number;
  cost_usd: number;
}

/**
 * Parse events.jsonl from a batch directory into typed event envelopes.
 * Silently skips malformed lines.
 */
export function parseEventsFile(eventsPath: string): EventEnvelope[] {
  if (!existsSync(eventsPath)) return [];
  const content = readFileSync(eventsPath, 'utf8').trim();
  if (!content) return [];

  return content.split('\n').reduce<EventEnvelope[]>((acc, line) => {
    try {
      acc.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
    return acc;
  }, []);
}

/**
 * Aggregate events into a BatchSummary.
 */
export function summarizeEvents(envelopes: EventEnvelope[]): BatchSummary {
  const completeEvents = envelopes
    .filter((e): e is EventEnvelope & { event: RunCompleteEvent } => e.event.type === 'run.complete');

  const issueEvents = envelopes
    .filter((e): e is EventEnvelope & { event: RunIssuePickedEvent } => e.event.type === 'run.issue_picked');

  const prEvents = envelopes
    .filter((e): e is EventEnvelope & { event: RunPrCreatedEvent } => e.event.type === 'run.pr_created');

  const batchId = completeEvents[0]?.event.batch_id ?? issueEvents[0]?.event.batch_id ?? 'unknown';

  const totalDurationMs = completeEvents.reduce((sum, e) => sum + e.event.duration_ms, 0);
  const totalCost = completeEvents.reduce((sum, e) => sum + e.event.cost_usd, 0);
  const totalToolCalls = completeEvents.reduce((sum, e) => sum + e.event.tool_calls, 0);
  const totalPrs = completeEvents.reduce((sum, e) => sum + e.event.prs_created, 0);
  const totalIssuesFiled = completeEvents.reduce((sum, e) => sum + e.event.issues_filed, 0);
  const totalIssuesClosed = completeEvents.reduce((sum, e) => sum + e.event.issues_closed, 0);
  const totalViolations = completeEvents.reduce((sum, e) => sum + e.event.lifecycle_violations, 0);

  const successCount = completeEvents.filter(e => e.event.outcome === 'success').length;
  const emptySuccessCount = completeEvents.filter(e => e.event.outcome === 'empty_success').length;
  const failCount = completeEvents.filter(e => e.event.outcome === 'failure').length;
  const stopCount = completeEvents.filter(e => e.event.outcome === 'stop').length;

  const failureClasses: Record<string, number> = {};
  for (const e of completeEvents) {
    if (e.event.failure_class) {
      failureClasses[e.event.failure_class] = (failureClasses[e.event.failure_class] ?? 0) + 1;
    }
  }

  const issuesWorked = [...new Set(issueEvents.map(e => e.event.issue))];
  const prsCreated = [...new Set(prEvents.map(e => e.event.pr_url))];

  // Compute label distributions from issue_picked events
  const labelDistribution: Record<string, number> = {};
  const horizonDistribution: Record<string, number> = {};
  const areaDistribution: Record<string, number> = {};
  for (const e of issueEvents) {
    const labels = e.event.labels ?? [];
    for (const label of labels) {
      labelDistribution[label] = (labelDistribution[label] ?? 0) + 1;
      if (label.startsWith('horizon/')) {
        horizonDistribution[label] = (horizonDistribution[label] ?? 0) + 1;
      }
      if (label.startsWith('area/')) {
        areaDistribution[label] = (areaDistribution[label] ?? 0) + 1;
      }
    }
  }

  // Compute cognitive mode distribution and mode-outcome matrix
  const modeDistribution: Record<string, number> = {};
  const modeOutcomes: Record<string, ModeOutcome> = {};
  for (const e of completeEvents) {
    const mode = e.event.mode || 'exploit';
    modeDistribution[mode] = (modeDistribution[mode] ?? 0) + 1;

    if (!modeOutcomes[mode]) {
      modeOutcomes[mode] = { runs: 0, success: 0, empty_success: 0, failure: 0, stop: 0, prs: 0, cost_usd: 0 };
    }
    const mo = modeOutcomes[mode];
    mo.runs++;
    mo.cost_usd = Math.round((mo.cost_usd + e.event.cost_usd) * 100) / 100;
    mo.prs += e.event.prs_created;
    if (e.event.outcome === 'success') mo.success++;
    else if (e.event.outcome === 'empty_success') mo.empty_success++;
    else if (e.event.outcome === 'failure') mo.failure++;
    else if (e.event.outcome === 'stop') mo.stop++;
  }

  const runCount = completeEvents.length || 1;
  const totalDurationMinutes = Math.round(totalDurationMs / 60000 * 10) / 10;

  return {
    batch_id: batchId,
    total_runs: completeEvents.length,
    successful_runs: successCount,
    empty_success_runs: emptySuccessCount,
    failed_runs: failCount,
    stopped_runs: stopCount,
    total_duration_minutes: totalDurationMinutes,
    total_cost_usd: Math.round(totalCost * 100) / 100,
    total_prs: totalPrs,
    total_issues_filed: totalIssuesFiled,
    total_issues_closed: totalIssuesClosed,
    total_tool_calls: totalToolCalls,
    total_lifecycle_violations: totalViolations,
    issues_worked: issuesWorked,
    prs_created: prsCreated,
    failure_classes: failureClasses,
    avg_run_duration_minutes: Math.round(totalDurationMinutes / runCount * 10) / 10,
    avg_cost_per_run_usd: Math.round(totalCost / runCount * 100) / 100,
    cost_per_pr_usd: totalPrs > 0 ? Math.round(totalCost / totalPrs * 100) / 100 : 0,
    label_distribution: labelDistribution,
    horizon_distribution: horizonDistribution,
    area_distribution: areaDistribution,
    mode_distribution: modeDistribution,
    mode_outcomes: modeOutcomes,
  };
}

/**
 * Format a BatchSummary as plain-language text suitable for posting
 * to a batch progress issue or reading by non-developer stakeholders.
 */
export function formatPlainLanguage(summary: BatchSummary): string {
  const lines: string[] = [];

  const hours = Math.floor(summary.total_duration_minutes / 60);
  const mins = Math.round(summary.total_duration_minutes % 60);
  const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  lines.push(`## Batch Summary: ${summary.batch_id}`);
  lines.push('');
  lines.push(`This batch ran **${summary.total_runs} times** over **${durationStr}**.`);
  lines.push('');

  // Outcome breakdown
  const parts: string[] = [];
  if (summary.successful_runs > 0) parts.push(`${summary.successful_runs} successful`);
  if (summary.empty_success_runs > 0) parts.push(`${summary.empty_success_runs} empty`);
  if (summary.failed_runs > 0) parts.push(`${summary.failed_runs} failed`);
  if (summary.stopped_runs > 0) parts.push(`${summary.stopped_runs} stopped`);
  if (parts.length > 0) {
    lines.push(`**Outcomes:** ${parts.join(', ')}`);
  }

  // Key metrics
  lines.push('');
  lines.push('### Key Metrics');
  lines.push(`- **PRs created:** ${summary.total_prs}`);
  lines.push(`- **Issues worked:** ${summary.issues_worked.length}`);
  lines.push(`- **Issues closed:** ${summary.total_issues_closed}`);
  lines.push(`- **Total cost:** $${summary.total_cost_usd.toFixed(2)}`);
  if (summary.total_prs > 0) {
    lines.push(`- **Cost per PR:** $${summary.cost_per_pr_usd.toFixed(2)}`);
  }
  lines.push(`- **Avg run duration:** ${summary.avg_run_duration_minutes}m`);

  // Failure analysis
  const failureEntries = Object.entries(summary.failure_classes);
  if (failureEntries.length > 0) {
    lines.push('');
    lines.push('### Failure Patterns');
    for (const [cls, count] of failureEntries.sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${cls}: ${count} occurrence${count > 1 ? 's' : ''}`);
    }
  }

  // Domain distribution (horizons and areas)
  const horizonEntries = Object.entries(summary.horizon_distribution);
  const areaEntries = Object.entries(summary.area_distribution);
  if (horizonEntries.length > 0 || areaEntries.length > 0) {
    lines.push('');
    lines.push('### Domain Distribution');
    if (horizonEntries.length > 0) {
      lines.push('**Horizons touched:**');
      for (const [label, count] of horizonEntries.sort((a, b) => b[1] - a[1])) {
        lines.push(`- ${label}: ${count} issue${count > 1 ? 's' : ''}`);
      }
    }
    if (areaEntries.length > 0) {
      lines.push('**Areas touched:**');
      for (const [label, count] of areaEntries.sort((a, b) => b[1] - a[1])) {
        lines.push(`- ${label}: ${count} issue${count > 1 ? 's' : ''}`);
      }
    }
  }

  // Cognitive mode analysis
  const modeEntries = Object.entries(summary.mode_distribution);
  if (modeEntries.length > 0) {
    lines.push('');
    lines.push('### Cognitive Mode Distribution');
    lines.push('| Mode | Runs | PRs | Success | Empty | Failed | Cost |');
    lines.push('|------|------|-----|---------|-------|--------|------|');
    for (const [mode] of modeEntries.sort((a, b) => b[1] - a[1])) {
      const mo = summary.mode_outcomes[mode];
      if (!mo) continue;
      lines.push(`| ${mode} | ${mo.runs} | ${mo.prs} | ${mo.success} | ${mo.empty_success} | ${mo.failure} | $${mo.cost_usd.toFixed(2)} |`);
    }

    // Strategic diversity indicator
    if (modeEntries.length === 1) {
      lines.push('');
      lines.push('*Single-mode batch — consider enabling mode diversity for strategic balance.*');
    }
  }

  // Lifecycle health
  if (summary.total_lifecycle_violations > 0) {
    lines.push('');
    lines.push(`**Lifecycle violations:** ${summary.total_lifecycle_violations} (process ordering issues detected)`);
  }

  return lines.join('\n');
}

// CLI entry point
if (process.argv[1]?.endsWith('batch-summary.ts') || process.argv[1]?.endsWith('batch-summary.js')) {
  const batchDir = process.argv[2];
  const jsonMode = process.argv.includes('--json');

  if (!batchDir) {
    console.error('Usage: npx tsx scripts/batch-summary.ts <batch-dir> [--json]');
    process.exit(1);
  }

  const eventsPath = resolve(batchDir, 'events.jsonl');
  const envelopes = parseEventsFile(eventsPath);

  if (envelopes.length === 0) {
    console.error(`No events found at ${eventsPath}`);
    process.exit(1);
  }

  const summary = summarizeEvents(envelopes);

  if (jsonMode) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatPlainLanguage(summary));
  }
}
