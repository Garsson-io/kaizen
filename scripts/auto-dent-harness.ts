/**
 * auto-dent-harness — Test infrastructure for the auto-dent stream pipeline.
 *
 * Four layers:
 *   1. Message builders  — construct stream-json messages declaratively
 *   2. runStream()       — feed messages through processStreamMessage, capture output
 *   3. replayLog()       — replay a real captured .log file through the pipeline
 *   4. runLiveProbe()    — spawn a real bounded claude session, capture everything
 *
 * The harness is the foundation for:
 *   - Fast unit tests (synthetic messages)
 *   - Regression tests (replay captured logs from real runs)
 *   - Live smoke tests (bounded real claude sessions)
 *   - Experimentation (compare prompt/hook variants by scoring results)
 */

import { spawn } from 'child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  processStreamMessage,
  type RunResult,
  type RunMetrics,
} from './auto-dent-run.js';
import { parsePhaseMarkers as parsePhaseMarkersLocal } from './auto-dent-stream.js';
import {
  type EventEnvelope,
  type AutoDentEvent,
  type RunStartEvent,
  type RunCompleteEvent,
  type RunIssuePickedEvent,
  type RunPrCreatedEvent,
  makeRunId,
} from './auto-dent-events.js';
import {
  scoreRunResult,
  type RunScore,
} from './auto-dent-score.js';

// Result types

export interface StreamCapture {
  /** All console.log lines emitted by processStreamMessage */
  logLines: string[];
  /** The accumulated RunResult (prs, issues, cost, tool calls, etc.) */
  result: RunResult;
  /** Phase markers extracted from logLines for easy assertion */
  phases: Array<{ phase: string; line: string }>;
  /** Raw stream-json messages (for replay tests and debugging) */
  rawMessages: Record<string, any>[];
  /** Wall-clock duration in ms (meaningful for live probes) */
  durationMs: number;
}

// Helpers

function makeRunResult(): RunResult {
  return {
    prs: [],
    issuesFiled: [],
    issuesClosed: [],
    cases: [],
    cost: 0,
    toolCalls: 0,
    stopRequested: false,
    linesDeleted: 0,
    issuesPruned: 0,
  };
}

const KNOWN_PHASES = new Set([
  'PICK', 'EVALUATE', 'IMPLEMENT', 'TEST', 'PR', 'MERGE', 'DECOMPOSE', 'REFLECT', 'STOP',
]);

function extractPhasesFromLog(logLines: string[]): Array<{ phase: string; line: string }> {
  const phases: Array<{ phase: string; line: string }> = [];
  for (const line of logLines) {
    const match = line.match(/\[([A-Z]+)\]/);
    if (match && KNOWN_PHASES.has(match[1])) {
      phases.push({ phase: match[1], line });
    }
  }
  return phases;
}

// Layer 1: Message builders

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, any> };

export const msg = {
  init: (model = 'claude-opus-4-6', sessionId = 'test-session') =>
    ({ type: 'system', subtype: 'init', session_id: sessionId, model }) as Record<string, any>,

  text: (text: string) =>
    ({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) as Record<string, any>,

  tool: (name: string, input: Record<string, any> = {}) =>
    ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }) as Record<string, any>,

  mixed: (...blocks: ContentBlock[]) =>
    ({ type: 'assistant', message: { content: blocks } }) as Record<string, any>,

  phase: (phase: string, fields: Record<string, string> = {}) => {
    const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
    const line = pairs.length > 0
      ? `AUTO_DENT_PHASE: ${phase} | ${pairs.join(' | ')}`
      : `AUTO_DENT_PHASE: ${phase}`;
    return msg.text(line);
  },

  proseWithPhase: (before: string, phase: string, fields: Record<string, string>, after: string) => {
    const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
    const marker = pairs.length > 0
      ? `AUTO_DENT_PHASE: ${phase} | ${pairs.join(' | ')}`
      : `AUTO_DENT_PHASE: ${phase}`;
    return msg.text([before, marker, after].join('\n'));
  },

  done: (cost: number, resultText = '') =>
    ({ type: 'result', subtype: 'success', total_cost_usd: cost, result: resultText }) as Record<string, any>,

  error: (cost: number, resultText = '') =>
    ({ type: 'result', subtype: 'error', total_cost_usd: cost, result: resultText }) as Record<string, any>,
};

