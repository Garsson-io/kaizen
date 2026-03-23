import { describe, it, expect } from 'vitest';
import {
  scoreRunMetrics,
  scoreRunResult,
  scoreBatch,
  scoreModeBreakdown,
  computeModeDiversity,
  computeBatchTrend,
  formatRunScoreLine,
  formatBatchScoreTable,
  formatModeBreakdown,
  postHocScoreBatch,
  formatPostHocLine,
  detectCostAnomaly,
  classifyFailure,
  failureClassLabel,
  failureClassDistribution,
  formatFailureDistribution,
  type RunScore,
  type BatchScore,
  type BatchTrend,
  type ModeStats,
  type PostHocBatchResult,
  type FailureClass,
} from './auto-dent-score.js';
import type { RunMetrics, RunResult } from './auto-dent-run.js';

function makeRunMetrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    run: 1,
    start_epoch: 1742680800,
    duration_seconds: 300,
    exit_code: 0,
    cost_usd: 2.5,
    tool_calls: 42,
    prs: ['https://github.com/Garsson-io/kaizen/pull/500'],
    issues_filed: [],
    issues_closed: ['#451'],
    cases: [],
    stop_requested: false,
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    prs: [],
    issuesFiled: [],
    issuesClosed: [],
    cases: [],
    cost: 0,
    toolCalls: 0,
    stopRequested: false,
    linesDeleted: 0,
    issuesPruned: 0,
    ...overrides,
  };
}

describe('scoreRunMetrics', () => {
  it('scores a successful run (exit 0 + PR)', () => {
    const score = scoreRunMetrics(makeRunMetrics());
    expect(score.success).toBe(true);
    expect(score.cost_usd).toBe(2.5);
    expect(score.tool_calls).toBe(42);
    expect(score.pr_count).toBe(1);
    expect(score.issues_closed_count).toBe(1);
    expect(score.duration_seconds).toBe(300);
  });

  it('marks run as failed when exit code is non-zero', () => {
    const score = scoreRunMetrics(makeRunMetrics({ exit_code: 1 }));
    expect(score.success).toBe(false);
  });

  it('marks run as failed when no PRs created despite exit 0', () => {
    const score = scoreRunMetrics(makeRunMetrics({ prs: [] }));
    expect(score.success).toBe(false);
  });

  it('calculates efficiency as PRs per dollar', () => {
    const score = scoreRunMetrics(
      makeRunMetrics({
        prs: ['pr1', 'pr2'],
        cost_usd: 4.0,
      }),
    );
    expect(score.efficiency).toBe(0.5);
  });

  it('returns zero efficiency when cost is zero', () => {
    const score = scoreRunMetrics(makeRunMetrics({ cost_usd: 0 }));
    expect(score.efficiency).toBe(0);
  });

  it('calculates cost per PR', () => {
    const score = scoreRunMetrics(
      makeRunMetrics({
        prs: ['pr1', 'pr2'],
        cost_usd: 6.0,
      }),
    );
    expect(score.cost_per_pr).toBe(3.0);
  });

  it('returns Infinity cost_per_pr when no PRs', () => {
    const score = scoreRunMetrics(makeRunMetrics({ prs: [] }));
    expect(score.cost_per_pr).toBe(Infinity);
  });

  it('propagates stop_requested flag', () => {
    const score = scoreRunMetrics(makeRunMetrics({ stop_requested: true }));
    expect(score.stop_requested).toBe(true);
  });

  it('defaults mode to "exploit" when not present', () => {
    const score = scoreRunMetrics(makeRunMetrics());
    expect(score.mode).toBe('exploit');
  });

  it('propagates explicit mode from RunMetrics', () => {
    const score = scoreRunMetrics(makeRunMetrics({ mode: 'explore' }));
    expect(score.mode).toBe('explore');
  });

  it('counts issues filed', () => {
    const score = scoreRunMetrics(
      makeRunMetrics({
        issues_filed: ['https://github.com/org/repo/issues/1', 'https://github.com/org/repo/issues/2'],
      }),
    );
    expect(score.issues_filed_count).toBe(2);
  });

  it('propagates lines_deleted from RunMetrics', () => {
    const score = scoreRunMetrics(makeRunMetrics({ lines_deleted: 42 }));
    expect(score.lines_deleted).toBe(42);
  });

  it('propagates issues_pruned from RunMetrics', () => {
    const score = scoreRunMetrics(makeRunMetrics({ issues_pruned: 3 }));
    expect(score.issues_pruned).toBe(3);
  });

  it('defaults lines_deleted and issues_pruned to 0 when absent', () => {
    const score = scoreRunMetrics(makeRunMetrics());
    expect(score.lines_deleted).toBe(0);
    expect(score.issues_pruned).toBe(0);
  });
});

describe('scoreRunResult', () => {
  it('scores a successful run result', () => {
    const result = makeRunResult({
      prs: ['https://github.com/org/repo/pull/1'],
      cost: 1.5,
      toolCalls: 30,
      issuesClosed: ['#100'],
    });
    const score = scoreRunResult(result, 0, 200);
    expect(score.success).toBe(true);
    expect(score.cost_usd).toBe(1.5);
    expect(score.tool_calls).toBe(30);
    expect(score.pr_count).toBe(1);
    expect(score.issues_closed_count).toBe(1);
    expect(score.duration_seconds).toBe(200);
  });

  it('marks as failed with non-zero exit code', () => {
    const result = makeRunResult({
      prs: ['https://github.com/org/repo/pull/1'],
    });
    const score = scoreRunResult(result, 1, 100);
    expect(score.success).toBe(false);
  });

  it('marks as failed with zero PRs even on exit 0', () => {
    const score = scoreRunResult(makeRunResult(), 0, 100);
    expect(score.success).toBe(false);
  });

  it('defaults mode to exploit', () => {
    const score = scoreRunResult(makeRunResult(), 0, 100);
    expect(score.mode).toBe('exploit');
  });

  it('accepts explicit mode parameter', () => {
    const score = scoreRunResult(makeRunResult(), 0, 100, 'reflect');
    expect(score.mode).toBe('reflect');
  });

  it('propagates linesDeleted and issuesPruned from RunResult', () => {
    const result = makeRunResult({ linesDeleted: 100, issuesPruned: 2 });
    const score = scoreRunResult(result, 0, 100);
    expect(score.lines_deleted).toBe(100);
    expect(score.issues_pruned).toBe(2);
  });
});

