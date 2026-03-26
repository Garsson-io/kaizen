import { describe, it, expect, vi } from 'vitest';
import { runReviewWiring, type ReviewWiringDeps, type ReviewWiringInput } from './auto-dent-run.js';
import type { BatteryResult } from '../src/review-battery.js';
import type { ReviewFixState } from './review-fix.js';

function makeDeps(overrides: Partial<ReviewWiringDeps> = {}): ReviewWiringDeps {
  return {
    reviewBattery: vi.fn().mockResolvedValue({
      verdict: 'pass',
      missingCount: 0,
      partialCount: 0,
      durationMs: 1000,
      costUsd: 0.10,
      failedDimensions: [],
      skippedDimensions: [],
      dimensions: [],
    } satisfies BatteryResult),
    runFixLoop: vi.fn().mockResolvedValue({
      prUrl: 'https://github.com/test/repo/pull/1',
      issueNum: '42',
      repo: 'test/repo',
      maxRounds: 2,
      budgetCap: 0.5,
      currentRound: 1,
      totalCostUsd: 0.20,
      startedAt: new Date().toISOString(),
      phase: 'done',
      rounds: [],
      outcome: 'pass',
    } satisfies ReviewFixState),
    listPrDimensions: vi.fn().mockReturnValue(['requirements', 'correctness']),
    formatBatteryReport: vi.fn().mockReturnValue('report'),
    emit: vi.fn(),
    appendLog: vi.fn(),
    writeAttachment: vi.fn(),
    ghExec: vi.fn(),
    ...overrides,
  };
}

function makeInput(overrides: Partial<ReviewWiringInput> = {}): ReviewWiringInput {
  return {
    prs: ['https://github.com/test/repo/pull/1'],
    pickedIssue: '42',
    repo: 'test/repo',
    totalBudget: 2.0,
    implementationCost: 0.5,
    runId: 'batch-1/run-1',
    batchId: 'batch-1',
    runNum: 1,
    ...overrides,
  };
}

