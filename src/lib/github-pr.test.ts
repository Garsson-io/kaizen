import { describe, expect, it } from 'vitest';
import {
  findOpenPrUrlForBranch,
  parseBranchPrQueryResult,
  parseFirstPrUrl,
  parseIssueNumber,
  parseIssueState,
  queryBranchPrState,
  queryIssueState,
} from './github-pr.js';

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

describe('parseBranchPrQueryResult', () => {
  it('derives mostRecent, hasOpen, and openUrl from newest-first gh output', () => {
    const result = parseBranchPrQueryResult(JSON.stringify([
      { number: 3, state: 'MERGED', url: 'https://github.com/o/r/pull/3' },
      { number: 2, state: 'OPEN', url: 'https://github.com/o/r/pull/2' },
      { number: 1, state: 'CLOSED', url: 'https://github.com/o/r/pull/1' },
    ]));

    expect(result).toEqual({
      mostRecent: { number: 3, state: 'MERGED', url: 'https://github.com/o/r/pull/3' },
      hasOpen: true,
      openUrl: 'https://github.com/o/r/pull/2',
    });
  });

  it('returns an empty result for empty, malformed, or missing-field output', () => {
    expect(parseBranchPrQueryResult('[]')).toEqual({ mostRecent: null, hasOpen: false });
    expect(parseBranchPrQueryResult('{not json')).toEqual({ mostRecent: null, hasOpen: false });
    expect(parseBranchPrQueryResult(JSON.stringify([{ number: 1, state: 'OPEN' }]))).toEqual({
      mostRecent: null,
      hasOpen: false,
    });
  });
});

describe('queryBranchPrState', () => {
  it('runs a repo-scoped all-state branch PR query', () => {
    const calls: string[][] = [];
    const result = queryBranchPrState({
      repo: 'owner/repo',
      branch: 'case/branch',
      gh: (args) => {
        calls.push(args);
        return JSON.stringify([{ number: 4, state: 'OPEN', url: 'https://github.com/owner/repo/pull/4' }]);
      },
    });

    expect(result.openUrl).toBe('https://github.com/owner/repo/pull/4');
    expect(calls).toEqual([[
      'pr', 'list',
      '--repo', 'owner/repo',
      '--head', 'case/branch',
      '--state', 'all',
      '--json', 'number,state,url',
      '--limit', '5',
    ]]);
  });

  it('returns an empty result when repo or branch is missing', () => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      return '[]';
    };

    expect(queryBranchPrState({ repo: '', branch: 'case/branch', gh })).toEqual({ mostRecent: null, hasOpen: false });
    expect(queryBranchPrState({ repo: 'owner/repo', branch: '', gh })).toEqual({ mostRecent: null, hasOpen: false });
    expect(calls).toEqual([]);
  });

  it('returns an empty result when gh throws', () => {
    const result = queryBranchPrState({
      repo: 'owner/repo',
      branch: 'case/branch',
      gh: () => {
        throw new Error('gh unavailable');
      },
    });

    expect(result).toEqual({ mostRecent: null, hasOpen: false });
  });
});

describe('parseIssueNumber', () => {
  it('extracts the number from #N, bare N, and a URL', () => {
    expect(parseIssueNumber('#1225')).toBe(1225);
    expect(parseIssueNumber('1225')).toBe(1225);
    expect(parseIssueNumber('https://github.com/o/r/issues/1225')).toBe(1225);
  });

  it('returns null for empty, missing, or digit-free tokens', () => {
    expect(parseIssueNumber(undefined)).toBeNull();
    expect(parseIssueNumber(null)).toBeNull();
    expect(parseIssueNumber('')).toBeNull();
    expect(parseIssueNumber('not an issue')).toBeNull();
  });
});

describe('parseIssueState', () => {
  it('maps OPEN and CLOSED case-insensitively', () => {
    expect(parseIssueState(JSON.stringify({ state: 'OPEN' }))).toBe('OPEN');
    expect(parseIssueState(JSON.stringify({ state: 'CLOSED' }))).toBe('CLOSED');
    expect(parseIssueState(JSON.stringify({ state: 'closed' }))).toBe('CLOSED');
  });

  it('returns null for malformed, empty, or unexpected state (fail-open)', () => {
    expect(parseIssueState('')).toBeNull();
    expect(parseIssueState('{not json')).toBeNull();
    expect(parseIssueState(JSON.stringify({ state: 'MERGED' }))).toBeNull();
    expect(parseIssueState(JSON.stringify({}))).toBeNull();
  });
});

describe('queryIssueState', () => {
  it('runs a repo-scoped issue view and returns the parsed state', () => {
    const calls: string[][] = [];
    const result = queryIssueState({
      repo: 'owner/repo',
      issue: 1225,
      gh: (args) => {
        calls.push(args);
        return JSON.stringify({ state: 'CLOSED' });
      },
    });

    expect(result).toBe('CLOSED');
    expect(calls).toEqual([[
      'issue', 'view', '1225',
      '--repo', 'owner/repo',
      '--json', 'state',
    ]]);
  });

  it('returns null without calling gh when repo or issue is missing', () => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      return JSON.stringify({ state: 'OPEN' });
    };

    expect(queryIssueState({ repo: '', issue: 1, gh })).toBeNull();
    expect(queryIssueState({ repo: 'owner/repo', issue: NaN, gh })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('returns null when gh throws (fail-open)', () => {
    const result = queryIssueState({
      repo: 'owner/repo',
      issue: 1225,
      gh: () => {
        throw new Error('gh unavailable');
      },
    });

    expect(result).toBeNull();
  });
});
