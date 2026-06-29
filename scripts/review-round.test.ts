import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  assertArtifactTargetMatchesArgs,
  assertArtifactStoreable,
  buildHelp,
  expandDimensionGroups,
  formatDimensionProgress,
  formatRecoveryCommands,
  parseCliArgs,
  parseTimeoutMs,
  readArtifact,
  reviewResultToArtifact,
  runAndStoreReviewRound,
  runReviewRound,
  storeDebugArtifact,
  storeReviewArtifact,
  writeArtifact,
  type ReviewRoundArtifact,
} from './review-round.js';
import { shellQuote } from '../src/lib/shell-quote.js';

const provider = { provider: 'codex' as const, billing: 'subscription-cli' as const };

afterEach(() => {
  vi.unstubAllEnvs();
});

function baseArtifact(overrides: Partial<ReviewRoundArtifact> = {}): ReviewRoundArtifact {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-30T10:00:00.000Z',
    repo: 'Garsson-io/kaizen',
    pr: '1735',
    prUrl: 'https://github.com/Garsson-io/kaizen/pull/1735',
    issue: '1732',
    headSha: 'a'.repeat(40),
    provider,
    requestedDimensions: ['security', 'test-quality'],
    result: {
      verdict: 'pass',
      dimensions: [
        {
          dimension: 'security',
          verdict: 'pass',
          summary: 'Security looks good.',
          provider,
          findings: [{ requirement: 'No shell injection', status: 'DONE', detail: 'Uses arg arrays.' }],
        },
      ],
      missingCount: 0,
      partialCount: 0,
      failedDimensions: [],
      failedDimensionFailures: [],
      skippedDimensions: [],
      durationMs: 1200,
      costUsd: 0,
    },
    context: {
      issueTitle: '[L2] Review battery lacks ergonomic CLI',
      prTitle: 'fix: add CLI',
      planChars: 100,
      diffChars: 200,
    },
    ...overrides,
  };
}

function makeReviewRoundGhMock(diff = 'diff'): ReturnType<typeof vi.fn> {
  return vi.fn((args: string[]) => {
    if (args[0] === 'issue') return JSON.stringify({ title: 'Issue title', body: 'Issue body' });
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ title: 'PR title', body: 'PR body', headRefOid: 'c'.repeat(40), url: 'https://github.com/Garsson-io/kaizen/pull/1735' });
    if (args[0] === 'pr' && args[1] === 'diff') return diff;
    throw new Error(`unexpected gh call ${args.join(' ')}`);
  });
}

