import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeHookTelemetry,
  buildReport,
  computeHookStats,
  formatReport,
  parseHooksJsonl,
  type HookTelemetryRecord,
} from './telemetry-analysis.js';

const SAMPLE_RECORDS: HookTelemetryRecord[] = [
  { hook: 'kaizen-enforce-pr-review', timestamp: '2026-03-23T08:35:58.815Z', duration_ms: 63, exit_code: 0, branch: 'main', case_id: '' },
  { hook: 'kaizen-enforce-pr-review', timestamp: '2026-03-23T08:36:00.581Z', duration_ms: 63, exit_code: 0, branch: 'main', case_id: '' },
  { hook: 'kaizen-enforce-pr-review', timestamp: '2026-03-23T08:36:01.763Z', duration_ms: 66, exit_code: 0, branch: 'main', case_id: '' },
  { hook: 'kaizen-enforce-pr-review', timestamp: '2026-03-23T08:36:14.864Z', duration_ms: 60, exit_code: 0, branch: 'main', case_id: '' },
  { hook: 'kaizen-enforce-pr-review', timestamp: '2026-03-23T08:40:00.000Z', duration_ms: 250, exit_code: 0, branch: 'main', case_id: '' },
  { hook: 'kaizen-block-git-rebase', timestamp: '2026-03-23T08:35:58.821Z', duration_ms: 10, exit_code: 0, branch: 'main', case_id: '' },
  { hook: 'kaizen-block-git-rebase', timestamp: '2026-03-23T08:36:00.586Z', duration_ms: 22, exit_code: 0, branch: 'main', case_id: '' },
  { hook: 'kaizen-block-git-rebase', timestamp: '2026-03-23T08:36:01.769Z', duration_ms: 21, exit_code: 0, branch: 'main', case_id: '' },
  { hook: 'kaizen-session-cleanup', timestamp: '2026-03-23T08:35:42.990Z', duration_ms: 33, exit_code: 0, branch: 'main', case_id: '' },
  { hook: 'kaizen-session-cleanup', timestamp: '2026-03-23T08:42:00.000Z', duration_ms: 40, exit_code: 1, branch: 'main', case_id: '' },
];

describe('parseHooksJsonl', () => {
  it('parses valid JSONL lines', () => {
    const content = [
      '{"hook":"kaizen-foo","timestamp":"2026-03-23T08:00:00Z","duration_ms":50,"exit_code":0,"branch":"main","case_id":""}',
      '{"hook":"kaizen-bar","timestamp":"2026-03-23T08:01:00Z","duration_ms":120,"exit_code":1,"branch":"feat","case_id":"abc"}',
    ].join('\n');
    const records = parseHooksJsonl(content);
    expect(records).toHaveLength(2);
    expect(records[0].hook).toBe('kaizen-foo');
    expect(records[0].duration_ms).toBe(50);
    expect(records[1].exit_code).toBe(1);
    expect(records[1].case_id).toBe('abc');
  });

  it('skips malformed lines', () => {
    const content = [
      '{"hook":"valid","timestamp":"2026-03-23T08:00:00Z","duration_ms":50}',
      'not json',
      '{"no_hook_field": true}',
      '',
      '{"hook":"also-valid","timestamp":"2026-03-23T08:01:00Z","duration_ms":30}',
    ].join('\n');
    const records = parseHooksJsonl(content);
    expect(records).toHaveLength(2);
    expect(records[0].hook).toBe('valid');
    expect(records[1].hook).toBe('also-valid');
  });

  it('handles empty content', () => {
    expect(parseHooksJsonl('')).toHaveLength(0);
    expect(parseHooksJsonl('\n\n\n')).toHaveLength(0);
  });

  it('defaults exit_code to 0 when missing', () => {
    const content = '{"hook":"test","timestamp":"2026-03-23T08:00:00Z","duration_ms":10}';
    const records = parseHooksJsonl(content);
    expect(records[0].exit_code).toBe(0);
  });
});

describe('computeHookStats', () => {
  it('computes correct statistics per hook', () => {
    const stats = computeHookStats(SAMPLE_RECORDS);
    expect(stats.length).toBe(3);

    const prReview = stats.find((s) => s.hook === 'kaizen-enforce-pr-review');
    expect(prReview).toBeDefined();
    expect(prReview!.count).toBe(5);
    expect(prReview!.max_ms).toBe(250);
    expect(prReview!.failures).toBe(0);
    expect(prReview!.failure_rate).toBe(0);
  });

  it('calculates failure rate correctly', () => {
    const stats = computeHookStats(SAMPLE_RECORDS);
    const cleanup = stats.find((s) => s.hook === 'kaizen-session-cleanup');
    expect(cleanup).toBeDefined();
    expect(cleanup!.count).toBe(2);
    expect(cleanup!.failures).toBe(1);
    expect(cleanup!.failure_rate).toBe(0.5);
  });

  it('sorts by avg_ms descending', () => {
    const stats = computeHookStats(SAMPLE_RECORDS);
    for (let i = 1; i < stats.length; i++) {
      expect(stats[i - 1].avg_ms).toBeGreaterThanOrEqual(stats[i].avg_ms);
    }
  });

  it('handles empty input', () => {
    expect(computeHookStats([])).toHaveLength(0);
  });

  it('computes p95 for single-record hooks', () => {
    const stats = computeHookStats([
      { hook: 'solo', timestamp: '2026-03-23T08:00:00Z', duration_ms: 42, exit_code: 0, branch: '', case_id: '' },
    ]);
    expect(stats[0].p95_ms).toBe(42);
    expect(stats[0].avg_ms).toBe(42);
  });
});

