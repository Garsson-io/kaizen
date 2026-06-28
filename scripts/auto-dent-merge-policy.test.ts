import { describe, expect, it } from 'vitest';
import { autoMergeBlockReasons, decideAutoMergeSafety } from './auto-dent-merge-policy.js';
import { evaluateHookActivation, extractInitPlugins } from './auto-dent-hook-activation.js';

// Real captured `system.init` shapes (mirror the fixtures in
// auto-dent-hook-activation.test.ts — `plugins` arrays copied verbatim from
// auto-dent logs). Verdicts are built through the production `evaluateHookActivation`
// so the gate is exercised against the SAME verdict shape production emits, not a
// hand-rolled `{degraded:true}`.
const INIT_PLUGINS_EMPTY = { type: 'system', subtype: 'init', plugins: [] as unknown[] };
const INIT_PLUGINS_KAIZEN = {
  type: 'system',
  subtype: 'init',
  plugins: [
    { name: 'kaizen', path: '/home/aviad/.claude/plugins/marketplaces/kaizen/', source: 'kaizen@kaizen' },
  ],
};

/** Build a verdict the way production does: provider + extracted init plugins. */
const verdict = (provider: 'claude' | 'codex', initMsg: typeof INIT_PLUGINS_EMPTY) =>
  evaluateHookActivation({ provider, plugins: extractInitPlugins(initMsg) });

const HOOK_DEGRADED_CLAUDE = verdict('claude', INIT_PLUGINS_EMPTY); // expected, !active → degraded
const HOOK_ACTIVE_CLAUDE = verdict('claude', INIT_PLUGINS_KAIZEN); // expected, active → ok
const HOOK_CODEX_EMPTY = verdict('codex', INIT_PLUGINS_EMPTY); // !expected → not degraded

describe('auto-dent merge policy (#1220)', () => {
  it('allows a PR only when required review passed and no hard process/lifecycle verdict failed', () => {
    expect(
      decideAutoMergeSafety({
        prCount: 1,
        reviewRequired: true,
        reviewVerdict: 'pass',
        processVerdict: 'pass',
        lifecycleHealth: 'clean',
      }),
    ).toEqual({ allow: true, reasons: [] });
  });

  it.each([
    ['review FAIL', { reviewVerdict: 'fail' as const }, 'review verdict fail'],
    ['review skipped', { reviewVerdict: 'skipped' as const }, 'review verdict skipped'],
    ['review missing', { reviewVerdict: undefined }, 'review verdict missing'],
    ['process incomplete', { processVerdict: 'process-incomplete' as const }, 'process verdict process-incomplete'],
    ['critical lifecycle', { lifecycleHealth: 'critical' as const }, 'lifecycle health critical'],
  ])('blocks auto-merge on %s', (_name, patch, reason) => {
    expect(
      autoMergeBlockReasons({
        prCount: 1,
        reviewRequired: true,
        reviewVerdict: 'pass',
        processVerdict: 'pass',
        lifecycleHealth: 'clean',
        ...patch,
      }),
    ).toContain(reason);
  });

  it('does not block non-PR runs', () => {
    expect(
      decideAutoMergeSafety({
        prCount: 0,
        reviewRequired: true,
        reviewVerdict: 'skipped',
        processVerdict: 'process-incomplete',
        lifecycleHealth: 'critical',
      }),
    ).toEqual({ allow: true, reasons: [] });
  });

  it('allows synthetic non-review runs unless a hard fail was observed', () => {
    expect(
      decideAutoMergeSafety({
        prCount: 1,
        reviewRequired: false,
        reviewVerdict: 'skipped',
        processVerdict: 'pass',
        lifecycleHealth: 'clean',
      }).allow,
    ).toBe(true);

    expect(
      decideAutoMergeSafety({
        prCount: 1,
        reviewRequired: false,
        reviewVerdict: 'fail',
        processVerdict: 'pass',
        lifecycleHealth: 'clean',
      }).allow,
    ).toBe(false);
  });
});

