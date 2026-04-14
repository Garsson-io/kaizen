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

import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { HookTimeline, ParsedHookEvent, Scenario } from './hook-gym-schema.js';
import { validateAgainstScenario, type ValidationReport } from './hook-gym-validate.js';
import { parseHookDecision } from './hook-gym-stream.js';

const __replay_dirname = dirname(fileURLToPath(import.meta.url));
const KAIZEN_ROOT = resolve(__replay_dirname, '..');
const HOOKS_DIR = join(KAIZEN_ROOT, '.claude', 'hooks');

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
function parseToolResult(text: string, _tool: string): ToolAction['result'] {
  // Stream-json tool_result blocks don't carry structured exit codes —
  // the text IS the stdout. Default to '0' for replay purposes.
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

// ── Hook registry (matches plugin.json) ───────────────────────────

const PRE_TOOL_USE_BASH = [
  'kaizen-bump-plugin-version-ts.sh',
  'kaizen-enforce-pr-review-ts.sh',
  'kaizen-enforce-case-worktree.sh',
  'kaizen-pr-quality-checks-ts.sh',
  'kaizen-check-dirty-files-ts.sh',
  'kaizen-enforce-pr-reflect-ts.sh',
  'kaizen-block-git-rebase.sh',
  'kaizen-search-before-file.sh',
];

const PRE_TOOL_USE_WRITE = [
  'kaizen-enforce-worktree-writes.sh',
  'kaizen-enforce-case-exists.sh',
  'kaizen-enforce-pr-review-ts.sh',
];

const POST_TOOL_USE_BASH = [
  'pr-review-loop-ts.sh',
  'kaizen-reflect-ts.sh',
  'kaizen-post-merge-clear-ts.sh',
  'pr-kaizen-clear-ts.sh',
  'kaizen-pr-kaizen-clear-fallback.sh',
  'kaizen-capture-worktree-context.sh',
];

const STOP_HOOKS = [
  'kaizen-stop-gate.sh',
  'kaizen-verify-before-stop.sh',
  'kaizen-check-cleanup-on-stop.sh',
];

const SESSION_START_HOOKS = [
  'kaizen-check-wip.sh',
  'kaizen-session-cleanup-ts.sh',
  'kaizen-worktree-setup.sh',
];

// ── Replay environment ────────────────────────────────────────────

/** Create a minimal git repo for hook replay. Real git, real state, no mocks. */
function createReplayRepo(branch: string, log: (...args: unknown[]) => void): { dir: string; stateDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'hook-replay-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'hook-replay-state-'));

  log(`[replay] Setting up git repo at ${dir} (branch: ${branch})`);
  execFileSync('git', ['init', '--initial-branch', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'hook-gym-replay'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'replay@hook-gym'], { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), '# Replay repo\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init', '--no-verify'], { cwd: dir, stdio: 'pipe' });

  if (branch !== 'main') {
    execFileSync('git', ['checkout', '-b', branch], { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'hook-gym-replay.md'), `replay at ${new Date().toISOString()}\n`);
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'replay commit', '--no-verify'], { cwd: dir, stdio: 'pipe' });
  }

  return {
    dir,
    stateDir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/** Detect branch name from captured tool actions. */
function detectBranch(actions: ToolAction[]): string {
  for (const a of actions) {
    if (a.tool !== 'Bash') continue;
    const cmd = String(a.input.command ?? '');
    // git checkout -b <branch>
    const checkoutMatch = cmd.match(/git\s+checkout\s+-b\s+(\S+)/);
    if (checkoutMatch) return checkoutMatch[1];
    // git push -u origin <branch>
    const pushMatch = cmd.match(/git\s+push\s+(?:-u\s+)?origin\s+(\S+)/);
    if (pushMatch) return pushMatch[1];
  }
  return 'wt/replay-branch';
}

// ── Run a single hook ─────────────────────────────────────────────

interface HookResult {
  hookPath: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

function runHook(hookPath: string, event: Record<string, unknown>, opts: { cwd: string; env: Record<string, string>; timeout: number }): HookResult {
  const json = JSON.stringify(event);

  const result = spawnSync('bash', [hookPath], {
    input: json,
    encoding: 'utf-8' as const,
    env: { ...process.env, ...opts.env },
    cwd: opts.cwd,
    timeout: opts.timeout,
  });

  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { hookPath, stdout: '', stderr: `TIMEOUT after ${opts.timeout}ms`, exitCode: 124, timedOut: true };
  }

  return {
    hookPath,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    exitCode: result.status ?? 1,
    timedOut: false,
  };
}

// ── Fire hooks for an event type ──────────────────────────────────

function fireHooks(
  hookNames: string[],
  event: Record<string, unknown>,
  opts: { cwd: string; env: Record<string, string>; timeout: number },
): HookResult[] {
  const results: HookResult[] = [];
  for (const name of hookNames) {
    const hookPath = join(HOOKS_DIR, name);
    if (!existsSync(hookPath)) continue;
    results.push(runHook(hookPath, event, opts));
  }
  return results;
}

// ── Build hook events from tool actions ───────────────────────────

function buildPreToolUseEvent(action: ToolAction, cwd: string): Record<string, unknown> | null {
  if (action.tool === 'Bash') {
    return {
      session_id: 'hook-gym-replay',
      transcript_path: '/tmp/replay-transcript.txt',
      cwd,
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: String(action.input.command ?? '') },
    };
  }
  if (action.tool === 'Write' || action.tool === 'Edit') {
    return {
      session_id: 'hook-gym-replay',
      transcript_path: '/tmp/replay-transcript.txt',
      cwd,
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: action.tool,
      tool_input: action.input,
    };
  }
  return null;
}

