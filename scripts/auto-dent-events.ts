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

import { resolve } from 'path';
import { appendJsonLine } from '../src/lib/json-lines.js';
import type { ProcessVerdict } from './auto-dent-lifecycle.js';
import type { PhaseProviderRecord } from './auto-dent-provider.js';
import type { HookActivationVerdict } from './auto-dent-hook-activation.js';
import type { WorkflowGateId, WorkflowGateState } from './workflow-gate-ledger.js';

// Event type definitions

export interface BanditDecisionDetailTelemetry {
  mode: string;
  plays: number;
  mean_reward: number;
  exploit_term: number;
  explore_bonus: number;
  ucb: number;
  weight: number;
}

export interface BanditDecisionTelemetry {
  selected_mode: string;
  reason: string;
  weights: Record<string, number>;
  details: BanditDecisionDetailTelemetry[];
  total_plays: number;
  exploration_c: number;
}

/** #899: Base fields shared by all auto-dent events */
export interface BaseEvent {
  run_id: string;
  batch_id: string;
  run_num: number;
}

export interface RunStartEvent extends BaseEvent {
  type: 'run.start';
  mode: string;
  mode_reason: string;
  prompt_template: string;
  prompt_hash: string;
  /** Epoch seconds when the run actually started (before runClaude) */
  start_epoch?: number;
}

export interface RunIssuePickedEvent extends BaseEvent {
  type: 'run.issue_picked';
  issue: string;
  title: string;
  labels?: string[];
}

export interface RunPrCreatedEvent extends BaseEvent {
  type: 'run.pr_created';
  pr_url: string;
}

export interface RunCompleteEvent extends BaseEvent {
  type: 'run.complete';
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
  /** Lifecycle health: clean | degraded (ordering) | critical (gaps/phantoms) (#1103) */
  lifecycle_health?: 'clean' | 'degraded' | 'critical';
  /** Count of critical lifecycle findings (gaps + phantom phases) (#1103) */
  lifecycle_critical?: number;
  /** Durable process-evidence verdict (#1149) */
  process_verdict?: ProcessVerdict;
  /** Count of failed/warning process evidence checks (#1149) */
  process_issue_count?: number;
  /** Compact human-readable process evidence summary (#1149) */
  process_summary?: string;
  /** Canonical workflow gate states (#1533). */
  workflow_gate_states?: Partial<Record<WorkflowGateId, WorkflowGateState>>;
  /** Canonical workflow gates that need repair before success/merge readiness (#1533). */
  workflow_repair_gates?: WorkflowGateId[];
  /** Evidence repair loop state for PR-producing incomplete runs (#1533). */
  workflow_repair_state?: 'not_required' | 'repair_scheduled' | 'merge_ready' | 'blocked_with_reason' | 'repair_budget_exhausted';
  /** Targeted repair instruction for the next attempt against the same PR (#1533). */
  workflow_repair_prompt?: string;
  /** Whether this run crossed the context-delegation pressure threshold (#1629). */
  context_delegation_required?: boolean;
  /** Whether this run showed observed subagent/tool delegation before implementation (#1629). */
  context_delegation_observed?: boolean;
  /** Machine-readable context/tool-call pressure reasons (#1629). */
  context_delegation_reasons?: string[];
  /** Default-delegated sub-work suggested by the pressure analysis (#1629). */
  context_delegation_recommended_substeps?: string[];
  outcome: 'success' | 'empty_success' | 'failure' | 'stop';
  /** Cognitive mode used, for context in analysis */
  mode?: string;
  /** Durable UCB1 decision breakdown used for this run's mode selection (#1178). */
  bandit_decision?: BanditDecisionTelemetry;
  /** Review battery verdict for PRs created in this run */
  review_verdict?: 'pass' | 'fail' | 'skipped';
  /** Review battery cost (USD) */
  review_cost_usd?: number;
  /** Hook-activation verdict from the session init event or explicit unknown fallback (#1501). */
  hook_activation?: HookActivationVerdict;
  /**
   * Provider + billing mode per lifecycle phase (#1143, epic #1134).
   * Absent on older events. Keyed by phase → { provider, billing }.
   */
  phase_providers?: PhaseProviderRecord;
}

export interface BatchReflectEvent extends BaseEvent {
  type: 'batch.reflect';
  recommendations_count: number;
}

export interface ReviewRoundStartEvent extends BaseEvent {
  type: 'review.round_start';
  pr_url: string;
  round: number;
  dimensions: string[];
}

export interface ReviewRoundCompleteEvent extends BaseEvent {
  type: 'review.round_complete';
  pr_url: string;
  round: number;
  verdict: 'pass' | 'fail';
  missing_count: number;
  partial_count: number;
  cost_usd: number;
  duration_ms: number;
}

export interface ReviewFixSpawnedEvent extends BaseEvent {
  type: 'review.fix_spawned';
  pr_url: string;
  round: number;
  gaps_count: number;
}

export interface ReviewFixCompleteEvent extends BaseEvent {
  type: 'review.fix_complete';
  pr_url: string;
  round: number;
  success: boolean;
  cost_usd: number;
}

export type AutoDentEvent =
  | RunStartEvent
  | RunIssuePickedEvent
  | RunPrCreatedEvent
  | RunCompleteEvent
  | BatchReflectEvent
  | ReviewRoundStartEvent
  | ReviewRoundCompleteEvent
  | ReviewFixSpawnedEvent
  | ReviewFixCompleteEvent;

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
    this.emitAt(new Date(), event);
  }

  /** Emit an event with an explicit timestamp (for events that must be backdated). */
  emitAt(when: Date, event: AutoDentEvent): void {
    const envelope: EventEnvelope = {
      timestamp: when.toISOString(),
      event,
    };
    try {
      appendJsonLine(this.filePath, envelope);
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
