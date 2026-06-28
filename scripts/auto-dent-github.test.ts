import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import {
  ghExec,
  parseShellArgs,
  fetchIssueLabels,
  checkMergeStatus,
  driveBatchToMerge,
  classifyMergeView,
  labelArtifacts,
  queueAutoMerge,
  cancelAutoMerge,
  extractLinkedIssue,
  isIssueClosed,
  cleanupSupersededPRs,
  parseEpicChecklist,
  extractAllLinkedIssues,
  syncEpicChecklists,
  verifyIssuesClosed,
  reconcileBatchClosedIssues,
} from './auto-dent-github.js';
import { makeRunResult } from './auto-dent-test-helpers.js';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

const mockSpawnSync = vi.mocked(spawnSync);

// Return a spawnSync success result with the given stdout
function ok(stdout: string) {
  return { stdout, stderr: '', status: 0, pid: 0, signal: null, output: [], error: undefined };
}

// Return a spawnSync result where the command exited non-zero
function fail(stderr = 'command failed') {
  return { stdout: '', stderr, status: 1, pid: 0, signal: null, output: [], error: undefined };
}

// Reconstruct a command string from spawnSync args for assertion convenience.
// With spawnSync, args are passed as separate strings so user data is NOT
// shell-interpolated — but we can still join them for substring matching.
function joinArgs(call: Parameters<typeof spawnSync>): string {
  return [call[0] as string, ...(call[1] as string[])].join(' ');
}

describe('parseShellArgs', () => {
  it('splits simple command', () => {
    expect(parseShellArgs('gh issue list')).toEqual(['gh', 'issue', 'list']);
  });

  it('handles double-quoted strings', () => {
    expect(parseShellArgs('gh issue create --title "My Title"')).toEqual([
      'gh', 'issue', 'create', '--title', 'My Title',
    ]);
  });

  it('handles double-quoted strings with JSON escape sequences', () => {
    expect(parseShellArgs('gh issue create --body "line1\\nline2"')).toEqual([
      'gh', 'issue', 'create', '--body', 'line1\nline2',
    ]);
  });

  it('does NOT execute backticks inside double-quoted strings', () => {
    // This is the core fix: backticks in user-controlled data (e.g. markdown
    // code spans like `worried-fish`) must be parsed as literal characters,
    // not as shell command substitutions.
    const cmd = 'gh issue create --body "see `worried-fish` for details"';
    const args = parseShellArgs(cmd);
    expect(args).toEqual([
      'gh', 'issue', 'create', '--body', 'see `worried-fish` for details',
    ]);
  });

  it('handles single-quoted strings', () => {
    expect(parseShellArgs("gh issue create --title 'My Title'")).toEqual([
      'gh', 'issue', 'create', '--title', 'My Title',
    ]);
  });

  it('handles escaped quotes inside double quotes', () => {
    expect(parseShellArgs('gh issue create --body "say \\"hello\\""')).toEqual([
      'gh', 'issue', 'create', '--body', 'say "hello"',
    ]);
  });

  it('handles multiple spaces between args', () => {
    expect(parseShellArgs('gh  issue  list')).toEqual(['gh', 'issue', 'list']);
  });

  it('handles empty string', () => {
    expect(parseShellArgs('')).toEqual([]);
  });

  it('does NOT interpret $() substitutions', () => {
    const cmd = 'gh issue create --body "cost: $(echo hack)"';
    const args = parseShellArgs(cmd);
    expect(args).toEqual([
      'gh', 'issue', 'create', '--body', 'cost: $(echo hack)',
    ]);
  });
});

describe('ghExec', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it('returns trimmed stdout on success', () => {
    mockSpawnSync.mockReturnValue(ok('  some output  \n') as any);
    expect(ghExec('gh issue list')).toBe('some output');
  });

  it('returns empty string on non-zero exit and does not throw', () => {
    mockSpawnSync.mockReturnValue(fail('gh error') as any);
    expect(ghExec('gh issue list')).toBe('');
  });

  it('returns empty string on spawn error and does not throw', () => {
    mockSpawnSync.mockReturnValue({ ...fail(), error: new Error('spawn failed') } as any);
    expect(ghExec('gh issue list')).toBe('');
  });

  it('passes args as array (no shell interpretation)', () => {
    mockSpawnSync.mockReturnValue(ok('') as any);
    ghExec('gh issue create --body "has `backtick` inside"');
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'gh',
      ['issue', 'create', '--body', 'has `backtick` inside'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });
});

