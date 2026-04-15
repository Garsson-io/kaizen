/**
 * enforce-plan-stored.test.ts — Adversarial tests for the plan enforcement hook.
 *
 * These tests prove that common agent subversion strategies are blocked:
 *   1. Skip store-plan entirely (the #1054 incident)
 *   2. Self-author plan during implementation session
 *   3. Store plan but not test plan
 *   4. Omit issue link to dodge the check
 *   5. Attempt to claim docs-only exception on source changes
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

/** Build a `gh pr create` command with a heredoc body. */
function ghPrCreate(body: string): string {
  return `gh pr create --title "feat: test" --body "$(cat <<'EOF'\n${body}\nEOF\n)"`;
}

// Substantive plan and test plan that pass all checks
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

/** Build deps with overrides. All defaults return "exists and valid". */
function makeDeps(overrides: Partial<PlanCheckDeps> = {}): PlanCheckDeps {
  return {
    retrievePlan: () => GOOD_PLAN,
    retrieveTestPlan: () => GOOD_TEST_PLAN,
    getPlanCommentCreatedAt: () => '2026-04-10T10:00:00Z',  // Plan created April 10
    getFirstBranchCommitTime: () => '2026-04-14T10:00:00Z', // Branch started April 14
    getChangedFiles: () => ['src/hooks/enforce-plan-stored.ts', 'src/hooks/enforce-plan-stored.test.ts'],
    getCurrentBranch: () => 'k1055-enforce-plan-stored',
    detectRepo: () => 'Garsson-io/kaizen',
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.KAIZEN_SKIP_PLAN_CHECK;
});

// ── Unit tests: extractors ──────────────────────────────────────────

describe('extractIssueNumber', () => {
  it('extracts from Closes #N', () => {
    expect(extractIssueNumber('Closes #1055')).toBe('1055');
  });

  it('extracts from Fixes #N (case insensitive)', () => {
    expect(extractIssueNumber('fixes #42')).toBe('42');
  });

  it('extracts from Resolves #N', () => {
    expect(extractIssueNumber('Resolves #100')).toBe('100');
  });

  it('extracts from heredoc body', () => {
    const cmd = ghPrCreate('## Summary\n\nDid stuff\n\nCloses #1055\nParent: #1028');
    expect(extractIssueNumber(cmd)).toBe('1055');
  });

  it('returns null when no issue reference', () => {
    expect(extractIssueNumber('gh pr create --title "test"')).toBeNull();
  });
});

describe('extractIssueFromBranch', () => {
  it('extracts from kNNN pattern', () => {
    expect(extractIssueFromBranch('k1055-enforce-plan')).toBe('1055');
  });

  it('extracts from feat/NNN pattern', () => {
    expect(extractIssueFromBranch('feat/123-new-feature')).toBe('123');
  });

  it('extracts from issue-NNN pattern', () => {
    expect(extractIssueFromBranch('fix/issue-42')).toBe('42');
  });

  it('returns null for unrecognized patterns', () => {
    expect(extractIssueFromBranch('main')).toBeNull();
    expect(extractIssueFromBranch('some-random-branch')).toBeNull();
  });
});

describe('isDocsOnly', () => {
  it('docs-only when only .md files changed', () => {
    expect(isDocsOnly(['docs/plan.md', 'README.md'])).toBe(true);
  });

  it('not docs-only when source files present', () => {
    expect(isDocsOnly(['docs/plan.md', 'src/hook.ts'])).toBe(false);
  });

  it('not docs-only for empty changeset', () => {
    expect(isDocsOnly([])).toBe(false);
  });
});

// ── Happy path ──────────────────────────────────────────────────────

describe('happy path — plan exists and predates implementation', () => {
  it('allows PR creation when plan + testplan exist and are fresh', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps());
    expect(result.allowed).toBe(true);
  });

  it('allows non-gh-pr-create commands unconditionally', () => {
    const result = checkPlanBeforePr('npm test', makeDeps());
    expect(result.allowed).toBe(true);
  });

  it('allows gh pr view (not create)', () => {
    const result = checkPlanBeforePr('gh pr view 42', makeDeps());
    expect(result.allowed).toBe(true);
  });
});

