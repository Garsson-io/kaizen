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
} from './auto-dent-run.js';

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
  };
}

const KNOWN_PHASES = new Set([
  'PICK', 'EVALUATE', 'IMPLEMENT', 'TEST', 'PR', 'MERGE', 'REFLECT', 'STOP',
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

// Smoke test prompt — designed to be fast, cheap, and exercise the protocol

export const SMOKE_TEST_PROMPT = `You are running a pipeline smoke test. This must complete quickly.

Do NOT use any tools or make any changes. Simply emit these exact phase markers
as your response text, then stop:

AUTO_DENT_PHASE: PICK | issue=#0 | title=smoke test probe
AUTO_DENT_PHASE: EVALUATE | verdict=proceed | reason=pipeline validation
AUTO_DENT_PHASE: TEST | result=pass | count=0
AUTO_DENT_PHASE: REFLECT | issues_filed=0 | lessons=pipeline is operational
AUTO_DENT_PHASE: STOP | reason=smoke test complete — pipeline operational`;
