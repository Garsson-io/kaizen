/**
 * hook-runner.ts — TypeScript hook execution engine for E2E tests.
 *
 * Simulates Claude Code's hook runner with proper JSON event construction,
 * subprocess isolation, and structured result parsing.
 *
 * Reuses the same event schema as the bash/python harnesses but with
 * type safety and vitest integration.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Event Input Types ──

export interface PreToolUseEvent {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PostToolUseEvent {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: {
    stdout: string;
    stderr: string;
    exit_code: string;
  };
}

export interface StopEvent {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: "Stop";
  reason: string;
}

export type HookEvent = PreToolUseEvent | PostToolUseEvent | StopEvent;

// ── Event Builders ──

export function preToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  opts?: { cwd?: string; sessionId?: string },
): PreToolUseEvent {
  return {
    session_id: opts?.sessionId ?? `test-e2e-${process.pid}`,
    transcript_path: "/tmp/test-transcript.txt",
    cwd: opts?.cwd ?? process.cwd(),
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
  };
}

export function postToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  response: { stdout?: string; stderr?: string; exitCode?: string },
  opts?: { cwd?: string; sessionId?: string },
): PostToolUseEvent {
  return {
    session_id: opts?.sessionId ?? `test-e2e-${process.pid}`,
    transcript_path: "/tmp/test-transcript.txt",
    cwd: opts?.cwd ?? process.cwd(),
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: {
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
      exit_code: response.exitCode ?? "0",
    },
  };
}

export function stopEvent(
  opts?: { reason?: string; cwd?: string; sessionId?: string },
): StopEvent {
  return {
    session_id: opts?.sessionId ?? `test-e2e-${process.pid}`,
    transcript_path: "/tmp/test-transcript.txt",
    cwd: opts?.cwd ?? process.cwd(),
    permission_mode: "default",
    hook_event_name: "Stop",
    reason: opts?.reason ?? "task_complete",
  };
}

// Convenience builders

export function bashPre(command: string, opts?: { cwd?: string; sessionId?: string }): PreToolUseEvent {
  return preToolUse("Bash", { command }, opts);
}

export function bashPost(
  command: string,
  stdout: string,
  opts?: { stderr?: string; exitCode?: string; cwd?: string; sessionId?: string },
): PostToolUseEvent {
  return postToolUse(
    "Bash",
    { command },
    { stdout, stderr: opts?.stderr, exitCode: opts?.exitCode },
    opts,
  );
}

export function writePre(filePath: string, opts?: { cwd?: string; sessionId?: string }): PreToolUseEvent {
  return preToolUse("Write", { file_path: filePath, content: "test content" }, opts);
}

// ── Hook Result Types ──

export interface HookResult {
  hookPath: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

// ── Result Analysis ──

export function allows(result: HookResult): boolean {
  if (result.exitCode !== 0 && result.exitCode !== 2) return true;
  if (!result.stdout.trim()) return true;
  try {
    const data = JSON.parse(result.stdout);
    return data?.hookSpecificOutput?.permissionDecision !== "deny";
  } catch {
    return true;
  }
}

export function denies(result: HookResult): boolean {
  if (!result.stdout.trim()) return false;
  try {
    const data = JSON.parse(result.stdout);
    const hso = data?.hookSpecificOutput;
    return hso?.permissionDecision === "deny" && !!hso?.permissionDecisionReason && result.exitCode === 0;
  } catch {
    return false;
  }
}

export function blocks(result: HookResult): boolean {
  if (!result.stdout.trim()) return false;
  try {
    const data = JSON.parse(result.stdout);
    return data?.decision === "block";
  } catch {
    return false;
  }
}

export function denyReason(result: HookResult): string {
  try {
    const data = JSON.parse(result.stdout);
    return data?.hookSpecificOutput?.permissionDecisionReason ?? "";
  } catch {
    return "";
  }
}

// ── Hook Runner ──

export interface RunHookOptions {
  env?: Record<string, string>;
  timeout?: number;
  cwd?: string;
}

export function runHook(
  hookPath: string,
  event: HookEvent,
  opts?: RunHookOptions,
): HookResult {
  const json = JSON.stringify(event);
  const timeout = opts?.timeout ?? 15000;
  const cwd = opts?.cwd ?? process.cwd();

  const env = { ...process.env, ...opts?.env };

  // Use spawnSync to capture both stdout and stderr regardless of exit code
  const result = spawnSync("bash", [hookPath], {
    input: json,
    encoding: "utf-8",
    env,
    cwd,
    timeout,
  });

  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { hookPath, stdout: "", stderr: `TIMEOUT after ${timeout}ms`, exitCode: 124, timedOut: true };
  }

  return {
    hookPath,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    exitCode: result.status ?? 1,
    timedOut: false,
  };
}

// ── Mock Utilities ──

export interface MockDir {
  path: string;
  pathWithMocks: string;
  cleanup: () => void;
}

export function createMockDir(): MockDir {
  const dir = mkdtempSync(join(tmpdir(), "mock-bin-"));
  return {
    path: dir,
    pathWithMocks: `${dir}:${process.env.PATH}`,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function addGitMock(
  mockDir: MockDir,
  opts?: { branch?: string; isWorktree?: boolean; statusOutput?: string },
): void {
  const branch = opts?.branch ?? "wt/test-branch";
  const gitDirLine = opts?.isWorktree === false
    ? 'echo ".git"; exit 0'
    : '/usr/bin/git rev-parse --git-dir 2>/dev/null';
  const script = `#!/bin/bash
if echo "$@" | grep -q "rev-parse --abbrev-ref"; then
  echo "${branch}"
  exit 0
fi
if echo "$@" | grep -q "status --porcelain"; then
  printf '%s' '${opts?.statusOutput ?? ""}'
  exit 0
fi
if echo "$@" | grep -q "rev-parse --git-common-dir"; then
  echo ".git"
  exit 0
fi
if echo "$@" | grep -q "rev-parse --git-dir"; then
  ${gitDirLine}
fi
if echo "$@" | grep -q "remote get-url"; then
  echo "https://github.com/Garsson-io/test-project.git"
  exit 0
fi
if echo "$@" | grep -q "diff --name-only"; then
  exit 0
fi
if echo "$@" | grep -q "rev-parse --show-toplevel"; then
  pwd
  exit 0
fi
/usr/bin/git "$@" 2>/dev/null
`;
  writeFileSync(join(mockDir.path, "git"), script);
  chmodSync(join(mockDir.path, "git"), 0o755);
}

export function addGhMock(mockDir: MockDir, opts?: { prState?: string }): void {
  const state = opts?.prState ?? "OPEN";
  const script = `#!/bin/bash
if echo "$@" | grep -q "pr view"; then
  echo "${state}"
  exit 0
fi
if echo "$@" | grep -q "pr diff"; then
  echo "diff --git a/src/test.ts b/src/test.ts"
  exit 0
fi
if echo "$@" | grep -q "issue"; then
  exit 0
fi
exit 0
`;
  writeFileSync(join(mockDir.path, "gh"), script);
  chmodSync(join(mockDir.path, "gh"), 0o755);
}

// ── State Directory Management ──

export interface StateDir {
  path: string;
  cleanup: () => void;
  hasFile: (pattern: string) => boolean;
  fileCount: (pattern: string) => number;
  createReviewState: (prUrl: string, opts?: { round?: number; status?: string; branch?: string }) => void;
  createKaizenState: (prUrl: string, opts?: { status?: string; branch?: string }) => void;
}

export function createStateDir(): StateDir {
  const dir = mkdtempSync(join(tmpdir(), "hook-state-"));
  return {
    path: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    hasFile: (pattern: string) => {
      try {
        return readdirSync(dir).some(f => f.includes(pattern));
      } catch {
        return false;
      }
    },
    fileCount: (pattern: string) => {
      try {
        return readdirSync(dir).filter(f => f.includes(pattern)).length;
      } catch {
        return 0;
      }
    },
    createReviewState: (prUrl: string, opts) => {
      const key = prUrl.replace("https://github.com/", "").replace("/pull/", "_").replace(/\//g, "_");
      const content = `PR_URL=${prUrl}\nROUND=${opts?.round ?? 1}\nSTATUS=${opts?.status ?? "needs_review"}\nBRANCH=${opts?.branch ?? "wt/test-branch"}\n`;
      writeFileSync(join(dir, key), content);
    },
    createKaizenState: (prUrl: string, opts) => {
      const key = prUrl.replace("https://github.com/", "").replace("/pull/", "_").replace(/\//g, "_");
      const content = `PR_URL=${prUrl}\nSTATUS=${opts?.status ?? "needs_pr_kaizen"}\nBRANCH=${opts?.branch ?? "wt/test-branch"}\n`;
      writeFileSync(join(dir, `pr-kaizen-${key}`), content);
    },
  };
}
