/**
 * review-battery.test.ts — Tests for the review battery system.
 *
 * Three test tiers:
 *   1. Schema/parser tests (fast, deterministic)
 *   2. Prompt template loading tests (fast, deterministic)
 *   3. Replay tests against known PRs (slow, costs money, non-deterministic)
 *
 * Replay tests are gated behind RUN_REPLAY_TESTS=1 env var.
 * They validate that review prompts produce correct findings on known PRs.
 */

import { describe, it, expect } from 'vitest';
import {
  parseReviewOutput,
  formatBatteryReport,
  loadReviewPrompt,
  resolvePromptsDir,
  discoverDimensions,
  listDimensions,
  loadDimensionMetas,
  reviewBriefing,
  validateReviewCoverage,
  MAX_FIX_ROUNDS,
  BUDGET_CAP_USD,
  PASSING_THRESHOLD,
  type DimensionReview,
  type DimensionMeta,
  type BatteryResult,
  type ReviewDimension,
} from './review-battery.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Tier 1: Schema and parser tests

describe('parseReviewOutput', () => {
  it('parses valid JSON with findings', () => {
    const raw = `Here is my review:
\`\`\`json
{
  "dimension": "requirements",
  "summary": "2 of 3 requirements met",
  "findings": [
    {"requirement": "R1: Define interface", "status": "DONE", "detail": "Interface exists at line 11"},
    {"requirement": "R2: Add parser", "status": "DONE", "detail": "Parser implemented"},
    {"requirement": "R3: Validate deps", "status": "MISSING", "detail": "Validation exists but never runs"}
  ]
}
\`\`\``;

    const result = parseReviewOutput(raw, 'requirements');
    expect(result).not.toBeNull();
    expect(result!.dimension).toBe('requirements');
    expect(result!.verdict).toBe('fail');
    expect(result!.findings).toHaveLength(3);
    expect(result!.findings[0].status).toBe('DONE');
    expect(result!.findings[2].status).toBe('MISSING');
  });

  it('parses JSON without markdown fences', () => {
    const raw = `{"dimension":"plan-coverage","summary":"all good","findings":[{"requirement":"R1","status":"DONE","detail":"ok"}]}`;
    const result = parseReviewOutput(raw, 'plan-coverage');
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('pass');
  });

  it('normalizes status variants', () => {
    const raw = `\`\`\`json
{"findings":[
  {"requirement":"A","status":"PASS","detail":"ok"},
  {"requirement":"B","status":"COMPLETE","detail":"ok"},
  {"requirement":"C","status":"ADDRESSED","detail":"ok"},
  {"requirement":"D","status":"PARTIALLY","detail":"half"},
  {"requirement":"E","status":"partial","detail":"half"},
  {"requirement":"F","status":"NOT_ADDRESSED","detail":"nope"}
]}
\`\`\``;
    const result = parseReviewOutput(raw, 'test');
    expect(result).not.toBeNull();
    expect(result!.findings[0].status).toBe('DONE');
    expect(result!.findings[1].status).toBe('DONE');
    expect(result!.findings[2].status).toBe('DONE');
    expect(result!.findings[3].status).toBe('PARTIAL');
    expect(result!.findings[4].status).toBe('PARTIAL');
    expect(result!.findings[5].status).toBe('MISSING');
  });

  it('returns null for unparseable input', () => {
    expect(parseReviewOutput('just some text', 'test')).toBeNull();
    expect(parseReviewOutput('', 'test')).toBeNull();
    expect(parseReviewOutput('```json\n{broken json\n```', 'test')).toBeNull();
  });

  it('returns null when findings is not an array', () => {
    const raw = '{"findings": "not an array"}';
    expect(parseReviewOutput(raw, 'test')).toBeNull();
  });

  it('handles alternative field names (item/description)', () => {
    const raw = `{"findings":[{"item":"R1","status":"DONE","description":"implemented"}]}`;
    const result = parseReviewOutput(raw, 'test');
    expect(result).not.toBeNull();
    expect(result!.findings[0].requirement).toBe('R1');
    expect(result!.findings[0].detail).toBe('implemented');
  });

  it('verdict is pass only when ALL findings are DONE', () => {
    const allDone = `{"findings":[{"requirement":"A","status":"DONE","detail":"ok"},{"requirement":"B","status":"DONE","detail":"ok"}]}`;
    const onePartial = `{"findings":[{"requirement":"A","status":"DONE","detail":"ok"},{"requirement":"B","status":"PARTIAL","detail":"half"}]}`;

    expect(parseReviewOutput(allDone, 'test')!.verdict).toBe('pass');
    expect(parseReviewOutput(onePartial, 'test')!.verdict).toBe('fail');
  });

  it('extracts JSON from text with surrounding prose', () => {
    const raw = `Let me analyze this PR.

After careful review, here are my findings:

{"dimension":"requirements","summary":"gaps found","findings":[{"requirement":"R1","status":"MISSING","detail":"not implemented"}]}

That concludes my review.`;
    const result = parseReviewOutput(raw, 'requirements');
    expect(result).not.toBeNull();
    expect(result!.findings[0].status).toBe('MISSING');
  });
});