describe('scoreBatch', () => {
  it('scores a batch with multiple runs', () => {
    const history: RunMetrics[] = [
      makeRunMetrics({ run: 1, cost_usd: 2.0, duration_seconds: 200 }),
      makeRunMetrics({
        run: 2,
        cost_usd: 3.0,
        duration_seconds: 400,
        prs: ['pr1', 'pr2'],
        issues_closed: ['#1', '#2', '#3'],
      }),
      makeRunMetrics({
        run: 3,
        exit_code: 1,
        cost_usd: 1.0,
        duration_seconds: 50,
        prs: [],
      }),
    ];

    const score = scoreBatch(history);
    expect(score.total_runs).toBe(3);
    expect(score.successful_runs).toBe(2);
    expect(score.success_rate).toBeCloseTo(2 / 3);
    expect(score.total_cost_usd).toBe(6.0);
    expect(score.total_prs).toBe(3); // 1 + 2 + 0
    expect(score.total_issues_closed).toBe(5); // 1 + 3 + 1
    expect(score.total_duration_seconds).toBe(650);
    expect(score.avg_duration_seconds).toBeCloseTo(650 / 3);
    expect(score.avg_cost_per_success).toBe(3.0); // 6.0 / 2
    expect(score.overall_efficiency).toBeCloseTo(3 / 6);
  });

  it('handles empty batch', () => {
    const score = scoreBatch([]);
    expect(score.total_runs).toBe(0);
    expect(score.success_rate).toBe(0);
    expect(score.total_cost_usd).toBe(0);
    expect(score.avg_duration_seconds).toBe(0);
    expect(score.overall_efficiency).toBe(0);
  });

  it('handles batch with all failures', () => {
    const history: RunMetrics[] = [
      makeRunMetrics({ run: 1, exit_code: 1, prs: [], cost_usd: 1.0 }),
      makeRunMetrics({ run: 2, exit_code: 1, prs: [], cost_usd: 2.0 }),
    ];

    const score = scoreBatch(history);
    expect(score.successful_runs).toBe(0);
    expect(score.success_rate).toBe(0);
    expect(isNaN(score.avg_cost_per_success)).toBe(true);
  });

  it('aggregates subtraction metrics across runs', () => {
    const history: RunMetrics[] = [
      makeRunMetrics({ run: 1, lines_deleted: 50, issues_pruned: 1 }),
      makeRunMetrics({ run: 2, lines_deleted: 30, issues_pruned: 2 }),
      makeRunMetrics({ run: 3, exit_code: 1, prs: [] }),
    ];

    const score = scoreBatch(history);
    expect(score.total_lines_deleted).toBe(80);
    expect(score.total_issues_pruned).toBe(3);
  });

  it('provides per-run scores', () => {
    const history: RunMetrics[] = [
      makeRunMetrics({ run: 1 }),
      makeRunMetrics({ run: 2, exit_code: 1, prs: [] }),
    ];

    const score = scoreBatch(history);
    expect(score.runs).toHaveLength(2);
    expect(score.runs[0].success).toBe(true);
    expect(score.runs[1].success).toBe(false);
  });
});

describe('formatRunScoreLine', () => {
  it('formats a successful run score with mode', () => {
    const score: RunScore = {
      success: true,
      cost_usd: 2.5,
      tool_calls: 42,
      pr_count: 1,
      issues_closed_count: 1,
      issues_filed_count: 0,
      duration_seconds: 300,
      efficiency: 0.4,
      cost_per_pr: 2.5,
      stop_requested: false,
      mode: 'exploit',
      lines_deleted: 0,
      issues_pruned: 0,
    };
    const line = formatRunScoreLine(score);
    expect(line).toContain('pass');
    expect(line).toContain('exploit');
    expect(line).toContain('$2.50');
    expect(line).toContain('42 tools');
    expect(line).toContain('1 PRs');
    expect(line).toContain('300s');
    expect(line).toContain('0.40 PR/$');
  });

  it('shows subtraction metrics when non-zero', () => {
    const score: RunScore = {
      success: true,
      cost_usd: 1.0,
      tool_calls: 10,
      pr_count: 1,
      issues_closed_count: 0,
      issues_filed_count: 0,
      duration_seconds: 100,
      efficiency: 1.0,
      cost_per_pr: 1.0,
      stop_requested: false,
      mode: 'subtract',
      lines_deleted: 200,
      issues_pruned: 3,
    };
    const line = formatRunScoreLine(score);
    expect(line).toContain('-200 lines');
    expect(line).toContain('3 pruned');
  });

  it('formats a failed run score without efficiency', () => {
    const score: RunScore = {
      success: false,
      cost_usd: 1.0,
      tool_calls: 10,
      pr_count: 0,
      issues_closed_count: 0,
      issues_filed_count: 0,
      duration_seconds: 50,
      efficiency: 0,
      cost_per_pr: Infinity,
      stop_requested: false,
      mode: 'explore',
      lines_deleted: 0,
      issues_pruned: 0,
      failure_class: 'crash',
    };
    const line = formatRunScoreLine(score);
    expect(line).toContain('crash');
    expect(line).toContain('explore');
    expect(line).not.toContain('PR/$');
  });
});

