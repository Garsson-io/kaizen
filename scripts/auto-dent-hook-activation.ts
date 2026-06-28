/**
 * auto-dent-hook-activation — prove kaizen hooks actually loaded in a spawned
 * Claude session, and loudly degrade when they did not (#843).
 *
 * Auto-dent spawns `claude -p` sessions. The kaizen hook layer registers ONLY
 * through `.claude-plugin/plugin.json` (self-dogfood rule #1063), so if the
 * kaizen plugin is not loaded, ZERO kaizen hooks fire — no review gate, no
 * dirty-file check, no stop gate. Log evidence shows this is flaky: across
 * batches, 95 runs started with `plugins:[]` and 303 with the plugin loaded.
 * A silent `plugins:[]` run shipped 25 PRs with no review (batch jolly-marsupial).
 *
 * The stream-json `system.init` event is ground truth for what actually loaded
 * this session (unlike static on-disk config, which the flaky split proves can
 * diverge from what the runtime actually loads). The populated shape is
 * `plugins:[{"name":"kaizen","source":"kaizen@kaizen","path":"..."}]`; the
 * broken shape is `plugins:[]`. We inspect that event and, when the provider
 * claims hook support but the kaizen plugin is absent, mark the run degraded.
 *
 * This module is pure (no I/O) so the detection logic is unit-testable against
 * real captured init-event fixtures.
 */

import type { Provider } from './auto-dent-provider.js';
import { KAIZEN_PLUGIN_NAME, KAIZEN_PLUGIN_SOURCE } from '../src/kaizen-plugin-identity.js';

/** A single entry in a `system.init` event's `plugins[]` array. */
export interface InitPluginEntry {
  name?: string;
  source?: string;
  path?: string;
}

/**
 * Does this provider run a Claude Code hook runtime, and therefore claim that
 * kaizen hook enforcement is in effect? Only the Claude CLI loads the kaizen
 * plugin's hooks; Codex has no Claude Code hook runtime at all, so the absence
 * of plugins there is expected, not a failure.
 */
export function providerClaimsHookSupport(provider: Provider): boolean {
  return provider === 'claude';
}

/**
 * Tolerant extraction of the `plugins[]` array from a stream-json `system.init`
 * message. Returns `[]` for any shape that isn't an array of objects so callers
 * never throw on a malformed or future-changed event.
 */
export function extractInitPlugins(msg: Record<string, unknown> | null | undefined): InitPluginEntry[] {
  if (!msg || typeof msg !== 'object') return [];
  const raw = (msg as { plugins?: unknown }).plugins;
  if (!Array.isArray(raw)) return [];
  const out: InitPluginEntry[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      out.push({
        name: typeof e.name === 'string' ? e.name : undefined,
        source: typeof e.source === 'string' ? e.source : undefined,
        path: typeof e.path === 'string' ? e.path : undefined,
      });
    }
  }
  return out;
}

/** True if the kaizen plugin appears among the loaded plugins (by name or source). */
export function pluginsIncludeKaizen(plugins: InitPluginEntry[]): boolean {
  return plugins.some(
    p => p.name === KAIZEN_PLUGIN_NAME || p.source === KAIZEN_PLUGIN_SOURCE,
  );
}

export type HookActivationStatus = 'active' | 'degraded' | 'unknown' | 'not_expected';

export interface HookActivationVerdict {
  provider: Provider;
  /** Canonical batch/reporting status for hook activation. */
  status: HookActivationStatus;
  /** Provider claims a Claude Code hook runtime (so kaizen hooks are expected). */
  expected: boolean;
  /** The kaizen plugin was observed in the session's loaded plugins. */
  active: boolean;
  /** Hooks were expected but the kaizen plugin did not load — enforcement is off. */
  degraded: boolean;
  /** Plugin names observed in the init event (for diagnostics). */
  observedPlugins: string[];
  /** One-line human summary of the verdict. */
  message: string;
}

/**
 * Combine the provider's hook expectation with the observed init plugins into a
 * verdict. `degraded` is the actionable bit: provider claims hook support but
 * the kaizen plugin did not load, so no kaizen hook fired this session.
 */
