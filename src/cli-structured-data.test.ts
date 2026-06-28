import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openSync, readFileSync, writeFileSync } from 'node:fs';
import { handlers, parseArgs, resolveContent, resolveRound, type CliArgs } from './cli-structured-data.js';
import {
  nextReviewRound,
  storePlan,
  storeMetadata,
  storeReviewFinding,
  storeReviewSummary,
  mineRunTranscriptCandidates,
  storeFrictionCandidateReport,
  readReviewFinding,
} from './structured-data.js';

vi.mock('node:fs', () => ({
  constants: {
    O_CREAT: 0o100,
    O_NOFOLLOW: 0o400000,
    O_TRUNC: 0o1000,
    O_WRONLY: 0o1,
  },
  chmodSync: vi.fn(),
  closeSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  lstatSync: vi.fn(),
  readFileSync: vi.fn().mockReturnValue('file-content'),
  mkdirSync: vi.fn(),
  openSync: vi.fn().mockReturnValue(42),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue('stdin-content'),
}));

vi.mock('./structured-data.js', () => ({
  prTarget: vi.fn((pr: string, repo: string) => ({ kind: 'pr', number: Number(pr), repo })),
  issueTarget: vi.fn((issue: string, repo: string) => ({ kind: 'issue', number: Number(issue), repo })),
  storeReviewFinding: vi.fn().mockReturnValue('https://example.com/finding'),
  storeReviewSummary: vi.fn().mockReturnValue('https://example.com/summary'),
  mineRunTranscriptCandidates: vi.fn().mockReturnValue({
    generatedAt: '2026-06-29T00:00:00.000Z',
    sources: [{ repo: 'Garsson-io/kaizen', pr: '1515', attachment: 'run-transcript' }],
    candidates: [
      {
        category: 'cli_fumble',
        title: 'Repeated failed Bash command',
        summary: 'Bash command failed and was retried.',
        count: 2,
        severity: 'medium',
        source: { repo: 'Garsson-io/kaizen', pr: '1515', attachment: 'run-transcript' },
        moments: [{ entryIndex: 3, excerpt: 'unknown option --bad', role: 'tool' }],
      },
    ],
  }),
  storeFrictionCandidateReport: vi.fn().mockReturnValue('https://example.com/friction-candidates'),
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
      'attach-transcript', 'mine-transcripts', 'store-friction-candidates',
      'store-metadata', 'retrieve-metadata', 'query-connected', 'query-pr',
      'update-pr-section',
      'store-iteration', 'retrieve-iteration',
      'emit-test-review-sentinel',
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

  it('has exactly 24 handlers (no stale entries)', () => {
    expect(Object.keys(handlers).length).toBe(24);
  });

  it('registers the attach-transcript handler (#1508)', () => {
    expect(handlers['attach-transcript']).toBeTypeOf('function');
  });

  it('registers transcript mining handlers (#1516)', () => {
    expect(handlers['mine-transcripts']).toBeTypeOf('function');
    expect(handlers['store-friction-candidates']).toBeTypeOf('function');
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

  it('reads from fd 0 when --stdin is passed (epic #1059 review-gate fix)', () => {
    // When --stdin is present, resolveContent calls readFileSync(0, 'utf8').
    // The node:fs mock returns 'file-content' for any readFileSync call,
    // which is enough to verify the code path is taken without duplicating
    // the mock registry.
    expect(resolveContent({ stdin: 'true' } as CliArgs)).toBe('file-content');
    expect(vi.mocked(readFileSync)).toHaveBeenCalledWith(0, 'utf8');
  });
});

describe('parseArgs — boolean flag handling', () => {
  it('treats --stdin as a boolean at end of args', () => {
    const a = parseArgs(['store-review-finding', '--pr', '1', '--stdin']);
    expect(a.stdin).toBe('true');
    expect(a.pr).toBe('1');
  });

  it('treats --stdin as boolean when followed by another flag', () => {
    const a = parseArgs(['store-review-finding', '--stdin', '--pr', '1', '--round', '2']);
    expect(a.stdin).toBe('true');
    expect(a.pr).toBe('1');
    expect(a.round).toBe('2');
  });

  it('does not eat the next arg as --stdin value', () => {
    const a = parseArgs(['store-review-finding', '--stdin', '--dimension', 'correctness']);
    expect(a.stdin).toBe('true');
    expect(a.dimension).toBe('correctness'); // regression: would be missing if --stdin ate --dimension
  });

  it('still parses value-bearing flags normally', () => {
    const a = parseArgs(['store-review-finding', '--pr', '1060', '--round', '2']);
    expect(a.pr).toBe('1060');
    expect(a.round).toBe('2');
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

  it('store-metadata parses YAML and stores', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handlers['store-metadata']({ ...baseArgs, issue: '904', text: 'type: bug' });
    expect(vi.mocked(storeMetadata)).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Metadata stored'));
    log.mockRestore();
  });

  it('mine-transcripts emits structured friction candidates from run-transcript attachments', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handlers['mine-transcripts']({
      ...baseArgs,
      prs: '1515,1516',
    });

    expect(vi.mocked(mineRunTranscriptCandidates)).toHaveBeenCalledWith(
      [
        { kind: 'pr', number: 1515, repo: 'Garsson-io/kaizen' },
        { kind: 'pr', number: 1516, repo: 'Garsson-io/kaizen' },
      ],
      expect.any(String),
    );
    const payload = JSON.parse(String(log.mock.calls[0][0]));
    expect(payload.candidates[0]).toMatchObject({
      category: 'cli_fumble',
      source: { pr: '1515', attachment: 'run-transcript' },
    });
    log.mockRestore();
  });

  it('store-friction-candidates persists mined candidates as a named issue attachment', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handlers['store-friction-candidates']({
      ...baseArgs,
      prs: '1515',
      issue: '1516',
    });

    expect(vi.mocked(mineRunTranscriptCandidates)).toHaveBeenCalledWith(
      [{ kind: 'pr', number: 1515, repo: 'Garsson-io/kaizen' }],
      expect.any(String),
    );
    expect(vi.mocked(storeFrictionCandidateReport)).toHaveBeenCalledWith(
      { kind: 'issue', number: 1516, repo: 'Garsson-io/kaizen' },
      expect.objectContaining({
        candidates: [expect.objectContaining({ category: 'cli_fumble' })],
      }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Friction candidates stored'));
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

    // Sentinel writer opens the deterministic path, then writes through the fd
    // so pre-existing symlinks cannot be followed.
    const sentinelOpen = vi.mocked(openSync).mock.calls.find(
      ([path]) => typeof path === 'string' && path.includes('.reviewed-r1'),
    );
    expect(sentinelOpen).toBeDefined();
    expect(String(sentinelOpen![0])).toMatch(/\.reviewed-r1$/);
    const sentinelWrite = vi.mocked(writeFileSync).mock.calls.find(([fd]) => fd === 42);
    expect(sentinelWrite).toBeDefined();
    const payload = JSON.parse(String(sentinelWrite![1]));
    expect(payload).toMatchObject({
      schemaVersion: 1,
      prUrl: 'https://github.com/org/repo/pull/903',
      round: 1,
      dimensionsReviewed: ['correctness', 'security'],
      dimensionCount: 2,
    });
    expect(payload.integrity).toMatch(/^sha256:/);
  });

  it('derives sentinel totals through the shared review finding metadata contract (#1362)', async () => {
    vi.mocked(readReviewFinding).mockImplementation((_target, _round, dim) =>
      `leading text\n<!-- meta:{"round":1,"dimension":"${dim}","verdict":"pass","done":2,"partial":1,"missing":0} -->\n### ${dim}`,
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handlers['store-review-batch']({
      ...baseArgs,
      text: JSON.stringify([{ dimension: 'dry', verdict: 'pass', summary: 'ok', findings: [] }]),
    });
    log.mockRestore();

    const sentinelCall = vi.mocked(openSync).mock.calls.find(
      ([path]) => typeof path === 'string' && path.includes('.reviewed-r1'),
    );
    expect(sentinelCall).toBeDefined();
    const sentinelWrite = vi.mocked(writeFileSync).mock.calls.find(([fd]) => fd === 42);
    expect(sentinelWrite).toBeDefined();
    const payload = JSON.parse(String(sentinelWrite![1]));
    expect(payload).toMatchObject({
      findingCount: 6,
      totalDone: 4,
      totalPartial: 2,
      totalMissing: 0,
    });
  });

  it('does not keep a private review finding metadata parser in the CLI (#1362)', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const source = fs.readFileSync(new URL('./cli-structured-data.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/function\s+parseFindingMeta\s*\(/);
  });

  it('sentinel path encodes PR number and repo', async () => {
    // INVARIANT: the sentinel path must uniquely identify the PR so
    // different PRs don't share sentinels.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handlers['store-review-batch']({
      ...baseArgs,
      pr: '456',
      repo: 'my/repo',
      text: JSON.stringify([{ dimension: 'dry', verdict: 'pass', summary: 'ok', findings: [] }]),
    });
    log.mockRestore();

    const sentinelCall = vi.mocked(openSync).mock.calls.find(
      ([path]) => typeof path === 'string' && path.includes('.reviewed-r'),
    );
    expect(sentinelCall).toBeDefined();
    expect(String(sentinelCall![0])).toContain('456');
  });
});

describe('store-review-summary — pure storage, then sentinel', () => {
  // Post-#1225 revert: the CLI no longer threads a `--head-sha` / CI-proof option into storage.
  // storeReviewSummary is invoked with (target, round, note) only, then the sentinel is written.
  it('calls storeReviewSummary with no CI option and writes the sentinel', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handlers['store-review-summary']({
      command: 'store-review-summary',
      pr: '903',
      repo: 'Garsson-io/kaizen',
      round: '5',
    } as CliArgs);

    expect(vi.mocked(storeReviewSummary)).toHaveBeenCalledWith(
      { kind: 'pr', number: 903, repo: 'Garsson-io/kaizen' },
      5,
      undefined,
    );
    const sentinelCall = vi.mocked(openSync).mock.calls.find(
      ([path]) => typeof path === 'string' && path.includes('.reviewed-r5'),
    );
    expect(sentinelCall).toBeDefined();
    const sentinelWrite = vi.mocked(writeFileSync).mock.calls.find(([fd]) => fd === 42);
    expect(sentinelWrite).toBeDefined();
    const payload = JSON.parse(String(sentinelWrite![1]));
    expect(payload).toMatchObject({
      schemaVersion: 1,
      prUrl: 'https://github.com/Garsson-io/kaizen/pull/903',
      round: 5,
      dimensionsReviewed: ['correctness', 'security'],
      dimensionCount: 2,
    });
    expect(payload.findingCount).toBeGreaterThanOrEqual(0);
    expect(payload.integrity).toMatch(/^sha256:/);
    log.mockRestore();
  });
});

// ── store-review-finding strict validation (#1039) ─────────────────────────

describe('store-review-finding — strict payload validation (#1039)', () => {
  const baseArgs: CliArgs = {
    command: 'store-review-finding',
    pr: '1030',
    repo: 'Garsson-io/kaizen',
    round: '13',
    dimension: 'correctness',
  };

  // Use process.exit stubbing: handler calls process.exit(1) on error paths.
  function spyExit() {
    return vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
  }

  it('H1: rejects non-JSON payload with non-zero exit and descriptive error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = spyExit();
    await expect(handlers['store-review-finding']({ ...baseArgs, text: 'not json at all{' }))
      .rejects.toThrow('process.exit(1)');
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/not valid JSON/));
    expect(vi.mocked(storeReviewFinding)).not.toHaveBeenCalled();
    err.mockRestore();
    exit.mockRestore();
  });

  it('H2: rejects verdict=fail with empty findings (the #1039 core bug)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = spyExit();
    await expect(handlers['store-review-finding']({
      ...baseArgs,
      text: JSON.stringify({ dimension: 'correctness', verdict: 'fail', summary: 'broken', findings: [] }),
    })).rejects.toThrow('process.exit(1)');
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/#1039|empty findings/i));
    expect(vi.mocked(storeReviewFinding)).not.toHaveBeenCalled();
    err.mockRestore();
    exit.mockRestore();
  });

  it('H3: accepts a valid payload and stores it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handlers['store-review-finding']({
      ...baseArgs,
      text: JSON.stringify({
        dimension: 'correctness',
        verdict: 'pass',
        summary: 'all checks addressed',
        findings: [{ requirement: 'R1', status: 'DONE', detail: 'ok' }],
      }),
    });
    expect(vi.mocked(storeReviewFinding)).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Review finding stored'));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/1 DONE/));
    log.mockRestore();
  });

  it('H4: --payload-file reads content from disk', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({
      dimension: 'correctness',
      verdict: 'pass',
      summary: 'multi\nline\n"quoted"',
      findings: [{ requirement: 'R1', status: 'DONE', detail: 'ok' }],
    }));
    await handlers['store-review-finding']({ ...baseArgs, ['payload-file']: '/tmp/finding.json' } as CliArgs);
    expect(vi.mocked(readFileSync)).toHaveBeenCalledWith('/tmp/finding.json', 'utf8');
    expect(vi.mocked(storeReviewFinding)).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('rejects empty payload with actionable message', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = spyExit();
    await expect(handlers['store-review-finding']({ ...baseArgs, text: '   ' }))
      .rejects.toThrow('process.exit(1)');
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/no payload/i));
    err.mockRestore();
    exit.mockRestore();
  });

  it('H6: store-review-batch rejects empty-fail and does NOT write sentinel', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    await expect(handlers['store-review-batch']({
      command: 'store-review-batch',
      pr: '1030',
      repo: 'Garsson-io/kaizen',
      round: '13',
      text: JSON.stringify([{ dimension: 'correctness', verdict: 'fail', summary: 'bad', findings: [] }]),
    } as CliArgs)).rejects.toThrow('process.exit(1)');
    // Sentinel must NOT be written when batch is rejected
    const sentinelCall = vi.mocked(openSync).mock.calls.find(
      ([path]) => typeof path === 'string' && path.includes('.reviewed-r'),
    );
    expect(sentinelCall).toBeUndefined();
    err.mockRestore();
    exit.mockRestore();
  });

  it('rejects missing summary', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = spyExit();
    await expect(handlers['store-review-finding']({
      ...baseArgs,
      text: JSON.stringify({ dimension: 'correctness', verdict: 'pass', findings: [] }),
    })).rejects.toThrow('process.exit(1)');
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/summary/i));
    err.mockRestore();
    exit.mockRestore();
  });
});
