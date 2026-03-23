import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import {
  ghExec,
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
import type { RunResult } from './auto-dent-run.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    prs: [],
    issuesFiled: [],
    issuesClosed: [],
    cases: [],
    cost: 0,
    toolCalls: 0,
    stopRequested: false,
    linesDeleted: 0,
    issuesPruned: 0,
    ...overrides,
  };
}

describe('ghExec', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns trimmed output on success', () => {
    mockExecSync.mockReturnValue('  some output  \n');
    expect(ghExec('gh issue list')).toBe('some output');
  });

  it('returns empty string on failure and does not throw', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command failed');
    });
    expect(ghExec('gh issue list')).toBe('');
  });
});

describe('fetchIssueLabels', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns label names from gh output', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ labels: [{ name: 'bug' }, { name: 'kaizen' }] }),
    );
    expect(fetchIssueLabels('#42', 'owner/repo')).toEqual(['bug', 'kaizen']);
  });

  it('extracts issue number from various formats', () => {
    mockExecSync.mockReturnValue(JSON.stringify({ labels: [] }));

    fetchIssueLabels('42', 'owner/repo');
    expect(String(mockExecSync.mock.calls[0][0])).toContain('42');

    mockExecSync.mockClear();
    fetchIssueLabels('#99', 'owner/repo');
    expect(String(mockExecSync.mock.calls[0][0])).toContain('99');

    mockExecSync.mockClear();
    fetchIssueLabels('https://github.com/o/r/issues/123', 'owner/repo');
    expect(String(mockExecSync.mock.calls[0][0])).toContain('123');
  });

  it('returns empty array for non-numeric input', () => {
    expect(fetchIssueLabels('abc', 'owner/repo')).toEqual([]);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('returns empty array on gh failure', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(fetchIssueLabels('#42', 'owner/repo')).toEqual([]);
  });
});

describe('checkMergeStatus', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns merged for MERGED state', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ state: 'MERGED', mergeStateStatus: null, autoMergeRequest: null }),
    );
    expect(checkMergeStatus('https://github.com/o/r/pull/1')).toBe('merged');
  });

  it('returns closed for CLOSED state', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ state: 'CLOSED', mergeStateStatus: null, autoMergeRequest: null }),
    );
    expect(checkMergeStatus('https://github.com/o/r/pull/1')).toBe('closed');
  });

  it('returns auto_queued when autoMergeRequest is set', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ state: 'OPEN', mergeStateStatus: 'CLEAN', autoMergeRequest: { enabledAt: '2024-01-01' } }),
    );
    expect(checkMergeStatus('https://github.com/o/r/pull/1')).toBe('auto_queued');
  });

  it('returns open for OPEN state without auto-merge', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ state: 'OPEN', mergeStateStatus: 'CLEAN', autoMergeRequest: null }),
    );
    expect(checkMergeStatus('https://github.com/o/r/pull/1')).toBe('open');
  });

  it('returns unknown for invalid URL', () => {
    expect(checkMergeStatus('not-a-url')).toBe('unknown');
  });

  it('returns unknown on gh failure', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('failed');
    });
    expect(checkMergeStatus('https://github.com/o/r/pull/1')).toBe('unknown');
  });
});

describe('sweepBatchPRs', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns empty for empty input', () => {
    expect(sweepBatchPRs([])).toEqual([]);
  });

  it('marks merged PRs as merged', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ state: 'MERGED', mergeStateStatus: null, autoMergeRequest: null }),
    );
    const results = sweepBatchPRs(['https://github.com/o/r/pull/1']);
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/1', action: 'merged' }]);
  });

  it('marks closed PRs as closed', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ state: 'CLOSED', mergeStateStatus: null, autoMergeRequest: null }),
    );
    const results = sweepBatchPRs(['https://github.com/o/r/pull/1']);
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/1', action: 'closed' }]);
  });

  it('updates BEHIND branches with auto-merge queued', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('pr view')) {
        return JSON.stringify({ state: 'OPEN', mergeStateStatus: 'BEHIND', autoMergeRequest: { enabledAt: '2024' } });
      }
      if (cmdStr.includes('update-branch')) {
        return 'ok';
      }
      return '';
    });

    const results = sweepBatchPRs(['https://github.com/o/r/pull/5']);
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/5', action: 'updated' }]);
  });

  it('marks already current PRs', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ state: 'OPEN', mergeStateStatus: 'CLEAN', autoMergeRequest: { enabledAt: '2024' } }),
    );
    const results = sweepBatchPRs(['https://github.com/o/r/pull/1']);
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/1', action: 'already_current' }]);
  });

  it('skips invalid URLs', () => {
    expect(sweepBatchPRs(['not-a-url'])).toEqual([]);
  });

  it('handles gh failure as failed', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('gh failed');
    });
    const results = sweepBatchPRs(['https://github.com/o/r/pull/1']);
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/1', action: 'failed' }]);
  });
});

