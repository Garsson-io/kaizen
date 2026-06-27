/**
 * CI/head proof for review summaries (#1070, redone correctly per #1221/#1222/#1225).
 *
 * Intent (#1070): a review round must NOT be stored as PASS while CI for the reviewed
 * commit is pending, red, stale, or absent — otherwise "review passed" is self-reported.
 *
 * Why this lives OUTSIDE the storage layer (#1222): `storeReviewSummary` is a deterministic
 * local-storage primitive. Baking `gh`/`git` `spawnSync` into it made every PASS store shell
 * out to the live GitHub CLI (slow, flaky, auth-dependent, untestable) and throw on non-PR
 * targets. The proof belongs at the CLI/caller boundary, behind an INJECTABLE runner, so the
 * storage layer stays pure and unit-testable. `structured-data.ts` only knows the `CiVerifier`
 * type; the concrete `gh` implementation is here.
 *
 * Why this WAITS for CI (#1221): the original gate was a synchronous point-in-time check with
 * no waiting, so a genuine PASS while CI was still `pending` THREW and false-exhausted the
 * review-fix loop. This verifier POLLS `gh pr checks` until terminal (or a timeout) and reports
 * `pending`/`no_checks` distinctly from a real `fail`, so callers can wait instead of burning a
 * fix round.
 */

import { spawnSync } from 'node:child_process';
import type { AttachmentTarget } from './section-editor.js';
import type { CiProofResult, CiVerifier } from './structured-data.js';

/** Result of running a subprocess — injectable so tests never shell out. */
export type CommandResult = { status: number | null; stdout: string; stderr: string };
export type CommandRunner = (command: string, args: string[]) => CommandResult;

/** The only real subprocess site. Everything else takes a runner. */
export const defaultRunner: CommandRunner = (command, args) => {
  const r = spawnSync(command, args, { encoding: 'utf8' });
  if (r.error) {
    return { status: 1, stdout: '', stderr: r.error.message };
  }
  return { status: r.status ?? 0, stdout: (r.stdout ?? '').toString(), stderr: (r.stderr ?? '').toString() };
};

/** A single `gh pr checks --json` row. */
export type GhCheck = {
  name?: string;
  bucket?: string;
  state?: string;
  workflow?: string;
  link?: string;
};

export type GhCiVerifierOptions = {
  /** Injectable command runner (default: real `spawnSync`). */
  runner?: CommandRunner;
  /** Poll interval while CI is pending. Default 10s. */
  pollIntervalMs?: number;
  /** Max time to wait for CI to leave the pending state. Default 5min. */
  timeoutMs?: number;
  /** Injectable sleep (default: blocking sleep). Tests pass a no-op. */
  sleep?: (ms: number) => void;
};

/**
 * Blocking sleep — keeps the verifier synchronous to match the storage call site. Uses
 * `Atomics.wait` on a throwaway buffer so it parks the thread cleanly (no busy-wait, no
 * subprocess) for the poll interval. Tests inject a no-op sleep instead.
 */
