import { describe, it, expect, vi } from 'vitest';
import {
  evaluateCiProof,
  waitForCiProof,
  type CommandRunner,
  type CommandResult,
} from './review-ci-proof.js';
import { prTarget, issueTarget } from './structured-data.js';

const pr = prTarget('903', 'Garsson-io/kaizen');
const issue = issueTarget('904', 'Garsson-io/kaizen');

const ok = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: '' });

/**
 * Build a fake runner driven by simple matchers on the joined arg string.
 * `gh pr checks` exits non-zero in real life when pending/failing, so callers
 * must NOT trust status — these fakes return status 0 with the JSON payload to
 * mirror that the code parses stdout, not the exit code.
 */
function runner(map: {
  revParse?: string;
  prView?: string;
  prChecks?: string;
}): CommandRunner {
  return (command, args) => {
    const joined = `${command} ${args.join(' ')}`;
    if (command === 'git' && args.includes('rev-parse')) return ok(map.revParse ?? 'HEAD_SHA');
    if (joined.includes('pr view')) return ok(map.prView ?? '');
    if (joined.includes('pr checks')) return ok(map.prChecks ?? '');
    return ok('');
  };
}

const passChecks = JSON.stringify([
  { name: 'TypeScript tests + coverage', bucket: 'pass', state: 'SUCCESS' },
  { name: 'auto-merge', bucket: 'skipping', state: 'SKIPPED' },
]);
const pendingChecks = JSON.stringify([
  { name: 'TypeScript tests + coverage', bucket: 'pending', state: 'IN_PROGRESS' },
]);
const failChecks = JSON.stringify([
  { name: 'TypeScript tests + coverage', bucket: 'fail', state: 'FAILURE' },
]);

describe('evaluateCiProof', () => {
  it('returns pass when current head matches and all buckets pass/skipping', () => {
    const r = evaluateCiProof(pr, { expectedHeadSha: 'abc' }, runner({ prView: 'abc', prChecks: passChecks }));
    expect(r.status).toBe('pass');
    expect(r.currentHead).toBe('abc');
  });

  it('returns pending (not fail) when any bucket is pending', () => {
    const r = evaluateCiProof(pr, { expectedHeadSha: 'abc' }, runner({ prView: 'abc', prChecks: pendingChecks }));
    expect(r.status).toBe('pending');
  });

  it('returns fail when a bucket is failing', () => {
    const r = evaluateCiProof(pr, { expectedHeadSha: 'abc' }, runner({ prView: 'abc', prChecks: failChecks }));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/not green/i);
  });

  it('returns fail when a bucket is cancelled', () => {
    const checks = JSON.stringify([{ name: 'x', bucket: 'cancel', state: 'CANCELLED' }]);
    const r = evaluateCiProof(pr, { expectedHeadSha: 'abc' }, runner({ prView: 'abc', prChecks: checks }));
    expect(r.status).toBe('fail');
  });

  it('returns stale when the PR head no longer matches the reviewed head', () => {
    const r = evaluateCiProof(pr, { expectedHeadSha: 'abc' }, runner({ prView: 'def', prChecks: passChecks }));
    expect(r.status).toBe('stale');
    expect(r.reviewedHead).toBe('abc');
    expect(r.currentHead).toBe('def');
  });

  it('returns no_checks when the checks array is empty', () => {
    const r = evaluateCiProof(pr, { expectedHeadSha: 'abc' }, runner({ prView: 'abc', prChecks: '[]' }));
    expect(r.status).toBe('no_checks');
  });

  it('returns skipped for a non-PR (issue) target — never throws (#1222.1)', () => {
    const r = evaluateCiProof(issue, {}, runner({}));
    expect(r.status).toBe('skipped');
  });

  it('resolves the reviewed head from git when not passed explicitly', () => {
    const r = evaluateCiProof(pr, {}, runner({ revParse: 'zzz', prView: 'zzz', prChecks: passChecks }));
    expect(r.status).toBe('pass');
    expect(r.reviewedHead).toBe('zzz');
  });

  it('returns pending (wait, not fail) when the PR head cannot be read', () => {
    const failing: CommandRunner = (command, args) => {
      if (command === 'git') return ok('abc');
      return { status: 1, stdout: '', stderr: 'gh: could not connect' };
    };
    const r = evaluateCiProof(pr, { expectedHeadSha: 'abc' }, failing);
    expect(r.status).toBe('pending');
  });
});

describe('waitForCiProof', () => {
  it('polls pending → pass and returns pass', async () => {
    const sequence = ['pending', 'pending', 'pass'];
    let i = 0;
    const seqRunner: CommandRunner = (command, args) => {
      const joined = `${command} ${args.join(' ')}`;
      if (command === 'git') return ok('abc');
      if (joined.includes('pr view')) return ok('abc');
      if (joined.includes('pr checks')) {
        const phase = sequence[Math.min(i, sequence.length - 1)];
        i++;
        return ok(phase === 'pass' ? passChecks : pendingChecks);
      }
      return ok('');
    };
    const sleep = vi.fn(async () => {});
    const r = await waitForCiProof(pr, {
      expectedHeadSha: 'abc',
      runner: seqRunner,
      sleep,
      now: (() => { let t = 0; return () => (t += 1000); })(),
      timeoutMs: 100_000,
      intervalMs: 1000,
    });
    expect(r.status).toBe('pass');
    expect(sleep).toHaveBeenCalled();
  });

  it('returns pending (NOT fail) after the timeout elapses (#1221)', async () => {
    const sleep = vi.fn(async () => {});
    let t = 0;
    const r = await waitForCiProof(pr, {
      expectedHeadSha: 'abc',
      runner: runner({ prView: 'abc', prChecks: pendingChecks }),
      sleep,
      now: () => (t += 60_000), // each call jumps 60s → exceeds timeout fast
      timeoutMs: 100_000,
      intervalMs: 1000,
    });
    expect(r.status).toBe('pending');
  });

  it('returns immediately on a terminal fail without sleeping', async () => {
    const sleep = vi.fn(async () => {});
    const r = await waitForCiProof(pr, {
      expectedHeadSha: 'abc',
      runner: runner({ prView: 'abc', prChecks: failChecks }),
      sleep,
      now: (() => { let t = 0; return () => (t += 1000); })(),
    });
    expect(r.status).toBe('fail');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('returns skipped immediately for a non-PR target', async () => {
    const sleep = vi.fn(async () => {});
    const r = await waitForCiProof(issue, { runner: runner({}), sleep });
    expect(r.status).toBe('skipped');
    expect(sleep).not.toHaveBeenCalled();
  });
});
