import { describe, it, expect } from 'vitest';
import { runExperiment, formatReport } from './run-scenarios.js';
import {
  FailureMode,
  type DiffScenario,
  type ReflectionScenario,
  type PRHistoryScenario,
  type Scenario,
} from './types.js';

/**
 * Integration test: runs ALL synthetic scenarios through the experiment runner
 * and proves that detectors catch what they should while avoiding false positives.
 *
 * This is the "autoresearch experiment" — the before/after proof that the
 * failure mode detectors work. Each scenario is tagged with:
 * - targetMode: which FM it tests
 * - expectDetection: true for known-bad, false for known-good
 *
 * The report shows detection rates and false positive rates per FM.
 */

// ============================================================
// Scenario definitions: known-bad (expect detection)
// ============================================================

const BAD_DRY_CROSS_FILE: DiffScenario = {
  kind: 'diff',
  name: 'Cross-file DRY violation (PR #434 pattern)',
  description: 'Three test files with identical 5-line mock setup blocks',
  targetMode: FailureMode.DRY_VIOLATION,
  expectDetection: true,
  files: [
    {
      path: 'tests/hook-a.test.ts',
      additions: [
        'const deps = makeDeps({',
        '  exec: vi.fn().mockReturnValue(""),',
        '  readFile: vi.fn().mockReturnValue("{}"),',
        '  writeFile: vi.fn(),',
        '  existsSync: vi.fn().mockReturnValue(true),',
        '});',
        'runHookA(deps);',
      ],
      deletions: [],
      rawDiff: '',
    },
    {
      path: 'tests/hook-b.test.ts',
      additions: [
        'const deps = makeDeps({',
        '  exec: vi.fn().mockReturnValue(""),',
        '  readFile: vi.fn().mockReturnValue("{}"),',
        '  writeFile: vi.fn(),',
        '  existsSync: vi.fn().mockReturnValue(true),',
        '});',
        'runHookB(deps);',
      ],
      deletions: [],
      rawDiff: '',
    },
  ],
};

const BAD_STALE_REF: DiffScenario = {
  kind: 'diff',
  name: 'Stale reference after rename (PR #416 pattern)',
  description: 'Hook renamed from accept-case to kaizen-evaluate but old name in added code',
  targetMode: FailureMode.STALE_REFERENCE,
  expectDetection: true,
  files: [
    {
      path: '.claude/hooks/test-evaluate.sh',
      additions: [
        'echo "Testing accept-case hook"',
        'run_hook accept-case "$INPUT"',
      ],
      deletions: [],
      rawDiff: '',
    },
  ],
  renamedSymbols: [{ old: 'accept-case', new: 'kaizen-evaluate' }],
};

const BAD_ENV_GIT_STATUS: DiffScenario = {
  kind: 'diff',
  name: 'git status without -C (issue #232)',
  description: 'Hook uses git status from CWD instead of target directory',
  targetMode: FailureMode.ENV_ASSUMPTION,
  expectDetection: true,
  files: [
    {
      path: '.claude/hooks/check-dirty.sh',
      additions: [
        '#!/bin/bash',
        'FILES=$(git status --porcelain)',
        'if [ -n "$FILES" ]; then exit 1; fi',
      ],
      deletions: [],
      rawDiff: '',
    },
  ],
};

const BAD_ENV_HARDCODED_PATH: DiffScenario = {
  kind: 'diff',
  name: 'Hardcoded home path (issue #219)',
  description: 'Script hardcodes /home/username/ path',
  targetMode: FailureMode.ENV_ASSUMPTION,
  expectDetection: true,
  files: [
    {
      path: 'scripts/setup.sh',
      additions: [
        'CONFIG_DIR="/home/aviadr1/projects/kaizen/.config"',
      ],
      deletions: [],
      rawDiff: '',
    },
  ],
};

