import { describe, expect, it, vi } from 'vitest';
import {
  ANOMALY_INCIDENT_LABELS,
  AutoDentAnomalyIncidentResultSchema,
  buildAutoDentAnomalyIncidentBody,
  detectAutoDentAnomalies,
  fileAutoDentAnomalyIncident,
  fileAutoDentAnomalyIncidentsForBatch,
  formatAutoDentAnomalyIncidentSummary,
} from './auto-dent-anomaly-incidents.js';
import type { RunMetrics } from './auto-dent-run.js';
import { makeBatchState } from './auto-dent-test-utils.js';

function run(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    run: 1,
    start_epoch: 1,
    duration_seconds: 60,
    exit_code: 0,
    cost_usd: 1,
    tool_calls: 10,
    prs: ['https://github.com/Garsson-io/kaizen/pull/1'],
    issues_filed: [],
    issues_closed: [],
    cases: [],
    stop_requested: false,
    failure_class: 'success',
    log_file: '/logs/run-1.log',
    ...overrides,
  };
}

describe('detectAutoDentAnomalies', () => {
  it('emits a typed critical lifecycle signal with stable evidence', () => {
    const state = makeBatchState({
      batch_id: 'batch-critical',
      run_history: [
        run({
          run: 3,
          log_file: '/logs/run-3.log',
          lifecycle_health: 'critical',
          lifecycle_violations: 2,
        }),
      ],
    });

    const signals = detectAutoDentAnomalies(state);

    expect(signals.map((s) => s.trigger)).toEqual(['lifecycle_critical']);
    expect(signals[0]).toMatchObject({
      severity: 'critical',
      batch_id: 'batch-critical',
      run: 3,
    });
    expect(signals[0].dedupe_key).toContain('batch-critical:run-3:lifecycle_critical');
    expect(signals[0].evidence).toContain('lifecycle_violations=2');
    expect(signals[0].evidence).toContain('run_log=/logs/run-3.log');
  });

  it('covers failed, empty, hook, PR-count, cost, and duration triggers without duplicate keys', () => {
    const state = makeBatchState({
      batch_id: 'batch-mixed',
      run_history: [
        run({ run: 1, cost_usd: 1, duration_seconds: 50 }),
        run({
          run: 2,
          exit_code: 1,
          failure_class: 'hook_rejection',
          hook_rejection_reason: 'plan gate',
          cost_usd: 3.1,
          duration_seconds: 120,
          prs: ['p1', 'p2', 'p3', 'p4'],
        }),
        run({ run: 3, exit_code: 0, failure_class: 'empty_success', prs: [], issues_filed: [], issues_closed: [] }),
      ],
    });

    const signals = detectAutoDentAnomalies(state);
    const triggers = signals.map((s) => s.trigger);

    expect(triggers).toEqual([
      'run_failed',
      'hook_rejection',
      'too_many_prs',
      'cost_outlier',
      'duration_outlier',
      'empty_success',
    ]);
    expect(new Set(signals.map((s) => s.dedupe_key)).size).toBe(signals.length);
  });

  it('returns no signals for clean runs', () => {
    expect(detectAutoDentAnomalies(makeBatchState({ run_history: [run(), run({ run: 2 })] }))).toEqual([]);
  });
});

