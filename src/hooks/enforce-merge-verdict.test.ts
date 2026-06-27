import { describe, it, expect } from 'vitest';
import {
  checkMergeVerdict,
  parseMergeTarget,
  MERGE_BYPASS_ENV,
  type MergeVerdictReader,
} from './enforce-merge-verdict.js';

const REPO = 'Garsson-io/kaizen';
const readerFor = (verdict: 'PASS' | 'PASS_WITH_PARTIALS' | 'FAIL' | null, round: number | null = 4): MergeVerdictReader =>
  () => ({ round: verdict === null ? null : round, verdict });

describe('parseMergeTarget', () => {
  it('parses a full PR URL', () => {
    expect(parseMergeTarget('gh pr merge https://github.com/Garsson-io/kaizen/pull/903 --squash'))
      .toEqual({ repo: 'Garsson-io/kaizen', prNumber: '903' });
  });
  it('parses bare number + --repo', () => {
    expect(parseMergeTarget('gh pr merge 903 --repo Garsson-io/kaizen --squash --auto'))
      .toEqual({ repo: 'Garsson-io/kaizen', prNumber: '903' });
  });
  it('parses bare number using repoFromGit fallback', () => {
    expect(parseMergeTarget('gh pr merge 903 --squash', 'org/repo'))
      .toEqual({ repo: 'org/repo', prNumber: '903' });
  });
  it('returns null when no PR can be determined', () => {
    expect(parseMergeTarget('gh pr merge --squash')).toBeNull();
  });
});

describe('checkMergeVerdict — the gate BLOCKS a FAIL merge (#1220)', () => {
  it('DENIES merge when the latest review round derived FAIL', () => {
    const r = checkMergeVerdict(`gh pr merge 903 --repo ${REPO} --squash --auto`, {
      reader: readerFor('FAIL'),
      env: {},
    });
    expect(r.action).toBe('deny');
    expect(r.message).toMatch(/MERGE BLOCKED/);
    expect(r.message).toMatch(/#903/);
    expect(r.message).toMatch(/FAIL/);
  });

  it('DENIES a FAIL merge given as a URL', () => {
    const r = checkMergeVerdict(`gh pr merge https://github.com/${REPO}/pull/903 --squash`, {
      reader: readerFor('FAIL'),
      env: {},
    });
    expect(r.action).toBe('deny');
  });

  it('ALLOWS merge when the latest round is PASS', () => {
    const r = checkMergeVerdict(`gh pr merge 903 --repo ${REPO} --squash`, {
      reader: readerFor('PASS'),
      env: {},
    });
    expect(r.action).toBe('allow');
  });

  it('ALLOWS merge when the latest round is PASS_WITH_PARTIALS', () => {
    const r = checkMergeVerdict(`gh pr merge 903 --repo ${REPO} --squash`, {
      reader: readerFor('PASS_WITH_PARTIALS'),
      env: {},
    });
    expect(r.action).toBe('allow');
  });

  it('WARNS (does not block) when the PR has no stored review', () => {
    const r = checkMergeVerdict(`gh pr merge 903 --repo ${REPO} --squash`, {
      reader: readerFor(null),
      env: {},
    });
    expect(r.action).toBe('warn');
    expect(r.message).toMatch(/no stored review/);
  });

  it('OVERRIDE: KAIZEN_ALLOW_MERGE_FAIL=1 allows a FAIL merge but logs it', () => {
    const r = checkMergeVerdict(`gh pr merge 903 --repo ${REPO} --squash`, {
      reader: readerFor('FAIL'),
      env: { [MERGE_BYPASS_ENV]: '1' },
    });
    expect(r.action).toBe('allow');
    expect(r.bypassed).toBe(true);
    expect(r.message).toMatch(/OVERRIDE/);
  });

  it('the override does NOT fire for any other value', () => {
    const r = checkMergeVerdict(`gh pr merge 903 --repo ${REPO} --squash`, {
      reader: readerFor('FAIL'),
      env: { [MERGE_BYPASS_ENV]: 'true' },
    });
    expect(r.action).toBe('deny');
  });

  it('ALLOWS non-merge commands without touching the reader', () => {
    let called = false;
    const r = checkMergeVerdict(`gh pr create --title x`, {
      reader: () => { called = true; return { round: 1, verdict: 'FAIL' }; },
      env: {},
    });
    expect(r.action).toBe('allow');
    expect(called).toBe(false);
  });

  it('does not match `gh pr merge` appearing inside a quoted string argument', () => {
    const r = checkMergeVerdict(`echo "remember to gh pr merge later"`, {
      reader: readerFor('FAIL'),
      env: {},
    });
    expect(r.action).toBe('allow');
  });

  it('WARNS when the reader throws (e.g. network error) rather than blocking blindly', () => {
    const r = checkMergeVerdict(`gh pr merge 903 --repo ${REPO} --squash`, {
      reader: () => { throw new Error('gh offline'); },
      env: {},
    });
    expect(r.action).toBe('warn');
    expect(r.message).toMatch(/gh offline/);
  });

  it('WARNS when the PR cannot be identified from the command', () => {
    const r = checkMergeVerdict(`gh pr merge --squash`, {
      reader: readerFor('FAIL'),
      env: {},
    });
    expect(r.action).toBe('warn');
  });
});
