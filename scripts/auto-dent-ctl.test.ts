import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
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
  persistReflectionSummary,
  type PersistedReflection,
  buildAggregateBatchRecord,
  appendBatchToAggregate,
  readAggregate,
  computeAggregateStats,
  formatAggregateStats,
  buildSteerOutput,
  discoverBatches,
  DEFAULT_WATCHDOG_THRESHOLD_SEC,
  type BatchInfo,
  type WatchdogResult,
  type AggregateBatchRecord,
} from './auto-dent-ctl.js';
import type { DrySweepReport } from './auto-dent-dry-sweep.js';
import type { RunMetrics } from './auto-dent-run.js';
import { makeBatchState } from './auto-dent-test-utils.js';
import { checkpointRunState, writeState } from './auto-dent-run.js';

const AUTO_DENT_CTL_SOURCE = readFileSync(new URL('./auto-dent-ctl.ts', import.meta.url), 'utf8');

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

describe('discoverBatches', () => {
  it('uses the canonical auto-dent state reader with backup fallback (#1264)', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'ctl-state-test-'));
    try {
      const batchDir = join(logsDir, 'batch-corrupt-primary');
      const stateFile = join(batchDir, 'state.json');
      const state = makeBatchState({
        batch_id: 'batch-from-backup',
        guidance: 'fallback control state',
      });
      mkdirSync(batchDir, { recursive: true });
      writeFileSync(stateFile, '{corrupt json');
      writeFileSync(`${stateFile}.bak`, JSON.stringify(state));

      const batches = discoverBatches(logsDir);

      expect(batches).toHaveLength(1);
      expect(batches[0].batchId).toBe('batch-from-backup');
      expect(batches[0].state.guidance).toBe('fallback control state');

      const source = readFileSync(
        new URL('./auto-dent-ctl.ts', import.meta.url),
        'utf8',
      );
      expect(source).not.toContain("JSON.parse(readFileSync(stateFile, 'utf8'))");
      expect(source).toMatch(/readState,/);
      expect(source).toContain("from './auto-dent-run.js'");
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });
});

