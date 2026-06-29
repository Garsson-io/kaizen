/**
 * spawn-claude.ts — the ONE provider-aware agent subprocess primitive for the repo.
 *
 * A single fresh provider invocation: new process, new context, no conversation
 * history. This is the substrate for every independent-judgment mechanism — the review
 * battery (`review-battery.ts`) and the independence-by-spawn judge (`independent-judge.ts`)
 * both call this rather than reimplementing the spawn loop (#1231 DRY mandate).
 *
 * The file keeps historical Claude-named exports for compatibility while new callers use
 * the provider-neutral `spawnAgent`/`buildSpawnAgentCommand` surface (#1580).
 */

import { spawn, spawnSync } from 'node:child_process';
import { assessCodexRun, buildCodexExecArgs, parseCodexJsonl, type CodexExecArgsOptions } from './codex-agent.js';
import { parseJsonLines } from './lib/json-lines.js';
import { resolveProjectRoot } from './lib/resolve-project-root.js';
import {
  parseSubscriptionAgentProvider,
  subscriptionAgentProvider,
  type AgentProvider,
  type SubscriptionAgentProvider,
} from './provider-contract.js';

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

export type SpawnAgentProvider = SubscriptionAgentProvider;

export function parseSpawnAgentProvider(value: string): SpawnAgentProvider | null {
  return parseSubscriptionAgentProvider(value);
}

export interface SpawnClaudeOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Model override. Defaults to REVIEW_MODEL env var, then 'sonnet'. Use null to omit. */
  model?: string | null;
  /** Optional local plugin dir for live plugin/skill tests. */
  pluginDir?: string | null;
  /** Optional max-turn guard for bounded live skill runs. */
  maxTurns?: number;
  /** Optional cost guard for bounded live skill runs. */
  maxBudgetUsd?: number;
  /** Extra env vars for the spawned provider process. */
  env?: NodeJS.ProcessEnv;
  /** Agent provider. Defaults to Claude for backward compatibility. */
  provider?: SpawnAgentProvider;
}

export interface SpawnClaudeArgsOptions extends SpawnClaudeOptions {
  /** Defaults to stream-json for the review/judge primitive. */
  outputFormat?: 'stream-json' | 'json';
  /** Defaults to true for stream-json, false for json. */
  verbose?: boolean;
  /** Append prompt as argv instead of stdin. Used by JSON-mode live skill tests. */
  promptArg?: string;
  /** Whether to pass Claude's permissions bypass flag. Defaults to true for compatibility. */
  skipPermissions?: boolean;
  /** Codex sandbox mode for provider-specific phases. Defaults to read-only. */
  codexSandbox?: CodexExecArgsOptions['sandbox'];
  /** Codex approval/sandbox bypass. Defaults to false. */
  codexBypassApprovalsAndSandbox?: boolean;
  /** Use cwd directly for Codex --cd instead of resolving to the git root. */
  codexUseProvidedCwd?: boolean;
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

export interface SpawnAgentCommand {
  command: 'claude' | 'codex';
  args: string[];
  stdin: boolean;
}

export function resolveCodexRepoRoot(cwd = process.cwd()): string {
  return resolveProjectRoot(cwd);
}

export function buildSpawnClaudeArgs(opts: SpawnClaudeArgsOptions = {}): string[] {
  const model = opts.model === null ? null : opts.model ?? process.env.REVIEW_MODEL ?? 'sonnet';
  const outputFormat = opts.outputFormat ?? 'stream-json';
  const verbose = opts.verbose ?? outputFormat === 'stream-json';
  const skipPermissions = opts.skipPermissions ?? true;
  const args = [
    '-p',
    '--output-format', outputFormat,
  ];

  if (verbose) args.push('--verbose');
  if (skipPermissions) args.push('--dangerously-skip-permissions');
  if (model) args.push('--model', model);
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

export function buildSpawnAgentCommand(opts: SpawnClaudeArgsOptions = {}): SpawnAgentCommand {
  const provider: AgentProvider = opts.provider?.provider ?? 'claude';
  if (provider === 'codex') {
    const repoRoot = opts.codexUseProvidedCwd
      ? opts.cwd ?? process.cwd()
      : resolveCodexRepoRoot(opts.cwd);
    return {
      command: 'codex',
      args: buildCodexExecArgs(repoRoot, {
        sandbox: opts.codexSandbox ?? 'read-only',
        bypassApprovalsAndSandbox: opts.codexBypassApprovalsAndSandbox ?? false,
      }),
      stdin: true,
    };
  }
  return {
    command: 'claude',
    args: buildSpawnClaudeArgs(opts),
    stdin: true,
  };
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

function parseClaudeStreamResult(stdout: string): { text: string; costUsd: number } {
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
  return { text, costUsd };
}

function parseAgentResult(provider: SpawnAgentProvider['provider'], stdout: string): { text: string; costUsd: number; failureNotes: string[] } {
  if (provider === 'codex') {
    const parsed = parseCodexJsonl(stdout);
    return {
      text: parsed.finalText || parsed.text,
      costUsd: 0,
      failureNotes: assessCodexRun(parsed).failureNotes,
    };
  }
  return { ...parseClaudeStreamResult(stdout), failureNotes: [] };
}

/**
 * Run a single agent provider call with the given prompt.
 * Each call is a fresh process — no shared context with the caller, by construction.
 * Model defaults to the REVIEW_MODEL env var (then 'sonnet').
 * Returns parsed text, cost, duration, and exit code.
 */
export const spawnAgent: SpawnClaudeFn = (prompt, opts) => {
  const provider = opts.provider?.provider ?? 'claude';
  const { command, args } = buildSpawnAgentCommand(opts);
  const start = Date.now();

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.write(prompt, 'utf8');
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (!child.kill()) timedOut = false;
      } catch {
        timedOut = false;
      }
    }, opts.timeoutMs ?? 120_000);
    let settled = false;

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      resolve({
        text: '',
        costUsd: 0,
        durationMs,
        exitCode: -1,
        rawStdout: stdout,
        rawStderr: `${stderr}${stderr ? '\n' : ''}${err.message}`,
        args,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const { text, costUsd, failureNotes } = parseAgentResult(provider, stdout);
      const providerFailureNotes = timedOut
        ? [`provider timed out after ${opts.timeoutMs ?? 120_000}ms`]
        : failureNotes;
      const normalizedStderr = providerFailureNotes.length > 0
        ? `${stderr}${stderr ? '\n' : ''}${providerFailureNotes.join('\n')}`
        : stderr;
      const exitCode = providerFailureNotes.length > 0 ? -1 : (code ?? -1);

      resolve({ text, costUsd, durationMs, exitCode, rawStdout: stdout, rawStderr: normalizedStderr, args });
    });
  });
};

export const spawnClaude: SpawnClaudeFn = (prompt, opts) =>
  spawnAgent(prompt, { ...opts, provider: subscriptionAgentProvider('claude') });
