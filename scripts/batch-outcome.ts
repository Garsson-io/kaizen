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
import type { BatchState } from './auto-dent-run.js';
import type { BatchScore } from './auto-dent-score.js';

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
      issues_closed: score.total_issues_closed,
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
