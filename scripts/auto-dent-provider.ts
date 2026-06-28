/**
 * auto-dent-provider — Provider capability / billing model for auto-dent.
 *
 * Phase 1 of epic #1134 (Codex-powered auto-dent). This module is the single
 * source of truth for *provider awareness*: which agent provider can safely
 * perform each lifecycle phase, under which billing mode, and whether that
 * combination is accepted for unattended batches.
 *
 * It deliberately holds NO orchestration logic and changes NO run behavior. It
 * exposes a schema-backed runtime contract plus consumers:
 *   - #1141 renderCapabilityMatrix() — print the provider × phase × billing matrix.
 *   - #1142 validateProviderPlan()   — reject API-token-only (subscription-
 *           incompatible) provider plans with a clear reason.
 *   - #1143 defaultPhaseProviders()  — the provider/billing reality each run
 *           records today (Claude under subscription for the agent phases,
 *           provider-independent for validation), so run metrics are auditable.
 *
 * Billing constraint (epic #1134): the accepted path must work under normal
 * Claude/Codex *subscription* (CLI) usage. API-token strategies may be
 * documented but cannot be required, so they are recorded with
 * acceptedForUnattended=false and rejected by validateProviderPlan.
 */

import { z } from 'zod';

/** Agent providers auto-dent can reason about. */
export const PROVIDERS = ['claude', 'codex', 'provider-independent'] as const;
export const ProviderSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof ProviderSchema>;

/** Providers that can run the agent-facing lifecycle phases. */
export const AGENT_PROVIDERS = ['claude', 'codex'] as const;
export const AgentProviderSchema = z.enum(AGENT_PROVIDERS);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

/** Lifecycle phases where a provider choice is meaningful (epic #1134 vocabulary). */
export const PHASES = [
  'planning',
  'implementation',
  'review',
  'fix',
  'reflection',
  'validation',
] as const;
export const PhaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseSchema>;

/** How a capability is billed. Only subscription-compatible modes are accepted. */
export const BILLING_MODES = ['subscription-cli', 'local-only', 'api-token'] as const;
export const BillingModeSchema = z.enum(BILLING_MODES);
export type BillingMode = z.infer<typeof BillingModeSchema>;

/** How well a provider fits a phase. */
export const FITS = ['best', 'works', 'avoid'] as const;
export const FitSchema = z.enum(FITS);
export type Fit = z.infer<typeof FitSchema>;

/**
 * Billing modes that are compatible with the hard subscription-only constraint.
 * `api-token` is intentionally excluded — it may be documented but never required.
 */
export const SUBSCRIPTION_COMPATIBLE_BILLING: readonly BillingMode[] = [
  'subscription-cli',
  'local-only',
] as const;

/** Provider + billing recorded for a single phase of a run (#1143). */
export const PhaseProviderSchema = z.object({
  provider: ProviderSchema,
  billing: BillingModeSchema,
}).strict();
export type PhaseProvider = z.infer<typeof PhaseProviderSchema>;

/** Per-phase provider/billing record stored on run metrics (#1143). */
export const PhaseProviderRecordSchema = z.partialRecord(PhaseSchema, PhaseProviderSchema);
export type PhaseProviderRecord = z.infer<typeof PhaseProviderRecordSchema>;

/** Provider plan schema: which provider runs each phase (phases may be omitted). */
export const ProviderPlanSchema = z.partialRecord(PhaseSchema, ProviderSchema);
export type ProviderPlan = z.infer<typeof ProviderPlanSchema>;

/** One row of the capability matrix: a (provider, phase) cell with its properties. */
export const ProviderCapabilitySchema = z.object({
  provider: ProviderSchema,
  phase: PhaseSchema,
  billingMode: BillingModeSchema,
  fit: FitSchema,
  acceptedForUnattended: z.boolean(),
  rationale: z.string().min(1),
}).strict();

/** One row of the capability matrix: a (provider, phase) cell with its properties. */
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;

/**
 * Hand-authored capability inventory. Reflects today's reality plus the Codex
 * direction of epic #1134. The api-token rows are documentation of optional
 * future paths — they are NOT accepted for unattended batches, which is what
 * validateProviderPlan enforces.
 */