describe('formatBatchScoreTable', () => {
  it('formats a batch score as markdown table with mode distribution', () => {
    const score: BatchScore = {
      total_runs: 3,
      successful_runs: 2,
      success_rate: 2 / 3,
      total_cost_usd: 6.0,
      total_prs: 3,
      total_issues_closed: 5,
      total_duration_seconds: 650,
      total_lines_deleted: 120,
      total_issues_pruned: 2,
      avg_cost_per_success: 3.0,
      avg_duration_seconds: 216.67,
      overall_efficiency: 0.5,
      runs: [
        { success: true, cost_usd: 2, tool_calls: 10, pr_count: 1, issues_closed_count: 1, issues_filed_count: 0, duration_seconds: 200, efficiency: 0.5, cost_per_pr: 2, stop_requested: false, mode: 'exploit', lines_deleted: 80, issues_pruned: 1, cost_vs_avg: null, failure_class: 'success' },
        { success: true, cost_usd: 3, tool_calls: 15, pr_count: 2, issues_closed_count: 3, issues_filed_count: 0, duration_seconds: 400, efficiency: 0.67, cost_per_pr: 1.5, stop_requested: false, mode: 'exploit', lines_deleted: 40, issues_pruned: 1, cost_vs_avg: null, failure_class: 'success' },
        { success: false, cost_usd: 1, tool_calls: 5, pr_count: 0, issues_closed_count: 1, issues_filed_count: 0, duration_seconds: 50, efficiency: 0, cost_per_pr: Infinity, stop_requested: false, mode: 'explore', lines_deleted: 0, issues_pruned: 0, cost_vs_avg: null, failure_class: 'crash' },
      ],
      mode_breakdown: [
        { mode: 'exploit', runs: 2, successes: 2, success_rate: 1, cost_usd: 5, prs: 3, avg_cost: 2.5, efficiency: 0.6, lines_deleted: 120, issues_pruned: 2 },
        { mode: 'explore', runs: 1, successes: 0, success_rate: 0, cost_usd: 1, prs: 0, avg_cost: 1, efficiency: 0, lines_deleted: 0, issues_pruned: 0 },
      ],
      cost_anomaly_count: 0,
      mode_diversity: 0,
      trend: null,
    };
    const table = formatBatchScoreTable(score);
    expect(table).toContain('| **Runs** | 3 (2 successful) |');
    expect(table).toContain('| **Success rate** | 67% |');
    expect(table).toContain('| **Total cost** | $6.00 |');
    expect(table).toContain('| **Total PRs** | 3 |');
    expect(table).toContain('| **Issues closed** | 5 |');
    expect(table).toContain('| **Lines deleted** | 120 |');
    expect(table).toContain('| **Issues pruned** | 2 |');
    expect(table).toContain('| **Avg cost/success** | $3.00 |');
    expect(table).toContain('| **Efficiency** | 0.50 PR/$ |');
    expect(table).toContain('| **Modes** | exploit:2, explore:1 |');
    expect(table).toContain('Per-mode effectiveness');
  });

  it('shows N/A for avg cost when no successes', () => {
    const score: BatchScore = {
      total_runs: 1,
      successful_runs: 0,
      success_rate: 0,
      total_cost_usd: 1.0,
      total_prs: 0,
      total_issues_closed: 0,
      total_lines_deleted: 0,
      total_issues_pruned: 0,
      total_duration_seconds: 50,
      avg_cost_per_success: NaN,
      avg_duration_seconds: 50,
      overall_efficiency: 0,
      runs: [],
      mode_breakdown: [],
      cost_anomaly_count: 0,
      mode_diversity: 0,
      trend: null,
    };
    const table = formatBatchScoreTable(score);
    expect(table).toContain('| **Avg cost/success** | N/A |');
    expect(table).toContain('| **Efficiency** | N/A |');
  });

  it('includes post-hoc merge rate when available', () => {
    const score: BatchScore = {
      total_runs: 3,
      successful_runs: 3,
      success_rate: 1.0,
      total_cost_usd: 9.0,
      total_prs: 3,
      total_issues_closed: 3,
      total_duration_seconds: 900,
      total_lines_deleted: 0,
      total_issues_pruned: 0,
      avg_cost_per_success: 3.0,
      avg_duration_seconds: 300,
      overall_efficiency: 1 / 3,
      runs: [],
      mode_breakdown: [],
      cost_anomaly_count: 0,
      mode_diversity: 0,
      post_hoc: {
        prs: [
          { url: 'https://github.com/org/repo/pull/1', status: 'merged' },
          { url: 'https://github.com/org/repo/pull/2', status: 'merged' },
          { url: 'https://github.com/org/repo/pull/3', status: 'closed' },
        ],
        merged_count: 2,
        pending_count: 0,
        closed_count: 1,
        merge_rate: 2 / 3,
        effective_efficiency: 2 / 9,
        scored_at: '2026-03-23T00:00:00.000Z',
      },
    };
    const table = formatBatchScoreTable(score);
    expect(table).toContain('| **PR merge rate** | 67% (2/3) |');
    expect(table).toContain('| **Effective efficiency** |');
  });

  it('omits post-hoc rows when not present', () => {
    const score: BatchScore = {
      total_runs: 1,
      successful_runs: 1,
      success_rate: 1.0,
      total_cost_usd: 3.0,
      total_prs: 1,
      total_issues_closed: 1,
      total_duration_seconds: 300,
      total_lines_deleted: 0,
      total_issues_pruned: 0,
      avg_cost_per_success: 3.0,
      avg_duration_seconds: 300,
      overall_efficiency: 1 / 3,
      runs: [],
      mode_breakdown: [],
      cost_anomaly_count: 0,
      mode_diversity: 0,
      trend: null,
    };
    const table = formatBatchScoreTable(score);
    expect(table).not.toContain('merge rate');
  });
});

function makeRunScore(overrides: Partial<RunScore> = {}): RunScore {
  return {
    success: true,
    cost_usd: 2.5,
    tool_calls: 42,
    pr_count: 1,
    issues_closed_count: 1,
    issues_filed_count: 0,
    duration_seconds: 300,
    efficiency: 0.4,
    cost_per_pr: 2.5,
    stop_requested: false,
    mode: 'exploit',
    lines_deleted: 0,
    issues_pruned: 0,
    cost_vs_avg: null,
    failure_class: 'success',
    ...overrides,
  };
}

