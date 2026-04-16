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
 *       → queryPrState (gh pr list)
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

import { appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { DEFAULT_STATE_DIR, ensureStateDir, prUrlToStateKey, writeStateFile } from './state-utils.js';
import { formatGateSignal, type GateSignal } from './lib/gate-signal.js';

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

/** Result of `gh pr list --state all` on a branch. */
export interface PrQueryResult {
  mostRecent: { number: number; state: 'MERGED' | 'CLOSED' | 'OPEN'; url: string } | null;
  hasOpen: boolean;
  openUrl?: string;
}

export interface PrePushOptions {
  stateDir?: string;
  traceFile?: string;
  queryPrState?: (repo: string, branch: string) => PrQueryResult;
  now?: () => number;
}

// ── Agent-env detection ───────────────────────────────────────────────

export const AGENT_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_PROJECT_DIR',
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
    return {
      action: 'allow_gate',
      reason: 'open_pr_push',
      message: null,
      gateSignal: {
        hook: 'pre-push',
        type: 'gate-set',
        gate: 'needs_review',
        pr: query.openUrl,
        round: 1,
        reason: 'Push to open PR — review round triggered',
      },
      context: { branch, prUrl: query.openUrl },
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

function git(args: string, fallback = ''): string {
  try {
    return execSync(`git ${args}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return fallback;
  }
}

export function detectRepo(): string {
  const url = git('remote get-url origin');
  return url.match(/github\.com[:/]([^/]+\/[^/.]+)/)?.[1] ?? '';
}

export function getCurrentBranch(): string {
  return git('rev-parse --abbrev-ref HEAD', '');
}

/** Default PR-state query via `gh`. Returns empty result on any failure. */
export function defaultQueryPrState(repo: string, branch: string): PrQueryResult {
  if (!repo || !branch) return { mostRecent: null, hasOpen: false };
  try {
    const out = execSync(
      `gh pr list --repo "${repo}" --head "${branch}" --state all --json number,state,url --limit 5`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    const prs = JSON.parse(out) as Array<{ number: number; state: string; url: string }>;
    if (prs.length === 0) return { mostRecent: null, hasOpen: false };

    const open = prs.find(p => p.state === 'OPEN');
    const mostRecent = prs[0]; // gh returns newest first

    return {
      mostRecent: {
        number: mostRecent.number,
        state: mostRecent.state as 'MERGED' | 'CLOSED' | 'OPEN',
        url: mostRecent.url,
      },
      hasOpen: !!open,
      openUrl: open?.url,
    };
  } catch {
    return { mostRecent: null, hasOpen: false };
  }
}

// ── Trace ─────────────────────────────────────────────────────────────

function getTraceFile(options: PrePushOptions): string {
  return options.traceFile ?? process.env.KAIZEN_HOOK_TRACE ?? '/tmp/.kaizen-hook-trace.jsonl';
}

function isTraceEnabled(): boolean {
  return process.env.KAIZEN_HOOK_TRACE !== '0';
}

export function trace(
  decision: PrePushDecision,
  envDetection: { detected: boolean; vars: string[] },
  options: PrePushOptions = {},
): void {
  if (!isTraceEnabled()) return;
  try {
    appendFileSync(
      getTraceFile(options),
      JSON.stringify({
        ts: new Date().toISOString(),
        hook: 'pre-push',
        agent_detected: envDetection.detected,
        env_vars_seen: envDetection.vars,
        action: decision.action,
        reason: decision.reason,
        ...(decision.context ?? {}),
      }) + '\n',
    );
  } catch {
    /* never fail on trace */
  }
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
  const branch = getCurrentBranch();
  const repo = detectRepo();
  const pushOptions = readPushOptions(env);

  const query = (options.queryPrState ?? defaultQueryPrState)(repo, branch);
  const decision = decide({ refs, branch, repo, pushOptions }, query);

  return { decision, envDetection };
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
