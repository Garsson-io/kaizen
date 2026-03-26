/**
 * review-fix.e2e.test.ts — Full loop smoke test for the review-fix pipeline.
 *
 * COST:
 *   Full loop (--dry-run, 1 review pass):  ~$0.30–0.50  ~2–4min
 *   (Runs the full review battery once, skips fix agent)
 *
 * WHAT THIS TESTS (pipe integrity):
 *   - CLI arg parsing → state init
 *   - gh prefetch (PR metadata, issue body, branch info)
 *   - review battery invocation (all dimensions, real LLM)
 *   - state persistence to .claude/review-fix/
 *   - --dry-run path: builds fix prompt, saves outcome, exits cleanly
 *
 * This is distinct from review-battery.e2e.test.ts which tests individual
 * dimensions in isolation. This test runs the full orchestration layer.
 *
 * GATE: CLAUDE_E2E=1 (same gate as dimension smoke tests)
 *
 * FIXTURE: PR #836 vs issue #783 (Garsson-io/kaizen)
 *   "fix: add restart notice to kaizen-update skill"
 *   Small, merged, real — good smoke target: self-contained, few files changed.
 *
 * FAST ITERATION:
 *   Re-running to check assertions only? The subprocess writes its own state file.
 *   Use CLAUDE_E2E_DEV=1 to skip the real subprocess call and load the saved state:
 *     CLAUDE_E2E_DEV=1 vitest run -- -t "review-fix smoke"
 *
 * OBSERVABILITY:
 *   stdout + stderr saved to: .claude/e2e-results/review-fix-smoke-<ts>.txt
 *   State file path printed in every assertion failure.
 *
 * RESUMABILITY:
 *   The subprocess itself is resumable via --resume. This harness only runs it once.
 *   If the subprocess times out, it leaves partial state — re-run with CLAUDE_E2E_DEV=1
 *   to inspect what was saved and debug assertions without re-spending budget.
 */

import { describe, it, beforeAll } from 'vitest';
import { expect } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stateKey } from './review-fix.js';
import { findLatestCheckpoint } from './e2e-test-utils.js';

// ── Config ─────────────────────────────────────────────────────────────

// PR #836 — "fix: add restart notice to kaizen-update skill" — small, merged
const FIXTURE_PR = 'https://github.com/Garsson-io/kaizen/pull/836';
const FIXTURE_ISSUE = '783';
const FIXTURE_REPO = 'Garsson-io/kaizen';

// Where the subprocess saves its state
const REVIEW_FIX_STATE_DIR = join(process.cwd(), '.claude', 'review-fix');

// Where this test saves its own observability files
const RESULTS_DIR = process.env.REVIEW_E2E_RESULTS_DIR
  ?? join(process.cwd(), '.claude', 'e2e-results');

// ── Env flags ──────────────────────────────────────────────────────────

const TIER2 = !!process.env.CLAUDE_E2E;
const DEV_MODE = !!process.env.CLAUDE_E2E_DEV;

// ── Helpers ────────────────────────────────────────────────────────────

function findLatestResultFile(): string | null {
  return findLatestCheckpoint(RESULTS_DIR, 'review-fix-smoke-');
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  resultFile: string;
  fromCheckpoint: boolean;
}

function runFullLoopDryRun(): RunResult {
  const timestamp = Date.now();
  const resultFile = join(RESULTS_DIR, `review-fix-smoke-${timestamp}.txt`);

  if (DEV_MODE) {
    const latest = findLatestResultFile();
    if (latest) {
      const data = JSON.parse(readFileSync(latest, 'utf8'));
      console.log(`  [dev] review-fix smoke: loaded checkpoint ${latest}`);
      return { ...data, resultFile: latest, fromCheckpoint: true };
    }
    console.warn('  [dev] review-fix smoke: no checkpoint found, falling through to real call');
  }

  const start = Date.now();

  const result = spawnSync(
    'npx', ['tsx', 'scripts/review-fix.ts',
      '--pr', FIXTURE_PR,
      '--issue', FIXTURE_ISSUE,
      '--repo', FIXTURE_REPO,
      '--dry-run',
      '--max-rounds', '1',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 720_000, // 12 min — sequential: 10+ dims × ~30-60s each
      env: { ...process.env, REVIEW_MODEL: process.env.REVIEW_MODEL ?? 'haiku' },
    },
  );

  const durationMs = Date.now() - start;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const exitCode = result.status ?? -1;

  // Write checkpoint immediately — all assertions below read from this
  const checkpoint = { stdout, stderr, exitCode, durationMs };
  writeFileSync(resultFile, JSON.stringify(checkpoint, null, 2));

  console.log(
    `  review-fix --dry-run: exit ${exitCode} in ${Math.round(durationMs / 1000)}s → ${resultFile}`,
  );
  if (stderr.trim()) {
    console.log(`  stderr (first 200): ${stderr.slice(0, 200)}`);
  }

  return { stdout, stderr, exitCode, durationMs, resultFile, fromCheckpoint: false };
}

// ── Pure assertions — testable against any RunResult ──────────────────

function assertExitedCleanly(run: RunResult): void {
  // finish() exits 0 only on 'pass'; dry_run exits 1 (non-pass, not an error).
  // Treat exit 0 or 1 as clean; anything else (timeout=-1, crash=2+) is a real failure.
  expect(
    run.exitCode === 0 || run.exitCode === 1,
    `review-fix --dry-run exited with code ${run.exitCode} (expected 0 or 1)\n` +
    `stderr: ${run.stderr.slice(0, 400)}\n` +
    `stdout (last 400): ${run.stdout.slice(-400)}\n` +
    `raw: ${run.resultFile}`,
  ).toBe(true);
}

