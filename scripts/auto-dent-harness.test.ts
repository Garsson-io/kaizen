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
import { existsSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { execSync } from 'child_process';
import {
  replayLog,
  runLiveProbe,
  expectPhase,
  phaseCount,
  SMOKE_TEST_PROMPT,
  type StreamCapture,
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
    // Create a temp empty file
    const { mkdtempSync, writeFileSync } = require('fs');
    const { tmpdir } = require('os');
    const dir = mkdtempSync(join(tmpdir(), 'harness-test-'));
    const emptyLog = join(dir, 'empty.log');
    writeFileSync(emptyLog, '');

    const capture = replayLog(emptyLog);
    expect(capture.rawMessages).toHaveLength(0);
    expect(capture.logLines).toHaveLength(0);
    expect(capture.result.toolCalls).toBe(0);
  });

  it('handles log with non-JSON lines (stderr, metadata)', () => {
    const { mkdtempSync, writeFileSync } = require('fs');
    const { tmpdir } = require('os');
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