function blockingSleep(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readReviewedHead(runner: CommandRunner, expectedHeadSha: string | undefined): string {
  const explicit = expectedHeadSha?.trim();
  if (explicit) return explicit;
  const r = runner('git', ['rev-parse', 'HEAD']);
  const out = r.stdout.trim();
  if (!out) {
    throw new Error(
      'review-ci-proof: unable to determine reviewed HEAD; pass --head-sha explicitly',
    );
  }
  return out;
}

function readPrHead(runner: CommandRunner, target: AttachmentTarget): string {
  const r = runner('gh', [
    'pr', 'view', String(target.number), '--repo', target.repo,
    '--json', 'headRefOid', '--jq', '.headRefOid',
  ]);
  const out = r.stdout.trim();
  if (!out) {
    throw new Error(`review-ci-proof: unable to read current head of PR #${target.number}`);
  }
  return out;
}

function readPrChecks(runner: CommandRunner, target: AttachmentTarget): GhCheck[] {
  const r = runner('gh', [
    'pr', 'checks', String(target.number), '--repo', target.repo,
    '--json', 'name,bucket,state,workflow,link',
  ]);
  const out = r.stdout.trim();
  // `gh pr checks` exits non-zero when checks are failing OR when none exist yet; both are
  // meaningful states we handle from the JSON, so only treat an empty body as "no checks".
  if (!out) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`review-ci-proof: unable to parse PR checks JSON (${msg})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('review-ci-proof: PR checks JSON was not an array');
  }
  return parsed as GhCheck[];
}

function formatCheck(check: GhCheck): string {
  const workflow = check.workflow ? `${check.workflow} / ` : '';
  const name = check.name ?? '(unnamed check)';
  const bucket = check.bucket ?? 'unknown';
  const state = check.state ? ` (${check.state})` : '';
  return `${workflow}${name}: ${bucket}${state}`;
}

const PASS_BUCKETS = new Set(['pass', 'skipping']);
const PENDING_BUCKETS = new Set(['pending']);

/**
 * Classify a snapshot of checks into one terminal-or-waiting verdict.
 *
 * Precedence: a hard `fail`/`cancel` (or any unknown bucket — fail-closed) wins even if siblings
 * are still pending, because a failed required check will not recover. Otherwise any pending (or
 * an as-yet-unregistered/undefined bucket) keeps us waiting. Zero checks => `no_checks` (also
 * waited on, since CI often registers a few seconds after a push). All pass/skipping => `pass`.
 */
export function evaluateChecks(checks: GhCheck[]): CiProofResult {
  if (checks.length === 0) {
    return { status: 'no_checks', detail: 'no CI checks registered yet' };
  }
  const failing = checks.filter(c => {
    const bucket = c.bucket;
    // pending / undefined buckets are "not done yet", not failures.
    if (bucket === undefined || PENDING_BUCKETS.has(bucket)) return false;
    return !PASS_BUCKETS.has(bucket);
  });
  if (failing.length > 0) {
    return { status: 'fail', detail: failing.map(formatCheck).join('; ') };
  }
  const pending = checks.filter(c => c.bucket === undefined || PENDING_BUCKETS.has(c.bucket));
  if (pending.length > 0) {
    return { status: 'pending', detail: pending.map(formatCheck).join('; ') };
  }
  return { status: 'pass' };
}

/**
 * Build a CI verifier backed by `gh`/`git` (injectable for tests).
 *
 * Returns a synchronous `CiVerifier` that:
 *  - skips (never throws) on non-PR targets — review summaries on issues are legitimate (#1222.1);
 *  - reports `stale_head` when the PR head no longer matches the reviewed commit;
 *  - POLLS checks until terminal or timeout, reporting `pending`/`no_checks` distinctly from
 *    `fail` so a not-yet-green CI is a wait, not a failure (#1221).
 */
export function makeGhCiVerifier(opts: GhCiVerifierOptions = {}): CiVerifier {
  const runner = opts.runner ?? defaultRunner;
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const sleep = opts.sleep ?? blockingSleep;

  return (target, expectedHeadSha) => {
    if (target.kind !== 'pr') {
      return { status: 'skipped', detail: 'non-PR target — CI proof does not apply' };
    }

    const reviewedHead = readReviewedHead(runner, expectedHeadSha);
    const currentHead = readPrHead(runner, target);
    if (currentHead !== reviewedHead) {
      return {
        status: 'stale_head',
        detail: `reviewed ${reviewedHead}, PR #${target.number} is now ${currentHead}`,
      };
    }

    let waited = 0;
    // Poll until checks reach a terminal verdict (pass/fail) or we exhaust the wait budget.
    // `pending` and `no_checks` are retryable states that keep us in the loop.
    for (;;) {
      const verdict = evaluateChecks(readPrChecks(runner, target));
      if (verdict.status === 'pass' || verdict.status === 'fail') {
        return verdict;
      }
      if (waited >= timeoutMs) {
        return verdict; // 'pending' or 'no_checks' — terminal *for this call*, distinct from fail
      }
      sleep(pollIntervalMs);
      waited += pollIntervalMs;
    }
  };
}