describe('parseCliArgs', () => {
  it('parses focused run options through the shared subscription provider shape', () => {
    const parsed = parseCliArgs([
      'run',
      '--pr', '1735',
      '--issue', '1732',
      '--repo', 'Garsson-io/kaizen',
      '--provider', 'codex',
      '--dimensions', 'plan-completeness,security,test-quality',
      '--timeout', '360s',
      '--out', 'logs/review/pr-1735-r2.json',
    ]);

    expect(parsed.command).toBe('run');
    expect(parsed.pr).toBe('1735');
    expect(parsed.issue).toBe('1732');
    expect(parsed.reviewProvider).toEqual(provider);
    expect(parsed.dimensions).toEqual(['plan-completeness', 'security', 'test-quality']);
    expect(parsed.timeoutMs).toBe(360_000);
    expect(parsed.out).toBe('logs/review/pr-1735-r2.json');
  });

  it('rejects unknown providers instead of hand-rolling provider objects', () => {
    expect(() => parseCliArgs(['run', '--provider', 'local'])).toThrow('unknown provider');
  });

  it('rejects non-numeric PR values after URL normalization', () => {
    expect(() => parseCliArgs(['run', '--pr', 'x/../../../.github/workflows/pwn'])).toThrow('--pr must be a PR number');
    expect(parseCliArgs(['run', '--pr', 'https://github.com/Garsson-io/kaizen/pull/1739']).pr).toBe('1739');
    expect(() => parseCliArgs(['run', '--pr', 'https://example.com/Garsson-io/kaizen/pull/1739'])).toThrow('--pr must be a PR number');
    expect(() => parseCliArgs(['run', '--pr', '0'])).toThrow('--pr must be a positive PR number');
  });

  it('uses the repo from a PR URL when --repo is omitted and rejects explicit mismatches', () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'Different/repo');

    expect(parseCliArgs(['run', '--pr', 'https://github.com/Garsson-io/kaizen/pull/1739']).repo).toBe('Garsson-io/kaizen');
    expect(() => parseCliArgs([
      'run',
      '--pr', 'https://github.com/Garsson-io/kaizen/pull/1739',
      '--repo', 'Other/repo',
    ])).toThrow('--pr URL repo Garsson-io/kaizen does not match --repo Other/repo');
  });

  it('rejects malformed integer flags instead of truncating them', () => {
    expect(() => parseCliArgs(['store', '--file', 'artifact.json', '--round', '7abc'])).toThrow('--round must be a positive integer');
    expect(() => parseCliArgs(['store', '--file', 'artifact.json', '--round', '1.5'])).toThrow('--round must be a positive integer');
    expect(() => parseCliArgs(['store', '--file', 'artifact.json', '--round', ''])).toThrow('--round must be a positive integer');
  });

  it('rejects malformed issue numbers before run prefetch', () => {
    expect(() => parseCliArgs(['run', '--issue', 'abc'])).toThrow('--issue must be a positive issue number');
    expect(() => parseCliArgs(['run', '--issue', '0'])).toThrow('--issue must be a positive issue number');
  });

  it('rejects zero timeouts', () => {
    expect(() => parseTimeoutMs('0')).toThrow('--timeout must be a safe positive integer');
    expect(() => parseTimeoutMs('0s')).toThrow('--timeout must be a safe positive integer');
  });

  it('rejects unsafe and timer-overflowing timeouts', () => {
    expect(() => parseTimeoutMs('999999999999999999999999m')).toThrow('--timeout must be a safe positive integer');
    expect(() => parseTimeoutMs('2147483648ms')).toThrow('--timeout must be <= 2147483647ms');
  });

  it('rejects debug dry-run storage because debug storage writes a GitHub attachment', () => {
    expect(() => parseCliArgs(['store', '--file', 'artifact.json', '--debug', '--dry-run'])).toThrow('--debug cannot be combined with --dry-run');
  });

  it('rejects debug mode for run-and-store because it only writes authoritative storage', () => {
    expect(() => parseCliArgs(['run-and-store', '--debug', '--store-only-if-pass'])).toThrow('--debug is only supported by the store command');
  });

  it('accepts explicit full PR review mode', () => {
    const parsed = parseCliArgs(['run', '--pr', '1735', '--issue', '1732', '--repo', 'Garsson-io/kaizen', '--all-pr']);

    expect(parsed.allPrDimensions).toBe(true);
    expect(parsed.dimensions).toEqual([]);
  });

  it('rejects explicit empty selectors instead of widening to all PR dimensions', () => {
    expect(() => parseCliArgs(['run', '--dimensions', ''])).toThrow('--dimensions must select at least one dimension');
    expect(() => parseCliArgs(['run', '--group', ''])).toThrow('--group must select at least one dimension group');
  });
});

describe('expandDimensionGroups', () => {
  it('expands common dimension groups without hard-coding dimensions at the callsite', () => {
    expect(expandDimensionGroups(['diff'], () => ['correctness', 'dry', 'requirements', 'security'])).toEqual([
      'correctness',
      'dry',
      'security',
    ]);
  });

  it('keeps issue groups focused on issue/diff dimensions and excludes PR-body review', () => {
    expect(expandDimensionGroups(['issue'], () => ['requirements', 'scope-fidelity', 'pr-description'])).toEqual([
      'requirements',
      'scope-fidelity',
    ]);
  });
});

describe('reviewResultToArtifact', () => {
  it('records provider failures in the durable artifact instead of throwing them away', () => {
    const artifact = reviewResultToArtifact({
      repo: 'Garsson-io/kaizen',
      pr: '1735',
      prUrl: 'https://github.com/Garsson-io/kaizen/pull/1735',
      issue: '1732',
      headSha: 'b'.repeat(40),
      requestedDimensions: ['security', 'test-quality'],
      issueTitle: 'Issue title',
      prTitle: 'PR title',
      issueBody: 'issue body',
      prBody: 'pr body',
      prDiff: 'diff',
      planText: 'plan',
      nowIso: '2026-06-30T10:00:00.000Z',
      result: {
        verdict: 'fail',
        reviewProvider: provider,
        dimensions: [],
        missingCount: 0,
        partialCount: 0,
        durationMs: 180_000,
        costUsd: 0,
        failedDimensions: ['test-quality'],
        failedDimensionFailures: [{ dimension: 'test-quality', provider, failureClass: 'codex_review_failed' }],
        skippedDimensions: [],
        error: 'provider timed out',
      },
    });

    expect(artifact.provider).toEqual(provider);
    expect(artifact.result.failedDimensions).toEqual(['test-quality']);
    expect(artifact.result.failedDimensionFailures).toEqual([
      { dimension: 'test-quality', provider, failureClass: 'codex_review_failed' },
    ]);
    expect(artifact.context).toMatchObject({
      issueTitle: 'Issue title',
      prTitle: 'PR title',
      issueChars: 10,
      prBodyChars: 7,
      diffChars: 4,
      planChars: 4,
    });
    expect(artifact.result.error).toBe('provider timed out');
  });
});

