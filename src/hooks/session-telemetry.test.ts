import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countChangedFiles,
  emitSessionEvent,
  type SessionEventEnvelope,
  type SessionPrCreatedEvent,
  type SessionReflectionEvent,
  type SessionStopGateEvent,
} from './session-telemetry.js';

describe('emitSessionEvent', () => {
  it('writes a pr_created event with correct envelope', () => {
    const dir = `/tmp/.test-st-${Date.now()}-a`;
    emitSessionEvent(
      {
        type: 'session.pr_created',
        session_id: 'test-session-1',
        pr_url: 'https://github.com/Garsson-io/kaizen/pull/42',
        branch: 'feat-test',
        changed_files_count: 3,
      },
      { telemetryDir: dir, now: new Date('2026-03-23T08:00:00Z') },
    );
    const content = readFileSync(join(dir, 'events.jsonl'), 'utf-8').trim();
    const envelope = JSON.parse(content) as SessionEventEnvelope;
    expect(envelope.source).toBe('interactive');
    expect(envelope.timestamp).toBe('2026-03-23T08:00:00.000Z');
    expect(envelope.event.type).toBe('session.pr_created');
    expect((envelope.event as SessionPrCreatedEvent).pr_url).toBe(
      'https://github.com/Garsson-io/kaizen/pull/42',
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends multiple event types', () => {
    const dir = `/tmp/.test-st-${Date.now()}-b`;
    emitSessionEvent(
      { type: 'session.pr_merged', session_id: 's2', pr_url: 'url', branch: 'b', changed_files_count: 5 },
      { telemetryDir: dir },
    );
    emitSessionEvent(
      { type: 'session.reflection', session_id: 's3', pr_url: 'url', impediments_count: 2 },
      { telemetryDir: dir },
    );
    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]) as SessionEventEnvelope).event.type).toBe('session.pr_merged');
    const ev2 = (JSON.parse(lines[1]) as SessionEventEnvelope).event as SessionReflectionEvent;
    expect(ev2.impediments_count).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates nested directories', () => {
    const dir = `/tmp/.test-st-${Date.now()}-c`;
    const nested = join(dir, 'nested', 'deep');
    emitSessionEvent(
      { type: 'session.pr_created', session_id: 's1', pr_url: 'u', branch: 'b', changed_files_count: 0 },
      { telemetryDir: nested },
    );
    expect(existsSync(join(nested, 'events.jsonl'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a stop_gate event with diagnostics', () => {
    const dir = `/tmp/.test-st-${Date.now()}-sg`;
    emitSessionEvent(
      {
        type: 'session.stop_gate',
        branch: 'feat/test-branch',
        decision: 'block',
        gates_count: 2,
        gate_types: ['review', 'reflection'],
        total_state_files: 5,
        included_files: 2,
        excluded_files: 3,
        exclude_reasons: { stale: 1, no_branch: 0, wrong_branch: 2, read_error: 0 },
      },
      { telemetryDir: dir, now: new Date('2026-03-24T10:00:00Z') },
    );
    const content = readFileSync(join(dir, 'events.jsonl'), 'utf-8').trim();
    const envelope = JSON.parse(content) as SessionEventEnvelope;
    expect(envelope.source).toBe('interactive');
    const event = envelope.event as SessionStopGateEvent;
    expect(event.type).toBe('session.stop_gate');
    expect(event.decision).toBe('block');
    expect(event.gates_count).toBe(2);
    expect(event.gate_types).toEqual(['review', 'reflection']);
    expect(event.total_state_files).toBe(5);
    expect(event.excluded_files).toBe(3);
    expect(event.exclude_reasons.wrong_branch).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('silently ignores write errors', () => {
    expect(() => {
      emitSessionEvent(
        { type: 'session.pr_created', session_id: 's1', pr_url: 'u', branch: 'b', changed_files_count: 0 },
        { telemetryDir: '/dev/null/impossible' },
      );
    }).not.toThrow();
  });
});

describe('countChangedFiles', () => {
  it('handles all edge cases', () => {
    expect(countChangedFiles('a.ts\nb.ts\nc.ts')).toBe(3);
    expect(countChangedFiles('')).toBe(0);
    expect(countChangedFiles('  \n  ')).toBe(0);
    expect(countChangedFiles('a.ts\nb.ts\n')).toBe(2);
  });
});
