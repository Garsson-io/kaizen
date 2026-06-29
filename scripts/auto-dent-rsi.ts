/**
 * auto-dent-rsi.ts - deterministic RSI improvement proposal contract.
 *
 * This module does not apply prompt or skill patches. It turns existing
 * auto-dent evidence into bounded proposals with behavioral-proof requirements
 * and a later before/after evaluator.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

const RsiCrossRunImprovementSchema = z.object({
  verdict: z.enum(['insufficient_data', 'improving', 'steady', 'degrading']),
  batches_analyzed: z.number(),
  previous_batch_id: z.string().nullable(),
  latest_batch_id: z.string().nullable(),
  success_rate_delta: z.number().nullable(),
  review_fail_rate_delta: z.number().nullable(),
  avg_cost_per_success_delta: z.number().nullable(),
  degradation_score_delta: z.number().nullable(),
  summary: z.string(),
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
  cross_run_improvement: RsiCrossRunImprovementSchema,
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
export type RsiCrossRunImprovement = z.infer<typeof RsiCrossRunImprovementSchema>;
export type RsiImprovementProposal = z.infer<typeof RsiImprovementProposalSchema>;
export type RsiImprovementProposalSet = z.infer<typeof RsiImprovementProposalSetSchema>;
export type RsiProposalEvaluation = z.infer<typeof RsiProposalEvaluationSchema>;

export interface BuildRsiImprovementProposalSetOptions {
  generatedAt?: string;
  maxProposals?: number;
  priorOutcomes?: BatchOutcome[];
}

export interface RsiImprovementProposalWriteResult {
  status: 'written' | 'skipped';
  proposalCount: number;
  crossRunVerdict?: RsiCrossRunImprovement['verdict'];
  url?: string;
  reason?: string;
}

function stableId(parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12);
}

function nonEmptyUnique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function nullableDelta(after: number | null, before: number | null): number | null {
  if (after === null || before === null) return null;
  return after - before;
}

function outcomeSortKey(outcome: BatchOutcome): string {
  return `${String(outcome.batch_start).padStart(16, '0')}:${outcome.batch_id}`;
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

export function computeRsiCrossRunImprovement(outcomes: BatchOutcome[]): RsiCrossRunImprovement {
  const ordered = [...outcomes].sort((a, b) => outcomeSortKey(a).localeCompare(outcomeSortKey(b)));
  if (ordered.length < 2) {
    return RsiCrossRunImprovementSchema.parse({
      verdict: 'insufficient_data',
      batches_analyzed: ordered.length,
      previous_batch_id: null,
      latest_batch_id: ordered[0]?.batch_id ?? null,
      success_rate_delta: null,
      review_fail_rate_delta: null,
      avg_cost_per_success_delta: null,
      degradation_score_delta: null,
      summary: 'Need at least two batch outcomes before cross-run RSI improvement can be measured.',
    });
  }

  const previous = ordered[ordered.length - 2];
  const latest = ordered[ordered.length - 1];
  const previousSnapshot = metricSnapshotFromOutcome(previous);
  const latestSnapshot = metricSnapshotFromOutcome(latest);
  const successRateDelta = latestSnapshot.success_rate - previousSnapshot.success_rate;
  const reviewFailRateDelta = latestSnapshot.review_fail_rate - previousSnapshot.review_fail_rate;
  const costDelta = nullableDelta(latestSnapshot.avg_cost_per_success, previousSnapshot.avg_cost_per_success);
  const degradationScoreDelta = nullableDelta(latestSnapshot.degradation_score, previousSnapshot.degradation_score);

  let score = 0;
  if (successRateDelta >= 0.05) score += 1;
  if (successRateDelta <= -0.05) score -= 1;
  if (reviewFailRateDelta <= -0.05) score += 1;
  if (reviewFailRateDelta >= 0.05) score -= 1;
  if (costDelta !== null && costDelta <= -0.5) score += 1;
  if (costDelta !== null && costDelta >= 0.5) score -= 1;
  if (degradationScoreDelta !== null && degradationScoreDelta <= -0.1) score += 1;
  if (degradationScoreDelta !== null && degradationScoreDelta >= 0.1) score -= 1;

  const verdict = score > 0 ? 'improving' : score < 0 ? 'degrading' : 'steady';
  const summary = [
    `${latest.batch_id} vs ${previous.batch_id}`,
    `success_rate ${successRateDelta >= 0 ? '+' : ''}${successRateDelta.toFixed(2)}`,
    `review_fail_rate ${reviewFailRateDelta >= 0 ? '+' : ''}${reviewFailRateDelta.toFixed(2)}`,
    costDelta === null ? 'avg_cost_per_success n/a' : `avg_cost_per_success ${costDelta >= 0 ? '+' : ''}${costDelta.toFixed(2)}`,
    degradationScoreDelta === null ? 'degradation_score n/a' : `degradation_score ${degradationScoreDelta >= 0 ? '+' : ''}${degradationScoreDelta.toFixed(2)}`,
  ].join('; ');

  return RsiCrossRunImprovementSchema.parse({
    verdict,
    batches_analyzed: ordered.length,
    previous_batch_id: previous.batch_id,
    latest_batch_id: latest.batch_id,
    success_rate_delta: successRateDelta,
    review_fail_rate_delta: reviewFailRateDelta,
    avg_cost_per_success_delta: costDelta,
    degradation_score_delta: degradationScoreDelta,
    summary,
  });
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

function collectSignals(
  state: BatchState,
  outcome: BatchOutcome,
  crossRunImprovement: RsiCrossRunImprovement,
): string[] {
  const signals: string[] = [];
  signals.push(...nonEmptyUnique(state.reflection_insights ?? []));
  signals.push(...repeatedFailureSignals(state.run_history ?? []));
  const degradation = outcome.degradation_signal;
  if (degradation?.verdict === 'watch' || degradation?.verdict === 'degraded') {
    signals.push(
      `Long-horizon degradation signal: ${degradation.verdict} score ${degradation.score.toFixed(2)} - ${degradation.reasons.join('; ')}`,
    );
  }
  if (crossRunImprovement.verdict === 'degrading') {
    signals.push(`Cross-run RSI improvement metric degraded: ${crossRunImprovement.summary}`);
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

function proposalForSignals(
  signals: string[],
  baseline: RsiMetricSnapshot,
  batchId: string,
): RsiImprovementProposal {
  const target = targetForSignal(signals[0]);
  const failurePattern = signals.join(' | ');
  const id = `rsi-${stableId([batchId, target.path, ...signals])}`;
  const kind = proposalKindForTarget(target);
  const promptTarget = target.kind === 'prompt' ? target : undefined;

  return {
    id,
    status: 'proposed',
    kind,
    target,
    source_signals: signals,
    failure_pattern: failurePattern,
    proposed_change:
      `Patch ${target.path} so future auto-dent runs explicitly handle these observed patterns: ${failurePattern}`,
    proof_required: proofRequirementForTarget(target),
    acceptance: acceptanceCriteria(baseline),
    ...(promptTarget
      ? { gepa_feedback: { prompt_target: promptTarget, textual_feedback: signals } }
      : {}),
  };
}

function proposalsForSignals(
  signals: string[],
  baseline: RsiMetricSnapshot,
  batchId: string,
  maxProposals: number,
): RsiImprovementProposal[] {
  const byTargetPath = new Map<string, string[]>();
  for (const signal of signals) {
    const target = targetForSignal(signal);
    const existing = byTargetPath.get(target.path);
    if (existing) existing.push(signal);
    else byTargetPath.set(target.path, [signal]);
  }

  return [...byTargetPath.values()]
    .slice(0, Math.max(0, maxProposals))
    .map((targetSignals) => proposalForSignals(targetSignals, baseline, batchId));
}

export function buildRsiImprovementProposalSet(
  state: BatchState,
  outcome: BatchOutcome,
  opts: BuildRsiImprovementProposalSetOptions = {},
): RsiImprovementProposalSet {
  const baseline = metricSnapshotFromOutcome(outcome);
  const crossRunImprovement = computeRsiCrossRunImprovement([...(opts.priorOutcomes ?? []), outcome]);
  const signals = collectSignals(state, outcome, crossRunImprovement);
  const maxProposals = opts.maxProposals ?? 3;
  const proposals = proposalsForSignals(signals, baseline, outcome.batch_id, maxProposals);
  const diagnostics = proposals.length === 0
    ? ['No actionable RSI proposal signals: no reflection insights, non-healthy degradation signal, or repeated failure class.']
    : [
      `${proposals.length} proposal(s) generated from ${signals.length} signal(s).`,
      `Cross-run RSI metric: ${crossRunImprovement.verdict} (${crossRunImprovement.summary})`,
    ];

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
    cross_run_improvement: crossRunImprovement,
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

export function writeRsiImprovementProposalsForBatch(
  issueNumber: string,
  repo: string,
  state: BatchState,
  outcome: BatchOutcome,
  deps: {
    write?: typeof writeAttachment;
    generatedAt?: string;
    priorOutcomes?: BatchOutcome[];
  } = {},
): RsiImprovementProposalWriteResult {
  try {
    const proposalSet = buildRsiImprovementProposalSet(state, outcome, {
      generatedAt: deps.generatedAt,
      priorOutcomes: deps.priorOutcomes,
    });
    const url = writeRsiImprovementProposalsAttachment(
      issueNumber,
      repo,
      proposalSet,
      deps.write ?? writeAttachment,
    );
    return {
      status: 'written',
      proposalCount: proposalSet.proposals.length,
      crossRunVerdict: proposalSet.cross_run_improvement.verdict,
      url,
    };
  } catch (err) {
    return {
      status: 'skipped',
      proposalCount: 0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
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

export function formatRsiProposalSetSummary(proposalSet: RsiImprovementProposalSet): string {
  const lines = [
    `RSI proposal set for ${proposalSet.batch_id}`,
    `Generated: ${proposalSet.generated_at}`,
    `Cross-run improvement: ${proposalSet.cross_run_improvement.verdict} - ${proposalSet.cross_run_improvement.summary}`,
    `Proposals: ${proposalSet.proposals.length}`,
  ];

  for (const proposal of proposalSet.proposals) {
    lines.push(
      `- ${proposal.id}: ${proposal.kind} -> ${proposal.target.path}`,
      `  signals: ${proposal.source_signals.join(' | ')}`,
      `  proof: ${proposal.proof_required.behavioral_proof}`,
    );
  }

  if (proposalSet.proposals.length === 0) {
    lines.push(`Diagnostics: ${proposalSet.diagnostics.join(' | ')}`);
  }

  return lines.join('\n');
}

function parseCliArgs(args: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      parsed.set(arg.slice(2), 'true');
      continue;
    }
    parsed.set(arg.slice(2), next);
    i += 1;
  }
  return parsed;
}

function loadProposalSet(args: Map<string, string>): RsiImprovementProposalSet {
  const file = args.get('file');
  if (file) {
    return RsiImprovementProposalSetSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  }
  const issue = args.get('issue');
  const repo = args.get('repo');
  if (!issue || !repo) {
    throw new Error('summary requires --file or both --issue and --repo');
  }
  const proposalSet = readRsiImprovementProposals(issue, repo);
  if (!proposalSet) {
    throw new Error(`No ${RSI_IMPROVEMENT_PROPOSALS_ATTACHMENT} attachment found on ${repo}#${issue}`);
  }
  return proposalSet;
}

function runCli(argv: string[]): void {
  const [command, ...rest] = argv;
  const args = parseCliArgs(rest);

  if (command === 'summary') {
    console.log(formatRsiProposalSetSummary(loadProposalSet(args)));
    return;
  }

  if (command === 'evaluate') {
    const proposalSet = loadProposalSet(args);
    const afterOutcomeFile = args.get('after-outcome-file');
    if (!afterOutcomeFile) {
      throw new Error('evaluate requires --after-outcome-file');
    }
    const proposalId = args.get('proposal-id') ?? proposalSet.proposals[0]?.id;
    const proposal = proposalSet.proposals.find((candidate) => candidate.id === proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: ${proposalId ?? '(none)'}`);
    }
    const afterOutcome = JSON.parse(readFileSync(afterOutcomeFile, 'utf8')) as BatchOutcome;
    console.log(JSON.stringify(evaluateRsiProposalOutcome(proposal, afterOutcome), null, 2));
    return;
  }

  throw new Error([
    'Usage:',
    '  npx tsx scripts/auto-dent-rsi.ts summary --issue <N> --repo <owner/repo>',
    '  npx tsx scripts/auto-dent-rsi.ts summary --file <proposal-set.json>',
    '  npx tsx scripts/auto-dent-rsi.ts evaluate --file <proposal-set.json> --after-outcome-file <batch-outcome.json> [--proposal-id <id>]',
  ].join('\n'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
