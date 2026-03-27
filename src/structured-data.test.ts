import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  prTarget,
  issueTarget,
  storeReviewFinding,
  storeReviewBatch,
  storeQuickPass,
  storeReviewSummary,
  composeReviewSummary,
  parseFindingMeta,
  nextReviewRound,
  latestReviewRound,
  listReviewRounds,
  listReviewDimensions,
  readReviewFinding,
  storePlan,
  retrievePlan,
  storeGrounding,
  retrieveGrounding,
  retrieveDeepDive,
  storeMetadata,
  retrieveMetadata,
  queryConnectedIssues,
  storeIterationState,
  retrieveIterationState,
  updatePrSection,
  type ReviewFindingData,
} from './structured-data.js';

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

beforeEach(() => vi.clearAllMocks());

const pr = prTarget('903', 'Garsson-io/kaizen');
const issue = issueTarget('904', 'Garsson-io/kaizen');

const passFinding: ReviewFindingData = {
  dimension: 'correctness',
  verdict: 'pass',
  summary: 'All logic correct.',
  findings: [
    { requirement: 'Agent unblock', status: 'DONE', detail: 'Returns allowed:true' },
    { requirement: 'Verdict formula', status: 'DONE', detail: 'Accounts for skipped dims' },
  ],
};

const failFinding: ReviewFindingData = {
  dimension: 'test-quality',
  verdict: 'pass',
  summary: 'Mostly covered.',
  findings: [
    { requirement: 'Unit tests', status: 'DONE', detail: '38 tests' },
    { requirement: 'gh-exec tests', status: 'MISSING', detail: 'Zero tests', analysis: '`gh-exec.ts` needs 3 tests.' },
  ],
};

describe('storeReviewFinding — format and storage', () => {
  it('stores finding with machine-parseable meta and table', () => {
    ghReturns(''); // readAttachment: no existing
    ghReturns('https://...#issuecomment-1'); // createComment
    storeReviewFinding(pr, 5, passFinding);
    const args = mockGh.mock.calls[1][1] as string[];
    const bodyArg = args.find(a => a.startsWith('body='))!;
    expect(bodyArg).toContain('<!-- meta:');
    expect(bodyArg).toContain('"round":5');
    expect(bodyArg).toContain('"verdict":"pass"');
    expect(bodyArg).toContain('"done":2');
    expect(bodyArg).toContain('### correctness — PASS');
    expect(bodyArg).toContain('| 1 | ✅ DONE | Agent unblock |');
  });

  it('includes expanded analysis for non-DONE findings', () => {
    ghReturns('');
    ghReturns('https://...#issuecomment-2');
    storeReviewFinding(pr, 3, failFinding);
    const args = mockGh.mock.calls[1][1] as string[];
    const bodyArg = args.find(a => a.startsWith('body='))!;
    expect(bodyArg).toContain('#### 2. ❌ gh-exec tests');
    expect(bodyArg).toContain('`gh-exec.ts` needs 3 tests.');
  });

  it('includes duration and cost in stats line when provided', () => {
    ghReturns('');
    ghReturns('https://...');
    storeReviewFinding(pr, 2, { ...passFinding, durationSec: 120, costUsd: 0.15 });
    const args = mockGh.mock.calls[1][1] as string[];
    const bodyArg = args.find(a => a.startsWith('body='))!;
    expect(bodyArg).toContain('Round 2 | 120s | $0.150');
  });
});

describe('parseFindingMeta', () => {
  it('extracts JSON from HTML comment', () => {
    const content = '<!-- meta:{"round":5,"dimension":"security","verdict":"pass","done":3,"partial":0,"missing":0} -->\n### security';
    const meta = parseFindingMeta(content);
    expect(meta).not.toBeNull();
    expect(meta!.round).toBe(5);
    expect(meta!.dimension).toBe('security');
    expect(meta!.done).toBe(3);
  });

  it('returns null for content without meta', () => {
    expect(parseFindingMeta('just plain text')).toBeNull();
  });
});

describe('storeReviewBatch — multiple findings + auto-summary', () => {
  it('stores all findings and composes summary', () => {
    // For each finding: readAttachment (no existing) + createComment
    // passFinding
    ghReturns(''); ghReturns('https://...#issuecomment-10');
    // failFinding
    ghReturns(''); ghReturns('https://...#issuecomment-11');
    // storeReviewSummary → composeReviewSummary → listAttachments → readAttachment per dim
    // listAttachments fetches comments
    const stored1 = JSON.stringify({ url: 'https://...#issuecomment-10', body: `<!-- kaizen:review/r5/correctness -->\n<!-- meta:{"round":5,"dimension":"correctness","verdict":"pass","done":2,"partial":0,"missing":0} -->` });
    const stored2 = JSON.stringify({ url: 'https://...#issuecomment-11', body: `<!-- kaizen:review/r5/test-quality -->\n<!-- meta:{"round":5,"dimension":"test-quality","verdict":"pass","done":1,"partial":0,"missing":1} -->` });
    ghReturns(`${stored1}\n${stored2}`); // listAttachments for review/r5/
    // readReviewFinding for each dim
    ghReturns(stored1);
    ghReturns(stored2);
    // writeAttachment for summary: readAttachment (no existing) + createComment
    ghReturns(''); ghReturns('https://...#issuecomment-12');

    const result = storeReviewBatch(pr, 5, [passFinding, failFinding]);
    expect(result.urls).toHaveLength(2);
    expect(result.summaryUrl).toContain('issuecomment');
  });
});