// Layer 2: Synthetic stream runner

export interface RunStreamOpts {
  /** If true, also print to real console (for debugging) */
  verbose?: boolean;
}

export function runStream(
  messages: Record<string, any>[],
  opts: RunStreamOpts = {},
): StreamCapture {
  const logLines: string[] = [];
  const realLog = console.log;
  const result = makeRunResult();
  const start = Date.now();

  console.log = (...args: any[]) => {
    const line = args.map(a => String(a)).join(' ');
    logLines.push(line);
    if (opts.verbose) realLog(line);
  };

  try {
    for (const m of messages) {
      processStreamMessage(m, result, start);
    }
  } finally {
    console.log = realLog;
  }

  return {
    logLines,
    result,
    phases: extractPhasesFromLog(logLines),
    rawMessages: messages,
    durationMs: Date.now() - start,
  };
}

// Layer 3: Log replay

export function replayLog(logPath: string, opts: RunStreamOpts = {}): StreamCapture {
  const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  const messages: Record<string, any>[] = [];

  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Non-JSON line (e.g. stderr, metadata) — skip
    }
  }

  return runStream(messages, opts);
}

// Layer 4: Live probe

export interface LiveProbeOpts {
  /** The prompt to send to claude */
  prompt: string;
  /** Working directory for the claude session */
  cwd: string;
  /** Max budget in USD (default: 0.05 — very cheap) */
  maxBudget?: number;
  /** Timeout in ms (default: 60_000) */
  timeoutMs?: number;
  /** Additional claude CLI args */
  extraArgs?: string[];
  /** Print output in real-time */
  verbose?: boolean;
}

export async function runLiveProbe(opts: LiveProbeOpts): Promise<StreamCapture & { exitCode: number }> {
  const {
    prompt,
    cwd,
    maxBudget = 0.05,
    timeoutMs = 60_000,
    extraArgs = [],
    verbose = false,
  } = opts;

  const logLines: string[] = [];
  const rawMessages: Record<string, any>[] = [];
  const result = makeRunResult();
  const start = Date.now();

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--max-budget-usd', String(maxBudget),
    '--verbose',
    ...extraArgs,
  ];

  // Save the raw log for replay/debugging
  const tmpDir = mkdtempSync(join(tmpdir(), 'auto-dent-probe-'));
  const logFile = join(tmpDir, 'probe.log');

  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    // Intercept console.log once for the entire probe
    const realLog = console.log;
    console.log = (...a: any[]) => {
      const l = a.map(x => String(x)).join(' ');
      logLines.push(l);
      if (verbose) realLog(l);
    };

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      try {
        writeFileSync(logFile, line + '\n', { flag: 'a' });
      } catch { /* best effort */ }

      try {
        const parsed = JSON.parse(line);
        rawMessages.push(parsed);
        processStreamMessage(parsed, result, start);
      } catch {
        // Non-JSON
      }
    });

    child.stderr?.on('data', () => {
      // Stderr captured in log file, not needed in memory
    });

    // Safety timeout
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      console.log = realLog;
      const durationMs = Date.now() - start;

      resolve({
        logLines,
        result,
        phases: extractPhasesFromLog(logLines),
        rawMessages,
        durationMs,
        exitCode: code ?? 1,
      });
    });

    child.on('error', () => {
      clearTimeout(timer);
      console.log = realLog;
      resolve({
        logLines,
        result,
        phases: extractPhasesFromLog(logLines),
        rawMessages,
        durationMs: Date.now() - start,
        exitCode: 1,
      });
    });
  });
}

