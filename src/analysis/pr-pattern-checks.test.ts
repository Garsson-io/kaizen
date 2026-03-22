import { describe, it, expect } from 'vitest';
import { detectMultiPRCycles } from './pr-pattern-checks.js';
import { FailureMode, type PRRecord } from './types.js';

// ============================================================
// FM2: Multi-PR Fix Cycle Detection
// ============================================================

describe('FM2: detectMultiPRCycles', () => {
  // --- Real incident: PRs #418-421, 4 fix PRs in 21 minutes ---
  it('detects rapid-fire fix PRs (plugin manifest pattern, PRs #418-421)', () => {
    const prs: PRRecord[] = [
      {
        number: 418,
        title: 'fix: marketplace.json author field must be object',
        mergedAt: '2026-03-21T22:22:28Z',
        changedFiles: ['marketplace.json'],
        additions: 1,
        deletions: 1,
        labels: [],
        linkedIssues: [],
      },
      {
        number: 419,
        title: 'fix: correct plugin.json paths to repo-root-relative',
        mergedAt: '2026-03-21T22:33:33Z',
        changedFiles: ['plugin.json'],
        additions: 0,
        deletions: 0,
        labels: [],
        linkedIssues: [],
      },
      {
        number: 420,
        title: 'fix: remove self-referencing .kaizen symlink breaking plugin install',
        mergedAt: '2026-03-21T22:38:31Z',
        changedFiles: ['.kaizen'],
        additions: 0,
        deletions: 1,
        labels: [],
        linkedIssues: [],
      },
      {
        number: 421,
        title: 'fix: plugin.json agents must be array not string',
        mergedAt: '2026-03-21T22:43:02Z',
        changedFiles: ['plugin.json'],
        additions: 1,
        deletions: 1,
        labels: [],
        linkedIssues: [],
      },
    ];

    const detections = detectMultiPRCycles(prs);
    expect(detections.length).toBeGreaterThan(0);
    expect(detections[0].mode).toBe(FailureMode.MULTI_PR_FIX_CYCLE);
  });

  // --- Real incident: issue #400, PRs #273-280 for same feature ---
  it('detects same-issue multi-PR pattern (issue #400)', () => {
    const prs: PRRecord[] = [
      {
        number: 273,
        title: 'feat: add progress reporting to overnight-dent',
        mergedAt: '2026-03-18T10:00:00Z',
        changedFiles: ['src/overnight-dent.ts', 'src/progress.ts'],
        additions: 200,
        deletions: 50,
        labels: [],
        linkedIssues: [270],
      },
      {
        number: 275,
        title: 'fix: progress report format missing run count',
        mergedAt: '2026-03-18T10:30:00Z',
        changedFiles: ['src/progress.ts'],
        additions: 10,
        deletions: 5,
        labels: [],
        linkedIssues: [270],
      },
      {
        number: 277,
        title: 'fix: progress report crashes on empty run history',
        mergedAt: '2026-03-18T11:00:00Z',
        changedFiles: ['src/progress.ts'],
        additions: 15,
        deletions: 3,
        labels: [],
        linkedIssues: [270],
      },
      {
        number: 280,
        title: 'fix: progress report off-by-one in success rate',
        mergedAt: '2026-03-18T11:30:00Z',
        changedFiles: ['src/progress.ts'],
        additions: 5,
        deletions: 5,
        labels: [],
        linkedIssues: [270],
      },
    ];

    const detections = detectMultiPRCycles(prs);
    expect(detections.length).toBeGreaterThan(0);

    // Should detect both the issue-reference cluster AND the file-overlap cluster
    const issueCluster = detections.find((d) =>
      d.detail.includes('issue #270'),
    );
    expect(issueCluster).toBeDefined();

    const fileCluster = detections.find((d) =>
      d.detail.includes('overlapping files'),
    );
    expect(fileCluster).toBeDefined();
  });

  // --- Clean scenario: unrelated PRs spread across time ---
  it('does NOT flag unrelated PRs with no overlap', () => {
    const prs: PRRecord[] = [
      {
        number: 100,
        title: 'feat: add new hook for PR review',
        mergedAt: '2026-03-10T10:00:00Z',
        changedFiles: ['src/hooks/review.ts'],
        additions: 100,
        deletions: 0,
        labels: [],
        linkedIssues: [50],
      },
      {
        number: 101,
        title: 'feat: add worktree cleanup skill',
        mergedAt: '2026-03-10T14:00:00Z',
        changedFiles: ['src/worktree-du.ts'],
        additions: 200,
        deletions: 10,
        labels: [],
        linkedIssues: [60],
      },
      {
        number: 102,
        title: 'docs: update CLAUDE.md with new skills',
        mergedAt: '2026-03-11T10:00:00Z',
        changedFiles: ['CLAUDE.md'],
        additions: 20,
        deletions: 5,
        labels: [],
        linkedIssues: [70],
      },
    ];

    const detections = detectMultiPRCycles(prs);
    expect(detections).toHaveLength(0);
  });

  // --- Clean: 2 PRs for same issue but under threshold ---
  it('does NOT flag 2 PRs (below minClusterSize=3)', () => {
    const prs: PRRecord[] = [
      {
        number: 200,
        title: 'feat: implement new check',
        mergedAt: '2026-03-15T10:00:00Z',
        changedFiles: ['src/check.ts'],
        additions: 50,
        deletions: 0,
        labels: [],
        linkedIssues: [100],
      },
      {
        number: 201,
        title: 'fix: edge case in new check',
        mergedAt: '2026-03-15T10:30:00Z',
        changedFiles: ['src/check.ts'],
        additions: 5,
        deletions: 2,
        labels: [],
        linkedIssues: [100],
      },
    ];

    const detections = detectMultiPRCycles(prs);
    expect(detections).toHaveLength(0);
  });

  // --- Edge case: PRs outside time window ---
  it('does NOT flag PRs spread across days', () => {
    const prs: PRRecord[] = [
      {
        number: 300,
        title: 'fix: auth token refresh',
        mergedAt: '2026-03-10T10:00:00Z',
        changedFiles: ['src/auth.ts'],
        additions: 10,
        deletions: 5,
        labels: [],
        linkedIssues: [200],
      },
      {
        number: 301,
        title: 'fix: auth token expiry edge case',
        mergedAt: '2026-03-11T10:00:00Z',
        changedFiles: ['src/auth.ts'],
        additions: 8,
        deletions: 3,
        labels: [],
        linkedIssues: [200],
      },
      {
        number: 302,
        title: 'fix: auth retry logic',
        mergedAt: '2026-03-12T10:00:00Z',
        changedFiles: ['src/auth.ts'],
        additions: 15,
        deletions: 10,
        labels: [],
        linkedIssues: [200],
      },
    ];

    // Default window is 2h, these are 24h apart
    const detections = detectMultiPRCycles(prs);
    expect(detections).toHaveLength(0);
  });
});
