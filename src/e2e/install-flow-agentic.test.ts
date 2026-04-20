/**
 * install-flow-agentic.test.ts — end-to-end proof of #1081.
 *
 * Drives the single forcing function for the kaizen install flow:
 *
 *   Given a brand-new host repo and the prompt
 *     "install Garsson-io/kaizen into this repo"
 *   (no other instructions), a Claude Code agent must end up with a
 *   fully-configured install by reading the README alone.
 *
 * Gated on KAIZEN_LIVE_TEST=1 because `claude -p` spends real tokens.
 * Costs ~$1-$2 per run (sonnet, maxTurns=20). Not wired into the fast
 * suite; intended for CI nightly and manual "did I regress the README?"
 * runs.
 *
 * The test is the forcing function. Every time it fails, the failure
 * mode should point at the README section that misled the agent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";

const KAIZEN_ROOT = resolve(__dirname, "../..");
const isLive = process.env.KAIZEN_LIVE_TEST === "1";

interface ClaudeResult {
  result: string;
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
}

function runClaude(prompt: string, cwd: string, opts: { maxTurns?: number; maxBudget?: number } = {}): ClaudeResult {
  const args = [
    "-p",
    "--output-format", "json",
    "--model", "sonnet",
    "--dangerously-skip-permissions",
    "--max-turns", String(opts.maxTurns ?? 20),
    "--max-budget-usd", String(opts.maxBudget ?? 2.5),
    prompt,
  ];
  const r = spawnSync("claude", args, {
    encoding: "utf-8",
    cwd,
    timeout: 15 * 60 * 1000,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
  });
  if (r.error) throw new Error(`claude failed: ${r.error.message}`);
  try {
    return JSON.parse(r.stdout.trim()) as ClaudeResult;
  } catch {
    throw new Error(
      `claude output not JSON:\nstdout: ${r.stdout?.slice(0, 800)}\nstderr: ${r.stderr?.slice(0, 800)}`,
    );
  }
}

/**
 * Simulate a fresh user: uninstall kaizen at user scope if present.
 * Safe to run when nothing is installed.
 */
function resetKaizenInstall(): void {
  spawnSync("claude", ["plugin", "uninstall", "kaizen@kaizen"], {
    encoding: "utf-8",
    timeout: 30000,
  });
  spawnSync("claude", ["plugin", "marketplace", "remove", "kaizen"], {
    encoding: "utf-8",
    timeout: 30000,
  });
}

function makeBareHostRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kaizen-install-agentic-${name}-`));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email test@test && git config user.name test", { cwd: dir });
  writeFileSync(join(dir, "README.md"), `# ${name}\n\nA test host project.\n`);
  execSync("git add -A && git commit -q -m init", { cwd: dir });
  return dir;
}

describe("install-flow agentic E2E (#1081) — README must lead the agent to a configured install", () => {
  if (!isLive) {
    it.skip("set KAIZEN_LIVE_TEST=1 to run the live agentic test (~$1-2/run)", () => {});
    return;
  }

  let hostRepo: string;

  beforeEach(() => {
    resetKaizenInstall();
    hostRepo = makeBareHostRepo("install-agentic");
  });

  afterEach(() => {
    if (hostRepo) rmSync(hostRepo, { recursive: true, force: true });
    resetKaizenInstall();
  });

  it(
    "single minimal prompt → fully configured install",
    { timeout: 15 * 60 * 1000 },
    () => {
      // The prompt is deliberately minimal — no hints, no step list, no
      // mention of /kaizen-setup or /reload-plugins. The agent must
      // derive the full flow from the README alone.
      const result = runClaude(
        "install https://github.com/Garsson-io/kaizen into this repo",
        hostRepo,
        { maxTurns: 25, maxBudget: 2.5 },
      );

      // Attach transcript to failure messages so when this test breaks,
      // the failure mode itself tells us which README section was weak.
      const tail = (result.result ?? "").slice(-800);

      expect(
        result.is_error,
        `claude -p returned is_error=true. transcript tail:\n${tail}`,
      ).toBe(false);

      // 1. Plugin settings file present at project scope (team-shared).
      const settingsPath = join(hostRepo, ".claude", "settings.json");
      expect(
        existsSync(settingsPath),
        `.claude/settings.json not created. #1080 regression — agent used user scope. Transcript tail:\n${tail}`,
      ).toBe(true);

      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(
        settings.enabledPlugins?.["kaizen@kaizen"],
        `kaizen@kaizen not enabled in project settings. Got:\n${JSON.stringify(settings, null, 2)}`,
      ).toBe(true);

      // 2. Kaizen config file present (the /kaizen-setup side of the flow).
      const configPath = join(hostRepo, "kaizen.config.json");
      expect(
        existsSync(configPath),
        `kaizen.config.json not created. #1081 regression — agent stopped at /plugin install without running /kaizen-setup. Transcript tail:\n${tail}`,
      ).toBe(true);

      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.host?.repo).toBeTruthy();
      expect(config.kaizen?.repo).toBe("Garsson-io/kaizen");

      // 3. policies-local.md scaffolded.
      expect(
        existsSync(join(hostRepo, ".agents", "kaizen", "local", "policies-local.md")),
        `.agents/kaizen/local/policies-local.md not scaffolded. Transcript tail:\n${tail}`,
      ).toBe(true);

      // 4. CLAUDE.md contains a kaizen section (injection happened).
      const claudeMd = existsSync(join(hostRepo, "CLAUDE.md"))
        ? readFileSync(join(hostRepo, "CLAUDE.md"), "utf-8")
        : "";
      expect(
        claudeMd.toLowerCase().includes("kaizen"),
        `CLAUDE.md does not mention kaizen (injection skipped). Content:\n${claudeMd.slice(0, 400)}`,
      ).toBe(true);
    },
  );
});
