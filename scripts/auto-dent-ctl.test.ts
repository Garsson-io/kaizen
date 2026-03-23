import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  formatBatchStatus,
  formatLastState,
  formatBatchScoreOutput,
  checkBatchHealth,
  runWatchdog,
  formatWatchdogResult,
  buildBatchReflection,
  formatBatchReflection,
  formatBatchReflectionComment,
  buildReflectionTemplateVars,
  buildAggregateBatchRecord,
  appendBatchToAggregate,
  readAggregate,
  computeAggregateStats,
  formatAggregateStats,
  DEFAULT_WATCHDOG_THRESHOLD_SEC,
  type BatchInfo,
  type WatchdogResult,
  type AggregateBatchRecord,
} from './auto-dent-ctl.js';
import type { BatchState, RunMetrics } from './auto-dent-run.js';

function makeBatchState(overrides: Partial<BatchState> = {}): BatchState {
  return {
    batch_id: 'batch-260322-2100-a1b2',
    batch_start: 1742680800,
    guidance: 'improve hooks reliability',
    max_runs: 5,
    cooldown: 30,
    budget: '3.00',
    max_failures: 3,
    kaizen_repo: 'Garsson-io/kaizen',
    host_repo: 'Garsson-io/kaizen',
    run: 0,
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
    ...overrides,
  };
}

function makeBatchInfo(overrides: Partial<BatchInfo> = {}): BatchInfo {
  return {
    batchId: 'batch-260322-2100-a1b2',
    dir: '/tmp/test',
    state: makeBatchState(),
    active: true,
    halted: false,
    ...overrides,
  };
}

