/**
 * check-dirty-files.ts — PreToolUse gate: ensures clean worktree before PR create/push.
 *
 * TypeScript port of .claude/hooks/kaizen-check-dirty-files.sh (kaizen #775).
 *
 * Triggers:
 *   gh pr create — BLOCK (agent is declaring "work is done")
 *   git push     — WARN  (push is intermediate, PR create is the gate — kaizen #775)
 *   gh pr merge  — WARN  (PR is on GitHub, local state is advisory)
 *
 * Skips entirely when MERGE_HEAD exists (merge resolution in progress — kaizen #775).
 *
 * Part of kAIzen Agent Control Flow — kaizen #775
 */

import { execSync, type ExecSyncOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readHookInput } from './hook-io.js';
import {
  extractGitCPath,
  isGhPrCommand,
  isGitCommand,
  splitCommandSegments,
  stripHeredocBody,
} from './parse-command.js';

const EXEC_OPTS: ExecSyncOptions = { encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] };

type TriggerType = 'pr_create' | 'git_push' | 'pr_merge' | 'none';

/**
 * Check if a compound command has `git commit` before `git push`.
 * When the user runs `git add -A && git commit -m '...' && git push`,
 * dirty files will be committed before push runs — so the dirty-files
 * check would be a false positive (kaizen #721).
 */
export function hasCommitBeforePush(cmdLine: string): boolean {
  const segments = splitCommandSegments(cmdLine);
  let foundCommit = false;
  for (const seg of segments) {
    if (/^git\s+(-C\s+\S+\s+)?commit\b/.test(seg)) foundCommit = true;
    if (/^git\s+(-C\s+\S+\s+)?push\b/.test(seg) && foundCommit) return true;
  }
  return false;
}

export function detectTrigger(cmdLine: string): TriggerType {
  if (isGhPrCommand(cmdLine, 'create')) return 'pr_create';
  if (isGitCommand(cmdLine, 'push')) {
    // Skip false positive when commit precedes push in compound command (kaizen #721)
    if (hasCommitBeforePush(cmdLine)) return 'none';
    return 'git_push';
  }
  if (isGhPrCommand(cmdLine, 'merge')) return 'pr_merge';
  return 'none';
}

export interface DirtyFileReport {
  staged: string[];
  modified: string[];
  untracked: string[];
  total: number;
}

export function parseDirtyFiles(porcelainOutput: string): DirtyFileReport {
  const lines = porcelainOutput.split('\n').filter(Boolean);
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (/^\?\?/.test(line)) {
      untracked.push(line);
    } else if (/^[MARCD] /.test(line)) {
      staged.push(line);
    } else if (/^ ?M/.test(line)) {
      modified.push(line);
    }
  }

  return { staged, modified, untracked, total: lines.length };
}

export function formatFileList(report: DirtyFileReport): string {
  const parts: string[] = [];
  if (report.staged.length > 0) {
    parts.push(`Staged but not committed:\n${report.staged.map((l) => `  ${l}`).join('\n')}\n`);
  }
  if (report.modified.length > 0) {
    parts.push(`Modified (unstaged):\n${report.modified.map((l) => `  ${l}`).join('\n')}\n`);
  }
  if (report.untracked.length > 0) {
    parts.push(`Untracked:\n${report.untracked.map((l) => `  ${l}`).join('\n')}\n`);
  }
  return parts.join('\n');
}

export function checkDirtyFiles(
  command: string,
  options: { gitRunner?: (args: string) => string } = {},
): { action: 'allow' | 'warn' | 'deny'; message?: string } {
  const cmdLine = stripHeredocBody(command);
  const trigger = detectTrigger(cmdLine);

  if (trigger === 'none') return { action: 'allow' };

  const git = options.gitRunner ?? ((args: string) => {
    try {
      return execSync(`git ${args}`, EXEC_OPTS as { encoding: 'utf-8' }).trim();
    } catch {
      return '';
    }
  });

  // Skip during merge resolution (kaizen #775)
  const toplevel = git('rev-parse --show-toplevel');
  if (toplevel && existsSync(join(toplevel, '.git', 'MERGE_HEAD'))) {
    return { action: 'allow' };
  }

  // Handle git -C <path> push (cross-worktree — kaizen #232)
  const targetDir = extractGitCPath(cmdLine);
  const gitPrefix = targetDir ? `-C ${targetDir}` : '';

  const porcelain = git(`${gitPrefix} status --porcelain`);
  if (!porcelain) return { action: 'allow' };

  const report = parseDirtyFiles(porcelain);
  if (report.total === 0) return { action: 'allow' };

  const fileList = formatFileList(report);

  if (trigger === 'pr_merge' || trigger === 'git_push') {
    // Advisory for merge and push (kaizen #775: push downgraded to warn)
    const actionLabel = trigger === 'pr_merge' ? 'merging a PR' : 'pushing code';
    return {
      action: 'warn',
      message: `DIRTY FILES DETECTED — ${report.total} file(s) with uncommitted changes:

${fileList}You're ${actionLabel}, so this is advisory only.
But dirty files suggest unfinished or forgotten work.
Consider committing or discarding before proceeding.`,
    };
  }

  // For pr create — BLOCK
  return {
    action: 'deny',
    message: `DIRTY FILES — ${report.total} file(s) with uncommitted changes while creating a PR.

${fileList}You MUST handle each file before proceeding:

FOR USEFUL FILES (part of this work):
  git add <file> && git commit -m 'meaningful message about what and why'

FOR ARTIFACTS/DEBUG/LEFTOVER FILES (not part of this work):
  git checkout -- <file>    (for modified tracked files)
  rm <file>                 (for untracked files)`,
  };
}

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) process.exit(0);

  const command = input.tool_input?.command ?? '';
  const result = checkDirtyFiles(command);

  if (result.action === 'deny') {
    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: result.message,
      },
    });
    process.stdout.write(output);
  } else if (result.action === 'warn' && result.message) {
    process.stderr.write(`\n${result.message}\n`);
  }
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('check-dirty-files.ts') ||
  process.argv[1]?.endsWith('check-dirty-files.js')
) {
  main().catch(() => process.exit(0));
}
