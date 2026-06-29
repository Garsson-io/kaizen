import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
import { parseJsonLinesWithMalformedRows } from '../src/lib/json-lines.js';
import type {
  EventEnvelope,
  RunCompleteEvent,
  RunIssuePickedEvent,
  RunPrCreatedEvent,
  RunStartEvent,
} from './auto-dent-events.js';

const baseEventSchema = z.object({
  run_id: z.string(),
  batch_id: z.string(),
  run_num: z.number().int().nonnegative(),
});

const runStartEventSchema = baseEventSchema.extend({
  type: z.literal('run.start'),
  mode: z.string(),
  mode_reason: z.string(),
  prompt_template: z.string(),
  prompt_hash: z.string(),
  start_epoch: z.number().optional(),
}).passthrough();

const runIssuePickedEventSchema = baseEventSchema.extend({
  type: z.literal('run.issue_picked'),
  issue: z.string(),
  title: z.string(),
  labels: z.array(z.string()).optional(),
}).passthrough();

const runPrCreatedEventSchema = baseEventSchema.extend({
  type: z.literal('run.pr_created'),
  pr_url: z.string(),
}).passthrough();

const runCompleteEventSchema = baseEventSchema.extend({
  type: z.literal('run.complete'),
  duration_ms: z.number(),
  exit_code: z.number().int(),
  cost_usd: z.number(),
  tool_calls: z.number().int(),
  prs_created: z.number().int(),
  issues_filed: z.number().int(),
  issues_closed: z.number().int(),
  stop_requested: z.boolean(),
  lifecycle_violations: z.number().int(),
  outcome: z.enum(['success', 'empty_success', 'failure', 'stop']),
}).passthrough();

const batchReflectEventSchema = baseEventSchema.extend({
  type: z.literal('batch.reflect'),
  recommendations_count: z.number().int(),
}).passthrough();

const reviewRoundStartEventSchema = baseEventSchema.extend({
  type: z.literal('review.round_start'),
  pr_url: z.string(),
  round: z.number().int(),
  dimensions: z.array(z.string()),
}).passthrough();

const reviewRoundCompleteEventSchema = baseEventSchema.extend({
  type: z.literal('review.round_complete'),
  pr_url: z.string(),
  round: z.number().int(),
  verdict: z.enum(['pass', 'fail']),
  missing_count: z.number().int(),
  partial_count: z.number().int(),
  cost_usd: z.number(),
  duration_ms: z.number(),
}).passthrough();

const reviewFixSpawnedEventSchema = baseEventSchema.extend({
  type: z.literal('review.fix_spawned'),
  pr_url: z.string(),
  round: z.number().int(),
  gaps_count: z.number().int(),
}).passthrough();

const reviewFixCompleteEventSchema = baseEventSchema.extend({
  type: z.literal('review.fix_complete'),
  pr_url: z.string(),
  round: z.number().int(),
  success: z.boolean(),
  cost_usd: z.number(),
}).passthrough();

export const autoDentEventSchema = z.discriminatedUnion('type', [
  runStartEventSchema,
  runIssuePickedEventSchema,
  runPrCreatedEventSchema,
  runCompleteEventSchema,
  batchReflectEventSchema,
  reviewRoundStartEventSchema,
  reviewRoundCompleteEventSchema,
  reviewFixSpawnedEventSchema,
  reviewFixCompleteEventSchema,
]);

export const autoDentEventEnvelopeSchema = z.object({
  timestamp: z.string().min(1),
  event: autoDentEventSchema,
}).passthrough();

export interface ReplayInvalidRow {
  lineNumber: number;
  raw: string;
  message: string;
}

export interface ReplaySummary {
  batchIds: string[];
  runIds: string[];
  runNumbers: number[];
  eventCounts: Record<string, number>;
}

export interface ReplayEventsResult {
  sourcePath?: string;
  events: EventEnvelope[];
  malformedRows: Array<{ lineNumber: number; raw: string }>;
  invalidRows: ReplayInvalidRow[];
  summary: ReplaySummary;
}

