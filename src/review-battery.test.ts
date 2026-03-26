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

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseReviewOutput,
  formatBatteryReport,
  loadReviewPrompt,
  resolvePromptsDir,
  discoverDimensions,
  listDimensions,
  listPrDimensions,
  loadDimensionMetas,
  reviewBriefing,
  validateReviewCoverage,
  renderTemplate,
  computeDataOverlap,
  spawnReview,
  reviewBattery,
  spawnBatchReview,
  parseAllReviewOutputs,
  groupByDataNeeds,
  parseFrontmatter,
  MAX_FIX_ROUNDS,
  BUDGET_CAP_USD,
  PASSING_THRESHOLD,
  type DimensionReview,
  type DimensionMeta,
  type BatteryResult,
  type ReviewDimension,
} from './review-battery.js';
import { spawnSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// vi.mock is hoisted by vitest so it runs before imports — this is the correct
// ESM-compatible way to intercept spawnSync/spawn in tests.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync), spawn: vi.fn(actual.spawn) };
});

// Shared test helpers — module-level to avoid copy-paste across describe blocks

/** Build a stream-json JSONL payload as claude emits with --output-format stream-json --verbose. */
function streamJsonPayload(text: string, costUsd: number): string {
  const assistant = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: costUsd });
  return `${assistant}\n${result}\n`;
}