describe('storeQuickPass — shorthand for all-DONE dimensions', () => {
  it('stores a pass finding with all DONE requirements', () => {
    ghReturns(''); ghReturns('https://...');
    storeQuickPass(pr, 5, 'security', 'No issues', ['No injection', 'Timeout set', 'Args array']);
    const args = mockGh.mock.calls[1][1] as string[];
    const bodyArg = args.find(a => a.startsWith('body='))!;
    expect(bodyArg).toContain('### security — PASS');
    expect(bodyArg).toContain('"done":3');
    expect(bodyArg).toContain('| 1 | ✅ DONE | No injection |');
    expect(bodyArg).toContain('| 3 | ✅ DONE | Args array |');
    // No expanded sections (all DONE) — no #### headers
    expect(bodyArg).not.toContain('####');
  });
});

describe('nextReviewRound + latestReviewRound', () => {
  it('returns 1 when no reviews exist', () => {
    ghReturns(''); // listAttachments: no comments
    expect(nextReviewRound(pr)).toBe(1);
  });

  it('returns latest + 1 when reviews exist', () => {
    ghReturns([
      JSON.stringify({ url: 'u', body: '<!-- kaizen:review/r3/correctness -->' }),
      JSON.stringify({ url: 'u', body: '<!-- kaizen:review/r3/summary -->' }),
    ].join('\n'));
    expect(nextReviewRound(pr)).toBe(4);
  });
});

describe('composeReviewSummary — auto-generates from stored findings', () => {
  it('builds summary table from dimension attachments', () => {
    const c1 = JSON.stringify({ url: 'u', body: `<!-- kaizen:review/r2/correctness -->\n<!-- meta:{"round":2,"dimension":"correctness","verdict":"pass","done":3,"partial":0,"missing":0} -->` });
    const c2 = JSON.stringify({ url: 'u', body: `<!-- kaizen:review/r2/security -->\n<!-- meta:{"round":2,"dimension":"security","verdict":"fail","done":1,"partial":0,"missing":2} -->` });
    // listAttachments
    ghReturns(`${c1}\n${c2}`);
    // readReviewFinding for each
    ghReturns(c1);
    ghReturns(c2);

    const summary = composeReviewSummary(pr, 2);
    expect(summary).toContain('## Review Round 2');
    expect(summary).toContain('| correctness | ✅ PASS | 3 | 0 | 0 |');
    expect(summary).toContain('| security | ❌ FAIL | 1 | 0 | 2 |');
    expect(summary).toContain('1 PASS, 1 FAIL');
    expect(summary).toContain('"verdict":"fail"'); // overall fails due to MISSING
  });
});

describe('storePlan + retrievePlan — round-trip', () => {
  it('stores and retrieves plan via attachment', () => {
    // store: writeAttachment → readAttachment (no existing) + createComment
    ghReturns(''); ghReturns('https://...');
    storePlan(issue, '## Plan\n\n1. Do X');

    // retrieve: readAttachment finds it
    ghReturns(JSON.stringify({ url: 'https://...', body: '<!-- kaizen:plan -->\n## Plan\n\n1. Do X' }));
    const plan = retrievePlan(issue);
    expect(plan).toContain('Do X');
  });

  it('falls back to issue body ## Plan section', () => {
    ghReturns(''); // readAttachment: no attachment
    ghReturns('## Problem\n\nBug.\n\n## Plan\n\n1. Fix it.\n\n## Test Plan'); // fetchBody
    const plan = retrievePlan(issue);
    expect(plan).toContain('Fix it');
    expect(plan).not.toContain('Test Plan');
  });
});

