/**
 * hook-gym-replay.ts — Extract tool sequences + replay through hooks.
 *
 * Three replay layers (from spec):
 *   1. Score-only ($0): re-validate captured fixture against updated GT
 *      → already exists as validateFixtureFile() in hook-gym-validate.ts
 *   2. Hook replay ($0): extract tool actions, fire real hooks, validate
 *      → THIS MODULE: extractToolActions + replayThroughHooks
 *   3. Live run ($0.02–0.25): spawn agent with --include-hook-events
 *      → already exists as runScenario() in hook-gym-harness.ts
 *
 * Flow: stream.jsonl → extractToolActions → ToolAction[] → replayThroughHooks → HookTimeline → validate
 */

import { readFileSync } from 'node:fs';
import type { HookTimeline, ParsedHookEvent, Scenario } from './hook-gym-schema.js';
import { validateAgainstScenario, type ValidationReport } from './hook-gym-validate.js';
import { parseHookDecision } from './hook-gym-stream.js';

// ── Types ─────────────────────────────────────────────────────────

/** A tool action extracted from a captured session stream. */
export interface ToolAction {
  /** Sequential index (0-based) */
  index: number;
  /** Tool name: Bash, Write, Edit, Read, Glob, Grep, Skill, Agent */
  tool: string;
  /** Tool input (command, file_path, etc.) */
  input: Record<string, unknown>;
  /** Tool result — present for PostToolUse replay */
  result?: {
    stdout: string;
    stderr: string;
    exitCode: string;
  };
}

/** Result of replaying through hooks. */
export interface ReplayResult {
  timeline: HookTimeline;
  validation: ValidationReport;
  actions: ToolAction[];
  /** Per-action hook results for detailed inspection. */
  steps: ReplayStep[];
}

export interface ReplayStep {
  action: ToolAction;
  preHooks: ReplayHookResult[];
  postHooks: ReplayHookResult[];
}

export interface ReplayHookResult {
  hookPath: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

// ── Extraction ────────────────────────────────────────────────────

/**
 * Extract tool actions from stream-json lines.
 *
 * Parses tool_use blocks from assistant messages and correlates them
 * with tool_result blocks from user messages (by tool_use_id).
 */
export function extractToolActions(streamLines: string[]): ToolAction[] {
  const actions: ToolAction[] = [];
  // Map tool_use_id → pending action (awaiting result)
  const pending = new Map<string, ToolAction>();
  let index = 0;

  for (const line of streamLines) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    // Assistant message → tool_use blocks
    if (msg.type === 'assistant') {
      const content = (msg as any).message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_use') {
          const action: ToolAction = {
            index: index++,
            tool: block.name,
            input: block.input ?? {},
          };
          pending.set(block.id, action);
          actions.push(action);
        }
      }
    }

    // User message → tool_result blocks (correlate by tool_use_id)
    if (msg.type === 'user') {
      const content = (msg as any).message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const action = pending.get(block.tool_use_id);
          if (action) {
            // Extract stdout/stderr/exitCode from the tool result
            const resultText = extractResultText(block);
            action.result = parseToolResult(resultText, action.tool);
            pending.delete(block.tool_use_id);
          }
        }
      }
    }
  }

  return actions;
}

/** Extract text content from a tool_result block. */
function extractResultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => c.text ?? c.content ?? '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Parse tool result text into stdout/stderr/exitCode. */
function parseToolResult(text: string, tool: string): ToolAction['result'] {
  // Bash results often have exit code in the text
  if (tool === 'Bash') {
    return { stdout: text, stderr: '', exitCode: '0' };
  }
  // Other tools just have content
  return { stdout: text, stderr: '', exitCode: '0' };
}

/**
 * Extract tool actions from a fixture file (stream.jsonl or JSON array).
 */
export function extractToolActionsFromFile(fixturePath: string): ToolAction[] {
  const raw = readFileSync(fixturePath, 'utf-8').trim();

  if (raw.startsWith('[')) {
    // JSON array form — these are hook events, not tool actions
    // Can't extract tool actions from hook-only fixtures
    return [];
  }

  // Stream-json form — each line is a message
  return extractToolActions(raw.split('\n'));
}

// ── Replay ────────────────────────────────────────────────────────