describe('formatBatchStatus', () => {
  it('shows basic batch info', () => {
    const info = makeBatchInfo();
    const output = formatBatchStatus(info);
    expect(output).toContain('batch-260322-2100-a1b2');
    expect(output).toContain('RUNNING');
    expect(output).toContain('improve hooks reliability');
  });

  it('shows HALT REQUESTED when halted', () => {
    const info = makeBatchInfo({ halted: true });
    const output = formatBatchStatus(info);
    expect(output).toContain('HALT REQUESTED');
  });

  it('shows stop reason when inactive', () => {
    const info = makeBatchInfo({
      active: false,
      state: makeBatchState({ stop_reason: 'max runs reached' }),
    });
    const output = formatBatchStatus(info);
    expect(output).toContain('max runs reached');
  });

  it('shows total cost from run_history', () => {
    const info = makeBatchInfo({
      state: makeBatchState({
        run: 2,
        run_history: [
          {
            run: 1,
            start_epoch: 1742680800,
            duration_seconds: 300,
            exit_code: 0,
            cost_usd: 2.5,
            tool_calls: 42,
            prs: [],
            issues_filed: [],
            issues_closed: [],
            cases: [],
            stop_requested: false,
          },
          {
            run: 2,
            start_epoch: 1742681400,
            duration_seconds: 450,
            exit_code: 0,
            cost_usd: 3.1,
            tool_calls: 60,
            prs: ['https://github.com/Garsson-io/kaizen/pull/500'],
            issues_filed: [],
            issues_closed: ['#451'],
            cases: [],
            stop_requested: false,
          },
        ],
      }),
    });
    const output = formatBatchStatus(info);
    expect(output).toContain('$5.60');
  });

  it('shows per-run metrics breakdown when run_history exists', () => {
    const info = makeBatchInfo({
      state: makeBatchState({
        run: 2,
        run_history: [
          {
            run: 1,
            start_epoch: 1742680800,
            duration_seconds: 185,
            exit_code: 0,
            cost_usd: 2.5,
            tool_calls: 42,
            prs: [],
            issues_filed: [],
            issues_closed: [],
            cases: [],
            stop_requested: false,
          },
          {
            run: 2,
            start_epoch: 1742681400,
            duration_seconds: 450,
            exit_code: 1,
            cost_usd: 3.1,
            tool_calls: 60,
            prs: ['https://github.com/Garsson-io/kaizen/pull/500'],
            issues_filed: [],
            issues_closed: ['#451'],
            cases: [],
            stop_requested: true,
          },
        ],
      }),
    });
    const output = formatBatchStatus(info);
    expect(output).toContain('#1: 3m5s $2.50 42tc ok');
    expect(output).toContain('#2: 7m30s $3.10 60tc exit 1');
    expect(output).toContain('1PR');
    expect(output).toContain('STOP');
  });

  it('omits per-run section when no run_history', () => {
    const info = makeBatchInfo();
    const output = formatBatchStatus(info);
    // Per-run lines look like "    #1: 3m5s ..." — indented with run number
    expect(output).not.toMatch(/^\s+#\d+:/m);
  });

  it('shows last-worked-on fields when present', () => {
    const info = makeBatchInfo({
      state: makeBatchState({
        last_pr: 'https://github.com/Garsson-io/kaizen/pull/500',
        last_issue: '#451',
      }),
    });
    const output = formatBatchStatus(info);
    expect(output).toContain('Last PR:');
    expect(output).toContain('pull/500');
    expect(output).toContain('Last issue:');
    expect(output).toContain('#451');
  });
});

describe('formatLastState', () => {
  it('shows batch and run info', () => {
    const state = makeBatchState({ run: 3 });
    const output = formatLastState(state);
    expect(output).toContain('batch-260322-2100-a1b2');
    expect(output).toContain('3');
  });

  it('shows no artifacts message when nothing tracked', () => {
    const state = makeBatchState();
    const output = formatLastState(state);
    expect(output).toContain('no artifacts tracked yet');
  });

  it('shows last PR when present', () => {
    const state = makeBatchState({
      last_pr: 'https://github.com/Garsson-io/kaizen/pull/500',
    });
    const output = formatLastState(state);
    expect(output).toContain('pull/500');
  });
});

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

describe('formatBatchScoreOutput', () => {
  it('returns no-history message when run_history is empty', () => {
    const batch = makeBatchInfo();
    const output = formatBatchScoreOutput(batch);
    expect(output).toContain('no run history to score');
  });

  it('shows batch score table for a batch with runs', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 2,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 2.5, prs: ['https://github.com/Garsson-io/kaizen/pull/500'] }),
          makeRunMetrics({ run: 2, cost_usd: 3.0, prs: [], exit_code: 1 }),
        ],
      }),
    });
    const output = formatBatchScoreOutput(batch);
    expect(output).toContain('batch-260322-2100-a1b2');
    expect(output).toContain('Success rate');
    expect(output).toContain('50%');
    expect(output).toContain('Total cost');
    expect(output).toContain('$5.50');
    expect(output).toContain('Total PRs');
  });

  it('shows per-run score lines', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 2,
        run_history: [
          makeRunMetrics({ run: 1 }),
          makeRunMetrics({ run: 2, cost_usd: 1.0, prs: [], exit_code: 0 }),
        ],
      }),
    });
    const output = formatBatchScoreOutput(batch);
    expect(output).toContain('#1: pass');
    expect(output).toContain('#2: fail');
  });

  it('shows efficiency metric for successful runs', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 1,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/500'] }),
        ],
      }),
    });
    const output = formatBatchScoreOutput(batch);
    expect(output).toContain('Efficiency');
    expect(output).toContain('PR/$');
  });

  it('does not include post-hoc section when postHoc=false', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 1,
        prs: ['https://github.com/Garsson-io/kaizen/pull/500'],
        run_history: [makeRunMetrics({ run: 1 })],
      }),
    });
    const output = formatBatchScoreOutput(batch, false);
    expect(output).not.toContain('Post-hoc merge status');
  });
});

