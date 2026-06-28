import { describe, it, expect } from 'vitest';
import {
  classifyStalePr,
  extractClosesIssues,
  ageInDays,
  triageOpenPrs,
  applyTriage,
  parseCliArgs,
  type StalePrInput,
  type TriageRow,
} from './stale-pr-triage.js';

function row(number: number, action: TriageRow['triage']['action'], closesIssues: number[] = []): TriageRow {
  return {
    number,
    title: `pr ${number}`,
    url: `u${number}`,
    ageDays: 30,
    closesIssues,
    triage: { action, reason: 'test' },
  };
}

const base: StalePrInput = {
  ageDays: 30,
  staleDays: 21,
  linkedIssueStates: ['OPEN'],
  mergeable: 'MERGEABLE',
  isDraft: false,
};

describe('classifyStalePr — precedence', () => {
  it('skips a PR younger than the staleness threshold regardless of other fields', () => {
    const r = classifyStalePr({ ...base, ageDays: 3, linkedIssueStates: ['CLOSED'], mergeable: 'CONFLICTING' });
    expect(r.action).toBe('skip-fresh');
    expect(r.reason).toBeTruthy();
  });

  it('closes a stale PR whose only linked issue is already CLOSED', () => {
    const r = classifyStalePr({ ...base, linkedIssueStates: ['CLOSED'] });
    expect(r.action).toBe('close-superseded');
  });

  it('closes a stale PR only when EVERY linked issue is CLOSED', () => {
    const r = classifyStalePr({ ...base, linkedIssueStates: ['CLOSED', 'CLOSED', 'CLOSED'] });
    expect(r.action).toBe('close-superseded');
  });

  it('does NOT close-superseded when a PR still closes one open issue', () => {
    // The #1084 shape: Closes #1081, #1080, #1082 — only #1082 resolved.
    const r = classifyStalePr({ ...base, linkedIssueStates: ['OPEN', 'CLOSED', 'CLOSED'], mergeable: 'MERGEABLE' });
    expect(r.action).not.toBe('close-superseded');
  });

  it('lets the all-CLOSED signal win over CONFLICTING mergeability', () => {
    const r = classifyStalePr({ ...base, linkedIssueStates: ['CLOSED'], mergeable: 'CONFLICTING' });
    expect(r.action).toBe('close-superseded');
  });

  it('lets the all-CLOSED signal win over MERGEABLE mergeability', () => {
    const r = classifyStalePr({ ...base, linkedIssueStates: ['CLOSED'], mergeable: 'MERGEABLE' });
    expect(r.action).toBe('close-superseded');
  });

  it('proposes resume for a conflicting PR with an open issue', () => {
    const r = classifyStalePr({ ...base, mergeable: 'CONFLICTING', linkedIssueStates: ['OPEN'] });
    expect(r.action).toBe('resume');
  });

  it('proposes merge-ready for a clean non-draft PR with an open issue', () => {
    const r = classifyStalePr({ ...base, mergeable: 'MERGEABLE', isDraft: false });
    expect(r.action).toBe('merge-ready');
  });

  it('routes a clean DRAFT to review, never merge-ready', () => {
    const r = classifyStalePr({ ...base, mergeable: 'MERGEABLE', isDraft: true });
    expect(r.action).toBe('review');
  });

  it('routes UNKNOWN mergeability to review', () => {
    const r = classifyStalePr({ ...base, mergeable: 'UNKNOWN' });
    expect(r.action).toBe('review');
  });

  it('always carries a non-empty reason across every branch', () => {
    const inputs: StalePrInput[] = [
      { ...base, ageDays: 1 }, // skip-fresh
      { ...base, linkedIssueStates: ['CLOSED'] }, // close-superseded
      { ...base, mergeable: 'CONFLICTING' }, // resume
      { ...base, mergeable: 'MERGEABLE' }, // merge-ready
      { ...base, mergeable: 'UNKNOWN' }, // review
    ];
    for (const input of inputs) {
      expect(classifyStalePr(input).reason).toBeTruthy();
    }
  });
});

