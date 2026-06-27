import { describe, it, expect } from 'vitest';
import {
  CAPABILITY_INVENTORY,
  PHASES,
  PROVIDERS,
  SUBSCRIPTION_COMPATIBLE_BILLING,
  renderCapabilityMatrix,
  validateProviderPlan,
  defaultPhaseProviders,
  type ProviderCapability,
  type ProviderPlan,
} from './auto-dent-provider.js';

describe('capability inventory (#1141)', () => {
  it('validates inventory shape — every entry is well-formed', () => {
    const fits = new Set(['best', 'works', 'avoid']);
    const billings = new Set(['subscription-cli', 'local-only', 'api-token']);
    for (const c of CAPABILITY_INVENTORY) {
      expect(PROVIDERS).toContain(c.provider);
      expect(PHASES).toContain(c.phase);
      expect(billings.has(c.billingMode)).toBe(true);
      expect(fits.has(c.fit)).toBe(true);
      expect(typeof c.acceptedForUnattended).toBe('boolean');
      expect(c.rationale.length).toBeGreaterThan(0);
    }
  });

  it('covers claude-best, codex-best, and provider-independent capabilities', () => {
    const has = (p: string, fit: string) =>
      CAPABILITY_INVENTORY.some((c) => c.provider === p && c.fit === fit && c.acceptedForUnattended);
    expect(has('claude', 'best')).toBe(true);
    expect(has('codex', 'best')).toBe(true);
    expect(
      CAPABILITY_INVENTORY.some(
        (c) => c.provider === 'provider-independent' && c.acceptedForUnattended,
      ),
    ).toBe(true);
  });

  it('records api-token paths as documented but NOT accepted (subscription constraint)', () => {
    const apiToken = CAPABILITY_INVENTORY.filter((c) => c.billingMode === 'api-token');
    expect(apiToken.length).toBeGreaterThan(0);
    for (const c of apiToken) {
      expect(c.acceptedForUnattended).toBe(false);
    }
  });
});

describe('renderCapabilityMatrix (#1141)', () => {
  it('names every phase', () => {
    const out = renderCapabilityMatrix();
    for (const phase of PHASES) {
      expect(out).toContain(`## ${phase}`);
    }
  });

  it('honors an explicitly-passed inventory override', () => {
    const custom: ProviderCapability[] = [
      { provider: 'codex', phase: 'implementation', billingMode: 'subscription-cli', fit: 'best', acceptedForUnattended: true, rationale: 'custom only' },
    ];
    const out = renderCapabilityMatrix(custom);
    expect(out).toContain('custom only');
    expect(out).not.toContain('Claude Code plans');
  });
});

describe('validateProviderPlan (#1142)', () => {
  it('accepts a subscription-only plan', () => {
    const plan: ProviderPlan = {
      planning: 'claude',
      implementation: 'codex',
      review: 'claude',
      fix: 'codex',
      reflection: 'claude',
      validation: 'provider-independent',
    };
    const result = validateProviderPlan(plan);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('accepts an empty plan (no phases to violate)', () => {
    expect(validateProviderPlan({}).ok).toBe(true);
  });

  it('rejects a plan whose phase only has api-token capability, with a clear reason', () => {
    // Custom inventory: codex/review is ONLY available via api-token.
    const inventory: ProviderCapability[] = [
      { provider: 'codex', phase: 'review', billingMode: 'api-token', fit: 'avoid', acceptedForUnattended: false, rationale: 'api-token only' },
    ];
    const result = validateProviderPlan({ review: 'codex' }, inventory);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].phase).toBe('review');
    expect(result.violations[0].provider).toBe('codex');
    expect(result.violations[0].reason).toContain('api-token');
    expect(result.violations[0].reason).toContain('subscription-compatible');
  });

  it('rejects a phase with no accepted capability at all, with a distinct reason', () => {
    const result = validateProviderPlan({ planning: 'codex' }, []);
    expect(result.ok).toBe(false);
    expect(result.violations[0].reason).toContain('no accepted subscription-compatible capability');
  });

  it('only subscription-cli and local-only count as subscription-compatible', () => {
    expect([...SUBSCRIPTION_COMPATIBLE_BILLING].sort()).toEqual(['local-only', 'subscription-cli']);
    expect(SUBSCRIPTION_COMPATIBLE_BILLING).not.toContain('api-token');
  });
});

describe('defaultPhaseProviders (#1143)', () => {
  it('maps agent phases to Claude under subscription and validation to provider-independent', () => {
    const d = defaultPhaseProviders();
    for (const phase of ['planning', 'implementation', 'review', 'fix', 'reflection'] as const) {
      expect(d[phase]).toEqual({ provider: 'claude', billing: 'subscription-cli' });
    }
    expect(d.validation).toEqual({ provider: 'provider-independent', billing: 'local-only' });
  });

  it('produces a plan that passes validateProviderPlan', () => {
    const plan: ProviderPlan = {};
    for (const [phase, pp] of Object.entries(defaultPhaseProviders())) {
      plan[phase as keyof ProviderPlan] = pp!.provider;
    }
    expect(validateProviderPlan(plan).ok).toBe(true);
  });
});
