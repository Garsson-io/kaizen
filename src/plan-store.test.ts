import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  storePlan,
  storeTestPlan,
  storeMetadata,
  retrievePlan,
  retrieveTestPlan,
  retrieveMetadata,
  queryConnectedIssues,
  queryPrNumber,
  extractPlanText,
  PLAN_MARKER,
  METADATA_MARKER,
  TESTPLAN_MARKER,
} from './plan-store.js';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

const mockGh = vi.mocked(spawnSync);

function ghReturns(stdout: string) {
  mockGh.mockReturnValueOnce({ status: 0, stdout, stderr: '', signal: null, pid: 0, output: [null, stdout, ''] } as any);
}

function ghFails(stderr = 'error') {
  mockGh.mockReturnValueOnce({ status: 1, stdout: '', stderr, signal: null, pid: 0, output: [null, '', stderr] } as any);
}

const opts = { issueNum: '904', repo: 'Garsson-io/kaizen' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('storePlan', () => {
  it('creates a new comment when no existing plan comment', () => {
    // findMarkerComment: gh issue view returns no matching comments
    ghReturns('');
    // storePlan: gh issue comment creates new
    ghReturns('https://github.com/Garsson-io/kaizen/issues/904#issuecomment-123');

    const url = storePlan(opts, '## Plan\n\n1. Fix bug');
    expect(url).toContain('issuecomment');
    expect(mockGh).toHaveBeenCalledTimes(2);
    const createCall = mockGh.mock.calls[1];
    // spawnSync(command, args) — args is [1]
    expect(createCall[1]).toEqual(['issue', 'comment', '904', '--repo', 'Garsson-io/kaizen', '--body', expect.stringContaining(PLAN_MARKER)]);
  });

  it('updates existing comment by ID via gh api PATCH (not --edit-last)', () => {
    // findMarkerComment: returns a comment with the marker and ID
    ghReturns(JSON.stringify({ url: 'https://github.com/Garsson-io/kaizen/issues/904#issuecomment-456', body: `${PLAN_MARKER}\nold plan` }));
    // updateCommentById: gh api PATCH
    ghReturns('');

    const url = storePlan(opts, '## Plan\n\n1. New plan');
    expect(url).toContain('issuecomment-456');
    const updateCall = mockGh.mock.calls[1];
    // Should use gh api PATCH with comment ID, not --edit-last
    expect(updateCall[1]).toContain('api');
    expect(updateCall[1]).toContain('PATCH');
    expect(updateCall[1]).toContain('/repos/Garsson-io/kaizen/issues/comments/456');
  });
});

describe('retrievePlan', () => {
  it('retrieves plan from comment with PLAN_MARKER', () => {
    // findMarkerComment returns plan comment
    ghReturns(JSON.stringify({ url: 'https://...#issuecomment-789', body: `${PLAN_MARKER}\n## Plan\n\n1. Do X\n2. Do Y` }));

    const result = retrievePlan(opts);
    expect(result).not.toBeNull();
    expect(result!.planText).toContain('Do X');
    expect(result!.commentUrl).toContain('issuecomment-789');
  });

  it('falls back to issue body when no marker comment', () => {
    // findMarkerComment: no match
    ghReturns('');
    // issue body fetch
    ghReturns('## Problem\n\nBroken.\n\n## Plan\n\n1. Fix A\n2. Fix B\n\n## Test Plan\n\nTests.');

    const result = retrievePlan(opts);
    expect(result).not.toBeNull();
    expect(result!.planText).toContain('Fix A');
    expect(result!.planText).not.toContain('Test Plan');
    expect(result!.commentUrl).toBeUndefined();
  });

  it('returns null when no plan anywhere', () => {
    ghReturns('');
    ghReturns('## Problem\n\nJust a bug report.');

    expect(retrievePlan(opts)).toBeNull();
  });
});

describe('storeMetadata / retrieveMetadata', () => {
  it('stores and retrieves YAML metadata', () => {
    const data = {
      deep_dive: {
        domain: 'review-infrastructure',
        pr: 903,
        connected_issues: [
          { number: 895, role: 'primary', title: 'Agent blocked' },
        ],
      },
    };

    // Store: no existing marker
    ghReturns('');
    ghReturns('https://...#issuecomment-100');
    storeMetadata(opts, data);

    // Retrieve: marker comment found
    const yamlBody = `${METADATA_MARKER}\n\`\`\`yaml\ndeep_dive:\n  domain: review-infrastructure\n  pr: 903\n  connected_issues:\n    - number: 895\n      role: primary\n      title: Agent blocked\n\`\`\``;
    ghReturns(JSON.stringify({ url: 'https://...#issuecomment-100', body: yamlBody }));

    const result = retrieveMetadata(opts);
    expect(result).not.toBeNull();
    expect((result!.data.deep_dive as any).pr).toBe(903);
  });

  it('falls back to issue body for inline YAML', () => {
    ghReturns(''); // no marker comment
    ghReturns('## Issue\n\n```yaml\ndeep_dive:\n  pr: 42\n```'); // issue body

    const result = retrieveMetadata(opts);
    expect(result).not.toBeNull();
    expect((result!.data.deep_dive as any).pr).toBe(42);
  });
});

describe('queryConnectedIssues', () => {
  it('returns connected issues from metadata', () => {
    const yamlBody = `${METADATA_MARKER}\n\`\`\`yaml\ndeep_dive:\n  connected_issues:\n    - number: 895\n      role: primary\n      title: Agent blocked\n    - number: 856\n      role: duplicate\n      title: Same bug\n\`\`\``;
    ghReturns(JSON.stringify({ url: 'https://...', body: yamlBody }));

    const issues = queryConnectedIssues(opts);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual({ number: 895, role: 'primary', title: 'Agent blocked' });
    expect(issues[1]).toEqual({ number: 856, role: 'duplicate', title: 'Same bug' });
  });

  it('returns empty array when no metadata', () => {
    ghReturns('');
    ghReturns('No metadata here.');
    expect(queryConnectedIssues(opts)).toEqual([]);
  });
});

describe('queryPrNumber', () => {
  it('returns PR number from metadata', () => {
    const yamlBody = `${METADATA_MARKER}\n\`\`\`yaml\ndeep_dive:\n  pr: 903\n\`\`\``;
    ghReturns(JSON.stringify({ url: 'https://...', body: yamlBody }));

    expect(queryPrNumber(opts)).toBe(903);
  });

  it('returns null when no PR in metadata', () => {
    ghReturns('');
    ghReturns('```yaml\ndeep_dive:\n  domain: foo\n```');
    expect(queryPrNumber(opts)).toBeNull();
  });
});

describe('storeTestPlan / retrieveTestPlan', () => {
  it('stores and retrieves test plan', () => {
    // Store: no existing
    ghReturns('');
    ghReturns('https://...#issuecomment-200');
    storeTestPlan(opts, '## Test Plan\n\n- [x] Unit tests\n- [ ] E2E');

    // Retrieve: marker comment
    ghReturns(JSON.stringify({
      url: 'https://...#issuecomment-200',
      body: `${TESTPLAN_MARKER}\n## Test Plan\n\n- [x] Unit tests\n- [ ] E2E`,
    }));

    const result = retrieveTestPlan(opts);
    expect(result).not.toBeNull();
    expect(result!.planText).toContain('Unit tests');
  });

  it('falls back to issue body ## Test Plan section', () => {
    ghReturns(''); // no marker comment
    ghReturns('## Plan\n\nDo stuff.\n\n## Test Plan\n\n- Run tests\n- Check coverage');

    const result = retrieveTestPlan(opts);
    expect(result).not.toBeNull();
    expect(result!.planText).toContain('Run tests');
  });
});

describe('error handling — gh CLI failures propagate', () => {
  it('storePlan throws when gh fails on comment creation', () => {
    ghReturns(''); // findMarkerComment: no existing
    ghFails('permission denied');
    expect(() => storePlan(opts, '## Plan')).toThrow('permission denied');
  });

  it('retrievePlan throws when gh fails on issue fetch', () => {
    ghReturns(''); // findMarkerComment: no match
    ghFails('not found');
    expect(() => retrievePlan(opts)).toThrow('not found');
  });

  it('storeMetadata throws when gh fails', () => {
    ghReturns(''); // findMarkerComment
    ghFails('rate limited');
    expect(() => storeMetadata(opts, { key: 'val' })).toThrow('rate limited');
  });

  it('queryConnectedIssues throws when gh fails on issue fetch', () => {
    ghFails('timeout'); // findMarkerComment catches internally
    ghFails('also timeout'); // issue body fetch throws
    expect(() => queryConnectedIssues(opts)).toThrow('also timeout');
  });
});

describe('extractPlanText — canonical regex (shared with auto-dent-run)', () => {
  it('extracts ## Plan section', () => {
    expect(extractPlanText('## Problem\n\nBug.\n\n## Plan\n\n1. Fix.\n\n## Test Plan\n\nTests.'))
      .toContain('Fix');
  });

  it('returns undefined when no plan', () => {
    expect(extractPlanText('## Problem\n\nJust a bug.')).toBeUndefined();
  });
});