describe('checkBatchHealth', () => {
  const NOW = 1742680800;
  const THRESHOLD = 600;

  it('reports healthy when heartbeat is within threshold', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({ last_heartbeat: NOW - 300 }),
    });
    const result = checkBatchHealth(batch, THRESHOLD, NOW);
    expect(result.action).toBe('healthy');
    expect(result.stale).toBe(false);
    expect(result.heartbeatAge).toBe(300);
  });

  it('reports stale when heartbeat exceeds threshold', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({ last_heartbeat: NOW - 700 }),
    });
    const result = checkBatchHealth(batch, THRESHOLD, NOW);
    expect(result.action).toBe('halt_created');
    expect(result.stale).toBe(true);
    expect(result.heartbeatAge).toBe(700);
  });

  it('reports already_halted when stale but halt file exists', () => {
    const batch = makeBatchInfo({
      halted: true,
      state: makeBatchState({ last_heartbeat: NOW - 700 }),
    });
    const result = checkBatchHealth(batch, THRESHOLD, NOW);
    expect(result.action).toBe('already_halted');
    expect(result.stale).toBe(true);
  });

  it('reports no_heartbeat when heartbeat is 0', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({ last_heartbeat: 0 }),
    });
    const result = checkBatchHealth(batch, THRESHOLD, NOW);
    expect(result.action).toBe('no_heartbeat');
    expect(result.heartbeatAge).toBe(0);
    expect(result.stale).toBe(false);
  });

  it('reports no_heartbeat when heartbeat is undefined', () => {
    const state = makeBatchState();
    delete (state as any).last_heartbeat;
    const batch = makeBatchInfo({ state });
    const result = checkBatchHealth(batch, THRESHOLD, NOW);
    expect(result.action).toBe('no_heartbeat');
  });

  it('uses exact threshold boundary correctly', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({ last_heartbeat: NOW - 600 }),
    });
    const result = checkBatchHealth(batch, THRESHOLD, NOW);
    expect(result.action).toBe('healthy');

    const batch2 = makeBatchInfo({
      state: makeBatchState({ last_heartbeat: NOW - 601 }),
    });
    const result2 = checkBatchHealth(batch2, THRESHOLD, NOW);
    expect(result2.action).toBe('halt_created');
  });
});

describe('runWatchdog', () => {
  it('creates HALT file for stale batch', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'watchdog-test-'));
    const batchDir = join(tmpDir, 'batch-test-001');
    require('fs').mkdirSync(batchDir);
    const state = makeBatchState({
      batch_id: 'batch-test-001',
      last_heartbeat: 1000,
    });
    writeFileSync(join(batchDir, 'state.json'), JSON.stringify(state));

    const results = runWatchdog(tmpDir, 600, 2000);
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('halt_created');
    expect(existsSync(join(batchDir, 'HALT'))).toBe(true);
  });

  it('does not create HALT file for healthy batch', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'watchdog-test-'));
    const batchDir = join(tmpDir, 'batch-test-002');
    require('fs').mkdirSync(batchDir);
    const state = makeBatchState({
      batch_id: 'batch-test-002',
      last_heartbeat: 1800,
    });
    writeFileSync(join(batchDir, 'state.json'), JSON.stringify(state));

    const results = runWatchdog(tmpDir, 600, 2000);
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('healthy');
    expect(existsSync(join(batchDir, 'HALT'))).toBe(false);
  });

  it('skips stopped batches', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'watchdog-test-'));
    const batchDir = join(tmpDir, 'batch-stopped');
    require('fs').mkdirSync(batchDir);
    const state = makeBatchState({
      batch_id: 'batch-stopped',
      last_heartbeat: 100,
      stop_reason: 'completed',
    });
    writeFileSync(join(batchDir, 'state.json'), JSON.stringify(state));

    const results = runWatchdog(tmpDir, 600, 2000);
    expect(results.length).toBe(0);
  });

  it('returns empty array when no batches exist', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'watchdog-test-'));
    const results = runWatchdog(tmpDir, 600, 2000);
    expect(results.length).toBe(0);
  });
});

