/**
 * review-battery.e2e.test.ts — Tier 2 (smoke) and Tier 3 (replay) E2E tests.
 *
 * COST TIERS:
 *   Tier 2 smoke   CLAUDE_E2E=1       ~$0.05/dim  ~30s/dim   schema check only
 *   Tier 3 replay  CLAUDE_E2E=replay  ~$0.20/dim  ~90s/dim   semantic correctness
 *
 *   Total Tier 2 (3 dims): ~$0.15, ~2min
 *   Total Tier 3 (1 dim):  ~$0.20, ~90s
 *
 * WHEN TO RUN (cost-aware scheduling for a work session):
 *   Mid-session (just changed a prompt): CLAUDE_E2E=1 vitest run -- -t "requirements smoke"
 *   End-of-session (all touched dims):   CLAUDE_E2E=1 vitest run scripts/review-battery.e2e.test.ts
 *   Before merge:                        CLAUDE_E2E=replay vitest run scripts/review-battery.e2e.test.ts
 *
 * FAST ITERATION WORKFLOW (how to debug without rerunning the full pipeline):
 *
 *   Step 1 — Get real output ONCE:
 *     CLAUDE_E2E=1 vitest run -- -t "requirements smoke"
 *     → saves to .claude/e2e-results/requirements-smoke-<ts>.txt
 *
 *   Step 2 — Iterate on assertions against the saved file (zero cost):
 *     CLAUDE_E2E_DEV=1 vitest run -- -t "requirements replay"
 *     → loads latest checkpoint instead of calling claude
 *     → instant, free, runs the assertion against the saved output
 *
 *   Step 3 — Validate once with real claude:
 *     CLAUDE_E2E=replay vitest run -- -t "requirements replay"
 *
 *   For prompt iteration (changed prompts/review-requirements.md):
 *     cat .claude/e2e-results/requirements-smoke-<ts>.txt | npx tsx -e "
 *       import { loadReviewPrompt } from './src/review-battery.js';
 *       console.log(loadReviewPrompt('requirements', { pr_url: '...', ... }));
 *     " | claude -p --output-format json --dangerously-skip-permissions
 *     → iterate on the prompt without running the test harness
 *
 * OBSERVABILITY:
 *   Every claude -p call writes output to a named file before parsing.
 *   Path appears in every assertion failure message.
 *   Cost + duration logged per call.
 *
 * RESUMABILITY:
 *   Use vitest --bail to stop at first failure. Fix in order, not all at once.
 *   Set SKIP_PASSED=1 to skip tests whose result files show 'passed=true'.
 *   Result files persist between runs in REVIEW_E2E_RESULTS_DIR.
 */

