/**
 * pre-push.ts — Mechanistic git-hook replacement for Bash-command parsing (#1059).
 *
 * @closes #911  — mechanistic alternative to command-string parsing for review gate
 * @closes #909  — PostToolUse hook not firing on git push in worktree sessions
 * @closes #1057 — multi-line `gh pr create` commands silently missed by regex
 * @closes #1032 — deny push to branch whose most-recent PR is MERGED
 *
 * Architecture (epic #1059, Option C decision):
 *   .githooks/pre-push (shell wrapper)
 *     → agent-env gate (exit 0 for humans; shell-level shortcut)
 *     → exec npx tsx src/hooks/pre-push.ts
 *       → parseStdin (git pre-push protocol)
 *       → queryPrState (shared branch PR-state query)
 *       → decide → { allow_silent | allow_gate | deny }
 *       → writeStateFile + emit GateSignal on allow_gate
 *       → exit non-zero with recovery message on deny
 *
 * Invariants:
 *   I-A: no side effects when no agent env var set
 *   I-B: MERGED+no-newer-open → deny, regardless of preceding PR count
 *   I-C: OPEN → allow + idempotent gate-file write
 *   I-D: no PR history → silent allow
 *   I-E: trace JSONL on every invocation that passes the agent gate
 *   I-F: --force-with-lease push option → allow even on merged branch
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_STATE_DIR, ensureStateDir, prUrlToStateKey, readStateFile, writeStateFile } from './state-utils.js';
import { currentHookBranch } from './lib/current-branch.js';
import { formatGateSignal, type GateSignal } from './lib/gate-signal.js';
import { gitStdout } from './lib/git-state.js';
import { queryBranchPrState, type BranchPrQueryResult } from '../lib/github-pr.js';
import { traceHookEvent, type HookTraceOptions } from './hook-io.js';

// ── Types ─────────────────────────────────────────────────────────────

/** One line of stdin sent by git to pre-push, per `githooks(5)`. */
export interface GitPushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

/** Inputs to the decision function; all derived, no execSync. */
export interface PrePushInput {
  refs: GitPushRef[];
  branch: string;
  repo: string;
  pushOptions: string[];
  /**
   * The round number of the existing state for this branch's PR, if any.
   * When present, pre-push emits `round: existingRound + 1` in its gate signal
   * to reflect what the next review round will be. `undefined` means no state
   * yet (first gate), which is signaled as round 1.
   */
  existingRound?: number;
}

/** Outputs of the decision function (pure — no I/O). */
export type PrePushAction = 'allow_silent' | 'allow_gate' | 'deny';

export interface PrePushDecision {
  action: PrePushAction;
  reason: string;
  message: string | null;
  gateSignal?: GateSignal;
  context?: Record<string, unknown>;
}

/** Branch PR-state query result used by the pre-push decision. */
export type PrQueryResult = BranchPrQueryResult;

export interface PrePushOptions extends HookTraceOptions {
  stateDir?: string;
  queryPrState?: (repo: string, branch: string) => PrQueryResult;
  currentBranch?: string;
  now?: () => number;
}

// ── Agent-env detection ───────────────────────────────────────────────

export const AGENT_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_PROJECT_DIR',
  'CODEX_CI',
  'CODEX_SESSION',
  'KAIZEN_SESSION',
] as const;

export function detectAgentEnv(env: NodeJS.ProcessEnv): { detected: boolean; vars: string[] } {
  const vars = AGENT_ENV_VARS.filter(key => env[key] != null && env[key] !== '');
  return { detected: vars.length > 0, vars };
}

// ── Stdin parsing (git pre-push protocol) ─────────────────────────────

/**
 * Parse git's pre-push stdin.
 *
 * Per `githooks(5)`, each line has 4 space-separated fields:
 *   <local_ref> <local_sha> <remote_ref> <remote_sha>
 *
 * Empty stdin → empty array (no refs being pushed).
 */
export function parseStdin(raw: string): GitPushRef[] {
  if (!raw.trim()) return [];
  const refs: GitPushRef[] = [];
  for (const line of raw.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) continue;
    refs.push({
      localRef: parts[0],
      localSha: parts[1],
      remoteRef: parts[2],
      remoteSha: parts[3],
    });
  }
  return refs;
}

const ZERO_SHA = '0000000000000000000000000000000000000000';
const HEAD_REF_PREFIX = 'refs/heads/';

function branchNameFromRef(ref: string): string | null {
  if (!ref.startsWith(HEAD_REF_PREFIX)) return null;
  const branch = ref.slice(HEAD_REF_PREFIX.length);
  return branch.length > 0 ? branch : null;
}