export interface ReplayRunProjection {
  batch_id: string;
  run_id: string;
  run: number;
  run_num: number;
  start_timestamp?: string;
  complete_timestamp?: string;
  start_epoch?: number;
  mode?: string;
  mode_reason?: string;
  prompt_template?: string;
  prompt_hash?: string;
  issue?: string;
  issue_title?: string;
  labels?: string[];
  prs: string[];
  duration_seconds?: number;
  exit_code?: number;
  cost_usd?: number;
  cost_integrity_warnings?: string[];
  tool_calls?: number;
  prs_created?: number;
  issues_filed_count?: number;
  issues_closed_count?: number;
  stop_requested?: boolean;
  failure_class?: string;
  lifecycle_violations?: number;
  lifecycle_health?: RunCompleteEvent['lifecycle_health'];
  lifecycle_critical?: number;
  process_verdict?: RunCompleteEvent['process_verdict'];
  process_issue_count?: number;
  process_summary?: string;
  workflow_gate_states?: RunCompleteEvent['workflow_gate_states'];
  workflow_repair_gates?: RunCompleteEvent['workflow_repair_gates'];
  workflow_repair_state?: RunCompleteEvent['workflow_repair_state'];
  workflow_repair_prompt?: string;
  context_delegation_required?: boolean;
  context_delegation_observed?: boolean;
  context_delegation_reasons?: string[];
  context_delegation_recommended_substeps?: string[];
  review_verdict?: RunCompleteEvent['review_verdict'];
  review_cost_usd?: number;
  phase_providers?: RunCompleteEvent['phase_providers'];
  hook_activation?: RunCompleteEvent['hook_activation'];
  bandit_decision?: RunCompleteEvent['bandit_decision'];
  outcome?: RunCompleteEvent['outcome'];
  missingFromEvents: string[];
  warnings: string[];
}

interface MutableProjection {
  projection: ReplayRunProjection;
  observedTypes: Set<EventEnvelope['event']['type']>;
}

function summarizeReplay(events: EventEnvelope[]): ReplaySummary {
  const batchIds = new Set<string>();
  const runIds = new Set<string>();
  const runNumbers = new Set<number>();
  const eventCounts: Record<string, number> = {};

  for (const envelope of events) {
    batchIds.add(envelope.event.batch_id);
    runIds.add(envelope.event.run_id);
    runNumbers.add(envelope.event.run_num);
    eventCounts[envelope.event.type] = (eventCounts[envelope.event.type] ?? 0) + 1;
  }

  return {
    batchIds: [...batchIds].sort(),
    runIds: [...runIds].sort(),
    runNumbers: [...runNumbers].sort((a, b) => a - b),
    eventCounts,
  };
}

export function parseReplayEventsJsonl(content: string, sourcePath?: string): ReplayEventsResult {
  const parsed = parseJsonLinesWithMalformedRows<unknown>(content);
  const rawLines = content.split(/\r?\n/);
  const events: EventEnvelope[] = [];
  const invalidRows: ReplayInvalidRow[] = [];

  for (const row of parsed.rowsWithLineNumbers) {
    const result = autoDentEventEnvelopeSchema.safeParse(row.value);
    if (result.success) {
      events.push(result.data as EventEnvelope);
      continue;
    }
    invalidRows.push({
      lineNumber: row.lineNumber,
      raw: rawLines[row.lineNumber - 1] ?? '',
      message: result.error.issues.map((issue) => issue.message).join('; '),
    });
  }

  return {
    sourcePath,
    events,
    malformedRows: parsed.malformed,
    invalidRows,
    summary: summarizeReplay(events),
  };
}

export function readReplayEventsFile(eventsPath: string): ReplayEventsResult {
  const sourcePath = resolve(eventsPath);
  if (!existsSync(sourcePath)) {
    throw new Error(`events.jsonl not found: ${sourcePath}`);
  }
  return parseReplayEventsJsonl(readFileSync(sourcePath, 'utf8'), sourcePath);
}

export function replayCapturedRun(runDir: string): ReplayEventsResult {
  return readReplayEventsFile(join(runDir, 'events.jsonl'));
}

function getOrCreateProjection(
  projections: Map<string, MutableProjection>,
  envelope: EventEnvelope,
): MutableProjection {
  const { event } = envelope;
  const existing = projections.get(event.run_id);
  if (existing) return existing;

  const created: MutableProjection = {
    projection: {
      batch_id: event.batch_id,
      run_id: event.run_id,
      run: event.run_num,
      run_num: event.run_num,
      prs: [],
      missingFromEvents: [],
      warnings: [],
    },
    observedTypes: new Set(),
  };
  projections.set(event.run_id, created);
  return created;
}