describe('fetchIssueLabels', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it('returns label names from gh output', () => {
    mockSpawnSync.mockReturnValue(
      ok(JSON.stringify({ labels: [{ name: 'bug' }, { name: 'kaizen' }] })) as any,
    );
    expect(fetchIssueLabels('#42', 'owner/repo')).toEqual(['bug', 'kaizen']);
  });

  it('extracts issue number from various formats', () => {
    mockSpawnSync.mockReturnValue(ok(JSON.stringify({ labels: [] })) as any);

    fetchIssueLabels('42', 'owner/repo');
    expect(joinArgs(mockSpawnSync.mock.calls[0] as any)).toContain('42');

    mockSpawnSync.mockClear();
    fetchIssueLabels('#99', 'owner/repo');
    expect(joinArgs(mockSpawnSync.mock.calls[0] as any)).toContain('99');

    mockSpawnSync.mockClear();
    fetchIssueLabels('https://github.com/o/r/issues/123', 'owner/repo');
    expect(joinArgs(mockSpawnSync.mock.calls[0] as any)).toContain('123');
  });

  it('returns empty array for non-numeric input', () => {
    expect(fetchIssueLabels('abc', 'owner/repo')).toEqual([]);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('returns empty array on gh failure', () => {
    mockSpawnSync.mockReturnValue(fail() as any);
    expect(fetchIssueLabels('#42', 'owner/repo')).toEqual([]);
  });
});

describe('checkMergeStatus', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it('returns merged for MERGED state', () => {
    mockSpawnSync.mockReturnValue(
      ok(JSON.stringify({ state: 'MERGED', mergeStateStatus: null, autoMergeRequest: null })) as any,
    );
    expect(checkMergeStatus('https://github.com/o/r/pull/1')).toBe('merged');
  });

  it('returns closed for CLOSED state', () => {
    mockSpawnSync.mockReturnValue(
      ok(JSON.stringify({ state: 'CLOSED', mergeStateStatus: null, autoMergeRequest: null })) as any,
    );
    expect(checkMergeStatus('https://github.com/o/r/pull/1')).toBe('closed');
  });

  it('returns auto_queued when autoMergeRequest is set', () => {
    mockSpawnSync.mockReturnValue(
      ok(JSON.stringify({ state: 'OPEN', mergeStateStatus: 'CLEAN', autoMergeRequest: { enabledAt: '2024-01-01' } })) as any,
    );
    expect(checkMergeStatus('https://github.com/o/r/pull/1')).toBe('auto_queued');
  });

  it('returns open for OPEN state without auto-merge', () => {
    mockSpawnSync.mockReturnValue(
      ok(JSON.stringify({ state: 'OPEN', mergeStateStatus: 'CLEAN', autoMergeRequest: null })) as any,
    );
    expect(checkMergeStatus('https://github.com/o/r/pull/1')).toBe('open');
  });

  it('returns unknown for invalid URL', () => {
    expect(checkMergeStatus('not-a-url')).toBe('unknown');
  });

  it('returns unknown on gh failure', () => {
    mockSpawnSync.mockReturnValue(fail() as any);
    expect(checkMergeStatus('https://github.com/o/r/pull/1')).toBe('unknown');
  });
});

