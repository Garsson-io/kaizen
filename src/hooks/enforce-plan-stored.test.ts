/**
 * enforce-plan-stored.test.ts — Tests for the plan enforcement hook.
 *
 * Uses the Case FE (CaseSystem) with an injected mock backend.
 * No GitHub or git calls are made.
 */

import { describe, expect, it, afterEach } from 'vitest';
import {
  checkPlanBeforePr,
  checkPlanBeforeEdit,
  extractIssueNumber,
  isDocsOnly,
  isSourceFile,
  checkPlanSubstance,
  checkTestPlanSubstance,
  type PlanCheckDeps,
} from './enforce-plan-stored.js';
import { CaseSystem, type CaseBackend } from '../case-system.js';
import type { Issue } from '../issue-backend.js';

// ── Mock backend ────────────────────────────────────────────────────

function mockBackend(overrides: Partial<CaseBackend> = {}): CaseBackend {
  return {
    name: 'mock',
    getIssue: () => ({ number: 1055, title: 'test', state: 'open', labels: [], body: '', url: '' }),
    retrievePlan: () => GOOD_PLAN,
    retrieveTestPlan: () => GOOD_TEST_PLAN,
    ...overrides,
  };
}

function makeDeps(backendOverrides: Partial<CaseBackend> = {}, depsOverrides: Partial<PlanCheckDeps> = {}): PlanCheckDeps {
  return {
    caseSystem: new CaseSystem(mockBackend(backendOverrides)),
    getChangedFiles: () => ['src/hooks/thing.ts'],
    getCurrentBranch: () => 'k1055-enforce-plan',
    detectRepo: () => 'Garsson-io/kaizen',
    isInWorktree: () => true,
    getWorktreeRoot: () => '/repo/.claude/worktrees/wt',
    getMainCheckout: () => '/repo',
    getDeclaredIssue: () => '1055',
    ...depsOverrides,
  };
}

const GOOD_PLAN = `## Plan

1. Refactor the auth module to support OIDC token flow
2. Add token refresh logic with exponential backoff
3. Wire up the new auth provider in the DI container
4. Update integration tests to cover the full OIDC flow
5. Update documentation with new auth configuration

## Test Plan

| # | Behavior | Level |
|---|----------|-------|
| 1 | Auth flow completes end-to-end | Integration |
| 2 | Token refresh on 401 response | Unit |
| 3 | Config validation rejects bad input | Unit |`;

const GOOD_TEST_PLAN = `## Test Plan

| # | Behavior | Level |
|---|----------|-------|
| 1 | Auth flow completes end-to-end | Integration |
| 2 | Token refresh on 401 response | Unit |
| 3 | Config validation rejects bad input | Unit |`;

function ghPrCreate(body: string): string {
  return `gh pr create --title "feat: test" --body "$(cat <<'EOF'\n${body}\nEOF\n)"`;
}

afterEach(() => { delete process.env.KAIZEN_SKIP_PLAN_CHECK; });

// ── Extractors ──────────────────────────────────────────────────────

describe('extractIssueNumber', () => {
  it('Closes #N', () => expect(extractIssueNumber('Closes #1055')).toBe('1055'));
  it('fixes #N', () => expect(extractIssueNumber('fixes #42')).toBe('42'));
  it('null when absent', () => expect(extractIssueNumber('no ref')).toBeNull());
});


// ── Gate 1: Edit/Write ──────────────────────────────────────────────