/** Build a minimal DimensionMeta for unit tests. */
function makeMeta(name: string, needs: string[] = ['diff']): DimensionMeta {
  return { name, description: '', applies_to: 'pr', needs: needs as any, high_when: [], low_when: [], file: `review-${name}.md` };
}

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
      failedDimensions: [],
      skippedDimensions: [],
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
      failedDimensions: [],
      skippedDimensions: [],
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

  it('listPrDimensions excludes plan-coverage and includes all other dimensions', () => {
    const all = listDimensions();
    const pr = listPrDimensions();
    expect(pr).not.toContain('plan-coverage');
    for (const name of all) {
      if (name !== 'plan-coverage') {
        expect(pr).toContain(name);
      }
    }
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

  it('strips YAML frontmatter from rendered prompt', () => {
    // Invariant: the rendered prompt must NOT contain frontmatter fields.
    // If frontmatter is sent to the LLM, haiku treats the prompt as a document
    // specification ("you've shared the scope-fidelity dimension") and refuses
    // to execute the review, asking for clarification instead.
    const dir = resolvePromptsDir();
    const path = resolve(dir, 'review-requirements.md');
    if (!existsSync(path)) {
      console.log('  [skip] review-requirements.md not yet created');
      return;
    }
    const prompt = loadReviewPrompt('requirements', {});
    expect(prompt.startsWith('---'), 'Prompt must not start with YAML frontmatter').toBe(false);
    expect(prompt).not.toMatch(/^name:\s+\w/m);
    expect(prompt).not.toMatch(/^needs:\s+\[/m);
    expect(prompt).not.toMatch(/^applies_to:\s+/m);
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

// Tier 1: renderTemplate

describe('renderTemplate', () => {
  it('substitutes simple variables', () => {
    const result = renderTemplate('Hello {{name}}, repo: {{repo}}', { name: 'world', repo: 'a/b' });
    expect(result).toBe('Hello world, repo: a/b');
  });

  it('includes conditional block when var is set', () => {
    const result = renderTemplate('prefix\n{{#guidance}}guided: {{guidance}}{{/guidance}}\nsuffix', { guidance: 'focus' });
    expect(result).toContain('guided: focus');
    expect(result).toContain('prefix');
    expect(result).toContain('suffix');
  });

  it('omits conditional block when var is missing or empty', () => {
    const result = renderTemplate('prefix\n{{#guidance}}guided: {{guidance}}{{/guidance}}\nsuffix', { guidance: '' });
    expect(result).not.toContain('guided');
    expect(result).toContain('prefix');
    expect(result).toContain('suffix');
  });

  it('leaves unknown variables as-is', () => {
    const result = renderTemplate('{{unknown}}', {});
    expect(result).toBe('{{unknown}}');
  });

  it('collapses multiple blank lines from removed conditionals', () => {
    const template = 'a\n\n{{#x}}x content{{/x}}\n\n\n\nb';
    const result = renderTemplate(template, {});
    expect(result).not.toMatch(/\n{3,}/);
    expect(result).toContain('a');
    expect(result).toContain('b');
  });

  it('trims leading and trailing whitespace', () => {
    const result = renderTemplate('  \n  hello  \n  ', {});
    expect(result).toBe('hello');
  });
});

// Tier 1: computeDataOverlap

describe('computeDataOverlap', () => {
  it('returns empty array for no metas', () => {
    expect(computeDataOverlap([])).toEqual([]);
  });

  it('groups dimensions with identical needs', () => {
    const metas = [
      makeMeta('a', ['diff', 'issue']),
      makeMeta('b', ['diff', 'issue']),
      makeMeta('c', ['diff']),
    ];
    const groups = computeDataOverlap(metas);
    const ab = groups.find(g => g.dimensions.includes('a'));
    expect(ab).toBeDefined();
    expect(ab!.dimensions).toContain('b');
    expect(ab!.dimensions).not.toContain('c');
    const cOnly = groups.find(g => g.dimensions.includes('c'));
    expect(cOnly!.dimensions).toHaveLength(1);
  });

  it('needs order does not affect grouping', () => {
    const metas = [
      makeMeta('x', ['issue', 'diff']),
      makeMeta('y', ['diff', 'issue']),
    ];
    const groups = computeDataOverlap(metas);
    expect(groups).toHaveLength(1);
    expect(groups[0].dimensions).toContain('x');
    expect(groups[0].dimensions).toContain('y');
  });

  it('each dimension with unique needs forms its own group', () => {
    const metas = [
      makeMeta('a', ['diff']),
      makeMeta('b', ['issue']),
      makeMeta('c', ['pr']),
    ];
    const groups = computeDataOverlap(metas);
    expect(groups).toHaveLength(3);
  });
});

// Tier 1: spawnReview (mocked claude subprocess)
//
// vi.mock hoists the node:child_process mock, wrapping spawnSync in vi.fn().
// In tests, we override mockImplementation per-test:
//   - git calls return empty stdout → resolvePromptsDir falls back to import.meta.url path
//   - claude calls return the desired mock response

describe('spawnReview', () => {
  afterEach(() => {
    vi.mocked(spawnSync).mockRestore();
    vi.mocked(spawn).mockRestore();
  });

  function mockClaude(stdout: string, exitCode = 0) {
    vi.mocked(spawnSync).mockImplementation((cmd: string) => {
      if (cmd === 'git') return { status: 0, stdout: '', stderr: '', signal: null, pid: 0, output: [] } as any;
      return { status: 0, stdout: '', stderr: '', signal: null, pid: 0, output: [] } as any;
    });
    vi.mocked(spawn).mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdin = { write: () => {}, end: () => {} };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from(stdout));
        proc.emit('close', exitCode);
      });
      return proc;
    });
  }

  it('returns parsed review when claude exits 0 with valid JSON', async () => {
    const text = JSON.stringify({
      dimension: 'requirements',
      summary: 'all good',
      findings: [{ requirement: 'R1', status: 'DONE', detail: 'ok' }],
    });
    mockClaude(streamJsonPayload(text, 0.12));

    const { review, costUsd } = await spawnReview({ dimension: 'requirements', prUrl: 'https://github.com/test/test/pull/1', repo: 'test/test' });
    expect(review).not.toBeNull();
    expect(review!.verdict).toBe('pass');
    expect(review!.findings[0].status).toBe('DONE');
    expect(costUsd).toBeCloseTo(0.12);
  });

  it('returns null review when claude exits non-zero', async () => {
    mockClaude('', 1);
    const { review, costUsd } = await spawnReview({ dimension: 'requirements', repo: 'test/test' });
    expect(review).toBeNull();
    expect(costUsd).toBe(0);
  });

  it('returns review when text contains prose with embedded JSON', async () => {
    const text = `Here is my review:\n{"dimension":"requirements","summary":"gap","findings":[{"requirement":"R1","status":"MISSING","detail":"not done"}]}\nDone.`;
    mockClaude(streamJsonPayload(text, 0.08));

    const { review } = await spawnReview({ dimension: 'requirements', repo: 'test/test' });
    expect(review).not.toBeNull();
    expect(review!.verdict).toBe('fail');
  });

  it('returns null review when output is unparseable', async () => {
    mockClaude(streamJsonPayload('not json at all', 0));
    const { review } = await spawnReview({ dimension: 'requirements', repo: 'test/test' });
    expect(review).toBeNull();
  });

  it('extracts total_cost_usd from result message', async () => {
    const text = '{"dimension":"d","summary":"ok","findings":[]}';
    mockClaude(streamJsonPayload(text, 0.05));
    const { costUsd } = await spawnReview({ dimension: 'requirements', repo: 'test/test' });
    expect(costUsd).toBeCloseTo(0.05);
  });
});

