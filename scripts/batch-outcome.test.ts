import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  buildBatchOutcome,
  writeBatchOutcomeAttachment,
  readBatchOutcome,
  BatchOutcomeSchema,
  BATCH_OUTCOME_ATTACHMENT,
  BATCH_OUTCOME_SCHEMA_VERSION,
} from './batch-outcome.js';
import { clearCommentCache } from '../src/section-editor.js';
import type { BatchState } from './auto-dent-run.js';
import type { BatchScore } from './auto-dent-score.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const mockGh = vi.mocked(spawnSync);
function ghReturns(stdout: string) {
  mockGh.mockReturnValueOnce({ status: 0, stdout, stderr: '', signal: null, pid: 0, output: [null, stdout, ''] } as any);
}

// Minimal but realistic fixtures ------------------------------------------------

function makeState(overrides: Partial<BatchState> = {}): BatchState {
  return {
    batch_id: 'sticky-lark',
    batch_start: 1_000,
    guidance: 'bring half-written features to a good place',
    max_runs: 0,
    cooldown: 30,
    budget: '',
    max_failures: 3,
    kaizen_repo: 'Garsson-io/kaizen',
    host_repo: 'Garsson-io/kaizen',
    run: 3,
    prs: ['https://github.com/Garsson-io/kaizen/pull/1108'],
    issues_filed: ['#1108'],
    issues_closed: ['#940'],
    cases: [],
    consecutive_failures: 0,
    current_cooldown: 30,
    stop_reason: '',
    last_issue: '',
    last_pr: '',
    last_case: '',
    last_branch: '',
    last_worktree: '',
    ...overrides,
  };
}

function makeScore(overrides: Partial<BatchScore> = {}): BatchScore {
  return {
    total_runs: 3,
    successful_runs: 2,
    success_rate: 2 / 3,
    total_cost_usd: 4.5,
    total_prs: 1,
    total_issues_closed: 1,
    total_duration_seconds: 600,
    total_lines_deleted: 10,
    total_issues_pruned: 0,
    avg_cost_per_success: 2.25,
    avg_duration_seconds: 200,
    overall_efficiency: 1 / 4.5,
    runs: [],
    mode_breakdown: [
      { mode: 'exploit', runs: 2, successes: 2, success_rate: 1, cost_usd: 3, prs: 1, avg_cost: 1.5, efficiency: 0.33, lines_deleted: 10, issues_pruned: 0 },
    ],
    cost_anomaly_count: 0,
    mode_diversity: 0,
    trend: null,
    review_fail_count: 0,
    review_fail_rate: 0,
    review_total_cost_usd: 0,
    ...overrides,
  };
}

describe('buildBatchOutcome — pure derivation', () => {
  it('maps state + score into a schema-valid outcome', () => {
    const outcome = buildBatchOutcome(makeState(), makeScore(), 1_600);
    // Must parse against the schema readers use.
    expect(() => BatchOutcomeSchema.parse(outcome)).not.toThrow();
    expect(outcome.schema_version).toBe(BATCH_OUTCOME_SCHEMA_VERSION);
    expect(outcome.batch_id).toBe('sticky-lark');
    expect(outcome.wall_seconds).toBe(600); // 1600 - 1000
    expect(outcome.totals.prs).toBe(1);
    expect(outcome.totals.issues_filed).toBe(1);
    expect(outcome.totals.cost_usd).toBeCloseTo(4.5);
    expect(outcome.mode_breakdown[0].mode).toBe('exploit');
    expect(outcome.prs).toEqual(['https://github.com/Garsson-io/kaizen/pull/1108']);
  });

  it('defaults stop_reason to "completed" when blank', () => {
    expect(buildBatchOutcome(makeState({ stop_reason: '' }), makeScore(), 1_600).stop_reason).toBe('completed');
  });

  it('preserves an abnormal stop_reason (budget exhausted)', () => {
    const outcome = buildBatchOutcome(makeState({ stop_reason: 'budget_exhausted' }), makeScore(), 1_600);
    expect(outcome.stop_reason).toBe('budget_exhausted');
  });

  it('normalizes non-finite derived numbers so the result is schema-valid and JSON-clean', () => {
    // No successes: avg_cost_per_success = NaN, overall_efficiency = Infinity upstream.
    const score = makeScore({ successful_runs: 0, avg_cost_per_success: NaN, overall_efficiency: Infinity, total_cost_usd: NaN });
    const outcome = buildBatchOutcome(makeState({ stop_reason: 'failed' }), score, 1_600);
    expect(() => BatchOutcomeSchema.parse(outcome)).not.toThrow();
    expect(outcome.avg_cost_per_success).toBeNull();
    expect(outcome.overall_efficiency).toBe(0);
    expect(outcome.totals.cost_usd).toBe(0);
    // And it survives a JSON roundtrip (no NaN/Infinity tokens).
    expect(JSON.parse(JSON.stringify(outcome))).toEqual(outcome);
  });

  it('handles an empty batch (no runs, no PRs)', () => {
    const outcome = buildBatchOutcome(
      makeState({ prs: [], issues_filed: [], issues_closed: [], stop_reason: 'no_work' }),
      makeScore({ total_runs: 0, successful_runs: 0, total_prs: 0, mode_breakdown: [], success_rate: 0 }),
      1_001,
    );
    expect(() => BatchOutcomeSchema.parse(outcome)).not.toThrow();
    expect(outcome.totals.runs).toBe(0);
    expect(outcome.wall_seconds).toBe(1);
  });
});

