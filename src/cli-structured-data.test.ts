import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, appendFileSync } from 'node:fs';
import { handlers, parseArgs, resolveContent, resolveRound, type CliArgs } from './cli-structured-data.js';
import {
  nextReviewRound,
  storePlan,
  storeGrounding,
  retrieveGrounding,
  storeMetadata,
} from './structured-data.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockReturnValue('file-content'),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue('stdin-content'),
}));

vi.mock('./structured-data.js', () => ({
  prTarget: vi.fn((pr: string, repo: string) => ({ kind: 'pr', number: Number(pr), repo })),
  issueTarget: vi.fn((issue: string, repo: string) => ({ kind: 'issue', number: Number(issue), repo })),
  storeReviewFinding: vi.fn().mockReturnValue('https://example.com/finding'),
  storeReviewSummary: vi.fn().mockReturnValue('https://example.com/summary'),
  storeReviewBatch: vi.fn().mockReturnValue({ urls: ['u1'], summaryUrl: 'https://example.com/batch-summary' }),
  storeQuickPass: vi.fn().mockReturnValue('https://example.com/quick-pass'),
  nextReviewRound: vi.fn().mockReturnValue(3),
  latestReviewRound: vi.fn().mockReturnValue(2),
  listReviewRounds: vi.fn().mockReturnValue([1, 2]),
  listReviewDimensions: vi.fn().mockReturnValue(['correctness', 'security']),
  readReviewFinding: vi.fn().mockReturnValue('finding text'),
  readReviewSummary: vi.fn().mockReturnValue('summary text'),
  storePlan: vi.fn().mockReturnValue('https://example.com/plan'),
  retrievePlan: vi.fn().mockReturnValue('plan text'),
  storeTestPlan: vi.fn().mockReturnValue('https://example.com/testplan'),
  retrieveTestPlan: vi.fn().mockReturnValue('testplan text'),
  storeGrounding: vi.fn().mockReturnValue('https://example.com/grounding'),
  retrieveGrounding: vi.fn().mockReturnValue('grounding text'),
  retrieveDeepDive: vi.fn().mockReturnValue('deep-dive text'),
  storeMetadata: vi.fn().mockReturnValue('https://example.com/metadata'),
  retrieveMetadata: vi.fn().mockReturnValue({ type: 'meta-issue' }),
  queryConnectedIssues: vi.fn().mockReturnValue([{ number: 1, role: 'primary', title: 'Issue 1' }]),
  queryPrNumber: vi.fn().mockReturnValue(903),
  updatePrSection: vi.fn(),
  storeIterationState: vi.fn().mockReturnValue('https://example.com/iteration'),
  retrieveIterationState: vi.fn().mockReturnValue({ round: 1 }),
}));

beforeEach(() => vi.clearAllMocks());

describe('parseArgs', () => {
  it('extracts command and flags', () => {
    const result = parseArgs(['store-plan', '--repo', 'R', '--issue', '42']);
    expect(result.command).toBe('store-plan');
    expect(result.repo).toBe('R');
    expect(result.issue).toBe('42');
  });

  it('returns empty command when no args', () => {
    const result = parseArgs([]);
    expect(result.command).toBe('');
  });
});

describe('handler registry', () => {
  it('has a handler for every known command', () => {
    const expectedCommands = [
      'next-round', 'store-review-finding', 'store-review-batch', 'quick-pass',
      'store-review-summary', 'list-review-rounds', 'list-review-dims',
      'read-review-finding', 'read-review-summary',
      'store-plan', 'retrieve-plan', 'store-testplan', 'retrieve-testplan',
      'store-grounding', 'retrieve-grounding', 'retrieve-deep-dive',
      'store-metadata', 'retrieve-metadata', 'query-connected', 'query-pr',
      'update-pr-section',
      'store-iteration', 'retrieve-iteration',
    ];
    for (const cmd of expectedCommands) {
      expect(handlers[cmd], `missing handler for '${cmd}'`).toBeDefined();
    }
  });

  it('every registered handler is a function', () => {
    for (const [name, handler] of Object.entries(handlers)) {
      expect(typeof handler, `handler '${name}' should be a function`).toBe('function');
    }
  });

  it('has exactly 23 handlers (no stale entries)', () => {
    expect(Object.keys(handlers).length).toBe(23);
  });
});

describe('resolveContent', () => {
  it('reads from --file flag', () => {
    const text = resolveContent({ file: '/tmp/test.md' } as CliArgs);
    expect(vi.mocked(readFileSync)).toHaveBeenCalledWith('/tmp/test.md', 'utf8');
    expect(text).toBe('file-content');
  });

  it('returns --text directly', () => {
    expect(resolveContent({ text: 'inline' } as CliArgs)).toBe('inline');
  });

  it('returns empty string when no source given', () => {
    expect(resolveContent({} as CliArgs)).toBe('');
  });
});

describe('resolveRound', () => {
  it('uses --round flag when provided', () => {
    expect(resolveRound({ round: '5', repo: 'R' } as CliArgs)).toBe(5);
  });

  it('auto-computes from PR when no round flag', () => {
    const r = resolveRound({ pr: '903', repo: 'R' } as CliArgs);
    expect(vi.mocked(nextReviewRound)).toHaveBeenCalled();
    expect(r).toBe(3);
  });

  it('defaults to 1 when no round and no PR', () => {
    expect(resolveRound({ repo: 'R' } as CliArgs)).toBe(1);
  });
});

