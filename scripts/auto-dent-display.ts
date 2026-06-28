/**
 * Shared display-text helpers for Auto-dent runtime output.
 *
 * These helpers own the small but drift-prone contract for rendering arbitrary
 * command/path/tool text as bounded human-readable summaries (#1348).
 */

import { basename } from 'node:path';

export interface TruncateDisplayOptions {
  ellipsis?: string;
  collapse?: boolean;
}

export const DISPLAY_BUDGETS = {
  path: 60,
  command: 90,
  grepPattern: 30,
  globPattern: 50,
  agentDescription: 50,
  taskSubject: 50,
} as const;

/**
 * Collapse internal whitespace - newlines, tabs, runs of spaces - to a single
 * space and trim (#1170). Display-only: machine-readable logs keep original
 * command/input text.
 */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function truncateDisplay(
  text: string,
  max: number,
  options: TruncateDisplayOptions = {},
): string {
  const ellipsis = options.ellipsis ?? '\u2026';
  const displayText = options.collapse === false ? text : collapseWhitespace(text);

  if (max <= 0) return '';
  if (displayText.length <= max) return displayText;
  if (ellipsis.length >= max) return ellipsis.slice(0, max);
  return displayText.slice(0, max - ellipsis.length) + ellipsis;
}

/**
 * Truncate text at a word boundary, max `max` characters before the ellipsis.
 * Falls back to an exact cut when no useful word boundary exists.
 */
export function truncateAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const truncated = text.slice(0, max);
  const lastSpace = truncated.lastIndexOf(' ');
  const cut = lastSpace > max * 0.5 ? lastSpace : max;
  return truncated.slice(0, cut).replace(/[,\s]+$/, '') + '...';
}

/** Matches a `.../.claude/worktrees/<id>` prefix; capture group 1 is the trailing slash, if any. */
const WORKTREE_PREFIX_RE = /\S*?\/\.claude\/worktrees\/[^/\s;|&]+(\/?)/g;

/**
 * Render worktree-absolute paths repo-relative. A path *under* the worktree
 * collapses to its remainder (`scripts/x.ts`); a bare worktree root collapses
 * to `.`. Non-worktree paths are returned unchanged.
 */
export function relativizeWorktreePath(s: string): string {
  if (!s) return s;
  return s.replace(WORKTREE_PREFIX_RE, (_m, slash) => (slash ? '' : '.'));
}

/**
 * Collapse noisy absolute prefixes for display: worktree paths become
 * repo-relative, then a remaining `/home/<user>/` collapses to `~/`.
 */
export function prettifyPath(s: string): string {
  if (!s) return s;
  return relativizeWorktreePath(s).replace(/\/home\/[^/\s;|&]+\//g, '~/');
}

/**
 * Drop a leading `cd <path>;` / `cd <path> &&` prefix from a command. The
 * worktree is implied by the run, so the `cd` is pure boilerplate.
 */
export function stripCdPrefix(cmd: string): string {
  return cmd.replace(/^\s*cd\s+\S+\s*(?:;|&&)\s*/, '');
}

export function renderPathForDisplay(path: string, max = DISPLAY_BUDGETS.path): string {
  return truncateDisplay(prettifyPath(path || '?'), max);
}

export function renderCommandForDisplay(command: string, max = DISPLAY_BUDGETS.command): string {
  return truncateDisplay(prettifyPath(stripCdPrefix(collapseWhitespace(command || '?'))), max);
}

export function renderToolInputSummary(name: string, input: Record<string, any>): string {
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return basename(input?.file_path || '?');
    case 'Bash':
      return truncateDisplay(
        prettifyPath(stripCdPrefix(collapseWhitespace(input?.command || input?.description || '?'))),
        60,
        { ellipsis: '' },
      );
    case 'Grep':
      return `"${truncateDisplay(input?.pattern || '?', DISPLAY_BUDGETS.grepPattern, { ellipsis: '' })}"`;
    case 'Glob':
      return truncateDisplay(input?.pattern || '?', 40, { ellipsis: '' });
    case 'Skill':
      return `/${input?.skill_name || input?.skill || '?'}`;
    case 'Agent':
      return truncateDisplay(input?.description || '?', 40, { ellipsis: '' });
    default:
      return '';
  }
}

export function renderToolUse(
  name: string,
  input: Record<string, any>,
): string {
  switch (name) {
    case 'Read':
      return `Read ${renderPathForDisplay(input?.file_path || '?')}`;
    case 'Edit':
      return `Edit ${renderPathForDisplay(input?.file_path || '?')}`;
    case 'Write':
      return `Write ${renderPathForDisplay(input?.file_path || '?')}`;
    case 'Bash':
      return `$ ${renderCommandForDisplay(input?.command || input?.description || '?')}`;
    case 'Grep':
      return `Grep "${truncateDisplay(input?.pattern || '?', DISPLAY_BUDGETS.grepPattern)}" ${prettifyPath(input?.path || '')}`;
    case 'Glob':
      return `Glob ${truncateDisplay(input?.pattern || '?', DISPLAY_BUDGETS.globPattern)}`;
    case 'Skill':
      return `Skill /${input?.skill_name || input?.skill || '?'}`;
    case 'Agent':
      return `Agent: ${truncateDisplay(input?.description || '?', DISPLAY_BUDGETS.agentDescription)}`;
    case 'TaskCreate':
      return `Task+ ${truncateDisplay(input?.subject || '?', DISPLAY_BUDGETS.taskSubject)}`;
    case 'TaskUpdate':
      return `Task~ #${input?.taskId || '?'} -> ${input?.status || '?'}`;
    case 'EnterWorktree':
      return `EnterWorktree ${input?.name || ''}`;
    case 'ExitWorktree':
      return 'ExitWorktree';
    case 'ToolSearch':
      return 'ToolSearch';
    default:
      return name;
  }
}

export interface DisplayPhaseMarker {
  phase: string;
  fields: Record<string, string>;
}

export function renderPhaseMarkerSummary(marker: DisplayPhaseMarker, phaseLabel: string): string {
  const parts = [phaseLabel];
  const { fields } = marker;
  if (fields.issue) parts.push(fields.issue);
  if (fields.title) parts.push(fields.title);
  if (fields.verdict) parts.push(fields.verdict);
  if (fields.reason) parts.push(`(${fields.reason})`);
  if (fields.case) parts.push(`case:${fields.case}`);
  if (fields.branch) parts.push(`branch:${fields.branch}`);
  if (fields.result) parts.push(fields.result);
  if (fields.count) parts.push(`${fields.count} tests`);
  if (fields.url) parts.push(fields.url);
  if (fields.status) parts.push(fields.status);
  if (fields.epic) parts.push(`epic:${fields.epic}`);
  if (fields.issues_created) parts.push(`created:${fields.issues_created}`);
  if (fields.issues_filed) parts.push(`${fields.issues_filed} issues filed`);
  if (fields.lessons) parts.push(fields.lessons);

  return truncateDisplay(parts.join(' '), 120);
}
