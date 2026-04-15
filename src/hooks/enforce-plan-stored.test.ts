/**
 * enforce-plan-stored.test.ts — Adversarial tests for the plan enforcement hook.
 *
 * These tests prove that common agent subversion strategies are blocked:
 *   1. Skip store-plan entirely (the #1054 incident)
 *   2. Store plan but not test plan
 *   3. Store a rubber-stamp plan
 *   4. Omit issue link to dodge the check
 *   5. Claim docs-only exception on source changes
 *
 * Each test injects fake deps so no GitHub or git calls are made.
 */

import { describe, expect, it, afterEach } from 'vitest';
import {
  checkPlanBeforePr,
  extractIssueNumber,
  extractIssueFromBranch,
  isDocsOnly,
  checkPlanSubstance,
  checkTestPlanSubstance,
  type PlanCheckDeps,
} from './enforce-plan-stored.js';

// ── Helpers ─────────────────────────────────────────────────────────

function ghPrCreate(body: string): string {
  return `gh pr create --title "feat: test" --body "$(cat <<'EOF'\n${body}\nEOF\n)"`;
}

const GOOD_PLAN = `## Plan

1. Refactor the auth module to support OIDC token flow
2. Add token refresh logic with exponential backoff
3. Wire up the new auth provider in the dependency injection container
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

function makeDeps(overrides: Partial<PlanCheckDeps> = {}): PlanCheckDeps {
  return {
    retrievePlan: () => GOOD_PLAN,
    retrieveTestPlan: () => GOOD_TEST_PLAN,
    getChangedFiles: () => ['src/hooks/enforce-plan-stored.ts', 'src/hooks/enforce-plan-stored.test.ts'],
    getCurrentBranch: () => 'k1055-enforce-plan-stored',
    detectRepo: () => 'Garsson-io/kaizen',
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.KAIZEN_SKIP_PLAN_CHECK;
});

// ── Extractors ──────────────────────────────────────────────────────

describe('extractIssueNumber', () => {
  it('extracts from Closes #N', () => expect(extractIssueNumber('Closes #1055')).toBe('1055'));
  it('extracts from Fixes #N', () => expect(extractIssueNumber('fixes #42')).toBe('42'));
  it('extracts from Resolves #N', () => expect(extractIssueNumber('Resolves #100')).toBe('100'));
  it('extracts from heredoc body', () => {
    expect(extractIssueNumber(ghPrCreate('Closes #1055\nParent: #1028'))).toBe('1055');
  });
  it('returns null when no issue reference', () => expect(extractIssueNumber('no ref')).toBeNull());
});

describe('extractIssueFromBranch', () => {
  it('kNNN', () => expect(extractIssueFromBranch('k1055-enforce-plan')).toBe('1055'));
  it('feat/NNN', () => expect(extractIssueFromBranch('feat/123-new')).toBe('123'));
  it('issue-NNN', () => expect(extractIssueFromBranch('fix/issue-42')).toBe('42'));
  it('null for unrecognized', () => expect(extractIssueFromBranch('main')).toBeNull());
});

describe('isDocsOnly', () => {
  it('true for only .md files', () => expect(isDocsOnly(['docs/plan.md', 'README.md'])).toBe(true));
  it('false with source files', () => expect(isDocsOnly(['docs/plan.md', 'src/hook.ts'])).toBe(false));
  it('false for empty', () => expect(isDocsOnly([])).toBe(false));
});

// ── Happy path ──────────────────────────────────────────────────────

describe('happy path', () => {
  it('allows when plan + testplan exist and pass substance', () => {
    expect(checkPlanBeforePr(ghPrCreate('Closes #1055'), makeDeps()).allowed).toBe(true);
  });
  it('allows non-pr-create commands', () => {
    expect(checkPlanBeforePr('npm test', makeDeps()).allowed).toBe(true);
  });
  it('allows gh pr view', () => {
    expect(checkPlanBeforePr('gh pr view 42', makeDeps()).allowed).toBe(true);
  });
});

// ── ADVERSARIAL: skip store-plan entirely (#1054) ───────────────────

describe('ADVERSARIAL: skip store-plan entirely', () => {
  it('DENIES when no plan exists', () => {
    const result = checkPlanBeforePr(ghPrCreate('Closes #1055'), makeDeps({
      retrievePlan: () => null, retrieveTestPlan: () => null,
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('plan');
    expect(result.missing).toContain('testplan');
    expect(result.reason).toContain('BLOCKED');
  });

  it('deny message includes recovery instructions', () => {
    const result = checkPlanBeforePr(ghPrCreate('Closes #1055'), makeDeps({
      retrievePlan: () => null, retrieveTestPlan: () => null,
    }));
    expect(result.reason).toContain('/kaizen-write-plan');
    expect(result.reason).toContain('1055');
  });
});

// ── ADVERSARIAL: plan exists but no test plan ───────────────────────

describe('ADVERSARIAL: plan but no test plan', () => {
  it('DENIES when test plan is missing', () => {
    const result = checkPlanBeforePr(ghPrCreate('Closes #1055'), makeDeps({
      retrieveTestPlan: () => null,
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('testplan');
    expect(result.missing).not.toContain('plan');
  });
});

// ── ADVERSARIAL: omit issue link ────────────────────────────────────

describe('ADVERSARIAL: omit issue link to dodge check', () => {
  it('DENIES when no issue found', () => {
    const result = checkPlanBeforePr(
      'gh pr create --title "sneaky" --body "no issue"',
      makeDeps({ getCurrentBranch: () => 'random-branch' }),
    );
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('issue-link');
  });

  it('falls back to branch name', () => {
    const result = checkPlanBeforePr(
      'gh pr create --title "no closes" --body "stuff"',
      makeDeps({ getCurrentBranch: () => 'k1055-enforce-plan' }),
    );
    expect(result.allowed).toBe(true);
  });
});

// ── ADVERSARIAL: claim docs-only ────────────────────────────────────

describe('ADVERSARIAL: claim docs-only on source changes', () => {
  it('docs-only exception fails when source files changed', () => {
    const result = checkPlanBeforePr(ghPrCreate('Closes #1055'), makeDeps({
      getChangedFiles: () => ['docs/readme.md', 'src/hooks/sneaky.ts'],
      retrievePlan: () => null,
    }));
    expect(result.allowed).toBe(false);
  });

  it('allows genuine docs-only PRs', () => {
    const result = checkPlanBeforePr(ghPrCreate('Closes #1055'), makeDeps({
      getChangedFiles: () => ['docs/plan.md', 'README.md'],
      retrievePlan: () => null,
    }));
    expect(result.allowed).toBe(true);
  });
});

// ── ADVERSARIAL: rubber-stamp plan ──────────────────────────────────

describe('ADVERSARIAL: rubber-stamp plan', () => {
  it('DENIES trivial one-liner plan', () => {
    const result = checkPlanBeforePr(ghPrCreate('Closes #1055'), makeDeps({
      retrievePlan: () => '## Plan\n\nDo the thing.',
      retrieveTestPlan: () => GOOD_TEST_PLAN,
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('plan-substance');
  });

  it('DENIES test plan without table', () => {
    const result = checkPlanBeforePr(ghPrCreate('Closes #1055'), makeDeps({
      retrieveTestPlan: () => '## Test Plan\n\nAll tests pass. Trust me.',
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('testplan-substance');
  });

  it('DENIES minimal subagent-authored plan', () => {
    const result = checkPlanBeforePr(ghPrCreate('Closes #1055'), makeDeps({
      retrievePlan: () => '## Plan\n\n1. Implement the feature\n2. Test it',
      retrieveTestPlan: () => '## Test Plan\n\nManual: Verified',
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing!.some(m => m.includes('substance'))).toBe(true);
  });
});

// ── Substance checks (unit) ────────────────────────────────────────

describe('checkPlanSubstance', () => {
  it('passes numbered plan with headings', () => {
    expect(checkPlanSubstance(GOOD_PLAN)).toEqual([]);
  });

  it('passes heading-item plan (kaizen format)', () => {
    const headingPlan = `# Test Plan — Issue #1047\n\n## Perspectives\n- Code-author — verify correctness\n- Operator — verify it runs\n- CI — verify it tests\n\n## Behaviors\n\n### L1 — formatTimeline shape\nPure function test with assertions.\n\n### L2 — cmdRun rejects unknowns\nError handling validation.\n\n### L3 — cmdRun timeout\nTimeout behavior verification.`;
    expect(checkPlanSubstance(headingPlan)).toEqual([]);
  });

  it('fails trivial stub', () => {
    expect(checkPlanSubstance('## Plan\n\nDo it.').some(f => f.includes('too short'))).toBe(true);
  });

  it('fails no headings', () => {
    expect(checkPlanSubstance('1. A\n2. B\n3. C\n' + 'x'.repeat(200)).some(f => f.includes('heading'))).toBe(true);
  });
});