import { describe, it, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { expect } from 'vitest';
import { spawnReview } from '../src/review-battery.js';
import type { DimensionReview } from '../src/review-battery.js';

// ── Results dir ───────────────────────────────────────────────────────

const RESULTS_DIR = process.env.REVIEW_E2E_RESULTS_DIR
  ?? join(process.cwd(), '.claude', 'e2e-results');

// ── PR fixtures ───────────────────────────────────────────────────────
//
// DEFAULT_PR: kaizen/pull/832 — real PR, has large diff and test files.
//   Used for: requirements, scope-fidelity (and other dims that benefit from realistic complexity).
//
// FIXTURE_PR: kaizen-test-fixture/pull/3 — tiny synthetic PR (one file, no tests).
//   Used for: test-plan (avoids 180s timeout caused by reading large test files in #832).
//   PR adds truncate() utility with no tests → test-plan flags missing unit tests.

interface PrFixture { prUrl: string; issueNum: string; repo: string; }

const DEFAULT_PR: PrFixture = {
  prUrl: 'https://github.com/Garsson-io/kaizen/pull/832',
  issueNum: '666',
  repo: 'Garsson-io/kaizen',
};

const FIXTURE_PR: PrFixture = {
  prUrl: 'https://github.com/Garsson-io/kaizen-test-fixture/pull/3',
  issueNum: '2',
  repo: 'Garsson-io/kaizen-test-fixture',
};

beforeAll(() => {
  mkdirSync(RESULTS_DIR, { recursive: true });
  console.log(`\n  E2E results: ${RESULTS_DIR}`);
  console.log('  Tip: SKIP_PASSED=1 to skip already-passing tests');
  console.log('  Tip: CLAUDE_E2E_DEV=1 to load checkpoints instead of calling claude');
});

// Use haiku by default to save cost/time; override with REVIEW_MODEL=sonnet for quality checks
if (!process.env.REVIEW_MODEL) process.env.REVIEW_MODEL = 'haiku';

// ── Env flags ─────────────────────────────────────────────────────────

const TIER2 = !!process.env.CLAUDE_E2E;
const TIER3 = process.env.CLAUDE_E2E === 'replay';
const DEV_MODE = !!process.env.CLAUDE_E2E_DEV; // load checkpoint, skip real call
const SKIP_PASSED = !!process.env.SKIP_PASSED;

// Per-call budget — smoke schema check should never exceed this
const SMOKE_BUDGET_USD = 0.30;

// ── Checkpoint helpers ────────────────────────────────────────────────

/**
 * Find the most recent checkpoint file for a dimension + tier combination.
 * Returns null if none exists.
 *
 * Checkpoints are named: <dim>-<tier>-<timestamp>.txt
 * They contain the full SmokeResult JSON for that run.
 */
function findLatestCheckpoint(dim: string, tier: 'smoke' | 'replay'): string | null {
  if (!existsSync(RESULTS_DIR)) return null;
  const prefix = `${dim}-${tier}-`;
  const files = readdirSync(RESULTS_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith('.txt'))
    .sort()
    .reverse(); // most recent first (timestamp in filename)
  return files.length > 0 ? join(RESULTS_DIR, files[0]) : null;
}

interface CheckpointData {
  passed: boolean;
  costUsd: number;
  durationMs: number;
  review: DimensionReview | null;
  rawPath: string;
}

// ── Core runner ───────────────────────────────────────────────────────

interface SmokeResult {
  review: DimensionReview | null;
  rawPath: string;
  costUsd: number;
  durationMs: number;
  fromCheckpoint: boolean;
}

/**
 * Run a smoke/replay call for one dimension.
 *
 * In CLAUDE_E2E_DEV=1 mode: loads the latest checkpoint instead of calling
 * claude. This lets you iterate on assertions without burning budget.
 *
 * In normal mode: calls claude, writes full output to a named checkpoint file
 * before parsing, logs cost + duration.
 */
async function runDimensionCall(
  dim: string,
  tier: 'smoke' | 'replay',
  pr: PrFixture = DEFAULT_PR,
): Promise<SmokeResult> {
  // DEV MODE: load latest checkpoint for fast assertion iteration
  if (DEV_MODE) {
    const checkpoint = findLatestCheckpoint(dim, tier);
    if (checkpoint) {
      const data: CheckpointData = JSON.parse(readFileSync(checkpoint, 'utf8'));
      console.log(`  [dev] ${dim} ${tier}: loaded checkpoint ${checkpoint}`);
      return { ...data, rawPath: checkpoint, fromCheckpoint: true };
    }
    console.warn(`  [dev] ${dim} ${tier}: no checkpoint found, falling through to real call`);
  }

  // SKIP_PASSED: skip if result file shows it already passed
  const resultPath = join(RESULTS_DIR, `${dim}-${tier}.result.json`);
  if (SKIP_PASSED && existsSync(resultPath)) {
    const prev: CheckpointData = JSON.parse(readFileSync(resultPath, 'utf8'));
    if (prev.passed) {
      console.log(`  [skip] ${dim} ${tier}: already passed ($${prev.costUsd?.toFixed(3)})`);
      return { review: prev.review, rawPath: prev.rawPath, costUsd: prev.costUsd, durationMs: 0, fromCheckpoint: true };
    }
  }

  // Real call — write checkpoint before parsing so it survives assertion failures
  const timestamp = Date.now();
  const rawPath = join(RESULTS_DIR, `${dim}-${tier}-${timestamp}.txt`);

  const { review, costUsd, durationMs } = await spawnReview({
    dimension: dim,
    prUrl: pr.prUrl,
    issueNum: pr.issueNum,
    repo: pr.repo,
    cwd: process.cwd(),
    timeoutMs: 120_000,
  });

  // Write checkpoint immediately — BEFORE parsing or asserting
  // This means if an assertion throws, the raw output is already on disk
  const checkpoint: CheckpointData = { passed: false, costUsd, durationMs, review, rawPath };
  writeFileSync(rawPath, JSON.stringify(checkpoint, null, 2));

  console.log(
    `  ${dim} ${tier}: $${costUsd.toFixed(3)} in ${Math.round(durationMs / 1000)}s → ${rawPath}`,
  );

  return { review, rawPath, costUsd, durationMs, fromCheckpoint: false };
}

/** Mark the checkpoint as passed so SKIP_PASSED mode can skip it next run. */
function markPassed(dim: string, tier: 'smoke' | 'replay', result: SmokeResult): void {
  if (result.fromCheckpoint) return; // don't overwrite a checkpoint we loaded
  const resultPath = join(RESULTS_DIR, `${dim}-${tier}.result.json`);
  writeFileSync(resultPath, JSON.stringify({
    passed: true, costUsd: result.costUsd, durationMs: result.durationMs,
    review: result.review, rawPath: result.rawPath,
  }, null, 2));
}

// ── Assertion helpers ─────────────────────────────────────────────────
//
// Extraction pattern: assertions are pure functions of DimensionReview.
// This lets you develop them against a DimensionReview object in isolation
// before wiring to a real claude call — zero cost during iteration.

function assertSchemaValid(review: DimensionReview | null, dim: string, rawPath: string): void {
  expect(
    review,
    `${dim} returned null — raw: ${rawPath}\nCheck prompt file and claude availability.`,
  ).not.toBeNull();

  expect(
    review!.dimension,
    `dimension field missing in ${dim} — raw: ${rawPath}`,
  ).toBeTruthy();

  expect(
    Array.isArray(review!.findings),
    `findings is not an array in ${dim} — raw: ${rawPath}`,
  ).toBe(true);

  expect(
    ['pass', 'fail'].includes(review!.verdict),
    `verdict "${review!.verdict}" is not pass|fail — raw: ${rawPath}`,
  ).toBe(true);

  for (const f of review!.findings) {
    expect(
      ['DONE', 'PARTIAL', 'MISSING'].includes(f.status),
      `status "${f.status}" not DONE|PARTIAL|MISSING in ${dim} finding "${f.requirement}" — raw: ${rawPath}`,
    ).toBe(true);
    expect(typeof f.requirement, `requirement not string — raw: ${rawPath}`).toBe('string');
    expect(typeof f.detail, `detail not string — raw: ${rawPath}`).toBe('string');
  }
}

function assertRequirementsHasAdoptionGap(review: DimensionReview, rawPath: string): void {
  const gaps = review.findings.filter(f => f.status !== 'DONE');
  expect(
    gaps.length,
    `Expected at least one non-DONE finding (PR #832 had known gaps) — raw: ${rawPath}`,
  ).toBeGreaterThan(0);

  // Known gap: kaizen-implement skill did not adopt the metadata format
  const adoptionGap = review.findings.find(
    f => f.status !== 'DONE' &&
      (f.requirement.toLowerCase().includes('adopt') ||
       f.detail.toLowerCase().includes('adopt') ||
       f.detail.toLowerCase().includes('kaizen-implement')),
  );
  expect(
    adoptionGap,
    `Expected a finding about skill adoption gap in PR #832 — raw: ${rawPath}\n` +
    `Actual findings:\n${review.findings.map(f => `  [${f.status}] ${f.requirement}`).join('\n')}`,
  ).toBeTruthy();
}

// ── Tier 2: Tool availability prerequisite ────────────────────────────
//
// This test runs first. If it fails, all schema smoke tests will also fail
// (the review dims require bash tool use to fetch GitHub data). Diagnose
// tool availability before debugging review output.

describe('Tier 2 — prerequisites (CLAUDE_E2E=1 to enable)', () => {
  it('claude -p subprocess has bash tool access', { timeout: 30_000 }, async () => {
    if (!TIER2) {
      console.log('  [skip] set CLAUDE_E2E=1 to run tool-availability check');
      return;
    }

    const SENTINEL = 'KAIZEN_TOOLS_OK_' + Date.now();
    const result = await new Promise<{ text: string; exitCode: number }>((res) => {
      const child = spawn('claude', [
        '-p', '--output-format', 'stream-json', '--verbose',
        '--dangerously-skip-permissions', '--model', process.env.REVIEW_MODEL ?? 'haiku',
      ], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });

      child.stdin.write(`Run this bash command and include its exact output in your response: echo ${SENTINEL}`, 'utf8');
      child.stdin.end();

      let stdout = '';
      child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
      child.stderr.on('data', () => {});

      const timer = setTimeout(() => child.kill(), 25_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        let text = '';
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'assistant') {
              for (const block of (msg.message?.content ?? [])) {
                if (block.type === 'text') text += block.text;
              }
            }
          } catch {}
        }
        res({ text, exitCode: code ?? -1 });
      });
    });

    expect(
      result.text,
      `claude -p did not use bash tools — cannot run reviews.\n` +
      `Response was: ${result.text.slice(0, 200)}\n` +
      `Check: REVIEW_MODEL=${process.env.REVIEW_MODEL}, exitCode=${result.exitCode}`,
    ).toContain(SENTINEL);
  });
});

