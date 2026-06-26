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
 * CRITICAL — the harness captures `claude --output-format stream-json`, so in a
 * real run log the hook payload is NOT a bare top-level line. It is *nested as
 * an escaped JSON string* inside a `hook_response` envelope, e.g.
 *
 *   {"type":"system","subtype":"hook_response","hook_event":"PreToolUse",
 *     "output":"{\"hookSpecificOutput\":{...\"permissionDecision\":\"deny\"...}}",
 *     "stdout":"{\"hookSpecificOutput\":...}", ...}
 *
 * So detection must (a) match a bare payload line (legacy / direct-hook output),
 * AND (b) parse each stream-json envelope and re-scan its de-escaped string
 * leaves (output/stdout/...) for the same three shapes. Both paths are
 * deterministic and contract-coupled. We never match English substrings here —
 * that stays in classifyFailure() only as a documented legacy fallback.
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
 * Try to interpret a chunk of text as one of the JSON deny/block envelopes.
 * Works on a bare log line OR a de-escaped string leaf pulled out of a
 * stream-json envelope. Returns a signal only for genuine rejections.
 */
function jsonSignalFromText(text: string): HookSignal | null {
  const trimmed = text.trim();
  // Cheap pre-filter: only attempt JSON.parse on text that looks like an object.
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
 * Recursively collect the de-escaped string leaves of a parsed JSON value.
 * The real harness shape nests the hook payload as an escaped JSON string in a
 * `hook_response` envelope's `output`/`stdout` fields, so we must re-scan those
 * de-escaped strings. Depth-bounded to stay O(envelope size) on large lines.
 */
function collectStringLeaves(value: unknown, acc: string[], depth = 0): void {
  if (depth > 6) return;
  if (typeof value === 'string') {
    acc.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStringLeaves(v, acc, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStringLeaves(v, acc, depth + 1);
  }
}

/** Stable identity for de-duplicating signals (output and stdout often dupe). */
function signalKey(s: HookSignal): string {
  return `${s.kind}|${s.source}|${s.hook ?? ''}|${s.reason ?? ''}`;
}

/**
 * Detect all structured hook rejections (deny/block) in a run log.
 *
 * Two coupled paths, both contract-based:
 *   - Bare payload lines (direct hook output / legacy): match the line itself.
 *   - stream-json envelopes (real harness, `--output-format stream-json`):
 *     parse the envelope and re-scan its de-escaped string leaves, because the
 *     payload lives nested-and-escaped inside `output`/`stdout` (issue #1102).
 */
export function detectHookSignals(log: string): HookSignal[] {
  if (!log) return [];
  const signals: HookSignal[] = [];

  for (const line of log.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // (a) bare payload line — the whole line IS the hook JSON.
    const bare = jsonSignalFromText(trimmed);
    if (bare) signals.push(bare);

    // (b) stream-json envelope — re-scan de-escaped string leaves for the same
    //     JSON and canonical-YAML shapes nested inside output/stdout/etc.
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      let env: unknown;
      try {
        env = JSON.parse(trimmed);
      } catch {
        env = null;
      }
      if (env && typeof env === 'object') {
        const leaves: string[] = [];
        collectStringLeaves(env, leaves);
        for (const leaf of leaves) {
          const inner = jsonSignalFromText(leaf);
          if (inner) signals.push(inner);
          signals.push(...yamlSignals(leaf));
        }
      }
    }
  }

  // Canonical YAML emitted as bare `---` fences directly in the log.
  signals.push(...yamlSignals(log));

  // De-duplicate: the same rejection surfaces in both `output` and `stdout`.
  const seen = new Set<string>();
  return signals.filter((s) => {
    const key = signalKey(s);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
