/**
 * issue-routing.test.ts — E2E: skills route issues to the host repo.
 *
 * Creates a synthetic host project with kaizen configured, then runs
 * claude -p with the kaizen plugin. Verifies the agent follows the
 * skill-config-header.md routing and queries the host repo for issues.
 *
 * Fixture: https://github.com/Garsson-io/kaizen-test-fixture
 *   - Has issues enabled, "kaizen" label, and test issue #1
 *   - Dedicated test repo — safe to query
 *
 * Run: KAIZEN_LIVE_TEST=1 npx vitest run src/e2e/issue-routing.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { SyntheticProject } from "./synthetic-project.js";

const KAIZEN_ROOT = resolve(__dirname, "../..");
const isLive = process.env.KAIZEN_LIVE_TEST === "1";

const KAIZEN_REPO = "Garsson-io/kaizen";
const HOST_FIXTURE_REPO = "Garsson-io/kaizen-test-fixture";

function claude(
  prompt: string,
  opts: { cwd: string; maxTurns?: number; maxBudget?: number; timeout?: number },
): { result: string; is_error: boolean; num_turns: number; total_cost_usd: number } {
  const args = [
    "claude", "-p",
    "--output-format", "json",
    "--model", "haiku",
    "--dangerously-skip-permissions",
    "--max-turns", String(opts.maxTurns ?? 8),
    "--max-budget-usd", String(opts.maxBudget ?? 0.50),
    "--plugin-dir", KAIZEN_ROOT,
    prompt,
  ];

  const proc = spawnSync(args[0], args.slice(1), {
    encoding: "utf-8",
    cwd: opts.cwd,
    timeout: opts.timeout ?? 120000,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
  });

  if (proc.error) throw new Error(`claude failed: ${proc.error.message}`);

  try {
    return JSON.parse(proc.stdout.trim());
  } catch {
    throw new Error(
      `claude output not JSON:\nstdout: ${proc.stdout?.slice(0, 500)}\nstderr: ${proc.stderr?.slice(0, 500)}`,
    );
  }
}

describe("Issue Routing E2E — skill queries host repo in synthetic project", () => {
  if (!isLive) {
    it.skip("set KAIZEN_LIVE_TEST=1 to run live tests", () => {});
    return;
  }

  let project: SyntheticProject;

  beforeAll(() => {
    project = new SyntheticProject({ language: "node" });
    project.fullSetup({
      name: "test-host-app",
      repo: HOST_FIXTURE_REPO,
      description: "Synthetic host for issue routing E2E test",
    });

    // Verify config was created correctly — host != kaizen
    const config = JSON.parse(project.readFile("kaizen.config.json"));
    expect(config.host.repo).toBe(HOST_FIXTURE_REPO);
    expect(config.kaizen.repo).toBe(KAIZEN_REPO);
  });

  afterAll(() => {
    project?.cleanup();
  });

  it("claude CLI is available", () => {
    const proc = spawnSync("claude", ["--version"], { encoding: "utf-8" });
    expect(proc.status).toBe(0);
  });

  it(
    "kaizen-pick step 1 queries the host repo, not the kaizen repo",
    { timeout: 180000 },
    () => {
      // This is the real test: invoke the actual skill and check which
      // repo the agent queries. We tell it to run /kaizen-pick step 1
      // which reads kaizen.config.json and lists open issues.
      const result = claude(
        [
          "Run /kaizen-pick. Only do step 1 (gather the landscape).",
          "After listing issues, STOP. Do not continue to step 2.",
          "Show which repo you queried for issues.",
        ].join(" "),
        { cwd: project.projectRoot, maxTurns: 15, maxBudget: 1.00, timeout: 180000 },
      );

      const text = result.result ?? "";
      console.log("--- kaizen-pick output ---");
      console.log(text.slice(0, 1200));
      console.log("--- end ---");

      // The agent should have queried the host fixture repo
      // We check for its presence in the output (either as repo name
      // or in issue URLs)
      const queriedHostRepo =
        text.includes(HOST_FIXTURE_REPO) ||
        text.includes("kaizen-test-fixture");

      const queriedKaizenRepo =
        text.includes(`github.com/${KAIZEN_REPO}/issues/`);

      expect(
        queriedHostRepo,
        `Agent should query ${HOST_FIXTURE_REPO} for issues. Output: ${text.slice(0, 800)}`,
      ).toBe(true);

      expect(
        queriedKaizenRepo,
        `Agent queried kaizen repo instead of host repo. Output: ${text.slice(0, 800)}`,
      ).toBe(false);
    },
  );
});
