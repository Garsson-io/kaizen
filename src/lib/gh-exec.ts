/**
 * gh-exec.ts — Shared helper for running gh CLI commands via spawnSync.
 *
 * Used by plan-store.ts, section-editor.ts, and any future module
 * that needs to call the GitHub CLI mechanistically.
 */

import { spawnSync } from 'node:child_process';

export interface GhResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run a gh CLI command and return status/stdout/stderr without throwing. */
export function ghResult(args: string[], timeoutMs: number = 30_000): GhResult {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

/** Run a gh CLI command and return trimmed stdout. Throws on non-zero exit. */
export function gh(args: string[], timeoutMs: number = 30_000): string {
  const result = ghResult(args, timeoutMs);
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Parse a shell-style `gh ...` command string into argv without invoking a shell.
 *
 * Handles single quotes, double quotes, and common JSON-style escapes inside
 * double quotes. It deliberately treats backticks and `$()` as literal text.
 */
export function parseGhCommandArgs(cmd: string): string[] {
  const args: string[] = [];
  let current = '';
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === ' ' || c === '\t') {
      if (current !== '') { args.push(current); current = ''; }
      i++;
    } else if (c === '"') {
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < cmd.length) {
          const esc = cmd[i + 1];
          if (esc === '"' || esc === '\\' || esc === '/') { current += esc; i += 2; }
          else if (esc === 'n') { current += '\n'; i += 2; }
          else if (esc === 'r') { current += '\r'; i += 2; }
          else if (esc === 't') { current += '\t'; i += 2; }
          else { current += '\\'; current += esc; i += 2; }
        } else {
          current += cmd[i]; i++;
        }
      }
      i++;
    } else if (c === "'") {
      i++;
      while (i < cmd.length && cmd[i] !== "'") { current += cmd[i]; i++; }
      i++;
    } else {
      current += c; i++;
    }
  }
  if (current !== '') args.push(current);
  return args;
}

/**
 * Tolerant `gh ...` command-string adapter. Prefer `gh(args)` for new code; use
 * this when migrating older command-string call sites that must remain best-effort.
 */
export function ghExec(cmd: string): string {
  const args = parseGhCommandArgs(cmd);
  const [_bin, ...rest] = args;
  try {
    return gh(rest);
  } catch (e: any) {
    console.log(
      `  [gh] warning: ${cmd.slice(0, 80)}... -> ${e.message?.split('\n')[0] || 'failed'}`,
    );
    return '';
  }
}