// Tier 1: reviewBattery (mocked spawnReview)

describe('reviewBattery', () => {
  afterEach(() => {
    vi.mocked(spawnSync).mockRestore();
    vi.mocked(spawn).mockRestore();
  });

  function mockClaude(responses: Array<{ stdout: string; exitCode?: number }>) {
    vi.mocked(spawnSync).mockImplementation((cmd: string) => {
      if (cmd === 'git') return { status: 0, stdout: '', stderr: '', signal: null, pid: 0, output: [] } as any;
      return { status: 0, stdout: '', stderr: '', signal: null, pid: 0, output: [] } as any;
    });
    let callCount = 0;
    vi.mocked(spawn).mockImplementation(() => {
      const resp = responses[callCount] ?? responses[responses.length - 1];
      callCount++;
      const { stdout, exitCode = 0 } = resp;
      const proc = new EventEmitter() as any;
      proc.stdin = { write: () => {}, end: () => {} };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from(stdout));
        proc.emit('close', exitCode);
      });
      return proc;
    });
  }

  const passingOutput = streamJsonPayload(
    JSON.stringify({ dimension: 'requirements', summary: 'ok', findings: [{ requirement: 'R1', status: 'DONE', detail: 'ok' }] }),
    0.10,
  );

  const failingOutput = streamJsonPayload(
    JSON.stringify({ dimension: 'test-quality', summary: 'gap', findings: [{ requirement: 'R1', status: 'MISSING', detail: 'no tests' }] }),
    0.08,
  );

  it('returns pass when all dimensions pass', async () => {
    mockClaude([{ stdout: passingOutput }, { stdout: passingOutput }]);
    const result = await reviewBattery({ dimensions: ['requirements', 'test-quality'] });
    expect(result.verdict).toBe('pass');
    expect(result.missingCount).toBe(0);
    expect(result.dimensions).toHaveLength(2);
  });

  it('returns fail when any dimension has MISSING finding', async () => {
    mockClaude([{ stdout: passingOutput }, { stdout: failingOutput }]);
    const result = await reviewBattery({ dimensions: ['requirements', 'test-quality'] });
    expect(result.verdict).toBe('fail');
    expect(result.missingCount).toBe(1);
  });

  it('returns fail when some reviews fail (null results excluded from dimensions)', async () => {
    mockClaude([{ stdout: passingOutput }, { stdout: '', exitCode: 1 }]);
    const result = await reviewBattery({ dimensions: ['requirements', 'test-quality'] });
    expect(result.verdict).toBe('fail');
    expect(result.dimensions).toHaveLength(1); // failed review excluded
  });

  it('sums costs across all dimensions', async () => {
    mockClaude([{ stdout: passingOutput }, { stdout: failingOutput }]);
    const result = await reviewBattery({ dimensions: ['requirements', 'test-quality'] });
    expect(result.costUsd).toBeCloseTo(0.18);
  });

  it('counts partialCount correctly', async () => {
    const partialOutput = streamJsonPayload(
      JSON.stringify({ dimension: 'requirements', summary: 'partial', findings: [
        { requirement: 'R1', status: 'DONE', detail: 'ok' },
        { requirement: 'R2', status: 'PARTIAL', detail: 'half done' },
      ]}),
      0.09,
    );
    mockClaude([{ stdout: partialOutput }]);
    const result = await reviewBattery({ dimensions: ['requirements'] });
    expect(result.partialCount).toBe(1);
    expect(result.missingCount).toBe(0);
  });
});

