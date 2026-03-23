import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  postInFlightUpdate,
  buildInFlightComment,
  type StreamContext,
} from './auto-dent-stream.js';
import type { RunResult } from './auto-dent-run.js';
import * as github from './auto-dent-github.js';

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    prs: [],
    issuesFiled: [],
    issuesClosed: [],
    cases: [],
    cost: 0,
    toolCalls: 0,
    stopRequested: false,
    linesDeleted: 0,
    issuesPruned: 0,
    ...overrides,
  };
}

describe('postInFlightUpdate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when progressIssue is empty', () => {
    const result = makeResult();
    const ctx: StreamContext = {};
    expect(postInFlightUpdate('', 'owner/repo', 1, Date.now(), result, ctx)).toBe(false);
  });

  it('returns false when kaizenRepo is empty', () => {
    const result = makeResult();
    const ctx: StreamContext = {};
    expect(
      postInFlightUpdate('https://github.com/o/r/issues/42', '', 1, Date.now(), result, ctx),
    ).toBe(false);
  });

  it('returns false when progressIssue has no issue number', () => {
    const result = makeResult();
    const ctx: StreamContext = {};
    expect(postInFlightUpdate('not-a-url', 'owner/repo', 1, Date.now(), result, ctx)).toBe(false);
  });

  it('posts a comment and returns true on success', () => {
    const ghExecSpy = vi.spyOn(github, 'ghExec').mockReturnValue('ok');
    const result = makeResult({ toolCalls: 5, cost: 1.23 });
    const ctx: StreamContext = {};

    const posted = postInFlightUpdate(
      'https://github.com/o/r/issues/42',
      'owner/repo',
      3,
      Date.now() - 60_000,
      result,
      ctx,
    );

    expect(posted).toBe(true);
    expect(ghExecSpy).toHaveBeenCalledOnce();
    const cmd = ghExecSpy.mock.calls[0][0];
    expect(cmd).toContain('gh issue comment 42');
    expect(cmd).toContain('--repo owner/repo');
  });

  it('returns false when ghExec returns empty string', () => {
    vi.spyOn(github, 'ghExec').mockReturnValue('');
    const result = makeResult();
    const ctx: StreamContext = {};

    const posted = postInFlightUpdate(
      'https://github.com/o/r/issues/42',
      'owner/repo',
      1,
      Date.now(),
      result,
      ctx,
    );

    expect(posted).toBe(false);
  });
});

describe('buildInFlightComment', () => {
  it('shows working status when no resultReceivedAt', () => {
    const result = makeResult({ toolCalls: 10, cost: 2.5 });
    const ctx: StreamContext = {};
    const comment = buildInFlightComment(2, Date.now() - 120_000, result, ctx);

    expect(comment).toContain('Run #2');
    expect(comment).toContain('working');
    expect(comment).toContain('10');
    expect(comment).toContain('$2.50');
  });

  it('shows waiting status when resultReceivedAt is set', () => {
    const result = makeResult({ toolCalls: 5, cost: 1.0 });
    const ctx: StreamContext = { resultReceivedAt: Date.now() - 5_000 };
    const comment = buildInFlightComment(1, Date.now() - 60_000, result, ctx);

    expect(comment).toContain('waiting for process exit');
  });

  it('includes last activity and phase when present', () => {
    const result = makeResult();
    const ctx: StreamContext = { lastActivity: 'Read foo.ts', lastPhase: 'IMPLEMENT' };
    const comment = buildInFlightComment(1, Date.now(), result, ctx);

    expect(comment).toContain('Read foo.ts');
    expect(comment).toContain('IMPLEMENT');
  });

  it('includes PRs when present', () => {
    const result = makeResult({ prs: ['https://github.com/o/r/pull/1'] });
    const ctx: StreamContext = {};
    const comment = buildInFlightComment(1, Date.now(), result, ctx);

    expect(comment).toContain('https://github.com/o/r/pull/1');
  });
});
