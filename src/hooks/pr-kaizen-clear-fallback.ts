/**
 * pr-kaizen-clear-fallback.ts — Bash fallback for PR kaizen gate clearing (TS state functions).
 *
 * PostToolUse hook on Bash — always exits 0 (state management, not blocking).
 *
 * The primary clearing hook is pr-kaizen-clear.ts (run via npx tsx). This fallback
 * is called by kaizen-pr-kaizen-clear-fallback.sh when the primary hook times out under
 * load (e.g., 5 parallel worktree agents exhausting the 10s tsx compile timeout).
 * It is invoked via `node dist/hooks/pr-kaizen-clear-fallback.js` (pre-compiled, no tsx).
 *
 * Does the minimum: detect KAIZEN_IMPEDIMENTS or KAIZEN_NO_ACTION in command output,
 * then clear any active needs_pr_kaizen gate. No validation, no audit PR comments —
 * the primary TS hook handles those when it runs successfully.
 *
 * Uses cross-branch iteration (listStateFilesAnyBranch) to match the primary hook's
 * findNewestStateWithStatusAnyBranch behaviour. See kaizen #492.
 *
 * Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
 * Migrated to TS state functions in #790 gap fix.
 */

import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readHookInput } from './hook-io.js';
import {
  DEFAULT_AUDIT_DIR,
  DEFAULT_STATE_DIR,
  listStateFilesAnyBranch,
  parseStateFile,
  serializeStateFile,
} from './state-utils.js';

function currentBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) process.exit(0);

  if (input.tool_name !== 'Bash') process.exit(0);

  const exitCode = String(input.tool_response?.exit_code ?? '0');
  if (exitCode !== '0') process.exit(0);

  const command = input.tool_input?.command ?? '';
  const stdout = input.tool_response?.stdout ?? '';

  // Only fire if the command or output contains a kaizen declaration
  if (!/KAIZEN_IMPEDIMENTS:|KAIZEN_NO_ACTION/.test(command + stdout)) {
    process.exit(0);
  }

  const stateDir = process.env.STATE_DIR ?? DEFAULT_STATE_DIR;

  // Check if there's an active kaizen gate (any branch — handles cross-worktree leak)
  const hasActive = listStateFilesAnyBranch(stateDir).some((filepath) => {
    const state = parseStateFile(readFileSync(filepath, 'utf-8'));
    return state.STATUS === 'needs_pr_kaizen';
  });

  if (!hasActive) process.exit(0);

  // The primary TS hook may have already cleared it (runs in the same PostToolUse batch).
  // Wait briefly to avoid racing.
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Re-check and mark any still-active gates as done
  let cleared = false;
  let lastPrUrl = '';

  for (const filepath of listStateFilesAnyBranch(stateDir)) {
    const content = readFileSync(filepath, 'utf-8');
    const state = parseStateFile(content);
    if (state.STATUS !== 'needs_pr_kaizen') continue;

    const updated = { ...state, STATUS: 'kaizen_done' } as Parameters<typeof serializeStateFile>[0];
    writeFileSync(filepath, serializeStateFile(updated), { mode: 0o600 });
    cleared = true;
    lastPrUrl = state.PR_URL ?? '';
  }

  if (cleared) {
    // Log that fallback fired (the primary TS hook failed/timed out)
    const auditDir = process.env.AUDIT_DIR ?? DEFAULT_AUDIT_DIR;
    try {
      mkdirSync(auditDir, { recursive: true });
      const ts = new Date().toISOString();
      appendFileSync(
        join(auditDir, 'fallback-clear.log'),
        `${ts} | FALLBACK_CLEAR | branch=${currentBranch()} | pr=${lastPrUrl} | reason=ts-hook-timeout-or-failure\n`,
      );
    } catch {
      /* ignore audit failures */
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
