import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emit, renderSummary, SUMMARY_PATH } from './coverage-summary.mjs';

const VALID_SUMMARY = {
  total: {
    lines: { pct: 71.66 },
    statements: { pct: 70.68 },
    functions: { pct: 77.52 },
    branches: { pct: 66.91 },
  },
};

describe('coverage-summary.emit', () => {
  let dir: string;
  let summaryFile: string;
  let coveragePath: string;
  const logs: string[] = [];
  const captureLog = (line: string) => logs.push(line);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cov-sum-'));
    summaryFile = join(dir, 'step-summary.md');
    coveragePath = join(dir, 'coverage-summary.json');
    logs.length = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes Markdown table when a valid coverage-summary.json exists', () => {
    writeFileSync(coveragePath, JSON.stringify(VALID_SUMMARY));

    const result = emit({ path: coveragePath, summaryFile, log: captureLog });

    expect(result.ok).toBe(true);
    const written = readFileSync(summaryFile, 'utf8');
    expect(written).toContain('## Test Coverage');
    expect(written).toContain('| Lines | 71.66% |');
    expect(written).toContain('| Statements | 70.68% |');
    expect(written).toContain('| Functions | 77.52% |');
    expect(written).toContain('| Branches | 66.91% |');
  });

  it('exits silently with ok:false when the summary file is missing', () => {
    const result = emit({
      path: join(dir, 'not-there.json'),
      summaryFile,
      log: captureLog,
    });

    expect(result).toEqual({ ok: false, reason: 'missing' });
    expect(logs.some((l) => l.includes('No coverage-summary.json'))).toBe(true);
  });

  it('exits silently with ok:false when the summary file is malformed JSON', () => {
    writeFileSync(coveragePath, 'not valid json {');

    const result = emit({ path: coveragePath, summaryFile, log: captureLog });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed');
    expect(logs.some((l) => l.includes('unreadable'))).toBe(true);
  });

  it('exits silently when summary JSON has no `total` object', () => {
    writeFileSync(coveragePath, JSON.stringify({ files: {} }));

    const result = emit({ path: coveragePath, summaryFile, log: captureLog });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed');
  });

  it('renders N/A for missing metrics rather than crashing', () => {
    writeFileSync(
      coveragePath,
      JSON.stringify({ total: { lines: { pct: 50 } } }),
    );

    const result = emit({ path: coveragePath, summaryFile, log: captureLog });

    expect(result.ok).toBe(true);
    const written = readFileSync(summaryFile, 'utf8');
    expect(written).toContain('| Lines | 50.00% |');
    expect(written).toContain('| Statements | N/A% |');
    expect(written).toContain('| Functions | N/A% |');
    expect(written).toContain('| Branches | N/A% |');
  });

  it('skips appendFileSync when GITHUB_STEP_SUMMARY env var is unset', () => {
    writeFileSync(coveragePath, JSON.stringify(VALID_SUMMARY));

    const result = emit({
      path: coveragePath,
      summaryFile: undefined,
      log: captureLog,
    });

    expect(result.ok).toBe(true);
    // No file was written; the log still received the rendered table
    expect(logs.some((l) => l.includes('## Test Coverage'))).toBe(true);
  });
});

describe('coverage-summary.renderSummary', () => {
  it('produces a stable Markdown table for a complete summary', () => {
    const out = renderSummary(VALID_SUMMARY.total);
    expect(out.split('\n')[0]).toBe('## Test Coverage');
    expect(out).toMatch(/\| Lines \| 71\.66% \|/);
  });

  it('gracefully handles null/undefined total', () => {
    expect(() => renderSummary(undefined)).not.toThrow();
    expect(() => renderSummary(null)).not.toThrow();
    expect(renderSummary(undefined)).toContain('| Lines | N/A% |');
  });
});

describe('coverage-summary.SUMMARY_PATH', () => {
  it('points at the vitest json-summary reporter output', () => {
    expect(SUMMARY_PATH).toBe('artifacts/coverage/coverage-summary.json');
  });
});
