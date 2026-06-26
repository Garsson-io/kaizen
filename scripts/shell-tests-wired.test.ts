import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

/**
 * Category-prevention test for #806.
 *
 * A shell test file (`*.test.sh`) that lives in the repo but is wired into no
 * runner silently rots: it passes locally, never runs in CI, and the code it
 * guards drifts unprotected. `scripts/auto-dent.test.sh` (66 tests over the
 * batch-state logic in `auto-dent-lib.sh`) was exactly this — added in
 * 14887d7 for #595/#748, referenced nowhere.
 *
 * This test fails if ANY tracked `*.test.sh` is not reachable from a CI
 * runner surface, so the next orphaned shell test is caught the moment it
 * lands rather than years later.
 */

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

/** All tracked `*.test.sh` files, repo-relative. */
function trackedShellTests(): string[] {
  const out = execFileSync('git', ['ls-files', '*.test.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out.split('\n').filter((l) => l.trim().length > 0);
}

/** Concatenated text of every CI workflow yml + package.json. */
function runnerSurfaceText(): string {
  const parts: string[] = [];
  const pkg = join(repoRoot, 'package.json');
  if (existsSync(pkg)) parts.push(readFileSync(pkg, 'utf8'));
  const wfDir = join(repoRoot, '.github', 'workflows');
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir)) {
      if (f.endsWith('.yml') || f.endsWith('.yaml')) {
        parts.push(readFileSync(join(wfDir, f), 'utf8'));
      }
    }
  }
  return parts.join('\n');
}

/**
 * A shell test is "wired" when a CI runner can reach it. Either:
 *  (a) it is auto-discovered by `run-all-tests.sh` — it lives in
 *      `.claude/hooks/tests/` and matches the `test-*.sh` glob — and that
 *      runner is itself invoked by ci.yml; or
 *  (b) its basename is referenced by name on a runner surface (package.json
 *      script or a workflow yml), i.e. it is explicitly plumbed in.
 */
function isWired(relPath: string, surface: string): boolean {
  const base = basename(relPath);
  const autoDiscovered =
    relPath.startsWith('.claude/hooks/tests/') && base.startsWith('test-');
  return autoDiscovered || surface.includes(base);
}

describe('shell tests are wired into CI (#806)', () => {
  it('every tracked *.test.sh is reachable from a CI runner', () => {
    const surface = runnerSurfaceText();
    const orphans = trackedShellTests().filter((p) => !isWired(p, surface));
    expect(
      orphans,
      `Orphaned shell test(s) — written but wired into no CI runner, so they ` +
        `silently rot (#806). Add them to package.json scripts or a CI ` +
        `workflow, or place them under .claude/hooks/tests/ as test-*.sh:\n  ` +
        orphans.join('\n  '),
    ).toEqual([]);
  });

  it('finds shell tests to check (guards against a vacuous pass)', () => {
    // If git ls-files ever returns nothing, the orphan check above is
    // trivially satisfied and proves nothing. Pin a non-empty expectation.
    expect(trackedShellTests().length).toBeGreaterThan(0);
  });
});
