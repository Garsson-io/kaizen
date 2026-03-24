import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseStateFile, writeStateFile } from './state-utils.js';
import { processPostMergeClear } from './post-merge-clear.js';

const TEST_STATE_DIR = '/tmp/.test-post-merge-clear';
const TEST_BRANCH = 'worktree-test-post-merge';

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

describe('processPostMergeClear — Skill trigger', () => {
  it('clears post-merge gates when /kaizen-reflect invoked', () => {
    writeStateFile(TEST_STATE_DIR, 'post-merge-org_repo_42', {
      PR_URL: 'https://github.com/org/repo/pull/42',
      STATUS: 'needs_post_merge',
      BRANCH: TEST_BRANCH,
    });

    const output = processPostMergeClear(
      'Skill',
      { skill: 'kaizen-reflect' },
      {},
      TEST_BRANCH,
      TEST_STATE_DIR,
    );

    expect(output).toContain('Post-merge gate cleared');
    expect(output).toContain('1 PR');
    // State file should be gone
    expect(existsSync(join(TEST_STATE_DIR, 'post-merge-org_repo_42'))).toBe(false);
  });

  it('clears post-merge gates when /kaizen invoked', () => {
    writeStateFile(TEST_STATE_DIR, 'post-merge-org_repo_42', {
      PR_URL: 'https://github.com/org/repo/pull/42',
      STATUS: 'needs_post_merge',
      BRANCH: TEST_BRANCH,
    });

    const output = processPostMergeClear(
      'Skill',
      { skill: 'kaizen' },
      {},
      TEST_BRANCH,
      TEST_STATE_DIR,
    );

    expect(output).toContain('Post-merge gate cleared');
  });

  it('clears multiple post-merge gates at once', () => {
    writeStateFile(TEST_STATE_DIR, 'post-merge-org_repo_42', {
      PR_URL: 'https://github.com/org/repo/pull/42',
      STATUS: 'needs_post_merge',
      BRANCH: TEST_BRANCH,
    });
    writeStateFile(TEST_STATE_DIR, 'post-merge-org_repo_43', {
      PR_URL: 'https://github.com/org/repo/pull/43',
      STATUS: 'needs_post_merge',
      BRANCH: TEST_BRANCH,
    });

    const output = processPostMergeClear(
      'Skill',
      { skill: 'kaizen-reflect' },
      {},
      TEST_BRANCH,
      TEST_STATE_DIR,
    );

    expect(output).toContain('2 PRs');
  });

  it('does not clear gates from other branches', () => {
    writeStateFile(TEST_STATE_DIR, 'post-merge-org_repo_42', {
      PR_URL: 'https://github.com/org/repo/pull/42',
      STATUS: 'needs_post_merge',
      BRANCH: 'other-branch',
    });

    const output = processPostMergeClear(
      'Skill',
      { skill: 'kaizen-reflect' },
      {},
      TEST_BRANCH,
      TEST_STATE_DIR,
    );

    expect(output).toBe('');
    // State file should still exist
    expect(existsSync(join(TEST_STATE_DIR, 'post-merge-org_repo_42'))).toBe(true);
  });

  it('returns empty for unrelated skills', () => {
    writeStateFile(TEST_STATE_DIR, 'post-merge-org_repo_42', {
      PR_URL: 'https://github.com/org/repo/pull/42',
      STATUS: 'needs_post_merge',
      BRANCH: TEST_BRANCH,
    });

    const output = processPostMergeClear(
      'Skill',
      { skill: 'kaizen-pick' },
      {},
      TEST_BRANCH,
      TEST_STATE_DIR,
    );

    expect(output).toBe('');
  });
});

describe('processPostMergeClear — Bash trigger (MERGED detection)', () => {
  it('promotes awaiting_merge to needs_post_merge on MERGED confirmation', () => {
    writeStateFile(TEST_STATE_DIR, 'post-merge-org_repo_50', {
      PR_URL: 'https://github.com/org/repo/pull/50',
      STATUS: 'awaiting_merge',
      BRANCH: TEST_BRANCH,
    });

    const output = processPostMergeClear(
      'Bash',
      { command: 'gh pr view 50 --json state --jq .state' },
      { stdout: 'MERGED', exit_code: 0 },
      TEST_BRANCH,
      TEST_STATE_DIR,
    );

    expect(output).toContain('PR merge confirmed');
    expect(output).toContain('pull/50');

    // awaiting_merge should be cleared, needs_post_merge should be written
    const stateFile = join(TEST_STATE_DIR, 'post-merge-org_repo_50');
    expect(existsSync(stateFile)).toBe(true);
    const state = parseStateFile(readFileSync(stateFile, 'utf-8'));
    expect(state.STATUS).toBe('needs_post_merge');
    expect(state.BRANCH).toBe(TEST_BRANCH);
  });

  it('detects JSON MERGED format', () => {
    writeStateFile(TEST_STATE_DIR, 'post-merge-org_repo_50', {
      PR_URL: 'https://github.com/org/repo/pull/50',
      STATUS: 'awaiting_merge',
      BRANCH: TEST_BRANCH,
    });

    const output = processPostMergeClear(
      'Bash',
      { command: 'gh pr view 50' },
      { stdout: '{"state": "MERGED"}', exit_code: 0 },
      TEST_BRANCH,
      TEST_STATE_DIR,
    );

    expect(output).toContain('PR merge confirmed');
  });

  it('ignores non-gh-pr-view commands', () => {
    const output = processPostMergeClear(
      'Bash',
      { command: 'git status' },
      { stdout: 'MERGED', exit_code: 0 },
      TEST_BRANCH,
      TEST_STATE_DIR,
    );

    expect(output).toBe('');
  });

  it('ignores failed commands', () => {
    const output = processPostMergeClear(
      'Bash',
      { command: 'gh pr view 50' },
      { stdout: 'MERGED', exit_code: 1 },
      TEST_BRANCH,
      TEST_STATE_DIR,
    );

    expect(output).toBe('');
  });

  it('ignores when no awaiting_merge state exists', () => {
    const output = processPostMergeClear(
      'Bash',
      { command: 'gh pr view 50 --json state --jq .state' },
      { stdout: 'MERGED', exit_code: 0 },
      TEST_BRANCH,
      TEST_STATE_DIR,
    );

    expect(output).toBe('');
  });
});

describe('cross-session isolation (kaizen #786)', () => {
  it('never clears gates from other branches via Skill', () => {
    writeStateFile(TEST_STATE_DIR, 'post-merge-org_repo_99', {
      PR_URL: 'https://github.com/org/repo/pull/99',
      STATUS: 'needs_post_merge',
      BRANCH: 'worktree-session-A',
    });

    const output = processPostMergeClear(
      'Skill',
      { skill: 'kaizen-reflect' },
      {},
      'worktree-session-B',
      TEST_STATE_DIR,
    );

    expect(output).toBe('');
    expect(existsSync(join(TEST_STATE_DIR, 'post-merge-org_repo_99'))).toBe(true);
  });

  it('returns empty when branch is unknown', () => {
    writeStateFile(TEST_STATE_DIR, 'post-merge-org_repo_99', {
      PR_URL: 'https://github.com/org/repo/pull/99',
      STATUS: 'needs_post_merge',
      BRANCH: 'some-branch',
    });

    const output = processPostMergeClear(
      'Skill',
      { skill: 'kaizen-reflect' },
      {},
      '',
      TEST_STATE_DIR,
    );

    expect(output).toBe('');
    expect(existsSync(join(TEST_STATE_DIR, 'post-merge-org_repo_99'))).toBe(true);
  });
});