describe('scoreModeBreakdown', () => {
  it('groups runs by mode and computes per-mode stats', () => {
    const runs: RunScore[] = [
      makeRunScore({ mode: 'exploit', cost_usd: 2.0, pr_count: 1, success: true }),
      makeRunScore({ mode: 'exploit', cost_usd: 3.0, pr_count: 2, success: true }),
      makeRunScore({ mode: 'explore', cost_usd: 1.5, pr_count: 0, success: false }),
      makeRunScore({ mode: 'reflect', cost_usd: 1.0, pr_count: 1, success: true }),
    ];

    const breakdown = scoreModeBreakdown(runs);
    expect(breakdown).toHaveLength(3);

    // Sorted by run count descending: exploit(2), explore(1), reflect(1)
    const exploit = breakdown.find((m) => m.mode === 'exploit')!;
    expect(exploit.runs).toBe(2);
    expect(exploit.successes).toBe(2);
    expect(exploit.success_rate).toBe(1.0);
    expect(exploit.cost_usd).toBe(5.0);
    expect(exploit.prs).toBe(3);
    expect(exploit.avg_cost).toBe(2.5);
    expect(exploit.efficiency).toBeCloseTo(3 / 5);

    const explore = breakdown.find((m) => m.mode === 'explore')!;
    expect(explore.runs).toBe(1);
    expect(explore.successes).toBe(0);
    expect(explore.success_rate).toBe(0);
    expect(explore.prs).toBe(0);

    const reflect = breakdown.find((m) => m.mode === 'reflect')!;
    expect(reflect.runs).toBe(1);
    expect(reflect.successes).toBe(1);
  });

  it('returns empty array for empty input', () => {
    expect(scoreModeBreakdown([])).toEqual([]);
  });

  it('returns single entry when all runs use the same mode', () => {
    const runs = [
      makeRunScore({ mode: 'exploit' }),
      makeRunScore({ mode: 'exploit' }),
    ];
    const breakdown = scoreModeBreakdown(runs);
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].mode).toBe('exploit');
    expect(breakdown[0].runs).toBe(2);
  });

  it('tracks subtraction metrics per mode', () => {
    const runs = [
      makeRunScore({ mode: 'subtract', lines_deleted: 100, issues_pruned: 2 }),
      makeRunScore({ mode: 'subtract', lines_deleted: 50, issues_pruned: 1 }),
      makeRunScore({ mode: 'exploit', lines_deleted: 0, issues_pruned: 0 }),
    ];
    const breakdown = scoreModeBreakdown(runs);
    const subtract = breakdown.find((m) => m.mode === 'subtract')!;
    expect(subtract.lines_deleted).toBe(150);
    expect(subtract.issues_pruned).toBe(3);
  });
});

describe('formatModeBreakdown', () => {
  it('returns empty string when only one mode exists', () => {
    const stats: ModeStats[] = [
      { mode: 'exploit', runs: 5, successes: 4, success_rate: 0.8, cost_usd: 10, prs: 4, avg_cost: 2, efficiency: 0.4, lines_deleted: 0, issues_pruned: 0 },
    ];
    expect(formatModeBreakdown(stats)).toBe('');
  });

  it('renders a markdown table for multiple modes', () => {
    const stats: ModeStats[] = [
      { mode: 'exploit', runs: 3, successes: 2, success_rate: 2 / 3, cost_usd: 6, prs: 3, avg_cost: 2, efficiency: 0.5, lines_deleted: 0, issues_pruned: 0 },
      { mode: 'explore', runs: 1, successes: 0, success_rate: 0, cost_usd: 1, prs: 0, avg_cost: 1, efficiency: 0, lines_deleted: 0, issues_pruned: 0 },
    ];
    const output = formatModeBreakdown(stats);
    expect(output).toContain('Per-mode effectiveness');
    expect(output).toContain('| exploit | 3 | 67% | 3 | $6.00 | 0.50 PR/$ | - |');
    expect(output).toContain('| explore | 1 | 0% | 0 | $1.00 | - | - |');
  });

  it('shows deletion counts for subtract mode', () => {
    const stats: ModeStats[] = [
      { mode: 'exploit', runs: 2, successes: 2, success_rate: 1, cost_usd: 4, prs: 2, avg_cost: 2, efficiency: 0.5, lines_deleted: 0, issues_pruned: 0 },
      { mode: 'subtract', runs: 1, successes: 1, success_rate: 1, cost_usd: 1.5, prs: 1, avg_cost: 1.5, efficiency: 2 / 3, lines_deleted: 200, issues_pruned: 0 },
    ];
    const output = formatModeBreakdown(stats);
    expect(output).toContain('| subtract | 1 | 100% | 1 | $1.50 |');
    expect(output).toContain('-200');
  });
});

describe('scoreBatch mode_breakdown integration', () => {
  it('includes mode_breakdown in batch score', () => {
    const history: RunMetrics[] = [
      makeRunMetrics({ run: 1, mode: 'exploit' }),
      makeRunMetrics({ run: 2, mode: 'explore', prs: [], exit_code: 1 }),
    ];
    const score = scoreBatch(history);
    expect(score.mode_breakdown).toHaveLength(2);
    expect(score.mode_breakdown[0].mode).toBe('exploit');
    expect(score.mode_breakdown[1].mode).toBe('explore');
  });

  it('includes mode breakdown in batch score table when multiple modes', () => {
    const history: RunMetrics[] = [
      makeRunMetrics({ run: 1, mode: 'exploit' }),
      makeRunMetrics({ run: 2, mode: 'explore', prs: [], exit_code: 1 }),
    ];
    const score = scoreBatch(history);
    const table = formatBatchScoreTable(score);
    expect(table).toContain('Per-mode effectiveness');
    expect(table).toContain('exploit');
    expect(table).toContain('explore');
  });

  it('omits mode breakdown in table when only one mode', () => {
    const history: RunMetrics[] = [
      makeRunMetrics({ run: 1, mode: 'exploit' }),
      makeRunMetrics({ run: 2, mode: 'exploit' }),
    ];
    const score = scoreBatch(history);
    const table = formatBatchScoreTable(score);
    expect(table).not.toContain('Per-mode effectiveness');
  });
});

