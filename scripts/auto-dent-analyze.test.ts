/**
 * Tests for auto-dent-analyze — cold-start and efficiency analysis.
 *
 * Uses synthetic log data to test all analysis functions.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  analyzeRunLog,
  analyzeBatch,
  computeToolPhaseFractions,
  formatRunAnalysis,
  formatBatchAnalysis,
} from './auto-dent-analyze.js';

// Synthetic log builders

function jsonLine(obj: Record<string, any>): string {
  return JSON.stringify(obj);
}

function userMsg(timestamp: string, toolResult = 'ok'): string {
  return jsonLine({
    type: 'user',
    timestamp,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content: toolResult }],
    },
  });
}

function assistantToolUse(name: string, input: Record<string, any>): string {
  return jsonLine({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name, input }],
    },
  });
}

function assistantText(text: string): string {
  return jsonLine({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  });
}

function initMsg(): string {
  return jsonLine({
    type: 'system',
    subtype: 'init',
    session_id: 'test-session',
  });
}

// Helpers

function createTmpLog(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'analyze-test-'));
  const logPath = join(dir, 'run-1-test.log');
  writeFileSync(logPath, lines.join('\n') + '\n');
  return logPath;
}

function createTmpBatch(runLogs: string[][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'analyze-batch-'));
  for (let i = 0; i < runLogs.length; i++) {
    const logPath = join(dir, `run-${i + 1}-test.log`);
    writeFileSync(logPath, runLogs[i].join('\n') + '\n');
  }
  return dir;
}

describe('analyzeRunLog', () => {
  it('extracts cold-start time from first Edit/Write tool call', () => {
    const log = createTmpLog([
      initMsg(),
      userMsg('2026-03-22T22:00:00.000Z'),
      assistantToolUse('Grep', { pattern: 'test' }),
      userMsg('2026-03-22T22:00:30.000Z'),
      assistantToolUse('Read', { file_path: '/foo/bar.ts' }),
      userMsg('2026-03-22T22:01:00.000Z'),
      assistantToolUse('Edit', { file_path: '/foo/bar.ts' }),
      userMsg('2026-03-22T22:01:30.000Z'),
    ]);

    const result = analyzeRunLog(log);
    expect(result.coldStartSec).toBe(60);
    expect(result.toolCalls).toBe(3);
  });

  it('returns NaN cold-start when no Edit/Write occurs', () => {
    const log = createTmpLog([
      initMsg(),
      userMsg('2026-03-22T22:00:00.000Z'),
      assistantToolUse('Grep', { pattern: 'test' }),
      userMsg('2026-03-22T22:00:10.000Z'),
      assistantToolUse('Read', { file_path: '/foo.ts' }),
      userMsg('2026-03-22T22:00:20.000Z'),
    ]);

    const result = analyzeRunLog(log);
    expect(result.coldStartSec).toBeNaN();
  });

  it('extracts phase markers from assistant text', () => {
    const log = createTmpLog([
      initMsg(),
      userMsg('2026-03-22T22:00:00.000Z'),
      assistantText('AUTO_DENT_PHASE: PICK | issue=#123 | title=test'),
      userMsg('2026-03-22T22:01:00.000Z'),
      assistantText('AUTO_DENT_PHASE: IMPLEMENT | case=test-case'),
      userMsg('2026-03-22T22:02:00.000Z'),
      assistantText('AUTO_DENT_PHASE: TEST | result=pass | count=5'),
      userMsg('2026-03-22T22:03:00.000Z'),
    ]);

    const result = analyzeRunLog(log);
    expect(result.phaseEvents).toHaveLength(3);
    expect(result.phaseEvents[0].phase).toBe('PICK');
    expect(result.phaseEvents[1].phase).toBe('IMPLEMENT');
    expect(result.phaseEvents[2].phase).toBe('TEST');
  });

  it('computes tool category fractions', () => {
    const log = createTmpLog([
      initMsg(),
      userMsg('2026-03-22T22:00:00.000Z'),
      assistantToolUse('Grep', { pattern: 'test' }),
      assistantToolUse('Read', { file_path: '/foo.ts' }),
      assistantToolUse('Edit', { file_path: '/foo.ts' }),
      assistantToolUse('Bash', { command: 'npm test' }),
      assistantToolUse('Bash', { command: 'git push' }),
      userMsg('2026-03-22T22:01:00.000Z'),
    ]);

    const result = analyzeRunLog(log);
    expect(result.toolCategoryFractions.discovery).toBeCloseTo(0.4); // Grep + Read
    expect(result.toolCategoryFractions.coding).toBeCloseTo(0.2); // Edit
    expect(result.toolCategoryFractions.testing).toBeCloseTo(0.2); // npm test
    expect(result.toolCategoryFractions.shipping).toBeCloseTo(0.2); // git push
  });

  it('counts top patterns correctly', () => {
    const log = createTmpLog([
      initMsg(),
      userMsg('2026-03-22T22:00:00.000Z'),
      assistantToolUse('Read', { file_path: '/foo.ts' }),
      assistantToolUse('Read', { file_path: '/foo.ts' }),
      assistantToolUse('Read', { file_path: '/foo.ts' }),
      assistantToolUse('Edit', { file_path: '/bar.ts' }),
      userMsg('2026-03-22T22:01:00.000Z'),
    ]);

    const result = analyzeRunLog(log);
    expect(result.topPatterns[0].pattern).toBe('Read foo.ts');
    expect(result.topPatterns[0].count).toBe(3);
  });

  it('handles empty log gracefully', () => {
    const log = createTmpLog([]);
    const result = analyzeRunLog(log);
    expect(result.toolCalls).toBe(0);
    expect(result.coldStartSec).toBeNaN();
    expect(result.totalDurationSec).toBe(0);
  });

  it('handles non-JSON lines gracefully', () => {
    const log = createTmpLog([
      'not json',
      initMsg(),
      '--- auto-dent metadata ---',
      userMsg('2026-03-22T22:00:00.000Z'),
      'batch_id=test',
    ]);

    const result = analyzeRunLog(log);
    expect(result.toolCalls).toBe(0);
  });
});

describe('analyzeBatch', () => {
  it('computes cold-start statistics across runs', () => {
    const batchDir = createTmpBatch([
      // Run 1: cold-start at 30s
      [
        initMsg(),
        userMsg('2026-03-22T22:00:00.000Z'),
        assistantToolUse('Grep', { pattern: 'x' }),
        userMsg('2026-03-22T22:00:30.000Z'),
        assistantToolUse('Edit', { file_path: '/a.ts' }),
        userMsg('2026-03-22T22:01:00.000Z'),
      ],
      // Run 2: cold-start at 60s
      [
        initMsg(),
        userMsg('2026-03-22T22:00:00.000Z'),
        assistantToolUse('Read', { file_path: '/b.ts' }),
        userMsg('2026-03-22T22:01:00.000Z'),
        assistantToolUse('Write', { file_path: '/c.ts' }),
        userMsg('2026-03-22T22:01:30.000Z'),
      ],
    ]);

    const result = analyzeBatch(batchDir);
    expect(result.runs).toHaveLength(2);
    expect(result.avgColdStartSec).toBe(45); // (30 + 60) / 2
    expect(result.minColdStartSec).toBe(30);
    expect(result.maxColdStartSec).toBe(60);
    expect(result.stddevColdStartSec).toBeGreaterThan(0);
  });

  it('aggregates top patterns across runs', () => {
    const batchDir = createTmpBatch([
      [
        initMsg(),
        userMsg('2026-03-22T22:00:00.000Z'),
        assistantToolUse('Read', { file_path: '/shared.ts' }),
        assistantToolUse('Read', { file_path: '/shared.ts' }),
        userMsg('2026-03-22T22:01:00.000Z'),
      ],
      [
        initMsg(),
        userMsg('2026-03-22T22:00:00.000Z'),
        assistantToolUse('Read', { file_path: '/shared.ts' }),
        userMsg('2026-03-22T22:01:00.000Z'),
      ],
    ]);

    const result = analyzeBatch(batchDir);
    const sharedPattern = result.globalTopPatterns.find(
      (p) => p.pattern === 'Read shared.ts',
    );
    expect(sharedPattern).toBeDefined();
    expect(sharedPattern!.count).toBe(3);
    expect(sharedPattern!.runCount).toBe(2);
  });

  it('handles batch with no coding tool calls', () => {
    const batchDir = createTmpBatch([
      [
        initMsg(),
        userMsg('2026-03-22T22:00:00.000Z'),
        assistantToolUse('Grep', { pattern: 'x' }),
        userMsg('2026-03-22T22:01:00.000Z'),
      ],
    ]);

    const result = analyzeBatch(batchDir);
    expect(result.avgColdStartSec).toBeNaN();
    expect(result.minColdStartSec).toBeNaN();
  });

  it('reads batch ID from state.json if present', () => {
    const batchDir = createTmpBatch([
      [initMsg(), userMsg('2026-03-22T22:00:00.000Z')],
    ]);
    writeFileSync(
      join(batchDir, 'state.json'),
      JSON.stringify({ batch_id: 'test-batch-id' }),
    );

    const result = analyzeBatch(batchDir);
    expect(result.batchId).toBe('test-batch-id');
  });
});

describe('computeToolPhaseFractions', () => {
  it('computes fractions from tool inputs', () => {
    const messages = [
      { name: 'Grep', input: { pattern: 'x' } },
      { name: 'Read', input: { file_path: '/a' } },
      { name: 'Edit', input: { file_path: '/b' } },
      { name: 'Bash', input: { command: 'npm test' } },
      { name: 'Bash', input: { command: 'gh pr create' } },
    ];

    const result = computeToolPhaseFractions([], messages);
    expect(result.discovery).toBeCloseTo(0.4);
    expect(result.coding).toBeCloseTo(0.2);
    expect(result.testing).toBeCloseTo(0.2);
    expect(result.shipping).toBeCloseTo(0.2);
  });

  it('returns zeros for empty input', () => {
    const result = computeToolPhaseFractions([], []);
    expect(result.discovery).toBe(0);
    expect(result.coding).toBe(0);
  });
});

describe('formatRunAnalysis', () => {
  it('produces markdown output with all sections', () => {
    const log = createTmpLog([
      initMsg(),
      userMsg('2026-03-22T22:00:00.000Z'),
      assistantToolUse('Read', { file_path: '/a.ts' }),
      userMsg('2026-03-22T22:00:30.000Z'),
      assistantToolUse('Edit', { file_path: '/a.ts' }),
      userMsg('2026-03-22T22:01:00.000Z'),
    ]);

    const analysis = analyzeRunLog(log);
    const output = formatRunAnalysis(analysis);

    expect(output).toContain('### run-1-test.log');
    expect(output).toContain('**Cold start**');
    expect(output).toContain('**Tool calls** | 2');
    expect(output).toContain('Tool category breakdown');
    expect(output).toContain('Top tool patterns');
  });
});

describe('formatBatchAnalysis', () => {
  it('produces markdown with summary and per-run details', () => {
    const batchDir = createTmpBatch([
      [
        initMsg(),
        userMsg('2026-03-22T22:00:00.000Z'),
        assistantToolUse('Edit', { file_path: '/a.ts' }),
        userMsg('2026-03-22T22:01:00.000Z'),
      ],
    ]);

    const analysis = analyzeBatch(batchDir);
    const output = formatBatchAnalysis(analysis);

    expect(output).toContain('## Auto-Dent Batch Analysis');
    expect(output).toContain('Cold-Start Summary');
    expect(output).toContain('Per-Run Details');
  });
});
