/**
 * auto-dent-anomaly-incidents.ts - deterministic incident filing for run anomalies.
 *
 * The harness owns these signals after the worker exits. Detection consumes the
 * existing RunMetrics contract; it does not re-parse logs or trust worker prose.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BatchState, RunMetrics } from './auto-dent-run.js';
import type { BatchScore } from './auto-dent-score.js';
import { gh } from '../src/lib/gh-exec.js';

export const ANOMALY_INCIDENT_LABELS = ['kaizen', 'level-2', 'area/auto-dent', 'auto-dent'] as const;

export const AutoDentAnomalyTriggerSchema = z.enum([
  'run_failed',
  'empty_success',
  'hook_rejection',
  'lifecycle_critical',
  'lifecycle_degraded',
  'process_incomplete',
  'too_many_prs',
  'duration_outlier',
  'cost_outlier',
]);

export const AutoDentAnomalySeveritySchema = z.enum(['warning', 'critical']);

export const AutoDentAnomalySignalSchema = z.object({
  trigger: AutoDentAnomalyTriggerSchema,
  severity: AutoDentAnomalySeveritySchema,
  dedupe_key: z.string().min(1),
  batch_id: z.string().min(1),
  run: z.number().int().positive(),
  title: z.string().min(1),
  summary: z.string().min(1),
  evidence: z.array(z.string()).min(1),
  search_query: z.string().min(1),
});

export const AutoDentIncidentRefSchema = z.object({
  signal_key: z.string().min(1),
  status: z.enum(['created', 'reused', 'skipped']),
  issue: z.number().int().positive().optional(),
  url: z.string().optional(),
  reason: z.string().optional(),
});

export const AutoDentAnomalyIncidentResultSchema = z.object({
  signals: z.array(AutoDentAnomalySignalSchema),
  refs: z.array(AutoDentIncidentRefSchema),
  diagnostics: z.array(z.string()),
});

export type AutoDentAnomalyTrigger = z.infer<typeof AutoDentAnomalyTriggerSchema>;
export type AutoDentAnomalySignal = z.infer<typeof AutoDentAnomalySignalSchema>;
export type AutoDentIncidentRef = z.infer<typeof AutoDentIncidentRefSchema>;
export type AutoDentAnomalyIncidentResult = z.infer<typeof AutoDentAnomalyIncidentResultSchema>;

export type GhArgs = (args: string[]) => string;

export interface DetectAutoDentAnomaliesOptions {
  batchScore?: BatchScore;
}

export interface FileAutoDentAnomalyIncidentsOptions {
  gh?: GhArgs;
  progressIssue?: string;
  maxSignals?: number;
}

function stableKey(parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12);
}

function issueUrl(repo: string, issue: number): string {
  return `https://github.com/${repo}/issues/${issue}`;
}

function extractIssueNumber(url: string): number | null {
  const match = url.match(/\/issues\/(\d+)(?:$|[#?])/);
  return match ? Number(match[1]) : null;
}

function avgPrior(values: number[], index: number): number | null {
  const prior = values.slice(0, index).filter((v) => Number.isFinite(v) && v > 0);
  if (prior.length === 0) return null;
  return prior.reduce((sum, v) => sum + v, 0) / prior.length;
}

function signal(
  state: BatchState,
  run: RunMetrics,
  trigger: AutoDentAnomalyTrigger,
  severity: z.infer<typeof AutoDentAnomalySeveritySchema>,
  summary: string,
  evidence: string[],
): AutoDentAnomalySignal {
  const key = stableKey([state.batch_id, String(run.run), trigger, summary]);
  const title = `[auto-dent incident] ${trigger.replaceAll('_', ' ')} in ${state.batch_id} run ${run.run}`;
  return AutoDentAnomalySignalSchema.parse({
    trigger,
    severity,
    dedupe_key: `${state.batch_id}:run-${run.run}:${trigger}:${key}`,
    batch_id: state.batch_id,
    run: run.run,
    title,
    summary,
    evidence,
    search_query: `"${state.batch_id}:run-${run.run}:${trigger}" in:body`,
  });
}

export function detectAutoDentAnomalies(
  state: BatchState,
  _opts: DetectAutoDentAnomaliesOptions = {},
): AutoDentAnomalySignal[] {
  const history = state.run_history ?? [];
  const signals: AutoDentAnomalySignal[] = [];
  const costs = history.map((run) => run.cost_usd);
  const durations = history.map((run) => run.duration_seconds);

  history.forEach((run, index) => {
    const evidenceBase = [
      `batch=${state.batch_id}`,
      `run=${run.run}`,
      `exit_code=${run.exit_code}`,
      `prs=${run.prs.length}`,
      `failure_class=${run.failure_class ?? 'unknown'}`,
    ];

    if (run.exit_code !== 0) {
      signals.push(signal(
        state,
        run,
        'run_failed',
        'critical',
        `Run ${run.run} exited non-zero.`,
        evidenceBase,
      ));
    }

    if (run.failure_class === 'empty_success') {
      signals.push(signal(
        state,
        run,
        'empty_success',
        'critical',
        `Run ${run.run} claimed success but produced no durable work artifacts.`,
        evidenceBase,
      ));
    }

    if (run.failure_class === 'hook_rejection') {
      signals.push(signal(
        state,
        run,
        'hook_rejection',
        'warning',
        `Run ${run.run} was blocked by a hook rejection.`,
        [...evidenceBase, `hook_reason=${run.hook_rejection_reason ?? 'unknown'}`],
      ));
    }

    if (run.lifecycle_health === 'critical') {
      signals.push(signal(
        state,
        run,
        'lifecycle_critical',
        'critical',
        `Run ${run.run} had critical lifecycle gaps or phantom phase evidence.`,
        [...evidenceBase, `lifecycle_violations=${run.lifecycle_violations ?? 0}`],
      ));
    } else if ((run.lifecycle_violations ?? 0) > 0 || run.lifecycle_health === 'degraded') {
      signals.push(signal(
        state,
        run,
        'lifecycle_degraded',
        'warning',
        `Run ${run.run} had lifecycle ordering violations.`,
        [...evidenceBase, `lifecycle_violations=${run.lifecycle_violations ?? 0}`],
      ));
    }

    if (run.process_verdict === 'process-incomplete') {
      signals.push(signal(
        state,
        run,
        'process_incomplete',
        'critical',
        `Run ${run.run} had incomplete external process evidence.`,
        [...evidenceBase, `process_summary=${run.process_summary ?? 'missing'}`],
      ));
    }

    if (run.prs.length > 3) {
      signals.push(signal(
        state,
        run,
        'too_many_prs',
        'critical',
        `Run ${run.run} created ${run.prs.length} PRs, exceeding the scope-discipline threshold of 3.`,
        [...evidenceBase, `prs=${run.prs.join(', ')}`],
      ));
    }

    const priorCost = avgPrior(costs, index);
    if (priorCost !== null && run.cost_usd > priorCost * 2) {
      signals.push(signal(
        state,
        run,
        'cost_outlier',
        'warning',
        `Run ${run.run} cost ${run.cost_usd.toFixed(2)}, more than 2x the prior average ${priorCost.toFixed(2)}.`,
        [...evidenceBase, `cost_usd=${run.cost_usd}`, `prior_avg_cost_usd=${priorCost.toFixed(2)}`],
      ));
    }

    const priorDuration = avgPrior(durations, index);
    if (priorDuration !== null && run.duration_seconds > priorDuration * 2) {
      signals.push(signal(
        state,
        run,
        'duration_outlier',
        'warning',
        `Run ${run.run} took ${run.duration_seconds}s, more than 2x the prior average ${priorDuration.toFixed(0)}s.`,
        [...evidenceBase, `duration_seconds=${run.duration_seconds}`, `prior_avg_duration_seconds=${priorDuration.toFixed(0)}`],
      ));
    }
  });

  const byKey = new Map<string, AutoDentAnomalySignal>();
  for (const item of signals) byKey.set(item.dedupe_key, item);
  return [...byKey.values()];
}

export function buildAutoDentAnomalyIncidentBody(
  signal: AutoDentAnomalySignal,
  opts: { progressIssue?: string } = {},
): string {
  const evidence = signal.evidence.map((line) => `- ${line}`).join('\n');
  const progress = opts.progressIssue ? `\n\nProgress issue: ${opts.progressIssue}` : '';
  return [
    '## Incident',
    '',
    signal.summary,
    '',
    `Dedupe key: \`${signal.dedupe_key}\``,
    progress.trim(),
    '',
    '## Evidence',
    '',
    evidence,
    '',
    '## Problem Space',
    '',
    'Auto-dent detected an anomalous run during harness-owned finalization. This may be a real process failure or a false positive in the detector, but it needs durable investigation instead of disappearing into local logs.',
    '',
    '## Directional Guess',
    '',
    'Investigate the linked batch/run evidence first. If the anomaly is real, fix the workflow or guardrail that allowed it. If it is a false positive, tighten the detector and keep this issue as the regression fixture.',
  ].filter((line) => line !== undefined).join('\n');
}

function parseIssueList(output: string): { number: number; url: string } | null {
  if (!output.trim()) return null;
  const parsed = JSON.parse(output) as Array<{ number?: number; url?: string }>;
  const first = parsed[0];
  if (!first?.number || !first.url) return null;
  return { number: first.number, url: first.url };
}

export function fileAutoDentAnomalyIncident(
  repo: string,
  signal: AutoDentAnomalySignal,
  opts: FileAutoDentAnomalyIncidentsOptions = {},
): AutoDentIncidentRef {
  const runGh = opts.gh ?? gh;
  try {
    const found = parseIssueList(runGh([
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--search',
      signal.search_query,
      '--json',
      'number,url',
      '--limit',
      '1',
    ]));
    if (found) {
      return AutoDentIncidentRefSchema.parse({
        signal_key: signal.dedupe_key,
        status: 'reused',
        issue: found.number,
        url: found.url,
      });
    }

    const body = buildAutoDentAnomalyIncidentBody(signal, { progressIssue: opts.progressIssue });
    const args = ['issue', 'create', '--repo', repo, '--title', signal.title, '--body', body];
    for (const label of ANOMALY_INCIDENT_LABELS) args.push('--label', label);
    const url = runGh(args).trim();
    const issue = extractIssueNumber(url);
    if (!issue) throw new Error(`could not parse created issue URL: ${url}`);
    return AutoDentIncidentRefSchema.parse({
      signal_key: signal.dedupe_key,
      status: 'created',
      issue,
      url: issueUrl(repo, issue),
    });
  } catch (err) {
    return AutoDentIncidentRefSchema.parse({
      signal_key: signal.dedupe_key,
      status: 'skipped',
      reason: (err as Error).message,
    });
  }
}

export function fileAutoDentAnomalyIncidentsForBatch(
  repo: string,
  state: BatchState,
  opts: FileAutoDentAnomalyIncidentsOptions = {},
): AutoDentAnomalyIncidentResult {
  const signals = detectAutoDentAnomalies(state).slice(0, opts.maxSignals ?? 10);
  const refs = signals.map((item) => fileAutoDentAnomalyIncident(repo, item, opts));
  const diagnostics = refs
    .filter((ref) => ref.status === 'skipped')
    .map((ref) => `skipped ${ref.signal_key}: ${ref.reason ?? 'unknown error'}`);
  return AutoDentAnomalyIncidentResultSchema.parse({ signals, refs, diagnostics });
}

export function formatAutoDentAnomalyIncidentSummary(result: AutoDentAnomalyIncidentResult): string {
  if (result.signals.length === 0) return '';
  const created = result.refs.filter((ref) => ref.status === 'created');
  const reused = result.refs.filter((ref) => ref.status === 'reused');
  const skipped = result.refs.filter((ref) => ref.status === 'skipped');
  const issueRefs = [...created, ...reused]
    .map((ref) => ref.url ?? (ref.issue ? `#${ref.issue}` : 'unknown'))
    .join(', ');
  const lines = [
    `- **Anomaly incidents:** ${result.signals.length} signal(s); ${created.length} created, ${reused.length} reused, ${skipped.length} skipped`,
  ];
  if (issueRefs) lines.push(`- **Incident refs:** ${issueRefs}`);
  if (skipped.length > 0) lines.push(`- **Incident filing warnings:** ${skipped.map((ref) => ref.reason ?? 'unknown').join('; ')}`);
  return lines.join('\n');
}
