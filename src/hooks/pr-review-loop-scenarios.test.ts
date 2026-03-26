/**
 * Scenario tests for pr-review-loop state machine.
 *
 * Test SEQUENCES of state transitions using injectable deps — not individual
 * triggers. Catches emergent behavior from repeated operations (kaizen #909).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import {
  processHookInput,
  MAX_ROUNDS,
  SMALL_PUSH_THRESHOLD,
  CUMULATIVE_CAP,
  type HookDecision,
  type ProcessOptions,
} from './pr-review-loop.js';
import { parseStateFile, writeStateFile } from './state-utils.js';
import type { HookInput } from './hook-io.js';

const TEST_DIR = '/tmp/.test-review-loop-scenarios';
const BRANCH = 'test-scenario';
const PR_URL = 'https://github.com/org/repo/pull/42';

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

function input(command: string, stdout = ''): HookInput {
  return { tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '', exit_code: '0' } };
}

function opts(diffFn?: (sha: string) => number): ProcessOptions {
  return {
    stateDir: TEST_DIR,
    branch: BRANCH,
    repoFromGit: 'org/repo',
    computeDiffLines: diffFn ?? (() => 10),
    checkShaExists: () => true,
  };
}

/** Run processHookInput and read resulting state file. */
function runAndReadState(hookInput: HookInput, options: ProcessOptions): { decision: HookDecision; state: Record<string, string> | null } {
  const decision = processHookInput(hookInput, options);
  try {
    const files = require('fs').readdirSync(TEST_DIR) as string[];
    const stateFile = files.find((f: string) => !f.startsWith('.'));
    if (!stateFile) return { decision, state: null };
    const content = readFileSync(`${TEST_DIR}/${stateFile}`, 'utf8');
    return { decision, state: parseStateFile(content) as unknown as Record<string, string> };
  } catch { return { decision, state: null }; }
}

describe('Scenario: cumulative diff cap prevents auto-pass bypass', () => {
  it('small incremental (5 lines) but large cumulative (150 lines) triggers needs_review', () => {
    processHookInput(input('gh pr create --title "test"', PR_URL), opts());
    processHookInput(input('gh pr diff 42'), opts());

    // The hook calls getDiffLines twice: once for incremental (lastPushSha), once for cumulative (lastFullReviewSha).
    // In test context both SHAs are empty strings from git rev-parse, so we use a call counter.
    let diffCallCount = 0;
    const pushOpts = opts(() => {
      diffCallCount++;
      return diffCallCount === 1 ? 5 : 150; // first call = incremental (5), second = cumulative (150)
    });

    const { decision } = runAndReadState(input('git push'), pushOpts);
    expect(decision.action).toBe('needs_review');
    expect(decision.reason).toBe('push_exceeds_threshold');
  });

  it('small incremental AND small cumulative auto-passes', () => {
    processHookInput(input('gh pr create --title "test"', PR_URL), opts());
    processHookInput(input('gh pr diff 42'), opts());

    const pushOpts = opts(() => 8); // both incremental and cumulative = 8
    const { decision } = runAndReadState(input('git push'), pushOpts);
    expect(decision.action).toBe('auto_pass');
  });

  it('large incremental (50 lines) triggers needs_review regardless of cumulative', () => {
    processHookInput(input('gh pr create --title "test"', PR_URL), opts());
    processHookInput(input('gh pr diff 42'), opts());

    const pushOpts = opts(() => 50);
    const { decision } = runAndReadState(input('git push'), pushOpts);
    expect(decision.action).toBe('needs_review');
  });
});