describe('formatWatchdogResult', () => {
  it('formats halt_created result', () => {
    const r: WatchdogResult = {
      batchId: 'batch-001',
      heartbeatAge: 750,
      stale: true,
      halted: false,
      action: 'halt_created',
    };
    const output = formatWatchdogResult(r);
    expect(output).toContain('STALE');
    expect(output).toContain('batch-001');
    expect(output).toContain('12m30s');
    expect(output).toContain('HALT file created');
  });

  it('formats healthy result', () => {
    const r: WatchdogResult = {
      batchId: 'batch-002',
      heartbeatAge: 120,
      stale: false,
      halted: false,
      action: 'healthy',
    };
    const output = formatWatchdogResult(r);
    expect(output).toContain('OK');
    expect(output).toContain('2m0s');
  });

  it('formats no_heartbeat result', () => {
    const r: WatchdogResult = {
      batchId: 'batch-003',
      heartbeatAge: 0,
      stale: false,
      halted: false,
      action: 'no_heartbeat',
    };
    const output = formatWatchdogResult(r);
    expect(output).toContain('SKIP');
    expect(output).toContain('no heartbeat');
  });

  it('formats already_halted result', () => {
    const r: WatchdogResult = {
      batchId: 'batch-004',
      heartbeatAge: 900,
      stale: true,
      halted: true,
      action: 'already_halted',
    };
    const output = formatWatchdogResult(r);
    expect(output).toContain('STALE');
    expect(output).toContain('already halted');
  });
});

describe('buildBatchReflection', () => {
  it('returns empty insights for batch with no run history', () => {
    const batch = makeBatchInfo();
    const reflection = buildBatchReflection(batch);
    expect(reflection.runCount).toBe(0);
    expect(reflection.insights).toEqual([]);
  });

  it('computes correct totals from run history', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 3,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/100'], issues_closed: ['#10'] }),
          makeRunMetrics({ run: 2, cost_usd: 3.0, prs: ['https://github.com/Garsson-io/kaizen/pull/101'], issues_closed: ['#11', '#12'] }),
          makeRunMetrics({ run: 3, cost_usd: 1.5, prs: [], exit_code: 1, issues_closed: [] }),
        ],
      }),
    });
    const reflection = buildBatchReflection(batch);
    expect(reflection.runCount).toBe(3);
    expect(reflection.totalCost).toBeCloseTo(6.5);
    expect(reflection.totalPrs).toBe(2);
    expect(reflection.issuesClosedCount).toBe(3);
    expect(reflection.successRate).toBeCloseTo(2 / 3);
    expect(reflection.avgCostPerPr).toBeCloseTo(3.25);
  });

  it('detects high success rate pattern', () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      makeRunMetrics({ run: i + 1, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/' + (100 + i)] }),
    );
    const batch = makeBatchInfo({
      state: makeBatchState({ run: 5, run_history: runs }),
    });
    const reflection = buildBatchReflection(batch);
    const successInsight = reflection.insights.find((i) => i.type === 'success_pattern' && i.message.includes('success rate'));
    expect(successInsight).toBeDefined();
    expect(successInsight!.message).toContain('100%');
  });

  it('detects low success rate pattern', () => {
    const runs = Array.from({ length: 4 }, (_, i) =>
      makeRunMetrics({ run: i + 1, cost_usd: 2.0, prs: [], exit_code: 1 }),
    );
    const batch = makeBatchInfo({
      state: makeBatchState({ run: 4, run_history: runs }),
    });
    const reflection = buildBatchReflection(batch);
    const failInsight = reflection.insights.find((i) => i.type === 'failure_pattern' && i.message.includes('success rate'));
    expect(failInsight).toBeDefined();
    expect(failInsight!.message).toContain('0%');
  });

  it('detects expensive failures', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 3,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 1.0, prs: ['https://github.com/Garsson-io/kaizen/pull/100'] }),
          makeRunMetrics({ run: 2, cost_usd: 1.0, prs: ['https://github.com/Garsson-io/kaizen/pull/101'] }),
          makeRunMetrics({ run: 3, cost_usd: 5.0, prs: [], exit_code: 1 }),
        ],
      }),
    });
    const reflection = buildBatchReflection(batch);
    const effInsight = reflection.insights.find((i) => i.type === 'efficiency' && i.message.includes('Expensive failures'));
    expect(effInsight).toBeDefined();
    expect(effInsight!.message).toContain('#3');
  });

  it('detects consecutive failures', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 4,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/100'] }),
          makeRunMetrics({ run: 2, cost_usd: 2.0, prs: [], exit_code: 1 }),
          makeRunMetrics({ run: 3, cost_usd: 2.0, prs: [], exit_code: 1 }),
          makeRunMetrics({ run: 4, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/101'] }),
        ],
      }),
    });
    const reflection = buildBatchReflection(batch);
    const consecInsight = reflection.insights.find((i) => i.message.includes('consecutive failures'));
    expect(consecInsight).toBeDefined();
    expect(consecInsight!.message).toContain('2');
  });

  it('detects stop signal pattern', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 3,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/100'], stop_requested: false }),
          makeRunMetrics({ run: 2, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/101'], stop_requested: true }),
          makeRunMetrics({ run: 3, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/102'], stop_requested: false }),
        ],
      }),
    });
    const reflection = buildBatchReflection(batch);
    const stopInsight = reflection.insights.find((i) => i.message.includes('stop signals'));
    expect(stopInsight).toBeDefined();
  });

  it('builds run history table', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 2,
        run_history: [
          makeRunMetrics({ run: 1, duration_seconds: 300, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/100'] }),
          makeRunMetrics({ run: 2, duration_seconds: 180, cost_usd: 1.5, prs: [], exit_code: 0 }),
        ],
      }),
    });
    const reflection = buildBatchReflection(batch);
    expect(reflection.runHistoryTable).toContain('| Run |');
    expect(reflection.runHistoryTable).toContain('| #1 |');
    expect(reflection.runHistoryTable).toContain('| #2 |');
    expect(reflection.runHistoryTable).toContain('5m0s');
    expect(reflection.runHistoryTable).toContain('$2.00');
  });
});

