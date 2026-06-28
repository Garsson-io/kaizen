#!/usr/bin/env npx tsx
/**
 * Provider capability inventory for auto-dent.
 *
 * This is descriptive metadata only. It does not select providers or change
 * runtime behavior; later provider-aware phases can consume the same inventory.
 */

import { escapeMarkdownTableCell } from './markdown-table.js';
import {
  PHASES,
  SUBSCRIPTION_COMPATIBLE_BILLING,
  type BillingMode,
  type Phase as AutoDentPhase,
  type Provider,
  type ProviderCapability as RuntimeProviderCapability,
} from './auto-dent-provider.js';

// Descriptive capability inventory phases intentionally reuse the runtime
// provider lifecycle order; this file may add fit metadata but not a phase list.
export const AUTO_DENT_PHASES = PHASES;

// The provider union has a single definition in auto-dent-provider.ts; this
// alias keeps the `AgentProvider` name used throughout this module while
// guaranteeing the two can never drift apart (#843).
export type AgentProvider = Provider;
export type PhaseFit = 'best' | 'supported' | 'partial' | 'avoid' | 'not-applicable';

export interface ProviderCapability {
  id: string;
  label: string;
  provider: AgentProvider;
  billingMode: BillingMode;
  acceptedForUnattended: boolean;
  phaseFit: Record<AutoDentPhase, PhaseFit>;
  notes: string;
}

export interface ProviderCapabilityMatrix {
  phases: AutoDentPhase[];
  rows: ProviderCapability[];
}

const NONE: Record<AutoDentPhase, PhaseFit> = {
  planning: 'not-applicable',
  implementation: 'not-applicable',
  review: 'not-applicable',
  fix: 'not-applicable',
  reflection: 'not-applicable',
  validation: 'not-applicable',
};

function fit(overrides: Partial<Record<AutoDentPhase, PhaseFit>>): Record<AutoDentPhase, PhaseFit> {
  return { ...NONE, ...overrides };
}

/**
 * Descriptive provider capability rows for reports/operators. Runtime dispatch
 * uses scripts/auto-dent-provider.ts PROVIDER_CAPABILITIES; keep this matrix
 * aligned with validateProviderCapabilityRuntimeAlignment().
 */
export const PROVIDER_CAPABILITIES: ProviderCapability[] = [
  {
    id: 'claude-kaizen-skills',
    label: 'Claude kaizen skills',
    provider: 'claude',
    billingMode: 'subscription-cli',
    acceptedForUnattended: true,
    phaseFit: fit({
      planning: 'best',
      implementation: 'supported',
      review: 'best',
      fix: 'supported',
      reflection: 'best',
    }),
    notes: 'Current mature path for existing /kaizen-* workflows and Claude hook observability.',
  },
  {
    id: 'claude-auto-dent-runner',
    label: 'Claude auto-dent runner',
    provider: 'claude',
    billingMode: 'subscription-cli',
    acceptedForUnattended: true,
    phaseFit: fit({
      planning: 'best',
      implementation: 'best',
      review: 'supported',
      fix: 'partial',
      reflection: 'supported',
      validation: 'partial',
    }),
    notes: 'Existing batch path uses claude stream-json and max-budget-usd; validation is possible but provider-independent evidence is authoritative.',
  },
  {
    id: 'codex-structured-exec',
    label: 'Codex structured exec',
    provider: 'codex',
    billingMode: 'subscription-cli',
    acceptedForUnattended: true,
    phaseFit: fit({
      planning: 'partial',
      implementation: 'best',
      review: 'avoid',
      fix: 'partial',
      reflection: 'partial',
    }),
    notes: 'Target subscription-compatible CLI path for JSONL execution and schema-constrained summaries.',
  },
  {
    id: 'codex-review-command',
    label: 'Codex review command',
    provider: 'codex',
    billingMode: 'subscription-cli',
    acceptedForUnattended: false,
    phaseFit: fit({
      review: 'avoid',
    }),
    notes: 'Candidate review surface; must still produce structured kaizen review evidence before replacing existing dimensions.',
  },
  {
    id: 'external-lifecycle-evidence',
    label: 'External lifecycle evidence',
    provider: 'provider-independent',
    billingMode: 'local-only',
    acceptedForUnattended: true,
    phaseFit: fit({
      validation: 'best',
    }),
    notes: 'GitHub, git state, stored plans, review attachments, and lifecycle evidence judge worker claims.',
  },
  {
    id: 'git-github-safeguards',
    label: 'Git/GitHub safeguards',
    provider: 'provider-independent',
    billingMode: 'local-only',
    acceptedForUnattended: true,
    phaseFit: fit({
      validation: 'best',
    }),
    notes: 'Provider-neutral checks for branches, dirty worktrees, PR links, checks, and merge readiness.',
  },
  {
    id: 'direct-api-orchestration',
    label: 'Direct API orchestration',
    provider: 'codex',
    billingMode: 'api-token',
    acceptedForUnattended: false,
    phaseFit: fit({
      planning: 'avoid',
      implementation: 'avoid',
      review: 'avoid',
      fix: 'avoid',
      reflection: 'avoid',
      validation: 'avoid',
    }),
    notes: 'Out of scope for accepted #1134 path because it requires API-token billing rather than subscription CLI access.',
  },
];

