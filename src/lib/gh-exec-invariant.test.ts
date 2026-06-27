/**
 * gh-exec-invariant.test.ts — category-prevention lint for #1294.
 *
 * Fails loudly if production TypeScript under src/ invokes the GitHub CLI directly
 * instead of routing through src/lib/gh-exec.ts.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

interface Violation {
  file: string;
}

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');
const CANONICAL_HELPER = 'src/lib/gh-exec.ts';

const OPT_OUT = new Set<string>([
  // stdin-based PR comment posting; migrate after gh-exec grows stdin support.
  'src/hooks/pr-kaizen-clear.ts',
  // PR quality hook still shells through an injected exec seam for gh metadata.
  'src/hooks/pr-quality-checks.ts',
  // Worktree cleanup still shells through an injected exec seam for gh PR lists.
  'src/worktree-du.ts',
]);

function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).replace(/\\/g, '/');
}

function isProductionTsFile(file: string): boolean {
  if (!file.endsWith('.ts')) return false;
  if (file.endsWith('.test.ts')) return false;
  if (file.endsWith('.d.ts')) return false;
  return true;
}

function collectProductionSrcFiles(dir: string = SRC_DIR): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [file, content] of collectProductionSrcFiles(fullPath)) {
        files.set(file, content);
      }
      continue;
    }

    const rel = repoRelative(fullPath);
    if (!isProductionTsFile(rel)) continue;
    if (rel === CANONICAL_HELPER) continue;
    files.set(rel, readFileSync(fullPath, 'utf-8'));
  }
  return files;
}

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function hasDirectGhSubprocessCall(content: string): boolean {
  const withoutComments = stripComments(content);

  if (/\bexec(?:Sync)?\s*\(\s*[`'"][^`'"]*\bgh\b/.test(withoutComments)) {
    return true;
  }

  if (/\bexecFile(?:Sync)?\s*\(\s*[`'"]gh[`'"]/.test(withoutComments)) {
    return true;
  }

  if (/\bspawn(?:Sync)?\s*\(\s*[`'"]gh[`'"]/.test(withoutComments)) {
    return true;
  }

  return false;
}

function findDirectGhViolations(files: Map<string, string>): Violation[] {
  return Array.from(files.entries())
    .filter(([, content]) => hasDirectGhSubprocessCall(content))
    .map(([file]) => ({ file }));
}

function unallowlistedViolations(
  violations: Violation[],
  allowlist: Set<string>,
): Violation[] {
  return violations.filter(v => !allowlist.has(v.file));
}

function staleAllowlistEntries(
  violations: Violation[],
  allowlist: Set<string>,
): string[] {
  const violationFiles = new Set(violations.map(v => v.file));
  return Array.from(allowlist).filter(f => !violationFiles.has(f));
}

describe('gh-exec invariant scanner', () => {
  it('detects direct gh subprocess calls in synthetic fixtures', () => {
    const violations = findDirectGhViolations(new Map([
      ['src/hooks/bad-shell.ts', "execSync(`gh pr view 1`)"],
      ['src/hooks/bad-argv.ts', "spawnSync('gh', ['pr', 'view', '1'])"],
      ['src/hooks/bad-injected-exec.ts', "deps.exec('gh pr list --state open')"],
    ]));

    expect(violations.map(v => v.file).sort()).toEqual([
      'src/hooks/bad-argv.ts',
      'src/hooks/bad-injected-exec.ts',
      'src/hooks/bad-shell.ts',
    ]);
  });

  it('fails when a direct gh caller is not allowlisted', () => {
    const violations = findDirectGhViolations(new Map([
      ['src/hooks/new-direct-gh.ts', "execSync('gh issue view 1')"],
    ]));

    expect(unallowlistedViolations(violations, OPT_OUT)).toEqual([
      { file: 'src/hooks/new-direct-gh.ts' },
    ]);
  });

  it('fails stale allowlist entries after migration', () => {
    const violations = findDirectGhViolations(new Map([
      ['src/hooks/pr-kaizen-clear.ts', "execSync('gh pr comment 1')"],
    ]));
    const allowlist = new Set([
      'src/hooks/pr-kaizen-clear.ts',
      'src/hooks/migrated.ts',
    ]);

    expect(staleAllowlistEntries(violations, allowlist)).toEqual([
      'src/hooks/migrated.ts',
    ]);
  });

  it('finds production source files and excludes the canonical helper', () => {
    const files = collectProductionSrcFiles();

    expect(files.size).toBeGreaterThan(50);
    expect(files.has(CANONICAL_HELPER)).toBe(false);
  });

  it('current production tree has no unallowlisted direct gh subprocess calls', () => {
    const violations = findDirectGhViolations(collectProductionSrcFiles());

    expect(unallowlistedViolations(violations, OPT_OUT)).toEqual([]);
  });

  it('OPT_OUT entries correspond to current direct-gh violations', () => {
    const violations = findDirectGhViolations(collectProductionSrcFiles());

    expect(staleAllowlistEntries(violations, OPT_OUT)).toEqual([]);
  });
});