describe('labelArtifacts', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('labels PRs and issues', () => {
    mockExecSync.mockReturnValue('ok');
    const result = makeResult({
      prs: ['https://github.com/o/r/pull/1'],
      issuesFiled: ['https://github.com/o/r/issues/10'],
    });

    labelArtifacts(result, 'auto-dent');

    const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('pr edit 1');
    expect(calls[0]).toContain('--add-label auto-dent');
    expect(calls[1]).toContain('issue edit 10');
    expect(calls[1]).toContain('--add-label auto-dent');
  });

  it('does nothing for empty result', () => {
    labelArtifacts(makeResult(), 'auto-dent');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe('queueAutoMerge', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('queues auto-merge for each PR', () => {
    mockExecSync.mockReturnValue('ok');
    const result = makeResult({
      prs: ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'],
    });

    queueAutoMerge(result, 'o/r');

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    const cmds = mockExecSync.mock.calls.map((c) => String(c[0]));
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
    mockExecSync.mockReset();
  });

  it('returns true for CLOSED state', () => {
    mockExecSync.mockReturnValue(JSON.stringify({ state: 'CLOSED' }));
    expect(isIssueClosed('42', 'owner/repo')).toBe(true);
  });

  it('returns false for OPEN state', () => {
    mockExecSync.mockReturnValue(JSON.stringify({ state: 'OPEN' }));
    expect(isIssueClosed('42', 'owner/repo')).toBe(false);
  });

  it('returns false on gh failure', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('failed');
    });
    expect(isIssueClosed('42', 'owner/repo')).toBe(false);
  });
});

describe('cleanupSupersededPRs', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns empty for empty input', () => {
    expect(cleanupSupersededPRs([], 'o/r')).toEqual([]);
  });

  it('marks merged PRs as already_merged', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ state: 'MERGED', body: 'Closes #100' }),
    );
    const results = cleanupSupersededPRs(['https://github.com/o/r/pull/1'], 'o/r');
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/1', action: 'already_merged' }]);
  });

  it('marks closed PRs as already_closed', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ state: 'CLOSED', body: 'Closes #100' }),
    );
    const results = cleanupSupersededPRs(['https://github.com/o/r/pull/1'], 'o/r');
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/1', action: 'already_closed' }]);
  });

  it('marks PRs with no linked issue as no_issue', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ state: 'OPEN', body: 'Just a regular PR' }),
    );
    const results = cleanupSupersededPRs(['https://github.com/o/r/pull/1'], 'o/r');
    expect(results).toEqual([{ pr: 'https://github.com/o/r/pull/1', action: 'no_issue' }]);
  });

  it('closes superseded PRs whose issues are closed', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('pr view')) {
        return JSON.stringify({ state: 'OPEN', body: 'Closes #100' });
      }
      if (cmdStr.includes('issue view')) {
        return JSON.stringify({ state: 'CLOSED' });
      }
      if (cmdStr.includes('pr close')) {
        return 'ok';
      }
      return '';
    });

    const results = cleanupSupersededPRs(['https://github.com/o/r/pull/5'], 'o/r');
    expect(results).toEqual([
      { pr: 'https://github.com/o/r/pull/5', action: 'closed', issue: '#100' },
    ]);
  });

  it('marks PRs as still_open when issue is open', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('pr view')) {
        return JSON.stringify({ state: 'OPEN', body: 'Closes #100' });
      }
      if (cmdStr.includes('issue view')) {
        return JSON.stringify({ state: 'OPEN' });
      }
      return '';
    });

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
    mockExecSync.mockReset();
  });

  it('returns empty when no closed issues', () => {
    expect(syncEpicChecklists([], 'owner/repo')).toEqual([]);
  });

  it('checks off issues in epic body', () => {
    const epicBody = '- [ ] #699 Wire\n- [x] #700 Dedup\n- [ ] #701 Names';

    mockExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('issue list') && cmdStr.includes('--label epic')) {
        return JSON.stringify([{ number: 698, body: epicBody }]);
      }
      if (cmdStr.includes('issue edit')) {
        return 'ok';
      }
      return '';
    });

    const results = syncEpicChecklists(['699', '701'], 'owner/repo');

    expect(results).toHaveLength(1);
    expect(results[0].epic).toBe('#698');
    expect(results[0].issuesChecked).toEqual(['#699', '#701']);
    expect(results[0].alreadyChecked).toEqual([]);

    // Verify edit was called with updated body
    const editCall = mockExecSync.mock.calls.find(
      (c) => String(c[0]).includes('issue edit'),
    );
    expect(editCall).toBeDefined();
    const editCmd = String(editCall![0]);
    expect(editCmd).toContain('- [x] #699');
    expect(editCmd).toContain('- [x] #701');
  });

  it('reports already-checked items', () => {
    const epicBody = '- [x] #699 Already done\n- [ ] #701 Pending';

    mockExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('issue list') && cmdStr.includes('--label epic')) {
        return JSON.stringify([{ number: 698, body: epicBody }]);
      }
      if (cmdStr.includes('issue edit')) {
        return 'ok';
      }
      return '';
    });

    const results = syncEpicChecklists(['699', '701'], 'owner/repo');
    expect(results).toHaveLength(1);
    expect(results[0].issuesChecked).toEqual(['#701']);
    expect(results[0].alreadyChecked).toEqual(['#699']);
  });

  it('skips epics with no matching unchecked items', () => {
    const epicBody = '- [x] #699 Already done\n- [ ] #800 Unrelated';

    mockExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('issue list')) {
        return JSON.stringify([{ number: 698, body: epicBody }]);
      }
      return '';
    });

    const results = syncEpicChecklists(['699'], 'owner/repo');
    expect(results).toHaveLength(0);

    // Should not have called edit
    const editCalls = mockExecSync.mock.calls.filter(
      (c) => String(c[0]).includes('issue edit'),
    );
    expect(editCalls).toHaveLength(0);
  });

  it('handles gh failure gracefully', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('gh failed');
    });

    const results = syncEpicChecklists(['699'], 'owner/repo');
    expect(results).toEqual([]);
  });
});

