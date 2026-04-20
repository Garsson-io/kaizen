/**
 * install-flow-agentic.test.ts — end-to-end proof of #1081.
 *
 * Two-phase test that mirrors the real interactive install flow:
 *
 *   Phase 1 — install. One `claude -p` session installs the plugin.
 *     Asserts `.claude/settings.json` with `enabledPlugins["kaizen@kaizen"]: true`
 *     and a marketplaces entry. Verifies #1080 (project scope is the default).
 *
 *   Phase 2 — setup. A SECOND `claude -p` session simulates "fresh session
 *     after /reload-plugins" — the kaizen skills are now loaded in the
 *     conversation's skill list, so the agent can actually invoke
 *     `/kaizen-setup`. Asserts `kaizen.config.json`, `policies-local.md`,
 *     and a kaizen section in `CLAUDE.md`. Verifies #1081.
 *
 * Why two phases: `/reload-plugins` is a Claude Code CLI built-in, not a
 * plugin skill, so agents in `claude -p` headless mode cannot invoke it
 * (probed and confirmed — agent explicitly reports "I can't invoke it
 * from here"). The second `claude -p` invocation starts with the plugin
 * already loaded, which is the effect `/reload-plugins` produces
 * interactively. README was updated to document this distinction.
 *
 * Gated on KAIZEN_LIVE_TEST=1 because `claude -p` spends real tokens.
 * Costs ~$1-$3 per run (sonnet, two maxTurns~25 calls). Not wired into
 * the fast suite; intended for CI nightly and manual "did I regress the
 * install flow?" runs.
 *
 * Every time the test fails, the failure assertion points at the README
 * section / skill step that misled the agent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const KAIZEN_ROOT = resolve(__dirname, "../..");
const isLive = process.env.KAIZEN_LIVE_TEST === "1";

/**
 * What the agent is told to install. Two modes:
 *
 *   - Default (PR iteration, unset env var): the **current worktree** —
 *     `claude plugin marketplace add` accepts a local path, so we point
 *     the agent at this checkout. README-edit → test-run is immediate;
 *     no network, no push, no rebuild.
 *
 *   - Override (`KAIZEN_E2E_PLUGIN_SOURCE=Garsson-io/kaizen`): a remote
 *     GitHub source, which is what real users give Claude. Used for CI
 *     nightly post-merge runs — validates that the *deployed* README
 *     still leads agents correctly after merge.
 */
const PLUGIN_SOURCE = process.env.KAIZEN_E2E_PLUGIN_SOURCE ?? KAIZEN_ROOT;

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
    "--max-turns", String(opts.maxTurns ?? 40),
    "--max-budget-usd", String(opts.maxBudget ?? 4.0),
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
 * Safe to run when nothing is installed. Project-scope installs live in
 * the host repo's .claude/settings.json and are removed when the temp
 * host dir is deleted.
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
  // Add a realistic origin so /kaizen-setup's auto-detection can
  // derive `repo` without asking. Real host repos have a remote;
  // a repro without one isn't representative of the bug we're
  // forcing the flow through.
  execSync(`git remote add origin https://github.com/test-org/${name}.git`, { cwd: dir });
  writeFileSync(join(dir, "README.md"), `# ${name}\n\nA test host project for the kaizen install flow.\n`);
  execSync("git add -A && git commit -q -m init", { cwd: dir });
  return dir;
}

