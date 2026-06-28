/**
 * worktree-integrity.ts — shared worktree/session integrity helpers.
 *
 * Keeps branch-shape and worktree-list logic out of bash hooks while preserving
 * the shell hook choke points that Claude Code invokes.
 */

import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  currentBranch,
  detectLeak,
  makeGitRun,
  selfHealBinding,
  type GitRun,
} from '../issue-binding.js';
import { canonicalCaseBranchFromSanitized } from './lib/case-branch.js';
import { gitStdout } from './lib/git-state.js';

export interface NormalizeResult {
  branchBefore: string;
  branchAfter: string;
  canonicalBranch: string | null;
  status: 'not-needed' | 'normalized' | 'target-exists' | 'rename-failed';
  message?: string;
}

export function normalizeSanitizedCaseBranch(run: GitRun): NormalizeResult {
  const branchBefore = currentBranch(run);
  const canonicalBranch = canonicalCaseBranchFromSanitized(branchBefore);
  if (!canonicalBranch) {
    return { branchBefore, branchAfter: branchBefore, canonicalBranch: null, status: 'not-needed' };
  }

  const exists = run(['show-ref', '--verify', '--quiet', `refs/heads/${canonicalBranch}`]);
  if (exists.code === 0) {
    return {
      branchBefore,
      branchAfter: branchBefore,
      canonicalBranch,
      status: 'target-exists',
      message:
        `kaizen-worktree-setup: ⚠️  Cannot normalize ${branchBefore} -> ${canonicalBranch} because that branch already exists.\n` +
        `kaizen-worktree-setup:    Remediate manually: git branch -m <unique case/... branch> && npx tsx src/cli-issue-binding.ts auto-bind`,
    };
  }

  const renamed = run(['branch', '-m', canonicalBranch]);
  if (renamed.code !== 0) {
    return {
      branchBefore,
      branchAfter: branchBefore,
      canonicalBranch,
      status: 'rename-failed',
      message:
        `kaizen-worktree-setup: ⚠️  Failed to normalize ${branchBefore} -> ${canonicalBranch}.\n` +
        `kaizen-worktree-setup:    Remediate manually: git branch -m ${canonicalBranch} && npx tsx src/cli-issue-binding.ts auto-bind`,
    };
  }

  return {
    branchBefore,
    branchAfter: canonicalBranch,
    canonicalBranch,
    status: 'normalized',
    message: `kaizen-worktree-setup: 🔧 Normalized branch ${branchBefore} -> ${canonicalBranch} (EnterWorktree case contract).`,
  };
}

export function sessionSetupMessages(run: GitRun = makeGitRun()): string[] {
  const messages: string[] = [];
  const normalized = normalizeSanitizedCaseBranch(run);
  if (normalized.message) messages.push(normalized.message);

  const branch = normalized.branchAfter || currentBranch(run);
  const healed = selfHealBinding(branch, run);
  if (healed.healed) {
    messages.push(`kaizen-worktree-setup: 🔗 Auto-bound this worktree to #${healed.issue} from its case branch (no manual step needed).`);
    return messages;
  }
  if (healed.reason === 'already-bound') return messages;

  const leak = detectLeak(branch, run);
  if (leak.leaked && leak.merged != null) {
    messages.push(
      `kaizen-worktree-setup: ⚠️  Leaked kaizen.issue — this worktree inherits #${leak.merged} from shared config with no binding of its own.\n` +
      `kaizen-worktree-setup:    Bind this worktree to its real issue: npx tsx src/cli-issue-binding.ts bind --issue <N>`,
    );
  }
  return messages;
}

export interface WorktreeEntry {
  path: string;
  branch?: string;
}

export function parseWorktreePorcelain(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of `${output}\n`.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length) };
      continue;
    }
    if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  if (current) entries.push(current);
  return entries;
}

export function matchingCaseWorktreeTargets(
  mainRoot: string,
  relPath: string,
  worktreeOutput: string,
  pathExists: (path: string) => boolean = existsSync,
): string[] {
  return parseWorktreePorcelain(worktreeOutput).flatMap(entry => {
    if (entry.path === mainRoot || !entry.branch?.startsWith('case/')) return [];
    const target = join(entry.path, relPath);
    return pathExists(target) || pathExists(dirname(target)) ? [target] : [];
  });
}

export function mainCheckoutEditHint(
  mainRoot: string,
  relPath: string,
  deps: { gitWorktreeList?: () => string; pathExists?: (path: string) => boolean } = {},
): string {
  const list = deps.gitWorktreeList ?? (() =>
    gitStdout(['-C', mainRoot, 'worktree', 'list', '--porcelain'])
  );
  const targets = matchingCaseWorktreeTargets(mainRoot, relPath, list(), deps.pathExists);
  if (targets.length === 1) {
    return `Active case worktree target for this file:\n  ${targets[0]}`;
  }
  if (targets.length > 1) {
    return 'Multiple active case worktrees contain this relative path. Choose the intended worktree before editing.';
  }
  return '';
}

function argValue(args: string[], name: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] ?? '' : '';
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const command = argv[0] ?? '';
  if (command === 'session-setup') {
    for (const message of sessionSetupMessages()) {
      console.error(message);
    }
    return 0;
  }
  if (command === 'main-edit-hint') {
    const mainRoot = argValue(argv, '--main-root');
    const relPath = argValue(argv, '--rel-path');
    if (!mainRoot || !relPath) return 0;
    const hint = mainCheckoutEditHint(mainRoot, relPath);
    if (hint) console.log(hint);
    return 0;
  }
  return 0;
}

if (process.argv[1]?.endsWith('worktree-integrity.ts') || process.argv[1]?.endsWith('worktree-integrity.js')) {
  process.exit(main());
}
