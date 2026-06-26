/**
 * hook-io.ts — Shared I/O for Claude Code hooks running as TypeScript.
 *
 * Claude Code hooks receive JSON on stdin and write advisory text to stdout.
 * This module handles the boilerplate.
 */

import { appendFileSync } from 'node:fs';
import { createDefaultGitExec, resolveTargetWorktree, type GitExec } from './lib/git-state.js';

const getTraceFile = (): string => process.env.KAIZEN_HOOK_TRACE ?? '/tmp/.kaizen-hook-trace.jsonl';
const isTraceEnabled = (): boolean => process.env.KAIZEN_HOOK_TRACE !== '0';

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: { command?: string; [key: string]: unknown };
  tool_response?: {
    stdout?: string;
    stderr?: string;
    exit_code?: number | string;
  };
}

/** Read all of stdin and parse as JSON. Returns null on parse failure. */
export async function readHookInput(): Promise<HookInput | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    if (isTraceEnabled()) {
      try {
        appendFileSync(
          getTraceFile(),
          JSON.stringify({
            ts: new Date().toISOString(),
            hook: 'hook-io',
            error: 'json_parse_failed',
            raw_length: raw.length,
          }) + '\n',
        );
      } catch { /* never fail on trace */ }
    }
    return null;
  }
}

/**
 * Write a null-input trace entry to the hook trace log.
 * Call before `process.exit(0)` in hooks that have no local trace infrastructure.
 */
export function traceNullInput(hookName: string): void {
  if (!isTraceEnabled()) return;
  try {
    appendFileSync(
      getTraceFile(),
      JSON.stringify({
        ts: new Date().toISOString(),
        hook: hookName,
        action: 'ignore',
        reason: 'null_input',
      }) + '\n',
    );
  } catch { /* never fail on trace */ }
}

/** Write advisory output to stdout (shown to the agent in PostToolUse). */
export function writeHookOutput(text: string): void {
  process.stdout.write(text);
}

/**
 * Get the current git branch name. Returns empty string on failure.
 *
 * cmdLine-aware (#1073/#240): when the gated command is available, the branch
 * is read from that command's *target worktree* (`git -C <target> rev-parse
 * --abbrev-ref HEAD`) instead of the agent's inherited `process.cwd()`. With
 * no cmdLine the target falls back to cwd — behaviorally identical to the
 * legacy un-anchored call, but routed through the argv-safe git-state runner.
 */
export function getCurrentBranch(
  cmdLine = '',
  options: { cwd?: string; exec?: GitExec } = {},
): string {
  try {
    const exec = options.exec ?? createDefaultGitExec();
    const target = resolveTargetWorktree(cmdLine, options.cwd ?? process.cwd()).dir;
    const anchor: readonly string[] = target ? ['-C', target] : [];
    const r = exec([...anchor, 'rev-parse', '--abbrev-ref', 'HEAD']);
    return r.exitCode === 0 ? r.stdout.trim() : '';
  } catch {
    return '';
  }
}
