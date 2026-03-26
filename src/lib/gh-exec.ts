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
