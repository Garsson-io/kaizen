/**
 * git-state-invariant.test.ts — category-prevention lint for #240.
 *
 * Fails loudly if any hook in src/hooks/*.ts reads git state via a raw
 * execSync('git ...') call WITHOUT going through the git-state.ts primitive.
 * This is the mechanistic trigger for the sibling-hook migration tracked in
 * the follow-up sub-issue.
 *
 * The OPT_OUT list below names hooks whose migration is pending. Adding a
 * new hook that reads git state without routing through the lib will fail
 * this test; the remediation is either (a) migrate to git-state.ts or
 * (b) add to OPT_OUT with a linked follow-up issue.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOOKS_DIR = join(__dirname, '..');

// Hooks whose migration to git-state.ts is pending. Removing an entry here
// without migrating the hook will re-introduce the cwd-drift anti-pattern.
const OPT_OUT = new Set<string>([
  'bump-plugin-version.ts',
  'kaizen-reflect.ts',
  'hook-io.ts',
  'pr-kaizen-clear.ts',
  'pr-kaizen-clear-fallback.ts',
  'pr-review-loop.ts',
  'pre-push.ts',
  'prehook-no-verify.ts',
  'post-merge-clear.ts',
]);

function isHookSource(name: string): boolean {
  if (!name.endsWith('.ts')) return false;
  if (name.endsWith('.test.ts')) return false;
  return true;
}

function readsGitState(content: string): boolean {
  // Naive but sufficient: any execSync call whose args start with `git `
  // (with template literal or string literal). Excludes comments.
  const withoutComments = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  return /execSync\(\s*[`'"][^`'"]*git\s/.test(withoutComments);
}

function importsGitState(content: string): boolean {
  return /from\s+['"]\.\/lib\/git-state\.js['"]/.test(content);
}

describe('git-state invariant (#240 category prevention)', () => {
  const files = readdirSync(HOOKS_DIR)
    .filter(isHookSource);

  it('finds hook source files', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const f of files) {
    if (OPT_OUT.has(f)) continue;
    it(`${f} routes git-state reads through lib/git-state.ts (or does not read state)`, () => {
      const content = readFileSync(join(HOOKS_DIR, f), 'utf-8');
      if (!readsGitState(content)) return; // no violation possible
      expect(
        importsGitState(content),
        `${f} calls execSync('git ...') but does not import from ./lib/git-state.js. ` +
          `Route through the shared primitive or add to OPT_OUT with a tracked follow-up.`,
      ).toBe(true);
    });
  }

  it('OPT_OUT entries correspond to real files (no stale opt-outs)', () => {
    for (const f of OPT_OUT) {
      expect(files, `${f} in OPT_OUT is missing from src/hooks/`).toContain(f);
    }
  });
});
