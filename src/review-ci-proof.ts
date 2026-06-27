/**
 * CI-proof verifier for review summaries (#1070, redone per #1225/#1221/#1222).
 *
 * A PASS / PASS-with-partials review summary may only be stored once CI is green
 * for the exact commit that was reviewed. This module owns that proof. It lives
 * OUTSIDE the storage layer (`structured-data.ts`) so storage stays a pure,
 * side-effect-free primitive (#1222): the gate is applied at the CLI/caller
 * boundary instead.
 *
 * Design:
 *  - `evaluateCiProof` is a PURE function of an injected `CommandRunner` — it
 *    never throws for control flow, returning a structured discriminated union
 *    so callers can branch on `pending` (wait) vs `fail`/`stale` (refuse).
 *  - `waitForCiProof` polls `evaluateCiProof` while the result is `pending`,
 *    with an injectable clock + sleep, so "CI not done yet" is a *wait*, not a
 *    *false review FAIL* (#1221).
 *  - Non-PR targets are `skipped`, never thrown on (#1222.1).
 */

import { spawnSync } from 'node:child_process';
import type { AttachmentTarget } from './section-editor.js';

/** Result of a single command invocation. */
export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Injectable command runner — real impl shells out; tests pass a fake. */
export type CommandRunner = (command: string, args: string[]) => CommandResult;

/** The reviewed commit + the PR it belongs to. */
export interface CiProofOptions {
  /**
   * The commit SHA that was reviewed. If omitted, the current local HEAD is
   * resolved via `git rev-parse HEAD`. Passing it explicitly lets review tooling
   * prove CI belongs to the same commit it reviewed even if the worktree moved.
   */
  expectedHeadSha?: string;
}

export type CiProofStatus =
  | 'pass'       // CI green for the reviewed head — safe to store PASS
  | 'pending'    // CI still running for the reviewed head — wait, do not fail
  | 'fail'       // a check is failing/cancelled for the reviewed head
  | 'stale'      // current PR head no longer matches the reviewed head
  | 'no_checks'  // CI has produced no checks for the reviewed head yet
  | 'skipped';   // proof not applicable (non-PR target / explicitly skipped)

export interface CiProofResult {
  status: CiProofStatus;
  /** Human-readable explanation, suitable for stderr. */
  detail: string;
  /** The reviewed head SHA, when it could be resolved. */
  reviewedHead?: string;
  /** The PR's current head SHA, when it could be read. */
  currentHead?: string;
}

type GhCheck = {
  name?: string;
  bucket?: string;
  state?: string;
  workflow?: string;
  link?: string;
};

/** Default runner — real `gh`/`git` via spawnSync. */
export const defaultCommandRunner: CommandRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) {
    return { status: 1, stdout: '', stderr: result.error.message };
  }
  return {
    status: result.status ?? 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
};

function formatCheck(check: GhCheck): string {
  const workflow = check.workflow ? `${check.workflow} / ` : '';
  const name = check.name ?? '(unnamed check)';
  const bucket = check.bucket ?? 'unknown';
  const state = check.state ? ` (${check.state})` : '';
  return `${workflow}${name}: ${bucket}${state}`;
}

function resolveReviewedHead(options: CiProofOptions, runner: CommandRunner): { sha?: string; error?: string } {
  const explicit = options.expectedHeadSha?.trim();
  if (explicit) return { sha: explicit };
  const res = runner('git', ['rev-parse', 'HEAD']);
  if (res.status !== 0 || !res.stdout) {
    return { error: res.stderr || 'git rev-parse HEAD failed; pass --head-sha explicitly' };
  }
  return { sha: res.stdout };
}

function readPrHead(target: AttachmentTarget, runner: CommandRunner): { sha?: string; error?: string } {
  const res = runner('gh', ['pr', 'view', target.number, '--repo', target.repo, '--json', 'headRefOid', '--jq', '.headRefOid']);
  if (res.status !== 0 || !res.stdout) {
    return { error: res.stderr || `gh pr view #${target.number} failed` };
  }
  return { sha: res.stdout };
}

function readPrChecks(target: AttachmentTarget, runner: CommandRunner): { checks?: GhCheck[]; error?: string } {
  const res = runner('gh', ['pr', 'checks', target.number, '--repo', target.repo, '--json', 'name,bucket,state,workflow,link']);
  // `gh pr checks` exits non-zero when checks are pending OR failing; the JSON
  // payload is still emitted, so prefer parsing stdout over trusting the code.
  if (!res.stdout) {
    // No checks have been created yet (gh prints nothing) — treat as no_checks,
    // not an error, unless stderr signals a real failure.
    if (res.stderr && !/no checks/i.test(res.stderr)) {
      return { error: res.stderr };
    }
    return { checks: [] };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    if (!Array.isArray(parsed)) return { error: 'gh pr checks JSON was not an array' };
    return { checks: parsed as GhCheck[] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `unable to parse PR checks JSON (${msg})` };
  }
}

