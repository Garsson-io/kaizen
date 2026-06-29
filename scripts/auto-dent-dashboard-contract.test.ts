import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import {
  PROGRESS_PHASE_ORDER,
  type RunProgressStep,
} from './auto-dent-progress.js';
import {
  BATCH_COMPLETE_ATTACHMENT,
  DashboardDataProjectionSchema,
  PROGRESS_RUN_ATTACHMENT_PATTERN,
  buildDashboardDataProjection,
  dashboardArtifactSources,
  progressRunAttachmentName,
} from './auto-dent-dashboard-contract.js';
import type { TranscriptBundleManifest } from '../src/transcript-bundle.js';

const REPO_ROOT = resolve(__dirname, '..');

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

const outcome: BatchOutcome = {
  schema_version: 1,
  batch_id: 'crisp-dashboard',
  guidance: 'surface durable auto-dent evidence',
  batch_start: 1_000,
  batch_end: 1_900,
  wall_seconds: 900,
  stop_reason: 'completed',
  totals: {
    runs: 2,
    successful_runs: 1,
    prs: 1,
    issues_closed: 1,
    issues_filed: 1,
    cost_usd: 3.25,
    duration_seconds: 850,
    lines_deleted: 0,
    issues_pruned: 0,
  },
  success_rate: 0.5,
  avg_cost_per_success: 3.25,
  overall_efficiency: 0.31,
  review_fail_rate: 0,
  cost_anomaly_count: 0,
  mode_diversity: 2,
  trend: null,
  degradation_signal: {
    verdict: 'watch',
    score: 0.32,
    first_half_success_rate: 1,
    second_half_success_rate: 0,
    success_rate_delta: -1,
    trailing_failure_count: 1,
    trailing_empty_success_count: 0,
    early_cost_per_success: 1.5,
    late_cost_per_success: null,
    cost_per_success_ratio: null,
    duration_slope_seconds_per_run: 40,
    reasons: ['late run failed'],
  },
  mode_breakdown: [
    { mode: 'exploit', runs: 1, successes: 1, success_rate: 1, cost_usd: 1.5, prs: 1, avg_cost: 1.5, efficiency: 0.67, lines_deleted: 0, issues_pruned: 0 },
    { mode: 'explore', runs: 1, successes: 0, success_rate: 0, cost_usd: 1.75, prs: 0, avg_cost: 1.75, efficiency: 0, lines_deleted: 0, issues_pruned: 0 },
  ],
  prs: ['https://github.com/Garsson-io/kaizen/pull/1730'],
  issues_closed: ['#1724'],
  issues_filed: ['#1725'],
};

const progressSteps: RunProgressStep[] = [
  { phase: 'PICK', state: 'selected', detail: '#1725' },
  { phase: 'PLAN', state: 'stored', detail: 'plan/test-plan stored' },
  { phase: 'IMPLEMENT', state: 'done', detail: 'contract projection built' },
  { phase: 'TEST', state: 'passed', detail: 'focused contract tests' },
  { phase: 'PR', state: 'created', detail: 'https://github.com/Garsson-io/kaizen/pull/1731' },
];

const transcriptManifest: TranscriptBundleManifest = {
  version: 1,
  batch_id: 'crisp-dashboard',
  repo: 'Garsson-io/kaizen',
  progress_issue: 2000,
  transport: 'github-actions-artifact',
  artifact_name: 'auto-dent-transcripts-crisp-dashboard',
  artifact_url: 'https://github.com/Garsson-io/kaizen/actions/runs/1',
  created_at: '2026-06-29T18:00:00.000Z',
  expires_at: '2026-09-27T18:00:00.000Z',
  content_encoding: 'tar+gzip',
  scrubbed: true,
  truncated: false,
  status: 'ready',
  bundle: {
    path: 'auto-dent-transcripts-crisp-dashboard.tar.gz',
    bytes: 100,
    sha256: 'a'.repeat(64),
  },
  files: [
    { path: 'run-1.log', bytes: 42, sha256: 'b'.repeat(64), redactions: 0 },
  ],
};

describe('dashboardArtifactSources', () => {
  it('maps required dashboard panels to existing artifact constants', () => {
    const sources = dashboardArtifactSources(2000);
    const byId = new Map(sources.map((source) => [source.id, source]));

    expect(byId.get(BATCH_OUTCOME_ATTACHMENT)?.required).toBe(true);
    expect(byId.get(BATCH_OUTCOME_ATTACHMENT)?.panels).toEqual(expect.arrayContaining(['batch-timeline', 'score-quality']));
    expect(byId.get(PROGRESS_RUN_ATTACHMENT_PATTERN)?.panels).toEqual(expect.arrayContaining(['run-table', 'pr-pipeline']));
    expect(byId.get(BATCH_COMPLETE_ATTACHMENT)?.panels).toContain('artifact-links');
    expect(byId.get(BATCH_ARTIFACTS_ATTACHMENT)?.required).toBe(false);
    expect(byId.get(BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT)?.provides).toContain('Actions artifact URL');
    expect(byId.get(RSI_IMPROVEMENT_PROPOSALS_ATTACHMENT)?.panels).toContain('score-quality');
  });
});