// Assertion helpers — use in tests for concise assertions

export function expectPhase(capture: StreamCapture, phase: string, ...fragments: string[]) {
  const matching = capture.phases.filter(p => p.phase === phase);
  if (matching.length === 0) {
    throw new Error(
      `Expected [${phase}] in output but not found.\nLog lines:\n${capture.logLines.join('\n')}`,
    );
  }
  for (const frag of fragments) {
    if (!matching.some(p => p.line.includes(frag))) {
      throw new Error(
        `Expected "${frag}" in [${phase}] line but not found.\nMatching lines:\n${matching.map(p => p.line).join('\n')}`,
      );
    }
  }
}

export function expectNoPhase(capture: StreamCapture, phase: string) {
  const matching = capture.phases.filter(p => p.phase === phase);
  if (matching.length > 0) {
    throw new Error(
      `Expected no [${phase}] in output but found ${matching.length}:\n${matching.map(p => p.line).join('\n')}`,
    );
  }
}

export function expectToolLogged(capture: StreamCapture, ...fragments: string[]) {
  for (const frag of fragments) {
    if (!capture.logLines.some(l => l.includes(frag))) {
      throw new Error(
        `Expected "${frag}" in tool output but not found.\nLog lines:\n${capture.logLines.join('\n')}`,
      );
    }
  }
}

export function phaseCount(capture: StreamCapture, phase: string): number {
  return capture.phases.filter(p => p.phase === phase).length;
}

// Lifecycle validation

/**
 * Expected phase ordering for auto-dent runs.
 * Phases must appear in this relative order (gaps are OK, reversals are not).
 * DECOMPOSE and STOP can appear at any point after EVALUATE.
 */
const LIFECYCLE_ORDER = ['PICK', 'EVALUATE', 'IMPLEMENT', 'TEST', 'PR', 'MERGE', 'REFLECT'];

/** Phases that can appear at any position (after at least PICK) */
const FLOATING_PHASES = new Set(['DECOMPOSE', 'STOP']);

export interface LifecycleViolation {
  /** The phase that appeared out of order */
  phase: string;
  /** The phase it appeared after (that should have come later) */
  after: string;
  /** 0-based indices within the captured phases array */
  phaseIndex: number;
  afterIndex: number;
}

export interface LifecycleValidation {
  /** Whether all phases appeared in valid order */
  valid: boolean;
  /** Phases present in the capture, in order */
  phasesPresent: string[];
  /** Standard lifecycle phases that were missing */
  phasesMissing: string[];
  /** Ordering violations (if any) */
  violations: LifecycleViolation[];
}

/**
 * Validate that phases in a StreamCapture follow the expected lifecycle order.
 * Floating phases (DECOMPOSE, STOP) are excluded from ordering checks.
 */
export function validateLifecycle(capture: StreamCapture): LifecycleValidation {
  const phasesPresent = capture.phases.map(p => p.phase);
  const orderedPhases = phasesPresent.filter(p => !FLOATING_PHASES.has(p));
  const violations: LifecycleViolation[] = [];

  for (let i = 1; i < orderedPhases.length; i++) {
    const prevIdx = LIFECYCLE_ORDER.indexOf(orderedPhases[i - 1]);
    const currIdx = LIFECYCLE_ORDER.indexOf(orderedPhases[i]);
    if (prevIdx === -1 || currIdx === -1) continue; // Unknown phase, skip
    if (currIdx < prevIdx) {
      violations.push({
        phase: orderedPhases[i],
        after: orderedPhases[i - 1],
        phaseIndex: i,
        afterIndex: i - 1,
      });
    }
  }

  const presentSet = new Set(phasesPresent);
  const phasesMissing = LIFECYCLE_ORDER.filter(p => !presentSet.has(p));

  return {
    valid: violations.length === 0,
    phasesPresent,
    phasesMissing,
    violations,
  };
}

