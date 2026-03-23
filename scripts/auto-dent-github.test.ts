import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import {
  ghExec,
  parseShellArgs,
  fetchIssueLabels,
  checkMergeStatus,
  sweepBatchPRs,
  labelArtifacts,
  queueAutoMerge,
  extractLinkedIssue,
  isIssueClosed,
  cleanupSupersededPRs,
  parseEpicChecklist,
  extractAllLinkedIssues,
  syncEpicChecklists,
  verifyIssuesClosed,
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

describe('sweepBatchPRs', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it('returns empty for empty input', () => {
    expect(sweepBatchPRs([])).toEqual([]);
  });

  it('marks merged PRs as merged', () => {
    mockSpawnSync.mockReturnValue(
      ok(JSON.stringify({ state: 'MERGED', mergeStateStatus: null, autoMergeRequest: null })) as any,
    );
    const results = sweepBatchPRs(['https://github.com/o/r/pull/1']);
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/1', action: 'merged' }]);
  });

  it('marks closed PRs as closed', () => {
    mockSpawnSync.mockReturnValue(
      ok(JSON.stringify({ state: 'CLOSED', mergeStateStatus: null, autoMergeRequest: null })) as any,
    );
    const results = sweepBatchPRs(['https://github.com/o/r/pull/1']);
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/1', action: 'closed' }]);
  });

  it('updates BEHIND branches with auto-merge queued', () => {
    mockSpawnSync.mockImplementation(((_bin: string, args: string[]) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('pr view')) {
        return ok(JSON.stringify({ state: 'OPEN', mergeStateStatus: 'BEHIND', autoMergeRequest: { enabledAt: '2024' } }));
      }
      if (cmdStr.includes('update-branch')) {
        return ok('ok');
      }
      return ok('');
    }) as any);

    const results = sweepBatchPRs(['https://github.com/o/r/pull/5']);
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/5', action: 'updated' }]);
  });

  it('marks already current PRs', () => {
    mockSpawnSync.mockReturnValue(
      ok(JSON.stringify({ state: 'OPEN', mergeStateStatus: 'CLEAN', autoMergeRequest: { enabledAt: '2024' } })) as any,
    );
    const results = sweepBatchPRs(['https://github.com/o/r/pull/1']);
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/1', action: 'already_current' }]);
  });

  it('skips invalid URLs', () => {
    expect(sweepBatchPRs(['not-a-url'])).toEqual([]);
  });

  it('handles gh failure as failed', () => {
    mockSpawnSync.mockReturnValue(fail() as any);
    const results = sweepBatchPRs(['https://github.com/o/r/pull/1']);
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/1', action: 'failed' }]);
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

    queueAutoMerge(result, 'o/r');

    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
    const cmds = mockSpawnSync.mock.calls.map((c) => joinArgs(c as any));
    expect(cmds[0]).toContain('pr merge 1');
    expect(cmds[0]).toContain('--squash --delete-branch --auto');
    expect(cmds[1]).toContain('pr merge 2');
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