/**
 * Replay tool actions through real hooks via hook-runner.
 *
 * This is the $0 deterministic replay layer: no LLM, just hooks.
 * Fires the actual hook scripts (same as SessionSimulator) and
 * converts the results into a HookTimeline for validation.
 *
 * Lazy-imports hook-runner and session-simulator to avoid pulling
 * in the E2E test infrastructure unless replay is actually used.
 */
export async function replayThroughHooks(
  actions: ToolAction[],
  opts: {
    cwd?: string;
    hookTimeout?: number;
    log?: (...args: unknown[]) => void;
  } = {},
): Promise<{ timeline: HookTimeline; steps: ReplayStep[] }> {
  // Dynamic import to avoid circular deps and keep hook-runner optional
  const { SessionSimulator } = await import('../src/e2e/session-simulator.js');

  const log = opts.log ?? console.log;
  const session = new SessionSimulator({ hookTimeout: opts.hookTimeout ?? 5000 });

  const steps: ReplayStep[] = [];
  const allParsedEvents: ParsedHookEvent[] = [];
  const gatesActivated: Record<string, number> = {};
  const gatesCleared: Record<string, number> = {};
  let timeOffset = 0;

  try {
    // Fire SessionStart
    log('[replay] Firing SessionStart...');
    const startStep = session.fireSessionStart();
    const startEvents = convertStepToEvents(startStep, 'SessionStart', timeOffset);
    allParsedEvents.push(...startEvents);
    trackGates(startEvents, gatesActivated, gatesCleared);
    timeOffset += 100;

    // Fire PreToolUse + PostToolUse for each action
    for (const action of actions) {
      const stepResult: ReplayStep = {
        action,
        preHooks: [],
        postHooks: [],
      };

      // PreToolUse
      const preStep = firePreToolUse(session, action);
      if (preStep) {
        stepResult.preHooks = preStep.results.map(r => ({
          hookPath: r.hookPath,
          stdout: r.stdout,
          stderr: r.stderr,
          exitCode: r.exitCode,
          timedOut: r.timedOut,
        }));
        const preEvents = convertStepToEvents(preStep, 'PreToolUse', timeOffset);
        allParsedEvents.push(...preEvents);
        trackGates(preEvents, gatesActivated, gatesCleared);
        timeOffset += 50;

        // Check for denials — if denied, skip PostToolUse
        const denied = preStep.results.some(r => {
          try {
            const d = JSON.parse(r.stdout);
            return d?.hookSpecificOutput?.permissionDecision === 'deny';
          } catch { return false; }
        });
        if (denied) {
          steps.push(stepResult);
          continue;
        }
      }

      // PostToolUse (only for tools that have post hooks)
      if (action.result && hasPostHooks(action.tool)) {
        const postStep = firePostToolUse(session, action);
        if (postStep) {
          stepResult.postHooks = postStep.results.map(r => ({
            hookPath: r.hookPath,
            stdout: r.stdout,
            stderr: r.stderr,
            exitCode: r.exitCode,
            timedOut: r.timedOut,
          }));
          const postEvents = convertStepToEvents(postStep, 'PostToolUse', timeOffset);
          allParsedEvents.push(...postEvents);
          trackGates(postEvents, gatesActivated, gatesCleared);
          timeOffset += 50;
        }
      }

      steps.push(stepResult);
    }

    // Fire Stop
    log('[replay] Firing Stop...');
    const stopStep = session.fireStop();
    const stopEvents = convertStepToEvents(stopStep, 'Stop', timeOffset);
    allParsedEvents.push(...stopEvents);
    trackGates(stopEvents, gatesActivated, gatesCleared);

  } finally {
    session.cleanup();
  }

  const timeline: HookTimeline = {
    events: allParsedEvents,
    gatesActivated,
    gatesCleared,
  };

  log(`[replay] Done: ${allParsedEvents.length} hook events, ${Object.keys(gatesActivated).length} gates activated.`);
  return { timeline, steps };
}

/**
 * Full replay pipeline: extract → replay → validate.
 */
export async function replayFixture(
  fixturePath: string,
  scenario: Scenario,
  opts: {
    cwd?: string;
    hookTimeout?: number;
    log?: (...args: unknown[]) => void;
  } = {},
): Promise<ReplayResult> {
  const log = opts.log ?? console.log;
  const actions = extractToolActionsFromFile(fixturePath);

  if (actions.length === 0) {
    log('[replay] No tool actions found in fixture — falling back to score-only validation.');
    const { loadFixture } = await import('./hook-gym-validate.js');
    const timeline = loadFixture(fixturePath);
    const validation = validateAgainstScenario(timeline, scenario);
    return { timeline, validation, actions, steps: [] };
  }

  log(`[replay] Extracted ${actions.length} tool actions from fixture.`);
  const { timeline, steps } = await replayThroughHooks(actions, opts);
  const validation = validateAgainstScenario(timeline, scenario);

  return { timeline, validation, actions, steps };
}

