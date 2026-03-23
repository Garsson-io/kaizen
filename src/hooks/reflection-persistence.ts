/**
 * reflection-persistence.ts — Persist kaizen reflections to searchable JSONL.
 *
 * Closes the observability gap where KAIZEN_IMPEDIMENTS data was only in
 * PR comments and flat audit logs. Stores full structured reflection records
 * in data/telemetry/reflections.jsonl, enabling:
 *   - Gap analysis: aggregate by category, find recurring friction
 *   - Quality trends: track filed vs no-action ratio over time
 *   - Cross-session learning: future agents can query past reflections
 *
 * Part of horizon #249 (Observability), issue #272.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveTelemetryDir } from './session-telemetry.js';

export interface ReflectionImpediment {
  impediment?: string;
  finding?: string;
  type?: string;
  disposition?: string;
  ref?: string;
  reason?: string;
  impact_minutes?: number;
}

export interface ReflectionRecord {
  timestamp: string;
  pr_url: string;
  branch: string;
  clear_type: 'impediments' | 'no-action' | 'empty-array';
  clear_reason: string;
  quality: 'high' | 'medium' | 'low' | 'empty';
  impediments: ReflectionImpediment[];
  counts: {
    total: number;
    filed: number;
    fixed_in_pr: number;
    incident: number;
    no_action: number;
  };
}

function countByDisposition(
  items: ReflectionImpediment[],
  disposition: string,
): number {
  return items.filter((i) => i.disposition === disposition).length;
}

export function buildReflectionRecord(options: {
  prUrl: string;
  branch: string;
  clearType: 'impediments' | 'no-action' | 'empty-array';
  clearReason: string;
  quality: 'high' | 'medium' | 'low' | 'empty';
  impediments: ReflectionImpediment[];
  now?: Date;
}): ReflectionRecord {
  return {
    timestamp: (options.now ?? new Date()).toISOString(),
    pr_url: options.prUrl,
    branch: options.branch,
    clear_type: options.clearType,
    clear_reason: options.clearReason,
    quality: options.quality,
    impediments: options.impediments,
    counts: {
      total: options.impediments.length,
      filed: countByDisposition(options.impediments, 'filed'),
      fixed_in_pr: countByDisposition(options.impediments, 'fixed-in-pr'),
      incident: countByDisposition(options.impediments, 'incident'),
      no_action: countByDisposition(options.impediments, 'no-action'),
    },
  };
}

/**
 * Persist a reflection record to reflections.jsonl.
 * Best-effort: never throws — telemetry must not break the hook.
 */
export function persistReflection(
  record: ReflectionRecord,
  options?: { telemetryDir?: string },
): void {
  try {
    const dir = options?.telemetryDir ?? resolveTelemetryDir();
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, 'reflections.jsonl');
    appendFileSync(filePath, JSON.stringify(record) + '\n');
  } catch {
    // Best-effort — never break the hook
  }
}
