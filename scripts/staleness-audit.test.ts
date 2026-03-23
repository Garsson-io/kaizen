import { describe, it, expect } from 'vitest';
import {
  extractFileRefs,
  extractCodeRefs,
  recommend,
  generateReport,
  formatReport,
  type StaleIssue,
} from './staleness-audit.js';

describe('extractFileRefs', () => {
  it('extracts src/ paths from issue body', () => {
    const body = 'The bug is in `src/hooks/kaizen-reflect.ts` and also affects src/lib/waiver-blocklist.ts';
    const refs = extractFileRefs(body);
    expect(refs).toContain('src/hooks/kaizen-reflect.ts');
    expect(refs).toContain('src/lib/waiver-blocklist.ts');
  });

  it('extracts scripts/ paths', () => {
    const body = 'See scripts/auto-dent-run.ts for context';
    expect(extractFileRefs(body)).toContain('scripts/auto-dent-run.ts');
  });

  it('extracts .claude/ paths', () => {
    const body = 'The hook at .claude/hooks/kaizen-verify.sh is broken';
    expect(extractFileRefs(body)).toContain('.claude/hooks/kaizen-verify.sh');
  });

  it('extracts docs/ paths', () => {
    const body = 'Documented in docs/hooks-design.md';
    expect(extractFileRefs(body)).toContain('docs/hooks-design.md');
  });

  it('extracts prompts/ paths', () => {
    const body = 'Template at prompts/explore-gaps.md';
    expect(extractFileRefs(body)).toContain('prompts/explore-gaps.md');
  });

  it('returns empty array for body with no paths', () => {
    expect(extractFileRefs('No file references here')).toEqual([]);
  });

  it('returns empty array for empty body', () => {
    expect(extractFileRefs('')).toEqual([]);
  });

  it('deduplicates paths', () => {
    const body = 'See src/hooks/foo.ts and also src/hooks/foo.ts again';
    expect(extractFileRefs(body)).toHaveLength(1);
  });
});

describe('extractCodeRefs', () => {
  it('extracts camelCase function names in backticks', () => {
    const body = 'The function `processStreamMessage` needs fixing';
    expect(extractCodeRefs(body)).toContain('processStreamMessage');
  });

  it('extracts PascalCase class names in backticks', () => {
    const body = 'Check `RunResult` and `BatchState` types';
    expect(extractCodeRefs(body)).toContain('RunResult');
    expect(extractCodeRefs(body)).toContain('BatchState');
  });

  it('ignores common type names', () => {
    const body = 'Returns `string` or `boolean` or `Promise`';
    expect(extractCodeRefs(body)).toEqual([]);
  });

  it('ignores all-lowercase short strings', () => {
    const body = 'The `result` is `null`';
    expect(extractCodeRefs(body)).toEqual([]);
  });

  it('returns empty for empty body', () => {
    expect(extractCodeRefs('')).toEqual([]);
  });
});

describe('recommend', () => {
  it('recommends close when all referenced files are missing', () => {
    const { recommendation } = recommend(
      100,
      ['src/old/gone.ts', 'src/old/removed.ts'],
      [],
      false,
      [],
    );
    expect(recommendation).toBe('close');
  });

  it('recommends investigate when area is heavily reworked and issue is old', () => {
    const { recommendation } = recommend(
      150,
      [],
      [],
      true,
      ['area/hooks'],
    );
    expect(recommendation).toBe('investigate');
  });

  it('recommends investigate when some refs are missing', () => {
    const { recommendation } = recommend(
      100,
      ['src/old/gone.ts'],
      ['src/hooks/existing.ts'],
      false,
      [],
    );
    expect(recommendation).toBe('investigate');
  });

  it('recommends keep for epic issues regardless of age', () => {
    const { recommendation } = recommend(
      200,
      [],
      [],
      false,
      ['epic', 'enhancement'],
    );
    expect(recommendation).toBe('keep');
  });

  it('recommends keep for prd issues', () => {
    const { recommendation } = recommend(200, [], [], false, ['prd']);
    expect(recommendation).toBe('keep');
  });

  it('recommends keep for horizon issues', () => {
    const { recommendation } = recommend(200, [], [], false, ['horizon/resilience']);
    expect(recommendation).toBe('keep');
  });

  it('recommends keep for aspirational issues', () => {
    const { recommendation } = recommend(200, [], [], false, ['aspirational']);
    expect(recommendation).toBe('keep');
  });

  it('recommends investigate for very old issues with no signals', () => {
    const { recommendation } = recommend(200, [], [], false, []);
    expect(recommendation).toBe('investigate');
  });

  it('recommends keep for moderately old issues with no signals', () => {
    const { recommendation } = recommend(100, [], [], false, []);
    expect(recommendation).toBe('keep');
  });

  it('does not recommend close with only one missing ref', () => {
    const { recommendation } = recommend(100, ['src/gone.ts'], [], false, []);
    // Single missing ref is not enough for close — needs investigation
    expect(recommendation).not.toBe('close');
  });
});

