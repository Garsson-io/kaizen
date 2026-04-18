/**
 * check-dirty-files.ts — PreToolUse gate: ensures clean worktree before PR create/push.
 *
 * @enforces I11 — No dirty files at `gh pr create` (denies).
 * @enforces I25 — No dirty files between ops (currently advisory on push/merge; escalation tracked in #1037).
 *                 Canonical: docs/kaizen-invariants.md.
 *
 * Triggers:
 *   gh pr create — BLOCK (agent is declaring "work is done")
 *   git push     — WARN  (push is intermediate, PR create is the gate — kaizen #775)
 *   gh pr merge  — WARN  (PR is on GitHub, local state is advisory)
 *
 * Skips entirely when MERGE_HEAD exists (merge resolution in progress — kaizen #775).
 *
 * Part of kAIzen Agent Control Flow — kaizen #775.
 *
 * Categorical fix (#1073) — every git invocation is anchored to the
 * resolved target worktree (see lib/git-state.ts), every porcelain entry
 * is verified at content-level, every deny includes a diagnostic block,
 * and KAIZEN_ALLOW_DIRTY_FILES=1 is a documented escape. The shared
 * primitive closes the category for this hook and stages the same
 * discipline for sibling hooks via the git-state invariant test.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readHookInput, traceNullInput } from './hook-io.js';
import {
  extractGitCPath,
  isGhPrCommand,
  isGitCommand,
  splitCommandSegments,
  stripHeredocBody,
} from './parse-command.js';
import {
  BYPASS_ENV,
  createDefaultGitExec,
  formatDiagnostic,
  isBypassRequested,
  readDirtyFiles,
  resolveTargetWorktree,
  type DirtyFileReport,
  type DirtyState,
  type GitExec,
} from './lib/git-state.js';

type TriggerType = 'pr_create' | 'git_push' | 'pr_merge' | 'none';

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
    if (hasCommitBeforePush(cmdLine)) return 'none';
    return 'git_push';
  }
  if (isGhPrCommand(cmdLine, 'merge')) return 'pr_merge';
  return 'none';
}

export function parseDirtyFiles(porcelainOutput: string): DirtyFileReport {
  const lines = porcelainOutput.split('\n').filter(Boolean);
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (/^\?\?/.test(line)) untracked.push(line);
    else if (/^[MARCD][MARCD]/.test(line)) staged.push(line);
    else if (/^[MARCD] /.test(line)) staged.push(line);
    else if (/^ [M]/.test(line)) modified.push(line);
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

export interface CheckDirtyFilesOptions {
  /**
   * Legacy runner: string → string. When provided (and `gitExec` is not),
   * the hook uses the pre-#1073 code path that trusts porcelain directly —
   * this preserves the semantics of every historical unit test. New tests
   * should use `gitExec` to exercise the content-level verification path.
   */
  gitRunner?: (args: string) => string;
  /**
   * Post-#1073 runner: string → { stdout, exitCode }. Enables
   * content-level verification via `git diff --quiet HEAD -- <file>` and
   * the full diagnostic block.
   */
  gitExec?: GitExec;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stderr?: { write: (s: string) => void };
}

export interface CheckDirtyFilesResult {
  action: 'allow' | 'warn' | 'deny';
  message?: string;
  bypassed?: boolean;
}

export function checkDirtyFiles(
  command: string,
  options: CheckDirtyFilesOptions = {},
): CheckDirtyFilesResult {
  const cmdLine = stripHeredocBody(command);
  const trigger = detectTrigger(cmdLine);

  if (trigger === 'none') return { action: 'allow' };

  if (options.gitRunner && !options.gitExec) {
    return legacyCheckDirtyFiles(cmdLine, trigger, options.gitRunner);
  }

  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  if (isBypassRequested(env)) {
    options.stderr?.write(
      `[check-dirty-files] BYPASS: ${BYPASS_ENV} is set — skipping dirty check\n`,
    );
    return { action: 'allow', bypassed: true };
  }

  const exec: GitExec = options.gitExec ?? createDefaultGitExec();
  const target = resolveTargetWorktree(cmdLine, cwd);
  const state: DirtyState = readDirtyFiles(target.dir, { runner: exec });

  if (state.gitDir && existsSync(join(state.gitDir, 'MERGE_HEAD'))) {
    return { action: 'allow' };
  }

  if (state.verified.total === 0) return { action: 'allow' };

  const fileList = formatFileList(state.verified);
  const diagnostic = formatDiagnostic({
    cwd,
    target: target.dir,
    targetSource: target.source,
    gitDir: state.gitDir,
    rawPorcelain: state.raw,
    perFileDiff: state.perFileDiff,
  });

  if (trigger === 'pr_merge' || trigger === 'git_push') {
    const actionLabel = trigger === 'pr_merge' ? 'merging a PR' : 'pushing code';
    return {
      action: 'warn',
      message: `DIRTY FILES DETECTED — ${state.verified.total} file(s) with uncommitted changes:

${fileList}You're ${actionLabel}, so this is advisory only.
But dirty files suggest unfinished or forgotten work.
Consider committing or discarding before proceeding.

${diagnostic}`,
    };
  }

  return {
    action: 'deny',
    message: `DIRTY FILES — ${state.verified.total} file(s) with uncommitted changes while creating a PR.

${fileList}You MUST handle each file before proceeding:

FOR USEFUL FILES (part of this work):
  git add <file> && git commit -m 'meaningful message about what and why'

FOR ARTIFACTS/DEBUG/LEFTOVER FILES (not part of this work):
  git checkout -- <file>    (for modified tracked files)
  rm <file>                 (for untracked files)

If you believe the hook is wrong (content-clean file flagged as dirty, or
stale stat), set ${BYPASS_ENV}=1 to bypass — please include the diagnostic
block below in the follow-up kaizen issue.

${diagnostic}`,
  };
}

/**
 * Legacy code path preserving pre-#1073 behavior for tests that pass
 * `gitRunner: (args: string) => string`. No content-level verification
 * (legacy runner can't signal exit code), no diagnostic block.
 */
function legacyCheckDirtyFiles(
  cmdLine: string,
  trigger: Exclude<TriggerType, 'none'>,
  gitRunner: (args: string) => string,
): CheckDirtyFilesResult {
  const git = gitRunner;

  const gitDir = git('rev-parse --git-dir');
  if (gitDir && existsSync(join(gitDir, 'MERGE_HEAD'))) return { action: 'allow' };

  const targetDir = extractGitCPath(cmdLine);
  const gitPrefix = targetDir ? `-C ${targetDir}` : '';

  git(`${gitPrefix} update-index -q --refresh`);
  const porcelain = git(`${gitPrefix} status --porcelain`);
  if (!porcelain) return { action: 'allow' };

  const report = parseDirtyFiles(porcelain);
  if (report.total === 0) return { action: 'allow' };

  const fileList = formatFileList(report);

  if (trigger === 'pr_merge' || trigger === 'git_push') {
    const actionLabel = trigger === 'pr_merge' ? 'merging a PR' : 'pushing code';
    return {
      action: 'warn',
      message: `DIRTY FILES DETECTED — ${report.total} file(s) with uncommitted changes:

${fileList}You're ${actionLabel}, so this is advisory only.
But dirty files suggest unfinished or forgotten work.
Consider committing or discarding before proceeding.`,
    };
  }

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
  if (!input) { traceNullInput("check-dirty-files"); process.exit(0); }

  const command = input.tool_input?.command ?? '';
  const result = checkDirtyFiles(command, { stderr: process.stderr });

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
