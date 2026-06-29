import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  parseReplayEventsJsonl,
  projectReplayRuns,
  readReplayEventsFile,
  replayCapturedRun,
} from './auto-dent-replay.js';
import {
  captureToEvents,
  captureToRunMetrics,
  runStream,
  scenarios,
} from './auto-dent-harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const fixtureRoot = join(repoRoot, 'fixtures', 'auto-dent-replay');

describe('auto-dent replay fixtures', () => {
  it('replays a committed captured-run fixture into typed event summaries', () => {
    const result = replayCapturedRun(join(fixtureRoot, 'basic-run'));

    expect(result.events).toHaveLength(4);
    expect(result.malformedRows).toEqual([]);
    expect(result.invalidRows).toEqual([]);
    expect(result.summary).toEqual({
      batchIds: ['fixture-batch'],
      runIds: ['fixture-batch/run-1'],
      runNumbers: [1],
      eventCounts: {
        'run.start': 1,
        'run.issue_picked': 1,
        'run.pr_created': 1,
        'run.complete': 1,
      },
    });
  });

  it('preserves malformed and invalid-row diagnostics while parsing valid rows', () => {
    const result = replayCapturedRun(join(fixtureRoot, 'malformed-run'));

    expect(result.events.map((event) => event.event.type)).toEqual([
      'run.start',
      'batch.reflect',
    ]);
    expect(result.malformedRows).toEqual([{ lineNumber: 2, raw: 'not-json' }]);
    expect(result.invalidRows).toHaveLength(1);
    expect(result.invalidRows[0]).toMatchObject({ lineNumber: 3 });
    expect(result.invalidRows[0].raw).toContain('"type":"run.mystery"');
    expect(result.invalidRows[0].message).toEqual(expect.any(String));
    expect(result.invalidRows[0].message).not.toHaveLength(0);
    expect(result.summary.eventCounts).toEqual({
      'run.start': 1,
      'batch.reflect': 1,
    });
  });

  it('can parse JSONL text directly for future non-file artifact sources', () => {
    const content = readFileSync(
      join(fixtureRoot, 'basic-run', 'events.jsonl'),
      'utf8',
    );

    const result = parseReplayEventsJsonl(content);

    expect(result.summary.batchIds).toEqual(['fixture-batch']);
    expect(result.summary.runNumbers).toEqual([1]);
  });

  it('accepts all current review event variants', () => {
    const base = {
      timestamp: '2026-03-26T00:00:00.000Z',
      event: {
        run_id: 'fixture-batch/run-3',
        batch_id: 'fixture-batch',
        run_num: 3,
      },
    };
    const content = [
      {
        ...base,
        event: {
          ...base.event,
          type: 'review.round_start',
          pr_url: 'https://github.com/Garsson-io/kaizen/pull/1678',
          round: 1,
          dimensions: ['correctness', 'test-quality'],
        },
      },
      {
        ...base,
        event: {
          ...base.event,
          type: 'review.round_complete',
          pr_url: 'https://github.com/Garsson-io/kaizen/pull/1678',
          round: 1,
          verdict: 'pass',
          missing_count: 0,
          partial_count: 0,
          cost_usd: 0.25,
          duration_ms: 1000,
        },
      },
      {
        ...base,
        event: {
          ...base.event,
          type: 'review.fix_spawned',
          pr_url: 'https://github.com/Garsson-io/kaizen/pull/1678',
          round: 1,
          gaps_count: 2,
        },
      },
      {
        ...base,
        event: {
          ...base.event,
          type: 'review.fix_complete',
          pr_url: 'https://github.com/Garsson-io/kaizen/pull/1678',
          round: 1,
          success: true,
          cost_usd: 0.1,
        },
      },
    ].map((event) => JSON.stringify(event)).join('\n');

    const result = parseReplayEventsJsonl(content);

    expect(result.invalidRows).toEqual([]);
    expect(result.events.map((event) => event.event.type)).toEqual([
      'review.round_start',
      'review.round_complete',
      'review.fix_spawned',
      'review.fix_complete',
    ]);
    expect(result.summary.eventCounts).toEqual({
      'review.round_start': 1,
      'review.round_complete': 1,
      'review.fix_spawned': 1,
      'review.fix_complete': 1,
    });
  });

  it('returns an empty summary for empty JSONL input', () => {
    const result = parseReplayEventsJsonl('\n\n');

    expect(result).toMatchObject({
      events: [],
      malformedRows: [],
      invalidRows: [],
      summary: {
        batchIds: [],
        runIds: [],
        runNumbers: [],
        eventCounts: {},
      },
    });
  });

  it('sorts multi-batch and multi-run summary identity fields', () => {
    const content = [
      {
        timestamp: '2026-03-26T00:00:00.000Z',
        event: {
          type: 'run.start',
          run_id: 'fixture-batch-b/run-2',
          batch_id: 'fixture-batch-b',
          run_num: 2,
          mode: 'exploit',
          mode_reason: 'fixture',
          prompt_template: 'deep-dive-default.md',
          prompt_hash: 'bbb',
        },
      },
      {
        timestamp: '2026-03-26T00:01:00.000Z',
        event: {
          type: 'run.start',
          run_id: 'fixture-batch-a/run-1',
          batch_id: 'fixture-batch-a',
          run_num: 1,
          mode: 'explore',
          mode_reason: 'fixture',
          prompt_template: 'deep-dive-default.md',
          prompt_hash: 'aaa',
        },
      },
      {
        timestamp: '2026-03-26T00:02:00.000Z',
        event: {
          type: 'batch.reflect',
          run_id: 'fixture-batch-a/run-1',
          batch_id: 'fixture-batch-a',
          run_num: 1,
          recommendations_count: 1,
        },
      },
    ].map((event) => JSON.stringify(event)).join('\n');

    const result = parseReplayEventsJsonl(content);

    expect(result.summary).toEqual({
      batchIds: ['fixture-batch-a', 'fixture-batch-b'],
      runIds: ['fixture-batch-a/run-1', 'fixture-batch-b/run-2'],
      runNumbers: [1, 2],
      eventCounts: {
        'run.start': 2,
        'batch.reflect': 1,
      },
    });
  });

  it('reads an events file without depending on mutable local logs paths', () => {
    const result = readReplayEventsFile(
      join(fixtureRoot, 'basic-run', 'events.jsonl'),
    );

    expect(result.sourcePath).toContain('fixtures/auto-dent-replay/basic-run/events.jsonl');
    expect(result.sourcePath).not.toContain('logs/auto-dent');
  });

  it('throws a diagnostic error when an events file is missing', () => {
    const missingPath = join(fixtureRoot, 'missing-run', 'events.jsonl');

    expect(() => readReplayEventsFile(missingPath)).toThrow(
      `events.jsonl not found: ${missingPath}`,
    );
  });

  it('does not wire replay into auto-dent finalization in the schema PR', () => {
    const runSource = readFileSync(
      new URL('./auto-dent-run.ts', import.meta.url),
      'utf8',
    );

    expect(runSource).not.toContain('auto-dent-replay');
  });

  it('projects replayed fixture events into current run-metrics fields', () => {
    const result = replayCapturedRun(join(fixtureRoot, 'basic-run'));

    const projections = projectReplayRuns(result.events);

    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      batch_id: 'fixture-batch',
      run_id: 'fixture-batch/run-1',
      run: 1,
      run_num: 1,
      mode: 'exploit',
      mode_reason: 'fixture',
      prompt_template: 'deep-dive-default.md',
      prompt_hash: 'abc123',
      issue: '#1678',
      issue_title: 'Event replay schema and captured-run fixtures',
      labels: ['kaizen', 'auto-dent', 'area/auto-dent'],
      prs: ['https://github.com/Garsson-io/kaizen/pull/1678'],
      duration_seconds: 180,
      exit_code: 0,
      cost_usd: 1.25,
      tool_calls: 42,
      prs_created: 1,
      issues_filed_count: 0,
      issues_closed_count: 1,
      stop_requested: false,
      lifecycle_violations: 0,
      outcome: 'success',
      workflow_gate_states: {
        'ticket-identity': 'done',
        'plan-testplan': 'done',
      },
    });
    expect(projections[0].missingFromEvents).toEqual(
      expect.arrayContaining(['cases', 'issues_filed', 'issues_closed']),
    );
  });

  it('preserves workflow gate repair fields from run.complete events', () => {
    const content = JSON.stringify({
      timestamp: '2026-03-26T00:03:00.000Z',
      event: {
        type: 'run.complete',
        run_id: 'fixture-batch/run-4',
        batch_id: 'fixture-batch',
        run_num: 4,
        duration_ms: 1000,
        exit_code: 1,
        cost_usd: 0.5,
        tool_calls: 7,
        prs_created: 1,
        issues_filed: 0,
        issues_closed: 0,
        stop_requested: false,
        lifecycle_violations: 2,
        outcome: 'failure',
        workflow_gate_states: {
          'dry-refactor': 'pending',
          'meet-reality': 'invalid',
        },
        workflow_repair_gates: ['dry-refactor', 'meet-reality'],
        workflow_repair_state: 'repair_scheduled',
        workflow_repair_prompt: 'Record dry/refactor and meet-reality evidence.',
      },
    });

    const [projection] = projectReplayRuns(parseReplayEventsJsonl(content).events);

    expect(projection).toMatchObject({
      workflow_gate_states: {
        'dry-refactor': 'pending',
        'meet-reality': 'invalid',
      },
      workflow_repair_gates: ['dry-refactor', 'meet-reality'],
      workflow_repair_state: 'repair_scheduled',
      workflow_repair_prompt: 'Record dry/refactor and meet-reality evidence.',
    });
  });

  it('matches synthetic harness RunMetrics for event-representable fields', () => {
    const capture = runStream(scenarios.successfulRun({
      issue: '#1679',
      title: 'State projection parity from events.jsonl',
      prUrl: 'https://github.com/Garsson-io/kaizen/pull/1679',
      cost: 2.25,
    }));
    const metrics = captureToRunMetrics(capture, {
      runNum: 7,
      mode: 'exploit',
    });
    const events = captureToEvents(capture, {
      batchId: 'synthetic-batch',
      runNum: 7,
      mode: 'exploit',
    });

    const [projection] = projectReplayRuns(events);

    expect(projection).toMatchObject({
      run: metrics.run,
      run_num: metrics.run,
      exit_code: metrics.exit_code,
      cost_usd: metrics.cost_usd,
      tool_calls: metrics.tool_calls,
      prs: metrics.prs,
      stop_requested: metrics.stop_requested,
      mode: metrics.mode,
      lifecycle_violations: metrics.lifecycle_violations,
    });
    expect(projection.issue).toBe('#1679');
    expect(projection.issue_title).toBe('State projection parity from events.jsonl');
  });

  it('reports missing source events without fabricating unavailable state', () => {
    const startOnly = parseReplayEventsJsonl(JSON.stringify({
      timestamp: '2026-03-26T00:00:00.000Z',
      event: {
        type: 'run.start',
        run_id: 'fixture-batch/run-5',
        batch_id: 'fixture-batch',
        run_num: 5,
        mode: 'exploit',
        mode_reason: 'partial fixture',
        prompt_template: 'deep-dive-default.md',
        prompt_hash: 'partial',
      },
    }));

    const [projection] = projectReplayRuns(startOnly.events);

    expect(projection).toMatchObject({
      run_id: 'fixture-batch/run-5',
      run: 5,
      mode: 'exploit',
      prs: [],
    });
    expect(projection.duration_seconds).toBeUndefined();
    expect(projection.exit_code).toBeUndefined();
    expect(projection.missingFromEvents).toEqual(
      expect.arrayContaining(['run.complete', 'cases', 'issues_filed', 'issues_closed']),
    );
  });

  it('projects multiple PR events for the same run', () => {
    const base = {
      timestamp: '2026-03-26T00:00:00.000Z',
      event: {
        run_id: 'fixture-batch/run-6',
        batch_id: 'fixture-batch',
        run_num: 6,
      },
    };
    const content = [
      {
        ...base,
        event: {
          ...base.event,
          type: 'run.pr_created',
          pr_url: 'https://github.com/Garsson-io/kaizen/pull/1701',
        },
      },
      {
        ...base,
        event: {
          ...base.event,
          type: 'run.pr_created',
          pr_url: 'https://github.com/Garsson-io/kaizen/pull/1702',
        },
      },
      {
        ...base,
        event: {
          ...base.event,
          type: 'run.complete',
          duration_ms: 2000,
          exit_code: 0,
          cost_usd: 1,
          tool_calls: 3,
          prs_created: 2,
          issues_filed: 0,
          issues_closed: 2,
          stop_requested: false,
          lifecycle_violations: 0,
          outcome: 'success',
        },
      },
    ].map((event) => JSON.stringify(event)).join('\n');

    const [projection] = projectReplayRuns(parseReplayEventsJsonl(content).events);

    expect(projection.prs).toEqual([
      'https://github.com/Garsson-io/kaizen/pull/1701',
      'https://github.com/Garsson-io/kaizen/pull/1702',
    ]);
    expect(projection.prs_created).toBe(2);
    expect(projection.issues_closed_count).toBe(2);
  });
});