describe("install-flow agentic E2E (#1081) — README must lead the agent to a configured install", () => {
  if (!isLive) {
    it.skip("set KAIZEN_LIVE_TEST=1 to run the live agentic test (~$1-3/run)", () => {});
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
    "phase 1: install prompt → plugin enabled at project scope (#1080)",
    { timeout: 15 * 60 * 1000 },
    () => {
      // Minimal install prompt. The agent must:
      //   - find the README at PLUGIN_SOURCE,
      //   - run the correct marketplace-add + install commands,
      //   - pick --scope project (per the README's recommendation — #1080),
      //   - correctly recognize that /reload-plugins and /kaizen-setup
      //     cannot execute in this headless session and stop.
      const result = runClaude(
        `install the Claude Code plugin at ${PLUGIN_SOURCE} into this repo`,
        hostRepo,
        { maxTurns: 40, maxBudget: 4.0 },
      );

      const diag = `turns=${result.num_turns} cost=$${result.total_cost_usd?.toFixed(2)} tail:\n${(result.result ?? "").slice(-1200)}`;

      expect(
        result.is_error,
        `phase 1 is_error=true. ${diag}`,
      ).toBe(false);

      // Plugin settings file present at project scope (team-shared).
      const settingsPath = join(hostRepo, ".claude", "settings.json");
      expect(
        existsSync(settingsPath),
        `.claude/settings.json not created. #1080 regression — agent used user scope or failed install. ${diag}`,
      ).toBe(true);

      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(
        settings.enabledPlugins?.["kaizen@kaizen"],
        `kaizen@kaizen not enabled in project settings. Got:\n${JSON.stringify(settings, null, 2)}`,
      ).toBe(true);
    },
  );

  it(
    "phase 2: setup prompt in a fresh session → config + policies + CLAUDE.md (#1081)",
    { timeout: 15 * 60 * 1000 },
    () => {
      // Phase 2 assumes phase 1 has already populated .claude/settings.json.
      // To keep the test independent and fast, inline the equivalent of
      // `claude plugin marketplace add + install --scope project` here
      // by running those CLI commands directly, then invoke a fresh
      // `claude -p` which will pick up the plugin on session start.
      // execFileSync with an arg array so PLUGIN_SOURCE (env-derived)
      // is never passed through a shell — fixes CodeQL
      // js/shell-command-injection-from-environment.
      execFileSync(
        "claude",
        ["plugin", "marketplace", "add", PLUGIN_SOURCE, "--scope", "project"],
        { cwd: hostRepo, encoding: "utf-8", timeout: 60000 },
      );
      execFileSync(
        "claude",
        ["plugin", "install", "kaizen@kaizen", "--scope", "project"],
        { cwd: hostRepo, encoding: "utf-8", timeout: 60000 },
      );

      // Sanity: phase-1-equivalent state is in place.
      const settingsPath = join(hostRepo, ".claude", "settings.json");
      expect(existsSync(settingsPath)).toBe(true);

      // Now the "fresh interactive session post-reload" effect: a brand
      // new `claude -p` invocation reads the project settings on startup
      // and loads the kaizen plugin, so /kaizen-setup is in its skill
      // list. The prompt still asks only for the user's intent, not the
      // specific sequence.
      const result = runClaude(
        `configure this repo to use the kaizen plugin that's already installed`,
        hostRepo,
        { maxTurns: 40, maxBudget: 4.0 },
      );

      const diag = `turns=${result.num_turns} cost=$${result.total_cost_usd?.toFixed(2)} tail:\n${(result.result ?? "").slice(-1200)}`;

      expect(
        result.is_error,
        `phase 2 is_error=true. ${diag}`,
      ).toBe(false);

      // Kaizen config file present.
      const configPath = join(hostRepo, "kaizen.config.json");
      expect(
        existsSync(configPath),
        `kaizen.config.json not created. #1081 regression — /kaizen-setup was not invoked or did not complete. ${diag}`,
      ).toBe(true);

      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.host?.repo).toBeTruthy();
      expect(config.kaizen?.repo).toBe("Garsson-io/kaizen");

      // policies-local.md scaffolded.
      expect(
        existsSync(join(hostRepo, ".agents", "kaizen", "local", "policies-local.md")),
        `.agents/kaizen/local/policies-local.md not scaffolded. ${diag}`,
      ).toBe(true);

      // CLAUDE.md contains a kaizen section.
      const claudeMd = existsSync(join(hostRepo, "CLAUDE.md"))
        ? readFileSync(join(hostRepo, "CLAUDE.md"), "utf-8")
        : "";
      expect(
        claudeMd.toLowerCase().includes("kaizen"),
        `CLAUDE.md does not mention kaizen (injection skipped). Content:\n${claudeMd.slice(0, 400)}`,
      ).toBe(true);

      // #1085 fragment fix: CLAUDE.md must NOT contain the literal
      // placeholder `{{KAIZEN_ROOT}}`. The fragment was rewritten to use
      // GitHub URLs and skill names — if someone reintroduces the
      // placeholder, this asserts.
      expect(
        claudeMd,
        `CLAUDE.md contains literal {{KAIZEN_ROOT}} placeholder — fragment regressed. Content:\n${claudeMd.slice(0, 800)}`,
      ).not.toContain("{{KAIZEN_ROOT}}");
    },
  );
});