export const CAPABILITY_INVENTORY: readonly ProviderCapability[] = [
  // --- Claude (subscription CLI) — the proven path today ---
  { provider: 'claude', phase: 'planning', billingMode: 'subscription-cli', fit: 'best', acceptedForUnattended: true, rationale: 'Claude Code plans the kaizen lifecycle natively under subscription.' },
  { provider: 'claude', phase: 'implementation', billingMode: 'subscription-cli', fit: 'best', acceptedForUnattended: true, rationale: 'Claude Code edits in a case worktree with hook enforcement.' },
  { provider: 'claude', phase: 'review', billingMode: 'subscription-cli', fit: 'best', acceptedForUnattended: true, rationale: 'Adversarial multi-dimension review battery is Claude-driven.' },
  { provider: 'claude', phase: 'fix', billingMode: 'subscription-cli', fit: 'works', acceptedForUnattended: true, rationale: 'Review-fix loop runs under subscription; Codex is often faster here.' },
  { provider: 'claude', phase: 'reflection', billingMode: 'subscription-cli', fit: 'best', acceptedForUnattended: true, rationale: 'Reflection/contemplation modes are Claude-native.' },
  { provider: 'claude', phase: 'validation', billingMode: 'subscription-cli', fit: 'works', acceptedForUnattended: true, rationale: 'Claude can validate, but provider-independent checks are authoritative.' },

  // --- Codex (subscription CLI) — the epic #1134 target ---
  { provider: 'codex', phase: 'planning', billingMode: 'subscription-cli', fit: 'works', acceptedForUnattended: true, rationale: 'Codex can plan via `codex exec` under subscription; Claude usually richer.' },
  { provider: 'codex', phase: 'implementation', billingMode: 'subscription-cli', fit: 'best', acceptedForUnattended: true, rationale: 'Codex is strong at focused code generation via the CLI.' },
  { provider: 'codex', phase: 'review', billingMode: 'subscription-cli', fit: 'works', acceptedForUnattended: true, rationale: 'Codex can review but lacks the structured kaizen review battery.' },
  { provider: 'codex', phase: 'fix', billingMode: 'subscription-cli', fit: 'best', acceptedForUnattended: true, rationale: 'Tight edit/fix iterations suit Codex exec well.' },
  { provider: 'codex', phase: 'reflection', billingMode: 'subscription-cli', fit: 'works', acceptedForUnattended: true, rationale: 'Codex can reflect but kaizen reflection is Claude-tuned.' },

  // --- Provider-independent — git/GitHub facts need no agent at all ---
  { provider: 'provider-independent', phase: 'validation', billingMode: 'local-only', fit: 'best', acceptedForUnattended: true, rationale: 'Plan/PR/test/review evidence is read from git+GitHub, not self-report.' },

  // --- API-token paths: documented, optional, NOT accepted (subscription constraint) ---
  { provider: 'claude', phase: 'review', billingMode: 'api-token', fit: 'avoid', acceptedForUnattended: false, rationale: 'API-token review works but violates the subscription-only constraint.' },
  { provider: 'codex', phase: 'implementation', billingMode: 'api-token', fit: 'avoid', acceptedForUnattended: false, rationale: 'API-token implementation is an optional future path, not required.' },
];

/** A single reason a provider plan was rejected. */
export interface PlanViolation {
  phase: Phase;
  provider: Provider;
  reason: string;
}

/** Result of validating a provider plan against the capability inventory. */
export interface PlanValidation {
  ok: boolean;
  violations: PlanViolation[];
}

/**
 * Is this (phase, provider) runnable under the subscription-only constraint?
 * True iff the inventory has an accepted capability for it with a
 * subscription-compatible billing mode.
 */
function hasSubscriptionCompatibleCapability(
  phase: Phase,
  provider: Provider,
  inventory: readonly ProviderCapability[],
): boolean {
  return inventory.some(
    (c) =>
      c.phase === phase &&
      c.provider === provider &&
      c.acceptedForUnattended &&
      SUBSCRIPTION_COMPATIBLE_BILLING.includes(c.billingMode),
  );
}

/**
 * #1142 — Reject provider plans that would require API-token billing.
 *
 * For every phase assigned in the plan, the chosen provider must have an
 * accepted, subscription-compatible capability. If a provider can only perform
 * a phase via `api-token` (or has no accepted capability for it at all), the
 * plan is rejected with a clear, human-readable reason. Subscription plans pass.
 */