/**
 * Assert that phases follow valid lifecycle ordering. Throws on violations.
 */
export function expectValidLifecycle(capture: StreamCapture): void {
  const validation = validateLifecycle(capture);
  if (!validation.valid) {
    const details = validation.violations.map(v =>
      `  ${v.phase} appeared after ${v.after} (expected ${v.after} to come later)`
    ).join('\n');
    throw new Error(
      `Lifecycle ordering violations:\n${details}\nPhases: ${validation.phasesPresent.join(' -> ')}`,
    );
  }
}

/**
 * Assert that specific phases appear in the expected relative order.
 * Only checks the listed phases — other phases may appear between them.
 */
export function expectPhaseOrder(capture: StreamCapture, expectedOrder: string[]): void {
  const phasesPresent = capture.phases.map(p => p.phase);

  // Find first occurrence of each expected phase
  const positions: Array<{ phase: string; pos: number }> = [];
  for (const phase of expectedOrder) {
    const pos = phasesPresent.indexOf(phase);
    if (pos === -1) {
      throw new Error(
        `Expected phase [${phase}] not found in output.\nPhases present: ${phasesPresent.join(', ')}`,
      );
    }
    positions.push({ phase, pos });
  }

  for (let i = 1; i < positions.length; i++) {
    if (positions[i].pos < positions[i - 1].pos) {
      throw new Error(
        `Phase [${positions[i].phase}] (pos ${positions[i].pos}) appeared before [${positions[i - 1].phase}] (pos ${positions[i - 1].pos}).\nExpected order: ${expectedOrder.join(' -> ')}\nActual: ${phasesPresent.join(' -> ')}`,
      );
    }
  }
}

// Result assertions

export interface ResultExpectation {
  /** Minimum number of PRs created */
  minPrs?: number;
  /** Maximum number of PRs created */
  maxPrs?: number;
  /** Minimum number of issues filed */
  minIssuesFiled?: number;
  /** Minimum number of issues closed */
  minIssuesClosed?: number;
  /** Maximum cost in USD */
  maxCost?: number;
  /** Minimum cost in USD */
  minCost?: number;
  /** Whether a stop was requested */
  stopRequested?: boolean;
  /** Minimum number of tool calls */
  minToolCalls?: number;
  /** Maximum number of tool calls */
  maxToolCalls?: number;
}

/**
 * Assert properties of the accumulated RunResult.
 * Only checks fields that are specified in the expectation.
 */
export function expectResult(capture: StreamCapture, expected: ResultExpectation): void {
  const r = capture.result;
  const failures: string[] = [];

  if (expected.minPrs !== undefined && r.prs.length < expected.minPrs) {
    failures.push(`PRs: expected >= ${expected.minPrs}, got ${r.prs.length}`);
  }
  if (expected.maxPrs !== undefined && r.prs.length > expected.maxPrs) {
    failures.push(`PRs: expected <= ${expected.maxPrs}, got ${r.prs.length}`);
  }
  if (expected.minIssuesFiled !== undefined && r.issuesFiled.length < expected.minIssuesFiled) {
    failures.push(`Issues filed: expected >= ${expected.minIssuesFiled}, got ${r.issuesFiled.length}`);
  }
  if (expected.minIssuesClosed !== undefined && r.issuesClosed.length < expected.minIssuesClosed) {
    failures.push(`Issues closed: expected >= ${expected.minIssuesClosed}, got ${r.issuesClosed.length}`);
  }
  if (expected.maxCost !== undefined && r.cost > expected.maxCost) {
    failures.push(`Cost: expected <= $${expected.maxCost}, got $${r.cost}`);
  }
  if (expected.minCost !== undefined && r.cost < expected.minCost) {
    failures.push(`Cost: expected >= $${expected.minCost}, got $${r.cost}`);
  }
  if (expected.stopRequested !== undefined && r.stopRequested !== expected.stopRequested) {
    failures.push(`stopRequested: expected ${expected.stopRequested}, got ${r.stopRequested}`);
  }
  if (expected.minToolCalls !== undefined && r.toolCalls < expected.minToolCalls) {
    failures.push(`Tool calls: expected >= ${expected.minToolCalls}, got ${r.toolCalls}`);
  }
  if (expected.maxToolCalls !== undefined && r.toolCalls > expected.maxToolCalls) {
    failures.push(`Tool calls: expected <= ${expected.maxToolCalls}, got ${r.toolCalls}`);
  }

  if (failures.length > 0) {
    throw new Error(`Result assertion failures:\n  ${failures.join('\n  ')}`);
  }
}

