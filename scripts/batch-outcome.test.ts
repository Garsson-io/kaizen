import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  buildBatchOutcome,
  writeBatchOutcomeAttachment,
  readBatchOutcome,
  readBatchOutcomesFromGithub,
  computeSteeringRecommendations,
  formatSteeringReport,
  steeringPromptText,
  BatchOutcomeSchema,
  BATCH_OUTCOME_ATTACHMENT,
  BATCH_OUTCOME_SCHEMA_VERSION,
} from './batch-outcome.js';
import type { BatchOutcome } from './batch-outcome.js';
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
    expect(outcome.mode_breakdown[0].efficiency).toBeCloseTo(0.33);
    // Durable record carries measurements Phase 2 trend analysis needs.
    expect(outcome.totals.duration_seconds).toBe(600);
    expect(outcome.totals.lines_deleted).toBe(10);
    expect(outcome.cost_anomaly_count).toBe(0);
    expect(outcome.trend).toBeNull();
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
    const score = makeScore({ successful_runs: 0, success_rate: 0, avg_cost_per_success: NaN, overall_efficiency: Infinity, total_cost_usd: NaN });
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

// --- Phase 2 (#940): read-back + steering analysis --------------------------

/** Build a steering-relevant outcome fixture. Only fields the analysis reads matter. */
function makeOutcome(overrides: Partial<BatchOutcome> = {}): BatchOutcome {
  const base: BatchOutcome = {
    schema_version: BATCH_OUTCOME_SCHEMA_VERSION,
    batch_id: 'batch-a',
    guidance: 'g',
    batch_start: 1_000,
    batch_end: 2_000,
    wall_seconds: 1_000,
    stop_reason: 'completed',
    totals: {
      runs: 4, successful_runs: 3, prs: 3, issues_closed: 3, issues_filed: 0,
      cost_usd: 10, duration_seconds: 1000, lines_deleted: 0, issues_pruned: 0,
    },
    success_rate: 0.75,
    avg_cost_per_success: 3.3,
    overall_efficiency: 0.3,
    review_fail_rate: 0,
    cost_anomaly_count: 0,
    mode_diversity: 1,
    trend: null,
    mode_breakdown: [],
    prs: [],
    issues_closed: [],
    issues_filed: [],
  };
  return { ...base, ...overrides };
}

const mode = (mode: string, runs: number, successes: number, prs: number, cost: number) => ({
  mode, runs, successes, success_rate: runs ? successes / runs : 0,
  cost_usd: cost, prs, avg_cost: runs ? cost / runs : 0,
  efficiency: cost ? prs / cost : 0, lines_deleted: 0, issues_pruned: 0,
});

describe('computeSteeringRecommendations — pure analysis', () => {
  it('returns a cold-start report for no outcomes', () => {
    const r = computeSteeringRecommendations([]);
    expect(r.batches_analyzed).toBe(0);
    expect(r.span).toBeNull();
    expect(r.recommendations).toEqual([]);
    expect(r.summary).toMatch(/without cross-batch steering/i);
  });

  it('ranks modes and recommends the more productive one when the gap is meaningful', () => {
    // exploit: 100% success across batches; explore: 0%.
    const a = makeOutcome({ batch_id: 'a', batch_start: 1, mode_breakdown: [mode('exploit', 3, 3, 3, 9)] });
    const b = makeOutcome({ batch_id: 'b', batch_start: 2, mode_breakdown: [mode('explore', 3, 0, 0, 9)] });
    const r = computeSteeringRecommendations([a, b]);
    expect(r.best_mode).toBe('exploit');
    expect(r.worst_mode).toBe('explore');
    const modeRec = r.recommendations.find((x) => x.kind === 'mode');
    expect(modeRec?.text).toMatch(/Prefer "exploit"/);
  });

  it('does not rank modes with too little evidence (<3 runs)', () => {
    const a = makeOutcome({ batch_start: 1, mode_breakdown: [mode('exploit', 2, 2, 2, 4), mode('explore', 1, 0, 0, 2)] });
    const r = computeSteeringRecommendations([a]);
    expect(r.recommendations.find((x) => x.kind === 'mode')).toBeUndefined();
  });

  it('flags a declining success-rate trajectory', () => {
    const good = makeOutcome({ batch_id: 'g1', batch_start: 1, success_rate: 0.9 });
    const good2 = makeOutcome({ batch_id: 'g2', batch_start: 2, success_rate: 0.9 });
    const bad = makeOutcome({ batch_id: 'b1', batch_start: 3, success_rate: 0.4 });
    const bad2 = makeOutcome({ batch_id: 'b2', batch_start: 4, success_rate: 0.3 });
    const r = computeSteeringRecommendations([bad2, good, bad, good2]); // unsorted on purpose
    const traj = r.recommendations.find((x) => x.kind === 'trajectory');
    expect(traj?.text).toMatch(/declining/i);
    // Declining trajectory is the highest-priority signal → sorts first.
    expect(r.recommendations[0].kind).toBe('trajectory');
  });

  it('notes an improving trajectory', () => {
    const r = computeSteeringRecommendations([
      makeOutcome({ batch_start: 1, success_rate: 0.3 }),
      makeOutcome({ batch_start: 2, success_rate: 0.4 }),
      makeOutcome({ batch_start: 3, success_rate: 0.9 }),
      makeOutcome({ batch_start: 4, success_rate: 0.9 }),
    ]);
    expect(r.recommendations.find((x) => x.kind === 'trajectory')?.text).toMatch(/improving/i);
  });

  it('flags high review fail rate', () => {
    const r = computeSteeringRecommendations([makeOutcome({ review_fail_rate: 0.5 })]);
    expect(r.recommendations.find((x) => x.kind === 'review')?.text).toMatch(/Review fail rate/);
  });

  it('surfaces a recurring stop reason when it dominates', () => {
    const r = computeSteeringRecommendations([
      makeOutcome({ batch_id: '1', batch_start: 1, stop_reason: 'backlog exhausted — no more open issues' }),
      makeOutcome({ batch_id: '2', batch_start: 2, stop_reason: 'backlog exhausted matching guidance' }),
    ]);
    const stop = r.recommendations.find((x) => x.kind === 'stop_reason');
    expect(stop?.text).toMatch(/backlog exhausted/i);
    expect(stop?.text).toMatch(/decompose an epic/i);
  });

  it('does not surface a stop reason that appears only once', () => {
    const r = computeSteeringRecommendations([
      makeOutcome({ batch_id: '1', batch_start: 1, stop_reason: 'backlog exhausted' }),
      makeOutcome({ batch_id: '2', batch_start: 2, stop_reason: 'completed' }),
    ]);
    expect(r.recommendations.find((x) => x.kind === 'stop_reason')).toBeUndefined();
  });

  it('flags recurring cost anomalies', () => {
    const r = computeSteeringRecommendations([
      makeOutcome({ batch_id: '1', batch_start: 1, cost_anomaly_count: 2 }),
      makeOutcome({ batch_id: '2', batch_start: 2, cost_anomaly_count: 1 }),
    ]);
    expect(r.recommendations.find((x) => x.kind === 'cost')?.text).toMatch(/Cost anomalies recur/);
  });

  it('gives no strong signal for a single healthy batch', () => {
    const r = computeSteeringRecommendations([makeOutcome()]);
    expect(r.batches_analyzed).toBe(1);
    expect(r.recommendations).toEqual([]);
    expect(r.summary).toMatch(/no strong steering signal/i);
  });

  it('is deterministic — same input, same report', () => {
    const outcomes = [
      makeOutcome({ batch_start: 1, success_rate: 0.9 }),
      makeOutcome({ batch_start: 2, success_rate: 0.4 }),
    ];
    expect(computeSteeringRecommendations(outcomes)).toEqual(computeSteeringRecommendations(outcomes));
  });
});