export function evaluateHookActivation(args: {
  provider: Provider;
  plugins: InitPluginEntry[];
}): HookActivationVerdict {
  const { provider, plugins } = args;
  const expected = providerClaimsHookSupport(provider);
  const active = pluginsIncludeKaizen(plugins);
  const degraded = expected && !active;
  const status: HookActivationStatus = !expected ? 'not_expected' : active ? 'active' : 'degraded';
  const observedPlugins = plugins
    .map(p => p.name ?? p.source)
    .filter((n): n is string => typeof n === 'string');

  let message: string;
  if (!expected) {
    message = `${provider} has no Claude Code hook runtime; kaizen hook enforcement not expected.`;
  } else if (active) {
    message = `kaizen plugin loaded — hook enforcement active.`;
  } else {
    message = `kaizen plugin NOT loaded (plugins: ${
      observedPlugins.length ? observedPlugins.join(', ') : 'none'
    }) — NO kaizen hooks fired this session.`;
  }

  return { provider, status, expected, active, degraded, observedPlugins, message };
}

/**
 * Fail-closed verdict for absent or invalid init evidence. This keeps the
 * durable run metric explicit: "unknown" is data, not an omitted field.
 */
export function unknownHookActivationVerdict(provider: Provider, reason: string): HookActivationVerdict {
  const expected = providerClaimsHookSupport(provider);
  if (!expected) {
    return {
      provider,
      status: 'not_expected',
      expected: false,
      active: false,
      degraded: false,
      observedPlugins: [],
      message: `${provider} has no Claude Code hook runtime; ${reason}.`,
    };
  }
  return {
    provider,
    status: 'unknown',
    expected: true,
    active: false,
    degraded: true,
    observedPlugins: [],
    message: `${reason}; hook activation unknown for hook-expecting provider.`,
  };
}

export function hookActivationStatus(verdict: HookActivationVerdict | undefined): HookActivationStatus | undefined {
  if (!verdict) return undefined;
  if (verdict.status) return verdict.status;
  if (!verdict.expected) return 'not_expected';
  if (verdict.degraded) return 'degraded';
  return verdict.active ? 'active' : 'unknown';
}

export function formatHookActivationDistribution(distribution: Partial<Record<HookActivationStatus, number>>): string {
  const order: HookActivationStatus[] = ['active', 'degraded', 'unknown', 'not_expected'];
  return order
    .filter(status => (distribution[status] ?? 0) > 0)
    .map(status => `${status}:${distribution[status]}`)
    .join(', ');
}

export interface HookActivationCounts {
  distribution?: Partial<Record<HookActivationStatus, number>>;
  degradedCount?: number;
}

export function computeHookActivationCounts(statuses: Array<HookActivationStatus | undefined>): HookActivationCounts {
  const distribution: Partial<Record<HookActivationStatus, number>> = {};
  for (const status of statuses) {
    if (!status) continue;
    distribution[status] = (distribution[status] ?? 0) + 1;
  }
  if (Object.keys(distribution).length === 0) return {};
  return {
    distribution,
    degradedCount: (distribution.degraded ?? 0) + (distribution.unknown ?? 0),
  };
}

/**
 * Render a verdict for the run log/console. Degraded/unknown verdicts produce
 * loud, unmissable banners; active verdicts produce a single confirmation line;
 * an unexpected-but-absent case stays quiet.
 */
export function formatHookActivationBanner(verdict: HookActivationVerdict): string {
  if (verdict.status === 'unknown') {
    const bar = '!'.repeat(64);
    return [
      bar,
      '!! HOOK ENFORCEMENT UNKNOWN — system.init evidence invalid (#1501)',
      `!! ${verdict.message}`,
      '!! This session may have run WITHOUT review/dirty-file/stop gates. Its',
      '!! PR was NOT proven to be gated by kaizen enforcement.',
      bar,
    ].join('\n');
  }
  if (verdict.degraded) {
    const bar = '!'.repeat(64);
    return [
      bar,
      '!! HOOK ENFORCEMENT DEGRADED — kaizen hooks did NOT load (#843)',
      `!! ${verdict.message}`,
      '!! This session ran WITHOUT review/dirty-file/stop gates. Its PR was',
      '!! NOT gated by kaizen enforcement. Treat the run as unverified.',
      bar,
    ].join('\n');
  }
  return `[hooks] ${verdict.message}`;
}

/**
 * The line to append to the per-run log for a verdict: the loud banner when the
 * run is degraded, else `null` (active / hooks-not-expected runs don't clutter
 * the log). Extracted so the "degraded → durable in the run log" guarantee is
 * unit-testable rather than buried in `main()` (#843).
 */
export function degradedRunLogBanner(verdict: HookActivationVerdict | undefined): string | null {
  return verdict?.degraded ? formatHookActivationBanner(verdict) : null;
}
