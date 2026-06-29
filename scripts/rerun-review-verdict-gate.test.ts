import { describe, expect, it, vi } from 'vitest';
import {
  decideRerun,
  fetchWorkflowRuns,
  isReviewSummaryAttachmentComment,
  rerunReviewVerdictGate,
  selectPrHeadPullRequestRun,
  type GhRunner,
  type ReviewGateWorkflowRun,
} from './rerun-review-verdict-gate.js';

const HEAD = '16588db5eeac5682111b2e5c411445c79e4e6ded';

function run(overrides: Partial<ReviewGateWorkflowRun>): ReviewGateWorkflowRun {
  return {
    id: 100,
    event: 'pull_request',
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'failure',
    ...overrides,
  };
}

function ok(stdout: string) {
  return { status: 0, stdout, stderr: '' };
}

describe('isReviewSummaryAttachmentComment', () => {
  it('matches only kaizen review summary attachment marker comments', () => {
    expect(isReviewSummaryAttachmentComment('<!-- kaizen:review/r1/summary -->\n## Review Round 1')).toBe(true);
    expect(isReviewSummaryAttachmentComment('<!-- kaizen:review/r12/correctness -->')).toBe(false);
    expect(isReviewSummaryAttachmentComment('plain review summary prose')).toBe(false);
  });
});

describe('selectPrHeadPullRequestRun', () => {
  it('chooses the newest pull_request run for the current PR head SHA', () => {
    const selected = selectPrHeadPullRequestRun([
      run({ id: 1, event: 'workflow_dispatch', head_sha: HEAD, conclusion: 'success' }),
      run({ id: 2, event: 'pull_request', head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
      run({ id: 3, event: 'pull_request', head_sha: HEAD }),
    ], HEAD);

    expect(selected?.id).toBe(3);
  });

  it('ignores runs without a run id', () => {
    expect(selectPrHeadPullRequestRun([run({ id: undefined, database_id: undefined })], HEAD)).toBeNull();
  });
});

describe('decideRerun', () => {
  it('reruns completed non-success pull_request runs', () => {
    expect(decideRerun(run({ conclusion: 'failure' }))).toEqual({
      action: 'rerun',
      reason: 'matching pull_request run concluded failure',
    });
  });

  it('skips active runs and successful runs', () => {
    expect(decideRerun(run({ status: 'in_progress', conclusion: null })).action).toBe('skip');
    expect(decideRerun(run({ conclusion: 'success' })).action).toBe('skip');
  });
});

describe('fetchWorkflowRuns', () => {
  it('lists only pull_request runs for the exact head SHA', () => {
    const gh = vi.fn(() => ok(JSON.stringify({ workflow_runs: [] })));

    fetchWorkflowRuns('Garsson-io/kaizen', 'review-verdict-gate.yml', HEAD, gh);

    expect(gh).toHaveBeenCalledWith([
      'api',
      '--method',
      'GET',
      'repos/Garsson-io/kaizen/actions/workflows/review-verdict-gate.yml/runs',
      '-F',
      'event=pull_request',
      '-F',
      `head_sha=${HEAD}`,
      '-F',
      'per_page=50',
    ], 30_000);
  });
});

describe('rerunReviewVerdictGate', () => {
  it('reruns the matching failed pull_request run for the current PR head', () => {
    const gh: GhRunner = vi.fn((args) => {
      if (args[0] === 'pr') return ok(`${HEAD}\n`);
      if (args[0] === 'api' && args.includes('/rerun')) return ok('');
      return ok(JSON.stringify({ workflow_runs: [run({ id: 28345819453 })] }));
    });

    const result = rerunReviewVerdictGate('Garsson-io/kaizen', '1658', { gh });

    expect(result).toMatchObject({ action: 'rerun', runId: 28345819453 });
    expect(gh).toHaveBeenLastCalledWith([
      'api',
      '--method',
      'POST',
      'repos/Garsson-io/kaizen/actions/runs/28345819453/rerun',
    ], 30_000);
  });

  it('does not rerun an already successful pull_request run', () => {
    const gh: GhRunner = vi.fn((args) => {
      if (args[0] === 'pr') return ok(`${HEAD}\n`);
      return ok(JSON.stringify({ workflow_runs: [run({ id: 44, conclusion: 'success' })] }));
    });

    const result = rerunReviewVerdictGate('Garsson-io/kaizen', '1658', { gh });

    expect(result).toEqual({
      action: 'skip',
      runId: 44,
      message: 'matching pull_request run already succeeded',
    });
    expect(vi.mocked(gh).mock.calls.some(([args]) => args.includes('/rerun'))).toBe(false);
  });
});
