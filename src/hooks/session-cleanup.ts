/**
 * session-cleanup.ts — SessionStart hook: prunes stale/merged state files.
 *
 * Moved out of find_needs_review_state() hot path in kaizen #452 —
 * was adding ~400ms per PreToolUse call due to gh pr view HTTP roundtrip.
 *
 * Replaces: .claude/hooks/kaizen-session-cleanup.sh
 * Part of kAIzen Agent Control Flow — kaizen #786
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readHookInput } from './hook-io.js';
import {
  DEFAULT_STATE_DIR,
  parseStateFile,
  pruneStaleStateFiles,
} from './state-utils.js';

/**
 * Clean up state files for PRs that have been merged or closed.
 * Uses gh pr view to check PR state — only runs at session start, not hot path.
 */
export function cleanupMergedReviewStates(
  stateDir: string = DEFAULT_STATE_DIR,
): number {
  // First prune stale files by age
  pruneStaleStateFiles(stateDir);

  if (!existsSync(stateDir)) return 0;

  let cleaned = 0;
  for (const entry of readdirSync(stateDir)) {
    const filepath = join(stateDir, entry);
    try {
      const content = readFileSync(filepath, 'utf-8');
      const state = parseStateFile(content);

      if (state.STATUS !== 'needs_review') continue;
      if (!state.PR_URL) continue;

      // Check if PR is merged or closed
      const prState = execSync(
        `gh pr view "${state.PR_URL}" --json state --jq .state`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
      ).trim();

      if (prState === 'MERGED' || prState === 'CLOSED') {
        unlinkSync(filepath);
        cleaned++;
      }
    } catch {
      continue;
    }
  }
  return cleaned;
}

async function main(): Promise<void> {
  await readHookInput();
  cleanupMergedReviewStates();
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('session-cleanup.ts') ||
  process.argv[1]?.endsWith('session-cleanup.js')
) {
  main().catch(() => process.exit(0));
}
