/**
 * Tests for auto-dent-hook-activation (#843).
 *
 * The `INIT_*` fixtures are real stream-json `system.init` events captured
 * verbatim from auto-dent logs (the `plugins` arrays are copied exactly):
 *   - INIT_PLUGINS_EMPTY  — logs/auto-dent/back-cardinal/run-2 (the bug: no hooks)
 *   - INIT_PLUGINS_KAIZEN — a healthy run with the kaizen plugin loaded
 * Testing against the real shape (per the #1102/#1114 lesson) keeps the parser
 * tracking what Claude Code actually emits, not a synthetic guess.
 */

import { describe, it, expect } from 'vitest';
import {
  degradedRunLogBanner,
  evaluateHookActivation,
  extractInitPlugins,
  formatHookActivationBanner,
  pluginsIncludeKaizen,
  providerClaimsHookSupport,
} from './auto-dent-hook-activation.js';
import { KAIZEN_PLUGIN_NAME, KAIZEN_PLUGIN_SOURCE } from '../src/kaizen-plugin-identity.js';

const INIT_PLUGINS_EMPTY = {
  type: 'system',
  subtype: 'init',
  plugins: [] as unknown[],
};

const INIT_PLUGINS_KAIZEN = {
  type: 'system',
  subtype: 'init',
  plugins: [
    { name: 'kaizen', path: '/home/aviad/.claude/plugins/marketplaces/kaizen/', source: 'kaizen@kaizen' },
  ],
};

describe('extractInitPlugins (real fixtures)', () => {
  it('returns [] for a captured plugins:[] init event', () => {
    expect(extractInitPlugins(INIT_PLUGINS_EMPTY)).toEqual([]);
  });

  it('returns the kaizen entry for a captured populated init event', () => {
    const plugins = extractInitPlugins(INIT_PLUGINS_KAIZEN);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('kaizen');
    expect(plugins[0].source).toBe('kaizen@kaizen');
  });

  it('tolerates malformed shapes without throwing', () => {
    expect(extractInitPlugins(null)).toEqual([]);
    expect(extractInitPlugins(undefined)).toEqual([]);
    expect(extractInitPlugins({})).toEqual([]); // missing key
    expect(extractInitPlugins({ plugins: 'nope' })).toEqual([]); // not an array
    expect(extractInitPlugins({ plugins: ['str', 42, null] })).toEqual([]); // non-object entries dropped
  });

  it('drops entries missing both name and source identifiers', () => {
    const plugins = extractInitPlugins({ plugins: [{ path: '/x' }] });
    expect(plugins).toHaveLength(1);
    expect(pluginsIncludeKaizen(plugins)).toBe(false);
  });
});

describe('plugin-identity single source of truth (#843 anti-drift)', () => {
  // kaizen-doctor derives the cache dir name as `source.split('@')[0]`; both the
  // static doctor check and this runtime check key off these same two constants,
  // so this invariant is what keeps them from drifting on a rename.
  it('the source string is <name>@<marketplace>', () => {
    expect(KAIZEN_PLUGIN_SOURCE.split('@')[0]).toBe(KAIZEN_PLUGIN_NAME);
  });

  it('the runtime detector matches the shared source string', () => {
    expect(pluginsIncludeKaizen([{ source: KAIZEN_PLUGIN_SOURCE }])).toBe(true);
    expect(pluginsIncludeKaizen([{ name: KAIZEN_PLUGIN_NAME }])).toBe(true);
  });
});

describe('pluginsIncludeKaizen', () => {
  it('matches by name', () => {
    expect(pluginsIncludeKaizen([{ name: 'kaizen' }])).toBe(true);
  });
  it('matches by source even if name differs', () => {
    expect(pluginsIncludeKaizen([{ name: 'other', source: 'kaizen@kaizen' }])).toBe(true);
  });
  it('does not match an unrelated plugin', () => {
    expect(pluginsIncludeKaizen([{ name: 'other', source: 'other@market' }])).toBe(false);
  });
});

describe('providerClaimsHookSupport', () => {
  it('only Claude runs the Claude Code hook runtime', () => {
    expect(providerClaimsHookSupport('claude')).toBe(true);
    expect(providerClaimsHookSupport('codex')).toBe(false);
    expect(providerClaimsHookSupport('provider-independent')).toBe(false);
  });
});

describe('evaluateHookActivation (verdict matrix)', () => {
  it('claude + kaizen loaded → active, not degraded', () => {
    const v = evaluateHookActivation({
      provider: 'claude',
      plugins: extractInitPlugins(INIT_PLUGINS_KAIZEN),
    });
    expect(v).toMatchObject({ expected: true, active: true, degraded: false });
  });

  it('claude + plugins:[] → DEGRADED (the #843 bug)', () => {
    const v = evaluateHookActivation({
      provider: 'claude',
      plugins: extractInitPlugins(INIT_PLUGINS_EMPTY),
    });
    expect(v).toMatchObject({ expected: true, active: false, degraded: true });
    expect(v.message).toMatch(/NOT loaded/i);
  });

  it('codex + plugins:[] → not expected, not degraded (Codex has no hook runtime)', () => {
    const v = evaluateHookActivation({
      provider: 'codex',
      plugins: extractInitPlugins(INIT_PLUGINS_EMPTY),
    });
    expect(v).toMatchObject({ expected: false, active: false, degraded: false });
  });

  it('claude + only a non-kaizen plugin → degraded', () => {
    const v = evaluateHookActivation({
      provider: 'claude',
      plugins: [{ name: 'other', source: 'other@market' }],
    });
    expect(v.degraded).toBe(true);
    expect(v.observedPlugins).toContain('other');
  });
});

describe('formatHookActivationBanner', () => {
  it('degraded verdict produces a loud banner referencing #843', () => {
    const v = evaluateHookActivation({ provider: 'claude', plugins: [] });
    const banner = formatHookActivationBanner(v);
    expect(banner).toMatch(/HOOK ENFORCEMENT DEGRADED/);
    expect(banner).toMatch(/#843/);
  });

  it('active verdict produces a quiet confirmation, no alarm', () => {
    const v = evaluateHookActivation({
      provider: 'claude',
      plugins: extractInitPlugins(INIT_PLUGINS_KAIZEN),
    });
    const banner = formatHookActivationBanner(v);
    expect(banner).not.toMatch(/DEGRADED/);
    expect(banner).toMatch(/active/i);
  });
});

describe('degradedRunLogBanner (durable per-run-log surface, #843)', () => {
  it('returns the loud banner for a degraded run (must be durable in the log)', () => {
    const v = evaluateHookActivation({ provider: 'claude', plugins: [] });
    const line = degradedRunLogBanner(v);
    expect(line).toMatch(/HOOK ENFORCEMENT DEGRADED/);
  });

  it('returns null for an active run (no log clutter)', () => {
    const v = evaluateHookActivation({
      provider: 'claude',
      plugins: extractInitPlugins(INIT_PLUGINS_KAIZEN),
    });
    expect(degradedRunLogBanner(v)).toBeNull();
  });

  it('returns null when no verdict was produced', () => {
    expect(degradedRunLogBanner(undefined)).toBeNull();
  });
});
