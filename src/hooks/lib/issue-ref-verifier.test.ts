/**
 * issue-ref-verifier.test.ts — unit tests for the outcome-verification predicate
 * that backs the reflection gate (kaizen #950 / #943).
 */

import { describe, it, expect } from 'vitest';
import {
  parseIssueRef,
  verifyIssueRef,
  type GhRunner,
} from './issue-ref-verifier.js';

describe('parseIssueRef', () => {
  it('parses bare #N', () => {
    expect(parseIssueRef('#123')).toEqual({ number: 123 });
  });
  it('parses bare N', () => {
    expect(parseIssueRef('456')).toEqual({ number: 456 });
  });
  it('parses owner/repo#N', () => {
    expect(parseIssueRef('Garsson-io/kaizen#789')).toEqual({
      repo: 'Garsson-io/kaizen',
      number: 789,
    });
  });
  it('parses a full issues URL', () => {
    expect(
      parseIssueRef('https://github.com/Garsson-io/kaizen/issues/950'),
    ).toEqual({ repo: 'Garsson-io/kaizen', number: 950 });
  });
  it('parses a full pull URL', () => {
    expect(
      parseIssueRef('https://github.com/owner/repo/pull/42'),
    ).toEqual({ repo: 'owner/repo', number: 42 });
  });
  it('tolerates trailing text after #N', () => {
    expect(parseIssueRef('#321 (filed)')).toEqual({ number: 321 });
  });
  it('returns null when there is no number', () => {
    expect(parseIssueRef('not a ref')).toBeNull();
    expect(parseIssueRef('')).toBeNull();
  });
});

// A runner factory: maps "repo#number" lookups to a canned result.
function runnerFor(
  existing: Set<string>,
  opts: { infraError?: boolean } = {},
): GhRunner {
  return (args: string[]) => {
    if (opts.infraError) {
      return { status: 1, stdout: '', stderr: 'error connecting to api.github.com' };
    }
    // args: ['issue'|'pr', 'view', '<n>', '--repo', '<repo>', '--json', ...]
    const sub = args[0];
    const num = args[2];
    const repoIdx = args.indexOf('--repo');
    const repo = repoIdx >= 0 ? args[repoIdx + 1] : '';
    const key = `${sub}:${repo}#${num}`;
    if (existing.has(key)) return { status: 0, stdout: '{"number":' + num + '}', stderr: '' };
    return {
      status: 1,
      stdout: '',
      stderr: `GraphQL: Could not resolve to an Issue with the number of ${num}. (repository.issue)`,
    };
  };
}

describe('verifyIssueRef', () => {
  it('returns "exists" when the issue exists in a candidate repo', () => {
    const runner = runnerFor(new Set(['issue:Garsson-io/kaizen#123']));
    expect(verifyIssueRef('#123', ['Garsson-io/kaizen'], runner)).toBe('exists');
  });

  it('returns "exists" when the ref is a PR (not an issue) in the repo', () => {
    const runner = runnerFor(new Set(['pr:Garsson-io/kaizen#42']));
    expect(verifyIssueRef('#42', ['Garsson-io/kaizen'], runner)).toBe('exists');
  });

  it('returns "missing" when the number resolves to nothing in any candidate repo', () => {
    const runner = runnerFor(new Set()); // nothing exists
    expect(verifyIssueRef('#9999', ['Garsson-io/kaizen'], runner)).toBe('missing');
  });

  it('finds the issue in a secondary candidate repo (host mode)', () => {
    const runner = runnerFor(new Set(['issue:host/app#5']));
    expect(
      verifyIssueRef('#5', ['Garsson-io/kaizen', 'host/app'], runner),
    ).toBe('exists');
  });

  it('prefers the repo embedded in a full URL over candidates', () => {
    const runner = runnerFor(new Set(['issue:explicit/repo#7']));
    expect(
      verifyIssueRef(
        'https://github.com/explicit/repo/issues/7',
        ['Garsson-io/kaizen'],
        runner,
      ),
    ).toBe('exists');
  });

  it('returns "unverifiable" on infra/network error (fail-open)', () => {
    const runner = runnerFor(new Set(), { infraError: true });
    expect(verifyIssueRef('#123', ['Garsson-io/kaizen'], runner)).toBe(
      'unverifiable',
    );
  });

  it('returns "unverifiable" when the ref cannot be parsed', () => {
    const runner = runnerFor(new Set());
    expect(verifyIssueRef('garbage', ['Garsson-io/kaizen'], runner)).toBe(
      'unverifiable',
    );
  });

  it('returns "unverifiable" when there are no candidate repos and no URL', () => {
    const runner = runnerFor(new Set());
    expect(verifyIssueRef('#123', [], runner)).toBe('unverifiable');
  });
});
