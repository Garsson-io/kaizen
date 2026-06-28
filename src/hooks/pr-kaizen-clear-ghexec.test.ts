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
import {
  defaultPostComment,
  autoCloseKaizenIssues,
  extractClosingIssues,
  reconcileClosedIssueStatusLabels,
} from './pr-kaizen-clear.js';

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

  it('pins issue view/close to the kaizen repo even when the PR lives elsewhere (host mode)', () => {
    // Host-project mode: the PR is on the host repo, but the kaizen-scoped regex
    // only extracts Garsson-io/kaizen issue refs — so the issue calls must stay
    // pinned to the kaizen repo, NOT the PR-derived host repo.
    const hostPrUrl = 'https://github.com/acme/widgets/pull/9';
    const ghRun = vi.fn((args: string[]) => {
      if (args[0] === 'pr' && args.includes('state')) return 'MERGED';
      if (args[0] === 'pr' && args.includes('body'))
        return 'Closes Garsson-io/kaizen#42';
      if (args[0] === 'issue' && args[1] === 'view') return 'OPEN';
      return '';
    });
    autoCloseKaizenIssues(hostPrUrl, ghRun);

    const issueCalls = ghRun.mock.calls
      .map(c => c[0])
      .filter(a => a[0] === 'issue');
    expect(issueCalls.length).toBeGreaterThan(0);
    for (const a of issueCalls) {
      expect(a[a.indexOf('--repo') + 1]).toBe('Garsson-io/kaizen');
    }
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

describe('extractClosingIssues — #1229', () => {
  it('parses close/fix/resolve keywords with and without repo prefix', () => {
    const body = [
      'Closes #1215',
      'Fixes Garsson-io/kaizen#42',
      'resolved #7',
      'Parent: #999', // mention, not a closing keyword
      'Refs: Garsson-io/kaizen#888',
    ].join('\n');
    expect(extractClosingIssues(body).sort()).toEqual(['1215', '42', '7']);
  });

  it('returns no numbers for a body with only mentions', () => {
    expect(extractClosingIssues('Parent: #1\nRefs: #2')).toEqual([]);
  });
});

describe('reconcileClosedIssueStatusLabels — #1229', () => {
  // Mock ghRun: closing-keyword issue is CLOSED and carries `labels` (passed in).
  function makeLabelGhRun(state: string, labels: string[]) {
    return vi.fn((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('state'))
        return state;
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('labels'))
        return JSON.stringify(labels);
      return '';
    });
  }

  it('removes the in-progress status label and adds status:done on a closed issue', () => {
    const ghRun = makeLabelGhRun('CLOSED', ['kaizen', 'status:has-pr']);
    reconcileClosedIssueStatusLabels('Closes #1215', ghRun);

    const edit = ghRun.mock.calls.map(c => c[0]).find(a => a[1] === 'edit');
    expect(edit).toEqual([
      'issue',
      'edit',
      '1215',
      '--repo',
      'Garsson-io/kaizen',
      '--remove-label',
      'status:has-pr',
      '--add-label',
      'status:done',
    ]);
  });

  it('removes every in-progress label present in one edit call', () => {
    const ghRun = makeLabelGhRun('CLOSED', ['status:has-pr', 'status:active']);
    reconcileClosedIssueStatusLabels('Fixes #42', ghRun);

    const edit = ghRun.mock.calls.map(c => c[0]).find(a => a[1] === 'edit')!;
    const removed = edit
      .map((v, i) => (v === '--remove-label' ? edit[i + 1] : null))
      .filter(Boolean);
    expect(removed.sort()).toEqual(['status:active', 'status:has-pr']);
    expect(edit).toContain('--add-label');
  });

  it('does NOT stamp status:done when no in-progress label is present', () => {
    const ghRun = makeLabelGhRun('CLOSED', ['kaizen', 'bug']);
    reconcileClosedIssueStatusLabels('Closes #42', ghRun);

    const editCalls = ghRun.mock.calls.map(c => c[0]).filter(a => a[1] === 'edit');
    expect(editCalls).toHaveLength(0);
  });

  it('skips issues that are still OPEN', () => {
    const ghRun = makeLabelGhRun('OPEN', ['status:has-pr']);
    reconcileClosedIssueStatusLabels('Closes #42', ghRun);

    const editCalls = ghRun.mock.calls.map(c => c[0]).filter(a => a[1] === 'edit');
    expect(editCalls).toHaveLength(0);
  });

  it('does not reconcile mentioned-but-not-closed issues', () => {
    const ghRun = makeLabelGhRun('CLOSED', ['status:has-pr']);
    reconcileClosedIssueStatusLabels('Parent: #999\nRefs: #888', ghRun);
    expect(ghRun).not.toHaveBeenCalled();
  });

  it('pins all label calls to the kaizen repo even for a host-repo PR body', () => {
    const ghRun = makeLabelGhRun('CLOSED', ['status:active']);
    reconcileClosedIssueStatusLabels('Closes Garsson-io/kaizen#42', ghRun);

    const issueCalls = ghRun.mock.calls.map(c => c[0]).filter(a => a[0] === 'issue');
    expect(issueCalls.length).toBeGreaterThan(0);
    for (const a of issueCalls) {
      expect(a[a.indexOf('--repo') + 1]).toBe('Garsson-io/kaizen');
    }
    // every argv element is a discrete token — no fused shell string
    for (const a of issueCalls) expect(a.some(t => t.includes(' '))).toBe(false);
  });
});
