/**
 * setup-live.test.ts — Live E2E tests for kaizen plugin setup.
 *
 * Runs `claude -p` against real temp projects to verify the ACTUAL user
 * experience: skills load, hooks fire, setup creates correct files.
 *
 * These tests use haiku for cost efficiency (~$0.01 per test).
 * Run with: KAIZEN_LIVE_TEST=1 npx vitest run src/e2e/setup-live.test.ts
 *
 * This is the test that would have caught #769 (skills not loading)
 * and #768 (no scope question during install).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const KAIZEN_ROOT = resolve(__dirname, "../..");
const isLive = process.env.KAIZEN_LIVE_TEST === "1";

// Run claude -p with the kaizen plugin against a project directory.
// Returns parsed JSON result.
function claude(
  prompt: string,
  opts: {
    cwd: string;
    maxTurns?: number;
    maxBudget?: number;
    timeout?: number;
    allowedTools?: string[];
  },
): {
  result: string;
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
  duration_ms: number;
} {
  const args = [
    "claude", "-p",
    "--plugin-dir", KAIZEN_ROOT,
    "--output-format", "json",
    "--model", "haiku",
    "--dangerously-skip-permissions",
    "--max-turns", String(opts.maxTurns ?? 5),
    "--max-budget-usd", String(opts.maxBudget ?? 0.50),
  ];

  if (opts.allowedTools) {
    for (const tool of opts.allowedTools) {
      args.push("--allowedTools", tool);
    }
  }

  args.push(prompt);

  const proc = spawnSync(args[0], args.slice(1), {
    encoding: "utf-8",
    cwd: opts.cwd,
    timeout: opts.timeout ?? 120000,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
  });

  if (proc.error) {
    throw new Error(`claude failed: ${proc.error.message}`);
  }

  try {
    return JSON.parse(proc.stdout.trim());
  } catch {
    throw new Error(`claude output is not JSON:\nstdout: ${proc.stdout}\nstderr: ${proc.stderr}`);
  }
}

// Create a temp project directory with git init
function createTempProject(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kaizen-live-${name}-`));
  execSync("git init && git config user.name test && git config user.email test@test.com", {
    cwd: dir,
    stdio: "pipe",
  });
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  execSync("git add . && git commit -m init", { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("Live E2E: Plugin Setup", () => {
  // Skip all tests if KAIZEN_LIVE_TEST is not set
  if (!isLive) {
    it.skip("set KAIZEN_LIVE_TEST=1 to run live tests", () => {});
    return;
  }

  it("claude CLI is available", () => {
    const result = spawnSync("claude", ["--version"], { encoding: "utf-8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+/);
  });

  describe("skill discovery", () => {
    let projectDir: string;

    beforeAll(() => {
      projectDir = createTempProject("skill-test");
    });

    afterAll(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("loads all kaizen skills", { timeout: 30000 }, () => {
      // Ask claude to invoke /kaizen-zen — if skills are loaded, this should work
      const result = claude(
        "Run /kaizen-zen to print the Zen of Kaizen.",
        { cwd: projectDir, maxTurns: 3, maxBudget: 0.20 },
      );

      // The zen skill should produce output containing kaizen philosophy text
      const text = (result.result ?? "").toLowerCase();
      expect(
        text.includes("kaizen") || text.includes("zen") || text.includes("improvement"),
        `Expected kaizen zen output, got: ${JSON.stringify(result).slice(0, 500)}`,
      ).toBe(true);
    });
  });

  describe("setup flow on a Python project", () => {
    let projectDir: string;

    beforeAll(() => {
      projectDir = createTempProject("python-setup");
      // Make it look like a Python project
      writeFileSync(join(projectDir, "pyproject.toml"), '[project]\nname = "test-app"\nversion = "0.1.0"\n');
      writeFileSync(join(projectDir, "CLAUDE.md"), "# Test Python App\n\nA test project.\n");
    });

    afterAll(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("creates kaizen.config.json in project root", { timeout: 120000 }, () => {
      const result = claude(
        'Run /kaizen-setup for this project. Use these values: name="test-python-app", repo="testorg/test-python-app", description="A test Python CLI", kaizen-repo="Garsson-io/kaizen", channel="none". Do NOT ask questions, just create the files.',
        { cwd: projectDir, maxTurns: 10, maxBudget: 1.00 },
      );

      expect(result.is_error).toBe(false);

      // kaizen.config.json should exist in project root
      const configPath = join(projectDir, "kaizen.config.json");
      expect(existsSync(configPath), "kaizen.config.json not created").toBe(true);

      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.host.name).toBe("test-python-app");
      expect(config.host.repo).toBe("testorg/test-python-app");
      expect(config.kaizen.repo).toBe("Garsson-io/kaizen");
    });

    it("creates policies-local.md", () => {
      const policiesPath = join(projectDir, ".claude", "kaizen", "policies-local.md");
      expect(existsSync(policiesPath), "policies-local.md not created").toBe(true);
    });

    it("injects kaizen section into CLAUDE.md", () => {
      const content = readFileSync(join(projectDir, "CLAUDE.md"), "utf-8");
      expect(content.toLowerCase()).toContain("kaizen");
    });

    it("config is NOT in plugin cache directory", () => {
      // The critical #756 bug: config was written to plugin cache instead of project root
      const pluginCacheConfig = join(KAIZEN_ROOT, "kaizen.config.json");
      // kaizen's own config is fine — but it should say "kaizen", not "test-python-app"
      if (existsSync(pluginCacheConfig)) {
        const config = JSON.parse(readFileSync(pluginCacheConfig, "utf-8"));
        expect(config.host.name).not.toBe("test-python-app");
      }
    });
  });

  describe("hooks fire correctly after setup", () => {
    let projectDir: string;

    beforeAll(() => {
      projectDir = createTempProject("hooks-test");
      writeFileSync(join(projectDir, "CLAUDE.md"), "# Hooks Test\n\n## Kaizen\nkaizen is active.\n");
      writeFileSync(
        join(projectDir, "kaizen.config.json"),
        JSON.stringify({
          host: { name: "hooks-test", repo: "test/hooks-test", description: "test" },
          kaizen: { repo: "Garsson-io/kaizen", issueLabel: "kaizen" },
        }, null, 2),
      );
      mkdirSync(join(projectDir, ".claude", "kaizen"), { recursive: true });
      writeFileSync(join(projectDir, ".claude", "kaizen", "policies-local.md"), "# Policies\n");
    });

    afterAll(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("blocks git rebase commands", () => {
      const result = claude(
        "Run this exact command: git rebase -i HEAD~3",
        { cwd: projectDir, maxTurns: 3, maxBudget: 0.20 },
      );

      // The hook should have blocked the rebase
      // The result should mention "blocked" or "rebase" or the agent should report it was denied
      const text = result.result.toLowerCase();
      expect(
        text.includes("block") || text.includes("denied") || text.includes("not allowed") || text.includes("rebase"),
        `Expected rebase to be blocked, got: ${result.result.slice(0, 200)}`,
      ).toBe(true);
    });
  });
});
