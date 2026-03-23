import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  EventEmitter,
  makeRunId,
  type AutoDentEvent,
  type EventEnvelope,
} from './auto-dent-events.js';

function readEvents(filePath: string): EventEnvelope[] {
  const content = readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('makeRunId', () => {
  it('formats batch_id and run number into a run tag', () => {
    expect(makeRunId('batch-260323-0003-072b', 42)).toBe(
      'batch-260323-0003-072b/run-42',
    );
  });
});

describe('EventEmitter', () => {
  let tmpDir: string;
  let emitter: EventEmitter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'events-test-'));
    emitter = new EventEmitter(tmpDir);
  });

  it('writes events.jsonl to the log directory', () => {
    expect(emitter.getFilePath()).toBe(join(tmpDir, 'events.jsonl'));
  });

  it('creates the file on first emit', () => {
    expect(existsSync(emitter.getFilePath())).toBe(false);

    emitter.emit({
      type: 'run.start',
      run_id: 'batch-test/run-1',
      batch_id: 'batch-test',
      run_num: 1,
      mode: 'exploit',
      mode_reason: 'schedule',
      prompt_template: 'deep-dive-default.md',
      prompt_hash: 'abc123def456',
    });

    expect(existsSync(emitter.getFilePath())).toBe(true);
  });

  it('emits run.start with ISO timestamp', () => {
    emitter.emit({
      type: 'run.start',
      run_id: 'batch-test/run-1',
      batch_id: 'batch-test',
      run_num: 1,
      mode: 'exploit',
      mode_reason: 'schedule',
      prompt_template: 'deep-dive-default.md',
      prompt_hash: 'abc123def456',
    });

    const events = readEvents(emitter.getFilePath());
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe('run.start');
    expect(events[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(events[0].event).toMatchObject({
      batch_id: 'batch-test',
      run_num: 1,
      mode: 'exploit',
    });
  });

  it('emits run.issue_picked with issue details', () => {
    emitter.emit({
      type: 'run.issue_picked',
      run_id: 'batch-test/run-2',
      batch_id: 'batch-test',
      run_num: 2,
      issue: '#647',
      title: 'Observability L2 bootstrap',
    });

    const events = readEvents(emitter.getFilePath());
    expect(events[0].event).toMatchObject({
      type: 'run.issue_picked',
      issue: '#647',
      title: 'Observability L2 bootstrap',
    });
  });

  it('emits run.pr_created with PR URL', () => {
    emitter.emit({
      type: 'run.pr_created',
      run_id: 'batch-test/run-3',
      batch_id: 'batch-test',
      run_num: 3,
      pr_url: 'https://github.com/Garsson-io/kaizen/pull/650',
    });

    const events = readEvents(emitter.getFilePath());
    expect(events[0].event).toMatchObject({
      type: 'run.pr_created',
      pr_url: 'https://github.com/Garsson-io/kaizen/pull/650',
    });
  });

  it('emits run.complete with outcome classification', () => {
    emitter.emit({
      type: 'run.complete',
      run_id: 'batch-test/run-4',
      batch_id: 'batch-test',
      run_num: 4,
      duration_ms: 120000,
      exit_code: 0,
      cost_usd: 1.5,
      tool_calls: 42,
      prs_created: 1,
      issues_filed: 0,
      issues_closed: 1,
      stop_requested: false,
      failure_class: undefined,
      lifecycle_violations: 0,
      outcome: 'success',
    });

    const events = readEvents(emitter.getFilePath());
    expect(events[0].event).toMatchObject({
      type: 'run.complete',
      outcome: 'success',
      cost_usd: 1.5,
      prs_created: 1,
    });
  });

  it('emits batch.reflect with recommendation count', () => {
    emitter.emit({
      type: 'batch.reflect',
      run_id: 'batch-test/run-5',
      batch_id: 'batch-test',
      run_num: 5,
      recommendations_count: 3,
    });

    const events = readEvents(emitter.getFilePath());
    expect(events[0].event).toMatchObject({
      type: 'batch.reflect',
      recommendations_count: 3,
    });
  });

  it('appends multiple events as separate lines', () => {
    emitter.emit({
      type: 'run.start',
      run_id: 'batch-test/run-1',
      batch_id: 'batch-test',
      run_num: 1,
      mode: 'exploit',
      mode_reason: 'schedule',
      prompt_template: 'deep-dive-default.md',
      prompt_hash: 'abc123',
    });
    emitter.emit({
      type: 'run.issue_picked',
      run_id: 'batch-test/run-1',
      batch_id: 'batch-test',
      run_num: 1,
      issue: '#100',
      title: 'test',
    });
    emitter.emit({
      type: 'run.complete',
      run_id: 'batch-test/run-1',
      batch_id: 'batch-test',
      run_num: 1,
      duration_ms: 60000,
      exit_code: 0,
      cost_usd: 0.5,
      tool_calls: 10,
      prs_created: 1,
      issues_filed: 0,
      issues_closed: 0,
      stop_requested: false,
      lifecycle_violations: 0,
      outcome: 'success',
    });

    const events = readEvents(emitter.getFilePath());
    expect(events).toHaveLength(3);
    expect(events[0].event.type).toBe('run.start');
    expect(events[1].event.type).toBe('run.issue_picked');
    expect(events[2].event.type).toBe('run.complete');
  });

  it('each event line is valid JSON (JSONL format)', () => {
    emitter.emit({
      type: 'run.start',
      run_id: 'batch-test/run-1',
      batch_id: 'batch-test',
      run_num: 1,
      mode: 'explore',
      mode_reason: 'signal:no-recent-prs',
      prompt_template: 'explore-gaps.md',
      prompt_hash: 'xyz789',
    });

    const raw = readFileSync(emitter.getFilePath(), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    // Each line must parse independently
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('emitAt uses the provided timestamp instead of now', () => {
    const pastDate = new Date('2026-01-15T10:30:00.000Z');
    emitter.emitAt(pastDate, {
      type: 'run.start',
      run_id: 'batch-test/run-1',
      batch_id: 'batch-test',
      run_num: 1,
      mode: 'exploit',
      mode_reason: 'schedule',
      prompt_template: 'test.md',
      prompt_hash: 'abc',
      start_epoch: 1736935800,
    });

    const events = readEvents(emitter.getFilePath());
    expect(events).toHaveLength(1);
    expect(events[0].timestamp).toBe('2026-01-15T10:30:00.000Z');
    expect((events[0].event as any).start_epoch).toBe(1736935800);
  });

  it('emits run.complete with empty_success outcome', () => {
    emitter.emit({
      type: 'run.complete',
      run_id: 'batch-test/run-1',
      batch_id: 'batch-test',
      run_num: 1,
      duration_ms: 120000,
      exit_code: 0,
      cost_usd: 1.0,
      tool_calls: 30,
      prs_created: 0,
      issues_filed: 0,
      issues_closed: 0,
      stop_requested: false,
      lifecycle_violations: 0,
      outcome: 'empty_success',
      mode: 'exploit',
    });

    const events = readEvents(emitter.getFilePath());
    expect(events[0].event).toMatchObject({
      type: 'run.complete',
      outcome: 'empty_success',
      mode: 'exploit',
    });
  });

  it('emits run.complete with mode field for explore runs', () => {
    emitter.emit({
      type: 'run.complete',
      run_id: 'batch-test/run-2',
      batch_id: 'batch-test',
      run_num: 2,
      duration_ms: 180000,
      exit_code: 0,
      cost_usd: 2.0,
      tool_calls: 50,
      prs_created: 0,
      issues_filed: 3,
      issues_closed: 0,
      stop_requested: false,
      lifecycle_violations: 0,
      outcome: 'success',
      mode: 'explore',
    });

    const events = readEvents(emitter.getFilePath());
    expect(events[0].event).toMatchObject({
      type: 'run.complete',
      outcome: 'success',
      mode: 'explore',
      issues_filed: 3,
    });
  });

  it('silently handles write errors without throwing', () => {
    // Point at a non-existent deep path — appendFileSync will fail
    const badEmitter = new EventEmitter('/nonexistent/deeply/nested/path');
    expect(() =>
      badEmitter.emit({
        type: 'run.start',
        run_id: 'batch-test/run-1',
        batch_id: 'batch-test',
        run_num: 1,
        mode: 'exploit',
        mode_reason: 'schedule',
        prompt_template: 'test.md',
        prompt_hash: 'abc',
      }),
    ).not.toThrow();
  });
});