const BAD_REFLECTION_GENERIC_WAIVER: ReflectionScenario = {
  kind: 'reflection',
  name: 'Generic "overengineering" waiver (issue #258)',
  description: 'Agent waives finding with "overengineering" rationalization',
  targetMode: FailureMode.REFLECTION_GAMING,
  expectDetection: true,
  impediments: [
    {
      finding: 'Bootstrap counter uses L1 enforcement for L2 policy',
      disposition: 'waived',
      reason: 'Fixing this would be overengineering for current scope',
    },
  ],
};

const BAD_REFLECTION_ALL_WAIVED: ReflectionScenario = {
  kind: 'reflection',
  name: 'All findings waived (100% avoidance)',
  description: 'Every finding is no-action with no real filings',
  targetMode: FailureMode.REFLECTION_GAMING,
  expectDetection: true,
  impediments: [
    {
      finding: 'Hook should validate JSON more strictly',
      type: 'positive',
      disposition: 'no-action',
      reason: 'Acceptable tradeoff for simplicity',
    },
    {
      finding: 'Test coverage could be higher for edge cases',
      type: 'positive',
      disposition: 'no-action',
      reason: 'Self-correcting — will be caught in next review',
    },
  ],
};

const BAD_MULTI_PR_RAPID_FIX: PRHistoryScenario = {
  kind: 'pr-history',
  name: 'Rapid-fire fix PRs (PRs #418-421 pattern)',
  description: '4 fix PRs in 21 minutes for plugin manifest',
  targetMode: FailureMode.MULTI_PR_FIX_CYCLE,
  expectDetection: true,
  prs: [
    {
      number: 418,
      title: 'fix: marketplace.json author field',
      mergedAt: '2026-03-21T22:22:28Z',
      changedFiles: ['marketplace.json'],
      additions: 1,
      deletions: 1,
      labels: [],
      linkedIssues: [],
    },
    {
      number: 419,
      title: 'fix: plugin.json paths',
      mergedAt: '2026-03-21T22:33:33Z',
      changedFiles: ['plugin.json'],
      additions: 0,
      deletions: 0,
      labels: [],
      linkedIssues: [],
    },
    {
      number: 420,
      title: 'fix: remove symlink',
      mergedAt: '2026-03-21T22:38:31Z',
      changedFiles: ['.kaizen'],
      additions: 0,
      deletions: 1,
      labels: [],
      linkedIssues: [],
    },
    {
      number: 421,
      title: 'fix: plugin.json agents type',
      mergedAt: '2026-03-21T22:43:02Z',
      changedFiles: ['plugin.json'],
      additions: 1,
      deletions: 1,
      labels: [],
      linkedIssues: [],
    },
  ],
};

const BAD_SCOPE_CUT: DiffScenario = {
  kind: 'diff',
  name: 'Source without tests (FM4 scope cut)',
  description: '50+ lines of new source code with no test file changes',
  targetMode: FailureMode.SCOPE_CUT_TESTABILITY,
  expectDetection: true,
  files: [
    {
      path: 'src/hooks/new-enforcement.ts',
      additions: new Array(50).fill('const x = processInput(data);'),
      deletions: [],
      rawDiff: '',
    },
  ],
};

const BAD_FILED_WHEN_FIXABLE: ReflectionScenario = {
  kind: 'reflection',
  name: 'Trivial gitignore fix filed as issue instead of fixed-in-pr (#450)',
  description: 'Agent filed a 1-line gitignore fix as a separate issue instead of fixing it in the PR',
  targetMode: FailureMode.FILED_WHEN_FIXABLE,
  expectDetection: true,
  impediments: [
    {
      finding: '.claude/kaizen/audit/ not in .gitignore — dirty file every session',
      disposition: 'filed',
      ref: '#450',
    },
    {
      finding: 'Self-review caught DRY violation',
      type: 'positive',
      disposition: 'no-action',
      reason: 'Review criteria working as designed',
    },
  ],
};

// ============================================================
// Scenario definitions: known-good (expect NO detection)
// ============================================================

