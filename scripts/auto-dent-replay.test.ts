import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  parseReplayEventsJsonl,
  readReplayEventsFile,
  replayCapturedRun,
} from './auto-dent-replay.js';

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
    expect(result.invalidRows[0].message).toContain('Invalid input');
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
});