describe('classifyMergeView', () => {
  it('MERGED → terminal merged', () => {
    expect(classifyMergeView({ state: 'MERGED' })).toEqual({ status: 'merged' });
  });

  it('CLOSED → terminal closed', () => {
    expect(classifyMergeView({ state: 'CLOSED' })).toEqual({ status: 'closed' });
  });

  it('DIRTY → stuck:conflicting', () => {
    expect(classifyMergeView({ state: 'OPEN', mergeStateStatus: 'DIRTY' })).toEqual({
      status: 'stuck',
      reason: 'conflicting',
    });
  });

  it('BLOCKED → stuck:blocked', () => {
    expect(classifyMergeView({ state: 'OPEN', mergeStateStatus: 'BLOCKED' })).toEqual({
      status: 'stuck',
      reason: 'blocked',
    });
  });

  it.each(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'])(
    'a check in %s state → stuck:checks_failing (via .state)',
    (s) => {
      expect(
        classifyMergeView({
          state: 'OPEN',
          mergeStateStatus: 'UNSTABLE',
          statusCheckRollup: [{ state: 'SUCCESS' }, { state: s }],
        }),
      ).toEqual({ status: 'stuck', reason: 'checks_failing' });
    },
  );

  it('a check failing via the .conclusion field (not .state) → stuck:checks_failing', () => {
    expect(
      classifyMergeView({
        state: 'OPEN',
        mergeStateStatus: 'UNSTABLE',
        statusCheckRollup: [{ conclusion: 'FAILURE' }],
      }),
    ).toEqual({ status: 'stuck', reason: 'checks_failing' });
  });

  it('checks failure is case-insensitive', () => {
    expect(
      classifyMergeView({
        state: 'OPEN',
        statusCheckRollup: [{ state: 'failure' }],
      }),
    ).toEqual({ status: 'stuck', reason: 'checks_failing' });
  });

  it.each(['BEHIND', 'CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'UNKNOWN', undefined])(
    'non-terminal mergeStateStatus %s with passing checks → null (keep polling)',
    (mss) => {
      expect(
        classifyMergeView({
          state: 'OPEN',
          mergeStateStatus: mss as string | undefined,
          statusCheckRollup: [{ state: 'SUCCESS' }],
        }),
      ).toBeNull();
    },
  );

  it('failing checks take precedence over a DIRTY/BLOCKED state', () => {
    // checks are evaluated before mergeStateStatus
    expect(
      classifyMergeView({
        state: 'OPEN',
        mergeStateStatus: 'DIRTY',
        statusCheckRollup: [{ state: 'FAILURE' }],
      }),
    ).toEqual({ status: 'stuck', reason: 'checks_failing' });
  });
});

describe('driveBatchToMerge', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  // Build a gh mock whose `pr view` responses come from a queue (one per poll),
  // while `update-branch` and other commands return ok. Lets us simulate a PR's
  // state evolving across polling attempts.
  function mockPrViewSequence(views: object[]) {
    let i = 0;
    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmd = args.join(' ');
      if (cmd.includes('pr view')) {
        const v = views[Math.min(i, views.length - 1)];
        i++;
        return ok(JSON.stringify(v));
      }
      return ok('ok'); // update-branch et al
    }) as any);
  }

  const noopSleep = () => {};
  const PR = 'https://github.com/o/r/pull/7';

  it('returns empty for empty input', () => {
    expect(driveBatchToMerge([])).toEqual([]);
  });

  it('skips invalid URLs', () => {
    expect(driveBatchToMerge(['not-a-url'], { sleep: noopSleep })).toEqual([]);
  });

  it('marks a MERGED PR terminal and stops polling it', () => {
    mockPrViewSequence([{ state: 'MERGED', mergeStateStatus: null, autoMergeRequest: null }]);
    const results = driveBatchToMerge([PR], { sleep: noopSleep, maxAttempts: 5 });
    expect(results).toEqual([{ pr: PR, status: 'merged', attempts: 1 }]);
    // exactly one `pr view` — no further polling after terminal
    const views = mockSpawnSync.mock.calls
      .map((c) => joinArgs(c as any))
      .filter((s) => s.includes('pr view'));
    expect(views).toHaveLength(1);
  });

  it('marks a CLOSED PR terminal', () => {
    mockPrViewSequence([{ state: 'CLOSED', mergeStateStatus: null, autoMergeRequest: null }]);
    const results = driveBatchToMerge([PR], { sleep: noopSleep });
    expect(results).toEqual([{ pr: PR, status: 'closed', attempts: 1 }]);
  });

  // The #368 regression guard: a PR BEHIND on a LATER poll must be re-updated,
  // then reach MERGED. A one-shot sweep could not do this.
  it('re-updates a branch that falls BEHIND across polls, then sees it merge', () => {
    mockPrViewSequence([
      { state: 'OPEN', mergeStateStatus: 'BEHIND', autoMergeRequest: { enabledAt: '2024' } },
      { state: 'MERGED', mergeStateStatus: null, autoMergeRequest: null },
    ]);
    const results = driveBatchToMerge([PR], { sleep: noopSleep, maxAttempts: 5 });
    expect(results).toEqual([{ pr: PR, status: 'merged', attempts: 2 }]);
    const cmds = mockSpawnSync.mock.calls.map((c) => joinArgs(c as any));
    expect(cmds.some((c) => c.includes('update-branch'))).toBe(true);
  });

  it('classifies a BLOCKED PR as stuck:blocked and stops polling', () => {
    mockPrViewSequence([
      { state: 'OPEN', mergeStateStatus: 'BLOCKED', autoMergeRequest: { enabledAt: '2024' } },
    ]);
    const results = driveBatchToMerge([PR], { sleep: noopSleep, maxAttempts: 5 });
    expect(results).toEqual([{ pr: PR, status: 'stuck', reason: 'blocked', attempts: 1 }]);
    const views = mockSpawnSync.mock.calls
      .map((c) => joinArgs(c as any))
      .filter((s) => s.includes('pr view'));
    expect(views).toHaveLength(1); // terminal-stuck: no further polling
  });

  it('classifies a DIRTY (conflicting) PR as stuck:conflicting', () => {
    mockPrViewSequence([
      { state: 'OPEN', mergeStateStatus: 'DIRTY', autoMergeRequest: { enabledAt: '2024' } },
    ]);
    const results = driveBatchToMerge([PR], { sleep: noopSleep });
    expect(results).toEqual([{ pr: PR, status: 'stuck', reason: 'conflicting', attempts: 1 }]);
  });

  it('classifies a PR with a failing check as stuck:checks_failing', () => {
    mockPrViewSequence([
      {
        state: 'OPEN',
        mergeStateStatus: 'UNSTABLE',
        autoMergeRequest: { enabledAt: '2024' },
        statusCheckRollup: [
          { name: 'build', state: 'SUCCESS' },
          { name: 'test', state: 'FAILURE' },
        ],
      },
    ]);
    const results = driveBatchToMerge([PR], { sleep: noopSleep });
    expect(results).toEqual([{ pr: PR, status: 'stuck', reason: 'checks_failing', attempts: 1 }]);
  });

  it('is bounded — exhausting maxAttempts on an in-progress PR returns stuck:timed_out', () => {
    // Always CLEAN + auto queued but never merges (CI in progress forever)
    mockPrViewSequence([
      { state: 'OPEN', mergeStateStatus: 'CLEAN', autoMergeRequest: { enabledAt: '2024' } },
    ]);
    const results = driveBatchToMerge([PR], { sleep: noopSleep, maxAttempts: 3 });
    expect(results).toEqual([{ pr: PR, status: 'stuck', reason: 'timed_out', attempts: 3 }]);
    const views = mockSpawnSync.mock.calls
      .map((c) => joinArgs(c as any))
      .filter((s) => s.includes('pr view'));
    expect(views).toHaveLength(3); // polled exactly maxAttempts times
  });

  it('never throws on gh failure — degrades to stuck:unknown within budget', () => {
    mockSpawnSync.mockReturnValue(fail() as any);
    const results = driveBatchToMerge([PR], { sleep: noopSleep, maxAttempts: 2 });
    expect(results).toEqual([{ pr: PR, status: 'stuck', reason: 'unknown', attempts: 2 }]);
  });

  it('drives multiple PRs independently in one pass', () => {
    const A = 'https://github.com/o/r/pull/1';
    const B = 'https://github.com/o/r/pull/2';
    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmd = args.join(' ');
      if (cmd.includes('pr view 1')) {
        return ok(JSON.stringify({ state: 'MERGED', mergeStateStatus: null, autoMergeRequest: null }));
      }
      if (cmd.includes('pr view 2')) {
        return ok(JSON.stringify({ state: 'OPEN', mergeStateStatus: 'DIRTY', autoMergeRequest: { enabledAt: '2024' } }));
      }
      return ok('ok');
    }) as any);
    const results = driveBatchToMerge([A, B], { sleep: noopSleep, maxAttempts: 5 });
    expect(results).toEqual([
      { pr: A, status: 'merged', attempts: 1 },
      { pr: B, status: 'stuck', reason: 'conflicting', attempts: 1 },
    ]);
  });
});