// Scenario builders — pre-built realistic message sequences

export const scenarios = {
  /** A successful run that picks an issue, implements, tests, creates a PR, and merges */
  successfulRun: (opts: {
    issue?: string;
    title?: string;
    prUrl?: string;
    cost?: number;
  } = {}) => [
    msg.init(),
    msg.phase('PICK', { issue: opts.issue ?? '#100', title: opts.title ?? 'test issue' }),
    msg.phase('EVALUATE', { verdict: 'proceed', reason: 'clear scope' }),
    msg.tool('Read', { file_path: '/src/example.ts' }),
    msg.tool('Edit', { file_path: '/src/example.ts', old_string: 'old', new_string: 'new' }),
    msg.phase('IMPLEMENT', { case: '260323-test', branch: 'feat/test' }),
    msg.tool('Bash', { command: 'npm test' }),
    msg.phase('TEST', { result: 'pass', count: '5' }),
    msg.text(`Created PR: ${opts.prUrl ?? 'https://github.com/Garsson-io/kaizen/pull/999'}`),
    msg.phase('PR', { url: opts.prUrl ?? 'https://github.com/Garsson-io/kaizen/pull/999' }),
    msg.phase('MERGE', { url: opts.prUrl ?? 'https://github.com/Garsson-io/kaizen/pull/999', status: 'queued' }),
    msg.phase('REFLECT', { issues_filed: '0', lessons: 'clean implementation' }),
    msg.done(opts.cost ?? 1.5),
  ],

  /** A run that skips an issue after evaluation */
  skippedRun: (opts: {
    issue?: string;
    reason?: string;
    cost?: number;
  } = {}) => [
    msg.init(),
    msg.phase('PICK', { issue: opts.issue ?? '#200', title: 'complex issue' }),
    msg.phase('EVALUATE', { verdict: 'skip', reason: opts.reason ?? 'too risky for auto-dent' }),
    msg.phase('REFLECT', { issues_filed: '0', lessons: 'skipped after evaluation' }),
    msg.done(opts.cost ?? 0.2),
  ],

  /** A run that decomposes an epic into sub-issues */
  decomposeRun: (opts: {
    epic?: string;
    issuesCreated?: string;
    prUrl?: string;
    cost?: number;
  } = {}) => [
    msg.init(),
    msg.phase('PICK', { issue: opts.epic ?? '#500', title: 'epic decomposition' }),
    msg.phase('EVALUATE', { verdict: 'proceed', reason: 'epic needs decomposition' }),
    msg.phase('DECOMPOSE', { epic: opts.epic ?? '#500', issues_created: opts.issuesCreated ?? '#501,#502,#503' }),
    msg.tool('Read', { file_path: '/docs/spec.md' }),
    msg.tool('Edit', { file_path: '/src/impl.ts', old_string: 'old', new_string: 'new' }),
    msg.phase('IMPLEMENT', { case: '260323-decompose', branch: 'feat/decompose' }),
    msg.phase('TEST', { result: 'pass', count: '3' }),
    msg.text(`Created PR: ${opts.prUrl ?? 'https://github.com/Garsson-io/kaizen/pull/998'}`),
    msg.phase('PR', { url: opts.prUrl ?? 'https://github.com/Garsson-io/kaizen/pull/998' }),
    msg.phase('REFLECT', { issues_filed: '3', lessons: 'decomposed epic into actionable work' }),
    msg.done(opts.cost ?? 2.0),
  ],

  /** A run that exhausts the backlog and signals STOP */
  stopRun: (opts: {
    reason?: string;
    cost?: number;
  } = {}) => [
    msg.init(),
    msg.phase('PICK', { issue: 'none', title: 'backlog scan' }),
    msg.phase('EVALUATE', { verdict: 'skip', reason: 'no matching issues' }),
    msg.phase('STOP', { reason: opts.reason ?? 'backlog exhausted' }),
    msg.done(opts.cost ?? 0.3),
  ],

  /** A run that errors out mid-implementation */
  errorRun: (opts: {
    issue?: string;
    cost?: number;
  } = {}) => [
    msg.init(),
    msg.phase('PICK', { issue: opts.issue ?? '#300', title: 'failing issue' }),
    msg.phase('EVALUATE', { verdict: 'proceed', reason: 'seems straightforward' }),
    msg.tool('Read', { file_path: '/src/broken.ts' }),
    msg.phase('IMPLEMENT', { case: '260323-error', branch: 'feat/error' }),
    msg.tool('Bash', { command: 'npm test' }),
    msg.phase('TEST', { result: 'fail', count: '3' }),
    msg.error(opts.cost ?? 0.8),
  ],
};

