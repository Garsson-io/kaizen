import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditEscapeLog,
  formatAuditReport,
  parseEscapeLog,
  runAudit,
} from './escape-hatch-audit.js';

function tempFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'kaizen-escape-audit-'));
  const path = join(dir, 'escape.jsonl');
  writeFileSync(path, content);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const rec = (overrides: Record<string, string> = {}): string => JSON.stringify({
  ts: '2026-06-29T01:00:00.000Z',
  hook: 'enforce-plan-stored',
  context: 'tool=Write',
  branch: 'case/260629-k1058-escape-audit',
  cwd: '/repo/.claude/worktrees/wt',
  ...overrides,
});

describe('parseEscapeLog', () => {
  it('parses valid JSONL records', () => {
    const parsed = parseEscapeLog(`${rec()}\n${rec({ context: 'tool=Bash' })}\n`);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.invalidLines).toEqual([]);
    expect(parsed.records[1].context).toBe('tool=Bash');
  });

  it('keeps malformed lines visible without throwing', () => {
    const parsed = parseEscapeLog(`${rec()}\nnot-json\n{"ts":"x"}\n`);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.invalidLines).toEqual([
      { lineNumber: 2, reason: 'invalid JSON' },
      { lineNumber: 3, reason: 'missing string field(s): hook, context, branch, cwd' },
    ]);
  });

  it('accepts empty branch values emitted when git branch lookup is unavailable', () => {
    const parsed = parseEscapeLog(`${rec({ branch: '' })}\n`);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].branch).toBe('');
    expect(parsed.invalidLines).toEqual([]);
  });
});

describe('auditEscapeLog', () => {
  it('reports zero usage for a missing log file', () => {
    const audit = auditEscapeLog('/tmp/kaizen-escape-audit-definitely-missing.jsonl');
    expect(audit.summary.total).toBe(0);
    expect(audit.summary.invalid).toBe(0);
    expect(audit.records).toEqual([]);
  });

  it('groups escape usage by hook, context, and branch', () => {
    const file = tempFile([
      rec(),
      rec({ context: 'tool=Bash' }),
      rec({ branch: 'case/260629-k-other' }),
    ].join('\n'));
    try {
      const audit = auditEscapeLog(file.path);
      expect(audit.summary.total).toBe(3);
      expect(audit.summary.byHook).toEqual({ 'enforce-plan-stored': 3 });
      expect(audit.summary.byContext).toEqual({ 'tool=Write': 2, 'tool=Bash': 1 });
      expect(audit.summary.byBranch).toEqual({
        'case/260629-k1058-escape-audit': 2,
        'case/260629-k-other': 1,
      });
    } finally {
      file.cleanup();
    }
  });
});

describe('formatAuditReport', () => {
  it('produces a quiet empty report', () => {
    const report = formatAuditReport(auditEscapeLog('/tmp/kaizen-escape-audit-definitely-missing.jsonl'));
    expect(report).toContain('Records: 0');
    expect(report).toContain('No escape-hatch use recorded.');
  });

  it('includes summary counts, invalid lines, and recent entries', () => {
    const audit = {
      ...auditEscapeLog('/tmp/kaizen-escape-audit-definitely-missing.jsonl'),
      records: [
        {
          ts: '2026-06-29T02:00:00.000Z',
          hook: 'enforce-plan-stored',
          context: 'tool=Write',
          branch: 'case/260629-k1058-escape-audit',
          cwd: '/repo/wt',
        },
      ],
      invalidLines: [{ lineNumber: 2, reason: 'invalid JSON' }],
      summary: {
        total: 1,
        invalid: 1,
        byHook: { 'enforce-plan-stored': 1 },
        byContext: { 'tool=Write': 1 },
        byBranch: { 'case/260629-k1058-escape-audit': 1 },
      },
    };

    const report = formatAuditReport(audit);
    expect(report).toContain('By hook:');
    expect(report).toContain('line 2: invalid JSON');
    expect(report).toContain('Recent escapes:');
  });
});

describe('runAudit', () => {
  it('emits JSON when requested', () => {
    const file = tempFile(`${rec()}\n`);
    const output: string[] = [];
    try {
      expect(runAudit(['--file', file.path, '--json'], { stdout: (s) => output.push(s), stderr: () => undefined })).toBe(0);
      expect(JSON.parse(output[0]).summary.total).toBe(1);
    } finally {
      file.cleanup();
    }
  });

  it('fails on usage when requested', () => {
    const file = tempFile(`${rec()}\n`);
    try {
      expect(runAudit(['--file', file.path, '--fail-on-usage'], { stdout: () => undefined, stderr: () => undefined })).toBe(1);
    } finally {
      file.cleanup();
    }
  });

  it('passes fail-on-usage for an empty log', () => {
    const output: string[] = [];
    expect(runAudit(
      ['--file', '/tmp/kaizen-escape-audit-definitely-missing.jsonl', '--fail-on-usage'],
      { stdout: (s) => output.push(s), stderr: () => undefined },
    )).toBe(0);
    expect(output[0]).toContain('Records: 0');
  });

  it('does not treat another flag as a missing --file value', () => {
    const output: string[] = [];
    expect(runAudit(
      ['--file', '--json'],
      { stdout: (s) => output.push(s), stderr: () => undefined },
    )).toBe(0);
    expect(JSON.parse(output[0]).filePath).toBe('/tmp/.kaizen-escape-hatch.jsonl');
  });

  it('has a working default IO boundary', () => {
    expect(runAudit(['--help'])).toBe(0);
  });
});
