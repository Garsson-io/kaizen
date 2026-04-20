/**
 * enforce-pr-review.ts — PreToolUse gate: blocks tools until PR review is done.
 *
 * @enforces I13 — During `needs_review`, only review-scoped commands run.
 *                 Canonical: docs/kaizen-invariants.md (search for "I13").
 *
 * Handles ALL tool types during review enforcement (kaizen #775, #789):
 *   - Bash: allowlist-based (review commands like gh pr diff, git diff pass through)
 *   - Edit/Write: always blocked during review (write tools, not useful for reviewing)
 *   - Agent: always allowed — review itself uses Agent to spawn dimension subagents
 *     (kaizen #895, #856). Blocking Agent blocked the review from running.
 *   - Read-only tools (Read, Glob, Grep): not registered — useful for reviewing code
 *
 * Fast path: allowed commands/tools exit immediately without checking state.
 * Slow path: blocked commands check state before denying.
 *
 * Part of kAIzen Agent Control Flow — kaizen #775, #789
 */

import { getCurrentBranch, readHookInput, traceNullInput } from './hook-io.js';
import { isReviewCommand } from './lib/allowlist.js';
import { stripHeredocBody } from './parse-command.js';
import { findStateWithStatus } from './state-utils.js';

/** Tools that are always blocked during review (no allowlist). */
const BLOCKED_TOOLS = new Set(['Edit', 'Write']);

function buildDenyMessage(toolLabel: string, prUrl: string, round: string): string {
  // Extract PR number from URL for the remediation snippet.
  const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? '<N>';
  const repoMatch = prUrl.match(/github\.com\/([^/]+\/[^/]+)/);
  const repo = repoMatch ? repoMatch[1] : '<owner/repo>';

  return `BLOCKED: ${toolLabel} is not allowed during PR review.

You have an active PR review that must be completed first:
  PR: ${prUrl} (round ${round})

Clearing this gate is a TWO-step mechanism (#1085 item 6):

  STEP 1 — read the diff and write a real summary:
    gh pr diff ${prUrl}
    # … then produce a meaningful review summary text …

  STEP 2 — store the summary, then re-run \`gh pr diff\` so the
           PostToolUse hook transitions the gate to "passed":
    npx tsx "\${CLAUDE_PLUGIN_ROOT}/src/cli-structured-data.ts" \\
      store-review-summary \\
      --pr ${prNum} --repo ${repo} --round ${round} \\
      --text "REVIEW: <your real review summary here>"
    gh pr diff ${prUrl}

The \`--text\` is the discipline. Writing "passed" there defeats the
point of the gate; the summary content is what the next reviewer reads.

For a full multi-dimension review, use \`/kaizen-review-pr ${prNum}\` —
it spawns dimension subagents and stores findings + summary for you.

Allowed commands during review:
  gh pr diff, gh pr view, gh pr comment, gh pr edit
  gh api, gh run view/list/watch
  git diff, git log, git show, git status, git branch
  npm test, npx, grep, rg (diagnostic commands)`;
}

export interface ToolContext {
  toolName?: string;
  toolInput?: { command?: string; subagent_type?: string; [key: string]: unknown };
}

export function processPreToolUse(
  command: string,
  currentBranch: string,
  stateDir?: string,
  context?: ToolContext,
): { allowed: boolean; reason?: string } {
  const toolName = context?.toolName ?? '';

  // Agent tool is always allowed — the review itself uses Agent to spawn
  // dimension subagents. Blocking it prevented review from running (kaizen #895, #856).
  if (toolName === 'Agent') {
    return { allowed: true };
  }

  // For Edit/Write: no command allowlist — go straight to state check
  if (BLOCKED_TOOLS.has(toolName)) {
    const reviewState = findStateWithStatus('needs_review', currentBranch, stateDir);
    if (!reviewState) return { allowed: true };

    const prUrl = reviewState.prUrl;
    const round = reviewState.round ?? '1';

    return {
      allowed: false,
      reason: buildDenyMessage(
        toolName || 'This tool',
        prUrl,
        round,
      ),
    };
  }

  // For Bash (or unspecified): use command allowlist
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
  const round = reviewState.round ?? '1';

  return {
    allowed: false,
    reason: buildDenyMessage('Bash', prUrl, round),
  };
}

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) { traceNullInput("enforce-pr-review"); process.exit(0); }

  const command = input.tool_input?.command ?? '';
  const branch = getCurrentBranch();

  const result = processPreToolUse(command, branch, undefined, {
    toolName: input.tool_name,
    toolInput: input.tool_input as ToolContext['toolInput'],
  });

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