describe('runReviewRound', () => {
  it('writes a durable artifact even when the review result fails', async () => {
    const writeArtifact = vi.fn();
    const reviewBattery = vi.fn().mockResolvedValue({
      verdict: 'fail',
      reviewProvider: provider,
      dimensions: [],
      missingCount: 0,
      partialCount: 0,
      durationMs: 180_000,
      costUsd: 0,
      failedDimensions: ['security'],
      failedDimensionFailures: [{ dimension: 'security', provider, failureClass: 'codex_review_failed' }],
      skippedDimensions: [],
    });
    const gh = makeReviewRoundGhMock('diff --git a/file b/file');

    const artifact = await runReviewRound(
      parseCliArgs([
        'run',
        '--pr', '1735',
        '--issue', '1732',
        '--repo', 'Garsson-io/kaizen',
        '--all-pr',
        '--provider', 'codex',
        '--out', 'logs/review/result.json',
      ]),
      {
        reviewBattery,
        listPrDimensions: vi.fn().mockReturnValue(['security']),
        gh: gh as any,
        retrievePlan: vi.fn().mockReturnValue('stored plan'),
        retrieveTestPlan: vi.fn().mockReturnValue('stored test plan'),
        writeArtifact,
        now: () => '2026-06-30T10:00:00.000Z',
      },
    );

    expect(reviewBattery).toHaveBeenCalledWith(expect.objectContaining({
      dimensions: ['security'],
      reviewProvider: provider,
      issueBody: 'Issue title\n\nIssue body',
      prBody: 'PR title\n\nPR body',
      prDiffStat: 'diff --git a/file b/file',
      planText: 'stored plan',
      extraVars: { test_plan: 'stored test plan' },
    }));
    expect(artifact.result.failedDimensions).toEqual(['security']);
    expect(writeArtifact).toHaveBeenCalledWith('logs/review/result.json', artifact);
  });

  it('uses a default artifact path when --out is omitted', async () => {
    const writeArtifact = vi.fn();
    const reviewBattery = vi.fn().mockResolvedValue({
      verdict: 'pass',
      reviewProvider: provider,
      dimensions: [],
      missingCount: 0,
      partialCount: 0,
      durationMs: 10,
      costUsd: 0,
      failedDimensions: [],
      failedDimensionFailures: [],
      skippedDimensions: [],
    });
    const gh = makeReviewRoundGhMock();

    const artifact = await runReviewRound(
      parseCliArgs(['run', '--pr', '1735', '--issue', '1732', '--repo', 'Garsson-io/kaizen', '--dimensions', 'security']),
      {
        reviewBattery,
        listPrDimensions: vi.fn(),
        gh: gh as any,
        retrievePlan: vi.fn().mockReturnValue('stored plan'),
        retrieveTestPlan: vi.fn().mockReturnValue('stored test plan'),
        writeArtifact,
        now: () => '2026-06-30T10:00:00.000Z',
      },
    );

    expect(writeArtifact).toHaveBeenCalledWith('logs/review/pr-1735-20260630T100000Z.json', artifact);
  });

  it('writes a failure artifact when reviewBattery throws', async () => {
    const writeArtifact = vi.fn();
    const gh = makeReviewRoundGhMock();

    await expect(runReviewRound(
      parseCliArgs(['run', '--pr', '1735', '--issue', '1732', '--repo', 'Garsson-io/kaizen', '--dimensions', 'security', '--provider', 'codex']),
      {
        reviewBattery: vi.fn().mockRejectedValue(new Error('provider timeout')),
        listPrDimensions: vi.fn(),
        gh: gh as any,
        retrievePlan: vi.fn().mockReturnValue('stored plan'),
        retrieveTestPlan: vi.fn().mockReturnValue('stored test plan'),
        writeArtifact,
        now: () => '2026-06-30T10:00:00.000Z',
      },
    )).rejects.toThrow('provider timeout');

    const [, artifact] = writeArtifact.mock.calls[0];
    expect(writeArtifact.mock.calls[0][0]).toBe('logs/review/pr-1735-20260630T100000Z.json');
    expect(artifact.result.verdict).toBe('fail');
    expect(artifact.result.failedDimensions).toEqual(['security']);
    expect(artifact.result.error).toBe('provider timeout');
  });

  it('writes a failure artifact when prefetch JSON parsing fails', async () => {
    const writeArtifact = vi.fn();
    const gh = vi.fn((args: string[]) => {
      if (args[0] === 'issue') return 'not json';
      throw new Error(`unexpected gh call ${args.join(' ')}`);
    });

    await expect(runReviewRound(
      parseCliArgs(['run', '--pr', '1735', '--issue', '1732', '--repo', 'Garsson-io/kaizen', '--dimensions', 'security', '--provider', 'codex']),
      {
        reviewBattery: vi.fn(),
        listPrDimensions: vi.fn(),
        gh: gh as any,
        retrievePlan: vi.fn(),
        retrieveTestPlan: vi.fn(),
        writeArtifact,
        now: () => '2026-06-30T10:00:00.000Z',
      },
    )).rejects.toThrow('invalid JSON');

    const [, artifact] = writeArtifact.mock.calls[0];
    expect(artifact.result.failedDimensions).toEqual(['security']);
    expect(artifact.result.error).toContain('invalid JSON');
  });

  it('writes a failure artifact when prefetch JSON is not an object', async () => {
    const writeArtifact = vi.fn();
    const gh = vi.fn((args: string[]) => {
      if (args[0] === 'issue') return 'null';
      throw new Error(`unexpected gh call ${args.join(' ')}`);
    });

    await expect(runReviewRound(
      parseCliArgs(['run', '--pr', '1735', '--issue', '1732', '--repo', 'Garsson-io/kaizen', '--dimensions', 'security', '--provider', 'codex']),
      {
        reviewBattery: vi.fn(),
        listPrDimensions: vi.fn(),
        gh: gh as any,
        retrievePlan: vi.fn(),
        retrieveTestPlan: vi.fn(),
        writeArtifact,
        now: () => '2026-06-30T10:00:00.000Z',
      },
    )).rejects.toThrow('expected a JSON object');

    const [, artifact] = writeArtifact.mock.calls[0];
    expect(artifact.result.failedDimensions).toEqual(['security']);
    expect(artifact.result.error).toContain('expected a JSON object');
  });

  it('does not silently widen an explicit empty group selection to all PR dimensions', async () => {
    const gh = makeReviewRoundGhMock();
    const reviewBattery = vi.fn();

    await expect(runReviewRound(
      parseCliArgs(['run', '--pr', '1735', '--issue', '1732', '--repo', 'Garsson-io/kaizen', '--group', 'skills']),
      {
        reviewBattery,
        listPrDimensions: vi.fn().mockReturnValue(['correctness', 'security']),
        gh: gh as any,
        retrievePlan: vi.fn(),
        retrieveTestPlan: vi.fn(),
        writeArtifact: vi.fn(),
        now: () => '2026-06-30T10:00:00.000Z',
      },
    )).rejects.toThrow('No review dimensions selected');

    expect(gh).not.toHaveBeenCalled();
    expect(reviewBattery).not.toHaveBeenCalled();
  });
});