export function buildProviderCapabilityMatrix(
  capabilities: ProviderCapability[] = PROVIDER_CAPABILITIES,
): ProviderCapabilityMatrix {
  return {
    phases: [...AUTO_DENT_PHASES],
    rows: [...capabilities].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function validateProviderCapabilityInventory(
  capabilities: ProviderCapability[] = PROVIDER_CAPABILITIES,
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const cap of capabilities) {
    if (!/^[a-z0-9-]+$/.test(cap.id)) errors.push(`${cap.id}: id must be kebab-case`);
    if (ids.has(cap.id)) errors.push(`${cap.id}: duplicate id`);
    ids.add(cap.id);
    if (cap.billingMode === 'api-token' && cap.acceptedForUnattended) {
      errors.push(`${cap.id}: api-token capabilities cannot be accepted for unattended batches`);
    }
    for (const phase of AUTO_DENT_PHASES) {
      if (!cap.phaseFit[phase]) errors.push(`${cap.id}: missing phase fit for ${phase}`);
    }
  }
  return errors;
}

export function validateProviderCapabilityRuntimeAlignment(
  capabilities: ProviderCapability[] = PROVIDER_CAPABILITIES,
  runtimeCapabilities: readonly RuntimeProviderCapability[],
): string[] {
  const errors: string[] = [];
  const describesRuntimeCapability = (runtime: RuntimeProviderCapability): boolean =>
    capabilities.some((cap) =>
      cap.provider === runtime.provider &&
      cap.billingMode === runtime.billingMode &&
      cap.acceptedForUnattended &&
      cap.phaseFit[runtime.phase] !== 'not-applicable' &&
      cap.phaseFit[runtime.phase] !== 'avoid'
    );

  for (const cap of capabilities) {
    if (!cap.acceptedForUnattended) continue;
    for (const phase of AUTO_DENT_PHASES) {
      const phaseFit = cap.phaseFit[phase];
      if (phaseFit === 'not-applicable' || phaseFit === 'avoid') continue;
      const runtime = runtimeCapabilities.find((candidate) =>
        candidate.provider === cap.provider &&
        candidate.phase === phase &&
        candidate.billingMode === cap.billingMode &&
        candidate.acceptedForUnattended &&
        SUBSCRIPTION_COMPATIBLE_BILLING.includes(candidate.billingMode)
      );
      if (!runtime) {
        errors.push(`${cap.id}: ${cap.provider}/${phase}/${cap.billingMode} is not accepted by the runtime provider inventory`);
      }
    }
  }
  for (const runtime of runtimeCapabilities) {
    if (!runtime.acceptedForUnattended || !SUBSCRIPTION_COMPATIBLE_BILLING.includes(runtime.billingMode)) continue;
    if (!describesRuntimeCapability(runtime)) {
      errors.push(`runtime ${runtime.provider}/${runtime.phase}/${runtime.billingMode} is accepted but missing from the descriptive provider matrix`);
    }
  }
  return errors;
}

export function renderProviderCapabilityMatrix(matrix: ProviderCapabilityMatrix): string {
  const lines = [
    '# Auto-dent Provider Capability Matrix',
    '',
    '| Capability | Provider | Billing | Unattended | Planning | Implementation | Review | Fix | Reflection | Validation | Notes |',
    '|---|---|---|---:|---|---|---|---|---|---|---|',
  ];

  for (const row of matrix.rows) {
    lines.push([
      row.label,
      providerLabel(row.provider),
      row.billingMode,
      row.acceptedForUnattended ? 'yes' : 'no',
      row.phaseFit.planning,
      row.phaseFit.implementation,
      row.phaseFit.review,
      row.phaseFit.fix,
      row.phaseFit.reflection,
      row.phaseFit.validation,
      row.notes,
    ].map(escapeMarkdownTableCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  return lines.join('\n');
}

function providerLabel(provider: AgentProvider): string {
  switch (provider) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'provider-independent':
      return 'Provider-independent';
  }
}

const isDirectRun = process.argv[1]?.endsWith('auto-dent-provider-capabilities.ts') ||
  process.argv[1]?.endsWith('auto-dent-provider-capabilities.js');

if (isDirectRun) {
  const errors = validateProviderCapabilityInventory();
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(renderProviderCapabilityMatrix(buildProviderCapabilityMatrix()));
}
