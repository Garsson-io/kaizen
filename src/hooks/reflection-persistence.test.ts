import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildReflectionRecord,
  persistReflection,
  type ReflectionImpediment,
  type ReflectionRecord,
} from './reflection-persistence.js';

const REFLECTION_PERSISTENCE_SOURCE = readFileSync(
  new URL('./reflection-persistence.ts', import.meta.url),
  'utf-8',
);

function makeReflectionTestDir(suffix: string): string {
  const base = join(process.cwd(), 'data', 'test-tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `reflection-${suffix}-`));
}

describe('json-lines helper source invariant', () => {
  it('routes reflection JSONL appends through the bounded append helper', () => {
    expect(REFLECTION_PERSISTENCE_SOURCE).toContain('appendBoundedJsonLine');
    expect(REFLECTION_PERSISTENCE_SOURCE).toContain("from '../lib/json-lines.js'");
    expect(REFLECTION_PERSISTENCE_SOURCE).not.toContain('appendFileSync(filePath, JSON.stringify');
  });
});

describe('buildReflectionRecord', () => {
  it('builds record with correct disposition counts', () => {
    const impediments: ReflectionImpediment[] = [
      { impediment: 'missing test', disposition: 'filed', ref: '#100' },
      { impediment: 'typo fix', disposition: 'fixed-in-pr' },
      { finding: 'good pattern', type: 'positive', disposition: 'no-action', reason: 'validates approach' },
      { impediment: 'relates to known bug', disposition: 'incident', ref: '#200' },
    ];

    const record = buildReflectionRecord({
      prUrl: 'https://github.com/Garsson-io/kaizen/pull/42',
      branch: 'feat-test',
      clearType: 'impediments',
      clearReason: '4 finding(s) addressed',
      quality: 'high',
      impediments,
      now: new Date('2026-03-23T10:00:00Z'),
    });

    expect(record.timestamp).toBe('2026-03-23T10:00:00.000Z');
    expect(record.pr_url).toBe('https://github.com/Garsson-io/kaizen/pull/42');
    expect(record.branch).toBe('feat-test');
    expect(record.clear_type).toBe('impediments');
    expect(record.quality).toBe('high');
    expect(record.counts).toEqual({
      total: 4,
      filed: 1,
      fixed_in_pr: 1,
      incident: 1,
      no_action: 1,
    });
  });

  it('builds empty record for no-action', () => {
    const record = buildReflectionRecord({
      prUrl: 'https://github.com/Garsson-io/kaizen/pull/55',
      branch: 'docs-update',
      clearType: 'no-action',
      clearReason: 'docs-only change',
      quality: 'empty',
      impediments: [],
    });

    expect(record.clear_type).toBe('no-action');
    expect(record.counts.total).toBe(0);
    expect(record.counts.filed).toBe(0);
  });

  it('builds record for empty-array with reason', () => {
    const record = buildReflectionRecord({
      prUrl: 'https://github.com/Garsson-io/kaizen/pull/66',
      branch: 'bugfix',
      clearType: 'empty-array',
      clearReason: 'no impediments identified (straightforward fix)',
      quality: 'empty',
      impediments: [],
    });

    expect(record.clear_type).toBe('empty-array');
    expect(record.clear_reason).toContain('straightforward fix');
  });
});

describe('persistReflection', () => {
  it('writes reflection record to reflections.jsonl', () => {
    const dir = makeReflectionTestDir('a');
    const record = buildReflectionRecord({
      prUrl: 'https://github.com/Garsson-io/kaizen/pull/77',
      branch: 'test-branch',
      clearType: 'impediments',
      clearReason: '1 finding(s) addressed',
      quality: 'medium',
      impediments: [{ impediment: 'test gap', disposition: 'filed', ref: '#300' }],
      now: new Date('2026-03-23T12:00:00Z'),
    });

    persistReflection(record, { telemetryDir: dir });

    const filePath = join(dir, 'reflections.jsonl');
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(content) as ReflectionRecord;
    expect(parsed.pr_url).toBe('https://github.com/Garsson-io/kaizen/pull/77');
    expect(parsed.quality).toBe('medium');
    expect(parsed.counts.filed).toBe(1);
    expect(parsed.impediments).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends multiple records', () => {
    const dir = makeReflectionTestDir('b');
    const base = {
      branch: 'b',
      clearType: 'impediments' as const,
      clearReason: 'ok',
      quality: 'medium' as const,
      impediments: [],
    };

    persistReflection(
      buildReflectionRecord({ ...base, prUrl: 'url1' }),
      { telemetryDir: dir },
    );
    persistReflection(
      buildReflectionRecord({ ...base, prUrl: 'url2' }),
      { telemetryDir: dir },
    );

    const lines = readFileSync(join(dir, 'reflections.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]) as ReflectionRecord).pr_url).toBe('url1');
    expect((JSON.parse(lines[1]) as ReflectionRecord).pr_url).toBe('url2');
    rmSync(dir, { recursive: true, force: true });
  });

  it('rotates reflection telemetry when the next record would exceed the local cap', () => {
    const dir = makeReflectionTestDir('rotate');
    const base = {
      branch: 'b',
      clearType: 'impediments' as const,
      clearReason: 'ok',
      quality: 'medium' as const,
      impediments: [{ impediment: 'long enough to force a small cap rollover', disposition: 'filed' }],
    };

    persistReflection(
      buildReflectionRecord({ ...base, prUrl: 'url1' }),
      { telemetryDir: dir, maxBytes: 180, maxBackups: 2 },
    );
    persistReflection(
      buildReflectionRecord({ ...base, prUrl: 'url2' }),
      { telemetryDir: dir, maxBytes: 180, maxBackups: 2 },
    );

    expect(readFileSync(join(dir, 'reflections.jsonl'), 'utf-8')).toContain('url2');
    expect(readFileSync(join(dir, 'reflections.jsonl.1'), 'utf-8')).toContain('url1');
    rmSync(dir, { recursive: true, force: true });
  });

  it('silently handles write errors without throwing', () => {
    // /dev/null is a file, not a directory — mkdirSync will fail with ENOTDIR.
    // Never use /proc paths in tests: mkdirSync('/proc/...') hangs on WSL2 (kaizen #681).
    expect(() =>
      persistReflection(
        buildReflectionRecord({
          prUrl: 'url',
          branch: 'b',
          clearType: 'no-action',
          clearReason: 'test',
          quality: 'empty',
          impediments: [],
        }),
        { telemetryDir: '/dev/null/impossible' },
      ),
    ).not.toThrow();
  });
});