describe('verifyIssuesClosed', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns empty for no PRs', () => {
    expect(verifyIssuesClosed([], 'owner/repo')).toEqual([]);
  });

  it('skips non-merged PRs', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('pr view')) {
        return JSON.stringify({ state: 'OPEN', body: 'Closes #100' });
      }
      return '';
    });

    const results = verifyIssuesClosed(
      ['https://github.com/owner/repo/pull/1'],
      'owner/repo',
    );
    expect(results).toEqual([]);
  });

  it('verifies already-closed issues without force-closing', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('pr view')) {
        return JSON.stringify({ state: 'MERGED', body: 'Closes #100' });
      }
      if (cmdStr.includes('issue view')) {
        return JSON.stringify({ state: 'CLOSED' });
      }
      return '';
    });

    const results = verifyIssuesClosed(
      ['https://github.com/owner/repo/pull/1'],
      'owner/repo',
    );
    expect(results).toHaveLength(1);
    expect(results[0].verified).toEqual(['#100']);
    expect(results[0].forceClosed).toEqual([]);
  });

  it('force-closes issues that GitHub did not auto-close', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('pr view')) {
        return JSON.stringify({ state: 'MERGED', body: 'Closes #100\nFixes #200' });
      }
      if (cmdStr.includes('issue view 100')) {
        return JSON.stringify({ state: 'CLOSED' });
      }
      if (cmdStr.includes('issue view 200')) {
        return JSON.stringify({ state: 'OPEN' });
      }
      if (cmdStr.includes('issue close')) {
        return 'ok';
      }
      return '';
    });

    const results = verifyIssuesClosed(
      ['https://github.com/owner/repo/pull/1'],
      'owner/repo',
    );
    expect(results).toHaveLength(1);
    expect(results[0].verified).toEqual(['#100']);
    expect(results[0].forceClosed).toEqual(['#200']);

    // Verify the close command was called
    const closeCalls = mockExecSync.mock.calls.filter(
      (c) => String(c[0]).includes('issue close'),
    );
    expect(closeCalls).toHaveLength(1);
    expect(String(closeCalls[0][0])).toContain('200');
  });

  it('skips PRs with no close keywords in body', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('pr view')) {
        return JSON.stringify({ state: 'MERGED', body: 'Just a regular PR' });
      }
      return '';
    });

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