describe('buildDashboardDataProjection', () => {
  it('builds a schema-valid read-only projection from existing artifact-shaped inputs', () => {
    const projection = buildDashboardDataProjection({
      repo: 'Garsson-io/kaizen',
      progressIssue: 2000,
      progressIssueUrl: 'https://github.com/Garsson-io/kaizen/issues/2000',
      outcome,
      runs: [
        {
          run: 1,
          mode: 'exploit',
          status: 'pass',
          issue: '#1725',
          issueTitle: 'Auto-dent dashboard data contract over GitHub artifacts',
          prs: ['https://github.com/Garsson-io/kaizen/pull/1731'],
          durationSeconds: 420,
          costUsd: 1.25,
          progressSteps,
        },
      ],
      transcriptBundle: transcriptManifest,
      artifactLinks: [
        { attachment: BATCH_ARTIFACTS_ATTACHMENT, status: 'available', source: 'batch-artifacts named attachment' },
      ],
      anomalyIncidents: {
        refs: [
          {
            signal_key: 'crisp-dashboard:run-2:run_failed',
            status: 'created',
            issue: 1999,
            url: 'https://github.com/Garsson-io/kaizen/issues/1999',
          },
        ],
      },
      rsi: {
        proposalCount: 2,
        crossRunVerdict: 'watch',
      },
    });

    expect(() => DashboardDataProjectionSchema.parse(projection)).not.toThrow();
    expect(projection.panels.batch_timeline).toMatchObject({
      batch_id: 'crisp-dashboard',
      source: BATCH_OUTCOME_ATTACHMENT,
      runs: 2,
    });
    expect(projection.panels.run_table[0]).toMatchObject({
      run: 1,
      progress_attachment: progressRunAttachmentName(1),
      issue: '#1725',
      cost_usd: 1.25,
    });
    expect(projection.panels.pr_pipeline[0]).toMatchObject({
      run: 1,
      pr: 'https://github.com/Garsson-io/kaizen/pull/1731',
      source: PROGRESS_RUN_ATTACHMENT_PATTERN,
    });
    expect(projection.panels.score_quality).toMatchObject({
      success_rate: 0.5,
      degradation_verdict: 'watch',
    });
    expect(projection.panels.score_quality.anomaly_refs[0]).toMatchObject({
      status: 'created',
      issue: 1999,
    });
    expect(projection.panels.score_quality.rsi_proposals).toEqual({
      attachment: RSI_IMPROVEMENT_PROPOSALS_ATTACHMENT,
      proposal_count: 2,
      cross_run_verdict: 'watch',
    });
  });

  it('treats transcripts and raw artifacts as links, never embedded raw payloads', () => {
    const projection = buildDashboardDataProjection({
      repo: 'Garsson-io/kaizen',
      progressIssue: 2000,
      outcome,
      runs: [{ run: 1, status: 'pass', prs: [], progressSteps }],
      transcriptBundle: transcriptManifest,
      artifactLinks: [{ attachment: BATCH_ARTIFACTS_ATTACHMENT, status: 'available' }],
    });

    const byAttachment = new Map(projection.panels.artifact_links.map((link) => [link.attachment, link]));
    expect(byAttachment.get(BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT)).toMatchObject({
      status: 'ready',
      url: transcriptManifest.artifact_url,
      embeds_raw_payload: false,
    });
    expect(byAttachment.get(BATCH_ARTIFACTS_ATTACHMENT)).toMatchObject({
      status: 'available',
      embeds_raw_payload: false,
    });
    expect(JSON.stringify(projection)).not.toContain('run-1 transcript raw text');
  });

  it('keeps the PR pipeline on the existing progress-step phase names', () => {
    const projection = buildDashboardDataProjection({
      repo: 'Garsson-io/kaizen',
      progressIssue: 2000,
      outcome,
      runs: [{ run: 1, status: 'pass', prs: ['https://github.com/Garsson-io/kaizen/pull/1731'], progressSteps }],
    });

    const phases = projection.panels.pr_pipeline[0].phases.map((step) => step.phase);
    expect(PROGRESS_PHASE_ORDER).toEqual(expect.arrayContaining(phases));
  });

  it('states sibling child issues as non-goals', () => {
    const projection = buildDashboardDataProjection({
      repo: 'Garsson-io/kaizen',
      progressIssue: 2000,
      outcome,
      runs: [{ run: 1, status: 'pass', prs: [], progressSteps }],
    });

    expect(projection.non_goals.join('\n')).toContain('#1727');
    expect(projection.non_goals.join('\n')).toContain('#1726');
    expect(projection.non_goals.join('\n')).toContain('#1728');
    expect(projection.non_goals.join('\n')).toContain('#1729');
  });
});

describe('dashboard data contract docs', () => {
  const doc = read('docs/auto-dent-dashboard-data-contract.md');

  it('documents every required panel and durable artifact source', () => {
    for (const panel of ['Batch timeline', 'Run table', 'PR pipeline', 'Score and quality', 'Artifact links']) {
      expect(doc).toContain(panel);
    }
    for (const artifact of [
      BATCH_OUTCOME_ATTACHMENT,
      PROGRESS_RUN_ATTACHMENT_PATTERN,
      BATCH_COMPLETE_ATTACHMENT,
      BATCH_ARTIFACTS_ATTACHMENT,
      BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT,
      RSI_IMPROVEMENT_PROPOSALS_ATTACHMENT,
    ]) {
      expect(doc).toContain(artifact);
    }
  });

  it('excludes live stream, replay, notification, and raw transcript concerns', () => {
    expect(doc).toContain('No live SSE or Cloudflare Worker stream');
    expect(doc).toContain('No asciinema replay generation');
    expect(doc).toContain('No Telegram or push notifications');
    expect(doc).toContain('must not embed raw');
  });
});