// ── Adversarial: Agent skips store-plan entirely (#1054 incident) ───

describe('ADVERSARIAL: agent skips store-plan entirely', () => {
  it('DENIES when no plan exists on the issue', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      retrievePlan: () => null,
      retrieveTestPlan: () => null,
      getPlanCommentCreatedAt: () => null,
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('plan');
    expect(result.missing).toContain('testplan');
    expect(result.reason).toContain('BLOCKED');
    expect(result.reason).toContain('I3');
    expect(result.reason).toContain('I8');
  });

  it('deny message includes recovery instructions', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      retrievePlan: () => null,
      retrieveTestPlan: () => null,
      getPlanCommentCreatedAt: () => null,
    }));
    expect(result.reason).toContain('/kaizen-write-plan');
    expect(result.reason).toContain('1055');
  });
});

// ── Adversarial: Agent stores plan but skips test plan ──────────────

describe('ADVERSARIAL: agent stores plan but skips test plan', () => {
  it('DENIES when plan exists but test plan is missing', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      retrieveTestPlan: () => null,
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('testplan');
    expect(result.missing).not.toContain('plan');
  });
});

// ── Adversarial: Agent self-authors plan during implementation ──────

describe('ADVERSARIAL: agent self-authors plan during implementation session', () => {
  it('DENIES when plan was created AFTER the first commit on the branch', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      // Plan was stored at 3pm, but first commit was at 2pm
      // → agent committed code first, THEN wrote the plan
      getPlanCommentCreatedAt: () => '2026-04-14T15:00:00Z',
      getFirstBranchCommitTime: () => '2026-04-14T14:00:00Z',
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('freshness');
    expect(result.reason).toContain('AFTER implementation started');
    expect(result.reason).toContain('independent planning');
  });

  it('DENIES when plan was created at exact same time as first commit', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      // Exact same timestamp — suspicious, deny
      getPlanCommentCreatedAt: () => '2026-04-14T14:00:00Z',
      getFirstBranchCommitTime: () => '2026-04-14T14:00:00Z',
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('freshness');
  });

  it('ALLOWS when plan predates the first commit by any margin', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      // Plan stored 1 second before first commit — legitimate
      getPlanCommentCreatedAt: () => '2026-04-14T13:59:59Z',
      getFirstBranchCommitTime: () => '2026-04-14T14:00:00Z',
    }));
    expect(result.allowed).toBe(true);
  });

  it('deny message explains the freshness violation clearly', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      getPlanCommentCreatedAt: () => '2026-04-14T16:00:00Z',
      getFirstBranchCommitTime: () => '2026-04-14T14:00:00Z',
    }));
    expect(result.reason).toContain('2026-04-14T16:00:00Z');
    expect(result.reason).toContain('2026-04-14T14:00:00Z');
    expect(result.reason).toContain('/kaizen-write-plan');
    expect(result.reason).toContain('NEW session');
  });
});

// ── Adversarial: Agent omits issue link to dodge the check ──────────

describe('ADVERSARIAL: agent omits issue link to dodge plan check', () => {
  it('DENIES when no issue number found in command or branch', () => {
    const cmd = 'gh pr create --title "sneaky PR" --body "no issue link here"';
    const result = checkPlanBeforePr(cmd, makeDeps({
      getCurrentBranch: () => 'some-random-branch',
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('issue-link');
    expect(result.reason).toContain('Closes #N');
  });

  it('falls back to branch name when body has no Closes #N', () => {
    const cmd = 'gh pr create --title "PR without closes" --body "did stuff"';
    const result = checkPlanBeforePr(cmd, makeDeps({
      getCurrentBranch: () => 'k1055-enforce-plan',
    }));
    // Should find issue 1055 from branch name and check plan
    expect(result.allowed).toBe(true);
  });
});

// ── Adversarial: Agent claims docs-only to skip the check ───────────

describe('ADVERSARIAL: agent claims docs-only exception on source changes', () => {
  it('docs-only exception only works when NO source files changed', () => {
    const cmd = ghPrCreate('Closes #1055');
    // Agent changed source files but tries to claim docs-only
    const result = checkPlanBeforePr(cmd, makeDeps({
      getChangedFiles: () => ['docs/readme.md', 'src/hooks/sneaky.ts'],
      retrievePlan: () => null,
    }));
    expect(result.allowed).toBe(false);
  });

  it('ALLOWS genuine docs-only PRs without plan', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      getChangedFiles: () => ['docs/plan.md', 'README.md', '.agents/kaizen/policies.md'],
      retrievePlan: () => null,
    }));
    expect(result.allowed).toBe(true);
  });
});

