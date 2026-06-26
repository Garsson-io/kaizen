/**
 * issue-binding.ts — per-worktree binding of `kaizen.issue`.
 *
 * ## The choke point this closes (#1111, harness-side half of #1106)
 *
 * `kaizen.issue` answers "which issue is THIS worktree's work for?" — an
 * inherently per-worktree fact. But git stores `git config kaizen.issue <N>` in
 * the **shared** `.git/config` unless `extensions.worktreeConfig` is enabled.
 * With it disabled, every worktree reads one global value, producing two bugs:
 *
 *   1. **Leak** — a freshly provisioned run worktree inherits the *previous*
 *      run's `kaizen.issue` (observed: a run for #1099 inherited `1106`).
 *   2. **Clobber** — two concurrent runs overwrite each other's binding.
 *
 * No shared-scope "unset on provisioning" is safe under concurrency: clearing
 * the global key would also clear a sibling worktree's legitimate binding. The
 * categorical fix is to scope the binding to the worktree, so the bad state
 * cannot exist (closer to L3 than the #1106 edit-time block).
 *
 * This module is the single write/read path for that binding. It enables
 * `extensions.worktreeConfig` on demand and writes with `--worktree`, so each
 * worktree owns an independent value. The #1106 hook cross-check remains as
 * defense-in-depth at edit time.
 *
 * ## Security posture
 *
 * Every git invocation goes through `spawnSync('git', argv)` — a fixed binary
 * with an explicit argv array, no shell, no interpolation. Matches the
 * discipline established in `src/hooks/lib/git-state.ts`.
 */

import { spawnSync } from 'node:child_process';

import { extractCaseIssueFromBranch } from './hooks/lib/case-branch.js';

/** Result of a single git invocation. `code` is the process exit code. */
export interface GitResult {
  stdout: string;
  code: number;
}

/**
 * Runs `git <args>` and returns trimmed stdout + exit code. Never throws —
 * a failed git call surfaces as a non-zero `code`, the way callers expect.
 * Injectable so tests can drive deterministic git states.
 */
export type GitRun = (args: string[]) => GitResult;

/** Default runner: no shell, explicit argv, optional working directory. */
export function makeGitRun(cwd?: string): GitRun {
  return (args: string[]): GitResult => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: (r.stdout || '').trim(), code: r.status ?? 1 };
  };
}

/** A bare positive integer issue number, or null. */
function parseIssue(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/**
 * Idempotently enable `extensions.worktreeConfig`, the prerequisite for
 * per-worktree config keys. Returns true if it flipped the setting, false if it
 * was already enabled (so callers can stay quiet on the common path).
 */
export function ensureWorktreeConfig(run: GitRun): boolean {
  const cur = run(['config', '--get', 'extensions.worktreeConfig']);
  if (cur.code === 0 && cur.stdout === 'true') return false;
  run(['config', 'extensions.worktreeConfig', 'true']);
  return true;
}

export interface BindResult {
  issue: number;
  /** Whether worktreeConfig had to be enabled as part of this bind. */
  enabledWorktreeConfig: boolean;
}

/**
 * Bind THIS worktree to `issue`, scoped to the worktree so it can never leak to
 * or clobber a sibling. Enables `extensions.worktreeConfig` first if needed.
 * Throws on a non-positive-integer issue — a bad binding is worse than none.
 */
export function bindIssue(issue: number, run: GitRun): BindResult {
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new Error(`bindIssue: invalid issue number ${JSON.stringify(issue)}`);
  }
  const enabledWorktreeConfig = ensureWorktreeConfig(run);
  run(['config', '--worktree', 'kaizen.issue', String(issue)]);
  return { issue, enabledWorktreeConfig };
}

/**
 * Merged-view read (`git config --get`): worktree-scoped value wins over shared.
 * This is what the hooks already read; after migration to per-worktree bindings
 * the merged view equals the worktree value. Returns null when unset/non-numeric.
 */
export function readBoundIssue(run: GitRun): number | null {
  const r = run(['config', '--get', 'kaizen.issue']);
  return r.code === 0 ? parseIssue(r.stdout) : null;
}

/**
 * Worktree-scoped read only (`git config --worktree --get`). Null when this
 * worktree has no binding of its own — including when worktreeConfig is off, in
 * which case `--worktree` errors and we report "no own binding".
 */
export function worktreeScopedIssue(run: GitRun): number | null {
  const r = run(['config', '--worktree', '--get', 'kaizen.issue']);
  return r.code === 0 ? parseIssue(r.stdout) : null;
}

/**
 * Shared-scope read (`git config --local --get`): the global `.git/config` value
 * that leaks across worktrees. Null when unset.
 */
export function sharedIssue(run: GitRun): number | null {
  const r = run(['config', '--local', '--get', 'kaizen.issue']);
  return r.code === 0 ? parseIssue(r.stdout) : null;
}

/**
 * Remove the shared `kaizen.issue` (migration / cleanup). Tolerant of "key not
 * found" (git exit code 5) so it is safe to call unconditionally. Returns true
 * if a value was removed.
 */
export function unsetSharedIssue(run: GitRun): boolean {
  const had = sharedIssue(run) != null;
  run(['config', '--local', '--unset', 'kaizen.issue']);
  return had;
}

export interface LeakReport {
  /** True when this worktree would read an *inherited* (shared) binding. */
  leaked: boolean;
  /** The merged value the hooks would see, or null. */
  merged: number | null;
  /** The worktree's own binding, or null when it has none. */
  worktreeScoped: number | null;
  /** Issue parsed from a canonical `case/<date>-k<N>-*` branch, or null. */
  branchToken: number | null;
}

/**
 * Detect a *leaked* binding: the worktree has no binding of its own, yet the
 * merged view returns a value inherited from shared config. We only flag it as
 * a leak when that inherited value cannot be vouched for by the branch:
 *
 *   - On a canonical case branch, a leak is when the inherited value disagrees
 *     with the branch token (a value matching the token is harmless to read).
 *   - On a non-case branch (e.g. `worktree-*`, which carries no token), any
 *     inherited value is suspect — nothing authoritative backs it.
 *
 * A worktree that owns its binding (`worktreeScoped != null`) is never a leak,
 * even if it disagrees with the branch token — that mismatch is the #1106
 * edit-time hook's domain, not a provisioning artifact.
 */
export function detectLeak(branch: string, run: GitRun): LeakReport {
  const merged = readBoundIssue(run);
  const worktreeScoped = worktreeScopedIssue(run);
  const tokenRaw = extractCaseIssueFromBranch(branch);
  const branchToken = tokenRaw ? Number(tokenRaw) : null;

  let leaked = false;
  if (merged != null && worktreeScoped == null) {
    // Value is inherited from shared config (no worktree-scoped binding).
    leaked = branchToken == null ? true : merged !== branchToken;
  }
  return { leaked, merged, worktreeScoped, branchToken };
}

/** Current branch name (`git rev-parse --abbrev-ref HEAD`), or '' on failure. */
export function currentBranch(run: GitRun): string {
  const r = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.code === 0 ? r.stdout : '';
}