describe('computeModeDiversity', () => {
  function makeRunScore(mode: string): RunScore {
    return {
      run: 1,
      mode,
      success: true,
      cost_usd: 1.0,
      duration_seconds: 60,
      pr_count: 1,
      issues_closed_count: 0,
      cost_vs_avg: null,
      lines_deleted: 0,
      issues_pruned: 0,
      failure_class: 'success',
    };
  }

  it('returns 0 for empty runs', () => {
    expect(computeModeDiversity([])).toBe(0);
  });

  it('returns 0 for single mode', () => {
    const runs = [makeRunScore('exploit'), makeRunScore('exploit'), makeRunScore('exploit')];
    expect(computeModeDiversity(runs)).toBe(0);
  });

  it('returns 1 for perfectly even distribution', () => {
    const runs = [
      makeRunScore('exploit'),
      makeRunScore('explore'),
      makeRunScore('reflect'),
      makeRunScore('subtract'),
    ];
    expect(computeModeDiversity(runs)).toBeCloseTo(1.0, 5);
  });

  it('returns value between 0 and 1 for uneven distribution', () => {
    const runs = [
      makeRunScore('exploit'),
      makeRunScore('exploit'),
      makeRunScore('exploit'),
      makeRunScore('explore'),
    ];
    const diversity = computeModeDiversity(runs);
    expect(diversity).toBeGreaterThan(0);
    expect(diversity).toBeLessThan(1);
  });

  it('higher diversity for more even distributions', () => {
    // Uneven: 7 exploit, 1 explore
    const uneven = [
      ...Array(7).fill(null).map(() => makeRunScore('exploit')),
      makeRunScore('explore'),
    ];
    // Even: 4 exploit, 4 explore
    const even = [
      ...Array(4).fill(null).map(() => makeRunScore('exploit')),
      ...Array(4).fill(null).map(() => makeRunScore('explore')),
    ];
    expect(computeModeDiversity(even)).toBeGreaterThan(computeModeDiversity(uneven));
  });
});

describe('scoreBatch mode_diversity integration', () => {
  it('includes mode_diversity in batch score', () => {
    const history: RunMetrics[] = [
      makeRunMetrics({ run: 1, mode: 'exploit' }),
      makeRunMetrics({ run: 2, mode: 'explore', prs: [], exit_code: 1 }),
    ];
    const score = scoreBatch(history);
    expect(score.mode_diversity).toBeCloseTo(1.0, 5);
  });

  it('mode_diversity is 0 for single-mode batch', () => {
    const history: RunMetrics[] = [
      makeRunMetrics({ run: 1, mode: 'exploit' }),
      makeRunMetrics({ run: 2, mode: 'exploit' }),
    ];
    const score = scoreBatch(history);
    expect(score.mode_diversity).toBe(0);
  });

  it('shows mode diversity in batch score table', () => {
    const history: RunMetrics[] = [
      makeRunMetrics({ run: 1, mode: 'exploit' }),
      makeRunMetrics({ run: 2, mode: 'explore', prs: [], exit_code: 1 }),
    ];
    const score = scoreBatch(history);
    const table = formatBatchScoreTable(score);
    expect(table).toContain('Mode diversity');
  });
});

describe('postHocScoreBatch', () => {
  it('scores a batch with mixed merge outcomes', () => {
    const result = postHocScoreBatch(
      [
        { url: 'https://github.com/org/repo/pull/1', status: 'merged' },
        { url: 'https://github.com/org/repo/pull/2', status: 'merged' },
        { url: 'https://github.com/org/repo/pull/3', status: 'closed' },
        { url: 'https://github.com/org/repo/pull/4', status: 'open' },
      ],
      10.0,
    );

    expect(result.merged_count).toBe(2);
    expect(result.closed_count).toBe(1);
    expect(result.pending_count).toBe(1);
    expect(result.merge_rate).toBe(0.5);
    expect(result.effective_efficiency).toBe(0.2);
    expect(result.prs).toHaveLength(4);
    expect(result.scored_at).toBeTruthy();
  });

  it('returns NaN merge rate for empty PR list', () => {
    const result = postHocScoreBatch([], 5.0);
    expect(isNaN(result.merge_rate)).toBe(true);
    expect(result.merged_count).toBe(0);
    expect(result.pending_count).toBe(0);
    expect(result.closed_count).toBe(0);
  });

  it('handles all merged PRs', () => {
    const result = postHocScoreBatch(
      [
        { url: 'https://github.com/org/repo/pull/1', status: 'merged' },
        { url: 'https://github.com/org/repo/pull/2', status: 'merged' },
      ],
      4.0,
    );
    expect(result.merge_rate).toBe(1.0);
    expect(result.effective_efficiency).toBe(0.5);
    expect(result.pending_count).toBe(0);
    expect(result.closed_count).toBe(0);
  });

  it('handles zero cost', () => {
    const result = postHocScoreBatch(
      [{ url: 'https://github.com/org/repo/pull/1', status: 'merged' }],
      0,
    );
    expect(result.effective_efficiency).toBe(0);
    expect(result.merge_rate).toBe(1.0);
  });

  it('treats auto_queued and unknown as pending', () => {
    const result = postHocScoreBatch(
      [
        { url: 'https://github.com/org/repo/pull/1', status: 'auto_queued' },
        { url: 'https://github.com/org/repo/pull/2', status: 'unknown' },
      ],
      2.0,
    );
    expect(result.pending_count).toBe(2);
    expect(result.merged_count).toBe(0);
    expect(result.closed_count).toBe(0);
  });
});