describe('auto-dent merge policy — hook_activation binding (#1220 completion / #843)', () => {
  // Baseline: an otherwise merge-ready PR-producing reviewed run.
  const ready = {
    prCount: 1,
    reviewRequired: true,
    reviewVerdict: 'pass' as const,
    processVerdict: 'pass' as const,
    lifecycleHealth: 'clean' as const,
  };

  it('sanity: the real fixtures produce the expected verdict shapes', () => {
    expect(HOOK_DEGRADED_CLAUDE.degraded).toBe(true);
    expect(HOOK_DEGRADED_CLAUDE.expected).toBe(true);
    expect(HOOK_ACTIVE_CLAUDE.degraded).toBe(false);
    expect(HOOK_ACTIVE_CLAUDE.active).toBe(true);
    expect(HOOK_CODEX_EMPTY.expected).toBe(false);
    expect(HOOK_CODEX_EMPTY.degraded).toBe(false);
  });

  it('1. blocks a degraded claude PR (kaizen hooks did not load)', () => {
    const d = decideAutoMergeSafety({ ...ready, hookActivation: HOOK_DEGRADED_CLAUDE, provider: 'claude' });
    expect(d.allow).toBe(false);
    expect(d.reasons).toContain('hook enforcement degraded (kaizen hooks did not load)');
  });

  it('2. blocks when no system.init was observed on claude (unknown hook state)', () => {
    const d = decideAutoMergeSafety({ ...ready, hookActivation: undefined, provider: 'claude' });
    expect(d.allow).toBe(false);
    expect(d.reasons).toContain(
      'hook activation unknown (no system.init observed on a hook-expecting provider)',
    );
  });

  it('3. defaults missing provider to hook-expecting → blocks unknown hook state', () => {
    // Mirrors the call site default `provider: state.provider ?? "claude"`.
    const d = decideAutoMergeSafety({ ...ready, hookActivation: undefined, provider: 'claude' });
    expect(d.allow).toBe(false);
  });

  it('4. allows codex with empty plugins (provider asymmetry — hooks not expected)', () => {
    const d = decideAutoMergeSafety({ ...ready, hookActivation: HOOK_CODEX_EMPTY, provider: 'codex' });
    expect(d.allow).toBe(true);
  });

  it('5. allows codex with no system.init (codex never expects hooks)', () => {
    const d = decideAutoMergeSafety({ ...ready, hookActivation: undefined, provider: 'codex' });
    expect(d.allow).toBe(true);
  });

  it('6. allows a claude PR when kaizen plugin loaded (active, not degraded)', () => {
    const d = decideAutoMergeSafety({ ...ready, hookActivation: HOOK_ACTIVE_CLAUDE, provider: 'claude' });
    expect(d.allow).toBe(true);
  });

  it('7. does NOT block a synthetic/test-task run (reviewRequired false) even if degraded', () => {
    const d = decideAutoMergeSafety({
      ...ready,
      reviewRequired: false,
      hookActivation: HOOK_DEGRADED_CLAUDE,
      provider: 'claude',
    });
    expect(d.allow).toBe(true);
  });

  it('8. does NOT block a non-PR run (prCount 0) even with unknown hook state on claude', () => {
    const d = decideAutoMergeSafety({ ...ready, prCount: 0, hookActivation: undefined, provider: 'claude' });
    expect(d.allow).toBe(true);
  });

  it('9. surfaces BOTH the review-fail and the hook reasons when both are red', () => {
    const reasons = autoMergeBlockReasons({
      ...ready,
      reviewVerdict: 'fail',
      hookActivation: HOOK_DEGRADED_CLAUDE,
      provider: 'claude',
    });
    expect(reasons).toContain('review verdict fail');
    expect(reasons).toContain('hook enforcement degraded (kaizen hooks did not load)');
  });

  it('regression: an active hook verdict introduces no new blocks for previously-ready runs', () => {
    // Same as the original "allows a PR" baseline, now with an active verdict attached.
    expect(
      decideAutoMergeSafety({ ...ready, hookActivation: HOOK_ACTIVE_CLAUDE, provider: 'claude' }),
    ).toEqual({ allow: true, reasons: [] });
  });
});

describe('auto-dent merge policy — test-health binding (#1481/#1518)', () => {
  const ready = {
    prCount: 1,
    reviewRequired: true,
    reviewVerdict: 'pass' as const,
    processVerdict: 'pass' as const,
    lifecycleHealth: 'clean' as const,
    hookActivation: HOOK_ACTIVE_CLAUDE,
    provider: 'claude' as const,
  };

  it('blocks a PR whose run observed an unowned test failure', () => {
    const d = decideAutoMergeSafety({ ...ready, testHealth: 'unowned-failures' });
    expect(d.allow).toBe(false);
    expect(d.reasons.some(r => r.includes('test health unowned-failures'))).toBe(true);
  });

  it('blocks regardless of reviewRequired (test health is provider-agnostic, not review-gated)', () => {
    const d = decideAutoMergeSafety({ ...ready, reviewRequired: false, testHealth: 'unowned-failures' });
    expect(d.allow).toBe(false);
  });

  it('does not block on pass / unknown / absent test-health', () => {
    expect(decideAutoMergeSafety({ ...ready, testHealth: 'pass' }).allow).toBe(true);
    expect(decideAutoMergeSafety({ ...ready, testHealth: 'unknown' }).allow).toBe(true);
    expect(decideAutoMergeSafety({ ...ready }).allow).toBe(true);
  });

  it('does not block an unowned-failure run that is not producing a PR', () => {
    expect(decideAutoMergeSafety({ ...ready, prCount: 0, testHealth: 'unowned-failures' }).allow).toBe(true);
  });

  it('surfaces test-health alongside other red verdicts', () => {
    const reasons = autoMergeBlockReasons({ ...ready, reviewVerdict: 'fail', testHealth: 'unowned-failures' });
    expect(reasons).toContain('review verdict fail');
    expect(reasons.some(r => r.includes('test health unowned-failures'))).toBe(true);
  });
});
