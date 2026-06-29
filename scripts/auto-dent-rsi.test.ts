import { describe, expect, it, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  buildRsiImprovementProposalSet,
  evaluateRsiProposalOutcome,
  readRsiImprovementProposals,
  writeRsiImprovementProposalsAttachment,
  RsiImprovementProposalSetSchema,
  RSI_IMPROVEMENT_PROPOSALS_ATTACHMENT,
} from './auto-dent-rsi.js';
import type { BatchOutcome } from './batch-outcome.js';
import type { BatchState, RunMetrics } from './auto-dent-run.js';
import { clearCommentCache } from '../src/section-editor.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const mockGh = vi.mocked(spawnSync);

function ghReturns(stdout: string) {
  mockGh.mockReturnValueOnce({ status: 0, stdout, stderr: '', signal: null, pid: 0, output: [null, stdout, ''] } as any);
}

function run(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    run: 1,
    start_epoch: 1,
    duration_seconds: 60,
    exit_code: 0,
    cost_usd: 1,
    tool_calls: 10,
    prs: [],
    issues_filed: [],
    issues_closed: [],
    cases: [],
    stop_requested: false,
    ...overrides,
  };
}

function state(overrides: Partial<BatchState> = {}): BatchState {
  return {
    batch_id: 'batch-rsi',
    batch_start: 1_000,
    guidance: 'improve auto-dent',
    max_runs: 0,
    cooldown: 30,
    budget: '',
    max_failures: 3,
    kaizen_repo: 'Garsson-io/kaizen',
    host_repo: 'Garsson-io/kaizen',
    run: 4,
    prs: [],
    issues_filed: [],
    issues_closed: [],
    cases: [],
    consecutive_failures: 0,
    current_cooldown: 30,
    stop_reason: '',
    last_issue: '',
    last_pr: '',
    last_case: '',
    last_branch: '',
    last_worktree: '',
    run_history: [],
    ...overrides,
  };
}

const degradedSignal = {
  verdict: 'degraded' as const,
  score: 0.82,
  first_half_success_rate: 1,
  second_half_success_rate: 0,
  success_rate_delta: -1,
  trailing_failure_count: 3,
  trailing_empty_success_count: 2,
  early_cost_per_success: 1,
  late_cost_per_success: null,
  cost_per_success_ratio: null,
  duration_slope_seconds_per_run: 75,
  reasons: ['success rate fell from 100% to 0%', '3 trailing failed runs'],
};

function outcome(overrides: Partial<BatchOutcome> = {}): BatchOutcome {
  return {
    schema_version: 1,
    batch_id: 'batch-rsi',
    guidance: 'improve auto-dent',
    batch_start: 1_000,
    batch_end: 2_000,
    wall_seconds: 1_000,
    stop_reason: 'completed',
    totals: {
      runs: 6,
      successful_runs: 3,
      prs: 3,
      issues_closed: 3,
      issues_filed: 1,
      cost_usd: 12,
      duration_seconds: 900,
      lines_deleted: 0,
      issues_pruned: 0,
    },
    success_rate: 0.5,
    avg_cost_per_success: 4,
    overall_efficiency: 0.25,
    review_fail_rate: 0.2,
    cost_anomaly_count: 0,
    mode_diversity: 2,
    trend: null,
    mode_breakdown: [],
    prs: [],
    issues_closed: [],
    issues_filed: [],
    ...overrides,
  };
}

describe('buildRsiImprovementProposalSet', () => {
  it('turns reflection and degradation evidence into bounded proposals with proof requirements', () => {
    const proposalSet = buildRsiImprovementProposalSet(
      state({
        reflection_insights: [
          'Explore mode keeps rediscovering the same manifest candidates without applying them',
        ],
      }),
      outcome({ degradation_signal: degradedSignal }),
      { generatedAt: '2026-06-29T12:00:00.000Z' },
    );

    expect(() => RsiImprovementProposalSetSchema.parse(proposalSet)).not.toThrow();
    expect(proposalSet.proposals.length).toBeGreaterThanOrEqual(2);
    expect(proposalSet.baseline).toMatchObject({
      success_rate: 0.5,
      review_fail_rate: 0.2,
      degradation_verdict: 'degraded',
      degradation_score: 0.82,
    });

    const explore = proposalSet.proposals.find((p) => p.target.path === 'prompts/explore-gaps.md');
    expect(explore).toBeDefined();
    expect(explore!.kind).toBe('prompt_patch');
    expect(explore!.proof_required.policy_refs).toContain('I22');
    expect(explore!.proof_required.policy_refs).toContain('Policy 10');
    expect(explore!.proof_required.commands).toContain('npx vitest run src/e2e/skill-change.test.ts');
    expect(explore!.gepa_feedback?.textual_feedback[0]).toContain('Explore mode');

    const degradation = proposalSet.proposals.find((p) => p.failure_pattern.includes('Long-horizon degradation signal'));
    expect(degradation?.target.path).toBe('prompts/reflect-batch.md');
    expect(degradation?.acceptance.reject_if).toContain('degradation_score increases more than 0.10 or verdict worsens to degraded');
  });

  it('emits an empty set with a diagnostic when there are no actionable signals', () => {
    const proposalSet = buildRsiImprovementProposalSet(
      state({ run_history: [run({ prs: ['pr'] })] }),
      outcome({ degradation_signal: { ...degradedSignal, verdict: 'healthy', score: 0, reasons: [] } }),
      { generatedAt: '2026-06-29T12:00:00.000Z' },
    );

    expect(proposalSet.proposals).toEqual([]);
    expect(proposalSet.diagnostics[0]).toMatch(/No actionable RSI proposal signals/);
  });

  it('uses repeated failure classes as proposal signals', () => {
    const proposalSet = buildRsiImprovementProposalSet(
      state({
        run_history: [
          run({ failure_class: 'timeout', exit_code: 124 }),
          run({ failure_class: 'timeout', exit_code: 124 }),
          run({ failure_class: 'success', prs: ['pr'] }),
        ],
      }),
      outcome(),
      { generatedAt: '2026-06-29T12:00:00.000Z' },
    );

    expect(proposalSet.proposals).toHaveLength(1);
    expect(proposalSet.proposals[0].failure_pattern).toContain('failure class "timeout"');
    expect(proposalSet.proposals[0].target.path).toBe('prompts/reflect-batch.md');
  });
});

