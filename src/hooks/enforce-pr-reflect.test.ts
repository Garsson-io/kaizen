import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeStateFile } from './state-utils.js';
import { processPreToolUse } from './enforce-pr-reflect.js';

const TEST_STATE_DIR = '/tmp/.test-enforce-pr-reflect';
const TEST_BRANCH = 'worktree-reflect-test';

function createReflectionGate(prUrl: string) {
  writeStateFile(TEST_STATE_DIR, `kaizen-${Date.now()}`, {
    PR_URL: prUrl,
    STATUS: 'needs_pr_kaizen',
    BRANCH: TEST_BRANCH,
  });
}

beforeEach(() => {
  if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
  mkdirSync(TEST_STATE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true });
});

describe('enforce-pr-reflect PreToolUse', () => {
  it('allows all commands when no reflection gate is active', () => {
    const result = processPreToolUse('npm install lodash', TEST_BRANCH, TEST_STATE_DIR);
    expect(result.allowed).toBe(true);
  });

  it('allows kaizen commands when gate is active', () => {
    createReflectionGate('https://github.com/org/repo/pull/50');
    expect(processPreToolUse("echo 'KAIZEN_IMPEDIMENTS: []'", TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
    expect(processPreToolUse('gh issue create --title "test"', TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
    expect(processPreToolUse('gh pr diff 50', TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
    expect(processPreToolUse('git log --oneline', TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
    expect(processPreToolUse('npm test', TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
    expect(processPreToolUse('grep -r "pattern" src/', TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
  });

  it('allows KAIZEN_UNFINISHED when gate is active (kaizen #775)', () => {
    createReflectionGate('https://github.com/org/repo/pull/50');
    expect(processPreToolUse("echo 'KAIZEN_UNFINISHED: session timeout'", TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
  });

  it('allows gh pr merge during reflection (kaizen #323)', () => {
    createReflectionGate('https://github.com/org/repo/pull/50');
    expect(processPreToolUse('gh pr merge 50', TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
  });

  it('blocks non-kaizen commands when gate is active', () => {
    createReflectionGate('https://github.com/org/repo/pull/50');
    const result = processPreToolUse('npm install lodash', TEST_BRANCH, TEST_STATE_DIR);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('BLOCKED');
    expect(result.reason).toContain('Kaizen reflection required');
    expect(result.reason).toContain('pull/50');
    expect(result.reason).toContain('KAIZEN_UNFINISHED');
  });

  it('blocks git push when gate is active', () => {
    createReflectionGate('https://github.com/org/repo/pull/50');
    expect(processPreToolUse('git push origin feature', TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(false);
  });

  it('allows empty commands', () => {
    createReflectionGate('https://github.com/org/repo/pull/50');
    expect(processPreToolUse('', TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
  });

  it('ignores gates from other branches', () => {
    writeStateFile(TEST_STATE_DIR, 'other-kaizen', {
      PR_URL: 'https://github.com/org/repo/pull/99',
      STATUS: 'needs_pr_kaizen',
      BRANCH: 'other-branch',
    });
    expect(processPreToolUse('npm install', TEST_BRANCH, TEST_STATE_DIR).allowed).toBe(true);
  });
});