function buildPostToolUseEvent(action: ToolAction, cwd: string): Record<string, unknown> | null {
  if (action.tool !== 'Bash' || !action.result) return null;
  return {
    session_id: 'hook-gym-replay',
    transcript_path: '/tmp/replay-transcript.txt',
    cwd,
    permission_mode: 'default',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: String(action.input.command ?? '') },
    tool_response: {
      stdout: action.result.stdout,
      stderr: action.result.stderr,
      exit_code: action.result.exitCode,
    },
  };
}

function buildStopEvent(cwd: string): Record<string, unknown> {
  return {
    session_id: 'hook-gym-replay',
    transcript_path: '/tmp/replay-transcript.txt',
    cwd,
    permission_mode: 'default',
    hook_event_name: 'Stop',
    reason: 'task_complete',
  };
}

function buildSessionStartEvent(cwd: string): Record<string, unknown> {
  return {
    session_id: 'hook-gym-replay',
    transcript_path: '/tmp/replay-transcript.txt',
    cwd,
    permission_mode: 'default',
    hook_event_name: 'SessionStart',
  };
}

// ── Replay ────────────────────────────────────────────────────────

/**
 * Replay tool actions through real hooks in a real git environment.
 *
 * This is the $0 deterministic replay layer: no LLM, just hooks.
 * Creates a real git repo, fires the actual hook scripts with the
 * captured tool commands and responses, and collects decisions.
 *
 * What's real: git repo, git branch, state files, hook scripts.
 * What's absent: the LLM (tool actions come from the captured fixture).
 */