export function validateProviderPlan(
  plan: ProviderPlan,
  inventory: readonly ProviderCapability[] = CAPABILITY_INVENTORY,
): PlanValidation {
  const violations: PlanViolation[] = [];

  for (const phase of PHASES) {
    const provider = plan[phase];
    if (!provider) continue; // phase not assigned — nothing to validate

    if (hasSubscriptionCompatibleCapability(phase, provider, inventory)) continue;

    // Distinguish "only api-token exists" from "no capability at all" for a clearer reason.
    const apiTokenOnly = inventory.some(
      (c) => c.phase === phase && c.provider === provider && c.billingMode === 'api-token',
    );
    const reason = apiTokenOnly
      ? `phase "${phase}" with provider "${provider}" requires api-token billing, which is not subscription-compatible`
      : `phase "${phase}" has no accepted subscription-compatible capability for provider "${provider}"`;

    violations.push({ phase, provider, reason });
  }

  return { ok: violations.length === 0, violations };
}

export function parsePhaseProviderRecord(input: unknown): PhaseProviderRecord {
  return PhaseProviderRecordSchema.parse(input);
}

export function safeParsePhaseProviderRecord(input: unknown): PhaseProviderRecord | null {
  const parsed = PhaseProviderRecordSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function phaseProviderRecordToProviderPlan(record: PhaseProviderRecord): ProviderPlan {
  const plan: ProviderPlan = {};
  for (const phase of PHASES) {
    const provider = record[phase]?.provider;
    if (provider) plan[phase] = provider;
  }
  return plan;
}

export function orderedPhaseProviderEntries(record: PhaseProviderRecord): Array<[Phase, PhaseProvider]> {
  return PHASES.flatMap((phase) => {
    const provider = record[phase];
    return provider ? [[phase, provider] as [Phase, PhaseProvider]] : [];
  });
}

export function phaseProvider(provider: Provider, billing: BillingMode): PhaseProvider {
  return PhaseProviderSchema.parse({ provider, billing });
}

/**
 * #1143 — The provider/billing reality of an auto-dent run today.
 *
 * Claude under subscription performs planning/implementation/review/fix/reflection;
 * validation is provider-independent (git/GitHub facts). Recording this makes every
 * run auditable for provider usage and billing mode without changing behavior.
 */
export function defaultPhaseProviders(): PhaseProviderRecord {
  const claude = phaseProvider('claude', 'subscription-cli');
  return parsePhaseProviderRecord({
    planning: claude,
    implementation: claude,
    review: claude,
    fix: claude,
    reflection: claude,
    validation: phaseProvider('provider-independent', 'local-only'),
  });
}

export function phaseProvidersForAgentProvider(provider: AgentProvider): PhaseProviderRecord {
  if (provider !== 'codex') return defaultPhaseProviders();
  const codex = phaseProvider('codex', 'subscription-cli');
  return parsePhaseProviderRecord({
    planning: codex,
    implementation: codex,
    review: phaseProvider('claude', 'subscription-cli'),
    fix: codex,
    reflection: codex,
    validation: phaseProvider('provider-independent', 'local-only'),
  });
}

/**
 * #1141 — Render the capability matrix as deterministic text. Every phase is
 * named (one section per phase), so a snapshot/string test can assert coverage.
 */
export function renderCapabilityMatrix(
  inventory: readonly ProviderCapability[] = CAPABILITY_INVENTORY,
): string {
  const lines: string[] = [];
  lines.push('Auto-dent provider capability matrix');
  lines.push('(fit | billing | accepted-for-unattended)');
  lines.push('');

  for (const phase of PHASES) {
    lines.push(`## ${phase}`);
    const rows = inventory.filter((c) => c.phase === phase);
    if (rows.length === 0) {
      lines.push('  (no capabilities recorded)');
      lines.push('');
      continue;
    }
    for (const c of rows) {
      const accepted = c.acceptedForUnattended ? 'accepted' : 'NOT-accepted';
      lines.push(`  - ${c.provider}: ${c.fit} | ${c.billingMode} | ${accepted} — ${c.rationale}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

// CLI entry point: `npx tsx scripts/auto-dent-provider.ts matrix [--json]`
if (
  process.argv[1]?.endsWith('auto-dent-provider.ts') ||
  process.argv[1]?.endsWith('auto-dent-provider.js')
) {
  const cmd = process.argv[2] ?? 'matrix';
  if (cmd === 'matrix') {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(CAPABILITY_INVENTORY, null, 2));
    } else {
      console.log(renderCapabilityMatrix());
    }
  } else {
    console.error(`Unknown command: ${cmd}\nUsage: npx tsx scripts/auto-dent-provider.ts matrix [--json]`);
    process.exit(1);
  }
}
