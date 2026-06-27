import { describe, expect, it } from 'vitest';
import { findOpenPrUrlForBranch, parseFirstPrUrl } from './github-pr.js';

describe('parseFirstPrUrl', () => {
  it('returns the first PR URL from gh JSON output', () => {
    expect(parseFirstPrUrl(JSON.stringify([{ url: 'https://github.com/o/r/pull/1' }]))).toBe(
      'https://github.com/o/r/pull/1',
    );
  });

  it('returns undefined for empty, malformed, or missing-url output', () => {
    expect(parseFirstPrUrl('[]')).toBeUndefined();
    expect(parseFirstPrUrl('{not json')).toBeUndefined();
    expect(parseFirstPrUrl(JSON.stringify([{ number: 1 }]))).toBeUndefined();
  });
});

describe('findOpenPrUrlForBranch', () => {
  it('runs a repo-scoped open PR branch lookup and returns the first URL', () => {
    const calls: string[][] = [];
    const result = findOpenPrUrlForBranch({
      repo: 'owner/repo',
      branch: 'case/branch',
      gh: (args) => {
        calls.push(args);
        return JSON.stringify([{ url: 'https://github.com/owner/repo/pull/123' }]);
      },
    });

    expect(result).toBe('https://github.com/owner/repo/pull/123');
    expect(calls).toEqual([[
      'pr', 'list',
      '--repo', 'owner/repo',
      '--head', 'case/branch',
      '--state', 'open',
      '--json', 'url',
      '--limit', '1',
    ]]);
  });

  it('omits --repo when the caller wants gh to infer the repository', () => {
    const calls: string[][] = [];
    findOpenPrUrlForBranch({
      branch: 'case/branch',
      gh: (args) => {
        calls.push(args);
        return '[]';
      },
    });

    expect(calls[0]).not.toContain('--repo');
    expect(calls[0]).toContain('--head');
  });

  it('returns undefined when gh throws', () => {
    const result = findOpenPrUrlForBranch({
      branch: 'case/branch',
      gh: () => {
        throw new Error('gh unavailable');
      },
    });

    expect(result).toBeUndefined();
  });
});