// ── Tier 2: Schema smoke tests ────────────────────────────────────────

describe('Tier 2 — schema smoke (CLAUDE_E2E=1 to enable)', () => {
  // These dims run against kaizen PR #832 (realistic complexity).
  // test-plan is excluded: it reads large test files from #832, causing 180s timeouts.
  // test-plan has its own test below using a small fixture PR.
  const smokeDimensions = ['requirements', 'scope-fidelity'];

  for (const dim of smokeDimensions) {
    it(`${dim}: returns valid DimensionReview schema`, { timeout: 150_000 }, async () => {
      if (!TIER2) {
        console.log(`  [skip] set CLAUDE_E2E=1 to run ${dim} smoke (~$0.05, ~30s)`);
        console.log(`         or CLAUDE_E2E_DEV=1 to load latest checkpoint (free)`);
        return;
      }

      const result = await runDimensionCall(dim, 'smoke');

      expect(
        result.costUsd,
        `${dim} smoke cost $${result.costUsd.toFixed(3)} exceeds cap $${SMOKE_BUDGET_USD}` +
        ` — raw: ${result.rawPath}`,
      ).toBeLessThanOrEqual(SMOKE_BUDGET_USD);

      assertSchemaValid(result.review, dim, result.rawPath);
      markPassed(dim, 'smoke', result);
    });
  }

  // test-plan uses a tiny synthetic PR (kaizen-test-fixture/pull/3: adds truncate()
  // with no tests). This keeps the run under 60s instead of 180s, while still
  // exercising the dimension's core signal (missing unit tests).
  it('test-plan: returns valid DimensionReview schema (fixture PR)', { timeout: 150_000 }, async () => {
    if (!TIER2) {
      console.log('  [skip] set CLAUDE_E2E=1 to run test-plan smoke (~$0.05, ~30s)');
      console.log('         uses kaizen-test-fixture/pull/3 (tiny PR, no tests)');
      return;
    }

    const result = await runDimensionCall('test-plan', 'smoke', FIXTURE_PR);

    expect(
      result.costUsd,
      `test-plan smoke cost $${result.costUsd.toFixed(3)} exceeds cap $${SMOKE_BUDGET_USD}` +
      ` — raw: ${result.rawPath}`,
    ).toBeLessThanOrEqual(SMOKE_BUDGET_USD);

    assertSchemaValid(result.review, 'test-plan', result.rawPath);
    markPassed('test-plan', 'smoke', result);
  });
});