describe('individual command handlers', () => {
  const baseArgs = { command: '', repo: 'Garsson-io/kaizen' } as CliArgs;

  it('next-round prints the next round number', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handlers['next-round']({ ...baseArgs, pr: '903' });
    expect(log).toHaveBeenCalledWith(3);
    log.mockRestore();
  });

  it('store-review-finding strips markdown code fences before parsing', async () => {
    // INVARIANT: agents often wrap JSON in ```json ... ``` — the handler must strip fences
    // so a fenced payload stores correctly instead of silently producing a 0/0/0 finding.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fenced = '```json\n{"dimension":"correctness","verdict":"pass","summary":"ok","findings":[]}\n```';
    await handlers['store-review-finding']({ ...baseArgs, pr: '903', round: '5', text: fenced });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Review finding stored'));
    log.mockRestore();
  });

  it('store-review-finding exits non-zero on unparseable JSON', async () => {
    // INVARIANT: a garbled --text must cause an explicit exit(1), not a silent 0/0/0 finding.
    // The old silent fallback obscured storage failures — callers had no way to detect them.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handlers['store-review-finding']({ ...baseArgs, pr: '903', round: '5', text: 'not-json' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('store-plan stores and prints URL', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handlers['store-plan']({ ...baseArgs, issue: '904', text: 'my plan' });
    expect(vi.mocked(storePlan)).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Plan stored'));
    log.mockRestore();
  });

  it('retrieve-plan prints plan text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handlers['retrieve-plan']({ ...baseArgs, issue: '904' });
    expect(log).toHaveBeenCalledWith('plan text');
    log.mockRestore();
  });

  it('store-grounding stores and prints URL', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handlers['store-grounding']({ ...baseArgs, issue: '904', text: 'my grounding' });
    expect(vi.mocked(storeGrounding)).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Grounding stored'));
    log.mockRestore();
  });

  it('retrieve-grounding calls retrieveGrounding with correct issue target', async () => {
    // INVARIANT: retrieve-grounding must wire CLI args to retrieveGrounding(issueTarget(issue, repo)).
    // Asserting the mock return value was passed to console.log is tautological — instead
    // verify the argument wiring so a wrong issue number or repo would cause this test to fail.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handlers['retrieve-grounding']({ ...baseArgs, issue: '904' });
    expect(vi.mocked(retrieveGrounding)).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'issue', number: 904, repo: 'Garsson-io/kaizen' }),
    );
    log.mockRestore();
  });

  it('retrieve-grounding exits non-zero when no grounding found', async () => {
    // INVARIANT: retrieve-grounding must signal failure (process.exit(1)) when
    // grounding is absent — callers (kaizen-implement Step 0) must not proceed
    // with an empty grounding silently.
    vi.mocked(retrieveGrounding).mockReturnValueOnce(null);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handlers['retrieve-grounding']({ ...baseArgs, issue: '904' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('retrieve-deep-dive prints combined deep-dive text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handlers['retrieve-deep-dive']({ ...baseArgs, issue: '904' });
    expect(log).toHaveBeenCalledWith('deep-dive text');
    log.mockRestore();
  });

  it('store-metadata parses YAML and stores', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handlers['store-metadata']({ ...baseArgs, issue: '904', text: 'type: bug' });
    expect(vi.mocked(storeMetadata)).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Metadata stored'));
    log.mockRestore();
  });
});

// ── store-review-batch sentinel (category prevention: #966) ─────────────────

describe('store-review-batch — review sentinel', () => {
  const baseArgs: CliArgs = { command: 'store-review-batch', pr: '903', repo: 'org/repo', round: '1' };

  it('writes review sentinel after storing batch findings', async () => {
    // INVARIANT: store-review-batch must write the review sentinel so the
    // pr-review-loop gate guard passes. Without the sentinel, the gate stays
    // blocked even after findings are stored, forcing KAIZEN_UNFINISHED bypass.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handlers['store-review-batch']({
      ...baseArgs,
      text: JSON.stringify([{
        dimension: 'correctness',
        verdict: 'pass',
        summary: 'No issues',
        findings: [],
      }]),
    });
    log.mockRestore();

    // appendFileSync must have been called with a path containing '.reviewed-r1'
    const calls = vi.mocked(appendFileSync).mock.calls;
    const sentinelCall = calls.find(
      ([path]) => typeof path === 'string' && path.includes('.reviewed-r1'),
    );
    expect(sentinelCall).toBeDefined();
    expect(String(sentinelCall![0])).toMatch(/\.reviewed-r1$/);
    expect(String(sentinelCall![1])).toMatch(/reviewed_at=/);
  });

  it('sentinel path encodes PR number and repo', async () => {
    // INVARIANT: the sentinel path must uniquely identify the PR so
    // different PRs don't share sentinels.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handlers['store-review-batch']({
      ...baseArgs,
      pr: '456',
      repo: 'my/repo',
      text: JSON.stringify([{ dimension: 'dry', verdict: 'pass', summary: '', findings: [] }]),
    });
    log.mockRestore();

    const calls = vi.mocked(appendFileSync).mock.calls;
    const sentinelCall = calls.find(
      ([path]) => typeof path === 'string' && path.includes('.reviewed-r'),
    );
    expect(sentinelCall).toBeDefined();
    expect(String(sentinelCall![0])).toContain('456');
  });
});
