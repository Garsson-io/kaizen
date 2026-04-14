/**
 * hook-gym-stream.ts — Parse hook events from --include-hook-events stream.
 *
 * Claude CLI emits hook lifecycle events as type:"system" messages with
 * subtypes "hook_started" and "hook_response". This module correlates
 * start/response pairs by hook_id and produces a HookTimeline.
 *
 * Also delegates non-hook messages to auto-dent-stream's processStreamMessage
 * for tool use tracking, phase markers, and artifact extraction.
 */

import type {
  HookStartedEvent,
  HookResponseEvent,
  ParsedHookEvent,
  HookTimeline,
} from './hook-gym-schema.js';
import { parseGateSignal } from '../src/hooks/lib/gate-signal.js';

// ── Gate detection patterns ────────────────────────────────────────

// Gate detection patterns — updated from Hook Gym smoke run (PR #1047).
// Real hooks emit human-readable text, not STATUS=<gate> tokens:
//   - pr-review-loop.ts emits "MANDATORY SELF-REVIEW LOOP" and "ROUND N/M"
//   - kaizen-reflect.ts emits "KAIZEN REFLECTION" and "GATED"
//   - stop-gate.ts emits {"decision":"block","reason":"...PR REVIEW...KAIZEN REFLECTION..."}
//
// The patterns below match both the literal gate name (for structured/state-file
// contexts) AND the human-readable phrases from real hook stdout.

const GATE_SET_PATTERNS: Record<string, RegExp> = {
  needs_review: /needs_review|STATUS=needs_review|MANDATORY SELF-REVIEW LOOP|PR REVIEW.*round/i,
  needs_pr_kaizen: /needs_pr_kaizen|STATUS=needs_pr_kaizen|KAIZEN REFLECTION|GATED.*kaizen-bg/i,
  needs_post_merge: /needs_post_merge|STATUS=needs_post_merge|POST-MERGE|post.merge.*sync/i,
};

// CLEAR patterns must NOT match quoted instructions. Real hooks often include
// the gate-clearing command as an instruction to the agent (e.g. 'state
// "REVIEW PASSED"' or 'echo KAIZEN_IMPEDIMENTS: [...]'). Those are SET signals
// (the hook is telling the agent what to do), not CLEAR signals.
//
// Real CLEAR signals:
//   - pr-review-loop.ts: "✅ REVIEW PASSED" at start of line, STATUS=passed
//   - kaizen-reflect.ts: agent actually runs KAIZEN_IMPEDIMENTS/KAIZEN_UNFINISHED
//     which appears as a PostToolUse Bash stdout starting with "KAIZEN_IMPEDIMENTS:"
//     or "KAIZEN_UNFINISHED:", not as a hook output mentioning the keyword
//
// Strategy: require CLEAR patterns to be anchored or preceded by non-instruction
// context. The `^` + multiline flag catches start-of-line patterns.
const GATE_CLEAR_PATTERNS: Record<string, RegExp> = {
  needs_review: /STATUS=passed|review_passed|✅\s*REVIEW PASSED|^REVIEW PASSED|clear(?:ed|ing)\s+needs_review/im,
  needs_pr_kaizen: /^KAIZEN_IMPEDIMENTS:|^KAIZEN_UNFINISHED:|cleared.*kaizen|clear(?:ed|ing)\s+needs_pr_kaizen/im,
  needs_post_merge: /STATUS=post_merge_clear|^post.merge.*cleared|clear(?:ed|ing)\s+needs_post_merge/im,
};

// ── Decision parsing ───────────────────────────────────────────────

/**
 * Parse the hook's output field to determine what decision it made.
 * Returns the decision type and optional reason text.
 */
export function parseHookDecision(
  output: string,
  stderrOrStdout: string,
  exitCode: number,
  extraStdout: string = '',
): { decision: ParsedHookEvent['decision']; reason: string | null } {
  // ── YAML hook output (preferred path) ───────────────────────────
  // All hooks that emit advisory text use the HookOutput YAML schema.
  // Check output first, then combined stdout/stderr.
  const combined = `${stderrOrStdout}\n${extraStdout}`;
  for (const text of [output, combined]) {
    if (!text) continue;
    const signal = parseGateSignal(text);
    if (signal) {
      if (signal.type === 'gate-set') return { decision: 'set-gate', reason: signal.gate ?? signal.reason };
      if (signal.type === 'gate-clear') return { decision: 'clear-gate', reason: signal.gate ?? signal.reason };
      if (signal.type === 'deny') return { decision: 'deny', reason: signal.reason };
      if (signal.type === 'block') return { decision: 'block', reason: signal.reason };
      // warn/info — not a gate decision, but the hook fired
      return { decision: 'none', reason: signal.reason };
    }
  }

  // ── Regex fallback (for hooks not yet upgraded to YAML signals) ──
  // Check CLEAR patterns before SET so phrases like "clearing needs_review"
  // or "STATUS=passed" aren't misclassified as set-gate when the underlying
  // gate name also matches the SET regex.
  const scanForGatePatterns = (): { decision: ParsedHookEvent['decision']; reason: string | null } | null => {
    for (const [gate, pattern] of Object.entries(GATE_CLEAR_PATTERNS)) {
      if (pattern.test(output) || pattern.test(combined)) {
        return { decision: 'clear-gate', reason: gate };
      }
    }
    for (const [gate, pattern] of Object.entries(GATE_SET_PATTERNS)) {
      if (pattern.test(output) || pattern.test(combined)) {
        return { decision: 'set-gate', reason: gate };
      }
    }
    return null;
  };

  if (!output && exitCode === 0) {
    const gateResult = scanForGatePatterns();
    if (gateResult) return gateResult;
    return { decision: 'none', reason: null };
  }

  // Try parsing as JSON
  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch {
    // Not JSON — fall back to raw pattern scan
    const gateResult = scanForGatePatterns();
    if (gateResult) return gateResult;
    return { decision: 'none', reason: null };
  }

  // PreToolUse deny
  if (parsed?.hookSpecificOutput?.permissionDecision === 'deny') {
    return {
      decision: 'deny',
      reason: parsed.hookSpecificOutput.permissionDecisionReason ?? null,
    };
  }

  // PreToolUse allow (explicit)
  if (parsed?.hookSpecificOutput?.permissionDecision === 'allow') {
    return { decision: 'allow', reason: null };
  }

  // Stop/PostToolUse block
  if (parsed?.decision === 'block') {
    return { decision: 'block', reason: parsed.reason ?? null };
  }

  // Check for gate patterns in parsed output (CLEAR before SET — see above).
  const outputStr = JSON.stringify(parsed);
  for (const [gate, pattern] of Object.entries(GATE_CLEAR_PATTERNS)) {
    if (pattern.test(outputStr)) {
      return { decision: 'clear-gate', reason: gate };
    }
  }
  for (const [gate, pattern] of Object.entries(GATE_SET_PATTERNS)) {
    if (pattern.test(outputStr)) {
      return { decision: 'set-gate', reason: gate };
    }
  }

  return { decision: 'none', reason: null };
}