/**
 * Derive the branch names whose remote refs are being updated by this push.
 *
 * Git pre-push receives the actual ref update list. That list is the authority:
 * `HEAD` can be on a different branch when an explicit refspec recreates a
 * deleted remote PR branch (#1536). Branch deletions are intentionally ignored;
 * deleting a stale merged PR branch is the cleanup path, not orphan work.
 */
export function derivePushTargetBranches(refs: GitPushRef[], currentBranch: string): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    if (ref.localSha === ZERO_SHA) continue;
    const branch = branchNameFromRef(ref.remoteRef);
    if (!branch || seen.has(branch)) continue;
    targets.push(branch);
    seen.add(branch);
  }

  if (targets.length > 0) return targets;
  const fallback = currentBranch.trim();
  return fallback ? [fallback] : [];
}

// ── Push options (GIT_PUSH_OPTION_*) ──────────────────────────────────

export function readPushOptions(env: NodeJS.ProcessEnv): string[] {
  const count = parseInt(env.GIT_PUSH_OPTION_COUNT ?? '0', 10);
  const options: string[] = [];
  for (let i = 0; i < count; i++) {
    const v = env[`GIT_PUSH_OPTION_${i}`];
    if (v) options.push(v);
  }
  return options;
}

// ── Core decision (pure) ──────────────────────────────────────────────

/**
 * Pure decision function. Takes derived inputs + query result, returns verdict.
 *
 * Decision matrix:
 *   has `kaizen-force` push option        → allow_silent (explicit override per I-F)
 *   query.mostRecent is null              → allow_silent (no PR history, I-D)
 *   query.hasOpen                          → allow_gate  (I-C, opens needs_review)
 *   query.mostRecent.state === 'MERGED'   → deny        (I-B, merged-branch block)
 *   query.mostRecent.state === 'CLOSED'   → allow_silent (closed-not-merged = fresh intent)
 *   default                                → allow_silent (defensive)
 */
export function decide(input: PrePushInput, query: PrQueryResult): PrePushDecision {
  const { branch, pushOptions } = input;

  if (pushOptions.includes('kaizen-force')) {
    return {
      action: 'allow_silent',
      reason: 'push_option_override',
      message: null,
      context: { branch, pushOptions },
    };
  }

  if (query.mostRecent == null) {
    return {
      action: 'allow_silent',
      reason: 'no_pr_history',
      message: null,
      context: { branch },
    };
  }

  if (query.hasOpen && query.openUrl) {
    // Signal the round that will be reviewed: existingRound + 1 if state
    // exists (pr-review-loop TRIGGER 2 will bump from existingRound → next),
    // or 1 if no state yet. This keeps the YAML signal informative — a
    // stale `round: 1` on later pushes was misleading.
    const nextRound = input.existingRound != null ? input.existingRound + 1 : 1;
    return {
      action: 'allow_gate',
      reason: 'open_pr_push',
      message: null,
      gateSignal: {
        hook: 'pre-push',
        type: 'gate-set',
        gate: 'needs_review',
        pr: query.openUrl,
        round: nextRound,
        reason: 'Push to open PR — review round triggered',
      },
      context: { branch, prUrl: query.openUrl, nextRound },
    };
  }

  if (query.mostRecent.state === 'MERGED') {
    const recoveryMessage = buildMergedBranchMessage(branch, query.mostRecent);
    return {
      action: 'deny',
      reason: 'merged_branch_push',
      message: recoveryMessage,
      context: { branch, mergedPr: query.mostRecent.number, mergedPrUrl: query.mostRecent.url },
    };
  }

  return {
    action: 'allow_silent',
    reason: 'closed_pr_or_unknown',
    message: null,
    context: { branch, state: query.mostRecent.state },
  };
}

function buildMergedBranchMessage(branch: string, pr: { number: number; url: string }): string {
  return [
    `kaizen: push denied — branch '${branch}' has a merged PR (${pr.url}) and no newer open PR.`,
    '',
    'Pushing new commits here will orphan them and confuse review-loop state.',
    'Recovery (per CLAUDE.md I7):',
    '  1. git checkout main && git pull --ff-only',
    `  2. git checkout -b <new-branch-name> origin/main`,
    `  3. git cherry-pick <commits-from-${branch}>`,
    '  4. git push -u origin <new-branch-name>',
    '',
    'Override (rare, for history correction only):',
    '  git push -o kaizen-force ...',
  ].join('\n');
}

// ── Wiring helpers (I/O boundary) ─────────────────────────────────────

export function detectRepo(): string {
  const url = gitStdout(['remote', 'get-url', 'origin']);
  // GitHub repo names may contain dots (owner/site.github.io, owner/foo.bar).
  // Match "owner/repo" stopping at whitespace, .git suffix, or slash.
  const match = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/|\s|$)/);
  return match?.[1] ?? '';
}

