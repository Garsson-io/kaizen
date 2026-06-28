import { describe, expect, it } from 'vitest';
import { firstMarkdownFence, markdownFences } from './markdown-fence.js';

describe('markdownFences', () => {
  it('extracts every matching fenced code block by language', () => {
    const blocks = markdownFences(
      [
        'before',
        '```json',
        '{"one":1}',
        '```',
        'middle',
        '```yaml',
        'two: 2',
        '```',
        'after',
      ].join('\n'),
      'json',
    );

    expect(blocks).toEqual([{ language: 'json', code: '{"one":1}' }]);
  });

  it('accepts CRLF fences and language labels with whitespace/case differences', () => {
    const block = firstMarkdownFence('prefix\r\n``` JSON \r\n{"ok":true}\r\n```\r\nsuffix', 'json');

    expect(block).toEqual({ language: 'JSON', code: '{"ok":true}' });
  });
});