// Telemetry bridge — convert StreamCapture to RunMetrics and EventEnvelopes
// Enables end-to-end testing of the scoring + batch-summary pipeline from synthetic scenarios.

export interface CaptureToMetricsOpts {
  runNum?: number;
  exitCode?: number;
  mode?: string;
  batchId?: string;
}

/**
 * Convert a StreamCapture to RunMetrics — the format used by auto-dent-score.
 * Bridges the harness to the scoring pipeline so synthetic scenarios can be scored.
 */
export function captureToRunMetrics(
  capture: StreamCapture,
  opts: CaptureToMetricsOpts = {},
): RunMetrics {
  const runNum = opts.runNum ?? 1;
  const exitCode = opts.exitCode ?? (capture.result.prs.length > 0 ? 0 : 1);
  const durationSeconds = Math.round(capture.durationMs / 1000);

  return {
    run: runNum,
    start_epoch: Math.floor(Date.now() / 1000),
    duration_seconds: durationSeconds,
    exit_code: exitCode,
    cost_usd: capture.result.cost,
    tool_calls: capture.result.toolCalls,
    prs: capture.result.prs,
    issues_filed: capture.result.issuesFiled,
    issues_closed: capture.result.issuesClosed,
    cases: capture.result.cases,
    stop_requested: capture.result.stopRequested,
    mode: opts.mode ?? 'exploit',
    lines_deleted: capture.result.linesDeleted,
    issues_pruned: capture.result.issuesPruned,
    failure_class: capture.result.failureClass,
    lifecycle_violations: validateLifecycle(capture).violations.length,
  };
}

/**
 * Convert a StreamCapture to EventEnvelope[] — the format stored in events.jsonl.
 * Bridges the harness to the batch-summary/batch-trends pipeline for end-to-end testing.
 */