export function getCurrentBranch(): string {
  return currentHookBranch({ fallback: '' });
}

/**
 * Default PR-state query via the shared argv-based gh helper. Returns an
 * empty result on any failure.
 */
export function defaultQueryPrState(repo: string, branch: string): PrQueryResult {
  return queryBranchPrState({ repo, branch });
}

export function trace(
  decision: PrePushDecision,
  envDetection: { detected: boolean; vars: string[] },
  options: PrePushOptions = {},
): void {
  traceHookEvent('pre-push', {
    agent_detected: envDetection.detected,
    env_vars_seen: envDetection.vars,
    action: decision.action,
    reason: decision.reason,
    ...(decision.context ?? {}),
  }, options);
}

// ── Side-effecting orchestration (idempotent gate write) ──────────────

export function applyDecision(
  decision: PrePushDecision,
  branch: string,
  options: PrePushOptions = {},
): void {
  if (decision.action !== 'allow_gate') return;
  if (!decision.gateSignal?.pr) return;

  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  ensureStateDir(stateDir);
  const filename = prUrlToStateKey(decision.gateSignal.pr);
  const filepath = join(stateDir, filename);

  // Coexistence with pr-review-loop.ts PostToolUse (I-C):
  // If a gate already exists for this PR (created by TRIGGER 1 pr-create or
  // bumped by TRIGGER 2 subsequent-push), do NOT overwrite — pr-review-loop
  // handles round bumping, escalation, and auto-pass on subsequent pushes.
  // Pre-push's role is to create the initial gate mechanistically when the
  // PostToolUse path fails (#909, #1057), not to replace round logic.
  if (existsSync(filepath)) return;

  writeStateFile(stateDir, filename, {
    PR_URL: decision.gateSignal.pr,
    STATUS: 'needs_review',
    BRANCH: branch,
    ROUND: String(decision.gateSignal.round ?? 1),
  });
}

// ── Top-level process function ────────────────────────────────────────

export function processPrePush(
  rawStdin: string,
  env: NodeJS.ProcessEnv,
  options: PrePushOptions = {},
): { decision: PrePushDecision; envDetection: { detected: boolean; vars: string[] } } {
  const envDetection = detectAgentEnv(env);
  if (!envDetection.detected) {
    return {
      decision: {
        action: 'allow_silent',
        reason: 'no_agent_env',
        message: null,
        context: {},
      },
      envDetection,
    };
  }

  const refs = parseStdin(rawStdin);
  const branch = options.currentBranch ?? getCurrentBranch();
  const repo = detectRepo();
  const pushOptions = readPushOptions(env);
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const targetBranches = derivePushTargetBranches(refs, branch);

  const decisions = targetBranches.map((targetBranch) => {
    const query = (options.queryPrState ?? defaultQueryPrState)(repo, targetBranch);
    const existingRound = query.openUrl ? readExistingRound(stateDir, query.openUrl) : undefined;
    return decide({ refs, branch: targetBranch, repo, pushOptions, existingRound }, query);
  });

  const decision = decisions.find((item) => item.action === 'deny')
    ?? decisions.find((item) => item.action === 'allow_gate')
    ?? decisions[0]
    ?? {
      action: 'allow_silent',
      reason: 'no_push_targets',
      message: null,
      context: { branch },
    };

  return { decision, envDetection };
}

/**
 * Read the ROUND field from the existing state file for this PR, if any.
 * Returns undefined when no state exists (first gate → signal round 1).
 */
export function readExistingRound(stateDir: string, prUrl: string): number | undefined {
  const filepath = join(stateDir, prUrlToStateKey(prUrl));
  if (!existsSync(filepath)) return undefined;
  const state = readStateFile(filepath);
  const r = parseInt(state.ROUND ?? '', 10);
  return Number.isFinite(r) && r > 0 ? r : undefined;
}

// ── CLI entry ─────────────────────────────────────────────────────────

async function readStdinFully(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main(): Promise<void> {
  const raw = await readStdinFully();
  const { decision, envDetection } = processPrePush(raw, process.env);

  trace(decision, envDetection);

  if (!envDetection.detected) {
    process.exit(0);
  }

  const branch = getCurrentBranch();
  applyDecision(decision, branch);

  if (decision.action === 'deny') {
    if (decision.message) process.stderr.write(decision.message + '\n');
    process.exit(1);
  }

  if (decision.action === 'allow_gate' && decision.gateSignal) {
    process.stderr.write(formatGateSignal(decision.gateSignal));
  }

  process.exit(0);
}

// Run main if invoked directly (not imported for tests)
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('pre-push.ts');
if (isMain) {
  main().catch(err => {
    process.stderr.write(`kaizen pre-push: internal error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(0); // fail-open on internal errors — don't block legitimate pushes
  });
}
