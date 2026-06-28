import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  normalizeFindingStatus,
  deriveVerdictFromFindings,
  normalizeReviewFindingData,
  makeReviewFindingMeta,
  extractReviewFindingMeta,
  validateReviewFindingPayload,
  deriveRoundVerdict,
  summarizeRound,
  assertsPass,
} from './review-finding-contract.js';

describe('review-finding-contract', () => {
  it('normalizes canonical and alias statuses', () => {
    expect(normalizeFindingStatus('DONE')).toBe('DONE');
    expect(normalizeFindingStatus('pass')).toBe('DONE');
    expect(normalizeFindingStatus('COMPLETE')).toBe('DONE');
    expect(normalizeFindingStatus('PARTIALLY')).toBe('PARTIAL');
    expect(normalizeFindingStatus('NOT_ADDRESSED')).toBe('MISSING');
  });

  it('derives verdict from findings', () => {
    expect(deriveVerdictFromFindings([{ status: 'DONE' }, { status: 'DONE' }])).toBe('pass');
    expect(deriveVerdictFromFindings([{ status: 'DONE' }, { status: 'PARTIAL' }])).toBe('fail');
    expect(deriveVerdictFromFindings([{ status: 'MISSING' }])).toBe('fail');
  });

  it('normalizes legacy payloads with default dimension', () => {
    const finding = normalizeReviewFindingData(
      { status: 'pass', text: 'legacy', findings: [{ item: 'R1', status: 'COMPLETE', description: 'ok' }] },
      { defaultDimension: 'self-review' },
    );
    expect(finding.dimension).toBe('self-review');
    expect(finding.verdict).toBe('pass');
    expect(finding.findings[0]).toEqual({ requirement: 'R1', status: 'DONE', detail: 'ok' });
  });

  it('writes and reads review meta consistently', () => {
    const meta = makeReviewFindingMeta(2, {
      dimension: 'correctness',
      verdict: 'fail',
      summary: 'gap',
      findings: [
        { requirement: 'R1', status: 'DONE', detail: 'ok' },
        { requirement: 'R2', status: 'MISSING', detail: 'missing' },
      ],
    });
    const content = `<!-- meta:${JSON.stringify(meta)} -->\n### correctness — FAIL`;
    expect(extractReviewFindingMeta(content)).toEqual(meta);
  });

  it('keeps review finding metadata on the shared meta-comment parser', () => {
    const source = readFileSync(new URL('./review-finding-contract.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/\.match\(\s*\/<!--\s*meta:/);
  });
});

describe('validateReviewFindingPayload (#1039)', () => {
  const validPass = {
    dimension: 'correctness',
    verdict: 'pass',
    summary: 'all checks addressed',
    findings: [{ requirement: 'R1', status: 'DONE', detail: 'ok' }],
  };

  it('accepts a canonical pass payload', () => {
    expect(validateReviewFindingPayload(validPass)).toEqual({ ok: true });
  });

  it('accepts pass verdict with empty findings when summary is present', () => {
    const res = validateReviewFindingPayload({ ...validPass, findings: [] });
    expect(res.ok).toBe(true);
  });

  it('rejects non-object payloads', () => {
    const r1 = validateReviewFindingPayload(null);
    expect(r1.ok).toBe(false);
    const r2 = validateReviewFindingPayload('oops');
    expect(r2.ok).toBe(false);
    const r3 = validateReviewFindingPayload([1, 2]);
    expect(r3.ok).toBe(false);
  });

  it('rejects missing dimension when no defaultDimension supplied', () => {
    const { dimension, ...rest } = validPass;
    const res = validateReviewFindingPayload(rest);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/dimension/i);
  });

  it('accepts missing dimension when defaultDimension is supplied', () => {
    const { dimension, ...rest } = validPass;
    expect(validateReviewFindingPayload(rest, { defaultDimension: 'self-review' })).toEqual({ ok: true });
  });

  it('rejects missing/invalid verdict', () => {
    const r1 = validateReviewFindingPayload({ ...validPass, verdict: 'maybe' });
    expect(r1.ok).toBe(false);
    const { verdict, ...rest } = validPass;
    const r2 = validateReviewFindingPayload(rest);
    expect(r2.ok).toBe(false);
  });

  it('rejects missing summary', () => {
    const { summary, ...rest } = validPass;
    const res = validateReviewFindingPayload(rest);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/summary/i);
  });

  it('rejects verdict=fail with empty findings (H2 — the #1039 core bug)', () => {
    const res = validateReviewFindingPayload({
      dimension: 'correctness',
      verdict: 'fail',
      summary: 'something is broken',
      findings: [],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/#1039/);
  });

  it('rejects malformed findings entries', () => {
    const res = validateReviewFindingPayload({
      ...validPass,
      findings: [{ detail: 'no requirement, no status' }],
    });
    expect(res.ok).toBe(false);
  });

  it('accepts legacy alias status=pass as verdict', () => {
    const res = validateReviewFindingPayload({
      dimension: 'correctness',
      status: 'pass',
      summary: 'ok',
      findings: [{ requirement: 'R1', status: 'DONE', detail: 'ok' }],
    });
    expect(res.ok).toBe(true);
  });
});

describe('deriveRoundVerdict — round-level three-state rule (#1019, #1067)', () => {
  it('any MISSING → FAIL', () => {
    expect(deriveRoundVerdict([{ done: 2, partial: 0, missing: 1 }])).toBe('FAIL');
    expect(deriveRoundVerdict([{ done: 5, partial: 3, missing: 2 }])).toBe('FAIL');
  });
  it('PARTIAL but no MISSING → PASS_WITH_PARTIALS', () => {
    expect(deriveRoundVerdict([{ done: 4, partial: 1, missing: 0 }])).toBe('PASS_WITH_PARTIALS');
  });
  it('all DONE → PASS', () => {
    expect(deriveRoundVerdict([{ done: 4, partial: 0, missing: 0 }])).toBe('PASS');
  });
  it('empty rows → PASS (nothing failed)', () => {
    expect(deriveRoundVerdict([])).toBe('PASS');
  });
});

describe('summarizeRound — authoritative rollup from rows', () => {
  it('computes per-state dimension counts and totals', () => {
    const roll = summarizeRound([
      { dim: 'correctness', verdict: 'pass', done: 3, partial: 0, missing: 0 },
      { dim: 'security', verdict: 'fail', done: 1, partial: 0, missing: 2 },
      { dim: 'perf', verdict: 'fail', done: 2, partial: 1, missing: 0 },
    ]);
    expect(roll.verdict).toBe('FAIL'); // security has MISSING
    expect(roll.dimensions).toBe(3);
    expect(roll.passDims).toBe(1);     // correctness
    expect(roll.failDims).toBe(1);     // security (missing)
    expect(roll.partialDims).toBe(1);  // perf (partial, no missing)
    expect(roll.totalDone).toBe(6);
    expect(roll.totalPartial).toBe(1);
    expect(roll.totalMissing).toBe(2);
  });
});

describe('assertsPass — conservative overt-PASS detection (#1019 guard)', () => {
  it('flags overt PASS claims', () => {
    expect(assertsPass('REVIEW PASSED — 5 rounds, 3 findings fixed')).toBe(true);
    expect(assertsPass('all dimensions pass')).toBe(true);
    expect(assertsPass('✅ PASS')).toBe(true);
    expect(assertsPass('LGTM')).toBe(true);
  });
  it('does NOT flag genuine non-verdict commentary', () => {
    expect(assertsPass('fixed 3 lint nits and a typo')).toBe(false);
    expect(assertsPass('carried the PARTIAL on perf forward to #1234')).toBe(false);
    expect(assertsPass('re-ran the security dimension after the TOCTOU fix')).toBe(false);
  });
});

describe('normalizeReviewFindingData — no fail-coercion on empty (#1039 H5)', () => {
  it('when input provides verdict=pass + empty findings, keeps verdict=pass', () => {
    // Regression: previously this would degrade to "fail" via the derivedVerdict
    // fallback only when verdictFromInput was absent. Confirm it stays pass.
    const finding = normalizeReviewFindingData({
      dimension: 'x',
      verdict: 'pass',
      summary: 'ok',
      findings: [],
    });
    expect(finding.verdict).toBe('pass');
  });
});
