import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideReviewVerdictStatus,
  getReviewVerdictStatus,
  resolveTarget,
} from './review-verdict-status.js';

describe('decideReviewVerdictStatus', () => {
  it('fails when the authoritative stored review round derives FAIL', () => {
    const status = decideReviewVerdictStatus(2, 'FAIL');
    expect(status.outcome).toBe('fail');
    expect(status.message.toLowerCase()).toContain('authoritative');
    expect(status.message).toContain('r2');
  });

  it('passes PASS and PASS_WITH_PARTIALS verdicts', () => {
    expect(decideReviewVerdictStatus(1, 'PASS').outcome).toBe('pass');
    expect(decideReviewVerdictStatus(1, 'PASS_WITH_PARTIALS').outcome).toBe('pass');
  });

  it('does not fail when no stored review data exists', () => {
    expect(decideReviewVerdictStatus(0, null).outcome).toBe('no_data');
  });
});

describe('resolveTarget', () => {
  const originalArgv = process.argv;
  const originalRepo = process.env.GITHUB_REPOSITORY;
  const originalPr = process.env.PR_NUMBER;

  afterEach(() => {
    process.argv = originalArgv;
    if (originalRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepo;
    if (originalPr === undefined) delete process.env.PR_NUMBER;
    else process.env.PR_NUMBER = originalPr;
  });

  it('resolves a numeric PR from --repo plus --pr', () => {
    process.argv = ['node', 'script', '--repo', 'Garsson-io/kaizen', '--pr', '1498'];
    expect(resolveTarget()).toEqual({ repo: 'Garsson-io/kaizen', pr: '1498' });
  });

  it('resolves repo and PR from a full PR URL', () => {
    process.argv = ['node', 'script', '--pr', 'https://github.com/Garsson-io/kaizen/pull/1498'];
    expect(resolveTarget()).toEqual({ repo: 'Garsson-io/kaizen', pr: '1498' });
  });

  it('resolves GitHub Actions environment inputs', () => {
    process.argv = ['node', 'script'];
    process.env.GITHUB_REPOSITORY = 'Garsson-io/kaizen';
    process.env.PR_NUMBER = '1498';
    expect(resolveTarget()).toEqual({ repo: 'Garsson-io/kaizen', pr: '1498' });
  });
});

describe('getReviewVerdictStatus', () => {
  it('reads the authoritative stored review round and fails when it derives FAIL', () => {
    const authoritative = vi.fn(() => 2);
    const derive = vi.fn(() => 'FAIL' as const);

    const status = getReviewVerdictStatus('Garsson-io/kaizen', '1498', {
      authoritativeReviewRound: authoritative,
      deriveStoredRoundVerdict: derive,
    });

    expect(status.outcome).toBe('fail');
    expect(authoritative).toHaveBeenCalledWith({ kind: 'pr', number: '1498', repo: 'Garsson-io/kaizen' });
    expect(derive).toHaveBeenCalledWith({ kind: 'pr', number: '1498', repo: 'Garsson-io/kaizen' }, 2);
  });

  it('uses active r2 instead of stale higher r3 when deriving the gate verdict', () => {
    const authoritative = vi.fn(() => 2);
    const derive = vi.fn((_target, round: number) => round === 2 ? 'PASS' as const : 'FAIL' as const);

    const status = getReviewVerdictStatus('Garsson-io/kaizen', '1498', {
      authoritativeReviewRound: authoritative,
      deriveStoredRoundVerdict: derive,
    });

    expect(status.outcome).toBe('pass');
    expect(status.round).toBe(2);
    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive).toHaveBeenCalledWith({ kind: 'pr', number: '1498', repo: 'Garsson-io/kaizen' }, 2);
  });

  it('does not read a round verdict when no review rounds exist', () => {
    const authoritative = vi.fn(() => 0);
    const derive = vi.fn(() => 'FAIL' as const);

    const status = getReviewVerdictStatus('Garsson-io/kaizen', '1498', {
      authoritativeReviewRound: authoritative,
      deriveStoredRoundVerdict: derive,
    });

    expect(status.outcome).toBe('no_data');
    expect(derive).not.toHaveBeenCalled();
  });
});