describe('formatPostHocLine', () => {
  it('formats a post-hoc result summary', () => {
    const ph: PostHocBatchResult = {
      prs: [
        { url: 'pr1', status: 'merged' },
        { url: 'pr2', status: 'open' },
      ],
      merged_count: 1,
      pending_count: 1,
      closed_count: 0,
      merge_rate: 0.5,
      effective_efficiency: 0.25,
      scored_at: '2026-03-23T00:00:00.000Z',
    };
    const line = formatPostHocLine(ph);
    expect(line).toContain('merge rate: 50%');
    expect(line).toContain('1 merged');
    expect(line).toContain('1 pending');
    expect(line).toContain('0 closed');
  });

  it('shows N/A for empty batch', () => {
    const ph: PostHocBatchResult = {
      prs: [],
      merged_count: 0,
      pending_count: 0,
      closed_count: 0,
      merge_rate: NaN,
      effective_efficiency: 0,
      scored_at: '2026-03-23T00:00:00.000Z',
    };
    const line = formatPostHocLine(ph);
    expect(line).toContain('merge rate: N/A');
  });
});

describe('detectCostAnomaly', () => {
  it('returns null when no prior history', () => {
    expect(detectCostAnomaly(5.0, [])).toBeNull();
  });

  it('returns null when rolling average is zero', () => {
    const history = [makeRunMetrics({ cost_usd: 0 })];
    expect(detectCostAnomaly(5.0, history)).toBeNull();
  });

  it('returns normal when cost is below 2x average', () => {
    const history = [
      makeRunMetrics({ cost_usd: 2.0 }),
      makeRunMetrics({ cost_usd: 3.0 }),
    ];
    const result = detectCostAnomaly(4.0, history);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('normal');
    expect(result!.rolling_avg).toBe(2.5);
    expect(result!.cost_vs_avg).toBeCloseTo(1.6);
  });

  it('returns warning when cost is 2-4x average', () => {
    const history = [
      makeRunMetrics({ cost_usd: 2.0 }),
      makeRunMetrics({ cost_usd: 2.0 }),
    ];
    const result = detectCostAnomaly(5.0, history);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('warning');
    expect(result!.cost_vs_avg).toBe(2.5);
  });

  it('returns anomaly when cost is 4x+ average', () => {
    const history = [
      makeRunMetrics({ cost_usd: 1.0 }),
      makeRunMetrics({ cost_usd: 1.0 }),
    ];
    const result = detectCostAnomaly(5.0, history);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('anomaly');
    expect(result!.cost_vs_avg).toBe(5.0);
  });

  it('returns warning at exactly 2x threshold', () => {
    const history = [makeRunMetrics({ cost_usd: 2.0 })];
    const result = detectCostAnomaly(4.0, history);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('warning');
  });

  it('returns anomaly at exactly 4x threshold', () => {
    const history = [makeRunMetrics({ cost_usd: 1.0 })];
    const result = detectCostAnomaly(4.0, history);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('anomaly');
  });
});

describe('cost_vs_avg in scoring', () => {
  it('scoreRunMetrics returns null cost_vs_avg when no prior history', () => {
    const score = scoreRunMetrics(makeRunMetrics());
    expect(score.cost_vs_avg).toBeNull();
  });

  it('scoreRunMetrics computes cost_vs_avg from prior history', () => {
    const priorHistory = [
      makeRunMetrics({ cost_usd: 2.0 }),
      makeRunMetrics({ cost_usd: 4.0 }),
    ];
    const score = scoreRunMetrics(makeRunMetrics({ cost_usd: 6.0 }), priorHistory);
    expect(score.cost_vs_avg).toBe(2.0); // 6.0 / 3.0
  });

  it('scoreRunResult returns null cost_vs_avg when no prior history', () => {
    const score = scoreRunResult(makeRunResult(), 0, 100);
    expect(score.cost_vs_avg).toBeNull();
  });

  it('scoreRunResult computes cost_vs_avg from prior history', () => {
    const priorHistory = [makeRunMetrics({ cost_usd: 2.0 })];
    const result = makeRunResult({ cost: 6.0 });
    const score = scoreRunResult(result, 0, 100, 'exploit', priorHistory);
    expect(score.cost_vs_avg).toBe(3.0); // 6.0 / 2.0
  });

  it('scoreBatch computes cost_vs_avg per run using rolling history', () => {
    const history: RunMetrics[] = [
      makeRunMetrics({ run: 1, cost_usd: 2.0 }),
      makeRunMetrics({ run: 2, cost_usd: 2.0 }),
      makeRunMetrics({ run: 3, cost_usd: 6.0 }),
    ];
    const score = scoreBatch(history);
    // Run 1: no prior history -> null
    expect(score.runs[0].cost_vs_avg).toBeNull();
    // Run 2: prior = [2.0], avg = 2.0, cost = 2.0 -> 1.0
    expect(score.runs[1].cost_vs_avg).toBe(1.0);
    // Run 3: prior = [2.0, 2.0], avg = 2.0, cost = 6.0 -> 3.0
    expect(score.runs[2].cost_vs_avg).toBe(3.0);
  });

  it('scoreBatch counts cost anomalies', () => {
    const history: RunMetrics[] = [
      makeRunMetrics({ run: 1, cost_usd: 2.0 }),
      makeRunMetrics({ run: 2, cost_usd: 2.0 }),
      makeRunMetrics({ run: 3, cost_usd: 8.0 }), // 4x avg -> anomaly
    ];
    const score = scoreBatch(history);
    expect(score.cost_anomaly_count).toBe(1);
  });

  it('formatRunScoreLine includes cost_vs_avg when present', () => {
    const score = makeRunScore({ cost_vs_avg: 2.5 });
    const line = formatRunScoreLine(score);
    expect(line).toContain('2.5x avg');
  });

  it('formatRunScoreLine omits cost_vs_avg when null', () => {
    const score = makeRunScore({ cost_vs_avg: null });
    const line = formatRunScoreLine(score);
    expect(line).not.toContain('x avg');
  });

  it('formatBatchScoreTable shows anomaly count when nonzero', () => {
    const score: BatchScore = {
      total_runs: 2,
      successful_runs: 2,
      success_rate: 1.0,
      total_cost_usd: 10.0,
      total_prs: 2,
      total_issues_closed: 2,
      total_duration_seconds: 600,
      total_lines_deleted: 0,
      total_issues_pruned: 0,
      avg_cost_per_success: 5.0,
      avg_duration_seconds: 300,
      overall_efficiency: 0.2,
      runs: [],
      mode_breakdown: [],
      cost_anomaly_count: 2,
      mode_diversity: 0,
      trend: null,
    };
    const table = formatBatchScoreTable(score);
    expect(table).toContain('| **Cost anomalies** | 2 runs >= 2x avg |');
  });

  it('formatBatchScoreTable omits anomaly row when zero', () => {
    const score: BatchScore = {
      total_runs: 2,
      successful_runs: 2,
      success_rate: 1.0,
      total_cost_usd: 4.0,
      total_prs: 2,
      total_issues_closed: 2,
      total_duration_seconds: 600,
      total_lines_deleted: 0,
      total_issues_pruned: 0,
      avg_cost_per_success: 2.0,
      avg_duration_seconds: 300,
      overall_efficiency: 0.5,
      runs: [],
      mode_breakdown: [],
      cost_anomaly_count: 0,
      mode_diversity: 0,
      trend: null,
    };
    const table = formatBatchScoreTable(score);
    expect(table).not.toContain('Cost anomalies');
  });
});

