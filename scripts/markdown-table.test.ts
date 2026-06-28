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

  it('can drop carriage returns for timeline table cells without changing the default (#1360)', () => {
    expect(escapeMarkdownTableCell('a\rb')).toBe('a\rb');
    expect(escapeMarkdownTableCell('a\rb', { carriageReturn: 'drop' })).toBe('ab');
  });
});
