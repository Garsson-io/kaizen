import { describe, expect, it } from 'vitest';
import { evaluatePlanCompleteness, parseDeferredBehaviors } from './plan-completeness.js';

const table = (rows: string): string => `## Test Plan

| # | Behavior | Coverage |
|---|----------|----------|
${rows}
`;

describe('plan completeness deferred behavior evaluation', () => {
  it('flags a deferred behavior with no tracking issue', () => {
    const result = evaluatePlanCompleteness(table('| H1 | Hook-gym replay | ⏳ deferred |'));

    expect(result.deferredBehaviors).toHaveLength(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      status: 'MISSING',
      detail: expect.stringContaining('does not name a tracking issue'),
    }));
  });

  it('allows a deferred behavior with an open tracking issue', () => {
    const result = evaluatePlanCompleteness(
      table('| H1 | Agentic replay | ⏳ deferred to #123 |'),
      issue => issue === 123 ? 'OPEN' : 'UNKNOWN',
    );

    expect(result.findings).toContainEqual(expect.objectContaining({
      status: 'DONE',
      detail: expect.stringContaining('#123'),
    }));
    expect(result.findings.some(f => f.status === 'MISSING')).toBe(false);
  });

  it('fails a deferred behavior with a closed tracking issue', () => {
    const result = evaluatePlanCompleteness(
      table('| H1 | Agentic replay | ⏳ deferred to #123 |'),
      () => 'CLOSED',
    );

    expect(result.findings).toContainEqual(expect.objectContaining({
      status: 'MISSING',
      detail: expect.stringContaining('closed'),
    }));
  });

  it('warns when more than thirty percent of behaviors are deferred', () => {
    const result = evaluatePlanCompleteness(
      table([
        '| H1 | Unit proof | ✅ tested |',
        '| H2 | Replay proof | ⏳ #123 |',
        '| H3 | System proof | ⏳ #124 |',
      ].join('\n')),
      () => 'OPEN',
    );

    expect(result.deferralRate).toBeGreaterThan(0.3);
    expect(result.findings).toContainEqual(expect.objectContaining({
      status: 'PARTIAL',
      detail: expect.stringContaining('scope-match warning'),
    }));
  });

  it('passes when every behavior is complete', () => {
    const result = evaluatePlanCompleteness(table('| H1 | Unit proof | ✅ tested |'));

    expect(result.deferredBehaviors).toHaveLength(0);
    expect(result.findings).toEqual([
      expect.objectContaining({ status: 'DONE' }),
    ]);
  });

  it('parses bullet-list behavior markers when no table is present', () => {
    const parsed = parseDeferredBehaviors('- ✅ H1 complete\n- ⏳ H2 deferred to #77');

    expect(parsed.totalBehaviors).toBe(2);
    expect(parsed.deferredBehaviors).toEqual([
      { behavior: '- ⏳ H2 deferred to #77', trackingIssues: [77] },
    ]);
  });
});
