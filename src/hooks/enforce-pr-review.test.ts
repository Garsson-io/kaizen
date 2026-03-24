import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeStateFile } from './state-utils.js';
import { processPreToolUse } from './enforce-pr-review.js';
import type { ToolContext } from './enforce-pr-review.js';

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

describe('enforce-pr-review PreToolUse — Bash commands', () => {
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

  it('includes round from state file in deny message', () => {
    createReviewGate('https://github.com/org/repo/pull/42', '3');
    const result = processPreToolUse('npm install lodash', TEST_BRANCH, TEST_STATE_DIR);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('round 3');
  });
});

describe('enforce-pr-review PreToolUse — Edit/Write tools (kaizen #789)', () => {
  it('allows Edit when no review gate is active', () => {
    const ctx: ToolContext = { toolName: 'Edit', toolInput: { file_path: '/some/file.ts' } };
    const result = processPreToolUse('', TEST_BRANCH, TEST_STATE_DIR, ctx);
    expect(result.allowed).toBe(true);
  });

  it('blocks Edit during active review', () => {
    createReviewGate('https://github.com/org/repo/pull/42');
    const ctx: ToolContext = { toolName: 'Edit', toolInput: { file_path: '/some/file.ts' } };
    const result = processPreToolUse('', TEST_BRANCH, TEST_STATE_DIR, ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('BLOCKED');
    expect(result.reason).toContain('Edit');
    expect(result.reason).toContain('pull/42');
  });

  it('blocks Write during active review', () => {
    createReviewGate('https://github.com/org/repo/pull/42');
    const ctx: ToolContext = { toolName: 'Write', toolInput: { file_path: '/some/file.ts' } };
    const result = processPreToolUse('', TEST_BRANCH, TEST_STATE_DIR, ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Write');
  });

  it('allows Edit/Write when review passed', () => {
    writeStateFile(TEST_STATE_DIR, 'review-passed', {
      PR_URL: 'https://github.com/org/repo/pull/42',
      STATUS: 'passed',
      BRANCH: TEST_BRANCH,
      ROUND: '1',
    });
    const ctx: ToolContext = { toolName: 'Edit', toolInput: { file_path: '/some/file.ts' } };
    const result = processPreToolUse('', TEST_BRANCH, TEST_STATE_DIR, ctx);
    expect(result.allowed).toBe(true);
  });

  it('does not block Edit from other branches review', () => {
    writeStateFile(TEST_STATE_DIR, 'other-review', {
      PR_URL: 'https://github.com/org/repo/pull/99',
      STATUS: 'needs_review',
      BRANCH: 'other-branch',
      ROUND: '1',
    });
    const ctx: ToolContext = { toolName: 'Edit', toolInput: { file_path: '/some/file.ts' } };
    const result = processPreToolUse('', TEST_BRANCH, TEST_STATE_DIR, ctx);
    expect(result.allowed).toBe(true);
  });

  it('includes round in deny message for tools', () => {
    createReviewGate('https://github.com/org/repo/pull/99', '3');
    const ctx: ToolContext = { toolName: 'Edit', toolInput: {} };
    const result = processPreToolUse('', TEST_BRANCH, TEST_STATE_DIR, ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('round 3');
    expect(result.reason).toContain('pull/99');
  });
});

describe('enforce-pr-review PreToolUse — Agent tool (kaizen #789)', () => {
  it('blocks Agent during active review', () => {
    createReviewGate('https://github.com/org/repo/pull/42');
    const ctx: ToolContext = {
      toolName: 'Agent',
      toolInput: { prompt: 'do something', subagent_type: 'general-purpose' },
    };
    const result = processPreToolUse('', TEST_BRANCH, TEST_STATE_DIR, ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Agent');
  });

  it('allows Agent(kaizen-bg) during active review (kaizen #151)', () => {
    createReviewGate('https://github.com/org/repo/pull/42');
    const ctx: ToolContext = {
      toolName: 'Agent',
      toolInput: { prompt: 'reflect on impediments', subagent_type: 'kaizen-bg' },
    };
    const result = processPreToolUse('', TEST_BRANCH, TEST_STATE_DIR, ctx);
    expect(result.allowed).toBe(true);
  });

  it('blocks Agent without subagent_type during review', () => {
    createReviewGate('https://github.com/org/repo/pull/42');
    const ctx: ToolContext = {
      toolName: 'Agent',
      toolInput: { prompt: 'do something' },
    };
    const result = processPreToolUse('', TEST_BRANCH, TEST_STATE_DIR, ctx);
    expect(result.allowed).toBe(false);
  });

  it('allows Agent when no review gate is active', () => {
    const ctx: ToolContext = {
      toolName: 'Agent',
      toolInput: { prompt: 'do something', subagent_type: 'general-purpose' },
    };
    const result = processPreToolUse('', TEST_BRANCH, TEST_STATE_DIR, ctx);
    expect(result.allowed).toBe(true);
  });
});
