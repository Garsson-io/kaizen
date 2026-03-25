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

// BUGS_PR: kaizen-test-fixture/pull/5 — synthetic PR with two known bugs (issue #4).
//
//   Bug 1 — logic-correctness: off-by-one in countMatching()
//     `for (let i = 0; i < items.length - 1; i++)` skips the last element.
//     Tests pass because the test array ends with an odd number, so missing the
//     last element doesn't affect the even-number count.
//
//   Bug 2 — error-handling: NaN on empty array in average()
//     `return sum / numbers.length` → NaN when numbers = [].
//     Tests pass because no test calls average([]).
//
// Used by: logic-correctness smoke, error-handling smoke.
// Expected: logic-correctness flags Bug 1, error-handling flags Bug 2.
const BUGS_PR: PrFixture = {
  prUrl: 'https://github.com/Garsson-io/kaizen-test-fixture/pull/5',
  issueNum: '4',
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
  label: string = dim,
): Promise<SmokeResult> {
  // DEV MODE: load latest checkpoint for fast assertion iteration
  if (DEV_MODE) {
    const checkpoint = findLatestCheckpoint(label, tier);
    if (checkpoint) {
      const data: CheckpointData = JSON.parse(readFileSync(checkpoint, 'utf8'));
      console.log(`  [dev] ${label} ${tier}: loaded checkpoint ${checkpoint}`);
      return { ...data, rawPath: checkpoint, fromCheckpoint: true };
    }
    console.warn(`  [dev] ${label} ${tier}: no checkpoint found, falling through to real call`);
  }

  // SKIP_PASSED: skip if result file shows it already passed
  const resultPath = join(RESULTS_DIR, `${label}-${tier}.result.json`);
  if (SKIP_PASSED && existsSync(resultPath)) {
    const prev: CheckpointData = JSON.parse(readFileSync(resultPath, 'utf8'));
    if (prev.passed) {
      console.log(`  [skip] ${label} ${tier}: already passed ($${prev.costUsd?.toFixed(3)})`);
      return { review: prev.review, rawPath: prev.rawPath, costUsd: prev.costUsd, durationMs: 0, fromCheckpoint: true };
    }
  }

  // Real call — write checkpoint before parsing so it survives assertion failures
  const timestamp = Date.now();
  const rawPath = join(RESULTS_DIR, `${label}-${tier}-${timestamp}.txt`);

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
    `  ${label} ${tier}: $${costUsd.toFixed(3)} in ${Math.round(durationMs / 1000)}s → ${rawPath}`,
  );

  return { review, rawPath, costUsd, durationMs, fromCheckpoint: false };
}

