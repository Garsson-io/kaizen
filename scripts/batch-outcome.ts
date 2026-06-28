/**
 * batch-outcome.ts — durable, machine-readable batch outcome attachment (#1108, #940 Phase 1).
 *
 * At batch close, auto-dent posts a human markdown table to the progress issue
 * (see `closeBatchProgressIssue`). That table is unreadable by the cross-batch
 * analysis tools — every new batch starts blind. This module derives a
 * structured, schema-validated `batch-outcome` object from the batch state and
 * writes it as a named attachment (`<!-- kaizen:batch-outcome -->`) on the
 * progress issue, so any machine can resolve the batch's outcome with zero
 * parsing — using the same named-attachment primitive every other kaizen skill
 * uses.
 *
 * Phase 2 (#940) wires `batch-trends.ts` / `auto-dent-ctl.ts history` to read
 * these attachments back via `readBatchOutcome` (`--from-github`).
 */

import { z } from 'zod';
import { writeAttachment, readAttachment } from '../src/section-editor.js';
import { gh } from '../src/lib/gh-exec.js';
import type { BatchState } from './auto-dent-run.js';
import { type BatchScore, effectiveIssuesClosed } from './auto-dent-score.js';

/** Named-attachment key on the progress issue. Stable contract with Phase 2 readers. */
export const BATCH_OUTCOME_ATTACHMENT = 'batch-outcome';

/**
 * Schema version for the attachment payload. Bump when the shape changes
 * incompatibly so readers can branch. Phase 2 readers assert on this.
 */
export const BATCH_OUTCOME_SCHEMA_VERSION = 1;

/** Per-mode effectiveness rollup carried in the outcome (mirrors ModeStats). */
const ModeBreakdownSchema = z.object({
  mode: z.string(),
  runs: z.number(),
  successes: z.number(),
  success_rate: z.number(),
  cost_usd: z.number(),
  prs: z.number(),
  avg_cost: z.number(),
  efficiency: z.number(),
  lines_deleted: z.number(),
  issues_pruned: z.number(),
});

/** Batch trend analysis (mirrors BatchTrend); null when fewer than 4 runs. */
const BatchTrendSchema = z
  .object({
    cost_slope: z.number(),
    first_half_success_rate: z.number(),
    second_half_success_rate: z.number(),
    efficiency_slope: z.number(),
    duration_slope: z.number(),
    summary: z.string(),
  })
  .nullable();

/**
 * The structured batch outcome. Derived purely from `BatchState` + `BatchScore`.
 * This is the cross-batch learning record — keep it machine-resolvable, not prose.
 */
export const BatchOutcomeSchema = z.object({
  schema_version: z.literal(BATCH_OUTCOME_SCHEMA_VERSION),
  batch_id: z.string(),
  guidance: z.string(),
  batch_start: z.number(),
  batch_end: z.number(),
  wall_seconds: z.number(),
  stop_reason: z.string(),
  totals: z.object({
    runs: z.number(),
    successful_runs: z.number(),
    prs: z.number(),
    issues_closed: z.number(),
    issues_filed: z.number(),
    cost_usd: z.number(),
    duration_seconds: z.number(),
    lines_deleted: z.number(),
    issues_pruned: z.number(),
  }),
  success_rate: z.number(),
  avg_cost_per_success: z.number().nullable(),
  overall_efficiency: z.number(),
  review_fail_rate: z.number(),
  cost_anomaly_count: z.number(),
  mode_diversity: z.number(),
  trend: BatchTrendSchema,
  mode_breakdown: z.array(ModeBreakdownSchema),
  prs: z.array(z.string()),
  issues_closed: z.array(z.string()),
  issues_filed: z.array(z.string()),
});

export type BatchOutcome = z.infer<typeof BatchOutcomeSchema>;

/**
 * Build the structured outcome from batch state + score. Pure: `nowEpoch` is
 * injected (seconds since epoch) so the builder is deterministic and testable.
 * Non-finite derived numbers (e.g. efficiency / avg-per-success with no
 * successes) are normalized so the result always passes `BatchOutcomeSchema`
 * and JSON-serializes cleanly (JSON.stringify turns NaN/Infinity into null).
 */
