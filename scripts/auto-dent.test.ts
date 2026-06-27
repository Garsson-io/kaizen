import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseAutoDentArgs,
  createInitialState,
  readStateKey,
  updateStateKey,
  checkHaltFile,
  checkBudget,
  stopDecision,
  writeBatchSummary,
  formatBatchSummary,
  postStructuredSummary,
  type AutoDentOptions,
} from './auto-dent.js';
import { readState, writeState, type BatchState } from './auto-dent-run.js';

const baseOpts: AutoDentOptions = {
  maxRuns: 0,
  cooldown: 30,
  budget: '',
  maxBudget: '',
  maxFailures: 3,
  maxRunSeconds: 1200,
  dryRun: false,
  testTask: false,
  experiment: false,
  noPlan: false,
  provider: 'claude',
  guidance: 'focus on hooks',
};

function makeState(overrides: Partial<BatchState> = {}): BatchState {
  return {
    batch_id: 'test-batch',
    guidance: 'focus on hooks',
    batch_start: 1_000,
    max_runs: 0,
    cooldown: 30,
    budget: null as unknown as string,
    max_budget: null as unknown as string,
    max_failures: 3,
    kaizen_repo: 'Garsson-io/kaizen',
    host_repo: 'Garsson-io/kaizen',
    run: 0,
    consecutive_failures: 0,
    current_cooldown: 30,
    stop_reason: '',
    prs: [],
    issues_filed: [],
    issues_closed: [],
    cases: [],
    last_issue: '',
    last_pr: '',
    last_case: '',
    last_branch: '',
    last_worktree: '',
    progress_issue: '',
    test_task: false,
    experiment: false,
    max_run_seconds: 1200,
    last_heartbeat: 0,
    ...overrides,
  };
}

function tempState(state: BatchState = makeState()): { dir: string; stateFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'auto-dent-ts-test-'));
  const stateFile = join(dir, 'state.json');
  writeState(stateFile, state);
  return { dir, stateFile };
}

describe('parseAutoDentArgs', () => {
  it('parses options and joins unquoted guidance words', () => {
    const opts = parseAutoDentArgs([
      '--max-runs', '5',
      '--cooldown', '10',
      '--budget', '5.00',
      '--max-budget', '50.00',
      '--max-failures', '2',
      '--max-run-seconds', '600',
      '--experiment',
      'fix',
      'hooks',
      'reliability',
    ]);

    expect(opts.maxRuns).toBe(5);
    expect(opts.cooldown).toBe(10);
    expect(opts.budget).toBe('5.00');
    expect(opts.maxBudget).toBe('50.00');
    expect(opts.maxFailures).toBe(2);
    expect(opts.maxRunSeconds).toBe(600);
    expect(opts.experiment).toBe(true);
    expect(opts.guidance).toBe('fix hooks reliability');
  });

  it('uses default guidance for test-task mode', () => {
    expect(parseAutoDentArgs(['--test-task']).guidance).toBe('synthetic pipeline test');
  });

  it('defaults provider to claude', () => {
    expect(parseAutoDentArgs(['focus']).provider).toBe('claude');
  });

  it('accepts codex provider for normal batches', () => {
    const opts = parseAutoDentArgs(['--provider', 'codex', 'real work']);
    expect(opts.provider).toBe('codex');
    expect(opts.testTask).toBe(false);
    expect(opts.guidance).toBe('real work');
  });

  it('still accepts codex provider for test-task mode', () => {
    const opts = parseAutoDentArgs(['--provider', 'codex', '--test-task']);
    expect(opts.provider).toBe('codex');
    expect(opts.testTask).toBe(true);
  });

  it('rejects unknown options', () => {
    expect(() => parseAutoDentArgs(['--wat'])).toThrow('Unknown option: --wat');
  });
});

describe('createInitialState', () => {
  it('creates valid batch state with configured repositories', () => {
    const state = createInitialState('batch-1', 'fix "quoted" strings', 1_711_234_567, {
      ...baseOpts,
      maxRuns: 10,
      budget: '5.00',
      maxBudget: '50.00',
      testTask: true,
      experiment: true,
      maxRunSeconds: 600,
    }, {
      kaizenRepo: 'Garsson-io/kaizen',
      hostRepo: 'Garsson-io/host',
    });

    expect(state.batch_id).toBe('batch-1');
    expect(state.guidance).toBe('fix "quoted" strings');
    expect(state.max_runs).toBe(10);
    expect(state.budget).toBe('5.00');
    expect(state.max_budget).toBe('50.00');
    expect(state.kaizen_repo).toBe('Garsson-io/kaizen');
    expect(state.host_repo).toBe('Garsson-io/host');
    expect(state.test_task).toBe(true);
    expect(state.experiment).toBe(true);
    expect(state.max_run_seconds).toBe(600);
    expect(state.provider).toBe('claude');
  });

  it('stores selected provider in initial state for dry-run inspection', () => {
    const state = createInitialState('batch-1', 'real work', 1, {
      ...baseOpts,
      provider: 'codex',
    }, {
      kaizenRepo: 'Garsson-io/kaizen',
      hostRepo: 'Garsson-io/kaizen',
    });

    expect(state.provider).toBe('codex');
    expect(state.test_task).toBe(false);
  });
});

