/**
 * allowlist.ts — Shared allowlist functions for PreToolUse gate hooks.
 *
 * TypeScript port of .claude/hooks/lib/allowlist.sh (kaizen #775).
 * DRY extraction: these functions are shared by enforce-pr-review and
 * enforce-pr-reflect to ensure consistent command allowlists.
 */

import {
  isGhPrCommand,
  isGitCommand,
  splitCommandSegments,
} from '../parse-command.js';

/**
 * Split a command line into statements. Delegates to the canonical
 * `splitCommandSegments` so the allowlist splits identically to every gate
 * detector — previously this was a private copy that split on `|;&` but NOT
 * bare newlines, diverging from the canonical splitter after #1013. The
 * divergence let a multi-line command whose readonly statement sits on a
 * separate line classify inconsistently across hooks.
 */
function splitSegments(cmdLine: string): string[] {
  return splitCommandSegments(cmdLine);
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
 * Check if a command is one of the universal stop-gate escape declarations.
 *
 * The Stop gate advertises `echo 'KAIZEN_UNFINISHED: <reason>'` (and the
 * sibling KAIZEN_NO_ACTION / KAIZEN_IMPEDIMENTS declarations) as the way out of
 * ANY blocked state — see `gate-manager.ts` formatGateMessage. A PreToolUse gate
 * that does not honor these would deadlock the author: the harness tells them to
 * run the escape, then the allowlist blocks it as "not scoped to this gate"
 * (kaizen #1068). This is the single source of truth so every gate allowlist
 * accepts the same escape — see the escape-hatch invariant in allowlist.test.ts.
 */
export function isEscapeHatch(cmdLine: string): boolean {
  const segments = splitSegments(cmdLine);
  for (const seg of segments) {
    // KAIZEN_UNFINISHED: <reason> — universal "stopping with unfinished work" escape
    if (/^echo.*KAIZEN_UNFINISHED:/.test(seg) || /^KAIZEN_UNFINISHED:/.test(seg)) return true;
    // KAIZEN_NO_ACTION — "nothing to do here" declaration
    if (/^echo.*KAIZEN_NO_ACTION/.test(seg) || /^KAIZEN_NO_ACTION/.test(seg)) return true;
    // KAIZEN_IMPEDIMENTS: — reflection escape (also used to satisfy I16)
    if (/^echo.*KAIZEN_IMPEDIMENTS:/.test(seg) || /^KAIZEN_IMPEDIMENTS:/.test(seg)) return true;
  }
  return false;
}

/**
 * Check if a command is allowed during PR review gate.
 * Includes review-related PR commands + the universal escape + shared readonly
 * monitoring.
 */
export function isReviewCommand(cmdLine: string): boolean {
  // gh pr diff/view/comment/edit
  if (isGhPrCommand(cmdLine, 'diff|view|comment|edit')) return true;

  // Universal stop-gate escape — must work from any gate-blocked state (#1068)
  if (isEscapeHatch(cmdLine)) return true;

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

    // `cat` heredoc bodies for issue/reflection payloads
    if (/^cat/.test(seg)) return true;
  }

  // Universal stop-gate escape declarations (KAIZEN_UNFINISHED/NO_ACTION/IMPEDIMENTS).
  // Single source of truth — shared with isReviewCommand so the documented escape
  // works from every gate-blocked state (#1068, kaizen #775).
  if (isEscapeHatch(cmdLine)) return true;

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