describe('formatBatchReflection', () => {
  it('formats basic reflection output', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 3,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/100'] }),
          makeRunMetrics({ run: 2, cost_usd: 3.0, prs: ['https://github.com/Garsson-io/kaizen/pull/101'] }),
          makeRunMetrics({ run: 3, cost_usd: 1.5, prs: [], exit_code: 1 }),
        ],
      }),
    });
    const reflection = buildBatchReflection(batch);
    const output = formatBatchReflection(reflection);
    expect(output).toContain('Batch: batch-260322-2100-a1b2');
    expect(output).toContain('Runs: 3');
    expect(output).toContain('PRs: 2');
    expect(output).toContain('Insights:');
  });

  it('shows no-patterns message when too few runs', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 1,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/100'] }),
        ],
      }),
    });
    const reflection = buildBatchReflection(batch);
    const output = formatBatchReflection(reflection);
    expect(output).toContain('No significant patterns');
  });
});

describe('formatBatchReflectionComment', () => {
  it('formats reflection as a GitHub-friendly markdown comment', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 5,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/100'], issues_closed: ['#10'] }),
          makeRunMetrics({ run: 2, cost_usd: 3.0, prs: ['https://github.com/Garsson-io/kaizen/pull/101'], issues_closed: ['#11'] }),
          makeRunMetrics({ run: 3, cost_usd: 1.5, prs: [], exit_code: 1, issues_closed: [] }),
          makeRunMetrics({ run: 4, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/102'], issues_closed: ['#12'] }),
          makeRunMetrics({ run: 5, cost_usd: 2.5, prs: ['https://github.com/Garsson-io/kaizen/pull/103'], issues_closed: [] }),
        ],
      }),
    });
    const reflection = buildBatchReflection(batch);
    const comment = formatBatchReflectionComment(reflection);

    expect(comment).toContain('### Mid-Batch Reflection (after run 5)');
    expect(comment).toContain('| **Success rate** |');
    expect(comment).toContain('80%');
    expect(comment).toContain('| **Total cost** |');
    expect(comment).toContain('$11.00');
    expect(comment).toContain('| **PRs created** | 4 |');
    expect(comment).toContain('| **Issues closed** | 3 |');
    expect(comment).toContain('| **Avg cost/run** | $2.20 |');
    expect(comment).toContain('**Insights:**');
  });

  it('shows no patterns message when insights are empty', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 1,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/100'] }),
        ],
      }),
    });
    const reflection = buildBatchReflection(batch);
    const comment = formatBatchReflectionComment(reflection);

    expect(comment).toContain('### Mid-Batch Reflection (after run 1)');
    expect(comment).toContain('No significant patterns detected yet');
  });

  it('includes avg cost/PR when there are PRs', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 3,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/100'] }),
          makeRunMetrics({ run: 2, cost_usd: 4.0, prs: ['https://github.com/Garsson-io/kaizen/pull/101'] }),
          makeRunMetrics({ run: 3, cost_usd: 3.0, prs: [], exit_code: 1 }),
        ],
      }),
    });
    const reflection = buildBatchReflection(batch);
    const comment = formatBatchReflectionComment(reflection);

    expect(comment).toContain('| **Avg cost/PR** | $4.50 |');
  });

  it('shows N/A for avg cost/PR when no PRs', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 2,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 2.0, prs: [], exit_code: 1 }),
          makeRunMetrics({ run: 2, cost_usd: 3.0, prs: [], exit_code: 1 }),
        ],
      }),
    });
    const reflection = buildBatchReflection(batch);
    const comment = formatBatchReflectionComment(reflection);

    expect(comment).toContain('| **Avg cost/PR** | N/A |');
  });
});