export async function replayThroughHooks(
  actions: ToolAction[],
  opts: {
    cwd?: string;
    hookTimeout?: number;
    log?: (...args: unknown[]) => void;
  } = {},
): Promise<{ timeline: HookTimeline; steps: ReplayStep[] }> {
  const log = opts.log ?? console.log;
  const timeout = opts.hookTimeout ?? 10000;
  const branch = detectBranch(actions);

  const repo = createReplayRepo(branch, log);
  const env: Record<string, string> = {
    STATE_DIR: repo.stateDir,
    KAIZEN_TELEMETRY_DISABLED: '1',
    AUDIT_LOG: '/dev/null',
    AUDIT_DIR: '/dev/null',
  };
  const hookOpts = { cwd: repo.dir, env, timeout };

  const steps: ReplayStep[] = [];
  const allEvents: ParsedHookEvent[] = [];
  const gatesActivated: Record<string, number> = {};
  const gatesCleared: Record<string, number> = {};
  let timeOffset = 0;

  try {
    // SessionStart
    log('[replay] Firing SessionStart...');
    const startEvent = buildSessionStartEvent(repo.dir);
    const startResults = fireHooks(SESSION_START_HOOKS, startEvent, hookOpts);
    const startParsed = resultsToEvents(startResults, 'SessionStart', timeOffset);
    allEvents.push(...startParsed);
    trackGates(startParsed, gatesActivated, gatesCleared);
    timeOffset += 100;

    // Replay each tool action
    for (const action of actions) {
      const step: ReplayStep = { action, preHooks: [], postHooks: [] };

      // PreToolUse
      const preEvent = buildPreToolUseEvent(action, repo.dir);
      if (preEvent) {
        const hookList = action.tool === 'Bash' ? PRE_TOOL_USE_BASH
          : (action.tool === 'Write' || action.tool === 'Edit') ? PRE_TOOL_USE_WRITE
          : [];
        const preResults = fireHooks(hookList, preEvent, hookOpts);
        step.preHooks = preResults;
        const preParsed = resultsToEvents(preResults, 'PreToolUse', timeOffset);
        allEvents.push(...preParsed);
        trackGates(preParsed, gatesActivated, gatesCleared);
        timeOffset += 50;

        // If denied, skip PostToolUse
        const denied = preResults.some(r => {
          try { return JSON.parse(r.stdout)?.hookSpecificOutput?.permissionDecision === 'deny'; }
          catch { return false; }
        });
        if (denied) { steps.push(step); continue; }
      }

      // PostToolUse
      const postEvent = buildPostToolUseEvent(action, repo.dir);
      if (postEvent) {
        const postResults = fireHooks(POST_TOOL_USE_BASH, postEvent, hookOpts);
        step.postHooks = postResults;
        const postParsed = resultsToEvents(postResults, 'PostToolUse', timeOffset);
        allEvents.push(...postParsed);
        trackGates(postParsed, gatesActivated, gatesCleared);
        timeOffset += 50;
      }

      steps.push(step);
      if ((action.index + 1) % 5 === 0) {
        log(`[replay] ${action.index + 1}/${actions.length} actions replayed...`);
      }
    }

    // Stop
    log('[replay] Firing Stop...');
    const stopResults = fireHooks(STOP_HOOKS, buildStopEvent(repo.dir), hookOpts);
    const stopParsed = resultsToEvents(stopResults, 'Stop', timeOffset);
    allEvents.push(...stopParsed);
    trackGates(stopParsed, gatesActivated, gatesCleared);

  } finally {
    repo.cleanup();
  }

  const timeline: HookTimeline = { events: allEvents, gatesActivated, gatesCleared };
  log(`[replay] Done: ${allEvents.length} hook events, ${Object.keys(gatesActivated).length} gates activated, ${Object.keys(gatesCleared).length} cleared.`);
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

/** Convert hook results to ParsedHookEvents. */
function resultsToEvents(
  results: HookResult[],
  eventType: string,
  baseTimestamp: number,
): ParsedHookEvent[] {
  return results.map((r, i) => {
    const { decision, reason } = parseHookDecision(r.stdout, r.stderr, r.exitCode);
    return {
      timestamp: baseTimestamp + i,
      eventType,
      hookId: `replay-${eventType}-${baseTimestamp}-${i}`,
      hookName: `${eventType}:${r.hookPath.split('/').pop()?.replace(/\.sh$/, '') ?? 'replay'}`,
      durationMs: 0,
      exitCode: r.exitCode,
      outcome: r.timedOut ? 'timeout' : (r.exitCode === 0 ? 'success' : 'error'),
      decision,
      reason,
      rawOutput: r.stdout,
      stderr: r.stderr || null,
    };
  });
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
