/**
 * review-ci-proof.ts — CI/head proof for review PASS verdicts.
 *
 * Intent (originally #1070): a review round must NOT be recorded PASS while the
 * PR's CI for the *reviewed* HEAD is pending, failing, stale, or absent. A
 * "PASS" that was never confirmed by CI is exactly the decorative verdict
 * #1227 warns about.
 *
 * Why this module exists separately (redo per #1221/#1222/#1225):
 *   PR #1212 baked the proof into `storeReviewSummary()` in structured-data.ts.
 *   That was wrong on three axes:
 *     - it gave a pure local-storage primitive network/process side-effects
 *       (every PASS store shelled out to `gh`/`git`) — #1222.2;
 *     - it threw on non-PR targets — #1222.1;
 *     - it was a synchronous point-in-time check with no wait, so a genuine
 *       PASS recorded while CI was still `pending` threw and burned a fix
 *       round / false-exhausted the loop — #1221.
 *
 * The fix: isolate the proof behind an INJECTABLE runner (storage stays
 * side-effect-free and unit-testable), classify CI into a STRUCTURED result so
 * callers can tell `ci_pending` apart from a real fail, and provide a
 * wait-for-CI poll that treats pending as "wait", not "fail". The proof is
 * invoked at the CLI/caller boundary, not inside the storage layer.
 */

import { spawnSync } from 'node:child_process';
import { setTimeout as sleepMs } from 'node:timers/promises';

export type GhCheck = {
  name?: string;
  bucket?: string;
  state?: string;
  workflow?: string;
  link?: string;
};

export type CiProofTarget = { kind: string; number: string; repo: string };

export interface CiProofOptions {
  /**
   * The commit SHA that was reviewed. When omitted the runner's local HEAD is
   * used. Passing it explicitly lets tooling prove CI belongs to the same
   * commit it reviewed even if the local worktree has moved.
   */
  expectedHeadSha?: string;
}

/**
 * The only seam that touches the network / process. Inject a fake in tests so
 * neither the storage layer nor unit tests ever shell out to `gh`/`git`.
 */
export interface CiProofRunner {
  /** Local HEAD sha (`git rev-parse HEAD`). */
  localHead(): string;
  /** Current PR head sha (`gh pr view --json headRefOid`). */
  prHeadSha(repo: string, prNumber: string): string;
  /** PR checks (`gh pr checks --json ...`). */
  prChecks(repo: string, prNumber: string): GhCheck[];
  /** Sleep `ms` milliseconds (injectable so tests don't actually wait). */
  sleep(ms: number): Promise<void>;
  /** Monotonic-ish clock in milliseconds. */
  now(): number;
}

export type CiProofStatus =
  | 'pass'           // CI green for the reviewed head — safe to record PASS
  | 'skipped_non_pr' // target is not a PR — proof does not apply
  | 'stale_head'     // PR head moved since review — re-review required
  | 'no_checks'      // CI has not produced checks yet — keep waiting
  | 'ci_pending'     // checks exist but some are still running — keep waiting
  | 'ci_failed';     // at least one check failed/cancelled — real fail

export interface CiProofResult {
  status: CiProofStatus;
  /** True when no amount of further waiting can change the outcome. */
  terminal: boolean;
  detail?: string;
  reviewedHead?: string;
  currentHead?: string;
}

/** Suggested process exit code for a non-pass proof result at a CLI boundary. */
export const EXIT_CI_PENDING = 75; // EX_TEMPFAIL — "try again later", not a review FAIL.
export const EXIT_CI_FAILED = 1;

const PENDING_BUCKETS = new Set(['pending']);
const PASS_BUCKETS = new Set(['pass', 'skipping']);
const FAIL_BUCKETS = new Set(['fail', 'cancel']);
const PENDING_STATES = new Set([
  'IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED',
]);
const FAIL_STATES = new Set([
  'FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE',
]);

function bucketOf(check: GhCheck): 'pass' | 'fail' | 'pending' {
  const bucket = (check.bucket ?? '').toLowerCase();
  const state = (check.state ?? '').toUpperCase();
  if (FAIL_BUCKETS.has(bucket) || FAIL_STATES.has(state)) return 'fail';
  if (PENDING_BUCKETS.has(bucket) || PENDING_STATES.has(state)) return 'pending';
  if (PASS_BUCKETS.has(bucket)) return 'pass';
  // Unknown bucket with no recognised pass marker: treat conservatively as
  // pending so we wait rather than declare a premature PASS.
  return state ? 'pending' : 'pass';
}

function formatCheck(check: GhCheck): string {
  const workflow = check.workflow ? `${check.workflow} / ` : '';
  const name = check.name ?? '(unnamed check)';
  const bucket = check.bucket ?? 'unknown';
  const state = check.state ? ` (${check.state})` : '';
  return `${workflow}${name}: ${bucket}${state}`;
}

/**
 * Point-in-time classification of the PR's CI for the reviewed head.
 * Pure given the runner — no waiting, no retries.
 */
