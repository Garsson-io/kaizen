/**
 * auto-dent-events — Structured JSON event telemetry for auto-dent runs.
 *
 * Emits machine-parseable JSONL events to `<batch_dir>/events.jsonl`.
 * Enables post-batch analysis, trend detection, and dashboard potential
 * without parsing prose logs.
 *
 * Event types:
 *   run.start        — run begins (mode, prompt, batch context)
 *   run.issue_picked — issue selected for work
 *   run.pr_created   — PR created during run
 *   run.complete     — run finished (duration, outcome, cost)
 *   batch.reflect    — reflection/contemplation results
 *
 * See issue #647, parent horizon #249 (Observability).
 */

import { appendFileSync } from 'fs';
import { resolve } from 'path';

// Event type definitions

export interface RunStartEvent {
  type: 'run.start';
  run_id: string;
  batch_id: string;
  run_num: number;
  mode: string;
  mode_reason: string;
  prompt_template: string;
  prompt_hash: string;
}

export interface RunIssuePickedEvent {
  type: 'run.issue_picked';
  run_id: string;
  batch_id: string;
  run_num: number;
  issue: string;
  title: string;
  labels?: string[];
}

export interface RunPrCreatedEvent {
  type: 'run.pr_created';
  run_id: string;
  batch_id: string;
  run_num: number;
  pr_url: string;
}

export interface RunCompleteEvent {
  type: 'run.complete';
  run_id: string;
  batch_id: string;
  run_num: number;
  duration_ms: number;
  exit_code: number;
  cost_usd: number;
  tool_calls: number;
  prs_created: number;
  issues_filed: number;
  issues_closed: number;
  stop_requested: boolean;
  failure_class?: string;
  lifecycle_violations: number;
  outcome: 'success' | 'failure' | 'stop';
}

export interface BatchReflectEvent {
  type: 'batch.reflect';
  run_id: string;
  batch_id: string;
  run_num: number;
  recommendations_count: number;
}

export type AutoDentEvent =
  | RunStartEvent
  | RunIssuePickedEvent
  | RunPrCreatedEvent
  | RunCompleteEvent
  | BatchReflectEvent;

// Event envelope wraps every event with timestamp

export interface EventEnvelope {
  timestamp: string;
  event: AutoDentEvent;
}

/**
 * EventEmitter writes structured JSONL events to a file.
 *
 * Usage:
 *   const emitter = new EventEmitter(logDir);
 *   emitter.emit({ type: 'run.start', ... });
 *
 * Each call appends one JSON line to `<logDir>/events.jsonl`.
 */
export class EventEmitter {
  private readonly filePath: string;

  constructor(logDir: string) {
    this.filePath = resolve(logDir, 'events.jsonl');
  }

  emit(event: AutoDentEvent): void {
    const envelope: EventEnvelope = {
      timestamp: new Date().toISOString(),
      event,
    };
    try {
      appendFileSync(this.filePath, JSON.stringify(envelope) + '\n');
    } catch {
      // Telemetry is best-effort — never break the run
    }
  }

  /** Return the path to the events file (for testing/debugging). */
  getFilePath(): string {
    return this.filePath;
  }
}

/**
 * Build a run ID from batch_id and run number.
 * Format: `<batch_id>/run-<N>` — same as the run tag used in prompts.
 */
export function makeRunId(batchId: string, runNum: number): string {
  return `${batchId}/run-${runNum}`;
}