// ── Escape hatch ────────────────────────────────────────────────────

describe('escape hatch: KAIZEN_SKIP_PLAN_CHECK', () => {
  it('allows PR creation when escape hatch is set', () => {
    process.env.KAIZEN_SKIP_PLAN_CHECK = '1';
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      retrievePlan: () => null,
    }));
    expect(result.allowed).toBe(true);
  });

  it('does NOT escape when set to anything other than "1"', () => {
    process.env.KAIZEN_SKIP_PLAN_CHECK = 'true';
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      retrievePlan: () => null,
      retrieveTestPlan: () => null,
      getPlanCommentCreatedAt: () => null,
    }));
    expect(result.allowed).toBe(false);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────

describe('edge cases', () => {
  it('skips freshness check when no commits on branch yet', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      getFirstBranchCommitTime: () => null,
    }));
    // Plan exists, testplan exists, no commits to compare against — allow
    expect(result.allowed).toBe(true);
  });

  it('skips freshness check when plan timestamp unavailable', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      getPlanCommentCreatedAt: () => null,
    }));
    // Plan exists but can't get timestamp — allow (fail-open on metadata)
    expect(result.allowed).toBe(true);
  });

  it('handles --repo flag in command', () => {
    const cmd = 'gh pr create --repo Garsson-io/other-repo --title "test" --body "Closes #42"';
    const result = checkPlanBeforePr(cmd, makeDeps({
      retrievePlan: (issue, repo) => {
        // Verify the repo was correctly extracted from the command
        expect(repo).toBe('Garsson-io/other-repo');
        return GOOD_PLAN;
      },
    }));
    // Plan exists in the specified repo
    expect(result.allowed).toBe(true);
  });

  it('fails open when repo cannot be determined', () => {
    const cmd = 'gh pr create --title "test" --body "Closes #42"';
    const result = checkPlanBeforePr(cmd, makeDeps({
      detectRepo: () => '',
    }));
    expect(result.allowed).toBe(true);
  });

  it('handles piped commands with gh pr create', () => {
    const cmd = 'gh pr create --title "test" --body "Closes #42" && echo "done"';
    const result = checkPlanBeforePr(cmd, makeDeps());
    // Should still detect gh pr create and run checks
    expect(result.allowed).toBe(true);
  });
});

// ── Regression: the exact #1054 scenario ────────────────────────────

describe('REGRESSION: exact #1054 scenario — agent skips artifacts entirely', () => {
  it('blocks the PR that started #1054', () => {
    // The agent in #1054:
    //   1. Skipped store-plan and store-testplan entirely
    //   2. Wrote the test plan directly in the PR body table
    //   3. Claimed "Manual: Verified" for CLI commands never run
    const cmd = ghPrCreate(
      '## Summary\n\n' +
      'Added hook-gym replay + fixtures\n\n' +
      '## Test Plan\n\n' +
      '| # | Behavior | Verified |\n' +
      '|---|----------|----------|\n' +
      '| 1 | Replay works | Manual: Verified |\n\n' +
      'Closes #1054',
    );

    const result = checkPlanBeforePr(cmd, makeDeps({
      // No plan stored on the issue — agent put it in PR body instead
      retrievePlan: () => null,
      retrieveTestPlan: () => null,
      getPlanCommentCreatedAt: () => null,
    }));

    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('plan');
    expect(result.missing).toContain('testplan');
    // The deny message should guide the agent to use the proper workflow
    expect(result.reason).toContain('/kaizen-write-plan');
  });
});

