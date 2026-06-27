/**
 * Tests for enforce-merge-verdict — the #1220/#1227 merge→verdict binding.
 *
 * Adversarial intent: prove the gate actually BLOCKS a merge when the latest
 * review round derives FAIL (the exact #1212 hole), via the injected-reader
 * end-to-end path; and prove it does NOT over-fire (PASS allows, no-data warns,
 * explicit override allows + logs).
 */

import { describe, it, expect } from 'vitest';
import {
  decideMergeGate,
  parseMergeTarget,
  checkMergeVerdict,
  MERGE_OVERRIDE_ENV,
  type VerdictReader,
} from './enforce-merge-verdict.js';

describe('parseMergeTarget', () => {
  it('parses bare PR number + --repo', () => {
    expect(parseMergeTarget('gh pr merge 123 --repo Garsson-io/kaizen --squash')).toEqual({
      pr: '123',
      repo: 'Garsson-io/kaizen',
    });
  });

  it('parses the URL form auto-dent emits', () => {
    expect(
      parseMergeTarget(
        'gh pr merge https://github.com/Garsson-io/kaizen/pull/456 --repo Garsson-io/kaizen --squash --delete-branch --auto',
      ),
    ).toEqual({ pr: '456', repo: 'Garsson-io/kaizen' });
  });

  it('returns null when no repo and no URL', () => {
    expect(parseMergeTarget('gh pr merge 123 --squash')).toBeNull();
  });
});

describe('decideMergeGate — pure decision (#1220)', () => {
  const target = { pr: '1212', repo: 'Garsson-io/kaizen' };

  it('DENIES a merge when the verdict is FAIL (the #1212 hole)', () => {
    const r = decideMergeGate('FAIL', { override: false, target });
    expect(r.action).toBe('deny');
    expect(r.message).toContain('MERGE BLOCKED');
    expect(r.message).toContain('PR #1212');
  });

  it('allows PASS', () => {
    expect(decideMergeGate('PASS', { override: false, target }).action).toBe('allow');
  });

  it('allows PASS_WITH_PARTIALS', () => {
    expect(decideMergeGate('PASS_WITH_PARTIALS', { override: false, target }).action).toBe('allow');
  });

  it('warns (does not block) when there is no review data', () => {
    expect(decideMergeGate(null, { override: false, target }).action).toBe('warn');
  });

  it('allows FAIL under explicit override but flags + logs it', () => {
    const r = decideMergeGate('FAIL', { override: true, target });
    expect(r.action).toBe('allow');
    expect(r.bypassed).toBe(true);
    expect(r.message).toContain('OVERRIDE');
    expect(r.message).toContain(MERGE_OVERRIDE_ENV);
  });
});

describe('checkMergeVerdict — end to end with injected reader', () => {
  const failReader: VerdictReader = () => 'FAIL';
  const passReader: VerdictReader = () => 'PASS';
  const noDataReader: VerdictReader = () => null;
  const throwReader: VerdictReader = () => {
    throw new Error('gh offline');
  };

  it('BLOCKS a real merge command when the latest round is FAIL', () => {
    const r = checkMergeVerdict(
      'gh pr merge https://github.com/Garsson-io/kaizen/pull/1212 --repo Garsson-io/kaizen --squash --auto',
      { readVerdict: failReader, env: {} },
    );
    expect(r.action).toBe('deny');
    expect(r.message).toContain('MERGE BLOCKED');
  });

  it('allows a merge when the latest round is PASS', () => {
    const r = checkMergeVerdict('gh pr merge 1212 --repo Garsson-io/kaizen --squash', {
      readVerdict: passReader,
      env: {},
    });
    expect(r.action).toBe('allow');
  });

  it('warns (not block) when the PR has no review rounds', () => {
    const r = checkMergeVerdict('gh pr merge 999 --repo Garsson-io/kaizen', {
      readVerdict: noDataReader,
      env: {},
    });
    expect(r.action).toBe('warn');
  });

  it('honours the explicit override env on a FAIL', () => {
    const r = checkMergeVerdict('gh pr merge 1212 --repo Garsson-io/kaizen', {
      readVerdict: failReader,
      env: { [MERGE_OVERRIDE_ENV]: '1' },
    });
    expect(r.action).toBe('allow');
    expect(r.bypassed).toBe(true);
  });

  it('fails OPEN (warn) if the verdict read throws — a hiccup must not wedge every merge', () => {
    const r = checkMergeVerdict('gh pr merge 1212 --repo Garsson-io/kaizen', {
      readVerdict: throwReader,
      env: {},
    });
    expect(r.action).toBe('warn');
  });

  it('ignores non-merge commands', () => {
    expect(checkMergeVerdict('gh pr create --title x', { readVerdict: failReader }).action).toBe('allow');
    expect(checkMergeVerdict('git push origin HEAD', { readVerdict: failReader }).action).toBe('allow');
    expect(checkMergeVerdict('echo gh pr merge 1', { readVerdict: failReader }).action).toBe('allow');
  });

  it('is advisory when the merge target cannot be resolved', () => {
    const r = checkMergeVerdict('gh pr merge --squash', { readVerdict: failReader });
    expect(r.action).toBe('warn');
  });
});
