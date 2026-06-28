/**
 * Shared Markdown table formatting helpers for generated runtime reports.
 */

export function escapeMarkdownTableCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}
