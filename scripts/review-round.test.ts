import { describe, it, expect, vi } from 'vitest';
import {
  assertArtifactStoreable,
  buildHelp,
  parseCliArgs,
  reviewResultToArtifact,
  runReviewRound,
  storeReviewArtifact,
  type ReviewRoundArtifact,
} from './review-round.js';

const provider = { provider: 'codex' as const, billing: 'subscription-cli' as const };

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

  it('accepts explicit full PR review mode', () => {
    const parsed = parseCliArgs(['run', '--pr', '1735', '--issue', '1732', '--repo', 'Garsson-io/kaizen', '--all-pr']);

    expect(parsed.allPrDimensions).toBe(true);
    expect(parsed.dimensions).toEqual([]);
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
    const gh = vi.fn((args: string[]) => {
      if (args[0] === 'issue') return JSON.stringify({ title: 'Issue title', body: 'Issue body' });
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ title: 'PR title', body: 'PR body', headRefOid: 'c'.repeat(40), url: 'https://github.com/Garsson-io/kaizen/pull/1735' });
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/file b/file';
      throw new Error(`unexpected gh call ${args.join(' ')}`);
    });

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
    const gh = vi.fn((args: string[]) => {
      if (args[0] === 'issue') return JSON.stringify({ title: 'Issue title', body: 'Issue body' });
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ title: 'PR title', body: 'PR body', headRefOid: 'c'.repeat(40), url: 'https://github.com/Garsson-io/kaizen/pull/1735' });
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff';
      throw new Error(`unexpected gh call ${args.join(' ')}`);
    });

    const artifact = await runReviewRound(
      parseCliArgs(['run', '--pr', '1735', '--issue', '1732', '--repo', 'Garsson-io/kaizen', '--dimensions', 'security']),
      {
        reviewBattery,
        listPrDimensions: vi.fn(),
        gh: gh as any,
        retrievePlan: vi.fn().mockReturnValue('stored plan'),
        writeArtifact,
        now: () => '2026-06-30T10:00:00.000Z',
      },
    );

    expect(writeArtifact).toHaveBeenCalledWith('logs/review/pr-1735-20260630T100000Z.json', artifact);
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
});

describe('storeReviewArtifact', () => {
  it('stores a passable artifact into the existing structured review contract', async () => {
    const deps = {
      nextReviewRound: vi.fn().mockReturnValue(4),
      storeReviewBatch: vi.fn().mockReturnValue({ urls: ['u1'], summaryUrl: 'summary-url' }),
      rerunReviewVerdictGate: vi.fn().mockReturnValue({ action: 'rerun', runId: 123, message: 'rerun requested' }),
    };

    const result = await storeReviewArtifact(baseArtifact(), { rerunGate: true }, deps);

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
    expect(deps.rerunReviewVerdictGate).toHaveBeenCalledWith('Garsson-io/kaizen', '1735');
    expect(result).toEqual({ round: 4, urls: ['u1'], summaryUrl: 'summary-url', gate: 'rerun requested' });
  });

  it('dry-run validates but never writes attachments or reruns the gate', async () => {
    const deps = {
      nextReviewRound: vi.fn().mockReturnValue(4),
      storeReviewBatch: vi.fn(),
      rerunReviewVerdictGate: vi.fn(),
    };

    const result = await storeReviewArtifact(baseArtifact(), { dryRun: true, rerunGate: true, round: 7 }, deps);

    expect(deps.storeReviewBatch).not.toHaveBeenCalled();
    expect(deps.rerunReviewVerdictGate).not.toHaveBeenCalled();
    expect(result).toEqual({ round: 7, urls: [], summaryUrl: undefined, gate: undefined });
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
  });
});