describe('buildReport', () => {
  it('identifies slow hooks based on p95 threshold', () => {
    const report = buildReport(SAMPLE_RECORDS);
    expect(report.total_records).toBe(SAMPLE_RECORDS.length);
    expect(report.time_range).not.toBeNull();
    expect(report.hooks.length).toBe(3);
    // kaizen-enforce-pr-review has p95 of 250ms which exceeds 100ms threshold
    expect(report.slow_hooks.some((h) => h.hook === 'kaizen-enforce-pr-review')).toBe(true);
  });

  it('identifies high failure rate hooks', () => {
    // kaizen-session-cleanup has 50% failure rate but only 2 calls (< 5 minimum)
    const report = buildReport(SAMPLE_RECORDS);
    expect(report.high_failure_hooks.some((h) => h.hook === 'kaizen-session-cleanup')).toBe(false);

    // Create a hook with enough calls and failures
    const failRecords: HookTelemetryRecord[] = Array.from({ length: 10 }, (_, i) => ({
      hook: 'kaizen-flaky',
      timestamp: `2026-03-23T08:${String(i).padStart(2, '0')}:00Z`,
      duration_ms: 20,
      exit_code: i < 2 ? 1 : 0,
      branch: '',
      case_id: '',
    }));
    const report2 = buildReport(failRecords);
    expect(report2.high_failure_hooks.some((h) => h.hook === 'kaizen-flaky')).toBe(true);
  });

  it('calculates event count from timestamp clusters', () => {
    // Records within 2s of each other form one event
    const report = buildReport(SAMPLE_RECORDS);
    // The sample data has clusters at ~08:35:42, ~08:35:58-08:36:02, ~08:36:14, ~08:40:00, ~08:42:00
    expect(report.avg_overhead_per_event_ms).toBeGreaterThan(0);
  });

  it('handles empty records', () => {
    const report = buildReport([]);
    expect(report.total_records).toBe(0);
    expect(report.time_range).toBeNull();
    expect(report.hooks).toHaveLength(0);
    expect(report.total_overhead_ms).toBe(0);
    expect(report.avg_overhead_per_event_ms).toBe(0);
  });
});

describe('formatReport', () => {
  it('formats a report with slow hooks', () => {
    const report = buildReport(SAMPLE_RECORDS);
    const formatted = formatReport(report);
    expect(formatted).toContain('HOOK TELEMETRY ANALYSIS');
    expect(formatted).toContain('kaizen-enforce-pr-review');
    expect(formatted).toContain('Slow hooks');
  });

  it('returns empty string for empty report', () => {
    const report = buildReport([]);
    expect(formatReport(report)).toBe('');
  });

  it('shows all-clear message when no issues', () => {
    const fastRecords: HookTelemetryRecord[] = [
      { hook: 'fast-hook', timestamp: '2026-03-23T08:00:00Z', duration_ms: 5, exit_code: 0, branch: '', case_id: '' },
      { hook: 'fast-hook', timestamp: '2026-03-23T08:01:00Z', duration_ms: 8, exit_code: 0, branch: '', case_id: '' },
    ];
    const report = buildReport(fastRecords);
    const formatted = formatReport(report);
    expect(formatted).toContain('All hooks within performance budgets');
  });
});

describe('analyzeHookTelemetry', () => {
  it('reads hooks.jsonl and produces a report', () => {
    const dir = `/tmp/.test-ta-${Date.now()}-a`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'hooks.jsonl'),
      SAMPLE_RECORDS.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    const result = analyzeHookTelemetry(dir);
    expect(result).toContain('HOOK TELEMETRY ANALYSIS');
    expect(result).toContain(`${SAMPLE_RECORDS.length} records`);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty string when file does not exist', () => {
    expect(analyzeHookTelemetry('/tmp/.nonexistent-telemetry-dir')).toBe('');
  });

  it('returns empty string for empty file', () => {
    const dir = `/tmp/.test-ta-${Date.now()}-b`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hooks.jsonl'), '');
    expect(analyzeHookTelemetry(dir)).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });
});
