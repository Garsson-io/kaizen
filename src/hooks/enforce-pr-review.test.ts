import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeStateFile } from './state-utils.js';
import { processPreToolUse } from './enforce-pr-review.js';

const TEST_STATE_DIR = '/tmp/.test-enforce-pr-review';
const TEST_BRANCH = 'worktree-review-test';

function createReviewGate(prUrl: string, round: string = '1') {
  writeStateFile(TEST_STATE_DIR, `review-${Date.now()}`, {
    PR_URL: prUrl,
    STATUS: 'needs_review',
    BRANCH: TEST_BRANCH,
    ROUND: round,
  });
}

beforeEach(() => {
  if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
  mkdirSync(TEST_STATE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
});

describe('enforce-pr-review PreToolUse', () => {
  it('allows all commands when no review gate is active', () => {
    const result = processPreToolUse('npm install lodash', TEST_BRANCH, TEST_STATE_DIR);
    expect(result.allowed).toBe(true);
  });

  it('allows review commands when gate is active', () => {
    createReviewGate('https://github.com/org/repo/pull/42');
    expect(processPreToolUse('gh pr diff 42', TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
    expect(processPreToolUse('gh pr view 42', TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
    expect(processPreToolUse('git diff', TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
    expect(processPreToolUse('npm test', TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
    expect(processPreToolUse('grep -r "foo" src/', TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
  });

  it('blocks non-review commands when gate is active', () => {
    createReviewGate('https://github.com/org/repo/pull/42');
    const result = processPreToolUse('npm install lodash', TEST_BRANCH, TEST_STATE_DIR);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('BLOCKED');
    expect(result.reason).toContain('PR review required');
    expect(result.reason).toContain('pull/42');
  });

  it('blocks git push when gate is active', () => {
    createReviewGate('https://github.com/org/repo/pull/42');
    const result = processPreToolUse('git push origin feature', TEST_BRANCH, TEST_STATE_DIR);
    expect(result.allowed).toBe(false);
  });

  it('allows empty commands', () => {
    createReviewGate('https://github.com/org/repo/pull/42');
    expect(processPreToolUse('', TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
  });

  it('ignores gates from other branches', () => {
    writeStateFile(TEST_STATE_DIR, 'other-review', {
      PR_URL: 'https://github.com/org/repo/pull/99',
      STATUS: 'needs_review',
      BRANCH: 'other-branch',
      ROUND: '1',
    });
    const result = processPreToolUse('npm install', TEST_BRANCH, TEST_STATE_DIR);
    expect(result.allowed).toBe(true);
  });
});
