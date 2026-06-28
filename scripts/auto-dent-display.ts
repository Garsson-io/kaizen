/**
 * Shared display-text helpers for Auto-dent runtime output.
 *
 * These helpers own the small but drift-prone contract for rendering arbitrary
 * command/path/tool text as bounded human-readable summaries (#1348).
 */

export interface TruncateDisplayOptions {
  ellipsis?: string;
  collapse?: boolean;
}

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
