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
  // bump-plugin-version.ts — migrated to git-state.ts (#1074)
  // hook-io.ts — migrated to git-state.ts (#1074)
  'pr-kaizen-clear.ts',
  'pr-kaizen-clear-fallback.ts',
  'pr-review-loop.ts',
  'pre-push.ts',
  'prehook-no-verify.ts',
  'enforce-plan-stored.ts',
  'pr-quality-checks.ts',
]);

function isHookSource(name: string): boolean {
  if (!name.endsWith('.ts')) return false;
  if (name.endsWith('.test.ts')) return false;
  return true;
}

function readsGitState(content: string): boolean {
  // Widened from the initial `execSync('git ...')` pattern to catch the
  // full family of subprocess-invoking APIs flagged in the #1073 review:
  // execSync, execFileSync, exec, spawnSync, spawn — with git as the
  // binary or first argument. We strip comments first so commented-out
  // examples don't trip the lint.
  const withoutComments = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  // Case 1: `execSync(\`git ...\`)` or `execSync('git ...')` — binary name
  // embedded in a shell-interpreted string. This IS the shell-injection
  // anti-pattern the primitive exists to eliminate.
  if (/exec(File)?(Sync)?\s*\(\s*[`'"][^`'"]*\bgit\b/.test(withoutComments)) return true;

  // Case 2: `spawnSync('git', argv)` / `execFileSync('git', argv)` —
  // argv-safe but still cwd-drift-prone unless the argv is built by
  // git-state.ts (which pins `-C <resolved-target>` as the first args).
  if (/(?:spawn|execFile)(?:Sync)?\s*\(\s*[`'"]git[`'"]/.test(withoutComments)) return true;

  return false;
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
