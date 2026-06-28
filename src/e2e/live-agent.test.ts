import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import {
  buildLiveAgentArgs,
  runLiveAgent,
} from "./live-agent.js";
import type { SpawnClaudeJsonFn, SpawnClaudeJsonResult } from "../spawn-claude.js";

function spawnResult(overrides: Partial<SpawnClaudeJsonResult> = {}): SpawnClaudeJsonResult {
  return {
    text: "ok",
    costUsd: 0.01,
    durationMs: 5,
    exitCode: 0,
    signal: null,
    rawStdout: JSON.stringify({
      result: "ok",
      is_error: false,
      total_cost_usd: 0.01,
      num_turns: 1,
    }),
    rawStderr: "",
    args: ["-p", "--plugin-dir", "/repo/kaizen"],
    numTurns: 1,
    ...overrides,
  };
}

function successfulSpawn(result: Partial<SpawnClaudeJsonResult> = {}): SpawnClaudeJsonFn {
  return async () => spawnResult(result);
}

describe("live-agent E2E runner contract", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function resultsDir(name: string): string {
    const dir = join(tmpdir(), `kaizen-live-agent-${name}-${Date.now()}`);
    tmpRoots.push(dir);
    return dir;
  }

  it("builds claude -p argv with explicit local plugin source by default", () => {
    const args = buildLiveAgentArgs({
      prompt: "Run /kaizen-zen",
      pluginDir: "/repo/kaizen",
      model: "haiku",
      maxTurns: 4,
      maxBudgetUsd: 0.12,
    });

    expect(args).toEqual([
      "-p",
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--model", "haiku",
      "--max-turns", "4",
      "--max-budget-usd", "0.12",
      "--plugin-dir", "/repo/kaizen",
      "Run /kaizen-zen",
    ]);
  });

  it("can explicitly run without --plugin-dir for installed-plugin tests", () => {
    const args = buildLiveAgentArgs({
      prompt: "Run /kaizen-zen",
      pluginDir: null,
    });

    expect(args).not.toContain("--plugin-dir");
    expect(args).toContain("json");
    expect(args.at(-1)).toBe("Run /kaizen-zen");
  });

  it("persists a raw checkpoint before rejecting empty parsed output", async () => {
    const dir = resultsDir("invalid-json");

    await expect(
      runLiveAgent("Run /kaizen-zen", {
        resultsDir: dir,
        artifactName: "invalid-json",
        spawn: successfulSpawn({ text: "", rawStdout: "not json" }),
      }),
    ).rejects.toThrow(/raw output: .*invalid-json\.json/);

    const rawPath = join(dir, "invalid-json.json");
    expect(existsSync(rawPath)).toBe(true);
    const checkpoint = JSON.parse(readFileSync(rawPath, "utf8"));
    expect(checkpoint.stdout).toBe("not json");
    expect(checkpoint.command).toBe("claude -p");
  });

  it.each([
    ["spawn error", { error: new Error("ENOENT"), text: "" }],
    ["nonzero exit", { text: "x", rawStderr: "bad", exitCode: 2 }],
    ["empty result", { text: "", rawStdout: "", exitCode: 0 }],
  ])("fails closed on %s", async (_name, result) => {
    await expect(
      runLiveAgent("Run /kaizen-zen", {
        resultsDir: resultsDir(_name.replace(/\s+/g, "-")),
        spawn: successfulSpawn(result),
      }),
    ).rejects.toThrow(/raw output:/);
  });

  it("fails when expected behavioral signals are missing", async () => {
    await expect(
      runLiveAgent("Run /kaizen-zen", {
        resultsDir: resultsDir("missing-signal"),
        expectedSignals: [
          { name: "zen output", pattern: /Zen of Kaizen/ },
        ],
        spawn: successfulSpawn({ text: "plain output" }),
      }),
    ).rejects.toThrow(/missing expected signal.*zen output/);
  });

  it("returns parsed output, matched signals, and checkpoint metadata on success", async () => {
    const dir = resultsDir("success");
    const result = await runLiveAgent("Run /kaizen-zen", {
      resultsDir: dir,
      artifactName: "success",
      expectedSignals: [
        "kaizen",
        { name: "zen", pattern: /Zen/i },
      ],
      spawn: successfulSpawn({
        text: "The Zen of Kaizen",
        rawStdout: JSON.stringify({
          result: "The Zen of Kaizen",
          is_error: false,
          total_cost_usd: 0.01,
          num_turns: 1,
        }),
      }),
    });

    expect(result.text).toBe("The Zen of Kaizen");
    expect(result.matchedSignals).toEqual(["kaizen", "zen"]);
    expect(result.rawPath).toBe(join(dir, "success.json"));
    expect(existsSync(result.rawPath)).toBe(true);
    const checkpoint = JSON.parse(readFileSync(result.rawPath, "utf8"));
    expect(checkpoint.costUsd).toBe(0.01);
    expect(checkpoint.durationMs).toEqual(expect.any(Number));
  });

  it("keeps skill-change live tests on the shared runner", () => {
    const source = readFileSync(resolve(process.cwd(), "src/e2e/skill-change.test.ts"), "utf8");
    expect(source).toContain("runLiveAgent");
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("spawnSync(");
    expect(source).not.toContain("JSON.parse(proc.stdout");
  });

  it("keeps issue-routing and setup live agent calls out of local claude wrappers", () => {
    const issueRouting = readFileSync(resolve(process.cwd(), "src/e2e/issue-routing.test.ts"), "utf8");
    const setupLive = readFileSync(resolve(process.cwd(), "src/e2e/setup-live.test.ts"), "utf8");

    expect(issueRouting).toContain("runLiveAgent");
    expect(issueRouting).not.toContain("function claude(");
    expect(issueRouting).not.toContain("JSON.parse(proc.stdout");

    expect(setupLive).toContain("runInstalledPluginAgent");
    expect(setupLive).toContain("runLiveAgent");
    expect(setupLive).not.toContain("JSON.parse(proc.stdout");
  });
});
