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
      'Closes: #55', // GitHub also honors the colon form
      'Parent: #999', // mention, not a closing keyword
      'Refs: Garsson-io/kaizen#888',
    ].join('\n');
    expect(extractClosingIssues(body).sort()).toEqual(['1215', '42', '55', '7']);
  });

  it('returns no numbers for a body with only mentions', () => {
    expect(extractClosingIssues('Parent: #1\nRefs: #2')).toEqual([]);
  });

  it('does not false-match keyword substrings (word boundary)', () => {
    // "disclosed"/"prefixed"/"hotfixes"/"unresolved" embed close/fix/resolve.
    const body = 'disclosed #5\nprefixed #9\nhotfixes #11\nunresolved #13';
    expect(extractClosingIssues(body)).toEqual([]);
  });
});

describe('reconcileClosedIssueStatusLabels — #1229', () => {
  // Mock ghRun: closing-keyword issue is CLOSED and carries `labels` (passed in).
  // `labelsByIssue` lets a test give different label sets per issue number.
  function makeLabelGhRun(
    state: string,
    labels: string[],
    labelsByIssue?: Record<string, string[]>,
  ) {
    return vi.fn((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('state'))
        return state;
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('labels')) {
        const num = args[2];
        return JSON.stringify(labelsByIssue?.[num] ?? labels);
      }
      return '';
    });
  }

  // Helper: collect the argv of every `issue edit` call.
  const editCalls = (ghRun: ReturnType<typeof vi.fn>) =>
    ghRun.mock.calls.map(c => c[0]).filter((a: string[]) => a[1] === 'edit');

  it('removes the in-progress label and stamps status:done in SEPARATE calls', () => {
    const ghRun = makeLabelGhRun('CLOSED', ['kaizen', 'status:has-pr']);
    reconcileClosedIssueStatusLabels('Closes #1215', ghRun);

    const edits = editCalls(ghRun);
    // remove and add are independent calls — a missing status:done can't abort the removal
    expect(edits).toContainEqual([
      'issue', 'edit', '1215', '--repo', 'Garsson-io/kaizen',
      '--remove-label', 'status:has-pr',
    ]);
    expect(edits).toContainEqual([
      'issue', 'edit', '1215', '--repo', 'Garsson-io/kaizen',
      '--add-label', 'status:done',
    ]);
  });

  it('removes every in-progress label present in a single remove call', () => {
    const ghRun = makeLabelGhRun('CLOSED', ['status:has-pr', 'status:active']);
    reconcileClosedIssueStatusLabels('Fixes #42', ghRun);

    const removeEdit = editCalls(ghRun).find((a: string[]) =>
      a.includes('--remove-label'),
    )!;
    const removed = removeEdit
      .map((v: string, i: number) => (v === '--remove-label' ? removeEdit[i + 1] : null))
      .filter(Boolean);
    expect(removed.sort()).toEqual(['status:active', 'status:has-pr']);
  });

  it('a failing status:done add does NOT block the in-progress removal', () => {
    // Simulate a host repo where status:done is undefined: --add-label throws.
    const ghRun = vi.fn((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('state'))
        return 'CLOSED';
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('labels'))
        return JSON.stringify(['status:has-pr']);
      if (args[1] === 'edit' && args.includes('--add-label'))
        throw new Error("'status:done' not found");
      return '';
    });
    reconcileClosedIssueStatusLabels('Closes #42', ghRun);

    // The removal still happened despite the add throwing.
    expect(editCalls(ghRun)).toContainEqual([
      'issue', 'edit', '42', '--repo', 'Garsson-io/kaizen',
      '--remove-label', 'status:has-pr',
    ]);
  });

  it('does not re-add status:done when it is already present', () => {
    const ghRun = makeLabelGhRun('CLOSED', ['status:has-pr', 'status:done']);
    reconcileClosedIssueStatusLabels('Closes #42', ghRun);

    const addEdits = editCalls(ghRun).filter((a: string[]) =>
      a.includes('--add-label'),
    );
    expect(addEdits).toHaveLength(0);
  });

  it('reconciles every closing-keyword issue in a multi-issue body', () => {
    const ghRun = makeLabelGhRun('CLOSED', [], {
      '42': ['status:has-pr'],
      '43': ['status:active'],
    });
    reconcileClosedIssueStatusLabels('Closes #42\nFixes #43', ghRun);

    const removed = editCalls(ghRun)
      .filter((a: string[]) => a.includes('--remove-label'))
      .map((a: string[]) => a[2]);
    expect(removed.sort()).toEqual(['42', '43']);
  });

  it('does NOT stamp status:done when no in-progress label is present', () => {
    const ghRun = makeLabelGhRun('CLOSED', ['kaizen', 'bug']);
    reconcileClosedIssueStatusLabels('Closes #42', ghRun);
    expect(editCalls(ghRun)).toHaveLength(0);
  });

  it('skips issues that are still OPEN', () => {
    const ghRun = makeLabelGhRun('OPEN', ['status:has-pr']);
    reconcileClosedIssueStatusLabels('Closes #42', ghRun);
    expect(editCalls(ghRun)).toHaveLength(0);
  });

  it('tolerates malformed labels output without throwing or editing', () => {
    const ghRun = vi.fn((args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('state'))
        return 'CLOSED';
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('labels'))
        return 'not-json';
      return '';
    });
    expect(() =>
      reconcileClosedIssueStatusLabels('Closes #42', ghRun),
    ).not.toThrow();
    expect(editCalls(ghRun)).toHaveLength(0);
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