describe('evaluateRsiProposalOutcome', () => {
  it('rejects a later outcome when core metrics regress', () => {
    const proposal = buildRsiImprovementProposalSet(
      state({ reflection_insights: ['Review failures are recurring'] }),
      outcome({ degradation_signal: { ...degradedSignal, verdict: 'watch', score: 0.4 } }),
      { generatedAt: '2026-06-29T12:00:00.000Z' },
    ).proposals[0];

    const evaluation = evaluateRsiProposalOutcome(
      proposal,
      outcome({
        batch_id: 'batch-after',
        success_rate: 0.3,
        review_fail_rate: 0.4,
        degradation_signal: degradedSignal,
      }),
    );

    expect(evaluation.verdict).toBe('rejected');
    expect(evaluation.reasons.join('\n')).toContain('success_rate regressed');
    expect(evaluation.reasons.join('\n')).toContain('review_fail_rate worsened');
    expect(evaluation.reasons.join('\n')).toContain('degradation signal worsened');
  });

  it('accepts a later outcome when quality metrics improve', () => {
    const proposal = buildRsiImprovementProposalSet(
      state({ reflection_insights: ['Batch reflection keeps missing lifecycle proof'] }),
      outcome({ degradation_signal: degradedSignal }),
      { generatedAt: '2026-06-29T12:00:00.000Z' },
    ).proposals[0];

    const evaluation = evaluateRsiProposalOutcome(
      proposal,
      outcome({
        batch_id: 'batch-after',
        success_rate: 0.72,
        review_fail_rate: 0.05,
        avg_cost_per_success: 3,
        degradation_signal: { ...degradedSignal, verdict: 'watch', score: 0.2 },
      }),
    );

    expect(evaluation.verdict).toBe('accepted');
    expect(evaluation.reasons.join('\n')).toContain('success_rate improved');
    expect(evaluation.reasons.join('\n')).toContain('review_fail_rate improved');
  });

  it('watches cost regressions without rejecting when quality does not regress', () => {
    const proposal = buildRsiImprovementProposalSet(
      state({ reflection_insights: ['Cost per PR is high'] }),
      outcome(),
      { generatedAt: '2026-06-29T12:00:00.000Z' },
    ).proposals[0];

    const evaluation = evaluateRsiProposalOutcome(
      proposal,
      outcome({
        batch_id: 'batch-after',
        success_rate: 0.52,
        avg_cost_per_success: 8,
      }),
    );

    expect(evaluation.verdict).toBe('watch');
    expect(evaluation.reasons.join('\n')).toContain('avg_cost_per_success increased');
  });
});

describe('RSI proposal attachment helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCommentCache();
  });

  it('writes proposal sets as the rsi-improvement-proposals named attachment', () => {
    ghReturns('');
    ghReturns('https://github.com/Garsson-io/kaizen/issues/1717#issuecomment-1');
    const proposalSet = buildRsiImprovementProposalSet(
      state({ reflection_insights: ['Explore prompt needs manifest follow-through'] }),
      outcome(),
      { generatedAt: '2026-06-29T12:00:00.000Z' },
    );

    const url = writeRsiImprovementProposalsAttachment('1717', 'Garsson-io/kaizen', proposalSet);

    expect(url).toContain('issuecomment');
    const createArgs = (mockGh.mock.calls[1][1] as string[]).join(' ');
    expect(createArgs).toContain(`<!-- kaizen:${RSI_IMPROVEMENT_PROPOSALS_ATTACHMENT} -->`);
    expect(createArgs).toContain('"proposals"');
  });

  it('reads proposal sets back through the schema', () => {
    const proposalSet = buildRsiImprovementProposalSet(
      state({ reflection_insights: ['Reflect batch should turn recurring failures into proof-bound proposals'] }),
      outcome(),
      { generatedAt: '2026-06-29T12:00:00.000Z' },
    );
    const body = `<!-- kaizen:${RSI_IMPROVEMENT_PROPOSALS_ATTACHMENT} -->\n${JSON.stringify(proposalSet, null, 2)}`;
    ghReturns(JSON.stringify({ url: 'https://github.com/Garsson-io/kaizen/issues/1717#issuecomment-1', body }));

    expect(readRsiImprovementProposals('1717', 'Garsson-io/kaizen')).toEqual(proposalSet);
  });
});
