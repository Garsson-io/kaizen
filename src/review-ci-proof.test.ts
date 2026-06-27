import { describe, it, expect } from 'vitest';
import {
  classifyCiProof,
  waitForCiProof,
  ciProofExitCode,
  formatCiProofFailure,
  EXIT_CI_PENDING,
  EXIT_CI_FAILED,
  type CiProofRunner,
  type GhCheck,
  type CiProofTarget,
} from './review-ci-proof.js';

const PR: CiProofTarget = { kind: 'pr', number: '903', repo: 'org/repo' };

/**
 * Scriptable fake runner. `checksSequence` lets a test feed a different checks
 * snapshot on each poll so the wait-for-CI behaviour can be exercised without
 * real time or network.
 */
function fakeRunner(opts: {
  localHead?: string;
  prHead?: string;
  checks?: GhCheck[];
  checksSequence?: GhCheck[][];
}): CiProofRunner & { sleeps: number[]; clock: { t: number } } {
  const clock = { t: 0 };
  const sleeps: number[] = [];
  let idx = 0;
  return {
    sleeps,
    clock,
    localHead: () => opts.localHead ?? 'HEAD',
    prHeadSha: () => opts.prHead ?? opts.localHead ?? 'HEAD',
    prChecks: () => {
      if (opts.checksSequence) {
        const c = opts.checksSequence[Math.min(idx, opts.checksSequence.length - 1)];
        idx++;
        return c;
      }
      return opts.checks ?? [];
    },
    async sleep(ms: number) {
      sleeps.push(ms);
      clock.t += ms;
    },
    now: () => clock.t,
  };
}

describe('classifyCiProof — point-in-time classification', () => {
  it('skips non-PR targets (terminal, no throw — #1222.1)', () => {
    const r = classifyCiProof({ kind: 'issue', number: '5', repo: 'org/repo' }, {}, fakeRunner({}));
    expect(r.status).toBe('skipped_non_pr');
    expect(r.terminal).toBe(true);
  });

  it('PASS when every check is pass/skipping', () => {
    const checks: GhCheck[] = [
      { name: 'tests', bucket: 'pass', state: 'SUCCESS' },
      { name: 'auto-merge', bucket: 'skipping', state: 'SKIPPED' },
    ];
    const r = classifyCiProof(PR, { expectedHeadSha: 'abc' }, fakeRunner({ prHead: 'abc', checks }));
    expect(r.status).toBe('pass');
    expect(r.terminal).toBe(true);
  });

  it('stale_head when the PR head moved since review (terminal)', () => {
    const r = classifyCiProof(PR, { expectedHeadSha: 'abc' }, fakeRunner({ prHead: 'def', checks: [] }));
    expect(r.status).toBe('stale_head');
    expect(r.terminal).toBe(true);
    expect(r.detail).toMatch(/abc/);
    expect(r.detail).toMatch(/def/);
  });

  it('no_checks (non-terminal) when CI has not produced checks yet', () => {
    const r = classifyCiProof(PR, { expectedHeadSha: 'abc' }, fakeRunner({ prHead: 'abc', checks: [] }));
    expect(r.status).toBe('no_checks');
    expect(r.terminal).toBe(false);
  });

  it('ci_pending (non-terminal) while a check is still running — #1221', () => {
    const checks: GhCheck[] = [
      { name: 'tests', bucket: 'pending', state: 'IN_PROGRESS' },
    ];
    const r = classifyCiProof(PR, { expectedHeadSha: 'abc' }, fakeRunner({ prHead: 'abc', checks }));
    expect(r.status).toBe('ci_pending');
    expect(r.terminal).toBe(false);
  });

  it('ci_failed (terminal) when any check failed', () => {
    const checks: GhCheck[] = [
      { name: 'tests', bucket: 'fail', state: 'FAILURE' },
      { name: 'lint', bucket: 'pass', state: 'SUCCESS' },
    ];
    const r = classifyCiProof(PR, { expectedHeadSha: 'abc' }, fakeRunner({ prHead: 'abc', checks }));
    expect(r.status).toBe('ci_failed');
    expect(r.terminal).toBe(true);
  });

  it('a real fail wins over a pending sibling (terminal fail, not wait)', () => {
    const checks: GhCheck[] = [
      { name: 'tests', bucket: 'pending', state: 'IN_PROGRESS' },
      { name: 'lint', bucket: 'fail', state: 'FAILURE' },
    ];
    const r = classifyCiProof(PR, { expectedHeadSha: 'abc' }, fakeRunner({ prHead: 'abc', checks }));
    expect(r.status).toBe('ci_failed');
  });

  it('uses local HEAD when no expectedHeadSha is supplied', () => {
    const r = classifyCiProof(PR, {}, fakeRunner({ localHead: 'zzz', prHead: 'zzz', checks: [{ bucket: 'pass' }] }));
    expect(r.status).toBe('pass');
  });
});

