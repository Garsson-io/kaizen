import { describe, it, expect } from 'vitest';
import {
  detectDryViolations,
  detectStaleReferences,
  detectEnvAssumptions,
  detectScopeCutTestability,
} from './diff-checks.js';
import { FailureMode, type DiffFile } from './types.js';

// ============================================================
// FM1: DRY Violation Detection
// ============================================================

describe('FM1: detectDryViolations', () => {
  // --- Real incident: PR #434 had 3x copy-pasted mock CLI blocks ---
  it('detects cross-file duplication (PR #434 pattern)', () => {
    const mockCliBlock = [
      'const mockCli = createMockCli({',
      '  caseExists: true,',
      '  caseStatus: "active",',
      '  caseWorktree: "/tmp/test-wt",',
      '});',
    ];

    const files: DiffFile[] = [
      {
        path: 'tests/test-hook-a.ts',
        additions: [...mockCliBlock, 'runHookA(mockCli);'],
        deletions: [],
        rawDiff: '',
      },
      {
        path: 'tests/test-hook-b.ts',
        additions: [...mockCliBlock, 'runHookB(mockCli);'],
        deletions: [],
        rawDiff: '',
      },
      {
        path: 'tests/test-hook-c.ts',
        additions: [...mockCliBlock, 'runHookC(mockCli);'],
        deletions: [],
        rawDiff: '',
      },
    ];

    const detections = detectDryViolations(files);
    expect(detections.length).toBeGreaterThan(0);
    expect(detections[0].mode).toBe(FailureMode.DRY_VIOLATION);
    expect(detections[0].confidence).toBeGreaterThanOrEqual(80);
  });

  it('detects within-file duplication', () => {
    const files: DiffFile[] = [
      {
        path: 'src/handler.ts',
        additions: [
          'const result = await fetch(url);',
          'const data = await result.json();',
          'validate(data);',
          'process(data);',
          'logResult(data);',
          '',
          'const result = await fetch(url);',
          'const data = await result.json();',
          'validate(data);',
          'process(data);',
          'logResult(data);',
        ],
        deletions: [],
        rawDiff: '',
      },
    ];

    const detections = detectDryViolations(files, 3);
    expect(detections.length).toBeGreaterThan(0);
    expect(detections[0].mode).toBe(FailureMode.DRY_VIOLATION);
  });

  // --- Clean scenario: no duplication ---
  it('does NOT flag unique code across files', () => {
    const files: DiffFile[] = [
      {
        path: 'src/a.ts',
        additions: ['function handleA() { return 1; }'],
        deletions: [],
        rawDiff: '',
      },
      {
        path: 'src/b.ts',
        additions: ['function handleB() { return 2; }'],
        deletions: [],
        rawDiff: '',
      },
    ];

    const detections = detectDryViolations(files);
    expect(detections).toHaveLength(0);
  });

  it('does NOT flag short shared lines (below threshold)', () => {
    const files: DiffFile[] = [
      {
        path: 'src/a.ts',
        additions: ['import { foo } from "./lib";', 'foo();'],
        deletions: [],
        rawDiff: '',
      },
      {
        path: 'src/b.ts',
        additions: ['import { foo } from "./lib";', 'foo();'],
        deletions: [],
        rawDiff: '',
      },
    ];

    // With minBlockSize=3, 2-line overlap shouldn't trigger
    const detections = detectDryViolations(files, 3);
    expect(detections).toHaveLength(0);
  });
});

// ============================================================
// FM6: Stale Reference Detection
// ============================================================

describe('FM6: detectStaleReferences', () => {
  // --- Real incident: PR #416, 24 files referenced old nanoclaw names ---
  it('detects old skill name after rename (PR #416 pattern)', () => {
    const files: DiffFile[] = [
      {
        path: '.claude/hooks/kaizen-post-merge-clear.sh',
        additions: [
          'if [[ "$SKILL_NAME" == "kaizen" ]]; then',
          '  clear_gate',
          'fi',
        ],
        deletions: [],
        rawDiff: '',
      },
    ];

    const detections = detectStaleReferences(files, [
      { old: 'kaizen', new: 'kaizen-reflect' },
    ]);
    // "kaizen" appears but not "kaizen-reflect"
    expect(detections.length).toBeGreaterThan(0);
    expect(detections[0].mode).toBe(FailureMode.STALE_REFERENCE);
  });

  it('detects old module reference after migration', () => {
    const files: DiffFile[] = [
      {
        path: 'src/hooks/setup.ts',
        additions: [
          'import { resolveCliKaizen } from "../cli-kaizen";',
          'const cli = resolveCliKaizen();',
        ],
        deletions: [],
        rawDiff: '',
      },
    ];

    const detections = detectStaleReferences(files, [
      { old: 'cli-kaizen', new: 'case-backend-github' },
    ]);
    expect(detections.length).toBeGreaterThan(0);
  });

  // --- Clean scenario: new name used correctly ---
  it('does NOT flag when new name is used', () => {
    const files: DiffFile[] = [
      {
        path: '.claude/hooks/kaizen-post-merge-clear.sh',
        additions: [
          'if [[ "$SKILL_NAME" == "kaizen-reflect" ]]; then',
          '  clear_gate',
          'fi',
        ],
        deletions: [],
        rawDiff: '',
      },
    ];

    const detections = detectStaleReferences(files, [
      { old: 'kaizen', new: 'kaizen-reflect' },
    ]);
    // "kaizen-reflect" is the new name, and "kaizen" appears only as prefix
    // The word boundary check should handle this
    expect(detections).toHaveLength(0);
  });

  it('does NOT flag when both old and new appear (legitimate reference)', () => {
    const files: DiffFile[] = [
      {
        path: 'docs/migration.md',
        additions: [
          'Renamed kaizen to kaizen-reflect for clarity',
        ],
        deletions: [],
        rawDiff: '',
      },
    ];

    // Line contains both old and new — likely documentation, not stale
    const detections = detectStaleReferences(files, [
      { old: 'kaizen', new: 'kaizen-reflect' },
    ]);
    expect(detections).toHaveLength(0);
  });
});

