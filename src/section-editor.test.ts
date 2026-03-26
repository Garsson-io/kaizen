import { describe, it, expect } from 'vitest';
import { parseSections } from './section-editor.js';

describe('parseSections — pure markdown section parsing', () => {
  it('parses multiple ## sections', () => {
    const body = '## Plan\n\n1. Do A\n2. Do B\n\n## Test Plan\n\n- Run tests\n\n## Known Limitations\n\n1. Edge case X';
    const sections = parseSections(body);

    expect(sections).toHaveLength(3);
    expect(sections[0].name).toBe('Plan');
    expect(sections[0].content).toContain('Do A');
    expect(sections[0].content).not.toContain('Run tests');

    expect(sections[1].name).toBe('Test Plan');
    expect(sections[1].content).toContain('Run tests');
    expect(sections[1].content).not.toContain('Edge case');

    expect(sections[2].name).toBe('Known Limitations');
    expect(sections[2].content).toContain('Edge case X');
  });

  it('handles preamble before first ##', () => {
    const body = 'Some preamble text.\n\n## Section 1\n\nContent.';
    const sections = parseSections(body);

    expect(sections).toHaveLength(2);
    expect(sections[0].name).toBe('');
    expect(sections[0].content).toContain('preamble');
    expect(sections[1].name).toBe('Section 1');
  });

  it('handles body with no ## sections', () => {
    const body = 'Just a plain body with no sections.';
    const sections = parseSections(body);

    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe('');
    expect(sections[0].content).toBe('Just a plain body with no sections.');
  });

  it('handles empty body', () => {
    expect(parseSections('')).toHaveLength(0);
    expect(parseSections('  \n  ')).toHaveLength(0);
  });

  it('preserves section content including code blocks', () => {
    const body = '## Architecture\n\n```\nbox1 --> box2\n```\n\n## Design\n\nText.';
    const sections = parseSections(body);

    expect(sections[0].name).toBe('Architecture');
    expect(sections[0].content).toContain('box1 --> box2');
    expect(sections[1].name).toBe('Design');
  });

  it('does not split on ### (only ##)', () => {
    const body = '## Main\n\n### Sub 1\n\nContent 1.\n\n### Sub 2\n\nContent 2.\n\n## Other\n\nStuff.';
    const sections = parseSections(body);

    expect(sections).toHaveLength(2);
    expect(sections[0].name).toBe('Main');
    expect(sections[0].content).toContain('Sub 1');
    expect(sections[0].content).toContain('Sub 2');
    expect(sections[1].name).toBe('Other');
  });

  it('handles sections with special characters in names', () => {
    const body = '## Once upon a time...\n\nStory.\n\n## Because of that...\n\nConsequences.';
    const sections = parseSections(body);

    expect(sections).toHaveLength(2);
    expect(sections[0].name).toBe('Once upon a time...');
    expect(sections[1].name).toBe('Because of that...');
  });

  it('provides correct offsets for section replacement', () => {
    const body = '## A\n\nContent A.\n\n## B\n\nContent B.\n\n## C\n\nContent C.';
    const sections = parseSections(body);

    // Replacing section B using offsets should work
    const replacement = '## B\n\nNew content B.';
    const newBody = body.slice(0, sections[1].startOffset) + replacement + '\n\n' + body.slice(sections[1].endOffset);
    expect(newBody).toContain('Content A');
    expect(newBody).toContain('New content B');
    expect(newBody).toContain('Content C');
    expect(newBody).not.toContain('Content B.');
  });

  it('handles Story Spine PR body structure', () => {
    const body = [
      '## Once upon a time...\n\nThe system existed.',
      '## Every day...\n\nThings worked.',
      '## One day...\n\nSomething broke.',
      '## Because of that...\n\nWe fixed it.',
      '## Until finally...\n\nTests pass.',
      '## And ever since...\n\nThe world is better.',
      '## Architecture\n\n```\ndiagram\n```',
      '## Design decisions\n\n| D | W | T |',
      '## Validation\n\n- [x] Tests pass',
      '## Known limitations\n\n1. Thing',
    ].join('\n\n');

    const sections = parseSections(body);
    expect(sections).toHaveLength(10);
    expect(sections.map(s => s.name)).toEqual([
      'Once upon a time...',
      'Every day...',
      'One day...',
      'Because of that...',
      'Until finally...',
      'And ever since...',
      'Architecture',
      'Design decisions',
      'Validation',
      'Known limitations',
    ]);
  });
});