describe('checkTestPlanSubstance', () => {
  it('passes table format', () => {
    expect(checkTestPlanSubstance(GOOD_TEST_PLAN)).toEqual([]);
  });

  it('fails without table or behavior headings', () => {
    expect(checkTestPlanSubstance('## Test Plan\n\nJust test.').some(f => f.includes('table'))).toBe(true);
  });

  it('fails without test levels', () => {
    expect(checkTestPlanSubstance('## Test Plan\n\n| # | B | D |\n|---|---|---|\n| 1 | x | y |').some(f => f.includes('levels'))).toBe(true);
  });
});

// ── Escape hatch ────────────────────────────────────────────────────

describe('escape hatch', () => {
  it('KAIZEN_SKIP_PLAN_CHECK=1 allows through', () => {
    process.env.KAIZEN_SKIP_PLAN_CHECK = '1';
    expect(checkPlanBeforePr(ghPrCreate('Closes #1055'), makeDeps({ retrievePlan: () => null })).allowed).toBe(true);
  });

  it('KAIZEN_SKIP_PLAN_CHECK=true does NOT escape', () => {
    process.env.KAIZEN_SKIP_PLAN_CHECK = 'true';
    expect(checkPlanBeforePr(ghPrCreate('Closes #1055'), makeDeps({ retrievePlan: () => null, retrieveTestPlan: () => null })).allowed).toBe(false);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────

describe('edge cases', () => {
  it('--repo flag extracted from command', () => {
    const result = checkPlanBeforePr(
      'gh pr create --repo Garsson-io/other --title "t" --body "Closes #42"',
      makeDeps({ retrievePlan: (_, repo) => { expect(repo).toBe('Garsson-io/other'); return GOOD_PLAN; } }),
    );
    expect(result.allowed).toBe(true);
  });

  it('fails open when repo unknown', () => {
    expect(checkPlanBeforePr('gh pr create --title "t" --body "Closes #42"', makeDeps({ detectRepo: () => '' })).allowed).toBe(true);
  });
});

// ── REGRESSION: exact #1054 scenario ────────────────────────────────

describe('REGRESSION: #1054 — agent skips artifacts', () => {
  it('blocks the PR that caused #1054', () => {
    const cmd = ghPrCreate(
      '## Summary\n\nReplay fixtures\n\n## Test Plan\n\n| # | Behavior | Verified |\n|---|----------|----------|\n| 1 | Replay works | Manual: Verified |\n\nCloses #1054',
    );
    const result = checkPlanBeforePr(cmd, makeDeps({
      retrievePlan: () => null, retrieveTestPlan: () => null,
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('plan');
    expect(result.reason).toContain('/kaizen-write-plan');
  });
});
