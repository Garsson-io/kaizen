import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeStateFile } from '../state-utils.js';
import {
  clearDeferredItems,
  formatGateMessage,
  handleUnfinishedEscape,
  readAllPendingGates,
  readDeferredItems,
  scanStateDirectoryDiagnostics,
} from './gate-manager.js';

const TEST_STATE_DIR = '/tmp/.test-gate-manager';
const TEST_BRANCH = 'worktree-test-branch';

function createState(
  filename: string,
  status: string,
  prUrl: string,
  extra: Record<string, string> = {},
) {
  writeStateFile(TEST_STATE_DIR, filename, {
    PR_URL: prUrl,
    STATUS: status,
    BRANCH: TEST_BRANCH,
    ...extra,
  });
}

beforeEach(() => {
  if (existsSync(TEST_STATE_DIR)) {
    rmSync(TEST_STATE_DIR, { recursive: true });
  }
  mkdirSync(TEST_STATE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_STATE_DIR)) {
    rmSync(TEST_STATE_DIR, { recursive: true });
  }
});

describe('readAllPendingGates', () => {
  it('returns empty report when no gates exist', () => {
    const report = readAllPendingGates(TEST_BRANCH, TEST_STATE_DIR);
    expect(report.gates).toEqual([]);
    expect(report.shouldBlock).toBe(false);
    expect(report.message).toBe('');
  });

  it('reads a single review gate', () => {
    createState('pr-review-1', 'needs_review', 'https://github.com/org/repo/pull/42', { ROUND: '2' });
    const report = readAllPendingGates(TEST_BRANCH, TEST_STATE_DIR);
    expect(report.gates).toHaveLength(1);
    expect(report.shouldBlock).toBe(true);
    expect(report.gates[0].type).toBe('review');
    expect(report.gates[0].prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(report.gates[0].label).toContain('round 2');
  });

  it('reads a single reflection gate', () => {
    createState('pr-kaizen-1', 'needs_pr_kaizen', 'https://github.com/org/repo/pull/50');
    const report = readAllPendingGates(TEST_BRANCH, TEST_STATE_DIR);
    expect(report.gates).toHaveLength(1);
    expect(report.gates[0].type).toBe('reflection');
    expect(report.gates[0].detail).toContain('KAIZEN_IMPEDIMENTS');
  });

  it('reads a single post-merge gate', () => {
    createState('post-merge-1', 'needs_post_merge', 'https://github.com/org/repo/pull/60');
    const report = readAllPendingGates(TEST_BRANCH, TEST_STATE_DIR);
    expect(report.gates).toHaveLength(1);
    expect(report.gates[0].type).toBe('post_merge');
    expect(report.gates[0].detail).toContain('git fetch origin main');
  });

  it('reads multiple gates of different types', () => {
    createState('review-1', 'needs_review', 'https://github.com/org/repo/pull/42', { ROUND: '1' });
    createState('kaizen-1', 'needs_pr_kaizen', 'https://github.com/org/repo/pull/42');
    createState('post-merge-1', 'needs_post_merge', 'https://github.com/org/repo/pull/42');
    const report = readAllPendingGates(TEST_BRANCH, TEST_STATE_DIR);
    expect(report.gates).toHaveLength(3);
    expect(report.shouldBlock).toBe(true);
    const types = report.gates.map((g) => g.type);
    expect(types).toContain('review');
    expect(types).toContain('reflection');
    expect(types).toContain('post_merge');
  });

  it('reads multiple PRs in one session', () => {
    createState('review-1', 'needs_review', 'https://github.com/org/repo/pull/42', { ROUND: '1' });
    createState('review-2', 'needs_review', 'https://github.com/org/repo/pull/43', { ROUND: '1' });
    const report = readAllPendingGates(TEST_BRANCH, TEST_STATE_DIR);
    expect(report.gates).toHaveLength(2);
    expect(report.gates.map((g) => g.prUrl)).toContain('https://github.com/org/repo/pull/42');
    expect(report.gates.map((g) => g.prUrl)).toContain('https://github.com/org/repo/pull/43');
  });

  it('ignores gates from other branches', () => {
    createState('review-1', 'needs_review', 'https://github.com/org/repo/pull/42', { ROUND: '1' });
    // Write a state file for a different branch
    writeStateFile(TEST_STATE_DIR, 'review-other', {
      PR_URL: 'https://github.com/org/repo/pull/99',
      STATUS: 'needs_review',
      BRANCH: 'other-branch',
      ROUND: '1',
    });
    const report = readAllPendingGates(TEST_BRANCH, TEST_STATE_DIR);
    expect(report.gates).toHaveLength(1);
    expect(report.gates[0].prUrl).toBe('https://github.com/org/repo/pull/42');
  });

  it('ignores non-gate status files', () => {
    createState('passed-1', 'passed', 'https://github.com/org/repo/pull/42');
    createState('kaizen-done-1', 'kaizen_done', 'https://github.com/org/repo/pull/42');
    const report = readAllPendingGates(TEST_BRANCH, TEST_STATE_DIR);
    expect(report.gates).toEqual([]);
    expect(report.shouldBlock).toBe(false);
  });
});

describe('formatGateMessage', () => {
  it('formats single gate message', () => {
    const msg = formatGateMessage([
      {
        type: 'review',
        prUrl: 'https://github.com/org/repo/pull/42',
        label: 'PR REVIEW (https://github.com/org/repo/pull/42 — round 1)',
        detail: 'Run: gh pr diff 42',
        action: 'gh pr diff 42',
        filepath: '/tmp/test',
      },
    ]);
    expect(msg).toContain('1 item pending');
    expect(msg).toContain('PR REVIEW');
    expect(msg).toContain('KAIZEN_UNFINISHED');
  });

  it('formats multiple gates with plural', () => {
    const msg = formatGateMessage([
      {
        type: 'review',
        prUrl: 'url1',
        label: 'PR REVIEW',
        detail: 'detail1',
        action: 'action1',
        filepath: '/tmp/a',
      },
      {
        type: 'reflection',
        prUrl: 'url2',
        label: 'KAIZEN REFLECTION',
        detail: 'detail2',
        action: 'action2',
        filepath: '/tmp/b',
      },
    ]);
    expect(msg).toContain('2 items pending');
    expect(msg).toContain('1. PR REVIEW');
    expect(msg).toContain('2. KAIZEN REFLECTION');
  });
});

describe('handleUnfinishedEscape', () => {
  it('clears all gate state files', () => {
    createState('review-1', 'needs_review', 'https://github.com/org/repo/pull/42', { ROUND: '1' });
    createState('kaizen-1', 'needs_pr_kaizen', 'https://github.com/org/repo/pull/42');

    const cleared = handleUnfinishedEscape('too tired', TEST_BRANCH, TEST_STATE_DIR);
    expect(cleared).toHaveLength(2);

    // State files should be gone
    const report = readAllPendingGates(TEST_BRANCH, TEST_STATE_DIR);
    expect(report.gates).toEqual([]);
  });

  it('writes deferred items file', () => {
    createState('review-1', 'needs_review', 'https://github.com/org/repo/pull/42', { ROUND: '1' });

    handleUnfinishedEscape('context switch', TEST_BRANCH, TEST_STATE_DIR);

    const deferred = readDeferredItems(TEST_STATE_DIR);
    expect(deferred).not.toBeNull();
    expect(deferred!.reason).toBe('context switch');
    expect(deferred!.branch).toBe(TEST_BRANCH);
    expect(deferred!.items).toHaveLength(1);
    expect(deferred!.items[0].type).toBe('review');
  });

  it('does not write deferred file when no gates exist', () => {
    const cleared = handleUnfinishedEscape('nothing to do', TEST_BRANCH, TEST_STATE_DIR);
    expect(cleared).toHaveLength(0);
    expect(readDeferredItems(TEST_STATE_DIR)).toBeNull();
  });
});

describe('scanStateDirectoryDiagnostics', () => {
  it('returns empty diagnostics when state dir is empty', () => {
    const diag = scanStateDirectoryDiagnostics(TEST_BRANCH, TEST_STATE_DIR);
    expect(diag.totalFiles).toBe(0);
    expect(diag.includedFiles).toBe(0);
    expect(diag.excludedFiles).toBe(0);
    expect(diag.files).toEqual([]);
  });

  it('returns empty diagnostics when state dir does not exist', () => {
    const diag = scanStateDirectoryDiagnostics(TEST_BRANCH, '/tmp/.nonexistent-gate-diag');
    expect(diag.totalFiles).toBe(0);
  });

  it('includes files matching current branch', () => {
    createState('review-1', 'needs_review', 'https://github.com/org/repo/pull/42', { ROUND: '1' });
    const diag = scanStateDirectoryDiagnostics(TEST_BRANCH, TEST_STATE_DIR);
    expect(diag.totalFiles).toBe(1);
    expect(diag.includedFiles).toBe(1);
    expect(diag.excludedFiles).toBe(0);
    expect(diag.files[0].included).toBe(true);
    expect(diag.files[0].status).toBe('needs_review');
    expect(diag.files[0].branch).toBe(TEST_BRANCH);
  });

  it('excludes files from other branches with reason wrong_branch', () => {
    writeStateFile(TEST_STATE_DIR, 'other-review', {
      PR_URL: 'https://github.com/org/repo/pull/99',
      STATUS: 'needs_review',
      BRANCH: 'other-branch',
      ROUND: '1',
    });
    const diag = scanStateDirectoryDiagnostics(TEST_BRANCH, TEST_STATE_DIR);
    expect(diag.totalFiles).toBe(1);
    expect(diag.includedFiles).toBe(0);
    expect(diag.excludedFiles).toBe(1);
    expect(diag.excludeReasons.wrong_branch).toBe(1);
    expect(diag.files[0].excludeReason).toBe('wrong_branch');
    expect(diag.files[0].branch).toBe('other-branch');
  });

  it('excludes files without BRANCH with reason no_branch', () => {
    writeStateFile(TEST_STATE_DIR, 'legacy-state', {
      PR_URL: 'https://github.com/org/repo/pull/10',
      STATUS: 'needs_review',
      BRANCH: '',
    });
    const diag = scanStateDirectoryDiagnostics(TEST_BRANCH, TEST_STATE_DIR);
    expect(diag.excludeReasons.no_branch).toBe(1);
    expect(diag.files[0].excludeReason).toBe('no_branch');
  });

  it('reports mixed included and excluded files', () => {
    createState('review-1', 'needs_review', 'https://github.com/org/repo/pull/42', { ROUND: '1' });
    createState('kaizen-1', 'needs_pr_kaizen', 'https://github.com/org/repo/pull/42');
    writeStateFile(TEST_STATE_DIR, 'other-review', {
      PR_URL: 'https://github.com/org/repo/pull/99',
      STATUS: 'needs_review',
      BRANCH: 'other-branch',
      ROUND: '1',
    });
    const diag = scanStateDirectoryDiagnostics(TEST_BRANCH, TEST_STATE_DIR);
    expect(diag.totalFiles).toBe(3);
    expect(diag.includedFiles).toBe(2);
    expect(diag.excludedFiles).toBe(1);
    expect(diag.excludeReasons.wrong_branch).toBe(1);
  });
});

describe('readDeferredItems / clearDeferredItems', () => {
  it('returns null when no deferred items exist', () => {
    expect(readDeferredItems(TEST_STATE_DIR)).toBeNull();
  });

  it('clears deferred items file', () => {
    createState('review-1', 'needs_review', 'https://github.com/org/repo/pull/42', { ROUND: '1' });
    handleUnfinishedEscape('reason', TEST_BRANCH, TEST_STATE_DIR);

    expect(readDeferredItems(TEST_STATE_DIR)).not.toBeNull();
    clearDeferredItems(TEST_STATE_DIR);
    expect(readDeferredItems(TEST_STATE_DIR)).toBeNull();
  });
});