describe('labelArtifacts', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it('labels PRs and issues', () => {
    mockSpawnSync.mockReturnValue(ok('ok') as any);
    const result = makeRunResult({
      prs: ['https://github.com/o/r/pull/1'],
      issuesFiled: ['https://github.com/o/r/issues/10'],
    });

    labelArtifacts(result, 'auto-dent');

    const calls = mockSpawnSync.mock.calls.map((c) => joinArgs(c as any));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('pr edit 1');
    expect(calls[0]).toContain('--add-label auto-dent');
    expect(calls[1]).toContain('issue edit 10');
    expect(calls[1]).toContain('--add-label auto-dent');
  });

  it('does nothing for empty result', () => {
    labelArtifacts(makeRunResult(), 'auto-dent');
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});

describe('queueAutoMerge', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it('queues auto-merge for each PR', () => {
    mockSpawnSync.mockReturnValue(ok('ok') as any);
    const result = makeRunResult({
      prs: ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'],
    });

    const queued = queueAutoMerge(result, 'o/r');

    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
    expect(queued).toEqual({
      queued: ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'],
      blocked: [],
      cancelFailed: [],
      queueFailed: [],
    });
    const cmds = mockSpawnSync.mock.calls.map((c) => joinArgs(c as any));
    expect(cmds[0]).toContain('pr merge 1');
    expect(cmds[0]).toContain('--squash --delete-branch --auto');
    expect(cmds[1]).toContain('pr merge 2');
  });

  it('does not queue unsafe auto-merge and disables any existing auto-merge request', () => {
    mockSpawnSync.mockReturnValue(ok('ok') as any);
    const result = makeRunResult({
      prs: ['https://github.com/o/r/pull/1'],
    });

    const queued = queueAutoMerge(result, 'o/r', {
      allow: false,
      reasons: ['review verdict fail', 'process verdict process-incomplete'],
    });

    expect(queued).toEqual({
      queued: [],
      blocked: ['https://github.com/o/r/pull/1'],
      cancelFailed: [],
      queueFailed: [],
    });
    const cmds = mockSpawnSync.mock.calls.map((c) => joinArgs(c as any));
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('pr merge 1');
    expect(cmds[0]).toContain('--disable-auto');
    expect(cmds[0]).not.toContain('--squash');
    expect(cmds[0]).not.toContain('--delete-branch');
  });

  it('surfaces unsafe auto-merge cancellation failures', () => {
    mockSpawnSync.mockReturnValue(fail('not queued') as any);
    const result = makeRunResult({
      prs: ['https://github.com/o/r/pull/1'],
    });

    const queued = queueAutoMerge(result, 'o/r', {
      allow: false,
      reasons: ['review verdict fail'],
    });

    expect(queued.cancelFailed).toEqual(['https://github.com/o/r/pull/1']);
  });

  it('rejects malformed PR URLs instead of passing attacker-controlled flags to gh', () => {
    mockSpawnSync.mockReturnValue(ok('ok') as any);
    const result = makeRunResult({
      prs: ['https://github.com/o/r/pull/1--delete-branch'],
    });

    const queued = queueAutoMerge(result, 'o/r');

    expect(queued).toEqual({ queued: [], blocked: [], cancelFailed: [], queueFailed: [] });
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});

describe('cancelAutoMerge', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it('disables auto-merge for each PR', () => {
    mockSpawnSync.mockReturnValue(ok('ok') as any);
    const result = makeRunResult({
      prs: ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'],
    });

    const failed = cancelAutoMerge(result);

    expect(failed).toEqual([]);
    const cmds = mockSpawnSync.mock.calls.map((c) => joinArgs(c as any));
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toContain('pr merge 1');
    expect(cmds[0]).toContain('--disable-auto');
    expect(cmds[1]).toContain('pr merge 2');
    expect(cmds[1]).toContain('--disable-auto');
  });

  it('returns PRs whose auto-merge could not be disabled', () => {
    mockSpawnSync.mockReturnValue(fail('missing permission') as any);
    const result = makeRunResult({
      prs: ['https://github.com/o/r/pull/1'],
    });

    expect(cancelAutoMerge(result)).toEqual(['https://github.com/o/r/pull/1']);
  });
});

describe('extractLinkedIssue', () => {
  it('extracts Closes #NNN', () => {
    expect(extractLinkedIssue('Some text\nCloses #42\nmore')).toBe('42');
  });

  it('extracts Fixes #NNN', () => {
    expect(extractLinkedIssue('Fixes #100')).toBe('100');
  });

  it('extracts Resolves #NNN', () => {
    expect(extractLinkedIssue('Resolves #200')).toBe('200');
  });

  it('returns null when no match', () => {
    expect(extractLinkedIssue('No issue reference here')).toBeNull();
  });

  it('is case insensitive', () => {
    expect(extractLinkedIssue('closes #55')).toBe('55');
  });
});

describe('isIssueClosed', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it('returns true for CLOSED state', () => {
    mockSpawnSync.mockReturnValue(ok(JSON.stringify({ state: 'CLOSED' })) as any);
    expect(isIssueClosed('42', 'owner/repo')).toBe(true);
  });

  it('returns false for OPEN state', () => {
    mockSpawnSync.mockReturnValue(ok(JSON.stringify({ state: 'OPEN' })) as any);
    expect(isIssueClosed('42', 'owner/repo')).toBe(false);
  });

  it('returns false on gh failure', () => {
    mockSpawnSync.mockReturnValue(fail() as any);
    expect(isIssueClosed('42', 'owner/repo')).toBe(false);
  });
});