describe('buildReflectionTemplateVars', () => {
  it('builds template variables from reflection and state', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 3,
        prs: ['https://github.com/Garsson-io/kaizen/pull/100', 'https://github.com/Garsson-io/kaizen/pull/101'],
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/100'] }),
          makeRunMetrics({ run: 2, cost_usd: 3.0, prs: ['https://github.com/Garsson-io/kaizen/pull/101'] }),
          makeRunMetrics({ run: 3, cost_usd: 1.5, prs: [], exit_code: 1 }),
        ],
      }),
    });
    const reflection = buildBatchReflection(batch);
    const vars = buildReflectionTemplateVars(reflection, batch.state);

    expect(vars.batch_id).toBe('batch-260322-2100-a1b2');
    expect(vars.guidance).toBe('improve hooks reliability');
    expect(vars.run_count).toBe('3');
    expect(vars.total_cost).toContain('6.50');
    expect(vars.pr_count).toBe('2');
    expect(vars.run_history_table).toContain('| Run |');
    expect(vars.pr_merge_status).toContain('pull/100');
    expect(vars.reflection_insights).toContain('[');
  });

  it('returns empty pr_merge_status when no PRs', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 1,
        prs: [],
        run_history: [makeRunMetrics({ run: 1 })],
      }),
    });
    const reflection = buildBatchReflection(batch);
    const vars = buildReflectionTemplateVars(reflection, batch.state);
    expect(vars.pr_merge_status).toBe('');
  });
});

// Cross-batch aggregate tests (#586)

