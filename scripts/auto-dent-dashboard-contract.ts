import { z } from 'zod';
import {
  BATCH_OUTCOME_ATTACHMENT,
  type BatchOutcome,
} from './batch-outcome.js';
import {
  BATCH_ARTIFACTS_ATTACHMENT,
} from './batch-artifacts-upload.js';
import {
  BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT,
} from './transcript-bundle-constants.js';
import {
  RSI_IMPROVEMENT_PROPOSALS_ATTACHMENT,
} from './auto-dent-rsi.js';
import type {
  AutoDentAnomalyIncidentResult,
} from './auto-dent-anomaly-incidents.js';
import type {
  RunProgressStep,
} from './auto-dent-progress.js';
import type {
  TranscriptBundleManifest,
} from '../src/transcript-bundle.js';

export const DASHBOARD_CONTRACT_VERSION = 1;

export const PROGRESS_RUN_ATTACHMENT_PATTERN = 'progress/run-*';
export const BATCH_COMPLETE_ATTACHMENT = 'progress/batch-complete';

export const DASHBOARD_PANEL_IDS = [
  'batch-timeline',
  'run-table',
  'pr-pipeline',
  'score-quality',
  'artifact-links',
] as const;

export const DashboardPanelIdSchema = z.enum(DASHBOARD_PANEL_IDS);
export type DashboardPanelId = z.infer<typeof DashboardPanelIdSchema>;

export const DashboardArtifactKindSchema = z.enum([
  'issue-body',
  'named-attachment',
  'github-api',
  'actions-artifact',
  'derived',
]);

export const DashboardArtifactSourceSchema = z.object({
  id: z.string().min(1),
  kind: DashboardArtifactKindSchema,
  name: z.string().min(1),
  required: z.boolean(),
  panels: z.array(DashboardPanelIdSchema).min(1),
  provides: z.array(z.string().min(1)).min(1),
  description: z.string().min(1),
});
export type DashboardArtifactSource = z.infer<typeof DashboardArtifactSourceSchema>;

export const DashboardProgressStepSchema = z.object({
  phase: z.string().min(1),
  state: z.string().min(1),
  detail: z.string(),
  url: z.string().optional(),
});

export const DashboardRunRowSchema = z.object({
  run: z.number().int().positive(),
  mode: z.string().optional(),
  status: z.string().min(1),
  issue: z.string().optional(),
  issue_title: z.string().optional(),
  prs: z.array(z.string()),
  duration_seconds: z.number().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  progress_attachment: z.string().min(1),
  phases: z.array(DashboardProgressStepSchema),
});

export const DashboardArtifactLinkSchema = z.object({
  id: z.string().min(1),
  attachment: z.string().min(1),
  status: z.string().min(1),
  url: z.string().optional(),
  source: z.string().min(1),
  embeds_raw_payload: z.literal(false),
});

export const DashboardDataProjectionSchema = z.object({
  schema_version: z.literal(DASHBOARD_CONTRACT_VERSION),
  source: z.object({
    repo: z.string().min(1),
    progress_issue: z.number().int().positive(),
    progress_issue_url: z.string().optional(),
  }),
  artifact_sources: z.array(DashboardArtifactSourceSchema),
  panels: z.object({
    batch_timeline: z.object({
      batch_id: z.string().min(1),
      guidance: z.string(),
      batch_start: z.number(),
      batch_end: z.number(),
      wall_seconds: z.number().nonnegative(),
      stop_reason: z.string().min(1),
      runs: z.number().int().nonnegative(),
      source: z.literal(BATCH_OUTCOME_ATTACHMENT),
    }),
    run_table: z.array(DashboardRunRowSchema),
    pr_pipeline: z.array(z.object({
      run: z.number().int().positive(),
      pr: z.string().min(1),
      phases: z.array(DashboardProgressStepSchema),
      source: z.literal(PROGRESS_RUN_ATTACHMENT_PATTERN),
    })),
    score_quality: z.object({
      success_rate: z.number(),
      review_fail_rate: z.number(),
      overall_efficiency: z.number(),
      degradation_verdict: z.string().nullable(),
      anomaly_refs: z.array(z.object({
        status: z.string().min(1),
        issue: z.number().int().positive().optional(),
        url: z.string().optional(),
      })),
      rsi_proposals: z.object({
        attachment: z.literal(RSI_IMPROVEMENT_PROPOSALS_ATTACHMENT),
        proposal_count: z.number().int().nonnegative(),
        cross_run_verdict: z.string().optional(),
      }),
      source: z.literal(BATCH_OUTCOME_ATTACHMENT),
    }),
    artifact_links: z.array(DashboardArtifactLinkSchema),
  }),
  non_goals: z.array(z.string().min(1)),
});
export type DashboardDataProjection = z.infer<typeof DashboardDataProjectionSchema>;

