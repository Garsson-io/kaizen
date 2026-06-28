import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import {
  parseAutoDentArgs,
  createInitialState,
  buildAutoDentResumeCommand,
  buildTsxScriptArgs,
  readStateKey,
  updateStateKey,
  loadResumeBatch,
  isOuterHarnessReloadPath,
  listChangedFilesBetween,
  maybeHotReloadOuterHarness,
  pullMainForSelfUpdate,
  runPreRunSelfUpdate,
  shouldHotReloadOuterHarness,
  shouldRunPlanningPrepass,
  startAutoDentResume,
  checkHaltFile,
  checkBudget,
  stopDecision,
  writeBatchSummary,
  formatBatchSummary,
  postStructuredSummary,
  type AutoDentOptions,
} from './auto-dent.js';
import { readState, writeState, type BatchState } from './auto-dent-run.js';

const AUTO_DENT_SOURCE = readFileSync(new URL('./auto-dent.ts', import.meta.url), 'utf8');

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
  resumeStateFile: '',
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

function fakeChild(): EventEmitter & { unref: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
  child.unref = vi.fn();
  return child;
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

  it('accepts resume mode without guidance', () => {
    const opts = parseAutoDentArgs(['--resume', '/tmp/state.json']);
    expect(opts.resumeStateFile).toBe('/tmp/state.json');
    expect(opts.guidance).toBe('');
  });

  it('requires a state file for resume mode', () => {
    expect(() => parseAutoDentArgs(['--resume'])).toThrow('Missing value for --resume');
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
  it('creates initial batch state through the canonical durable state writer', () => {
    expect(AUTO_DENT_SOURCE).toContain('writeState(stateFile, state)');
    expect(AUTO_DENT_SOURCE).not.toContain("writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\\n')");
  });

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

  it('loads resume batches from the existing durable state file', () => {
    const { dir, stateFile } = tempState(makeState({
      batch_id: 'existing-batch',
      run: 7,
      progress_issue: '1495',
    }));
    try {
      const resumed = loadResumeBatch(stateFile);

      expect(resumed.stateFile).toBe(stateFile);
      expect(resumed.logDir).toBe(dir);
      expect(resumed.haltFile).toBe(join(dir, 'HALT'));
      expect(resumed.state.batch_id).toBe('existing-batch');
      expect(resumed.state.run).toBe(7);
      expect(readState(stateFile).batch_id).toBe('existing-batch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not rerun planning when bootstrapping from resume state', () => {
    expect(shouldRunPlanningPrepass({ resumeStateFile: '/tmp/state.json', testTask: false, noPlan: false })).toBe(false);
    expect(shouldRunPlanningPrepass({ resumeStateFile: '', testTask: true, noPlan: false })).toBe(false);
    expect(shouldRunPlanningPrepass({ resumeStateFile: '', testTask: false, noPlan: true })).toBe(false);
    expect(shouldRunPlanningPrepass({ resumeStateFile: '', testTask: false, noPlan: false })).toBe(true);
  });
});

describe('outer harness hot reload', () => {
  it('centralizes npx tsx script command construction', () => {
    expect(buildTsxScriptArgs('/repo/scripts', 'auto-dent-run.ts', '/tmp/state.json')).toEqual([
      'tsx',
      '/repo/scripts/auto-dent-run.ts',
      '/tmp/state.json',
    ]);
  });

  it('builds the auto-dent resume handoff command', () => {
    expect(buildAutoDentResumeCommand('/repo/scripts', '/tmp/state.json')).toEqual({
      command: 'npx',
      args: ['tsx', '/repo/scripts/auto-dent.ts', '--resume', '/tmp/state.json'],
    });
  });

  it('matches outer-harness contract paths without matching unrelated files', () => {
    expect(isOuterHarnessReloadPath('scripts/auto-dent.ts')).toBe(true);
    expect(isOuterHarnessReloadPath('scripts/auto-dent-run.ts')).toBe(true);
    expect(isOuterHarnessReloadPath('src/lib/json-file.ts')).toBe(true);
    expect(isOuterHarnessReloadPath('scripts\\auto-dent.ts')).toBe(true);
    expect(isOuterHarnessReloadPath('docs/auto-dent-operations.md')).toBe(false);
    expect(isOuterHarnessReloadPath('src/hooks/pre-push.ts')).toBe(false);
  });

  it('restarts only after a successful pull changes an outer harness contract path', () => {
    expect(shouldHotReloadOuterHarness({
      pullStatus: 0,
      beforeHead: 'aaa',
      afterHead: 'bbb',
      changedFiles: ['scripts/auto-dent.ts'],
    })).toBe(true);

    expect(shouldHotReloadOuterHarness({
      pullStatus: 0,
      beforeHead: 'aaa',
      afterHead: 'bbb',
      changedFiles: ['docs/auto-dent-operations.md'],
    })).toBe(false);

    expect(shouldHotReloadOuterHarness({
      pullStatus: 1,
      beforeHead: 'aaa',
      afterHead: 'bbb',
      changedFiles: ['scripts/auto-dent.ts'],
    })).toBe(false);

    expect(shouldHotReloadOuterHarness({
      pullStatus: 0,
      beforeHead: 'aaa',
      afterHead: 'aaa',
      changedFiles: ['scripts/auto-dent.ts'],
    })).toBe(false);

    expect(shouldHotReloadOuterHarness({
      pullStatus: 0,
      beforeHead: 'unknown',
      afterHead: 'bbb',
      changedFiles: ['scripts/auto-dent.ts'],
    })).toBe(false);

    expect(shouldHotReloadOuterHarness({
      pullStatus: 0,
      beforeHead: 'aaa',
      afterHead: 'bbb',
      changedFiles: [],
      changedFilesKnown: false,
    })).toBe(true);
  });

  it('propagates changed-file detection failures instead of hiding them as no-op pulls', () => {
    let headReads = 0;
    const update = pullMainForSelfUpdate('/repo', {
      captureCommand: () => (++headReads === 1 ? 'aaa' : 'bbb'),
      pullMain: () => ({ status: 0, stdout: 'updated' }),
      listChangedFiles: () => ({ ok: false, files: [], error: 'diff failed' }),
    });

    expect(update).toMatchObject({
      pullStatus: 0,
      beforeHead: 'aaa',
      afterHead: 'bbb',
      changedFiles: [],
      changedFilesKnown: false,
      changeDetectionError: 'diff failed',
    });
  });

  it('returns an explicit changed-file failure when git diff cannot list files', () => {
    const result = listChangedFilesBetween('/not/a/repo', 'aaa', 'bbb');
    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it('waits for a spawned replacement before reporting handoff success', async () => {
    const child = fakeChild();
    const result = startAutoDentResume('/repo/scripts', '/tmp/state.json', {
      scriptExists: () => true,
      spawnProcess: () => {
        process.nextTick(() => child.emit('spawn'));
        return child as never;
      },
      log: () => {},
    });

    await expect(result).resolves.toBe(true);
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('keeps the old process alive when replacement spawn fails asynchronously', async () => {
    const child = fakeChild();
    const lines: string[] = [];
    const result = startAutoDentResume('/repo/scripts', '/tmp/state.json', {
      scriptExists: () => true,
      spawnProcess: () => {
        process.nextTick(() => child.emit('error', new Error('ENOENT')));
        return child as never;
      },
      log: (line) => lines.push(line),
    });

    await expect(result).resolves.toBe(false);
    expect(child.unref).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('ENOENT');
  });

  it('hot-reloads conservatively when changed-file detection fails after a moved HEAD', async () => {
    const child = fakeChild();
    const lines: string[] = [];

    const result = await maybeHotReloadOuterHarness({
      pullStatus: 0,
      beforeHead: 'aaa',
      afterHead: 'bbb',
      changedFiles: [],
      changedFilesKnown: false,
      changeDetectionError: 'diff failed',
      stdout: '',
    }, '/repo/scripts', '/tmp/state.json', {
      scriptExists: () => true,
      spawnProcess: () => {
        process.nextTick(() => child.emit('spawn'));
        return child as never;
      },
      log: (line) => lines.push(line),
    });

    expect(result).toBe(true);
    expect(lines.join('\n')).toContain('hot-reloading conservatively');
    expect(lines.join('\n')).toContain('unknown files');
  });

  it('tells the outer loop to return before next-run work after a successful hot reload handoff', async () => {
    const child = fakeChild();
    const events: string[] = [];

    const handedOff = await runPreRunSelfUpdate('/repo', '/repo/scripts', '/tmp/state.json', true, {
      pullSelfUpdate: () => ({
        pullStatus: 0,
        beforeHead: 'aaa111',
        afterHead: 'bbb222',
        changedFiles: ['scripts/auto-dent.ts'],
        changedFilesKnown: true,
        stdout: 'updated\n',
      }),
      scriptExists: () => true,
      spawnProcess: () => {
        process.nextTick(() => child.emit('spawn'));
        return child as never;
      },
      writeStdout: (text) => events.push(`stdout:${text.trim()}`),
      log: (line) => events.push(line),
    });
    if (handedOff) {
      events.push('old-loop-returned');
    } else {
      events.push('next-run-work');
    }

    expect(handedOff).toBe(true);
    expect(events).toContain('old-loop-returned');
    expect(events).not.toContain('next-run-work');
    expect(events.join('\n')).toContain('Outer harness changed: scripts/auto-dent.ts');
  });

  it('continues old-loop work when hot reload handoff fails', async () => {
    const child = fakeChild();
    const handedOff = await runPreRunSelfUpdate('/repo', '/repo/scripts', '/tmp/state.json', false, {
      pullSelfUpdate: () => ({
        pullStatus: 0,
        beforeHead: 'aaa',
        afterHead: 'bbb',
        changedFiles: ['scripts/auto-dent.ts'],
        changedFilesKnown: true,
        stdout: '',
      }),
      scriptExists: () => true,
      spawnProcess: () => {
        process.nextTick(() => child.emit('error', new Error('ENOENT')));
        return child as never;
      },
      writeStdout: () => {},
      log: () => {},
    });

    expect(handedOff).toBe(false);
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