/**
 * Evaluate CI proof for a review summary. Pure given `runner`; never throws for
 * control flow. Callers branch on `status`.
 */
export function evaluateCiProof(
  target: AttachmentTarget,
  options: CiProofOptions = {},
  runner: CommandRunner = defaultCommandRunner,
): CiProofResult {
  if (target.kind !== 'pr') {
    return { status: 'skipped', detail: `CI proof skipped: target is a ${target.kind}, not a PR.` };
  }

  const reviewed = resolveReviewedHead(options, runner);
  if (!reviewed.sha) {
    // Can't establish what we reviewed → cannot prove staleness; treat as
    // pending so the caller waits/retries rather than recording a false PASS.
    return { status: 'pending', detail: `CI proof undetermined: ${reviewed.error}` };
  }

  const current = readPrHead(target, runner);
  if (!current.sha) {
    return { status: 'pending', detail: `CI proof undetermined: ${current.error}`, reviewedHead: reviewed.sha };
  }

  if (current.sha !== reviewed.sha) {
    return {
      status: 'stale',
      detail:
        `Reviewed ${reviewed.sha}, but PR #${target.number} is currently ${current.sha}. ` +
        `Re-review the current head before storing a pass summary.`,
      reviewedHead: reviewed.sha,
      currentHead: current.sha,
    };
  }

  const checksRes = readPrChecks(target, runner);
  if (checksRes.error) {
    return { status: 'pending', detail: `CI proof undetermined: ${checksRes.error}`, reviewedHead: reviewed.sha, currentHead: current.sha };
  }
  const checks = checksRes.checks ?? [];
  if (checks.length === 0) {
    return {
      status: 'no_checks',
      detail: `CI has not produced any checks for ${current.sha} yet.`,
      reviewedHead: reviewed.sha,
      currentHead: current.sha,
    };
  }

  const failing = checks.filter(c => c.bucket === 'fail' || c.bucket === 'cancel');
  if (failing.length > 0) {
    return {
      status: 'fail',
      detail: `CI is not green for ${current.sha}: ${failing.map(formatCheck).join('; ')}`,
      reviewedHead: reviewed.sha,
      currentHead: current.sha,
    };
  }

  const unfinished = checks.filter(c => c.bucket !== 'pass' && c.bucket !== 'skipping');
  if (unfinished.length > 0) {
    return {
      status: 'pending',
      detail: `CI still running for ${current.sha}: ${unfinished.map(formatCheck).join('; ')}`,
      reviewedHead: reviewed.sha,
      currentHead: current.sha,
    };
  }

  return { status: 'pass', detail: `CI green for ${current.sha}.`, reviewedHead: reviewed.sha, currentHead: current.sha };
}

const TERMINAL: ReadonlySet<CiProofStatus> = new Set(['pass', 'fail', 'stale', 'skipped']);

export interface WaitForCiOptions extends CiProofOptions {
  runner?: CommandRunner;
  /** Total budget before giving up on a pending CI. Default 600_000ms (10m). */
  timeoutMs?: number;
  /** Delay between polls. Default 15_000ms. */
  intervalMs?: number;
  /** Injectable sleep (tests pass a no-op or fake). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (tests advance it). Default Date.now via a closure. */
  now?: () => number;
  /** Called once per poll with the interim result (for progress logging). */
  onPoll?: (result: CiProofResult, elapsedMs: number) => void;
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Poll `evaluateCiProof` while the status is `pending` (or transient `no_checks`)
 * until it reaches a terminal status or the timeout elapses. A timeout returns
 * the last `pending`/`no_checks` result unchanged — it is NOT promoted to `fail`,
 * so callers can distinguish "CI not done" from "CI red" (#1221).
 */
export async function waitForCiProof(
  target: AttachmentTarget,
  options: WaitForCiOptions = {},
): Promise<CiProofResult> {
  const runner = options.runner ?? defaultCommandRunner;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const intervalMs = options.intervalMs ?? 15_000;
  const sleep = options.sleep ?? realSleep;
  // Default clock: capture a monotonic-ish baseline. Date.now is unavailable in
  // some sandboxes; fall back to a counter driven by elapsed sleeps.
  let fallbackClock = 0;
  const now = options.now ?? (() => {
    try {
      return Date.now();
    } catch {
      return fallbackClock;
    }
  });

  const start = now();
  let last: CiProofResult = evaluateCiProof(target, options, runner);
  options.onPoll?.(last, 0);
  while (!TERMINAL.has(last.status) && now() - start < timeoutMs) {
    await sleep(intervalMs);
    fallbackClock += intervalMs;
    last = evaluateCiProof(target, options, runner);
    options.onPoll?.(last, now() - start);
  }
  return last;
}
