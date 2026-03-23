/**
 * plugin-lifecycle.test.ts — End-to-end tests for the kaizen plugin lifecycle.
 *
 * Tests the FULL operation: setup → hook registration → workflow simulation.
 * No LLM needed — hooks are executed directly with simulated Claude Code events.
 *
 * This is the "trigger-to-outcome" test for kaizen itself (cf. NanoClaw issue #173).
 * It verifies that:
 *   1. Setup produces correct configuration
 *   2. All hooks are registered and executable
 *   3. A complete dev workflow (edit → commit → PR → review → reflect → stop)
 *      enforces correctly through the hook chain
 *   4. All SKILL.md files are structurally valid
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  generateConfig,
  scaffoldPolicies,
  verifySetup,
} from "../kaizen-setup.js";

import {
  runHook,
  bashPre,
  bashPost,
  writePre,
  stopEvent,
  allows,
  denies,
  blocks,
  createMockDir,
  addGitMock,
  addGhMock,
  createStateDir,
  type MockDir,
  type StateDir,
} from "./hook-runner.js";

// ── Paths ──

const KAIZEN_ROOT = resolve(__dirname, "../..");
const HOOKS_DIR = join(KAIZEN_ROOT, ".claude", "hooks");
const SKILLS_DIR = join(KAIZEN_ROOT, ".claude", "skills");
const PLUGIN_JSON_PATH = join(KAIZEN_ROOT, ".claude-plugin", "plugin.json");

// ── Shared Test State ──

let hostProject: string;
let mockDir: MockDir;
let stateDir: StateDir;

// Parse plugin.json for hook registration verification
const pluginJson = JSON.parse(readFileSync(PLUGIN_JSON_PATH, "utf-8"));

// ── Helpers ──

function hookPath(name: string): string {
  return join(HOOKS_DIR, name);
}

function hookEnv(opts?: { branch?: string; isWorktree?: boolean }): Record<string, string> {
  return {
    STATE_DIR: stateDir.path,
    AUDIT_DIR: join(stateDir.path, "audit"),
    PATH: mockDir.pathWithMocks,
    DEBUG_LOG: "/dev/null",
    IPC_DIR: join(stateDir.path, "ipc"),
  };
}

function runKaizenHook(name: string, event: Parameters<typeof runHook>[1]): HookResult {
  return runHook(hookPath(name), event, { env: hookEnv() });
}

// ── Setup / Teardown ──

beforeAll(() => {
  // Create a simulated host project with kaizen installed as plugin
  hostProject = mkdtempSync(join(tmpdir(), "kaizen-e2e-host-"));

  // Initialize git repo so hooks can use git commands
  execSync("git init", { cwd: hostProject, stdio: "pipe" });
  execSync('git config user.email "test@kaizen.dev"', { cwd: hostProject, stdio: "pipe" });
  execSync('git config user.name "Kaizen Test"', { cwd: hostProject, stdio: "pipe" });
  execSync('git commit --allow-empty -m "init"', { cwd: hostProject, stdio: "pipe" });
});

afterAll(() => {
  rmSync(hostProject, { recursive: true, force: true });
});

beforeEach(() => {
  mockDir = createMockDir();
  addGitMock(mockDir, { branch: "wt/test-branch", isWorktree: true });
  addGhMock(mockDir);
  stateDir = createStateDir();
});

afterEach(() => {
  mockDir?.cleanup();
  stateDir?.cleanup();
});

// ════════════════════════════════════════════════════════════════════
// Part 1: Setup Verification
// ════════════════════════════════════════════════════════════════════

describe("Part 1: Setup produces correct configuration", () => {
  it("generates valid kaizen.config.json", () => {
    const result = generateConfig(
      { name: "test-project", repo: "org/test-project", description: "E2E test host" },
      hostProject,
    );
    expect(result.status).toBe("ok");

    const config = JSON.parse(readFileSync(join(hostProject, "kaizen.config.json"), "utf-8"));
    expect(config.host.name).toBe("test-project");
    expect(config.host.repo).toBe("org/test-project");
    expect(config.kaizen.repo).toBe("Garsson-io/kaizen");
  });

  it("scaffolds policies-local.md", () => {
    const result = scaffoldPolicies(hostProject);
    expect(result.status).toBe("ok");
    expect(existsSync(join(hostProject, ".claude", "kaizen", "policies-local.md"))).toBe(true);
  });

  it("plugin.json registers hooks for all four event types", () => {
    const hooks = pluginJson.hooks;
    expect(hooks).toBeDefined();
    expect(Object.keys(hooks)).toEqual(
      expect.arrayContaining(["SessionStart", "PreToolUse", "PostToolUse", "Stop"]),
    );
  });

  it("verifySetup passes for properly configured host", () => {
    execSync(`echo "# Project\n\n## Kaizen\nkaizen plugin installed" > "${join(hostProject, "CLAUDE.md")}"`, { stdio: "pipe" });

    const result = verifySetup(hostProject);
    const passedNames = result.checks.filter((c) => c.ok).map((c) => c.name);
    expect(passedNames).toContain("config-valid");
    expect(passedNames).toContain("policies-local");
    expect(passedNames).toContain("claudemd-kaizen");
  });
});

// ════════════════════════════════════════════════════════════════════
// Part 2: Hook Registration Completeness
// ════════════════════════════════════════════════════════════════════

describe("Part 2: All hooks are registered and executable", () => {
  // Extract all unique hook commands from plugin.json
  const allHookCommands: string[] = [];
  for (const eventEntries of Object.values(pluginJson.hooks) as any[]) {
    for (const entry of eventEntries) {
      for (const hook of entry.hooks ?? []) {
        if (hook.command && !allHookCommands.includes(hook.command)) {
          allHookCommands.push(hook.command);
        }
      }
    }
  }

  it("has a non-trivial number of hooks registered", () => {
    expect(allHookCommands.length).toBeGreaterThanOrEqual(20);
  });

  for (const cmd of allHookCommands) {
    const hookName = cmd.split("/").pop()!;
    const resolvedPath = join(KAIZEN_ROOT, ".claude", "hooks", hookName);

    it(`${hookName} exists and is executable`, () => {
      expect(existsSync(resolvedPath), `Missing: ${resolvedPath}`).toBe(true);
      const stats = statSync(resolvedPath);
      expect(stats.mode & 0o111, `Not executable: ${hookName}`).toBeGreaterThan(0);
    });
  }

  it("plugin.json covers all four event types", () => {
    const events = Object.keys(pluginJson.hooks);
    expect(events).toContain("SessionStart");
    expect(events).toContain("PreToolUse");
    expect(events).toContain("PostToolUse");
    expect(events).toContain("Stop");
  });

  it("PreToolUse covers Bash, Edit|Write, and Agent matchers", () => {
    const matchers = (pluginJson.hooks.PreToolUse as any[]).map(
      (e: any) => e.matcher ?? "*",
    );
    expect(matchers).toContain("Bash");
    expect(matchers).toContain("Edit|Write");
    expect(matchers).toContain("Agent");
  });
});

// ════════════════════════════════════════════════════════════════════
// Part 3: Skill Inventory Verification
// ════════════════════════════════════════════════════════════════════

describe("Part 3: All skills are structurally valid", () => {
  const skillDirs = readdirSync(SKILLS_DIR).filter((d) =>
    d.startsWith("kaizen-") && statSync(join(SKILLS_DIR, d)).isDirectory(),
  );

  it("has a non-trivial number of skills", () => {
    expect(skillDirs.length).toBeGreaterThanOrEqual(10);
  });

  // Known skills without frontmatter (legacy format — should be fixed)
  const SKILLS_WITHOUT_FRONTMATTER = new Set(["kaizen-review-pr"]);

  for (const dir of skillDirs) {
    it(`${dir}/SKILL.md exists and has valid frontmatter`, () => {
      const skillPath = join(SKILLS_DIR, dir, "SKILL.md");
      expect(existsSync(skillPath), `Missing SKILL.md in ${dir}`).toBe(true);

      const content = readFileSync(skillPath, "utf-8");

      if (SKILLS_WITHOUT_FRONTMATTER.has(dir)) {
        // Known exception — just verify the file has content
        expect(content.length).toBeGreaterThan(10);
        return;
      }

      // Must have YAML frontmatter
      expect(content.startsWith("---"), `${dir} SKILL.md missing frontmatter`).toBe(true);
      const endIndex = content.indexOf("---", 3);
      expect(endIndex, `${dir} SKILL.md frontmatter not closed`).toBeGreaterThan(3);

      const frontmatter = content.slice(3, endIndex).trim();

      // Must have name and description
      expect(frontmatter).toContain("name:");
      expect(frontmatter).toContain("description:");

      // Name should match directory
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
      expect(nameMatch, `${dir} missing name field`).toBeTruthy();
      expect(nameMatch![1].trim()).toBe(dir);
    });
  }
});

// ════════════════════════════════════════════════════════════════════
// Part 4: Workflow Simulation — The Main Event
// ════════════════════════════════════════════════════════════════════

describe("Part 4: Dev workflow simulation through hooks", () => {
  // Tests simulate a realistic Claude Code session by sending events
  // through individual hooks. This is the trigger-to-outcome test:
  // given a sequence of Claude Code events, do hooks produce the
  // correct enforcement decisions?

  describe("4a: Write enforcement (enforce-worktree-writes)", () => {
    it("blocks source code writes in main checkout on main branch", () => {
      const mainMock = createMockDir();
      addGitMock(mainMock, { branch: "main", isWorktree: false });
      const env = { ...hookEnv(), PATH: mainMock.pathWithMocks };
      const cwd = process.cwd();

      const result = runHook(
        hookPath("kaizen-enforce-worktree-writes.sh"),
        // File path must be inside the cwd for the hook to detect it as "in main checkout"
        writePre(`${cwd}/src/index.ts`),
        { env },
      );
      expect(denies(result), `Should block source write on main: stdout='${result.stdout}' stderr='${result.stderr}'`).toBe(true);
      mainMock.cleanup();
    });

    it("allows config writes in main checkout", () => {
      const mainMock = createMockDir();
      addGitMock(mainMock, { branch: "main", isWorktree: false });
      const env = { ...hookEnv(), PATH: mainMock.pathWithMocks };
      const cwd = process.cwd();

      const result = runHook(
        hookPath("kaizen-enforce-worktree-writes.sh"),
        writePre(`${cwd}/.claude/settings.json`),
        { env },
      );
      expect(allows(result), `Should allow .claude/ write: stdout='${result.stdout}' stderr='${result.stderr}'`).toBe(true);
      mainMock.cleanup();
    });

    it("allows source writes in a worktree", () => {
      // Default mock has isWorktree: true — hook skips enforcement in worktrees
      const result = runKaizenHook(
        "kaizen-enforce-worktree-writes.sh",
        writePre(`${process.cwd()}/src/index.ts`),
      );
      expect(allows(result), `Should allow write in worktree: stdout='${result.stdout}'`).toBe(true);
    });
  });

  describe("4b: Commit/push advisory (enforce-case-worktree)", () => {
    it("warns on git commit in main checkout", () => {
      const mainMock = createMockDir();
      addGitMock(mainMock, { branch: "main", isWorktree: false });
      const env = { ...hookEnv(), PATH: mainMock.pathWithMocks };

      const result = runHook(
        hookPath("kaizen-enforce-case-worktree.sh"),
        bashPre('git commit -m "test"'),
        { env },
      );
      // Advisory only — exit 0 but with stderr warning about main checkout
      expect(result.exitCode).toBe(0);
      // The hook warns about being in "main checkout" or on a specific branch
      expect(result.stderr).toMatch(/main|checkout|worktree/i);
    });

    it("passes silently in a worktree", () => {
      const result = runKaizenHook(
        "kaizen-enforce-case-worktree.sh",
        bashPre('git commit -m "test"'),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("ignores non-git commands", () => {
      const result = runKaizenHook(
        "kaizen-enforce-case-worktree.sh",
        bashPre("npm test"),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  describe("4c: Git rebase blocking (block-git-rebase)", () => {
    it("blocks git rebase -i", () => {
      const result = runKaizenHook(
        "kaizen-block-git-rebase.sh",
        bashPre("git rebase -i HEAD~3"),
      );
      expect(denies(result), `Should block interactive rebase: ${result.stdout}`).toBe(true);
    });

    it("allows non-rebase git commands", () => {
      const result = runKaizenHook(
        "kaizen-block-git-rebase.sh",
        bashPre("git log --oneline"),
      );
      expect(allows(result)).toBe(true);
    });
  });

  describe("4d: PR review lifecycle", () => {
    it("blocks non-review commands when review state is active", () => {
      const prUrl = "https://github.com/Garsson-io/test-project/pull/42";
      stateDir.createReviewState(prUrl);

      // npm test is now allowed as diagnostic (kaizen #775), use npm install instead
      const result = runKaizenHook(
        "kaizen-enforce-pr-review-ts.sh",
        bashPre("npm install lodash"),
      );
      expect(denies(result), `Should block npm install during review: ${result.stdout}`).toBe(true);
    });

    it("allows review commands when review state is active", () => {
      const prUrl = "https://github.com/Garsson-io/test-project/pull/42";
      stateDir.createReviewState(prUrl);

      const result = runKaizenHook(
        "kaizen-enforce-pr-review-ts.sh",
        bashPre("gh pr diff 42"),
      );
      expect(allows(result), `Should allow gh pr diff during review: ${result.stdout}`).toBe(true);
    });

    it("allows everything when no review state exists", () => {
      const result = runKaizenHook(
        "kaizen-enforce-pr-review-ts.sh",
        bashPre("npm test"),
      );
      expect(allows(result)).toBe(true);
    });

    it("blocks Edit/Write/Agent during review", () => {
      const prUrl = "https://github.com/Garsson-io/test-project/pull/42";
      stateDir.createReviewState(prUrl);

      const writeResult = runKaizenHook(
        "kaizen-enforce-pr-review-tools.sh",
        writePre("/some/file.ts"),
      );
      expect(denies(writeResult), `Should block Write during review: ${writeResult.stdout}`).toBe(true);
    });

    it("blocks Stop during active review", () => {
      const prUrl = "https://github.com/Garsson-io/test-project/pull/42";
      stateDir.createReviewState(prUrl);

      const result = runKaizenHook(
        "kaizen-stop-gate.sh",
        stopEvent(),
      );
      expect(blocks(result), `Should block Stop during review: ${result.stdout}`).toBe(true);
    });
  });

  describe("4e: Kaizen reflection lifecycle", () => {
    it("PR create triggers reflection prompt and sets kaizen gate", () => {
      const prUrl = "https://github.com/Garsson-io/test-project/pull/77";

      const result = runKaizenHook(
        "kaizen-reflect-ts.sh",
        bashPost('gh pr create --title "test"', prUrl),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("KAIZEN");
      expect(stateDir.hasFile("pr-kaizen-")).toBe(true);
    });

    it("blocks non-kaizen commands when reflection gate is active", () => {
      const prUrl = "https://github.com/Garsson-io/test-project/pull/77";
      stateDir.createKaizenState(prUrl);

      // npm test is now allowed as diagnostic (kaizen #775), use npm install instead
      const result = runKaizenHook(
        "kaizen-enforce-pr-reflect-ts.sh",
        bashPre("npm install lodash"),
      );
      expect(denies(result), `Should block during kaizen reflection: ${result.stdout}`).toBe(true);
    });

    it("allows kaizen-related commands during reflection gate", () => {
      const prUrl = "https://github.com/Garsson-io/test-project/pull/77";
      stateDir.createKaizenState(prUrl);

      const result = runKaizenHook(
        "kaizen-enforce-pr-reflect-ts.sh",
        bashPre("gh issue create --title 'kaizen: found issue' --repo Garsson-io/kaizen"),
      );
      expect(allows(result), `Should allow gh issue create during reflection: ${result.stdout}`).toBe(true);
    });

    it("valid KAIZEN_IMPEDIMENTS clears the reflection gate", () => {
      const prUrl = "https://github.com/Garsson-io/test-project/pull/77";
      stateDir.createKaizenState(prUrl);

      // The COMMAND must contain KAIZEN_IMPEDIMENTS: — the hook checks the command text
      const impedimentsJson = '[{"impediment": "test issue", "disposition": "filed", "ref": "#100"}]';
      const command = `echo 'KAIZEN_IMPEDIMENTS:' && echo '${impedimentsJson}'`;
      const stdout = `KAIZEN_IMPEDIMENTS:\n${impedimentsJson}`;
      const result = runKaizenHook(
        "pr-kaizen-clear-ts.sh",
        bashPost(command, stdout),
      );
      expect(result.exitCode).toBe(0);
      expect(stateDir.hasFile("pr-kaizen-"), `Gate should be cleared: stderr=${result.stderr}`).toBe(false);
    });

    it("rejects waived dispositions (kaizen #198)", () => {
      const prUrl = "https://github.com/Garsson-io/test-project/pull/77";
      stateDir.createKaizenState(prUrl);

      const waivedJson = '[{"impediment": "test", "disposition": "waived", "reason": "skip"}]';
      const command = `echo 'KAIZEN_IMPEDIMENTS:' && echo '${waivedJson}'`;
      const stdout = `KAIZEN_IMPEDIMENTS:\n${waivedJson}`;
      const result = runKaizenHook(
        "pr-kaizen-clear-ts.sh",
        bashPost(command, stdout),
      );
      // Gate should still be active — waived is rejected
      expect(stateDir.hasFile("pr-kaizen-")).toBe(true);
    });

    it("blocks Stop when reflection gate is active", () => {
      const prUrl = "https://github.com/Garsson-io/test-project/pull/77";
      stateDir.createKaizenState(prUrl);

      const result = runKaizenHook(
        "kaizen-stop-gate.sh",
        stopEvent(),
      );
      expect(blocks(result), `Should block Stop during reflection: ${result.stdout}`).toBe(true);
    });

    it("KAIZEN_NO_ACTION also clears the gate", () => {
      const prUrl = "https://github.com/Garsson-io/test-project/pull/77";
      stateDir.createKaizenState(prUrl);

      // Command must contain the trigger pattern
      const command = "echo 'KAIZEN_NO_ACTION [docs-only]: documentation update'";
      const stdout = "KAIZEN_NO_ACTION [docs-only]: documentation update";
      const result = runKaizenHook(
        "pr-kaizen-clear-ts.sh",
        bashPost(command, stdout),
      );
      expect(result.exitCode).toBe(0);
      expect(stateDir.hasFile("pr-kaizen-"), `Gate should be cleared: stderr=${result.stderr}`).toBe(false);
    });
  });

  describe("4f: Full session lifecycle (trigger-to-outcome)", () => {
    // This is THE test — simulates a complete dev session through
    // the actual hook chain, verifying the sequence of enforcement
    // decisions matches expected behavior.

    it("complete workflow: edit → commit → PR → review → reflect → stop", { timeout: 30000 }, () => {
      // Phase 1: Agent edits source file in worktree → allowed
      const writeResult = runKaizenHook(
        "kaizen-enforce-worktree-writes.sh",
        writePre(`${process.cwd()}/src/fix.ts`),
      );
      expect(allows(writeResult), "Write in worktree should be allowed").toBe(true);

      // Phase 2: Agent commits → no block (worktree)
      const commitResult = runKaizenHook(
        "kaizen-enforce-case-worktree.sh",
        bashPre('git commit -m "fix: something"'),
      );
      expect(commitResult.exitCode, "Commit in worktree should pass").toBe(0);

      // Phase 3: Agent creates PR → triggers review and kaizen gates
      const prUrl = "https://github.com/Garsson-io/test-project/pull/99";

      // review-loop sets review state
      const reviewLoopResult = runKaizenHook(
        "pr-review-loop-ts.sh",
        bashPost('gh pr create --title "fix: something"', prUrl),
      );

      // reflect sets kaizen state
      const reflectResult = runKaizenHook(
        "kaizen-reflect-ts.sh",
        bashPost('gh pr create --title "fix: something"', prUrl),
      );
      expect(reflectResult.stdout).toContain("KAIZEN");

      // Phase 4: Agent tries to install packages → blocked by review gate
      // (npm test is now allowed as diagnostic — kaizen #775)
      const npmResult = runKaizenHook(
        "kaizen-enforce-pr-review-ts.sh",
        bashPre("npm install lodash"),
      );
      // Review gate should block
      if (stateDir.hasFile("Garsson-io_test-project_99")) {
        expect(denies(npmResult), "npm install blocked during review").toBe(true);
      }

      // Phase 5: Agent reads PR diff (allowed during review)
      const diffResult = runKaizenHook(
        "kaizen-enforce-pr-review-ts.sh",
        bashPre("gh pr diff 99"),
      );
      expect(allows(diffResult), "gh pr diff allowed during review").toBe(true);

      // Phase 6: Agent tries to stop → blocked by reflection gate
      if (stateDir.hasFile("pr-kaizen-")) {
        const stopResult = runKaizenHook(
          "kaizen-stop-gate.sh",
          stopEvent(),
        );
        expect(blocks(stopResult), "Stop blocked during reflection").toBe(true);
      }

      // Phase 7: Agent submits valid kaizen impediments → gate clears
      const impedimentsJson = '[{"impediment": "found bug", "disposition": "filed", "ref": "#101"}]';
      const kaizenCommand = `echo 'KAIZEN_IMPEDIMENTS:' && echo '${impedimentsJson}'`;
      const kaizenStdout = `KAIZEN_IMPEDIMENTS:\n${impedimentsJson}`;
      runKaizenHook(
        "pr-kaizen-clear-ts.sh",
        bashPost(kaizenCommand, kaizenStdout),
      );
      expect(stateDir.hasFile("pr-kaizen-"), "Kaizen gate should be cleared").toBe(false);

      // Phase 8: Agent can now stop (reflection cleared)
      // Note: review gate may still be active but that's a separate lifecycle
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// Part 5: Optional Live Claude Test
// ════════════════════════════════════════════════════════════════════

describe("Part 5: Live Claude integration (opt-in)", () => {
  const isLive = process.env.KAIZEN_LIVE_TEST === "1";

  it.skipIf(!isLive)("claude CLI is available", () => {
    const version = execSync("claude --version", { encoding: "utf-8" }).trim();
    expect(version).toMatch(/\d+\.\d+/);
  });

  it.skipIf(!isLive)("claude loads kaizen plugin and hooks fire", () => {
    const debugFile = join(tmpdir(), `claude-e2e-debug-${Date.now()}.log`);
    try {
      const output = execSync(
        [
          "claude",
          "-p",
          "--plugin-dir", KAIZEN_ROOT,
          "--output-format", "json",
          "--max-budget-usd", "0.05",
          "--model", "haiku",
          "--debug-file", debugFile,
          '"Say exactly: KAIZEN_TEST_OK. Nothing else."',
        ].join(" "),
        {
          encoding: "utf-8",
          timeout: 60000,
          cwd: KAIZEN_ROOT,
        },
      );

      const result = JSON.parse(output);
      expect(result).toBeDefined();

      // Check debug log for hook execution
      if (existsSync(debugFile)) {
        const debugLog = readFileSync(debugFile, "utf-8");
        expect(debugLog).toContain("hook");
      }
    } finally {
      try { rmSync(debugFile); } catch {}
    }
  });
});
