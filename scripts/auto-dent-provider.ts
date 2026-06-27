/**
 * auto-dent-provider — Provider capability / billing model for auto-dent.
 *
 * Phase 1 of epic #1134 (Codex-powered auto-dent). This module is the single
 * source of truth for *provider awareness*: which agent provider can safely
 * perform each lifecycle phase, under which billing mode, and whether that
 * combination is accepted for unattended batches.
 *
 * It deliberately holds NO orchestration logic and changes NO run behavior. It
 * exposes a typed inventory plus two consumers:
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

/** Agent providers auto-dent can reason about. */
export type Provider = 'claude' | 'codex' | 'provider-independent';

/** Lifecycle phases where a provider choice is meaningful (epic #1134 vocabulary). */
export type Phase =
  | 'planning'
  | 'implementation'
  | 'review'
  | 'fix'
  | 'reflection'
  | 'validation';

/** How a capability is billed. Only subscription-compatible modes are accepted. */
export type BillingMode = 'subscription-cli' | 'local-only' | 'api-token';

/** How well a provider fits a phase. */
export type Fit = 'best' | 'works' | 'avoid';

/** Canonical phase order — drives matrix layout and ensures every phase is named. */
export const PHASES: readonly Phase[] = [
  'planning',
  'implementation',
  'review',
  'fix',
  'reflection',
  'validation',
] as const;

/** Providers in canonical display order. */
export const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'provider-independent'] as const;

/**
 * Billing modes that are compatible with the hard subscription-only constraint.
 * `api-token` is intentionally excluded — it may be documented but never required.
 */
export const SUBSCRIPTION_COMPATIBLE_BILLING: readonly BillingMode[] = [
  'subscription-cli',
  'local-only',
] as const;

/** One row of the capability matrix: a (provider, phase) cell with its properties. */
export interface ProviderCapability {
  provider: Provider;
  phase: Phase;
  billingMode: BillingMode;
  fit: Fit;
  /** Whether this capability is accepted for unattended auto-dent batches. */
  acceptedForUnattended: boolean;
  /** One-line human rationale for the fit/accepted decision. */
  rationale: string;
}

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

/** A provider plan: which provider runs each phase (phases may be omitted). */
export type ProviderPlan = Partial<Record<Phase, Provider>>;

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

/** Provider + billing recorded for a single phase of a run (#1143). */
export interface PhaseProvider {
  provider: Provider;
  billing: BillingMode;
}

/** Per-phase provider/billing record stored on run metrics (#1143). */
export type PhaseProviderRecord = Partial<Record<Phase, PhaseProvider>>;

/**
 * #1143 — The provider/billing reality of an auto-dent run today.
 *
 * Claude under subscription performs planning/implementation/review/fix/reflection;
 * validation is provider-independent (git/GitHub facts). Recording this makes every
 * run auditable for provider usage and billing mode without changing behavior.
 */
export function defaultPhaseProviders(): PhaseProviderRecord {
  const claude: PhaseProvider = { provider: 'claude', billing: 'subscription-cli' };
  return {
    planning: claude,
    implementation: claude,
    review: claude,
    fix: claude,
    reflection: claude,
    validation: { provider: 'provider-independent', billing: 'local-only' },
  };
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