// Tier 1: parseAllReviewOutputs (pure)

describe('parseAllReviewOutputs', () => {
  it('parses multiple json blocks from a batch response', () => {
    const raw = `
First dimension:
\`\`\`json
{"dimension":"requirements","summary":"ok","findings":[{"requirement":"R1","status":"DONE","detail":"ok"}]}
\`\`\`

Second dimension:
\`\`\`json
{"dimension":"test-quality","summary":"gap","findings":[{"requirement":"T1","status":"MISSING","detail":"no tests"}]}
\`\`\`
`;
    const results = parseAllReviewOutputs(raw, ['requirements', 'test-quality']);
    expect(results).toHaveLength(2);
    expect(results.find(r => r.dimension === 'requirements')).toBeTruthy();
    expect(results.find(r => r.dimension === 'test-quality')).toBeTruthy();
  });

  it('returns empty array for unparseable input', () => {
    expect(parseAllReviewOutputs('just prose, no json blocks', [])).toEqual([]);
    expect(parseAllReviewOutputs('', [])).toEqual([]);
  });

  it('skips blocks without findings array', () => {
    const raw = `\`\`\`json\n{"not": "a review"}\n\`\`\`\n\`\`\`json\n{"dimension":"d","summary":"ok","findings":[]}\n\`\`\``;
    const results = parseAllReviewOutputs(raw, ['d']);
    expect(results).toHaveLength(1);
    expect(results[0].dimension).toBe('d');
  });

  it('skips blocks with no dimension field', () => {
    const raw = `\`\`\`json\n{"summary":"ok","findings":[{"requirement":"R","status":"DONE","detail":"ok"}]}\n\`\`\``;
    const results = parseAllReviewOutputs(raw, []);
    expect(results).toHaveLength(0);
  });

  it('handles partial output — returns what parsed successfully', () => {
    const raw = `
\`\`\`json
{"dimension":"requirements","summary":"ok","findings":[{"requirement":"R1","status":"DONE","detail":"ok"}]}
\`\`\`

\`\`\`json
{broken json
\`\`\`
`;
    const results = parseAllReviewOutputs(raw, ['requirements']);
    expect(results).toHaveLength(1);
    expect(results[0].dimension).toBe('requirements');
  });
});

// Tier 1: groupByDataNeeds (pure)

describe('groupByDataNeeds', () => {
  it('groups dims with identical data needs together', () => {
    const metas = [
      makeMeta('error-handling', ['diff']),
      makeMeta('logic-correctness', ['diff']),
      makeMeta('requirements', ['diff', 'issue']),
    ];
    const groups = groupByDataNeeds(['error-handling', 'logic-correctness', 'requirements'], metas);
    expect(groups).toHaveLength(2);
    const diffGroup = groups.find(g => g.includes('error-handling'));
    expect(diffGroup).toContain('logic-correctness');
    expect(diffGroup).not.toContain('requirements');
  });

  it('unknown dims (not in metas) are never batched together', () => {
    const metas: DimensionMeta[] = [];
    const groups = groupByDataNeeds(['unknown-a', 'unknown-b'], metas);
    expect(groups).toHaveLength(2); // each gets its own group
  });

  it('single dim produces single-element group', () => {
    const metas = [makeMeta('dry', ['diff', 'codebase'])];
    const groups = groupByDataNeeds(['dry'], metas);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual(['dry']);
  });

  it('preserves order within each group', () => {
    const metas = [
      makeMeta('a', ['diff']),
      makeMeta('b', ['diff']),
      makeMeta('c', ['diff']),
    ];
    const groups = groupByDataNeeds(['a', 'b', 'c'], metas);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual(['a', 'b', 'c']);
  });
});

// Tier 1: spawnBatchReview (mocked spawn)

