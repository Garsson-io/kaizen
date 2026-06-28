import { describe, it, expect } from 'vitest';
import {
  BillingModeSchema,
  PHASES,
  PhaseProviderRecordSchema,
  PhaseProviderSchema,
  PhaseSchema,
  PROVIDER_CAPABILITIES,
  ProviderCapabilitySchema,
  SUBSCRIPTION_COMPATIBLE_BILLING,
  phaseProviderRecordToProviderPlan,
  renderCapabilityMatrix,
  validateProviderPlan,
  defaultPhaseProviders,
  phaseProvidersForAgentProvider,
  parsePhaseProviderRecord,
  ProviderSchema,
  type ProviderCapability,
  type ProviderPlan,
} from './auto-dent-provider.js';

describe('capability inventory (#1141)', () => {
  it('exports runtime schemas for provider lifecycle records (#1490)', () => {
    expect(ProviderSchema.parse('claude')).toBe('claude');
    expect(PhaseSchema.parse('planning')).toBe('planning');
    expect(BillingModeSchema.parse('subscription-cli')).toBe('subscription-cli');
    expect(PhaseProviderSchema.parse({ provider: 'codex', billing: 'subscription-cli' })).toEqual({
      provider: 'codex',
      billing: 'subscription-cli',
    });

    expect(() => ProviderSchema.parse('gpt-five')).toThrow();
    expect(() => PhaseSchema.parse('deploy')).toThrow();
    expect(() => BillingModeSchema.parse('credit-card')).toThrow();
    expect(() => PhaseProviderSchema.parse({ provider: 'claude', billing: 'credit-card' })).toThrow();
    expect(() => PhaseProviderRecordSchema.parse({
      deploy: { provider: 'claude', billing: 'subscription-cli' },
    })).toThrow();
    expect(() => ProviderCapabilitySchema.parse({
      provider: 'claude',
      phase: 'planning',
      billingMode: 'subscription-cli',
      fit: 'best',
      acceptedForUnattended: true,
      rationale: '',
    })).toThrow();
  });

  it('validates inventory shape — every entry is well-formed', () => {
    for (const c of PROVIDER_CAPABILITIES) {
      expect(ProviderCapabilitySchema.parse(c)).toEqual(c);
    }
  });

  it('covers claude-best, codex-best, and provider-independent capabilities', () => {
    const has = (p: string, fit: string) =>
      PROVIDER_CAPABILITIES.some((c) => c.provider === p && c.fit === fit && c.acceptedForUnattended);
    expect(has('claude', 'best')).toBe(true);
    expect(has('codex', 'best')).toBe(true);
    expect(
      PROVIDER_CAPABILITIES.some(
        (c) => c.provider === 'provider-independent' && c.acceptedForUnattended,
      ),
    ).toBe(true);
  });

  it('records api-token paths as documented but NOT accepted (subscription constraint)', () => {
    const apiToken = PROVIDER_CAPABILITIES.filter((c) => c.billingMode === 'api-token');
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
    const plan = phaseProviderRecordToProviderPlan(defaultPhaseProviders());
    expect(validateProviderPlan(plan).ok).toBe(true);
  });

  it('parses and serializes existing default Claude and Codex records through one contract (#1490)', () => {
    const claude = parsePhaseProviderRecord(defaultPhaseProviders());
    const codex = parsePhaseProviderRecord(phaseProvidersForAgentProvider('codex'));

    expect(claude).toEqual(defaultPhaseProviders());
    expect(codex.implementation).toEqual({ provider: 'codex', billing: 'subscription-cli' });
    expect(codex.review).toEqual({ provider: 'claude', billing: 'subscription-cli' });
    expect(codex.validation).toEqual({ provider: 'provider-independent', billing: 'local-only' });
    expect(validateProviderPlan(phaseProviderRecordToProviderPlan(codex)).ok).toBe(true);
  });

  it('derives Codex-run phase providers from accepted runtime capabilities instead of literals (#1580)', () => {
    const custom: ProviderCapability[] = [
      { provider: 'claude', phase: 'planning', billingMode: 'subscription-cli', fit: 'best', acceptedForUnattended: true, rationale: 'runtime available' },
      { provider: 'claude', phase: 'implementation', billingMode: 'subscription-cli', fit: 'best', acceptedForUnattended: true, rationale: 'runtime available' },
      { provider: 'claude', phase: 'review', billingMode: 'subscription-cli', fit: 'best', acceptedForUnattended: true, rationale: 'runtime available' },
      { provider: 'claude', phase: 'fix', billingMode: 'subscription-cli', fit: 'works', acceptedForUnattended: true, rationale: 'runtime available' },
      { provider: 'claude', phase: 'reflection', billingMode: 'subscription-cli', fit: 'best', acceptedForUnattended: true, rationale: 'runtime available' },
      { provider: 'provider-independent', phase: 'validation', billingMode: 'local-only', fit: 'best', acceptedForUnattended: true, rationale: 'runtime available' },
      { provider: 'codex', phase: 'planning', billingMode: 'subscription-cli', fit: 'best', acceptedForUnattended: true, rationale: 'runtime available' },
      { provider: 'codex', phase: 'implementation', billingMode: 'subscription-cli', fit: 'avoid', acceptedForUnattended: false, rationale: 'temporarily disabled' },
      { provider: 'codex', phase: 'review', billingMode: 'subscription-cli', fit: 'avoid', acceptedForUnattended: false, rationale: 'structured review unavailable' },
      { provider: 'codex', phase: 'fix', billingMode: 'subscription-cli', fit: 'best', acceptedForUnattended: true, rationale: 'runtime available' },
      { provider: 'codex', phase: 'reflection', billingMode: 'subscription-cli', fit: 'works', acceptedForUnattended: true, rationale: 'runtime available' },
    ];

    const codex = phaseProvidersForAgentProvider('codex', custom);

    expect(codex.planning).toEqual({ provider: 'codex', billing: 'subscription-cli' });
    expect(codex.implementation).toEqual({ provider: 'claude', billing: 'subscription-cli' });
    expect(codex.review).toEqual({ provider: 'claude', billing: 'subscription-cli' });
    expect(codex.fix).toEqual({ provider: 'codex', billing: 'subscription-cli' });
    expect(codex.reflection).toEqual({ provider: 'codex', billing: 'subscription-cli' });
    expect(codex.validation).toEqual({ provider: 'provider-independent', billing: 'local-only' });
    expect(validateProviderPlan(phaseProviderRecordToProviderPlan(codex), custom).ok).toBe(true);
  });
});
