import { z } from 'zod';

export const WORKFLOW_GATE_SCHEMA_VERSION = 'workflow-gate-ledger/v1' as const;

export const WORKFLOW_GATE_STATES = [
  'pending',
  'in_progress',
  'done',
  'blocked',
  'not_applicable',
  'invalid',
] as const;

export const CANONICAL_WORKFLOW_GATES = [
  {
    id: 'ticket-identity',
    label: 'ticket identity',
    repairInstruction: 'load the issue number, title, URL, repo, and scope linkage',
  },
  {
    id: 'plan-testplan',
    label: 'plan/test-plan gate',
    repairInstruction: 'store or retrieve the durable plan and test plan, or record why they are not applicable',
  },
  {
    id: 'worktree-case',
    label: 'worktree/case gate',
    repairInstruction: 'record branch, worktree, case, and issue binding evidence',
  },
  {
    id: 'implementation-tests',
    label: 'implementation with tests',
    repairInstruction: 'record changed artifacts plus the test command, result, count, and output source',
  },
  {
    id: 'dry-refactor',
    label: 'related-area DRY/refactor pass',
    repairInstruction: 'record the related-area simplification sweep or the explicit reason no refactor was warranted',
  },
  {
    id: 'context-delegation',
    label: 'context delegation',
    repairInstruction: 'record context-heavy sub-work delegated to subagents or the explicit reason delegation was not applicable',
  },
  {
    id: 'meet-reality',
    label: 'meet reality',
    repairInstruction: 'try the PR/workflow against reality and record observed outputs and side effects',
  },
  {
    id: 'review-requirements-impact',
    label: 'review/requirements/impact gates',
    repairInstruction: 'run/store review, requirements, and impact proof evidence',
  },
  {
    id: 'reflection',
    label: 'reflection gate',
    repairInstruction: 'record durable reflection or an explicit no-action reason',
  },
  {
    id: 'pr-ci-merge-cleanup',
    label: 'PR/CI/merge/cleanup',
    repairInstruction: 'record PR URL, CI state, merge readiness, merge result, and cleanup state',
  },
  {
    id: 'hook-provider-activation',
    label: 'hook/provider activation',
    repairInstruction: 'record provider identity, hook expectation/activation, or schema-valid external substitute evidence',
  },
] as const;

export const CANONICAL_WORKFLOW_GATE_IDS = CANONICAL_WORKFLOW_GATES.map((gate) => gate.id);

export type WorkflowGateId = typeof CANONICAL_WORKFLOW_GATES[number]['id'];
export type WorkflowGateState = typeof WORKFLOW_GATE_STATES[number];

const gateIdSchema = z.enum(CANONICAL_WORKFLOW_GATE_IDS as [WorkflowGateId, ...WorkflowGateId[]]);
const evidenceTypeSchema = z.enum([
  'issue',
  'plan',
  'testplan',
  'case',
  'implementation',
  'test',
  'dry-refactor',
  'context-delegation',
  'meet-reality',
  'review',
  'requirements',
  'impact',
  'reflection',
  'pr',
  'ci',
  'merge',
  'cleanup',
  'hook-activation',
  'phase-marker',
  'final-claim',
  'external',
  'manual',
]);

const workflowEvidenceInputSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_GATE_SCHEMA_VERSION),
  gateId: gateIdSchema,
  evidenceType: evidenceTypeSchema,
  producer: z.string().min(1),
  timestamp: z.string().min(1),
  runId: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  payload: z.unknown().optional(),
  authoritative: z.boolean().optional(),
  repairInstruction: z.string().min(1).optional(),
  warnings: z.array(z.string()).optional(),
});

export interface WorkflowEvidenceItem {
  schemaVersion: string;
  gateId: WorkflowGateId;
  evidenceType: z.infer<typeof evidenceTypeSchema>;
  producer: string;
  timestamp: string;
  runId?: string;
  source?: string;
  payload?: unknown;
  authoritative: boolean;
  validation: {
    status: 'valid' | 'invalid';
    errors: string[];
  };
  repairInstruction?: string;
  warnings: string[];
}

export interface WorkflowGateLedgerContext {
  provider?: string;
  prUrl?: string;
  issueNumber?: number;
  branch?: string;
  runId?: string;
}

