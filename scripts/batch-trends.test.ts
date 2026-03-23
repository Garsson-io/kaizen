import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { EventEnvelope } from './auto-dent-events.js';
import {
  discoverBatchDirs,
  toDataPoint,
  computeTrend,
  analyzeTrends,
  formatTrendReport,
} from './batch-trends.js';
import { summarizeEvents } from './batch-summary.js';

function makeCompleteEnvelope(overrides: Record<string, unknown> = {}, timestamp?: string): EventEnvelope {
  return {
    timestamp: timestamp ?? new Date().toISOString(),
    event: {
      type: 'run.complete' as const,
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
      outcome: 'success' as const,
      ...overrides,
    } as EventEnvelope['event'],
  };
}

function writeBatchEvents(dir: string, envelopes: EventEnvelope[]): void {
  const content = envelopes.map(e => JSON.stringify(e)).join('\n');
  writeFileSync(join(dir, 'events.jsonl'), content);
}

describe('discoverBatchDirs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'batch-trends-'));
  });

  it('returns empty array for non-existent directory', () => {
    expect(discoverBatchDirs(join(tmpDir, 'nope'))).toEqual([]);
  });

  it('finds subdirectories containing events.jsonl', () => {
    const batch1 = join(tmpDir, 'batch-001');
    const batch2 = join(tmpDir, 'batch-002');
    const emptyDir = join(tmpDir, 'no-events');

    mkdirSync(batch1);
    mkdirSync(batch2);
    mkdirSync(emptyDir);

    writeFileSync(join(batch1, 'events.jsonl'), '{}');
    writeFileSync(join(batch2, 'events.jsonl'), '{}');

    const result = discoverBatchDirs(tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('batch-001');
    expect(result[1]).toContain('batch-002');
  });

  it('ignores files (non-directories) in parent', () => {
    writeFileSync(join(tmpDir, 'some-file.txt'), 'hello');
    expect(discoverBatchDirs(tmpDir)).toEqual([]);
  });
});

describe('toDataPoint', () => {
  it('converts BatchSummary to BatchDataPoint with correct success rate', () => {
    const summary = summarizeEvents([
      makeCompleteEnvelope({ run_num: 1, outcome: 'success' }),
      makeCompleteEnvelope({ run_num: 2, outcome: 'failure', failure_class: 'oom' }),
    ]);

    const dp = toDataPoint(summary, '2026-03-20T00:00:00Z');
    expect(dp.success_rate).toBe(50);
    expect(dp.total_runs).toBe(2);
    expect(dp.timestamp).toBe('2026-03-20T00:00:00Z');
  });

  it('handles zero runs without division error', () => {
    const summary = summarizeEvents([]);
    const dp = toDataPoint(summary, '2026-03-20T00:00:00Z');
    expect(dp.success_rate).toBe(0);
  });
});

describe('computeTrend', () => {
  it('returns insufficient_data for single value', () => {
    const result = computeTrend([5], true);
    expect(result.direction).toBe('insufficient_data');
  });

  it('returns insufficient_data for empty array', () => {
    const result = computeTrend([], true);
    expect(result.direction).toBe('insufficient_data');
  });

  it('detects improving trend (lower is better)', () => {
    // First half avg = 10, second half avg = 5, -50% change
    const result = computeTrend([10, 10, 5, 5], true);
    expect(result.direction).toBe('improving');
    expect(result.change_pct).toBeLessThan(0);
  });

  it('detects worsening trend (lower is better)', () => {
    // First half avg = 5, second half avg = 10, +100% change
    const result = computeTrend([5, 5, 10, 10], true);
    expect(result.direction).toBe('worsening');
    expect(result.change_pct).toBeGreaterThan(0);
  });

  it('detects improving trend (higher is better)', () => {
    // First half avg = 50, second half avg = 90, +80% change
    const result = computeTrend([50, 50, 90, 90], false);
    expect(result.direction).toBe('improving');
    expect(result.change_pct).toBeGreaterThan(0);
  });

  it('detects stable when change is below threshold', () => {
    const result = computeTrend([10, 10, 10.2, 10.2], true);
    expect(result.direction).toBe('stable');
  });

  it('handles zero first half without division error', () => {
    const result = computeTrend([0, 0, 5, 5], true);
    expect(result.change_pct).toBe(0);
  });
});