describe('computeBatchTrend', () => {
  function makeScore(overrides: Partial<RunScore> = {}): RunScore {
    return {
      success: true,
      cost_usd: 2.0,
      tool_calls: 40,
      pr_count: 1,
      issues_closed_count: 1,
      issues_filed_count: 0,
      duration_seconds: 300,
      efficiency: 0.5,
      cost_per_pr: 2.0,
      stop_requested: false,
      mode: 'exploit',
      lines_deleted: 0,
      issues_pruned: 0,
      cost_vs_avg: null,
      failure_class: 'success',
      ...overrides,
    };
  }

  it('returns null for fewer than 4 runs', () => {
    expect(computeBatchTrend([])).toBeNull();
    expect(computeBatchTrend([makeScore()])).toBeNull();
    expect(computeBatchTrend([makeScore(), makeScore(), makeScore()])).toBeNull();
  });

  it('returns stable summary when all runs are identical', () => {
    const runs = Array.from({ length: 6 }, () => makeScore());
    const trend = computeBatchTrend(runs)!;
    expect(trend).not.toBeNull();
    expect(trend.cost_slope).toBe(0);
    expect(trend.efficiency_slope).toBe(0);
    expect(trend.duration_slope).toBe(0);
    expect(trend.first_half_success_rate).toBe(1);
    expect(trend.second_half_success_rate).toBe(1);
    expect(trend.summary).toBe('stable across batch');
  });

  it('detects increasing cost trend', () => {
    const runs = [
      makeScore({ cost_usd: 1.0 }),
      makeScore({ cost_usd: 2.0 }),
      makeScore({ cost_usd: 3.0 }),
      makeScore({ cost_usd: 4.0 }),
    ];
    const trend = computeBatchTrend(runs)!;
    expect(trend.cost_slope).toBeCloseTo(1.0);
    expect(trend.summary).toContain('costs increasing');
  });

  it('detects decreasing cost trend', () => {
    const runs = [
      makeScore({ cost_usd: 4.0 }),
      makeScore({ cost_usd: 3.0 }),
      makeScore({ cost_usd: 2.0 }),
      makeScore({ cost_usd: 1.0 }),
    ];
    const trend = computeBatchTrend(runs)!;
    expect(trend.cost_slope).toBeCloseTo(-1.0);
    expect(trend.summary).toContain('costs decreasing');
  });

  it('detects declining success rate in second half', () => {
    const runs = [
      makeScore({ success: true }),
      makeScore({ success: true }),
      makeScore({ success: false }),
      makeScore({ success: false }),
    ];
    const trend = computeBatchTrend(runs)!;
    expect(trend.first_half_success_rate).toBe(1);
    expect(trend.second_half_success_rate).toBe(0);
    expect(trend.summary).toContain('success rate declining');
  });

  it('detects improving success rate in second half', () => {
    const runs = [
      makeScore({ success: false }),
      makeScore({ success: false }),
      makeScore({ success: true }),
      makeScore({ success: true }),
    ];
    const trend = computeBatchTrend(runs)!;
    expect(trend.first_half_success_rate).toBe(0);
    expect(trend.second_half_success_rate).toBe(1);
    expect(trend.summary).toContain('success rate improving');
  });

  it('detects runs getting longer', () => {
    const runs = [
      makeScore({ duration_seconds: 100 }),
      makeScore({ duration_seconds: 200 }),
      makeScore({ duration_seconds: 300 }),
      makeScore({ duration_seconds: 400 }),
    ];
    const trend = computeBatchTrend(runs)!;
    expect(trend.duration_slope).toBeCloseTo(100);
    expect(trend.summary).toContain('runs getting longer');
  });

  it('detects efficiency improvement', () => {
    const runs = [
      makeScore({ efficiency: 0.1 }),
      makeScore({ efficiency: 0.2 }),
      makeScore({ efficiency: 0.3 }),
      makeScore({ efficiency: 0.4 }),
    ];
    const trend = computeBatchTrend(runs)!;
    expect(trend.efficiency_slope).toBeCloseTo(0.1);
    expect(trend.summary).toContain('efficiency improving');
  });
});

describe('scoreBatch trend integration', () => {
  it('scoreBatch includes trend for batches with 4+ runs', () => {
    const history: RunMetrics[] = Array.from({ length: 5 }, (_, i) =>
      makeRunMetrics({ run: i + 1 }),
    );
    const score = scoreBatch(history);
    expect(score.trend).not.toBeNull();
    expect(score.trend!.summary).toBeDefined();
  });

  it('scoreBatch returns null trend for small batches', () => {
    const history = [makeRunMetrics(), makeRunMetrics()];
    const score = scoreBatch(history);
    expect(score.trend).toBeNull();
  });
});