describe('waitForCiProof — pending is a WAIT, not a FAIL (#1221)', () => {
  it('polls while pending, then returns PASS once CI goes green', async () => {
    const runner = fakeRunner({
      prHead: 'abc',
      localHead: 'abc',
      checksSequence: [
        [{ name: 'tests', bucket: 'pending', state: 'IN_PROGRESS' }],
        [{ name: 'tests', bucket: 'pending', state: 'IN_PROGRESS' }],
        [{ name: 'tests', bucket: 'pass', state: 'SUCCESS' }],
      ],
    });
    const r = await waitForCiProof(PR, { expectedHeadSha: 'abc' }, runner, { timeoutMs: 100000, intervalMs: 10 });
    expect(r.status).toBe('pass');
    expect(runner.sleeps.length).toBe(2); // waited twice before green
  });

  it('returns ci_pending (non-terminal) on timeout — never fabricates pass or fail', async () => {
    const runner = fakeRunner({
      prHead: 'abc',
      localHead: 'abc',
      checks: [{ name: 'tests', bucket: 'pending', state: 'IN_PROGRESS' }],
    });
    const r = await waitForCiProof(PR, { expectedHeadSha: 'abc' }, runner, { timeoutMs: 30, intervalMs: 10 });
    expect(r.status).toBe('ci_pending');
    expect(r.terminal).toBe(false);
  });

  it('returns immediately on a terminal fail without waiting', async () => {
    const runner = fakeRunner({
      prHead: 'abc',
      localHead: 'abc',
      checks: [{ name: 'tests', bucket: 'fail', state: 'FAILURE' }],
    });
    const r = await waitForCiProof(PR, { expectedHeadSha: 'abc' }, runner, { timeoutMs: 100000, intervalMs: 10 });
    expect(r.status).toBe('ci_failed');
    expect(runner.sleeps.length).toBe(0);
  });
});

describe('ciProofExitCode — ci_pending is distinct from a real FAIL', () => {
  it('pass / skipped → 0', () => {
    expect(ciProofExitCode({ status: 'pass', terminal: true })).toBe(0);
    expect(ciProofExitCode({ status: 'skipped_non_pr', terminal: true })).toBe(0);
  });
  it('ci_pending / no_checks → EX_TEMPFAIL (75), NOT a fail', () => {
    expect(ciProofExitCode({ status: 'ci_pending', terminal: false })).toBe(EXIT_CI_PENDING);
    expect(ciProofExitCode({ status: 'no_checks', terminal: false })).toBe(EXIT_CI_PENDING);
  });
  it('stale_head / ci_failed → 1 (real fail)', () => {
    expect(ciProofExitCode({ status: 'stale_head', terminal: true })).toBe(EXIT_CI_FAILED);
    expect(ciProofExitCode({ status: 'ci_failed', terminal: true })).toBe(EXIT_CI_FAILED);
  });
  it('pending failure message announces it is NOT a review FAIL', () => {
    const msg = formatCiProofFailure({ status: 'ci_pending', terminal: false, detail: 'tests: pending' });
    expect(msg).toMatch(/NOT a review FAIL/i);
    expect(msg).toMatch(/75/);
  });
});
