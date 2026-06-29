/**
 * auto-dent-rsi.ts - deterministic RSI improvement proposal contract.
 *
 * This module does not apply prompt or skill patches. It turns existing
 * auto-dent evidence into bounded proposals with behavioral-proof requirements
 * and a later before/after evaluator.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readAttachment, writeAttachment } from '../src/section-editor.js';
import type { BatchOutcome } from './batch-outcome.js';
import type { BatchState, RunMetrics } from './auto-dent-run.js';

export const RSI_IMPROVEMENT_PROPOSALS_ATTACHMENT = 'rsi-improvement-proposals';
export const RSI_IMPROVEMENT_SCHEMA_VERSION = 1;

const DegradationVerdictSchema = z.enum(['insufficient_data', 'healthy', 'watch', 'degraded']);

const RsiMetricSnapshotSchema = z.object({
  success_rate: z.number(),
  review_fail_rate: z.number(),
  avg_cost_per_success: z.number().nullable(),
  degradation_verdict: DegradationVerdictSchema.nullable(),
  degradation_score: z.number().nullable(),
  runs: z.number(),
  prs: z.number(),
  issues_closed: z.number(),
  cost_usd: z.number(),
});

const RsiTargetSchema = z.object({
  kind: z.enum(['prompt', 'skill', 'process']),
  id: z.string(),
  path: z.string(),
});

const RsiProofRequirementSchema = z.object({
  policy_refs: z.array(z.string()),
  behavioral_proof: z.string(),
  commands: z.array(z.string()),
  evidence: z.array(z.string()),
});

const RsiAcceptanceCriteriaSchema = z.object({
  baseline: RsiMetricSnapshotSchema,
  success_rate_regression_tolerance: z.number(),
  review_fail_rate_regression_tolerance: z.number(),
  degradation_score_regression_tolerance: z.number(),
  cost_per_success_regression_ratio: z.number(),
  reject_if: z.array(z.string()),
});

export const RsiImprovementProposalSchema = z.object({
  id: z.string(),
  status: z.literal('proposed'),
  kind: z.enum(['prompt_patch', 'skill_patch', 'process_patch']),
  target: RsiTargetSchema,
  source_signals: z.array(z.string()).min(1),
  failure_pattern: z.string(),
  proposed_change: z.string(),
  proof_required: RsiProofRequirementSchema,
  acceptance: RsiAcceptanceCriteriaSchema,
  gepa_feedback: z
    .object({
      prompt_target: RsiTargetSchema.optional(),
      textual_feedback: z.array(z.string()),
    })
    .optional(),
});

export const RsiImprovementProposalSetSchema = z.object({
  schema_version: z.literal(RSI_IMPROVEMENT_SCHEMA_VERSION),
  batch_id: z.string(),
  generated_at: z.string(),
  source: z.object({
    outcome_batch_id: z.string(),
    signals_analyzed: z.number(),
    run_count: z.number(),
  }),
  baseline: RsiMetricSnapshotSchema,
  proposals: z.array(RsiImprovementProposalSchema),
  diagnostics: z.array(z.string()),
});

export const RsiProposalEvaluationSchema = z.object({
  proposal_id: z.string(),
  verdict: z.enum(['accepted', 'watch', 'rejected']),
  reasons: z.array(z.string()),
  before: RsiMetricSnapshotSchema,
  after: RsiMetricSnapshotSchema,
});

export type RsiMetricSnapshot = z.infer<typeof RsiMetricSnapshotSchema>;
export type RsiImprovementProposal = z.infer<typeof RsiImprovementProposalSchema>;
export type RsiImprovementProposalSet = z.infer<typeof RsiImprovementProposalSetSchema>;
export type RsiProposalEvaluation = z.infer<typeof RsiProposalEvaluationSchema>;

export interface BuildRsiImprovementProposalSetOptions {
  generatedAt?: string;
  maxProposals?: number;
}

function stableId(parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12);
}

function nonEmptyUnique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

export function metricSnapshotFromOutcome(outcome: BatchOutcome): RsiMetricSnapshot {
  return {
    success_rate: outcome.success_rate,
    review_fail_rate: outcome.review_fail_rate,
    avg_cost_per_success: outcome.avg_cost_per_success,
    degradation_verdict: outcome.degradation_signal?.verdict ?? null,
    degradation_score: outcome.degradation_signal?.score ?? null,
    runs: outcome.totals.runs,
    prs: outcome.totals.prs,
    issues_closed: outcome.totals.issues_closed,
    cost_usd: outcome.totals.cost_usd,
  };
}

function repeatedFailureSignals(history: RunMetrics[]): string[] {
  const counts = new Map<string, number>();
  for (const run of history) {
    const failureClass = run.failure_class;
    if (!failureClass || failureClass === 'success' || failureClass === 'empty_success' || failureClass === 'no_op') {
      continue;
    }
    counts.set(failureClass, (counts.get(failureClass) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([failureClass, count]) => `${count} runs ended with failure class "${failureClass}"`);
}

function collectSignals(state: BatchState, outcome: BatchOutcome): string[] {
  const signals: string[] = [];
  signals.push(...nonEmptyUnique(state.reflection_insights ?? []));
  signals.push(...repeatedFailureSignals(state.run_history ?? []));
  const degradation = outcome.degradation_signal;
  if (degradation?.verdict === 'watch' || degradation?.verdict === 'degraded') {
    signals.push(
      `Long-horizon degradation signal: ${degradation.verdict} score ${degradation.score.toFixed(2)} - ${degradation.reasons.join('; ')}`,
    );
  }
  return nonEmptyUnique(signals);
}

function targetForSignal(signal: string): z.infer<typeof RsiTargetSchema> {
  const text = signal.toLowerCase();
  if (/\b(explore|manifest|scout|ecosystem|candidate-task)\b/.test(text)) {
    return { kind: 'prompt', id: 'explore-gaps', path: 'prompts/explore-gaps.md' };
  }
  if (/\b(review|test plan|behavioral proof|proof)\b/.test(text)) {
    return { kind: 'prompt', id: 'review-test-plan', path: 'prompts/review-test-plan.md' };
  }
  if (/\b(reflect|reflection|meta-kaizen|degradation|consecutive|failure|cost|timeout)\b/.test(text)) {
    return { kind: 'prompt', id: 'reflect-batch', path: 'prompts/reflect-batch.md' };
  }
  return { kind: 'process', id: 'auto-dent-runner', path: 'scripts/auto-dent-run.ts' };
}

function proposalKindForTarget(target: z.infer<typeof RsiTargetSchema>): RsiImprovementProposal['kind'] {
  if (target.kind === 'prompt') return 'prompt_patch';
  if (target.kind === 'skill') return 'skill_patch';
  return 'process_patch';
}

function proofRequirementForTarget(target: z.infer<typeof RsiTargetSchema>): RsiImprovementProposal['proof_required'] {
  const commands = ['npx vitest run scripts/auto-dent-rsi.test.ts', 'npm run typecheck'];
  const evidence = ['Before/after metric snapshot from batch-outcome', 'Focused proposal/evaluation fixture output'];
  const policyRefs = ['I22'];

  if (target.kind === 'prompt' || target.kind === 'skill') {
    commands.push('npx vitest run src/e2e/skill-change.test.ts');
    evidence.push('Behavioral proof for the prompt/skill change, including a synthetic case or before/after agent trace');
    policyRefs.push('Policy 10');
  }

  return {
    policy_refs: [...new Set(policyRefs)],
    behavioral_proof:
      target.kind === 'process'
        ? 'Show the process patch changes an auto-dent fixture outcome without regressing the stored acceptance metrics.'
        : 'Show the prompt/skill patch changes the targeted agent behavior with a synthetic case and before/after evidence.',
    commands,
    evidence,
  };
}

function acceptanceCriteria(baseline: RsiMetricSnapshot): RsiImprovementProposal['acceptance'] {
  return {
    baseline,
    success_rate_regression_tolerance: 0.05,
    review_fail_rate_regression_tolerance: 0.05,
    degradation_score_regression_tolerance: 0.1,
    cost_per_success_regression_ratio: 1.25,
    reject_if: [
      'success_rate drops more than 0.05',
      'review_fail_rate increases more than 0.05',
      'degradation_score increases more than 0.10 or verdict worsens to degraded',
      'avg_cost_per_success increases more than 25% without a compensating success-rate improvement',
    ],
  };
}

function proposalForSignal(
  signal: string,
  baseline: RsiMetricSnapshot,
  batchId: string,
): RsiImprovementProposal {
  const target = targetForSignal(signal);
  const id = `rsi-${stableId([batchId, target.path, signal])}`;
  const kind = proposalKindForTarget(target);
  const promptTarget = target.kind === 'prompt' ? target : undefined;

  return {
    id,
    status: 'proposed',
    kind,
    target,
    source_signals: [signal],
    failure_pattern: signal,
    proposed_change:
      `Patch ${target.path} so future auto-dent runs explicitly handle this observed pattern: ${signal}`,
    proof_required: proofRequirementForTarget(target),
    acceptance: acceptanceCriteria(baseline),
    ...(promptTarget
      ? { gepa_feedback: { prompt_target: promptTarget, textual_feedback: [signal] } }
      : {}),
  };
}

export function buildRsiImprovementProposalSet(
  state: BatchState,
  outcome: BatchOutcome,
  opts: BuildRsiImprovementProposalSetOptions = {},
): RsiImprovementProposalSet {
  const baseline = metricSnapshotFromOutcome(outcome);
  const signals = collectSignals(state, outcome);
  const maxProposals = opts.maxProposals ?? 3;
  const proposals = signals
    .slice(0, Math.max(0, maxProposals))
    .map((signal) => proposalForSignal(signal, baseline, outcome.batch_id));
  const diagnostics = proposals.length === 0
    ? ['No actionable RSI proposal signals: no reflection insights, non-healthy degradation signal, or repeated failure class.']
    : [`${proposals.length} proposal(s) generated from ${signals.length} signal(s).`];

  return RsiImprovementProposalSetSchema.parse({
    schema_version: RSI_IMPROVEMENT_SCHEMA_VERSION,
    batch_id: state.batch_id,
    generated_at: opts.generatedAt ?? new Date().toISOString(),
    source: {
      outcome_batch_id: outcome.batch_id,
      signals_analyzed: signals.length,
      run_count: outcome.totals.runs,
    },
    baseline,
    proposals,
    diagnostics,
  });
}

function degradationRank(verdict: RsiMetricSnapshot['degradation_verdict']): number {
  switch (verdict) {
    case 'degraded':
      return 3;
    case 'watch':
      return 2;
    case 'healthy':
      return 1;
    case 'insufficient_data':
      return 0;
    default:
      return 0;
  }
}

export function evaluateRsiProposalOutcome(
  proposal: RsiImprovementProposal,
  afterOutcome: BatchOutcome,
): RsiProposalEvaluation {
  const before = proposal.acceptance.baseline;
  const after = metricSnapshotFromOutcome(afterOutcome);
  const rejectReasons: string[] = [];
  const watchReasons: string[] = [];
  const acceptReasons: string[] = [];

  if (before.success_rate - after.success_rate > proposal.acceptance.success_rate_regression_tolerance) {
    rejectReasons.push(`success_rate regressed from ${before.success_rate.toFixed(2)} to ${after.success_rate.toFixed(2)}`);
  } else if (after.success_rate - before.success_rate >= proposal.acceptance.success_rate_regression_tolerance) {
    acceptReasons.push(`success_rate improved from ${before.success_rate.toFixed(2)} to ${after.success_rate.toFixed(2)}`);
  }

  if (after.review_fail_rate - before.review_fail_rate > proposal.acceptance.review_fail_rate_regression_tolerance) {
    rejectReasons.push(`review_fail_rate worsened from ${before.review_fail_rate.toFixed(2)} to ${after.review_fail_rate.toFixed(2)}`);
  } else if (before.review_fail_rate - after.review_fail_rate >= proposal.acceptance.review_fail_rate_regression_tolerance) {
    acceptReasons.push(`review_fail_rate improved from ${before.review_fail_rate.toFixed(2)} to ${after.review_fail_rate.toFixed(2)}`);
  }

  const beforeDegradationScore = before.degradation_score ?? 0;
  const afterDegradationScore = after.degradation_score ?? 0;
  if (
    degradationRank(after.degradation_verdict) > degradationRank(before.degradation_verdict) ||
    afterDegradationScore - beforeDegradationScore > proposal.acceptance.degradation_score_regression_tolerance
  ) {
    rejectReasons.push('degradation signal worsened');
  } else if (beforeDegradationScore - afterDegradationScore >= proposal.acceptance.degradation_score_regression_tolerance) {
    acceptReasons.push(`degradation_score improved from ${beforeDegradationScore.toFixed(2)} to ${afterDegradationScore.toFixed(2)}`);
  }

  if (before.avg_cost_per_success !== null && after.avg_cost_per_success !== null && before.avg_cost_per_success > 0) {
    const costRatio = after.avg_cost_per_success / before.avg_cost_per_success;
    const compensatingSuccessGain = after.success_rate - before.success_rate >= 0.1;
    if (costRatio > proposal.acceptance.cost_per_success_regression_ratio && !compensatingSuccessGain) {
      watchReasons.push(`avg_cost_per_success increased ${costRatio.toFixed(2)}x without compensating success-rate improvement`);
    } else if (costRatio <= 0.85) {
      acceptReasons.push(`avg_cost_per_success improved ${costRatio.toFixed(2)}x`);
    }
  }

  const verdict = rejectReasons.length > 0 ? 'rejected' : watchReasons.length > 0 || acceptReasons.length === 0 ? 'watch' : 'accepted';
  const reasons = rejectReasons.length > 0
    ? rejectReasons
    : watchReasons.length > 0
      ? watchReasons
      : acceptReasons;

  return RsiProposalEvaluationSchema.parse({
    proposal_id: proposal.id,
    verdict,
    reasons,
    before,
    after,
  });
}

export function writeRsiImprovementProposalsAttachment(
  issueNumber: string,
  repo: string,
  proposalSet: RsiImprovementProposalSet,
  write: typeof writeAttachment = writeAttachment,
): string {
  return write(
    { kind: 'issue', number: issueNumber, repo },
    RSI_IMPROVEMENT_PROPOSALS_ATTACHMENT,
    JSON.stringify(proposalSet, null, 2),
  );
}

export function readRsiImprovementProposals(
  issueNumber: string,
  repo: string,
): RsiImprovementProposalSet | null {
  const attachment = readAttachment(
    { kind: 'issue', number: issueNumber, repo },
    RSI_IMPROVEMENT_PROPOSALS_ATTACHMENT,
  );
  if (!attachment) return null;
  return RsiImprovementProposalSetSchema.parse(JSON.parse(attachment.content));
}
