import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupMergedReviewStates } from './session-cleanup.js';

const TEST_STATE_DIR = '/tmp/.test-session-cleanup';

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
  vi.restoreAllMocks();
});

function writeState(filename: string, prUrl: string, status: string, branch: string) {
  writeFileSync(
    join(TEST_STATE_DIR, filename),
    `PR_URL=${prUrl}\nSTATUS=${status}\nBRANCH=${branch}\n`,
    { mode: 0o600 },
  );
}

function makeStale(filename: string) {
  const filepath = join(TEST_STATE_DIR, filename);
  const old = new Date(Date.now() - 3 * 3600 * 1000); // 3 hours ago
  utimesSync(filepath, old, old);
}

describe('cleanupMergedReviewStates', () => {
  it('returns 0 when no state files exist', () => {
    expect(cleanupMergedReviewStates(TEST_STATE_DIR)).toBe(0);
  });

  it('returns 0 when directory does not exist', () => {
    rmSync(TEST_STATE_DIR, { recursive: true });
    expect(cleanupMergedReviewStates(TEST_STATE_DIR)).toBe(0);
  });

  it('ignores non-review state files', () => {
    writeState('post-merge-1', 'https://github.com/org/repo/pull/42', 'needs_post_merge', 'main');
    // Should not try to gh pr view for non-review states
    expect(cleanupMergedReviewStates(TEST_STATE_DIR)).toBe(0);
    expect(existsSync(join(TEST_STATE_DIR, 'post-merge-1'))).toBe(true);
  });

  it('prunes stale files regardless of status', () => {
    writeState('stale-review', 'https://github.com/org/repo/pull/42', 'needs_review', 'main');
    makeStale('stale-review');

    cleanupMergedReviewStates(TEST_STATE_DIR);
    // Stale file should be pruned by pruneStaleStateFiles
    expect(existsSync(join(TEST_STATE_DIR, 'stale-review'))).toBe(false);
  });

  it('removes review state files for merged PRs', () => {
    const prUrl = 'https://github.com/org/repo/pull/42';
    writeState('needs-review-merged', prUrl, 'needs_review', 'feature');

    const cleaned = cleanupMergedReviewStates(TEST_STATE_DIR, {
      readPrState: vi.fn().mockReturnValue('MERGED'),
    });

    expect(cleaned).toBe(1);
    expect(existsSync(join(TEST_STATE_DIR, 'needs-review-merged'))).toBe(false);
  });

  it('removes review state files for closed PRs', () => {
    const prUrl = 'https://github.com/org/repo/pull/43';
    writeState('needs-review-closed', prUrl, 'needs_review', 'feature');

    const cleaned = cleanupMergedReviewStates(TEST_STATE_DIR, {
      readPrState: vi.fn().mockReturnValue('CLOSED'),
    });

    expect(cleaned).toBe(1);
    expect(existsSync(join(TEST_STATE_DIR, 'needs-review-closed'))).toBe(false);
  });

  it('keeps review state files for open PRs', () => {
    const prUrl = 'https://github.com/org/repo/pull/44';
    writeState('needs-review-open', prUrl, 'needs_review', 'feature');

    const cleaned = cleanupMergedReviewStates(TEST_STATE_DIR, {
      readPrState: vi.fn().mockReturnValue('OPEN'),
    });

    expect(cleaned).toBe(0);
    expect(existsSync(join(TEST_STATE_DIR, 'needs-review-open'))).toBe(true);
  });

  it('ignores PR state lookup failures', () => {
    const prUrl = 'https://github.com/org/repo/pull/45';
    writeState('needs-review-failure', prUrl, 'needs_review', 'feature');

    const cleaned = cleanupMergedReviewStates(TEST_STATE_DIR, {
      readPrState: vi.fn().mockImplementation(() => {
        throw new Error('gh failed');
      }),
    });

    expect(cleaned).toBe(0);
    expect(existsSync(join(TEST_STATE_DIR, 'needs-review-failure'))).toBe(true);
  });
});