export function classifyCiProof(
  target: CiProofTarget,
  options: CiProofOptions,
  runner: CiProofRunner,
): CiProofResult {
  if (target.kind !== 'pr') {
    return { status: 'skipped_non_pr', terminal: true };
  }

  const reviewedHead = (options.expectedHeadSha ?? '').trim() || runner.localHead();
  const currentHead = runner.prHeadSha(target.repo, target.number);
  if (currentHead && reviewedHead && currentHead !== reviewedHead) {
    return {
      status: 'stale_head',
      terminal: true,
      reviewedHead,
      currentHead,
      detail:
        `PR #${target.number} head is ${currentHead} but the review covered ${reviewedHead}. ` +
        `Re-review the current head before recording a pass.`,
    };
  }

  const checks = runner.prChecks(target.repo, target.number);
  if (checks.length === 0) {
    return {
      status: 'no_checks',
      terminal: false,
      currentHead,
      detail: `CI has not produced any checks for ${currentHead || 'the reviewed head'} yet.`,
    };
  }

  const failing = checks.filter(c => bucketOf(c) === 'fail');
  if (failing.length > 0) {
    return {
      status: 'ci_failed',
      terminal: true,
      currentHead,
      detail: `CI is red for ${currentHead}: ${failing.map(formatCheck).join('; ')}`,
    };
  }

  const pending = checks.filter(c => bucketOf(c) === 'pending');
  if (pending.length > 0) {
    return {
      status: 'ci_pending',
      terminal: false,
      currentHead,
      detail: `CI is still running for ${currentHead}: ${pending.map(formatCheck).join('; ')}`,
    };
  }

  return { status: 'pass', terminal: true, currentHead };
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
}

/**
 * Poll `classifyCiProof` until it returns a terminal result or the timeout
 * elapses. On timeout the last (non-terminal) result is returned — so callers
 * see `ci_pending` / `no_checks`, never a fabricated pass or fail.
 */
export async function waitForCiProof(
  target: CiProofTarget,
  options: CiProofOptions,
  runner: CiProofRunner,
  wait: WaitOptions,
): Promise<CiProofResult> {
  const deadline = runner.now() + Math.max(0, wait.timeoutMs);
  let result = classifyCiProof(target, options, runner);
  while (!result.terminal && runner.now() < deadline) {
    await runner.sleep(Math.max(1, wait.intervalMs));
    result = classifyCiProof(target, options, runner);
  }
  return result;
}

/** Map a proof result to a CLI exit code. pass / skipped → 0. */
export function ciProofExitCode(result: CiProofResult): number {
  switch (result.status) {
    case 'pass':
    case 'skipped_non_pr':
      return 0;
    case 'ci_pending':
    case 'no_checks':
      return EXIT_CI_PENDING;
    case 'stale_head':
    case 'ci_failed':
    default:
      return EXIT_CI_FAILED;
  }
}

/** Human-readable explanation for a non-pass proof result. */
export function formatCiProofFailure(result: CiProofResult): string {
  const detail = result.detail ? ` ${result.detail}` : '';
  switch (result.status) {
    case 'ci_pending':
    case 'no_checks':
      return (
        `store-review-summary: not recording a PASS yet — CI is not terminal.${detail} ` +
        `This is NOT a review FAIL (exit ${EXIT_CI_PENDING}); wait for CI to finish, then re-run, ` +
        `or set KAIZEN_SKIP_CI_PROOF=1 to bypass (logged).`
      );
    case 'stale_head':
      return `store-review-summary: refusing to record a PASS for a stale head.${detail}`;
    case 'ci_failed':
      return `store-review-summary: refusing to record a PASS while CI is red.${detail}`;
    default:
      return `store-review-summary: CI proof failed (${result.status}).${detail}`;
  }
}

// ── Default runner (the only place that shells out) ──────────────────

function spawnText(command: string, args: string[], failureContext: string): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) {
    throw new Error(`${failureContext}: ${result.error.message}`);
  }
  const stdout = (result.stdout ?? '').trim();
  if ((result.status ?? 0) !== 0 && !stdout) {
    const stderr = (result.stderr ?? '').trim();
    throw new Error(`${failureContext}: ${stderr || `${command} exited ${result.status}`}`);
  }
  return stdout;
}

export function createDefaultCiProofRunner(): CiProofRunner {
  return {
    localHead() {
      return spawnText('git', ['rev-parse', 'HEAD'], 'ci-proof: unable to determine local HEAD');
    },
    prHeadSha(repo, prNumber) {
      return spawnText(
        'gh',
        ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'headRefOid', '--jq', '.headRefOid'],
        'ci-proof: unable to read current PR head',
      );
    },
    prChecks(repo, prNumber) {
      const stdout = spawnText(
        'gh',
        ['pr', 'checks', String(prNumber), '--repo', repo, '--json', 'name,bucket,state,workflow,link'],
        'ci-proof: unable to read PR checks',
      );
      if (!stdout) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`ci-proof: unable to parse PR checks JSON (${msg})`);
      }
      if (!Array.isArray(parsed)) {
        throw new Error('ci-proof: PR checks JSON was not an array');
      }
      return parsed as GhCheck[];
    },
    sleep(ms) {
      return sleepMs(ms);
    },
    now() {
      return Date.now();
    },
  };
}