describe('classifyStalePr — fail-open on null/empty linkage', () => {
  it('never treats a null linked-issue state as CLOSED', () => {
    const r = classifyStalePr({ ...base, linkedIssueStates: [null], mergeable: 'CONFLICTING' });
    expect(r.action).not.toBe('close-superseded');
    expect(r.action).toBe('resume');
  });

  it('does not close-superseded when one of several lookups is null/unknown', () => {
    const r = classifyStalePr({ ...base, linkedIssueStates: ['CLOSED', null], mergeable: 'MERGEABLE' });
    expect(r.action).not.toBe('close-superseded');
  });

  it('does not close-superseded when there is no closing reference at all', () => {
    const r = classifyStalePr({ ...base, linkedIssueStates: [], mergeable: 'MERGEABLE' });
    expect(r.action).toBe('merge-ready');
  });

  it('falls through to merge-ready when linkage is empty but PR is clean', () => {
    const r = classifyStalePr({ ...base, linkedIssueStates: [], mergeable: 'MERGEABLE' });
    expect(r.action).toBe('merge-ready');
  });
});

describe('classifyStalePr — #1252/#1254 verdict-binding-draft protection', () => {
  it('does not batch-close a draft whose linked issue is still OPEN', () => {
    // Mirrors the double-barracuda verdict-binding rescue drafts (#1252/#1254):
    // their linked issues (#1220/#1227) are still open, so they must route to
    // review/resume — never close-superseded.
    const r = classifyStalePr({ ...base, linkedIssueStates: ['OPEN'], isDraft: true, mergeable: 'UNKNOWN' });
    expect(r.action).toBe('review');
    expect(r.action).not.toBe('close-superseded');
  });
});

describe('extractClosesIssues', () => {
  it('extracts the number from Closes/Fixes/Resolves keywords', () => {
    expect(extractClosesIssues('Closes #123')).toEqual([123]);
    expect(extractClosesIssues('Fixes #45')).toEqual([45]);
    expect(extractClosesIssues('Resolves #7')).toEqual([7]);
    expect(extractClosesIssues('closed #88')).toEqual([88]);
    expect(extractClosesIssues('Closes: #321')).toEqual([321]);
  });

  it('extracts every issue in a comma-separated closing list', () => {
    expect(extractClosesIssues('Closes #1081, #1080, #1082')).toEqual([1081, 1080, 1082]);
  });

  it('collects closing refs across multiple keyword lines, deduped', () => {
    expect(extractClosesIssues('Closes #10\nFixes #20\nCloses #10')).toEqual([10, 20]);
  });

  it('returns [] for informational references (Parent/Refs)', () => {
    expect(extractClosesIssues('Parent: #99')).toEqual([]);
    expect(extractClosesIssues('Refs: #99')).toEqual([]);
  });

  it('returns [] when there is no closing reference', () => {
    expect(extractClosesIssues('just a description with #5 mentioned')).toEqual([]);
    expect(extractClosesIssues('')).toEqual([]);
    expect(extractClosesIssues(null)).toEqual([]);
    expect(extractClosesIssues(undefined)).toEqual([]);
  });

  it('requires the # to be adjacent to the keyword', () => {
    expect(extractClosesIssues('closes the gap, see #5')).toEqual([]);
  });
});

describe('ageInDays', () => {
  const now = Date.parse('2026-06-28T00:00:00Z');
  it('computes whole days since the timestamp', () => {
    expect(ageInDays('2026-06-21T00:00:00Z', now)).toBe(7);
    expect(ageInDays('2026-06-28T00:00:00Z', now)).toBe(0);
  });
  it('clamps future timestamps to 0 and tolerates garbage', () => {
    expect(ageInDays('2026-07-01T00:00:00Z', now)).toBe(0);
    expect(ageInDays('not-a-date', now)).toBe(0);
  });
});