describe('storeGrounding + retrieveGrounding — round-trip', () => {
  it('stores and retrieves grounding via attachment', () => {
    ghReturns(''); ghReturns('https://...');
    storeGrounding(issue, '## Success Criteria\n\nGOAL: Fix the plan slot conflict.');

    ghReturns(JSON.stringify({ url: 'https://...', body: '<!-- kaizen:grounding -->\n## Success Criteria\n\nGOAL: Fix the plan slot conflict.' }));
    const grounding = retrieveGrounding(issue);
    expect(grounding).toContain('Fix the plan slot conflict');
  });

  it('writes to the grounding slot (kaizen:grounding), not the plan slot', () => {
    // Slot-isolation invariant: storeGrounding must NOT write <!-- kaizen:plan -->
    ghReturns(''); ghReturns('https://...');
    storeGrounding(issue, 'grounding content');
    // Second gh call is the createComment with the body containing the marker
    const args = mockGh.mock.calls[1][1] as string[];
    const bodyIdx = args.indexOf('--body');
    const bodyArg = bodyIdx >= 0 ? args[bodyIdx + 1] : '';
    expect(bodyArg).toContain('<!-- kaizen:grounding -->');
    expect(bodyArg).not.toContain('<!-- kaizen:plan -->');
  });

  it('returns null when no grounding exists', () => {
    ghReturns(''); // readAttachment: no attachment found
    const grounding = retrieveGrounding(issue);
    expect(grounding).toBeNull();
  });
});

describe('retrieveDeepDive — combined body + metadata + connected', () => {
  it('combines issue body, metadata attachment, and connected issues sections', () => {
    // fetchBody (called first)
    ghReturns('## Problem — The Pattern\n\nRepeated plan slot conflict.');
    // readAttachment for metadata (called by retrieveDeepDive)
    ghReturns(JSON.stringify({ url: 'u', body: '<!-- kaizen:metadata -->\n```yaml\narea: skills\n```' }));
    // retrieveMetadata call inside queryConnectedIssues
    ghReturns(JSON.stringify({ url: 'u', body: '<!-- kaizen:metadata -->\n```yaml\nconnected_issues: []\n```' }));

    const result = retrieveDeepDive(issue);
    expect(result).toContain('## Issue Body');
    expect(result).toContain('Repeated plan slot conflict');
    expect(result).toContain('## Metadata Attachment');
    expect(result).toContain('## Connected Issues');
  });

  it('falls back to placeholder text when fetchBody fails', () => {
    // INVARIANT: a gh failure on fetchBody must not throw — body section shows placeholder
    ghFails('not found'); // fetchBody fails
    ghReturns(JSON.stringify({ url: 'u', body: '<!-- kaizen:metadata -->\n```yaml\narea: skills\n```' }));
    ghReturns(JSON.stringify({ url: 'u', body: '<!-- kaizen:metadata -->\n```yaml\nconnected_issues: []\n```' }));

    const result = retrieveDeepDive(issue);
    expect(result).toContain('## Issue Body');
    expect(result).toContain('(no body)');
    expect(result).toContain('## Metadata Attachment');
  });

  it('shows placeholder when metadata attachment is absent', () => {
    // INVARIANT: missing metadata attachment must not throw — shows placeholder
    ghReturns('## Problem\n\nSome problem.');
    ghReturns(''); // no metadata attachment found
    ghReturns(JSON.stringify({ url: 'u', body: '<!-- kaizen:metadata -->\n```yaml\nconnected_issues: []\n```' }));

    const result = retrieveDeepDive(issue);
    expect(result).toContain('## Metadata Attachment');
    expect(result).toContain('(no metadata attachment)');
  });

  it('shows placeholder when connected issues list is empty', () => {
    // INVARIANT: zero connected issues must produce the placeholder, not an empty section
    ghReturns('## Problem\n\nSome problem.');
    ghReturns(JSON.stringify({ url: 'u', body: '<!-- kaizen:metadata -->\n```yaml\narea: skills\n```' }));
    ghReturns(JSON.stringify({ url: 'u', body: '<!-- kaizen:metadata -->\n```yaml\nconnected_issues: []\n```' }));

    const result = retrieveDeepDive(issue);
    expect(result).toContain('## Connected Issues');
    expect(result).toContain('(no connected issues)');
  });
});

describe('storeIterationState + retrieveIterationState', () => {
  it('round-trips JSON state', () => {
    ghReturns(''); ghReturns('https://...');
    storeIterationState(pr, { round: 3, phase: 'fix_running', cost: 1.5 });

    ghReturns(JSON.stringify({ url: 'u', body: '<!-- kaizen:iteration/state -->\n```json\n{"round":3,"phase":"fix_running","cost":1.5}\n```' }));
    const state = retrieveIterationState(pr);
    expect(state).toEqual({ round: 3, phase: 'fix_running', cost: 1.5 });
  });
});

describe('updatePrSection', () => {
  it('adds a section to PR body', () => {
    ghReturns('## Plan\n\nOld.'); // fetchBody
    ghReturns(''); // writeBody
    updatePrSection(pr, 'Validation', '- [x] Tests pass');
    const args = mockGh.mock.calls[1][1] as string[];
    const bodyArg = args[args.indexOf('--body') + 1];
    expect(bodyArg).toContain('## Plan');
    expect(bodyArg).toContain('## Validation');
    expect(bodyArg).toContain('Tests pass');
  });
});