describe('assertArtifactStoreable', () => {
  it('fails closed when the artifact has MISSING findings', () => {
    const artifact = baseArtifact({
      result: {
        ...baseArtifact().result,
        verdict: 'fail',
        missingCount: 1,
        dimensions: [
          {
            dimension: 'requirements',
            verdict: 'fail',
            summary: 'Missing requirement.',
            findings: [{ requirement: 'CLI stores round', status: 'MISSING', detail: 'No store path.' }],
          },
        ],
      },
    });

    expect(() => assertArtifactStoreable(artifact)).toThrow(/MISSING findings/);
  });

  it('fails closed when any dimension failed provider-side', () => {
    const artifact = baseArtifact({
      result: {
        ...baseArtifact().result,
        verdict: 'fail',
        failedDimensions: ['security'],
        failedDimensionFailures: [{ dimension: 'security', provider, failureClass: 'codex_review_failed' }],
      },
    });

    expect(() => assertArtifactStoreable(artifact)).toThrow(/provider failures/);
  });

  it('fails closed when provider failure records exist even if failedDimensions is empty', () => {
    const artifact = baseArtifact({
      requestedDimensions: ['security'],
      result: {
        ...baseArtifact().result,
        failedDimensions: [],
        failedDimensionFailures: [{ dimension: 'security', provider, failureClass: 'codex_review_failed' }],
      },
    });

    expect(() => assertArtifactStoreable(artifact)).toThrow(/provider failure records/);
  });

  it('fails closed when the artifact carries a provider or run error', () => {
    const artifact = baseArtifact({
      requestedDimensions: ['security'],
      result: {
        ...baseArtifact().result,
        error: 'provider timeout',
      },
    });

    expect(() => assertArtifactStoreable(artifact)).toThrow(/artifact contains provider\/run error/);
  });

  it('fails closed when requested dimensions are missing from the artifact results', () => {
    const artifact = baseArtifact({
      requestedDimensions: ['security', 'test-quality'],
      result: {
        ...baseArtifact().result,
        dimensions: [baseArtifact().result.dimensions[0]],
      },
    });

    expect(() => assertArtifactStoreable(artifact)).toThrow(/missing requested dimensions/);
  });

  it('fails closed for zero-dimension authoritative artifacts', () => {
    expect(() => assertArtifactStoreable(baseArtifact({
      requestedDimensions: [],
      result: {
        ...baseArtifact().result,
        dimensions: [],
      },
    }))).toThrow(/no requested dimensions/);

    expect(() => assertArtifactStoreable(baseArtifact({
      requestedDimensions: ['security'],
      result: {
        ...baseArtifact().result,
        dimensions: [],
      },
    }))).toThrow(/no stored dimensions/);
  });
});

