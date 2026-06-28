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
 * True when source (comments stripped) contains local YAML-frontmatter
 * delimiter split/parse logic. Two shapes are caught:
 *   (a) a regex literal frontmatter delimiter — `/^---\n`, `/---\n`,
 *       `/^---\r`, `/---\r` (the `^` anchor is optional);
 *   (b) a `.split`/`.match`/`.exec`/`.replace` call whose first argument
 *       opens with `---` (string or regex) — e.g. `content.split('---\n')`.
 * The shared template-string serializer (`` `---\n${yaml}\n---` ``) is NOT a
 * regex literal and is NOT a split/match/exec/replace argument, so it stays
 * clean. Broader than the canonical #1368 shape so a non-anchored or
 * string-split reintroduction can't slip past (tooling-fitness, PR #1371).
 */
export function hasLocalFrontmatterRegex(content: string): boolean {
  const code = stripComments(content);
  // (a) frontmatter regex literal: `/` then optional `^`, `---`, escaped \r|\n.
  if (/\/\^?-{3}\\[rn]/.test(code)) return true;
  // (b) split/match/exec/replace on a `---`-leading string or regex arg.
  if (/\.(?:split|match|exec|replace)\s*\(\s*[/'"`]\^?-{3}/.test(code)) {
    return true;
  }
  return false;
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

  it('detects non-anchored and string-split frontmatter forms', () => {
    // Non-anchored regex literal (no `^`).
    expect(
      hasLocalFrontmatterRegex('const RE = /---\\n([\\s\\S]*?)\\n---/;'),
    ).toBe(true);
    // String-split on the `---` delimiter.
    expect(
      hasLocalFrontmatterRegex("const parts = content.split('---\\n');"),
    ).toBe(true);
    expect(
      hasLocalFrontmatterRegex('const parts = content.split(/^---$/m);'),
    ).toBe(true);
  });

  it('does not flag the shared template-string serializer', () => {
    // serializeFrontmatter builds `---\n${yaml}\n---` — not a regex literal
    // and not a split/match/exec/replace argument.
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
