import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
import { parseJsonLinesWithMalformedRows } from '../src/lib/json-lines.js';
import type { EventEnvelope } from './auto-dent-events.js';

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