describe('analyzeTrends', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'batch-trends-analyze-'));
  });

  it('produces report from multiple batch directories', () => {
    const batch1 = join(tmpDir, 'batch-001');
    const batch2 = join(tmpDir, 'batch-002');
    mkdirSync(batch1);
    mkdirSync(batch2);

    writeBatchEvents(batch1, [
      makeCompleteEnvelope({ batch_id: 'batch-001', cost_usd: 2.0, prs_created: 2 }, '2026-03-19T10:00:00Z'),
      makeCompleteEnvelope({ batch_id: 'batch-001', cost_usd: 3.0, prs_created: 1, run_num: 2 }, '2026-03-19T11:00:00Z'),
    ]);
    writeBatchEvents(batch2, [
      makeCompleteEnvelope({ batch_id: 'batch-002', cost_usd: 1.5, prs_created: 3 }, '2026-03-20T10:00:00Z'),
    ]);

    const report = analyzeTrends([batch1, batch2]);
    expect(report.batch_count).toBe(2);
    expect(report.datapoints).toHaveLength(2);
    expect(report.totals.total_prs).toBe(6);
    expect(report.totals.total_cost_usd).toBe(6.5);
    expect(report.date_range.earliest).toContain('2026-03-19');
    expect(report.date_range.latest).toContain('2026-03-20');
  });

  it('skips directories with no events', () => {
    const batch1 = join(tmpDir, 'batch-empty');
    mkdirSync(batch1);
    writeFileSync(join(batch1, 'events.jsonl'), '');

    const batch2 = join(tmpDir, 'batch-has-data');
    mkdirSync(batch2);
    writeBatchEvents(batch2, [
      makeCompleteEnvelope({ batch_id: 'batch-has-data' }, '2026-03-20T10:00:00Z'),
    ]);

    const report = analyzeTrends([batch1, batch2]);
    expect(report.batch_count).toBe(1);
  });

  it('returns empty report for no valid data', () => {
    const report = analyzeTrends([]);
    expect(report.batch_count).toBe(0);
    expect(report.datapoints).toEqual([]);
  });

  it('sorts datapoints by timestamp', () => {
    const batch1 = join(tmpDir, 'zzz-later');
    const batch2 = join(tmpDir, 'aaa-earlier');
    mkdirSync(batch1);
    mkdirSync(batch2);

    writeBatchEvents(batch1, [
      makeCompleteEnvelope({ batch_id: 'later' }, '2026-03-22T10:00:00Z'),
    ]);
    writeBatchEvents(batch2, [
      makeCompleteEnvelope({ batch_id: 'earlier' }, '2026-03-20T10:00:00Z'),
    ]);

    const report = analyzeTrends([batch1, batch2]);
    expect(report.datapoints[0].batch_id).toBe('earlier');
    expect(report.datapoints[1].batch_id).toBe('later');
  });
});

describe('formatTrendReport', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'batch-trends-format-'));
  });

  it('produces readable markdown output', () => {
    const batch1 = join(tmpDir, 'batch-001');
    const batch2 = join(tmpDir, 'batch-002');
    mkdirSync(batch1);
    mkdirSync(batch2);

    writeBatchEvents(batch1, [
      makeCompleteEnvelope({ batch_id: 'batch-001', cost_usd: 5.0, prs_created: 2 }, '2026-03-19T10:00:00Z'),
    ]);
    writeBatchEvents(batch2, [
      makeCompleteEnvelope({ batch_id: 'batch-002', cost_usd: 3.0, prs_created: 3 }, '2026-03-20T10:00:00Z'),
    ]);

    const report = analyzeTrends([batch1, batch2]);
    const text = formatTrendReport(report);

    expect(text).toContain('## Cross-Batch Trend Analysis');
    expect(text).toContain('**2 batches**');
    expect(text).toContain('### Totals');
    expect(text).toContain('### Trends');
    expect(text).toContain('### Per-Batch Breakdown');
    expect(text).toContain('batch-001');
    expect(text).toContain('batch-002');
  });

  it('shows trend arrows and directions', () => {
    const batch1 = join(tmpDir, 'batch-a');
    const batch2 = join(tmpDir, 'batch-b');
    mkdirSync(batch1);
    mkdirSync(batch2);

    writeBatchEvents(batch1, [
      makeCompleteEnvelope({ batch_id: 'a', cost_usd: 10.0, prs_created: 1 }, '2026-03-19T00:00:00Z'),
    ]);
    writeBatchEvents(batch2, [
      makeCompleteEnvelope({ batch_id: 'b', cost_usd: 2.0, prs_created: 1 }, '2026-03-20T00:00:00Z'),
    ]);

    const report = analyzeTrends([batch1, batch2]);
    const text = formatTrendReport(report);

    // Cost/PR should show improving since it went from $10 to $2
    expect(text).toContain('Cost/PR');
    expect(text).toMatch(/improving|stable/);
  });
});