describe('artifact files', () => {
  it('round-trips the durable run artifact into the store path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-round-'));
    try {
      const path = join(dir, 'artifact.json');
      const artifact = baseArtifact({ requestedDimensions: ['security'] });
      writeArtifact(path, artifact);

      const deps = {
        nextReviewRound: vi.fn().mockReturnValue(4),
        storeReviewBatch: vi.fn().mockReturnValue({ urls: ['u1'], summaryUrl: 'summary-url' }),
        rerunReviewVerdictGate: vi.fn(),
        writeReviewSentinel: vi.fn(),
        writeAttachment: vi.fn(),
      };
      await storeReviewArtifact(readArtifact(path), { round: 4 }, deps);

      expect(deps.storeReviewBatch).toHaveBeenCalledWith(
        { kind: 'pr', number: '1735', repo: 'Garsson-io/kaizen' },
        4,
        [{
          dimension: 'security',
          verdict: 'pass',
          summary: 'Security looks good.',
          findings: [{ requirement: 'No shell injection', status: 'DONE', detail: 'Uses arg arrays.' }],
        }],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unreadable or invalid artifact JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-round-'));
    try {
      expect(() => readArtifact(join(dir, 'missing.json'))).toThrow('Invalid or unreadable review-round artifact');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('storeReviewArtifact', () => {
  it('stores a passable artifact into the existing structured review contract', async () => {
    const deps = {
      nextReviewRound: vi.fn().mockReturnValue(4),
      storeReviewBatch: vi.fn().mockReturnValue({ urls: ['u1'], summaryUrl: 'summary-url' }),
      rerunReviewVerdictGate: vi.fn().mockReturnValue({ action: 'rerun', runId: 123, message: 'rerun requested' }),
      writeReviewSentinel: vi.fn(),
      writeAttachment: vi.fn(),
    };

    const artifact = baseArtifact({ requestedDimensions: ['security'] });
    const result = await storeReviewArtifact(artifact, { rerunGate: true }, deps);

    expect(deps.nextReviewRound).toHaveBeenCalledWith({ kind: 'pr', number: '1735', repo: 'Garsson-io/kaizen' });
    expect(deps.storeReviewBatch).toHaveBeenCalledWith(
      { kind: 'pr', number: '1735', repo: 'Garsson-io/kaizen' },
      4,
      [
        {
          dimension: 'security',
          verdict: 'pass',
          summary: 'Security looks good.',
          findings: [{ requirement: 'No shell injection', status: 'DONE', detail: 'Uses arg arrays.' }],
        },
      ],
    );
    expect(deps.writeReviewSentinel).toHaveBeenCalledWith('Garsson-io/kaizen', '1735', 4, { strict: true });
    expect(deps.rerunReviewVerdictGate).toHaveBeenCalledWith('Garsson-io/kaizen', '1735');
    expect(result).toEqual({ round: 4, urls: ['u1'], summaryUrl: 'summary-url', gate: 'rerun requested' });
  });

  it('dry-run validates but never writes attachments or reruns the gate', async () => {
    const deps = {
      nextReviewRound: vi.fn().mockReturnValue(4),
      storeReviewBatch: vi.fn(),
      rerunReviewVerdictGate: vi.fn(),
      writeReviewSentinel: vi.fn(),
      writeAttachment: vi.fn(),
    };

    const result = await storeReviewArtifact(baseArtifact({ requestedDimensions: ['security'] }), { dryRun: true, rerunGate: true, round: 7 }, deps);

    expect(deps.storeReviewBatch).not.toHaveBeenCalled();
    expect(deps.rerunReviewVerdictGate).not.toHaveBeenCalled();
    expect(deps.writeReviewSentinel).not.toHaveBeenCalled();
    expect(result).toEqual({ round: 7, urls: [], summaryUrl: undefined, gate: undefined });
  });

  it('refuses invalid injected rounds before storage side effects', async () => {
    const deps = {
      nextReviewRound: vi.fn(),
      storeReviewBatch: vi.fn(),
      rerunReviewVerdictGate: vi.fn(),
      writeReviewSentinel: vi.fn(),
      writeAttachment: vi.fn(),
    };

    await expect(storeReviewArtifact(baseArtifact({ requestedDimensions: ['security'] }), { round: 0 }, deps)).rejects.toThrow(/invalid round 0/);

    expect(deps.storeReviewBatch).not.toHaveBeenCalled();
    expect(deps.writeReviewSentinel).not.toHaveBeenCalled();
  });

  it('allows PARTIAL-only artifacts so structured-data can derive PASS_WITH_PARTIALS', async () => {
    const deps = {
      nextReviewRound: vi.fn().mockReturnValue(4),
      storeReviewBatch: vi.fn().mockReturnValue({ urls: ['u1'], summaryUrl: 'summary-url' }),
      rerunReviewVerdictGate: vi.fn(),
      writeReviewSentinel: vi.fn(),
      writeAttachment: vi.fn(),
    };
    const artifact = baseArtifact({
      requestedDimensions: ['requirements'],
      result: {
        ...baseArtifact().result,
        verdict: 'fail',
        partialCount: 1,
        dimensions: [{
          dimension: 'requirements',
          verdict: 'fail',
          summary: 'partial',
          findings: [{ requirement: 'live running status', status: 'PARTIAL', detail: 'Final status is implemented; live running status is not.' }],
        }],
      },
    });

    const result = await storeReviewArtifact(artifact, { round: 4 }, deps);

    expect(result.summaryUrl).toBe('summary-url');
    expect(deps.storeReviewBatch).toHaveBeenCalledWith(
      { kind: 'pr', number: '1735', repo: 'Garsson-io/kaizen' },
      4,
      [{
        dimension: 'requirements',
        verdict: 'fail',
        summary: 'partial',
        findings: [{ requirement: 'live running status', status: 'PARTIAL', detail: 'Final status is implemented; live running status is not.' }],
      }],
    );
  });

  it('refuses unstoreable artifacts before any storage side effects', async () => {
    const deps = {
      nextReviewRound: vi.fn().mockReturnValue(4),
      storeReviewBatch: vi.fn(),
      rerunReviewVerdictGate: vi.fn(),
      writeReviewSentinel: vi.fn(),
      writeAttachment: vi.fn(),
    };

    await expect(storeReviewArtifact(baseArtifact({
      requestedDimensions: ['security'],
      result: {
        ...baseArtifact().result,
        verdict: 'fail',
        missingCount: 1,
        dimensions: [{
          dimension: 'security',
          verdict: 'fail',
          summary: 'missing',
          findings: [{ requirement: 'store command', status: 'MISSING', detail: 'missing' }],
        }],
      },
    }), {}, deps)).rejects.toThrow(/MISSING findings/);

    expect(deps.storeReviewBatch).not.toHaveBeenCalled();
    expect(deps.writeReviewSentinel).not.toHaveBeenCalled();
    expect(deps.rerunReviewVerdictGate).not.toHaveBeenCalled();
  });

  it('reports strict sentinel failures without rerunning the review gate', async () => {
    const deps = {
      nextReviewRound: vi.fn().mockReturnValue(4),
      storeReviewBatch: vi.fn().mockReturnValue({ urls: ['u1'], summaryUrl: 'summary-url' }),
      rerunReviewVerdictGate: vi.fn(),
      writeReviewSentinel: vi.fn().mockImplementation(() => {
        throw new Error('sentinel write failed');
      }),
      writeAttachment: vi.fn(),
    };

    await expect(storeReviewArtifact(baseArtifact({ requestedDimensions: ['security'] }), { rerunGate: true }, deps)).rejects.toThrow('sentinel write failed');

    expect(deps.storeReviewBatch).toHaveBeenCalled();
    expect(deps.writeReviewSentinel).toHaveBeenCalledWith('Garsson-io/kaizen', '1735', 4, { strict: true });
    expect(deps.rerunReviewVerdictGate).not.toHaveBeenCalled();
  });
});

describe('assertArtifactTargetMatchesArgs', () => {
  it('rejects explicit store targets that do not match the artifact metadata', () => {
    const artifact = baseArtifact({ requestedDimensions: ['security'] });

    expect(() => assertArtifactTargetMatchesArgs(artifact, parseCliArgs([
      'store',
      '--file', 'artifact.json',
      '--pr', '9999',
    ]))).toThrow('--pr 9999 does not match artifact PR 1735');

    expect(() => assertArtifactTargetMatchesArgs(artifact, parseCliArgs([
      'store',
      '--file', 'artifact.json',
      '--repo', 'Other/repo',
    ]))).toThrow('--repo Other/repo does not match artifact repo Garsson-io/kaizen');
  });
});

describe('storeDebugArtifact', () => {
  it('stores a non-authoritative debug attachment without calling authoritative storage', () => {
    const deps = { writeAttachment: vi.fn().mockReturnValue('debug-url') };
    const artifact = baseArtifact({
      result: {
        ...baseArtifact().result,
        verdict: 'fail',
        missingCount: 1,
      },
    });

    const url = storeDebugArtifact(artifact, 'logs/review/pr-1735-r1.json', deps);

    expect(url).toBe('debug-url');
    expect(deps.writeAttachment.mock.calls[0][0]).toEqual({ kind: 'pr', number: '1735', repo: 'Garsson-io/kaizen' });
    expect(deps.writeAttachment.mock.calls[0][1]).toMatch(/^review\/debug\//);
    expect(deps.writeAttachment.mock.calls[0][2]).toContain('does not satisfy the review verdict gate');
  });
});

describe('help text', () => {
  it('includes examples for focused, full, dry-run, store, and combined workflows', () => {
    const help = buildHelp();

    expect(help).toContain('focused rerun');
    expect(help).toContain('full PR review');
    expect(help).toContain('dry-run artifact only');
    expect(help).toContain('store after inspection');
    expect(help).toContain('run-and-store');
    expect(help).toContain('--group diff,tests');
  });

  it('renders help through the executable CLI entrypoint', () => {
    const result = spawnSync('npx', ['tsx', 'scripts/review-round.ts', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('review-round - run and store focused authoritative review rounds');
  });
});

describe('formatRecoveryCommands', () => {
  it('prints final progress for pass, partial, missing, absent, and provider-failed dimensions', () => {
    const artifact = baseArtifact({
      requestedDimensions: ['security', 'requirements', 'test-quality', 'dry', 'tooling-fitness'],
      result: {
        ...baseArtifact().result,
        failedDimensions: ['tooling-fitness'],
        dimensions: [
          baseArtifact().result.dimensions[0],
          {
            dimension: 'requirements',
            verdict: 'fail',
            summary: 'partial',
            findings: [{ requirement: 'R', status: 'PARTIAL', detail: 'partial' }],
          },
          {
            dimension: 'test-quality',
            verdict: 'fail',
            summary: 'missing',
            findings: [{ requirement: 'T', status: 'MISSING', detail: 'missing' }],
          },
        ],
      },
    });

    expect(formatDimensionProgress(artifact)).toContain('security: PASS');
    expect(formatDimensionProgress(artifact)).toContain('requirements: PARTIAL (1)');
    expect(formatDimensionProgress(artifact)).toContain('test-quality: MISSING (1)');
    expect(formatDimensionProgress(artifact)).toContain('dry: MISSING');
    expect(formatDimensionProgress(artifact)).toContain('tooling-fitness: PROVIDER_FAILED');
  });

  it('prints a tailored rerun command for missing dimensions', () => {
    const artifact = baseArtifact({
      requestedDimensions: ['security', 'requirements'],
      result: {
        ...baseArtifact().result,
        verdict: 'fail',
        missingCount: 1,
        dimensions: [
          baseArtifact().result.dimensions[0],
          {
            dimension: 'requirements',
            verdict: 'fail',
            summary: 'missing',
            findings: [{ requirement: 'store command', status: 'MISSING', detail: 'missing' }],
          },
        ],
      },
    });

    expect(formatRecoveryCommands(artifact, 'logs/review/pr-1735-r1.json')).toContain('--dimensions requirements');
  });

  it('reruns requested dimensions that are absent from the artifact results', () => {
    const artifact = baseArtifact({
      requestedDimensions: ['security', 'dry'],
      result: {
        ...baseArtifact().result,
        dimensions: [baseArtifact().result.dimensions[0]],
      },
    });

    expect(formatRecoveryCommands(artifact, 'logs/review/pr-1735-r1.json')).toContain('--dimensions dry');
  });

  it('shell-quotes generated command arguments', () => {
    const artifact = baseArtifact({ requestedDimensions: ['security'] });
    const command = formatRecoveryCommands(artifact, 'logs/review/pr 1735-r1.json');

    expect(command).toContain("--file 'logs/review/pr 1735-r1.json'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe('runAndStoreReviewRound', () => {
  it('rejects combined storage without the explicit pass guard', async () => {
    await expect(runAndStoreReviewRound(parseCliArgs(['run-and-store']))).rejects.toThrow('--store-only-if-pass');
  });

  it('runs first and stores only the returned passable artifact', async () => {
    const gh = makeReviewRoundGhMock();
    const runDeps = {
      reviewBattery: vi.fn().mockResolvedValue({
        verdict: 'pass',
        reviewProvider: provider,
        dimensions: [baseArtifact().result.dimensions[0]],
        missingCount: 0,
        partialCount: 0,
        durationMs: 10,
        costUsd: 0,
        failedDimensions: [],
        failedDimensionFailures: [],
        skippedDimensions: [],
      }),
      listPrDimensions: vi.fn().mockReturnValue(['security']),
      gh: gh as any,
      retrievePlan: vi.fn().mockReturnValue('stored plan'),
      retrieveTestPlan: vi.fn().mockReturnValue('stored test plan'),
      writeArtifact: vi.fn(),
      now: () => '2026-06-30T10:00:00.000Z',
    };
    const storeDeps = {
      nextReviewRound: vi.fn().mockReturnValue(2),
      storeReviewBatch: vi.fn().mockReturnValue({ urls: ['u'], summaryUrl: 's' }),
      rerunReviewVerdictGate: vi.fn(),
      writeReviewSentinel: vi.fn(),
      writeAttachment: vi.fn(),
    };
    const args = parseCliArgs(['run-and-store', '--store-only-if-pass', '--pr', '1735', '--issue', '1732', '--repo', 'Garsson-io/kaizen', '--dimensions', 'security']);
    const result = await runAndStoreReviewRound(args, runDeps, storeDeps);

    expect(result.stored.summaryUrl).toBe('s');
    expect(runDeps.writeArtifact).toHaveBeenCalled();
    expect(storeDeps.storeReviewBatch).toHaveBeenCalledWith(
      { kind: 'pr', number: '1735', repo: 'Garsson-io/kaizen' },
      2,
      [{
        dimension: 'security',
        verdict: 'pass',
        summary: 'Security looks good.',
        findings: [{ requirement: 'No shell injection', status: 'DONE', detail: 'Uses arg arrays.' }],
      }],
    );
    expect(runDeps.writeArtifact.mock.invocationCallOrder[0]).toBeLessThan(storeDeps.storeReviewBatch.mock.invocationCallOrder[0]);
  });
});
