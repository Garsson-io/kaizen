/**
 * session-telemetry.ts — Lightweight structured telemetry for interactive sessions.
 *
 * Closes the observability gap identified in issue #671: auto-dent has
 * structured events (auto-dent-events.ts) but interactive Claude Code
 * sessions emit nothing.
 *
 * Design:
 *   - Reuses the EventEnvelope wrapper format from auto-dent-events.ts
 *   - Defines session-specific event types (session.pr_created, session.pr_merged)
 *   - Writes JSONL to data/telemetry/events.jsonl (gitignored via data/)
 *   - Best-effort: never blocks or crashes the hook
 *
 * Part of horizon #249 (Observability), issue #671.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Session event types — lightweight versions of auto-dent events

export interface SessionPrCreatedEvent {
  type: 'session.pr_created';
  session_id: string;
  pr_url: string;
  branch: string;
  changed_files_count: number;
}

export interface SessionPrMergedEvent {
  type: 'session.pr_merged';
  session_id: string;
  pr_url: string;
  branch: string;
  changed_files_count: number;
}

export interface SessionReflectionEvent {
  type: 'session.reflection';
  session_id: string;
  pr_url: string;
  impediments_count: number;
}

export interface SessionStopGateEvent {
  type: 'session.stop_gate';
  branch: string;
  decision: 'block' | 'allow';
  gates_count: number;
  gate_types: string[];
  total_state_files: number;
  included_files: number;
  excluded_files: number;
  exclude_reasons: Record<string, number>;
}

export type SessionEvent =
  | SessionPrCreatedEvent
  | SessionPrMergedEvent
  | SessionReflectionEvent
  | SessionStopGateEvent;

export interface SessionEventEnvelope {
  timestamp: string;
  source: 'interactive';
  event: SessionEvent;
}

/**
 * Resolve the telemetry directory for the current project.
 * Uses KAIZEN_TELEMETRY_DIR env var if set, otherwise data/telemetry
 * relative to the git root.
 */
export function resolveTelemetryDir(projectDir?: string): string {
  if (process.env.KAIZEN_TELEMETRY_DIR) {
    return process.env.KAIZEN_TELEMETRY_DIR;
  }
  const base = projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  return resolve(base, 'data', 'telemetry');
}

/**
 * Emit a session telemetry event to the JSONL log.
 * Best-effort: silently ignores errors to never break the calling hook.
 */
export function emitSessionEvent(
  event: SessionEvent,
  options?: { telemetryDir?: string; now?: Date },
): void {
  try {
    const dir = options?.telemetryDir ?? resolveTelemetryDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const filePath = resolve(dir, 'events.jsonl');
    const envelope: SessionEventEnvelope = {
      timestamp: (options?.now ?? new Date()).toISOString(),
      source: 'interactive',
      event,
    };
    appendFileSync(filePath, JSON.stringify(envelope) + '\n');
  } catch {
    // Telemetry is best-effort — never break the hook
  }
}

/**
 * Count newline-separated file list entries.
 */
export function countChangedFiles(changedFiles: string): number {
  if (!changedFiles.trim()) return 0;
  return changedFiles.trim().split('\n').filter(Boolean).length;
}
