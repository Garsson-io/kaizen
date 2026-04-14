import { describe, it, expect } from 'vitest';
import type { HookTimeline } from './hook-gym-schema.js';
import { formatTimeline, summarizeTimeline } from './hook-gym-format.js';
import { evt } from './hook-gym-test-utils.js';

describe('formatTimeline', () => {
  it('renders the header with event count and end timestamp', () => {
    const timeline: HookTimeline = {
      events: [
        evt({ timestamp: 0, eventType: 'SessionStart' }),
        evt({ timestamp: 100, eventType: 'PreToolUse' }),
        evt({ timestamp: 250, eventType: 'Stop' }),
      ],
      gatesActivated: {},
      gatesCleared: {},
    };

    const out = formatTimeline(timeline);

    expect(out.split('\n')[0]).toBe('# Hook Timeline — 3 events · 250ms');
  });

  it('singular event count when exactly 1 event', () => {
    const timeline: HookTimeline = {
      events: [evt({ timestamp: 50 })],
      gatesActivated: {},
      gatesCleared: {},
    };
    expect(formatTimeline(timeline)).toContain('1 event ·');
  });

  it('renders an event row with all fields', () => {
    const timeline: HookTimeline = {
      events: [
        evt({
          timestamp: 123,
          eventType: 'PreToolUse',
          hookName: 'PreToolUse:Bash',
          decision: 'deny',
          reason: 'no kaizen case found',
          durationMs: 42,
        }),
      ],
      gatesActivated: {},
      gatesCleared: {},
    };

    const out = formatTimeline(timeline);

    expect(out).toContain(
      '| 123 | PreToolUse | PreToolUse:Bash | deny | 42 | no kaizen case found |',
    );
  });

  it('renders dash for missing reason and none decision', () => {
    const timeline: HookTimeline = {
      events: [
        evt({ timestamp: 0, eventType: 'SessionStart', hookName: 'SessionStart:s', decision: 'none', reason: null, durationMs: 3 }),
      ],
      gatesActivated: {},
      gatesCleared: {},
    };
    expect(formatTimeline(timeline)).toContain('| 0 | SessionStart | SessionStart:s | none | 3 | — |');
  });

  it('escapes pipe characters in hook names and reasons so the table does not break', () => {
    const timeline: HookTimeline = {
      events: [
        evt({
          timestamp: 1,
          hookName: 'weird|hook',
          decision: 'deny',
          reason: 'contains | pipes | everywhere',
        }),
      ],
      gatesActivated: {},
      gatesCleared: {},
    };
    const out = formatTimeline(timeline);
    expect(out).toContain('weird\\|hook');
    expect(out).toContain('contains \\| pipes \\| everywhere');
  });

  it('truncates very long reasons', () => {
    const longReason = 'x'.repeat(120);
    const timeline: HookTimeline = {
      events: [evt({ reason: longReason, decision: 'block' })],
      gatesActivated: {},
      gatesCleared: {},
    };
    const out = formatTimeline(timeline);
    expect(out).toContain('xxx…');
    expect(out).not.toContain(longReason);
  });

  it('renders a placeholder when no events captured', () => {
    const timeline: HookTimeline = { events: [], gatesActivated: {}, gatesCleared: {} };
    const out = formatTimeline(timeline);
    expect(out).toContain('_No hook events captured._');
    expect(out).toContain('0 events · 0ms');
  });

  it('renders each gate with its lifecycle', () => {
    const timeline: HookTimeline = {
      events: [],
      gatesActivated: { needs_review: 100, needs_pr_kaizen: 200 },
      gatesCleared: { needs_review: 5000 },
    };

    const out = formatTimeline(timeline);

    expect(out).toContain('- **needs_pr_kaizen**: activated @200ms (still active at run end)');
    expect(out).toContain('- **needs_review**: activated @100ms, cleared @5000ms');
  });

  it('handles a gate that was only cleared (e.g. already set at run start)', () => {
    const timeline: HookTimeline = {
      events: [],
      gatesActivated: {},
      gatesCleared: { needs_review: 500 },
    };
    const out = formatTimeline(timeline);
    expect(out).toContain('- **needs_review**: cleared @500ms (no activation observed this run)');
  });

  it('gate list is alphabetically ordered for deterministic output', () => {
    const t1: HookTimeline = {
      events: [],
      gatesActivated: { zebra: 1, apple: 2, mango: 3 },
      gatesCleared: {},
    };
    const t2: HookTimeline = {
      events: [],
      gatesActivated: { mango: 3, apple: 2, zebra: 1 },
      gatesCleared: {},
    };
    expect(formatTimeline(t1)).toBe(formatTimeline(t2));

    const out = formatTimeline(t1);
    const appleIdx = out.indexOf('apple');
    const mangoIdx = out.indexOf('mango');
    const zebraIdx = out.indexOf('zebra');
    expect(appleIdx).toBeLessThan(mangoIdx);
    expect(mangoIdx).toBeLessThan(zebraIdx);
  });

  it('empty gates section when timeline has no gates', () => {
    const timeline: HookTimeline = {
      events: [evt({ timestamp: 0 })],
      gatesActivated: {},
      gatesCleared: {},
    };
    expect(formatTimeline(timeline)).toContain('_No gates observed._');
  });

  it('always ends with exactly one trailing newline', () => {
    const timeline: HookTimeline = {
      events: [evt({})],
      gatesActivated: {},
      gatesCleared: {},
    };
    const out = formatTimeline(timeline);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });
});

describe('summarizeTimeline', () => {
  it('produces a one-line summary with events · gates · duration', () => {
    const timeline: HookTimeline = {
      events: [evt({ timestamp: 0 }), evt({ timestamp: 100 }), evt({ timestamp: 500 })],
      gatesActivated: { needs_review: 100 },
      gatesCleared: { needs_review: 400 },
    };
    expect(summarizeTimeline('probe-hooks', timeline)).toBe(
      'probe-hooks: 3 events · 1 gates · 500ms',
    );
  });

  it('counts activated+cleared as a single gate even if both exist', () => {
    const timeline: HookTimeline = {
      events: [],
      gatesActivated: { a: 1, b: 2 },
      gatesCleared: { a: 3 },
    };
    expect(summarizeTimeline('x', timeline)).toContain('2 gates');
  });
});