// ── Adversarial: Agent stores plan then immediately starts coding ───

describe('ADVERSARIAL: agent stores plan and starts coding in same session', () => {
  it('DENIES when plan was stored 5 minutes after first commit', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      // Agent committed at 2pm, stored plan at 2:05pm
      getPlanCommentCreatedAt: () => '2026-04-14T14:05:00Z',
      getFirstBranchCommitTime: () => '2026-04-14T14:00:00Z',
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('freshness');
  });

  it('DENIES when plan was stored hours after implementation started', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      // Agent started coding at 10am, remembered to store plan at 3pm
      getPlanCommentCreatedAt: () => '2026-04-14T15:00:00Z',
      getFirstBranchCommitTime: () => '2026-04-14T10:00:00Z',
    }));
    expect(result.allowed).toBe(false);
  });

  it('ALLOWS when plan was stored days before implementation', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      // Write-plan session on April 10, implement session on April 14
      getPlanCommentCreatedAt: () => '2026-04-10T10:00:00Z',
      getFirstBranchCommitTime: () => '2026-04-14T10:00:00Z',
    }));
    expect(result.allowed).toBe(true);
  });
});

// ── Substance checks (unit) ────────────────────────────────────────

describe('checkPlanSubstance', () => {
  const NUMBERED_PLAN = `## Plan

1. Refactor the auth module to support OIDC
2. Add token refresh logic with exponential backoff
3. Wire up the new auth provider in the DI container
4. Update integration tests to cover OIDC flow

## Rollout
5. Update docs with new auth configuration`;

  const HEADING_PLAN = `# Test Plan — Issue #1047

## Perspectives
- Code-author — things work
- Operator — things run
- CI — things test

## Behaviors

### L1 — formatTimeline shape
Pure function test.

### L2 — cmdRun rejects unknown scenarios
Error handling test.

### L3 — cmdRun enforces timeout
Timeout behavior test.`;

  it('passes a numbered-steps plan', () => {
    expect(checkPlanSubstance(NUMBERED_PLAN)).toEqual([]);
  });

  it('passes a heading-item plan (real kaizen format)', () => {
    expect(checkPlanSubstance(HEADING_PLAN)).toEqual([]);
  });

  it('fails a trivial one-liner', () => {
    const failures = checkPlanSubstance('## Plan\n\nDo the thing.');
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some(f => f.includes('too short'))).toBe(true);
  });

  it('fails when no headings at all', () => {
    const failures = checkPlanSubstance('1. Do X\n2. Do Y\n3. Do Z\n' + 'x'.repeat(200));
    expect(failures.some(f => f.includes('heading'))).toBe(true);
  });

  it('fails when fewer than 3 items', () => {
    const failures = checkPlanSubstance('## Plan\n\n## Details\n\n1. Do X\n2. Do Y\n' + 'x'.repeat(200));
    expect(failures.some(f => f.includes('too few'))).toBe(true);
  });
});

describe('checkTestPlanSubstance', () => {
  const GOOD_TEST_PLAN = `## Test Plan

| # | Behavior | Level |
|---|----------|-------|
| 1 | Auth flow completes | Integration |
| 2 | Token refresh on 401 | Unit |
| 3 | Config validation | Unit |`;

  it('passes a substantive test plan', () => {
    expect(checkTestPlanSubstance(GOOD_TEST_PLAN)).toEqual([]);
  });

  it('fails without a table', () => {
    const failures = checkTestPlanSubstance('## Test Plan\n\nJust test stuff.');
    expect(failures.some(f => f.includes('table'))).toBe(true);
  });

  it('fails without test levels mentioned', () => {
    const failures = checkTestPlanSubstance(
      '## Test Plan\n\n| # | Behavior | Done |\n|---|----------|------|\n| 1 | thing | yes |\n| 2 | other | yes |',
    );
    expect(failures.some(f => f.includes('test levels'))).toBe(true);
  });

  it('fails without any test plan header', () => {
    const failures = checkTestPlanSubstance(
      '| # | Behavior | Level |\n|---|----------|-------|\n| 1 | thing | Unit |',
    );
    expect(failures.some(f => f.includes('header'))).toBe(true);
  });
});

