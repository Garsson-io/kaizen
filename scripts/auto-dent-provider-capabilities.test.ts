import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  AUTO_DENT_PHASES,
  PROVIDER_CAPABILITIES,
  buildProviderCapabilityMatrix,
  renderProviderCapabilityMatrix,
  validateProviderCapabilityInventory,
} from './auto-dent-provider-capabilities.js';

describe('auto-dent provider capability inventory', () => {
  it('covers every #1141 phase', () => {
    expect(AUTO_DENT_PHASES).toEqual([
      'planning',
      'implementation',
      'review',
      'fix',
      'reflection',
      'validation',
    ]);

    const matrix = buildProviderCapabilityMatrix();
    for (const phase of AUTO_DENT_PHASES) {
      expect(matrix.phases).toContain(phase);
      expect(matrix.rows.some((row) => row.phaseFit[phase] !== 'not-applicable')).toBe(true);
    }
  });

  it('represents Claude, Codex, and provider-independent capabilities', () => {
    const providers = new Set(PROVIDER_CAPABILITIES.map((cap) => cap.provider));
    expect(providers).toEqual(new Set(['claude', 'codex', 'provider-independent']));

    expect(PROVIDER_CAPABILITIES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'claude-kaizen-skills',
          provider: 'claude',
          billingMode: 'subscription-cli',
        }),
        expect.objectContaining({
          id: 'codex-structured-exec',
          provider: 'codex',
          billingMode: 'subscription-cli',
        }),
        expect.objectContaining({
          id: 'external-lifecycle-evidence',
          provider: 'provider-independent',
          billingMode: 'local-only',
        }),
      ]),
    );
  });

  it('validates schema and rejects unattended API-token-only capabilities', () => {
    expect(validateProviderCapabilityInventory(PROVIDER_CAPABILITIES)).toEqual([]);

    for (const capability of PROVIDER_CAPABILITIES) {
      expect(capability.id).toMatch(/^[a-z0-9-]+$/);
      expect(['subscription-cli', 'local-only', 'api-token']).toContain(capability.billingMode);
      if (capability.billingMode === 'api-token') {
        expect(capability.acceptedForUnattended).toBe(false);
      }
    }
  });

  it('renders a stable matrix naming every phase and provider class', () => {
    const rendered = renderProviderCapabilityMatrix(buildProviderCapabilityMatrix());
    expect(rendered).toContain('| Capability | Provider | Billing | Unattended | Planning | Implementation | Review | Fix | Reflection | Validation | Notes |');
    expect(rendered).toContain('Claude');
    expect(rendered).toContain('Codex');
    expect(rendered).toContain('Provider-independent');

    for (const phase of ['Planning', 'Implementation', 'Review', 'Fix', 'Reflection', 'Validation']) {
      expect(rendered).toContain(`| ${phase} `);
    }
  });

  it('prints the rendered matrix from the CLI entry point', () => {
    const output = execFileSync(
      'npx',
      ['tsx', 'scripts/auto-dent-provider-capabilities.ts'],
      { encoding: 'utf8' },
    );

    expect(output).toBe(renderProviderCapabilityMatrix(buildProviderCapabilityMatrix()) + '\n');
  });
});
