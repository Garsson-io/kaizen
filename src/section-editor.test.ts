import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { parseSections, listSections, readSection, addSection, replaceSection, removeSection } from './section-editor.js';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

const mockGh = vi.mocked(spawnSync);

function ghReturns(stdout: string) {
  mockGh.mockReturnValueOnce({ status: 0, stdout, stderr: '', signal: null, pid: 0, output: [null, stdout, ''] } as any);
}

function ghFails(stderr = 'error') {
  mockGh.mockReturnValueOnce({ status: 1, stdout: '', stderr, signal: null, pid: 0, output: [null, '', stderr] } as any);
}

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

const target = { kind: 'pr' as const, number: '903', repo: 'Garsson-io/kaizen' };

describe('listSections — fetches body and returns section names', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns section names from PR body', () => {
    ghReturns('## Plan\n\nContent.\n\n## Test Plan\n\nTests.');
    const names = listSections(target);
    expect(names).toEqual(['Plan', 'Test Plan']);
  });

  it('returns empty array for body with no sections', () => {
    ghReturns('Just text.');
    expect(listSections(target)).toEqual([]);
  });
});

describe('readSection — fetches body and returns one section', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns section content by name', () => {
    ghReturns('## Plan\n\n1. Do X\n\n## Test Plan\n\nRun tests.');
    const content = readSection(target, 'Plan');
    expect(content).toContain('Do X');
    expect(content).not.toContain('Run tests');
  });

  it('returns null for non-existent section', () => {
    ghReturns('## Plan\n\nContent.');
    expect(readSection(target, 'Missing')).toBeNull();
  });
});

describe('addSection — upserts a named section', () => {
  beforeEach(() => vi.clearAllMocks());

  it('appends new section when it does not exist', () => {
    ghReturns('## Plan\n\nOld plan.'); // fetchBody
    ghReturns(''); // writeBody (gh pr edit)
    addSection(target, 'Validation', 'Tests pass.');
    const writeCall = mockGh.mock.calls[1];
    const body = writeCall[1]![writeCall[1]!.indexOf('--body') + 1] as string;
    expect(body).toContain('## Plan');
    expect(body).toContain('## Validation');
    expect(body).toContain('Tests pass.');
  });

  it('replaces existing section', () => {
    ghReturns('## Plan\n\nOld plan.\n\n## Validation\n\nOld validation.\n\n## Notes\n\nStuff.'); // fetchBody
    ghReturns(''); // writeBody
    addSection(target, 'Validation', 'New validation.');
    const writeCall = mockGh.mock.calls[1];
    const body = writeCall[1]![writeCall[1]!.indexOf('--body') + 1] as string;
    expect(body).toContain('Old plan');
    expect(body).toContain('New validation');
    expect(body).not.toContain('Old validation');
    expect(body).toContain('Stuff');
  });
});

describe('replaceSection — replaces existing section or throws if missing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('replaces existing section content', () => {
    ghReturns('## Plan\n\nOld content.\n\n## Notes\n\nStay.'); // fetchBody
    ghReturns(''); // writeBody
    replaceSection(target, 'Plan', 'New content.');
    const writeCall = mockGh.mock.calls[1];
    const body = writeCall[1]![writeCall[1]!.indexOf('--body') + 1] as string;
    expect(body).toContain('New content');
    expect(body).not.toContain('Old content');
    expect(body).toContain('## Notes');
    expect(body).toContain('Stay');
  });

  it('throws when section does not exist', () => {
    ghReturns('## Plan\n\nContent.');
    expect(() => replaceSection(target, 'Missing', 'text')).toThrow('Section "Missing" not found');
  });
});

describe('removeSection — removes a named section', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes existing section', () => {
    ghReturns('## Plan\n\nKeep.\n\n## Draft\n\nRemove.\n\n## Notes\n\nAlso keep.'); // fetchBody
    ghReturns(''); // writeBody
    removeSection(target, 'Draft');
    const writeCall = mockGh.mock.calls[1];
    const body = writeCall[1]![writeCall[1]!.indexOf('--body') + 1] as string;
    expect(body).toContain('Keep');
    expect(body).toContain('Also keep');
    expect(body).not.toContain('Remove');
  });

  it('no-ops when section does not exist', () => {
    ghReturns('## Plan\n\nContent.');
    removeSection(target, 'Missing');
    expect(mockGh).toHaveBeenCalledTimes(1); // only fetchBody, no writeBody
  });
});