// ── Stream processor ───────────────────────────────────────────────

interface PendingHook {
  startedAt: number; // ms since epoch
  event: HookStartedEvent;
}

/**
 * Accumulates hook events from the stream and produces a HookTimeline.
 *
 * Usage:
 *   const processor = createHookStreamProcessor();
 *   for (const msg of streamMessages) {
 *     processor.process(msg);
 *   }
 *   const timeline = processor.getTimeline();
 */
export function createHookStreamProcessor() {
  const pending = new Map<string, PendingHook>(); // hook_id → pending
  const events: ParsedHookEvent[] = [];
  const gatesActivated: Record<string, number> = {};
  const gatesCleared: Record<string, number> = {};
  const runStart = Date.now();

  return {
    /**
     * Process a single stream-json message. Returns true if it was a hook event.
     */
    process(msg: Record<string, any>): boolean {
      if (msg.type !== 'system') return false;

      if (msg.subtype === 'hook_started') {
        pending.set(msg.hook_id, {
          startedAt: Date.now(),
          event: msg as HookStartedEvent,
        });
        return true;
      }

      if (msg.subtype === 'hook_response') {
        const start = pending.get(msg.hook_id);
        const now = Date.now();
        const durationMs = start ? now - start.startedAt : 0;
        const timestamp = now - runStart;

        const hookEvent = (msg as HookResponseEvent);
        const { decision, reason } = parseHookDecision(
          hookEvent.output ?? '',
          hookEvent.stderr ?? '',
          hookEvent.exit_code,
          hookEvent.stdout ?? '',
        );

        const parsed: ParsedHookEvent = {
          timestamp,
          eventType: hookEvent.hook_event,
          hookId: hookEvent.hook_id,
          hookName: hookEvent.hook_name,
          durationMs,
          exitCode: hookEvent.exit_code,
          outcome: hookEvent.outcome,
          decision,
          reason,
          rawOutput: hookEvent.output ?? '',
          stderr: hookEvent.stderr || null,
        };

        events.push(parsed);

        // Track gate lifecycle
        if (decision === 'set-gate' && reason) {
          if (!gatesActivated[reason]) {
            gatesActivated[reason] = timestamp;
          }
        }
        if (decision === 'clear-gate' && reason) {
          gatesCleared[reason] = timestamp;
        }
        // Stop block implies gates are active
        if (decision === 'block' && hookEvent.hook_event === 'Stop') {
          // Parse gate names from the block reason
          if (reason) {
            for (const gate of Object.keys(GATE_SET_PATTERNS)) {
              if (reason.toLowerCase().includes(gate.replace(/_/g, ' ')) ||
                  reason.toLowerCase().includes(gate)) {
                if (!gatesActivated[gate]) {
                  gatesActivated[gate] = timestamp;
                }
              }
            }
          }
        }

        pending.delete(msg.hook_id);
        return true;
      }

      return false;
    },

    /** Get the accumulated timeline. */
    getTimeline(): HookTimeline {
      return {
        events: [...events],
        gatesActivated: { ...gatesActivated },
        gatesCleared: { ...gatesCleared },
      };
    },

    /** Get events filtered by type. */
    getEventsByType(eventType: string): ParsedHookEvent[] {
      return events.filter((e) => e.eventType === eventType);
    },

    /** Get all denials. */
    getDenials(): ParsedHookEvent[] {
      return events.filter((e) => e.decision === 'deny');
    },

    /** Get all blocks. */
    getBlocks(): ParsedHookEvent[] {
      return events.filter((e) => e.decision === 'block');
    },

    /** Get all errors (non-zero exit, stderr). */
    getErrors(): ParsedHookEvent[] {
      return events.filter(
        (e) => e.exitCode !== 0 || (e.stderr && e.outcome !== 'success'),
      );
    },
  };
}

/**
 * Parse a complete log file (newline-delimited JSON) and extract hook timeline.
 * Skips non-JSON lines (stderr mixed into log).
 */
export function parseLogFile(logContent: string): HookTimeline {
  const processor = createHookStreamProcessor();
  for (const line of logContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      processor.process(msg);
    } catch {
      // Skip non-JSON lines
    }
  }
  return processor.getTimeline();
}
