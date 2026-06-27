import { describe, it, expect, vi } from 'vitest';
import { makeGhCiVerifier, evaluateChecks, type CommandRunner, type CommandResult, type GhCheck } from './review-ci-proof.js';
import { prTarget, issueTarget } from './structured-data.js';

const pr = prTarget('903', 'Garsson-io/kaizen');
const HEAD = 'abc123def';

/**
 * Build a scripted runner. `git rev-parse HEAD` and `gh pr view` return fixed heads; each call to
 * `gh pr checks` consumes the next entry from `checksScript` (so we can model pending-then-pass).
 */
function makeRunner(opts: {
  reviewedHead?: string;
  prHead?: string;
  checksScript: Array<GhCheck[] | string>;
}): { runner: CommandRunner; checksCalls: () => number } {
  let checksIdx = 0;
  const runner: CommandRunner = (command, args) => {
    const ok = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: '' });
    if (command === 'git' && args[0] === 'rev-parse') return ok(opts.reviewedHead ?? HEAD);
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') return ok(opts.prHead ?? HEAD);
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'checks') {
      const entry = opts.checksScript[Math.min(checksIdx, opts.checksScript.length - 1)];
      checksIdx++;
      return ok(typeof entry === 'string' ? entry : JSON.stringify(entry));
    }
    return { status: 1, stdout: '', stderr: `unexpected ${command} ${args.join(' ')}` };
  };
  return { runner, checksCalls: () => checksIdx };
}

const PASS: GhCheck[] = [
  { name: 'TypeScript tests + coverage', bucket: 'pass', state: 'SUCCESS' },
  { name: 'auto-merge', bucket: 'skipping', state: 'SKIPPED' },
];
const PENDING: GhCheck[] = [{ name: 'TypeScript tests + coverage', bucket: 'pending', state: 'IN_PROGRESS' }];
const FAILING: GhCheck[] = [{ name: 'TypeScript tests + coverage', bucket: 'fail', state: 'FAILURE' }];

describe('evaluateChecks — terminal/waiting classification', () => {
  it('all pass/skipping → pass', () => {
    expect(evaluateChecks(PASS).status).toBe('pass');
  });
  it('zero checks → no_checks (waited, not failed)', () => {
    expect(evaluateChecks([]).status).toBe('no_checks');
  });
  it('any pending → pending', () => {
    expect(evaluateChecks(PENDING).status).toBe('pending');
  });
  it('any fail → fail', () => {
    expect(evaluateChecks(FAILING).status).toBe('fail');
  });
  it('fail wins over a sibling pending (a failed required check will not recover)', () => {
    expect(evaluateChecks([...FAILING, ...PENDING]).status).toBe('fail');
  });
  it('unknown bucket fails closed', () => {
    expect(evaluateChecks([{ name: 'mystery', bucket: 'weird' }]).status).toBe('fail');
  });
  it('undefined bucket is treated as pending (not yet registered)', () => {
    expect(evaluateChecks([{ name: 'just-queued' }]).status).toBe('pending');
  });
});

describe('makeGhCiVerifier — wait-for-CI + structured reasons (#1221/#1222)', () => {
  const noSleep = vi.fn();

  it('returns pass when head matches and all checks are green', () => {
    const { runner } = makeRunner({ checksScript: [PASS] });
    const verify = makeGhCiVerifier({ runner, sleep: noSleep });
    expect(verify(pr, HEAD)).toEqual({ status: 'pass' });
  });

  it('WAIT-FOR-CI: pending-then-pass returns pass after polling (#1221)', () => {
    const { runner, checksCalls } = makeRunner({ checksScript: [PENDING, PENDING, PASS] });
    const verify = makeGhCiVerifier({ runner, sleep: noSleep, pollIntervalMs: 10, timeoutMs: 10_000 });
    expect(verify(pr, HEAD).status).toBe('pass');
    expect(checksCalls()).toBe(3); // it actually polled, not point-in-time
    expect(noSleep).toHaveBeenCalled();
  });

  it('BLOCKS: returns pending (not pass) when CI never finishes before timeout', () => {
    const { runner } = makeRunner({ checksScript: [PENDING] });
    const verify = makeGhCiVerifier({ runner, sleep: noSleep, pollIntervalMs: 10, timeoutMs: 30 });
    const result = verify(pr, HEAD);
    expect(result.status).toBe('pending'); // distinct from fail — caller waits, not exhausts
  });

  it('BLOCKS: returns fail on a red check even with pending siblings', () => {
    const { runner } = makeRunner({ checksScript: [[...FAILING, ...PENDING]] });
    const verify = makeGhCiVerifier({ runner, sleep: noSleep });
    expect(verify(pr, HEAD).status).toBe('fail');
  });

  it('returns no_checks (distinct from fail) when CI never registers checks (#1221)', () => {
    const { runner } = makeRunner({ checksScript: ['[]'] });
    const verify = makeGhCiVerifier({ runner, sleep: noSleep, pollIntervalMs: 10, timeoutMs: 30 });
    expect(verify(pr, HEAD).status).toBe('no_checks');
  });

  it('returns stale_head when PR head moved past the reviewed commit (no checks read)', () => {
    const { runner, checksCalls } = makeRunner({ reviewedHead: HEAD, prHead: 'zzz999', checksScript: [PASS] });
    const verify = makeGhCiVerifier({ runner, sleep: noSleep });
    expect(verify(pr, HEAD).status).toBe('stale_head');
    expect(checksCalls()).toBe(0);
  });

  it('SKIP-NOT-THROW: non-PR target returns skipped without touching the runner (#1222.1)', () => {
    const runner = vi.fn<CommandRunner>(() => ({ status: 0, stdout: '', stderr: '' }));
    const verify = makeGhCiVerifier({ runner, sleep: noSleep });
    expect(verify(issueTarget('904', 'Garsson-io/kaizen'), HEAD)).toEqual({
      status: 'skipped',
      detail: 'non-PR target — CI proof does not apply',
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('resolves the reviewed head from git when no expectedHeadSha is given', () => {
    const { runner } = makeRunner({ reviewedHead: 'gitHEAD', prHead: 'gitHEAD', checksScript: [PASS] });
    const verify = makeGhCiVerifier({ runner, sleep: noSleep });
    expect(verify(pr).status).toBe('pass'); // git rev-parse HEAD == gitHEAD == prHead
  });
});