describe('cleanupSupersededPRs', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it('returns empty for empty input', () => {
    expect(cleanupSupersededPRs([], 'o/r')).toEqual([]);
  });

  it('marks merged PRs as already_merged', () => {
    mockSpawnSync.mockReturnValue(
      ok(JSON.stringify({ state: 'MERGED', body: 'Closes #100' })) as any,
    );
    const results = cleanupSupersededPRs(['https://github.com/o/r/pull/1'], 'o/r');
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/1', action: 'already_merged' }]);
  });

  it('marks closed PRs as already_closed', () => {
    mockSpawnSync.mockReturnValue(
      ok(JSON.stringify({ state: 'CLOSED', body: 'Closes #100' })) as any,
    );
    const results = cleanupSupersededPRs(['https://github.com/o/r/pull/1'], 'o/r');
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/1', action: 'already_closed' }]);
  });

  it('marks PRs with no linked issue as no_issue', () => {
    mockSpawnSync.mockReturnValue(
      ok(JSON.stringify({ state: 'OPEN', body: 'Just a regular PR' })) as any,
    );
    const results = cleanupSupersededPRs(['https://github.com/o/r/pull/1'], 'o/r');
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/1', action: 'no_issue' }]);
  });

  it('closes superseded PRs whose issues are closed', () => {
    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('pr view')) {
        return ok(JSON.stringify({ state: 'OPEN', body: 'Closes #100' }));
      }
      if (cmdStr.includes('issue view')) {
        return ok(JSON.stringify({ state: 'CLOSED' }));
      }
      if (cmdStr.includes('pr close')) {
        return ok('ok');
      }
      return ok('');
    }) as any);

    const results = cleanupSupersededPRs(['https://github.com/o/r/pull/5'], 'o/r');
    expect(results).toEqual([
      { pr: 'https://github.com/o/r/pull/5', action: 'closed', issue: '#100' },
    ]);
  });

  it('marks PRs as still_open when issue is open', () => {
    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('pr view')) {
        return ok(JSON.stringify({ state: 'OPEN', body: 'Closes #100' }));
      }
      if (cmdStr.includes('issue view')) {
        return ok(JSON.stringify({ state: 'OPEN' }));
      }
      return ok('');
    }) as any);

    const results = cleanupSupersededPRs(['https://github.com/o/r/pull/1'], 'o/r');
    expect(results).toEqual([
      { pr: 'https://github.com/o/r/pull/1', action: 'still_open', issue: '#100' },
    ]);
  });

  it('skips invalid URLs', () => {
    expect(cleanupSupersededPRs(['not-a-url'], 'o/r')).toEqual([]);
  });
});

