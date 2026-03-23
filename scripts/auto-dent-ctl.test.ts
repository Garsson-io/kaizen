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
  DEFAULT_WATCHDOG_THRESHOLD_SEC,
  type BatchInfo,
  type WatchdogResult,
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
