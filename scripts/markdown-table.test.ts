import { describe, expect, it } from 'vitest';
import { escapeMarkdownTableCell } from './markdown-table.js';

describe('escapeMarkdownTableCell', () => {
  it('escapes backslashes, pipes, and newlines for Markdown table cells (#1356)', () => {
    expect(escapeMarkdownTableCell('Pipe | Backslash \\')).toBe('Pipe \\| Backslash \\\\');
    expect(escapeMarkdownTableCell('line one\nline | two \\')).toBe('line one line \\| two \\\\');
  });

  it('leaves ordinary cell text unchanged', () => {
    expect(escapeMarkdownTableCell('provider-independent')).toBe('provider-independent');
  });
});