export interface WorkflowGateEntry {
  id: WorkflowGateId;
  label: string;
  state: WorkflowGateState;
  evidence: WorkflowEvidenceItem[];
  validation: {
    status: 'valid' | 'invalid' | 'missing';
    errors: string[];
  };
  repairInstruction: string;
}

export interface WorkflowGateLedger {
  schemaVersion: typeof WORKFLOW_GATE_SCHEMA_VERSION;
  gates: WorkflowGateEntry[];
  context: WorkflowGateLedgerContext;
  warnings: string[];
  consumerCoverage: Record<'status' | 'batchSummary' | 'mergePolicy' | 'repairPrompt', Array<{ gateId: WorkflowGateId }>>;
}

export interface WorkflowGateVerdict {
  processVerdict: 'pass' | 'process-incomplete' | 'fail-open-warning';
  mergeReady: boolean;
  blockReasons: string[];
  missingGateIds: WorkflowGateId[];
  invalidGateIds: WorkflowGateId[];
  repairRequired: boolean;
}

export interface EvidenceRepairRequest {
  state: 'not_required' | 'repair_scheduled' | 'merge_ready' | 'blocked_with_reason' | 'repair_budget_exhausted';
  prUrl?: string;
  issueNumber?: number;
  branch?: string;
  runId?: string;
  missingGateIds: WorkflowGateId[];
  invalidGateIds: WorkflowGateId[];
  prompt: string;
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'evidence';
    return `${path}: ${issue.message}`;
  });
}

export function workflowEvidence(input: Record<string, unknown>): WorkflowEvidenceItem {
  const parsed = workflowEvidenceInputSchema.safeParse(input);
  if (!parsed.success) {
    const candidate = input as {
      gateId?: WorkflowGateId;
      evidenceType?: WorkflowEvidenceItem['evidenceType'];
      producer?: string;
      timestamp?: string;
      runId?: string;
      source?: string;
      payload?: unknown;
      authoritative?: boolean;
      repairInstruction?: string;
      warnings?: string[];
      schemaVersion?: string;
    };
    return {
      schemaVersion: candidate.schemaVersion ?? '',
      gateId: gateIdSchema.safeParse(candidate.gateId).success ? candidate.gateId as WorkflowGateId : 'ticket-identity',
      evidenceType: evidenceTypeSchema.safeParse(candidate.evidenceType).success ? candidate.evidenceType as WorkflowEvidenceItem['evidenceType'] : 'external',
      producer: candidate.producer ?? 'unknown',
      timestamp: candidate.timestamp ?? new Date(0).toISOString(),
      runId: candidate.runId,
      source: candidate.source,
      payload: candidate.payload,
      authoritative: candidate.authoritative ?? true,
      validation: { status: 'invalid', errors: formatZodIssues(parsed.error) },
      repairInstruction: candidate.repairInstruction,
      warnings: candidate.warnings ?? [],
    };
  }

  return {
    ...parsed.data,
    authoritative: parsed.data.authoritative ?? parsed.data.evidenceType !== 'final-claim',
    validation: { status: 'valid', errors: [] },
    warnings: parsed.data.warnings ?? [],
  };
}

interface PhaseMarkerLike {
  phase: string;
  fields: Record<string, string>;
}

type EvidenceMeta = Pick<WorkflowEvidenceItem, 'schemaVersion' | 'producer' | 'timestamp' | 'runId' | 'source'>;

function phaseEvidence(
  marker: PhaseMarkerLike,
  meta: EvidenceMeta,
  gateId: WorkflowGateId,
  evidenceType: WorkflowEvidenceItem['evidenceType'],
  payload: Record<string, unknown>,
): WorkflowEvidenceItem {
  return workflowEvidence({
    ...meta,
    gateId,
    evidenceType,
    producer: meta.producer || 'AUTO_DENT_PHASE',
    payload: { phase: marker.phase, fields: marker.fields, ...payload },
  });
}

function invalidPhaseEvidence(
  marker: PhaseMarkerLike,
  meta: EvidenceMeta,
  gateId: WorkflowGateId,
  message: string,
): WorkflowEvidenceItem {
  const item = workflowEvidence({
    ...meta,
    gateId,
    evidenceType: 'phase-marker',
    producer: meta.producer || 'AUTO_DENT_PHASE',
    payload: { phase: marker.phase, fields: marker.fields },
    repairInstruction: message,
  });
  return {
    ...item,
    validation: { status: 'invalid', errors: [message] },
    repairInstruction: message,
  };
}

