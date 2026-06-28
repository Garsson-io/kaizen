/**
 * cli-experiment-git-invariant.test.ts — focused category-prevention lint for #1334.
 *
 * The experiment CLI must resolve the worktree root through the shared
 * src/lib/resolve-project-root.ts (no-shell argv runner), never via its own
 * direct `git rev-parse --show-toplevel` subprocess. This is a source-text
 * ratchet: it fails the moment a future edit re-introduces the duplicated
 * Git-root path. Mirrors the gh-exec-invariant.test.ts (#1294) pattern.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI_SOURCE = join(__dirname, 'cli-experiment.ts');
const CLI_LIFECYCLE_TEST = join(__dirname, 'cli-experiment.test.ts');

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/** True when source (comments stripped) shells out to git directly. */
export function hasDirectGitSubprocessCall(content: string): boolean {
  const code = stripComments(content);

  // Any exec/execFile/spawn family call whose first string arg is `git ...`
  // or a literal that contains the toplevel lookup.
  if (/\bexec(?:Sync)?\s*\(\s*[`'"][^`'"]*\bgit\b/.test(code)) return true;
  if (/\b(?:execFile|spawn)(?:Sync)?\s*\(\s*[`'"]git[`'"]/.test(code)) return true;
  if (/git\s+rev-parse\s+--show-toplevel/.test(code)) return true;

  return false;
}

/** True when source imports execSync from child_process. */
export function importsExecSync(content: string): boolean {
  const code = stripComments(content);
  return /import\s*\{[^}]*\bexecSync\b[^}]*\}\s*from\s*['"]child_process['"]/.test(
    code,
  );
}

describe('cli-experiment git-subprocess invariant', () => {
  it('detects a direct git subprocess call in a synthetic fixture', () => {
    expect(
      hasDirectGitSubprocessCall("execSync('git rev-parse --show-toplevel')"),
    ).toBe(true);
    expect(
      hasDirectGitSubprocessCall("spawnSync('git', ['rev-parse'])"),
    ).toBe(true);
  });

  it('does not flag the shared resolver import', () => {
    const clean = "import { resolveProjectRoot } from './lib/resolve-project-root.js';\nresolveProjectRoot(process.cwd());";
    expect(hasDirectGitSubprocessCall(clean)).toBe(false);
  });

  it('detects an execSync import in a synthetic fixture', () => {
    expect(importsExecSync("import { execSync } from 'child_process';")).toBe(
      true,
    );
    expect(importsExecSync("import path from 'path';")).toBe(false);
  });

  it('cli-experiment.ts has no direct git subprocess call', () => {
    const content = readFileSync(CLI_SOURCE, 'utf-8');
    expect(hasDirectGitSubprocessCall(content)).toBe(false);
  });

  it('cli-experiment.ts does not import execSync', () => {
    const content = readFileSync(CLI_SOURCE, 'utf-8');
    expect(importsExecSync(content)).toBe(false);
  });

  it('cli-experiment.ts routes through the shared resolveProjectRoot', () => {
    const content = readFileSync(CLI_SOURCE, 'utf-8');
    expect(content).toMatch(/resolveProjectRoot/);
    expect(content).toMatch(/resolve-project-root/);
  });

  it('cli-experiment lifecycle tests do not duplicate this Git invariant', () => {
    const content = readFileSync(CLI_LIFECYCLE_TEST, 'utf-8');
    expect(content).not.toContain('git rev-parse --show-toplevel');
    expect(content).not.toContain('direct git execSync');
    expect(content).not.toContain('resolveProjectRoot(process.cwd())');
  });
});
