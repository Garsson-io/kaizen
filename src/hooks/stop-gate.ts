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

import { getCurrentBranch, readHookInput } from './hook-io.js';
import { readAllPendingGates, scanStateDirectoryDiagnostics } from './lib/gate-manager.js';
import { emitSessionEvent } from './session-telemetry.js';

async function main(): Promise<void> {
  // Read hook input (required by Claude Code protocol)
  await readHookInput();

  const branch = getCurrentBranch();
  if (!branch) {
    // Not in a git repo — allow stop
    return;
  }

  const report = readAllPendingGates(branch);

  // Emit telemetry for cross-session debugging (kaizen #792)
  try {
    const diagnostics = scanStateDirectoryDiagnostics(branch);
    emitSessionEvent({
      type: 'session.stop_gate',
      branch,
      decision: report.shouldBlock ? 'block' : 'allow',
      gates_count: report.gates.length,
      gate_types: report.gates.map((g) => g.type),
      total_state_files: diagnostics.totalFiles,
      included_files: diagnostics.includedFiles,
      excluded_files: diagnostics.excludedFiles,
      exclude_reasons: diagnostics.excludeReasons,
    });
  } catch {
    // Telemetry is best-effort — never break the gate
  }

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