describe('generateReport', () => {
  const makeIssue = (
    overrides: Partial<StaleIssue>,
  ): StaleIssue => ({
    number: 1,
    title: 'Test issue',
    createdAt: '2025-01-01T00:00:00Z',
    ageDays: 100,
    commentCount: 0,
    labels: [],
    missingRefs: [],
    existingRefs: [],
    areaChanged: false,
    recommendation: 'keep',
    reason: 'test',
    ...overrides,
  });

  it('sorts issues by recommendation priority (close first)', () => {
    const issues = [
      makeIssue({ number: 1, recommendation: 'keep' }),
      makeIssue({ number: 2, recommendation: 'close' }),
      makeIssue({ number: 3, recommendation: 'investigate' }),
    ];

    const report = generateReport('test/repo', 90, issues);
    expect(report.issues[0].recommendation).toBe('close');
    expect(report.issues[1].recommendation).toBe('investigate');
    expect(report.issues[2].recommendation).toBe('keep');
  });

  it('computes summary counts correctly', () => {
    const issues = [
      makeIssue({ recommendation: 'close' }),
      makeIssue({ recommendation: 'close' }),
      makeIssue({ recommendation: 'investigate' }),
      makeIssue({ recommendation: 'keep' }),
    ];

    const report = generateReport('test/repo', 90, issues);
    expect(report.summary.total).toBe(4);
    expect(report.summary.closeRecommended).toBe(2);
    expect(report.summary.investigateRecommended).toBe(1);
    expect(report.summary.keepRecommended).toBe(1);
  });

  it('sorts by age within same recommendation', () => {
    const issues = [
      makeIssue({ number: 1, ageDays: 100, recommendation: 'investigate' }),
      makeIssue({ number: 2, ageDays: 200, recommendation: 'investigate' }),
    ];

    const report = generateReport('test/repo', 90, issues);
    expect(report.issues[0].number).toBe(2); // older first
  });
});

describe('formatReport', () => {
  it('produces readable output with summary and issue details', () => {
    const report = generateReport('test/repo', 90, [
      {
        number: 42,
        title: 'Fix old thing',
        createdAt: '2025-01-01T00:00:00Z',
        ageDays: 150,
        commentCount: 0,
        labels: [],
        missingRefs: ['src/old.ts', 'src/gone.ts'],
        existingRefs: [],
        areaChanged: false,
        recommendation: 'close',
        reason: '2 referenced files/symbols no longer exist in codebase',
      },
    ]);

    const output = formatReport(report);
    expect(output).toContain('# Staleness Audit');
    expect(output).toContain('#42');
    expect(output).toContain('Fix old thing');
    expect(output).toContain('close');
    expect(output).toContain('Missing refs: src/old.ts, src/gone.ts');
    expect(output).toContain('Close recommended: 1');
  });

  it('shows area changed flag when present', () => {
    const report = generateReport('test/repo', 90, [
      {
        number: 10,
        title: 'Area changed issue',
        createdAt: '2025-01-01T00:00:00Z',
        ageDays: 130,
        commentCount: 0,
        labels: ['area/hooks'],
        missingRefs: [],
        existingRefs: [],
        areaChanged: true,
        recommendation: 'investigate',
        reason: 'area heavily reworked',
      },
    ]);

    const output = formatReport(report);
    expect(output).toContain('Area heavily changed since filing');
  });
});
