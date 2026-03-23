/**
 * allowlist.ts — Shared allowlist functions for PreToolUse gate hooks.
 *
 * TypeScript port of .claude/hooks/lib/allowlist.sh (kaizen #775).
 * DRY extraction: these functions are shared by enforce-pr-review and
 * enforce-pr-reflect to ensure consistent command allowlists.
 */

import { isGhPrCommand, isGitCommand } from '../parse-command.js';

/**
 * Split a command line by pipe/chain operators and return segments.
 */
function splitSegments(cmdLine: string): string[] {
  return cmdLine
    .split(/[|;&]{1,2}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Check if a command is a readonly monitoring command allowed through any gate.
 * These commands can't "do work" (build, deploy, edit) so they don't violate
 * any gate's intent.
 *
 * Allowed:
 *   gh api, gh run view/list/watch
 *   git diff/log/show/status/branch/fetch
 *   ls, cat, stat, find, head, tail, wc, file
 *   npm test, npx (diagnostic — kaizen #775)
 *   grep, rg, awk, sed (read-only search — kaizen #775)
 */
export function isReadonlyMonitoringCommand(cmdLine: string): boolean {
  const segments = splitSegments(cmdLine);
  for (const seg of segments) {
    const firstWord = seg.split(/\s+/)[0];

    // gh api
    if (/^gh\s+api\s/.test(seg)) return true;

    // gh run view/list/watch
    if (/^gh\s+run\s+(view|list|watch)/.test(seg)) return true;

    // git read-only
    if (isGitCommand(seg, 'diff|log|show|status|branch|fetch')) return true;

    // Read-only filesystem commands
    if (['ls', 'cat', 'stat', 'find', 'head', 'tail', 'wc', 'file'].includes(firstWord)) return true;

    // Diagnostic commands (kaizen #775 — expand allowlist)
    if (['grep', 'rg', 'awk', 'sed'].includes(firstWord)) return true;

    // npm test / npx (diagnostic — kaizen #775)
    if (/^npm\s+test/.test(seg) || /^npx\s/.test(seg)) return true;
  }
  return false;
}

/**
 * Check if a command is allowed during PR review gate.
 * Includes review-related PR commands + shared readonly monitoring.
 */
export function isReviewCommand(cmdLine: string): boolean {
  // gh pr diff/view/comment/edit
  if (isGhPrCommand(cmdLine, 'diff|view|comment|edit')) return true;

  // Shared readonly monitoring
  if (isReadonlyMonitoringCommand(cmdLine)) return true;

  return false;
}

/**
 * Check if a command is allowed during kaizen reflection gate.
 * Includes kaizen-related commands + shared readonly monitoring.
 */
export function isKaizenCommand(cmdLine: string): boolean {
  const segments = splitSegments(cmdLine);

  for (const seg of segments) {
    // gh issue create/list/search/comment/view
    if (/^gh\s+issue\s+(create|list|search|comment|view)/.test(seg)) return true;

    // KAIZEN_IMPEDIMENTS declaration
    if (/^echo.*KAIZEN_IMPEDIMENTS:/.test(seg) || /^KAIZEN_IMPEDIMENTS:/.test(seg) || /^cat/.test(seg)) return true;

    // KAIZEN_NO_ACTION declaration
    if (/^echo.*KAIZEN_NO_ACTION/.test(seg) || /^KAIZEN_NO_ACTION/.test(seg)) return true;

    // KAIZEN_UNFINISHED declaration (kaizen #775)
    if (/^echo.*KAIZEN_UNFINISHED:/.test(seg) || /^KAIZEN_UNFINISHED:/.test(seg)) return true;
  }

  // gh pr diff/view/comment/edit/checks/merge
  if (isGhPrCommand(cmdLine, 'diff|view|comment|edit|checks|merge')) return true;

  // Shared readonly monitoring
  if (isReadonlyMonitoringCommand(cmdLine)) return true;

  return false;
}

/**
 * Check if a relative path is in an allowed runtime directory (non-source code).
 */
export function isAllowedRuntimeDir(relPath: string): boolean {
  return /^(\.claude\/|groups\/|data\/|store\/|logs\/|strategy\/)/.test(relPath);
}
