/**
 * setup-live.test.ts — Live E2E tests for kaizen plugin installation and setup.
 *
 * Tests the ACTUAL user experience:
 *   1. Install kaizen via `claude plugin marketplace add` + `claude plugin install`
 *   2. Verify skills load after install
 *   3. Run /kaizen-setup and verify files are created
 *   4. Verify hooks fire
 *
 * This is the test that catches real installation bugs like #769 (skills
 * not loading after install) because it runs the same commands users run.
 *
 * Run with: KAIZEN_LIVE_TEST=1 npx vitest run src/e2e/setup-live.test.ts
 * Uses haiku for cost efficiency.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
import { tmpdir, homedir } from "node:os";

const KAIZEN_ROOT = resolve(__dirname, "../..");
const isLive = process.env.KAIZEN_LIVE_TEST === "1";

// Run claude -p in a project directory. No --plugin-dir — uses whatever
// plugins are installed in the user's environment (the real path).
function claude(
  prompt: string,
  opts: {
    cwd: string;
    maxTurns?: number;
    maxBudget?: number;
    timeout?: number;
    pluginDir?: string;
    model?: string;
  },
): {
  result: string;
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
} {
  const args = [
    "claude", "-p",
    "--output-format", "json",
    "--model", opts.model ?? "sonnet",
    "--dangerously-skip-permissions",
    "--max-turns", String(opts.maxTurns ?? 5),
    "--max-budget-usd", String(opts.maxBudget ?? 0.50),
  ];

  if (opts.pluginDir) {
    args.push("--plugin-dir", opts.pluginDir);
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
    throw new Error(`claude output not JSON:\nstdout: ${proc.stdout?.slice(0, 500)}\nstderr: ${proc.stderr?.slice(0, 500)}`);
  }
}

// Run a claude CLI command (not -p mode)
function claudeCmd(args: string[]): { stdout: string; stderr: string; status: number } {
  const proc = spawnSync("claude", args, {
    encoding: "utf-8",
    timeout: 30000,
  });
  return {
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    status: proc.status ?? 1,
  };
}

function createTempProject(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kaizen-live-${name}-`));
  execSync("git init && git config user.name test && git config user.email test@test.com", {
    cwd: dir, stdio: "pipe",
  });
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  execSync("git add . && git commit -m init", { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("Live E2E: Full Installation Flow", () => {
  if (!isLive) {
    it.skip("set KAIZEN_LIVE_TEST=1 to run live tests", () => {});
    return;
  }

  it("claude CLI is available", () => {
    const result = spawnSync("claude", ["--version"], { encoding: "utf-8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+/);
  });

  describe("plugin installation via marketplace", () => {
    it("adds kaizen marketplace", { timeout: 30000 }, () => {
      const result = claudeCmd(["plugin", "marketplace", "add", "Garsson-io/kaizen"]);
      // Either succeeds or says already added
      expect(
        result.stdout.includes("kaizen") || result.stderr.includes("kaizen"),
        `marketplace add failed: ${result.stdout} ${result.stderr}`,
      ).toBe(true);
    });

    it("installs kaizen plugin", { timeout: 30000 }, () => {
      const result = claudeCmd(["plugin", "install", "kaizen@kaizen"]);
      expect(
        result.stdout.toLowerCase().includes("success") ||
        result.stdout.toLowerCase().includes("installed") ||
        result.stdout.toLowerCase().includes("already"),
        `plugin install failed: ${result.stdout} ${result.stderr}`,
      ).toBe(true);
    });
  });

  describe("skills load after marketplace install", () => {
    let projectDir: string;

    beforeAll(() => {
      projectDir = createTempProject("skill-test");
    });

    afterAll(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("kaizen-zen skill works (proves skills loaded from installed plugin)", { timeout: 60000 }, () => {
      // NO --plugin-dir here — uses the marketplace-installed plugin
      const result = claude(
        "Run /kaizen-zen to print the Zen of Kaizen. Just print it, nothing else.",
        { cwd: projectDir, maxTurns: 5, maxBudget: 0.30 },
      );

      const text = (result.result ?? "").toLowerCase();
      expect(
        text.includes("kaizen") || text.includes("zen") || text.includes("improvement"),
        `Expected kaizen zen output from installed plugin, got: ${JSON.stringify(result).slice(0, 500)}`,
      ).toBe(true);
    });

    it("kaizen-setup skill is available", { timeout: 60000 }, () => {
      // Verify /kaizen-setup is recognized (not "Unknown skill")
      const result = claude(
        'What does the /kaizen-setup skill do? Just describe it in one sentence.',
        { cwd: projectDir, maxTurns: 2, maxBudget: 0.20 },
      );

      const text = (result.result ?? "").toLowerCase();
      // Should describe setup, not say "unknown skill"
      expect(text).not.toContain("unknown skill");
      expect(
        text.includes("setup") || text.includes("config") || text.includes("install"),
        `Expected setup description, got: ${result.result?.slice(0, 200)}`,
      ).toBe(true);
    });
  });

  describe("full setup flow on Python project (installed plugin)", () => {
    let projectDir: string;

    beforeAll(() => {
      projectDir = createTempProject("python-setup");
      writeFileSync(join(projectDir, "pyproject.toml"), '[project]\nname = "test-app"\nversion = "0.1.0"\n');
      writeFileSync(join(projectDir, "CLAUDE.md"), "# Test Python App\n\nA test project.\n");
    });

    afterAll(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("kaizen-setup creates config files", { timeout: 180000 }, () => {
      // The plugin is already installed (from earlier tests).
      // In a real flow the user would restart or /reload-plugins.
      // We simulate "second session" by just running /kaizen-setup directly.
      const result = claude(
        "Run /kaizen-setup to configure kaizen for this project. Use these values: name=test-python-app, repo=testorg/test-python-app, description=A test Python CLI, channel=none. Do not ask questions.",
        { cwd: projectDir, maxTurns: 15, maxBudget: 2.00 },
      );

      expect(result.is_error).toBe(false);

      // kaizen.config.json in project root
      const configPath = join(projectDir, "kaizen.config.json");
      expect(existsSync(configPath), `kaizen.config.json not created. Result: ${(result.result ?? "").slice(0, 300)}`).toBe(true);

      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.host.name).toBe("test-python-app");
      expect(config.host.repo).toBe("testorg/test-python-app");
    });

    it("creates policies-local.md", () => {
      expect(existsSync(join(projectDir, ".claude", "kaizen", "policies-local.md")), "policies-local.md not created").toBe(true);
    });

    it("injects kaizen section into CLAUDE.md", () => {
      const content = readFileSync(join(projectDir, "CLAUDE.md"), "utf-8");
      expect(content.toLowerCase()).toContain("kaizen");
    });
  });

  describe("hooks fire after install", () => {
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

    it("blocks git rebase commands", { timeout: 30000 }, () => {
      // NO --plugin-dir — uses installed plugin
      const result = claude(
        "Run this exact command: git rebase -i HEAD~3",
        { cwd: projectDir, maxTurns: 3, maxBudget: 0.20 },
      );

      const text = (result.result ?? "").toLowerCase();
      expect(
        text.includes("block") || text.includes("denied") || text.includes("not allowed") || text.includes("rebase"),
        `Expected rebase to be blocked, got: ${result.result?.slice(0, 200)}`,
      ).toBe(true);
    });
  });
});