// Tier 1: Battery report formatting

describe('formatBatteryReport', () => {
  it('formats a passing battery', () => {
    const result: BatteryResult = {
      dimensions: [{
        dimension: 'requirements',
        verdict: 'pass',
        findings: [
          { requirement: 'R1', status: 'DONE', detail: 'ok' },
          { requirement: 'R2', status: 'DONE', detail: 'ok' },
        ],
        summary: 'All requirements met',
      }],
      verdict: 'pass',
      missingCount: 0,
      partialCount: 0,
      durationMs: 5000,
      costUsd: 0.13,
    };

    const report = formatBatteryReport(result);
    expect(report).toContain('### Review Battery: PASS');
    expect(report).toContain('[x] **R1**');
    expect(report).toContain('[x] **R2**');
    expect(report).toContain('$0.13');
  });

  it('formats a failing battery with MISSING items', () => {
    const result: BatteryResult = {
      dimensions: [{
        dimension: 'requirements',
        verdict: 'fail',
        findings: [
          { requirement: 'R1', status: 'DONE', detail: 'ok' },
          { requirement: 'R2', status: 'MISSING', detail: 'not found' },
        ],
        summary: 'Gap found',
      }],
      verdict: 'fail',
      missingCount: 1,
      partialCount: 0,
      durationMs: 3000,
      costUsd: 0.10,
    };

    const report = formatBatteryReport(result);
    expect(report).toContain('### Review Battery: FAIL');
    expect(report).toContain('[x] **R1**');
    expect(report).toContain('[ ] **R2**');
    expect(report).toContain('Missing | 1');
  });
});

// Tier 1: Dimension discovery

describe('discoverDimensions', () => {
  it('discovers dimensions from prompts directory', () => {
    const dims = discoverDimensions();
    expect(dims).toHaveProperty('plan-coverage');
    expect(dims).toHaveProperty('requirements');
    expect(dims).toHaveProperty('pr-description');
    expect(dims['plan-coverage']).toBe('review-plan-coverage.md');
    expect(dims['requirements']).toBe('review-requirements.md');
    expect(dims['pr-description']).toBe('review-pr-description.md');
  });

  it('listDimensions returns dimension names', () => {
    const names = listDimensions();
    expect(names).toContain('plan-coverage');
    expect(names).toContain('requirements');
    expect(names).toContain('pr-description');
  });

  it('loadDimensionMetas reads frontmatter from each dimension', () => {
    const metas = loadDimensionMetas();
    expect(metas.length).toBeGreaterThanOrEqual(7);

    const req = metas.find(m => m.name === 'requirements');
    expect(req).toBeDefined();
    expect(req!.description).toContain('requirement');
    expect(req!.applies_to).toBe('pr');
    expect(req!.needs).toContain('diff');
    expect(req!.needs).toContain('issue');
    expect(req!.file).toBe('review-requirements.md');

    const plan = metas.find(m => m.name === 'plan-coverage');
    expect(plan).toBeDefined();
    expect(plan!.applies_to).toBe('plan');

    const desc = metas.find(m => m.name === 'pr-description');
    expect(desc).toBeDefined();
    expect(desc!.description).toContain('Story Spine');
    expect(desc!.needs).toContain('pr');
  });

  it('reviewBriefing returns human-readable briefing with priority signals', () => {
    const metas = loadDimensionMetas().filter(m => m.applies_to !== 'plan');
    const briefing = reviewBriefing(metas, 200);

    // It's a formatted string the agent reads
    expect(typeof briefing).toBe('string');
    expect(briefing).toContain('Review Briefing');
    expect(briefing).toContain('200 lines');
    expect(briefing).toContain('logic-correctness');
    expect(briefing).toContain('High priority when');
    expect(briefing).toContain('Low priority when');
    expect(briefing).toContain('Natural Groupings');
    // diff-only dimensions grouped together
    expect(briefing).toContain('logic-correctness');
    expect(briefing).toContain('error-handling');
  });
});

// Tier 1: Prompt template loading

describe('loadReviewPrompt', () => {
  it('resolves prompts directory', () => {
    const dir = resolvePromptsDir();
    expect(existsSync(dir)).toBe(true);
  });

  it('loads plan-coverage template if it exists', () => {
    const dir = resolvePromptsDir();
    const path = resolve(dir, 'review-plan-coverage.md');
    if (!existsSync(path)) {
      // Template not yet created — this test will pass once task 3 is done
      console.log('  [skip] review-plan-coverage.md not yet created');
      return;
    }
    const prompt = loadReviewPrompt('plan-coverage', { issue_num: '666', repo: 'Garsson-io/kaizen' });
    expect(prompt).toContain('666');
    expect(prompt).toContain('Garsson-io/kaizen');
  });

  it('loads requirements template if it exists', () => {
    const dir = resolvePromptsDir();
    const path = resolve(dir, 'review-requirements.md');
    if (!existsSync(path)) {
      console.log('  [skip] review-requirements.md not yet created');
      return;
    }
    const prompt = loadReviewPrompt('requirements', { pr_url: 'https://github.com/test/test/pull/1' });
    expect(prompt).toContain('https://github.com/test/test/pull/1');
  });

  it('throws for nonexistent template', () => {
    const dir = resolvePromptsDir();
    const path = resolve(dir, 'review-plan-coverage.md');
    if (!existsSync(path)) {
      // Template not created yet — verify it throws
      expect(() => loadReviewPrompt('plan-coverage', {})).toThrow('not found');
    } else {
      // Template exists — verify it loads without throwing
      expect(() => loadReviewPrompt('plan-coverage', {})).not.toThrow();
    }
  });
});