export function captureToEvents(
  capture: StreamCapture,
  opts: CaptureToMetricsOpts = {},
): EventEnvelope[] {
  const batchId = opts.batchId ?? 'test-batch';
  const runNum = opts.runNum ?? 1;
  const runId = makeRunId(batchId, runNum);
  const exitCode = opts.exitCode ?? (capture.result.prs.length > 0 ? 0 : 1);
  const mode = opts.mode ?? 'exploit';
  const now = new Date();
  const envelopes: EventEnvelope[] = [];

  // run.start
  const startEvent: RunStartEvent = {
    type: 'run.start',
    run_id: runId,
    batch_id: batchId,
    run_num: runNum,
    mode,
    mode_reason: 'synthetic',
    prompt_template: 'harness-scenario',
    prompt_hash: 'synthetic',
    start_epoch: Math.floor(now.getTime() / 1000),
  };
  envelopes.push({ timestamp: now.toISOString(), event: startEvent });

  // run.issue_picked — extract from raw messages containing PICK phase marker
  for (const rawMsg of capture.rawMessages) {
    if (rawMsg.type !== 'assistant' || !rawMsg.message?.content) continue;
    for (const block of rawMsg.message.content) {
      if (block.type !== 'text') continue;
      const markers = parsePhaseMarkersLocal(block.text);
      const pickMarker = markers.find((m: { phase: string }) => m.phase === 'PICK');
      if (pickMarker) {
        const pickedEvent: RunIssuePickedEvent = {
          type: 'run.issue_picked',
          run_id: runId,
          batch_id: batchId,
          run_num: runNum,
          issue: pickMarker.fields.issue ?? 'unknown',
          title: pickMarker.fields.title ?? 'unknown',
        };
        envelopes.push({ timestamp: now.toISOString(), event: pickedEvent });
        break;
      }
    }
  }

  // run.pr_created — one per PR
  for (const prUrl of capture.result.prs) {
    const prEvent: RunPrCreatedEvent = {
      type: 'run.pr_created',
      run_id: runId,
      batch_id: batchId,
      run_num: runNum,
      pr_url: prUrl,
    };
    envelopes.push({ timestamp: now.toISOString(), event: prEvent });
  }

  // run.complete
  const hasArtifacts = capture.result.prs.length > 0 ||
    capture.result.issuesFiled.length > 0 ||
    capture.result.issuesClosed.length > 0;
  const outcome: RunCompleteEvent['outcome'] =
    capture.result.stopRequested ? 'stop' :
    exitCode !== 0 ? 'failure' :
    hasArtifacts ? 'success' : 'empty_success';

  const completeEvent: RunCompleteEvent = {
    type: 'run.complete',
    run_id: runId,
    batch_id: batchId,
    run_num: runNum,
    duration_ms: capture.durationMs,
    exit_code: exitCode,
    cost_usd: capture.result.cost,
    tool_calls: capture.result.toolCalls,
    prs_created: capture.result.prs.length,
    issues_filed: capture.result.issuesFiled.length,
    issues_closed: capture.result.issuesClosed.length,
    stop_requested: capture.result.stopRequested,
    failure_class: capture.result.failureClass,
    lifecycle_violations: validateLifecycle(capture).violations.length,
    outcome,
    mode,
  };
  envelopes.push({ timestamp: now.toISOString(), event: completeEvent });

  return envelopes;
}

/**
 * Score a StreamCapture using the auto-dent-score pipeline.
 * Convenience wrapper that bridges harness → scoring in one call.
 */
export function scoreCapture(
  capture: StreamCapture,
  opts: CaptureToMetricsOpts = {},
): RunScore {
  const exitCode = opts.exitCode ?? (capture.result.prs.length > 0 ? 0 : 1);
  const durationSeconds = Math.round(capture.durationMs / 1000);
  return scoreRunResult(
    capture.result,
    exitCode,
    durationSeconds,
    opts.mode ?? 'exploit',
  );
}

// Smoke test prompt — designed to be fast, cheap, and exercise the protocol

export const SMOKE_TEST_PROMPT = `You are running a pipeline smoke test. This must complete quickly.

Do NOT use any tools or make any changes. Simply emit these exact phase markers
as your response text, then stop:

AUTO_DENT_PHASE: PICK | issue=#0 | title=smoke test probe
AUTO_DENT_PHASE: EVALUATE | verdict=proceed | reason=pipeline validation
AUTO_DENT_PHASE: TEST | result=pass | count=0
AUTO_DENT_PHASE: REFLECT | issues_filed=0 | lessons=pipeline is operational
AUTO_DENT_PHASE: STOP | reason=smoke test complete — pipeline operational`;
