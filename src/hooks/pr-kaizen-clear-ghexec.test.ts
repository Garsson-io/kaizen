/**
 * pr-kaizen-clear-ghexec.test.ts — proves the gh-exec DRY migration (#1306).
 *
 * The reflection-comment, issue-view, and issue-close paths must go through the
 * shared gh-exec argv boundary (no shell-string interpolation), which is the
 * precondition for dropping pr-kaizen-clear.ts from the gh-exec invariant
 * allowlist. The companion `gh-exec-invariant.test.ts` enforces the allowlist;
 * this file enforces the runtime behavior behind it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gh } from '../lib/gh-exec.js';
import { defaultPostComment, autoCloseKaizenIssues } from './pr-kaizen-clear.js';

vi.mock('../lib/gh-exec.js', () => ({
  gh: vi.fn(() => ''),
}));

const mockGh = vi.mocked(gh);

beforeEach(() => vi.clearAllMocks());

describe('defaultPostComment — gh-exec argv migration', () => {
  it('posts via argv array + stdin, never a shell command string', () => {
    defaultPostComment(
      'https://github.com/Garsson-io/kaizen/pull/100',
      'reflection body',
    );

    expect(mockGh).toHaveBeenCalledTimes(1);
    const [args, timeout, input] = mockGh.mock.calls[0];
    expect(args).toEqual([
      'pr',
      'comment',
      '100',
      '--repo',
      'Garsson-io/kaizen',
      '--body-file',
      '-',
    ]);
    expect(input).toBe('reflection body');
    expect(timeout).toBe(15000);
    // No element is a fused "gh ..." shell string.
    expect((args as string[]).some(a => a.includes(' '))).toBe(false);
  });

  it('no-ops when the PR url is unparseable', () => {
    defaultPostComment('not-a-url', 'body');
    expect(mockGh).not.toHaveBeenCalled();
  });
});

describe('autoCloseKaizenIssues — gh-exec argv migration', () => {
  const PR_URL = 'https://github.com/Garsson-io/kaizen/pull/100';

  function makeGhRun(state: string) {
    return vi.fn((args: string[]) => {
      if (args[0] === 'pr' && args.includes('state')) return 'MERGED';
      if (args[0] === 'pr' && args.includes('body'))
        return 'Closes Garsson-io/kaizen#42';
      if (args[0] === 'issue' && args[1] === 'view') return state;
      return '';
    });
  }

  it('routes issue view and close through the injected ghRun argv boundary', () => {
    const ghRun = makeGhRun('OPEN');
    autoCloseKaizenIssues(PR_URL, ghRun);

    expect(ghRun).toHaveBeenCalledWith([
      'issue',
      'view',
      '42',
      '--repo',
      'Garsson-io/kaizen',
      '--json',
      'state',
      '--jq',
      '.state',
    ]);
    expect(ghRun).toHaveBeenCalledWith([
      'issue',
      'close',
      '42',
      '--repo',
      'Garsson-io/kaizen',
      '--comment',
      `Auto-closed: PR merged (${PR_URL})`,
    ]);
  });

  it('does not close an issue that is already CLOSED', () => {
    const ghRun = makeGhRun('CLOSED');
    autoCloseKaizenIssues(PR_URL, ghRun);

    const closeCalls = ghRun.mock.calls.filter(c => c[0][1] === 'close');
    expect(closeCalls).toHaveLength(0);
  });

  it('does nothing when the PR is not MERGED', () => {
    const ghRun = vi.fn((args: string[]) => {
      if (args[0] === 'pr' && args.includes('state')) return 'OPEN';
      return '';
    });
    autoCloseKaizenIssues(PR_URL, ghRun);

    expect(ghRun.mock.calls.every(c => c[0][0] === 'pr')).toBe(true);
  });
});
