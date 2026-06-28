import { describe, expect, it } from 'vitest';
import { hasYamlFrontmatterBlock, parseYamlFrontmatter, readYamlFrontmatter, stripYamlFrontmatter } from './frontmatter.js';

describe('parseYamlFrontmatter', () => {
  it('returns null when markdown has no leading YAML frontmatter', () => {
    expect(parseYamlFrontmatter('# Heading\n\nBody')).toBeNull();
  });

  it('returns null for malformed YAML without throwing', () => {
    const content = '---\nname: foo: bar\ndescription: nope\n---\nBody';
    expect(parseYamlFrontmatter(content)).toBeNull();
  });

  it('detects a CRLF frontmatter block even when its YAML is malformed', () => {
    const content = '---\r\nname: foo: bar\r\ndescription: nope\r\n---\r\nBody';

    expect(hasYamlFrontmatterBlock(content)).toBe(true);
    expect(parseYamlFrontmatter(content)).toBeNull();
  });

  it('parses frontmatter and preserves the markdown body', () => {
    const content = '---\nname: correctness\napplies_to: pr\nneeds: [diff, issue]\n---\nPrompt body\n';

    const parsed = parseYamlFrontmatter(content);

    expect(parsed).not.toBeNull();
    expect(parsed!.data).toEqual({
      name: 'correctness',
      applies_to: 'pr',
      needs: ['diff', 'issue'],
    });
    expect(parsed!.body).toBe('Prompt body\n');
  });

  it('accepts CRLF frontmatter delimiters', () => {
    const parsed = readYamlFrontmatter('---\r\nname: sentinel\r\napplies_to: both\r\n---\r\nBody');

    expect(parsed).toEqual({ name: 'sentinel', applies_to: 'both' });
  });

  it('strips YAML frontmatter and returns the markdown body', () => {
    const body = stripYamlFrontmatter('---\r\nname: prompt\r\n---\r\nBody\r\n');

    expect(body).toBe('Body\r\n');
  });

  it('leaves markdown without frontmatter unchanged', () => {
    expect(stripYamlFrontmatter('# Heading\n\nBody')).toBe('# Heading\n\nBody');
  });
});