export function normalizePhaseMarkerEvidence(marker: PhaseMarkerLike, meta: EvidenceMeta): WorkflowEvidenceItem[] {
  const f = marker.fields;
  switch (marker.phase) {
    case 'PICK':
      return [phaseEvidence(marker, meta, 'ticket-identity', 'issue', { issue: f.issue, title: f.title })];
    case 'PLAN':
      return [phaseEvidence(marker, meta, 'plan-testplan', f.kind === 'testplan' ? 'testplan' : 'plan', { url: f.url })];
    case 'IMPLEMENT':
      return [
        phaseEvidence(marker, meta, 'worktree-case', 'case', { case: f.case, branch: f.branch }),
        phaseEvidence(marker, meta, 'implementation-tests', 'implementation', { case: f.case, branch: f.branch }),
      ];
    case 'TEST': {
      if (f.result === 'pass' && f.count && Number.parseInt(f.count, 10) > 0) {
        return [phaseEvidence(marker, meta, 'implementation-tests', 'test', { result: f.result, count: f.count })];
      }
      return [invalidPhaseEvidence(
        marker,
        meta,
        'implementation-tests',
        'Malformed TEST phase marker: record a schema-valid test command/result/count evidence item.',
      )];
    }
    case 'PR':
      return [phaseEvidence(marker, meta, 'pr-ci-merge-cleanup', 'pr', { url: f.url })];
    case 'MERGE':
      return [phaseEvidence(marker, meta, 'pr-ci-merge-cleanup', 'merge', { url: f.url, status: f.status })];
    case 'REFLECT':
      return [phaseEvidence(marker, meta, 'reflection', 'reflection', { issues_filed: f.issues_filed, issues_created: f.issues_created })];
    default:
      return [];
  }
}

export function normalizeFinalClaimEvidence(input: {
  claim: { review_status?: string; tests?: { status?: string }; pr_url?: string | null };
  durable: { reviewEvidence: boolean; testEvidence: boolean; prs: string[] };
  meta: EvidenceMeta;
}): WorkflowEvidenceItem[] {
  const warnings: string[] = [];
  if (input.claim.review_status === 'pass' && !input.durable.reviewEvidence) {
    warnings.push('claim says review passed but durable review evidence is missing');
  }
  if (input.claim.tests?.status === 'pass' && !input.durable.testEvidence) {
    warnings.push('claim says tests passed but durable test evidence is missing');
  }
  if (input.claim.pr_url && !input.durable.prs.includes(input.claim.pr_url)) {
    warnings.push(`claim selected PR ${input.claim.pr_url} but durable PR evidence is missing`);
  }

  return [workflowEvidence({
    ...input.meta,
    gateId: 'review-requirements-impact',
    evidenceType: 'final-claim',
    producer: input.meta.producer || 'final-claim',
    authoritative: false,
    payload: input.claim,
    warnings,
  })];
}

function gateMetadata(id: WorkflowGateId): typeof CANONICAL_WORKFLOW_GATES[number] {
  return CANONICAL_WORKFLOW_GATES.find((gate) => gate.id === id)!;
}

function evidenceMakesGateNotApplicable(evidence: WorkflowEvidenceItem): boolean {
  const payload = evidence.payload as Record<string, unknown> | undefined;
  return payload?.status === 'not_applicable' ||
    (evidence.gateId === 'hook-provider-activation' && payload?.expected === false);
}

function evidenceIsBusinessInvalid(evidence: WorkflowEvidenceItem): string[] {
  const payload = evidence.payload as Record<string, unknown> | undefined;
  if (evidence.gateId === 'hook-provider-activation' && payload?.expected === true && payload.active !== true) {
    return ['hook/provider evidence says hooks were expected but not active'];
  }
  return [];
}