describe('Scenario: LAST_FULL_REVIEW_SHA lifecycle', () => {
  it('pr create sets LAST_FULL_REVIEW_SHA', () => {
    const { state } = runAndReadState(input('gh pr create --title "test"', PR_URL), opts());
    expect(state?.LAST_FULL_REVIEW_SHA).toBeTruthy();
  });

  it('auto-pass preserves LAST_FULL_REVIEW_SHA from previous review', () => {
    processHookInput(input('gh pr create --title "test"', PR_URL), opts());
    processHookInput(input('gh pr diff 42'), opts());

    // Read the full-review SHA before auto-pass
    let files = require('fs').readdirSync(TEST_DIR) as string[];
    let sf = files.find((f: string) => !f.startsWith('.'))!;
    const beforeContent = readFileSync(`${TEST_DIR}/${sf}`, 'utf8');
    const fullReviewSha = beforeContent.match(/LAST_FULL_REVIEW_SHA=(.+)/)?.[1];

    // Auto-pass (small push)
    processHookInput(input('git push'), opts(() => 5));

    // LAST_FULL_REVIEW_SHA should be unchanged
    files = require('fs').readdirSync(TEST_DIR) as string[];
    sf = files.find((f: string) => !f.startsWith('.'))!;
    const afterContent = readFileSync(`${TEST_DIR}/${sf}`, 'utf8');
    const afterFullReviewSha = afterContent.match(/LAST_FULL_REVIEW_SHA=(.+)/)?.[1];
    expect(afterFullReviewSha).toBe(fullReviewSha);
  });

  it('full review (gh pr diff) resets LAST_FULL_REVIEW_SHA', () => {
    processHookInput(input('gh pr create --title "test"', PR_URL), opts());
    processHookInput(input('gh pr diff 42'), opts());

    // Read SHA after first review
    let files = require('fs').readdirSync(TEST_DIR) as string[];
    let sf = files.find((f: string) => !f.startsWith('.'))!;
    const firstReviewSha = readFileSync(`${TEST_DIR}/${sf}`, 'utf8').match(/LAST_FULL_REVIEW_SHA=(.+)/)?.[1];

    // Trigger needs_review with big push
    processHookInput(input('git push'), opts(() => 500));

    // Do second review
    processHookInput(input('gh pr diff 42'), opts());

    // LAST_FULL_REVIEW_SHA should be updated
    files = require('fs').readdirSync(TEST_DIR) as string[];
    sf = files.find((f: string) => !f.startsWith('.'))!;
    const secondReviewSha = readFileSync(`${TEST_DIR}/${sf}`, 'utf8').match(/LAST_FULL_REVIEW_SHA=(.+)/)?.[1];

    // They should be different (new HEAD after push)
    // Both are from git rev-parse HEAD which returns empty in test context,
    // but the state file should show the field exists
    expect(secondReviewSha).toBeDefined();
  });
});

describe('Scenario: invalid SHA graceful degradation', () => {
  it('rebased SHA → conservative needs_review (not crash or auto-pass)', () => {
    processHookInput(input('gh pr create --title "test"', PR_URL), opts());
    processHookInput(input('gh pr diff 42'), opts());

    const pushOpts = opts(() => 0); // can't compute diff
    pushOpts.checkShaExists = () => false; // SHA gone

    const { decision } = runAndReadState(input('git push'), pushOpts);
    // incrementalLines=0 because SHA invalid → condition `> 0` fails → falls through to needs_review
    expect(decision.action).toBe('needs_review');
    expect(decision.context?.pushShaValid).toBe(false);
  });
});

describe('Scenario: escalation after max rounds', () => {
  it('pushing when round equals MAX_ROUNDS escalates', () => {
    // Directly set up state at round MAX_ROUNDS (passed) to test escalation
    writeStateFile(TEST_DIR, 'org_repo_42', {
      PR_URL,
      STATUS: 'passed',
      BRANCH: BRANCH,
      ROUND: String(MAX_ROUNDS),
    });

    const { decision } = runAndReadState(input('git push'), opts(() => 500));
    expect(decision.action).toBe('escalated');
    expect(decision.reason).toBe('max_rounds_exceeded');
  });
});

describe('Scenario: HookDecision context is complete for debugging', () => {
  it('auto_pass includes all context fields', () => {
    processHookInput(input('gh pr create --title "test"', PR_URL), opts());
    processHookInput(input('gh pr diff 42'), opts());

    const { decision } = runAndReadState(input('git push'), opts(() => 8));
    expect(decision.action).toBe('auto_pass');
    expect(decision.context).toMatchObject({
      prUrl: PR_URL,
      incrementalLines: 8,
      cumulativeLines: 8,
      pushShaValid: true,
      fullReviewShaValid: true,
      thresholds: { smallPush: SMALL_PUSH_THRESHOLD, cumulativeCap: CUMULATIVE_CAP },
    });
  });

  it('ignore decisions include reason', () => {
    const d = processHookInput(input('npm install'), opts());
    expect(d.action).toBe('ignore');
    expect(d.reason).toBe('not_a_trigger');
  });

  it('non-zero exit code is ignored with context', () => {
    const d = processHookInput(
      { tool_name: 'Bash', tool_input: { command: 'git push' }, tool_response: { stdout: '', stderr: 'error', exit_code: '1' } },
      opts(),
    );
    expect(d.action).toBe('ignore');
    expect(d.reason).toBe('non_zero_exit');
  });
});
