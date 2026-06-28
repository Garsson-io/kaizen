import { describe, it, expect } from 'vitest';
import {
  computeAgeDistribution,
  computeHorizonCoverage,
  computeCreationClosureRatio,
  computeEpicProgress,
  buildBacklogHealthReport,
  classifyBacklogHealth,
  formatReport,
  parseArgs,
  type OpenIssue,
  type ClosedIssue,
  type CreatedIssue,
} from './backlog-health.js';

const NOW = new Date('2026-06-28T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000).toISOString();

function open(partial: Partial<OpenIssue>): OpenIssue {
  return {
    number: 1,
    title: 'Test issue',
    createdAt: daysAgo(5),
    updatedAt: daysAgo(5),
    body: '',
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

describe('computeEpicProgress', () => {
  it('flags an impacted stale epic as needing replan/continue pressure', () => {
    const report = computeEpicProgress([
      open({
        number: 10,
        title: 'Epic with partial impact',
        labels: ['epic'],
        updatedAt: daysAgo(35),
        body: '- [x] #101 shipped\n- [ ] #102 remaining',
      }),
    ], NOW);

    expect(report.needsReplan).toBe(1);
    expect(report.items[0]).toMatchObject({
      number: 10,
      checkedItems: 1,
      uncheckedItems: 1,
      verdict: 'needs-replan',
    });
    expect(report.items[0].reason).toContain('completed child work exists');
  });

  it('flags an impacted epic with no remaining checklist work as needing a terminal decision', () => {
    const report = computeEpicProgress([
      open({
        number: 11,
        title: 'Epic with all tracked work done',
        labels: ['epic'],
        updatedAt: daysAgo(3),
        body: '- [x] #201 shipped\n- [x] #202 shipped',
      }),
    ], NOW);

    expect(report.needsTerminalDecision).toBe(1);
    expect(report.items[0]).toMatchObject({
      number: 11,
      checkedItems: 2,
      uncheckedItems: 0,
      verdict: 'needs-terminal-decision',
    });
  });

  it('flags an epic with no checklist children as needing decomposition', () => {
    const report = computeEpicProgress([
      open({ number: 12, title: 'Empty epic', labels: ['epic'], body: 'Broad direction only.' }),
    ], NOW);

    expect(report.needsDecomposition).toBe(1);
    expect(report.items[0]).toMatchObject({
      number: 12,
      trackedItems: 0,
      verdict: 'needs-decomposition',
    });
  });

  it('leaves an active epic with completed and pending work healthy while fresh', () => {
    const report = computeEpicProgress([
      open({
        number: 13,
        title: 'Fresh epic',
        labels: ['epic'],
        updatedAt: daysAgo(5),
        body: '- [x] #301 shipped\n- [ ] #302 next',
      }),
    ], NOW);

    expect(report.healthy).toBe(1);
    expect(report.items[0].verdict).toBe('healthy');
  });

  it('ignores non-epic issues', () => {
    const report = computeEpicProgress([
      open({ number: 14, labels: ['kaizen'], body: '- [x] #401 done' }),
    ], NOW);

    expect(report.total).toBe(0);
    expect(report.items).toEqual([]);
  });
});

describe('classifyBacklogHealth', () => {
  const baseReport = buildBacklogHealthReport(
    [open({ number: 1, updatedAt: daysAgo(5), labels: ['horizon/a'] })],
    [{ number: 1, createdAt: daysAgo(5) }],
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

  it('returns warning when epics need terminal progress decisions', () => {
    const report = {
      ...baseReport,
      ratio: { created: 1, closed: 1, ratio: 1.0 },
      age: { total: 1, stale30: 0, stale60: 0, stale90: 0 },
      horizon: { byHorizon: { 'horizon/a': 1 }, noHorizon: 0, distinctHorizons: 1 },
      epicProgress: {
        total: 1,
        healthy: 0,
        needsDecomposition: 0,
        needsReplan: 0,
        needsTerminalDecision: 1,
        items: [],
      },
    };
    expect(classifyBacklogHealth(report)).toBe('warning');
  });

  it('returns warning in the >90d stale-share band (0.1 <= share < 0.25)', () => {
    // 2 of 10 stale >90d = 20% → warning band, not pathological
    const report = {
      ...baseReport,
      ratio: { created: 1, closed: 1, ratio: 1.0 },
      age: { total: 10, stale30: 2, stale60: 2, stale90: 2 },
      horizon: { byHorizon: { 'horizon/a': 1 }, noHorizon: 0, distinctHorizons: 1 },
    };
    expect(classifyBacklogHealth(report)).toBe('warning');
  });

  it('suppresses horizon concentration on a tiny backlog (< MIN_LABELED)', () => {
    // one horizon holds 100% but only 3 labeled issues → below the min, stays healthy
    const report = {
      ...baseReport,
      ratio: { created: 1, closed: 1, ratio: 1.0 },
      age: { total: 3, stale30: 0, stale60: 0, stale90: 0 },
      horizon: { byHorizon: { 'horizon/a': 3 }, noHorizon: 0, distinctHorizons: 1 },
    };
    expect(classifyBacklogHealth(report)).toBe('healthy');
  });
});

describe('buildBacklogHealthReport', () => {
  it('assembles all axes into one report', () => {
    const openIssues = [
      open({ number: 1, createdAt: daysAgo(5), updatedAt: daysAgo(5), labels: ['horizon/a'] }),
      open({ number: 2, createdAt: daysAgo(120), updatedAt: daysAgo(100), labels: [] }),
    ];
    // `created` is fetched across ALL states — includes a created-and-closed issue (#9)
    const createdIssues: CreatedIssue[] = [
      { number: 1, createdAt: daysAgo(5) },
      { number: 9, createdAt: daysAgo(3) }, // created+closed inside window, not in `open`
      { number: 2, createdAt: daysAgo(120) }, // outside window
    ];
    const closedIssues: ClosedIssue[] = [{ number: 50, closedAt: daysAgo(2) }];
    const report = buildBacklogHealthReport(openIssues, createdIssues, closedIssues, NOW, 30);

    expect(report.totalOpen).toBe(2);
    expect(report.windowDays).toBe(30);
    // #1 and #9 were created within the 30-day window (#9 counts even though closed);
    // this is the bias fix — a derive-from-open numerator would have reported 1.
    expect(report.ratio.created).toBe(2);
    expect(report.ratio.closed).toBe(1);
    expect(report.age.total).toBe(2);
    expect(report.age.stale90).toBe(1);
    expect(report.horizon.noHorizon).toBe(1);
    expect(report.epicProgress.total).toBe(0);
    expect(typeof report.generatedAt).toBe('string');
  });

  it('feeds computed ratio into the verdict end-to-end (6 created / 2 closed → pathological)', () => {
    const createdIssues: CreatedIssue[] = Array.from({ length: 6 }, (_, i) => ({
      number: 100 + i,
      createdAt: daysAgo(3),
    }));
    const closedIssues: ClosedIssue[] = [
      { number: 200, closedAt: daysAgo(2) },
      { number: 201, closedAt: daysAgo(2) },
    ];
    const report = buildBacklogHealthReport([], createdIssues, closedIssues, NOW, 30);
    expect(report.ratio.ratio).toBe(3);
    expect(classifyBacklogHealth(report)).toBe('pathological');
  });
});

describe('formatReport', () => {
  it('prints epic terminal-pressure details', () => {
    const report = buildBacklogHealthReport(
      [
        open({
          number: 20,
          title: 'Partially landed epic',
          labels: ['epic'],
          updatedAt: daysAgo(40),
          body: '- [x] #1 done\n- [ ] #2 next',
        }),
      ],
      [],
      [],
      NOW,
      30,
      'owner/repo',
    );

    const text = formatReport(report, classifyBacklogHealth(report));
    expect(text).toContain('epic progress');
    expect(text).toContain('#20 needs-replan');
    expect(text).toContain('Partially landed epic');
  });
});

describe('parseArgs', () => {
  it('parses repo/window/json with defaults', () => {
    expect(parseArgs([])).toEqual({ repo: 'Garsson-io/kaizen', window: 30, json: false });
    expect(parseArgs(['--repo', 'o/r', '--window', '60', '--json'])).toEqual({
      repo: 'o/r',
      window: 60,
      json: true,
    });
  });

  it('rejects a missing or non-numeric --window instead of producing NaN', () => {
    expect(() => parseArgs(['--window'])).toThrow(/positive number/);
    expect(() => parseArgs(['--window', 'abc'])).toThrow(/positive number/);
    expect(() => parseArgs(['--window', '0'])).toThrow(/positive number/);
  });

  it('rejects a missing --repo value and unknown flags', () => {
    expect(() => parseArgs(['--repo'])).toThrow(/--repo requires/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});