describe('state helpers', () => {
  it('reads and updates state atomically with backups', () => {
    const { dir, stateFile } = tempState();
    try {
      expect(readStateKey(stateFile, 'batch_id')).toBe('test-batch');
      expect(readStateKey(stateFile, 'last_pr')).toBe('');

      updateStateKey(stateFile, 'run', 5);
      expect(readState(stateFile).run).toBe(5);
      expect(existsSync(`${stateFile}.bak`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects halt files and records stop reason', () => {
    const { dir, stateFile } = tempState();
    try {
      const haltFile = join(dir, 'HALT');
      expect(checkHaltFile(haltFile, stateFile)).toBe(false);

      writeFileSync(haltFile, '');
      expect(checkHaltFile(haltFile, stateFile)).toBe(true);
      expect(readState(stateFile).stop_reason).toContain('halt file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stopDecision and budget', () => {
  it('stops when max runs would be exceeded', () => {
    expect(stopDecision(makeState({ max_runs: 3 }), 4)).toEqual({
      stop: true,
      reason: 'max runs reached (3)',
    });
  });

  it('stops when consecutive failures reach the threshold', () => {
    expect(stopDecision(makeState({ consecutive_failures: 3, max_failures: 3 }), 4)).toEqual({
      stop: true,
      reason: '3 consecutive failures',
    });
  });

  it('reports budget status and stops on exhaustion', () => {
    const state = makeState({
      max_budget: '10.00',
      run_history: [
        { run: 1, start_epoch: 1, duration_seconds: 10, exit_code: 0, cost_usd: 4.5, tool_calls: 1, prs: [], issues_filed: [], issues_closed: [], cases: [], stop_requested: false },
        { run: 2, start_epoch: 2, duration_seconds: 10, exit_code: 0, cost_usd: 5.5, tool_calls: 1, prs: [], issues_filed: [], issues_closed: [], cases: [], stop_requested: false },
      ],
    });

    expect(checkBudget(state)).toEqual({ totalCost: 10, remaining: 0, exceeded: true });
    expect(stopDecision(state, 3)).toEqual({
      stop: true,
      reason: 'budget exhausted ($10.00 >= $10.00)',
    });
  });
});

describe('batch summary', () => {
  it('writes summary text and finalizes state', () => {
    const { dir, stateFile } = tempState(makeState({
      run: 1,
      prs: ['https://github.com/Garsson-io/kaizen/pull/1'],
      run_history: [
        { run: 1, start_epoch: 1, duration_seconds: 65, exit_code: 0, cost_usd: 1.25, tool_calls: 7, prs: ['https://github.com/Garsson-io/kaizen/pull/1'], issues_filed: [], issues_closed: [], cases: [], stop_requested: false },
      ],
    }));
    try {
      const summaryPath = writeBatchSummary(stateFile, 1_300);
      const summary = readFileSync(summaryPath, 'utf8');
      const state = readState(stateFile);

      expect(summary).toContain('batch_id=test-batch');
      expect(summary).toContain('run_1_cost=1.25');
      expect(state.stop_reason).toBe('completed');
      expect(state.batch_end).toBe(1_300);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formats the operator-facing final summary', () => {
    const formatted = formatBatchSummary(makeState({ run: 0 }), 1_600);
    expect(formatted).toContain('auto-dent — Batch Summary');
    expect(formatted).toContain('PRs created: none');
    expect(formatted).toContain('Runs:      0');
  });
});

describe('postStructuredSummary', () => {
  it('posts generated batch summary through the shared ghResult-compatible seam', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-dent-summary-test-'));
    try {
      writeFileSync(join(dir, 'events.jsonl'), '{}\n');
      const postIssueComment = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));

      postStructuredSummary('scripts', dir, '1286', 'Garsson-io/kaizen', {
        generateSummary: () => 'summary body',
        postIssueComment,
        log: () => {},
      });

      expect(postIssueComment).toHaveBeenCalledWith([
        'issue',
        'comment',
        '1286',
        '--repo',
        'Garsson-io/kaizen',
        '--body',
        'summary body',
      ]);
      expect(readFileSync(join(dir, 'batch-summary-report.md'), 'utf8')).toBe(
        'summary body\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps writing the summary report when posting fails non-fatally', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-dent-summary-test-'));
    try {
      writeFileSync(join(dir, 'events.jsonl'), '{}\n');
      const lines: string[] = [];

      postStructuredSummary('scripts', dir, '1286', 'Garsson-io/kaizen', {
        generateSummary: () => 'summary body',
        postIssueComment: () => ({ status: 1, stdout: '', stderr: 'gh error' }),
        log: (line) => lines.push(line),
      });

      expect(lines).toContain('>>> Summary posting skipped (non-fatal).');
      expect(readFileSync(join(dir, 'batch-summary-report.md'), 'utf8')).toBe(
        'summary body\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
