/**
 * enforcement-coverage.ts — provider coverage inventory for kaizen gates.
 *
 * This is the machine-readable source for #1166: every registered hook command
 * must have an explicit provider story, even when that story is "Claude-only
 * gap". Human docs render the same matrix in docs/kaizen-invariants.md.
 */

export type HookSurface =
  | 'SessionStart'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'GitPrePush';

export type ProviderCoverageStatus =
  | 'provider-agnostic'
  | 'partial'
  | 'claude-only-gap'
  | 'advisory'
  | 'infrastructure';

export type ProviderFallbackClass =
  | 'git-hook'
  | 'ci-check'
  | 'inside-harness-step'
  | 'external-validator-needed'
  | 'advisory-only'
  | 'infrastructure-only'
  | 'not-needed';

export interface EnforcementCoverageRow {
  hookId: string;
  commandBasename: string;
  surface: HookSurface;
  invariants: string[];
  claudeHookDependent: boolean;
  status: ProviderCoverageStatus;
  fallbackClass: ProviderFallbackClass;
  fallbackArtifact: string;
  notes: string;
}

export const ENFORCEMENT_COVERAGE: readonly EnforcementCoverageRow[] = [
  {
    hookId: 'git-pre-push',
    commandBasename: '.githooks/pre-push',
    surface: 'GitPrePush',
    invariants: ['I7', 'I15'],
    claudeHookDependent: false,
    status: 'provider-agnostic',
    fallbackClass: 'git-hook',
    fallbackArtifact: 'src/hooks/pre-push.ts',
    notes: 'Native git hook; fires for Claude, Codex, humans, and any external agent that runs git push without --no-verify.',
  },
  {
    hookId: 'bump-plugin-version',
    commandBasename: 'kaizen-bump-plugin-version-ts.sh',
    surface: 'PreToolUse',
    invariants: [],
    claudeHookDependent: true,
    status: 'infrastructure',
    fallbackClass: 'infrastructure-only',
    fallbackArtifact: 'manual version bump / release review',
    notes: 'Repository release hygiene, not a kaizen workflow safety gate.',
  },
  {
    hookId: 'enforce-pr-review',
    commandBasename: 'kaizen-enforce-pr-review-ts.sh',
    surface: 'PreToolUse',
    invariants: ['I13', 'I15', 'I28'],
    claudeHookDependent: true,
    status: 'partial',
    fallbackClass: 'ci-check',
    fallbackArtifact: 'Review verdict gate workflow + /kaizen-autodent inside-harness review step',
    notes: 'Claude hook limits tools during review; provider-agnostic terminal binding is the stored review verdict check.',
  },
  {
    hookId: 'enforce-merge-verdict',
    commandBasename: 'kaizen-enforce-merge-verdict-ts.sh',
    surface: 'PreToolUse',
    invariants: ['I5', 'I13', 'I28'],
    claudeHookDependent: true,
    status: 'partial',
    fallbackClass: 'ci-check',
    fallbackArtifact: 'Review verdict gate workflow / branch protection',
    notes: 'Direct local gh merge is Claude-hook guarded; GitHub-side merge readiness still depends on the CI verdict check.',
  },
  {
    hookId: 'enforce-case-worktree',
    commandBasename: 'kaizen-enforce-case-worktree.sh',
    surface: 'PreToolUse',
    invariants: ['I9', 'I10', 'I26'],
    claudeHookDependent: true,
    status: 'claude-only-gap',
    fallbackClass: 'external-validator-needed',
    fallbackArtifact: '#1166 follow-up: provider-agnostic case/worktree validator',
    notes: 'Blocks main-checkout or wrong-worktree actions only when Claude Code invokes hooks.',
  },
  {
    hookId: 'pr-quality-checks',
    commandBasename: 'kaizen-pr-quality-checks-ts.sh',
    surface: 'PreToolUse',
    invariants: ['I17', 'I18', 'I19'],
    claudeHookDependent: true,
    status: 'advisory',
    fallbackClass: 'advisory-only',
    fallbackArtifact: 'review dimensions: test-quality, test-plan, security, pr-description',
    notes: 'Advisory quality checks are intentionally not terminal provider-agnostic gates.',
  },
  {
    hookId: 'check-dirty-files',
    commandBasename: 'kaizen-check-dirty-files-ts.sh',
    surface: 'PreToolUse',
    invariants: ['I11', 'I25'],
    claudeHookDependent: true,
    status: 'claude-only-gap',
    fallbackClass: 'external-validator-needed',
    fallbackArtifact: '#1166 follow-up: git/CI dirty-worktree validator for external runs',
    notes: 'Blocks dirty PR creation only under Claude Code; external agents need an explicit status/PR-body validator.',
  },
  {
    hookId: 'enforce-plan-stored',
    commandBasename: 'kaizen-enforce-plan-stored-ts.sh',
    surface: 'PreToolUse',
    invariants: ['I3', 'I8'],
    claudeHookDependent: true,
    status: 'partial',
    fallbackClass: 'inside-harness-step',
    fallbackArtifact: '/kaizen-autodent and /kaizen-do plan/test-plan evidence contract',
    notes: 'Claude hook blocks first edit; inside-harness auto-dent can require stored plan evidence for Codex/external runs.',
  },
  {
    hookId: 'enforce-pr-reflect',
    commandBasename: 'kaizen-enforce-pr-reflect-ts.sh',
    surface: 'PreToolUse',
    invariants: ['I14', 'I16'],
    claudeHookDependent: true,
    status: 'claude-only-gap',
    fallbackClass: 'external-validator-needed',
    fallbackArtifact: '#1166 follow-up: provider-agnostic reflection/completion validator',
    notes: 'Reflection gate is local-session enforcement; external runs can currently merge/stop without this hook firing.',
  },
  {
    hookId: 'block-git-rebase',
    commandBasename: 'kaizen-block-git-rebase.sh',
    surface: 'PreToolUse',
    invariants: ['I12'],
    claudeHookDependent: true,
    status: 'claude-only-gap',
    fallbackClass: 'external-validator-needed',
    fallbackArtifact: '#1166 follow-up: git-history policy check',
    notes: 'Rebase command blocking is Claude-only; provider-agnostic detection would need git-history inspection.',
  },
  {
    hookId: 'prehook-no-verify',
    commandBasename: 'kaizen-prehook-no-verify.sh',
    surface: 'PreToolUse',
    invariants: ['I7', 'I15'],
    claudeHookDependent: true,
    status: 'partial',
    fallbackClass: 'ci-check',
    fallbackArtifact: 'branch protection / required checks',
    notes: 'Claude blocks --no-verify; non-Claude pushes can bypass local git hooks, so server-side checks remain the fallback.',
  },
  {
    hookId: 'block-self-plugin-enable',
    commandBasename: 'kaizen-block-self-plugin-enable.sh',
    surface: 'PreToolUse',
    invariants: [],
    claudeHookDependent: true,
    status: 'infrastructure',
    fallbackClass: 'infrastructure-only',
    fallbackArtifact: 'scripts/kaizen-self-invariants.test.ts',
    notes: 'Self-plugin activation guard; CI invariants protect the durable source state.',
  },
  {
    hookId: 'search-before-file',
    commandBasename: 'kaizen-search-before-file.sh',
    surface: 'PreToolUse',
    invariants: ['I20'],
    claudeHookDependent: true,
    status: 'advisory',
    fallbackClass: 'advisory-only',
    fallbackArtifact: '/kaizen-file-issue duplicate-search discipline',
    notes: 'Advisory duplicate-prevention prompt; no provider-agnostic block is claimed.',
  },
  {
    hookId: 'enforce-worktree-writes',
    commandBasename: 'kaizen-enforce-worktree-writes.sh',
    surface: 'PreToolUse',
    invariants: ['I9'],
    claudeHookDependent: true,
    status: 'claude-only-gap',
    fallbackClass: 'external-validator-needed',
    fallbackArtifact: '#1166 follow-up: provider-agnostic write-location validator',
    notes: 'Edit/Write location blocking depends on Claude tool events.',
  },
  {
    hookId: 'enforce-case-exists',
    commandBasename: 'kaizen-enforce-case-exists.sh',
    surface: 'PreToolUse',
    invariants: ['I10'],
    claudeHookDependent: true,
    status: 'claude-only-gap',
    fallbackClass: 'external-validator-needed',
    fallbackArtifact: '#1166 follow-up: provider-agnostic case binding validator',
    notes: 'Edit/Write case binding is unavailable outside Claude hook invocation.',
  },
  {
    hookId: 'check-wip',
    commandBasename: 'kaizen-check-wip.sh',
    surface: 'SessionStart',
    invariants: [],
    claudeHookDependent: true,
    status: 'infrastructure',
    fallbackClass: 'infrastructure-only',
    fallbackArtifact: '/kaizen-wip',
    notes: 'Session awareness helper, not a blocking provider-agnostic safety gate.',
  },
  {
    hookId: 'session-cleanup',
    commandBasename: 'kaizen-session-cleanup-ts.sh',
    surface: 'SessionStart',
    invariants: [],
    claudeHookDependent: true,
    status: 'infrastructure',
    fallbackClass: 'infrastructure-only',
    fallbackArtifact: 'manual cleanup / kaizen-cleanup',
    notes: 'Session hygiene helper.',
  },
  {
    hookId: 'worktree-setup',
    commandBasename: 'kaizen-worktree-setup.sh',
    surface: 'SessionStart',
    invariants: ['I9', 'I10'],
    claudeHookDependent: true,
    status: 'partial',
    fallbackClass: 'inside-harness-step',
    fallbackArtifact: '/kaizen-autodent worktree binding contract',
    notes: 'Claude session setup warns/normalizes; inside-harness workflows must bind worktrees explicitly.',
  },
  {
    hookId: 'session-snapshot',
    commandBasename: 'kaizen-session-snapshot.sh',
    surface: 'SessionStart',
    invariants: [],
    claudeHookDependent: true,
    status: 'infrastructure',
    fallbackClass: 'infrastructure-only',
    fallbackArtifact: 'transcript/session artifacts',
    notes: 'Observability helper.',
  },
  {
    hookId: 'pr-review-loop',
    commandBasename: 'pr-review-loop-ts.sh',
    surface: 'PostToolUse',
    invariants: ['I5', 'I15', 'I16', 'I28'],
    claudeHookDependent: true,
    status: 'partial',
    fallbackClass: 'ci-check',
    fallbackArtifact: 'Review verdict gate workflow',
    notes: 'Claude hook manages round state after gh/pr operations; CI verdict check is the provider-agnostic terminal reader.',
  },
  {
    hookId: 'kaizen-reflect',
    commandBasename: 'kaizen-reflect-ts.sh',
    surface: 'PostToolUse',
    invariants: ['I16'],
    claudeHookDependent: true,
    status: 'claude-only-gap',
    fallbackClass: 'external-validator-needed',
    fallbackArtifact: '#1166 follow-up: post-run reflection validator',
    notes: 'Reflection prompt automation is Claude-hook only.',
  },
  {
    hookId: 'post-merge-clear',
    commandBasename: 'kaizen-post-merge-clear-ts.sh',
    surface: 'PostToolUse',
    invariants: ['I6', 'I24'],
    claudeHookDependent: true,
    status: 'partial',
    fallbackClass: 'inside-harness-step',
    fallbackArtifact: '/kaizen-autodent cleanup/status evidence',
    notes: 'Claude clears local gates after merge; external runs need explicit cleanup evidence.',
  },
  {
    hookId: 'pr-kaizen-clear',
    commandBasename: 'pr-kaizen-clear-ts.sh',
    surface: 'PostToolUse',
    invariants: ['I6', 'I16'],
    claudeHookDependent: true,
    status: 'partial',
    fallbackClass: 'inside-harness-step',
    fallbackArtifact: '/kaizen-autodent workflow status ledger',
    notes: 'Claude hook clears PR/kaizen gates; inside-harness status ledger is the external fallback contract.',
  },
  {
    hookId: 'pr-kaizen-clear-fallback',
    commandBasename: 'kaizen-pr-kaizen-clear-fallback.sh',
    surface: 'PostToolUse',
    invariants: ['I6', 'I16'],
    claudeHookDependent: true,
    status: 'partial',
    fallbackClass: 'inside-harness-step',
    fallbackArtifact: '/kaizen-autodent workflow status ledger',
    notes: 'Fallback wrapper for Claude-hook clear path.',
  },
  {
    hookId: 'capture-worktree-context',
    commandBasename: 'kaizen-capture-worktree-context.sh',
    surface: 'PostToolUse',
    invariants: ['I24'],
    claudeHookDependent: true,
    status: 'infrastructure',
    fallbackClass: 'infrastructure-only',
    fallbackArtifact: '/kaizen-cleanup and worktree-du',
    notes: 'Context capture helper for cleanup visibility.',
  },
  {
    hookId: 'stop-gate',
    commandBasename: 'kaizen-stop-gate.sh',
    surface: 'Stop',
    invariants: ['I6', 'I13', 'I14', 'I16', 'I24'],
    claudeHookDependent: true,
    status: 'partial',
    fallbackClass: 'inside-harness-step',
    fallbackArtifact: '/kaizen-autodent workflow status CLI',
    notes: 'Claude Stop gate blocks incomplete sessions; external runs need durable workflow-status evidence.',
  },
  {
    hookId: 'verify-before-stop',
    commandBasename: 'kaizen-verify-before-stop.sh',
    surface: 'Stop',
    invariants: ['I18'],
    claudeHookDependent: true,
    status: 'advisory',
    fallbackClass: 'advisory-only',
    fallbackArtifact: 'CI checks / PR verification section',
    notes: 'Advisory stop-time reminder; CI is the terminal verification mechanism.',
  },
  {
    hookId: 'check-cleanup-on-stop',
    commandBasename: 'kaizen-check-cleanup-on-stop.sh',
    surface: 'Stop',
    invariants: ['I21', 'I24'],
    claudeHookDependent: true,
    status: 'advisory',
    fallbackClass: 'advisory-only',
    fallbackArtifact: '/kaizen-cleanup',
    notes: 'Advisory cleanup reminder.',
  },
] as const;

export function coverageByCommandBasename(): Map<string, EnforcementCoverageRow> {
  return new Map(ENFORCEMENT_COVERAGE.map(row => [row.commandBasename, row]));
}
