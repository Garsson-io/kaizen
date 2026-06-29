import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

import {
  addGhMock,
  addGitMock,
  agentPost,
  allows,
  assertPostHookStdoutContains,
  bashPost,
  bashPre,
  createIsolatedHookEnv,
  createMockDir,
  createStateDir,
  denies,
  denyReason,
  runHook,
  stopEvent,
  type HookResult,
  type IsolatedHookEnv,
  type MockDir,
  type StateDir,
} from "./hook-runner.js";

const HOOKS_DIR = ".claude/hooks";

function hook(name: string): string {
  return `${HOOKS_DIR}/${name}`;
}

const REAL_COMMANDS = {
  prCreateHeredoc: `gh pr create --title "fix: address review findings" --body "$(cat <<'EOF'
## Summary
- Fixed prompt formatting
- Added missing imports

## Test plan
- [x] Unit tests pass

## Verification
- [ ] Run \`npm run build\`
- [ ] Send test message
EOF
)"`,
  prCreatePiped: 'gh pr create --title "test" --body "## Verification\\n- ok" | tee /tmp/pr.log',
  heredocWithGhText: `cat > /tmp/docs.md << 'EOF'
To create a PR, run:
  gh pr create --title "your title" --body "description"
  git push origin your-branch
EOF`,
  chainedCommitPush: 'git add src/index.ts && git commit -m "fix: update routing" && git push origin wt/test',
  complexMultiline: `gh pr create \\
  --title "feat: add voice transcription" \\
  --body "## Summary
Added whisper integration

## Verification
- Run npm test"`,
};

let isolated: IsolatedHookEnv;
let state: StateDir;
let mocks: MockDir;

function baseEnv(extra?: Record<string, string>): Record<string, string> {
  return {
    ...isolated.env,
    STATE_DIR: state.path,
    PATH: mocks.pathWithMocks,
    ...extra,
  };
}

function runPre(hookName: string, command: string, extraEnv?: Record<string, string>): HookResult {
  return runHook(hook(hookName), bashPre(command), { env: baseEnv(extraEnv) });
}

function runPost(
  hookName: string,
  command: string,
  stdout = "",
  opts?: { stderr?: string; exitCode?: string; timeout?: number },
): HookResult {
  return runHook(
    hook(hookName),
    bashPost(command, stdout, { stderr: opts?.stderr, exitCode: opts?.exitCode }),
    { env: baseEnv(), timeout: opts?.timeout ?? 30000 },
  );
}

beforeEach(() => {
  isolated = createIsolatedHookEnv();
  state = createStateDir();
  mocks = createMockDir();
  addGitMock(mocks, { branch: "wt/test-branch", statusOutput: "" });
  addGhMock(mocks);
});

afterEach(() => {
  mocks.cleanup();
  state.cleanup();
  isolated.cleanup();
});

