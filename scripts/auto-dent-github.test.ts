import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import {
  parseEpicChecklist,
  extractAllLinkedIssues,
  syncEpicChecklists,
  verifyIssuesClosed,
} from './auto-dent-github.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

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
