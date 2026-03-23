import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { EventEnvelope } from './auto-dent-events.js';
import { parseEventsFile, summarizeEvents, formatPlainLanguage } from './batch-summary.js';

function makeEnvelope(event: EventEnvelope['event'], timestamp?: string): EventEnvelope {
  return {
    timestamp: timestamp ?? new Date().toISOString(),
    event,
  };
}

function makeCompleteEvent(overrides: Partial<EventEnvelope['event'] & { type: 'run.complete' }> = {}): EventEnvelope {
  return makeEnvelope({
    type: 'run.complete',
    run_id: 'batch-test/run-1',
    batch_id: 'batch-test',
    run_num: 1,
    duration_ms: 120000,
    exit_code: 0,
    cost_usd: 1.50,
    tool_calls: 42,
    prs_created: 1,
    issues_filed: 0,
    issues_closed: 1,
    stop_requested: false,
    lifecycle_violations: 0,
    outcome: 'success',
    ...overrides,
  });
}

describe('parseEventsFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'batch-summary-'));
  });

  it('returns empty array for non-existent file', () => {
    expect(parseEventsFile(join(tmpDir, 'missing.jsonl'))).toEqual([]);
  });

  it('returns empty array for empty file', () => {
    writeFileSync(join(tmpDir, 'events.jsonl'), '');
    expect(parseEventsFile(join(tmpDir, 'events.jsonl'))).toEqual([]);
  });

  it('parses valid JSONL lines', () => {
    const events = [
      makeCompleteEvent(),
      makeEnvelope({ type: 'run.issue_picked', run_id: 'batch-test/run-1', batch_id: 'batch-test', run_num: 1, issue: '#42', title: 'Fix thing' }),
    ];
    const content = events.map(e => JSON.stringify(e)).join('\n');
    writeFileSync(join(tmpDir, 'events.jsonl'), content);

    const result = parseEventsFile(join(tmpDir, 'events.jsonl'));
    expect(result).toHaveLength(2);
    expect(result[0].event.type).toBe('run.complete');
    expect(result[1].event.type).toBe('run.issue_picked');
  });

  it('skips malformed lines', () => {
    const valid = JSON.stringify(makeCompleteEvent());
    const content = `${valid}\n{broken json\n${valid}`;
    writeFileSync(join(tmpDir, 'events.jsonl'), content);

    const result = parseEventsFile(join(tmpDir, 'events.jsonl'));
    expect(result).toHaveLength(2);
  });
});