describe('fileAutoDentAnomalyIncident', () => {
  const signal = detectAutoDentAnomalies(makeBatchState({
    batch_id: 'batch-file',
    run_history: [run({ run: 1, lifecycle_health: 'critical' })],
  }))[0];

  it('searches before creating and reuses an existing issue', () => {
    const gh = vi.fn(() => JSON.stringify([{ number: 900, url: 'https://github.com/Garsson-io/kaizen/issues/900' }]));

    const result = fileAutoDentAnomalyIncident('Garsson-io/kaizen', signal, { gh });

    expect(result).toMatchObject({ status: 'reused', issue: 900 });
    expect(gh).toHaveBeenCalledTimes(1);
    expect(gh.mock.calls[0][0]).toEqual([
      'issue', 'list',
      '--repo', 'Garsson-io/kaizen',
      '--state', 'open',
      '--search', signal.search_query,
      '--json', 'number,url',
      '--limit', '1',
    ]);
  });

  it('creates a labeled incident issue when no existing issue matches', () => {
    const gh = vi.fn()
      .mockReturnValueOnce('[]')
      .mockReturnValueOnce('https://github.com/Garsson-io/kaizen/issues/901/');

    const result = fileAutoDentAnomalyIncident('Garsson-io/kaizen', signal, {
      gh,
      progressIssue: 'https://github.com/Garsson-io/kaizen/issues/800',
    });

    expect(result).toMatchObject({ status: 'created', issue: 901 });
    expect(gh).toHaveBeenCalledTimes(2);
    const createArgs = gh.mock.calls[1][0];
    expect(createArgs.slice(0, 6)).toEqual([
      'issue', 'create', '--repo', 'Garsson-io/kaizen', '--title', signal.title,
    ]);
    for (const label of ANOMALY_INCIDENT_LABELS) {
      expect(createArgs).toContain(label);
    }
    const body = createArgs[createArgs.indexOf('--body') + 1];
    expect(body).toContain('## Incident');
    expect(body).toContain(signal.dedupe_key);
    expect(body).toContain('Progress issue: https://github.com/Garsson-io/kaizen/issues/800');
    expect(body).toContain('- run_log=/logs/run-1.log');
    expect(body).toContain('## Directional Guess');
  });

  it('fails open when create returns a non-issue URL', () => {
    const gh = vi.fn()
      .mockReturnValueOnce('[]')
      .mockReturnValueOnce('https://github.com/Garsson-io/kaizen/pull/901');

    const result = fileAutoDentAnomalyIncident('Garsson-io/kaizen', signal, { gh });

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('could not parse created issue URL');
  });

  it('fails open when search returns malformed JSON', () => {
    const result = fileAutoDentAnomalyIncident('Garsson-io/kaizen', signal, {
      gh: vi.fn(() => 'not json'),
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('Unexpected token');
  });

  it('fails open on GitHub errors', () => {
    const result = fileAutoDentAnomalyIncident('Garsson-io/kaizen', signal, {
      gh: () => {
        throw new Error('permission denied');
      },
    });

    expect(result).toMatchObject({ status: 'skipped', reason: 'permission denied' });
  });
});

describe('fileAutoDentAnomalyIncidentsForBatch', () => {
  it('returns schema-valid result and summary text', () => {
    const state = makeBatchState({
      batch_id: 'batch-result',
      run_history: [run({ run: 1, lifecycle_health: 'critical' })],
    });
    const gh = vi.fn()
      .mockReturnValueOnce('[]')
      .mockReturnValueOnce('https://github.com/Garsson-io/kaizen/issues/902');

    const result = fileAutoDentAnomalyIncidentsForBatch('Garsson-io/kaizen', state, { gh });

    expect(() => AutoDentAnomalyIncidentResultSchema.parse(result)).not.toThrow();
    expect(formatAutoDentAnomalyIncidentSummary(result)).toContain('1 signal(s); 1 created');
    expect(formatAutoDentAnomalyIncidentSummary(result)).toContain('https://github.com/Garsson-io/kaizen/issues/902');
  });

  it('caps filed signals when maxSignals is set', () => {
    const state = makeBatchState({
      batch_id: 'batch-capped',
      run_history: [
        run({ run: 1, exit_code: 1, failure_class: 'crash' }),
        run({ run: 2, exit_code: 1, failure_class: 'crash' }),
        run({ run: 3, exit_code: 1, failure_class: 'crash' }),
      ],
    });
    const gh = vi.fn()
      .mockReturnValueOnce('[]')
      .mockReturnValueOnce('https://github.com/Garsson-io/kaizen/issues/903')
      .mockReturnValueOnce('[]')
      .mockReturnValueOnce('https://github.com/Garsson-io/kaizen/issues/904');

    const result = fileAutoDentAnomalyIncidentsForBatch('Garsson-io/kaizen', state, {
      gh,
      maxSignals: 2,
    });

    expect(result.signals).toHaveLength(2);
    expect(result.refs).toHaveLength(2);
    expect(gh).toHaveBeenCalledTimes(4);
  });

  it('builds incident bodies with evidence bullets', () => {
    const signal = detectAutoDentAnomalies(makeBatchState({
      batch_id: 'batch-file',
      run_history: [run({ run: 1, lifecycle_health: 'critical' })],
    }))[0];
    const body = buildAutoDentAnomalyIncidentBody(signal);

    expect(body).toContain('- batch=batch-file');
    expect(body).toContain('false positive');
  });
});