export function buildBatchOutcome(
  state: BatchState,
  score: BatchScore,
  nowEpoch: number,
): BatchOutcome {
  const finite = (n: number): number => (Number.isFinite(n) ? n : 0);
  const finiteOrNull = (n: number): number | null =>
    Number.isFinite(n) ? n : null;

  return {
    schema_version: BATCH_OUTCOME_SCHEMA_VERSION,
    batch_id: state.batch_id,
    guidance: state.guidance ?? '',
    batch_start: state.batch_start,
    batch_end: nowEpoch,
    wall_seconds: Math.max(0, nowEpoch - state.batch_start),
    stop_reason: state.stop_reason || 'completed',
    totals: {
      runs: score.total_runs,
      successful_runs: score.successful_runs,
      prs: score.total_prs,
      issues_closed: effectiveIssuesClosed(score),
      issues_filed: state.issues_filed.length,
      cost_usd: finite(score.total_cost_usd),
      duration_seconds: finite(score.total_duration_seconds),
      lines_deleted: finite(score.total_lines_deleted),
      issues_pruned: finite(score.total_issues_pruned),
    },
    success_rate: finite(score.success_rate),
    avg_cost_per_success: finiteOrNull(score.avg_cost_per_success),
    overall_efficiency: finite(score.overall_efficiency),
    review_fail_rate: finite(score.review_fail_rate),
    cost_anomaly_count: score.cost_anomaly_count,
    mode_diversity: finite(score.mode_diversity),
    trend: score.trend,
    mode_breakdown: score.mode_breakdown.map((m) => ({
      mode: m.mode,
      runs: m.runs,
      successes: m.successes,
      success_rate: finite(m.success_rate),
      cost_usd: finite(m.cost_usd),
      prs: m.prs,
      avg_cost: finite(m.avg_cost),
      efficiency: finite(m.efficiency),
      lines_deleted: finite(m.lines_deleted),
      issues_pruned: finite(m.issues_pruned),
    })),
    prs: state.prs,
    issues_closed: state.issues_closed,
    issues_filed: state.issues_filed,
  };
}

/**
 * Write the outcome as a named attachment on the progress issue. Idempotent:
 * `writeAttachment` updates the existing marker comment if present. Returns the
 * comment URL.
 */
export function writeBatchOutcomeAttachment(
  issueNumber: string,
  repo: string,
  outcome: BatchOutcome,
): string {
  return writeAttachment(
    { kind: 'issue', number: issueNumber, repo },
    BATCH_OUTCOME_ATTACHMENT,
    JSON.stringify(outcome, null, 2),
  );
}

/**
 * Read the outcome back from a progress issue. Returns null if no attachment is
 * present. Throws (via Zod) if the attachment exists but is malformed — drift
 * is a bug, not a silent miss.
 */
export function readBatchOutcome(
  issueNumber: string,
  repo: string,
): BatchOutcome | null {
  const attachment = readAttachment(
    { kind: 'issue', number: issueNumber, repo },
    BATCH_OUTCOME_ATTACHMENT,
  );
  if (!attachment) return null;
  return BatchOutcomeSchema.parse(JSON.parse(attachment.content));
}

// ---------------------------------------------------------------------------
// Phase 2 (#940) — read prior batch outcomes back from GitHub and turn them
// into steering recommendations that bias the next batch's prompt.
//
// Phase 1 made the outcome durable and cloud-accessible. The loop only closes
// when a *later* batch reads those outcomes and changes what it does. This is
// the read + analyze side: discovery (`readBatchOutcomesFromGithub`), analysis
// (`computeSteeringRecommendations`), and display (`formatSteeringReport`).
// ---------------------------------------------------------------------------

/** Options for {@link readBatchOutcomesFromGithub}. */
export interface ReadOutcomesOpts {
  /** Max progress issues to scan, newest-first. Default 20. */
  limit?: number;
  /** Skip the outcome whose `batch_id` matches (exclude the current batch's own record). */
  excludeBatchId?: string;
}

/**
 * Injectable I/O for {@link readBatchOutcomesFromGithub}, so the discovery
 * logic is unit-testable without touching the network. Defaults shell out to
 * `gh` and reuse {@link readBatchOutcome}.
 */
export interface ReadOutcomesDeps {
  /** Return auto-dent progress-issue numbers, newest-first, bounded by `limit`. */
  listIssues?: (repo: string, limit: number) => number[];
  /** Resolve one issue's batch-outcome attachment (null if absent). */
  readOutcome?: (issueNumber: string, repo: string) => BatchOutcome | null;
}

