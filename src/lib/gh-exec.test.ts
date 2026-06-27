import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { gh, findOpenPrUrlForBranch } from './gh-exec.js';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

const mockSpawn = vi.mocked(spawnSync);

beforeEach(() => vi.clearAllMocks());

describe('gh — shared GitHub CLI helper', () => {
  it('returns trimmed stdout on success', () => {
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: '  hello world  \n', stderr: '', signal: null, pid: 0, output: [] } as any);
    expect(gh(['issue', 'view', '1'])).toBe('hello world');
  });

  it('passes args as array to spawnSync (no shell injection)', () => {
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: '', stderr: '', signal: null, pid: 0, output: [] } as any);
    gh(['api', '--method', 'PATCH', '/repos/org/repo/issues/comments/123']);
    expect(mockSpawn).toHaveBeenCalledWith('gh', ['api', '--method', 'PATCH', '/repos/org/repo/issues/comments/123'], expect.objectContaining({ timeout: 30_000 }));
  });

  it('throws with stderr on non-zero exit', () => {
    mockSpawn.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'permission denied', signal: null, pid: 0, output: [] } as any);
    expect(() => gh(['issue', 'view', '999'])).toThrow('permission denied');
  });

  it('throws on timeout (null status from killed process)', () => {
    mockSpawn.mockReturnValueOnce({ status: null, stdout: '', stderr: '', signal: 'SIGTERM', pid: 0, output: [] } as any);
    expect(() => gh(['issue', 'view', '1'])).toThrow('failed');
  });

  it('respects custom timeout', () => {
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: 'ok', stderr: '', signal: null, pid: 0, output: [] } as any);
    gh(['issue', 'list'], 60_000);
    expect(mockSpawn).toHaveBeenCalledWith('gh', ['issue', 'list'], expect.objectContaining({ timeout: 60_000 }));
  });

  it('returns empty string when stdout is null/undefined', () => {
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: null, stderr: '', signal: null, pid: 0, output: [] } as any);
    expect(gh(['issue', 'view', '1'])).toBe('');
  });
});

describe('findOpenPrUrlForBranch — shared branch open-PR lookup (#1271)', () => {
  it('returns the first open PR url on a successful parse', () => {
    const exec = () => JSON.stringify([{ url: 'https://github.com/o/r/pull/7' }]);
    expect(findOpenPrUrlForBranch('case/x', { ghExec: exec })).toBe('https://github.com/o/r/pull/7');
  });

  it('returns undefined when no open PR exists (empty array)', () => {
    expect(findOpenPrUrlForBranch('case/x', { ghExec: () => '[]' })).toBeUndefined();
  });

  it('returns undefined on malformed (non-JSON) output without throwing', () => {
    expect(findOpenPrUrlForBranch('case/x', { ghExec: () => 'not json' })).toBeUndefined();
  });

  it('returns undefined when the executor throws (failed lookup)', () => {
    const exec = () => { throw new Error('gh failed'); };
    expect(findOpenPrUrlForBranch('case/x', { ghExec: exec })).toBeUndefined();
  });

  it('scopes the lookup with --repo when a repo is given (rescue policy)', () => {
    let captured: string[] = [];
    const exec = (args: string[]) => { captured = args; return '[]'; };
    findOpenPrUrlForBranch('case/x', { repo: 'owner/repo', ghExec: exec });
    expect(captured.slice(0, 2)).toEqual(['pr', 'list']);
    expect(captured).toEqual(expect.arrayContaining(['--head', 'case/x', '--state', 'open', '--json', 'url']));
    const i = captured.indexOf('--repo');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(captured[i + 1]).toBe('owner/repo');
  });

  it('omits --repo for the ambient-repo review-loop fallback path', () => {
    let captured: string[] = [];
    const exec = (args: string[]) => { captured = args; return '[]'; };
    findOpenPrUrlForBranch('case/x', { ghExec: exec });
    expect(captured).not.toContain('--repo');
  });
});
