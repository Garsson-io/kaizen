/**
 * hook-gym-schema.ts — TypeScript types for Hook Gym.
 *
 * All types for hook events, scenarios, scoring, and iteration tracking.
 * Uses plain TypeScript (no Zod) — data comes from Claude CLI (controlled format).
 */

// ── Hook Event (from --include-hook-events stream) ─────────────────

/** Raw hook_started event from Claude CLI stream-json. */
export interface HookStartedEvent {
  type: 'system';
  subtype: 'hook_started';
  hook_id: string;
  hook_name: string; // "EventType:groupName" e.g. "SessionStart:startup"
  hook_event: string; // SessionStart, PreToolUse, PostToolUse, Stop
  uuid: string;
  session_id: string;
}

/** Raw hook_response event from Claude CLI stream-json. */
export interface HookResponseEvent {
  type: 'system';
  subtype: 'hook_response';
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  exit_code: number;
  outcome: string; // "success", "error", "timeout"
  uuid: string;
  session_id: string;
}

// ── Parsed Hook Event (enriched) ───────────────────────────────────

export type HookDecision = 'deny' | 'allow' | 'block' | 'set-gate' | 'clear-gate' | 'none';

export interface ParsedHookEvent {
  /** ms since run start */
  timestamp: number;
  /** SessionStart, PreToolUse, PostToolUse, Stop */
  eventType: string;
  /** hook_id from stream (correlates start/response) */
  hookId: string;
  /** Raw hook_name from stream (e.g. "PreToolUse:Bash") */
  hookName: string;
  /** Duration in ms (response - started) */
  durationMs: number;
  /** Exit code from hook process */
  exitCode: number;
  /** Outcome string from CLI */
  outcome: string;
  /** Parsed decision */
  decision: HookDecision | null;
  /** Reason text from deny/block response */
  reason: string | null;
  /** Raw output field (JSON string from hook) */
  rawOutput: string;
  /** Stderr if non-empty */
  stderr: string | null;
}

// ── Hook Timeline (accumulated from a run) ─────────────────────────

export interface HookTimeline {
  events: ParsedHookEvent[];
  /** Gates activated during the run: gate name → timestamp ms */
  gatesActivated: Record<string, number>;
  /** Gates cleared during the run: gate name → timestamp ms */
  gatesCleared: Record<string, number>;
}

// ── Ground Truth ───────────────────────────────────────────────────

export type ExpectedDecision = 'fire' | 'deny' | 'allow' | 'block' | 'set-gate' | 'clear-gate' | 'skip';

export interface HookExpectation {
  /** Hook name pattern to match (substring match against hookName) */
  hookPattern: string;
  /** Event type: SessionStart, PreToolUse, PostToolUse, Stop */
  eventType: string;
  /** Expected decision */
  expectedDecision: ExpectedDecision;
  /** 1=advisory, 2=enforcement, 3=gate-critical */
  severity: number;
  /** Human description */
  description: string;
}

export interface GateExpectation {
  gate: string;
  shouldActivate: boolean;
  shouldClear: boolean;
}

export interface Scenario {
  name: string;
  description: string;
  prompt: string;
  model: 'haiku' | 'sonnet' | 'opus';
  maxBudget: number;
  timeoutSeconds: number;
  expectedHooks: HookExpectation[];
  expectedGates: GateExpectation[];
}

// ── Scoring ────────────────────────────────────────────────────────

export interface ConfusionPair {
  hook: string;
  expected: string;
  actual: string;
  severity: number;
}

export interface ScoreResult {
  scenario: string;
  hookAccuracy: number;       // 0-100
  gateAccuracy: number;       // 0-100
  totalLoss: number;          // weighted, lower = better
  confusionPairs: ConfusionPair[];
  criticalMisses: number;     // severity>=3 mismatches
  hooksFired: number;
  hooksExpected: number;
}

// ── Iteration Log ──────────────────────────────────────────────────

export interface IterationResult {
  iteration: number;
  timestamp: string;
  commit: string;
  scenario: string;
  loss: number;
  delta: number;
  status: 'baseline' | 'keep' | 'discard' | 'regression';
  hookAccuracy: number;
  gateAccuracy: number;
  criticalMisses: number;
  confusionPairs: string[];   // compact: "hook:expected→actual"
  cost: number;
  durationSeconds: number;
  model: string;
}

// ── Severity weights (analogous to autoresearch row weights) ───────

export const SEVERITY_WEIGHT: Record<number, number> = {
  1: 1,  // advisory
  2: 2,  // enforcement
  3: 4,  // gate-critical
};