describe('spawnBatchReview', () => {
  afterEach(() => {
    vi.mocked(spawnSync).mockRestore();
    vi.mocked(spawn).mockRestore();
  });

  function mockClaudeOnce(stdout: string, exitCode = 0) {
    vi.mocked(spawnSync).mockImplementation((cmd: string) => {
      if (cmd === 'git') return { status: 0, stdout: '', stderr: '', signal: null, pid: 0, output: [] } as any;
      return { status: 0, stdout: '', stderr: '', signal: null, pid: 0, output: [] } as any;
    });
    vi.mocked(spawn).mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdin = { write: () => {}, end: () => {} };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from(stdout));
        proc.emit('close', exitCode);
      });
      return proc;
    });
  }

  function batchPayload(reviews: Array<{ dim: string; verdict: string; findings: any[] }>, costUsd: number): string {
    const blocks = reviews.map(r =>
      `\`\`\`json\n${JSON.stringify({ dimension: r.dim, summary: 'ok', findings: r.findings })}\n\`\`\``,
    ).join('\n\n');
    const assistantLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: blocks }] } });
    const resultLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: costUsd });
    return `${assistantLine}\n${resultLine}\n`;
  }

  it('returns parsed reviews for each requested dimension', async () => {
    const payload = batchPayload([
      { dim: 'error-handling', verdict: 'pass', findings: [{ requirement: 'R1', status: 'DONE', detail: 'ok' }] },
      { dim: 'logic-correctness', verdict: 'pass', findings: [{ requirement: 'R2', status: 'DONE', detail: 'ok' }] },
    ], 0.15);
    mockClaudeOnce(payload);

    const results = await spawnBatchReview({ dimensions: ['error-handling', 'logic-correctness'], repo: 'test/test' });
    expect(results).toHaveLength(2);
    expect(results[0].review?.dimension).toBe('error-handling');
    expect(results[1].review?.dimension).toBe('logic-correctness');
  });

  it('returns null for dimensions missing from the batch response', async () => {
    const payload = batchPayload([
      { dim: 'error-handling', verdict: 'pass', findings: [{ requirement: 'R1', status: 'DONE', detail: 'ok' }] },
    ], 0.10); // only one dim returned
    mockClaudeOnce(payload);

    const results = await spawnBatchReview({ dimensions: ['error-handling', 'logic-correctness'], repo: 'test/test' });
    expect(results[0].review).not.toBeNull();
    expect(results[1].review).toBeNull(); // logic-correctness missing from response
  });

  it('splits cost evenly across dimensions', async () => {
    const payload = batchPayload([
      { dim: 'error-handling', verdict: 'pass', findings: [] },
      { dim: 'logic-correctness', verdict: 'pass', findings: [] },
    ], 0.20);
    mockClaudeOnce(payload);

    const results = await spawnBatchReview({ dimensions: ['error-handling', 'logic-correctness'], repo: 'test/test' });
    expect(results[0].costUsd).toBeCloseTo(0.10);
    expect(results[1].costUsd).toBeCloseTo(0.10);
  });

  it('returns all nulls when claude fails', async () => {
    mockClaudeOnce('', 1);
    const results = await spawnBatchReview({ dimensions: ['error-handling', 'logic-correctness'], repo: 'test/test' });
    expect(results[0].review).toBeNull();
    expect(results[1].review).toBeNull();
  });

  it('uses a single claude call regardless of dimension count', async () => {
    const payload = batchPayload([
      { dim: 'error-handling', verdict: 'pass', findings: [] },
      { dim: 'logic-correctness', verdict: 'pass', findings: [] },
    ], 0.10);
    mockClaudeOnce(payload);

    await spawnBatchReview({ dimensions: ['error-handling', 'logic-correctness'], repo: 'test/test' });
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });
});

// Tier 1: reviewBattery — failedDimensions, skippedDimensions, batching