describe('formatSteeringReport / steeringPromptText', () => {
  it('renders a cold-start report compactly', () => {
    const text = formatSteeringReport(computeSteeringRecommendations([]));
    expect(text).toMatch(/Cross-Batch Steering/);
    expect(text).not.toMatch(/Recommendations:/);
  });

  it('lists recommendations and best/worst mode', () => {
    const a = makeOutcome({ batch_id: 'a', batch_start: 1, mode_breakdown: [mode('exploit', 3, 3, 3, 9)] });
    const b = makeOutcome({ batch_id: 'b', batch_start: 2, mode_breakdown: [mode('explore', 3, 0, 0, 9)] });
    const text = formatSteeringReport(computeSteeringRecommendations([a, b]));
    expect(text).toMatch(/Best mode: exploit/);
    expect(text).toMatch(/Recommendations:/);
  });

  it('steeringPromptText is empty when no recommendations, numbered otherwise', () => {
    expect(steeringPromptText(computeSteeringRecommendations([]))).toBe('');
    const r = computeSteeringRecommendations([makeOutcome({ review_fail_rate: 0.6 })]);
    expect(steeringPromptText(r)).toMatch(/^1\. /);
  });
});

describe('readBatchOutcomesFromGithub — discovery (injected deps)', () => {
  it('reads outcomes for each discovered issue, skipping ones without an attachment', () => {
    const out = readBatchOutcomesFromGithub('Garsson-io/kaizen', {}, {
      listIssues: () => [10, 11, 12],
      readOutcome: (n) =>
        n === '11' ? null : makeOutcome({ batch_id: `b${n}` }),
    });
    expect(out.map((o) => o.batch_id)).toEqual(['b10', 'b12']);
  });

  it('excludes the current batch via excludeBatchId', () => {
    const out = readBatchOutcomesFromGithub('Garsson-io/kaizen', { excludeBatchId: 'self' }, {
      listIssues: () => [1, 2],
      readOutcome: (n) => makeOutcome({ batch_id: n === '1' ? 'self' : 'other' }),
    });
    expect(out.map((o) => o.batch_id)).toEqual(['other']);
  });

  it('passes the limit through to the lister', () => {
    let seenLimit = -1;
    readBatchOutcomesFromGithub('Garsson-io/kaizen', { limit: 5 }, {
      listIssues: (_repo, limit) => { seenLimit = limit; return []; },
    });
    expect(seenLimit).toBe(5);
  });

  it('skips a malformed attachment instead of aborting the whole sweep', () => {
    const out = readBatchOutcomesFromGithub('Garsson-io/kaizen', {}, {
      listIssues: () => [1, 2, 3],
      readOutcome: (n) => {
        if (n === '2') throw new Error('schema drift');
        return makeOutcome({ batch_id: `b${n}` });
      },
    });
    expect(out.map((o) => o.batch_id)).toEqual(['b1', 'b3']);
  });
});
