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
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shellQuote } from "../lib/shell-quote.js";

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

export function agentPost(
  prompt = "Run /kaizen-review-pr dimension review",
  opts?: { stdout?: string; stderr?: string; exitCode?: string; cwd?: string; sessionId?: string },
): PostToolUseEvent {
  return postToolUse(
    "Agent",
    { prompt },
    { stdout: opts?.stdout ?? "review complete", stderr: opts?.stderr, exitCode: opts?.exitCode },
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

export function assertPostHookStdoutContains(result: HookResult, expected: string, context: string): void {
  if (result.timedOut) {
    throw new Error(
      `${context} timed out before emitting ${JSON.stringify(expected)}. ` +
      `hook=${result.hookPath}, exit=${result.exitCode}, stderr=${JSON.stringify(result.stderr)}. ` +
      "PostToolUse hooks are advisory and can be slow under fleet load; " +
      "increase the timeout option if this bounded test budget is too low.",
    );
  }
  if (!result.stdout.includes(expected)) {
    throw new Error(
      `${context} did not emit ${JSON.stringify(expected)}. ` +
      `hook=${result.hookPath}, exit=${result.exitCode}, ` +
      `stdout=${JSON.stringify(result.stdout.slice(0, 500))}, ` +
      `stderr=${JSON.stringify(result.stderr.slice(0, 500))}`,
    );
  }
}

// ── Hook Runner ──

export interface RunHookOptions {
  env?: Record<string, string>;
  timeout?: number;
  cwd?: string;
}

export interface IsolatedHookEnv {
  stateDir: string;
  auditDir: string;
  env: Record<string, string>;
  cleanup: () => void;
}

function repoRoot(): string {
  return process.cwd();
}

export function createIsolatedHookEnv(): IsolatedHookEnv {
  const root = mkdtempSync(join(tmpdir(), "hook-harness-"));
  const stateDir = join(root, "state");
  const auditDir = join(root, "audit");
  mkdirSync(stateDir);
  mkdirSync(auditDir);

  const env: Record<string, string> = {
    STATE_DIR: stateDir,
    AUDIT_DIR: auditDir,
    AUDIT_LOG: join(auditDir, "no-action.log"),
    DEBUG_LOG: "/dev/null",
    HOOK_TIMING_SENTINEL_DISABLED: "true",
    SEND_TELEGRAM_IPC_DISABLED: "true",
    KAIZEN_TEST_RUNNER: "1",
  };
  const localTsx = join(repoRoot(), "node_modules", ".bin", "tsx");
  if (existsSync(localTsx)) {
    env.KAIZEN_TSX_BIN = localTsx;
  }

  return {
    stateDir,
    auditDir,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function runHook(
  hookPath: string,
  event: HookEvent | string,
  opts?: RunHookOptions,
): HookResult {
  const json = typeof event === "string" ? event : JSON.stringify(event);
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
  opts?: {
    branch?: string;
    diffOutput?: string;
    isWorktree?: boolean;
    remoteUrl?: string;
    simulateMainCheckout?: boolean;
    statusOutput?: string;
  },
): void {
  const branch = opts?.branch ?? "wt/test-branch";
  const simulateMainCheckout = opts?.simulateMainCheckout ?? opts?.isWorktree === false;
  const gitDirLine = simulateMainCheckout
    ? 'echo ".git"; exit 0'
    : '/usr/bin/git rev-parse --git-dir 2>/dev/null';
  const statusOutput = opts?.statusOutput ?? "";
  const diffOutput = opts?.diffOutput ?? "";
  const contentDirty = statusOutput.trim() ? 1 : 0;
  const remoteUrl = opts?.remoteUrl ?? "https://github.com/Garsson-io/test-project.git";
  const script = `#!/bin/bash
if echo "$@" | grep -q "rev-parse --abbrev-ref"; then
  echo "${branch}"
  exit 0
fi
if echo "$@" | grep -q "status --porcelain"; then
  printf '%s' ${shellQuote(statusOutput)}
  exit 0
fi
if echo "$@" | grep -q "diff --quiet HEAD"; then
  exit ${contentDirty}
fi
if echo "$@" | grep -q "diff --name-only"; then
  printf '%s' ${shellQuote(diffOutput)}
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
  echo "${remoteUrl}"
  exit 0
fi
if echo "$@" | grep -q "log -1 --format=%P HEAD"; then
  echo "mock-parent-sha"
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

export function addGhMock(
  mockDir: MockDir,
  opts?: { prDiffOutput?: string; prState?: string; prViewBody?: string },
): void {
  const state = opts?.prState ?? "OPEN";
  const prDiffOutput = opts?.prDiffOutput ?? "diff --git a/src/test.ts b/src/test.ts";
  const prViewBody = opts?.prViewBody;
  const script = `#!/bin/bash
if echo "$@" | grep -q "pr view"; then
  if [ ${prViewBody === undefined ? "1" : "0"} -eq 1 ]; then
    echo "${state}"
  else
    printf '%s' ${shellQuote(prViewBody ?? "")}
  fi
  exit 0
fi
if echo "$@" | grep -q "pr diff"; then
  printf '%s' ${shellQuote(prDiffOutput)}
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
  createReviewSentinel: (prUrl: string, round: number | string) => void;
  createKaizenState: (prUrl: string, opts?: { status?: string; branch?: string }) => void;
  readReviewState: (prUrl: string) => Record<string, string> | undefined;
  reviewStateExists: (prUrl: string) => boolean;
  stateCount: () => number;
}

function stateKey(prUrl: string): string {
  return prUrl.replace("https://github.com/", "").replace("/pull/", "_").replace(/\//g, "_");
}

export function createStateDir(): StateDir {
  const dir = mkdtempSync(join(tmpdir(), "hook-state-"));
  const reviewStatePath = (prUrl: string) => join(dir, stateKey(prUrl));
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
      const content = `PR_URL=${prUrl}\nROUND=${opts?.round ?? 1}\nSTATUS=${opts?.status ?? "needs_review"}\nBRANCH=${opts?.branch ?? "wt/test-branch"}\n`;
      writeFileSync(reviewStatePath(prUrl), content);
      chmodSync(reviewStatePath(prUrl), 0o600);
    },
    createReviewSentinel: (prUrl: string, round: number | string) => {
      const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(prUrl);
      if (!match) {
        throw new Error(`createReviewSentinel: cannot parse PR URL: ${prUrl}`);
      }
      const [, repo, pr] = match;
      const localTsx = join(repoRoot(), "node_modules", ".bin", "tsx");
      const command = existsSync(localTsx) ? localTsx : "npx";
      const args = existsSync(localTsx)
        ? [
            "src/cli-structured-data.ts",
            "emit-test-review-sentinel",
            "--repo",
            repo,
            "--pr",
            pr,
            "--round",
            String(round),
          ]
        : [
            "tsx",
            "src/cli-structured-data.ts",
            "emit-test-review-sentinel",
            "--repo",
            repo,
            "--pr",
            pr,
            "--round",
            String(round),
          ];
      const result = spawnSync(command, args, {
        cwd: repoRoot(),
        encoding: "utf-8",
        env: { ...process.env, STATE_DIR: dir, KAIZEN_TEST_RUNNER: "1" },
        timeout: 30000,
      });
      if (result.status !== 0) {
        throw new Error(
          `emit-test-review-sentinel failed (${result.status}): ${result.stdout}${result.stderr}`,
        );
      }
    },
    createKaizenState: (prUrl: string, opts) => {
      const key = stateKey(prUrl);
      const content = `PR_URL=${prUrl}\nSTATUS=${opts?.status ?? "needs_pr_kaizen"}\nBRANCH=${opts?.branch ?? "wt/test-branch"}\n`;
      writeFileSync(join(dir, `pr-kaizen-${key}`), content);
    },
    readReviewState: (prUrl: string) => {
      const filePath = reviewStatePath(prUrl);
      if (!existsSync(filePath)) return undefined;
      const result: Record<string, string> = {};
      for (const line of readFileSync(filePath, "utf-8").trim().split("\n")) {
        const [key, ...rest] = line.split("=");
        if (key && rest.length > 0) {
          result[key] = rest.join("=");
        }
      }
      return result;
    },
    reviewStateExists: (prUrl: string) => existsSync(reviewStatePath(prUrl)),
    stateCount: () => readdirSync(dir).length,
  };
}