describe('triageOpenPrs — integration over a canned gh runner', () => {
  it('classifies each PR and only looks up issue state for stale PRs with a closing ref', () => {
    const issueLookups: number[] = [];
    const gh = (args: string[]): string => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          { number: 1, title: 'fresh', updatedAt: '2026-06-27T00:00:00Z', isDraft: false, mergeable: 'MERGEABLE', body: 'Closes #100', url: 'u1' },
          { number: 2, title: 'superseded', updatedAt: '2026-01-01T00:00:00Z', isDraft: false, mergeable: 'MERGEABLE', body: 'Closes #200', url: 'u2' },
          { number: 3, title: 'conflict', updatedAt: '2026-01-01T00:00:00Z', isDraft: false, mergeable: 'CONFLICTING', body: 'no closing ref', url: 'u3' },
        ]);
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        issueLookups.push(parseInt(args[2], 10));
        return JSON.stringify({ state: 'CLOSED' });
      }
      throw new Error('unexpected gh call: ' + args.join(' '));
    };

    const rows = triageOpenPrs({ gh, nowMs: Date.parse('2026-06-28T00:00:00Z'), repo: 'o/r', staleDays: 21, limit: 100 });

    expect(rows.find((r) => r.number === 1)?.triage.action).toBe('skip-fresh');
    expect(rows.find((r) => r.number === 2)?.triage.action).toBe('close-superseded');
    expect(rows.find((r) => r.number === 3)?.triage.action).toBe('resume');
    // Only the stale PR with a closing ref (#2 -> #200) triggers an issue lookup;
    // the fresh PR #1 is never looked up despite its closing ref.
    expect(issueLookups).toEqual([200]);
  });

  it('looks up every issue in a multi-issue closing list and keeps the PR open if any is still open', () => {
    const gh = (args: string[]): string => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          { number: 9, title: 'multi', updatedAt: '2026-01-01T00:00:00Z', isDraft: false, mergeable: 'MERGEABLE', body: 'Closes #80, #81, #82', url: 'u9' },
        ]);
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        // #80 is still OPEN, the others CLOSED.
        return JSON.stringify({ state: args[2] === '80' ? 'OPEN' : 'CLOSED' });
      }
      throw new Error('unexpected gh call: ' + args.join(' '));
    };
    const rows = triageOpenPrs({ gh, nowMs: Date.parse('2026-06-28T00:00:00Z'), repo: 'o/r', staleDays: 21, limit: 100 });
    expect(rows[0].closesIssues).toEqual([80, 81, 82]);
    expect(rows[0].triage.action).not.toBe('close-superseded');
    expect(rows[0].triage.action).toBe('merge-ready');
  });

  it('returns [] on malformed gh output', () => {
    const gh = () => 'not json';
    expect(triageOpenPrs({ gh, nowMs: 0, repo: 'o/r', staleDays: 21, limit: 100 })).toEqual([]);
  });

  it('never close-supersedes when the issue-state lookup throws (fail-open end-to-end)', () => {
    // The lookup-failure → null → never-close wiring, exercised through the
    // integration seam (not just the pure classifier).
    const gh = (args: string[]): string => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          { number: 5, title: 'stale', updatedAt: '2026-01-01T00:00:00Z', isDraft: false, mergeable: 'MERGEABLE', body: 'Closes #500', url: 'u5' },
        ]);
      }
      if (args[0] === 'issue' && args[1] === 'view') throw new Error('gh boom');
      throw new Error('unexpected gh call: ' + args.join(' '));
    };
    const rows = triageOpenPrs({ gh, nowMs: Date.parse('2026-06-28T00:00:00Z'), repo: 'o/r', staleDays: 21, limit: 100 });
    expect(rows[0].triage.action).not.toBe('close-superseded');
    expect(rows[0].triage.action).toBe('merge-ready');
  });

  it('coerces an unrecognized mergeable value to UNKNOWN -> review', () => {
    const gh = (args: string[]): string => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          { number: 6, title: 'weird', updatedAt: '2026-01-01T00:00:00Z', isDraft: false, mergeable: 'GARBAGE', body: 'no ref', url: 'u6' },
        ]);
      }
      throw new Error('unexpected gh call: ' + args.join(' '));
    };
    const rows = triageOpenPrs({ gh, nowMs: Date.parse('2026-06-28T00:00:00Z'), repo: 'o/r', staleDays: 21, limit: 100 });
    expect(rows[0].triage.action).toBe('review');
  });
});

