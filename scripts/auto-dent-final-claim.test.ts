import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  compareFinalClaimToEvidence,
  foldFinalClaimWarningsIntoProcess,
  parseFinalRunClaim,
  writeFinalClaimArtifact,
  type FinalRunClaim,
} from './auto-dent-final-claim.js';

function validClaim(overrides: Partial<FinalRunClaim> = {}): FinalRunClaim {
  return {
    schema_version: 1,
    selected_issue: '#1145',
    case_worktree: '2606271547-k1145-final-claim-contract',
    tests: {
      status: 'pass',
      command: 'npx vitest run scripts/auto-dent-final-claim.test.ts',
      count: 8,
      evidence: ['8 tests passed'],
    },
    pr_url: 'https://github.com/Garsson-io/kaizen/pull/1176',
    review_status: 'pass',
    reflection_status: 'done',
    stop_reason: null,
    blockers: [],
    ...overrides,
  };
}

describe('parseFinalRunClaim (#1145)', () => {
  it('parses a valid fenced final claim object', () => {
    const result = parseFinalRunClaim([
      'done',
      '```json',
      JSON.stringify(validClaim(), null, 2),
      '```',
    ].join('\n'));

    expect(result.status).toBe('valid');
    expect(result.claim?.selected_issue).toBe('#1145');
    expect(result.claim?.tests.status).toBe('pass');
    expect(result.warnings).toEqual([]);
  });

  it('parses a valid plain JSON final claim object', () => {
    const result = parseFinalRunClaim(JSON.stringify(validClaim({ pr_url: null })));

    expect(result.status).toBe('valid');
    expect(result.claim?.pr_url).toBeNull();
  });

  it('returns structured warnings for invalid schema output', () => {
    const result = parseFinalRunClaim(JSON.stringify({
      schema_version: 1,
      selected_issue: '#1145',
      tests: { status: 'green' },
      blockers: 'none',
    }));

    expect(result.status).toBe('invalid');
    expect(result.warnings.join('\n')).toMatch(/tests\.status/);
    expect(result.warnings.join('\n')).toMatch(/blockers/);
  });

  it('returns missing without throwing for legacy free text', () => {
    const result = parseFinalRunClaim('Finished the run. AUTO_DENT_PHASE: STOP | reason=done');

    expect(result.status).toBe('missing');
    expect(result.claim).toBeUndefined();
    expect(result.warnings).toEqual(['final claim object missing']);
  });
});

describe('compareFinalClaimToEvidence (#1145)', () => {
  it('warns when agent claims are not backed by durable evidence', () => {
    const warnings = compareFinalClaimToEvidence(validClaim(), {
      prs: [],
      cases: [],
      testEvidence: false,
      reviewEvidence: false,
      reflectionEvidence: false,
    });

    expect(warnings).toContain('claim selected PR https://github.com/Garsson-io/kaizen/pull/1176 but durable PR evidence is missing');
    expect(warnings).toContain('claim selected case/worktree 2606271547-k1145-final-claim-contract but durable implementation evidence is missing');
    expect(warnings).toContain('claim says tests passed but durable test evidence is missing');
    expect(warnings).toContain('claim says review passed but durable review evidence is missing');
    expect(warnings).toContain('claim says reflection completed but durable reflection evidence is missing');
  });

  it('does not warn when claims match durable evidence', () => {
    const warnings = compareFinalClaimToEvidence(validClaim(), {
      prs: ['https://github.com/Garsson-io/kaizen/pull/1176'],
      cases: ['2606271547-k1145-final-claim-contract'],
      testEvidence: true,
      reviewEvidence: true,
      reflectionEvidence: true,
    });

    expect(warnings).toEqual([]);
  });
});

describe('writeFinalClaimArtifact (#1145)', () => {
  it('persists valid claim JSON beside run artifacts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'final-claim-'));
    try {
      const path = writeFinalClaimArtifact(dir, 3, validClaim());

      expect(path).toBe(join(dir, 'run-3-final-claim.json'));
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
        schema_version: 1,
        selected_issue: '#1145',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('foldFinalClaimWarningsIntoProcess (#1145)', () => {
  it('fixture #1150: a valid structured success claim is not proof without durable evidence', () => {
    const claim = validClaim({
      tests: {
        status: 'pass',
        command: 'npm test',
        count: 42,
        evidence: ['claimed green'],
      },
      review_status: 'pass',
      reflection_status: 'done',
    });

    const warnings = compareFinalClaimToEvidence(claim, {
      prs: [],
      cases: [],
      testEvidence: false,
      reviewEvidence: false,
      reflectionEvidence: false,
    });
    const folded = foldFinalClaimWarningsIntoProcess(
      'pass',
      0,
      'process verdict pass (durable evidence complete)',
      true,
      warnings,
    );

    expect(warnings).toContain('claim says tests passed but durable test evidence is missing');
    expect(warnings).toContain('claim says review passed but durable review evidence is missing');
    expect(warnings).toContain('claim says reflection completed but durable reflection evidence is missing');
    expect(folded.verdict).toBe('process-incomplete');
    expect(folded.issueCount).toBeGreaterThanOrEqual(3);
  });

  it('turns an otherwise passing process verdict into process-incomplete for valid contradictory claims', () => {
    const folded = foldFinalClaimWarningsIntoProcess(
      'pass',
      0,
      'process verdict pass (durable evidence complete)',
      true,
      ['claim says tests passed but durable test evidence is missing'],
    );

    expect(folded).toEqual({
      verdict: 'process-incomplete',
      issueCount: 1,
      summary: 'process verdict pass (durable evidence complete); final-claim: claim says tests passed but durable test evidence is missing',
    });
  });

  it('does not change the durable process verdict for invalid or missing claim warnings alone', () => {
    const folded = foldFinalClaimWarningsIntoProcess(
      'pass',
      0,
      'process verdict pass (durable evidence complete)',
      false,
      ['final claim object missing'],
    );

    expect(folded).toEqual({
      verdict: 'pass',
      issueCount: 0,
      summary: 'process verdict pass (durable evidence complete)',
    });
  });
});
