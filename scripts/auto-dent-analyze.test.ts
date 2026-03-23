/**
 * Tests for auto-dent-analyze — cold-start and efficiency analysis.
 *
 * Uses synthetic log data to test all analysis functions.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  analyzeRunLog,
  analyzeBatch,
  computeToolPhaseFractions,
  computeRunCompleteness,
  detectWastePatterns,
  generateRecommendations,
  formatRunAnalysis,
  formatBatchAnalysis,
} from './auto-dent-analyze.js';
import type { PhaseEvent, ToolEvent, RunAnalysis } from './auto-dent-analyze.js';

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
    expect(output).toContain('Run Completeness');
    expect(output).toContain('Per-Run Details');
  });
});

describe('computeRunCompleteness', () => {
  it('returns full score when all expected phases are present', () => {
    const phases: PhaseEvent[] = [
      { offsetSec: 0, phase: 'PICK' },
      { offsetSec: 10, phase: 'EVALUATE' },
      { offsetSec: 20, phase: 'IMPLEMENT' },
      { offsetSec: 30, phase: 'TEST' },
      { offsetSec: 40, phase: 'PR' },
      { offsetSec: 50, phase: 'MERGE' },
      { offsetSec: 60, phase: 'REFLECT' },
    ];

    const result = computeRunCompleteness(phases);
    expect(result.score).toBe(1);
    expect(result.phasesMissing).toHaveLength(0);
    expect(result.orderedCorrectly).toBe(true);
  });

  it('returns partial score when phases are missing', () => {
    const phases: PhaseEvent[] = [
      { offsetSec: 0, phase: 'PICK' },
      { offsetSec: 10, phase: 'IMPLEMENT' },
      { offsetSec: 20, phase: 'PR' },
    ];

    const result = computeRunCompleteness(phases);
    expect(result.score).toBeCloseTo(3 / 7);
    expect(result.phasesMissing).toContain('EVALUATE');
    expect(result.phasesMissing).toContain('TEST');
    expect(result.phasesMissing).toContain('MERGE');
    expect(result.phasesMissing).toContain('REFLECT');
    expect(result.orderedCorrectly).toBe(true);
  });

  it('detects out-of-order phases', () => {
    const phases: PhaseEvent[] = [
      { offsetSec: 0, phase: 'IMPLEMENT' },
      { offsetSec: 10, phase: 'PICK' },
      { offsetSec: 20, phase: 'TEST' },
    ];

    const result = computeRunCompleteness(phases);
    expect(result.orderedCorrectly).toBe(false);
  });

  it('returns zero score for empty phases', () => {
    const result = computeRunCompleteness([]);
    expect(result.score).toBe(0);
    expect(result.phasesMissing).toHaveLength(7);
    expect(result.orderedCorrectly).toBe(true);
  });

  it('ignores STOP phase in scoring (it is not expected)', () => {
    const phases: PhaseEvent[] = [
      { offsetSec: 0, phase: 'PICK' },
      { offsetSec: 10, phase: 'STOP' },
    ];

    const result = computeRunCompleteness(phases);
    expect(result.score).toBeCloseTo(1 / 7);
    expect(result.phasesPresent).toContain('STOP');
  });
});

describe('detectWastePatterns', () => {
  it('detects repeated search patterns (3+ identical Grep)', () => {
    const toolEvents: ToolEvent[] = [
      { offsetSec: 0, name: 'Grep', summary: 'Grep "test"' },
      { offsetSec: 1, name: 'Grep', summary: 'Grep "test"' },
      { offsetSec: 2, name: 'Grep', summary: 'Grep "test"' },
      { offsetSec: 3, name: 'Edit', summary: 'Edit foo.ts' },
    ];
    const phases: PhaseEvent[] = [{ offsetSec: 0, phase: 'IMPLEMENT' }];

    const result = detectWastePatterns(toolEvents, phases);
    const repeated = result.find(w => w.type === 'repeated_search');
    expect(repeated).toBeDefined();
    expect(repeated!.count).toBe(3);
    expect(repeated!.wastedCalls).toBe(2);
  });

  it('detects redundant reads (3+ of same file)', () => {
    const toolEvents: ToolEvent[] = [
      { offsetSec: 0, name: 'Read', summary: 'Read foo.ts' },
      { offsetSec: 1, name: 'Read', summary: 'Read foo.ts' },
      { offsetSec: 2, name: 'Read', summary: 'Read foo.ts' },
    ];
    const phases: PhaseEvent[] = [];

    const result = detectWastePatterns(toolEvents, phases);
    const redundant = result.find(w => w.type === 'redundant_read');
    expect(redundant).toBeDefined();
    expect(redundant!.count).toBe(3);
    expect(redundant!.wastedCalls).toBe(1); // first two are OK
  });

  it('detects abandoned approach (coding with no TEST/PR/MERGE phase)', () => {
    const toolEvents: ToolEvent[] = [
      { offsetSec: 0, name: 'Edit', summary: 'Edit foo.ts' },
      { offsetSec: 1, name: 'Write', summary: 'Write bar.ts' },
    ];
    const phases: PhaseEvent[] = [
      { offsetSec: 0, phase: 'PICK' },
      { offsetSec: 5, phase: 'IMPLEMENT' },
    ];

    const result = detectWastePatterns(toolEvents, phases);
    const abandoned = result.find(w => w.type === 'abandoned_approach');
    expect(abandoned).toBeDefined();
    expect(abandoned!.wastedCalls).toBe(2);
  });

  it('does not flag abandoned approach when TEST phase is present', () => {
    const toolEvents: ToolEvent[] = [
      { offsetSec: 0, name: 'Edit', summary: 'Edit foo.ts' },
    ];
    const phases: PhaseEvent[] = [
      { offsetSec: 0, phase: 'IMPLEMENT' },
      { offsetSec: 5, phase: 'TEST' },
    ];

    const result = detectWastePatterns(toolEvents, phases);
    expect(result.find(w => w.type === 'abandoned_approach')).toBeUndefined();
  });

  it('returns empty array when no waste detected', () => {
    const toolEvents: ToolEvent[] = [
      { offsetSec: 0, name: 'Grep', summary: 'Grep "a"' },
      { offsetSec: 1, name: 'Grep', summary: 'Grep "b"' },
      { offsetSec: 2, name: 'Edit', summary: 'Edit foo.ts' },
    ];
    const phases: PhaseEvent[] = [
      { offsetSec: 0, phase: 'IMPLEMENT' },
      { offsetSec: 5, phase: 'TEST' },
    ];

    const result = detectWastePatterns(toolEvents, phases);
    expect(result).toHaveLength(0);
  });
});

describe('generateRecommendations', () => {
  function makeMinimalRun(overrides: Partial<RunAnalysis> = {}): RunAnalysis {
    return {
      runFile: 'run-1.log',
      coldStartSec: 30,
      totalDurationSec: 600,
      toolCalls: 50,
      phaseDurations: {},
      toolCategoryFractions: { discovery: 0.4, coding: 0.2, testing: 0.2, shipping: 0.1, other: 0.1 },
      topPatterns: [],
      toolEvents: [],
      phaseEvents: [],
      completeness: { score: 1, phasesPresent: [], phasesMissing: [], orderedCorrectly: true },
      wastePatterns: [],
      totalWastedCalls: 0,
      ...overrides,
    };
  }

  it('recommends plan pre-pass for high cold-start', () => {
    const runs = [makeMinimalRun(), makeMinimalRun()];
    const recs = generateRecommendations(runs, 180, []);
    expect(recs.some(r => r.includes('cold-start'))).toBe(true);
  });

  it('recommends phase clarity for low completeness', () => {
    const runs = [
      makeMinimalRun({ completeness: { score: 0.3, phasesPresent: ['PICK', 'IMPLEMENT'], phasesMissing: ['EVALUATE', 'TEST', 'PR', 'MERGE', 'REFLECT'], orderedCorrectly: true } }),
      makeMinimalRun({ completeness: { score: 0.3, phasesPresent: ['PICK', 'IMPLEMENT'], phasesMissing: ['EVALUATE', 'TEST', 'PR', 'MERGE', 'REFLECT'], orderedCorrectly: true } }),
    ];
    const recs = generateRecommendations(runs, 30, []);
    expect(recs.some(r => r.includes('completeness'))).toBe(true);
  });

  it('recommends investigating abandoned approaches', () => {
    const runs = [makeMinimalRun(), makeMinimalRun()];
    const waste = [{ type: 'abandoned_approach', totalCount: 3, runCount: 2 }];
    const recs = generateRecommendations(runs, 30, waste);
    expect(recs.some(r => r.includes('coding but never reached TEST'))).toBe(true);
  });

  it('returns empty for healthy batch', () => {
    const runs = [makeMinimalRun()];
    const recs = generateRecommendations(runs, 30, []);
    expect(recs).toHaveLength(0);
  });
});

describe('integration: completeness and waste in batch analysis', () => {
  it('includes completeness and waste in batch analysis output', () => {
    const batchDir = createTmpBatch([
      [
        initMsg(),
        userMsg('2026-03-22T22:00:00.000Z'),
        assistantText('AUTO_DENT_PHASE: PICK | issue=#123'),
        assistantToolUse('Grep', { pattern: 'x' }),
        assistantToolUse('Grep', { pattern: 'x' }),
        assistantToolUse('Grep', { pattern: 'x' }),
        userMsg('2026-03-22T22:01:00.000Z'),
        assistantText('AUTO_DENT_PHASE: IMPLEMENT | case=test'),
        assistantToolUse('Edit', { file_path: '/a.ts' }),
        userMsg('2026-03-22T22:02:00.000Z'),
        assistantText('AUTO_DENT_PHASE: TEST | result=pass'),
        assistantText('AUTO_DENT_PHASE: PR | url=https://github.com/test/test/pull/1'),
        userMsg('2026-03-22T22:03:00.000Z'),
      ],
    ]);

    const result = analyzeBatch(batchDir);

    // Should have completeness data
    expect(result.avgCompleteness).toBeGreaterThan(0);
    expect(result.runs[0].completeness.phasesPresent).toContain('PICK');
    expect(result.runs[0].completeness.phasesPresent).toContain('TEST');

    // Should detect repeated search waste
    expect(result.totalWastedCalls).toBeGreaterThan(0);
    expect(result.globalWastePatterns.length).toBeGreaterThan(0);

    // Format should include new sections
    const output = formatBatchAnalysis(result);
    expect(output).toContain('Run Completeness');
    expect(output).toContain('Waste Patterns');
  });
});