describe('summarizeEvents', () => {
  it('aggregates run.complete events correctly', () => {
    const events = [
      makeCompleteEvent({ run_num: 1, cost_usd: 1.00, duration_ms: 60000, prs_created: 1, tool_calls: 20 }),
      makeCompleteEvent({ run_num: 2, cost_usd: 2.00, duration_ms: 120000, prs_created: 2, tool_calls: 30, outcome: 'success' }),
    ];

    const summary = summarizeEvents(events);
    expect(summary.batch_id).toBe('batch-test');
    expect(summary.total_runs).toBe(2);
    expect(summary.successful_runs).toBe(2);
    expect(summary.total_cost_usd).toBe(3.00);
    expect(summary.total_prs).toBe(3);
    expect(summary.total_tool_calls).toBe(50);
  });

  it('counts outcomes correctly', () => {
    const events = [
      makeCompleteEvent({ run_num: 1, outcome: 'success' }),
      makeCompleteEvent({ run_num: 2, outcome: 'failure', failure_class: 'hook-timeout' }),
      makeCompleteEvent({ run_num: 3, outcome: 'failure', failure_class: 'hook-timeout' }),
      makeCompleteEvent({ run_num: 4, outcome: 'stop' }),
    ];

    const summary = summarizeEvents(events);
    expect(summary.successful_runs).toBe(1);
    expect(summary.failed_runs).toBe(2);
    expect(summary.stopped_runs).toBe(1);
    expect(summary.failure_classes).toEqual({ 'hook-timeout': 2 });
  });

  it('deduplicates issues and PRs', () => {
    const events: EventEnvelope[] = [
      makeEnvelope({ type: 'run.issue_picked', run_id: 'b/run-1', batch_id: 'b', run_num: 1, issue: '#10', title: 'A' }),
      makeEnvelope({ type: 'run.issue_picked', run_id: 'b/run-2', batch_id: 'b', run_num: 2, issue: '#10', title: 'A' }),
      makeEnvelope({ type: 'run.issue_picked', run_id: 'b/run-3', batch_id: 'b', run_num: 3, issue: '#20', title: 'B' }),
      makeEnvelope({ type: 'run.pr_created', run_id: 'b/run-1', batch_id: 'b', run_num: 1, pr_url: 'https://github.com/repo/pull/1' }),
      makeEnvelope({ type: 'run.pr_created', run_id: 'b/run-2', batch_id: 'b', run_num: 2, pr_url: 'https://github.com/repo/pull/1' }),
      makeEnvelope({ type: 'run.pr_created', run_id: 'b/run-3', batch_id: 'b', run_num: 3, pr_url: 'https://github.com/repo/pull/2' }),
    ];

    const summary = summarizeEvents(events);
    expect(summary.issues_worked).toEqual(['#10', '#20']);
    expect(summary.prs_created).toEqual(['https://github.com/repo/pull/1', 'https://github.com/repo/pull/2']);
  });

  it('handles empty events', () => {
    const summary = summarizeEvents([]);
    expect(summary.total_runs).toBe(0);
    expect(summary.batch_id).toBe('unknown');
    expect(summary.total_cost_usd).toBe(0);
  });

  it('computes cost_per_pr correctly', () => {
    const events = [
      makeCompleteEvent({ cost_usd: 10.00, prs_created: 5 }),
    ];
    const summary = summarizeEvents(events);
    expect(summary.cost_per_pr_usd).toBe(2.00);
  });

  it('returns zero cost_per_pr when no PRs', () => {
    const events = [
      makeCompleteEvent({ cost_usd: 5.00, prs_created: 0 }),
    ];
    const summary = summarizeEvents(events);
    expect(summary.cost_per_pr_usd).toBe(0);
  });

  it('tracks lifecycle violations', () => {
    const events = [
      makeCompleteEvent({ run_num: 1, lifecycle_violations: 3 }),
      makeCompleteEvent({ run_num: 2, lifecycle_violations: 1 }),
    ];
    const summary = summarizeEvents(events);
    expect(summary.total_lifecycle_violations).toBe(4);
  });
});

describe('formatPlainLanguage', () => {
  it('produces readable markdown output', () => {
    const summary = summarizeEvents([
      makeCompleteEvent({ run_num: 1, cost_usd: 1.50, duration_ms: 300000, prs_created: 1 }),
      makeCompleteEvent({ run_num: 2, cost_usd: 2.00, duration_ms: 600000, prs_created: 1 }),
    ]);
    const text = formatPlainLanguage(summary);

    expect(text).toContain('## Batch Summary: batch-test');
    expect(text).toContain('**2 times**');
    expect(text).toContain('**PRs created:** 2');
    expect(text).toContain('**Total cost:** $3.50');
    expect(text).toContain('**Cost per PR:** $1.75');
  });

  it('shows failure patterns when present', () => {
    const summary = summarizeEvents([
      makeCompleteEvent({ outcome: 'failure', failure_class: 'oom' }),
      makeCompleteEvent({ outcome: 'failure', failure_class: 'oom' }),
      makeCompleteEvent({ outcome: 'failure', failure_class: 'timeout' }),
    ]);
    const text = formatPlainLanguage(summary);

    expect(text).toContain('### Failure Patterns');
    expect(text).toContain('oom: 2 occurrences');
    expect(text).toContain('timeout: 1 occurrence');
  });

  it('shows lifecycle violations when present', () => {
    const summary = summarizeEvents([
      makeCompleteEvent({ lifecycle_violations: 5 }),
    ]);
    const text = formatPlainLanguage(summary);
    expect(text).toContain('**Lifecycle violations:** 5');
  });

  it('omits failure section when no failures', () => {
    const summary = summarizeEvents([
      makeCompleteEvent({ outcome: 'success' }),
    ]);
    const text = formatPlainLanguage(summary);
    expect(text).not.toContain('### Failure Patterns');
  });

  it('formats duration with hours when applicable', () => {
    const summary = summarizeEvents([
      makeCompleteEvent({ duration_ms: 5400000 }), // 90 minutes
    ]);
    const text = formatPlainLanguage(summary);
    expect(text).toContain('1h 30m');
  });

  it('formats duration as minutes only when under an hour', () => {
    const summary = summarizeEvents([
      makeCompleteEvent({ duration_ms: 1800000 }), // 30 minutes
    ]);
    const text = formatPlainLanguage(summary);
    expect(text).toContain('30m');
    expect(text).not.toContain('0h');
  });
});
