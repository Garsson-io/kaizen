/**
 * Integration tests using the auto-dent harness.
 *
 * - Replay tests: feed real captured logs through the pipeline (fast, deterministic)
 * - Live smoke test: spawn a bounded claude session and verify the pipeline (slow, real)
 *
 * Live tests are tagged with `live` and skipped by default.
 * Run with: npm test -- --run scripts/auto-dent-harness.test.ts
 * Run live: LIVE_PROBE=1 npm test -- --run scripts/auto-dent-harness.test.ts
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import {
  replayLog,
  runLiveProbe,
  runStream,
  msg,
  expectPhase,
  phaseCount,
  validateLifecycle,
  expectValidLifecycle,
  expectPhaseOrder,
  expectResult,
  scenarios,
  SMOKE_TEST_PROMPT,
} from './auto-dent-harness.js';

// Resolve repo root (works from worktrees too)
function getRepoRoot(): string {
  try {
    const gitCommonDir = execSync(
      'git rev-parse --path-format=absolute --git-common-dir',
      { encoding: 'utf8' },
    ).trim();
    return gitCommonDir.replace(/\/\.git$/, '');
  } catch {
    return resolve(dirname(new URL(import.meta.url).pathname), '..');
  }
}

const REPO_ROOT = getRepoRoot();
const LOGS_DIR = join(REPO_ROOT, 'logs/auto-dent');

// Replay tests — feed real captured logs through the pipeline

describe('replay: captured logs', () => {
  // Find all batch directories with log files
  const batches = existsSync(LOGS_DIR)
    ? readdirSync(LOGS_DIR).filter(d => d.startsWith('batch-'))
    : [];

  if (batches.length === 0) {
    it.skip('no captured logs found (run auto-dent first to generate)', () => {});
    return;
  }

  for (const batch of batches) {
    const batchDir = join(LOGS_DIR, batch);
    const logFiles = readdirSync(batchDir).filter(f => f.endsWith('.log'));

    for (const logFile of logFiles) {
      const logPath = join(batchDir, logFile);

      it(`replays ${batch}/${logFile} without errors`, () => {
        const capture = replayLog(logPath);

        // Basic invariants every real run should satisfy
        expect(capture.rawMessages.length).toBeGreaterThan(0);

        // Should have at least an init message
        const initMsgs = capture.rawMessages.filter(
          m => m.type === 'system' && m.subtype === 'init',
        );
        expect(initMsgs.length).toBeGreaterThanOrEqual(1);

        // Completed runs should have a result message.
        // In-progress or truncated logs may not — that's OK.
        const resultMsgs = capture.rawMessages.filter(m => m.type === 'result');
        if (resultMsgs.length > 0) {
          // Cost should be recorded in completed runs
          expect(capture.result.cost).toBeGreaterThanOrEqual(0);
        }

        // Tool calls should be non-negative regardless
        expect(capture.result.toolCalls).toBeGreaterThanOrEqual(0);
      });

      it(`extracts consistent artifacts from ${batch}/${logFile}`, () => {
        const capture = replayLog(logPath);

        // PR URLs should be well-formed if present
        for (const pr of capture.result.prs) {
          expect(pr).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/);
        }

        // Issue URLs should be well-formed if present
        for (const issue of capture.result.issuesFiled) {
          expect(issue).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/);
        }
      });
    }
  }
});

// Harness self-test — verify replayLog handles edge cases

describe('replay: edge cases', () => {
  it('handles empty log gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-test-'));
    const emptyLog = join(dir, 'empty.log');
    writeFileSync(emptyLog, '');

    const capture = replayLog(emptyLog);
    expect(capture.rawMessages).toHaveLength(0);
    expect(capture.logLines).toHaveLength(0);
    expect(capture.result.toolCalls).toBe(0);
  });

  it('handles log with non-JSON lines (stderr, metadata)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-test-'));
    const mixedLog = join(dir, 'mixed.log');
    writeFileSync(mixedLog, [
      'some stderr output',
      '{"type":"system","subtype":"init","session_id":"abc","model":"test"}',
      '--- auto-dent metadata ---',
      'batch_id=test',
      '{"type":"result","subtype":"success","total_cost_usd":0.5,"result":"done"}',
    ].join('\n'));

    const capture = replayLog(mixedLog);
    expect(capture.rawMessages).toHaveLength(2); // only JSON lines
    expect(capture.result.cost).toBe(0.5);
  });
});

// Synthetic stream tests — verify phase marker extraction

describe('synthetic: DECOMPOSE phase marker', () => {
  it('recognizes DECOMPOSE as a known phase', () => {
    const capture = runStream([
      msg.init(),
      msg.phase('PICK', { issue: '#506', title: 'experimentation framework' }),
      msg.phase('DECOMPOSE', { epic: '#506', issues_created: '#560,#561,#562' }),
      msg.phase('IMPLEMENT', { case: '260323-1200-k560', branch: 'case/260323-1200-k560' }),
      msg.done(1.5),
    ]);

    expect(phaseCount(capture, 'DECOMPOSE')).toBe(1);
    expectPhase(capture, 'DECOMPOSE');
  });

  it('DECOMPOSE phase coexists with other phases in a full flow', () => {
    const capture = runStream([
      msg.init(),
      msg.phase('PICK', { issue: '#548', title: 'cognitive modes epic' }),
      msg.phase('EVALUATE', { verdict: 'proceed', reason: 'epic needs decomposition' }),
      msg.phase('DECOMPOSE', { epic: '#548', issues_created: '#570,#571' }),
      msg.phase('IMPLEMENT', { case: '260323-test', branch: 'feat/test' }),
      msg.phase('TEST', { result: 'pass', count: '5' }),
      msg.phase('PR', { url: 'https://github.com/Garsson-io/kaizen/pull/999' }),
      msg.phase('REFLECT', { issues_filed: '2', lessons: 'decomposed epic into concrete work' }),
      msg.done(2.0),
    ]);

    expect(phaseCount(capture, 'DECOMPOSE')).toBe(1);
    expect(phaseCount(capture, 'PICK')).toBe(1);
    expect(phaseCount(capture, 'PR')).toBe(1);
    expect(capture.result.prs).toContain('https://github.com/Garsson-io/kaizen/pull/999');
  });
});

// Lifecycle validation tests

describe('lifecycle: validateLifecycle', () => {
  it('valid lifecycle with standard ordering', () => {
    const capture = runStream(scenarios.successfulRun());
    const validation = validateLifecycle(capture);

    expect(validation.valid).toBe(true);
    expect(validation.violations).toHaveLength(0);
    expect(validation.phasesPresent).toContain('PICK');
    expect(validation.phasesPresent).toContain('PR');
  });

  it('detects reversed phase ordering', () => {
    const capture = runStream([
      msg.init(),
      msg.phase('IMPLEMENT', { case: 'test', branch: 'test' }),
      msg.phase('PICK', { issue: '#100', title: 'wrong order' }),
      msg.done(0.5),
    ]);

    const validation = validateLifecycle(capture);
    expect(validation.valid).toBe(false);
    expect(validation.violations.length).toBeGreaterThan(0);
    expect(validation.violations[0].phase).toBe('PICK');
    expect(validation.violations[0].after).toBe('IMPLEMENT');
  });

  it('floating phases (DECOMPOSE, STOP) do not cause violations', () => {
    const capture = runStream([
      msg.init(),
      msg.phase('PICK', { issue: '#100', title: 'test' }),
      msg.phase('DECOMPOSE', { epic: '#100', issues_created: '#101' }),
      msg.phase('EVALUATE', { verdict: 'proceed', reason: 'ok' }),
      msg.phase('STOP', { reason: 'done' }),
      msg.done(0.5),
    ]);

    const validation = validateLifecycle(capture);
    expect(validation.valid).toBe(true);
  });

  it('reports missing standard phases', () => {
    const capture = runStream([
      msg.init(),
      msg.phase('PICK', { issue: '#100', title: 'test' }),
      msg.phase('PR', { url: 'https://github.com/Garsson-io/kaizen/pull/1' }),
      msg.done(1.0),
    ]);

    const validation = validateLifecycle(capture);
    expect(validation.phasesMissing).toContain('EVALUATE');
    expect(validation.phasesMissing).toContain('IMPLEMENT');
    expect(validation.phasesMissing).toContain('TEST');
    expect(validation.phasesMissing).not.toContain('PICK');
    expect(validation.phasesMissing).not.toContain('PR');
  });

  it('empty stream is valid (no ordering violations possible)', () => {
    const capture = runStream([msg.init(), msg.done(0)]);
    const validation = validateLifecycle(capture);
    expect(validation.valid).toBe(true);
    expect(validation.phasesPresent).toHaveLength(0);
  });
});

describe('lifecycle: expectValidLifecycle', () => {
  it('passes for valid lifecycle', () => {
    const capture = runStream(scenarios.successfulRun());
    expect(() => expectValidLifecycle(capture)).not.toThrow();
  });

  it('throws descriptive error for invalid lifecycle', () => {
    const capture = runStream([
      msg.init(),
      msg.phase('TEST', { result: 'pass', count: '1' }),
      msg.phase('EVALUATE', { verdict: 'proceed', reason: 'too late' }),
      msg.done(0.5),
    ]);

    expect(() => expectValidLifecycle(capture)).toThrow(/EVALUATE.*after.*TEST/);
  });
});

describe('lifecycle: expectPhaseOrder', () => {
  it('passes when phases appear in expected relative order', () => {
    const capture = runStream(scenarios.successfulRun());
    expect(() => expectPhaseOrder(capture, ['PICK', 'EVALUATE', 'TEST', 'PR'])).not.toThrow();
  });

  it('allows gaps between expected phases', () => {
    const capture = runStream(scenarios.successfulRun());
    expect(() => expectPhaseOrder(capture, ['PICK', 'PR'])).not.toThrow();
  });

  it('throws when phase is missing', () => {
    const capture = runStream(scenarios.skippedRun());
    expect(() => expectPhaseOrder(capture, ['PICK', 'IMPLEMENT'])).toThrow(/IMPLEMENT.*not found/);
  });

  it('throws when phases are reversed', () => {
    const capture = runStream([
      msg.init(),
      msg.phase('PR', { url: 'https://github.com/Garsson-io/kaizen/pull/1' }),
      msg.phase('PICK', { issue: '#1', title: 'late pick' }),
      msg.done(0.5),
    ]);

    expect(() => expectPhaseOrder(capture, ['PICK', 'PR'])).toThrow(/appeared before/);
  });
});

// Result assertion tests

describe('result: expectResult', () => {
  it('passes when all expectations are met', () => {
    const capture = runStream(scenarios.successfulRun({ cost: 1.5 }));
    expect(() => expectResult(capture, {
      minPrs: 1,
      maxCost: 5.0,
      stopRequested: false,
    })).not.toThrow();
  });

  it('fails when PR count is below minimum', () => {
    const capture = runStream(scenarios.skippedRun());
    expect(() => expectResult(capture, { minPrs: 1 })).toThrow(/PRs.*expected >= 1.*got 0/);
  });

  it('fails when cost exceeds maximum', () => {
    const capture = runStream(scenarios.successfulRun({ cost: 10.0 }));
    expect(() => expectResult(capture, { maxCost: 5.0 })).toThrow(/Cost.*expected <= \$5/);
  });

  it('fails when stopRequested does not match', () => {
    const capture = runStream(scenarios.stopRun());
    expect(() => expectResult(capture, { stopRequested: false })).toThrow(/stopRequested.*expected false/);
  });

  it('reports multiple failures at once', () => {
    const capture = runStream(scenarios.skippedRun({ cost: 10.0 }));
    expect(() => expectResult(capture, {
      minPrs: 1,
      maxCost: 5.0,
    })).toThrow(/PRs.*\n.*Cost/);
  });

  it('checks tool call bounds', () => {
    const capture = runStream(scenarios.successfulRun());
    expect(() => expectResult(capture, { minToolCalls: 1 })).not.toThrow();
    expect(() => expectResult(capture, { maxToolCalls: 0 })).toThrow(/Tool calls/);
  });
});

// Scenario builder tests

describe('scenarios: pre-built sequences', () => {
  it('successfulRun produces valid lifecycle with PR', () => {
    const capture = runStream(scenarios.successfulRun());
    expectValidLifecycle(capture);
    expect(capture.result.prs.length).toBeGreaterThanOrEqual(1);
    expect(capture.result.cost).toBeGreaterThan(0);
    expect(capture.result.toolCalls).toBeGreaterThan(0);
  });

  it('successfulRun accepts custom options', () => {
    const capture = runStream(scenarios.successfulRun({
      issue: '#42',
      prUrl: 'https://github.com/Garsson-io/kaizen/pull/42',
      cost: 3.0,
    }));
    expectPhase(capture, 'PICK', '#42');
    expect(capture.result.prs).toContain('https://github.com/Garsson-io/kaizen/pull/42');
    expect(capture.result.cost).toBe(3.0);
  });

  it('skippedRun produces valid lifecycle with no PRs', () => {
    const capture = runStream(scenarios.skippedRun());
    expectValidLifecycle(capture);
    expect(capture.result.prs).toHaveLength(0);
  });

  it('decomposeRun includes DECOMPOSE phase and PR', () => {
    const capture = runStream(scenarios.decomposeRun());
    expectValidLifecycle(capture);
    expectPhase(capture, 'DECOMPOSE');
    expect(capture.result.prs.length).toBeGreaterThanOrEqual(1);
  });

  it('stopRun signals stop', () => {
    const capture = runStream(scenarios.stopRun());
    expect(capture.result.stopRequested).toBe(true);
    expectPhase(capture, 'STOP');
  });

  it('errorRun has TEST fail phase and no PRs', () => {
    const capture = runStream(scenarios.errorRun());
    expectPhase(capture, 'TEST', 'fail');
    expect(capture.result.prs).toHaveLength(0);
  });
});

// Live smoke test — spawns a real bounded claude session

const LIVE = process.env.LIVE_PROBE === '1';

describe('live: smoke test', () => {
  // Skip by default — requires claude CLI and API credits
  const testFn = LIVE ? it : it.skip;

  testFn('pipeline smoke test — phase markers round-trip through real claude', async () => {
    const capture = await runLiveProbe({
      prompt: SMOKE_TEST_PROMPT,
      cwd: REPO_ROOT,
      maxBudget: 0.05,
      timeoutMs: 30_000,
    });

    // Claude should have exited cleanly
    expect(capture.exitCode).toBe(0);

    // Should have emitted phase markers
    expect(capture.phases.length).toBeGreaterThanOrEqual(1);

    // Should have requested stop
    expect(capture.result.stopRequested).toBe(true);
    expect(capture.result.stopReason).toContain('smoke test');

    // Cost should be minimal
    expect(capture.result.cost).toBeLessThan(0.10);

    console.log(`Live probe completed in ${capture.durationMs}ms, cost $${capture.result.cost.toFixed(3)}, ${capture.phases.length} phases`);
  }, 60_000); // 60s timeout for vitest
});
