/**
 * post-merge-clear.ts — Clears post-merge gate when /kaizen is invoked or merge confirmed.
 *
 * PostToolUse hook on Bash and Skill — always exits 0 (state management, not blocking).
 *
 * Triggers:
 *   1. Skill: /kaizen or /kaizen-reflect invoked → clear all post-merge gates
 *   2. Bash: gh pr view shows MERGED → promote awaiting_merge to needs_post_merge
 *
 * Replaces: .claude/hooks/kaizen-post-merge-clear.sh
 * Part of kAIzen Agent Control Flow — kaizen #786
 */

import { execSync } from 'node:child_process';
import { getCurrentBranch, readHookInput, writeHookOutput } from './hook-io.js';
import { isGhPrCommand, stripHeredocBody } from './parse-command.js';
import {
  DEFAULT_STATE_DIR,
  clearAllStatesWithStatus,
  clearStateWithStatus,
  findStateWithStatus,
  prUrlToStateKey,
  writeStateFile,
} from './state-utils.js';

function resolveMainCheckout(): string {
  try {
    const output = execSync('git worktree list --porcelain', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const match = output.match(/^worktree (.+)/m);
    return match?.[1] ?? '.';
  } catch {
    return '.';
  }
}

export function processPostMergeClear(
  toolName: string,
  toolInput: { skill?: string; command?: string; [key: string]: unknown },
  toolResponse: { stdout?: string; exit_code?: number | string },
  currentBranch: string,
  stateDir: string = DEFAULT_STATE_DIR,
): string {
  // Trigger 1: Skill tool — /kaizen or /kaizen-reflect
  if (toolName === 'Skill') {
    const skill = toolInput.skill ?? '';
    if (skill === 'kaizen-reflect' || skill === 'kaizen') {
      const cleared = clearAllStatesWithStatus('needs_post_merge', currentBranch, stateDir);
      if (cleared > 0) {
        const mc = resolveMainCheckout();
        return `\nPost-merge gate cleared (${cleared} PR${cleared !== 1 ? 's' : ''}). The /kaizen reflection satisfies the post-merge workflow requirement.\n\nRemember to also:\n- Mark the case as done (if applicable)\n- Sync main: \`git -C ${mc} fetch origin main && git -C ${mc} merge origin/main --no-edit\`\n- Update linked kaizen issue`;
      }
    }
    return '';
  }

  // Trigger 2: Bash — gh pr view showing MERGED state
  if (toolName === 'Bash') {
    const command = toolInput.command ?? '';
    const stdout = toolResponse.stdout ?? '';
    const exitCode = String(toolResponse.exit_code ?? '0');

    if (exitCode !== '0') return '';

    const cmdLine = stripHeredocBody(command);
    if (!isGhPrCommand(cmdLine, 'view')) return '';

    // Tightened MERGED detection (kaizen #172)
    const mergedPattern = /(^MERGED$|"state"\s*:\s*"MERGED"|^"MERGED"$)/m;
    if (!mergedPattern.test(stdout)) return '';

    // Check for awaiting_merge state to promote
    const awaiting = findStateWithStatus('awaiting_merge', currentBranch, stateDir);
    if (!awaiting) return '';

    const prUrl = awaiting.prUrl;
    clearStateWithStatus('awaiting_merge', currentBranch, stateDir);

    // Write the actual post-merge state
    const postMergeKey = prUrlToStateKey(prUrl);
    writeStateFile(stateDir, `post-merge-${postMergeKey}`, {
      PR_URL: prUrl,
      STATUS: 'needs_post_merge',
      BRANCH: currentBranch,
    });

    const mc = resolveMainCheckout();
    return `\n🎉 PR merge confirmed: ${prUrl}\n\nNow complete the post-merge workflow:\n1. **Kaizen reflection (REQUIRED)** — Run \`/kaizen\` NOW to reflect on impediments and process friction\n2. **Mark case done** — if a case exists for this work\n3. **Sync main** — \`git -C ${mc} fetch origin main && git -C ${mc} merge origin/main --no-edit\`\n4. **Update linked issue** — close the kaizen/tracking issue with lessons learned\n\n⛔ You will NOT be able to finish until /kaizen is run.`;
  }

  return '';
}

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) process.exit(0);

  const toolName = input.tool_name ?? '';
  const branch = getCurrentBranch();

  const output = processPostMergeClear(
    toolName,
    input.tool_input ?? {},
    input.tool_response ?? {},
    branch,
  );

  if (output) {
    writeHookOutput(output);
  }
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('post-merge-clear.ts') ||
  process.argv[1]?.endsWith('post-merge-clear.js')
) {
  main().catch(() => process.exit(0));
}