describe('applyTriage — only close-superseded is auto-actioned', () => {
  it('closes close-superseded PRs and skips every other action', () => {
    const closed: string[] = [];
    const gh = (args: string[]): string => {
      if (args[0] === 'pr' && args[1] === 'close') {
        closed.push(args[2]);
        return '';
      }
      throw new Error('unexpected gh call: ' + args.join(' '));
    };
    const rows = [
      row(1, 'close-superseded', [10]),
      row(2, 'resume'),
      row(3, 'merge-ready'),
      row(4, 'review'),
      row(5, 'close-superseded', [20, 21]),
    ];
    const result = applyTriage(rows, { gh, repo: 'o/r' });
    expect(closed).toEqual(['1', '5']); // only the two close-superseded PRs
    expect(result.closed).toEqual([1, 5]);
    expect(result.failed).toEqual([]);
  });

  it('passes a discrete argv (no shell string) with the resolved issue list in the comment', () => {
    let captured: string[] = [];
    const gh = (args: string[]): string => {
      captured = args;
      return '';
    };
    applyTriage([row(7, 'close-superseded', [70, 71])], { gh, repo: 'o/r' });
    expect(captured.slice(0, 5)).toEqual(['pr', 'close', '7', '--repo', 'o/r']);
    expect(captured[5]).toBe('--comment');
    expect(captured[6]).toContain('#70, #71');
  });

  it('records a per-PR failure and continues with the rest', () => {
    const gh = (args: string[]): string => {
      if (args[2] === '1') throw new Error('close failed');
      return '';
    };
    const result = applyTriage(
      [row(1, 'close-superseded', [10]), row(2, 'close-superseded', [20])],
      { gh, repo: 'o/r' },
    );
    expect(result.failed).toEqual([1]);
    expect(result.closed).toEqual([2]);
  });

  it('does nothing when there are no close-superseded rows', () => {
    let calls = 0;
    const gh = (): string => {
      calls++;
      return '';
    };
    const result = applyTriage([row(1, 'review'), row(2, 'resume')], { gh, repo: 'o/r' });
    expect(calls).toBe(0);
    expect(result).toEqual({ closed: [], failed: [] });
  });
});

describe('parseCliArgs', () => {
  it('parses repo, stale-days, limit, and the apply flag', () => {
    const o = parseCliArgs(['--repo', 'o/r', '--stale-days', '30', '--limit', '5', '--apply']);
    expect(o).toEqual({ repo: 'o/r', staleDays: 30, limit: 5, apply: true });
  });

  it('defaults stale-days=21, limit=100, apply=false', () => {
    expect(parseCliArgs(['--repo', 'o/r'])).toEqual({ repo: 'o/r', staleDays: 21, limit: 100, apply: false });
  });

  it('throws when --repo is missing', () => {
    expect(() => parseCliArgs([])).toThrow(/--repo/);
  });

  it('clamps a negative/garbage stale-days and non-positive limit to defaults', () => {
    expect(parseCliArgs(['--repo', 'o/r', '--stale-days', '-3']).staleDays).toBe(21);
    expect(parseCliArgs(['--repo', 'o/r', '--stale-days', 'nope']).staleDays).toBe(21);
    expect(parseCliArgs(['--repo', 'o/r', '--limit', '0']).limit).toBe(100);
  });
});
