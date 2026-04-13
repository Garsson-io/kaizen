/**
 * policy-docs.test.ts — Assertions on canonical policy documents.
 *
 * Behaviors covered (from issue #1034 test plan):
 *   B16 — AGENTS.md mandates "every PR closes exactly one scope-matched issue"
 *          and lists WRONG patterns including `Closes #<epic>` and `Closes subtask of #<epic>`
 *   B17 — kaizen-write-pr SKILL.md has "Issue linkage (MANDATORY)" section with
 *          the GitHub closing-keyword table and the real #1029 incident
 *   B18 — prompts/review-requirements.md check #7 flags premature epic closure
 *   B20 — AGENTS.md mandates a behaviors × levels test plan using the 5-level taxonomy
 *   B21 — kaizen-write-pr step 8 retrieves test plan via retrieve-testplan and
 *          requires behaviors × levels in the PR body
 *
 * These are Unit-level tests: file content assertions, no I/O besides fs read,
 * no composition. They're cheap regression guards — if the policy text gets
 * edited away accidentally, these tests fail before the policy silently drifts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf-8');
}

// ── AGENTS.md — scope-matched issue closure (B16) ──────────────────

describe('AGENTS.md — B16: scope-matched issue closure mandate', () => {
  const agents = read('.agents/AGENTS.md');

  it('mandates every PR closes exactly one scope-matched issue', () => {
    expect(agents).toMatch(/Every PR MUST close exactly one scope-matched issue/);
  });

  it('forbids orphan PRs (no issue)', () => {
    expect(agents).toMatch(/[Oo]rphan PRs.*not accepted/);
  });

  it('explicitly forbids closing the epic', () => {
    expect(agents).toMatch(/Never write.*Closes.*#.*epic/i);
  });

  it('lists the GitHub closing keywords that trigger auto-close', () => {
    // At least the three main families
    expect(agents).toMatch(/Closes?|Close/);
    expect(agents).toMatch(/Fixes?|Fix/);
    expect(agents).toMatch(/Resolves?|Resolve/);
  });

  it('shows the correct pattern (Closes #child + Parent: #epic)', () => {
    expect(agents).toMatch(/Closes #<scope-matched-sub-issue>/);
    expect(agents).toMatch(/Parent:\s*#<epic>/);
  });
});

// ── AGENTS.md — test plan mandate (B20) ────────────────────────────

describe('AGENTS.md — B20: behaviors × levels test plan mandate', () => {
  const agents = read('.agents/AGENTS.md');

  it('mandates every PR include a test plan', () => {
    expect(agents).toMatch(/Every PR MUST include a test plan/);
  });

  it('names the 5-level taxonomy', () => {
    expect(agents).toMatch(/Unit.*Integration.*System.*Agentic.*Workflow/);
  });

  it('rejects "tests pass" as a plan', () => {
    expect(agents).toMatch(/["']Test plan.*tests pass["'].*NOT a test plan|["']Tests pass["'].*NOT a.*plan/i);
  });

  it('points to the write-plan skill for level assignment', () => {
    expect(agents).toContain('kaizen-write-plan');
  });
});

// ── kaizen-write-pr SKILL — Issue linkage (B17) ────────────────────

describe('kaizen-write-pr SKILL — B17: Issue linkage section', () => {
  const skill = read('.agents/skills/kaizen-write-pr/SKILL.md');

  it('has an Issue linkage (MANDATORY) section', () => {
    expect(skill).toMatch(/Issue linkage \(MANDATORY\)/);
  });

  it('includes the GitHub closing keywords table', () => {
    expect(skill).toMatch(/GitHub closing keywords/);
    expect(skill).toMatch(/close #N/);
    expect(skill).toMatch(/fixes #N/i);
    expect(skill).toMatch(/resolves #N/i);
  });

  it('shows correct vs wrong patterns', () => {
    expect(skill).toMatch(/Correct body patterns/);
    expect(skill).toMatch(/Wrong patterns/);
  });

  it('cites the #1029 real incident as a cautionary example', () => {
    expect(skill).toMatch(/#1029/);
    expect(skill).toMatch(/#1028/);
    expect(skill).toMatch(/epic/i);
  });

  it('warns about parser-ambiguous patterns like "Closes subtask of #N"', () => {
    expect(skill).toMatch(/Closes subtask of #/);
  });
});

// ── kaizen-write-pr SKILL — step 8 retrieves test plan (B21) ───────

describe('kaizen-write-pr SKILL — B21: step 8 retrieves test plan', () => {
  const skill = read('.agents/skills/kaizen-write-pr/SKILL.md');

  it('instructs using retrieve-testplan', () => {
    expect(skill).toMatch(/retrieve-testplan/);
  });

  it('requires a behaviors × levels section in the PR body', () => {
    expect(skill).toMatch(/Behaviors × Levels|behaviors × levels/i);
  });

  it('routes to /kaizen-write-plan if no test plan exists', () => {
    expect(skill).toMatch(/\/kaizen-write-plan/);
  });

  it('names the review dimensions that consume the test plan', () => {
    expect(skill).toMatch(/review-plan-coverage/);
    expect(skill).toMatch(/review-test-plan/);
    expect(skill).toMatch(/review-requirements/);
  });
});

// ── review-requirements.md — check #7 (B18) ────────────────────────

describe('review-requirements.md — B18: premature epic closure check', () => {
  const dim = read('prompts/review-requirements.md');

  it('has a dedicated premature-epic-closure check', () => {
    expect(dim).toMatch(/premature epic closure/i);
  });

  it('names the GitHub closing keywords it inspects', () => {
    expect(dim).toMatch(/close\/closes\/closed\/fix\/fixes\/fixed\/resolve\/resolves\/resolved/i);
  });

  it('flags closing an epic as FAIL', () => {
    expect(dim).toMatch(/epic.*FAIL/i);
  });

  it('flags the Closes-subtask-of pattern as parser-ambiguous', () => {
    expect(dim).toMatch(/Closes subtask of/);
  });

  it('requires verifying the closed issue via gh issue view', () => {
    expect(dim).toMatch(/gh issue view.*labels|labels.*gh issue view/);
  });
});