describe('BatchOutcomeSchema — drift guard', () => {
  it('rejects a malformed payload (wrong schema_version)', () => {
    const good = buildBatchOutcome(makeState(), makeScore(), 1_600);
    expect(() => BatchOutcomeSchema.parse({ ...good, schema_version: 99 })).toThrow();
  });

  it('rejects a payload missing required totals', () => {
    const good: any = buildBatchOutcome(makeState(), makeScore(), 1_600);
    delete good.totals;
    expect(() => BatchOutcomeSchema.parse(good)).toThrow();
  });
});

describe('write/read attachment wrappers — gh-backed', () => {
  beforeEach(() => { vi.clearAllMocks(); clearCommentCache(); });

  it('writes the outcome as the batch-outcome named attachment', () => {
    ghReturns(''); // fetchComments: empty
    ghReturns('https://github.com/Garsson-io/kaizen/issues/1099#issuecomment-789'); // createComment
    const outcome = buildBatchOutcome(makeState(), makeScore(), 1_600);
    const url = writeBatchOutcomeAttachment('1099', 'Garsson-io/kaizen', outcome);
    expect(url).toContain('issuecomment');
    // The created comment body carries the kaizen marker + serialized JSON.
    const createArgs = (mockGh.mock.calls[1][1] as string[]).join(' ');
    expect(createArgs).toContain(`<!-- kaizen:${BATCH_OUTCOME_ATTACHMENT} -->`);
    expect(createArgs).toContain('"batch_id"');
  });

  it('reads a written outcome back and validates it (roundtrip)', () => {
    const outcome = buildBatchOutcome(makeState(), makeScore(), 1_600);
    const body = `<!-- kaizen:${BATCH_OUTCOME_ATTACHMENT} -->\n${JSON.stringify(outcome, null, 2)}`;
    ghReturns(JSON.stringify({ url: 'https://...#issuecomment-456', body }));
    const read = readBatchOutcome('1099', 'Garsson-io/kaizen');
    expect(read).toEqual(outcome);
  });

  it('returns null when no batch-outcome attachment exists', () => {
    ghReturns(JSON.stringify({ url: 'https://...#issuecomment-1', body: 'Just the markdown table' }));
    expect(readBatchOutcome('1099', 'Garsson-io/kaizen')).toBeNull();
  });

  it('throws on a malformed stored attachment (drift is a bug, not a silent miss)', () => {
    const body = `<!-- kaizen:${BATCH_OUTCOME_ATTACHMENT} -->\n{"schema_version": 99}`;
    ghReturns(JSON.stringify({ url: 'https://...#issuecomment-456', body }));
    expect(() => readBatchOutcome('1099', 'Garsson-io/kaizen')).toThrow();
  });
});
