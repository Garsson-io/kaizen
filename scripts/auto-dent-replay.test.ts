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

  it('reads an events file without depending on mutable local logs paths', () => {
    const result = readReplayEventsFile(
      join(fixtureRoot, 'basic-run', 'events.jsonl'),
    );

    expect(result.sourcePath).toContain('fixtures/auto-dent-replay/basic-run/events.jsonl');
    expect(result.sourcePath).not.toContain('logs/auto-dent');
  });

  it('does not wire replay into auto-dent finalization in the schema PR', () => {
    const runSource = readFileSync(
      new URL('./auto-dent-run.ts', import.meta.url),
      'utf8',
    );

    expect(runSource).not.toContain('auto-dent-replay');
  });
});