function assertStateFileSaved(run: RunResult): void {
  const key = stateKey(FIXTURE_PR);
  const statePath = join(REVIEW_FIX_STATE_DIR, `${key}.json`);
  expect(
    existsSync(statePath),
    `State file not found at ${statePath}\nraw: ${run.resultFile}`,
  ).toBe(true);
}

function assertStateStructure(run: RunResult): { state: Record<string, unknown> } {
  const key = stateKey(FIXTURE_PR);
  const statePath = join(REVIEW_FIX_STATE_DIR, `${key}.json`);
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse state file at ${statePath}: ${e}\nraw: ${run.resultFile}`);
  }

  expect(
    state['outcome'],
    `Expected outcome: 'dry_run' — raw: ${run.resultFile}\nState: ${JSON.stringify(state, null, 2).slice(0, 500)}`,
  ).toBe('dry_run');

  expect(
    state['phase'],
    `Expected phase: 'done' — raw: ${run.resultFile}`,
  ).toBe('done');

  expect(
    Array.isArray(state['rounds']) && (state['rounds'] as unknown[]).length >= 1,
    `Expected at least one round — raw: ${run.resultFile}\nrounds: ${JSON.stringify(state['rounds'])}`,
  ).toBe(true);

  return { state };
}

function assertFindingsGenerated(run: RunResult, state: Record<string, unknown>): void {
  const rounds = state['rounds'] as Array<Record<string, unknown>>;
  const round0 = rounds[0];

  expect(
    round0,
    `rounds[0] is undefined — raw: ${run.resultFile}`,
  ).toBeTruthy();

  expect(
    Array.isArray(round0['findings']) && (round0['findings'] as unknown[]).length > 0,
    `Expected findings in round 0 — raw: ${run.resultFile}\n` +
    `rounds[0]: ${JSON.stringify(round0, null, 2).slice(0, 400)}`,
  ).toBe(true);

  const findings = round0['findings'] as Array<Record<string, unknown>>;
  for (const f of findings) {
    expect(
      ['DONE', 'PARTIAL', 'MISSING'].includes(f['status'] as string),
      `Invalid finding status '${f['status']}' — raw: ${run.resultFile}`,
    ).toBe(true);
    expect(typeof f['requirement'], `requirement not string — raw: ${run.resultFile}`).toBe('string');
    expect(typeof f['detail'], `detail not string — raw: ${run.resultFile}`).toBe('string');
  }
}

function assertStdoutContainsCostLine(run: RunResult): void {
  // The review battery logs cost per dimension: "  requirements smoke: $0.XXX in Xs"
  // or the review-fix wrapper logs: "  Cost: $X.XX"
  const hasCostLine = /cost.*\$[\d.]+/i.test(run.stdout) || /\$[\d.]+.*in \d+s/.test(run.stdout);
  expect(
    hasCostLine,
    `Expected a cost line in stdout (observability check) — raw: ${run.resultFile}\n` +
    `stdout (last 600): ${run.stdout.slice(-600)}`,
  ).toBe(true);
}

// ── Tier 0: unit test for stateKey (free, no subprocess) ─────────────

describe('Tier 0 — stateKey pure function', () => {
  it('extracts PR number from standard GitHub URL', () => {
    expect(stateKey('https://github.com/Garsson-io/kaizen/pull/836')).toBe('pr-836');
  });

  it('falls back to sanitized URL when no pull path', () => {
    const key = stateKey('https://example.com/some/path');
    expect(key).not.toContain('/');
    expect(key.length).toBeGreaterThan(0);
  });
});

// ── Tier 2: full loop smoke (CLAUDE_E2E=1 to enable) ──────────────────

describe('Tier 2 — full loop smoke (CLAUDE_E2E=1 to enable)', () => {
  beforeAll(() => {
    mkdirSync(RESULTS_DIR, { recursive: true });
    mkdirSync(REVIEW_FIX_STATE_DIR, { recursive: true });
    console.log(`\n  E2E results: ${RESULTS_DIR}`);
    console.log(`  State dir:   ${REVIEW_FIX_STATE_DIR}`);
    console.log('  Tip: CLAUDE_E2E_DEV=1 to load latest checkpoint (free)');
  });

  it(
    `review-fix --dry-run: full pipe for PR #836 (schema + state + findings)`,
    { timeout: 780_000 }, // 13 min — sequential: 10+ dims × ~30-60s each
    () => {
      if (!TIER2 && !DEV_MODE) {
        console.log('  [skip] set CLAUDE_E2E=1 to run full loop smoke (~$0.30-0.50, ~2-4min)');
        console.log('         or CLAUDE_E2E_DEV=1 to load latest checkpoint (free)');
        return;
      }
      if (DEV_MODE && !findLatestResultFile()) {
        console.log('  [dev-skip] no checkpoint for review-fix smoke — run CLAUDE_E2E=1 once first');
        return;
      }

      const run = runFullLoopDryRun();

      // Assertions — each includes the result file path for self-diagnosis
      assertExitedCleanly(run);
      assertStateFileSaved(run);
      const { state } = assertStateStructure(run);
      assertFindingsGenerated(run, state);
      assertStdoutContainsCostLine(run);

      console.log(`  Passed. Findings: ${((state['rounds'] as Array<Record<string, unknown>>)[0]['findings'] as unknown[]).length}`);
    },
  );
});