describe("deny schema", () => {
  it("dirty files deny PR create with valid JSON", () => {
    addGitMock(mocks, { branch: "wt/test", statusOutput: " M src/dirty.ts" });

    const result = runPre("kaizen-check-dirty-files-ts.sh", "gh pr create --title test --body test");

    expect(denies(result), result.stdout).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("case worktree hook warns but allows commit on main", () => {
    addGitMock(mocks, { branch: "main", simulateMainCheckout: true });

    const result = runPre("kaizen-enforce-case-worktree.sh", "git commit -m test");

    expect(allows(result)).toBe(true);
    expect(result.stderr.toLowerCase()).toContain("worktree");
  });

  it("PR review gate denies during review", () => {
    state.createReviewState("https://github.com/Garsson-io/kaizen/pull/42", {
      round: 1,
      status: "needs_review",
      branch: "wt/test-branch",
    });

    const result = runPre("kaizen-enforce-pr-review-ts.sh", "npm install lodash");

    expect(denies(result), result.stdout).toBe(true);
    expect(denyReason(result).toLowerCase()).toContain("review");
  });

  it("deny JSON has required fields", () => {
    addGitMock(mocks, { statusOutput: " M src/dirty.ts" });

    const result = runPre("kaizen-check-dirty-files-ts.sh", "gh pr create --title test --body test");
    const data = JSON.parse(result.stdout);

    expect(data.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(data.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(10);
  });
});

describe("allow schema", () => {
  it.each(["npm test", "ls -la", "echo hello", "node -e 'console.log(1)'"])(
    "allows non-trigger command %s",
    (command) => {
      const result = runPre("kaizen-check-dirty-files-ts.sh", command);

      expect(allows(result), `${command}: ${result.stdout}`).toBe(true);
      expect(result.exitCode).toBe(0);
    },
  );

  it("allows PR create in a clean worktree", () => {
    const result = runPre("kaizen-check-dirty-files-ts.sh", "gh pr create --title test --body test");

    expect(allows(result), result.stdout).toBe(true);
  });
});

describe("real-world commands", () => {
  it("allows heredoc PR body with verification", () => {
    const result = runPre("kaizen-pr-quality-checks-ts.sh", REAL_COMMANDS.prCreateHeredoc);

    expect(allows(result), result.stdout).toBe(true);
  });

  it("does not treat gh pr create text inside heredoc as a command", () => {
    const result = runPre("kaizen-check-dirty-files-ts.sh", REAL_COMMANDS.heredocWithGhText);

    expect(allows(result), result.stdout).toBe(true);
  });

  it("allows piped PR create", () => {
    const result = runPre("kaizen-pr-quality-checks-ts.sh", REAL_COMMANDS.prCreatePiped);

    expect(allows(result), result.stdout).toBe(true);
  });

  it("allows chained git commands on a worktree branch", () => {
    addGitMock(mocks, { branch: "wt/260315-test" });

    const result = runPre("kaizen-enforce-case-worktree.sh", REAL_COMMANDS.chainedCommitPush);

    expect(allows(result), result.stderr).toBe(true);
  });

  it("detects PR create URL emitted on stderr", () => {
    const result = runHook(
      hook("pr-review-loop-ts.sh"),
      bashPost("gh pr create --title test --body test", "", {
        stderr: "https://github.com/Garsson-io/kaizen/pull/88",
      }),
      { env: baseEnv(), timeout: 30000 },
    );

    assertPostHookStdoutContains(result, "SELF-REVIEW", "PostToolUse pr-review-loop");
  });

  it("allows multiline PR create command", () => {
    const result = runPre("kaizen-pr-quality-checks-ts.sh", REAL_COMMANDS.complexMultiline);

    expect(allows(result), result.stdout).toBe(true);
  });
});

describe("edge cases", () => {
  it.each([
    "kaizen-enforce-pr-review-ts.sh",
    "kaizen-enforce-case-worktree.sh",
    "kaizen-check-dirty-files-ts.sh",
    "kaizen-pr-quality-checks-ts.sh",
  ])("handles empty command in %s", (hookName) => {
    const result = runPre(hookName, "");

    expect(result.exitCode, result.stderr).toBe(0);
  });

  it.each([
    "kaizen-enforce-pr-review-ts.sh",
    "kaizen-enforce-case-worktree.sh",
    "kaizen-check-dirty-files-ts.sh",
    "kaizen-pr-quality-checks-ts.sh",
  ])("handles missing tool_input in %s", (hookName) => {
    const rawJson = '{"session_id":"test","hook_event_name":"PreToolUse","tool_name":"Bash"}';
    const result = runHook(hook(hookName), rawJson, { env: baseEnv() });

    expect(result.exitCode, result.stderr).toBe(0);
  });

  it.each([
    "kaizen-enforce-pr-review-ts.sh",
    "kaizen-enforce-case-worktree.sh",
    "kaizen-check-dirty-files-ts.sh",
    "kaizen-pr-quality-checks-ts.sh",
  ])("handles malformed JSON in %s", (hookName) => {
    const result = runHook(hook(hookName), "not json at all", { env: baseEnv() });

    expect([0, 1, 2]).toContain(result.exitCode);
  });

  it("handles special characters in command", () => {
    const command = 'gh pr create --title \'fix: handle $PATH & "quotes"\' --body \'## Verification\\n- test\'';
    const result = runPre("kaizen-pr-quality-checks-ts.sh", command);

    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("handles very long command", () => {
    const longBody = "x".repeat(10000);
    const command = `gh pr create --title test --body "## Verification\\n${longBody}"`;
    const result = runPre("kaizen-pr-quality-checks-ts.sh", command);

    expect(result.exitCode, result.stderr).toBe(0);
  });
});

describe("PR lifecycle", () => {
  const prUrl = "https://github.com/Garsson-io/kaizen/pull/55";

  it("runs create, gate, review, push, and re-gate lifecycle", () => {
    expect(allows(runPre("kaizen-enforce-pr-review-ts.sh", "npm test"))).toBe(true);

    const created = runPost("pr-review-loop-ts.sh", "gh pr create --title test --body test", prUrl);
    assertPostHookStdoutContains(created, "SELF-REVIEW", "PostToolUse pr-review-loop");
    expect(state.reviewStateExists(prUrl)).toBe(true);
    expect(state.readReviewState(prUrl)?.STATUS).toBe("needs_review");
    expect(state.readReviewState(prUrl)?.ROUND).toBe("1");

    const blocked = runPre("kaizen-enforce-pr-review-ts.sh", "npm install lodash");
    expect(denies(blocked), blocked.stdout).toBe(true);

    expect(allows(runPre("kaizen-enforce-pr-review-ts.sh", "gh pr diff 55"))).toBe(true);

    runHook(hook("pr-review-loop-ts.sh"), agentPost(), { env: baseEnv(), timeout: 30000 });
    state.createReviewSentinel(prUrl, 1);
    runPost("pr-review-loop-ts.sh", "gh pr diff 55", "diff...");
    expect(state.readReviewState(prUrl)?.STATUS).toBe("passed");

    expect(allows(runPre("kaizen-enforce-pr-review-ts.sh", "npm test"))).toBe(true);

    runPost("pr-review-loop-ts.sh", "git push", "ok");
    expect(state.readReviewState(prUrl)?.STATUS).toBe("needs_review");
    expect(state.readReviewState(prUrl)?.ROUND).toBe("2");
  });

  it("requires review sentinel and Agent evidence before diff clears gate", () => {
    state.createReviewState(prUrl, { round: 1, status: "needs_review", branch: "wt/test-branch" });

    const noSentinel = runPost("pr-review-loop-ts.sh", "gh pr diff 55", "diff...");
    expect(state.readReviewState(prUrl)?.STATUS).toBe("needs_review");
    expect(noSentinel.stdout).toContain("no valid review sentinel stored");

    state.createReviewSentinel(prUrl, 1);
    const noAgent = runPost("pr-review-loop-ts.sh", "gh pr diff 55", "diff...");
    expect(state.readReviewState(prUrl)?.STATUS).toBe("needs_review");
    expect(noAgent.stdout).toContain("no observed Agent reviewer activity");

    runHook(hook("pr-review-loop-ts.sh"), agentPost(), { env: baseEnv(), timeout: 30000 });
    runPost("pr-review-loop-ts.sh", "gh pr diff 55", "diff...");
    expect(state.readReviewState(prUrl)?.STATUS).toBe("passed");
  });

  it("merge cleans up PR review state", () => {
    state.createReviewState(prUrl, { round: 2, status: "needs_review", branch: "wt/test-branch" });

    runPost("pr-review-loop-ts.sh", "gh pr merge 55 --squash", `✓ Merged ${prUrl}`);

    expect(state.reviewStateExists(prUrl)).toBe(false);
  });

  it("keeps review state isolated by repo", () => {
    const urlA = "https://github.com/Garsson-io/kaizen/pull/60";
    const urlB = "https://github.com/Garsson-io/garsson-prints/pull/10";

    runPost("pr-review-loop-ts.sh", "gh pr create --repo Garsson-io/kaizen", urlA);
    runPost("pr-review-loop-ts.sh", "gh pr create --repo Garsson-io/garsson-prints", urlB);

    expect(state.reviewStateExists(urlA)).toBe(true);
    expect(state.reviewStateExists(urlB)).toBe(true);

    runPost("pr-review-loop-ts.sh", "gh pr merge 60", `✓ Merged ${urlA}`);

    expect(state.reviewStateExists(urlA)).toBe(false);
    expect(state.reviewStateExists(urlB)).toBe(true);
  });

  it("does not create review state for failed PR create command", () => {
    runPost("pr-review-loop-ts.sh", "gh pr create --title test", "", { exitCode: "1" });

    expect(state.stateCount()).toBe(0);
  });
});

describe("parallel and combined hook behavior", () => {
  it("all PreToolUse hooks allow harmless commands", () => {
    for (const hookName of [
      "kaizen-enforce-pr-review-ts.sh",
      "kaizen-enforce-case-worktree.sh",
      "kaizen-pr-quality-checks-ts.sh",
      "kaizen-check-dirty-files-ts.sh",
    ]) {
      const result = runPre(hookName, "npm test");
      expect(allows(result), `${hookName}: ${result.stdout}`).toBe(true);
    }
  });

  it("multiple hooks can deny the same unsafe command", () => {
    addGitMock(mocks, { branch: "main", statusOutput: " M src/dirty.ts" });
    state.createReviewState("https://github.com/Garsson-io/kaizen/pull/42", {
      status: "needs_review",
      branch: "main",
    });

    const denying = [
      "kaizen-enforce-pr-review-ts.sh",
      "kaizen-check-dirty-files-ts.sh",
      "kaizen-enforce-case-worktree.sh",
    ].filter((hookName) => denies(runPre(hookName, "gh pr create --title test --body test")));

    expect(denying.length).toBeGreaterThanOrEqual(2);
  });

  it("both PostToolUse hooks react to PR create", () => {
    const input = bashPost(
      "gh pr create --title test --body test",
      "https://github.com/Garsson-io/kaizen/pull/99",
    );

    const reviewResult = runHook(hook("pr-review-loop-ts.sh"), input, { env: baseEnv(), timeout: 30000 });
    const reflectResult = runHook(hook("kaizen-reflect-ts.sh"), input, { env: baseEnv(), timeout: 30000 });

    assertPostHookStdoutContains(reviewResult, "SELF-REVIEW", "PostToolUse pr-review-loop");
    assertPostHookStdoutContains(reflectResult, "KAIZEN", "PostToolUse kaizen-reflect");
  });
});

describe("PostToolUse format", () => {
  it("post-hook assertion reports timeout diagnostics", () => {
    const result: HookResult = {
      hookPath: "kaizen-reflect-ts.sh",
      stdout: "",
      stderr: "TIMEOUT after 1s",
      exitCode: 124,
      timedOut: true,
    };

    expect(() => assertPostHookStdoutContains(result, "KAIZEN", "PostToolUse kaizen-reflect"))
      .toThrow(/PostToolUse kaizen-reflect timed out.*KAIZEN/);
  });

  it("post-hook assertion accepts expected output", () => {
    const result: HookResult = {
      hookPath: "kaizen-reflect-ts.sh",
      stdout: "KAIZEN: consider filing a process improvement",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };

    expect(() => assertPostHookStdoutContains(result, "KAIZEN", "PostToolUse kaizen-reflect")).not.toThrow();
  });

  it("post-hook assertion reports missing output without timeout", () => {
    const result: HookResult = {
      hookPath: "kaizen-reflect-ts.sh",
      stdout: "SELF-REVIEW: run review",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };

    expect(() => assertPostHookStdoutContains(result, "KAIZEN", "PostToolUse kaizen-reflect"))
      .toThrow(/did not emit "KAIZEN".*stdout=/);
  });

  it("runHook timeout reports real subprocess diagnostic", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "slow-post-hook-"));
    try {
      const slowHook = join(tempDir, "slow-post-hook.sh");
      writeFileSync(slowHook, "#!/bin/bash\nsleep 1\necho KAIZEN\n");
      chmodSync(slowHook, 0o755);

      const result = runHook(slowHook, bashPost("gh pr create", ""), {
        env: baseEnv(),
        timeout: 10,
      });

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(124);
      expect(() => assertPostHookStdoutContains(result, "KAIZEN", "PostToolUse slow hook"))
        .toThrow(/PostToolUse slow hook timed out.*KAIZEN.*slow-post-hook\.sh/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each(["pr-review-loop-ts.sh", "kaizen-reflect-ts.sh"])(
    "does not emit deny JSON from %s",
    (hookName) => {
      const result = runPost(
        hookName,
        "gh pr create --title test --body test",
        "https://github.com/Garsson-io/kaizen/pull/70",
      );

      expect(result.exitCode).toBe(0);
      if (result.stdout.trim().startsWith("{")) {
        expect(JSON.stringify(JSON.parse(result.stdout))).not.toContain("permissionDecision");
      }
    },
  );
});

describe("Stop hooks", () => {
  it("verify-before-stop allows when there are no changes", () => {
    addGitMock(mocks, { diffOutput: "" });

    const result = runHook(hook("kaizen-verify-before-stop.sh"), stopEvent(), { env: baseEnv() });

    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("cleanup hook always allows", () => {
    const result = runHook(hook("kaizen-check-cleanup-on-stop.sh"), stopEvent(), { env: baseEnv() });

    expect(result.exitCode, result.stderr).toBe(0);
  });
});