const GOOD_DRY_UNIQUE_CODE: DiffScenario = {
  kind: 'diff',
  name: 'Unique code across files (clean)',
  description: 'Different functions in different files — no duplication',
  targetMode: FailureMode.DRY_VIOLATION,
  expectDetection: false,
  files: [
    {
      path: 'src/a.ts',
      additions: ['export function processA(input: string) { return input.toUpperCase(); }'],
      deletions: [],
      rawDiff: '',
    },
    {
      path: 'src/b.ts',
      additions: ['export function processB(count: number) { return count * 2; }'],
      deletions: [],
      rawDiff: '',
    },
  ],
};

const GOOD_RENAME_COMPLETE: DiffScenario = {
  kind: 'diff',
  name: 'Complete rename (clean)',
  description: 'All references updated to new name',
  targetMode: FailureMode.STALE_REFERENCE,
  expectDetection: false,
  files: [
    {
      path: '.claude/hooks/test-evaluate.sh',
      additions: [
        'echo "Testing kaizen-evaluate hook"',
        'run_hook kaizen-evaluate "$INPUT"',
      ],
      deletions: [],
      rawDiff: '',
    },
  ],
  renamedSymbols: [{ old: 'accept-case', new: 'kaizen-evaluate' }],
};

const GOOD_ENV_WITH_C_FLAG: DiffScenario = {
  kind: 'diff',
  name: 'git status with -C flag (clean)',
  description: 'Hook correctly uses -C to target specific directory',
  targetMode: FailureMode.ENV_ASSUMPTION,
  expectDetection: false,
  files: [
    {
      path: '.claude/hooks/check-dirty.sh',
      additions: [
        '#!/bin/bash',
        'FILES=$(git -C "$TARGET_DIR" status --porcelain)',
      ],
      deletions: [],
      rawDiff: '',
    },
  ],
};

const GOOD_REFLECTION_HIGH_QUALITY: ReflectionScenario = {
  kind: 'reflection',
  name: 'High-quality reflection with filed issues (clean)',
  description: '2 filed issues with refs, 1 positive finding — good reflection',
  targetMode: FailureMode.REFLECTION_GAMING,
  expectDetection: false,
  impediments: [
    {
      finding: 'Hook test infrastructure needs DRY refactoring — 3 test files share identical setup',
      type: 'meta',
      disposition: 'filed',
      ref: '#430',
    },
    {
      finding: 'Post-merge gate clearing was ambiguous, causing gate-type confusion',
      disposition: 'fixed-in-pr',
    },
    {
      finding: 'E2E test harness validated investment — caught git config issue before CI',
      type: 'positive',
      disposition: 'no-action',
      reason: 'Pattern working as designed',
    },
  ],
};

const GOOD_PR_HISTORY_NORMAL: PRHistoryScenario = {
  kind: 'pr-history',
  name: 'Normal PR history — different features, spread out (clean)',
  description: 'Unrelated PRs with no overlapping files or issues',
  targetMode: FailureMode.MULTI_PR_FIX_CYCLE,
  expectDetection: false,
  prs: [
    {
      number: 100,
      title: 'feat: add new hook',
      mergedAt: '2026-03-10T10:00:00Z',
      changedFiles: ['src/hooks/new.ts'],
      additions: 100,
      deletions: 0,
      labels: [],
      linkedIssues: [50],
    },
    {
      number: 101,
      title: 'feat: update docs',
      mergedAt: '2026-03-12T10:00:00Z',
      changedFiles: ['CLAUDE.md'],
      additions: 20,
      deletions: 5,
      labels: [],
      linkedIssues: [60],
    },
  ],
};

const GOOD_FILED_COMPLEX: ReflectionScenario = {
  kind: 'reflection',
  name: 'Complex impediment correctly filed (clean for FM8)',
  description: 'Architectural issue correctly filed as separate issue — not trivially fixable',
  targetMode: FailureMode.FILED_WHEN_FIXABLE,
  expectDetection: false,
  impediments: [
    {
      finding: 'Hook enforcement system needs redesign for parallel gate clearing across worktrees',
      disposition: 'filed',
      ref: '#500',
    },
  ],
};

// ============================================================
// All scenarios
// ============================================================