describe('watchdog live-run checkpoint reality proof', () => {
  it('classifies checkpointed active runs by heartbeat age instead of no_heartbeat', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'watchdog-checkpoint-'));
    try {
      const batchDir = join(logsDir, 'batch-live');
      mkdirSync(batchDir, { recursive: true });
      const stateFile = join(batchDir, 'state.json');
      writeState(stateFile, makeBatchState({
        batch_id: 'batch-live',
        run: 0,
        last_heartbeat: 0,
      }));

      checkpointRunState(stateFile, { runNum: 1, heartbeatEpoch: 1_742_680_900 });
      const [fresh] = runWatchdog(logsDir, 60, 1_742_680_930);
      const [stale] = runWatchdog(logsDir, 60, 1_742_681_100);

      expect(fresh).toMatchObject({
        batchId: 'batch-live',
        action: 'healthy',
        heartbeatAge: 30,
      });
      expect(stale).toMatchObject({
        batchId: 'batch-live',
        action: 'halt_created',
        heartbeatAge: 200,
      });
      expect(formatWatchdogResult(fresh)).not.toContain('no heartbeat recorded');
      expect(existsSync(join(batchDir, 'HALT'))).toBe(true);
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });
});

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
    // Run 2 has exit_code=0 and no PRs but has default issues_closed, so failure_class='success' (label 'ok')
    expect(output).toContain('#2: ok');
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

  it('shows hook activation health in score output', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 2,
        run_history: [
          makeRunMetrics({
            run: 1,
            hook_activation: {
              provider: 'claude',
              expected: true,
              active: true,
              degraded: false,
              status: 'active',
              observedPlugins: ['kaizen'],
              message: 'active',
            } as any,
          }),
          makeRunMetrics({
            run: 2,
            hook_activation: {
              provider: 'claude',
              expected: true,
              active: false,
              degraded: true,
              status: 'unknown',
              observedPlugins: [],
              message: 'no system.init observed',
            } as any,
          }),
        ],
      }),
    });

    const output = formatBatchScoreOutput(batch);
    expect(output).toContain('Hook activation');
    expect(output).toContain('active:1, unknown:1 (1 degraded/unknown)');
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

  it('keeps the expensive cost-per-PR recommendation for ordinary guidance', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        guidance: 'pick small isolated issues and ship them independently',
        run: 2,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 4.0, prs: ['https://github.com/Garsson-io/kaizen/pull/100'] }),
          makeRunMetrics({ run: 2, cost_usd: 4.0, prs: ['https://github.com/Garsson-io/kaizen/pull/101'] }),
        ],
      }),
    });

    const reflection = buildBatchReflection(batch);
    const costInsight = reflection.insights.find((i) => i.message.includes('$4.00/PR'));

    expect(costInsight).toBeDefined();
    expect(costInsight?.message).toContain('consider simpler issues');
  });

  it('reframes expensive cost-per-PR when guidance asks for bundled complete work', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        guidance: 'find meaningful tasks, bunch them together into one bigger useful task, finish it to completion perfectly',
        run: 2,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 4.0, prs: ['https://github.com/Garsson-io/kaizen/pull/100'], issues_closed: ['#10', '#11'] }),
          makeRunMetrics({ run: 2, cost_usd: 4.0, prs: ['https://github.com/Garsson-io/kaizen/pull/101'], issues_closed: ['#12', '#13'] }),
        ],
      }),
    });

    const reflection = buildBatchReflection(batch);
    const simplerIssuesAdvice = reflection.insights.find((i) => i.message.includes('consider simpler issues'));
    const bundledCostInsight = reflection.insights.find((i) => i.message.includes('bundling guidance'));

    expect(simplerIssuesAdvice).toBeUndefined();
    expect(bundledCostInsight).toBeDefined();
    expect(bundledCostInsight?.message).toContain('$4.00/PR');
    expect(bundledCostInsight?.message).toContain('issues closed');
  });

  it('surfaces explore to exploit conversion in reflection comments', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 3,
        run_history: [
          makeRunMetrics({ run: 1, mode: 'explore', issues_filed: ['#10', '#11'] }),
          makeRunMetrics({ run: 2, mode: 'exploit', prs: ['pr1'], issues_closed: ['https://github.com/Garsson-io/kaizen/issues/10'] }),
          makeRunMetrics({ run: 3, mode: 'reflect', issues_closed: ['#11'] }),
        ],
      }),
    });

    const reflection = buildBatchReflection(batch);
    const comment = formatBatchReflectionComment(reflection);

    expect(reflection.exploreExploitConversion).toMatchObject({
      exploreIssuesFiled: 2,
      exploreIssuesClosedByExploit: 1,
      conversionRate: 0.5,
    });
    expect(comment).toContain('Explore->exploit conversion');
    expect(comment).toContain('1/2 (50%)');
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

  it('does not report no_op runs as failure root causes', () => {
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 3,
        run_history: [
          makeRunMetrics({ run: 1, prs: ['https://github.com/Garsson-io/kaizen/pull/100'] }),
          makeRunMetrics({ run: 2, prs: [], issues_closed: [], failure_class: 'no_op', stop_requested: true }),
          makeRunMetrics({ run: 3, prs: [], issues_closed: [], failure_class: 'no_op', stop_requested: true }),
        ],
      }),
    });
    const reflection = buildBatchReflection(batch);
    expect(reflection.insights.some((i) => i.message.includes('Failure root causes'))).toBe(false);
    expect(reflection.runHistoryTable).toContain('| #2 | 5m0s | $2.50 | 0 | 0 | noop |');
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

  it('surfaces dry-sweep findings as advisory reflection insight', () => {
    const drySweepReport: DrySweepReport = {
      generatedAt: '2026-06-29T00:00:00.000Z',
      repo: 'Garsson-io/kaizen',
      recentPrLimit: 20,
      candidates: [
        {
          kind: 'progress_comments',
          summary: 'Direct progress comments compete with marker attachments',
          confidence: 85,
          evidence: [
            { path: 'scripts/auto-dent-run.ts', line: 10, symbol: 'gh issue comment', detail: 'direct comment' },
            { path: 'src/section-editor.ts', line: 338, symbol: 'writeAttachment', detail: 'shared attachment primitive' },
          ],
          files: ['scripts/auto-dent-run.ts', 'src/section-editor.ts'],
          recentPrs: [
            {
              number: 100,
              title: 'refactor(auto-dent): progress comments',
              mergedAt: '2026-06-28T10:00:00Z',
              changedFiles: ['scripts/auto-dent-run.ts'],
              url: 'https://github.com/Garsson-io/kaizen/pull/100',
            },
          ],
          suggestedUnificationTarget: 'src/section-editor.ts writeAttachment',
        },
      ],
    };
    const batch = makeBatchInfo({
      state: makeBatchState({
        run: 3,
        run_history: [
          makeRunMetrics({ run: 1, prs: ['https://github.com/Garsson-io/kaizen/pull/1'] }),
          makeRunMetrics({ run: 2, prs: ['https://github.com/Garsson-io/kaizen/pull/2'] }),
          makeRunMetrics({ run: 3, prs: ['https://github.com/Garsson-io/kaizen/pull/3'] }),
        ],
      }),
    });

    const reflection = buildBatchReflection(batch, { drySweepReport });

    expect(reflection.insights).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'recommendation',
        message: expect.stringContaining('DRY sweep found 1 candidate'),
      }),
    ]));
    expect(formatBatchReflection(reflection)).toContain('progress_comments');
    expect(formatBatchReflectionComment(reflection)).toContain('DRY sweep found 1 candidate');
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
    // PR merge status should include status labels
    expect(vars.pr_merge_status).toMatch(/— \*\*(merged|open|closed)\*\*|— unknown/);
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

