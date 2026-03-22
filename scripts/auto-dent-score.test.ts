import { describe, it, expect } from 'vitest';
import {
  scoreRunMetrics,
  scoreRunResult,
  scoreBatch,
  formatRunScoreLine,
  formatBatchScoreTable,
  type RunScore,
  type BatchScore,
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

  it('counts issues filed', () => {
    const score = scoreRunMetrics(
      makeRunMetrics({
        issues_filed: ['https://github.com/org/repo/issues/1', 'https://github.com/org/repo/issues/2'],
      }),
    );
    expect(score.issues_filed_count).toBe(2);
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
  it('formats a successful run score', () => {
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
    };
    const line = formatRunScoreLine(score);
    expect(line).toContain('pass');
    expect(line).toContain('$2.50');
    expect(line).toContain('42 tools');
    expect(line).toContain('1 PRs');
    expect(line).toContain('300s');
    expect(line).toContain('0.40 PR/$');
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
    };
    const line = formatRunScoreLine(score);
    expect(line).toContain('fail');
    expect(line).not.toContain('PR/$');
  });
});

describe('formatBatchScoreTable', () => {
  it('formats a batch score as markdown table', () => {
    const score: BatchScore = {
      total_runs: 3,
      successful_runs: 2,
      success_rate: 2 / 3,
      total_cost_usd: 6.0,
      total_prs: 3,
      total_issues_closed: 5,
      total_duration_seconds: 650,
      avg_cost_per_success: 3.0,
      avg_duration_seconds: 216.67,
      overall_efficiency: 0.5,
      runs: [],
    };
    const table = formatBatchScoreTable(score);
    expect(table).toContain('| **Runs** | 3 (2 successful) |');
    expect(table).toContain('| **Success rate** | 67% |');
    expect(table).toContain('| **Total cost** | $6.00 |');
    expect(table).toContain('| **Total PRs** | 3 |');
    expect(table).toContain('| **Issues closed** | 5 |');
    expect(table).toContain('| **Avg cost/success** | $3.00 |');
    expect(table).toContain('| **Efficiency** | 0.50 PR/$ |');
  });

  it('shows N/A for avg cost when no successes', () => {
    const score: BatchScore = {
      total_runs: 1,
      successful_runs: 0,
      success_rate: 0,
      total_cost_usd: 1.0,
      total_prs: 0,
      total_issues_closed: 0,
      total_duration_seconds: 50,
      avg_cost_per_success: NaN,
      avg_duration_seconds: 50,
      overall_efficiency: 0,
      runs: [],
    };
    const table = formatBatchScoreTable(score);
    expect(table).toContain('| **Avg cost/success** | N/A |');
    expect(table).toContain('| **Efficiency** | N/A |');
  });
});