// ============================================================
// FM5: Environment Assumption Detection
// ============================================================

describe('FM5: detectEnvAssumptions', () => {
  // --- Real incident: issue #232, git status without -C ---
  it('detects git status without -C in hook (issue #232)', () => {
    const files: DiffFile[] = [
      {
        path: '.claude/hooks/check-dirty-files.sh',
        additions: [
          '#!/bin/bash',
          'DIRTY=$(git status --porcelain)',
          'if [ -n "$DIRTY" ]; then',
          '  echo "Dirty files found"',
          'fi',
        ],
        deletions: [],
        rawDiff: '',
      },
    ];

    const detections = detectEnvAssumptions(files);
    const envDetections = detections.filter(
      (d) => d.mode === FailureMode.ENV_ASSUMPTION,
    );
    expect(envDetections.length).toBeGreaterThan(0);
    expect(envDetections[0].detail).toContain('-C');
  });

  // --- Real incident: issue #219, hardcoded home path ---
  it('detects hardcoded home path (issue #219)', () => {
    const files: DiffFile[] = [
      {
        path: 'scripts/worktree-du.sh',
        additions: [
          'REPO_ROOT="/home/aviadr1/projects/nanoclaw"',
        ],
        deletions: [],
        rawDiff: '',
      },
    ];

    const detections = detectEnvAssumptions(files);
    expect(detections.length).toBeGreaterThan(0);
    expect(detections[0].detail).toContain('Hardcoded home path');
  });

  // --- Real incident: PR #434, git init without user config ---
  it('detects git init without user config in tests (PR #434)', () => {
    const files: DiffFile[] = [
      {
        path: 'src/e2e/plugin-lifecycle.test.ts',
        additions: [
          'const tmpDir = mkdtempSync("/tmp/test-");',
          'execSync("git init", { cwd: tmpDir });',
          'execSync("git commit --allow-empty -m init", { cwd: tmpDir });',
        ],
        deletions: [],
        rawDiff: '',
      },
    ];

    const detections = detectEnvAssumptions(files);
    const gitInitDetections = detections.filter(
      (d) => d.detail.includes('git init'),
    );
    expect(gitInitDetections.length).toBeGreaterThan(0);
  });

  // --- Clean scenarios ---
  it('does NOT flag git status with -C', () => {
    const files: DiffFile[] = [
      {
        path: '.claude/hooks/check-dirty-files.sh',
        additions: [
          'DIRTY=$(git -C "$TARGET_DIR" status --porcelain)',
        ],
        deletions: [],
        rawDiff: '',
      },
    ];

    const detections = detectEnvAssumptions(files);
    const gitDetections = detections.filter((d) =>
      d.detail.includes('without -C'),
    );
    expect(gitDetections).toHaveLength(0);
  });

  it('does NOT flag commented-out code', () => {
    const files: DiffFile[] = [
      {
        path: '.claude/hooks/check-dirty-files.sh',
        additions: ['# DIRTY=$(git status --porcelain)'],
        deletions: [],
        rawDiff: '',
      },
    ];

    const detections = detectEnvAssumptions(files);
    expect(detections).toHaveLength(0);
  });

  it('does NOT flag git init WITH user config setup', () => {
    const files: DiffFile[] = [
      {
        path: 'src/e2e/setup.test.ts',
        additions: [
          'execSync("git init", { cwd: tmpDir });',
          'execSync("git config user.name test", { cwd: tmpDir });',
          'execSync("git config user.email test@test.com", { cwd: tmpDir });',
        ],
        deletions: [],
        rawDiff: '',
      },
    ];

    const detections = detectEnvAssumptions(files);
    const gitInitDetections = detections.filter(
      (d) => d.detail.includes('git init'),
    );
    expect(gitInitDetections).toHaveLength(0);
  });
});

// ============================================================
// FM4: Scope Cut Testability
// ============================================================

describe('FM4: detectScopeCutTestability', () => {
  it('detects source additions with no test changes', () => {
    const files: DiffFile[] = [
      {
        path: 'src/analysis/new-feature.ts',
        additions: new Array(30).fill('const x = 1;'),
        deletions: [],
        rawDiff: '',
      },
    ];

    const detections = detectScopeCutTestability(files);
    expect(detections.length).toBeGreaterThan(0);
    expect(detections[0].mode).toBe(FailureMode.SCOPE_CUT_TESTABILITY);
  });

  it('does NOT flag when test file is also changed', () => {
    const files: DiffFile[] = [
      {
        path: 'src/analysis/new-feature.ts',
        additions: new Array(30).fill('const x = 1;'),
        deletions: [],
        rawDiff: '',
      },
      {
        path: 'src/analysis/new-feature.test.ts',
        additions: ['it("works", () => { expect(true).toBe(true); });'],
        deletions: [],
        rawDiff: '',
      },
    ];

    const detections = detectScopeCutTestability(files);
    expect(detections).toHaveLength(0);
  });

  it('does NOT flag small changes (under threshold)', () => {
    const files: DiffFile[] = [
      {
        path: 'src/utils.ts',
        additions: ['export const VERSION = "2.0.0";'],
        deletions: [],
        rawDiff: '',
      },
    ];

    const detections = detectScopeCutTestability(files);
    expect(detections).toHaveLength(0);
  });
});