/** Default lister: every batch progress issue carries the `auto-dent` label (see auto-dent-run.ts). */
function defaultListIssues(repo: string, limit: number): number[] {
  const out = gh([
    'issue', 'list', '--repo', repo,
    '--label', 'auto-dent', '--state', 'all',
    '--json', 'number', '--jq', '.[].number',
    '--limit', String(limit),
  ]);
  return out
    .split('\n')
    .map((l) => parseInt(l.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Discover prior batches' outcomes from GitHub. Enumerates `auto-dent`-labeled
 * progress issues (newest-first), reads each one's `batch-outcome` attachment,
 * and returns the validated outcomes.
 *
 * Fail-soft per issue: a missing attachment is skipped, and a malformed one is
 * skipped (not thrown) so a single drifted batch can't blind the next — this is
 * read-side steering, where fail-open beats fail-closed. The current batch's own
 * record is excluded via `excludeBatchId`.
 */
export function readBatchOutcomesFromGithub(
  repo: string,
  opts: ReadOutcomesOpts = {},
  deps: ReadOutcomesDeps = {},
): BatchOutcome[] {
  const limit = opts.limit ?? 20;
  const listIssues = deps.listIssues ?? defaultListIssues;
  const readOutcome = deps.readOutcome ?? readBatchOutcome;

  const numbers = listIssues(repo, limit);
  const outcomes: BatchOutcome[] = [];
  for (const n of numbers) {
    let outcome: BatchOutcome | null = null;
    try {
      outcome = readOutcome(String(n), repo);
    } catch {
      // Malformed attachment on one issue — skip, don't abort the sweep.
      continue;
    }
    if (!outcome) continue;
    if (opts.excludeBatchId && outcome.batch_id === opts.excludeBatchId) continue;
    outcomes.push(outcome);
  }
  return outcomes;
}

/** One steering recommendation with a priority for stable ordering. */
export interface SteeringRecommendation {
  /** Lower sorts first. */
  priority: number;
  /** Category, for grouping/telemetry. */
  kind: 'trajectory' | 'mode' | 'review' | 'stop_reason' | 'cost';
  /** Concrete, actionable guidance the next batch should weigh. */
  text: string;
}

/** Result of {@link computeSteeringRecommendations}. */
export interface SteeringReport {
  batches_analyzed: number;
  /** Oldest/newest `batch_start` seen, or null when empty. */
  span: { from: number; to: number } | null;
  best_mode: string | null;
  worst_mode: string | null;
  recommendations: SteeringRecommendation[];
  /** One-line headline. */
  summary: string;
}

/** Per-mode rollup across all analyzed batches. */
interface ModeRollup {
  mode: string;
  runs: number;
  successes: number;
  prs: number;
  cost_usd: number;
  success_rate: number;
  efficiency: number; // PRs per $ — higher is better
}

export interface BanditPriorMode {
  /** Decayed cross-batch plays for this mode. */
  plays: number;
  /** Decayed cross-batch reward total for this mode. */
  total_reward: number;
}

export interface BanditPrior {
  source: 'batch-outcome';
  /** Number of batch outcomes that contributed at least one mode row. */
  source_batches: number;
  /** Recency decay applied per batch, newest outcome weight = 1. */
  decay: number;
  /** Per-mode prior evidence keyed by mode name. */
  modes: Record<string, BanditPriorMode>;
}

function outcomesWithModeEvidence(
  outcomes: BatchOutcome[],
  opts: { newestFirst?: boolean; limit?: number } = {},
): BatchOutcome[] {
  const filtered = outcomes.filter((outcome) => outcome.mode_breakdown.length > 0);
  const ordered = opts.newestFirst
    ? [...filtered].sort((a, b) => b.batch_start - a.batch_start)
    : filtered;
  return ordered.slice(0, opts.limit ?? ordered.length);
}

function rollupModes(outcomes: BatchOutcome[]): ModeRollup[] {
  const acc = new Map<string, { runs: number; successes: number; prs: number; cost: number }>();
  for (const o of outcomesWithModeEvidence(outcomes)) {
    for (const m of o.mode_breakdown) {
      const cur = acc.get(m.mode) ?? { runs: 0, successes: 0, prs: 0, cost: 0 };
      cur.runs += m.runs;
      cur.successes += m.successes;
      cur.prs += m.prs;
      cur.cost += m.cost_usd;
      acc.set(m.mode, cur);
    }
  }
  return [...acc.entries()].map(([mode, v]) => ({
    mode,
    runs: v.runs,
    successes: v.successes,
    prs: v.prs,
    cost_usd: v.cost,
    success_rate: v.runs > 0 ? v.successes / v.runs : 0,
    efficiency: v.cost > 0 ? v.prs / v.cost : 0,
  }));
}

export function deriveBanditPriorFromOutcomes(
  outcomes: BatchOutcome[],
  opts: { decay?: number; limit?: number } = {},
): BanditPrior | null {
  const decay = opts.decay ?? 0.8;
  const limit = opts.limit ?? outcomes.length;
  const sorted = outcomesWithModeEvidence(outcomes, { newestFirst: true, limit });
  if (sorted.length === 0) return null;

  const modes: Record<string, BanditPriorMode> = {};
  for (let i = 0; i < sorted.length; i++) {
    const weight = Math.pow(decay, i);
    for (const mode of sorted[i].mode_breakdown) {
      const cur = modes[mode.mode] ?? { plays: 0, total_reward: 0 };
      cur.plays += mode.runs * weight;
      // Consume the durable BatchOutcome success proxy so every cross-batch
      // reader learns from the same structured observation contract.
      cur.total_reward += mode.successes * weight;
      modes[mode.mode] = cur;
    }
  }

  return {
    source: 'batch-outcome',
    source_batches: sorted.length,
    decay,
    modes,
  };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/**
 * Turn a set of batch outcomes into prioritized, concrete steering
 * recommendations. PURE and deterministic: no clock, no I/O. Trajectory is
 * computed from the outcomes' own `batch_start` timestamps, so the same input
 * always yields the same report. Degrades gracefully on empty / single-batch
 * input (no false signals from one data point).
 */
export function computeSteeringRecommendations(
  outcomes: BatchOutcome[],
): SteeringReport {
  if (outcomes.length === 0) {
    return {
      batches_analyzed: 0,
      span: null,
      best_mode: null,
      worst_mode: null,
      recommendations: [],
      summary: 'No prior batch outcomes on GitHub — this batch starts without cross-batch steering.',
    };
  }

  // Chronological order for trajectory comparisons.
  const sorted = [...outcomes].sort((a, b) => a.batch_start - b.batch_start);
  const span = { from: sorted[0].batch_start, to: sorted[sorted.length - 1].batch_start };
  const recs: SteeringRecommendation[] = [];

  // --- Mode effectiveness: prefer the mode that actually ships work ----------
  // Only rank modes with enough evidence (>=3 runs) to avoid noise.
  const modes = rollupModes(sorted).filter((m) => m.runs >= 3);
  let bestMode: string | null = null;
  let worstMode: string | null = null;
  if (modes.length >= 2) {
    const ranked = [...modes].sort(
      (a, b) => b.success_rate - a.success_rate || b.efficiency - a.efficiency,
    );
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    bestMode = best.mode;
    worstMode = worst.mode;
    // Only recommend if there's a meaningful gap.
    if (best.success_rate - worst.success_rate >= 0.2) {
      recs.push({
        priority: 20,
        kind: 'mode',
        text: `Mode "${best.mode}" has been more productive than "${worst.mode}" across recent batches (${pct(best.success_rate)} vs ${pct(worst.success_rate)} success). Prefer "${best.mode}" unless guidance dictates otherwise.`,
      });
    }
  }

  // --- Success-rate trajectory ----------------------------------------------
  if (sorted.length >= 2) {
    const mid = Math.floor(sorted.length / 2);
    const firstHalf = sorted.slice(0, mid);
    const secondHalf = sorted.slice(mid);
    const avg = (arr: BatchOutcome[]) =>
      arr.reduce((s, o) => s + o.success_rate, 0) / arr.length;
    const before = avg(firstHalf);
    const after = avg(secondHalf);
    if (after - before <= -0.15) {
      recs.push({
        priority: 10,
        kind: 'trajectory',
        text: `Batch success rate is declining (${pct(before)} → ${pct(after)} across recent batches). Reduce scope per run, prefer well-specified leaf issues, and verify before stopping.`,
      });
    } else if (after - before >= 0.15) {
      recs.push({
        priority: 90,
        kind: 'trajectory',
        text: `Batch success rate is improving (${pct(before)} → ${pct(after)}). Current approach is working — keep the same scope discipline.`,
      });
    }
  }

  // --- Review fail rate ------------------------------------------------------
  const avgReviewFail =
    sorted.reduce((s, o) => s + o.review_fail_rate, 0) / sorted.length;
  if (avgReviewFail >= 0.3) {
    recs.push({
      priority: 30,
      kind: 'review',
      text: `Review fail rate has averaged ${pct(avgReviewFail)} — strengthen the test plan and self-review before opening PRs so review rounds pass first time.`,
    });
  }

  // --- Recurring stop reasons ------------------------------------------------
  // Group free-text stop reasons by a coarse category; if one category recurs in
  // at least half the batches, surface tailored guidance.
  const stopCounts = new Map<string, number>();
  for (const o of sorted) {
    const cat = classifyStopReason(o.stop_reason);
    if (cat) stopCounts.set(cat, (stopCounts.get(cat) ?? 0) + 1);
  }
  const threshold = Math.ceil(sorted.length / 2);
  for (const [cat, count] of stopCounts) {
    if (count < threshold || count < 2) continue;
    recs.push({
      priority: 40,
      kind: 'stop_reason',
      text: stopReasonGuidance(cat, count, sorted.length),
    });
  }

  // --- Recurring cost anomalies ---------------------------------------------
  const batchesWithAnomalies = sorted.filter((o) => o.cost_anomaly_count > 0).length;
  if (batchesWithAnomalies >= 2 && batchesWithAnomalies >= threshold) {
    const total = sorted.reduce((s, o) => s + o.cost_anomaly_count, 0);
    recs.push({
      priority: 50,
      kind: 'cost',
      text: `Cost anomalies recur (${total} flagged across ${batchesWithAnomalies} batches). Watch for runaway runs — split large issues and stop early when work is exhausted.`,
    });
  }

  recs.sort((a, b) => a.priority - b.priority);

  const summary =
    recs.length > 0
      ? `${recs.length} cross-batch steering signal(s) from ${sorted.length} prior batch(es).`
      : `${sorted.length} prior batch(es) analyzed — no strong steering signal; proceed on guidance.`;

  return {
    batches_analyzed: sorted.length,
    span,
    best_mode: bestMode,
    worst_mode: worstMode,
    recommendations: recs,
    summary,
  };
}

/** Coarse category for a free-text stop reason, or null if uninformative. */
function classifyStopReason(reason: string): string | null {
  const r = reason.toLowerCase();
  if (!r || r === 'completed') return null;
  if (r.includes('backlog') || r.includes('exhaust') || r.includes('no more') || r.includes('no open'))
    return 'backlog_exhausted';
  if (r.includes('budget') || r.includes('cost') || r.includes('cap'))
    return 'budget_cap';
  if (r.includes('fail')) return 'failures';
  if (r.includes('halt')) return 'halted';
  return null;
}

function stopReasonGuidance(cat: string, count: number, total: number): string {
  const prefix = `${count}/${total} recent batches stopped for the same reason`;
  switch (cat) {
    case 'backlog_exhausted':
      return `${prefix}: backlog exhausted. The leaf-issue supply is thin — decompose an epic/PRD into concrete issues before stopping, or broaden the guidance.`;
    case 'budget_cap':
      return `${prefix}: budget cap. Scope each run smaller so it completes before the cap, or raise the budget deliberately.`;
    case 'failures':
      return `${prefix}: consecutive failures. Investigate the failure class (hooks vs. agent logic) before picking similar work.`;
    case 'halted':
      return `${prefix}: halted. Check for a stuck choke point (gate, lock, or watchdog) that keeps tripping.`;
    default:
      return `${prefix}.`;
  }
}

/** Render a steering report as human-readable text (CLI / progress-issue display). */
export function formatSteeringReport(report: SteeringReport): string {
  const lines: string[] = [];
  lines.push('=== Cross-Batch Steering ===');
  lines.push('');
  lines.push(report.summary);
  if (report.batches_analyzed === 0) return lines.join('\n');
  if (report.best_mode && report.worst_mode) {
    lines.push('');
    lines.push(`Best mode: ${report.best_mode}   Worst mode: ${report.worst_mode}`);
  }
  if (report.recommendations.length > 0) {
    lines.push('');
    lines.push('Recommendations:');
    report.recommendations.forEach((r, i) => {
      lines.push(`  ${i + 1}. [${r.kind}] ${r.text}`);
    });
  }
  return lines.join('\n');
}

/**
 * Format steering recommendations as a numbered list for prompt injection
 * (mirrors how reflection insights are rendered). Returns '' when there is
 * nothing to steer on, so the prompt's conditional block stays collapsed.
 */
export function steeringPromptText(report: SteeringReport): string {
  if (report.recommendations.length === 0) return '';
  return report.recommendations.map((r, i) => `${i + 1}. ${r.text}`).join('\n');
}
