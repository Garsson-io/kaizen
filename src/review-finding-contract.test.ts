import { describe, it, expect } from 'vitest';
import {
  normalizeFindingStatus,
  deriveVerdictFromFindings,
  normalizeReviewFindingData,
  makeReviewFindingMeta,
  extractReviewFindingMeta,
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