// ── Tier 3: Semantic replay tests ─────────────────────────────────────
//
// Promotion workflow (how to add a new Tier 3 test without wasting budget):
//
//  1. Run Tier 2 smoke once to get real output:
//       CLAUDE_E2E=1 vitest run -- -t "requirements smoke"
//     Output saved to: .claude/e2e-results/requirements-smoke-<ts>.txt
//
//  2. Read the output, verify findings make sense:
//       cat .claude/e2e-results/requirements-smoke-<ts>.txt | jq .review.findings
//
//  3. Write the assertion function (pure, takes DimensionReview):
//       function assertMyDimension(review, rawPath) { expect(...).toBe(...); }
//
//  4. Test the assertion against the saved checkpoint (free, instant):
//       CLAUDE_E2E_DEV=1 vitest run -- -t "my-dim replay"
//     → loads checkpoint, runs assertion, zero cost
//
//  5. Validate once with real claude:
//       CLAUDE_E2E=replay vitest run -- -t "my-dim replay"
//
// Never write a Tier 3 assertion speculatively ("I think the output should be X").
// Always derive it from real captured output you have manually verified.

describe('Tier 3 — semantic replay (CLAUDE_E2E=replay to enable)', () => {
  it(
    'requirements: PR #832 (skill-metadata) flags zero-adoption gap',
    { timeout: 180_000 },
    async () => {
      if (!TIER3 && !DEV_MODE) {
        console.log('  [skip] set CLAUDE_E2E=replay (or CLAUDE_E2E_DEV=1) to run requirements replay');
        return;
      }
      if (!TIER3 && DEV_MODE && !findLatestCheckpoint('requirements', 'replay')) {
        console.log('  [dev-skip] no checkpoint for requirements replay — run CLAUDE_E2E=replay once first');
        return;
      }

      const result = await runDimensionCall('requirements', 'replay');
      assertSchemaValid(result.review, 'requirements', result.rawPath);
      assertRequirementsHasAdoptionGap(result.review!, result.rawPath);
      markPassed('requirements', 'replay', result);
    },
  );

  // TODO: Add replay cases for remaining dimensions — add when motivating PR found.
  // Use the promotion workflow above. Never add speculatively.
  //
  // Candidates (with conditions for when to add):
  // - scope-fidelity:       when a PR adds unrequested refactoring is caught
  // - test-plan:            PR #846 itself — this PR had wrong pyramid levels
  // - dry:                  when a confirmed duplication is caught
  // - error-handling:       when swallowed exception is caught
  // - logic-correctness:    when a confirmed logic bug is caught
  // - plan-fidelity:        when a PR diverges from its plan
  // - improvement-lifecycle: PR #846 — review battery without lifecycle
});
