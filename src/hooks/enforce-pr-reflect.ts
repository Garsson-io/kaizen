/**
 * enforce-pr-reflect.ts — PreToolUse gate: blocks Bash commands until kaizen reflection is done.
 *
 * TypeScript port of .claude/hooks/kaizen-enforce-pr-reflect.sh (kaizen #775).
 *
 * When a needs_pr_kaizen state file exists for the current branch, only
 * kaizen-related commands are allowed through. All others are denied.
 *
 * Part of kAIzen Agent Control Flow — kaizen #775
 */

import { execSync } from 'node:child_process';
import { readHookInput } from './hook-io.js';
import { isKaizenCommand } from './lib/allowlist.js';
import { stripHeredocBody } from './parse-command.js';
import { findStateWithStatus } from './state-utils.js';

function getCurrentBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

export function processPreToolUse(
  command: string,
  currentBranch: string,
  stateDir?: string,
): { allowed: boolean; reason?: string } {
  if (!command) return { allowed: true };

  const cmdLine = stripHeredocBody(command);

  // FAST PATH: allowed commands exit immediately
  if (isKaizenCommand(cmdLine)) {
    return { allowed: true };
  }

  // SLOW PATH: check state
  const reflectState = findStateWithStatus(
    'needs_pr_kaizen',
    currentBranch,
    stateDir,
  );
  if (!reflectState) {
    return { allowed: true };
  }

  const prUrl = reflectState.prUrl;

  return {
    allowed: false,
    reason: `BLOCKED: Kaizen reflection required — ALL findings must be addressed.

You must reflect on the development process before proceeding.
  PR: ${prUrl}

Submit your reflection:
  echo 'KAIZEN_IMPEDIMENTS: [{"impediment": "...", "disposition": "filed", "ref": "#NNN"}]'

Or defer with accountability:
  echo 'KAIZEN_UNFINISHED: <honest reason>'

Allowed commands during reflection:
  gh issue create/comment/list/search/view, gh pr diff/view/comment/edit
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
  process.argv[1]?.endsWith('enforce-pr-reflect.ts') ||
  process.argv[1]?.endsWith('enforce-pr-reflect.js')
) {
  main().catch(() => process.exit(0));
}
