/**
 * cli-experiment-frontmatter-invariant.test.ts — focused category-prevention
 * lint for #1368.
 *
 * The experiment CLI must parse markdown YAML frontmatter through the shared
 * src/lib/frontmatter.ts helper (`parseYamlFrontmatter`), never via its own
 * local split regex. This is a source-text ratchet: it fails the moment a
 * future edit re-introduces a local `^---\n...---` frontmatter-delimiter
 * regex. Mirrors cli-experiment-git-invariant.test.ts (#1334) and the
 * gh-exec-invariant.test.ts (#1294) pattern.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI_SOURCE = join(__dirname, 'cli-experiment.ts');

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/**
 * True when source (comments stripped) contains a local YAML-frontmatter
 * delimiter regex — an anchored `/^---\n` or `/^---\r` regex literal.
 */
export function hasLocalFrontmatterRegex(content: string): boolean {
  const code = stripComments(content);
  // `/` `^` `---` then an escaped \r or \n — the shape every local
  // frontmatter splitter shares. The shared template-string serializer
  // (`---\n${yaml}\n---`) has no leading `/`, so it is not matched.
  return /\/\^-{3}\\[rn]/.test(code);
}

/** True when source imports the shared frontmatter helper. */
export function importsSharedFrontmatter(content: string): boolean {
  const code = stripComments(content);
  return /import\s*\{[^}]*\bparseYamlFrontmatter\b[^}]*\}\s*from\s*['"][^'"]*frontmatter(?:\.js)?['"]/.test(
    code,
  );
}

describe('cli-experiment frontmatter-parsing invariant', () => {
  it('detects a local frontmatter regex in a synthetic fixture', () => {
    expect(
      hasLocalFrontmatterRegex(
        'const m = content.match(/^---\\n([\\s\\S]*?)\\n---\\n([\\s\\S]*)$/);',
      ),
    ).toBe(true);
    expect(
      hasLocalFrontmatterRegex('const RE = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---/;'),
    ).toBe(true);
  });

  it('does not flag the shared template-string serializer', () => {
    // serializeFrontmatter builds `---\n${yaml}\n---` — no leading `/`.
    expect(
      hasLocalFrontmatterRegex('return `---\\n${yaml}\\n---`;'),
    ).toBe(false);
  });

  it('detects the shared frontmatter import in a synthetic fixture', () => {
    expect(
      importsSharedFrontmatter(
        "import { parseYamlFrontmatter } from './lib/frontmatter.js';",
      ),
    ).toBe(true);
    expect(importsSharedFrontmatter("import path from 'path';")).toBe(false);
  });

  it('cli-experiment.ts has no local frontmatter delimiter regex', () => {
    const content = readFileSync(CLI_SOURCE, 'utf-8');
    expect(hasLocalFrontmatterRegex(content)).toBe(false);
  });

  it('cli-experiment.ts routes through the shared frontmatter helper', () => {
    const content = readFileSync(CLI_SOURCE, 'utf-8');
    expect(importsSharedFrontmatter(content)).toBe(true);
    expect(content).toMatch(/parseYamlFrontmatter/);
  });
});
