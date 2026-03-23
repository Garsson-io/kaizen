/**
 * stop-gate.ts — Unified stop hook entry point.
 *
 * Replaces 3 separate stop hooks (enforce-pr-review-stop, enforce-reflect-stop,
 * enforce-post-merge-stop) with a single gate that reads all pending state files
 * and produces one rich, context-aware message.
 *
 * Exit behavior (Claude Code Stop hook protocol):
 *   - stdout empty → allow stop
 *   - stdout JSON { decision: "block", reason: "..." } → block stop
 *
 * Part of kAIzen Agent Control Flow — kaizen #775
 */

import { execSync } from 'node:child_process';
import { readHookInput } from './hook-io.js';
import { readAllPendingGates } from './lib/gate-manager.js';

function getCurrentBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  // Read hook input (required by Claude Code protocol)
  await readHookInput();

  const branch = getCurrentBranch();
  if (!branch) {
    // Not in a git repo — allow stop
    return;
  }

  const report = readAllPendingGates(branch);

  if (!report.shouldBlock) {
    // No pending gates — allow stop (empty stdout)
    return;
  }

  // Block stop with rich combined message
  const output = JSON.stringify({
    decision: 'block',
    reason: report.message,
  });
  process.stdout.write(output);
}

main().catch(() => {
  // On any error, allow stop (fail-open to prevent deadlock)
});
