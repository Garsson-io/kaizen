/**
 * hook-gym-push-review.test.ts — TDD test for push→review round 2 trigger.
 *
 * Bug hypothesis: After review round 1 passes, a small push (under
 * SMALL_PUSH_THRESHOLD) gets auto-passed instead of triggering round 2.
 * This means review fix pushes skip review entirely.
 *
 * The auto-pass path (line 396 of pr-review-loop.ts) checks:
 *   incrementalLines > 0 && incrementalLines <= 15 && cumulativeLines <= 100
 * If a review fix push is small (say 5 lines), it auto-passes.
 *
 * Expected: pushes after a review should ALWAYS require review,
 * regardless of size. Auto-pass should only apply to the first push
 * after PR create (where no review has happened yet), not after review.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { processHookInput, writeReviewSentinel, SMALL_PUSH_THRESHOLD } from '../src/hooks/pr-review-loop.js';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'push-review-test-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function readState(filename: string): Record<string, string> {
  const filePath = join(stateDir, filename);
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf-8');
  const state: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) state[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return state;
}

function createState(filename: string, fields: Record<string, string>): void {
  const content = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  writeFileSync(join(stateDir, filename), content);
}

const PR_URL = 'https://github.com/Garsson-io/kaizen/pull/999';
const STATE_KEY = 'Garsson-io_kaizen_999';
const BRANCH = 'worktree-feat+test';
const REVIEWED_SHA = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';

// Seed the review-loop state file for round 1 with a valid reviewed SHA.
// Only STATUS differs across scenarios ('passed' = review happened,
// 'needs_review' = PR just created, no review yet).
function seedReviewState(status: string): void {
  createState(STATE_KEY, {
    PR_URL,
    ROUND: '1',
    STATUS: status,
    BRANCH,
    LAST_REVIEWED_SHA: REVIEWED_SHA,
    LAST_FULL_REVIEW_SHA: REVIEWED_SHA,
  });
}

// Simulate a successful `git push`. The SHA always exists; only the diff
// size varies (under SMALL_PUSH_THRESHOLD of 15 = small, above = large).
function simulatePush(diffLines: number) {
  return processHookInput(
    {
      tool_input: { command: 'git push' },
      tool_response: { stdout: 'To github.com:...', stderr: '', exit_code: '0' },
    },
    {
      stateDir,
      branch: BRANCH,
      checkShaExists: () => true,
      computeDiffLines: () => diffLines,
      isMergeFromMainPush: () => false,
    },
  );
}

describe('push after review should trigger new review round', () => {

  it('small push after round 1 PASSED should still require review (not auto-pass)', () => {
    // Round 1 review has passed; a small push (5 lines, under SMALL_PUSH_THRESHOLD)
    // should still require review because it lands AFTER a review round.
    seedReviewState('passed');
    const decision = simulatePush(5);

    expect(decision.action).toBe('needs_review');
    expect(decision.reason).toBe('push_exceeds_threshold');

    // Verify state was updated to needs_review round 2
    const state = readState(STATE_KEY);
    expect(state.STATUS).toBe('needs_review');
    expect(state.ROUND).toBe('2');
  });

  it('auto-pass SHOULD be allowed for first push (no prior review)', () => {
    // PR was just created, round 1 is needs_review (no review happened yet).
    // A small supplementary push (e.g., hook auto-fixed formatting) may auto-pass.
    seedReviewState('needs_review');
    const decision = simulatePush(5);

    expect(decision.action).toBe('auto_pass');
  });

  it('large push after review should also require review', () => {
    seedReviewState('passed');
    const decision = simulatePush(50);

    // Large push always requires review
    expect(decision.action).toBe('needs_review');
    expect(decision.reason).toBe('push_exceeds_threshold');
  });

  it('documents the SMALL_PUSH_THRESHOLD constant', () => {
    expect(SMALL_PUSH_THRESHOLD).toBe(15);
  });
});