describe('parseEpicChecklist', () => {
  it('extracts unchecked and checked items', () => {
    const body = [
      '- [ ] #699 Wire reflection_insights',
      '- [x] #700 Dedup contemplation',
      '- [x] #701 Human-readable batch names',
      '- [ ] #702 Strategic runs',
      'Some other text #703 not in checklist',
    ].join('\n');

    const items = parseEpicChecklist(body);
    expect(items).toEqual([
      { issue: '699', checked: false },
      { issue: '700', checked: true },
      { issue: '701', checked: true },
      { issue: '702', checked: false },
    ]);
  });

  it('returns empty array for body with no checklist', () => {
    expect(parseEpicChecklist('No checklist here')).toEqual([]);
  });

  it('handles multiple references to same issue', () => {
    const body = '- [ ] #100 First\n- [ ] #100 Duplicate';
    const items = parseEpicChecklist(body);
    expect(items).toHaveLength(2);
  });
});

describe('extractAllLinkedIssues', () => {
  it('extracts Closes, Fixes, Resolves patterns', () => {
    const body = 'Closes #123\nFixes #456\nResolves #789';
    expect(extractAllLinkedIssues(body)).toEqual(['123', '456', '789']);
  });

  it('is case-insensitive', () => {
    const body = 'closes #100\nCLOSES #200\nfixed #300';
    expect(extractAllLinkedIssues(body)).toEqual(['100', '200', '300']);
  });

  it('deduplicates', () => {
    const body = 'Closes #100\nAlso closes #100';
    expect(extractAllLinkedIssues(body)).toEqual(['100']);
  });

  it('returns empty for no matches', () => {
    expect(extractAllLinkedIssues('No issue references here')).toEqual([]);
  });

  it('handles Close singular', () => {
    expect(extractAllLinkedIssues('Close #555')).toEqual(['555']);
  });
});