export function buildWorkflowGateLedger(input: {
  evidence: WorkflowEvidenceItem[];
  context?: WorkflowGateLedgerContext;
}): WorkflowGateLedger {
  const warnings = input.evidence.flatMap((item) => item.warnings);
  const gates = CANONICAL_WORKFLOW_GATES.map<WorkflowGateEntry>((meta) => {
    const evidence = input.evidence.filter((item) => item.gateId === meta.id);
    const authoritative = evidence.filter((item) => item.authoritative);
    const schemaInvalid = authoritative.filter((item) => item.validation.status === 'invalid');
    const businessInvalid = authoritative.flatMap((item) =>
      evidenceIsBusinessInvalid(item).map((error) => ({ item, error })));
    const notApplicable = authoritative.some(evidenceMakesGateNotApplicable);
    const valid = authoritative.some((item) => item.validation.status === 'valid') && businessInvalid.length === 0;
    const errors = [
      ...schemaInvalid.flatMap((item) => item.validation.errors),
      ...businessInvalid.map((item) => item.error),
    ];
    let state: WorkflowGateState = 'pending';
    if (schemaInvalid.length > 0 || businessInvalid.length > 0) state = 'invalid';
    else if (notApplicable) state = 'not_applicable';
    else if (valid) state = 'done';

    return {
      id: meta.id,
      label: meta.label,
      state,
      evidence,
      validation: {
        status: state === 'invalid' ? 'invalid' : state === 'pending' ? 'missing' : 'valid',
        errors,
      },
      repairInstruction: evidence.find((item) => item.repairInstruction)?.repairInstruction ?? meta.repairInstruction,
    };
  });

  const coverage = CANONICAL_WORKFLOW_GATE_IDS.map((gateId) => ({ gateId }));
  return {
    schemaVersion: WORKFLOW_GATE_SCHEMA_VERSION,
    gates,
    context: input.context ?? {},
    warnings,
    consumerCoverage: {
      status: coverage,
      batchSummary: coverage,
      mergePolicy: coverage,
      repairPrompt: coverage,
    },
  };
}

export function deriveWorkflowGateVerdict(ledger: WorkflowGateLedger): WorkflowGateVerdict {
  const missingGateIds = ledger.gates.filter((gate) => gate.state === 'pending').map((gate) => gate.id);
  const invalidGateIds = ledger.gates.filter((gate) => gate.state === 'invalid').map((gate) => gate.id);
  const blockReasons = [
    ...missingGateIds.map((id) => `${gateMetadata(id).label} missing`),
    ...invalidGateIds.map((id) => `${gateMetadata(id).label} invalid`),
  ];
  const mergeReady = blockReasons.length === 0;
  return {
    processVerdict: mergeReady ? 'pass' : 'process-incomplete',
    mergeReady,
    blockReasons,
    missingGateIds,
    invalidGateIds,
    repairRequired: !mergeReady,
  };
}

export function buildEvidenceRepairRequest(
  ledger: WorkflowGateLedger,
  options: { attempt?: number; maxAttempts?: number } = {},
): EvidenceRepairRequest {
  const verdict = deriveWorkflowGateVerdict(ledger);
  if (verdict.mergeReady) {
    return {
      state: 'merge_ready',
      ...ledger.context,
      missingGateIds: [],
      invalidGateIds: [],
      prompt: 'Ledger is merge-ready; no evidence repair is required.',
    };
  }

  const attempt = options.attempt ?? 1;
  const maxAttempts = options.maxAttempts ?? 3;
  const state = attempt > maxAttempts ? 'repair_budget_exhausted' : 'repair_scheduled';
  const gateList = [...verdict.missingGateIds, ...verdict.invalidGateIds]
    .map((id) => `- ${id}: ${gateMetadata(id).repairInstruction}`)
    .join('\n');
  const prompt = [
    `Repair evidence for run ${ledger.context.runId ?? '(unknown run)'}.`,
    `PR: ${ledger.context.prUrl ?? '(unknown PR)'}`,
    `Issue: ${ledger.context.issueNumber ?? '(unknown issue)'}`,
    `Branch: ${ledger.context.branch ?? '(unknown branch)'}`,
    'fill evidence for the exact missing/invalid gates below; do not restart unrelated implementation.',
    gateList,
    'Update the same workflow gate ledger and stop only at merge_ready, blocked_with_reason, or repair_budget_exhausted.',
  ].join('\n');

  return {
    state,
    ...ledger.context,
    missingGateIds: verdict.missingGateIds,
    invalidGateIds: verdict.invalidGateIds,
    prompt,
  };
}