// Reflection persistence tests (#603)

describe('persistReflectionSummary', () => {
  it('routes reflection JSON persistence through shared JSON file contracts', () => {
    const persistSection = AUTO_DENT_CTL_SOURCE.slice(
      AUTO_DENT_CTL_SOURCE.indexOf('export function persistReflectionSummary'),
      AUTO_DENT_CTL_SOURCE.indexOf('export interface AggregateBatchRecord'),
    );

    expect(persistSection).toContain('readJsonValueFile');
    expect(persistSection).toContain('writeJsonValueFile');
    expect(persistSection).not.toContain("JSON.parse(readFileSync(historyPath, 'utf8'))");
    expect(persistSection).not.toContain('JSON.stringify(summary, null, 2)');
    expect(persistSection).not.toContain('JSON.stringify(history, null, 2)');
  });

  it('writes reflection-summary.json to the batch directory', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'reflect-persist-'));
    const batch = makeBatchInfo({
      dir: tmpDir,
      state: makeBatchState({
        run: 5,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 2.0, prs: ['https://github.com/Garsson-io/kaizen/pull/100'] }),
          makeRunMetrics({ run: 2, cost_usd: 3.0, prs: [] }),
        ],
      }),
    });
    const reflection = buildBatchReflection(batch);
    const path = persistReflectionSummary(batch, reflection);

    expect(path).toBeTruthy();
    expect(existsSync(path!)).toBe(true);

    const data: PersistedReflection = JSON.parse(readFileSync(path!, 'utf8'));
    expect(data.runCount).toBe(2);
    expect(data.insights).toBeInstanceOf(Array);
    expect(data.avoidIssues).toBeInstanceOf(Array);
    expect(data.timestamp).toBeTruthy();
    expect(readFileSync(path!, 'utf8')).toMatch(/\n$/);
  });

  it('extracts issue numbers from failure insights into avoidIssues', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'reflect-avoid-'));
    const batch = makeBatchInfo({
      dir: tmpDir,
      state: makeBatchState({
        run: 5,
        run_history: [
          makeRunMetrics({ run: 1, cost_usd: 2.0, prs: [] }),
          makeRunMetrics({ run: 2, cost_usd: 3.0, prs: [] }),
          makeRunMetrics({ run: 3, cost_usd: 1.5, prs: [] }),
        ],
      }),
    });
    const reflection = buildBatchReflection(batch);
    // Manually add an insight with issue references for test
    reflection.insights.push({
      type: 'recommendation',
      message: 'Issues #42 and #99 keep failing — skip them',
    });
    const path = persistReflectionSummary(batch, reflection);
    const data: PersistedReflection = JSON.parse(readFileSync(path!, 'utf8'));

    expect(data.avoidIssues).toContain('42');
    expect(data.avoidIssues).toContain('99');
  });

  it('deduplicates avoidIssues', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'reflect-dedup-'));
    const batch = makeBatchInfo({ dir: tmpDir });
    const reflection = buildBatchReflection(batch);
    reflection.insights = [
      { type: 'failure_pattern', message: 'Issue #42 fails repeatedly' },
      { type: 'recommendation', message: 'Skip #42 and try #99' },
    ];
    const path = persistReflectionSummary(batch, reflection);
    const data: PersistedReflection = JSON.parse(readFileSync(path!, 'utf8'));

    const count42 = data.avoidIssues.filter((i) => i === '42').length;
    expect(count42).toBe(1);
  });

  it('appends to reflection-history.json for consecutive reflections', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'reflect-history-'));
    const batch = makeBatchInfo({ dir: tmpDir });

    // First reflection
    const r1 = buildBatchReflection(batch);
    r1.insights = [{ type: 'recommendation', message: 'Focus on hooks' }];
    persistReflectionSummary(batch, r1);

    const historyPath = join(tmpDir, 'reflection-history.json');
    expect(existsSync(historyPath)).toBe(true);
    let history = JSON.parse(readFileSync(historyPath, 'utf8'));
    expect(history).toHaveLength(1);
    expect(history[0].insights[0].message).toBe('Focus on hooks');

    // Second reflection
    const r2 = buildBatchReflection(batch);
    r2.insights = [{ type: 'success_pattern', message: 'Testing works well' }];
    persistReflectionSummary(batch, r2);

    history = JSON.parse(readFileSync(historyPath, 'utf8'));
    expect(history).toHaveLength(2);
    expect(history[1].insights[0].message).toBe('Testing works well');
    expect(readFileSync(historyPath, 'utf8')).toMatch(/\n$/);
  });

  it('resets corrupted reflection history through the shared JSON reader contract', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'reflect-history-corrupt-'));
    const batch = makeBatchInfo({ dir: tmpDir });
    const historyPath = join(tmpDir, 'reflection-history.json');
    writeFileSync(historyPath, '{not json');

    const reflection = buildBatchReflection(batch);
    reflection.insights = [{ type: 'recommendation', message: 'Fresh history' }];
    persistReflectionSummary(batch, reflection);

    const history = JSON.parse(readFileSync(historyPath, 'utf8'));
    expect(history).toHaveLength(1);
    expect(history[0].insights[0].message).toBe('Fresh history');
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

  it('parses CRLF aggregate JSONL while skipping blank and malformed rows', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'agg-test-'));
    writeFileSync(
      join(tmpDir, 'aggregate.jsonl'),
      [
        '{"batch_id":"b1","total_runs":1}',
        '',
        'not json',
        '{"batch_id":"b2","total_runs":2}',
      ].join('\r\n'),
    );

    const records = readAggregate(tmpDir);

    expect(records.map((record) => record.batch_id)).toEqual(['b1', 'b2']);
  });

  it('delegates tolerant aggregate JSONL decoding to the shared parser', () => {
    const source = readFileSync('scripts/auto-dent-ctl.ts', 'utf8');
    const aggregateSource = source.slice(
      source.indexOf('export function appendBatchToAggregate'),
      source.indexOf('export interface AggregateStats'),
    );

    expect(source).toContain('appendJsonLine');
    expect(source).toContain("from '../src/lib/json-lines.js'");
    expect(aggregateSource).not.toContain('appendFileSync');
    expect(aggregateSource).not.toContain("JSON.stringify(record) + '\\n'");
    expect(aggregateSource).not.toMatch(/JSON\.parse\(line\)/);
    expect(aggregateSource).not.toMatch(/\.split\(['"]\\n['"]\)/);
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

  it('formats recent-batch guidance through the shared display helper (#1354)', () => {
    const stats = computeAggregateStats([{
      batch_id: 'b1',
      guidance: 'focus on hooks reliability and review evidence quality',
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
    expect(output).toContain('| b1 | focus on hooks reliability and review... |');
  });

  it('does not keep private guidance truncation logic in aggregate stats (#1354)', () => {
    const source = readFileSync('scripts/auto-dent-ctl.ts', 'utf8');
    expect(source).not.toMatch(/guidance\.slice\(0,\s*37\)\s*\+\s*['"]\.\.\.['"]/);
  });
});

describe('buildSteerOutput — cloud-backed steer command (#940 Phase 2)', () => {
  function outcome(over: Record<string, unknown> = {}): any {
    return {
      schema_version: 1, batch_id: 'b', guidance: 'g', batch_start: 1, batch_end: 2,
      wall_seconds: 1, stop_reason: 'completed',
      totals: { runs: 4, successful_runs: 3, prs: 3, issues_closed: 3, issues_filed: 0, cost_usd: 10, duration_seconds: 100, lines_deleted: 0, issues_pruned: 0 },
      success_rate: 0.75, avg_cost_per_success: 3, overall_efficiency: 0.3, review_fail_rate: 0,
      cost_anomaly_count: 0, mode_diversity: 1, trend: null, mode_breakdown: [], prs: [], issues_closed: [], issues_filed: [],
      ...over,
    };
  }

  it('wires read → analyze → format end to end with injected deps', () => {
    const out = buildSteerOutput('Garsson-io/kaizen', {}, {
      listIssues: () => [101, 102],
      readOutcome: (n) =>
        outcome({ batch_id: `b${n}`, batch_start: Number(n), review_fail_rate: 0.5 }),
    });
    expect(out).toContain('Cross-Batch Steering');
    expect(out).toContain('Review fail rate');
  });

  it('renders the cold-start report when no outcomes are found', () => {
    const out = buildSteerOutput('Garsson-io/kaizen', {}, { listIssues: () => [] });
    expect(out).toMatch(/without cross-batch steering/i);
  });
});
