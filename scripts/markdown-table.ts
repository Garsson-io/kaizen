/**
 * Shared Markdown table formatting helpers for generated runtime reports.
 */

export interface MarkdownTableCellOptions {
  carriageReturn?: 'preserve' | 'drop';
}

export function escapeMarkdownTableCell(
  value: string,
  options: MarkdownTableCellOptions = {},
): string {
  const carriageReturn = options.carriageReturn ?? 'preserve';
  return value.replace(/[\|\n\r\\]/g, (ch) => {
    switch (ch) {
      case '|': return '\\|';
      case '\\': return '\\\\';
      case '\n': return ' ';
      case '\r': return carriageReturn === 'drop' ? '' : '\r';
      default: return ch;
    }
  });
}