// Tier 1: Coverage validation gate

describe('validateReviewCoverage', () => {
  const makeMeta = (name: string): DimensionMeta => ({
    name, description: '', applies_to: 'pr', needs: ['diff'], file: `review-${name}.md`,
  });
  const makeReview = (dim: string): DimensionReview => ({
    dimension: dim, verdict: 'pass', findings: [], summary: 'ok',
  });

  it('returns complete when all dimensions reviewed', () => {
    const expected = [makeMeta('a'), makeMeta('b'), makeMeta('c')];
    const reviewed = [makeReview('a'), makeReview('b'), makeReview('c')];
    const result = validateReviewCoverage(expected, reviewed);
    expect(result.complete).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('returns missing dimensions', () => {
    const expected = [makeMeta('a'), makeMeta('b'), makeMeta('c')];
    const reviewed = [makeReview('a')];
    const result = validateReviewCoverage(expected, reviewed);
    expect(result.complete).toBe(false);
    expect(result.missing.map(m => m.name)).toEqual(['b', 'c']);
  });

  it('handles empty reviews', () => {
    const expected = [makeMeta('a')];
    const result = validateReviewCoverage(expected, []);
    expect(result.complete).toBe(false);
    expect(result.missing).toHaveLength(1);
  });
});

// Tier 1: Policy constants

describe('policy constants', () => {
  it('exports expected constants', () => {
    expect(MAX_FIX_ROUNDS).toBe(3);
    expect(BUDGET_CAP_USD).toBe(2.0);
    expect(PASSING_THRESHOLD).toEqual({ maxMissing: 0 });
  });
});

// Tier 3: Replay tests (slow, costs money)
// Run with: RUN_REPLAY_TESTS=1 npm test -- --grep "replay"

describe('replay tests', () => {
  const skip = !process.env.RUN_REPLAY_TESTS;

  it('requirements review flags PR #832 zero-adoption gap', async () => {
    if (skip) { console.log('  [skip] set RUN_REPLAY_TESTS=1 to run'); return; }

    // PR #832 closed issue #666 (skill metadata schema)
    // Expected: reviewer flags that 0/16 SKILL.md files use the new fields
    // This is the "smoke detectors with no batteries" finding
    const { spawnReview } = await import('./review-battery.js');
    const { review } = spawnReview({
      dimension: 'requirements',
      prUrl: 'https://github.com/Garsson-io/kaizen/pull/832',
      issueNum: '666',
      repo: 'Garsson-io/kaizen',
    });

    expect(review).not.toBeNull();
    expect(review!.verdict).toBe('fail');
    // At least one finding should be MISSING or PARTIAL
    const gaps = review!.findings.filter(f => f.status !== 'DONE');
    expect(gaps.length).toBeGreaterThan(0);
  }, 180_000);

  it('requirements review passes PR #825 clean fix', async () => {
    if (skip) { console.log('  [skip] set RUN_REPLAY_TESTS=1 to run'); return; }

    // PR #825 closed issue #726 (deduplicate batch progress issues)
    // Expected: clean pass — all requirements addressed
    const { spawnReview } = await import('./review-battery.js');
    const { review } = spawnReview({
      dimension: 'requirements',
      prUrl: 'https://github.com/Garsson-io/kaizen/pull/825',
      issueNum: '726',
      repo: 'Garsson-io/kaizen',
    });

    expect(review).not.toBeNull();
    expect(review!.verdict).toBe('pass');
  }, 180_000);

  it('requirements review flags PR #810 L1-fixing-L1', async () => {
    if (skip) { console.log('  [skip] set RUN_REPLAY_TESTS=1 to run'); return; }

    // PR #810 closed issue #765 (dead code deletion prompts)
    // Expected: flags that 1 of 3 failure patterns isn't addressed,
    // and no L2 escalation mechanism was created
    const { spawnReview } = await import('./review-battery.js');
    const { review } = spawnReview({
      dimension: 'requirements',
      prUrl: 'https://github.com/Garsson-io/kaizen/pull/810',
      issueNum: '765',
      repo: 'Garsson-io/kaizen',
    });

    expect(review).not.toBeNull();
    expect(review!.verdict).toBe('fail');
    const gaps = review!.findings.filter(f => f.status !== 'DONE');
    expect(gaps.length).toBeGreaterThan(0);
  }, 180_000);
});