describe('runReviewWiring', () => {
  it('INVARIANT: review pass skips fix loop, verdict is pass', async () => {
    const deps = makeDeps();
    const result = await runReviewWiring(makeInput(), deps);

    expect(result.reviewVerdict).toBe('pass');
    expect(deps.runFixLoop).not.toHaveBeenCalled();
  });

  it('INVARIANT: review fail with gaps triggers fix loop with correct args', async () => {
    const deps = makeDeps({
      reviewBattery: vi.fn().mockResolvedValue({
        verdict: 'fail',
        missingCount: 1,
        partialCount: 0,
        durationMs: 1000,
        costUsd: 0.10,
        failedDimensions: [],
        skippedDimensions: [],
        dimensions: [{
          dimension: 'requirements',
          verdict: 'fail',
          findings: [{ requirement: 'Must do X', status: 'MISSING', detail: 'Not implemented' }],
          summary: 'fail',
        }],
      } satisfies BatteryResult),
    });
    const input = makeInput({ repo: 'test/repo', pickedIssue: '42' });
    const result = await runReviewWiring(input, deps);

    expect(deps.runFixLoop).toHaveBeenCalledTimes(1);
    const fixArgs = (deps.runFixLoop as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(fixArgs.prUrl).toBe('https://github.com/test/repo/pull/1');
    expect(fixArgs.issueNum).toBe('42');
    expect(fixArgs.repo).toBe('test/repo');
  });

  it('INVARIANT: budget exceeded skips fix loop (#898 — uses remaining, not total)', async () => {
    const deps = makeDeps({
      reviewBattery: vi.fn().mockResolvedValue({
        verdict: 'fail',
        missingCount: 1,
        partialCount: 0,
        durationMs: 1000,
        costUsd: 0.10,
        failedDimensions: [],
        skippedDimensions: [],
        dimensions: [{
          dimension: 'requirements',
          verdict: 'fail',
          findings: [{ requirement: 'X', status: 'MISSING', detail: 'missing' }],
          summary: 'fail',
        }],
      } satisfies BatteryResult),
    });
    // Total budget $2, implementation cost $1.80 → remaining $0.20 → review cap $0.08
    // Review costs $0.10 → exceeds cap → no fix loop
    const input = makeInput({ totalBudget: 2.0, implementationCost: 1.80 });
    const result = await runReviewWiring(input, deps);

    expect(deps.runFixLoop).not.toHaveBeenCalled();
    expect(result.reviewVerdict).toBe('fail');
  });

  it('INVARIANT: 0 gaps skips fix loop even when verdict is fail (#897)', async () => {
    const deps = makeDeps({
      reviewBattery: vi.fn().mockResolvedValue({
        verdict: 'fail',
        missingCount: 0,
        partialCount: 0,
        durationMs: 1000,
        costUsd: 0.10,
        failedDimensions: ['requirements'],
        skippedDimensions: [],
        dimensions: [{
          dimension: 'requirements',
          verdict: 'fail',
          findings: [], // all timed out — no findings
          summary: 'timeout',
        }],
      } satisfies BatteryResult),
    });
    const result = await runReviewWiring(makeInput(), deps);

    expect(deps.runFixLoop).not.toHaveBeenCalled();
    expect(result.reviewVerdict).toBe('fail');
  });

  it('INVARIANT: fix loop pass propagates to reviewVerdict', async () => {
    const deps = makeDeps({
      reviewBattery: vi.fn().mockResolvedValue({
        verdict: 'fail',
        missingCount: 1,
        partialCount: 0,
        durationMs: 1000,
        costUsd: 0.10,
        failedDimensions: [],
        skippedDimensions: [],
        dimensions: [{
          dimension: 'requirements',
          verdict: 'fail',
          findings: [{ requirement: 'X', status: 'MISSING', detail: 'missing' }],
          summary: 'fail',
        }],
      } satisfies BatteryResult),
      runFixLoop: vi.fn().mockResolvedValue({
        prUrl: 'https://github.com/test/repo/pull/1',
        issueNum: '42',
        repo: 'test/repo',
        maxRounds: 2,
        budgetCap: 0.5,
        currentRound: 2,
        totalCostUsd: 0.30,
        startedAt: new Date().toISOString(),
        phase: 'done',
        rounds: [],
        outcome: 'pass',
      } satisfies ReviewFixState),
    });
    const result = await runReviewWiring(makeInput(), deps);

    expect(result.reviewVerdict).toBe('pass');
  });

  it('INVARIANT: fix loop fail propagates to reviewVerdict', async () => {
    const deps = makeDeps({
      reviewBattery: vi.fn().mockResolvedValue({
        verdict: 'fail',
        missingCount: 1,
        partialCount: 0,
        durationMs: 1000,
        costUsd: 0.10,
        failedDimensions: [],
        skippedDimensions: [],
        dimensions: [{
          dimension: 'requirements',
          verdict: 'fail',
          findings: [{ requirement: 'X', status: 'MISSING', detail: 'missing' }],
          summary: 'fail',
        }],
      } satisfies BatteryResult),
      runFixLoop: vi.fn().mockResolvedValue({
        prUrl: 'https://github.com/test/repo/pull/1',
        issueNum: '42',
        repo: 'test/repo',
        maxRounds: 2,
        budgetCap: 0.5,
        currentRound: 2,
        totalCostUsd: 0.30,
        startedAt: new Date().toISOString(),
        phase: 'done',
        rounds: [],
        outcome: 'max_rounds',
      } satisfies ReviewFixState),
    });
    const result = await runReviewWiring(makeInput(), deps);

    expect(result.reviewVerdict).toBe('fail');
  });

  it('INVARIANT: no PRs → verdict is skipped', async () => {
    const deps = makeDeps();
    const result = await runReviewWiring(makeInput({ prs: [] }), deps);

    expect(result.reviewVerdict).toBe('skipped');
    expect(deps.reviewBattery).not.toHaveBeenCalled();
  });

  it('INVARIANT: budget cap is (totalBudget - implementationCost) * 0.4, capped at $2 (#898)', async () => {
    // totalBudget=5, implementationCost=1 → remaining=4 → 4*0.4=1.6 → cap=1.6
    // Review costs $0.10, 1 gap → fix loop should get budgetCap = 1.6 - 0.10 = 1.5
    const deps = makeDeps({
      reviewBattery: vi.fn().mockResolvedValue({
        verdict: 'fail',
        missingCount: 1,
        partialCount: 0,
        durationMs: 1000,
        costUsd: 0.10,
        failedDimensions: [],
        skippedDimensions: [],
        dimensions: [{
          dimension: 'requirements',
          verdict: 'fail',
          findings: [{ requirement: 'X', status: 'MISSING', detail: 'missing' }],
          summary: 'fail',
        }],
      } satisfies BatteryResult),
    });
    const input = makeInput({ totalBudget: 5.0, implementationCost: 1.0 });
    await runReviewWiring(input, deps);

    const fixArgs = (deps.runFixLoop as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(fixArgs.budgetCap).toBeCloseTo(1.5, 1);
  });
});