describe('checkPlanBeforeEdit', () => {
  it('allows when plan exists', () => {
    expect(checkPlanBeforeEdit('src/thing.ts', makeDeps()).allowed).toBe(true);
  });

  it('DENIES source edit when no plan', () => {
    const result = checkPlanBeforeEdit('src/thing.ts', makeDeps({ retrievePlan: () => null }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('BLOCKED');
    expect(result.reason).toContain('kaizen-write-plan');
  });

  it('allows non-source files even without plan', () => {
    expect(checkPlanBeforeEdit('docs/readme.md', makeDeps({ retrievePlan: () => null })).allowed).toBe(true);
  });

  it('allows when not in a worktree', () => {
    expect(checkPlanBeforeEdit('src/thing.ts', makeDeps({}, { isInWorktree: () => false })).allowed).toBe(true);
  });

  it('DENIES when no issue declared and not in branch (closes loophole)', () => {
    const result = checkPlanBeforeEdit('src/thing.ts', makeDeps({}, {
      getCurrentBranch: () => 'random-branch',
      getDeclaredIssue: () => null,
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('issue-link');
    expect(result.reason).toContain('git config kaizen.issue');
  });

  it('uses declared issue when branch name is ambiguous', () => {
    // Declared: 1055, branch has no issue marker
    const result = checkPlanBeforeEdit('src/thing.ts', makeDeps({}, {
      getCurrentBranch: () => 'random-branch',
      getDeclaredIssue: () => '1055',
    }));
    expect(result.allowed).toBe(true);
  });

  it('uses only declared issue (no branch parsing)', () => {
    let checkedIssue = 0;
    const result = checkPlanBeforeEdit('src/thing.ts', makeDeps({
      retrievePlan: (issue) => { checkedIssue = issue as unknown as number; return GOOD_PLAN; },
    }, {
      getCurrentBranch: () => 'k40-something', // branch has k40 — should be IGNORED
      getDeclaredIssue: () => '1055',
    }));
    expect(result.allowed).toBe(true);
    expect(checkedIssue).toBe(1055);
  });

  it('escape hatch works', () => {
    process.env.KAIZEN_SKIP_PLAN_CHECK = '1';
    expect(checkPlanBeforeEdit('src/thing.ts', makeDeps({ retrievePlan: () => null })).allowed).toBe(true);
  });

  it('suggests correct worktree path when agent writes to main checkout', () => {
    // Agent in worktree tries absolute path in main checkout
    const result = checkPlanBeforeEdit('/repo/src/thing.ts', makeDeps({ retrievePlan: () => null }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('main checkout');
    expect(result.reason).toContain('/repo/.claude/worktrees/wt/src/thing.ts');
  });

  it('does NOT add path hint when writing to worktree path correctly', () => {
    const result = checkPlanBeforeEdit('/repo/.claude/worktrees/wt/src/thing.ts', makeDeps({ retrievePlan: () => null }));
    expect(result.allowed).toBe(false);
    expect(result.reason).not.toContain('main checkout');
  });

  it('tells agent to wait for skill to complete', () => {
    const result = checkPlanBeforeEdit('src/thing.ts', makeDeps({ retrievePlan: () => null }));
    expect(result.reason).toContain('Wait for the skill to COMPLETE');
  });
});

// ── Gate 2: gh pr create ────────────────────────────────────────────

describe('checkPlanBeforePr', () => {
  it('allows when plan + testplan exist', () => {
    expect(checkPlanBeforePr(ghPrCreate('Closes #1055'), makeDeps()).allowed).toBe(true);
  });

  it('allows non-pr-create commands', () => {
    expect(checkPlanBeforePr('npm test', makeDeps()).allowed).toBe(true);
  });

  it('DENIES when no plan', () => {
    const result = checkPlanBeforePr(ghPrCreate('Closes #1055'), makeDeps({ retrievePlan: () => null }));
    expect(result.allowed).toBe(false);
  });

  it('DENIES when no testplan', () => {
    const result = checkPlanBeforePr(ghPrCreate('Closes #1055'), makeDeps({ retrieveTestPlan: () => null }));
    expect(result.allowed).toBe(false);
  });

  it('DENIES without issue link (no declaration, no Closes #N)', () => {
    const result = checkPlanBeforePr(
      'gh pr create --title "x" --body "no issue"',
      makeDeps({}, { getDeclaredIssue: () => null }),
    );
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('issue-link');
  });

  it('allows docs-only PRs without plan', () => {
    const result = checkPlanBeforePr(
      ghPrCreate('Closes #1055'),
      makeDeps({ retrievePlan: () => null }, { getChangedFiles: () => ['README.md'] }),
    );
    expect(result.allowed).toBe(true);
  });
});

// ── Substance checks ────────────────────────────────────────────────

describe('checkPlanSubstance', () => {
  it('passes good plan', () => expect(checkPlanSubstance(GOOD_PLAN)).toEqual([]));
  it('fails stub', () => expect(checkPlanSubstance('short').length).toBeGreaterThan(0));
});

describe('checkTestPlanSubstance', () => {
  it('passes good testplan', () => expect(checkTestPlanSubstance(GOOD_TEST_PLAN)).toEqual([]));
  it('fails without table', () => expect(checkTestPlanSubstance('## Test Plan\nno table').length).toBeGreaterThan(0));
});

// ── Source file detection (allowlist-based) ────────────────────────

describe('isSourceFile — allowlist design', () => {
  it('known docs/config are NOT source', () => {
    for (const f of ['README.md', 'config.yaml', 'package.json', 'docs/guide.md', 'data.csv', '.gitignore', 'LICENSE']) {
      expect(isSourceFile(f), f).toBe(false);
    }
  });
  it('unknown extensions are TREATED as source (robust to new languages)', () => {
    for (const f of ['main.ts', 'app.py', 'Main.kt', 'widget.vue', 'tool.ps1', 'script.lua', 'new.rs', 'lib.mjs', 'unknown.xyz']) {
      expect(isSourceFile(f), f).toBe(true);
    }
  });
  it('files with no extension default to source', () => {
    expect(isSourceFile('Makefile')).toBe(true);
    expect(isSourceFile('Dockerfile')).toBe(true);
  });
});

// ── Regression: #1054 ───────────────────────────────────────────────

describe('REGRESSION: #1054 — agent skips plan', () => {
  it('blocks PR with no stored plan', () => {
    const result = checkPlanBeforePr(
      ghPrCreate('## Summary\nstuff\n\nCloses #1054'),
      makeDeps({ retrievePlan: () => null, retrieveTestPlan: () => null }),
    );
    expect(result.allowed).toBe(false);
  });

  it('blocks first source edit with no stored plan', () => {
    const result = checkPlanBeforeEdit(
      'src/hooks/new-feature.ts',
      makeDeps({ retrievePlan: () => null }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('kaizen-write-plan');
  });
});
