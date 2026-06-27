/**
 * gh-exec.ts — Shared helper for running gh CLI commands via spawnSync.
 *
 * Used by plan-store.ts, section-editor.ts, and any future module
 * that needs to call the GitHub CLI mechanistically.
 */

import { spawnSync } from 'node:child_process';

/** Run a gh CLI command and return trimmed stdout. Throws on non-zero exit. */
export function gh(args: string[], timeoutMs: number = 30_000): string {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${result.stderr?.trim()}`);
  }
  return result.stdout?.trim() ?? '';
}

/**
 * Look up the URL of the first OPEN PR whose head is `branch`.
 *
 * Single shared implementation of the "does this branch already have an open
 * PR?" question that both the auto-dent rescue path
 * (`scripts/auto-dent-rescue.ts`) and the PR review-loop fallback
 * (`src/hooks/pr-review-loop.ts`) ask. Command construction + JSON parsing live
 * here; callers keep their own policy (null vs undefined, env opt-out, whether
 * to scope by `--repo`). See #1271 — and #973/#1255 for why the two paths must
 * not drift.
 *
 * Returns `undefined` on empty result, malformed output, or any executor
 * failure — never throws.
 *
 * @param opts.repo    Scope the lookup to a specific `owner/repo` (rescue runs
 *                     against an explicit repo; the review-loop hook uses the
 *                     ambient repo and omits this).
 * @param opts.ghExec  Override the gh executor (arg array → stdout string).
 *                     Defaults to {@link gh}. Used for test injection and so the
 *                     rescue path can pass its own guarded executor.
 */
export function findOpenPrUrlForBranch(
  branch: string,
  opts: { repo?: string; ghExec?: (args: string[]) => string } = {},
): string | undefined {
  const exec = opts.ghExec ?? gh;
  const args = ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--limit', '1'];
  if (opts.repo) args.push('--repo', opts.repo);
  try {
    const out = exec(args);
    const arr = JSON.parse(out || '[]') as Array<{ url?: string }>;
    return arr[0]?.url;
  } catch {
    return undefined;
  }
}
