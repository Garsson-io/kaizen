/**
 * parse-command.ts — TypeScript port of .claude/hooks/lib/parse-command.sh
 *
 * Shared utilities for parsing hook command inputs. Replaces fragile sed/grep
 * pipelines with proper string handling.
 */

import { extractPrUrl as extractGithubPrUrl } from '../lib/github-pr.js';

/**
 * Strip heredoc body from a command string.
 * Heredocs (<<'EOF' ... EOF) can contain arbitrary text that causes
 * false positives when grepping for command patterns.
 * Removes the heredoc body but preserves content AFTER the closing delimiter
 * (e.g., `git commit -m "$(cat <<'EOF'\n...\nEOF\n)" && git push` keeps `&& git push`).
 */
export function stripHeredocBody(command: string): string {
  const lines = command.split('\n');
  const heredocPattern = /<<\s*-?\s*['"]?([A-Za-z_][A-Za-z_0-9]*)['"]?/;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(heredocPattern);
    if (match) {
      const delimiter = match[1];
      const before = lines.slice(0, i + 1);
      // Find the closing delimiter and keep everything after it
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === delimiter || lines[j].trim() === `${delimiter})`
            || lines[j].trim().startsWith(`${delimiter})"`)) {
          const after = lines.slice(j + 1);
          return [...before, ...after].join('\n');
        }
      }
      // No closing delimiter found — return up to the heredoc line
      return before.join('\n');
    }
  }
  return command;
}

/**
 * Split a command line by pipe/chain operators (|, &&, ||, ;) AND bare newlines,
 * returning individual segments trimmed.
 *
 * Newlines are delimiters because a multi-statement Bash block separates
 * statements with bare `\n` (e.g. variable assignments on their own lines
 * before `gh pr create`). Without splitting on `\n` the whole block is one
 * segment beginning with the first assignment, so anchored detectors like
 * `isGhPrCommand` (`^gh\s+pr\s+create`) never match and the review/plan/dirty
 * gates silently no-op (#1013). The bash original
 * (`.claude/hooks/lib/parse-command.sh`) already splits on newlines via its
 * line-based sed pipeline; this restores that parity. Callers strip heredoc
 * bodies first, so an embedded `gh pr create` in a commit message is not
 * resurrected as a false segment.
 */