describe('reviewBattery — failure surfacing and skipping', () => {
  afterEach(() => {
    vi.mocked(spawnSync).mockRestore();
    vi.mocked(spawn).mockRestore();
  });

  function mockClaudeSequential(responses: Array<{ stdout: string; exitCode?: number }>) {
    vi.mocked(spawnSync).mockImplementation((cmd: string) => {
      if (cmd === 'git') return { status: 0, stdout: '', stderr: '', signal: null, pid: 0, output: [] } as any;
      return { status: 0, stdout: '', stderr: '', signal: null, pid: 0, output: [] } as any;
    });
    let callCount = 0;
    vi.mocked(spawn).mockImplementation(() => {
      const resp = responses[callCount] ?? responses[responses.length - 1];
      callCount++;
      const proc = new EventEmitter() as any;
      proc.stdin = { write: () => {}, end: () => {} };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from(resp.stdout));
        proc.emit('close', resp.exitCode ?? 0);
      });
      return proc;
    });
  }

  it('populates failedDimensions when a dim returns null', async () => {
    const passingOutput = streamJsonPayload(
      JSON.stringify({ dimension: 'requirements', summary: 'ok', findings: [{ requirement: 'R', status: 'DONE', detail: '' }] }),
      0.10,
    );
    mockClaudeSequential([{ stdout: passingOutput }, { stdout: '', exitCode: 1 }]);
    const result = await reviewBattery({ dimensions: ['requirements', 'test-quality'] });
    expect(result.failedDimensions).toContain('test-quality');
    expect(result.failedDimensions).not.toContain('requirements');
  });

  it('failedDimensions is empty when all dims succeed', async () => {
    const passingOutput = streamJsonPayload(
      JSON.stringify({ dimension: 'requirements', summary: 'ok', findings: [] }),
      0.10,
    );
    mockClaudeSequential([{ stdout: passingOutput }, { stdout: passingOutput }]);
    const result = await reviewBattery({ dimensions: ['requirements', 'test-quality'] });
    expect(result.failedDimensions).toHaveLength(0);
  });

  it('auto-skips plan-requiring dims when no planText provided', async () => {
    const passingOutput = streamJsonPayload(
      JSON.stringify({ dimension: 'requirements', summary: 'ok', findings: [] }),
      0.10,
    );
    mockClaudeSequential([{ stdout: passingOutput }]);
    const result = await reviewBattery({
      dimensions: ['requirements', 'plan-coverage', 'plan-fidelity', 'improvement-lifecycle'],
    });
    expect(result.skippedDimensions).toContain('plan-coverage');
    expect(result.skippedDimensions).toContain('plan-fidelity');
    expect(result.skippedDimensions).toContain('improvement-lifecycle');
    expect(result.skippedDimensions).not.toContain('requirements');
  });

  it('includes plan-requiring dims when planText is provided', async () => {
    const passingOutput = streamJsonPayload(
      JSON.stringify({ dimension: 'requirements', summary: 'ok', findings: [] }),
      0.10,
    );
    mockClaudeSequential([{ stdout: passingOutput }, { stdout: passingOutput }]);
    const result = await reviewBattery({
      dimensions: ['requirements', 'plan-fidelity'],
      planText: 'my plan',
    });
    expect(result.skippedDimensions).toHaveLength(0);
  });

  it('batches same-needs dims into fewer claude calls', async () => {
    // error-handling and logic-correctness both need [diff] — should be one call
    const batchOutput = streamJsonPayload(
      [
        '```json\n' + JSON.stringify({ dimension: 'error-handling', summary: 'ok', findings: [] }) + '\n```',
        '```json\n' + JSON.stringify({ dimension: 'logic-correctness', summary: 'ok', findings: [] }) + '\n```',
      ].join('\n\n'),
      0.15,
    );
    mockClaudeSequential([{ stdout: batchOutput }]);
    await reviewBattery({ dimensions: ['error-handling', 'logic-correctness'] });
    // Both dims share [diff] needs → batched into 1 spawn call
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
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
    const { review } = await spawnReview({
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
    const { review } = await spawnReview({
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
    const { review } = await spawnReview({
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

  it('scope-fidelity flags PR #816 scope reduction (disabled sentinel instead of fixing root cause)', async () => {
    if (skip) { console.log('  [skip] set RUN_REPLAY_TESTS=1 to run'); return; }

    // PR #816 / issue #814 (CI tests timing out)
    // Issue explicitly said "fix the underlying slowness rather than increasing the timeout."
    // PR disabled the timing sentinel. Scope-fidelity should catch this.
    const { spawnReview } = await import('./review-battery.js');
    const { review } = await spawnReview({
      dimension: 'scope-fidelity',
      prUrl: 'https://github.com/Garsson-io/kaizen/pull/816',
      issueNum: '814',
      repo: 'Garsson-io/kaizen',
    });

    expect(review).not.toBeNull();
    expect(review!.verdict).toBe('fail');
    const gaps = review!.findings.filter(f => f.status !== 'DONE');
    expect(gaps.length).toBeGreaterThan(0);
  }, 180_000);

  it('scope-fidelity passes PR #825 clean implementation', async () => {
    if (skip) { console.log('  [skip] set RUN_REPLAY_TESTS=1 to run'); return; }

    // PR #825 / issue #726 (deduplicate batch progress issues)
    // Expected: clean implementation, scope matches issue
    const { spawnReview } = await import('./review-battery.js');
    const { review } = await spawnReview({
      dimension: 'scope-fidelity',
      prUrl: 'https://github.com/Garsson-io/kaizen/pull/825',
      issueNum: '726',
      repo: 'Garsson-io/kaizen',
    });

    expect(review).not.toBeNull();
    expect(review!.verdict).toBe('pass');
  }, 180_000);

  it('pr-description flags PR #810 missing narrative arc', async () => {
    if (skip) { console.log('  [skip] set RUN_REPLAY_TESTS=1 to run'); return; }

    // PR #810 / issue #765 — pre-Story Spine era, likely a feature list not a narrative.
    // pr-description should catch weak "Once upon a time / Because of that" structure.
    const { spawnReview } = await import('./review-battery.js');
    const { review } = await spawnReview({
      dimension: 'pr-description',
      prUrl: 'https://github.com/Garsson-io/kaizen/pull/810',
      issueNum: '765',
      repo: 'Garsson-io/kaizen',
    });

    expect(review).not.toBeNull();
    // Pre-Story Spine PRs should score PARTIAL or fail on narrative quality
    const gaps = review!.findings.filter(f => f.status !== 'DONE');
    expect(gaps.length).toBeGreaterThan(0);
  }, 180_000);

  it('test-quality flags PR #832 zero-adoption gap in tests', async () => {
    if (skip) { console.log('  [skip] set RUN_REPLAY_TESTS=1 to run'); return; }

    // PR #832 / issue #666 (skill metadata schema)
    // Tests exist for the TypeScript interface but no test verifies that
    // existing SKILL.md files are updated to use the schema.
    const { spawnReview } = await import('./review-battery.js');
    const { review } = await spawnReview({
      dimension: 'test-quality',
      prUrl: 'https://github.com/Garsson-io/kaizen/pull/832',
      issueNum: '666',
      repo: 'Garsson-io/kaizen',
    });

    expect(review).not.toBeNull();
    const gaps = review!.findings.filter(f => f.status !== 'DONE');
    expect(gaps.length).toBeGreaterThan(0);
  }, 180_000);

  // TODO: Add replay cases for these dimensions once motivating PRs are identified:
  // - plan-coverage: needs a PR where plan review was run (requires plan in issue comment)
  // - plan-fidelity: needs a PR that diverged from its plan
  // - logic-correctness: needs a PR with a confirmed logic bug that was caught
  // - error-handling: needs a PR with swallowed exceptions or missing error paths
  // - dry: needs a PR with confirmed duplication
  // - test-plan: needs a PR with wrong testing strategy (e.g. unit tests for something needing E2E)
  // - improvement-lifecycle: use PR #846 itself (the review battery PR)
});

// ── Tier 1: Structural tests for all prompt files ────────────────────
//
// Zero cost — no subprocess. Verifies every prompts/review-*.md file
// has the required frontmatter fields, correct name/filename alignment,
// and a valid applies_to value. These are the cheapest possible guard
// against schema drift in prompt files.

describe('Tier 1 — prompt file structure (all dimensions)', () => {
  const promptsDir = resolvePromptsDir();
  const validAppliesTo = new Set(['pr', 'plan', 'both']);

  const dimensions = [
    'dry', 'error-handling', 'improvement-lifecycle', 'logic-correctness',
    'plan-coverage', 'plan-fidelity', 'pr-description', 'requirements',
    'scope-fidelity', 'test-plan', 'test-quality',
  ];

  for (const dim of dimensions) {
    const filePath = resolve(promptsDir, `review-${dim}.md`);

    it(`review-${dim}.md exists`, () => {
      expect(existsSync(filePath), `${filePath} not found`).toBe(true);
    });

    it(`review-${dim}.md has parseable frontmatter`, () => {
      const content = readFileSync(filePath, 'utf8');
      const fm = parseFrontmatter(content) as Record<string, string> | null;
      expect(fm, `Could not parse frontmatter in review-${dim}.md`).not.toBeNull();
    });

    it(`review-${dim}.md frontmatter name matches filename`, () => {
      const content = readFileSync(filePath, 'utf8');
      const fm = parseFrontmatter(content) as Record<string, string>;
      expect(fm.name, `name field in review-${dim}.md should be "${dim}"`).toBe(dim);
    });

    it(`review-${dim}.md has non-empty description`, () => {
      const content = readFileSync(filePath, 'utf8');
      const fm = parseFrontmatter(content) as Record<string, string>;
      expect(fm.description, `description missing in review-${dim}.md`).toBeTruthy();
    });

    it(`review-${dim}.md applies_to is valid`, () => {
      const content = readFileSync(filePath, 'utf8');
      const fm = parseFrontmatter(content) as Record<string, string>;
      expect(
        validAppliesTo.has(fm.applies_to),
        `applies_to in review-${dim}.md is "${fm.applies_to}", must be pr|plan|both`,
      ).toBe(true);
    });

    it(`review-${dim}.md has non-empty body`, () => {
      const content = readFileSync(filePath, 'utf8');
      const bodyStart = content.indexOf('---', 3);
      const body = bodyStart !== -1 ? content.slice(bodyStart + 3).trim() : '';
      expect(body.length, `body in review-${dim}.md is empty`).toBeGreaterThan(50);
    });
  }
});

// ── Tier 0: Category-prevention for parseReviewOutput edge cases ──────
//
// These tests ensure the parser does not crash on malformed or unexpected
// LLM output — a real risk since LLM output shape can vary.

describe('parseReviewOutput — category prevention for edge cases', () => {
  it('findings entry with neither requirement nor item uses empty string, does not crash', () => {
    const raw = JSON.stringify({
      dimension: 'test',
      summary: 'ok',
      findings: [{ status: 'DONE', detail: 'done' }],
    });
    const result = parseReviewOutput(raw, 'test');
    expect(result).not.toBeNull();
    expect(result!.findings[0].requirement).toBe('');
  });

  it('unknown dimension field falls back to the passed-in dimension param', () => {
    const raw = JSON.stringify({
      dimension: 'some-unknown-value',
      summary: 'ok',
      findings: [{ requirement: 'R', status: 'DONE', detail: 'd' }],
    });
    // dimension field is preserved as-is from parsed output (whatever the LLM returned)
    const result = parseReviewOutput(raw, 'fallback-dim');
    expect(result).not.toBeNull();
    expect(result!.dimension).toBe('some-unknown-value');
  });

  it('valid JSON but completely wrong shape (no findings) returns null', () => {
    const raw = JSON.stringify({ type: 'assistant', message: 'hello' });
    expect(parseReviewOutput(raw, 'test')).toBeNull();
  });

  it('findings is not an array returns null', () => {
    const raw = JSON.stringify({ dimension: 'test', findings: 'not an array' });
    expect(parseReviewOutput(raw, 'test')).toBeNull();
  });

  it('finding with item field (alternative name) normalizes to requirement', () => {
    const raw = JSON.stringify({
      dimension: 'test',
      summary: '',
      findings: [{ item: 'Alternative field', status: 'PARTIAL', detail: 'partial' }],
    });
    const result = parseReviewOutput(raw, 'test');
    expect(result!.findings[0].requirement).toBe('Alternative field');
  });

  it('finding with description field (alternative name) normalizes to detail', () => {
    const raw = JSON.stringify({
      dimension: 'test',
      summary: '',
      findings: [{ requirement: 'R', status: 'DONE', description: 'alt detail' }],
    });
    const result = parseReviewOutput(raw, 'test');
    expect(result!.findings[0].detail).toBe('alt detail');
  });
});
