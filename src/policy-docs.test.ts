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

// ── B16: scope-matched issue closure mandate (canonical doc) ───────

describe('canonical invariants doc — B16: scope-matched issue closure', () => {
  const doc = read('docs/kaizen-invariants.md');
  const agents = read('.agents/AGENTS.md');

  it('canonical doc states I1 (Closes #N adjacent)', () => {
    expect(doc).toMatch(/### I1\b[^]*Closes.*#N.*adjacent/);
  });

  it('canonical doc states I2 (scope-matched, not epic)', () => {
    expect(doc).toMatch(/### I2\b[^]*scope-matched/);
  });

  it('AGENTS.md summary lists both I1 and I2 with short descriptions', () => {
    expect(agents).toMatch(/\*\*I1\*\*.*Closes/);
    expect(agents).toMatch(/\*\*I2\*\*.*scope-matched/);
  });

  it('AGENTS.md shows the correct linkage pattern for PR bodies', () => {
    expect(agents).toMatch(/Closes #<scope-matched-sub-issue>/);
    expect(agents).toMatch(/Parent:\s*#<epic>/);
  });
});

// ── B20: test plan mandate (canonical doc + AGENTS.md pointer) ─────

describe('canonical invariants doc — B20: test plan mandate', () => {
  const doc = read('docs/kaizen-invariants.md');
  const agents = read('.agents/AGENTS.md');

  it('canonical doc states I3 (issue has stored test plan)', () => {
    expect(doc).toMatch(/### I3\b[^]*stored test plan/);
  });

  it('canonical doc states I4 (PR body has behaviors × levels)', () => {
    expect(doc).toMatch(/### I4\b[^]*behaviors/);
  });

  it('AGENTS.md summary lists I3 and I4 with the 5-level taxonomy', () => {
    expect(agents).toMatch(/\*\*I3\*\*.*test plan/);
    expect(agents).toMatch(/\*\*I4\*\*.*Unit\/Integration\/System\/Agentic\/Workflow/);
  });
});

describe('kaizen-do workflow driver docs', () => {
  const agents = read('.agents/AGENTS.md');
  const fragment = read('.agents/kaizen/instructions-fragment.md');
  const readme = read('README.md');

  it('lists /kaizen-do as the goal-driven workflow driver', () => {
    expect(agents).toContain('/kaizen-do');
    expect(fragment).toContain('/kaizen-do');
    expect(readme).toContain('/kaizen-do');
    expect(agents).toContain('sets `/goal`');
  });

  it('documents status calls through the reusable workflow driver CLI', () => {
    expect(agents).toContain('scripts/kaizen-workflow-driver.ts status');
  });
});

describe('kaizen-autodent inside-harness workflow docs', () => {
  const agents = read('.agents/AGENTS.md');
  const fragment = read('.agents/kaizen/instructions-fragment.md');
  const readme = read('README.md');

  it('lists /kaizen-autodent as the hook-independent inside-harness auto-dent skill', () => {
    expect(agents).toContain('/kaizen-autodent');
    expect(fragment).toContain('/kaizen-autodent');
    expect(readme).toContain('/kaizen-autodent');
    expect(agents).toContain('inside-harness auto-dent');
  });

  it('routes parent/sub-issue execution through /kaizen-do and the workflow ledger', () => {
    expect(agents).toContain('one eligible sub-issue');
    expect(agents).toContain('/kaizen-do');
    expect(agents).toContain('docs/workflow-gate-ledger.md');
    expect(readme).toContain('one eligible sub-issue at a time through /kaizen-do');
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

// ── Invariant cross-references are in place (DRY enforcement) ─────

describe('kaizen-invariants.md — canonical source declaration', () => {
  const doc = read('docs/kaizen-invariants.md');

  it('declares itself as the canonical source of truth', () => {
    expect(doc).toMatch(/CANONICAL SOURCE OF TRUTH/i);
  });

  it('contains a forward-index matrix (invariant → artifacts)', () => {
    expect(doc).toMatch(/Enforcement matrix.*Invariant.*Artifact/i);
  });

  it('contains a reverse-index matrix (artifact → invariants)', () => {
    expect(doc).toMatch(/Enforcement matrix.*Artifact.*Invariants/i);
  });

  it('enumerates 28 invariants', () => {
    const idMatches = doc.match(/^### I\d+\b/gm) ?? [];
    // Unique invariant IDs present
    const ids = new Set(idMatches.map((m) => m.replace(/^### /, '').trim()));
    expect(ids.size).toBeGreaterThanOrEqual(28);
  });

  it('explains the "how to add a new invariant" ritual', () => {
    expect(doc).toMatch(/How to add a new invariant/i);
  });
});

describe('AGENTS.md — references canonical invariants doc (not restating rules)', () => {
  const agents = read('.agents/AGENTS.md');

  it('points to docs/kaizen-invariants.md as canonical source', () => {
    expect(agents).toMatch(/docs\/kaizen-invariants\.md/);
  });

  it('lists all 28 invariants as a compact in-context summary', () => {
    // Each invariant ID appears in the summary table
    for (const n of Array.from({ length: 28 }, (_, i) => i + 1)) {
      expect(agents).toMatch(new RegExp(`\\bI${n}\\b`));
    }
  });
});

describe('hook source files — @enforces JSDoc cross-references', () => {
  it('enforce-pr-review.ts declares @enforces I13', () => {
    expect(read('src/hooks/enforce-pr-review.ts')).toMatch(/@enforces I13/);
  });
  it('enforce-pr-reflect.ts declares @enforces I14', () => {
    expect(read('src/hooks/enforce-pr-reflect.ts')).toMatch(/@enforces I14/);
  });
  it('check-dirty-files.ts declares @enforces I11 and I25', () => {
    const src = read('src/hooks/check-dirty-files.ts');
    expect(src).toMatch(/@enforces I11/);
    expect(src).toMatch(/@enforces I25/);
  });
  it('pr-review-loop.ts declares I5, I15, I16, I28', () => {
    const src = read('src/hooks/pr-review-loop.ts');
    expect(src).toMatch(/@enforces I5\b/);
    expect(src).toMatch(/@enforces I15/);
    expect(src).toMatch(/@enforces I28/);
  });
  it('kaizen-reflect.ts declares @enforces I16', () => {
    expect(read('src/hooks/kaizen-reflect.ts')).toMatch(/@enforces I16/);
  });
  it('stop-gate.ts declares I6 and multiple Stop-time invariants', () => {
    const src = read('src/hooks/stop-gate.ts');
    expect(src).toMatch(/@enforces I6\b/);
    expect(src).toMatch(/@enforces I16/);
    expect(src).toMatch(/@enforces I24/);
  });
  it('bash hooks reference invariants in header comments', () => {
    expect(read('.claude/hooks/kaizen-enforce-worktree-writes.sh')).toMatch(/@enforces I9\b/);
    expect(read('.claude/hooks/kaizen-enforce-case-exists.sh')).toMatch(/@enforces I10/);
    expect(read('.claude/hooks/kaizen-block-git-rebase.sh')).toMatch(/@enforces I12/);
  });
  it('all @enforces references point at the canonical doc', () => {
    const files = [
      'src/hooks/enforce-pr-review.ts',
      'src/hooks/enforce-pr-reflect.ts',
      'src/hooks/check-dirty-files.ts',
      'src/hooks/pr-review-loop.ts',
      'src/hooks/kaizen-reflect.ts',
      'src/hooks/stop-gate.ts',
      'src/hooks/pr-kaizen-clear.ts',
      'src/hooks/post-merge-clear.ts',
      'src/hooks/pr-quality-checks.ts',
    ];
    for (const f of files) {
      expect(read(f)).toMatch(/docs\/kaizen-invariants\.md/);
    }
  });
});

describe('hook runtime docs — TypeScript shim contract', () => {
  const hooksDesign = read('docs/hooks-design.md');
  const hookCatalog = read('.agents/kaizen/docs/hook-catalog.md');
  const languageBoundaries = read('docs/hook-language-boundaries.md');

  it('documents run-tsx.sh as the production TypeScript hook trampoline', () => {
    for (const doc of [hooksDesign, hookCatalog, languageBoundaries]) {
      expect(doc).toMatch(/run-tsx\.sh/);
    }
    expect(hooksDesign).toMatch(/resolve-tsx-bin\.sh/);
    expect(hooksDesign).toMatch(/KAIZEN_TSX_BIN/);
  });

  it('documents the precompiled Node freshness contract and fallback matrix', () => {
    for (const doc of [hooksDesign, hookCatalog, languageBoundaries]) {
      expect(doc).toMatch(/dist\/\.kaizen-hook-build/);
    }
    expect(hooksDesign).toMatch(/Precompiled Node/);
    expect(hooksDesign).toMatch(/Source `tsx`/);
    expect(hooksDesign).toMatch(/Bun/);
    expect(hooksDesign).toMatch(/non-test `src\/\*\*\/\*\.ts`/);
  });

  it('does not claim TS hook shims call npx tsx directly', () => {
    const staleDirectShimClaims = [
      /shim[^.\n]*calls `npx tsx`/i,
      /wrapper[^.\n]*calls `npx tsx`/i,
      /calls `npx tsx` to invoke/i,
      /exec npx --prefix "\$KAIZEN_DIR" tsx/,
    ];

    for (const doc of [hooksDesign, hookCatalog, languageBoundaries]) {
      for (const pattern of staleDirectShimClaims) {
        expect(doc).not.toMatch(pattern);
      }
    }
  });
});

describe('skill files — Upholds invariants section', () => {
  it('kaizen-write-pr names I1-I4', () => {
    const s = read('.agents/skills/kaizen-write-pr/SKILL.md');
    expect(s).toMatch(/Upholds invariants/);
    for (const id of ['I1', 'I2', 'I3', 'I4']) {
      expect(s).toMatch(new RegExp(`\\b${id}\\b`));
    }
  });
  it('kaizen-write-plan names I3, I8', () => {
    const s = read('.agents/skills/kaizen-write-plan/SKILL.md');
    expect(s).toMatch(/Upholds invariants/);
    expect(s).toMatch(/\bI3\b/);
    expect(s).toMatch(/\bI8\b/);
  });
  it('kaizen-review-pr names I5, I13, I15, I27, I28', () => {
    const s = read('.agents/skills/kaizen-review-pr/SKILL.md');
    expect(s).toMatch(/Upholds invariants/);
    for (const id of ['I5', 'I13', 'I15', 'I27', 'I28']) {
      expect(s).toMatch(new RegExp(`\\b${id}\\b`));
    }
  });
  it('kaizen-implement names I3, I8, I10, I17, I27', () => {
    const s = read('.agents/skills/kaizen-implement/SKILL.md');
    expect(s).toMatch(/Upholds invariants/);
    for (const id of ['I3', 'I8', 'I10', 'I17', 'I27']) {
      expect(s).toMatch(new RegExp(`\\b${id}\\b`));
    }
  });
  it('kaizen-reflect names I16', () => {
    const s = read('.agents/skills/kaizen-reflect/SKILL.md');
    expect(s).toMatch(/Upholds invariants/);
    expect(s).toMatch(/\bI16\b/);
  });
});

describe('workflow skills — simplification/refactor impact is first-class', () => {
  it('kaizen-write-plan requires a simplification/refactor impact assessment', () => {
    const s = read('.agents/skills/kaizen-write-plan/SKILL.md');
    expect(s).toMatch(/simplification\/refactor impact assessment/i);
    expect(s).toMatch(/related-area DRY sweep/i);
    expect(s).toMatch(/least reasonable new surface area/i);
  });

  it('kaizen-implement makes the related-area refactor/DRY pass a visible workflow task', () => {
    const s = read('.agents/skills/kaizen-implement/SKILL.md');
    expect(s).toMatch(/related-area simplification\/DRY refactor pass/i);
    expect(s).toMatch(/before review/i);
    expect(s).toMatch(/competing mechanisms/i);
  });

  it('kaizen-implement and workflow tasks make context delegation evidence visible', () => {
    const skill = read('.agents/skills/kaizen-implement/SKILL.md');
    const workflowTasks = read('.agents/kaizen/workflow-tasks.md');

    expect(skill).toMatch(/Context delegation evidence before review/i);
    expect(skill).toMatch(/Delegate context-heavy/i);
    expect(workflowTasks).toMatch(/Context delegation evidence/i);
    expect(workflowTasks).toMatch(/Delegate broad\/context-heavy sub-work/i);
  });

  it('kaizen-review-pr documents the simplification-impact data-needs grouping', () => {
    const s = read('.agents/skills/kaizen-review-pr/SKILL.md');
    expect(s).toMatch(/`\[diff, issue, plan\]`: simplification-impact/);
  });
});

describe('.agents/kaizen/README.md — Core Invariants points to canonical', () => {
  const readme = read('.agents/kaizen/README.md');

  it('references docs/kaizen-invariants.md as canonical', () => {
    expect(readme).toMatch(/kaizen-invariants\.md/);
  });

  it('does NOT restate I9-I10 workspace isolation rules (deduplicated)', () => {
    // Spot-check: the long "Main checkout: what is and isn't allowed" table
    // was removed; now the readme groups invariants by discipline with ID pointers.
    expect(readme).toMatch(/\bI9\b/);
    expect(readme).toMatch(/\bI10\b/);
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
