/**
 * spawn-claude.ts — the ONE `claude -p` subprocess primitive for the repo.
 *
 * A single fresh `claude -p` invocation: new process, new context, no conversation
 * history. This is the substrate for every independent-judgment mechanism — the review
 * battery (`review-battery.ts`) and the independence-by-spawn judge (`independent-judge.ts`)
 * both call this rather than reimplementing the spawn loop (#1231 DRY mandate).
 *
 * Extracted verbatim from the original private `runClaude` in review-battery.ts so the
 * stream-json JSONL parsing + cost extraction + timeout live in exactly one place.
 */

import { spawn, spawnSync } from 'node:child_process';
import { parseJsonLines } from './lib/json-lines.js';

interface StreamJsonContentBlock {
  type?: unknown;
  text?: string;
}

interface StreamJsonMessage {
  type?: unknown;
  total_cost_usd?: number;
  message?: {
    content?: unknown;
  };
}

export interface SpawnClaudeResult {
  text: string;
  costUsd: number;
  durationMs: number;
  exitCode: number;
  rawStdout: string;
  rawStderr: string;
  args: string[];
}

export interface SpawnClaudeOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Model override. Defaults to REVIEW_MODEL env var, then 'sonnet'. */
  model?: string;
  /** Optional local plugin dir for live plugin/skill tests. */
  pluginDir?: string | null;
  /** Optional max-turn guard for bounded live skill runs. */
  maxTurns?: number;
  /** Optional cost guard for bounded live skill runs. */
  maxBudgetUsd?: number;
  /** Extra env vars for the spawned Claude process. */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnClaudeArgsOptions extends SpawnClaudeOptions {
  /** Defaults to stream-json for the review/judge primitive. */
  outputFormat?: 'stream-json' | 'json';
  /** Defaults to true for stream-json, false for json. */
  verbose?: boolean;
  /** Append prompt as argv instead of stdin. Used by JSON-mode live skill tests. */
  promptArg?: string;
}

/**
 * The injectable shape callers depend on, so tests can substitute a fake spawn
 * (zero cost, deterministic) without touching a real `claude` process.
 */
export type SpawnClaudeFn = (
  prompt: string,
  opts: SpawnClaudeOptions,
) => Promise<SpawnClaudeResult>;

export interface SpawnClaudeJsonResult {
  text: string;
  costUsd: number | null;
  durationMs: number;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  rawStdout: string;
  rawStderr: string;
  args: string[];
  error?: Error;
  numTurns: number | null;
}

export interface SpawnClaudeJsonOptions extends SpawnClaudeOptions {
  promptArg?: boolean;
}

export type SpawnClaudeJsonFn = (
  prompt: string,
  opts: SpawnClaudeJsonOptions,
) => Promise<SpawnClaudeJsonResult>;

export function buildSpawnClaudeArgs(opts: SpawnClaudeArgsOptions = {}): string[] {
  const model = opts.model ?? process.env.REVIEW_MODEL ?? 'sonnet';
  const outputFormat = opts.outputFormat ?? 'stream-json';
  const verbose = opts.verbose ?? outputFormat === 'stream-json';
  const args = [
    '-p',
    '--output-format', outputFormat,
  ];

  if (verbose) args.push('--verbose');
  args.push('--dangerously-skip-permissions', '--model', model);
  if (opts.maxTurns !== undefined) {
    args.push('--max-turns', String(opts.maxTurns));
  }
  if (opts.maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  }
  if (opts.pluginDir !== undefined && opts.pluginDir !== null) {
    args.push('--plugin-dir', opts.pluginDir);
  }
  if (opts.promptArg !== undefined) args.push(opts.promptArg);

  return args;
}

export const spawnClaudeJson: SpawnClaudeJsonFn = async (prompt, opts) => {
  const startedAt = Date.now();
  const args = buildSpawnClaudeArgs({
    ...opts,
    outputFormat: 'json',
    verbose: false,
    promptArg: opts.promptArg === false ? undefined : prompt,
  });
  const proc = spawnSync('claude', args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 120_000,
    encoding: 'utf-8',
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  const durationMs = Date.now() - startedAt;
  const rawStdout = proc.stdout ?? '';
  const rawStderr = proc.stderr ?? '';

  let text = '';
  let costUsd: number | null = null;
  let numTurns: number | null = null;
  try {
    const parsed = JSON.parse(rawStdout) as {
      result?: unknown;
      is_error?: unknown;
      num_turns?: unknown;
      total_cost_usd?: unknown;
    };
    if (parsed.is_error !== true && typeof parsed.result === 'string') {
      text = parsed.result;
    }
    costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null;
    numTurns = typeof parsed.num_turns === 'number' ? parsed.num_turns : null;
  } catch {
    // Leave parse failures to callers; raw stdout is preserved.
  }

  return {
    text,
    costUsd,
    durationMs,
    exitCode: proc.status,
    signal: proc.signal,
    rawStdout,
    rawStderr,
    args,
    error: proc.error,
    numTurns,
  };
};

/**
 * Run a single `claude -p` call with the given prompt.
 * Each call is a fresh process — no shared context with the caller, by construction.
 * Model defaults to the REVIEW_MODEL env var (then 'sonnet').
 * Returns parsed text, cost, duration, and exit code.
 */
export const spawnClaude: SpawnClaudeFn = (prompt, opts) => {
  const args = buildSpawnClaudeArgs(opts);
  const start = Date.now();

  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.write(prompt, 'utf8');
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    const timer = setTimeout(() => { child.kill(); }, opts.timeoutMs ?? 120_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;

      // Parse text and cost from stream-json JSONL output.
      // The `result` field in the final "result" message is now always empty;
      // actual text lives in assistant message content blocks.
      let costUsd = 0;
      let text = '';
      for (const msg of parseJsonLines<StreamJsonMessage>(stdout)) {
        if (msg.type === 'result') {
          costUsd = msg.total_cost_usd ?? 0;
        } else if (msg.type === 'assistant') {
          const content = Array.isArray(msg.message?.content)
            ? msg.message.content as StreamJsonContentBlock[]
            : [];
          for (const block of content) {
            if (block.type === 'text') {
              text += block.text ?? '';
            }
          }
        }
      }

      resolve({ text, costUsd, durationMs, exitCode: code ?? -1, rawStdout: stdout, rawStderr: stderr, args });
    });
  });
};
