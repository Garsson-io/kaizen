/**
 * hook-runner.test.ts — Tests for the E2E hook runner infrastructure.
 *
 * The hook runner is test infrastructure used by plugin-lifecycle and other
 * E2E tests. Testing the runner itself ensures false passes don't slip through.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  preToolUse,
  postToolUse,
  stopEvent,
  bashPre,
  bashPost,
  writePre,
  allows,
  denies,
  blocks,
  denyReason,
  runHook,
  createMockDir,
  addGitMock,
  addGhMock,
  createStateDir,
  type HookResult,
  type MockDir,
  type StateDir,
} from "./hook-runner.js";

// Event Builders

describe("preToolUse", () => {
  it("builds a PreToolUse event with defaults", () => {
    const event = preToolUse("Bash", { command: "echo hello" });
    expect(event.hook_event_name).toBe("PreToolUse");
    expect(event.tool_name).toBe("Bash");
    expect(event.tool_input).toEqual({ command: "echo hello" });
    expect(event.session_id).toMatch(/^test-e2e-/);
    expect(event.permission_mode).toBe("default");
    expect(event.cwd).toBe(process.cwd());
  });

  it("accepts custom cwd and sessionId", () => {
    const event = preToolUse("Write", { file_path: "/tmp/x" }, { cwd: "/custom", sessionId: "s123" });
    expect(event.cwd).toBe("/custom");
    expect(event.session_id).toBe("s123");
  });
});

describe("postToolUse", () => {
  it("builds a PostToolUse event with response fields", () => {
    const event = postToolUse("Bash", { command: "ls" }, { stdout: "file.txt", stderr: "warn", exitCode: "1" });
    expect(event.hook_event_name).toBe("PostToolUse");
    expect(event.tool_name).toBe("Bash");
    expect(event.tool_response.stdout).toBe("file.txt");
    expect(event.tool_response.stderr).toBe("warn");
    expect(event.tool_response.exit_code).toBe("1");
  });

  it("defaults response fields to empty strings", () => {
    const event = postToolUse("Bash", { command: "ls" }, {});
    expect(event.tool_response.stdout).toBe("");
    expect(event.tool_response.stderr).toBe("");
    expect(event.tool_response.exit_code).toBe("0");
  });
});

describe("stopEvent", () => {
  it("builds a Stop event with defaults", () => {
    const event = stopEvent();
    expect(event.hook_event_name).toBe("Stop");
    expect(event.reason).toBe("task_complete");
  });

  it("accepts custom reason", () => {
    const event = stopEvent({ reason: "user_cancelled" });
    expect(event.reason).toBe("user_cancelled");
  });
});

// Convenience Builders

describe("bashPre", () => {
  it("builds a Bash PreToolUse event from a command string", () => {
    const event = bashPre("npm test");
    expect(event.tool_name).toBe("Bash");
    expect(event.tool_input).toEqual({ command: "npm test" });
    expect(event.hook_event_name).toBe("PreToolUse");
  });
});

describe("bashPost", () => {
  it("builds a Bash PostToolUse event", () => {
    const event = bashPost("npm test", "all passed", { stderr: "deprecation warning", exitCode: "0" });
    expect(event.tool_name).toBe("Bash");
    expect(event.tool_input).toEqual({ command: "npm test" });
    expect(event.tool_response.stdout).toBe("all passed");
    expect(event.tool_response.stderr).toBe("deprecation warning");
  });

  it("defaults optional fields", () => {
    const event = bashPost("echo hi", "hi");
    expect(event.tool_response.stderr).toBe("");
    expect(event.tool_response.exit_code).toBe("0");
  });
});

describe("writePre", () => {
  it("builds a Write PreToolUse event", () => {
    const event = writePre("/tmp/file.ts");
    expect(event.tool_name).toBe("Write");
    expect(event.tool_input.file_path).toBe("/tmp/file.ts");
    expect(event.tool_input.content).toBe("test content");
  });
});

// Result Analysis

describe("allows", () => {
  it("returns true for non-deny exit codes", () => {
    expect(allows({ hookPath: "h", stdout: "", stderr: "", exitCode: 1, timedOut: false })).toBe(true);
  });

  it("returns true when stdout is empty (no decision)", () => {
    expect(allows({ hookPath: "h", stdout: "", stderr: "", exitCode: 0, timedOut: false })).toBe(true);
  });

  it("returns true when stdout is not valid JSON", () => {
    expect(allows({ hookPath: "h", stdout: "not json", stderr: "", exitCode: 0, timedOut: false })).toBe(true);
  });

  it("returns false when stdout contains a deny decision", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "blocked" },
    });
    expect(allows({ hookPath: "h", stdout, stderr: "", exitCode: 0, timedOut: false })).toBe(false);
  });

  it("returns true when stdout has allow decision", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    expect(allows({ hookPath: "h", stdout, stderr: "", exitCode: 0, timedOut: false })).toBe(true);
  });

  it("returns true for exit code 2 with no deny in stdout", () => {
    expect(allows({ hookPath: "h", stdout: "{}", stderr: "", exitCode: 2, timedOut: false })).toBe(true);
  });
});

describe("denies", () => {
  it("returns true for a proper deny with reason and exit 0", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "not allowed" },
    });
    expect(denies({ hookPath: "h", stdout, stderr: "", exitCode: 0, timedOut: false })).toBe(true);
  });

  it("returns false when permissionDecisionReason is missing", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(denies({ hookPath: "h", stdout, stderr: "", exitCode: 0, timedOut: false })).toBe(false);
  });

  it("returns false for empty stdout", () => {
    expect(denies({ hookPath: "h", stdout: "", stderr: "", exitCode: 0, timedOut: false })).toBe(false);
  });

  it("returns false for invalid JSON", () => {
    expect(denies({ hookPath: "h", stdout: "garbage", stderr: "", exitCode: 0, timedOut: false })).toBe(false);
  });

  it("returns false for non-zero exit code even with deny decision", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "blocked" },
    });
    expect(denies({ hookPath: "h", stdout, stderr: "", exitCode: 1, timedOut: false })).toBe(false);
  });
});

describe("blocks", () => {
  it("returns true when decision is block", () => {
    const stdout = JSON.stringify({ decision: "block" });
    expect(blocks({ hookPath: "h", stdout, stderr: "", exitCode: 0, timedOut: false })).toBe(true);
  });

  it("returns false for allow decision", () => {
    const stdout = JSON.stringify({ decision: "allow" });
    expect(blocks({ hookPath: "h", stdout, stderr: "", exitCode: 0, timedOut: false })).toBe(false);
  });

  it("returns false for empty stdout", () => {
    expect(blocks({ hookPath: "h", stdout: "", stderr: "", exitCode: 0, timedOut: false })).toBe(false);
  });

  it("returns false for invalid JSON", () => {
    expect(blocks({ hookPath: "h", stdout: "not json", stderr: "", exitCode: 0, timedOut: false })).toBe(false);
  });
});

describe("denyReason", () => {
  it("extracts deny reason from valid JSON", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { permissionDecisionReason: "unsafe command" },
    });
    expect(denyReason({ hookPath: "h", stdout, stderr: "", exitCode: 0, timedOut: false })).toBe("unsafe command");
  });

  it("returns empty string when reason is missing", () => {
    const stdout = JSON.stringify({ hookSpecificOutput: {} });
    expect(denyReason({ hookPath: "h", stdout, stderr: "", exitCode: 0, timedOut: false })).toBe("");
  });

  it("returns empty string for invalid JSON", () => {
    expect(denyReason({ hookPath: "h", stdout: "nope", stderr: "", exitCode: 0, timedOut: false })).toBe("");
  });
});

// runHook

describe("runHook", () => {
  let mockDir: MockDir;

  beforeEach(() => {
    mockDir = createMockDir();
  });

  afterEach(() => {
    mockDir.cleanup();
  });

  it("runs a simple hook that exits 0", () => {
    const hookPath = join(mockDir.path, "hook.sh");
    writeFileSync(hookPath, '#!/bin/bash\necho "ok"');
    chmodSync(hookPath, 0o755);

    const result = runHook(hookPath, bashPre("echo hello"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr and non-zero exit code", () => {
    const hookPath = join(mockDir.path, "fail-hook.sh");
    writeFileSync(hookPath, '#!/bin/bash\necho "err msg" >&2\nexit 2');
    chmodSync(hookPath, 0o755);

    const result = runHook(hookPath, bashPre("bad cmd"));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("err msg");
  });

  it("reads stdin JSON from the event", () => {
    const hookPath = join(mockDir.path, "read-stdin.sh");
    writeFileSync(hookPath, '#!/bin/bash\nread input\necho "$input" | jq -r .tool_name');
    chmodSync(hookPath, 0o755);

    const result = runHook(hookPath, bashPre("test cmd"));
    expect(result.stdout).toBe("Bash");
  });

  it("respects timeout and marks timedOut", () => {
    const hookPath = join(mockDir.path, "slow-hook.sh");
    writeFileSync(hookPath, '#!/bin/bash\nsleep 30');
    chmodSync(hookPath, 0o755);

    const result = runHook(hookPath, bashPre("test"), { timeout: 500 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  it("passes custom env vars", () => {
    const hookPath = join(mockDir.path, "env-hook.sh");
    writeFileSync(hookPath, '#!/bin/bash\necho "$TEST_VAR"');
    chmodSync(hookPath, 0o755);

    const result = runHook(hookPath, bashPre("test"), { env: { TEST_VAR: "hello123" } });
    expect(result.stdout).toBe("hello123");
  });

  it("returns hookPath in result", () => {
    const hookPath = join(mockDir.path, "noop.sh");
    writeFileSync(hookPath, '#!/bin/bash\nexit 0');
    chmodSync(hookPath, 0o755);

    const result = runHook(hookPath, bashPre("test"));
    expect(result.hookPath).toBe(hookPath);
  });
});

// Mock Utilities

describe("createMockDir", () => {
  let mockDir: MockDir;

  afterEach(() => {
    mockDir?.cleanup();
  });

  it("creates a temp directory", () => {
    mockDir = createMockDir();
    expect(existsSync(mockDir.path)).toBe(true);
  });

  it("provides PATH with mock dir prepended", () => {
    mockDir = createMockDir();
    expect(mockDir.pathWithMocks.startsWith(mockDir.path)).toBe(true);
    expect(mockDir.pathWithMocks).toContain(":");
  });

  it("cleanup removes the directory", () => {
    mockDir = createMockDir();
    const path = mockDir.path;
    mockDir.cleanup();
    expect(existsSync(path)).toBe(false);
  });
});

describe("addGitMock", () => {
  let mockDir: MockDir;

  beforeEach(() => {
    mockDir = createMockDir();
  });

  afterEach(() => {
    mockDir.cleanup();
  });

  it("creates a git mock script", () => {
    addGitMock(mockDir);
    const gitPath = join(mockDir.path, "git");
    expect(existsSync(gitPath)).toBe(true);
    const content = readFileSync(gitPath, "utf-8");
    expect(content).toContain("#!/bin/bash");
    expect(content).toContain("rev-parse --abbrev-ref");
  });

  it("returns custom branch name", () => {
    addGitMock(mockDir, { branch: "feature/test-123" });
    const content = readFileSync(join(mockDir.path, "git"), "utf-8");
    expect(content).toContain("feature/test-123");
  });

  it("handles status output", () => {
    addGitMock(mockDir, { statusOutput: "M src/file.ts" });
    const content = readFileSync(join(mockDir.path, "git"), "utf-8");
    expect(content).toContain("M src/file.ts");
  });
});

describe("addGhMock", () => {
  let mockDir: MockDir;

  beforeEach(() => {
    mockDir = createMockDir();
  });

  afterEach(() => {
    mockDir.cleanup();
  });

  it("creates a gh mock script", () => {
    addGhMock(mockDir);
    const ghPath = join(mockDir.path, "gh");
    expect(existsSync(ghPath)).toBe(true);
    const content = readFileSync(ghPath, "utf-8");
    expect(content).toContain("#!/bin/bash");
    expect(content).toContain("pr view");
  });

  it("uses custom PR state", () => {
    addGhMock(mockDir, { prState: "MERGED" });
    const content = readFileSync(join(mockDir.path, "gh"), "utf-8");
    expect(content).toContain("MERGED");
  });
});

// State Directory Management

describe("createStateDir", () => {
  let stateDir: StateDir;

  afterEach(() => {
    stateDir?.cleanup();
  });

  it("creates a temp directory for state", () => {
    stateDir = createStateDir();
    expect(existsSync(stateDir.path)).toBe(true);
  });

  it("hasFile returns false when no files exist", () => {
    stateDir = createStateDir();
    expect(stateDir.hasFile("review")).toBe(false);
  });

  it("fileCount returns 0 when empty", () => {
    stateDir = createStateDir();
    expect(stateDir.fileCount("review")).toBe(0);
  });

  it("cleanup removes directory", () => {
    stateDir = createStateDir();
    const path = stateDir.path;
    stateDir.cleanup();
    expect(existsSync(path)).toBe(false);
  });
});

describe("createReviewState", () => {
  let stateDir: StateDir;

  beforeEach(() => {
    stateDir = createStateDir();
  });

  afterEach(() => {
    stateDir.cleanup();
  });

  it("creates a review state file with correct content", () => {
    stateDir.createReviewState("https://github.com/Garsson-io/kaizen/pull/42");
    expect(stateDir.hasFile("Garsson-io")).toBe(true);
    expect(stateDir.fileCount("kaizen")).toBe(1);

    const files = readdirSync(stateDir.path);
    expect(files.length).toBe(1);
    const content = readFileSync(join(stateDir.path, files[0]), "utf-8");
    expect(content).toContain("PR_URL=https://github.com/Garsson-io/kaizen/pull/42");
    expect(content).toContain("ROUND=1");
    expect(content).toContain("STATUS=needs_review");
  });

  it("respects custom round and status", () => {
    stateDir.createReviewState("https://github.com/Garsson-io/kaizen/pull/42", {
      round: 3,
      status: "approved",
      branch: "wt/custom-branch",
    });

    const files = readdirSync(stateDir.path);
    const content = readFileSync(join(stateDir.path, files[0]), "utf-8");
    expect(content).toContain("ROUND=3");
    expect(content).toContain("STATUS=approved");
    expect(content).toContain("BRANCH=wt/custom-branch");
  });
});

describe("createKaizenState", () => {
  let stateDir: StateDir;

  beforeEach(() => {
    stateDir = createStateDir();
  });

  afterEach(() => {
    stateDir.cleanup();
  });

  it("creates a kaizen state file with pr-kaizen prefix", () => {
    stateDir.createKaizenState("https://github.com/Garsson-io/kaizen/pull/99");

    const files = readdirSync(stateDir.path);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^pr-kaizen-/);

    const content = readFileSync(join(stateDir.path, files[0]), "utf-8");
    expect(content).toContain("PR_URL=https://github.com/Garsson-io/kaizen/pull/99");
    expect(content).toContain("STATUS=needs_pr_kaizen");
  });

  it("respects custom status and branch", () => {
    stateDir.createKaizenState("https://github.com/Garsson-io/kaizen/pull/99", {
      status: "complete",
      branch: "wt/fix-branch",
    });

    const files = readdirSync(stateDir.path);
    const content = readFileSync(join(stateDir.path, files[0]), "utf-8");
    expect(content).toContain("STATUS=complete");
    expect(content).toContain("BRANCH=wt/fix-branch");
  });
});
