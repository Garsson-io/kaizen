/**
 * enforce-pr-review.ts — PreToolUse gate: blocks Bash commands until PR review is done.
 *
 * TypeScript port of .claude/hooks/kaizen-enforce-pr-review.sh (kaizen #775).
 *
 * When a needs_review state file exists for the current branch, only review-related
 * commands are allowed through. All others are denied.
 *
 * Fast path: allowed commands exit immediately without checking state.
 * Slow path: blocked commands check state before denying.
 *
 * Part of kAIzen Agent Control Flow — kaizen #775
 */

import { getCurrentBranch, readHookInput } from './hook-io.js';
import { isReviewCommand } from './lib/allowlist.js';
import { stripHeredocBody } from './parse-command.js';
import { findStateWithStatus } from './state-utils.js';

export function processPreToolUse(
  command: string,
  currentBranch: string,
  stateDir?: string,
): { allowed: boolean; reason?: string } {
  if (!command) return { allowed: true };

  const cmdLine = stripHeredocBody(command);

  // FAST PATH: allowed commands exit immediately
  if (isReviewCommand(cmdLine)) {
    return { allowed: true };
  }

  // SLOW PATH: check state
  const reviewState = findStateWithStatus(
    'needs_review',
    currentBranch,
    stateDir,
  );
  if (!reviewState) {
    return { allowed: true };
  }

  const prUrl = reviewState.prUrl;
  const round = '1'; // Round info is in the state file content

  return {
    allowed: false,
    reason: `BLOCKED: PR review required before proceeding.

You have an active PR review that must be completed first:
  PR: ${prUrl} (round ${round})

Run \`gh pr diff ${prUrl}\` to review the diff, then work through the
self-review checklist. Only after reviewing can you proceed with other work.

Allowed commands during review:
  gh pr diff, gh pr view, gh pr comment, gh pr edit
  gh api, gh run view/list/watch
  git diff, git log, git show, git status, git branch
  npm test, npx, grep, rg (diagnostic commands)`,
  };
}

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) process.exit(0);

  const command = input.tool_input?.command ?? '';
  const branch = getCurrentBranch();

  const result = processPreToolUse(command, branch);

  if (!result.allowed) {
    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: result.reason,
      },
    });
    process.stdout.write(output);
  }
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('enforce-pr-review.ts') ||
  process.argv[1]?.endsWith('enforce-pr-review.js')
) {
  main().catch(() => process.exit(0));
}
