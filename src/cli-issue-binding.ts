/**
 * cli-issue-binding.ts — CLI for per-worktree `kaizen.issue` binding (#1111).
 *
 * Use this instead of raw `git config kaizen.issue <N>`, which silently writes
 * to the SHARED `.git/config` and leaks across worktrees. This command writes
 * with `--worktree` scope so each worktree owns an independent binding.
 *
 * Commands:
 *   bind --issue <N>          Bind this worktree to issue N (worktree-scoped).
 *   auto-bind                 Self-heal: bind from the canonical case-branch token (#1113).
 *   read                      Print the merged binding the hooks would see.
 *   check-leak                Detect an inherited (leaked) binding; exit 1 if leaked.
 *   ensure-worktree-config    Enable extensions.worktreeConfig (idempotent).
 *   unset-shared              Remove the shared kaizen.issue (migration/cleanup).
 *
 * Usage: npx tsx src/cli-issue-binding.ts <command> [args]
 */

import {
  makeGitRun,
  bindIssue,
  readBoundIssue,
  detectLeak,
  ensureWorktreeConfig,
  unsetSharedIssue,
  currentBranch,
  selfHealBinding,
} from './issue-binding.js';

export function parseArgs(argv: string[]): void {
  const args = argv.slice(2);
  const command = args[0];
  const run = makeGitRun();

  switch (command) {
    case 'bind': {
      let issue = 0;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--issue' && args[i + 1]) issue = parseInt(args[++i], 10);
      }
      if (!Number.isInteger(issue) || issue <= 0) {
        console.error('Error: --issue <N> (positive integer) is required');
        process.exit(1);
      }
      const r = bindIssue(issue, run);
      console.log(
        `Bound this worktree to #${r.issue} (worktree-scoped).` +
          (r.enabledWorktreeConfig ? ' Enabled extensions.worktreeConfig.' : ''),
      );
      break;
    }
    case 'auto-bind': {
      const branch = currentBranch(run);
      const r = selfHealBinding(branch, run);
      if (r.healed) {
        console.log(
          `Auto-bound this worktree to #${r.issue} from its case branch (${branch}).` +
            (r.enabledWorktreeConfig ? ' Enabled extensions.worktreeConfig.' : ''),
        );
      } else if (r.reason === 'already-bound') {
        console.log(`Already bound to #${r.issue} (worktree-scoped) — nothing to do.`);
      } else {
        console.log(
          `No case-branch token on '${branch || '(detached)'}' — cannot auto-derive an issue. ` +
            `Bind explicitly: bind --issue <N>.`,
        );
      }
      break;
    }
    case 'read': {
      const n = readBoundIssue(run);
      console.log(n == null ? '' : String(n));
      break;
    }
    case 'check-leak': {
      const report = detectLeak(currentBranch(run), run);
      if (report.leaked) {
        console.error(
          `LEAKED kaizen.issue — this worktree would read inherited #${report.merged} ` +
            `from shared config with no binding of its own` +
            (report.branchToken ? ` (branch is for #${report.branchToken})` : '') +
            `.\nFix: npx tsx src/cli-issue-binding.ts bind --issue <this worktree's issue>`,
        );
        process.exit(1);
      }
      console.log(
        report.merged == null
          ? 'No kaizen.issue bound.'
          : `OK — bound to #${report.merged}${report.worktreeScoped != null ? ' (worktree-scoped)' : ''}.`,
      );
      break;
    }
    case 'ensure-worktree-config': {
      const changed = ensureWorktreeConfig(run);
      console.log(changed ? 'Enabled extensions.worktreeConfig.' : 'extensions.worktreeConfig already enabled.');
      break;
    }
    case 'unset-shared': {
      const removed = unsetSharedIssue(run);
      console.log(removed ? 'Removed shared kaizen.issue.' : 'No shared kaizen.issue to remove.');
      break;
    }
    default: {
      console.error(`Unknown command: ${command ?? '(none)'}`);
      console.error(
        'Commands: bind --issue <N> | auto-bind | read | check-leak | ensure-worktree-config | unset-shared',
      );
      process.exit(1);
    }
  }
}

// Only run when executed directly (not when imported by tests)
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('cli-issue-binding.ts') || process.argv[1].endsWith('cli-issue-binding.js'));
if (isMain) {
  parseArgs(process.argv);
}