describe('syncEpicChecklists', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it('returns empty when no closed issues', () => {
    expect(syncEpicChecklists([], 'owner/repo')).toEqual([]);
  });

  it('checks off issues in epic body', () => {
    const epicBody = '- [ ] #699 Wire\n- [x] #700 Dedup\n- [ ] #701 Names';

    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('issue list') && cmdStr.includes('--label epic')) {
        return ok(JSON.stringify([{ number: 698, body: epicBody }]));
      }
      if (cmdStr.includes('issue edit')) {
        return ok('ok');
      }
      return ok('');
    }) as any);

    const results = syncEpicChecklists(['699', '701'], 'owner/repo');

    expect(results).toHaveLength(1);
    expect(results[0].epic).toBe('#698');
    expect(results[0].issuesChecked).toEqual(['#699', '#701']);
    expect(results[0].alreadyChecked).toEqual([]);

    // Verify edit was called with updated body containing checked items
    const editCall = mockSpawnSync.mock.calls.find(
      (c) => (c[1] as string[]).join(' ').includes('issue edit'),
    );
    expect(editCall).toBeDefined();
    // The body is passed as a plain string arg (after --body flag)
    const editArgs = editCall![1] as string[];
    const bodyIdx = editArgs.indexOf('--body');
    const updatedBody = editArgs[bodyIdx + 1];
    expect(updatedBody).toContain('- [x] #699');
    expect(updatedBody).toContain('- [x] #701');
  });

  it('reports already-checked items', () => {
    const epicBody = '- [x] #699 Already done\n- [ ] #701 Pending';

    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('issue list') && cmdStr.includes('--label epic')) {
        return ok(JSON.stringify([{ number: 698, body: epicBody }]));
      }
      if (cmdStr.includes('issue edit')) {
        return ok('ok');
      }
      return ok('');
    }) as any);

    const results = syncEpicChecklists(['699', '701'], 'owner/repo');
    expect(results).toHaveLength(1);
    expect(results[0].issuesChecked).toEqual(['#701']);
    expect(results[0].alreadyChecked).toEqual(['#699']);
  });

  it('skips epics with no matching unchecked items', () => {
    const epicBody = '- [x] #699 Already done\n- [ ] #800 Unrelated';

    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('issue list')) {
        return ok(JSON.stringify([{ number: 698, body: epicBody }]));
      }
      return ok('');
    }) as any);

    const results = syncEpicChecklists(['699'], 'owner/repo');
    expect(results).toHaveLength(0);

    // Should not have called edit
    const editCalls = mockSpawnSync.mock.calls.filter(
      (c) => (c[1] as string[]).join(' ').includes('issue edit'),
    );
    expect(editCalls).toHaveLength(0);
  });

  it('handles gh failure gracefully', () => {
    mockSpawnSync.mockReturnValue(fail() as any);
    const results = syncEpicChecklists(['699'], 'owner/repo');
    expect(results).toEqual([]);
  });
});

describe('verifyIssuesClosed', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it('returns empty for no PRs', () => {
    expect(verifyIssuesClosed([], 'owner/repo')).toEqual([]);
  });

  it('skips non-merged PRs', () => {
    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('pr view')) {
        return ok(JSON.stringify({ state: 'OPEN', body: 'Closes #100' }));
      }
      return ok('');
    }) as any);

    const results = verifyIssuesClosed(
      ['https://github.com/owner/repo/pull/1'],
      'owner/repo',
    );
    expect(results).toEqual([]);
  });

  it('verifies already-closed issues without force-closing', () => {
    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('pr view')) {
        return ok(JSON.stringify({ state: 'MERGED', body: 'Closes #100' }));
      }
      if (cmdStr.includes('issue view')) {
        return ok(JSON.stringify({ state: 'CLOSED' }));
      }
      return ok('');
    }) as any);

    const results = verifyIssuesClosed(
      ['https://github.com/owner/repo/pull/1'],
      'owner/repo',
    );
    expect(results).toHaveLength(1);
    expect(results[0].verified).toEqual(['#100']);
    expect(results[0].forceClosed).toEqual([]);
  });

  it('force-closes issues that GitHub did not auto-close', () => {
    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('pr view')) {
        return ok(JSON.stringify({ state: 'MERGED', body: 'Closes #100\nFixes #200' }));
      }
      if (cmdStr.includes('issue view 100')) {
        return ok(JSON.stringify({ state: 'CLOSED' }));
      }
      if (cmdStr.includes('issue view 200')) {
        return ok(JSON.stringify({ state: 'OPEN' }));
      }
      if (cmdStr.includes('issue close')) {
        return ok('ok');
      }
      return ok('');
    }) as any);

    const results = verifyIssuesClosed(
      ['https://github.com/owner/repo/pull/1'],
      'owner/repo',
    );
    expect(results).toHaveLength(1);
    expect(results[0].verified).toEqual(['#100']);
    expect(results[0].forceClosed).toEqual(['#200']);

    // Verify the close command was called for issue 200
    const closeCalls = mockSpawnSync.mock.calls.filter(
      (c) => (c[1] as string[]).join(' ').includes('issue close'),
    );
    expect(closeCalls).toHaveLength(1);
    expect((closeCalls[0][1] as string[]).join(' ')).toContain('200');
  });

  it('skips PRs with no close keywords in body', () => {
    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('pr view')) {
        return ok(JSON.stringify({ state: 'MERGED', body: 'Just a regular PR' }));
      }
      return ok('');
    }) as any);

    const results = verifyIssuesClosed(
      ['https://github.com/owner/repo/pull/1'],
      'owner/repo',
    );
    expect(results).toEqual([]);
  });

  it('handles invalid PR URLs gracefully', () => {
    const results = verifyIssuesClosed(
      ['not-a-url', 'https://example.com/foo'],
      'owner/repo',
    );
    expect(results).toEqual([]);
  });
});

