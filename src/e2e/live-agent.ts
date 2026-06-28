import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  buildSpawnClaudeArgs,
  spawnClaudeJson,
  type SpawnClaudeJsonFn,
  type SpawnClaudeJsonResult,
} from "../spawn-claude.js";
import { KAIZEN_ROOT } from "./test-runtime.js";

const RAW_PREVIEW_CHARS = 300;

export type ExpectedSignal = string | RegExp | {
  name: string;
  pattern: string | RegExp;
};

export interface LiveAgentOptions {
  cwd?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /**
   * Local plugin dir by default. Use null only for tests that explicitly verify
   * installed-plugin behavior.
   */
  pluginDir?: string | null;
  artifactName?: string;
  resultsDir?: string;
  expectedSignals?: ExpectedSignal[];
  spawn?: SpawnClaudeJsonFn;
  env?: NodeJS.ProcessEnv;
}

export interface LiveAgentRunResult {
  text: string;
  rawPath: string;
  rawStdout: string;
  rawStderr: string;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  durationMs: number;
  costUsd: number | null;
  numTurns: number | null;
  matchedSignals: string[];
  args: string[];
}

export function buildLiveAgentArgs(opts: LiveAgentOptions & { prompt?: string } = {}): string[] {
  return buildSpawnClaudeArgs({
    outputFormat: "json",
    verbose: false,
    model: opts.model ?? "haiku",
    maxTurns: opts.maxTurns ?? 5,
    maxBudgetUsd: opts.maxBudgetUsd ?? 0.50,
    pluginDir: opts.pluginDir === undefined ? KAIZEN_ROOT : opts.pluginDir,
    promptArg: opts.prompt,
  });
}

function sanitizeArtifactName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "live-agent-run";
}

function preview(rawStdout: string, rawStderr: string): string {
  return (rawStdout || rawStderr).slice(0, RAW_PREVIEW_CHARS);
}

function defaultResultsDir(): string {
  return resolve(KAIZEN_ROOT, ".claude", "e2e-results", "live-agent");
}

function signalName(signal: ExpectedSignal): string {
  if (typeof signal === "string") return signal;
  if (signal instanceof RegExp) return signal.toString();
  return signal.name;
}

function signalMatches(text: string, signal: ExpectedSignal): boolean {
  if (typeof signal === "string") {
    return text.toLowerCase().includes(signal.toLowerCase());
  }
  if (signal instanceof RegExp) return signal.test(text);
  if (typeof signal.pattern === "string") {
    return text.toLowerCase().includes(signal.pattern.toLowerCase());
  }
  return signal.pattern.test(text);
}

function persistCheckpoint(
  result: SpawnClaudeJsonResult,
  prompt: string,
  opts: LiveAgentOptions,
): string {
  const rawDir = opts.resultsDir ?? defaultResultsDir();
  mkdirSync(rawDir, { recursive: true });
  const base = sanitizeArtifactName(opts.artifactName ?? `live-agent-${Date.now()}`);
  const rawPath = join(rawDir, `${base}.json`);

  writeFileSync(
    rawPath,
    JSON.stringify({
      command: "claude -p",
      args: result.args,
      cwd: opts.cwd ?? KAIZEN_ROOT,
      prompt,
      model: opts.model ?? "haiku",
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.rawStdout,
      stderr: result.rawStderr,
    }, null, 2),
    "utf8",
  );

  return rawPath;
}

export async function runLiveAgent(prompt: string, opts: LiveAgentOptions = {}): Promise<LiveAgentRunResult> {
  const cwd = opts.cwd ?? KAIZEN_ROOT;
  const spawn = opts.spawn ?? spawnClaudeJson;
  const result = await spawn(prompt, {
    cwd,
    timeoutMs: opts.timeoutMs ?? 120_000,
    model: opts.model ?? "haiku",
    maxTurns: opts.maxTurns ?? 5,
    maxBudgetUsd: opts.maxBudgetUsd ?? 0.50,
    pluginDir: opts.pluginDir === undefined ? KAIZEN_ROOT : opts.pluginDir,
    env: { ...opts.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
  });
  const rawPath = persistCheckpoint(result, prompt, { ...opts, cwd });

  if (result.error) {
    throw new Error(`claude spawn error: ${result.error.message}; raw output: ${rawPath}\n${preview(result.rawStdout, result.rawStderr)}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`claude exited ${result.exitCode}; raw output: ${rawPath}\n${preview(result.rawStdout, result.rawStderr)}`);
  }
  if (!result.text.trim()) {
    throw new Error(`claude returned empty result; raw output: ${rawPath}\n${preview(result.rawStdout, result.rawStderr)}`);
  }

  const expectedSignals = opts.expectedSignals ?? [];
  const missing = expectedSignals.filter((signal) => !signalMatches(result.text, signal));
  if (missing.length > 0) {
    throw new Error(
      `missing expected signal(s): ${missing.map(signalName).join(", ")}; raw output: ${rawPath}\n` +
        preview(result.rawStdout, result.rawStderr),
    );
  }

  return {
    text: result.text,
    rawPath,
    rawStdout: result.rawStdout,
    rawStderr: result.rawStderr,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    costUsd: result.costUsd,
    numTurns: result.numTurns,
    matchedSignals: expectedSignals.map(signalName),
    args: result.args,
  };
}