// ── Helpers ───────────────────────────────────────────────────────

interface StepResult {
  eventType: string;
  results: Array<{
    hookPath: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
  }>;
}

function firePreToolUse(
  session: { fireBashPre: (cmd: string) => StepResult; fireWritePre: (path: string) => StepResult },
  action: ToolAction,
): StepResult | null {
  switch (action.tool) {
    case 'Bash':
      return session.fireBashPre(String(action.input.command ?? ''));
    case 'Write':
    case 'Edit':
      return session.fireWritePre(String(action.input.file_path ?? ''));
    default:
      // Other tools (Read, Glob, Grep) don't have pre-hooks in kaizen
      return null;
  }
}

function firePostToolUse(
  session: { fireBashPost: (cmd: string, stdout: string, opts?: { exitCode?: string }) => StepResult },
  action: ToolAction,
): StepResult | null {
  if (action.tool === 'Bash' && action.result) {
    return session.fireBashPost(
      String(action.input.command ?? ''),
      action.result.stdout,
      { exitCode: action.result.exitCode },
    );
  }
  // Only Bash has post-hooks currently
  return null;
}

function hasPostHooks(tool: string): boolean {
  // In kaizen's plugin.json, only Bash has PostToolUse hooks
  return tool === 'Bash';
}

/**
 * Convert a SessionSimulator StepResult into ParsedHookEvents.
 *
 * Each hook result becomes one ParsedHookEvent, with the decision
 * parsed from the hook's stdout using the same logic as the stream parser.
 */
function convertStepToEvents(
  step: StepResult,
  eventType: string,
  baseTimestamp: number,
): ParsedHookEvent[] {
  const events: ParsedHookEvent[] = [];

  for (let i = 0; i < step.results.length; i++) {
    const r = step.results[i];
    const { decision, reason } = parseHookDecision(
      r.stdout,
      r.stderr,
      r.exitCode,
    );

    events.push({
      timestamp: baseTimestamp + i,
      eventType,
      hookId: `replay-${eventType}-${baseTimestamp}-${i}`,
      hookName: `${eventType}:replay`,
      durationMs: 0,
      exitCode: r.exitCode,
      outcome: r.timedOut ? 'timeout' : (r.exitCode === 0 ? 'success' : 'error'),
      decision,
      reason,
      rawOutput: r.stdout,
      stderr: r.stderr || null,
    });
  }

  return events;
}

/** Track gate activations/clears from parsed events. */
function trackGates(
  events: ParsedHookEvent[],
  activated: Record<string, number>,
  cleared: Record<string, number>,
): void {
  for (const e of events) {
    if (e.decision === 'set-gate' && e.reason) {
      if (!activated[e.reason]) activated[e.reason] = e.timestamp;
    }
    if (e.decision === 'clear-gate' && e.reason) {
      cleared[e.reason] = e.timestamp;
    }
    // Stop blocks imply gates are active
    if (e.decision === 'block' && e.eventType === 'Stop' && e.reason) {
      const gateNames = ['needs_review', 'needs_pr_kaizen', 'needs_post_merge'];
      for (const gate of gateNames) {
        if (e.reason.toLowerCase().includes(gate.replace(/_/g, ' ')) ||
            e.reason.toLowerCase().includes(gate)) {
          if (!activated[gate]) activated[gate] = e.timestamp;
        }
      }
    }
  }
}

// ── Compact fixture format ────────────────────────────────────────

/** Write extracted actions as a compact fixture JSON file. */
export function formatFixture(actions: ToolAction[]): string {
  // Strip large input/result values to keep fixtures compact
  const compact = actions.map(a => ({
    index: a.index,
    tool: a.tool,
    input: compactInput(a.input),
    ...(a.result ? { result: a.result } : {}),
  }));
  return JSON.stringify(compact, null, 2) + '\n';
}

function compactInput(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > 500) {
      result[key] = value.slice(0, 500) + '...[truncated]';
    } else {
      result[key] = value;
    }
  }
  return result;
}
