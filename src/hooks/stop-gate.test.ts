import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeStateFile } from './state-utils.js';
import { readAllPendingGates } from './lib/gate-manager.js';

const TEST_STATE_DIR = '/tmp/.test-stop-gate';
const TEST_BRANCH = 'worktree-stop-gate-test';

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

describe('stop-gate integration (via gate-manager)', () => {
  it('allows stop when no gates are pending', () => {
    const report = readAllPendingGates(TEST_BRANCH, TEST_STATE_DIR);
    expect(report.shouldBlock).toBe(false);
    expect(report.message).toBe('');
  });

  it('blocks stop with rich message for single review gate', () => {
    createState('review-1', 'needs_review', 'https://github.com/org/repo/pull/42', { ROUND: '2' });
    const report = readAllPendingGates(TEST_BRANCH, TEST_STATE_DIR);

    expect(report.shouldBlock).toBe(true);
    expect(report.message).toContain('1 item pending');
    expect(report.message).toContain('PR REVIEW');
    expect(report.message).toContain('round 2');
    expect(report.message).toContain('gh pr diff 42');
    expect(report.message).toContain('KAIZEN_UNFINISHED');
  });

  it('blocks stop with all 3 gate types combined', () => {
    createState('review-1', 'needs_review', 'https://github.com/org/repo/pull/100', { ROUND: '1' });
    createState('kaizen-1', 'needs_pr_kaizen', 'https://github.com/org/repo/pull/100');
    createState('post-merge-1', 'needs_post_merge', 'https://github.com/org/repo/pull/100');

    const report = readAllPendingGates(TEST_BRANCH, TEST_STATE_DIR);
    expect(report.shouldBlock).toBe(true);
    expect(report.message).toContain('3 items pending');
    expect(report.message).toContain('PR REVIEW');
    expect(report.message).toContain('KAIZEN REFLECTION');
    expect(report.message).toContain('POST-MERGE SYNC');
  });

  it('shows multiple PRs when multiple reviews are pending', () => {
    createState('review-1', 'needs_review', 'https://github.com/org/repo/pull/10', { ROUND: '1' });
    createState('review-2', 'needs_review', 'https://github.com/org/repo/pull/20', { ROUND: '1' });

    const report = readAllPendingGates(TEST_BRANCH, TEST_STATE_DIR);
    expect(report.gates).toHaveLength(2);
    expect(report.message).toContain('pull/10');
    expect(report.message).toContain('pull/20');
  });

  it('produces valid JSON block output', () => {
    createState('review-1', 'needs_review', 'https://github.com/org/repo/pull/42', { ROUND: '1' });
    const report = readAllPendingGates(TEST_BRANCH, TEST_STATE_DIR);

    const output = JSON.stringify({ decision: 'block', reason: report.message });
    const parsed = JSON.parse(output);
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('BEFORE STOPPING');
  });

  it('ignores gates from different branches', () => {
    writeStateFile(TEST_STATE_DIR, 'other-branch-review', {
      PR_URL: 'https://github.com/org/repo/pull/999',
      STATUS: 'needs_review',
      BRANCH: 'completely-different-branch',
      ROUND: '1',
    });
    const report = readAllPendingGates(TEST_BRANCH, TEST_STATE_DIR);
    expect(report.shouldBlock).toBe(false);
  });
});