function applyRunStart(projection: ReplayRunProjection, envelope: EventEnvelope & { event: RunStartEvent }): void {
  projection.start_timestamp = envelope.timestamp;
  projection.start_epoch = envelope.event.start_epoch;
  projection.mode = envelope.event.mode;
  projection.mode_reason = envelope.event.mode_reason;
  projection.prompt_template = envelope.event.prompt_template;
  projection.prompt_hash = envelope.event.prompt_hash;
}

function applyIssuePicked(projection: ReplayRunProjection, event: RunIssuePickedEvent): void {
  projection.issue = event.issue;
  projection.issue_title = event.title;
  projection.labels = event.labels;
}

function applyPrCreated(projection: ReplayRunProjection, event: RunPrCreatedEvent): void {
  if (!projection.prs.includes(event.pr_url)) projection.prs.push(event.pr_url);
}

function applyRunComplete(projection: ReplayRunProjection, envelope: EventEnvelope & { event: RunCompleteEvent }): void {
  const event = envelope.event;
  projection.complete_timestamp = envelope.timestamp;
  projection.duration_seconds = Math.round(event.duration_ms / 1000);
  projection.exit_code = event.exit_code;
  projection.cost_usd = event.cost_usd;
  projection.cost_integrity_warnings = event.cost_integrity_warnings;
  projection.tool_calls = event.tool_calls;
  projection.prs_created = event.prs_created;
  projection.issues_filed_count = event.issues_filed;
  projection.issues_closed_count = event.issues_closed;
  projection.stop_requested = event.stop_requested;
  projection.failure_class = event.failure_class;
  projection.lifecycle_violations = event.lifecycle_violations;
  projection.lifecycle_health = event.lifecycle_health;
  projection.lifecycle_critical = event.lifecycle_critical;
  projection.process_verdict = event.process_verdict;
  projection.process_issue_count = event.process_issue_count;
  projection.process_summary = event.process_summary;
  projection.workflow_gate_states = event.workflow_gate_states;
  projection.workflow_repair_gates = event.workflow_repair_gates;
  projection.workflow_repair_state = event.workflow_repair_state;
  projection.workflow_repair_prompt = event.workflow_repair_prompt;
  projection.context_delegation_required = event.context_delegation_required;
  projection.context_delegation_observed = event.context_delegation_observed;
  projection.context_delegation_reasons = event.context_delegation_reasons;
  projection.context_delegation_recommended_substeps = event.context_delegation_recommended_substeps;
  projection.review_verdict = event.review_verdict;
  projection.review_cost_usd = event.review_cost_usd;
  projection.phase_providers = event.phase_providers;
  projection.hook_activation = event.hook_activation;
  projection.bandit_decision = event.bandit_decision;
  projection.outcome = event.outcome;
  if (event.mode && !projection.mode) projection.mode = event.mode;
}

function finalizeProjection(entry: MutableProjection): ReplayRunProjection {
  const missing = new Set(entry.projection.missingFromEvents);
  if (!entry.observedTypes.has('run.start')) missing.add('run.start');
  if (!entry.observedTypes.has('run.complete')) missing.add('run.complete');

  // events.jsonl currently records counts for these fields, not stable identities.
  // Keep the absence explicit so #1680 does not silently fabricate state arrays.
  missing.add('cases');
  missing.add('issues_filed');
  missing.add('issues_closed');

  return {
    ...entry.projection,
    missingFromEvents: [...missing].sort(),
  };
}

export function projectReplayRuns(input: EventEnvelope[] | ReplayEventsResult): ReplayRunProjection[] {
  const events = Array.isArray(input) ? input : input.events;
  const projections = new Map<string, MutableProjection>();

  for (const envelope of events) {
    const entry = getOrCreateProjection(projections, envelope);
    entry.observedTypes.add(envelope.event.type);

    switch (envelope.event.type) {
      case 'run.start':
        applyRunStart(entry.projection, envelope as EventEnvelope & { event: RunStartEvent });
        break;
      case 'run.issue_picked':
        applyIssuePicked(entry.projection, envelope.event);
        break;
      case 'run.pr_created':
        applyPrCreated(entry.projection, envelope.event);
        break;
      case 'run.complete':
        applyRunComplete(entry.projection, envelope as EventEnvelope & { event: RunCompleteEvent });
        break;
      default:
        break;
    }
  }

  return [...projections.values()]
    .map(finalizeProjection)
    .sort((a, b) => a.run_num - b.run_num || a.run_id.localeCompare(b.run_id));
}
