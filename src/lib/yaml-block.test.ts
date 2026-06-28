import { describe, expect, it } from 'vitest';
import { hasLeadingDelimitedYamlBlock, parseDelimitedYamlBlocks, parseLeadingDelimitedYamlBlock } from './yaml-block.js';

describe('parseLeadingDelimitedYamlBlock', () => {
  it('parses a leading YAML block and preserves trailing body', () => {
    const parsed = parseLeadingDelimitedYamlBlock('---\nname: review\n---\nBody\n');

    expect(parsed).toEqual({
      data: { name: 'review' },
      body: 'Body\n',
      raw: '---\nname: review\n---\n',
    });
  });

  it('returns null when the leading YAML block is invalid', () => {
    expect(parseLeadingDelimitedYamlBlock('---\nname: nope: invalid\n---\nBody')).toBeNull();
  });

  it('detects a leading block with CRLF delimiters without parsing it', () => {
    expect(hasLeadingDelimitedYamlBlock('---\r\nname: nope: invalid\r\n---\r\nBody')).toBe(true);
    expect(hasLeadingDelimitedYamlBlock('# Heading\r\n---\r\nname: later\r\n---')).toBe(false);
  });
});

describe('parseDelimitedYamlBlocks', () => {
  it('parses every valid delimited YAML block from mixed text', () => {
    const blocks = parseDelimitedYamlBlocks([
      'prefix',
      '---',
      'hook: one',
      '---',
      'middle',
      '---',
      'hook: two',
      '---',
      'suffix',
    ].join('\n'));

    expect(blocks.map(block => block.data)).toEqual([{ hook: 'one' }, { hook: 'two' }]);
  });

  it('accepts CRLF delimiters in mixed output', () => {
    const blocks = parseDelimitedYamlBlocks('prefix\r\n---\r\nhook: crlf\r\n---\r\nsuffix');

    expect(blocks.map(block => block.data)).toEqual([{ hook: 'crlf' }]);
  });
});
