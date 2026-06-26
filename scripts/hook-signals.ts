/**
 * hook-signals.ts — Structured detection of kaizen hook rejections in a run log.
 *
 * The auto-dent harness and the kaizen hooks share a structured contract for
 * "this tool/stop/push was blocked". This module lets the harness consume that
 * contract instead of guessing from English prose (issue #1102).
 *
 * Three structured shapes a kaizen hook can emit into a run log:
 *
 *   1. PreToolUse deny (JSON, e.g. enforce-plan-stored, check-dirty-files):
 *        {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *          "permissionDecision":"deny","permissionDecisionReason":"..."}}
 *
 *   2. Stop / decision block (JSON, e.g. stop-gate):
 *        {"decision":"block","reason":"..."}
 *
 *   3. Canonical hook output (YAML, gate-signal.ts via formatHookOutput):
 *        ---
 *        hook: check-dirty-files
 *        type: deny|block
 *        reason: ...
 *        ---
 *
 * All three are deterministic. We never match English substrings here — that
 * stays in classifyFailure() only as a documented legacy fallback.
 */

import { z } from 'zod';
import { parseHookOutput } from '../src/hooks/lib/gate-signal.js';

export type HookSignalSource = 'permission-decision' | 'stop-decision' | 'canonical-yaml';

export interface HookSignal {
  /** 'deny' = PreToolUse blocked; 'block' = Stop/session blocked. */
  kind: 'deny' | 'block';
  /** Which structured shape it was parsed from. */
  source: HookSignalSource;
  /** Hook name, when the shape carries one (canonical YAML). */
  hook?: string;
  /** Human-readable rejection reason, for observability. */
  reason?: string;
}

// Zod schemas for the two JSON envelopes — no hand-rolled parsing (invariant I29).
const PermissionDecisionSchema = z.object({
  hookSpecificOutput: z.object({
    permissionDecision: z.string(),
    permissionDecisionReason: z.string().optional(),
  }),
});

const StopDecisionSchema = z.object({
  decision: z.string(),
  reason: z.string().optional(),
});

/**
 * Try to parse a single line as one of the JSON deny/block envelopes.
 * Returns a signal only for genuine rejections (deny / block).
 */
function jsonSignalFromLine(line: string): HookSignal | null {
  const trimmed = line.trim();
  // Cheap pre-filter: only attempt JSON.parse on lines that look like an object.
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const perm = PermissionDecisionSchema.safeParse(parsed);
  if (perm.success && perm.data.hookSpecificOutput.permissionDecision === 'deny') {
    return {
      kind: 'deny',
      source: 'permission-decision',
      reason: perm.data.hookSpecificOutput.permissionDecisionReason,
    };
  }

  const stop = StopDecisionSchema.safeParse(parsed);
  if (stop.success && stop.data.decision === 'block') {
    return { kind: 'block', source: 'stop-decision', reason: stop.data.reason };
  }

  return null;
}

/**
 * Extract canonical-YAML hook outputs (gate-signal.ts) of type deny/block.
 * The YAML blocks are delimited by `---` fences and may appear anywhere in the
 * log, so we scan each fenced block independently.
 */
function yamlSignals(log: string): HookSignal[] {
  const signals: HookSignal[] = [];
  // Match each `---\n...\n---` fenced block; parseHookOutput validates content.
  const fenceRe = /^---\n[\s\S]*?\n---/gm;
  const blocks = log.match(fenceRe);
  if (!blocks) return signals;
  for (const block of blocks) {
    const output = parseHookOutput(block);
    if (output && (output.type === 'deny' || output.type === 'block')) {
      signals.push({
        kind: output.type,
        source: 'canonical-yaml',
        hook: output.hook,
        reason: output.reason,
      });
    }
  }
  return signals;
}

/**
 * Detect all structured hook rejections (deny/block) in a run log.
 */
export function detectHookSignals(log: string): HookSignal[] {
  if (!log) return [];
  const signals: HookSignal[] = [];

  for (const line of log.split('\n')) {
    const sig = jsonSignalFromLine(line);
    if (sig) signals.push(sig);
  }
  signals.push(...yamlSignals(log));

  return signals;
}

/** True if the run log contains any structured hook deny/block. */
export function hasHookRejection(log: string): boolean {
  return detectHookSignals(log).length > 0;
}

/** First rejection reason in the log, for compact observability display. */
export function firstHookReason(log: string): string | undefined {
  for (const sig of detectHookSignals(log)) {
    if (sig.reason) return sig.reason;
  }
  return undefined;
}