export function splitCommandSegments(cmdLine: string): string[] {
  return cmdLine
    .split(/[\n|;&]{1,2}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Check if a command line contains an actual `gh pr <subcommand>` invocation,
 * not just the text inside a string argument.
 */
export function isGhPrCommand(cmdLine: string, subcommand: string): boolean {
  const segments = splitCommandSegments(cmdLine);
  // The alternation MUST be grouped and word-bounded: a bare `${subcommand}`
  // would (a) bind the `^gh\s+pr\s+` anchor only to the first alternative and
  // (b) match a longer subcommand by prefix (e.g. `gh pr difftool` as `diff`).
  // See isGitCommand for the full failure mode (#1350).
  const pattern = new RegExp(`^gh\\s+pr\\s+(${subcommand})\\b`);
  return segments.some((seg) => pattern.test(seg));
}

/**
 * Check if a command line contains an actual `git <subcommand>` invocation.
 * Handles `git -C <path> <subcommand>` by skipping the -C flag and its argument.
 */
export function isGitCommand(cmdLine: string, subcommand: string): boolean {
  const segments = splitCommandSegments(cmdLine);
  // The alternation MUST be wrapped in a group, or `|` (lowest precedence)
  // makes the `^git\s+(-C…)?` anchor bind only to the FIRST alternative and
  // every later alternative becomes a bare, unanchored substring match. With
  // subcommand='diff|log|show|status|branch|fetch' that classified
  // `rm -rf branch-backups`, `git push origin show`, `docker rm show`, and
  // `make deploy-log` as a readonly git command — a gate bypass (#1350). The
  // trailing `\b` also stops a longer command (`git difftool`) from matching a
  // bare subcommand (`diff`).
  const pattern = new RegExp(`^git\\s+(-C\\s+\\S+\\s+)?(${subcommand})\\b`);
  return segments.some((seg) => pattern.test(seg));
}

/**
 * Extract PR number from a gh pr <subcommand> invocation.
 * Returns the number if present, undefined otherwise.
 */
export function extractPrNumber(
  cmdLine: string,
  subcommand: string,
): string | undefined {
  const match = cmdLine.match(
    new RegExp(`gh\\s+pr\\s+${subcommand}\\s+(\\d+)`),
  );
  return match?.[1];
}

/**
 * Extract the -C <path> argument from a git command, if present.
 * Bash equivalent: extract_git_c_path()
 */
export function extractGitCPath(cmdLine: string): string | undefined {
  const segments = splitCommandSegments(cmdLine);
  for (const seg of segments) {
    const match = seg.match(/^git\s+-C\s+(\S+)/);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Extract the target of a leading `cd <dir>` in a compound command.
 * Returns the directory a following command will execute in, or undefined
 * when the command has no `cd`, uses `cd -` / bare `cd`, or the path is
 * unrecognised.
 *
 * Category prevention for #1073 / #240: hooks resolve the *gated command's*
 * target worktree before running git queries, instead of inheriting the
 * agent's `process.cwd()`.
 */
export function extractCdTarget(cmdLine: string): string | undefined {
  const stripped = cmdLine.trim().replace(/^\(\s*/, '');
  const segments = splitCommandSegments(stripped);
  for (const seg of segments) {
    // `cd <arg>` with word boundary (so `cdlock` is ignored).
    // Arg is one of: "quoted", 'quoted', or a bare \S+.
    const m = seg.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/);
    if (!m) continue;
    const target = m[1] ?? m[2] ?? m[3];
    if (!target || target === '-') return undefined;
    return target;
  }
  return undefined;
}

function extractPersistentCdPath(segment: string): string | null {
  const match = segment.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/);
  const target = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  return target && target !== '-' ? target : null;
}

/**
 * Track plain `cd <dir>` segments before the first segment matching
 * `targetPattern`, returning that target command's effective cwd. Parenthesized
 * or otherwise unrecognised cd forms return undefined so callers can fail
 * closed instead of pretending subshell state persists.
 */
export function effectiveCwdBeforeCommand(
  cmdLine: string,
  targetPattern: RegExp,
  initialCwd = process.cwd(),
): string | undefined {
  let cwd = initialCwd;
  for (const segment of splitCommandSegments(cmdLine)) {
    if (targetPattern.test(segment)) return cwd;
    if (/^\(?\s*cd\s+/.test(segment)) {
      const target = extractPersistentCdPath(segment);
      if (!target) return undefined;
      cwd = target.startsWith('/') ? target : `${cwd.replace(/\/$/, '')}/${target}`;
    }
  }
  return undefined;
}

/**
 * Extract --repo flag value from a command line.
 */
export function extractRepoFlag(cmdLine: string): string | undefined {
  const match = cmdLine.match(/--repo\s+(\S+)/);
  return match?.[1];
}

/**
 * Detect the GitHub repo (owner/name) from a git remote URL string.
 * Handles both HTTPS and SSH URLs.
 * Bash equivalent: detect_gh_repo() — but takes a URL string instead of
 * calling git directly, to keep this module pure (no child_process).
 */
export function detectGhRepo(remoteUrl: string): string | undefined {
  const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  return match?.[1];
}

/**
 * Get changed files for a PR command.
 * For merge: returns files from `gh pr diff --name-only`.
 * For create: returns files from `git diff --name-only main...HEAD`.
 *
 * Bash equivalent: get_pr_changed_files() — but takes an executor function
 * instead of calling shell commands directly.
 */
export function getPrChangedFiles(
  cmdLine: string,
  isMerge: boolean,
  executor: (cmd: string) => string,
): string[] {
  if (isMerge) {
    const prNum = extractPrNumber(cmdLine, 'merge');
    const repo = extractRepoFlag(cmdLine);
    const repoFlag = repo ? `--repo ${repo}` : '';
    const prArg = prNum ?? '';

    let result = executor(`gh pr diff ${prArg} --name-only ${repoFlag}`.trim());
    if (!result) {
      result = executor('git diff --name-only main...HEAD');
    }
    return result
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }
  return executor('git diff --name-only main...HEAD')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Extract a GitHub PR URL from text (stdout, stderr, or command args).
 */
export function extractPrUrl(text: string): string | undefined {
  return extractGithubPrUrl(text);
}

/**
 * Reconstruct a full PR URL from a gh pr command line.
 * Fallback chain:
 *   1. Extract URL from stdout/stderr
 *   2. Extract URL from command args
 *   3. Parse --repo + bare PR number from command, construct URL
 *   4. Parse bare PR number + detect repo from git remote (requires repoFromGit)
 */
export function reconstructPrUrl(
  cmdLine: string,
  stdout: string,
  stderr: string,
  subcommand: string,
  repoFromGit?: string,
): string | undefined {
  // Try stdout
  let url = extractPrUrl(stdout);
  if (url) return url;

  // Try stderr
  url = extractPrUrl(stderr);
  if (url) return url;

  // Try command args (full URL in the command)
  url = extractPrUrl(cmdLine);
  if (url) return url;

  // Reconstruct from --repo + bare PR number
  const prNum = extractPrNumber(cmdLine, subcommand);
  if (prNum) {
    const repo = extractRepoFlag(cmdLine) ?? repoFromGit;
    if (repo) {
      return `https://github.com/${repo}/pull/${prNum}`;
    }
  }

  return undefined;
}