const ALL_SCENARIOS: Scenario[] = [
  // Known-bad (expect detection)
  BAD_DRY_CROSS_FILE,
  BAD_STALE_REF,
  BAD_ENV_GIT_STATUS,
  BAD_ENV_HARDCODED_PATH,
  BAD_REFLECTION_GENERIC_WAIVER,
  BAD_REFLECTION_ALL_WAIVED,
  BAD_MULTI_PR_RAPID_FIX,
  BAD_SCOPE_CUT,
  BAD_FILED_WHEN_FIXABLE,
  // Known-good (expect no detection)
  GOOD_DRY_UNIQUE_CODE,
  GOOD_RENAME_COMPLETE,
  GOOD_ENV_WITH_C_FLAG,
  GOOD_REFLECTION_HIGH_QUALITY,
  GOOD_PR_HISTORY_NORMAL,
  GOOD_FILED_COMPLEX,
];

// ============================================================
// Tests
// ============================================================

describe('Experiment Runner — full scenario suite', () => {
  const report = runExperiment(ALL_SCENARIOS);

  it('all scenarios pass (detectors match expectations)', () => {
    const failures = report.scenarios.filter((s) => !s.passed);
    if (failures.length > 0) {
      const failList = failures
        .map(
          (f) =>
            `  - ${f.scenario.name}: expected ${f.scenario.expectDetection ? 'detection' : 'clean'}, got ${f.detections.length} detections`,
        )
        .join('\n');
      expect.fail(`${failures.length} scenarios failed:\n${failList}`);
    }
  });

  it('detection rate is 100% for all tested failure modes', () => {
    for (const [fm, rate] of Object.entries(report.detectionRate)) {
      if (rate.total > 0) {
        expect(rate.rate, `${fm} detection rate`).toBe(1);
      }
    }
  });

  it('false positive rate is 0% for all tested failure modes', () => {
    for (const [fm, rate] of Object.entries(report.falsePositiveRate)) {
      if (rate.total > 0) {
        expect(rate.caught, `${fm} false positives`).toBe(0);
      }
    }
  });

  it('report formats as valid markdown', () => {
    const md = formatReport(report);
    expect(md).toContain('## Failure Mode Detection Report');
    expect(md).toContain('Detection Rates');
    expect(md).toContain('False Positive Rates');
    // Should not have any failed scenarios section
    expect(md).not.toContain('Failed Scenarios');
  });
});

describe('Experiment Runner — individual scenario validation', () => {
  const report = runExperiment(ALL_SCENARIOS);

  it('FM1 DRY violation detected in cross-file scenario', () => {
    const result = report.scenarios.find(
      (s) => s.scenario.name === BAD_DRY_CROSS_FILE.name,
    );
    expect(result?.passed).toBe(true);
    expect(result?.detections.length).toBeGreaterThan(0);
  });

  it('FM6 stale reference detected after rename', () => {
    const result = report.scenarios.find(
      (s) => s.scenario.name === BAD_STALE_REF.name,
    );
    expect(result?.passed).toBe(true);
  });

  it('FM5 env assumptions detected (both git status and hardcoded path)', () => {
    const gitResult = report.scenarios.find(
      (s) => s.scenario.name === BAD_ENV_GIT_STATUS.name,
    );
    const pathResult = report.scenarios.find(
      (s) => s.scenario.name === BAD_ENV_HARDCODED_PATH.name,
    );
    expect(gitResult?.passed).toBe(true);
    expect(pathResult?.passed).toBe(true);
  });

  it('FM3 reflection gaming detected (waiver + all-waived)', () => {
    const waiverResult = report.scenarios.find(
      (s) => s.scenario.name === BAD_REFLECTION_GENERIC_WAIVER.name,
    );
    const allWaivedResult = report.scenarios.find(
      (s) => s.scenario.name === BAD_REFLECTION_ALL_WAIVED.name,
    );
    expect(waiverResult?.passed).toBe(true);
    expect(allWaivedResult?.passed).toBe(true);
  });

  it('FM2 multi-PR cycle detected in rapid-fire fix chain', () => {
    const result = report.scenarios.find(
      (s) => s.scenario.name === BAD_MULTI_PR_RAPID_FIX.name,
    );
    expect(result?.passed).toBe(true);
  });
});
