/**
 * git-state.ts — shared primitive for hooks that gate on git working-tree state.
 *
 * Established as the single source of state-reading discipline in response to
 * the recurring cwd/stat false-positive family: #232, #721, #871, #1073
 * (category umbrella: #240). See docs/hooks-design.md § "State-reading
 * discipline" for the rationale and the CI invariant that keeps new hooks
 * routed through this module.
 *
 * Four responsibilities:
 *   1. resolveTargetWorktree — anchor git reads to the *gated command's*
 *      worktree, not process.cwd().
 *   2. readDirtyFiles — verify every porcelain entry with a content-level
 *      `git diff --quiet HEAD -- <file>` call, neutralising the stat-vs-
 *      content-clean false-positive family (#871 regression class).
 *   3. formatDiagnostic — stable deny-time diagnostic block so the next
 *      false-positive is debuggable from the failure transcript alone
 *      (#1073 comment:2 explicit request).
 *   4. isBypassRequested — read the documented escape-hatch env var.
 *
 * Security posture: every git invocation goes through `spawnSync('git',
 * argv)` — a fixed binary with an explicit argv array. No shell, no
 * interpolation. Nothing in the resolved target path, porcelain filename,
 * or any other user-influenced value reaches a shell interpreter. The
 * original `execSync(\`git ${args}\`)` form was flagged in the #1073
 * review as the very shell-injection anti-pattern the PR claims to
 * neutralise; fixing it is part of the categorical fix.
 */

import { spawnSync } from 'node:child_process';

import { extractCdTarget, extractGitCPath, stripHeredocBody } from '../parse-command.js';

export type TargetSource = 'git-C' | 'cd' | 'cwd';

export interface ResolvedTarget {
  dir: string;
  source: TargetSource;
}

/**
 * Resolve the directory the *gated* command will execute against. Explicit
 * `git -C <path>` wins over `cd <path> && …`; both win over the fallback cwd.
 */
export function resolveTargetWorktree(
  cmdLine: string,
  fallbackCwd: string,
): ResolvedTarget {
  const stripped = stripHeredocBody(cmdLine);
  const gitC = extractGitCPath(stripped);
  if (gitC) return { dir: gitC, source: 'git-C' };
  const cd = extractCdTarget(stripped);
  if (cd) return { dir: cd, source: 'cd' };
  return { dir: fallbackCwd, source: 'cwd' };
}

export interface DirtyFileReport {
  staged: string[];
  modified: string[];
  untracked: string[];
  total: number;
}

export interface PerFileDiff {
  file: string;
  diffIndexExitCode: number;
  blobMatch: boolean;
}