describe('reconcileBatchClosedIssues (#1173)', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it('counts verified auto-closures, not just force-closures', () => {
    // The undercount bug: a merged PR whose Closes #N GitHub already auto-closed
    // must be counted. Previously only force-closed issues were recorded back.
    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('pr view')) {
        return ok(JSON.stringify({ state: 'MERGED', body: 'Closes #5\nFixes #6' }));
      }
      if (cmdStr.includes('issue view')) {
        return ok(JSON.stringify({ state: 'CLOSED' }));
      }
      return ok('');
    }) as any);

    const closed = reconcileBatchClosedIssues(
      ['https://github.com/owner/repo/pull/1'],
      'owner/repo',
    );
    expect(closed).toEqual(['#5', '#6']);
  });

  it('unions verified and force-closed sets', () => {
    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('pr view')) {
        return ok(JSON.stringify({ state: 'MERGED', body: 'Closes #5\nFixes #6' }));
      }
      if (cmdStr.includes('issue view 5')) {
        return ok(JSON.stringify({ state: 'CLOSED' }));
      }
      if (cmdStr.includes('issue view 6')) {
        return ok(JSON.stringify({ state: 'OPEN' }));
      }
      if (cmdStr.includes('issue close')) return ok('ok');
      return ok('');
    }) as any);

    const closed = reconcileBatchClosedIssues(
      ['https://github.com/owner/repo/pull/1'],
      'owner/repo',
    );
    expect(closed).toEqual(['#5', '#6']);
  });

  it('dedupes issues closed by more than one batch PR (no double count)', () => {
    // verifyIssuesClosed re-runs over ALL batch PRs each run; if two PRs both
    // reference #7 the reconciled set must contain it once, not twice.
    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('pr view')) {
        return ok(JSON.stringify({ state: 'MERGED', body: 'Closes #7' }));
      }
      if (cmdStr.includes('issue view')) {
        return ok(JSON.stringify({ state: 'CLOSED' }));
      }
      return ok('');
    }) as any);

    const closed = reconcileBatchClosedIssues(
      [
        'https://github.com/owner/repo/pull/1',
        'https://github.com/owner/repo/pull/2',
      ],
      'owner/repo',
    );
    expect(closed).toEqual(['#7']);
  });

  it('excludes issues from PRs that are not merged', () => {
    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('pr view')) {
        return ok(JSON.stringify({ state: 'OPEN', body: 'Closes #9' }));
      }
      return ok('');
    }) as any);

    const closed = reconcileBatchClosedIssues(
      ['https://github.com/owner/repo/pull/1'],
      'owner/repo',
    );
    expect(closed).toEqual([]);
  });

  it('returns refs sorted by issue number', () => {
    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('pr view')) {
        return ok(JSON.stringify({ state: 'MERGED', body: 'Closes #30\nFixes #4\nResolves #12' }));
      }
      if (cmdStr.includes('issue view')) {
        return ok(JSON.stringify({ state: 'CLOSED' }));
      }
      return ok('');
    }) as any);

    const closed = reconcileBatchClosedIssues(
      ['https://github.com/owner/repo/pull/1'],
      'owner/repo',
    );
    expect(closed).toEqual(['#4', '#12', '#30']);
  });
});