describe('formatBatchScoreTable trend integration', () => {
  it('includes trend line when trend is present', () => {
    const score: BatchScore = {
      total_runs: 5,
      successful_runs: 5,
      success_rate: 1.0,
      total_cost_usd: 10.0,
      total_prs: 5,
      total_issues_closed: 5,
      total_duration_seconds: 1500,
      total_lines_deleted: 0,
      total_issues_pruned: 0,
      avg_cost_per_success: 2.0,
      avg_duration_seconds: 300,
      overall_efficiency: 0.5,
      runs: [],
      mode_breakdown: [],
      cost_anomaly_count: 0,
      mode_diversity: 0,
      trend: {
        cost_slope: 0.5,
        first_half_success_rate: 1.0,
        second_half_success_rate: 0.8,
        efficiency_slope: -0.01,
        duration_slope: 5,
        summary: 'costs increasing (+$0.50/run)',
      },
    };
    const table = formatBatchScoreTable(score);
    expect(table).toContain('| **Trend** | costs increasing (+$0.50/run) |');
  });

  it('omits trend line when trend is null', () => {
    const score: BatchScore = {
      total_runs: 2,
      successful_runs: 2,
      success_rate: 1.0,
      total_cost_usd: 4.0,
      total_prs: 2,
      total_issues_closed: 2,
      total_duration_seconds: 600,
      total_lines_deleted: 0,
      total_issues_pruned: 0,
      avg_cost_per_success: 2.0,
      avg_duration_seconds: 300,
      overall_efficiency: 0.5,
      runs: [],
      mode_breakdown: [],
      cost_anomaly_count: 0,
      mode_diversity: 0,
      trend: null,
    };
    const table = formatBatchScoreTable(score);
    expect(table).not.toContain('Trend');
  });
});

describe('classifyFailure', () => {
  it('classifies successful run with PRs as success', () => {
    expect(classifyFailure(makeRunMetrics({ exit_code: 0, prs: ['pr1'] }))).toBe('success');
  });

  it('classifies exit 0 with no artifacts as empty_success', () => {
    expect(classifyFailure(makeRunMetrics({ exit_code: 0, prs: [], issues_filed: [], issues_closed: [] }))).toBe('empty_success');
  });

  it('classifies exit 0 with issues filed as success', () => {
    expect(classifyFailure(makeRunMetrics({ exit_code: 0, prs: [], issues_filed: ['#1'], issues_closed: [] }))).toBe('success');
  });

  it('classifies non-zero exit as crash by default', () => {
    expect(classifyFailure(makeRunMetrics({ exit_code: 1, prs: [] }))).toBe('crash');
  });

  it('classifies hook rejection from log', () => {
    expect(classifyFailure(
      makeRunMetrics({ exit_code: 1, prs: [] }),
      'Error: hook rejected the commit',
    )).toBe('hook_rejection');
  });

  it('classifies infrastructure failure from log', () => {
    expect(classifyFailure(
      makeRunMetrics({ exit_code: 1, prs: [] }),
      'fatal: unable to access remote',
    )).toBe('infrastructure');
  });

  it('classifies timeout from log', () => {
    expect(classifyFailure(
      makeRunMetrics({ exit_code: 1, prs: [] }),
      'process timed out after 300s',
    )).toBe('timeout');
  });

  it('classifies scope overflow from log', () => {
    expect(classifyFailure(
      makeRunMetrics({ exit_code: 1, prs: [] }),
      'context limit exceeded, too many changes',
    )).toBe('scope_overflow');
  });

  it('classifies issue blocked from log', () => {
    expect(classifyFailure(
      makeRunMetrics({ exit_code: 1, prs: [] }),
      'issue blocked by dependency',
    )).toBe('issue_blocked');
  });

  it('classifies contemplate run with no artifacts as success (#631)', () => {
    expect(classifyFailure(
      makeRunMetrics({ exit_code: 0, prs: [], issues_filed: [], issues_closed: [], mode: 'contemplate' }),
    )).toBe('success');
  });

  it('classifies reflect run with no artifacts as success (#631)', () => {
    expect(classifyFailure(
      makeRunMetrics({ exit_code: 0, prs: [], issues_filed: [], issues_closed: [], mode: 'reflect' }),
    )).toBe('success');
  });

  it('still classifies non-zero contemplate run as crash', () => {
    expect(classifyFailure(
      makeRunMetrics({ exit_code: 1, prs: [], mode: 'contemplate' }),
    )).toBe('crash');
  });
});

describe('failureClassLabel', () => {
  it('returns compact labels for each class', () => {
    expect(failureClassLabel('success')).toBe('ok');
    expect(failureClassLabel('empty_success')).toBe('empty');
    expect(failureClassLabel('crash')).toBe('crash');
    expect(failureClassLabel('hook_rejection')).toBe('hook');
    expect(failureClassLabel('infrastructure')).toBe('infra');
    expect(failureClassLabel('timeout')).toBe('timeout');
    expect(failureClassLabel('unknown')).toBe('???');
  });
});

describe('failureClassDistribution', () => {
  it('counts failure classes', () => {
    const dist = failureClassDistribution(['success', 'crash', 'crash', 'empty_success']);
    expect(dist.success).toBe(1);
    expect(dist.crash).toBe(2);
    expect(dist.empty_success).toBe(1);
  });
});

describe('formatFailureDistribution', () => {
  it('formats distribution sorted by count', () => {
    const result = formatFailureDistribution(['crash', 'crash', 'success', 'empty_success']);
    expect(result).toBe('crash:2, success:1, empty_success:1');
  });

  it('returns empty string for empty array', () => {
    expect(formatFailureDistribution([])).toBe('');
  });
});
