#!/usr/bin/env tsx
/**
 * escape-hatch-audit — report local KAIZEN_SKIP_PLAN_CHECK usage.
 *
 * `enforce-plan-stored` writes append-only JSONL records when the plan gate is
 * bypassed. This command makes that accountability trail readable by humans and
 * CI/reflection jobs.
 */

import { existsSync, readFileSync } from 'node:fs';

export const DEFAULT_ESCAPE_LOG = '/tmp/.kaizen-escape-hatch.jsonl';

export interface EscapeHatchRecord {
  ts: string;
  hook: string;
  context: string;
  branch: string;
  cwd: string;
}

export interface InvalidEscapeLine {
  lineNumber: number;
  reason: string;
}

export interface EscapeHatchAudit {
  filePath: string;
  records: EscapeHatchRecord[];
  invalidLines: InvalidEscapeLine[];
  summary: {
    total: number;
    invalid: number;
    byHook: Record<string, number>;
    byContext: Record<string, number>;
    byBranch: Record<string, number>;
  };
}

interface CliOptions {
  filePath: string;
  json: boolean;
  failOnUsage: boolean;
  help: boolean;
}

interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

function asRecord(value: unknown, lineNumber: number): EscapeHatchRecord | InvalidEscapeLine {
  if (!value || typeof value !== 'object') {
    return { lineNumber, reason: 'entry is not an object' };
  }

  const obj = value as Record<string, unknown>;
  const required: Array<keyof EscapeHatchRecord> = ['ts', 'hook', 'context', 'branch', 'cwd'];
  const missing = required.filter((key) => typeof obj[key] !== 'string');
  if (missing.length > 0) {
    return { lineNumber, reason: `missing string field(s): ${missing.join(', ')}` };
  }

  return {
    ts: obj.ts as string,
    hook: obj.hook as string,
    context: obj.context as string,
    branch: obj.branch as string,
    cwd: obj.cwd as string,
  };
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function parseEscapeLog(content: string): Pick<EscapeHatchAudit, 'records' | 'invalidLines'> {
  const records: EscapeHatchRecord[] = [];
  const invalidLines: InvalidEscapeLine[] = [];

  content.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;

    try {
      const parsed = asRecord(JSON.parse(line), index + 1);
      if ('reason' in parsed) {
        invalidLines.push(parsed);
      } else {
        records.push(parsed);
      }
    } catch {
      invalidLines.push({ lineNumber: index + 1, reason: 'invalid JSON' });
    }
  });

  return { records, invalidLines };
}

export function auditEscapeLog(filePath: string = process.env.KAIZEN_ESCAPE_LOG ?? DEFAULT_ESCAPE_LOG): EscapeHatchAudit {
  const parsed = existsSync(filePath)
    ? parseEscapeLog(readFileSync(filePath, 'utf8'))
    : { records: [], invalidLines: [] };

  const byHook: Record<string, number> = {};
  const byContext: Record<string, number> = {};
  const byBranch: Record<string, number> = {};

  for (const record of parsed.records) {
    increment(byHook, record.hook);
    increment(byContext, record.context);
    increment(byBranch, record.branch);
  }

  return {
    filePath,
    ...parsed,
    summary: {
      total: parsed.records.length,
      invalid: parsed.invalidLines.length,
      byHook,
      byContext,
      byBranch,
    },
  };
}

function formatCounts(title: string, counts: Record<string, number>): string[] {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return [];
  return [
    `${title}:`,
    ...entries.map(([key, count]) => `  - ${key}: ${count}`),
  ];
}

export function formatAuditReport(audit: EscapeHatchAudit, recentLimit = 5): string {
  const lines = [
    'kaizen escape-hatch audit',
    `File: ${audit.filePath}`,
    `Records: ${audit.summary.total}`,
    `Invalid lines: ${audit.summary.invalid}`,
  ];

  if (audit.summary.total === 0 && audit.summary.invalid === 0) {
    lines.push('', 'No escape-hatch use recorded.');
    return lines.join('\n');
  }

  lines.push(
    '',
    ...formatCounts('By hook', audit.summary.byHook),
    ...formatCounts('By context', audit.summary.byContext),
    ...formatCounts('By branch', audit.summary.byBranch),
  );

  if (audit.invalidLines.length > 0) {
    lines.push('', 'Invalid lines:');
    audit.invalidLines.forEach((line) => lines.push(`  - line ${line.lineNumber}: ${line.reason}`));
  }

  const recent = [...audit.records]
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, recentLimit);
  if (recent.length > 0) {
    lines.push('', 'Recent escapes:');
    recent.forEach((record) => {
      lines.push(`  - ${record.ts} ${record.hook} ${record.context} ${record.branch} ${record.cwd}`);
    });
  }

  return lines.join('\n');
}

function readArg(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  const value = argv[idx + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function parseCli(argv: string[]): CliOptions {
  return {
    filePath: readArg(argv, '--file') ?? process.env.KAIZEN_ESCAPE_LOG ?? DEFAULT_ESCAPE_LOG,
    json: argv.includes('--json'),
    failOnUsage: argv.includes('--fail-on-usage'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

function usage(): string {
  return [
    'Usage: npx tsx scripts/escape-hatch-audit.ts [--file <path>] [--json] [--fail-on-usage]',
    '',
    'Defaults to KAIZEN_ESCAPE_LOG or /tmp/.kaizen-escape-hatch.jsonl.',
    '--fail-on-usage exits 1 when escape records or malformed log lines are present.',
  ].join('\n');
}

const DEFAULT_IO: CliIo = {
  stdout: (text) => console.log(text),
  stderr: (text) => console.error(text),
};

export function runAudit(argv: string[] = process.argv.slice(2), io: CliIo = DEFAULT_IO): number {
  const options = parseCli(argv);
  if (options.help) {
    io.stdout(usage());
    return 0;
  }

  const audit = auditEscapeLog(options.filePath);
  io.stdout(options.json ? JSON.stringify(audit, null, 2) : formatAuditReport(audit));

  if (options.failOnUsage && (audit.records.length > 0 || audit.invalidLines.length > 0)) {
    return 1;
  }
  return 0;
}

if (process.argv[1]?.endsWith('escape-hatch-audit.ts') || process.argv[1]?.endsWith('escape-hatch-audit.js')) {
  process.exit(runAudit());
}
