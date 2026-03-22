import { describe, it, expect } from 'vitest';
import {
  formatBatchStatus,
  formatLastState,
  type BatchInfo,
} from './auto-dent-ctl.js';
import type { BatchState } from './auto-dent-run.js';

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