export interface DashboardRunInput {
  run: number;
  mode?: string;
  status: string;
  issue?: string;
  issueTitle?: string;
  prs?: string[];
  durationSeconds?: number;
  costUsd?: number;
  progressSteps: RunProgressStep[];
}

export interface DashboardArtifactLinkInput {
  attachment: string;
  status: string;
  url?: string;
  source?: string;
}

export interface DashboardRsiSummaryInput {
  proposalCount: number;
  crossRunVerdict?: string;
}

export interface BuildDashboardDataProjectionInput {
  repo: string;
  progressIssue: number;
  progressIssueUrl?: string;
  outcome: BatchOutcome;
  runs: DashboardRunInput[];
  transcriptBundle?: TranscriptBundleManifest;
  artifactLinks?: DashboardArtifactLinkInput[];
  anomalyIncidents?: Pick<AutoDentAnomalyIncidentResult, 'refs'>;
  rsi?: DashboardRsiSummaryInput;
}

export function dashboardArtifactSources(progressIssue: number): DashboardArtifactSource[] {
  return [
    {
      id: 'progress-issue-body',
      kind: 'issue-body',
      name: `issue/${progressIssue}.body`,
      required: true,
      panels: ['batch-timeline', 'artifact-links'],
      provides: ['operator header', 'guidance summary', 'progress issue index'],
      description: 'Human-readable progress issue body created by auto-dent; it is an index, not the machine source of truth.',
    },
    {
      id: BATCH_OUTCOME_ATTACHMENT,
      kind: 'named-attachment',
      name: BATCH_OUTCOME_ATTACHMENT,
      required: true,
      panels: ['batch-timeline', 'run-table', 'score-quality'],
      provides: ['batch totals', 'mode breakdown', 'quality score', 'degradation signal', 'PR and issue refs'],
      description: 'Schema-validated batch summary written at progress issue close.',
    },
    {
      id: PROGRESS_RUN_ATTACHMENT_PATTERN,
      kind: 'named-attachment',
      name: PROGRESS_RUN_ATTACHMENT_PATTERN,
      required: true,
      panels: ['run-table', 'pr-pipeline'],
      provides: ['per-run outcome', 'run metrics', 'work-cycle phase rows'],
      description: 'One named attachment per run containing the existing kaizen progress-step model.',
    },
    {
      id: BATCH_COMPLETE_ATTACHMENT,
      kind: 'named-attachment',
      name: BATCH_COMPLETE_ATTACHMENT,
      required: true,
      panels: ['score-quality', 'artifact-links'],
      provides: ['final scorecard', 'merge audit', 'anomaly incident summary', 'durable attachment index'],
      description: 'Batch closing attachment that links durable finalization artifacts.',
    },
    {
      id: BATCH_ARTIFACTS_ATTACHMENT,
      kind: 'named-attachment',
      name: BATCH_ARTIFACTS_ATTACHMENT,
      required: false,
      panels: ['artifact-links'],
      provides: ['capped events.jsonl', 'capped state.json', 'forensic pointer'],
      description: 'Capped raw forensic attachment for drill-down only; the dashboard must not parse it as its primary model.',
    },
    {
      id: BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT,
      kind: 'named-attachment',
      name: BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT,
      required: false,
      panels: ['artifact-links'],
      provides: ['transcript bundle manifest', 'Actions artifact URL', 'retention status'],
      description: 'Small manifest/index for scrubbed transcript bundles stored as GitHub Actions artifacts.',
    },
    {
      id: RSI_IMPROVEMENT_PROPOSALS_ATTACHMENT,
      kind: 'named-attachment',
      name: RSI_IMPROVEMENT_PROPOSALS_ATTACHMENT,
      required: false,
      panels: ['score-quality', 'artifact-links'],
      provides: ['proposal count', 'cross-run verdict', 'proof requirements'],
      description: 'Structured RSI improvement proposal set derived from batch outcome signals.',
    },
    {
      id: 'github-pr-api',
      kind: 'github-api',
      name: 'gh pr view --json title,state,url',
      required: false,
      panels: ['pr-pipeline', 'artifact-links'],
      provides: ['PR title', 'PR state', 'PR URL'],
      description: 'Best-effort enrichment for refs already present in durable attachments.',
    },
    {
      id: 'github-issue-api',
      kind: 'github-api',
      name: 'gh issue view --json title,state,url',
      required: false,
      panels: ['run-table', 'artifact-links'],
      provides: ['issue title', 'issue state', 'issue URL'],
      description: 'Best-effort enrichment for refs already present in durable attachments.',
    },
  ].map((source) => DashboardArtifactSourceSchema.parse(source));
}

