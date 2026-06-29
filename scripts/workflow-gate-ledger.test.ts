import { describe, expect, it } from 'vitest';

import { parsePhaseMarkers } from './auto-dent-stream.js';
import {
  CANONICAL_WORKFLOW_GATE_IDS,
  WORKFLOW_GATE_SCHEMA_VERSION,
  buildEvidenceRepairRequest,
  buildWorkflowGateLedger,
  deriveWorkflowGateVerdict,
  normalizeFinalClaimEvidence,
  normalizePhaseMarkerEvidence,
  workflowEvidence,
} from './workflow-gate-ledger.js';

const baseEvidence = {
  schemaVersion: WORKFLOW_GATE_SCHEMA_VERSION,
  producer: 'test',
  timestamp: '2026-06-28T00:00:00.000Z',
  runId: 'missing-crayfish/run-1',
  source: 'fixture',
};

describe('workflow gate ledger schema (#1533)', () => {
  it('defines the full authoritative kaizen gate set', () => {
    expect(CANONICAL_WORKFLOW_GATE_IDS).toEqual([
      'ticket-identity',
      'plan-testplan',
      'worktree-case',
      'implementation-tests',
      'dry-refactor',
      'context-delegation',
      'meet-reality',
      'review-requirements-impact',
      'reflection',
      'pr-ci-merge-cleanup',
      'hook-provider-activation',
    ]);

    const ledger = buildWorkflowGateLedger({ evidence: [] });
    expect(ledger.gates.map((gate) => gate.id)).toEqual(CANONICAL_WORKFLOW_GATE_IDS);
    expect(new Set(ledger.gates.map((gate) => gate.state))).toEqual(new Set(['pending']));
  });

  it('validates evidence before consumers can trust it', () => {
    const valid = workflowEvidence({
      ...baseEvidence,
      gateId: 'plan-testplan',
      evidenceType: 'plan',
      payload: { planUrl: 'https://github.com/Garsson-io/kaizen/issues/1533#issuecomment-1' },
    });

    const invalid = workflowEvidence({
      ...baseEvidence,
      schemaVersion: 'workflow-gate-ledger/v0',
      gateId: 'plan-testplan',
      evidenceType: 'plan',
      payload: { planUrl: 'https://github.com/Garsson-io/kaizen/issues/1533#issuecomment-1' },
    });

    expect(valid.validation.status).toBe('valid');
    expect(invalid.validation.status).toBe('invalid');
    expect(invalid.validation.errors.join('\n')).toContain('schemaVersion');
  });

  it('treats legacy phase markers as compatibility input, not authoritative truth', () => {
    const [testMarker] = parsePhaseMarkers('AUTO_DENT_PHASE: TEST | 19 passed');
    const [normalized] = normalizePhaseMarkerEvidence(testMarker, baseEvidence);

    expect(normalized.gateId).toBe('implementation-tests');
    expect(normalized.validation.status).toBe('invalid');
    expect(normalized.repairInstruction).toContain('test command');

    const ledger = buildWorkflowGateLedger({ evidence: [normalized] });
    expect(ledger.gates.find((gate) => gate.id === 'implementation-tests')?.state).toBe('invalid');
  });

  it('blocks and schedules repair for the missing-crayfish/run-1 shape', () => {
    const markers = parsePhaseMarkers([
      'AUTO_DENT_PHASE: PICK | issue=#1193 | title=case branch test',
      'AUTO_DENT_PHASE: IMPLEMENT | case=260628-k1193-case-branch-test',
      'AUTO_DENT_PHASE: TEST | 19 passed',
      'AUTO_DENT_PHASE: PR | url=https://github.com/Garsson-io/kaizen/pull/1530',
    ].join('\n'));
    const markerEvidence = markers.flatMap((marker) => normalizePhaseMarkerEvidence(marker, baseEvidence));
    const ledger = buildWorkflowGateLedger({
      evidence: [
        ...markerEvidence,
        workflowEvidence({
          ...baseEvidence,
          gateId: 'hook-provider-activation',
          evidenceType: 'hook-activation',
          producer: 'system.init',
          payload: { provider: 'claude', expected: true, active: false, plugins: [] },
        }),
        workflowEvidence({
          ...baseEvidence,
          gateId: 'review-requirements-impact',
          evidenceType: 'final-claim',
          payload: { review_status: 'pass' },
        }),
      ],
      context: {
        provider: 'claude',
        prUrl: 'https://github.com/Garsson-io/kaizen/pull/1530',
        issueNumber: 1193,
        branch: 'case/260628-k1193-case-branch-test',
        runId: 'missing-crayfish/run-1',
      },
    });

    const verdict = deriveWorkflowGateVerdict(ledger);
    expect(verdict.mergeReady).toBe(false);
    expect(verdict.processVerdict).toBe('process-incomplete');
    expect(verdict.invalidGateIds).toContain('implementation-tests');
    expect(verdict.invalidGateIds).toContain('hook-provider-activation');
    expect(verdict.missingGateIds).toContain('review-requirements-impact');
    expect(verdict.missingGateIds).toContain('dry-refactor');
    expect(verdict.missingGateIds).toContain('context-delegation');
    expect(verdict.repairRequired).toBe(true);

    const repair = buildEvidenceRepairRequest(ledger, { maxAttempts: 3, attempt: 1 });
    expect(repair.state).toBe('repair_scheduled');
    expect(repair.prUrl).toBe('https://github.com/Garsson-io/kaizen/pull/1530');
    expect(repair.issueNumber).toBe(1193);
    expect(repair.branch).toBe('case/260628-k1193-case-branch-test');
    expect(repair.missingGateIds).toEqual(verdict.missingGateIds);
    expect(repair.invalidGateIds).toEqual(verdict.invalidGateIds);
    expect(repair.prompt).toContain('fill evidence');
    expect(repair.prompt).toContain('do not restart unrelated implementation');
  });

  it('allows Codex/no-hook runs when schema-valid external evidence satisfies every gate', () => {
    const evidence = CANONICAL_WORKFLOW_GATE_IDS.map((gateId) =>
      workflowEvidence({
        ...baseEvidence,
        gateId,
        evidenceType: gateId === 'hook-provider-activation' ? 'external' : 'manual',
        payload: gateId === 'hook-provider-activation'
          ? { provider: 'codex', expected: false, active: false, reason: 'codex does not use Claude hooks' }
          : { status: 'done' },
      }));

    const ledger = buildWorkflowGateLedger({ evidence, context: { provider: 'codex' } });
    const verdict = deriveWorkflowGateVerdict(ledger);

    expect(ledger.gates.every((gate) => gate.state === 'done' || gate.state === 'not_applicable')).toBe(true);
    expect(verdict.processVerdict).toBe('pass');
    expect(verdict.mergeReady).toBe(true);
  });

  it('keeps final claims subordinate to durable review evidence', () => {
    const claimEvidence = normalizeFinalClaimEvidence({
      claim: { review_status: 'pass', tests: { status: 'pass' }, pr_url: 'https://github.com/o/r/pull/1' },
      durable: { reviewEvidence: false, testEvidence: false, prs: ['https://github.com/o/r/pull/1'] },
      meta: baseEvidence,
    });
    const ledger = buildWorkflowGateLedger({ evidence: claimEvidence });
    const verdict = deriveWorkflowGateVerdict(ledger);

    expect(ledger.gates.find((gate) => gate.id === 'review-requirements-impact')?.state).toBe('pending');
    expect(ledger.warnings).toContain('claim says review passed but durable review evidence is missing');
    expect(verdict.missingGateIds).toContain('review-requirements-impact');
    expect(verdict.repairRequired).toBe(true);
  });

  it('exposes one invariant surface for all consumer projections', () => {
    const ledger = buildWorkflowGateLedger({ evidence: [] });

    expect(ledger.consumerCoverage.status.map((item) => item.gateId)).toEqual(CANONICAL_WORKFLOW_GATE_IDS);
    expect(ledger.consumerCoverage.batchSummary.map((item) => item.gateId)).toEqual(CANONICAL_WORKFLOW_GATE_IDS);
    expect(ledger.consumerCoverage.mergePolicy.map((item) => item.gateId)).toEqual(CANONICAL_WORKFLOW_GATE_IDS);
    expect(ledger.consumerCoverage.repairPrompt.map((item) => item.gateId)).toEqual(CANONICAL_WORKFLOW_GATE_IDS);
  });
});