describe('buildAggregateBatchRecord', () => {
  it('builds a record from a batch with run history', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        batch_end: 1742684400,
        run: 3,
        prs: ['https://github.com/Garsson-io/kaizen/pull/500', 'https://github.com/Garsson-io/kaizen/pull/501'],
        issues_filed: ['#600'],
        issues_closed: ['#451', '#452'],
        stop_reason: 'max runs reached',
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/500'], mode: 'exploit' }),
          makeRunMetrics({ run: 2, cost_usd: 1.5, prs: [], exit_code: 1, mode: 'explore' }),
          makeRunMetrics({ run: 3, cost_usd: 3.0, prs: ['https://github.com/Garsson-io/kaizen/pull/501'], mode: 'exploit' }),
        ],
      }),
    });

    const record = buildAggregateBatchRecord(batch);

    expect(record.batch_id).toBe('batch-260322-2100-a1b2');
    expect(record.total_runs).toBe(3);
    expect(record.successful_runs).toBe(2);
    expect(record.total_cost_usd).toBeCloseTo(6.5);
    expect(record.total_prs).toBe(2);
    expect(record.total_issues_closed).toBe(3); // from run metrics, not batch state
    expect(record.stop_reason).toBe('max runs reached');
    expect(record.mode_breakdown).toHaveProperty('exploit');
    expect(record.mode_breakdown).toHaveProperty('explore');
    expect(record.mode_breakdown.exploit.runs).toBe(2);
    expect(record.mode_breakdown.exploit.successes).toBe(2);
    expect(record.mode_breakdown.explore.runs).toBe(1);
    expect(record.mode_breakdown.explore.successes).toBe(0);
    expect(record.prs).toEqual(['https://github.com/Garsson-io/kaizen/pull/500', 'https://github.com/Garsson-io/kaizen/pull/501']);
    expect(record.recorded_at).toBeTruthy();
  });

  it('handles batch with no run history', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({ run_history: undefined }),
    });
    const record = buildAggregateBatchRecord(batch);
    expect(record.total_runs).toBe(0);
    expect(record.success_rate).toBe(0);
    expect(record.total_cost_usd).toBe(0);
  });
});

describe('appendBatchToAggregate', () => {
  it('appends a record to a new aggregate file', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'agg-test-'));
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 1,
        run_history: [makeRunMetrics({ run: 1 })],
      }),
    });

    const result = appendBatchToAggregate(tmpDir, batch);
    expect(result.action).toBe('appended');

    const records = readAggregate(tmpDir);
    expect(records).toHaveLength(1);
    expect(records[0].batch_id).toBe('batch-260322-2100-a1b2');
  });

  it('skips duplicate batch IDs', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'agg-test-'));
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 1,
        run_history: [makeRunMetrics({ run: 1 })],
      }),
    });

    appendBatchToAggregate(tmpDir, batch);
    const result2 = appendBatchToAggregate(tmpDir, batch);
    expect(result2.action).toBe('already_exists');

    const records = readAggregate(tmpDir);
    expect(records).toHaveLength(1);
  });

  it('appends multiple different batches', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'agg-test-'));
    const batch1 = makeBatchInfo({
      batchId: 'batch-1',
      state: makeBatchState({
        batch_id: 'batch-1',
        run: 1,
        run_history: [makeRunMetrics({ run: 1 })],
      }),
    });
    const batch2 = makeBatchInfo({
      batchId: 'batch-2',
      state: makeBatchState({
        batch_id: 'batch-2',
        run: 2,
        run_history: [makeRunMetrics({ run: 1 }), makeRunMetrics({ run: 2 })],
      }),
    });

    appendBatchToAggregate(tmpDir, batch1);
    appendBatchToAggregate(tmpDir, batch2);

    const records = readAggregate(tmpDir);
    expect(records).toHaveLength(2);
    expect(records[0].batch_id).toBe('batch-1');
    expect(records[1].batch_id).toBe('batch-2');
  });
});

describe('readAggregate', () => {
  it('returns empty array for non-existent file', () => {
    const records = readAggregate('/tmp/non-existent-dir-12345');
    expect(records).toEqual([]);
  });

  it('skips malformed lines', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'agg-test-'));
    writeFileSync(
      join(tmpDir, 'aggregate.jsonl'),
      '{"batch_id":"b1","total_runs":1}\nnot json\n{"batch_id":"b2","total_runs":2}\n',
    );
    const records = readAggregate(tmpDir);
    expect(records).toHaveLength(2);
  });
});