// ── ADVERSARIAL: Agent stores a rubber-stamp plan ───────────────────

describe('ADVERSARIAL: agent stores a trivial rubber-stamp plan', () => {
  it('DENIES when plan is just "## Plan\\nDo the thing"', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      retrievePlan: () => '## Plan\n\nDo the thing.',
      retrieveTestPlan: () => '## Test Plan\n\n| # | Behavior | Level |\n|---|----------|-------|\n| 1 | It works | Unit |',
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('plan-substance');
  });

  it('DENIES when test plan has no table', () => {
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      retrieveTestPlan: () => '## Test Plan\n\nAll tests pass. Trust me.',
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('testplan-substance');
  });

  it('DENIES when agent spawns subagent that writes minimal plan', () => {
    // Agent spawns subagent: "write a plan for issue #1055"
    // Subagent produces minimal content to pass existence check
    const cmd = ghPrCreate('Closes #1055');
    const result = checkPlanBeforePr(cmd, makeDeps({
      retrievePlan: () => '## Plan\n\n1. Implement the feature\n2. Test it',
      retrieveTestPlan: () => '## Test Plan\n\nManual: Verified',
    }));
    expect(result.allowed).toBe(false);
    // Both should fail substance checks
    expect(result.missing!.some(m => m.includes('substance'))).toBe(true);
  });
});

// ── REAL-WORLD: Replay actual PR data against the hook ──────────────

describe('REAL-WORLD: replay actual merged PRs against the hook', () => {
  it('PR #1043 (plan stored 3 min AFTER first commit) → DENIED by freshness', () => {
    // Real data: plan created 2026-04-13T16:02:37Z, first commit 2026-04-13T15:59:19Z
    const cmd = ghPrCreate('Closes #1042');
    const result = checkPlanBeforePr(cmd, makeDeps({
      getPlanCommentCreatedAt: () => '2026-04-13T16:02:37Z',
      getFirstBranchCommitTime: () => '2026-04-13T15:59:19Z',
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('freshness');
  });

  it('PR #1030 (plan stored day AFTER implementation started) → DENIED by freshness', () => {
    // Real data: plan 2026-04-13T10:19:46Z, first commit 2026-04-12T13:41:06Z
    const cmd = ghPrCreate('Closes #1034');
    const result = checkPlanBeforePr(cmd, makeDeps({
      getPlanCommentCreatedAt: () => '2026-04-13T10:19:46Z',
      getFirstBranchCommitTime: () => '2026-04-12T13:41:06Z',
    }));
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain('freshness');
  });

  it('PR #1049 (plan stored 9 min BEFORE first commit) → ALLOWED', () => {
    // Real data: plan 2026-04-13T16:52:13Z, first commit 2026-04-13T17:01:16Z
    const cmd = ghPrCreate('Closes #1047');
    const result = checkPlanBeforePr(cmd, makeDeps({
      getPlanCommentCreatedAt: () => '2026-04-13T16:52:13Z',
      getFirstBranchCommitTime: () => '2026-04-13T17:01:16Z',
    }));
    expect(result.allowed).toBe(true);
  });

  it('PR #1054 (no Closes #N, branch has no parseable issue) → DENIED by missing issue-link', () => {
    // PR #1054 had no Closes #N, only Parent: #1028
    // Branch name uses + separator which doesn't match extractIssueFromBranch patterns
    // This is a real failure mode: agent doesn't use Closes #N
    const cmd = ghPrCreate('## Summary\n\nReplay fixtures\n\nParent: #1028');
    const result = checkPlanBeforePr(cmd, makeDeps({
      getCurrentBranch: () => 'worktree-feat+k1028-replay-fixtures',
      retrievePlan: () => null,
      retrieveTestPlan: () => null,
      getPlanCommentCreatedAt: () => null,
    }));
    expect(result.allowed).toBe(false);
    // Denied at the issue-link gate — can't even check for a plan
    expect(result.missing).toContain('issue-link');
  });
});