/** Mark the checkpoint as passed so SKIP_PASSED mode can skip it next run. */
function markPassed(dim: string, tier: 'smoke' | 'replay', result: SmokeResult, label: string = dim): void {
  if (result.fromCheckpoint) return; // don't overwrite a checkpoint we loaded
  const resultPath = join(RESULTS_DIR, `${label}-${tier}.result.json`);
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

// ── Tier 2: Synthetic bug detection smoke ─────────────────────────────
//
// These tests run specific review dimensions against BUGS_PR — a synthetic PR
// containing two known bugs. The goal: verify the review battery can detect
// real bugs, not just schema-validate its output.
//
// BUGS_PR (kaizen-test-fixture/pull/5) has:
//   - off-by-one in countMatching() → should be caught by logic-correctness
//   - NaN on empty input in average() → should be caught by error-handling
//
// Checkpoint names use a label suffix ("-bugs") to avoid colliding with
// checkpoints from DEFAULT_PR runs of the same dimension.
//
// AUTO-DENT INTEGRATION:
//   After these tests establish that the battery detects the bugs, run:
//     npx tsx scripts/review-fix.ts --pr https://github.com/Garsson-io/kaizen-test-fixture/pull/5
//   This simulates auto-dent: review → file issues → implement fixes → re-review.

describe('Tier 2 — bug detection smoke on synthetic bugs PR (CLAUDE_E2E=1 to enable)', () => {
  it('logic-correctness: flags off-by-one bug in countMatching', { timeout: 150_000 }, async () => {
    if (!TIER2) {
      console.log('  [skip] set CLAUDE_E2E=1 to run logic-correctness bug detection (~$0.05, ~30s)');
      console.log('         target: off-by-one in countMatching (i < items.length - 1)');
      return;
    }

    const result = await runDimensionCall('logic-correctness', 'smoke', BUGS_PR, 'logic-correctness-bugs');

    expect(
      result.costUsd,
      `logic-correctness smoke cost $${result.costUsd.toFixed(3)} exceeds cap $${SMOKE_BUDGET_USD}` +
      ` — raw: ${result.rawPath}`,
    ).toBeLessThanOrEqual(SMOKE_BUDGET_USD);

    assertSchemaValid(result.review, 'logic-correctness', result.rawPath);

    // The dimension should detect the bug — verdict must be 'fail'
    expect(
      result.review!.verdict,
      `logic-correctness should flag the off-by-one bug (verdict='fail') — raw: ${result.rawPath}\n` +
      `Findings: ${JSON.stringify(result.review!.findings, null, 2)}`,
    ).toBe('fail');

    markPassed('logic-correctness', 'smoke', result, 'logic-correctness-bugs');
  });

  it('error-handling: flags NaN on empty input in average', { timeout: 150_000 }, async () => {
    if (!TIER2) {
      console.log('  [skip] set CLAUDE_E2E=1 to run error-handling bug detection (~$0.05, ~30s)');
      console.log('         target: NaN when average([]) called (division by zero)');
      return;
    }

    const result = await runDimensionCall('error-handling', 'smoke', BUGS_PR, 'error-handling-bugs');

    expect(
      result.costUsd,
      `error-handling smoke cost $${result.costUsd.toFixed(3)} exceeds cap $${SMOKE_BUDGET_USD}` +
      ` — raw: ${result.rawPath}`,
    ).toBeLessThanOrEqual(SMOKE_BUDGET_USD);

    assertSchemaValid(result.review, 'error-handling', result.rawPath);

    // The dimension should detect the unguarded division — verdict must be 'fail'
    expect(
      result.review!.verdict,
      `error-handling should flag the unguarded division by zero (verdict='fail') — raw: ${result.rawPath}\n` +
      `Findings: ${JSON.stringify(result.review!.findings, null, 2)}`,
    ).toBe('fail');

    markPassed('error-handling', 'smoke', result, 'error-handling-bugs');
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

// ── Tier 4: Auto-dent E2E — full fix loop ─────────────────────────────
//
// Tests the complete auto-dent loop against the synthetic bugs fixture:
//   detect bugs → pick issues → implement fixes → run tests → create PRs → merge
//
// FIXTURE SETUP (permanent, in Garsson-io/kaizen-test-fixture):
//   branch fixture/buggy-utils @ 5f1dd1c7
//     src/utils.ts has two known bugs:
//       - countMatching: off-by-one (i < items.length - 1)
//       - average: NaN on empty (sum / 0)
//     Tests pass WITH the bugs (edge cases deliberately excluded)
//
// EACH TEST RUN:
//   1. Creates a fresh branch test/autodent-<ts> from fixture/buggy-utils
//   2. Files two new issues in kaizen-test-fixture describing the bugs
//   3. Bootstraps a state.json with host_repo=kaizen-test-fixture and
//      guidance directing the agent to the test branch + issues
//   4. Runs auto-dent-run.ts (single run, $3 budget)
//   5. Asserts: both issues closed, ≥2 PRs created, run succeeded
//   6. Cleans up: deletes the test branch
//
// Enable with: CLAUDE_E2E_AUTODENT=1
// Cost: ~$0.70–$1.50 per run, ~4–6 min

const TIER4_AUTODENT = !!process.env.CLAUDE_E2E_AUTODENT;

// The commit SHA of the buggy state (PR #5 merged to main, before any fixes).
// fixture/buggy-utils branch always points here — this is the reset point.
const BUGGY_UTILS_SHA = '5f1dd1c7d7c159e2b66f0f1ea5278d77bda17055';
const FIXTURE_REPO = 'Garsson-io/kaizen-test-fixture';

async function execCapture(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', cmd], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Command failed (${code}): ${cmd}\n${err}`));
      else resolve(out.trim());
    });
  });
}

describe('Tier 4 — auto-dent E2E full fix loop (CLAUDE_E2E_AUTODENT=1 to enable)', () => {
  it(
    'auto-dent detects and fixes both bugs in kaizen-test-fixture',
    { timeout: 600_000 },
    async () => {
      if (!TIER4_AUTODENT) {
        console.log('  [skip] set CLAUDE_E2E_AUTODENT=1 to run full auto-dent loop (~$1, ~5min)');
        console.log('         fixture: Garsson-io/kaizen-test-fixture @ fixture/buggy-utils');
        console.log('         bugs: off-by-one in countMatching, NaN in average');
        return;
      }

      const ts = Date.now();
      const testBranch = `test/autodent-${ts}`;
      let cleanedUp = false;

      const cleanup = async () => {
        if (cleanedUp) return;
        cleanedUp = true;
        try {
          await execCapture(
            `gh api repos/${FIXTURE_REPO}/git/refs/heads/${testBranch.replace('/', '/')} -X DELETE 2>/dev/null || true`,
          );
        } catch {}
      };

      try {
        // ── Step 1: Create fresh test branch from the buggy commit ─────
        console.log(`  [setup] creating branch ${testBranch} from ${BUGGY_UTILS_SHA.slice(0, 7)}`);
        await execCapture(
          `gh api repos/${FIXTURE_REPO}/git/refs -X POST ` +
          `-f ref="refs/heads/${testBranch}" -f sha="${BUGGY_UTILS_SHA}"`,
        );

        // ── Step 2: File fresh issues ──────────────────────────────────
        console.log('  [setup] filing bug issues in kaizen-test-fixture');
        const issue1Url = await execCapture(
          `gh issue create --repo ${FIXTURE_REPO} ` +
          `--title "Bug: countMatching skips last element (off-by-one)" ` +
          `--body "In branch ${testBranch}: \`for (let i = 0; i < items.length - 1; i++)\` ` +
          `skips the last element. Fix: change to \`i < items.length\`. ` +
          `Add a regression test: countMatching([2,4,6], n=>n%2===0) should return 3."`,
        );
        const issue1Num = issue1Url.split('/').pop()!;

        const issue2Url = await execCapture(
          `gh issue create --repo ${FIXTURE_REPO} ` +
          `--title "Bug: average() returns NaN for empty array" ` +
          `--body "In branch ${testBranch}: \`return sum / numbers.length\` returns NaN when ` +
          `numbers is empty (divide by zero). Fix: throw an error if numbers.length === 0. ` +
          `Add regression test: average([]) should throw."`,
        );
        const issue2Num = issue2Url.split('/').pop()!;
        console.log(`  [setup] issues: #${issue1Num} (off-by-one), #${issue2Num} (NaN)`);

        // ── Step 3: Bootstrap state.json ──────────────────────────────
        const batchId = `autodent-e2e-${ts}`;
        const logDir = join(process.cwd(), 'logs', 'auto-dent', batchId);
        mkdirSync(logDir, { recursive: true });
        const stateFile = join(logDir, 'state.json');

        const state = {
          batch_id: batchId,
          guidance: `Fix two bugs in ${FIXTURE_REPO} on branch ${testBranch}:\n` +
            `  - Issue #${issue1Num}: off-by-one in countMatching (src/utils.ts)\n` +
            `  - Issue #${issue2Num}: NaN on empty in average (src/utils.ts)\n\n` +
            `IMPORTANT: The bugs are on branch "${testBranch}", NOT on main. ` +
            `Clone that branch, create fix branches from it, and PR back to "${testBranch}". ` +
            `Do NOT target main.`,
          batch_start: Math.floor(ts / 1000),
          max_runs: 1,
          cooldown: 0,
          budget: '3.00',
          max_budget: '3.00',
          max_failures: 1,
          kaizen_repo: 'Garsson-io/kaizen',
          host_repo: FIXTURE_REPO,
          run: 0,
          consecutive_failures: 0,
          prs: [],
          issues_filed: [],
          issues_closed: [],
          run_history: [],
          stop_reason: '',
          progress_issue: '',
          test_task: false,
          experiment: false,
          max_run_seconds: 540,
          no_plan: false,
        };
        writeFileSync(stateFile, JSON.stringify(state, null, 2));

        // ── Step 4: Run auto-dent-run.ts ───────────────────────────────
        console.log(`  [run] starting auto-dent-run.ts (budget $3, timeout 9min)`);
        const runnerPath = join(process.cwd(), '..', '..', '..', 'scripts', 'auto-dent-run.ts');
        await execCapture(`npx tsx "${runnerPath}" "${stateFile}"`);

        // ── Step 5: Assert ─────────────────────────────────────────────
        const finalState = JSON.parse(readFileSync(stateFile, 'utf8'));

        // Run must have produced at least one PR
        expect(
          finalState.prs.length,
          `Expected ≥1 PRs from auto-dent run, got ${finalState.prs.length}\n` +
          `state: ${stateFile}`,
        ).toBeGreaterThanOrEqual(1);

        // Run outcome must be 'success' (set by the harness in run_history)
        const runHistory: Array<{ outcome?: string }> = finalState.run_history ?? [];
        expect(
          runHistory.some(r => r.outcome === 'success'),
          `Expected at least one run with outcome='success' in run_history\n` +
          `Actual outcomes: ${JSON.stringify(runHistory.map(r => r.outcome))}\n` +
          `state: ${stateFile}`,
        ).toBe(true);

        // All produced PRs must be merged (agent fixed the code and it landed)
        for (const prUrl of finalState.prs as string[]) {
          const prState = await execCapture(
            `gh pr view "${prUrl}" --json state --jq .state`,
          );
          expect(
            prState,
            `PR ${prUrl} should be MERGED (agent fixed the bugs and merged)\n` +
            `state: ${stateFile}`,
          ).toBe('MERGED');
        }

        // Verify the bugs are actually gone: check utils.ts on the test branch
        // after the fix PRs were merged into it
        const utilsContent = await execCapture(
          `gh api repos/${FIXTURE_REPO}/contents/src/utils.ts?ref=${testBranch} --jq .content | base64 -d`,
        );
        expect(
          utilsContent,
          `off-by-one bug should be fixed (i < items.length not i < items.length - 1)\n` +
          `utils.ts content:\n${utilsContent}`,
        ).not.toContain('items.length - 1');
        expect(
          utilsContent,
          `NaN bug should be fixed (should guard against empty input)\n` +
          `utils.ts content:\n${utilsContent}`,
        ).not.toMatch(/return sum \/ numbers\.length/);

        console.log(`  [pass] auto-dent fixed both bugs: PRs=${finalState.prs.join(', ')}`);

      } finally {
        await cleanup();
      }
    },
  );
});
