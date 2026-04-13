import { describe, it, expect } from 'vitest';
import {
  normalizeFindingStatus,
  deriveVerdictFromFindings,
  normalizeReviewFindingData,
  makeReviewFindingMeta,
  extractReviewFindingMeta,
  validateReviewFindingPayload,
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
