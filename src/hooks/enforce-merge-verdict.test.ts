import { describe, expect, it } from 'vitest';
import {
  checkMergeVerdict,
  decideMergeGate,
  MERGE_OVERRIDE_ENV,
  parseMergeTarget,
  type VerdictReader,
} from './enforce-merge-verdict.js';

describe('parseMergeTarget', () => {
  it('parses bare PR number + --repo', () => {
    expect(parseMergeTarget('gh pr merge 123 --repo Garsson-io/kaizen --squash')).toEqual({
      pr: '123',
      repo: 'Garsson-io/kaizen',
    });
  });

  it('parses the full PR URL form', () => {
    expect(
      parseMergeTarget('gh pr merge https://github.com/Garsson-io/kaizen/pull/456 --squash --auto'),
    ).toEqual({ pr: '456', repo: 'Garsson-io/kaizen' });
  });

  it('returns null when no target repo can be resolved', () => {
    expect(parseMergeTarget('gh pr merge 123 --squash')).toBeNull();
  });
});

describe('decideMergeGate', () => {
  const target = { pr: '1212', repo: 'Garsson-io/kaizen' };

  it('denies a merge when the latest round derives FAIL', () => {
    const result = decideMergeGate('FAIL', { override: false, target });
    expect(result.action).toBe('deny');
    expect(result.message).toContain('MERGE BLOCKED');
    expect(result.message).toContain('PR #1212');
  });

  it('allows PASS and PASS_WITH_PARTIALS', () => {
    expect(decideMergeGate('PASS', { override: false, target }).action).toBe('allow');
    expect(decideMergeGate('PASS_WITH_PARTIALS', { override: false, target }).action).toBe('allow');
  });

  it('warns without blocking when no review data exists', () => {
    expect(decideMergeGate(null, { override: false, target }).action).toBe('warn');
  });

  it('allows FAIL under an explicit override and marks it bypassed', () => {
    const result = decideMergeGate('FAIL', { override: true, target });
    expect(result.action).toBe('allow');
    expect(result.bypassed).toBe(true);
    expect(result.message).toContain(MERGE_OVERRIDE_ENV);
  });
});

describe('checkMergeVerdict', () => {
  const failReader: VerdictReader = () => 'FAIL';
  const passReader: VerdictReader = () => 'PASS';
  const noDataReader: VerdictReader = () => null;
  const throwReader: VerdictReader = () => {
    throw new Error('gh offline');
  };

  it('blocks a real merge command when the latest round is FAIL', () => {
    const result = checkMergeVerdict(
      'gh pr merge https://github.com/Garsson-io/kaizen/pull/1212 --repo Garsson-io/kaizen --squash --auto',
      { readVerdict: failReader, env: {} },
    );
    expect(result.action).toBe('deny');
  });

  it('allows a merge when the latest round is PASS', () => {
    expect(checkMergeVerdict('gh pr merge 1212 --repo Garsson-io/kaizen', {
      readVerdict: passReader,
      env: {},
    }).action).toBe('allow');
  });

  it('warns when there are no review rounds', () => {
    expect(checkMergeVerdict('gh pr merge 999 --repo Garsson-io/kaizen', {
      readVerdict: noDataReader,
      env: {},
    }).action).toBe('warn');
  });

  it('honours the explicit override env on FAIL', () => {
    const result = checkMergeVerdict('gh pr merge 1212 --repo Garsson-io/kaizen', {
      readVerdict: failReader,
      env: { [MERGE_OVERRIDE_ENV]: '1' },
    });
    expect(result.action).toBe('allow');
    expect(result.bypassed).toBe(true);
  });

  it('fails open with a warning if verdict reading throws', () => {
    expect(checkMergeVerdict('gh pr merge 1212 --repo Garsson-io/kaizen', {
      readVerdict: throwReader,
      env: {},
    }).action).toBe('warn');
  });

  it('ignores non-merge commands', () => {
    expect(checkMergeVerdict('gh pr create --title x', { readVerdict: failReader }).action).toBe('allow');
    expect(checkMergeVerdict('git push origin HEAD', { readVerdict: failReader }).action).toBe('allow');
    expect(checkMergeVerdict('echo gh pr merge 1', { readVerdict: failReader }).action).toBe('allow');
  });
});
