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
  retrieveTestPlan,
  storeMetadata,
  retrieveMetadata,
  queryConnectedIssues,
  storeIterationState,
  retrieveIterationState,
  updatePrSection,
  normalizeReviewFindingData,
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

  it('accepts legacy status-only payload without findings', () => {
    ghReturns('');
    ghReturns('https://...');
    storeReviewFinding(pr, 1, {
      // legacy shape from older callers
      dimension: 'self-review',
      status: 'pass',
      summary: 'Looks good',
    } as any);
    const args = mockGh.mock.calls[1][1] as string[];
    const bodyArg = args.find(a => a.startsWith('body='))!;
    expect(bodyArg).toContain('### self-review — PASS');
    expect(bodyArg).toContain('**0 findings**: 0 DONE, 0 PARTIAL, 0 MISSING');
  });

  it('defaults missing verdict/findings to safe fail shape', () => {
    ghReturns('');
    ghReturns('https://...');
    storeReviewFinding(pr, 1, {
      dimension: 'self-review',
      summary: 'brief note only',
    } as any);
    const args = mockGh.mock.calls[1][1] as string[];
    const bodyArg = args.find(a => a.startsWith('body='))!;
    expect(bodyArg).toContain('### self-review — FAIL');
    expect(bodyArg).toContain('> brief note only');
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

describe('normalizeReviewFindingData', () => {
  it('maps legacy status/result fields and defaults safely', () => {
    const normalized = normalizeReviewFindingData({
      dimension: 'self-review',
      status: 'pass',
      text: 'legacy message',
    } as any);
    expect(normalized.dimension).toBe('self-review');
    expect(normalized.verdict).toBe('pass');
    expect(normalized.summary).toBe('legacy message');
    expect(normalized.findings).toEqual([]);
  });

  it('normalizes finding item statuses and computes derived verdict', () => {
    const normalized = normalizeReviewFindingData({
      dimension: 'correctness',
      findings: [
        { requirement: 'A', status: 'done' },
        { requirement: 'B', verdict: 'fail' },
      ],
    } as any);
    expect(normalized.findings[0].status).toBe('DONE');
    expect(normalized.findings[1].status).toBe('MISSING');
    expect(normalized.verdict).toBe('fail');
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

describe('storePlan + retrieveTestPlan — round-trip via plan-section fallback (B15)', () => {
  it('a plan containing a ## Test Plan section is retrievable via retrieveTestPlan', () => {
    // Store: writeAttachment with the full plan (no dedicated testplan stored)
    const planDoc = '## Plan\n\nSteps:\n1. Do X\n2. Do Y\n\n## Test Plan\n\n| # | Behavior | Level |\n|---|----------|-------|\n| 1 | X does Y | Unit |';
    ghReturns(''); // readAttachment: no existing plan attachment
    ghReturns('https://github.com/.../comments/1'); // createComment succeeds
    storePlan(issue, planDoc);

    // Retrieve the test plan — should fall back to plan attachment's Test Plan section
    ghReturns(''); // readAttachment for 'testplan': none
    ghReturns(JSON.stringify({ url: 'u', body: `<!-- kaizen:plan -->\n${planDoc}` })); // readAttachment for 'plan': the stored plan
    const testPlan = retrieveTestPlan(issue);

    expect(testPlan).not.toBeNull();
    expect(testPlan).toContain('X does Y');
    expect(testPlan).toContain('Unit');
    // Must NOT contain unrelated sections of the plan
    expect(testPlan).not.toContain('1. Do X');
  });

  it('a plan containing ## Seam Map & Test Plan is retrievable (matches write-plan template)', () => {
    const planDoc = '## Plan\n\nSteps\n\n## Seam Map & Test Plan\n\n| # | Behavior | Level |\n|---|----------|-------|\n| 1 | A | Integration |';
    ghReturns(''); ghReturns('https://...');
    storePlan(issue, planDoc);

    ghReturns(''); // no testplan attachment
    ghReturns(JSON.stringify({ url: 'u', body: `<!-- kaizen:plan -->\n${planDoc}` }));
    const testPlan = retrieveTestPlan(issue);
    expect(testPlan).toContain('A');
    expect(testPlan).toContain('Integration');
  });

  it('dedicated testplan attachment takes precedence over plan attachment section', () => {
    const dedicated = '## Test Plan\n\nDedicated version with B-prime';
    ghReturns(JSON.stringify({ url: 'u', body: `<!-- kaizen:testplan -->\n${dedicated}` }));
    const testPlan = retrieveTestPlan(issue);
    expect(testPlan).toContain('B-prime');
  });
});

describe('retrieveTestPlan — lookup order', () => {
  it('prefers dedicated testplan attachment', () => {
    ghReturns(JSON.stringify({ url: 'u', body: '<!-- kaizen:testplan -->\n## Test Plan\n\nBehavior X: Unit' }));
    const tp = retrieveTestPlan(issue);
    expect(tp).toContain('Behavior X');
  });

  it('falls back to Test Plan section inside plan attachment', () => {
    ghReturns(''); // no dedicated testplan attachment
    ghReturns(JSON.stringify({
      url: 'u',
      body: '<!-- kaizen:plan -->\n## Plan\n\nSteps.\n\n## Test Plan\n\nBehavior Y: Integration',
    })); // plan attachment contains Test Plan section
    const tp = retrieveTestPlan(issue);
    expect(tp).toContain('Behavior Y');
  });

  it('falls back to Seam Map & Test Plan section inside plan attachment', () => {
    ghReturns(''); // no dedicated testplan
    ghReturns(JSON.stringify({
      url: 'u',
      body: '<!-- kaizen:plan -->\n## Plan\n\nSteps.\n\n## Seam Map & Test Plan\n\nBehavior Z: System',
    }));
    const tp = retrieveTestPlan(issue);
    expect(tp).toContain('Behavior Z');
  });

  it('falls back to Test Plan section in issue body', () => {
    ghReturns(''); // no testplan
    ghReturns(''); // no plan
    ghReturns('## Context\n\nBug.\n\n## Test Plan\n\nBehavior W: Workflow'); // issue body
    const tp = retrieveTestPlan(issue);
    expect(tp).toContain('Behavior W');
  });

  it('returns null when no test plan anywhere', () => {
    ghReturns(''); // no testplan
    ghReturns(''); // no plan
    ghReturns('## Just a body with no test plan');
    expect(retrieveTestPlan(issue)).toBeNull();
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