export function buildDashboardDataProjection(
  input: BuildDashboardDataProjectionInput,
): DashboardDataProjection {
  const runRows = input.runs.map((run) => DashboardRunRowSchema.parse({
    run: run.run,
    ...(run.mode ? { mode: run.mode } : {}),
    status: run.status,
    ...(run.issue ? { issue: run.issue } : {}),
    ...(run.issueTitle ? { issue_title: run.issueTitle } : {}),
    prs: run.prs ?? [],
    ...(typeof run.durationSeconds === 'number' ? { duration_seconds: Math.max(0, run.durationSeconds) } : {}),
    ...(typeof run.costUsd === 'number' ? { cost_usd: Math.max(0, run.costUsd) } : {}),
    progress_attachment: progressRunAttachmentName(run.run),
    phases: run.progressSteps.map((step) => DashboardProgressStepSchema.parse(step)),
  }));

  const artifactLinks = [
    ...defaultArtifactLinks(input),
    ...(input.artifactLinks ?? []),
  ].map((link) => DashboardArtifactLinkSchema.parse({
    id: link.attachment,
    attachment: link.attachment,
    status: link.status,
    ...(link.url ? { url: link.url } : {}),
    source: link.source ?? `progress issue #${input.progressIssue}`,
    embeds_raw_payload: false,
  }));

  return DashboardDataProjectionSchema.parse({
    schema_version: DASHBOARD_CONTRACT_VERSION,
    source: {
      repo: input.repo,
      progress_issue: input.progressIssue,
      ...(input.progressIssueUrl ? { progress_issue_url: input.progressIssueUrl } : {}),
    },
    artifact_sources: dashboardArtifactSources(input.progressIssue),
    panels: {
      batch_timeline: {
        batch_id: input.outcome.batch_id,
        guidance: input.outcome.guidance,
        batch_start: input.outcome.batch_start,
        batch_end: input.outcome.batch_end,
        wall_seconds: input.outcome.wall_seconds,
        stop_reason: input.outcome.stop_reason,
        runs: input.outcome.totals.runs,
        source: BATCH_OUTCOME_ATTACHMENT,
      },
      run_table: runRows,
      pr_pipeline: runRows.flatMap((run) =>
        run.prs.map((pr) => ({
          run: run.run,
          pr,
          phases: run.phases,
          source: PROGRESS_RUN_ATTACHMENT_PATTERN,
        })),
      ),
      score_quality: {
        success_rate: input.outcome.success_rate,
        review_fail_rate: input.outcome.review_fail_rate,
        overall_efficiency: input.outcome.overall_efficiency,
        degradation_verdict: input.outcome.degradation_signal?.verdict ?? null,
        anomaly_refs: (input.anomalyIncidents?.refs ?? []).map((ref) => ({
          status: ref.status,
          ...(ref.issue ? { issue: ref.issue } : {}),
          ...(ref.url ? { url: ref.url } : {}),
        })),
        rsi_proposals: {
          attachment: RSI_IMPROVEMENT_PROPOSALS_ATTACHMENT,
          proposal_count: input.rsi?.proposalCount ?? 0,
          ...(input.rsi?.crossRunVerdict ? { cross_run_verdict: input.rsi.crossRunVerdict } : {}),
        },
        source: BATCH_OUTCOME_ATTACHMENT,
      },
      artifact_links: artifactLinks,
    },
    non_goals: [
      'No live SSE or Cloudflare Worker stream; #1727 owns live event transport.',
      'No read-only dashboard UI; #1726 owns the first web surface.',
      'No asciinema replay generator; #1728 owns replay output.',
      'No Telegram or push notifications; #1729 owns notifications.',
      'No raw transcript embedding; use the transcript bundle manifest and artifact URL.',
    ],
  });
}

export function progressRunAttachmentName(run: number): string {
  return `progress/run-${run}`;
}

function defaultArtifactLinks(input: BuildDashboardDataProjectionInput): DashboardArtifactLinkInput[] {
  const links: DashboardArtifactLinkInput[] = [
    {
      attachment: BATCH_OUTCOME_ATTACHMENT,
      status: 'required',
      source: 'progress issue named attachment',
    },
    {
      attachment: BATCH_COMPLETE_ATTACHMENT,
      status: 'required',
      source: 'progress issue named attachment',
    },
  ];

  if (input.transcriptBundle) {
    links.push({
      attachment: BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT,
      status: input.transcriptBundle.status,
      url: input.transcriptBundle.artifact_url,
      source: input.transcriptBundle.artifact_name,
    });
  }

  return links;
}