export interface DirtyState {
  verified: DirtyFileReport;
  raw: string;
  gitDir: string;
  perFileDiff: PerFileDiff[];
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runner contract: takes an argv array (no shell), returns stdout + stderr
 * + exitCode. All internal uses build the argv programmatically — user
 * input (paths, porcelain-reported filenames) is always a dedicated array
 * element and never concatenated into a shell-interpreted string.
 */
export type GitExec = (args: readonly string[]) => GitExecResult;

export function createDefaultGitExec(): GitExec {
  return (args) => {
    const r = spawnSync('git', [...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      exitCode: r.status ?? 1,
    };
  };
}

export function gitStdout(
  args: readonly string[],
  fallback = '',
  exec: GitExec = createDefaultGitExec(),
): string {
  const result = exec(args);
  if (result.exitCode !== 0) return fallback;
  return result.stdout.trim();
}

/**
 * Parse porcelain v1 output into staged/modified/untracked buckets.
 * Exported so check-dirty-files.ts can reuse the single parser.
 */
export function parsePorcelain(output: string): DirtyFileReport {
  const lines = output.split('\n').filter(Boolean);
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

/**
 * Extract the destination file path from a porcelain v1 line.
 *
 * Porcelain format: `XY path` where X/Y are status chars. Rename/copy
 * entries take the form `R  orig -> new` (or `C  orig -> new`); we want
 * the destination, because that's the file whose working-tree content
 * we content-verify. Dropping the ` -> ` arrow into the git argv would
 * cause git to treat `->` as an operand — caught by the #1073 review.
 */
export function extractFilePath(porcelainLine: string): string {
  const tail = porcelainLine.slice(3);
  const arrow = tail.indexOf(' -> ');
  return (arrow >= 0 ? tail.slice(arrow + 4) : tail).trim();
}

/**
 * Read the git state of `targetDir` and verify every tracked-file claim
 * with `git diff --quiet HEAD -- <file>`. Files where porcelain says
 * "modified" but diff says "content matches HEAD" are filtered out —
 * this is the direct regression guard for #871.
 */
export function readDirtyFiles(
  targetDir: string,
  options: { runner?: GitExec } = {},
): DirtyState {
  const runner = options.runner ?? createDefaultGitExec();
  const anchor: readonly string[] = targetDir ? ['-C', targetDir] : [];

  const gitDir = runner([...anchor, 'rev-parse', '--absolute-git-dir']).stdout.trim();

  // Refresh the index to clear stat-only drift (belt-and-suspenders alongside
  // the content-level check below; observed as the #871 partial fix).
  runner([...anchor, 'update-index', '-q', '--refresh']);

  // Do NOT trim: porcelain's leading whitespace is significant.
  const porcelain = runner([...anchor, 'status', '--porcelain']).stdout;
  const rawReport = parsePorcelain(porcelain);

  const verifiedStaged: string[] = [];
  const verifiedModified: string[] = [];
  const perFileDiff: PerFileDiff[] = [];

  const checkFile = (line: string, bucket: string[]): void => {
    const file = extractFilePath(line);
    if (!file) return;
    const r = runner([...anchor, 'diff', '--quiet', 'HEAD', '--', file]);
    const blobMatch = r.exitCode === 0;
    perFileDiff.push({ file, diffIndexExitCode: r.exitCode, blobMatch });
    if (!blobMatch) bucket.push(line);
  };

  for (const line of rawReport.staged) checkFile(line, verifiedStaged);
  for (const line of rawReport.modified) checkFile(line, verifiedModified);

  const verified: DirtyFileReport = {
    staged: verifiedStaged,
    modified: verifiedModified,
    untracked: rawReport.untracked, // untracked has no HEAD to diff against
    total: verifiedStaged.length + verifiedModified.length + rawReport.untracked.length,
  };

  return { verified, raw: porcelain, gitDir, perFileDiff };
}

export interface DiagnosticContext {
  cwd: string;
  target: string;
  targetSource: TargetSource;
  gitDir: string;
  rawPorcelain: string;
  perFileDiff: PerFileDiff[];
}

const PORCELAIN_MAX_LINES = 20;

export function formatDiagnostic(ctx: DiagnosticContext): string {
  const rawLines = ctx.rawPorcelain.split('\n').filter(Boolean);
  const shown = rawLines.slice(0, PORCELAIN_MAX_LINES).join('\n');
  const truncatedNote =
    rawLines.length > PORCELAIN_MAX_LINES
      ? `\n... (${rawLines.length - PORCELAIN_MAX_LINES} lines truncated)`
      : '';

  const perFile = ctx.perFileDiff.length
    ? ctx.perFileDiff
        .map(
          (f) =>
            `  ${f.file}: diff-index exit=${f.diffIndexExitCode} content-match=${f.blobMatch}`,
        )
        .join('\n')
    : '  (no per-file diff evidence)';

  return [
    '--- diagnostic ---',
    `[cwd]             ${ctx.cwd}`,
    `[target]          ${ctx.target}`,
    `[target-source]   ${ctx.targetSource}`,
    `[git-dir]         ${ctx.gitDir}`,
    `[porcelain]       (${rawLines.length} line(s))`,
    shown + truncatedNote,
    `[diff-index]`,
    perFile,
    '--- end diagnostic ---',
  ].join('\n');
}

const BYPASS_ENV = 'KAIZEN_ALLOW_DIRTY_FILES';

export function isBypassRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[BYPASS_ENV];
  if (!v) return false;
  const norm = v.trim().toLowerCase();
  return norm === '1' || norm === 'true' || norm === 'yes';
}

export { BYPASS_ENV };