describe('computeAggregateStats', () => {
  function makeRecord(overrides: Partial<AggregateBatchRecord> = {}): AggregateBatchRecord {
    return {
      batch_id: 'batch-test',
      guidance: 'test guidance',
      batch_start: 1742680800,
      batch_end: 1742684400,
      total_runs: 5,
      successful_runs: 3,
      success_rate: 0.6,
      total_cost_usd: 10.0,
      total_prs: 3,
      total_issues_closed: 2,
      total_issues_filed: 1,
      total_duration_seconds: 1500,
      stop_reason: 'completed',
      mode_breakdown: {
        exploit: { runs: 3, successes: 2, prs: 2, cost: 6.0 },
        explore: { runs: 2, successes: 1, prs: 1, cost: 4.0 },
      },
      issues_attempted: ['#451', '#452'],
      prs: [],
      recorded_at: '2026-03-22T00:00:00.000Z',
      ...overrides,
    };
  }

  it('computes stats across multiple batches', () => {
    const records = [
      makeRecord({ batch_id: 'b1', total_runs: 5, successful_runs: 3, total_cost_usd: 10, total_prs: 3 }),
      makeRecord({ batch_id: 'b2', total_runs: 3, successful_runs: 2, total_cost_usd: 6, total_prs: 2 }),
    ];
    const stats = computeAggregateStats(records);

    expect(stats.totalBatches).toBe(2);
    expect(stats.totalRuns).toBe(8);
    expect(stats.totalCost).toBeCloseTo(16);
    expect(stats.totalPrs).toBe(5);
    expect(stats.overallSuccessRate).toBeCloseTo(5 / 8);
    expect(stats.avgCostPerPr).toBeCloseTo(16 / 5);
  });

  it('aggregates mode effectiveness across batches', () => {
    const records = [
      makeRecord({
        batch_id: 'b1',
        mode_breakdown: { exploit: { runs: 3, successes: 2, prs: 2, cost: 6 } },
      }),
      makeRecord({
        batch_id: 'b2',
        mode_breakdown: { exploit: { runs: 2, successes: 1, prs: 1, cost: 4 } },
      }),
    ];
    const stats = computeAggregateStats(records);

    expect(stats.modeEffectiveness.exploit.runs).toBe(5);
    expect(stats.modeEffectiveness.exploit.successes).toBe(3);
    expect(stats.modeEffectiveness.exploit.prs).toBe(3);
    expect(stats.modeEffectiveness.exploit.successRate).toBeCloseTo(0.6);
  });

  it('handles empty records', () => {
    const stats = computeAggregateStats([]);
    expect(stats.totalBatches).toBe(0);
    expect(stats.overallSuccessRate).toBe(0);
    expect(stats.avgCostPerPr).toBe(0);
  });

  it('returns recent batches sorted by start time', () => {
    const records = [
      makeRecord({ batch_id: 'old', batch_start: 1000000 }),
      makeRecord({ batch_id: 'new', batch_start: 2000000 }),
    ];
    const stats = computeAggregateStats(records);
    expect(stats.recentBatches[0].batch_id).toBe('new');
    expect(stats.recentBatches[1].batch_id).toBe('old');
  });
});

describe('formatAggregateStats', () => {
  it('formats stats as human-readable text', () => {
    const stats = computeAggregateStats([{
      batch_id: 'b1',
      guidance: 'test',
      batch_start: 1742680800,
      batch_end: 1742684400,
      total_runs: 5,
      successful_runs: 3,
      success_rate: 0.6,
      total_cost_usd: 10,
      total_prs: 3,
      total_issues_closed: 2,
      total_issues_filed: 1,
      total_duration_seconds: 1500,
      stop_reason: 'completed',
      mode_breakdown: { exploit: { runs: 5, successes: 3, prs: 3, cost: 10 } },
      issues_attempted: [],
      prs: [],
      recorded_at: '2026-03-22T00:00:00.000Z',
    }]);

    const output = formatAggregateStats(stats);
    expect(output).toContain('Cross-Batch History');
    expect(output).toContain('Total batches');
    expect(output).toContain('$10.00');
    expect(output).toContain('60%');
    expect(output).toContain('Recent batches');
    expect(output).toContain('b1');
  });
});
