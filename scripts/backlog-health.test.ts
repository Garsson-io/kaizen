import { describe, it, expect } from 'vitest';
import {
  computeAgeDistribution,
  computeHorizonCoverage,
  computeCreationClosureRatio,
  buildBacklogHealthReport,
  classifyBacklogHealth,
  type OpenIssue,
  type ClosedIssue,
} from './backlog-health.js';

const NOW = new Date('2026-06-28T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000).toISOString();

function open(partial: Partial<OpenIssue>): OpenIssue {
  return {
    number: 1,
    createdAt: daysAgo(5),
    updatedAt: daysAgo(5),
    labels: [],
    ...partial,
  };
}

describe('computeAgeDistribution', () => {
  it('buckets open issues by inactivity (updatedAt) into nested >30/>60/>90 buckets', () => {
    const issues = [
      open({ number: 1, updatedAt: daysAgo(10) }), // fresh
      open({ number: 2, updatedAt: daysAgo(40) }), // >30 only
      open({ number: 3, updatedAt: daysAgo(70) }), // >30, >60
      open({ number: 4, updatedAt: daysAgo(100) }), // >30, >60, >90
    ];
    const dist = computeAgeDistribution(issues, NOW);
    expect(dist.total).toBe(4);
    expect(dist.stale30).toBe(3); // issues 2,3,4
    expect(dist.stale60).toBe(2); // issues 3,4
    expect(dist.stale90).toBe(1); // issue 4
  });

  it('returns all zeros for an empty backlog', () => {
    const dist = computeAgeDistribution([], NOW);
    expect(dist).toEqual({ total: 0, stale30: 0, stale60: 0, stale90: 0 });
  });
});

describe('computeHorizonCoverage', () => {
  it('counts issues per horizon, tracks no-horizon and distinct count', () => {
    const issues = [
      open({ number: 1, labels: ['horizon/a', 'kaizen'] }),
      open({ number: 2, labels: ['horizon/a'] }),
      open({ number: 3, labels: ['horizon/b'] }),
      open({ number: 4, labels: ['kaizen'] }), // no horizon
    ];
    const cov = computeHorizonCoverage(issues);
    expect(cov.byHorizon['horizon/a']).toBe(2);
    expect(cov.byHorizon['horizon/b']).toBe(1);
    expect(cov.noHorizon).toBe(1);
    expect(cov.distinctHorizons).toBe(2);
  });

  it('treats horizon: (colon) labels as horizons too', () => {
    const issues = [open({ number: 1, labels: ['horizon:quality'] })];
    const cov = computeHorizonCoverage(issues);
    expect(cov.byHorizon['horizon:quality']).toBe(1);
    expect(cov.noHorizon).toBe(0);
  });
});

describe('computeCreationClosureRatio', () => {
  it('computes created/closed ratio', () => {
    expect(computeCreationClosureRatio(6, 3)).toEqual({ created: 6, closed: 3, ratio: 2 });
  });

  it('guards divide-by-zero when nothing was closed', () => {
    const r = computeCreationClosureRatio(4, 0);
    expect(r.closed).toBe(0);
    expect(r.ratio).toBe(4); // created / max(closed, 1)
  });
});

describe('classifyBacklogHealth', () => {
  const baseReport = buildBacklogHealthReport(
    [open({ number: 1, updatedAt: daysAgo(5), labels: ['horizon/a'] })],
    [{ number: 99, closedAt: daysAgo(5) }],
    NOW,
    30,
  );

  it('returns healthy for a balanced backlog', () => {
    // 1 created in window, 1 closed → ratio 1.0; no stale; single horizon but only 1 issue
    expect(classifyBacklogHealth(baseReport)).toBe('healthy');
  });

  it('returns warning when ratio is moderately high', () => {
    const report = { ...baseReport, ratio: { created: 7, closed: 5, ratio: 1.4 } };
    expect(classifyBacklogHealth(report)).toBe('warning');
  });

  it('returns pathological when ratio >= 2:1', () => {
    const report = { ...baseReport, ratio: { created: 10, closed: 4, ratio: 2.5 } };
    expect(classifyBacklogHealth(report)).toBe('pathological');
  });

  it('returns pathological when >90d-stale share is large even if ratio is fine', () => {
    // ratio healthy (1.0) but 3 of 4 open issues stale >90d → 75% share
    const report = {
      ...baseReport,
      ratio: { created: 1, closed: 1, ratio: 1.0 },
      age: { total: 4, stale30: 3, stale60: 3, stale90: 3 },
    };
    expect(classifyBacklogHealth(report)).toBe('pathological');
  });

  it('returns warning on horizon over-concentration', () => {
    // ratio fine, no excess staleness, but one horizon holds >= 50% of labeled issues
    const report = {
      ...baseReport,
      ratio: { created: 1, closed: 1, ratio: 1.0 },
      age: { total: 10, stale30: 0, stale60: 0, stale90: 0 },
      horizon: { byHorizon: { 'horizon/a': 8, 'horizon/b': 2 }, noHorizon: 0, distinctHorizons: 2 },
    };
    expect(classifyBacklogHealth(report)).toBe('warning');
  });
});

describe('buildBacklogHealthReport', () => {
  it('assembles all axes into one report', () => {
    const openIssues = [
      open({ number: 1, createdAt: daysAgo(5), updatedAt: daysAgo(5), labels: ['horizon/a'] }),
      open({ number: 2, createdAt: daysAgo(120), updatedAt: daysAgo(100), labels: [] }),
    ];
    const closedIssues: ClosedIssue[] = [{ number: 50, closedAt: daysAgo(2) }];
    const report = buildBacklogHealthReport(openIssues, closedIssues, NOW, 30);

    expect(report.totalOpen).toBe(2);
    expect(report.windowDays).toBe(30);
    // only issue #1 was created within the 30-day window
    expect(report.ratio.created).toBe(1);
    expect(report.ratio.closed).toBe(1);
    expect(report.age.total).toBe(2);
    expect(report.age.stale90).toBe(1);
    expect(report.horizon.noHorizon).toBe(1);
    expect(typeof report.generatedAt).toBe('string');
  });
});
